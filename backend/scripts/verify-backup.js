/**
 * Firestore 백업 파일 검증 스크립트
 * 
 * 사용법:
 *   node scripts/verify-backup.js [백업파일경로]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 백업 파일 경로
const backupFile = process.argv[2] || 
    path.join(__dirname, '../../backups/firestore-backup-2025-12-11_00-23-14-530Z.json');

console.log('🔍 Firestore 백업 파일 검증 시작...\n');
console.log(`📁 백업 파일: ${backupFile}\n`);

// 1. 파일 존재 확인
if (!fs.existsSync(backupFile)) {
    console.error(`❌ 백업 파일을 찾을 수 없습니다: ${backupFile}`);
    process.exit(1);
}

// 2. 파일 크기 확인
const stats = fs.statSync(backupFile);
const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
console.log(`📊 파일 크기: ${fileSizeMB} MB (${stats.size.toLocaleString()} bytes)`);

// 3. JSON 파싱 및 구조 확인
let backupData;
try {
    console.log('\n📖 JSON 파일 파싱 중...');
    const fileContent = fs.readFileSync(backupFile, 'utf8');
    backupData = JSON.parse(fileContent);
    console.log('✅ JSON 파싱 성공\n');
} catch (error) {
    console.error(`❌ JSON 파싱 실패: ${error.message}`);
    process.exit(1);
}

// 4. 백업 데이터 구조 확인
console.log('📋 백업 데이터 구조 확인:\n');

// 백업 파일 구조 확인 (metadata + collections)
let collections = {};
let metadata = {};

if (backupData.metadata) {
    metadata = backupData.metadata;
    console.log(`📋 프로젝트 ID: ${metadata.projectId || 'N/A'}`);
    console.log(`📅 백업 일시: ${metadata.backupDate || metadata.timestamp || 'N/A'}\n`);
}

// 백업 파일 구조 확인: data 객체에 실제 데이터가 있음
if (backupData.data && typeof backupData.data === 'object') {
    // data 객체에서 컬렉션 추출
    for (const [key, value] of Object.entries(backupData.data)) {
        if (value && typeof value === 'object' && value.documents) {
            collections[key] = { documents: value.documents };
        } else if (Array.isArray(value)) {
            collections[key] = { documents: value };
        }
    }
} else if (backupData.collections && typeof backupData.collections === 'object') {
    collections = backupData.collections;
} else if (Array.isArray(backupData.collections)) {
    // 배열 형태인 경우
    for (const col of backupData.collections) {
        if (col.name && col.data) {
            collections[col.name] = { documents: col.data };
        }
    }
} else if (backupData.metadata && backupData.metadata.collections) {
    // metadata 안에 collections가 있는 경우
    const metadataCollections = backupData.metadata.collections;
    for (const colMeta of metadataCollections) {
        if (colMeta.name) {
            // 실제 데이터는 data 객체 안에 있을 수 있음
            const collectionName = colMeta.name;
            if (backupData.data && backupData.data[collectionName]) {
                const colData = backupData.data[collectionName];
                collections[collectionName] = { 
                    documents: colData.documents || colData || [],
                    metadata: colMeta 
                };
            } else if (backupData[collectionName]) {
                collections[collectionName] = { documents: backupData[collectionName] };
            } else {
                collections[collectionName] = { documents: [], metadata: colMeta };
            }
        }
    }
}

// 루트 레벨에서 컬렉션 찾기 (data가 없는 경우)
if (Object.keys(collections).length === 0) {
    const collectionNames = Object.keys(backupData).filter(key => 
        key !== 'metadata' && key !== 'data' &&
        Array.isArray(backupData[key]) && 
        backupData[key].length > 0 &&
        typeof backupData[key][0] === 'object'
    );

    if (collectionNames.length > 0) {
        for (const colName of collectionNames) {
            collections[colName] = { documents: backupData[colName] };
        }
    }
}

const allCollectionNames = Object.keys(collections);

console.log(`📦 총 컬렉션 수: ${allCollectionNames.length}`);
console.log(`📄 컬렉션 목록: ${allCollectionNames.join(', ')}\n`);

// 5. 각 컬렉션별 문서 수 및 샘플 데이터 확인
let totalDocuments = 0;
const collectionStats = {};

for (const collectionName of allCollectionNames) {
    const collection = collections[collectionName];
    const documents = Array.isArray(collection.documents) ? collection.documents : [];
    const docCount = documents.length;
    totalDocuments += docCount;
    
    collectionStats[collectionName] = {
        count: docCount,
        sample: documents[0] || null,
        metadata: collection.metadata
    };
    
    console.log(`📂 ${collectionName}:`);
    console.log(`   문서 수: ${docCount.toLocaleString()}개`);
    
    if (documents.length > 0) {
        const firstDoc = documents[0];
        let docId = 'N/A';
        let fields = 0;
        
        if (firstDoc.id) {
            docId = firstDoc.id;
            fields = firstDoc.data ? Object.keys(firstDoc.data).length : 0;
        } else if (firstDoc.name) {
            docId = firstDoc.name.split('/').pop();
            fields = firstDoc.fields ? Object.keys(firstDoc.fields).length : 0;
        } else if (typeof firstDoc === 'object') {
            docId = Object.keys(firstDoc)[0] || 'N/A';
            const docData = firstDoc[docId] || firstDoc;
            fields = typeof docData === 'object' ? Object.keys(docData).length : 0;
        }
        
        console.log(`   샘플 문서 ID: ${docId}`);
        console.log(`   필드 수: ${fields}개`);
        
        // 주요 필드 확인
        let mainFields = [];
        if (firstDoc.data) {
            mainFields = Object.keys(firstDoc.data).slice(0, 5);
        } else if (firstDoc.fields) {
            mainFields = Object.keys(firstDoc.fields).slice(0, 5);
        } else if (typeof firstDoc === 'object') {
            const docData = firstDoc[docId] || firstDoc;
            if (typeof docData === 'object') {
                mainFields = Object.keys(docData).slice(0, 5);
            }
        }
        
        if (mainFields.length > 0) {
            console.log(`   주요 필드: ${mainFields.join(', ')}${mainFields.length < fields ? '...' : ''}`);
        }
    }
    console.log('');
}

console.log('='.repeat(60));
console.log(`📊 총 문서 수: ${totalDocuments.toLocaleString()}개`);
console.log('='.repeat(60));

// 6. 주요 컬렉션 상세 검증
console.log('\n🔍 주요 컬렉션 상세 검증:\n');

const keyCollections = ['users', 'territories', 'auctions', 'wallets', 'bids', 'ownerships'];

for (const colName of keyCollections) {
    if (collectionStats[colName]) {
        const stats = collectionStats[colName];
        console.log(`✅ ${colName}: ${stats.count}개 문서`);
        
        if (stats.sample && stats.sample.fields) {
            // 필수 필드 확인
            const requiredFields = {
                users: ['uid', 'email', 'nickname'],
                territories: ['code', 'name', 'polygon'],
                auctions: ['territoryId', 'status', 'startTime'],
                wallets: ['userId', 'balance'],
                bids: ['auctionId', 'userId', 'amount'],
                ownerships: ['territoryId', 'userId']
            };
            
            const fields = Object.keys(stats.sample.fields);
            const required = requiredFields[colName] || [];
            const missing = required.filter(f => !fields.includes(f));
            
            if (missing.length === 0) {
                console.log(`   ✅ 필수 필드 확인 완료`);
            } else {
                console.log(`   ⚠️  누락된 필드: ${missing.join(', ')}`);
            }
        }
    } else {
        console.log(`⚠️  ${colName}: 컬렉션 없음`);
    }
}

// 7. 데이터 무결성 검증
console.log('\n🔒 데이터 무결성 검증:\n');

let integrityIssues = [];

// 빈 컬렉션 확인
for (const colName of keyCollections) {
    if (collectionStats[colName] && collectionStats[colName].count === 0) {
        integrityIssues.push(`${colName} 컬렉션이 비어있습니다`);
    }
}

// territories가 가장 많아야 함 (맵 데이터)
if (collectionStats.territories && collectionStats.users) {
    if (collectionStats.territories.count < collectionStats.users.count) {
        integrityIssues.push('경고: territories 문서 수가 users보다 적습니다');
    }
}

if (integrityIssues.length === 0) {
    console.log('✅ 데이터 무결성 검증 통과');
} else {
    console.log('⚠️  데이터 무결성 문제:');
    integrityIssues.forEach(issue => console.log(`   - ${issue}`));
}

// 8. 백업 완료 요약
console.log('\n' + '='.repeat(60));
console.log('✅ 백업 파일 검증 완료');
console.log('='.repeat(60));
console.log(`📁 파일: ${path.basename(backupFile)}`);
console.log(`📊 크기: ${fileSizeMB} MB`);
console.log(`📦 컬렉션: ${allCollectionNames.length}개`);
console.log(`📄 문서: ${totalDocuments.toLocaleString()}개`);
console.log('='.repeat(60));

process.exit(0);

