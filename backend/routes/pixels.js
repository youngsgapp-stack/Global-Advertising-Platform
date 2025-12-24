/**
 * Pixels API Routes
 * 픽셀 데이터 조회/저장
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidatePixelCache } from '../redis/cache-utils.js';
import { broadcastPixelUpdate } from '../websocket/index.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';

// 상위 레벨 라우터 (독립 라우트) - /api/pixels/* 경로용
const topLevelRouter = express.Router();

/**
 * GET /api/pixels/territories
 * 픽셀 데이터가 있는 영토 ID 목록 조회 (공개 API - 게스트 허용)
 * Redis에서 픽셀 데이터 메타 정보를 조회
 */
topLevelRouter.get('/territories', async (req, res) => {
    // ⚡ 공개 API: 게스트 접근 허용 (인증 불필요)
    console.log('[Pixels] ✅ GET /api/pixels/territories - Public API access (guest allowed)');
    console.log('[Pixels] Request details:', {
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        path: req.path
    });
    try {
        // 캐시된 목록 먼저 확인
        const cacheKey = 'pixels:territories:list';
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            console.log(`[Pixels] ⚠️ Returning cached data (count: ${cached.count || 0})`);
            return res.json(cached);
        }
        
        console.log(`[Pixels] No cache found, fetching from Set...`);
        
        // ⚡ 핵심 수정: KEYS/SCAN 대신 Set을 사용하여 픽셀이 있는 territory 목록 조회
        // Upstash Redis는 KEYS 명령을 지원하지 않으므로, Set으로 목록 관리
        const territoriesSetKey = 'pixels:territories:set';
        let territoryIds = [];
        
        try {
            // Set에서 모든 territoryId 조회
            territoryIds = await redis.smembers(territoriesSetKey) || [];
            console.log(`[Pixels] territories:set size=${territoryIds.length}`);
            console.log(`[Pixels] territories:set sample=`, (territoryIds || []).slice(0, 10));
            
            // ⚡ 디버깅: Set이 비어있으면 경고
            if (territoryIds.length === 0) {
                console.warn(`[Pixels] ⚠️ Set is empty! Run rebuild script if pixel data exists.`);
            }
        } catch (error) {
            console.warn('[Pixels] Failed to get territories from Set, trying fallback method:', error.message);
            // Set이 없거나 실패한 경우 빈 배열 (첫 실행 또는 Set이 아직 생성되지 않은 경우)
            territoryIds = [];
        }
        
        // ⚡ Set이 비어있으면 1회 SCAN으로 자동 재구축 (레거시 데이터 복구)
        // ⚠️ 주의: Upstash Redis는 SCAN을 지원하지 않으므로 일반 Redis에서만 동작
        if (territoryIds.length === 0) {
            console.warn('[Pixels] Set is empty. Attempting to rebuild via SCAN (one-time fallback for legacy data)...');
            
            try {
                const prefix = 'pixel_data:'; // 실제 픽셀 저장 키 패턴
                const rebuilt = new Set();
                
                // SCAN 시도 (Upstash는 빈 결과 반환, 일반 Redis만 동작)
                let cursor = '0';
                let scanAttempts = 0;
                const maxScanAttempts = 1000; // 무한 루프 방지
                
                do {
                    const scanResult = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
                    
                    // redis.scan 반환값 처리 (배열 또는 객체 형태)
                    let nextCursor = '0';
                    let keys = [];
                    
                    if (Array.isArray(scanResult)) {
                        // node-redis: [cursor, keys] 형태
                        nextCursor = scanResult[0] || '0';
                        keys = scanResult[1] || [];
                    } else if (typeof scanResult === 'object' && scanResult !== null) {
                        // 객체 형태: { cursor, keys } 또는 { cursor: [...], keys: [...] }
                        nextCursor = scanResult.cursor || scanResult[0] || '0';
                        keys = scanResult.keys || scanResult[1] || [];
                    } else {
                        // SCAN이 지원되지 않는 경우 (Upstash 등)
                        cursor = '0';
                        break;
                    }
                    
                    cursor = nextCursor;
                    
                    for (const key of keys) {
                        const territoryId = key.replace(prefix, '').trim();
                        if (territoryId) {
                            // 실제로 픽셀 데이터가 있는지 확인
                            const pixelData = await redis.get(key);
                            if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                                rebuilt.add(territoryId);
                            }
                        }
                    }
                    
                    scanAttempts++;
                    if (scanAttempts >= maxScanAttempts) {
                        console.warn('[Pixels] SCAN reached max attempts, stopping');
                        break;
                    }
                } while (cursor !== '0');
                
                // 재구축된 territoryId들을 Set에 추가
                if (rebuilt.size > 0) {
                    const rebuiltArray = Array.from(rebuilt);
                    // 기존 Set 삭제 후 재생성 (깔끔한 재구축)
                    await redis.del(territoriesSetKey);
                    await redis.sadd(territoriesSetKey, ...rebuiltArray);
                    territoryIds = rebuiltArray;
                    console.log(`[Pixels] ✅ Rebuilt Set with ${territoryIds.length} territories from legacy Redis data`);
                } else {
                    console.warn('[Pixels] ⚠️ No legacy pixel data found via SCAN (Set will be populated on next save)');
                    console.warn('[Pixels] ⚠️ Note: Upstash Redis does not support SCAN command, so this fallback will not work');
                }
            } catch (error) {
                // SCAN 실패는 조용히 무시 (Upstash 등 SCAN 미지원 환경)
                console.debug('[Pixels] SCAN fallback failed (may not be supported):', error.message);
            }
        }
        
        const territoriesWithPixels = [];
        
        // ⚡ 디버깅: territoryIds가 있으면 로그
        if (territoryIds.length > 0) {
            console.log(`[Pixels] Processing ${territoryIds.length} territories from Set`);
        }
        
        // 각 territoryId에 대해 픽셀 데이터 조회 (병렬 처리)
        const pixelDataPromises = territoryIds.map(async (territoryId) => {
            try {
                // pixel_data:${territoryId} 키로 픽셀 데이터 조회
                const pixelCacheKey = `pixel_data:${territoryId}`;
                const pixelData = await redis.get(pixelCacheKey);
                
                // ⚡ 디버깅: pixelData 조회 결과 로그
                console.log(`[Pixels] Checking ${territoryId}:`, {
                    hasData: !!pixelData,
                    hasPixels: !!(pixelData && pixelData.pixels && Array.isArray(pixelData.pixels)),
                    pixelsLength: pixelData && pixelData.pixels ? pixelData.pixels.length : 0
                });
                
                if (pixelData) {
                    // ⚠️ 핵심 수정: redis.get()이 이미 파싱된 객체를 반환하므로 중복 파싱 제거
                    // 픽셀이 실제로 있는 경우만 포함
                    if (pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                        const pixelCount = pixelData.pixels.length;
                        const totalPixels = (pixelData.width || 64) * (pixelData.height || 64);
                        const fillRatio = totalPixels > 0 ? pixelCount / totalPixels : null;
                        
                        console.log(`[Pixels] ✅ ${territoryId}: valid pixel data (${pixelCount} pixels)`);
                        
                        return {
                            territoryId: territoryId,
                            pixelCount: pixelCount,
                            hasPixelArt: true,
                            fillRatio: fillRatio,
                            updatedAt: pixelData.updatedAt || pixelData.lastUpdated || null,
                            hasOwner: !!pixelData.ownerId
                        };
                    } else {
                        // Set에는 있지만 실제 픽셀 데이터가 없는 경우, Set에서 제거 (정리)
                        console.warn(`[Pixels] ⚠️ Territory ${territoryId} in Set but has no pixel data, removing from Set`);
                        await redis.srem(territoriesSetKey, territoryId);
                    }
                } else {
                    // Set에는 있지만 Redis에 데이터가 없는 경우, Set에서 제거 (정리)
                    console.warn(`[Pixels] ⚠️ Territory ${territoryId} in Set but no data in Redis, removing from Set`);
                    await redis.srem(territoriesSetKey, territoryId);
                }
            } catch (err) {
                // ⚠️ 중요: 네트워크/서버 오류 시에는 Set에서 제거하지 않음 (데이터 손실 방지)
                // 개별 키 조회 실패는 무시 (로깅만)
                console.error(`[Pixels] ❌ Failed to get pixel data for ${territoryId}:`, err.message);
            }
            return null;
        });
        
        const results = await Promise.all(pixelDataPromises);
        const validTerritories = results.filter(t => t !== null);
        
        territoriesWithPixels.push(...validTerritories);
        
        // 영토 ID 목록 생성 (필터링은 프론트엔드에서 소유권 확인)
        const finalTerritoryIds = territoriesWithPixels.map(t => t.territoryId);
        
        // ⚡ 성능: limit 적용 (기본값 1000, 최대 5000)
        // 향후 픽셀아트가 많아져도 안정적으로 동작하도록 제한
        const limit = parseInt(req.query.limit) || 1000;
        const maxLimit = 5000;
        const effectiveLimit = Math.min(limit, maxLimit);
        
        const limitedTerritories = territoriesWithPixels.slice(0, effectiveLimit);
        const limitedTerritoryIds = limitedTerritories.map(t => t.territoryId);
        
        const response = {
            territoryIds: limitedTerritoryIds,
            count: limitedTerritoryIds.length,
            totalCount: finalTerritoryIds.length, // 전체 개수 (limit 적용 전)
            hasMore: finalTerritoryIds.length > effectiveLimit, // 더 있는지 여부
            territories: limitedTerritories // 메타 정보만 포함 (픽셀 전체 데이터는 포함하지 않음)
        };
        
        // ⚡ 디버깅: 응답 로그
        console.log(`[Pixels] GET /api/pixels/territories response:`, {
            territoryIdsCount: response.territoryIds.length,
            count: response.count,
            totalCount: response.totalCount,
            hasMore: response.hasMore,
            sampleIds: response.territoryIds.slice(0, 5)
        });
        
        // 캐시 저장
        await redis.set(cacheKey, response, CACHE_TTL.PIXEL_META);
        
        res.json(response);
    } catch (error) {
        console.error('[Pixels] Error getting territories with pixels:', error);
        res.status(500).json({ error: 'Failed to fetch territories with pixels' });
    }
});

