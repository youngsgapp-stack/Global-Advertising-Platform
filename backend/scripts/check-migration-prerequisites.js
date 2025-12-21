/**
 * 데이터 이관 전 필수 조건 체크 스크립트
 * 
 * 사용법:
 *   node scripts/check-migration-prerequisites.js
 */

import 'dotenv/config';
import { getPool, query, initDatabase } from '../db/init.js';
import admin from 'firebase-admin';

console.log('🔍 데이터 이관 전 필수 조건 체크 시작...\n');

let allChecksPassed = true;

// 1. 환경 변수 체크
console.log('1️⃣ 환경 변수 확인');
console.log('-'.repeat(50));

const requiredEnvVars = {
    'DATABASE_URL': 'Postgres 연결 문자열',
    'FIREBASE_PROJECT_ID': 'Firebase 프로젝트 ID',
    'FIREBASE_PRIVATE_KEY': 'Firebase Private Key',
    'FIREBASE_CLIENT_EMAIL': 'Firebase Service Account Email'
};

const envStatus = {};
for (const [key, description] of Object.entries(requiredEnvVars)) {
    const value = process.env[key];
    const exists = !!value;
    const isValid = exists && value.length > 0;
    
    envStatus[key] = { exists, isValid, description };
    
    if (isValid) {
        // 민감한 정보는 일부만 표시
        const preview = key === 'DATABASE_URL' 
            ? value.substring(0, 30) + '...'
            : key === 'FIREBASE_PRIVATE_KEY'
            ? value.substring(0, 30) + '...'
            : value;
        console.log(`  ✅ ${key}: ${preview}`);
    } else {
        console.log(`  ❌ ${key}: ${exists ? '값이 비어있음' : '설정되지 않음'}`);
        allChecksPassed = false;
    }
}

console.log('');

// 2. Postgres 연결 체크
console.log('2️⃣ Postgres 데이터베이스 연결 확인');
console.log('-'.repeat(50));

try {
    // 먼저 데이터베이스 초기화
    await initDatabase();
    
    const pool = getPool();
    const result = await query('SELECT NOW() as current_time, version() as pg_version');
    
    console.log(`  ✅ Postgres 연결 성공`);
    console.log(`     현재 시간: ${result.rows[0].current_time}`);
    console.log(`     PostgreSQL 버전: ${result.rows[0].pg_version.split(' ')[0]} ${result.rows[0].pg_version.split(' ')[1]}`);
} catch (error) {
    console.log(`  ❌ Postgres 연결 실패: ${error.message}`);
    allChecksPassed = false;
}

console.log('');

// 3. 스키마 테이블 존재 확인
console.log('3️⃣ Postgres 스키마 테이블 확인');
console.log('-'.repeat(50));

const requiredTables = [
    'users',
    'territories',
    'auctions',
    'bids',
    'ownerships',
    'wallets',
    'wallet_transactions'
];

for (const tableName of requiredTables) {
    try {
        const result = await query(
            `SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1
            )`,
            [tableName]
        );
        
        if (result.rows[0].exists) {
            // 테이블 레코드 수 확인
            const countResult = await query(`SELECT COUNT(*) as count FROM ${tableName}`);
            const count = parseInt(countResult.rows[0].count);
            console.log(`  ✅ ${tableName}: 존재 (현재 ${count}개 레코드)`);
        } else {
            console.log(`  ❌ ${tableName}: 테이블이 존재하지 않음`);
            allChecksPassed = false;
        }
    } catch (error) {
        console.log(`  ❌ ${tableName}: 확인 실패 - ${error.message}`);
        allChecksPassed = false;
    }
}

console.log('');

// 4. Firebase Admin SDK 초기화 체크
console.log('4️⃣ Firebase Admin SDK 초기화 확인');
console.log('-'.repeat(50));

