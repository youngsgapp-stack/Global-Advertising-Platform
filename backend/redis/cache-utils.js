/**
 * Redis 캐시 유틸리티
 * 패턴 기반 삭제 최적화 및 캐시 무효화 전략
 */

import { redis } from './init.js';

// TTL 상수 정의
export const CACHE_TTL = {
    // 짧은 TTL (자주 변경되는 데이터)
    AUCTION: 30,              // 경매: 30초
    USER_WALLET: 10,          // 사용자 지갑: 10초
    
    // 중간 TTL
    TERRITORY_LIST: 300,      // 영토 목록: 5분
    PIXEL_META: 300,          // 픽셀 메타데이터: 5분
    RANKING: 300,             // 랭킹: 5분
    MAP_SNAPSHOT: 300,        // 맵 스냅샷: 5분
    
    // 긴 TTL (자주 변경되지 않는 데이터)
    TERRITORY_DETAIL: 3600,   // 영토 상세: 1시간
};

/**
 * 패턴 기반 캐시 무효화 (최적화된 방식)
 * SCAN을 사용하여 메모리 효율적으로 처리
 */
export async function invalidateCachePattern(pattern) {
    try {
        const client = redis;
        
        // Upstash REST API는 SCAN을 직접 지원하지 않으므로
        // keys를 사용하되 제한적으로 처리
        if (client._type === 'upstash') {
            // Upstash는 keys를 지원하지 않으므로 개별 키 삭제 필요
            // 패턴 매칭은 클라이언트 측에서 처리
            console.warn(`[Cache] Pattern deletion not fully supported for Upstash: ${pattern}`);
            return;
        }
        
        // 일반 Redis: SCAN 사용
        const keys = [];
        let cursor = '0';
        
        do {
            const result = await client.scan(cursor, {
                MATCH: pattern,
                COUNT: 100 // 한 번에 최대 100개 키 스캔
            });
            
            cursor = result.cursor;
            keys.push(...result.keys);
        } while (cursor !== '0');
        
        // 배치 삭제 (한 번에 최대 100개씩)
        if (keys.length > 0) {
            for (let i = 0; i < keys.length; i += 100) {
                const batch = keys.slice(i, i + 100);
                await client.del(batch);
            }
            console.log(`[Cache] Invalidated ${keys.length} keys matching pattern: ${pattern}`);
        }
    } catch (error) {
        console.error(`[Cache] Error invalidating pattern ${pattern}:`, error);
    }
}

/**
 * 영토 관련 캐시 무효화
 */
export async function invalidateTerritoryCache(territoryId) {
    try {
        // 개별 키 삭제
        await redis.del(`territory:${territoryId}`);
        
        // 목록 캐시 무효화 (패턴 사용)
        await invalidateCachePattern('territories:*');
    } catch (error) {
        console.error(`[Cache] Error invalidating territory cache for ${territoryId}:`, error);
    }
}

/**
 * 경매 관련 캐시 무효화
 */
export async function invalidateAuctionCache(auctionId, territoryId) {
    try {
        await redis.del(`auction:${auctionId}`);
        
        if (territoryId) {
            await invalidateTerritoryCache(territoryId);
        }
        
        // 경매 목록 캐시 무효화
        await invalidateCachePattern('auctions:*');
    } catch (error) {
        console.error(`[Cache] Error invalidating auction cache for ${auctionId}:`, error);
    }
}

/**
 * 사용자 관련 캐시 무효화
 */
export async function invalidateUserCache(userId) {
    try {
        await redis.del(`user:${userId}`);
        await redis.del(`wallet:${userId}`);
        
        // 랭킹 캐시도 무효화
        await invalidateCachePattern('ranking:*');
    } catch (error) {
        console.error(`[Cache] Error invalidating user cache for ${userId}:`, error);
    }
}

/**
 * 픽셀 데이터 캐시 무효화
 */
export async function invalidatePixelCache(territoryId) {
    try {
        await redis.del(`pixel_data:${territoryId}`);
        await redis.del(`pixels:${territoryId}`);
        
        // 픽셀 목록 캐시 무효화
        await redis.del('pixels:territories:list');
    } catch (error) {
        console.error(`[Cache] Error invalidating pixel cache for ${territoryId}:`, error);
    }
}







