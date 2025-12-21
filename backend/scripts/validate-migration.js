/**
 * 데이터 무결성 검증 스크립트
 * 
 * 이관된 데이터의 무결성을 검증합니다.
 * 
 * 사용법:
 *   node scripts/validate-migration.js
 */

import 'dotenv/config';
import { getPool, query, initDatabase } from '../db/init.js';

console.log('🔍 데이터 무결성 검증 시작...\n');

// 데이터베이스 초기화
await initDatabase();

const issues = [];
const warnings = [];

/**
 * 검증 결과 출력
 */
function reportIssue(severity, table, field, issue, details = null) {
    const entry = { severity, table, field, issue, details };
    if (severity === 'ERROR') {
        issues.push(entry);
    } else {
        warnings.push(entry);
    }
}

/**
 * Users 테이블 검증
 */
async function validateUsers() {
    console.log('📊 Users 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalUsers}개 사용자`);
    
    // 필수 필드 확인
    const nullFirebaseUid = await query(
        'SELECT COUNT(*) as count FROM users WHERE firebase_uid IS NULL'
    );
    if (parseInt(nullFirebaseUid.rows[0].count) > 0) {
        reportIssue('ERROR', 'users', 'firebase_uid', 'firebase_uid가 NULL인 레코드 존재');
    }
    
    // 중복 firebase_uid 확인
    const duplicates = await query(
        `SELECT firebase_uid, COUNT(*) as count 
         FROM users 
         WHERE firebase_uid IS NOT NULL
         GROUP BY firebase_uid 
         HAVING COUNT(*) > 1`
    );
    if (duplicates.rows.length > 0) {
        reportIssue('ERROR', 'users', 'firebase_uid', '중복된 firebase_uid 발견', duplicates.rows);
    }
    
    console.log('   ✅ Users 검증 완료\n');
}

/**
 * Territories 테이블 검증
 */
async function validateTerritories() {
    console.log('📊 Territories 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM territories');
    const totalTerritories = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalTerritories}개 영토`);
    
    // Foreign Key 확인 (ruler_id)
    const invalidRulerIds = await query(
        `SELECT t.id, t.ruler_id 
         FROM territories t 
         LEFT JOIN users u ON t.ruler_id = u.id 
         WHERE t.ruler_id IS NOT NULL AND u.id IS NULL`
    );
    if (invalidRulerIds.rows.length > 0) {
        reportIssue('ERROR', 'territories', 'ruler_id', 
            '존재하지 않는 user를 참조하는 ruler_id 발견', 
            invalidRulerIds.rows);
    }
    
    // Foreign Key 확인 (current_auction_id)
    const invalidAuctionIds = await query(
        `SELECT t.id, t.current_auction_id 
         FROM territories t 
         LEFT JOIN auctions a ON t.current_auction_id = a.id 
         WHERE t.current_auction_id IS NOT NULL AND a.id IS NULL`
    );
    if (invalidAuctionIds.rows.length > 0) {
        reportIssue('WARNING', 'territories', 'current_auction_id', 
            '존재하지 않는 auction을 참조하는 current_auction_id 발견', 
            invalidAuctionIds.rows);
    }
    
    // 필수 필드 확인
    const nullIds = await query(
        'SELECT COUNT(*) as count FROM territories WHERE id IS NULL'
    );
    if (parseInt(nullIds.rows[0].count) > 0) {
        reportIssue('ERROR', 'territories', 'id', 'id가 NULL인 레코드 존재');
    }
    
    console.log('   ✅ Territories 검증 완료\n');
}

/**
 * Auctions 테이블 검증
 */
async function validateAuctions() {
    console.log('📊 Auctions 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM auctions');
    const totalAuctions = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalAuctions}개 경매`);
    
    // Foreign Key 확인 (territory_id)
    const invalidTerritoryIds = await query(
        `SELECT a.id, a.territory_id 
         FROM auctions a 
         LEFT JOIN territories t ON a.territory_id = t.id 
         WHERE a.territory_id IS NOT NULL AND t.id IS NULL`
    );
    if (invalidTerritoryIds.rows.length > 0) {
        reportIssue('ERROR', 'auctions', 'territory_id', 
            '존재하지 않는 territory를 참조하는 territory_id 발견', 
            invalidTerritoryIds.rows);
    }
    
    // Foreign Key 확인 (current_bidder_id)
    const invalidBidderIds = await query(
        `SELECT a.id, a.current_bidder_id 
         FROM auctions a 
         LEFT JOIN users u ON a.current_bidder_id = u.id 
         WHERE a.current_bidder_id IS NOT NULL AND u.id IS NULL`
    );
    if (invalidBidderIds.rows.length > 0) {
        reportIssue('ERROR', 'auctions', 'current_bidder_id', 
            '존재하지 않는 user를 참조하는 current_bidder_id 발견', 
            invalidBidderIds.rows);
    }
    
    // 비즈니스 로직 검증: current_bid >= min_bid
    const invalidBids = await query(
        `SELECT id, min_bid, current_bid 
         FROM auctions 
         WHERE current_bid IS NOT NULL 
         AND min_bid IS NOT NULL 
         AND current_bid < min_bid`
    );
    if (invalidBids.rows.length > 0) {
        reportIssue('WARNING', 'auctions', 'current_bid', 
            'current_bid가 min_bid보다 작은 경매 발견', 
            invalidBids.rows);
    }
    
    console.log('   ✅ Auctions 검증 완료\n');
}

/**
 * Wallets 테이블 검증
 */
