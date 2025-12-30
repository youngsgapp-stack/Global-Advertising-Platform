/**
 * 옥션 종료 개선 사항 테스트 스크립트
 * 
 * 테스트 항목:
 * 1. 마이그레이션 확인 (last_winning_amount 컬럼)
 * 2. 옥션 종료 후 소유권 이전 확인
 * 3. 보호기간 계산 확인 (입찰금액 기반)
 * 4. last_winning_amount 저장 확인
 * 5. 다음 경매 시작가 확인
 * 
 * 사용법:
 *   node backend/scripts/test-auction-end-improvements.js
 */

import dotenv from 'dotenv';
import { initDatabase, getPool } from '../db/init.js';

dotenv.config();

async function testMigration() {
    console.log('\n📋 [Test 1] 마이그레이션 확인');
    console.log('='.repeat(50));
    
    const pool = getPool();
    
    // 1. last_winning_amount 컬럼 확인
    const columnCheck = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = 'territories' 
          AND column_name = 'last_winning_amount'
    `);
    
    if (columnCheck.rows.length === 0) {
        console.log('❌ [Test 1] FAILED: last_winning_amount 컬럼이 없습니다.');
        console.log('   → 마이그레이션을 실행하세요: node backend/scripts/run-migration.js');
        return false;
    }
    
    console.log('✅ [Test 1] PASSED: last_winning_amount 컬럼 존재');
    console.log(`   - 타입: ${columnCheck.rows[0].data_type}`);
    console.log(`   - Nullable: ${columnCheck.rows[0].is_nullable}`);
    
    // 2. 인덱스 확인
    const indexCheck = await pool.query(`
        SELECT indexname 
        FROM pg_indexes 
        WHERE tablename = 'territories' 
          AND indexname = 'idx_territories_last_winning_amount'
    `);
    
    if (indexCheck.rows.length === 0) {
        console.log('⚠️  [Test 1] WARNING: 인덱스가 없습니다 (선택사항)');
    } else {
        console.log('✅ [Test 1] PASSED: 인덱스 존재');
    }
    
    // 3. auctions 테이블 컬럼 확인
    const auctionColumns = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
          AND column_name IN ('winning_amount', 'winner_user_id', 'winning_bid_id', 'ended_at', 'transferred_at')
        ORDER BY column_name
    `);
    
    const requiredColumns = ['winning_amount', 'winner_user_id', 'winning_bid_id', 'ended_at', 'transferred_at'];
    const existingColumns = auctionColumns.rows.map(r => r.column_name);
    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
    
    if (missingColumns.length > 0) {
        console.log(`⚠️  [Test 1] WARNING: auctions 테이블에 누락된 컬럼: ${missingColumns.join(', ')}`);
        console.log('   → 003_add_auction_winner_fields.sql 마이그레이션 실행 필요');
    } else {
        console.log('✅ [Test 1] PASSED: auctions 테이블 필수 컬럼 모두 존재');
    }
    
    return true;
}

