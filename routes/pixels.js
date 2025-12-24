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
 * 픽셀 데이터가 있는 영토 ID 목록 조회
 * Redis에서 픽셀 데이터 메타 정보를 조회
 */
topLevelRouter.get('/territories', async (req, res) => {
    try {
        // 캐시된 목록 먼저 확인
        const cacheKey = 'pixels:territories:list';
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // Redis에서 모든 픽셀 데이터 키 검색
        // 패턴: pixel_data:*
        const keys = await redis.keys('pixel_data:*');
        
        const territoriesWithPixels = [];
        
        // 각 키에서 픽셀 데이터가 실제로 있는지 확인 (병렬 처리)
        const pixelDataPromises = keys.map(async (key) => {
            try {
                const pixelData = await redis.get(key);
                if (pixelData) {
                    // ⚠️ 핵심 수정: redis.get()이 이미 파싱된 객체를 반환하므로 중복 파싱 제거
                    // 픽셀이 실제로 있는 경우만 포함
                    if (pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                        const territoryId = key.replace('pixel_data:', '');
                        return {
                            territoryId: territoryId,
                            pixelCount: pixelData.pixels.length,
                            hasOwner: !!pixelData.ownerId
                        };
                    }
                }
            } catch (err) {
                // 개별 키 조회 실패는 무시
                console.debug(`[Pixels] Failed to get pixel data for ${key}:`, err.message);
            }
            return null;
        });
        
        const results = await Promise.all(pixelDataPromises);
        const validTerritories = results.filter(t => t !== null);
        
        territoriesWithPixels.push(...validTerritories);
        
        // 영토 ID 목록만 반환 (필터링은 프론트엔드에서 소유권 확인)
        const territoryIds = territoriesWithPixels.map(t => t.territoryId);
        
        const response = {
            territoryIds: territoryIds,
            count: territoryIds.length,
            territories: territoriesWithPixels // 상세 정보도 포함 (선택적)
        };
        
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
 * 영토의 픽셀 데이터 저장
 */
router.post('/', async (req, res) => {
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
router.delete('/', async (req, res) => {
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
