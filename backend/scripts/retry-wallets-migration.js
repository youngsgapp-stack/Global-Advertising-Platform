/**
 * Wallets 재이관 스크립트
 * 
 * 분석 결과를 바탕으로 wallets 데이터를 재이관합니다.
 * 
 * 사용법:
 *   node scripts/retry-wallets-migration.js [백업파일경로]
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

console.log('🔄 Wallets 재이관 시작...\n');
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

/**
 * Firebase UID를 PostgreSQL user ID로 변환
 */
async function getUserId(firebaseUid) {
    if (!firebaseUid) return null;
    const result = await query('SELECT id FROM users WHERE firebase_uid = $1', [firebaseUid]);
    return result.rows.length > 0 ? result.rows[0].id : null;
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
        const postgresUserId = await getUserId(userId);
        if (!postgresUserId) {
            skipped++;
            errors.push({ 
                docId: doc.id, 
                firebaseUid: userId,
                reason: 'Firebase UID에 해당하는 user가 PostgreSQL에 없음' 
            });
            continue;
        }

        // 이미 존재하는지 확인
        const existing = await query(
            'SELECT id FROM wallets WHERE user_id = $1',
            [postgresUserId]
        );

        if (existing.rows.length > 0) {
            skipped++;
            continue; // 이미 존재하면 건너뜀
        }

        // Timestamp 변환
        const createdAt = data.createdAt?._firestore_timestamp
            ? new Date(data.createdAt.seconds * 1000 + data.createdAt.nanoseconds / 1000000)
            : (data.createdAt ? new Date(data.createdAt) : new Date());

        const updatedAt = data.updatedAt?._firestore_timestamp
            ? new Date(data.updatedAt.seconds * 1000 + data.updatedAt.nanoseconds / 1000000)
            : (data.updatedAt ? new Date(data.updatedAt) : new Date());

        // balance 값 추출 (다양한 필드명 지원)
        const balance = parseFloat(data.balance || data.holdBalance || data.balance_amount || 0);

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
        console.log(`✅ ${doc.id} 이관 완료 (${userId} → balance: ${balance})`);
    } catch (error) {
        skipped++;
        errors.push({ docId: doc.id, reason: error.message });
        console.error(`  ❌ 지갑 이관 실패 (${doc.id}):`, error.message);
    }
}

console.log(`\n📊 재이관 결과:`);
console.log(`   ✅ 이관 완료: ${migrated}개`);
console.log(`   ⚠️  건너뜀: ${skipped}개`);

if (errors.length > 0 && errors.length <= 20) {
    console.log(`\n⚠️  오류 상세:`);
    errors.forEach(err => {
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

console.log('\n✅ 재이관 완료');
process.exit(0);









