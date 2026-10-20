/**
 * 영토 픽셀 아트 완전 삭제 (레거시 pixel_data + 타일 데이터 + 목록 캐시)
 * 타일을 남기면 GET /pixels가 타일로 그림을 다시 조합해 지운 그림이 되살아남
 */

import { redis } from '../redis/init.js';

export async function deleteTerritoryPixels(territoryId) {
    await redis.del(`pixel_data:${territoryId}`);
    await redis.del(`pixels:${territoryId}`);
    
    const tileRevKey = `territory_tile_rev:${territoryId}`;
    const tileRevisionMap = (await redis.hgetall(tileRevKey)) || {};
    for (const tileId of Object.keys(tileRevisionMap)) {
        await redis.del(`tile_data:${tileId}`);
        await redis.del(`tile_revision:${tileId}`);
    }
    await redis.del(tileRevKey);
    
    try {
        await redis.srem('pixels:territories:set', territoryId);
    } catch (error) {
        console.warn(`[PixelCleanup] Failed to remove ${territoryId} from territories set:`, error.message);
    }
    await redis.del('pixels:territories:list');
}
