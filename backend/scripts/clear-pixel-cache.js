/**
 * 픽셀 메타데이터 캐시 삭제 스크립트
 * 
 * /api/pixels/territories 엔드포인트의 캐시를 삭제하여
 * 최신 데이터를 다시 가져오도록 합니다.
 */

import dotenv from 'dotenv';
import { initRedis } from '../redis/init.js';

dotenv.config();

async function clearPixelCache() {
    console.log('🗑️  Clearing pixel territories cache...\n');
    
    try {
        const redis = await initRedis();
        
        if (redis._type === 'disabled') {
            console.error('❌ Redis is not configured or disabled');
            process.exit(1);
        }
        
        const cacheKey = 'pixels:territories:list';
        
        // 캐시 확인
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log('📦 Found cached data, deleting...');
            await redis.del(cacheKey);
            console.log('✅ Cache cleared');
        } else {
            console.log('ℹ️  No cache found (already cleared)');
        }
        
        // Set 상태 확인
        const setKey = 'pixels:territories:set';
        const setMembers = await redis.smembers(setKey) || [];
        console.log(`\n📊 Set status: ${setMembers.length} territories`);
        if (setMembers.length > 0) {
            console.log(`📋 Set members:`, setMembers);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

clearPixelCache();