// 하위 레벨 라우터 (territories 라우터에 마운트됨) - /api/territories/:territoryId/pixels 경로용
const router = express.Router({ mergeParams: true }); // territories 라우터의 params 상속

/**
 * GET /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 조회
 */
router.get('/', async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
        
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
        
        // Redis에서 먼저 조회
        // pixel_data:${territoryId} 키에서 실제 픽셀 데이터 조회
        const pixelCacheKey = `pixel_data:${territoryId}`;
        const pixelData = await redis.get(pixelCacheKey);
        
        // ⚠️ 디버깅: 조회한 데이터 확인
        console.log(`[Pixels] GET /territories/${territoryId}/pixels - Retrieved from Redis:`, {
            hasData: !!pixelData,
            pixelsLength: pixelData?.pixels?.length || 0,
            filledPixels: pixelData?.filledPixels || 0,
            dataType: typeof pixelData,
            isArray: Array.isArray(pixelData?.pixels)
        });
        
        // ⚠️ 핵심 수정: redis.get()이 이미 파싱된 객체를 반환하므로 중복 파싱 제거
        if (pixelData) {
            // ⚠️ 개선: 메타데이터 보장 (캐시 일관성 검증용)
            // 기존 데이터에 메타데이터가 없으면 추가
            if (!pixelData.revision || !pixelData.updatedAt) {
                const now = Date.now();
                pixelData.revision = pixelData.revision || now; // 타임스탬프 기반 revision
                pixelData.updatedAt = pixelData.updatedAt || pixelData.lastUpdated || new Date().toISOString();
                // Redis에 업데이트된 메타데이터 저장
                await redis.set(pixelCacheKey, pixelData);
            }
            
            console.log(`[Pixels] Returning pixel data:`, {
                pixelsLength: pixelData.pixels?.length || 0,
                filledPixels: pixelData.filledPixels || 0,
                revision: pixelData.revision,
                updatedAt: pixelData.updatedAt
            });
            return res.json(pixelData);
        }
        
        // 캐시된 메타데이터 확인
        const cacheKey = `pixels:${territoryId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            // ⚠️ 개선: 메타데이터 보장
            if (!cached.revision || !cached.updatedAt) {
                const now = Date.now();
                cached.revision = cached.revision || now;
                cached.updatedAt = cached.updatedAt || cached.lastUpdated || new Date().toISOString();
                await redis.set(cacheKey, cached, CACHE_TTL.PIXEL_META);
            }
            return res.json(cached);
        }
        
        // TODO: DB에 pixel_canvases 테이블이 있으면 조회
        // 현재는 빈 데이터 반환 (나중에 DB 스키마 확장 필요)
        const now = Date.now();
        const emptyPixelData = {
            territoryId,
            pixels: [],
            width: 64,
            height: 64,
            filledPixels: 0,
            lastUpdated: null,
            // ⚠️ 개선: 빈 데이터에도 메타데이터 포함
            revision: now,
            updatedAt: new Date().toISOString()
        };
        
            // Redis에 캐시
            await redis.set(cacheKey, emptyPixelData, CACHE_TTL.PIXEL_META);
        
        res.json(emptyPixelData);
    } catch (error) {
        console.error('[Pixels] Error:', error);
        res.status(500).json({ error: 'Failed to fetch pixel data' });
    }
});

/**
 * POST /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 저장 (인증 필요)
 */
// ⚡ 인증 미들웨어를 여기서만 적용 (GET은 공개, POST/DELETE는 인증 필요)
router.post('/', async (req, res, next) => {
    // ⚡ 인증 체크: req.user가 없으면 401 반환
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}, async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
        const { pixels, width, height } = req.body;
        const firebaseUid = req.user.uid;
        
        // ⚠️ 디버깅: 받은 데이터 확인
        console.log(`[Pixels] POST /territories/${territoryIdParam}/pixels - Received data:`, {
            pixelsType: typeof pixels,
            pixelsIsArray: Array.isArray(pixels),
            pixelsLength: pixels ? pixels.length : 0,
            pixelsSample: pixels ? pixels.slice(0, 3) : null,
            width,
            height,
            bodyKeys: Object.keys(req.body)
        });
        
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
        
        // 영토 소유권 확인
        const territoryResult = await query(
            `SELECT ruler_id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = territoryResult.rows[0];
        if (territory.ruler_id !== userId) {
            return res.status(403).json({ error: 'You do not own this territory' });
        }
        
        // Redis 캐시 키 정의
        const pixelCacheKey = `pixel_data:${territoryId}`;
        
        // ⚠️ 전문가 조언: revision은 항상 단조 증가, 타입 고정 (정수 increment)
        // ⚠️ 최종 피드백: 동시 저장 시 revision 중복 방지를 위해 Redis INCR 사용 (원자적 증가)
        const revisionKey = `pixel_revision:${territoryId}`;
        let newRevision;
        
        try {
            // Redis INCR을 사용하여 원자적 증가 보장 (동시 저장 시에도 안전)
            newRevision = await redis.incr(revisionKey);
            
            // 첫 저장인 경우 (INCR 결과가 1) revisionKey가 없었으므로 1로 시작
            // 이후 저장은 자동으로 2, 3, 4... 로 증가
            if (newRevision === 1) {
                // 첫 저장이므로 revisionKey를 영구 저장 (TTL 없음)
                // 이후 revision은 항상 증가
                log.debug(`[Pixels] First revision for ${territoryId}, starting at 1`);
            } else {
                log.debug(`[Pixels] Revision incremented to ${newRevision} for ${territoryId}`);
            }
        } catch (error) {
            // Redis INCR 실패 시 fallback: 기존 데이터에서 revision 가져오기
            log.warn(`[Pixels] Redis INCR failed for ${territoryId}, falling back to read-then-increment:`, error.message);
            const existingPixelData = await redis.get(pixelCacheKey);
            const existingRevision = existingPixelData?.revision;
            
            if (typeof existingRevision === 'number' && Number.isInteger(existingRevision) && existingRevision > 0) {
                newRevision = existingRevision + 1;
            } else {
                newRevision = 1;
            }
        }
        
        const pixelData = {
            territoryId,
            pixels: pixels || [],
            width: width || 64,
            height: height || 64,
            filledPixels: pixels ? pixels.length : 0,
            lastUpdated: new Date().toISOString(),
            ownerId: userId,
            // ⚠️ 개선: 캐시 일관성 검증을 위한 메타데이터 추가
            revision: newRevision,
            updatedAt: new Date().toISOString()
        };
        
        // ⚠️ 디버깅: 저장할 데이터 확인
        console.log(`[Pixels] Saving pixel data for ${territoryId}:`, {
            pixelsLength: pixelData.pixels.length,
            filledPixels: pixelData.filledPixels,
            width: pixelData.width,
            height: pixelData.height,
            pixelsSample: pixelData.pixels.slice(0, 3),
            revision: pixelData.revision,
            updatedAt: pixelData.updatedAt
        });
        
        // Redis에 저장 (메인 저장소 - 무제한 캐시)
        await redis.set(pixelCacheKey, pixelData);
        
        // ⚡ 핵심 수정: 픽셀 데이터가 있는 territory 목록에 추가 (KEYS/SCAN 대신 Set 사용)
        // Upstash Redis는 KEYS 명령을 지원하지 않으므로, Set을 사용하여 목록 관리
        const territoriesSetKey = 'pixels:territories:set';
        try {
            // Set에 territoryId 추가 (중복 자동 제거)
            await redis.sadd(territoriesSetKey, territoryId);
            console.log(`[Pixels] Added ${territoryId} to territories set`);
        } catch (error) {
            // Set 추가 실패는 무시 (로깅만)
            console.warn(`[Pixels] Failed to add ${territoryId} to territories set:`, error.message);
        }
        
        // ⚠️ 디버깅: 저장 후 즉시 확인
        const verifyData = await redis.get(pixelCacheKey);
        console.log(`[Pixels] Verified saved data for ${territoryId}:`, {
            hasData: !!verifyData,
            pixelsLength: verifyData?.pixels?.length || 0,
            filledPixels: verifyData?.filledPixels || 0
        });
        
            // 메타데이터 캐시도 업데이트
            const metaCacheKey = `pixels:${territoryId}`;
            await redis.set(metaCacheKey, pixelData, CACHE_TTL.PIXEL_META);
            
            // 목록 캐시 무효화
            await redis.del('pixels:territories:list');
            
            // WebSocket으로 픽셀 업데이트 브로드캐스트
        broadcastPixelUpdate(territoryId, {
            territoryId,
            pixelCount: pixelData.filledPixels,
            ownerId: userId,
            updatedAt: pixelData.lastUpdated
        });
        
        res.json(pixelData);
    } catch (error) {
        console.error('[Pixels] Error:', error);
        res.status(500).json({ error: 'Failed to save pixel data' });
    }
});