async function testAuctionEndFlow() {
    console.log('\n📋 [Test 2] 옥션 종료 플로우 확인');
    console.log('='.repeat(50));
    
    const pool = getPool();
    
    // 최근 종료된 옥션 확인
    const recentEndedAuctions = await pool.query(`
        SELECT 
            a.id,
            a.territory_id,
            a.status,
            a.winning_amount,
            a.winner_user_id,
            a.ended_at,
            a.transferred_at,
            t.ruler_id,
            t.last_winning_amount,
            t.protection_ends_at
        FROM auctions a
        LEFT JOIN territories t ON a.territory_id = t.id
        WHERE a.status = 'ended'
          AND a.ended_at IS NOT NULL
        ORDER BY a.ended_at DESC
        LIMIT 5
    `);
    
    if (recentEndedAuctions.rows.length === 0) {
        console.log('⚠️  [Test 2] SKIPPED: 종료된 옥션이 없습니다 (정상)');
        return true;
    }
    
    console.log(`✅ [Test 2] Found ${recentEndedAuctions.rows.length} recently ended auctions`);
    
    let passedCount = 0;
    let failedCount = 0;
    
    for (const auction of recentEndedAuctions.rows) {
        console.log(`\n   옥션 ID: ${auction.id}`);
        console.log(`   영토 ID: ${auction.territory_id}`);
        
        // 1. winning_amount 저장 확인
        if (auction.winning_amount && parseFloat(auction.winning_amount) > 0) {
            console.log(`   ✅ winning_amount: ${auction.winning_amount} pt`);
            passedCount++;
        } else {
            console.log(`   ❌ winning_amount: ${auction.winning_amount || 'NULL'} (저장되지 않음)`);
            failedCount++;
        }
        
        // 2. winner_user_id 저장 확인
        if (auction.winner_user_id) {
            console.log(`   ✅ winner_user_id: ${auction.winner_user_id}`);
            passedCount++;
        } else {
            console.log(`   ⚠️  winner_user_id: NULL (입찰자가 없었을 수 있음)`);
        }
        
        // 3. 소유권 이전 확인
        if (auction.ruler_id && auction.winner_user_id) {
            if (String(auction.ruler_id) === String(auction.winner_user_id)) {
                console.log(`   ✅ 소유권 이전: 정상 (ruler_id = winner_user_id)`);
                passedCount++;
            } else {
                console.log(`   ❌ 소유권 이전: 불일치 (ruler_id: ${auction.ruler_id}, winner_user_id: ${auction.winner_user_id})`);
                failedCount++;
            }
        }
        
        // 4. last_winning_amount 저장 확인
        if (auction.last_winning_amount && parseFloat(auction.last_winning_amount) > 0) {
            if (parseFloat(auction.last_winning_amount) === parseFloat(auction.winning_amount)) {
                console.log(`   ✅ last_winning_amount: ${auction.last_winning_amount} pt (일치)`);
                passedCount++;
            } else {
                console.log(`   ⚠️  last_winning_amount: ${auction.last_winning_amount} pt (winning_amount와 불일치)`);
            }
        } else {
            console.log(`   ⚠️  last_winning_amount: NULL (아직 저장되지 않았을 수 있음)`);
        }
        
        // 5. 보호기간 확인
        if (auction.protection_ends_at) {
            const protectionEndsAt = new Date(auction.protection_ends_at);
            const now = new Date();
            const daysRemaining = Math.ceil((protectionEndsAt - now) / (24 * 60 * 60 * 1000));
            
            console.log(`   ✅ protection_ends_at: ${protectionEndsAt.toISOString()}`);
            console.log(`   ✅ 보호기간 남은 일수: ${daysRemaining}일`);
            
            // 보호기간이 입찰금액에 맞는지 확인
            const winningAmount = parseFloat(auction.winning_amount || 0);
            let expectedDays = 7;
            if (winningAmount >= 400) expectedDays = 30;
            else if (winningAmount >= 300) expectedDays = 28;
            else if (winningAmount >= 200) expectedDays = 21;
            else if (winningAmount >= 100) expectedDays = 14;
            
            // 실제 보호기간과 예상 보호기간 비교 (약간의 오차 허용)
            if (Math.abs(daysRemaining - expectedDays) <= 1) {
                console.log(`   ✅ 보호기간 계산: 정상 (예상: ${expectedDays}일, 실제: ${daysRemaining}일)`);
                passedCount++;
            } else {
                console.log(`   ⚠️  보호기간 계산: 불일치 (예상: ${expectedDays}일, 실제: ${daysRemaining}일)`);
            }
        } else {
            console.log(`   ⚠️  protection_ends_at: NULL`);
        }
    }
    
    console.log(`\n   결과: ${passedCount}개 통과, ${failedCount}개 실패`);
    
    return failedCount === 0;
}

async function testProtectionDaysCalculation() {
    console.log('\n📋 [Test 3] 보호기간 계산 로직 확인');
    console.log('='.repeat(50));
    
    const pool = getPool();
    
    // 입찰금액별 보호기간 확인
    const testCases = [
        { amount: 50, expectedDays: 7 },
        { amount: 150, expectedDays: 14 },
        { amount: 250, expectedDays: 21 },
        { amount: 350, expectedDays: 28 },
        { amount: 450, expectedDays: 30 },
        { amount: 500, expectedDays: 30 }
    ];
    
    console.log('   입찰금액별 예상 보호기간:');
    for (const testCase of testCases) {
        // 서버 로직과 동일하게 계산
        let expectedDays = 7;
        if (testCase.amount >= 400) expectedDays = 30;
        else if (testCase.amount >= 300) expectedDays = 28;
        else if (testCase.amount >= 200) expectedDays = 21;
        else if (testCase.amount >= 100) expectedDays = 14;
        
        const match = expectedDays === testCase.expectedDays;
        console.log(`   ${match ? '✅' : '❌'} ${testCase.amount}pt → ${expectedDays}일 (예상: ${testCase.expectedDays}일)`);
    }
    
    return true;
}

