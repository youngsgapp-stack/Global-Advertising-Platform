/**
 * 픽셀 territory Set 재구축 스크립트
 * 
 * 기존 픽셀 데이터가 Redis에 있지만 Set에는 없는 경우,
 * 이 스크립트를 실행하여 Set을 재구축할 수 있습니다.
 * 
 * 사용법:
 *   node backend/scripts/rebuild-pixel-territories-set.js
 */

import dotenv from 'dotenv';
import { initRedis } from '../redis/init.js';

dotenv.config();

async function rebuildSet() {
    console.log('🔍 Rebuilding pixels:territories:set...\n');
    
    try {
        const redis = await initRedis();
        
        if (redis._type === 'disabled') {
            console.error('❌ Redis is not configured or disabled');
            process.exit(1);
        }
        
        const setKey = 'pixels:territories:set';
        const prefix = 'pixel_data:';
        
        // 현재 Set 상태 확인
        const currentSet = await redis.smembers(setKey) || [];
        console.log(`📊 Current Set size: ${currentSet.length}`);
        if (currentSet.length > 0) {
            console.log(`📋 Sample IDs:`, currentSet.slice(0, 10));
        }
        
        // Redis에서 모든 pixel_data:* 키 찾기 시도
        console.log('\n🔍 Attempting to scan Redis for pixel_data keys...');
        
        const rebuilt = new Set();
        let cursor = '0';
        let scanAttempts = 0;
        const maxScanAttempts = 1000;
        
        try {
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
                    console.warn('⚠️  SCAN command not supported (Upstash Redis)');
                    break;
                }
                
                cursor = nextCursor;
                
                console.log(`   Found ${keys.length} keys in this scan iteration`);
                
                for (const key of keys) {
                    const territoryId = key.replace(prefix, '').trim();
                    if (territoryId) {
                        // 실제로 픽셀 데이터가 있는지 확인
                        const pixelData = await redis.get(key);
                        if (pixelData) {
                            const hasPixels = pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0;
                            if (hasPixels) {
                                rebuilt.add(territoryId);
                                console.log(`   ✅ ${territoryId}: ${pixelData.pixels.length} pixels`);
                            } else {
                                console.log(`   ⚠️  ${territoryId}: no pixels (empty array or missing)`);
                            }
                        } else {
                            console.log(`   ⚠️  ${territoryId}: no data in Redis`);
                        }
                    }
                }
                
                scanAttempts++;
                if (scanAttempts >= maxScanAttempts) {
                    console.warn('⚠️  Reached max scan attempts');
                    break;
                }
            } while (cursor !== '0');
        } catch (error) {
            console.warn('⚠️  SCAN failed (may not be supported):', error.message);
            console.warn('   This is normal if using Upstash Redis');
        }
        
        if (rebuilt.size > 0) {
            console.log(`\n✅ Found ${rebuilt.size} territories with pixel data`);
            
            // Set 재구축
            await redis.del(setKey);
            const rebuiltArray = Array.from(rebuilt);
            await redis.sadd(setKey, ...rebuiltArray);
            
            console.log(`✅ Rebuilt Set with ${rebuiltArray.length} territories`);
            console.log(`📋 Sample IDs:`, rebuiltArray.slice(0, 10));
        } else {
            console.log('\n⚠️  No pixel data found via SCAN');
            console.log('   This may be because:');
            console.log('   1. Upstash Redis does not support SCAN command');
            console.log('   2. No pixel data exists in Redis');
            console.log('   3. Pixel data keys use a different pattern');
            console.log('\n💡 Solution: Save a pixel to automatically add it to the Set');
        }
        
        // 최종 Set 상태 확인
        const finalSet = await redis.smembers(setKey) || [];
        console.log(`\n📊 Final Set size: ${finalSet.length}`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

rebuildSet();

