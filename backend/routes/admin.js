/**
 * Admin API Routes
 * 관리자 대시보드용 API 엔드포인트
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { invalidateAuctionCache, invalidateTerritoryCache, invalidateCachePattern, invalidatePixelCache } from '../redis/cache-utils.js';
import { calculateProtectionEndsAt, logAuctionEndSuccess, finalizeAuctionEnd } from '../utils/auction-utils.js';
// requireAdmin은 server.js에서 전역으로 적용됨

const router = express.Router();

/**
 * GET /api/admin/stats
 * 통계 정보 조회
 */
router.get('/stats', async (req, res) => {
    try {
        // Redis 캐시 확인 (1분 캐시)
        const cacheKey = 'admin:stats';
        let cached = null;
        
        try {
            cached = await redis.get(cacheKey);
            if (cached && typeof cached === 'object') {
                console.log('[Admin] ✅ Stats loaded from cache');
                return res.json(cached);
            }
        } catch (redisError) {
            console.warn('[Admin] ⚠️ Redis cache read error (continuing with DB query):', redisError.message);
            // Redis 오류가 있어도 DB 쿼리는 계속 진행
        }
        
        console.log('[Admin] 📊 Fetching stats from database...');
        
        // 사용자 수
        const usersResult = await query('SELECT COUNT(*) as count FROM users');
        const userCount = parseInt(usersResult.rows[0]?.count || 0, 10);
        
        // 영토 통계
        const territoriesResult = await query(`
            SELECT 
                sovereignty,
                COUNT(*) as count
            FROM territories
            WHERE sovereignty IN ('ruled', 'protected')
            GROUP BY sovereignty
        `);
        
        let ruledCount = 0;
        let protectedCount = 0;
        territoriesResult.rows.forEach(row => {
            if (row.sovereignty === 'ruled') {
                ruledCount = parseInt(row.count, 10);
            } else if (row.sovereignty === 'protected') {
                protectedCount = parseInt(row.count, 10);
            }
        });
        const totalTerritories = ruledCount + protectedCount;
        
        // 수익 계산 (ownerships 테이블의 price 합계 - 현재 소유 중인 영토만)
        const revenueResult = await query(`
            SELECT COALESCE(SUM(price), 0) as total_revenue
            FROM ownerships o
            INNER JOIN territories t ON o.territory_id = t.id
            WHERE t.sovereignty IN ('ruled', 'protected')
              AND o.ended_at IS NULL
              AND o.price IS NOT NULL
        `);
        const totalRevenue = parseFloat(revenueResult.rows[0]?.total_revenue || 0);
        
        // 활성 경매 수
        const auctionsResult = await query(`
            SELECT COUNT(*) as count
            FROM auctions
            WHERE status = 'active'
        `);
        const activeAuctions = parseInt(auctionsResult.rows[0]?.count || 0, 10);
        
        const stats = {
            users: userCount,
            territories: totalTerritories,
            ruled: ruledCount,
            protected: protectedCount,
            revenue: totalRevenue,
            activeAuctions: activeAuctions,
            timestamp: new Date().toISOString()
        };
        
        // Redis에 캐시 (1분) - 실패해도 응답은 반환
        try {
            await redis.set(cacheKey, stats, 60);
            console.log('[Admin] ✅ Stats cached in Redis');
        } catch (redisError) {
            console.warn('[Admin] ⚠️ Redis cache write error (response still sent):', redisError.message);
        }
        
        console.log('[Admin] ✅ Stats fetched successfully:', stats);
        res.json(stats);
    } catch (error) {
        console.error('[Admin] ❌❌❌ Stats error:', {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
            fullError: error
        });
        res.status(500).json({ 
            error: 'Failed to fetch stats',
            details: error.message,
            errorCode: error.code || 'UNKNOWN_ERROR'
        });
    }
});

/**
 * GET /api/admin/users
 * 사용자 목록 조회
 * Query params: limit, offset, search
 */
