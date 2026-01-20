/**
 * Territories API Routes
 */

import express from 'express';
import crypto from 'crypto';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateTerritoryCache } from '../redis/cache-utils.js';
import { broadcastTerritoryUpdate } from '../websocket/index.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';

const router = express.Router();

/**
 * ⚡ 성능 최적화: ETag 생성 헬퍼 함수
 * 응답 데이터의 해시를 기반으로 ETag 생성
 */
function generateETag(data) {
    const dataString = JSON.stringify(data);
    const hash = crypto.createHash('md5').update(dataString).digest('hex');
    return `"${hash}"`; // ETag는 따옴표로 감싸야 함
}

/**
 * GET /api/territories
 * 영토 목록 조회 (필터링 지원)
 * Query params: country, status, limit
 */
router.get('/', async (req, res) => {
    try {
        const { country, status, limit, fields } = req.query;
        
        console.log('[Territories] 📊 Fetching territories...', { country, status, limit, fields });
        console.log('[Territories] 🔍 Request received:', {
            method: req.method,
            url: req.url,
            query: req.query,
            headers: {
                'authorization': req.headers.authorization ? 'Bearer ***' : 'none',
                'user-agent': req.headers['user-agent']
            }
        });
        
        // ⚡ 성능 최적화: fields 파라미터 파싱 (쉼표로 구분된 필드 목록)
        const requestedFields = fields ? fields.split(',').map(f => f.trim()) : null;
        
        // Redis 캐시 키 생성 (fields 포함)
        const cacheKey = `territories:${country || 'all'}:${status || 'all'}:${limit || 'all'}:${fields || 'all'}`;
        let cached = null;
        
        try {
            cached = await redis.get(cacheKey);
            if (cached && Array.isArray(cached)) {
                console.log('[Territories] ✅ Territories loaded from cache');
                
                // ⚡ 픽셀 메타 필드가 요청되었는데 캐시에 없으면 캐시 무효화하고 DB에서 재조회
                const pixelMetaRequested = !requestedFields || requestedFields.length === 0 || (
                    requestedFields.includes('hasPixelArt') || 
                    requestedFields.includes('pixelCount') || 
                    requestedFields.includes('fillRatio') || 
                    requestedFields.includes('pixelUpdatedAt')
                );
                
                if (pixelMetaRequested && cached.length > 0) {
                    // 캐시된 항목 중 하나라도 픽셀 메타 필드가 없으면 캐시 무효화
                    const sampleItem = cached[0];
                    if (!('hasPixelArt' in sampleItem) || sampleItem.hasPixelArt === undefined) {
                        console.log('[Territories] ⚠️ Cache invalid: pixel metadata fields missing, fetching from DB...');
                        cached = null; // 캐시 무효화, DB에서 재조회
                    }
                }
                
                if (cached) {
                    // ⚡ 성능 최적화: ETag 생성 및 304 Not Modified 처리
                    const etag = generateETag(cached);
                    res.setHeader('ETag', etag);
                    res.setHeader('Cache-Control', 'public, max-age=10'); // 10초 캐시
                    
                    // 클라이언트가 If-None-Match 헤더로 ETag를 보냈고 일치하면 304 반환
                    const clientETag = req.headers['if-none-match'];
                    if (clientETag && clientETag === etag) {
                        console.log('[Territories] ✅ 304 Not Modified (ETag match)');
                        return res.status(304).end();
                    }
                    
                    return res.json(cached);
                }
            }
        } catch (redisError) {
            console.warn('[Territories] ⚠️ Redis cache read error (continuing with DB query):', redisError.message);
            // Redis 오류가 있어도 DB 쿼리는 계속 진행
        }
        
        console.log('[Territories] 📊 Fetching territories from database...');
        
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
        
        // ⚡ 픽셀 메타 필드가 요청된 경우 또는 전체 필드 반환 시 Redis에서 일괄 조회 (성능 최적화)
        const pixelMetaRequested = !requestedFields || requestedFields.length === 0 || (
            requestedFields.includes('hasPixelArt') || 
            requestedFields.includes('pixelCount') || 
            requestedFields.includes('fillRatio') || 
            requestedFields.includes('pixelUpdatedAt')
        );
        
        console.log('[Territories] 🔍 Pixel meta requested:', {
            pixelMetaRequested,
            requestedFields: requestedFields || 'all',
            territoryCount: result.rows.length
        });
        
        let pixelMetaMap = new Map();
        if (pixelMetaRequested && result.rows.length > 0) {
            console.log('[Territories] 🔍 Starting pixel metadata lookup from Redis...');
            const t1 = performance.now();
            try {
                // ⚡ 성능 최적화: MGET으로 일괄 조회 (개별 GET보다 훨씬 빠름)
                const territoryIds = result.rows.map(row => row.id);
                const redisKeys = territoryIds.map(id => `pixel_data:${id}`);
                
                // MGET으로 한 번에 조회
                const pixelDataArray = await redis.mget(redisKeys);
                
                // 결과 처리
                pixelDataArray.forEach((pixelData, index) => {
                    if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                        const territoryId = territoryIds[index];
                        const pixelCount = pixelData.pixels.length;
                        const width = pixelData.width || 64;
                        const height = pixelData.height || 64;
                        const totalPixels = width * height;
                        const fillRatio = totalPixels > 0 ? pixelCount / totalPixels : 0;
                        
                        pixelMetaMap.set(territoryId, {
                            territoryId,
                            hasPixelArt: true,
                            pixelCount,
                            fillRatio,
                            updatedAt: pixelData.updatedAt || pixelData.lastUpdated || null
                        });
                    }
                });
                
                const t2 = performance.now();
                console.log(`[Territories] ⚡ MGET pixel metadata time: ${Math.round(t2 - t1)}ms (${pixelMetaMap.size} territories with pixel art)`);
            } catch (error) {
                console.warn('[Territories] ⚠️ Failed to load pixel metadata from Redis:', error.message);
            }
        }
        
        // ⚡ 성능 최적화: fields 파라미터에 따라 필드 선택적 포함
        const territories = result.rows.map(row => {
            const territory = {};
            
            // ⚡ 필수 필드 (항상 포함)
            territory.id = row.id;
            
            // ⚡ fields 파라미터가 없으면 전체 필드 반환 (기존 동작)
            if (!requestedFields || requestedFields.length === 0) {
                territory.code = row.code;
                territory.name = row.name;
                territory.name_en = row.name_en;
                territory.country = row.country;
                territory.continent = row.continent;
                // ⚠️ 중요: countryIso 필수 포함 (경매 생성에 필수)
                territory.countryIso = row.country_iso || null;
                territory.status = row.status;
                territory.sovereignty = row.sovereignty;
                territory.ruler_id = row.ruler_id || null;
                territory.ruler_firebase_uid = row.ruler_firebase_uid || null;
                territory.ruler_nickname = row.ruler_nickname || row.ruler_name || null;
                territory.ruler = row.ruler_id ? {
                    id: row.ruler_id,
                    firebase_uid: row.ruler_firebase_uid,
                    name: row.ruler_name || row.ruler_nickname,
                    email: row.ruler_email
                } : null;
                territory.basePrice = parseFloat(row.base_price || 0);
                // ⚠️ 전문가 조언 반영: last_winning_amount 포함 (Price 표시에 필요)
                territory.last_winning_amount = row.last_winning_amount ? parseFloat(row.last_winning_amount) : null;
                territory.hasAuction = !!row.auction_id;
                territory.auction = row.auction_id ? {
                    id: row.auction_id,
                    status: row.auction_status,
                    currentBid: parseFloat(row.auction_current_bid || 0),
                    endTime: row.auction_end_time
                } : null;
                territory.polygon = row.polygon;
                territory.protectionEndsAt = row.protection_ends_at;
                territory.createdAt = row.created_at;
                territory.updatedAt = row.updated_at;
                
                // ⚡ 픽셀 메타 필드 포함 (전체 필드 반환 시)
                if (pixelMetaMap.has(row.id)) {
                    const meta = pixelMetaMap.get(row.id);
                    territory.hasPixelArt = meta.hasPixelArt;
                    territory.pixelCount = meta.pixelCount;
                    territory.fillRatio = meta.fillRatio;
                    territory.pixelUpdatedAt = meta.updatedAt;
                    // ⚡ 필드명 호환성: pixelArtUpdatedAt도 포함 (기존 코드 호환)
                    territory.pixelArtUpdatedAt = meta.updatedAt;
                } else {
                    // ⚡ 픽셀이 없어도 필드를 명시적으로 설정 (undefined 방지)
                    territory.hasPixelArt = false;
                    territory.pixelCount = 0;
                    territory.fillRatio = 0;
                    territory.pixelUpdatedAt = null;
                    territory.pixelArtUpdatedAt = null;
                }
            } else {
                // ⚡ fields 파라미터가 있으면 요청된 필드만 포함
                const fieldMap = {
                    'id': () => { territory.id = row.id; },
                    'sovereignty': () => { territory.sovereignty = row.sovereignty; },
                    'status': () => { territory.status = row.status; },
                    'ruler_firebase_uid': () => { territory.ruler_firebase_uid = row.ruler_firebase_uid || null; },
                    'ruler_id': () => { territory.ruler_id = row.ruler_id || null; },
                    'ruler_nickname': () => { territory.ruler_nickname = row.ruler_nickname || row.ruler_name || null; },
                    'hasAuction': () => { territory.hasAuction = !!row.auction_id; },
                    'updatedAt': () => { territory.updatedAt = row.updated_at; },
                    'protectionEndsAt': () => { territory.protectionEndsAt = row.protection_ends_at; },
                    'basePrice': () => { territory.basePrice = parseFloat(row.base_price || 0); },
                    // ⚠️ 전문가 조언 반영: last_winning_amount 포함 (Price 표시에 필요)
                    'last_winning_amount': () => { territory.last_winning_amount = row.last_winning_amount ? parseFloat(row.last_winning_amount) : null; },
                    // ⚠️ 중요: countryIso 필수 필드로 포함 (경매 생성에 필수)
                    'countryIso': () => { territory.countryIso = row.country_iso || null; },
                    // 선택적 필드 (초기 로딩에 불필요)
                    'code': () => { territory.code = row.code; },
                    'name': () => { territory.name = row.name; },
                    'name_en': () => { territory.name_en = row.name_en; },
                    'country': () => { territory.country = row.country; },
                    'continent': () => { territory.continent = row.continent; },
                    'polygon': () => { territory.polygon = row.polygon; },
                    'createdAt': () => { territory.createdAt = row.created_at; },
                    'ruler': () => {
                        territory.ruler = row.ruler_id ? {
                            id: row.ruler_id,
                            firebase_uid: row.ruler_firebase_uid,
                            name: row.ruler_name || row.ruler_nickname,
                            email: row.ruler_email
                        } : null;
                    },
                    'auction': () => {
                        territory.auction = row.auction_id ? {
                            id: row.auction_id,
                            status: row.auction_status,
                            currentBid: parseFloat(row.auction_current_bid || 0),
                            endTime: row.auction_end_time
                        } : null;
                    },
                    // ⚡ 픽셀 메타 필드 (게스트 지원) - Redis에서 조회한 메타 사용
                    'hasPixelArt': () => {
                        const meta = pixelMetaMap.get(row.id);
                        territory.hasPixelArt = meta ? meta.hasPixelArt : false;
                    },
                    'pixelCount': () => {
                        const meta = pixelMetaMap.get(row.id);
                        territory.pixelCount = meta ? meta.pixelCount : 0;
                    },
                    'fillRatio': () => {
                        const meta = pixelMetaMap.get(row.id);
                        territory.fillRatio = meta ? meta.fillRatio : 0;
                    },
                    'pixelUpdatedAt': () => {
                        const meta = pixelMetaMap.get(row.id);
                        territory.pixelUpdatedAt = meta ? meta.updatedAt : null;
                        // ⚡ 필드명 호환성: pixelArtUpdatedAt도 포함 (기존 코드 호환)
                        territory.pixelArtUpdatedAt = meta ? meta.updatedAt : null;
                    }
                };
                
                // 요청된 필드만 추가
                for (const field of requestedFields) {
                    if (fieldMap[field]) {
                        fieldMap[field]();
                    }
                }
            }
            
            return territory;
        });
        
        // ⚡ 성능 최적화: ETag 생성 및 캐시 헤더 설정
        const etag = generateETag(territories);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=10'); // 10초 캐시
        
        // 클라이언트가 If-None-Match 헤더로 ETag를 보냈고 일치하면 304 반환
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
            console.log('[Territories] ✅ 304 Not Modified (ETag match)');
            return res.status(304).end();
        }
        
        // Redis에 캐시 - 실패해도 응답은 반환
        try {
            await redis.set(cacheKey, territories, CACHE_TTL.TERRITORY_LIST);
            console.log('[Territories] ✅ Territories cached in Redis');
        } catch (redisError) {
            console.warn('[Territories] ⚠️ Redis cache write error (response still sent):', redisError.message);
        }
        
        console.log('[Territories] ✅ Territories fetched successfully:', { count: territories.length });
        res.json(territories);
    } catch (error) {
        console.error('[Territories] ❌❌❌ Error:', {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
            fullError: error
        });
        res.status(500).json({ 
            error: 'Failed to fetch territories',
            details: error.message,
            errorCode: error.code || 'UNKNOWN_ERROR'
        });
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
            
            // ⚠️ 디버깅: userId 타입 확인 (상세)
            console.log(`[Territories] Purchase: userId type=${typeof userId}, value=${userId}, valueString=${String(userId)}, firebase_uid=${firebaseUid}`);
            console.log(`[Territories] Purchase: userId constructor=${userId?.constructor?.name}`);
            
            // ⚠️ 핵심 수정: DB 스키마에 따르면 users.id는 UUID 타입이므로 UUID를 그대로 사용
            // UUID를 string으로 변환하여 저장 (PostgreSQL UUID 타입은 string으로 처리)
            if (userId === null || userId === undefined) {
                await client.query('ROLLBACK');
                client.release();
                console.error(`[Territories] Purchase: userId is null or undefined`);
                return res.status(500).json({ error: 'User ID is missing' });
            }
            
            // userId를 string으로 변환 (UUID는 string으로 처리)
            const userIdString = String(userId);
            console.log(`[Territories] Purchase: Using userId as UUID: ${userIdString}`);
            
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
            
            // ⚠️ 중요: market_base_price 계산 (초기 구매 시)
            // 기존 market_base_price가 있으면 유지, 없으면 base_price와 purchasePrice 중 큰 값 사용
            let marketBasePrice = parseFloat(territory.market_base_price || 0);
            if (!marketBasePrice || marketBasePrice <= 0) {
                const basePrice = parseFloat(territory.base_price || 0);
                marketBasePrice = Math.max(basePrice, purchasePrice);
                console.log(`[Territories] Purchase: Setting initial market_base_price: ${marketBasePrice} (basePrice: ${basePrice}, purchasePrice: ${purchasePrice})`);
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
            // ⚠️ 핵심 수정: userIdString를 사용하여 UUID로 저장 (DB 스키마에 맞춤)
            console.log(`[Territories] Purchase: About to UPDATE territory ${territoryId} with ruler_id=${userIdString} (type=${typeof userIdString})`);
            const updateResult = await client.query(
                `UPDATE territories 
                SET ruler_id = $1,
                    ruler_name = (SELECT nickname FROM users WHERE id = $1),
                    status = 'protected',
                    sovereignty = 'protected',
                    protection_ends_at = $2,
                    base_price = $3,
                    market_base_price = $4,
                    purchased_by_admin = $5,
                    updated_at = NOW()
                WHERE id = $6
                RETURNING *`,
                [userIdString, protectionEndsAt, purchasePrice, marketBasePrice, purchasedByAdmin, territoryId]
            );
            
            // ⚠️ 디버깅: 업데이트 결과 확인
            if (updateResult.rows.length > 0) {
                console.log(`[Territories] Purchase: Territory updated (RETURNING result):`, {
                    territoryId: updateResult.rows[0].id,
                    ruler_id: updateResult.rows[0].ruler_id,
                    ruler_id_type: typeof updateResult.rows[0].ruler_id,
                    ruler_id_value: updateResult.rows[0].ruler_id,
                    sovereignty: updateResult.rows[0].sovereignty,
                    status: updateResult.rows[0].status,
                    updated_at: updateResult.rows[0].updated_at
                });
            } else {
                console.error(`[Territories] Purchase: UPDATE returned 0 rows! Territory ${territoryId} may not exist.`);
            }
            
            if (updateResult.rows.length === 0) {
                throw new Error('Failed to update territory ownership');
            }
            
            // ⚠️ 핵심 수정: History 로깅은 트랜잭션 밖으로 이동
            // History 로깅 실패가 전체 트랜잭션을 abort시키지 않도록 함
            // History는 부가 기능이므로 실패해도 구매는 성공해야 함
            
            // 트랜잭션 커밋
            console.log(`[Territories] Purchase: About to COMMIT transaction for territory ${territoryId}`);
            console.log(`[Territories] Purchase: Pre-commit state:`, {
                territoryId: updateResult.rows[0].id,
                ruler_id: updateResult.rows[0].ruler_id,
                sovereignty: updateResult.rows[0].sovereignty,
                status: updateResult.rows[0].status,
                updated_at: updateResult.rows[0].updated_at
            });
            
            // ⚠️ 핵심 진단: COMMIT 전에 실제 DB 상태 확인 (같은 connection에서)
            const preCommitCheck = await client.query(
                `SELECT id, ruler_id, sovereignty, status, updated_at FROM territories WHERE id = $1`,
                [territoryId]
            );
            console.log(`[Territories] Purchase: Pre-commit DB check (same connection):`, {
                id: preCommitCheck.rows[0]?.id,
                ruler_id: preCommitCheck.rows[0]?.ruler_id,
                sovereignty: preCommitCheck.rows[0]?.sovereignty,
                status: preCommitCheck.rows[0]?.status,
                updated_at: preCommitCheck.rows[0]?.updated_at
            });
            
            await client.query('COMMIT');
            console.log(`[Territories] Purchase: Transaction COMMITTED for territory ${territoryId}`);
            
            const updatedTerritory = updateResult.rows[0];
            
            // ⚠️ 핵심 수정: COMMIT 후에는 새로운 connection을 사용하여 조회
            // 같은 connection을 사용하면 트랜잭션 격리 수준 문제가 있을 수 있음
            const verifyClient = await getPool().connect();
            
            try {
                // ⚠️ 디버깅: 스키마 및 테이블 정보 확인
                const schemaCheck = await verifyClient.query(`
                    SELECT 
                        table_schema,
                        table_name,
                        table_type
                    FROM information_schema.tables 
                    WHERE table_name = 'territories'
                `);
                console.log(`[Territories] Purchase: Schema check:`, schemaCheck.rows);
                
                // ⚠️ 핵심 진단: 모든 트리거 확인
                const triggersCheck = await verifyClient.query(`
                    SELECT 
                        trigger_name,
                        event_manipulation,
                        action_timing,
                        action_statement
                    FROM information_schema.triggers
                    WHERE event_object_table = 'territories'
                `);
                console.log(`[Territories] Purchase: Triggers on territories table:`, triggersCheck.rows);
                
                // ⚠️ 핵심 진단: 제약 조건 확인
                const constraintsCheck = await verifyClient.query(`
                    SELECT 
                        constraint_name,
                        constraint_type
                    FROM information_schema.table_constraints
                    WHERE table_name = 'territories'
                `);
                console.log(`[Territories] Purchase: Constraints on territories table:`, constraintsCheck.rows);
                
                // ⚠️ 핵심 진단: 뷰 확인 (territories가 뷰인지)
                const viewsCheck = await verifyClient.query(`
                    SELECT 
                        table_schema,
                        table_name,
                        view_definition
                    FROM information_schema.views
                    WHERE table_name = 'territories'
                `);
                console.log(`[Territories] Purchase: Views named 'territories':`, viewsCheck.rows);
                
                // ⚠️ 디버깅: 커밋 후 실제 DB에서 확인 (새로운 connection 사용)
                // ⚠️ 명시적으로 public 스키마 지정
                const verifyResult = await verifyClient.query(
                    `SELECT id, ruler_id, sovereignty, status, updated_at FROM public.territories WHERE id = $1`,
                    [territoryId]
                );
                
                if (verifyResult.rows.length > 0) {
                    const dbTerritory = verifyResult.rows[0];
                    console.log(`[Territories] Purchase: Verified DB state after commit (new connection):`, {
                        id: dbTerritory.id,
                        ruler_id: dbTerritory.ruler_id,
                        ruler_id_type: typeof dbTerritory.ruler_id,
                        sovereignty: dbTerritory.sovereignty,
                        status: dbTerritory.status,
                        updated_at: dbTerritory.updated_at
                    });
                    
                    // ⚠️ 검증: DB에 실제로 저장되었는지 확인
                    if (!dbTerritory.ruler_id || dbTerritory.ruler_id !== updatedTerritory.ruler_id) {
                        console.error(`[Territories] ⚠️ WARNING: DB state mismatch! Expected ruler_id: ${updatedTerritory.ruler_id}, Got: ${dbTerritory.ruler_id}`);
                        
                        // ⚠️ 핵심 진단: 최근 변경 이력 확인
                        const changeHistory = await verifyClient.query(`
                            SELECT 
                                xact_start,
                                state,
                                query_start,
                                wait_event_type,
                                wait_event,
                                query
                            FROM pg_stat_activity 
                            WHERE pid = pg_backend_pid()
                        `);
                        console.log(`[Territories] Purchase: Current connection state:`, changeHistory.rows);
                        
                        // ⚠️ 핵심 진단: 최근 트랜잭션 로그 확인 (가능한 경우)
                        try {
                            const recentTxLog = await verifyClient.query(`
                                SELECT 
                                    xid,
                                    committed,
                                    timestamp
                                FROM pg_prepared_xacts
                                ORDER BY timestamp DESC
                                LIMIT 5
                            `);
                            console.log(`[Territories] Purchase: Recent prepared transactions:`, recentTxLog.rows);
                        } catch (txLogError) {
                            console.warn(`[Territories] Purchase: Could not check transaction log:`, txLogError.message);
                        }
                        
                        // ⚠️ 핵심 진단: 다른 connection에서도 확인
                        const otherConnectionCheck = await getPool().connect();
                        try {
                            const otherResult = await otherConnectionCheck.query(
                                `SELECT id, ruler_id, sovereignty, status, updated_at FROM public.territories WHERE id = $1`,
                                [territoryId]
                            );
                            console.log(`[Territories] Purchase: Check from another connection:`, {
                                id: otherResult.rows[0]?.id,
                                ruler_id: otherResult.rows[0]?.ruler_id,
                                sovereignty: otherResult.rows[0]?.sovereignty,
                                status: otherResult.rows[0]?.status,
                                updated_at: otherResult.rows[0]?.updated_at
                            });
                        } finally {
                            otherConnectionCheck.release();
                        }
                    } else {
                        console.log(`[Territories] Purchase: ✅ DB state verified successfully!`);
                    }
                } else {
                    console.error(`[Territories] ⚠️ WARNING: Territory not found in DB after commit: ${territoryId}`);
                }
                
                // 사용자 정보 조회 (ruler_firebase_uid 포함)
                // ⚠️ 핵심 수정: ruler_id는 UUID이므로 그대로 사용
                let rulerFirebaseUid = null;
                let rulerNickname = null;
                if (updatedTerritory.ruler_id) {
                    const rulerResult = await verifyClient.query(
                        `SELECT firebase_uid, nickname FROM users WHERE id = $1`,
                        [updatedTerritory.ruler_id]
                    );
                    if (rulerResult.rows.length > 0) {
                        rulerFirebaseUid = rulerResult.rows[0].firebase_uid;
                        rulerNickname = rulerResult.rows[0].nickname;
                    } else {
                        console.warn(`[Territories] Purchase: User not found for ruler_id: ${updatedTerritory.ruler_id}`);
                    }
                }
                
                // 응답 형식을 GET 엔드포인트와 동일하게 맞춤
                // ⚠️ 핵심 수정: ruler_id는 UUID이므로 그대로 반환
                const responseTerritory = {
                    ...updatedTerritory,
                    ruler_id: updatedTerritory.ruler_id || null,
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
            } finally {
                verifyClient.release();
            }
            
            // ⚠️ 핵심 수정: History 로깅을 트랜잭션 밖에서 실행
            // 트랜잭션이 성공적으로 커밋된 후에만 History 로깅 시도
            // History 로깅 실패가 구매 성공에 영향을 주지 않도록 함
            try {
                const historyClient = await getPool().connect();
                try {
                    await historyClient.query(
                        `INSERT INTO territory_history (territory_id, user_id, event_type, metadata, created_at)
                         VALUES ($1, $2, 'purchase', $3, NOW())`,
                        [territoryId, userId, JSON.stringify({
                            price: purchasePrice,
                            previousRulerId: previousRulerId,
                            protectionDays: protectionDays,
                            purchasedByAdmin: purchasedByAdmin
                        })]
                    );
                    console.log(`[Territories] Purchase: History logged successfully for territory ${territoryId}`);
                } catch (historyError) {
                    // History 테이블이 없어도 구매는 성공 (나중에 테이블 생성 가능)
                    console.warn('[Territories] History logging failed (table may not exist):', historyError.message);
                } finally {
                    historyClient.release();
                }
            } catch (historyConnectionError) {
                // History 로깅을 위한 connection 획득 실패도 무시
                console.warn('[Territories] Failed to get connection for history logging:', historyConnectionError.message);
            }
            
        } catch (error) {
            console.error('[Territories] Purchase transaction error:', error);
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('[Territories] Rollback error:', rollbackError);
            }
            // ⚠️ 주의: client.release()는 finally 블록에서 처리되므로 여기서 호출하지 않음
            throw error;
        }
        
    } catch (error) {
        // 중첩된 에러 핸들링 - 롤백은 이미 내부에서 처리됨
        // ⚠️ 주의: client가 이미 release되었을 수 있으므로 확인 필요
        if (client && !client.released) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('[Territories] Rollback error:', rollbackError);
            }
        }
        // ⚠️ 주의: client.release()는 finally 블록에서 처리되므로 여기서 호출하지 않음
        console.error('[Territories] Purchase error:', {
            error: error.message,
            stack: error.stack,
            territoryId: req.params.id,
            firebaseUid: req.user?.uid
        });
        res.status(500).json({ error: 'Failed to purchase territory', message: error.message });
    } finally {
        if (client && !client.released) {
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
        
        // ⚠️ 디버깅: 조인 결과 로깅 (소유권 문제 진단용) - 항상 로깅
        // ⚠️ 중요: country_iso 확인
        console.log(`[Territories] GET /${territoryId} (skipCache=${skipCache}):`, {
            territoryId: row.id,
            country: row.country,
            country_iso: row.country_iso, // ⚠️ 중요: DB에서 가져온 값
            ruler_id: row.ruler_id,
            ruler_id_type: typeof row.ruler_id,
            ruler_firebase_uid: row.ruler_firebase_uid,
            ruler_nickname: row.ruler_nickname,
            sovereignty: row.sovereignty,
            status: row.status,
            // JOIN 결과 확인
            user_id_from_join: row.ruler_id ? 'present' : 'null',
            firebase_uid_from_join: row.ruler_firebase_uid ? 'present' : 'null'
        });
        
        // ⚠️ 디버깅: JOIN 실패 원인 확인
        if (row.ruler_id && !row.ruler_firebase_uid) {
            console.error(`[Territories] ⚠️ JOIN FAILED: ruler_id exists (${row.ruler_id}) but ruler_firebase_uid is null`);
            console.error(`[Territories] ⚠️ This indicates the JOIN condition failed or user not found`);
        }
        
        // ⚠️ 전문가 조언 반영: 응답 형식 일관성 확보 - ruler_firebase_uid로 통일
        // 구매 API와 동일한 형식으로 응답 (ruler_firebase_uid 포함)
        // ⚠️ 중요: countryIso 필수 포함 (경매 생성에 필수)
        // ⚠️ 중요: row 객체의 모든 키 확인 (디버깅)
        console.log(`[Territories] GET /${territoryId}: row keys:`, Object.keys(row).filter(k => k.includes('country') || k.includes('iso')));
        console.log(`[Territories] GET /${territoryId}: row.country_iso=`, row.country_iso, `(type: ${typeof row.country_iso})`);
        
        const territory = {
            ...row,
            ruler_firebase_uid: row.ruler_firebase_uid || null,
            ruler_nickname: row.ruler_nickname || row.ruler_name || null,
            // country_iso를 countryIso로 매핑 (프론트엔드 호환성)
            // ⚠️ 중요: row.country_iso가 undefined일 수 있으므로 명시적으로 확인
            countryIso: (row.country_iso && row.country_iso.length === 3) ? row.country_iso.toUpperCase() : null
        };
        
        // ⚠️ 디버깅: countryIso 포함 확인
        console.log(`[Territories] GET /${territoryId}: country_iso=${row.country_iso}, countryIso=${territory.countryIso}`);
        
        // ⚡ 성능 최적화: ETag 생성 및 캐시 헤더 설정
        const etag = generateETag(territory);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=60'); // 60초 캐시
        
        // 클라이언트가 If-None-Match 헤더로 ETag를 보냈고 일치하면 304 반환
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
            console.log(`[Territories] ✅ 304 Not Modified (ETag match) for ${territoryId}`);
            return res.status(304).end();
        }
        
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
            purchasedByAdmin,
            market_base_price  // 시장 기준가 (경매 낙찰가에 따라 갱신)
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
        
        if (market_base_price !== undefined) {
            updates.push(`market_base_price = $${paramIndex}`);
            params.push(market_base_price);
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
