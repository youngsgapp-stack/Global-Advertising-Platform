/**
 * 백업 파일에서 PostgreSQL로 데이터 이관 스크립트
 * 
 * 사용법:
 *   node scripts/migrate-from-backup.js [백업파일경로]
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

console.log('🚀 백업 파일에서 PostgreSQL로 데이터 이관 시작...\n');
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
console.log('✅ 백업 파일 파싱 완료\n');

// 백업 데이터 구조 확인
const collections = backupData.data || {};
const metadata = backupData.metadata || {};

console.log('📋 백업 데이터 정보:');
console.log(`   프로젝트: ${metadata.projectId || 'N/A'}`);
console.log(`   백업 일시: ${metadata.backupDate || metadata.timestamp || 'N/A'}`);
console.log(`   컬렉션 수: ${Object.keys(collections).length}\n`);

/**
 * 사용자 데이터 이관
 */
async function migrateUsers() {
    console.log('📦 Migrating users...');
    const usersCollection = collections.users;
    if (!usersCollection || !usersCollection.documents || usersCollection.documents.length === 0) {
        console.log('  ⚠️  users 컬렉션이 비어있습니다.\n');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const doc of usersCollection.documents) {
        try {
            const data = doc.data || doc;
            const firebaseUid = data.uid || doc.id;
            
            if (!firebaseUid) {
                skipped++;
                continue;
            }

            // 이미 존재하는지 확인
            const existing = await query(
                'SELECT id FROM users WHERE firebase_uid = $1',
                [firebaseUid]
            );

            if (existing.rows.length > 0) {
                skipped++;
                continue;
            }

            // Timestamp 변환
            const createdAt = data.createdAt?._firestore_timestamp 
                ? new Date(data.createdAt.seconds * 1000 + data.createdAt.nanoseconds / 1000000)
                : (data.createdAt ? new Date(data.createdAt) : new Date());
            
            const updatedAt = data.updatedAt?._firestore_timestamp
                ? new Date(data.updatedAt.seconds * 1000 + data.updatedAt.nanoseconds / 1000000)
                : (data.updatedAt ? new Date(data.updatedAt) : new Date());

            // 사용자 데이터 삽입
            await query(
                `INSERT INTO users (firebase_uid, email, nickname, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    firebaseUid,
                    data.email || null,
                    data.displayName || data.nickname || null,
                    createdAt,
                    updatedAt
                ]
            );

            migrated++;
        } catch (error) {
            console.error(`  ❌ 사용자 이관 실패 (${doc.id}):`, error.message);
            skipped++;
        }
    }

    console.log(`  ✅ users: ${migrated}개 이관, ${skipped}개 건너뜀\n`);
    return { migrated, skipped };
}

/**
 * Firebase UID를 Postgres user ID로 변환
 */
async function getUserId(firebaseUid) {
    if (!firebaseUid) return null;
    const result = await query('SELECT id FROM users WHERE firebase_uid = $1', [firebaseUid]);
    return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * 영토 데이터 이관
 */
async function migrateTerritories() {
    console.log('📦 Migrating territories...');
    const territoriesCollection = collections.territories;
    if (!territoriesCollection || !territoriesCollection.documents || territoriesCollection.documents.length === 0) {
        console.log('  ⚠️  territories 컬렉션이 비어있습니다.\n');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;
    let processed = 0;
    const total = territoriesCollection.documents.length;

    for (const doc of territoriesCollection.documents) {
        try {
            processed++;
            if (processed % 500 === 0) {
                console.log(`  📊 진행률: ${processed}/${total} (${((processed/total)*100).toFixed(1)}%)`);
            }

            const data = doc.data || doc;
            const territoryId = data.id || doc.id;
            
            if (!territoryId) {
                skipped++;
                continue;
            }

            // 이미 존재하는지 확인
            const existing = await query(
                'SELECT id FROM territories WHERE id = $1',
                [territoryId]
            );

            if (existing.rows.length > 0) {
                skipped++;
                continue;
            }

            // ruler_id 변환 (Firebase UID → Postgres UUID)
            let rulerId = null;
            if (data.rulerId || data.ruler_id || data.currentOwnerId) {
                const firebaseUid = data.rulerId || data.ruler_id || data.currentOwnerId;
                rulerId = await getUserId(firebaseUid);
            }

            // Timestamp 변환
            const protectionEndsAt = data.protectionEndsAt?._firestore_timestamp
                ? new Date(data.protectionEndsAt.seconds * 1000 + data.protectionEndsAt.nanoseconds / 1000000)
                : (data.protectionEndsAt ? new Date(data.protectionEndsAt) : null);

            const createdAt = data.createdAt?._firestore_timestamp
                ? new Date(data.createdAt.seconds * 1000 + data.createdAt.nanoseconds / 1000000)
                : (data.createdAt ? new Date(data.createdAt) : new Date());

            const updatedAt = data.updatedAt?._firestore_timestamp
                ? new Date(data.updatedAt.seconds * 1000 + data.updatedAt.nanoseconds / 1000000)
                : (data.updatedAt ? new Date(data.updatedAt) : new Date());

            // 영토 데이터 삽입
            await query(
                `INSERT INTO territories (
                    id, code, name, name_en, country, continent,
                    polygon, base_price, status, ruler_id, ruler_name,
                    sovereignty, protection_ends_at, purchased_by_admin,
                    created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
                [
                    territoryId,
                    data.code || data.id || null,
                    data.name || null,
                    data.name_en || data.nameEn || null,
                    data.country || null,
                    data.continent || null,
                    data.polygon ? JSON.stringify(data.polygon) : null,
                    parseFloat(data.basePrice || data.base_price || 0),
                    data.status || 'unconquered',
                    rulerId,
                    data.rulerName || data.ruler_name || null,
                    data.sovereignty || null,
                    protectionEndsAt,
                    data.purchasedByAdmin || data.purchased_by_admin || false,
                    createdAt,
                    updatedAt
                ]
            );

            migrated++;
        } catch (error) {
            console.error(`  ❌ 영토 이관 실패 (${doc.id || doc.data?.id}):`, error.message);
            skipped++;
        }
    }

    console.log(`  ✅ territories: ${migrated}개 이관, ${skipped}개 건너뜀\n`);
    return { migrated, skipped };
}

/**
 * 경매 데이터 이관
 */
async function migrateAuctions() {
    console.log('📦 Migrating auctions...');
    const auctionsCollection = collections.auctions;
    if (!auctionsCollection || !auctionsCollection.documents || auctionsCollection.documents.length === 0) {
        console.log('  ⚠️  auctions 컬렉션이 비어있습니다.\n');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const doc of auctionsCollection.documents) {
        try {
            const data = doc.data || doc;
            const auctionId = data.id || doc.id;
            
            if (!auctionId) {
                skipped++;
                continue;
            }

            // 이미 존재하는지 확인
            const existing = await query(
                'SELECT id FROM auctions WHERE id::text = $1',
                [auctionId]
            );

            if (existing.rows.length > 0) {
                skipped++;
                continue;
            }

            // territory_id 확인
            const territoryId = data.territoryId || data.territory_id;
            if (!territoryId) {
                skipped++;
                continue;
            }

            // current_bidder_id 변환
            let currentBidderId = null;
            if (data.currentBidderId || data.current_bidder_id) {
                const firebaseUid = data.currentBidderId || data.current_bidder_id;
                currentBidderId = await getUserId(firebaseUid);
            }

            // Timestamp 변환
            const startTime = data.startTime?._firestore_timestamp
                ? new Date(data.startTime.seconds * 1000 + data.startTime.nanoseconds / 1000000)
                : (data.startTime ? new Date(data.startTime) : null);

            const endTime = data.endTime?._firestore_timestamp
                ? new Date(data.endTime.seconds * 1000 + data.endTime.nanoseconds / 1000000)
                : (data.endTime ? new Date(data.endTime) : null);

            const createdAt = data.createdAt?._firestore_timestamp
                ? new Date(data.createdAt.seconds * 1000 + data.createdAt.nanoseconds / 1000000)
                : (data.createdAt ? new Date(data.createdAt) : new Date());

            const updatedAt = data.updatedAt?._firestore_timestamp
                ? new Date(data.updatedAt.seconds * 1000 + data.updatedAt.nanoseconds / 1000000)
                : (data.updatedAt ? new Date(data.updatedAt) : new Date());

            // 경매 데이터 삽입
            await query(
                `INSERT INTO auctions (
                    id, territory_id, status, start_time, end_time,
                    min_bid, current_bid, current_bidder_id, season, country,
                    created_at, updated_at
                ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    territoryId,
                    data.status || 'pending',
                    startTime,
                    endTime,
                    parseFloat(data.minBid || data.min_bid || 0),
                    parseFloat(data.currentBid || data.current_bid || 0),
                    currentBidderId,
                    data.season || null,
                    data.country || null,
                    createdAt,
                    updatedAt
                ]
            );

            migrated++;
        } catch (error) {
            console.error(`  ❌ 경매 이관 실패 (${doc.id}):`, error.message);
            skipped++;
        }
    }

    console.log(`  ✅ auctions: ${migrated}개 이관, ${skipped}개 건너뜀\n`);
    return { migrated, skipped };
}

/**
 * 지갑 데이터 이관
 */
async function migrateWallets() {
    console.log('📦 Migrating wallets...');
    const walletsCollection = collections.wallets;
    if (!walletsCollection || !walletsCollection.documents || walletsCollection.documents.length === 0) {
        console.log('  ⚠️  wallets 컬렉션이 비어있습니다.\n');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const doc of walletsCollection.documents) {
        try {
            const data = doc.data || doc;
            const userId = data.userId || data.user_id || doc.id;
            
            if (!userId) {
                skipped++;
                continue;
            }

            // Firebase UID를 Postgres user ID로 변환
            const postgresUserId = await getUserId(userId);
            if (!postgresUserId) {
                skipped++;
                continue;
            }

            // 이미 존재하는지 확인
            const existing = await query(
                'SELECT id FROM wallets WHERE user_id = $1',
                [postgresUserId]
            );

            if (existing.rows.length > 0) {
                skipped++;
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
                    parseFloat(data.balance || data.holdBalance || 0),
                    createdAt,
                    updatedAt
                ]
            );

            migrated++;
        } catch (error) {
            console.error(`  ❌ 지갑 이관 실패 (${doc.id}):`, error.message);
            skipped++;
        }
    }

    console.log(`  ✅ wallets: ${migrated}개 이관, ${skipped}개 건너뜀\n`);
    return { migrated, skipped };
}

/**
 * 메인 이관 함수
 */
async function main() {
    try {
        console.log('='.repeat(60));
        console.log('🚀 데이터 이관 시작');
        console.log('='.repeat(60));
        console.log('');

        const stats = {
            users: { migrated: 0, skipped: 0 },
            territories: { migrated: 0, skipped: 0 },
            auctions: { migrated: 0, skipped: 0 },
            wallets: { migrated: 0, skipped: 0 }
        };

        // 1. 사용자 이관
        stats.users = await migrateUsers();

        // 2. 영토 이관
        stats.territories = await migrateTerritories();

        // 3. 경매 이관
        stats.auctions = await migrateAuctions();

        // 4. 지갑 이관
        stats.wallets = await migrateWallets();

        // 결과 요약
        console.log('='.repeat(60));
        console.log('✅ 데이터 이관 완료!');
        console.log('='.repeat(60));
        console.log('📊 이관 통계:');
        console.log(`   users: ${stats.users.migrated}개 이관, ${stats.users.skipped}개 건너뜀`);
        console.log(`   territories: ${stats.territories.migrated}개 이관, ${stats.territories.skipped}개 건너뜀`);
        console.log(`   auctions: ${stats.auctions.migrated}개 이관, ${stats.auctions.skipped}개 건너뜀`);
        console.log(`   wallets: ${stats.wallets.migrated}개 이관, ${stats.wallets.skipped}개 건너뜀`);
        console.log('');
        console.log(`   총 이관된 문서: ${stats.users.migrated + stats.territories.migrated + stats.auctions.migrated + stats.wallets.migrated}개`);
        console.log('='.repeat(60));

    } catch (error) {
        console.error('\n❌ 이관 실패:', error);
        process.exit(1);
    }
}

main();

