/**
 * Firestore → Postgres 데이터 이관 스크립트
 * 
 * 사용법:
 *   node scripts/migrate-from-firestore.js
 * 
 * 환경 변수 필요:
 *   - DATABASE_URL: Postgres 연결 문자열
 *   - FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL: Firebase Admin SDK 인증
 */

import 'dotenv/config';
import { getPool, query } from '../db/init.js';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import pg from 'pg';

// Firebase Admin SDK 초기화
if (!admin.apps.length) {
    let serviceAccountData = null;
    
    // 1. 서비스 계정 키 파일에서 읽기 시도 (가장 확실한 방법)
    const serviceAccountFiles = [
        path.join(__dirname, '../../FIREBASE_SERVICE_ACCOUNT_ONELINE.txt'),
        path.join(__dirname, '../../firebase-service-account.json'),
    ];
    
    for (const filePath of serviceAccountFiles) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8').trim();
                // JSON 파싱 시도
                try {
                    // 여러 줄일 수 있으므로 첫 번째 JSON 라인 찾기
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('{')) {
                            serviceAccountData = JSON.parse(trimmed);
                            console.log(`✅ 서비스 계정 키 파일에서 인증 정보 로드: ${filePath}`);
                            break;
                        }
                    }
                    if (serviceAccountData) break;
                    
                    // 전체 내용이 JSON인 경우
                    serviceAccountData = JSON.parse(content);
                    console.log(`✅ 서비스 계정 키 파일에서 인증 정보 로드: ${filePath}`);
                    break;
                } catch (parseError) {
                    // JSON 파싱 실패, 다음 파일 시도
                    continue;
                }
            }
        } catch (error) {
            // 파일 읽기 실패, 다음 파일 시도
            continue;
        }
    }
    
    // 2. 환경 변수에서 읽기 시도
    if (!serviceAccountData) {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        let privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        
        if (projectId && privateKey && clientEmail) {
            serviceAccountData = {
                project_id: projectId,
                private_key: privateKey,
                client_email: clientEmail
            };
            console.log(`✅ 환경 변수에서 인증 정보 로드`);
        }
    }
    
    // 3. 서비스 계정 데이터가 없으면 에러
    if (!serviceAccountData || !serviceAccountData.project_id || !serviceAccountData.private_key || !serviceAccountData.client_email) {
        console.error('\n❌ Firebase 인증 정보를 찾을 수 없습니다.');
        console.error('\n해결 방법:');
        console.error('1. FIREBASE_SERVICE_ACCOUNT_ONELINE.txt 파일 확인');
        console.error('2. 또는 backend/.env 파일에 Firebase 환경 변수 설정');
        process.exit(1);
    }
    
    // Firebase Admin SDK 초기화
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: serviceAccountData.project_id,
            privateKey: serviceAccountData.private_key,
            clientEmail: serviceAccountData.client_email,
        }),
    });
    
    console.log(`✅ Firebase Admin SDK 초기화 완료 (프로젝트: ${serviceAccountData.project_id})\n`);
}

const db = admin.firestore();

/**
 * 사용자 데이터 이관
 */
