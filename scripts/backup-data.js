/**
 * Data Backup Script
 * Firestore 데이터를 JSON/CSV로 백업
 * 
 * 사용법:
 * node scripts/backup-data.js [--collections territories,wallets,payments,auctions,rankings]
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Firebase Service Account 로드
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 
    path.join(__dirname, '..', 'FIREBASE_SERVICE_ACCOUNT_ONELINE.txt');

let serviceAccount;
try {
    const serviceAccountText = fs.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(serviceAccountText);
} catch (error) {
    console.error('Failed to load Firebase service account:', error);
    process.exit(1);
}

// Firebase 초기화
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const firestore = admin.firestore();

// 기본 백업 대상 컬렉션
const DEFAULT_COLLECTIONS = [
    'territories',
    'wallets',
    'payments',
    'auctions',
    'rankings',
    'territoryOwnershipLogs'
];

async function backupCollection(collectionName) {
    console.log(`\n📦 Backing up collection: ${collectionName}...`);
    
    try {
        const snapshot = await firestore.collection(collectionName).get();
        const data = [];
        
        snapshot.forEach(doc => {
            const docData = doc.data();
            // Firestore Timestamp를 ISO 문자열로 변환
            const processedData = processTimestamps(docData);
            data.push({
                id: doc.id,
                ...processedData
            });
        });
        
        console.log(`✅ Backed up ${data.length} documents from ${collectionName}`);
        
        return data;
        
    } catch (error) {
        console.error(`❌ Failed to backup ${collectionName}:`, error);
        return [];
    }
}

// Firestore Timestamp를 처리
function processTimestamps(obj) {
    if (obj === null || obj === undefined) {
        return obj;
    }
    
    if (obj.constructor && obj.constructor.name === 'Timestamp') {
        return obj.toDate().toISOString();
    }
    
    if (Array.isArray(obj)) {
        return obj.map(item => processTimestamps(item));
    }
    
    if (typeof obj === 'object') {
        const processed = {};
        for (const key in obj) {
            processed[key] = processTimestamps(obj[key]);
        }
        return processed;
    }
    
    return obj;
}

async function backupData(collections = DEFAULT_COLLECTIONS) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'backups', timestamp);
    
    // 백업 디렉토리 생성
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    console.log(`\n🚀 Starting backup at ${new Date().toISOString()}`);
    console.log(`📁 Backup directory: ${backupDir}\n`);
    
    const backupResults = {};
    
    for (const collectionName of collections) {
        const data = await backupCollection(collectionName);
        
        if (data.length > 0) {
            // JSON 파일로 저장
            const jsonPath = path.join(backupDir, `${collectionName}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            
            backupResults[collectionName] = {
                count: data.length,
                jsonPath: jsonPath
            };
        }
    }
    
    // 백업 메타데이터 저장
    const metadata = {
        timestamp: new Date().toISOString(),
        collections: Object.keys(backupResults),
        counts: Object.fromEntries(
            Object.entries(backupResults).map(([key, value]) => [key, value.count])
        )
    };
    
    const metadataPath = path.join(backupDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    
    console.log('\n📊 Backup Summary:');
    console.log(JSON.stringify(metadata, null, 2));
    console.log(`\n✅ Backup completed: ${backupDir}`);
    
    return {
        backupDir,
        metadata
    };
}

// 실행
const collectionsArg = process.argv.find(arg => arg.startsWith('--collections='));
const collections = collectionsArg 
    ? collectionsArg.split('=')[1].split(',')
    : DEFAULT_COLLECTIONS;

backupData(collections)
    .then(() => {
        console.log('\n✅ Backup process completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Backup failed:', error);
        process.exit(1);
    });

