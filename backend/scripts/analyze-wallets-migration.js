/**
 * Wallets 이관 문제 분석 스크립트
 * 
 * 사용법:
 *   node scripts/analyze-wallets-migration.js [백업파일경로]
 */

import 'dotenv/config';
import { getPool, query, initDatabase } from '../db/init.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 백업 파일 경로
const backupFile = process.argv[2] || 
    path.join(__dirname, '../../backups/firestore-backup-2025-12-11_00-23-14-530Z.json');

console.log('🔍 Wallets 이관 문제 분석 시작...\n');
console.log(`📁 백업 파일: ${backupFile}\n`);

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

// PostgreSQL에서 현재 users 데이터 확인
console.log('\n📊 PostgreSQL users 데이터:');
const usersResult = await query('SELECT id, firebase_uid, email, nickname FROM users');
console.log(`   총 ${usersResult.rows.length}개 사용자`);
usersResult.rows.forEach(user => {
    console.log(`   - ${user.firebase_uid} → ${user.id} (${user.email || user.nickname || 'N/A'})`);
});

// 백업 파일의 wallets 데이터 확인
const walletsCollection = collections.wallets;
if (!walletsCollection || !walletsCollection.documents || walletsCollection.documents.length === 0) {
    console.log('\n⚠️  wallets 컬렉션이 비어있습니다.');
    process.exit(0);
}

console.log(`\n📊 Firestore wallets 데이터: ${walletsCollection.documents.length}개 문서`);

// 각 wallet 문서 분석
const walletAnalysis = {
    missingUsers: [],
    foundUsers: [],
    invalidFormat: [],
    alreadyMigrated: []
};

for (const doc of walletsCollection.documents) {
    try {
        const data = doc.data || doc;
        const userId = data.userId || data.user_id || doc.id;
        
        if (!userId) {
            walletAnalysis.invalidFormat.push({
                docId: doc.id,
                reason: 'userId 필드 없음',
                data: data
            });
            continue;
        }

        // Firebase UID로 PostgreSQL user 조회
        const userResult = await query(
            'SELECT id, firebase_uid, email FROM users WHERE firebase_uid = $1',
            [userId]
        );

        // 이미 이관된 wallet 확인
        if (userResult.rows.length > 0) {
            const postgresUserId = userResult.rows[0].id;
            const existingWallet = await query(
                'SELECT id FROM wallets WHERE user_id = $1',
                [postgresUserId]
            );

            if (existingWallet.rows.length > 0) {
                walletAnalysis.alreadyMigrated.push({
                    docId: doc.id,
                    firebaseUid: userId,
                    postgresUserId: postgresUserId,
                    email: userResult.rows[0].email
                });
            } else {
                walletAnalysis.foundUsers.push({
                    docId: doc.id,
                    firebaseUid: userId,
                    postgresUserId: postgresUserId,
                    email: userResult.rows[0].email,
                    balance: data.balance || data.holdBalance || 0,
                    data: data
                });
            }
        } else {
            // 임시/테스트 사용자인지 확인
            const isTemporaryUser = userId.startsWith('admin_') || userId.includes('admin_');
            walletAnalysis.missingUsers.push({
                docId: doc.id,
                firebaseUid: userId,
                reason: isTemporaryUser 
                    ? '임시/테스트 사용자 (실제 Firebase Auth 사용자 아님)' 
                    : 'Firebase UID에 해당하는 user가 PostgreSQL에 없음',
                isTemporary: isTemporaryUser,
                balance: data.balance || data.holdBalance || 0,
                data: data
            });
        }
    } catch (error) {
        walletAnalysis.invalidFormat.push({
            docId: doc.id,
            reason: `에러: ${error.message}`,
            data: doc
        });
    }
}

// 결과 출력
console.log('\n📋 분석 결과:');
console.log(`   ✅ 이관 가능한 wallets: ${walletAnalysis.foundUsers.length}개`);
console.log(`   ⚠️  이미 이관된 wallets: ${walletAnalysis.alreadyMigrated.length}개`);
console.log(`   ❌ 사용자 매핑 실패: ${walletAnalysis.missingUsers.length}개`);
console.log(`   ⚠️  형식 오류: ${walletAnalysis.invalidFormat.length}개`);

if (walletAnalysis.foundUsers.length > 0) {
    console.log('\n✅ 이관 가능한 wallets:');
    walletAnalysis.foundUsers.forEach(w => {
        console.log(`   - ${w.docId} (${w.firebaseUid} / ${w.email}): balance=${w.balance}`);
    });
}

if (walletAnalysis.missingUsers.length > 0) {
    console.log('\n❌ 사용자 매핑 실패 wallets:');
    
    // 임시/테스트 사용자와 실제 매핑 실패 분리
    const temporaryUsers = walletAnalysis.missingUsers.filter(w => w.isTemporary);
    const realFailures = walletAnalysis.missingUsers.filter(w => !w.isTemporary);
    
    if (temporaryUsers.length > 0) {
        console.log(`\n   🔸 임시/테스트 사용자: ${temporaryUsers.length}개`);
        const totalBalance = temporaryUsers.reduce((sum, w) => sum + parseFloat(w.balance || 0), 0);
        console.log(`   총 balance: ${totalBalance.toFixed(2)}`);
        temporaryUsers.slice(0, 5).forEach(w => {
            console.log(`   - ${w.docId} (${w.firebaseUid}): balance=${w.balance}`);
        });
        if (temporaryUsers.length > 5) {
            console.log(`   ... 외 ${temporaryUsers.length - 5}개`);
        }
    }
    
    if (realFailures.length > 0) {
        console.log(`\n   🔸 실제 매핑 실패: ${realFailures.length}개`);
        realFailures.slice(0, 5).forEach(w => {
            console.log(`   - ${w.docId} (${w.firebaseUid}): ${w.reason}`);
        });
        if (realFailures.length > 5) {
            console.log(`   ... 외 ${realFailures.length - 5}개`);
        }
    }
}

if (walletAnalysis.invalidFormat.length > 0) {
    console.log('\n⚠️  형식 오류 wallets:');
    walletAnalysis.invalidFormat.forEach(w => {
        console.log(`   - ${w.docId}: ${w.reason}`);
    });
}

// 재이관 스크립트 생성 제안
if (walletAnalysis.foundUsers.length > 0) {
    console.log('\n💡 해결 방법:');
    console.log('   다음 명령으로 재이관 스크립트를 실행하세요:');
    console.log('   node scripts/retry-wallets-migration.js [백업파일경로]');
}

console.log('\n✅ 분석 완료');
process.exit(0);

