/**
 * Auction Migration Script
 * 기존 Auction 문서에 territoryId와 countryIso 필드 추가
 * 
 * 사용법:
 * node scripts/migrate-auctions.js [--dry-run]
 */

// Firebase Admin SDK 초기화
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Firebase Service Account 로드
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 
    path.join(__dirname, '..', 'FIREBASE_SERVICE_ACCOUNT_ONELINE.txt');

let serviceAccount;
try {
    const serviceAccountText = fs.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(serviceAccountText);
} catch (error) {
    console.error('Failed to load Firebase service account:', error);
    process.exit(1);
}

// Firebase 초기화
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const firestore = admin.firestore();

// Territory ID 유틸리티 (간단한 버전)
function createTerritoryIdFromFeature(feature) {
    const countryIso = feature.properties?.adm0_a3?.toUpperCase();
    const adminCode = feature.properties?.adm1_code || 
                     feature.properties?.ne_id || 
                     feature.properties?.gid;
    
    if (!countryIso || !adminCode) {
        return null;
    }
    
    return `${countryIso}::${adminCode}`;
}

// ISO to Slug 매핑 (간단한 버전)
function getCountrySlugFromIso(iso) {
    // 주요 국가 매핑 (필요시 확장)
    const isoToSlugMap = {
        'USA': 'united-states',
        'KOR': 'south-korea',
        'JPN': 'japan',
        'CHN': 'china',
        'GBR': 'united-kingdom',
        'DEU': 'germany',
        'FRA': 'france',
        // ... 더 많은 매핑 필요
    };
    
    return isoToSlugMap[iso] || iso.toLowerCase();
}

async function migrateAuctions(dryRun = false) {
    console.log(`\n${dryRun ? '🔍 DRY RUN MODE' : '🚀 MIGRATION MODE'}\n`);
    
    try {
        // 모든 활성 경매 조회
        const auctionsSnapshot = await firestore.collection('auctions')
            .where('status', '==', 'active')
            .get();
        
        console.log(`Found ${auctionsSnapshot.size} active auctions\n`);
        
        const results = {
            success: [],
            failed: [],
            ambiguous: [],
            skipped: []
        };
        
        // GeoJSON 데이터 로드 (간단한 버전 - 실제로는 모든 GeoJSON 소스를 로드해야 함)
        // 여기서는 예시로 territories 컬렉션에서 territory 정보를 가져옴
        
        for (const doc of auctionsSnapshot.docs) {
            const auction = doc.data();
            const auctionId = doc.id;
            
            // 이미 territoryId와 countryIso가 있으면 스킵
            if (auction.territoryId && auction.countryIso) {
                console.log(`⏭️  Skipping ${auctionId} (already has territoryId and countryIso)`);
                results.skipped.push(auctionId);
                continue;
            }
            
            const territoryId = auction.territoryId || auction.territoryId;
            
            if (!territoryId) {
                console.log(`❌ ${auctionId}: No territoryId found`);
                results.failed.push({ auctionId, reason: 'No territoryId' });
                continue;
            }
            
            // Territory 정보 가져오기
            let territory = null;
            try {
                const territoryDoc = await firestore.collection('territories').doc(territoryId).get();
                if (territoryDoc.exists) {
                    territory = territoryDoc.data();
                }
            } catch (error) {
                console.warn(`⚠️  ${auctionId}: Could not load territory ${territoryId}:`, error.message);
            }
            
            // countryIso 추출 시도
            let countryIso = null;
            let finalTerritoryId = territoryId;
            
            if (territory) {
                // Territory ID 형식 확인 (새로운 형식: "SGP::ADM1_003")
                const newTerritoryId = territory.territoryId || territory.properties?.territoryId;
                if (newTerritoryId && newTerritoryId.includes('::')) {
                    const parts = newTerritoryId.split('::');
                    if (parts.length === 2 && parts[0].length === 3) {
                        countryIso = parts[0].toUpperCase();
                        finalTerritoryId = newTerritoryId;
                    }
                } else {
                    // Legacy 형식: country 정보 추출
                    countryIso = territory.properties?.adm0_a3 || territory.countryIso;
                    if (countryIso && countryIso.length === 3) {
                        countryIso = countryIso.toUpperCase();
                    }
                }
            }
            
            // countryIso가 여전히 없으면 맵에서 찾기 시도 (복잡하므로 생략)
            // 실제로는 모든 GeoJSON 소스를 로드해서 매칭해야 함
            
            if (!countryIso) {
                console.log(`⚠️  ${auctionId}: Could not determine countryIso for ${territoryId}`);
                results.ambiguous.push({
                    auctionId,
                    territoryId,
                    reason: 'Could not determine countryIso'
                });
                
                if (!dryRun) {
                    // 애매한 케이스는 invalid로 표시
                    await doc.ref.update({
                        status: 'invalid',
                        migrationNote: 'Could not determine countryIso'
                    });
                }
                continue;
            }
            
            // 업데이트 데이터 준비
            const updateData = {
                territoryId: finalTerritoryId,
                countryIso: countryIso
            };
            
            if (dryRun) {
                console.log(`✅ ${auctionId}: Would update with`, updateData);
                results.success.push({ auctionId, updateData });
            } else {
                // 실제 업데이트
                await doc.ref.update(updateData);
                console.log(`✅ ${auctionId}: Updated with`, updateData);
                results.success.push({ auctionId, updateData });
            }
        }
        
        // 결과 요약
        console.log('\n📊 Migration Summary:');
        console.log(`✅ Success: ${results.success.length}`);
        console.log(`❌ Failed: ${results.failed.length}`);
        console.log(`⚠️  Ambiguous: ${results.ambiguous.length}`);
        console.log(`⏭️  Skipped: ${results.skipped.length}`);
        
        // 애매한 케이스 로그 저장
        if (results.ambiguous.length > 0) {
            const logPath = path.join(__dirname, '..', 'migration-ambiguous-cases.json');
            fs.writeFileSync(logPath, JSON.stringify(results.ambiguous, null, 2));
            console.log(`\n⚠️  Ambiguous cases saved to: ${logPath}`);
        }
        
        if (dryRun) {
            console.log('\n🔍 This was a DRY RUN. No data was modified.');
            console.log('Run without --dry-run to apply changes.');
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    }
}

// 실행
const isDryRun = process.argv.includes('--dry-run');

migrateAuctions(isDryRun)
    .then(() => {
        console.log('\n✅ Migration completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    });