async function migrateUsers() {
    console.log('📦 Migrating users...');
    
    const usersSnapshot = await db.collection('users').get();
    let migrated = 0;
    let skipped = 0;
    
    for (const doc of usersSnapshot.docs) {
        const data = doc.data();
        const firebaseUid = doc.id;
        
        try {
            // 이미 존재하는지 확인
            const existing = await query(
                `SELECT id FROM users WHERE firebase_uid = $1`,
                [firebaseUid]
            );
            
            if (existing.rows.length > 0) {
                console.log(`  ⏭️  User ${firebaseUid} already exists, skipping`);
                skipped++;
                continue;
            }
            
            // 사용자 삽입
            await query(
                `INSERT INTO users (firebase_uid, email, nickname, avatar_url, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (firebase_uid) DO NOTHING`,
                [
                    firebaseUid,
                    data.email || null,
                    data.displayName || data.nickname || null,
                    data.photoURL || data.avatarUrl || null,
                    data.createdAt?.toDate() || new Date(),
                    data.updatedAt?.toDate() || new Date()
                ]
            );
            
            migrated++;
            if (migrated % 10 === 0) {
                console.log(`  ✅ Migrated ${migrated} users...`);
            }
        } catch (error) {
            console.error(`  ❌ Error migrating user ${firebaseUid}:`, error.message);
        }
    }
    
    console.log(`✅ Users migration complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
}

/**
 * 영토 데이터 이관
 */
async function migrateTerritories() {
    console.log('📦 Migrating territories...');
    
    const territoriesSnapshot = await db.collection('territories').get();
    let migrated = 0;
    let skipped = 0;
    
    // firebase_uid → user_id 매핑 캐시
    const uidToUserIdCache = new Map();
    
    const getUserId = async (firebaseUid) => {
        if (!firebaseUid) return null;
        
        if (uidToUserIdCache.has(firebaseUid)) {
            return uidToUserIdCache.get(firebaseUid);
        }
        
        const result = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        const userId = result.rows.length > 0 ? result.rows[0].id : null;
        uidToUserIdCache.set(firebaseUid, userId);
        return userId;
    };
    
    for (const doc of territoriesSnapshot.docs) {
        const data = doc.data();
        const territoryId = doc.id;
        
        try {
            // 이미 존재하는지 확인
            const existing = await query(
                `SELECT id FROM territories WHERE id = $1`,
                [territoryId]
            );
            
            if (existing.rows.length > 0) {
                console.log(`  ⏭️  Territory ${territoryId} already exists, skipping`);
                skipped++;
                continue;
            }
            
            // ruler_id 매핑
            let rulerId = null;
            if (data.ruler) {
                rulerId = await getUserId(data.ruler);
            }
            
            // 상태 변환
            let status = 'unconquered';
            if (data.sovereignty === 'ruled' || data.sovereignty === 'protected') {
                status = 'ruled';
            } else if (data.sovereignty === 'contested' || data.currentAuction) {
                status = 'contested';
            }
            
            // 보호 종료 시간 변환
            let protectionEndsAt = null;
            if (data.protectionEndsAt) {
                protectionEndsAt = data.protectionEndsAt.toDate 
                    ? data.protectionEndsAt.toDate() 
                    : new Date(data.protectionEndsAt);
            } else if (data.protectedUntil) {
                protectionEndsAt = data.protectedUntil.toDate 
                    ? data.protectedUntil.toDate() 
                    : new Date(data.protectedUntil);
            }
            
            // 폴리곤 데이터 변환 (JSONB)
            let polygon = null;
            if (data.geometry || data.polygon) {
                polygon = JSON.stringify(data.geometry || data.polygon);
            }
            
            // 영토 삽입
            await query(
                `INSERT INTO territories (
                    id, code, name, name_en, country, continent,
                    polygon, base_price, status, ruler_id, ruler_name,
                    sovereignty, protection_ends_at, purchased_by_admin,
                    created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                ON CONFLICT (id) DO NOTHING`,
                [
                    territoryId,
                    data.code || null,
                    data.name || data.properties?.name || null,
                    data.name_en || data.properties?.name_en || null,
                    data.country || null,
                    data.continent || null,
                    polygon,
                    data.basePrice || data.price || data.base_price || 0,
                    status,
                    rulerId,
                    data.rulerName || null,
                    data.sovereignty || null,
                    protectionEndsAt,
                    data.purchasedByAdmin || false,
                    data.createdAt?.toDate() || new Date(),
                    data.updatedAt?.toDate() || new Date()
                ]
            );
            
            migrated++;
            if (migrated % 50 === 0) {
                console.log(`  ✅ Migrated ${migrated} territories...`);
            }
        } catch (error) {
            console.error(`  ❌ Error migrating territory ${territoryId}:`, error.message);
        }
    }
    
    console.log(`✅ Territories migration complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
}

/**
 * 경매 데이터 이관
 */
async function migrateAuctions() {
    console.log('📦 Migrating auctions...');
    
    let migrated = 0;
    let skipped = 0;
    
    // firebase_uid → user_id 매핑 캐시
    const uidToUserIdCache = new Map();
    
    const getUserId = async (firebaseUid) => {
        if (!firebaseUid) return null;
        
        if (uidToUserIdCache.has(firebaseUid)) {
            return uidToUserIdCache.get(firebaseUid);
        }
        
        const result = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        const userId = result.rows.length > 0 ? result.rows[0].id : null;
        uidToUserIdCache.set(firebaseUid, userId);
        return userId;
    };
    
    // territory_id → territory 존재 확인 캐시
    const territoryExistsCache = new Map();
    
    const checkTerritoryExists = async (territoryId) => {
        if (!territoryId) return false;
        
        if (territoryExistsCache.has(territoryId)) {
            return territoryExistsCache.get(territoryId);
        }
        
        const result = await query(
            `SELECT id FROM territories WHERE id = $1`,
            [territoryId]
        );
        
        const exists = result.rows.length > 0;
        territoryExistsCache.set(territoryId, exists);
        return exists;
    };
    
    // 전체 경매 조회 (active/ended만)
    const allAuctionsSnapshot = await db.collection('auctions')
        .where('status', 'in', ['active', 'ended'])
        .get();
    
    for (const doc of allAuctionsSnapshot.docs) {
        const data = doc.data();
        const auctionId = doc.id;
        
        try {
            // 영토 존재 확인
            const territoryId = data.territoryId || data.territory?.id;
            if (!territoryId || !(await checkTerritoryExists(territoryId))) {
                console.log(`  ⏭️  Auction ${auctionId} has invalid territory, skipping`);
                skipped++;
                continue;
            }
            
            // 이미 존재하는지 확인
            const existing = await query(
                `SELECT id FROM auctions WHERE id = $1`,
                [auctionId]
            );
            
            if (existing.rows.length > 0) {
                console.log(`  ⏭️  Auction ${auctionId} already exists, skipping`);
                skipped++;
                continue;
            }
            
            // current_bidder_id 매핑
            let currentBidderId = null;
            if (data.currentBidder || data.highestBidder) {
                currentBidderId = await getUserId(data.currentBidder || data.highestBidder);
            }
            
            // 시간 변환
            const startTime = data.startTime?.toDate 
                ? data.startTime.toDate() 
                : (data.startTime ? new Date(data.startTime) : null);
            
            const endTime = data.endTime?.toDate 
                ? data.endTime.toDate() 
                : (data.endTime ? new Date(data.endTime) : null);
            
            // 경매 삽입
            await query(
                `INSERT INTO auctions (
                    id, territory_id, status, start_time, end_time,
                    min_bid, current_bid, current_bidder_id,
                    season, country, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO NOTHING`,
                [
                    auctionId,
                    territoryId,
                    data.status || 'active',
                    startTime,
                    endTime,
                    data.startingBid || data.minBid || 0,
                    data.currentBid || data.highestBid || null,
                    currentBidderId,
                    data.season || null,
                    data.country || null,
                    data.createdAt?.toDate() || new Date(),
                    data.updatedAt?.toDate() || new Date()
                ]
            );
            
            migrated++;
            if (migrated % 10 === 0) {
                console.log(`  ✅ Migrated ${migrated} auctions...`);
            }
        } catch (error) {
            console.error(`  ❌ Error migrating auction ${auctionId}:`, error.message);
        }
    }
    
    console.log(`✅ Auctions migration complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
}

/**
 * 입찰 데이터 이관
 */
async function migrateBids() {
    console.log('📦 Migrating bids...');
    
    // 경매별로 입찰 조회
    const auctionsResult = await query(`SELECT id FROM auctions`);
    let totalMigrated = 0;
    let totalSkipped = 0;
    
    // firebase_uid → user_id 매핑 캐시
    const uidToUserIdCache = new Map();
    
    const getUserId = async (firebaseUid) => {
        if (!firebaseUid) return null;
        
        if (uidToUserIdCache.has(firebaseUid)) {
            return uidToUserIdCache.get(firebaseUid);
        }
        
        const result = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        const userId = result.rows.length > 0 ? result.rows[0].id : null;
        uidToUserIdCache.set(firebaseUid, userId);
        return userId;
    };
    
    for (const auctionRow of auctionsResult.rows) {
        const auctionId = auctionRow.id;
        
        try {
            const bidsSnapshot = await db.collection('auctions')
                .doc(auctionId)
                .collection('bids')
                .get();
            
            let migrated = 0;
            
            for (const bidDoc of bidsSnapshot.docs) {
                const data = bidDoc.data();
                
                try {
                    // user_id 매핑
                    const userId = await getUserId(data.userId || data.bidder);
                    if (!userId) {
                        console.log(`  ⏭️  Bid ${bidDoc.id} has invalid user, skipping`);
                        totalSkipped++;
                        continue;
                    }
                    
                    // 이미 존재하는지 확인
                    const existing = await query(
                        `SELECT id FROM bids WHERE auction_id = $1 AND user_id = $2 AND amount = $3 AND created_at = $4`,
                        [
                            auctionId,
                            userId,
                            data.amount || data.bidAmount,
                            data.createdAt?.toDate() || new Date()
                        ]
                    );
                    
                    if (existing.rows.length > 0) {
                        totalSkipped++;
                        continue;
                    }
                    
                    // 입찰 삽입
                    await query(
                        `INSERT INTO bids (auction_id, user_id, amount, created_at)
                         VALUES ($1, $2, $3, $4)`,
                        [
                            auctionId,
                            userId,
                            data.amount || data.bidAmount || 0,
                            data.createdAt?.toDate() || new Date()
                        ]
                    );
                    
                    migrated++;
                    totalMigrated++;
                } catch (error) {
                    console.error(`  ❌ Error migrating bid ${bidDoc.id}:`, error.message);
                    totalSkipped++;
                }
            }
            
            if (migrated > 0) {
                console.log(`  ✅ Migrated ${migrated} bids for auction ${auctionId}`);
            }
        } catch (error) {
            console.error(`  ❌ Error processing auction ${auctionId}:`, error.message);
        }
    }
    
    console.log(`✅ Bids migration complete: ${totalMigrated} migrated, ${totalSkipped} skipped`);
    return { migrated: totalMigrated, skipped: totalSkipped };
}

/**
 * 지갑 데이터 이관
 */
async function migrateWallets() {
    console.log('📦 Migrating wallets...');
    
    const walletsSnapshot = await db.collection('wallets').get();
    let migrated = 0;
    let skipped = 0;
    
    // firebase_uid → user_id 매핑 캐시
    const uidToUserIdCache = new Map();
    
    const getUserId = async (firebaseUid) => {
        if (!firebaseUid) return null;
        
        if (uidToUserIdCache.has(firebaseUid)) {
            return uidToUserIdCache.get(firebaseUid);
        }
        
        const result = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        const userId = result.rows.length > 0 ? result.rows[0].id : null;
        uidToUserIdCache.set(firebaseUid, userId);
        return userId;
    };
    
    for (const doc of walletsSnapshot.docs) {
        const data = doc.data();
        const firebaseUid = doc.id;
        
        try {
            const userId = await getUserId(firebaseUid);
            if (!userId) {
                console.log(`  ⏭️  Wallet for user ${firebaseUid} not found, skipping`);
                skipped++;
                continue;
            }
            
            // 이미 존재하는지 확인
            const existing = await query(
                `SELECT id FROM wallets WHERE user_id = $1`,
                [userId]
            );
            
            if (existing.rows.length > 0) {
                // 업데이트
                await query(
                    `UPDATE wallets 
                     SET balance = $1, updated_at = $2
                     WHERE user_id = $3`,
                    [
                        data.balance || 0,
                        data.updatedAt?.toDate() || new Date(),
                        userId
                    ]
                );
                skipped++;
                continue;
            }
            
            // 지갑 삽입
            await query(
                `INSERT INTO wallets (user_id, balance, created_at, updated_at)
                 VALUES ($1, $2, $3, $4)`,
                [
                    userId,
                    data.balance || 0,
                    data.createdAt?.toDate() || new Date(),
                    data.updatedAt?.toDate() || new Date()
                ]
            );
            
            migrated++;
            if (migrated % 10 === 0) {
                console.log(`  ✅ Migrated ${migrated} wallets...`);
            }
        } catch (error) {
            console.error(`  ❌ Error migrating wallet for ${firebaseUid}:`, error.message);
        }
    }
    
    console.log(`✅ Wallets migration complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
}

/**
 * 소유권 이력 데이터 이관
 */
async function migrateOwnerships() {
    console.log('📦 Migrating ownerships...');
    
    const ownershipsSnapshot = await db.collection('ownerships').get();
    let migrated = 0;
    let skipped = 0;
    
    // firebase_uid → user_id 매핑 캐시
    const uidToUserIdCache = new Map();
    
    const getUserId = async (firebaseUid) => {
        if (!firebaseUid) return null;
        
        if (uidToUserIdCache.has(firebaseUid)) {
            return uidToUserIdCache.get(firebaseUid);
        }
        
        const result = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        const userId = result.rows.length > 0 ? result.rows[0].id : null;
        uidToUserIdCache.set(firebaseUid, userId);
        return userId;
    };
    
    for (const doc of ownershipsSnapshot.docs) {
        const data = doc.data();
        
        try {
            const territoryId = data.territoryId || data.territory?.id;
            if (!territoryId) {
                skipped++;
                continue;
            }
            
            const userId = await getUserId(data.userId || data.user?.id);
            if (!userId) {
                skipped++;
                continue;
            }
            
            // 소유권 삽입
            await query(
                `INSERT INTO ownerships (
                    territory_id, user_id, acquired_at, price, ended_at, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT DO NOTHING`,
                [
                    territoryId,
                    userId,
                    data.acquiredAt?.toDate() || data.createdAt?.toDate() || new Date(),
                    data.price || null,
                    data.endedAt?.toDate() || null,
                    data.createdAt?.toDate() || new Date()
                ]
            );
            
            migrated++;
            if (migrated % 50 === 0) {
                console.log(`  ✅ Migrated ${migrated} ownerships...`);
            }
        } catch (error) {
            console.error(`  ❌ Error migrating ownership ${doc.id}:`, error.message);
        }
    }
    
    console.log(`✅ Ownerships migration complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
}

/**
 * 데이터 검증
 */
async function validateMigration() {
    console.log('🔍 Validating migration...');
    
    const firestoreCounts = {
        users: (await db.collection('users').get()).size,
        territories: (await db.collection('territories').get()).size,
        auctions: (await db.collection('auctions').get()).size,
        wallets: (await db.collection('wallets').get()).size,
    };
    
    const postgresCounts = {
        users: (await query(`SELECT COUNT(*) as count FROM users`)).rows[0].count,
        territories: (await query(`SELECT COUNT(*) as count FROM territories`)).rows[0].count,
        auctions: (await query(`SELECT COUNT(*) as count FROM auctions`)).rows[0].count,
        wallets: (await query(`SELECT COUNT(*) as count FROM wallets`)).rows[0].count,
    };
    
    console.log('\n📊 Migration Statistics:');
    console.log('='.repeat(60));
    console.log('Collection        | Firestore | Postgres | Status');
    console.log('-'.repeat(60));
    console.log(`Users             | ${String(firestoreCounts.users).padStart(9)} | ${String(postgresCounts.users).padStart(8)} | ${firestoreCounts.users <= postgresCounts.users ? '✅' : '⚠️'}`);
    console.log(`Territories       | ${String(firestoreCounts.territories).padStart(9)} | ${String(postgresCounts.territories).padStart(8)} | ${firestoreCounts.territories <= postgresCounts.territories ? '✅' : '⚠️'}`);
    console.log(`Auctions          | ${String(firestoreCounts.auctions).padStart(9)} | ${String(postgresCounts.auctions).padStart(8)} | ${firestoreCounts.auctions <= postgresCounts.auctions ? '✅' : '⚠️'}`);
    console.log(`Bids              |      -    | ${String(postgresCounts.bids).padStart(8)} | ✅`);
    console.log(`Wallets           | ${String(firestoreCounts.wallets).padStart(9)} | ${String(postgresCounts.wallets).padStart(8)} | ${firestoreCounts.wallets <= postgresCounts.wallets ? '✅' : '⚠️'}`);
    console.log(`Ownerships        | ${String(firestoreCounts.ownerships).padStart(9)} | ${String(postgresCounts.ownerships).padStart(8)} | ${firestoreCounts.ownerships <= postgresCounts.ownerships ? '✅' : '⚠️'}`);
    console.log('='.repeat(60));
}

/**
 * 메인 함수
 */
async function main() {
    console.log('🚀 Starting Firestore → Postgres migration...\n');
    
    try {
        // 1. 사용자 이관
        await migrateUsers();
        console.log('');
        
        // 2. 영토 이관
        await migrateTerritories();
        console.log('');
        
        // 3. 경매 이관
        await migrateAuctions();
        console.log('');
        
        // 4. 입찰 이관
        await migrateBids();
        console.log('');
        
        // 5. 지갑 이관
        await migrateWallets();
        console.log('');
        
        // 6. 소유권 이력 이관
        await migrateOwnerships();
        console.log('');
        
        // 7. 데이터 검증
        await validateMigration();
        
        console.log('\n✅ Migration completed successfully!');
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    } finally {
        const pool = getPool();
        await pool.end();
        process.exit(0);
    }
}

// 스크립트 실행
main();