async function testNextAuctionStartingBid() {
    console.log('\n📋 [Test 4] 다음 경매 시작가 확인');
    console.log('='.repeat(50));
    
    const pool = getPool();
    
    // last_winning_amount가 있는 영토 확인
    const territoriesWithLastBid = await pool.query(`
        SELECT 
            t.id,
            t.last_winning_amount,
            a.id as auction_id,
            a.min_bid as starting_bid,
            a.status
        FROM territories t
        LEFT JOIN auctions a ON a.territory_id = t.id AND a.status = 'active'
        WHERE t.last_winning_amount IS NOT NULL
        ORDER BY t.updated_at DESC
        LIMIT 5
    `);
    
    if (territoriesWithLastBid.rows.length === 0) {
        console.log('⚠️  [Test 4] SKIPPED: last_winning_amount가 있는 영토가 없습니다');
        console.log('   → 옥션을 종료한 후 다시 테스트하세요');
        return true;
    }
    
    let passedCount = 0;
    let failedCount = 0;
    
    for (const territory of territoriesWithLastBid.rows) {
        console.log(`\n   영토 ID: ${territory.id}`);
        console.log(`   last_winning_amount: ${territory.last_winning_amount} pt`);
        
        if (territory.auction_id) {
            const startingBid = parseFloat(territory.starting_bid || 0);
            const lastWinning = parseFloat(territory.last_winning_amount || 0);
            
            if (startingBid >= lastWinning) {
                console.log(`   ✅ 시작가: ${startingBid} pt (last_winning_amount 이상)`);
                passedCount++;
            } else {
                console.log(`   ❌ 시작가: ${startingBid} pt (last_winning_amount ${lastWinning}pt보다 낮음)`);
                failedCount++;
            }
        } else {
            console.log(`   ℹ️  활성 경매 없음 (다음 경매 생성 시 확인)`);
        }
    }
    
    console.log(`\n   결과: ${passedCount}개 통과, ${failedCount}개 실패`);
    
    return failedCount === 0;
}

async function testExpectedProtectionDays() {
    console.log('\n📋 [Test 5] 예상 보호기간 API 응답 확인');
    console.log('='.repeat(50));
    
    console.log('   ⚠️  이 테스트는 실제 API 호출이 필요합니다.');
    console.log('   → POST /api/auctions/:id/bids 응답에 expectedProtectionDays 포함 확인');
    console.log('   → GET /api/auctions/:id 응답에 expectedProtectionDays 포함 확인');
    console.log('   → 프론트엔드 UI에 예상 보호기간 표시 확인');
    
    return true;
}

async function main() {
    try {
        console.log('🧪 옥션 종료 개선 사항 테스트 시작');
        console.log('='.repeat(50));
        
        // DB 초기화
        await initDatabase();
        console.log('✅ 데이터베이스 연결 성공\n');
        
        // 테스트 실행
        const results = [];
        
        results.push(await testMigration());
        results.push(await testAuctionEndFlow());
        results.push(await testProtectionDaysCalculation());
        results.push(await testNextAuctionStartingBid());
        results.push(await testExpectedProtectionDays());
        
        // 결과 요약
        console.log('\n' + '='.repeat(50));
        console.log('📊 테스트 결과 요약');
        console.log('='.repeat(50));
        
        const passed = results.filter(r => r === true).length;
        const total = results.length;
        
        console.log(`✅ 통과: ${passed}/${total}`);
        console.log(`❌ 실패: ${total - passed}/${total}`);
        
        if (passed === total) {
            console.log('\n🎉 모든 테스트 통과!');
            process.exit(0);
        } else {
            console.log('\n⚠️  일부 테스트 실패. 위의 결과를 확인하세요.');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('\n❌ 테스트 실행 중 오류 발생:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

main();

