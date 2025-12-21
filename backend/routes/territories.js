/**
 * Territories API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateTerritoryCache } from '../redis/cache-utils.js';
import { broadcastTerritoryUpdate } from '../websocket/index.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';

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
        // ⚠️ 전문가 조언 반영: ruler_firebase_uid를 포함하여 소유권 정보 완전성 보장
        let sql = `SELECT 
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
        
        // ⚠️ 전문가 조언 반영: 응답 형식 일관성 확보 - ruler_firebase_uid로 통일
        const territories = result.rows.map(row => ({
            id: row.id,
            code: row.code,
            name: row.name,
            name_en: row.name_en,
            country: row.country,
            continent: row.continent,
            status: row.status,
            sovereignty: row.sovereignty,
            ruler_id: row.ruler_id || null,
            ruler_firebase_uid: row.ruler_firebase_uid || null,
            ruler_nickname: row.ruler_nickname || row.ruler_name || null,
            ruler: row.ruler_id ? {
                id: row.ruler_id,
                firebase_uid: row.ruler_firebase_uid,
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
 * POST /api/territories/:id/view
 * 영토 조회수 증가
 */
router.post('/:id/view', async (req, res) => {
    try {
        const { id: territoryIdParam } = req.params;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 조회수 증가 (비동기, 실패해도 에러 반환하지 않음)
        try {
            await query(
                `UPDATE territories 
                 SET view_count = COALESCE(view_count, 0) + 1,
                     updated_at = NOW()
                 WHERE id = $1`,
                [territoryId]
            );
            
            // Redis 캐시 무효화
            await invalidateTerritoryCache(territoryId);
        } catch (updateError) {
            // 조회수 업데이트 실패는 무시 (로그만 기록)
            console.warn(`[Territories] Failed to increment view count for ${territoryId}:`, updateError.message);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('[Territories] View count increment error:', error);
        res.status(500).json({ error: 'Failed to increment view count' });
    }
});

/**
 * POST /api/territories/:id/purchase
 * 영토 구매 (전문가 조언: 원자성 보장 - 포인트 차감과 소유권 부여를 하나의 트랜잭션으로)
 */
router.post('/:id/purchase', async (req, res) => {
    // 인증 확인
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const client = await getPool().connect();
    
    try {
        const { id: territoryIdParam } = req.params;
        const { 
            price,
            protectionDays,
            purchasedByAdmin = false
        } = req.body;
        const firebaseUid = req.user.uid;
        
        // ID 검증 및 Canonical ID 변환 (트랜잭션 시작 전에 수행)
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            client.release();
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 트랜잭션 시작 (원자성 보장)
        await client.query('BEGIN');
        
        try {
            // 1. 사용자 ID 조회
            const userResult = await client.query(
                `SELECT id, firebase_uid FROM users WHERE firebase_uid = $1 FOR UPDATE`,
                [firebaseUid]
            );
            
            if (userResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: 'User not found' });
            }
            
            const userId = userResult.rows[0].id;
            
            // ⚠️ 디버깅: userId 타입 확인
            console.log(`[Territories] Purchase: userId type=${typeof userId}, value=${userId}, firebase_uid=${firebaseUid}`);
            
            // 지갑 조회 및 잠금 (wallets 테이블 사용)
            const walletResult = await client.query(
                `SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let currentBalance = 0;
            let walletId = null;
            if (walletResult.rows.length === 0) {
                // 지갑이 없으면 생성
                const insertResult = await client.query(
                    `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) RETURNING id`,
                    [userId]
                );
                walletId = insertResult.rows[0].id;
            } else {
                currentBalance = parseFloat(walletResult.rows[0].balance || 0);
                walletId = walletResult.rows[0].id;
            }
            
            // 2. 영토 정보 조회 및 잠금
            const territoryResult = await client.query(
                `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
                [territoryId]
            );
            
            if (territoryResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: 'Territory not found' });
            }
            
            const territory = territoryResult.rows[0];
            
            // 3. 이미 소유자가 있는지 확인
            if (territory.ruler_id && territory.ruler_id !== userId) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(409).json({ 
                    error: 'Territory already owned by another user',
                    currentOwner: territory.ruler_id
                });
            }
            
            // 4. 가격 확인
            const purchasePrice = price || parseFloat(territory.base_price || 0);
            if (purchasePrice <= 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(400).json({ error: 'Invalid purchase price' });
            }
            
            // 5. 잔액 확인
            if (currentBalance < purchasePrice) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(402).json({ 
                    error: 'Insufficient balance',
                    required: purchasePrice,
                    current: currentBalance
                });
            }
            
            // 6. 포인트 차감 및 소유권 부여 (원자적 처리)
            const newBalance = currentBalance - purchasePrice;
            
            // 포인트 차감 (wallets 테이블 업데이트)
            const updateWalletResult = await client.query(
                `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance`,
                [newBalance, userId]
            );
            
            if (updateWalletResult.rows.length === 0) {
                throw new Error('Failed to update wallet balance');
            }
            
            // 거래 내역 기록 (wallet_transactions 테이블 사용 - 기존 테이블 활용)
            if (walletId) {
                await client.query(
                    `INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference_id)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [walletId, userId, 'purchase', -purchasePrice, `Territory purchase: ${territoryId}`, territoryId]
                );
            }
            
            // 보호 기간 계산
            let protectionEndsAt = null;
            if (protectionDays && protectionDays > 0) {
                protectionEndsAt = new Date();
                protectionEndsAt.setDate(protectionEndsAt.getDate() + protectionDays);
            }
            
            // 소유권 부여
            const previousRulerId = territory.ruler_id;
            
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
                [territoryId, userId, purchasePrice]
            );
            
            // 영토 업데이트
            const updateResult = await client.query(
                `UPDATE territories 
                 SET ruler_id = $1,
                     ruler_name = (SELECT nickname FROM users WHERE id = $1),
                     status = 'protected',
                     sovereignty = 'protected',
                     protection_ends_at = $2,
                     base_price = $3,
                     purchased_by_admin = $4,
                     updated_at = NOW()
                 WHERE id = $5
                 RETURNING *`,
                [userId, protectionEndsAt, purchasePrice, purchasedByAdmin, territoryId]
            );
            
            // ⚠️ 디버깅: 업데이트 결과 확인
            if (updateResult.rows.length > 0) {
                console.log(`[Territories] Purchase: Territory updated:`, {
                    territoryId: updateResult.rows[0].id,
                    ruler_id: updateResult.rows[0].ruler_id,
                    ruler_id_type: typeof updateResult.rows[0].ruler_id,
                    sovereignty: updateResult.rows[0].sovereignty
                });
            }
            
            if (updateResult.rows.length === 0) {
                throw new Error('Failed to update territory ownership');
            }
            
            // 7. History 로깅 (감사로그)
            try {
                await client.query(
                    `INSERT INTO territory_history (territory_id, user_id, event_type, metadata, created_at)
                     VALUES ($1, $2, 'purchase', $3, NOW())`,
                    [territoryId, userId, JSON.stringify({
                        price: purchasePrice,
                        previousRulerId: previousRulerId,
                        protectionDays: protectionDays,
                        purchasedByAdmin: purchasedByAdmin
                    })]
                );
            } catch (historyError) {
                // History 테이블이 없어도 구매는 성공 (나중에 테이블 생성 가능)
                console.warn('[Territories] History logging failed (table may not exist):', historyError.message);
            }
            
            // 트랜잭션 커밋
            await client.query('COMMIT');
            
            const updatedTerritory = updateResult.rows[0];
            
            // 사용자 정보 조회 (ruler_firebase_uid 포함)
            let rulerFirebaseUid = null;
            let rulerNickname = null;
            if (updatedTerritory.ruler_id) {
                const rulerResult = await query(
                    `SELECT firebase_uid, nickname FROM users WHERE id = $1`,
                    [updatedTerritory.ruler_id]
                );
                if (rulerResult.rows.length > 0) {
                    rulerFirebaseUid = rulerResult.rows[0].firebase_uid;
                    rulerNickname = rulerResult.rows[0].nickname;
                }
            }
            
            // 응답 형식을 GET 엔드포인트와 동일하게 맞춤
            const responseTerritory = {
                ...updatedTerritory,
                ruler_firebase_uid: rulerFirebaseUid,
                ruler_nickname: rulerNickname || updatedTerritory.ruler_name
            };
            
            // Redis 캐시 무효화
            await invalidateTerritoryCache(territoryId);
            
            // WebSocket으로 영토 업데이트 브로드캐스트
            broadcastTerritoryUpdate(territoryId, {
                id: updatedTerritory.id,
                status: updatedTerritory.status,
                sovereignty: updatedTerritory.sovereignty,
                rulerId: updatedTerritory.ruler_id,
                rulerFirebaseUid: rulerFirebaseUid,
                rulerName: rulerNickname || updatedTerritory.ruler_name,
                previousRulerId: previousRulerId,
                protectionEndsAt: updatedTerritory.protection_ends_at,
                purchasedPrice: updatedTerritory.base_price,
                purchasedByAdmin: updatedTerritory.purchased_by_admin,
                updatedAt: updatedTerritory.updated_at
            });
            
            res.json({
                success: true,
                territory: responseTerritory,
                newBalance: newBalance,
                message: 'Territory purchased successfully'
            });
            
        } catch (error) {
            console.error('[Territories] Purchase transaction error:', error);
            await client.query('ROLLBACK');
            throw error;
        }
        
    } catch (error) {
        // 중첩된 에러 핸들링 - 롤백은 이미 내부에서 처리됨
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('[Territories] Rollback error:', rollbackError);
        }
        console.error('[Territories] Purchase error:', {
            error: error.message,
            stack: error.stack,
            territoryId: req.params.id,
            firebaseUid: req.user?.uid
        });
        res.status(500).json({ error: 'Failed to purchase territory', message: error.message });
    } finally {
        if (client) {
            client.release();
        }
    }
});

/**
 * GET /api/territories/:id
 * 영토 상세 조회
 */
router.get('/:id', async (req, res) => {
    try {
        const { id: territoryIdParam } = req.params;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // ⚠️ 전문가 조언 반영: reconcile용 요청은 캐시를 우회 (소유권 관련 필드는 강한 일관성 필요)
        // skipCache 쿼리 파라미터 또는 X-Skip-Cache 헤더로 캐시 우회 가능
        const skipCache = req.query.skipCache === 'true' || req.headers['x-skip-cache'] === 'true';
        
        // Redis에서 먼저 조회 (캐시 우회 옵션이 없을 때만)
        const cacheKey = `territory:${territoryId}`;
        let cached = null;
        
        if (!skipCache) {
            cached = await redis.get(cacheKey);
            if (cached) {
                return res.json(cached);
            }
        } else {
            console.log(`[Territories] ⚠️ Cache bypass requested for territory ${territoryId} (reconcile or fresh data needed)`);
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
            [territoryId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const row = result.rows[0];
        
        // ⚠️ 디버깅: 조인 결과 로깅 (소유권 문제 진단용)
        if (skipCache || row.ruler_id) {
            console.log(`[Territories] GET /${territoryId} (skipCache=${skipCache}):`, {
                territoryId: row.id,
                ruler_id: row.ruler_id,
                ruler_firebase_uid: row.ruler_firebase_uid,
                ruler_nickname: row.ruler_nickname,
                sovereignty: row.sovereignty,
                status: row.status
            });
        }
        
        // ⚠️ 전문가 조언 반영: 응답 형식 일관성 확보 - ruler_firebase_uid로 통일
        // 구매 API와 동일한 형식으로 응답 (ruler_firebase_uid 포함)
        const territory = {
            ...row,
            ruler_firebase_uid: row.ruler_firebase_uid || null,
            ruler_nickname: row.ruler_nickname || row.ruler_name || null
        };
        
        // Redis에 캐시 (에러 발생 시 무시하고 계속 진행)
        // ⚠️ 캐시 우회 옵션이 있을 때는 캐시를 업데이트하지 않음 (최신 데이터 보장)
        if (!skipCache) {
            try {
                await redis.set(cacheKey, territory, CACHE_TTL.TERRITORY_DETAIL);
            } catch (redisError) {
                console.warn('[Territories] Redis cache set failed (non-critical):', redisError.message);
            }
        }
        
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
        const { id: territoryIdParam } = req.params;
        
        // ID 검증 및 Canonical ID 변환 (전문가 조언: 잘못된 입력 차단)
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam,
                message: 'Territory ID must be in Canonical format (e.g., "texas") or will be auto-converted from Display format (e.g., "USA::texas")'
            });
        }
        
        const territoryId = idValidation.canonicalId;
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
 * GET /api/territories/:id/history
 * 영토 History 조회 (감사로그)
 */
router.get('/:id/history', async (req, res) => {
    try {
        const { id: territoryIdParam } = req.params;
        const { limit = 100, offset = 0 } = req.query;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: false
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // History 조회
        try {
            const result = await query(
                `SELECT 
                    th.*,
                    u.nickname as user_nickname,
                    u.email as user_email
                 FROM territory_history th
                 LEFT JOIN users u ON th.user_id = u.id
                 WHERE th.territory_id = $1
                 ORDER BY th.created_at DESC
                 LIMIT $2 OFFSET $3`,
                [territoryId, parseInt(limit), parseInt(offset)]
            );
            
            const history = result.rows.map(row => ({
                id: row.id,
                territoryId: row.territory_id,
                userId: row.user_id,
                user: row.user_id ? {
                    nickname: row.user_nickname,
                    email: row.user_email
                } : null,
                eventType: row.event_type,
                metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
                createdAt: row.created_at
            }));
            
            res.json({
                territoryId,
                history,
                count: history.length,
                limit: parseInt(limit),
                offset: parseInt(offset)
            });
        } catch (dbError) {
            // History 테이블이 없으면 빈 배열 반환
            if (dbError.message?.includes('does not exist') || dbError.message?.includes('relation')) {
                return res.json({
                    territoryId,
                    history: [],
                    count: 0,
                    message: 'History table not initialized'
                });
            }
            throw dbError;
        }
        
    } catch (error) {
        console.error('[Territories] History fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch history', message: error.message });
    }
});

/**
 * POST /api/territories/:id/history
 * 영토 History 로깅 (감사로그 기반)
 */
router.post('/:id/history', async (req, res) => {
    // 인증 확인
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const { id: territoryIdParam } = req.params;
        const { event, metadata } = req.body;
        const firebaseUid = req.user.uid;
        
        // ID 검증 및 Canonical ID 변환
        const idValidation = validateTerritoryIdParam(territoryIdParam, {
            strict: false,
            autoConvert: true,
            logWarning: true
        });
        
        if (!idValidation || !idValidation.canonicalId) {
            return res.status(400).json({ 
                error: idValidation?.error || 'Invalid territory ID format',
                received: territoryIdParam
            });
        }
        
        const territoryId = idValidation.canonicalId;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // History 테이블에 저장 (append-only 불변 로그)
        try {
            await query(
                `INSERT INTO territory_history (territory_id, user_id, event_type, metadata, created_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [territoryId, userId, event || 'unknown', JSON.stringify(metadata || {})]
            );
            
            res.json({ success: true, message: 'History logged successfully' });
        } catch (dbError) {
            // History 테이블이 없으면 경고만 (기능은 계속 동작)
            console.warn('[Territories] History table may not exist:', dbError.message);
            res.status(200).json({ 
                success: true, 
                message: 'History logging skipped (table not available)',
                warning: 'History table may not be initialized'
            });
        }
        
    } catch (error) {
        console.error('[Territories] History logging error:', error);
        res.status(500).json({ error: 'Failed to log history', message: error.message });
    }
});

// 픽셀 데이터 라우터 import 및 마운트
import { pixelsRouter } from './pixels.js';
router.use('/:territoryId/pixels', pixelsRouter);

export { router as territoriesRouter };
