/**
 * Price 표시 로직 테스트 스크립트
 * 
 * 테스트 시나리오:
 * 1. last_winning_amount가 있는 경우 → last_winning_amount 표시
 * 2. last_winning_amount가 없는 경우 → 기본 가격 계산
 * 3. last_winning_amount가 0인 경우 → 기본 가격 계산
 * 4. last_winning_amount가 null인 경우 → 기본 가격 계산
 */

import dotenv from 'dotenv';
import { initDatabase, getPool } from '../db/init.js';

dotenv.config();

// 프론트엔드 로직 시뮬레이션
function calculateDisplayPrice(territory, basePrice) {
    // TerritoryPanel.js의 로직과 동일
    let realPrice;
    
    if (territory.last_winning_amount !== undefined) {
        console.log(`  [Test] territory.last_winning_amount found: ${territory.last_winning_amount} (type: ${typeof territory.last_winning_amount})`);
    } else {
        console.log(`  [Test] territory.last_winning_amount is undefined`);
    }
    
    if (territory.last_winning_amount && parseFloat(territory.last_winning_amount) > 0) {
        realPrice = parseFloat(territory.last_winning_amount);
        console.log(`  [Test] ✅ Using last_winning_amount as price: ${realPrice} pt`);
        return { price: realPrice, source: 'last_winning_amount' };
    } else {
        realPrice = basePrice;
        console.log(`  [Test] Using calculated base price: ${realPrice} pt (last_winning_amount: ${territory.last_winning_amount || 'null'})`);
        return { price: realPrice, source: 'calculated' };
    }
}

