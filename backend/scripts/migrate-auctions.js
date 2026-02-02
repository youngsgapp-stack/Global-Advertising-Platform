import 'dotenv/config';
import { initDatabase, query, getPool } from '../db/init.js';
import logger from '../utils/logger.js';

async function migrateAuctions() {
    console.log('🚀 Auction 마이그레이션 시작...\n');

    try {
        await initDatabase();

        // 1. 모든 auctions 조회
        console.log('📖 Auctions 데이터 조회 중...');
        const auctionsResult = await query('SELECT * FROM auctions');
        const auctions = auctionsResult.rows;
        
        console.log(`✅ 총 ${auctions.length}개의 auctions 발견\n`);

        if (auctions.length === 0) {
            console.log('⚠️  이관할 auction이 없습니다.');
            return;
        }

        // 2. territories 테이블에서 country 정보 조회 (매핑용)
        const territoriesResult = await query('SELECT id, country FROM territories');
        const territoryCountryMap = new Map();
        territoriesResult.rows.forEach(t => {
            territoryCountryMap.set(t.id, t.country);
        });

        console.log(`📋 Territories 매핑 테이블 생성 완료: ${territoryCountryMap.size}개\n`);

        // 3. 각 auction 분석 및 업데이트
        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        const issues = [];

        for (const auction of auctions) {
            try {
                const issues = [];
                const updates = [];
                const params = [];
                let paramIndex = 1;

                // territory_id 확인
                if (!auction.territory_id) {
                    issues.push('territory_id 없음');
                }

                // country 확인
                let country = auction.country;
                if (!country && auction.territory_id) {
                    // territory_id로 country 매핑 시도
                    country = territoryCountryMap.get(auction.territory_id);
                    if (country) {
                        updates.push(`country = $${paramIndex}`);
                        params.push(country);
                        paramIndex++;
                        console.log(`  ✓ Auction ${auction.id}: country 매핑 성공 (${country})`);
                    } else {
                        issues.push(`country 매핑 실패 (territory_id: ${auction.territory_id})`);
                    }
                }

                // 업데이트가 필요한 경우에만 실행
                if (updates.length > 0) {
                    params.push(auction.id);
                    await query(
                        `UPDATE auctions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex}`,
                        params
                    );
                    updatedCount++;
                    console.log(`  ✅ Auction ${auction.id} 업데이트 완료`);
                } else if (issues.length > 0) {
                    skippedCount++;
                    console.log(`  ⚠️  Auction ${auction.id} 스킵: ${issues.join(', ')}`);
                } else {
                    skippedCount++;
                    console.log(`  ✓ Auction ${auction.id}: 이미 완료됨`);
                }

                if (issues.length > 0) {
                    issues.push({
                        auctionId: auction.id,
                        territoryId: auction.territory_id,
                        issues: issues
                    });
                }

            } catch (error) {
                errorCount++;
                console.error(`  ❌ Auction ${auction.id} 처리 실패:`, error.message);
            }
        }

        console.log('\n📊 마이그레이션 결과:');
        console.log(`   ✅ 업데이트: ${updatedCount}개`);
        console.log(`   ⚠️  스킵: ${skippedCount}개`);
        console.log(`   ❌ 오류: ${errorCount}개`);
        
        if (issues.length > 0) {
            console.log(`\n⚠️  이슈가 있는 auctions:`);
            issues.forEach((issue, index) => {
                console.log(`   ${index + 1}. Auction ${issue.auctionId}: ${issue.issues.join(', ')}`);
            });
        }

        console.log('\n✅ Auction 마이그레이션 완료');

    } catch (error) {
        logger.error('❌ Auction 마이그레이션 실패:', error);
        process.exit(1);
    } finally {
        getPool().end();
    }
}

migrateAuctions();