async function validateWallets() {
    console.log('📊 Wallets 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM wallets');
    const totalWallets = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalWallets}개 지갑`);
    
    // Foreign Key 확인 (user_id)
    const invalidUserIds = await query(
        `SELECT w.id, w.user_id 
         FROM wallets w 
         LEFT JOIN users u ON w.user_id = u.id 
         WHERE w.user_id IS NOT NULL AND u.id IS NULL`
    );
    if (invalidUserIds.rows.length > 0) {
        reportIssue('ERROR', 'wallets', 'user_id', 
            '존재하지 않는 user를 참조하는 user_id 발견', 
            invalidUserIds.rows);
    }
    
    // UNIQUE 제약조건 확인 (user_id는 UNIQUE)
    const duplicates = await query(
        `SELECT user_id, COUNT(*) as count 
         FROM wallets 
         WHERE user_id IS NOT NULL
         GROUP BY user_id 
         HAVING COUNT(*) > 1`
    );
    if (duplicates.rows.length > 0) {
        reportIssue('ERROR', 'wallets', 'user_id', '중복된 user_id 발견 (UNIQUE 제약조건 위반)', duplicates.rows);
    }
    
    // balance 값 검증
    const negativeBalances = await query(
        'SELECT id, user_id, balance FROM wallets WHERE balance < 0'
    );
    if (negativeBalances.rows.length > 0) {
        reportIssue('WARNING', 'wallets', 'balance', 
            '음수 balance 발견', 
            negativeBalances.rows);
    }
    
    console.log('   ✅ Wallets 검증 완료\n');
}

/**
 * Bids 테이블 검증
 */
async function validateBids() {
    console.log('📊 Bids 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM bids');
    const totalBids = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalBids}개 입찰`);
    
    // Foreign Key 확인 (auction_id)
    const invalidAuctionIds = await query(
        `SELECT b.id, b.auction_id 
         FROM bids b 
         LEFT JOIN auctions a ON b.auction_id = a.id 
         WHERE b.auction_id IS NOT NULL AND a.id IS NULL`
    );
    if (invalidAuctionIds.rows.length > 0) {
        reportIssue('ERROR', 'bids', 'auction_id', 
            '존재하지 않는 auction을 참조하는 auction_id 발견', 
            invalidAuctionIds.rows);
    }
    
    // Foreign Key 확인 (user_id)
    const invalidUserIds = await query(
        `SELECT b.id, b.user_id 
         FROM bids b 
         LEFT JOIN users u ON b.user_id = u.id 
         WHERE b.user_id IS NOT NULL AND u.id IS NULL`
    );
    if (invalidUserIds.rows.length > 0) {
        reportIssue('ERROR', 'bids', 'user_id', 
            '존재하지 않는 user를 참조하는 user_id 발견', 
            invalidUserIds.rows);
    }
    
    console.log('   ✅ Bids 검증 완료\n');
}

/**
 * Ownerships 테이블 검증
 */
async function validateOwnerships() {
    console.log('📊 Ownerships 테이블 검증 중...');
    
    // 총 개수 확인
    const countResult = await query('SELECT COUNT(*) as count FROM ownerships');
    const totalOwnerships = parseInt(countResult.rows[0].count);
    console.log(`   총 ${totalOwnerships}개 소유권`);
    
    // Foreign Key 확인 (territory_id)
    const invalidTerritoryIds = await query(
        `SELECT o.id, o.territory_id 
         FROM ownerships o 
         LEFT JOIN territories t ON o.territory_id = t.id 
         WHERE o.territory_id IS NOT NULL AND t.id IS NULL`
    );
    if (invalidTerritoryIds.rows.length > 0) {
        reportIssue('ERROR', 'ownerships', 'territory_id', 
            '존재하지 않는 territory를 참조하는 territory_id 발견', 
            invalidTerritoryIds.rows);
    }
    
    // Foreign Key 확인 (user_id)
    const invalidUserIds = await query(
        `SELECT o.id, o.user_id 
         FROM ownerships o 
         LEFT JOIN users u ON o.user_id = u.id 
         WHERE o.user_id IS NOT NULL AND u.id IS NULL`
    );
    if (invalidUserIds.rows.length > 0) {
        reportIssue('ERROR', 'ownerships', 'user_id', 
            '존재하지 않는 user를 참조하는 user_id 발견', 
            invalidUserIds.rows);
    }
    
    console.log('   ✅ Ownerships 검증 완료\n');
}

// 모든 검증 실행
await validateUsers();
await validateTerritories();
await validateAuctions();
await validateWallets();
await validateBids();
await validateOwnerships();

// 결과 출력
console.log('='.repeat(60));
console.log('📊 검증 결과 요약');
console.log('='.repeat(60));

if (issues.length === 0 && warnings.length === 0) {
    console.log('\n✅ 모든 검증을 통과했습니다! 데이터 무결성이 유지되고 있습니다.\n');
} else {
    if (issues.length > 0) {
        console.log(`\n❌ 오류: ${issues.length}개`);
        issues.forEach((issue, index) => {
            console.log(`\n${index + 1}. [${issue.table}.${issue.field}] ${issue.issue}`);
            if (issue.details && issue.details.length > 0) {
                console.log(`   예시: ${JSON.stringify(issue.details[0])}`);
                if (issue.details.length > 1) {
                    console.log(`   ... 외 ${issue.details.length - 1}개`);
                }
            }
        });
    }
    
    if (warnings.length > 0) {
        console.log(`\n⚠️  경고: ${warnings.length}개`);
        warnings.forEach((warning, index) => {
            console.log(`\n${index + 1}. [${warning.table}.${warning.field}] ${warning.issue}`);
            if (warning.details && warning.details.length > 0) {
                console.log(`   예시: ${JSON.stringify(warning.details[0])}`);
                if (warning.details.length > 1) {
                    console.log(`   ... 외 ${warning.details.length - 1}개`);
                }
            }
        });
    }
    
    console.log('\n');
}

process.exit(issues.length > 0 ? 1 : 0);





