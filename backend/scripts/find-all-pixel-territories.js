/**
 * Redis에 저장된 모든 픽셀 territory 찾기
 * 
 * Upstash Redis의 SCAN 제한을 우회하여 가능한 모든 방법으로 픽셀 데이터를 찾습니다.
 */

import dotenv from 'dotenv';
import { initRedis } from '../redis/init.js';
import { initDatabase, query } from '../db/init.js';

dotenv.config();

async function findAllPixelTerritories() {
    console.log('🔍 Finding all territories with pixel data...\n');
    
    try {
        const redis = await initRedis();
        
        if (redis._type === 'disabled') {
            console.error('❌ Redis is not configured or disabled');
            process.exit(1);
        }
        
        const prefix = 'pixel_data:';
        const foundTerritories = [];
        
        // 방법 1: DB에서 소유된 territory 목록을 가져와서 확인
        console.log('📊 Method 1: Checking territories from database...\n');
        try {
            await initDatabase();
            const dbResult = await query(`
                SELECT DISTINCT id 
                FROM territories 
                WHERE ruler_id IS NOT NULL 
                ORDER BY id 
                LIMIT 1000
            `);
            
            console.log(`   Found ${dbResult.rows.length} owned territories in database`);
            
            let checked = 0;
            let found = 0;
            
            for (const row of dbResult.rows) {
                const territoryId = row.id;
                if (!territoryId) continue;
                
                checked++;
                const key = `pixel_data:${territoryId}`;
                const pixelData = await redis.get(key);
                
                if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                    foundTerritories.push({
                        territoryId,
                        pixelCount: pixelData.pixels.length,
                        updatedAt: pixelData.updatedAt || pixelData.lastUpdated
                    });
                    found++;
                    console.log(`   ✅ ${territoryId}: ${pixelData.pixels.length} pixels`);
                }
                
                // 진행 상황 표시 (100개마다)
                if (checked % 100 === 0) {
                    console.log(`   ... checked ${checked}/${dbResult.rows.length}, found ${found} with pixels`);
                }
            }
            
            console.log(`\n📊 Database check complete: ${found} territories with pixel data found`);
        } catch (error) {
            console.error('❌ Database check failed:', error.message);
        }
        
        // 방법 2: Set에서 확인
        console.log('\n📊 Method 2: Checking Set...\n');
        const setKey = 'pixels:territories:set';
        const setMembers = await redis.smembers(setKey) || [];
        console.log(`   Set size: ${setMembers.length}`);
        console.log(`   Set members:`, setMembers);
        
        // 방법 3: 알려진 territory ID 샘플 확인
        console.log('\n📊 Method 3: Checking known territory samples...\n');
        const knownTerritories = [
            'tamanghasset', 'algeria', 'egypt', 'libya', 'morocco', 'tunisia',
            'spain', 'france', 'italy', 'germany', 'uk', 'russia', 'china',
            'japan', 'korea', 'india', 'brazil', 'usa', 'canada', 'mexico'
        ];
        
        for (const territoryId of knownTerritories) {
            const key = `pixel_data:${territoryId}`;
            const pixelData = await redis.get(key);
            if (pixelData && pixelData.pixels && Array.isArray(pixelData.pixels) && pixelData.pixels.length > 0) {
                const exists = foundTerritories.find(t => t.territoryId === territoryId);
                if (!exists) {
                    foundTerritories.push({
                        territoryId,
                        pixelCount: pixelData.pixels.length,
                        updatedAt: pixelData.updatedAt || pixelData.lastUpdated
                    });
                    console.log(`   ✅ ${territoryId}: ${pixelData.pixels.length} pixels`);
                }
            }
        }
        
        // 최종 결과
        console.log(`\n📊 Final Summary:`);
        console.log(`   Total territories with pixel data: ${foundTerritories.length}`);
        if (foundTerritories.length > 0) {
            console.log(`\n📋 Territories with pixels:`);
            foundTerritories.forEach(t => {
                console.log(`   - ${t.territoryId}: ${t.pixelCount} pixels`);
            });
            
            // Set에 추가
            const setKey = 'pixels:territories:set';
            const territoryIds = foundTerritories.map(t => t.territoryId);
            
            // 기존 Set과 병합
            const existingSet = await redis.smembers(setKey) || [];
            const allIds = new Set([...existingSet, ...territoryIds]);
            const allIdsArray = Array.from(allIds);
            
            await redis.del(setKey);
            if (allIdsArray.length > 0) {
                await redis.sadd(setKey, ...allIdsArray);
                console.log(`\n✅ Updated Set with ${allIdsArray.length} territories`);
            }
        } else {
            console.log(`\n⚠️  No pixel data found`);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

findAllPixelTerritories();

