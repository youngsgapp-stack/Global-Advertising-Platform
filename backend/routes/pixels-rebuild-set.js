/**
 * Set 재구축 헬퍼 함수들
 * 
 * ⚠️ 주의: 현재 시스템에서는 픽셀 데이터가 Redis에만 저장되어 있습니다.
 * Firestore 백필은 픽셀 데이터가 Firestore에도 저장되는 경우에만 필요합니다.
 * 
 * 현재는 Redis SCAN을 사용한 재구축만 지원합니다 (Upstash Redis는 SCAN 미지원).
 */

import { redis } from '../redis/init.js';

/**
 * Redis SCAN을 사용한 Set 재구축
 * ⚠️ Upstash Redis는 SCAN을 지원하지 않으므로 일반 Redis에서만 동작
 */
export async function rebuildPixelTerritorySetFromRedis(redis) {
    const setKey = 'pixels:territories:set';
    const prefix = 'pixel_data:';
    const rebuilt = new Set();
    
    try {
        let cursor = '0';
        let scanAttempts = 0;
        const maxScanAttempts = 1000; // 무한 루프 방지
        
        do {
            const scanResult = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
            
            let nextCursor = '0';
            let keys = [];
            
            if (Array.isArray(scanResult)) {
                nextCursor = scanResult[0] || '0';
                keys = scanResult[1] || [];
            } else if (typeof scanResult === 'object' && scanResult !== null) {
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
            await redis.del(setKey);
            await redis.sadd(setKey, ...rebuiltArray);
            console.log(`[Pixels] ✅ Rebuilt Set with ${rebuiltArray.length} territories from Redis`);
            return rebuiltArray;
        } else {
            console.warn('[Pixels] ⚠️ No pixel data found via SCAN');
            return [];
        }
    } catch (error) {
        console.error('[Pixels] ❌ Failed to rebuild Set from Redis:', error);
        return [];
    }
}

/**
 * Firestore에서 Set 재구축 (pixels/{territoryId} 문서 구조일 때)
 * ⚠️ 현재 시스템에서는 픽셀 데이터가 Firestore에 저장되지 않으므로 사용하지 않음
 * 
 * 사용 방법:
 * const { admin } = await import('firebase-admin');
 * const db = admin.firestore();
 * await rebuildPixelTerritorySetFromFirestorePixelsCollection({ firestore: db, redis });
 */
export async function rebuildPixelTerritorySetFromFirestorePixelsCollection({ firestore, redis }) {
    const setKey = 'pixels:territories:set';
    
    try {
        const snap = await firestore.collection('pixels').get();
        const ids = snap.docs.map(d => d.id).filter(Boolean);
        
        if (ids.length > 0) {
            await redis.del(setKey);
            await redis.sadd(setKey, ...ids);
        }
        
        console.log('[Pixels] ✅ Rebuilt territories:set from pixels collection. size=', ids.length);
        return ids.length;
    } catch (error) {
        console.error('[Pixels] ❌ Failed to rebuild Set from Firestore pixels collection:', error);
        return 0;
    }
}

/**
 * Firestore에서 Set 재구축 (territories/{territoryId}/pixels/... 서브컬렉션 구조일 때)
 * ⚠️ 현재 시스템에서는 픽셀 데이터가 Firestore에 저장되지 않으므로 사용하지 않음
 * 
 * 사용 방법:
 * const { admin } = await import('firebase-admin');
 * const db = admin.firestore();
 * await rebuildPixelTerritorySetFromFirestorePixelsGroup({ firestore: db, redis });
 */
export async function rebuildPixelTerritorySetFromFirestorePixelsGroup({ firestore, redis }) {
    const setKey = 'pixels:territories:set';
    
    try {
        const snap = await firestore.collectionGroup('pixels').limit(50000).get();
        const idsSet = new Set();
        
        snap.forEach(doc => {
            const parent = doc.ref.parent?.parent; // subcollection의 상위 doc
            if (parent?.id) idsSet.add(parent.id);
        });
        
        const ids = Array.from(idsSet);
        
        if (ids.length > 0) {
            await redis.del(setKey);
            await redis.sadd(setKey, ...ids);
        }
        
        console.log('[Pixels] ✅ Rebuilt territories:set from pixels collectionGroup. size=', ids.length);
        return ids.length;
    } catch (error) {
        console.error('[Pixels] ❌ Failed to rebuild Set from Firestore pixels collectionGroup:', error);
        return 0;
    }
}