router.get('/users', async (req, res) => {
    try {
        const { limit = 100, offset = 0, search } = req.query;
        
        let sql = `
            SELECT 
                u.*,
                w.balance,
                COUNT(DISTINCT t.id) as territory_count
            FROM users u
            LEFT JOIN wallets w ON u.id = w.user_id
            LEFT JOIN territories t ON u.id = t.ruler_id AND t.sovereignty IN ('ruled', 'protected')
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (search) {
            sql += ` WHERE (u.email ILIKE $${paramIndex} OR u.nickname ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        sql += ` GROUP BY u.id, w.balance`;
        sql += ` ORDER BY u.created_at DESC`;
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        
        const result = await query(sql, params);
        
        const users = result.rows.map(row => ({
            id: row.id,
            firebaseUid: row.firebase_uid,
            email: row.email,
            nickname: row.nickname,
            avatarUrl: row.avatar_url,
            balance: parseFloat(row.balance || 0),
            territoryCount: parseInt(row.territory_count || 0, 10),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
        
        res.json(users);
    } catch (error) {
        console.error('[Admin] Users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * GET /api/admin/users/:id
 * 사용자 상세 정보 조회
 */
router.get('/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 사용자 정보
        const userResult = await query(`
            SELECT 
                u.*,
                w.balance
            FROM users u
            LEFT JOIN wallets w ON u.id = w.user_id
            WHERE u.id = $1
        `, [id]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // 소유 영토 목록
        const territoriesResult = await query(`
            SELECT 
                t.*,
                a.id as auction_id,
                a.status as auction_status,
                o.price as purchased_price,
                o.acquired_at as purchased_at
            FROM territories t
            LEFT JOIN auctions a ON t.current_auction_id = a.id
            LEFT JOIN ownerships o ON t.id = o.territory_id AND o.ended_at IS NULL
            WHERE t.ruler_id = $1
              AND t.sovereignty IN ('ruled', 'protected')
            ORDER BY t.updated_at DESC
        `, [id]);
        
        // 거래 내역
        const transactionsResult = await query(`
            SELECT 
                wt.*
            FROM wallet_transactions wt
            JOIN wallets w ON wt.wallet_id = w.id
            WHERE w.user_id = $1
            ORDER BY wt.created_at DESC
            LIMIT 50
        `, [id]);
        
        const userData = {
            id: user.id,
            firebaseUid: user.firebase_uid,
            email: user.email,
            nickname: user.nickname,
            avatarUrl: user.avatar_url,
            balance: parseFloat(user.balance || 0),
            territories: territoriesResult.rows.map(t => ({
                id: t.id,
                name: t.name,
                code: t.code,
                country: t.country,
                sovereignty: t.sovereignty,
                purchasedPrice: parseFloat(t.purchased_price || 0),
                purchasedAt: t.purchased_at,
                auctionId: t.auction_id,
                auctionStatus: t.auction_status,
                updatedAt: t.updated_at
            })),
            transactions: transactionsResult.rows.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: parseFloat(tx.amount || 0),
                description: tx.description,
                referenceId: tx.reference_id,
                createdAt: tx.created_at
            })),
            createdAt: user.created_at,
            updatedAt: user.updated_at
        };
        
        res.json(userData);
    } catch (error) {
        console.error('[Admin] User detail error:', error);
        res.status(500).json({ error: 'Failed to fetch user details' });
    }
});

/**
 * PUT /api/admin/territories/:id/reset
 * 영토 초기화
 * ⚠️ 중요: 이 라우트는 /territories보다 먼저 등록되어야 함 (라우트 순서)
 */
router.put('/territories/:id/reset', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: territoryId } = req.params;
        
        await client.query('BEGIN');
        
        // 영토 정보 조회
        const territoryResult = await client.query(
            `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = territoryResult.rows[0];
        const previousRulerId = territory.ruler_id;
        
        // 영토 초기화
        await client.query(
            `UPDATE territories 
             SET ruler_id = NULL,
                 ruler_name = NULL,
                 sovereignty = 'unconquered',
                 status = 'unconquered',
                 protection_ends_at = NULL,
                 current_auction_id = NULL,
                 base_price = 0,
                 purchased_by_admin = false,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [territoryId]
        );
        
        // 이전 소유권 종료 처리
        if (previousRulerId) {
            await client.query(
                `UPDATE ownerships 
                 SET ended_at = NOW() 
                 WHERE territory_id = $1 AND user_id = $2 AND ended_at IS NULL`,
                [territoryId, previousRulerId]
            );
        }
        
        // 활성 경매 삭제
        await client.query(
            `DELETE FROM auctions 
             WHERE territory_id = $1 AND status = 'active'`,
            [territoryId]
        );
        
        await client.query('COMMIT');
        
        // Redis 캐시 무효화
        await invalidateTerritoryCache(territoryId);
        await invalidateAuctionCache(null, territoryId); // 해당 영토의 모든 경매 캐시 무효화
        
        res.json({ 
            success: true, 
            message: 'Territory reset successfully',
            territoryId,
            previousRulerId 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Reset territory error:', error);
        res.status(500).json({ error: 'Failed to reset territory' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/admin/territories
 * 영토 목록 조회
 * Query params: limit, offset, status, country, search
 */
router.get('/territories', async (req, res) => {
    try {
        const { limit = 100, offset = 0, status, country, search } = req.query;
        
        let sql = `
            SELECT 
                t.*,
                u.nickname as ruler_nickname,
                u.email as ruler_email,
                a.id as auction_id,
                a.status as auction_status,
                a.current_bid as auction_current_bid,
                o.price as purchased_price,
                o.acquired_at as purchased_at
            FROM territories t
            LEFT JOIN users u ON t.ruler_id = u.id
            LEFT JOIN auctions a ON t.current_auction_id = a.id
            LEFT JOIN ownerships o ON t.id = o.territory_id AND o.ended_at IS NULL
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (status) {
            sql += ` AND t.sovereignty = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        } else {
            // 기본값: ruled 또는 protected만
            sql += ` AND t.sovereignty IN ('ruled', 'protected')`;
        }
        
        if (country) {
            sql += ` AND t.country = $${paramIndex}`;
            params.push(country);
            paramIndex++;
        }
        
        if (search) {
            sql += ` AND (t.name ILIKE $${paramIndex} OR t.code ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }
        
        sql += ` ORDER BY t.updated_at DESC`;
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        
        const result = await query(sql, params);
        
        const territories = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            code: row.code,
            country: row.country,
            sovereignty: row.sovereignty,
            price: parseFloat(row.price || 0),
            purchasedPrice: parseFloat(row.purchased_price || 0),
            purchasedAt: row.purchased_at,
            rulerId: row.ruler_id,
            rulerNickname: row.ruler_nickname,
            rulerEmail: row.ruler_email,
            auctionId: row.auction_id,
            auctionStatus: row.auction_status,
            auctionCurrentBid: parseFloat(row.auction_current_bid || 0),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
        
        res.json(territories);
    } catch (error) {
        console.error('[Admin] Territories error:', error);
        res.status(500).json({ error: 'Failed to fetch territories' });
    }
});

/**
 * GET /api/admin/territories/:id
 * 영토 상세 조회 (관리자용)
 * ⚠️ 중요: 이 라우트는 /territories/:id/reset보다 나중에 등록되어야 함 (라우트 순서)
 */
router.get('/territories/:id', async (req, res) => {
    try {
        const { id: territoryId } = req.params;
        console.log('[Admin] GET /territories/:id called with territoryId:', territoryId);
        
        const result = await query(
            `SELECT 
                t.*,
                u.nickname as ruler_nickname,
                u.email as ruler_email,
                u.firebase_uid as ruler_firebase_uid,
                a.id as auction_id,
                a.status as auction_status,
                a.current_bid as auction_current_bid,
                a.end_time as auction_end_time,
                o.price as purchased_price,
                o.acquired_at as purchased_at
            FROM territories t
            LEFT JOIN users u ON t.ruler_id = u.id
            LEFT JOIN auctions a ON t.current_auction_id = a.id
            LEFT JOIN ownerships o ON t.id = o.territory_id AND o.ended_at IS NULL
            WHERE t.id = $1`,
            [territoryId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const row = result.rows[0];
        const territory = {
            id: row.id,
            name: row.name,
            code: row.code,
            country: row.country,
            countryIso: row.country_iso,
            sovereignty: row.sovereignty,
            status: row.status,
            price: parseFloat(row.price || 0),
            basePrice: parseFloat(row.base_price || 0),
            marketBasePrice: parseFloat(row.market_base_price || 0),
            purchasedPrice: parseFloat(row.purchased_price || 0),
            purchasedAt: row.purchased_at,
            rulerId: row.ruler_id,
            rulerFirebaseUid: row.ruler_firebase_uid,
            rulerNickname: row.ruler_nickname,
            rulerEmail: row.ruler_email,
            rulerName: row.ruler_name,
            auctionId: row.auction_id,
            auctionStatus: row.auction_status,
            auctionCurrentBid: parseFloat(row.auction_current_bid || 0),
            auctionEndTime: row.auction_end_time,
            protectionEndsAt: row.protection_ends_at,
            purchasedByAdmin: row.purchased_by_admin || false,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
        
        res.json(territory);
    } catch (error) {
        console.error('[Admin] Territory detail error:', error);
        res.status(500).json({ error: 'Failed to fetch territory' });
    }
});

/**
 * PUT /api/admin/territories/:id
 * 영토 정보 수정 (관리자용 - 가격 등)
 */
router.put('/territories/:id', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: territoryId } = req.params;
        const { price, basePrice, marketBasePrice } = req.body;
        
        await client.query('BEGIN');
        
        // 영토 정보 조회
        const territoryResult = await client.query(
            `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        // 업데이트할 필드 구성
        const updates = [];
        const params = [];
        let paramIndex = 1;
        
        if (price !== undefined) {
            updates.push(`price = $${paramIndex}`);
            params.push(price);
            paramIndex++;
        }
        
        if (basePrice !== undefined) {
            updates.push(`base_price = $${paramIndex}`);
            params.push(basePrice);
            paramIndex++;
        }
        
        if (marketBasePrice !== undefined) {
            updates.push(`market_base_price = $${paramIndex}`);
            params.push(marketBasePrice);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(territoryId);
        
        // 영토 업데이트
        await client.query(
            `UPDATE territories 
             SET ${updates.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING *`,
            params
        );
        
        await client.query('COMMIT');
        
        // 캐시 무효화
        await invalidateTerritoryCache(territoryId);
        
        res.json({ 
            success: true, 
            message: 'Territory updated successfully',
            territoryId
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Update territory error:', error);
        res.status(500).json({ error: 'Failed to update territory' });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/admin/auctions/:id/end
 * 경매 종료 (관리자용)
 * ⚠️ 중요: 이 라우트는 /auctions보다 먼저 등록되어야 함 (라우트 순서)
 * 일반 사용자용 POST /api/auctions/:id/end와 동일한 로직 사용
 */
router.put('/auctions/:id/end', async (req, res) => {
    // ✅ 변수 스코프 문제 해결: 함수 최상단에 선언
    const { id: auctionId } = req.params;
    const startTime = Date.now(); // 처리 시간 측정
    const client = await getPool().connect();
    
    try {
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 1. 경매 정보 조회 (FOR UPDATE는 auctions 테이블에만 적용)
        const auctionResult = await client.query(
            `SELECT 
                a.*,
                t.base_price,
                t.market_base_price,
                t.ruler_id as current_owner_id,
                t.ruler_name as current_owner_name,
                u.nickname as bidder_nickname,
                u.firebase_uid as bidder_firebase_uid
            FROM auctions a
            LEFT JOIN territories t ON a.territory_id = t.id
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.id = $1
            FOR UPDATE OF a`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        
        // 2. 이미 종료된 경매인지 확인 및 소유권 이전 상태 검증
        if (auction.status === 'ended') {
            // territory_id가 없는 경우는 복구 불가
            if (!auction.territory_id) {
                await client.query('ROLLBACK');
                return res.json({
                    success: true,
                    message: 'Auction already ended (no territory associated)',
                    auction: {
                        id: auctionId,
                        status: 'ended',
                        endedAt: auction.end_time
                    }
                });
            }
            
            // 이미 종료된 옥션이지만, 소유권 이전이 제대로 되었는지 확인
            const territoryCheckResult = await client.query(
                `SELECT 
                    t.id,
                    t.ruler_id,
                    t.sovereignty,
                    t.current_auction_id,
                    a.current_bidder_id,
                    a.current_bid
                FROM territories t
                LEFT JOIN auctions a ON a.id = $1
                WHERE t.id = $2`,
                [auctionId, auction.territory_id]
            );
            
            if (territoryCheckResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ 
                    error: 'Territory not found',
                    territoryId: auction.territory_id
                });
            }
            
            const territory = territoryCheckResult.rows[0];
            const expectedWinnerId = auction.current_bidder_id;
            const hasWinner = expectedWinnerId && parseFloat(auction.current_bid || 0) > 0;
            
            // 소유권 이전이 필요한지 확인
            let needsRecovery = false;
            let recoveryReason = '';
            
            if (hasWinner) {
                // 낙찰자가 있는데 소유권이 이전되지 않은 경우
                if (String(territory.ruler_id) !== String(expectedWinnerId)) {
                    needsRecovery = true;
                    recoveryReason = `Expected winner ${expectedWinnerId} but territory ruler is ${territory.ruler_id || 'NULL'}`;
                }
                // 영토가 여전히 옥션과 연결되어 있는 경우
                if (String(territory.current_auction_id) === String(auctionId)) {
                    needsRecovery = true;
                    recoveryReason = recoveryReason || 'Territory still linked to ended auction';
                }
            } else {
                // 낙찰자가 없는데 영토가 여전히 옥션과 연결되어 있는 경우
                if (String(territory.current_auction_id) === String(auctionId)) {
                    needsRecovery = true;
                    recoveryReason = 'Territory still linked to ended auction with no winner';
                }
            }
            
            if (!needsRecovery) {
                // 이미 정상적으로 처리된 경우
                await client.query('ROLLBACK');
                return res.json({
                    success: true,
                    message: 'Auction already ended and ownership properly transferred',
                    auction: {
                        id: auctionId,
                        status: 'ended',
                        endedAt: auction.end_time
                    },
                    territory: {
                        id: territory.id,
                        rulerId: territory.ruler_id,
                        sovereignty: territory.sovereignty
                    }
                });
            }
            
            // 소유권 이전 복구 필요 - 아래 로직으로 계속 진행
            console.log(`[Admin] Recovering ownership transfer for ended auction ${auctionId}: ${recoveryReason}`);
        } else if (auction.status !== 'active') {
            // 이미 종료되지 않았지만 active도 아닌 경우 (예: cancelled 등)
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Auction is not active',
                status: auction.status
            });
        }
        
        // 3. ⚠️ 전문가 조언 반영: 공통 종료 함수 사용
        // 모든 종료 처리는 finalizeAuctionEnd 하나로만 처리
        // 이미 종료된 옥션도 복구 가능 (소유권 이전이 안 된 경우)
        const endResult = await finalizeAuctionEnd({
            client,
            auctionId,
            auction,
            source: 'admin'
        });
        
        const { hasWinner, finalBid, finalBidderId, finalBidderNickname, protectionEndsAt } = endResult;
        
        await client.query('COMMIT');
        
        // Redis 캐시 무효화 (소유권 변경 시 모든 관련 캐시 무효화)
        await invalidateAuctionCache(auctionId, auction.territory_id);
        await invalidateTerritoryCache(auction.territory_id);
        
        // 픽셀/오버레이 캐시 무효화 (영토 소유권 변경 시 렌더링 캐시도 무효화)
        if (auction.territory_id) {
            await invalidatePixelCache(auction.territory_id);
        }
        
        // 맵 스냅샷 및 오버레이 캐시 무효화
        await invalidateCachePattern('map:*');
        await invalidateCachePattern('overlay:*');
        await invalidateCachePattern('pixels:*');
        
        // ✅ 성공 로그 출력 (처리 시간 포함)
        const processingTimeMs = Date.now() - startTime;
        logAuctionEndSuccess({
            auctionId,
            territoryId: auction.territory_id,
            winnerUserId: finalBidderId || null,
            protectionEndsAt: hasWinner ? protectionEndsAt : null,
            processingTimeMs,
            source: 'admin'
        });
        
        res.json({ 
            success: true, 
            message: 'Auction ended successfully',
            auctionId,
            winnerId: finalBidderId || null,
            finalBid: finalBid || 0
        });
        
    } catch (error) {
        await client.query('ROLLBACK').catch(rollbackError => {
            console.error('[Admin] Rollback error:', rollbackError);
        });
        console.error('[Admin] End auction error:', error);
        console.error('[Admin] Error message:', error.message);
        console.error('[Admin] Error stack:', error.stack);
        console.error('[Admin] Auction ID:', auctionId);
        console.error('[Admin] Error code:', error.code);
        console.error('[Admin] Error name:', error.name);
        res.status(500).json({ 
            error: 'Failed to end auction',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/admin/auctions/:id/time
 * 경매 종료 시간 수정
 * ⚠️ 중요: 이 라우트는 /auctions보다 먼저 등록되어야 함 (라우트 순서)
 */
router.put('/auctions/:id/time', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: auctionId } = req.params;
        const { endTime } = req.body;
        
        if (!endTime) {
            return res.status(400).json({ error: 'endTime is required' });
        }
        
        // ISO 문자열을 Date로 변환
        const endTimeDate = new Date(endTime);
        if (isNaN(endTimeDate.getTime())) {
            return res.status(400).json({ error: 'Invalid endTime format' });
        }
        
        await client.query('BEGIN');
        
        // 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        const territoryId = auction.territory_id;
        
        // 경매 종료 시간 업데이트
        await client.query(
            `UPDATE auctions 
             SET end_time = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [endTimeDate, auctionId]
        );
        
        await client.query('COMMIT');
        
        // ✅ Redis 캐시 무효화 (관리자 목록 캐시 포함)
        await invalidateAuctionCache(auctionId, territoryId);
        // 관리자 목록/집계 캐시 무효화 (패턴 기반)
        try {
            await invalidateCachePattern('admin:auctions:*');
            await redis.del('admin:stats');
        } catch (cacheError) {
            console.warn('[Admin] Failed to invalidate admin cache:', cacheError);
        }
        
        res.json({ 
            success: true, 
            message: 'Auction end time updated successfully',
            auctionId,
            endTime: endTimeDate.toISOString()
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Update auction time error:', error);
        res.status(500).json({ error: 'Failed to update auction time', details: error.message });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/admin/auctions/:id
 * 경매 삭제
 * ⚠️ 중요: 이 라우트는 /auctions보다 먼저 등록되어야 함 (라우트 순서)
 */
router.delete('/auctions/:id', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: auctionId } = req.params;
        
        await client.query('BEGIN');
        
        // 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        const territoryId = auction.territory_id;
        const wasActive = auction.status === 'active';
        
        // 경매 삭제
        await client.query(
            `DELETE FROM auctions WHERE id = $1`,
            [auctionId]
        );
        
        // 활성 경매였으면 영토의 current_auction_id 제거
        if (wasActive && territoryId) {
            await client.query(
                `UPDATE territories 
                 SET current_auction_id = NULL,
                     updated_at = NOW()
                 WHERE id = $1`,
                [territoryId]
            );
        }
        
        await client.query('COMMIT');
        
        // Redis 캐시 무효화
        await invalidateAuctionCache(auctionId, territoryId);
        
        res.json({ 
            success: true, 
            message: 'Auction deleted successfully',
            auctionId 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Delete auction error:', error);
        res.status(500).json({ error: 'Failed to delete auction' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/admin/auctions/:id
 * 경매 상세 정보 조회
 * ⚠️ 중요: 이 라우트는 /auctions보다 먼저 등록되어야 함 (라우트 순서)
 */
router.get('/auctions/:id', async (req, res) => {
    try {
        const { id: auctionId } = req.params;
        
        const result = await query(`
            SELECT 
                a.*,
                t.name as territory_name,
                t.code as territory_code,
                u.nickname as bidder_nickname,
                u.email as bidder_email
            FROM auctions a
            LEFT JOIN territories t ON a.territory_id = t.id
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.id = $1
        `, [auctionId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const row = result.rows[0];
        const auction = {
            id: row.id,
            territoryId: row.territory_id,
            territoryName: row.territory_name,
            territoryCode: row.territory_code,
            status: row.status,
            startingBid: parseFloat(row.min_bid || 0),
            currentBid: parseFloat(row.current_bid || 0),
            currentBidderId: row.current_bidder_id,
            bidderNickname: row.bidder_nickname,
            bidderEmail: row.bidder_email,
            endTime: row.end_time ? (row.end_time instanceof Date ? row.end_time.toISOString() : new Date(row.end_time).toISOString()) : null,
            endedAt: row.ended_at ? (row.ended_at instanceof Date ? row.ended_at.toISOString() : new Date(row.ended_at).toISOString()) : null,
            createdAt: row.created_at ? (row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()) : null,
            updatedAt: row.updated_at ? (row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString()) : null
        };
        
        res.json(auction);
    } catch (error) {
        console.error('[Admin] Auction detail error:', error);
        res.status(500).json({ error: 'Failed to fetch auction details' });
    }
});

/**
 * GET /api/admin/auctions
 * 경매 목록 조회
 * Query params: limit, offset, status
 */
router.get('/auctions', async (req, res) => {
    try {
        const { limit = 100, offset = 0, status } = req.query;
        
        // ✅ bids 기반으로 실제 현재 입찰가와 최신 입찰자 정보 계산
        // 동률 처리 규칙: amount DESC, created_at DESC, id DESC (가장 나중 입찰이 최고가)
        let sql = `
            SELECT 
                a.*,
                t.name as territory_name,
                t.code as territory_code,
                -- bids 테이블에서 실제 최고 입찰가 계산
                COALESCE((
                    SELECT b.amount
                    FROM bids b
                    WHERE b.auction_id = a.id
                    ORDER BY 
                        b.amount DESC,      -- 1순위: 금액 높은 순
                        b.created_at DESC,  -- 2순위: 동률이면 가장 최근
                        b.id DESC           -- 3순위: 완전 동률이면 ID 큰 순 (최신)
                    LIMIT 1
                ), a.min_bid) as calculated_current_bid,
                -- 최고가 입찰의 user_id (동일한 ORDER BY 규칙 적용)
                (
                    SELECT b.user_id
                    FROM bids b
                    WHERE b.auction_id = a.id
                    ORDER BY 
                        b.amount DESC,      -- 1순위: 금액 높은 순
                        b.created_at DESC,  -- 2순위: 동률이면 가장 최근
                        b.id DESC           -- 3순위: 완전 동률이면 ID 큰 순 (최신)
                    LIMIT 1
                ) as latest_bidder_id,
                -- 기존 current_bidder_id (fallback용)
                u.nickname as bidder_nickname,
                u.email as bidder_email
            FROM auctions a
            LEFT JOIN territories t ON a.territory_id = t.id
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (status) {
            sql += ` AND a.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        
        sql += ` ORDER BY a.created_at DESC`;
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        
        // 디버깅: SQL 쿼리 확인
        console.log('[Admin] Executing auctions query with params:', params);
        
        const result = await query(sql, params);
        
        console.log('[Admin] Query executed successfully, rows:', result.rows.length);
        
        const auctions = result.rows.map(row => ({
            id: row.id,
            territoryId: row.territory_id,
            territoryName: row.territory_name,
            territoryCode: row.territory_code,
            status: row.status,
            startingBid: parseFloat(row.min_bid || 0),
            // ✅ bids 기반 계산된 현재 입찰가 사용 (기존 current_bid 컬럼 대신)
            currentBid: parseFloat(row.calculated_current_bid || row.min_bid || 0),
            // ✅ 최신 입찰자 정보 우선 사용, 없으면 기존 current_bidder_id 사용
            currentBidderId: row.latest_bidder_id || row.current_bidder_id,
            bidderNickname: row.latest_bidder_nickname || row.bidder_nickname || null,
            bidderEmail: row.latest_bidder_email || row.bidder_email || null,
            endTime: row.end_time ? (row.end_time instanceof Date ? row.end_time.toISOString() : new Date(row.end_time).toISOString()) : null,
            endedAt: row.ended_at ? (row.ended_at instanceof Date ? row.ended_at.toISOString() : new Date(row.ended_at).toISOString()) : null,
            createdAt: row.created_at ? (row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()) : null,
            updatedAt: row.updated_at ? (row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString()) : null
        }));
        
        // ✅ 최신 입찰자 정보를 users 테이블에서 조회하여 추가
        // (latest_bidder_id가 있는 경우 해당 정보로 덮어쓰기)
        // 성능 최적화: 배치로 한 번에 조회
        const bidderIds = [...new Set(auctions
            .map(a => a.currentBidderId)
            .filter(id => id != null)
        )];
        
        if (bidderIds.length > 0) {
            try {
                // PostgreSQL UUID 배열 처리
                const placeholders = bidderIds.map((_, i) => `$${i + 1}`).join(', ');
                const userResults = await query(
                    `SELECT id, nickname, email FROM users WHERE id IN (${placeholders})`,
                    bidderIds
                );
                const userMap = new Map(
                    userResults.rows.map(u => [u.id, { nickname: u.nickname, email: u.email }])
                );
                
                // 각 auction에 입찰자 정보 매핑
                auctions.forEach(auction => {
                    if (auction.currentBidderId && userMap.has(auction.currentBidderId)) {
                        const userInfo = userMap.get(auction.currentBidderId);
                        auction.bidderNickname = userInfo.nickname;
                        auction.bidderEmail = userInfo.email;
                    }
                });
            } catch (error) {
                console.warn('[Admin] Failed to fetch user info batch:', error);
                // 개별 조회로 fallback (기존 방식)
                for (const auction of auctions) {
                    if (auction.currentBidderId && !auction.bidderNickname) {
                        try {
                            const userResult = await query(
                                'SELECT nickname, email FROM users WHERE id = $1',
                                [auction.currentBidderId]
                            );
                            if (userResult.rows.length > 0) {
                                auction.bidderNickname = userResult.rows[0].nickname;
                                auction.bidderEmail = userResult.rows[0].email;
                            }
                        } catch (err) {
                            console.warn(`[Admin] Failed to fetch user info for ${auction.currentBidderId}:`, err);
                        }
                    }
                }
            }
        }
        
        res.json(auctions);
    } catch (error) {
        console.error('[Admin] Auctions error:', error);
        console.error('[Admin] Error stack:', error.stack);
        console.error('[Admin] Error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail,
            hint: error.hint
        });
        res.status(500).json({ 
            error: 'Failed to fetch auctions',
            details: error.message 
        });
    }
});

// ⚠️ 중복 라우트 제거: PUT /api/admin/auctions/:id/end는 위에 이미 정의됨 (584번 줄)

/**
 * DELETE /api/admin/auctions/:id
 * 경매 삭제
 */
router.delete('/auctions/:id', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: auctionId } = req.params;
        
        await client.query('BEGIN');
        
        // 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        const territoryId = auction.territory_id;
        const wasActive = auction.status === 'active';
        
        // 경매 삭제
        await client.query(
            `DELETE FROM auctions WHERE id = $1`,
            [auctionId]
        );
        
        // 활성 경매였으면 영토의 current_auction_id 제거
        if (wasActive && territoryId) {
            await client.query(
                `UPDATE territories 
                 SET current_auction_id = NULL,
                     updated_at = NOW()
                 WHERE id = $1`,
                [territoryId]
            );
        }
        
        await client.query('COMMIT');
        
        // Redis 캐시 무효화
        await invalidateAuctionCache(auctionId, territoryId);
        
        res.json({ 
            success: true, 
            message: 'Auction deleted successfully',
            auctionId 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Delete auction error:', error);
        res.status(500).json({ error: 'Failed to delete auction' });
    } finally {
        client.release();
    }
});


/**
 * DELETE /api/admin/users/:id
 * 사용자 데이터 삭제 (재가입 가능)
 * - 사용자 데이터 삭제
 * - 지갑 데이터 삭제
 * - 소유권 이력 종료
 * - 영토 소유권 해제
 * - 입찰 기록 삭제
 */
router.delete('/users/:id', async (req, res) => {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const { id: userId } = req.params;
        const adminEmail = req.user?.email || 'admin';
        
        // 1. 사용자 정보 조회 (로그용)
        const userResult = await client.query('SELECT email, nickname FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        const userInfo = userResult.rows[0];
        
        // 2. 소유 중인 영토 해제
        await client.query(`
            UPDATE territories 
            SET ruler_id = NULL, 
                ruler_name = NULL, 
                sovereignty = 'unconquered',
                protection_ends_at = NULL,
                current_auction_id = NULL,
                updated_at = NOW()
            WHERE ruler_id = $1
        `, [userId]);
        
        // 3. 소유권 이력 종료
        await client.query(`
            UPDATE ownerships 
            SET ended_at = NOW()
            WHERE user_id = $1 AND ended_at IS NULL
        `, [userId]);
        
        // 4. 활성 경매에서 입찰자 제거
        await client.query(`
            UPDATE auctions 
            SET current_bidder_id = NULL,
                updated_at = NOW()
            WHERE current_bidder_id = $1 AND status = 'active'
        `, [userId]);
        
        // 5. 입찰 기록 삭제
        await client.query('DELETE FROM bids WHERE user_id = $1', [userId]);
        
        // 6. 지갑 거래 이력 삭제
        await client.query(`
            DELETE FROM wallet_transactions 
            WHERE user_id = $1
        `, [userId]);
        
        // 7. 지갑 삭제
        await client.query('DELETE FROM wallets WHERE user_id = $1', [userId]);
        
        // 8. 사용자 삭제
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
        
        // 9. 관리자 로그 기록
        await client.query(`
            INSERT INTO admin_logs (action, details, admin_email, created_at)
            VALUES ($1, $2, $3, NOW())
        `, [
            'DELETE_USER',
            JSON.stringify({
                userId,
                userEmail: userInfo.email,
                userNickname: userInfo.nickname,
                reason: req.body.reason || '관리자에 의해 삭제됨'
            }),
            adminEmail
        ]);
        
        await client.query('COMMIT');
        
        // 캐시 무효화
        await invalidateTerritoryCache(null);
        
        res.json({ 
            success: true, 
            message: `User ${userInfo.email || userId} deleted successfully. User can re-register.` 
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Admin] Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user', details: error.message });
    } finally {
        client.release();
    }
});

/**
 * GET /api/admin/logs
 * 관리자 로그 조회
 * Query params: limit, offset, action
 */
router.get('/logs', async (req, res) => {
    try {
        const { limit = 50, offset = 0, action } = req.query;
        
        let sql = 'SELECT * FROM admin_logs';
        const params = [];
        let paramIndex = 1;
        
        if (action) {
            sql += ` WHERE action = $${paramIndex}`;
            params.push(action);
            paramIndex++;
        }
        
        sql += ` ORDER BY created_at DESC`;
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        
        const result = await query(sql, params);
        
        const logs = result.rows.map(row => ({
            id: row.id,
            action: row.action,
            details: row.details,
            adminEmail: row.admin_email,
            adminUid: row.admin_uid,
            userAgent: row.user_agent,
            ipAddress: row.ip_address,
            timestamp: row.created_at
        }));
        
        res.json(logs);
    } catch (error) {
        console.error('[Admin] Logs error:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

/**
 * POST /api/admin/logs
 * 관리자 작업 로그 기록
 */
router.post('/logs', async (req, res) => {
    try {
        const { action, details } = req.body;
        const adminEmail = req.user?.email || 'admin';
        const adminUid = req.user?.uid || null;
        const userAgent = req.headers['user-agent'] || null;
        const ipAddress = req.ip || req.connection.remoteAddress || null;
        
        const result = await query(`
            INSERT INTO admin_logs (action, details, admin_email, admin_uid, user_agent, ip_address, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            RETURNING *
        `, [
            action,
            JSON.stringify(details || {}),
            adminEmail,
            adminUid,
            userAgent,
            ipAddress
        ]);
        
        res.json({
            id: result.rows[0].id,
            action: result.rows[0].action,
            details: result.rows[0].details,
            adminEmail: result.rows[0].admin_email,
            timestamp: result.rows[0].created_at
        });
    } catch (error) {
        console.error('[Admin] Log creation error:', error);
        res.status(500).json({ error: 'Failed to create log' });
    }
});

/**
 * GET /api/admin/activity
 * 최근 활동 조회
 * 최근 사용자 가입, 영토 구매, 경매 종료, 관리자 작업 등을 조합하여 반환
 */
router.get('/activity', async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        
        const activities = [];
        
        // 1. 최근 사용자 가입
        const recentUsers = await query(`
            SELECT 
                id,
                email,
                nickname,
                created_at,
                'user_signup' as type
            FROM users
            ORDER BY created_at DESC
            LIMIT $1
        `, [Math.floor(limit / 4)]);
        
        recentUsers.rows.forEach(user => {
            activities.push({
                id: user.id,
                type: 'user_signup',
                title: '새 사용자 가입',
                description: `${user.nickname || user.email || '사용자'}님이 가입했습니다`,
                timestamp: user.created_at,
                icon: '👤',
                color: '#4ECDC4'
            });
        });
        
        // 2. 최근 영토 구매 (ownerships 테이블)
        const recentPurchases = await query(`
            SELECT 
                o.id,
                o.territory_id,
                o.user_id,
                o.acquired_at,
                o.price,
                t.name as territory_name,
                t.country,
                u.nickname,
                u.email,
                'territory_purchase' as type
            FROM ownerships o
            JOIN territories t ON o.territory_id = t.id
            JOIN users u ON o.user_id = u.id
            WHERE o.ended_at IS NULL
            ORDER BY o.acquired_at DESC
            LIMIT $1
        `, [Math.floor(limit / 4)]);
        
        recentPurchases.rows.forEach(purchase => {
            activities.push({
                id: purchase.id,
                type: 'territory_purchase',
                title: '영토 구매',
                description: `${purchase.nickname || purchase.email || '사용자'}님이 ${purchase.territory_name || purchase.territory_id}를 ${parseFloat(purchase.price || 0).toLocaleString('ko-KR')}pt에 구매했습니다`,
                timestamp: purchase.acquired_at,
                icon: '🗺️',
                color: '#95E1D3',
                territoryId: purchase.territory_id,
                userId: purchase.user_id
            });
        });
        
        // 3. 최근 경매 종료
        const recentAuctions = await query(`
            SELECT 
                a.id,
                a.territory_id,
                a.end_time,
                a.current_bid,
                a.current_bidder_id,
                t.name as territory_name,
                u.nickname,
                u.email,
                'auction_end' as type
            FROM auctions a
            JOIN territories t ON a.territory_id = t.id
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.status = 'ended'
            ORDER BY a.end_time DESC
            LIMIT $1
        `, [Math.floor(limit / 4)]);
        
        recentAuctions.rows.forEach(auction => {
            activities.push({
                id: auction.id,
                type: 'auction_end',
                title: '경매 종료',
                description: `${auction.territory_name || auction.territory_id} 경매가 종료되었습니다 (최종 입찰: ${parseFloat(auction.current_bid || 0).toLocaleString('ko-KR')}pt)`,
                timestamp: auction.end_time,
                icon: '💰',
                color: '#F38181',
                territoryId: auction.territory_id,
                userId: auction.current_bidder_id
            });
        });
        
        // 4. 최근 관리자 작업 (admin_logs)
        const recentAdminActions = await query(`
            SELECT 
                id,
                action,
                details,
                admin_email,
                created_at,
                'admin_action' as type
            FROM admin_logs
            ORDER BY created_at DESC
            LIMIT $1
        `, [Math.floor(limit / 4)]);
        
        recentAdminActions.rows.forEach(log => {
            const actionNames = {
                'DELETE_USER': '사용자 삭제',
                'ADD_POINTS': '포인트 지급',
                'RESET_TERRITORY': '영토 초기화',
                'END_AUCTION': '경매 종료',
                'DELETE_AUCTION': '경매 삭제',
                'EDIT_TERRITORY': '영토 수정',
                'SET_TERRITORY_OWNER': '영토 소유자 설정'
            };
            
            const actionName = actionNames[log.action] || log.action;
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
            
            activities.push({
                id: log.id,
                type: 'admin_action',
                title: actionName,
                description: `${log.admin_email} 관리자가 ${actionName} 작업을 수행했습니다`,
                timestamp: log.created_at,
                icon: '⚙️',
                color: '#AA96DA',
                details: details
            });
        });
        
        // 시간순으로 정렬 (최신순)
        activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // limit만큼만 반환
        res.json(activities.slice(0, parseInt(limit, 10)));
    } catch (error) {
        console.error('[Admin] Activity error:', error);
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

/**
 * GET /api/admin/analytics
 * 분석 데이터 조회
 */
router.get('/analytics', async (req, res) => {
    try {
        const { period = '7d' } = req.query; // 7d, 30d, 90d, all
        
        let dateFilter = '';
        if (period === '7d') {
            dateFilter = "AND created_at >= NOW() - INTERVAL '7 days'";
        } else if (period === '30d') {
            dateFilter = "AND created_at >= NOW() - INTERVAL '30 days'";
        } else if (period === '90d') {
            dateFilter = "AND created_at >= NOW() - INTERVAL '90 days'";
        }
        
        // 사용자 성장 추이
        const userGrowthResult = await query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as count
            FROM users
            WHERE created_at IS NOT NULL ${dateFilter}
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `);
        
        // 수익 추이 (지갑 거래 이력)
        const revenueResult = await query(`
            SELECT 
                DATE(created_at) as date,
                SUM(amount) as total
            FROM wallet_transactions
            WHERE type = 'deposit' ${dateFilter}
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `);
        
        // 영토 분포
        const territoryDistributionResult = await query(`
            SELECT 
                country,
                COUNT(*) as count
            FROM territories
            WHERE sovereignty IN ('ruled', 'protected')
            GROUP BY country
            ORDER BY count DESC
            LIMIT 20
        `);
        
        // 옥션 통계
        const auctionStatsResult = await query(`
            SELECT 
                status,
                COUNT(*) as count,
                AVG(current_bid) as avg_bid,
                SUM(current_bid) as total_value
            FROM auctions
            WHERE created_at IS NOT NULL ${dateFilter}
            GROUP BY status
        `);
        
        res.json({
            userGrowth: userGrowthResult.rows,
            revenue: revenueResult.rows,
            territoryDistribution: territoryDistributionResult.rows,
            auctionStats: auctionStatsResult.rows
        });
    } catch (error) {
        console.error('[Admin] Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

export { router as adminRouter };

