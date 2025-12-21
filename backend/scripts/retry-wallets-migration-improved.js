/**
 * Wallets 재이관 스크립트 (개선판)
 * 
 * 임시/테스트 wallet 데이터 처리 옵션 포함
 * 
 * 사용법:
 *   node scripts/retry-wallets-migration-improved.js [백업파일경로] [--create-missing-users]
 */

import 'dotenv/config';
import { getPool, query, initDatabase } from '../db/init.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 옵션 파싱
const createMissingUsers = process.argv.includes('--create-missing-users');
const backupFile = process.argv.find(arg => arg.endsWith('.json')) || 
    path.join(__dirname, '../../backups/firestore-backup-2025-12-11_00-23-14-530Z.json');

console.log('🔄 Wallets 재이관 시작 (개선판)...\n');
console.log(`📁 백업 파일: ${backupFile}`);
console.log(`⚙️  옵션: ${createMissingUsers ? '누락된 사용자 생성 모드' : '일반 모드 (매핑 실패 시 건너뜀)'}\n`);

// 백업 파일 확인
if (!fs.existsSync(backupFile)) {
    console.error(`❌ 백업 파일을 찾을 수 없습니다: ${backupFile}`);
    process.exit(1);
}

// 데이터베이스 초기화
await initDatabase();

// 백업 파일 읽기
console.log('📖 백업 파일 읽기 중...');
const backupContent = fs.readFileSync(backupFile, 'utf8');
const backupData = JSON.parse(backupContent);
const collections = backupData.data || {};

/**
 * Firebase UID를 PostgreSQL user ID로 변환
 */
