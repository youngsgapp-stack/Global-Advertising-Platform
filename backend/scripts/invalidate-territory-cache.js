/**
 * Territory 캐시 무효화 스크립트
 * 
 * 사용법:
 *   node backend/scripts/invalidate-territory-cache.js [territoryId]
 * 
 * territoryId가 없으면 모든 territory 캐시를 무효화합니다.
 */

import dotenv from 'dotenv';
import { redis } from '../redis/init.js';

dotenv.config();

async function invalidateCache(territoryId = null) {
    try {
        if (territoryId) {
            // 특정 territory 캐시 무효화
            await redis.del(`territory:${territoryId}`);
            
            // 목록 캐시에서도 제거
            const pattern = `territories:*`;
            const keys = await redis.keys(pattern);
            for (const key of keys) {
                await redis.del(key);
            }
            
            console.log(`✅ [Cache] Invalidated cache for territory: ${territoryId}`);
        } else {
            // 모든 territory 캐시 무효화
            const patterns = ['territory:*', 'territories:*'];
            let totalDeleted = 0;
            
            for (const pattern of patterns) {
                const keys = await redis.keys(pattern);
                if (keys.length > 0) {
                    await redis.del(...keys);
                    totalDeleted += keys.length;
                    console.log(`✅ [Cache] Deleted ${keys.length} keys matching ${pattern}`);
                }
            }
            
            console.log(`✅ [Cache] Total ${totalDeleted} cache keys invalidated`);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ [Cache] Error:', error);
        process.exit(1);
    }
}

const territoryId = process.argv[2] || null;
invalidateCache(territoryId);

