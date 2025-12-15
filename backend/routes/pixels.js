/**
 * Pixels API Routes
 * 픽셀 데이터 조회/저장
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidatePixelCache } from '../redis/cache-utils.js';
import { broadcastPixelUpdate } from '../websocket/index.js';

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
                    const data = typeof pixelData === 'string' ? JSON.parse(pixelData) : pixelData;
                    // 픽셀이 실제로 있는 경우만 포함
                    if (data.pixels && Array.isArray(data.pixels) && data.pixels.length > 0) {
                        const territoryId = key.replace('pixel_data:', '');
                        return {
                            territoryId: territoryId,
                            pixelCount: data.pixels.length,
                            hasOwner: !!data.ownerId
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
        const { territoryId } = req.params;
        
        // Redis에서 먼저 조회
        // pixel_data:${territoryId} 키에서 실제 픽셀 데이터 조회
        const pixelCacheKey = `pixel_data:${territoryId}`;
        const pixelData = await redis.get(pixelCacheKey);
        
        if (pixelData) {
            const data = typeof pixelData === 'string' ? JSON.parse(pixelData) : pixelData;
            return res.json(data);
        }
        
        // 캐시된 메타데이터 확인
        const cacheKey = `pixels:${territoryId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // TODO: DB에 pixel_canvases 테이블이 있으면 조회
        // 현재는 빈 데이터 반환 (나중에 DB 스키마 확장 필요)
        const emptyPixelData = {
            territoryId,
            pixels: [],
            width: 64,
            height: 64,
            filledPixels: 0,
            lastUpdated: null
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
        const { territoryId } = req.params;
        const { pixels, width, height } = req.body;
        const firebaseUid = req.user.uid;
        
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
        
        const pixelData = {
            territoryId,
            pixels: pixels || [],
            width: width || 64,
            height: height || 64,
            filledPixels: pixels ? pixels.length : 0,
            lastUpdated: new Date().toISOString(),
            ownerId: userId
        };
        
        // Redis에 저장 (메인 저장소 - 무제한 캐시)
        const pixelCacheKey = `pixel_data:${territoryId}`;
        await redis.set(pixelCacheKey, pixelData);
        
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
        const { territoryId } = req.params;
        const firebaseUid = req.user.uid;
        
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
