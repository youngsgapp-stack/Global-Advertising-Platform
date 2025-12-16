/**
 * Territories API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateTerritoryCache } from '../redis/cache-utils.js';
import { broadcastTerritoryUpdate } from '../websocket/index.js';

const router = express.Router();

/**
 * GET /api/territories
 * 영토 목록 조회 (필터링 지원)
 * Query params: country, status, limit
 */
router.get('/', async (req, res) => {
    try {
        const { country, status, limit } = req.query;
        
        // Redis 캐시 키 생성
        const cacheKey = `territories:${country || 'all'}:${status || 'all'}:${limit || 'all'}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // SQL 쿼리 빌드
        let sql = `SELECT 
            t.*,
            u.nickname as ruler_nickname,
            u.email as ruler_email,
            a.id as auction_id,
            a.status as auction_status,
            a.current_bid as auction_current_bid,
            a.end_time as auction_end_time
        FROM territories t
        LEFT JOIN users u ON t.ruler_id = u.id
        LEFT JOIN auctions a ON t.current_auction_id = a.id AND a.status = 'active'
        WHERE 1=1`;
        
        const params = [];
        let paramIndex = 1;
        
        if (country) {
            sql += ` AND t.country = $${paramIndex}`;
            params.push(country);
            paramIndex++;
        }
        
        if (status) {
            // status는 territories 테이블의 status 필드를 확인
            // sovereignty도 함께 확인 (ruled, protected 등)
            sql += ` AND (t.status = $${paramIndex} OR t.sovereignty = $${paramIndex})`;
            params.push(status);
            paramIndex++;
        }
        
        sql += ` ORDER BY t.updated_at DESC`;
        
        if (limit) {
            const limitNum = parseInt(limit, 10);
            if (limitNum > 0 && limitNum <= 10000) {
                sql += ` LIMIT $${paramIndex}`;
                params.push(limitNum);
            }
        }
        
        const result = await query(sql, params);
        
        const territories = result.rows.map(row => ({
            id: row.id,
            code: row.code,
            name: row.name,
            name_en: row.name_en,
            country: row.country,
            continent: row.continent,
            status: row.status,
            sovereignty: row.sovereignty,
            ruler: row.ruler_id ? {
                id: row.ruler_id,
                name: row.ruler_name || row.ruler_nickname,
                email: row.ruler_email
            } : null,
            basePrice: parseFloat(row.base_price || 0),
            hasAuction: !!row.auction_id,
            auction: row.auction_id ? {
                id: row.auction_id,
                status: row.auction_status,
                currentBid: parseFloat(row.auction_current_bid || 0),
                endTime: row.auction_end_time
            } : null,
            polygon: row.polygon,
            protectionEndsAt: row.protection_ends_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
        
        // Redis에 캐시
        await redis.set(cacheKey, territories, CACHE_TTL.TERRITORY_LIST);
        
        res.json(territories);
    } catch (error) {
        console.error('[Territories] Error:', error);
        res.status(500).json({ error: 'Failed to fetch territories' });
    }
});

/**
 * GET /api/territories/:id/auctions/active
 * 영토의 활성 경매 조회
 * 더 구체적인 경로를 먼저 정의
 */
router.get('/:id/auctions/active', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await query(
            `SELECT 
                a.*,
                u.nickname as bidder_nickname
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.territory_id = $1 AND a.status = 'active'
            ORDER BY a.created_at DESC
            LIMIT 1`,
            [id]
        );
        
        res.json(result.rows[0] || null);
    } catch (error) {
        console.error('[Territories] Error:', error);
        res.status(500).json({ error: 'Failed to fetch active auction' });
    }
});

/**
 * GET /api/territories/:id
 * 영토 상세 조회
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Redis에서 먼저 조회
        const cacheKey = `territory:${id}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // DB에서 조회
        const result = await query(
            `SELECT 
                t.*,
                u.nickname as ruler_nickname,
                u.email as ruler_email,
                u.firebase_uid as ruler_firebase_uid,
                a.id as auction_id,
                a.status as auction_status,
                a.current_bid as auction_current_bid,
                a.end_time as auction_end_time
            FROM territories t
            LEFT JOIN users u ON t.ruler_id = u.id
            LEFT JOIN auctions a ON t.current_auction_id = a.id AND a.status = 'active'
            WHERE t.id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = result.rows[0];
        
        // Redis에 캐시
        await redis.set(cacheKey, territory, CACHE_TTL.TERRITORY_DETAIL);
        
        res.json(territory);
    } catch (error) {
        console.error('[Territories] Error:', error);
        res.status(500).json({ error: 'Failed to fetch territory' });
    }
});

/**
 * PUT /api/territories/:id
 * 영토 정보 업데이트 (소유권 변경, 상태 변경 등)
 */
router.put('/:id', async (req, res) => {
    // 인증 확인 (PUT은 Protected API)
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const client = await getPool().connect();
    
    try {
        const { id: territoryId } = req.params;
        const { 
            rulerId,
            rulerFirebaseUid,  // Firebase UID로도 받을 수 있음
            rulerName,
            status, 
            sovereignty,
            protectionUntil,
            protectionEndsAt,
            protectionDays,
            purchasedPrice,
            purchasedByAdmin
        } = req.body;
        const firebaseUid = req.user.uid;
        
        // 사용자 ID 조회 (요청 사용자)
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const currentUserId = userResult.rows[0].id;
        
        // rulerId 결정: rulerId가 있으면 사용, 없으면 rulerFirebaseUid로 조회, 둘 다 없으면 현재 사용자
        let finalRulerId = rulerId;
        if (!finalRulerId && rulerFirebaseUid) {
            const rulerUserResult = await query(
                `SELECT id FROM users WHERE firebase_uid = $1`,
                [rulerFirebaseUid]
            );
            if (rulerUserResult.rows.length > 0) {
                finalRulerId = rulerUserResult.rows[0].id;
            }
        }
        if (!finalRulerId) {
            // 둘 다 없으면 현재 사용자를 ruler로 설정 (구매 시나리오)
            finalRulerId = currentUserId;
        }
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 현재 영토 정보 조회
        const territoryResult = await client.query(
            `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const currentTerritory = territoryResult.rows[0];
        const previousStatus = currentTerritory.status;
        const previousRulerId = currentTerritory.ruler_id;
        
        // 동시성 검증: ruler가 이미 설정되어 있고 다른 사용자이면 실패
        if (finalRulerId && currentTerritory.ruler_id && currentTerritory.ruler_id !== finalRulerId) {
            await client.query('ROLLBACK');
            return res.status(409).json({ 
                error: 'Territory already owned by another user',
                currentOwner: currentTerritory.ruler_id
            });
        }
        
        // 업데이트할 필드 구성
        const updates = [];
        const params = [];
        let paramIndex = 1;
        
        if (finalRulerId !== undefined) {
            updates.push(`ruler_id = $${paramIndex}`);
            params.push(finalRulerId);
            paramIndex++;
        }
        
        if (rulerName !== undefined) {
            updates.push(`ruler_name = $${paramIndex}`);
            params.push(rulerName);
            paramIndex++;
        }
        
        if (status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }
        
        // sovereignty와 status는 둘 다 있을 수 있음 (sovereignty 우선)
        if (sovereignty !== undefined) {
            // sovereignty를 status로 매핑
            const mappedStatus = sovereignty === 'protected' ? 'protected' : 
                                 sovereignty === 'ruled' ? 'ruled' : 
                                 sovereignty === 'unconquered' ? 'unconquered' : 
                                 sovereignty;
            updates.push(`status = $${paramIndex}`);
            params.push(mappedStatus);
            paramIndex++;
            // sovereignty 필드도 함께 저장 (호환성)
            updates.push(`sovereignty = $${paramIndex}`);
            params.push(sovereignty);
            paramIndex++;
        }
        
        if (protectionUntil !== undefined) {
            updates.push(`protection_ends_at = $${paramIndex}`);
            params.push(protectionUntil);
            paramIndex++;
        }
        
        if (protectionEndsAt !== undefined) {
            updates.push(`protection_ends_at = $${paramIndex}`);
            params.push(protectionEndsAt);
            paramIndex++;
        }
        
        if (purchasedPrice !== undefined) {
            updates.push(`base_price = $${paramIndex}`);
            params.push(purchasedPrice);
            paramIndex++;
        }
        
        if (purchasedByAdmin !== undefined) {
            updates.push(`purchased_by_admin = $${paramIndex}`);
            params.push(purchasedByAdmin);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(territoryId);
        
        // 영토 업데이트
        const updateResult = await client.query(
            `UPDATE territories 
             SET ${updates.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING *`,
            params
        );
        
        // 소유권 변경 시 ownerships 테이블에 기록
        if (finalRulerId && (!previousRulerId || previousRulerId !== finalRulerId)) {
            // 이전 소유권 종료 처리
            if (previousRulerId) {
                await client.query(
                    `UPDATE ownerships 
                     SET ended_at = NOW() 
                     WHERE territory_id = $1 AND user_id = $2 AND ended_at IS NULL`,
                    [territoryId, previousRulerId]
                );
            }
            
            // 새 소유권 기록
            await client.query(
                `INSERT INTO ownerships (territory_id, user_id, acquired_at, price)
                 VALUES ($1, $2, NOW(), $3)`,
                [territoryId, finalRulerId, purchasedPrice || currentTerritory.base_price || 0]
            );
        }
        
        await client.query('COMMIT');
        
        const updatedTerritory = updateResult.rows[0];
        
        // Redis 캐시 무효화
        await invalidateTerritoryCache(territoryId);
        
        // 사용자 정보 조회 (ruler 정보)
        let rulerNickname = null;
        let updatedRulerFirebaseUid = null;
        if (updatedTerritory.ruler_id) {
            const rulerResult = await query(
                `SELECT nickname, email, firebase_uid FROM users WHERE id = $1`,
                [updatedTerritory.ruler_id]
            );
            if (rulerResult.rows.length > 0) {
                rulerNickname = rulerResult.rows[0].nickname || rulerResult.rows[0].email;
                updatedRulerFirebaseUid = rulerResult.rows[0].firebase_uid;
            }
        }
        
        // 응답에 firebase_uid 포함
        const responseTerritory = {
            ...updatedTerritory,
            ruler_firebase_uid: updatedRulerFirebaseUid,
            ruler_name: rulerNickname || updatedTerritory.ruler_name,
            sovereignty: updatedTerritory.sovereignty || updatedTerritory.status
        };
        
        // WebSocket으로 영토 업데이트 브로드캐스트
        broadcastTerritoryUpdate(territoryId, {
            id: updatedTerritory.id,
            status: updatedTerritory.status,
            sovereignty: updatedTerritory.sovereignty || updatedTerritory.status, // sovereignty 필드 우선
            previousStatus: previousStatus,
            rulerId: updatedTerritory.ruler_id,
            rulerFirebaseUid: updatedRulerFirebaseUid,
            rulerName: rulerNickname || updatedTerritory.ruler_name,
            previousRulerId: previousRulerId,
            protectionEndsAt: updatedTerritory.protection_ends_at,
            protectionUntil: updatedTerritory.protection_ends_at, // 호환성
            purchasedPrice: updatedTerritory.base_price,
            purchasedByAdmin: updatedTerritory.purchased_by_admin,
            updatedAt: updatedTerritory.updated_at
        });
        
        res.json(responseTerritory);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Territories] Update error:', error);
        res.status(500).json({ error: 'Failed to update territory' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/territories/:id/view
 * 영토 조회수 증가
 */
router.post('/:id/view', async (req, res) => {
    try {
        const { id: territoryId } = req.params;
        
        // Redis에서 조회수 증가 (atomic increment)
        const viewCountKey = `territory:${territoryId}:views`;
        const viewCount = await redis.incr(viewCountKey);
        
        // Redis TTL 설정 (1일)
        await redis.expire(viewCountKey, 86400);
        
        // DB에서도 조회수 업데이트 (비동기, 실패해도 계속 진행)
        query(
            `UPDATE territories 
             SET view_count = COALESCE(view_count, 0) + 1, 
                 last_viewed_at = NOW()
             WHERE id = $1`,
            [territoryId]
        ).catch(err => {
            console.error(`[Territories] Failed to update view count in DB:`, err);
        });
        
        res.json({ success: true, viewCount });
    } catch (error) {
        console.error('[Territories] View count error:', error);
        res.status(500).json({ error: 'Failed to increment view count' });
    }
});

// 픽셀 데이터 라우터 import 및 마운트
import { pixelsRouter } from './pixels.js';
router.use('/:territoryId/pixels', pixelsRouter);

export { router as territoriesRouter };