async function getUserId(firebaseUid) {
    if (!firebaseUid) return null;
    const result = await query('SELECT id FROM users WHERE firebase_uid = $1', [firebaseUid]);
    return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * 임시/테스트 사용자를 위한 user 생성
 * admin_q886654_* 형태의 UID를 처리
 */
async function createMissingUser(firebaseUid, walletData) {
    if (!createMissingUsers) return null;
    
    // admin_* 형태의 UID는 실제 Firebase Auth 사용자가 아니므로
    // 대표 사용자(q886654@naver.com)에 매핑
    const adminUserResult = await query(
        'SELECT id FROM users WHERE email = $1 OR firebase_uid LIKE $2',
        ['q886654@naver.com', '%q886654%']
    );
    
    if (adminUserResult.rows.length > 0) {
        console.log(`   ℹ️  임시 wallet (${firebaseUid}) → 관리자 계정에 매핑`);
        return adminUserResult.rows[0].id;
    }
    
    // 또는 기본 사용자 생성 (선택적)
    console.log(`   ⚠️  임시 wallet (${firebaseUid}): 관리자 계정을 찾을 수 없음`);
    return null;
}

// wallets 컬렉션 확인
const walletsCollection = collections.wallets;
if (!walletsCollection || !walletsCollection.documents || walletsCollection.documents.length === 0) {
    console.log('⚠️  wallets 컬렉션이 비어있습니다.');
    process.exit(0);
}

console.log(`📊 총 ${walletsCollection.documents.length}개 wallets 문서 처리\n`);

let migrated = 0;
let skipped = 0;
let mappedToAdmin = 0;
const errors = [];

for (const doc of walletsCollection.documents) {
    try {
        const data = doc.data || doc;
        const userId = data.userId || data.user_id || doc.id;
        
        if (!userId) {
            skipped++;
            errors.push({ docId: doc.id, reason: 'userId 필드 없음' });
            continue;
        }

        // Firebase UID를 Postgres user ID로 변환
        let postgresUserId = await getUserId(userId);
        
        // 매핑 실패 시 처리
        if (!postgresUserId) {
            // 임시/테스트 사용자인 경우 (admin_* 형태)
            if (userId.startsWith('admin_') || userId.includes('admin_')) {
                if (createMissingUsers) {
                    postgresUserId = await createMissingUser(userId, data);
                    if (postgresUserId) {
                        mappedToAdmin++;
                    } else {
                        skipped++;
                        errors.push({ 
                            docId: doc.id, 
                            firebaseUid: userId,
                            reason: '임시 사용자 매핑 실패 (관리자 계정 없음)' 
                        });
                        continue;
                    }
                } else {
                    skipped++;
                    errors.push({ 
                        docId: doc.id, 
                        firebaseUid: userId,
                        reason: '임시/테스트 사용자 (--create-missing-users 옵션 필요)' 
                    });
                    continue;
                }
            } else {
                skipped++;
                errors.push({ 
                    docId: doc.id, 
                    firebaseUid: userId,
                    reason: 'Firebase UID에 해당하는 user가 PostgreSQL에 없음' 
                });
                continue;
            }
        }

        // 이미 존재하는지 확인
        const existing = await query(
            'SELECT id, balance FROM wallets WHERE user_id = $1',
            [postgresUserId]
        );

        // balance 값 추출
        const balance = parseFloat(data.balance || data.holdBalance || data.balance_amount || 0);

        if (existing.rows.length > 0) {
            // 이미 wallet이 존재하는 경우: balance 합산 (임시 wallet의 경우)
            if (userId.startsWith('admin_') || userId.includes('admin_')) {
                const existingBalance = parseFloat(existing.rows[0].balance || 0);
                const newBalance = existingBalance + balance;
                
                // balance 업데이트
                await query(
                    'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2',
                    [newBalance, postgresUserId]
                );
                
                migrated++;
                mappedToAdmin++;
                console.log(`✅ ${doc.id} balance 합산 (${balance} → 총 ${newBalance}) [관리자 계정]`);
            } else {
                skipped++;
            }
            continue;
        }

        // Timestamp 변환
        const createdAt = data.createdAt?._firestore_timestamp
            ? new Date(data.createdAt.seconds * 1000 + data.createdAt.nanoseconds / 1000000)
            : (data.createdAt ? new Date(data.createdAt) : new Date());

        const updatedAt = data.updatedAt?._firestore_timestamp
            ? new Date(data.updatedAt.seconds * 1000 + data.updatedAt.nanoseconds / 1000000)
            : (data.updatedAt ? new Date(data.updatedAt) : new Date());

        // 지갑 데이터 삽입
        await query(
            `INSERT INTO wallets (user_id, balance, created_at, updated_at)
             VALUES ($1, $2, $3, $4)`,
            [
                postgresUserId,
                balance,
                createdAt,
                updatedAt
            ]
        );

        migrated++;
        const mappingNote = mappedToAdmin > 0 && userId.startsWith('admin_') ? ' [관리자 계정에 매핑]' : '';
        console.log(`✅ ${doc.id} 이관 완료 (${userId} → balance: ${balance})${mappingNote}`);
    } catch (error) {
        skipped++;
        errors.push({ docId: doc.id, reason: error.message });
        console.error(`  ❌ 지갑 이관 실패 (${doc.id}):`, error.message);
    }
}

console.log(`\n📊 재이관 결과:`);
console.log(`   ✅ 이관 완료: ${migrated}개`);
if (mappedToAdmin > 0) {
    console.log(`   🔄 관리자 계정에 매핑: ${mappedToAdmin}개`);
}
console.log(`   ⚠️  건너뜀: ${skipped}개`);

if (errors.length > 0 && errors.length <= 20) {
    console.log(`\n⚠️  오류 상세 (처음 20개):`);
    errors.slice(0, 20).forEach(err => {
        console.log(`   - ${err.docId}: ${err.reason}`);
    });
} else if (errors.length > 20) {
    console.log(`\n⚠️  오류: ${errors.length}개 (처음 20개만 표시)`);
    errors.slice(0, 20).forEach(err => {
        console.log(`   - ${err.docId}: ${err.reason}`);
    });
}

// 최종 상태 확인
const finalCount = await query('SELECT COUNT(*) as count FROM wallets');
console.log(`\n✅ PostgreSQL wallets 총 개수: ${finalCount.rows[0].count}개`);

if (!createMissingUsers && errors.some(e => e.reason.includes('임시/테스트'))) {
    console.log(`\n💡 팁: 임시/테스트 wallet을 관리자 계정에 매핑하려면:`);
    console.log(`   npm run retry-wallets-improved -- --create-missing-users`);
}

console.log('\n✅ 재이관 완료');
process.exit(0);