try {
    if (!admin.apps.length) {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
        
        if (!process.env.FIREBASE_PROJECT_ID || !privateKey || !process.env.FIREBASE_CLIENT_EMAIL) {
            throw new Error('Firebase 환경 변수가 설정되지 않음');
        }
        
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                privateKey: privateKey,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            }),
        });
    }
    
    const db = admin.firestore();
    
    // 간단한 읽기 테스트
    const testSnapshot = await db.collection('users').limit(1).get();
    console.log(`  ✅ Firebase Admin SDK 초기화 성공`);
    console.log(`     Firestore 연결 성공`);
    console.log(`     users 컬렉션 샘플 조회: ${testSnapshot.size}개 문서`);
} catch (error) {
    console.log(`  ❌ Firebase Admin SDK 초기화 실패: ${error.message}`);
    allChecksPassed = false;
}

console.log('');

// 5. Firestore 컬렉션 데이터 확인
console.log('5️⃣ Firestore 컬렉션 데이터 확인');
console.log('-'.repeat(50));

try {
    const db = admin.firestore();
    
    const collections = ['users', 'territories', 'auctions', 'wallets', 'ownerships'];
    const collectionCounts = {};
    
    for (const collectionName of collections) {
        try {
            const snapshot = await db.collection(collectionName).limit(1).get();
            const totalSnapshot = await db.collection(collectionName).get();
            collectionCounts[collectionName] = totalSnapshot.size;
            console.log(`  ✅ ${collectionName}: ${totalSnapshot.size}개 문서 존재`);
        } catch (error) {
            console.log(`  ⚠️  ${collectionName}: 조회 실패 - ${error.message}`);
        }
    }
    
    // 총 데이터량 확인
    const totalDocs = Object.values(collectionCounts).reduce((sum, count) => sum + count, 0);
    console.log(`     총 문서 수: ${totalDocs}개`);
    
} catch (error) {
    console.log(`  ❌ Firestore 데이터 확인 실패: ${error.message}`);
    allChecksPassed = false;
}

console.log('');

// 6. Postgres 외래키 제약조건 확인
console.log('6️⃣ Postgres 외래키 제약조건 확인');
console.log('-'.repeat(50));

try {
    const constraints = await query(`
        SELECT 
            tc.table_name, 
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name
    `);
    
    if (constraints.rows.length > 0) {
        console.log(`  ✅ 외래키 제약조건 ${constraints.rows.length}개 확인됨`);
        for (const constraint of constraints.rows.slice(0, 5)) {
            console.log(`     ${constraint.table_name}.${constraint.column_name} → ${constraint.foreign_table_name}.${constraint.foreign_column_name}`);
        }
        if (constraints.rows.length > 5) {
            console.log(`     ... 외 ${constraints.rows.length - 5}개`);
        }
    } else {
        console.log(`  ⚠️  외래키 제약조건이 없습니다 (스키마가 제대로 적용되지 않았을 수 있음)`);
    }
} catch (error) {
    console.log(`  ⚠️  외래키 확인 실패: ${error.message}`);
}

console.log('');

// 7. 최종 결과
console.log('='.repeat(50));
if (allChecksPassed) {
    console.log('✅ 모든 필수 조건이 충족되었습니다!');
    console.log('');
    console.log('다음 단계:');
    console.log('  npm run migrate-firestore');
    console.log('');
} else {
    console.log('❌ 일부 필수 조건이 충족되지 않았습니다.');
    console.log('');
    console.log('다음 항목을 확인하세요:');
    if (!envStatus.DATABASE_URL?.isValid) {
        console.log('  - DATABASE_URL 환경 변수 설정');
    }
    if (!envStatus.FIREBASE_PROJECT_ID?.isValid) {
        console.log('  - Firebase 환경 변수 설정');
    }
    console.log('');
}
console.log('='.repeat(50));

// 정리
const pool = getPool();
await pool.end();
process.exit(allChecksPassed ? 0 : 1);