/**
 * DELETE /api/territories/:territoryId/pixels
 * 영토의 픽셀 데이터 삭제 (소유권 이전 시)
 */
// ⚡ 인증 미들웨어를 여기서만 적용 (GET은 공개, DELETE는 인증 필요)
router.delete('/', async (req, res, next) => {
    // ⚡ 인증 체크: req.user가 없으면 401 반환
    if (!req.user || !req.user.uid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}, async (req, res) => {
    try {
        const { territoryId: territoryIdParam } = req.params;
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
        
        // 영토 소유권 확인 (소유권 이전 시 이전 소유자 또는 새 소유자가 삭제 가능)
        const territoryResult = await query(
            `SELECT ruler_id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        // Redis에서 픽셀 데이터 삭제
        const pixelCacheKey = `pixel_data:${territoryId}`;
        const metaCacheKey = `pixels:${territoryId}`;
        
        await redis.del(pixelCacheKey);
        await redis.del(metaCacheKey);
        
        // ⚡ 핵심 수정: Set에서도 territoryId 제거
        const territoriesSetKey = 'pixels:territories:set';
        try {
            await redis.srem(territoriesSetKey, territoryId);
            console.log(`[Pixels] Removed ${territoryId} from territories set`);
        } catch (error) {
            console.warn(`[Pixels] Failed to remove ${territoryId} from territories set:`, error.message);
        }
        
        // 목록 캐시 무효화
        await redis.del('pixels:territories:list');
        
        // WebSocket으로 픽셀 삭제 브로드캐스트
        broadcastPixelUpdate(territoryId, {
            territoryId,
            pixelCount: 0,
            ownerId: null,
            updatedAt: new Date().toISOString(),
            deleted: true
        });
        
        res.json({ 
            success: true, 
            message: 'Pixel data deleted',
            territoryId 
        });
    } catch (error) {
        console.error('[Pixels] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete pixel data' });
    }
});

export { router as pixelsRouter, topLevelRouter as pixelsTopLevelRouter };
