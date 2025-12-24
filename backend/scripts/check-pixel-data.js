/**
 * Redis에 저장된 픽셀 데이터 확인 스크립트
 */

import { initRedis } from '../redis/init.js';
import dotenv from 'dotenv';

// 환경 변수 로드
dotenv.config();

async function checkPixelData() {
    // Redis 초기화
    const redis = await initRedis();
    
    if (redis._type === 'disabled') {
        console.error('❌ Redis is not configured or disabled');
        console.log('   Please check REDIS_URL and REDIS_TOKEN environment variables');
        process.exit(1);
    }
    try {
        console.log('🔍 Checking pixel data in Redis...\n');
        
        // ⚠️ Upstash Redis는 KEYS 명령을 지원하지 않으므로 직접 키 조회 불가
        // 대신 샘플 territory ID로 확인
        console.log('⚠️  Upstash Redis does not support KEYS command.');
        console.log('   Checking sample territory IDs instead...\n');
        
        // 샘플 territory ID들 (일반적으로 사용되는 ID)
        const sampleTerritoryIds = [
            'KR-11', // 서울
            'US-NY', // 뉴욕
            'JP-13', // 도쿄
            'GB-LND', // 런던
            'FR-75', // 파리
        ];
        
        let foundCount = 0;
        for (const territoryId of sampleTerritoryIds) {
            try {
                const key = `pixel_data:${territoryId}`;
                const pixelData = await redis.get(key);
                
                if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                    foundCount++;
                    console.log(`✅ Found pixel data for ${territoryId}:`);
                    console.log(`   - Pixel count: ${pixelData.pixels.length}`);
                    console.log(`   - Width: ${pixelData.width || 'N/A'}`);
                    console.log(`   - Height: ${pixelData.height || 'N/A'}`);
                    console.log(`   - Updated: ${pixelData.updatedAt || pixelData.lastUpdated || 'N/A'}\n`);
                } else {
                    console.log(`❌ No pixel data for ${territoryId}`);
                }
            } catch (error) {
                console.log(`⚠️  Error checking ${territoryId}: ${error.message}`);
            }
        }
        
        console.log(`\n📊 Summary:`);
        console.log(`   - Sample territories checked: ${sampleTerritoryIds.length}`);
        console.log(`   - Territories with pixel data: ${foundCount}`);
        
        if (foundCount === 0) {
            console.log('\n⚠️  No pixel data found in Redis.');
            console.log('   This is normal if no pixel art has been created yet.');
            console.log('   To create pixel art, use the pixel canvas in the frontend.');
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

checkPixelData();

