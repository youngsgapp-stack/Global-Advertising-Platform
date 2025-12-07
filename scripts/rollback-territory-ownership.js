/**
 * Territory Ownership Rollback Script
 * 백업에서 특정 영토의 소유권 정보를 복구
 * 
 * 사용법:
 * node scripts/rollback-territory-ownership.js <backupDir> <territoryId> [--field ruler,rulerName]
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

async function rollbackTerritoryOwnership(backupDir, territoryId, fields = ['ruler', 'rulerName', 'rulerSince', 'sovereignty', 'protectionEndsAt']) {
    console.log(`\n🔄 Rolling back territory ownership: ${territoryId}`);
    console.log(`📁 Backup directory: ${backupDir}`);
    console.log(`📝 Fields to restore: ${fields.join(', ')}\n`);
    
    // 백업 파일 로드
    const backupPath = path.join(backupDir, 'territories.json');
    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const territoryBackup = backupData.find(t => t.id === territoryId);
    
    if (!territoryBackup) {
        throw new Error(`Territory ${territoryId} not found in backup`);
    }
    
    console.log(`✅ Found territory in backup:`, {
        id: territoryBackup.id,
        ruler: territoryBackup.ruler,
        rulerName: territoryBackup.rulerName
    });
    
    // 현재 상태 확인
    const territoryRef = firestore.collection('territories').doc(territoryId);
    const territoryDoc = await territoryRef.get();
    
    if (!territoryDoc.exists) {
        throw new Error(`Territory ${territoryId} not found in Firestore`);
    }
    
    const currentTerritory = territoryDoc.data();
    console.log(`\n📊 Current state:`, {
        ruler: currentTerritory.ruler,
        rulerName: currentTerritory.rulerName
    });
    
    // 복구할 데이터 준비
    const restoreData = {};
    for (const field of fields) {
        if (territoryBackup[field] !== undefined) {
            // ISO 문자열을 Timestamp로 변환
            if (field === 'rulerSince' || field === 'protectionEndsAt') {
                restoreData[field] = admin.firestore.Timestamp.fromDate(new Date(territoryBackup[field]));
            } else {
                restoreData[field] = territoryBackup[field];
            }
        }
    }
    
    restoreData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    restoreData.rollbackAt = admin.firestore.FieldValue.serverTimestamp();
    restoreData.rollbackFrom = backupDir;
    
    console.log(`\n🔄 Restoring data:`, restoreData);
    
    // 복구 실행
    await territoryRef.update(restoreData);
    
    console.log(`\n✅ Territory ownership rolled back successfully`);
    
    // 롤백 로그 저장
    const rollbackLog = {
        territoryId,
        backupDir,
        fieldsRestored: fields,
        previousState: {
            ruler: currentTerritory.ruler,
            rulerName: currentTerritory.rulerName
        },
        restoredState: {
            ruler: restoreData.ruler,
            rulerName: restoreData.rulerName
        },
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await firestore.collection('rollbackLogs').doc(`rollback_${territoryId}_${Date.now()}`).set(rollbackLog);
    
    console.log(`📝 Rollback log saved`);
    
    return rollbackLog;
}

// 실행
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: node rollback-territory-ownership.js <backupDir> <territoryId> [--field ruler,rulerName]');
    process.exit(1);
}

const backupDir = args[0];
const territoryId = args[1];
const fieldsArg = args.find(arg => arg.startsWith('--field='));
const fields = fieldsArg ? fieldsArg.split('=')[1].split(',') : ['ruler', 'rulerName', 'rulerSince', 'sovereignty', 'protectionEndsAt'];

rollbackTerritoryOwnership(backupDir, territoryId, fields)
    .then(() => {
        console.log('\n✅ Rollback completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Rollback failed:', error);
        process.exit(1);
    });