async function testPriceDisplayLogic() {
    console.log('🧪 Price 표시 로직 테스트 시작\n');
    console.log('='.repeat(60));
    
    try {
        await initDatabase();
        const pool = getPool();
        
        // 테스트 케이스 1: last_winning_amount가 있는 영토
        console.log('\n📋 테스트 케이스 1: last_winning_amount가 있는 영토');
        console.log('-'.repeat(60));
        
        const result1 = await pool.query(`
            SELECT id, name, last_winning_amount, base_price, market_base_price
            FROM territories
            WHERE last_winning_amount IS NOT NULL
            LIMIT 3
        `);
        
        if (result1.rows.length === 0) {
            console.log('  ⚠️  last_winning_amount가 있는 영토가 없습니다.');
            console.log('  → 옥션을 종료한 후 다시 테스트하세요.');
        } else {
            for (const territory of result1.rows) {
                console.log(`\n  영토: ${territory.name || territory.id}`);
                console.log(`  last_winning_amount: ${territory.last_winning_amount}`);
                console.log(`  base_price: ${territory.base_price}`);
                
                const basePrice = territory.base_price || 100;
                const result = calculateDisplayPrice(territory, basePrice);
                
                if (result.source === 'last_winning_amount' && result.price === parseFloat(territory.last_winning_amount)) {
                    console.log(`  ✅ PASS: ${result.price} pt 표시 (last_winning_amount 사용)`);
                } else {
                    console.log(`  ❌ FAIL: 예상 ${territory.last_winning_amount} pt, 실제 ${result.price} pt`);
                }
            }
        }
        
        // 테스트 케이스 2: last_winning_amount가 없는 영토
        console.log('\n📋 테스트 케이스 2: last_winning_amount가 없는 영토');
        console.log('-'.repeat(60));
        
        const result2 = await pool.query(`
            SELECT id, name, last_winning_amount, base_price, market_base_price
            FROM territories
            WHERE last_winning_amount IS NULL
            LIMIT 3
        `);
        
        if (result2.rows.length === 0) {
            console.log('  ⚠️  last_winning_amount가 없는 영토가 없습니다.');
        } else {
            for (const territory of result2.rows) {
                console.log(`\n  영토: ${territory.name || territory.id}`);
                console.log(`  last_winning_amount: ${territory.last_winning_amount || 'NULL'}`);
                console.log(`  base_price: ${territory.base_price}`);
                
                const basePrice = territory.base_price || 100;
                const result = calculateDisplayPrice(territory, basePrice);
                
                if (result.source === 'calculated') {
                    console.log(`  ✅ PASS: ${result.price} pt 표시 (기본 가격 사용)`);
                } else {
                    console.log(`  ❌ FAIL: 기본 가격을 사용해야 하는데 ${result.source} 사용`);
                }
            }
        }
        
        // 테스트 케이스 3: last_winning_amount가 0인 영토
        console.log('\n📋 테스트 케이스 3: last_winning_amount가 0인 영토');
        console.log('-'.repeat(60));
        
        const testTerritoryZero = {
            id: 'test-1',
            last_winning_amount: 0,
            base_price: 100
        };
        
        const result3 = calculateDisplayPrice(testTerritoryZero, 100);
        if (result3.source === 'calculated' && result3.price === 100) {
            console.log(`  ✅ PASS: 0인 경우 기본 가격 사용`);
        } else {
            console.log(`  ❌ FAIL: 0인 경우 기본 가격을 사용해야 함`);
        }
        
        // 테스트 케이스 4: last_winning_amount가 null인 영토
        console.log('\n📋 테스트 케이스 4: last_winning_amount가 null인 영토');
        console.log('-'.repeat(60));
        
        const testTerritoryNull = {
            id: 'test-2',
            last_winning_amount: null,
            base_price: 100
        };
        
        const result4 = calculateDisplayPrice(testTerritoryNull, 100);
        if (result4.source === 'calculated' && result4.price === 100) {
            console.log(`  ✅ PASS: null인 경우 기본 가격 사용`);
        } else {
            console.log(`  ❌ FAIL: null인 경우 기본 가격을 사용해야 함`);
        }
        
        // 테스트 케이스 5: last_winning_amount가 undefined인 영토
        console.log('\n📋 테스트 케이스 5: last_winning_amount가 undefined인 영토');
        console.log('-'.repeat(60));
        
        const testTerritoryUndefined = {
            id: 'test-3',
            base_price: 100
        };
        
        const result5 = calculateDisplayPrice(testTerritoryUndefined, 100);
        if (result5.source === 'calculated' && result5.price === 100) {
            console.log(`  ✅ PASS: undefined인 경우 기본 가격 사용`);
        } else {
            console.log(`  ❌ FAIL: undefined인 경우 기본 가격을 사용해야 함`);
        }
        
        // 테스트 케이스 6: 실제 낙찰된 영토 확인
        console.log('\n📋 테스트 케이스 6: 실제 낙찰된 영토 확인');
        console.log('-'.repeat(60));
        
        const result6 = await pool.query(`
            SELECT 
                t.id,
                t.name,
                t.last_winning_amount,
                t.base_price,
                a.winning_amount,
                a.status,
                a.ended_at
            FROM territories t
            LEFT JOIN auctions a ON a.territory_id = t.id AND a.status = 'ended'
            WHERE t.last_winning_amount IS NOT NULL
            ORDER BY a.ended_at DESC NULLS LAST
            LIMIT 5
        `);
        
        if (result6.rows.length === 0) {
            console.log('  ⚠️  낙찰된 영토가 없습니다.');
        } else {
            for (const row of result6.rows) {
                console.log(`\n  영토: ${row.name || row.id}`);
                console.log(`  last_winning_amount: ${row.last_winning_amount}`);
                console.log(`  auction.winning_amount: ${row.winning_amount || 'NULL'}`);
                
                if (row.winning_amount && parseFloat(row.last_winning_amount) === parseFloat(row.winning_amount)) {
                    console.log(`  ✅ PASS: last_winning_amount와 winning_amount 일치`);
                } else if (row.winning_amount) {
                    console.log(`  ⚠️  WARNING: last_winning_amount와 winning_amount 불일치`);
                    console.log(`     → 옥션 종료 후 업데이트가 안 되었을 수 있음`);
                } else {
                    console.log(`  ℹ️  INFO: winning_amount가 없음 (다른 경로로 낙찰되었을 수 있음)`);
                }
            }
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('✅ 테스트 완료');
        
    } catch (error) {
        console.error('\n❌ 테스트 실행 중 오류 발생:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

testPriceDisplayLogic()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('테스트 실패:', error);
        process.exit(1);
    });

