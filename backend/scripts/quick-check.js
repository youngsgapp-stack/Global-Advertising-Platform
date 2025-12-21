/**
 * 빠른 데이터 확인 스크립트
 * 
 * 사용법:
 *   cd backend
 *   node scripts/quick-check.js
 */

import 'dotenv/config';
import { getPool, query, initDatabase } from '../db/init.js';

console.log('🔍 빠른 데이터 확인 시작...\n');

try {
    await initDatabase();
    console.log('✅ PostgreSQL 연결 성공\n');

    // 1. 테이블별 개수 확인
    console.log('📊 테이블별 데이터 개수:');
    console.log('━'.repeat(40));
    
    const tables = ['users', 'territories', 'auctions', 'bids', 'wallets', 'ownerships'];
    
    for (const table of tables) {
        try {
            const result = await query(`SELECT COUNT(*) as count FROM ${table}`);
            const count = parseInt(result.rows[0].count);
            console.log(`  ${table.padEnd(15)} ${count.toLocaleString().padStart(10)}개`);
        } catch (error) {
            console.log(`  ${table.padEnd(15)} ❌ 테이블 없음`);
        }
    }

    // 2. 영토 상태 분포
    console.log('\n🏰 영토 상태 분포:');
    console.log('━'.repeat(40));
    try {
        const territoryStatus = await query(`
            SELECT 
                COALESCE(sovereignty, 'null') as sovereignty, 
                COUNT(*) as count 
            FROM territories 
            GROUP BY sovereignty
            ORDER BY count DESC
        `);
        territoryStatus.rows.forEach(row => {
            console.log(`  ${row.sovereignty.padEnd(15)} ${parseInt(row.count).toLocaleString().padStart(10)}개`);
        });
    } catch (error) {
        console.log('  ❌ 조회 실패:', error.message);
    }

    // 3. 소유된 영토
    console.log('\n👑 소유 정보:');
    console.log('━'.repeat(40));
    try {
        const owned = await query(`
            SELECT COUNT(*) as count 
            FROM territories 
            WHERE ruler_id IS NOT NULL
        `);
        const ownedCount = parseInt(owned.rows[0].count);
        console.log(`  소유된 영토: ${ownedCount.toLocaleString()}개`);
        
        const total = await query(`SELECT COUNT(*) as count FROM territories`);
        const totalCount = parseInt(total.rows[0].count);
        const percentage = totalCount > 0 ? ((ownedCount / totalCount) * 100).toFixed(2) : 0;
        console.log(`  소유율: ${percentage}%`);
    } catch (error) {
        console.log('  ❌ 조회 실패:', error.message);
    }

    // 4. 지갑 잔액
    console.log('\n💰 지갑 잔액:');
    console.log('━'.repeat(40));
    try {
        const wallets = await query(`
            SELECT 
                u.email, 
                COALESCE(w.balance, 0) as balance 
            FROM users u
            LEFT JOIN wallets w ON w.user_id = u.id
            ORDER BY w.balance DESC NULLS LAST
            LIMIT 10
        `);
        
        if (wallets.rows.length === 0) {
            console.log('  지갑 데이터 없음');
        } else {
            let totalBalance = 0;
            wallets.rows.forEach(row => {
                const balance = parseFloat(row.balance || 0);
                totalBalance += balance;
                console.log(`  ${(row.email || 'N/A').padEnd(30)} ${balance.toFixed(2).padStart(10)} pt`);
            });
            console.log(`  ${'-'.repeat(40)}`);
            console.log(`  총 잔액: ${totalBalance.toFixed(2).padStart(10)} pt`);
        }
    } catch (error) {
        console.log('  ❌ 조회 실패:', error.message);
    }

    // 5. 경매 상태
    console.log('\n🔨 경매 상태:');
    console.log('━'.repeat(40));
    try {
        const auctions = await query(`
            SELECT 
                COALESCE(status, 'null') as status, 
                COUNT(*) as count 
            FROM auctions 
            GROUP BY status
            ORDER BY count DESC
        `);
        
        if (auctions.rows.length === 0) {
            console.log('  경매 데이터 없음');
        } else {
            auctions.rows.forEach(row => {
                console.log(`  ${row.status.padEnd(15)} ${parseInt(row.count).toLocaleString().padStart(10)}개`);
            });
        }
    } catch (error) {
        console.log('  ❌ 조회 실패:', error.message);
    }

    // 6. 최근 사용자
    console.log('\n👤 최근 가입 사용자 (최대 5명):');
    console.log('━'.repeat(40));
    try {
        const recentUsers = await query(`
            SELECT 
                email, 
                nickname, 
                created_at 
            FROM users 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        
        if (recentUsers.rows.length === 0) {
            console.log('  사용자 데이터 없음');
        } else {
            recentUsers.rows.forEach(row => {
                const date = row.created_at ? new Date(row.created_at).toLocaleDateString('ko-KR') : 'N/A';
                const name = row.nickname || row.email || 'N/A';
                console.log(`  ${(name).padEnd(30)} ${date}`);
            });
        }
    } catch (error) {
        console.log('  ❌ 조회 실패:', error.message);
    }

    console.log('\n✅ 확인 완료!\n');
    
    process.exit(0);
} catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    console.error(error.stack);
    process.exit(1);
}

