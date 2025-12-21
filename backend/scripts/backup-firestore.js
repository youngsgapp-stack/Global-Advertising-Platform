/**
 * Firestore 데이터 백업 스크립트
 * 
 * 사용법:
 *   node scripts/backup-firestore.js
 * 
 * 또는 Firebase CLI 직접 사용:
 *   firebase firestore:export gs://your-bucket/backup-YYYYMMDD
 */

import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Admin SDK 초기화
if (!admin.apps.length) {
    let serviceAccountData = null;
    
    // 1. 서비스 계정 키 파일에서 직접 읽기 (우선순위 1)
    const serviceAccountFiles = [
        path.join(__dirname, '../../FIREBASE_SERVICE_ACCOUNT_ONELINE.txt'),
        path.join(__dirname, '../../firebase-service-account.json'),
        path.join(__dirname, '../../service-account.json'),
    ];
    
    for (const filePath of serviceAccountFiles) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8').trim();
                console.log(`  🔍 파일 확인 중: ${filePath}`);
                
                // JSON 파싱 시도
                try {
                    // 전체 내용이 JSON인 경우
                    serviceAccountData = JSON.parse(content);
                    console.log(`  ✅ 서비스 계정 키 파일에서 JSON 파싱 성공`);
                    break;
                } catch (parseError) {
                    // JSON이 아니면 각 라인을 확인
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('{') && trimmed.includes('project_id')) {
                            try {
                                serviceAccountData = JSON.parse(trimmed);
                                console.log(`  ✅ 서비스 계정 정보 발견 (라인에서 파싱)`);
                                break;
                            } catch (e) {
                                // 이 라인은 JSON이 아님, 다음 라인 시도
                            }
                        }
                    }
                    if (serviceAccountData) break;
                }
            }
        } catch (error) {
            console.log(`  ⚠️  파일 읽기 실패: ${filePath} - ${error.message}`);
        }
    }
    
    // 2. 환경 변수에서 읽기 시도 (우선순위 2)
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
            console.log(`  ✅ 환경 변수에서 인증 정보 로드`);
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
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: serviceAccountData.project_id,
                privateKey: serviceAccountData.private_key,
                clientEmail: serviceAccountData.client_email,
            }),
        });
        console.log(`✅ Firebase Admin SDK 초기화 완료 (프로젝트: ${serviceAccountData.project_id})`);
        console.log(`   서비스 계정: ${serviceAccountData.client_email}\n`);
    } catch (error) {
        console.error('\n❌ Firebase Admin SDK 초기화 실패:', error.message);
        console.error('   서비스 계정 키 파일 형식을 확인하세요.');
        process.exit(1);
    }
}

const db = admin.firestore();

// 백업 디렉토리 생성
const backupDir = path.join(__dirname, '../../backups');
if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

// 날짜 기반 백업 파일명
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                  new Date().toISOString().replace(/[:.]/g, '-').split('T')[1].split('.')[0];
const backupFile = path.join(backupDir, `firestore-backup-${timestamp}.json`);

console.log('📦 Firestore 데이터 백업 시작...\n');
console.log(`백업 파일: ${backupFile}\n`);

/**
 * 지연 함수
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 컬렉션 백업 (배치 처리 및 재시도 포함)
 */
async function backupCollection(collectionName) {
    console.log(`  📂 ${collectionName} 컬렉션 백업 중...`);
    
    const data = [];
    let lastDoc = null;
    const batchSize = 100; // 한 번에 100개씩
    let retryCount = 0;
    const maxRetries = 5;
    
    try {
        while (true) {
            try {
                let query = db.collection(collectionName).limit(batchSize);
                
                if (lastDoc) {
                    query = query.startAfter(lastDoc);
                }
                
                const snapshot = await query.get();
                
                if (snapshot.empty) {
                    break; // 더 이상 문서가 없음
                }
                
                snapshot.forEach((doc) => {
                    const docData = doc.data();
                    const serializedData = serializeFirestoreData(docData);
                    
                    data.push({
                        id: doc.id,
                        data: serializedData
                    });
                    
                    lastDoc = doc;
                });
                
                console.log(`    📄 ${collectionName}: ${data.length}개 문서 백업 중...`);
                
                // 할당량 제한을 피하기 위해 대기
                await delay(1000); // 1초 대기
                
                // 다음 배치가 있는지 확인
                if (snapshot.size < batchSize) {
                    break; // 마지막 배치
                }
                
                retryCount = 0; // 성공하면 재시도 카운터 리셋
                
            } catch (error) {
                if (error.code === 8 && error.message.includes('RESOURCE_EXHAUSTED')) {
                    // 할당량 초과 - 재시도
                    retryCount++;
                    if (retryCount > maxRetries) {
                        console.error(`  ⚠️  ${collectionName}: 할당량 초과로 중단 (${data.length}개 문서 백업됨)`);
                        console.error(`     Firebase 무료 티어 제한에 걸렸습니다.`);
                        console.error(`     잠시 후 다시 시도하거나 Firebase CLI를 사용하세요.`);
                        return { collection: collectionName, documents: data, error: 'Quota exceeded (partial backup)', partial: true };
                    }
                    
                    const waitTime = Math.pow(2, retryCount) * 1000; // 지수 백오프: 2초, 4초, 8초...
                    console.log(`    ⏳ 할당량 초과 감지. ${waitTime/1000}초 대기 후 재시도... (${retryCount}/${maxRetries})`);
                    await delay(waitTime);
                } else {
                    throw error; // 다른 오류는 그대로 던지기
                }
            }
        }
        
        console.log(`  ✅ ${collectionName}: ${data.length}개 문서 백업 완료`);
        return { collection: collectionName, documents: data };
        
    } catch (error) {
        console.error(`  ❌ ${collectionName} 백업 실패:`, error.message);
        return { collection: collectionName, documents: data, error: error.message, partial: data.length > 0 };
    }
}

/**
 * Firestore 데이터를 JSON 직렬화 가능한 형태로 변환
 */
function serializeFirestoreData(data) {
    if (data === null || data === undefined) {
        return data;
    }
    
    if (data instanceof admin.firestore.Timestamp) {
        return {
            _firestore_timestamp: true,
            seconds: data.seconds,
            nanoseconds: data.nanoseconds
        };
    }
    
    if (data instanceof admin.firestore.GeoPoint) {
        return {
            _firestore_geopoint: true,
            latitude: data.latitude,
            longitude: data.longitude
        };
    }
    
    if (data instanceof admin.firestore.DocumentReference) {
        return {
            _firestore_reference: true,
            path: data.path
        };
    }
    
    if (Array.isArray(data)) {
        return data.map(item => serializeFirestoreData(item));
    }
    
    if (typeof data === 'object') {
        const serialized = {};
        for (const [key, value] of Object.entries(data)) {
            serialized[key] = serializeFirestoreData(value);
        }
        return serialized;
    }
    
    return data;
}

/**
 * 서브컬렉션 백업 (예: auctions/{id}/bids)
 */
async function backupSubcollections(collectionName, docId) {
    const subcollections = ['bids', 'votes', 'comments']; // 필요한 서브컬렉션 목록
    const results = {};
    
    for (const subcollectionName of subcollections) {
        try {
            const snapshot = await db.collection(collectionName)
                .doc(docId)
                .collection(subcollectionName)
                .get();
            
            if (!snapshot.empty) {
                const data = [];
                snapshot.forEach((doc) => {
                    data.push({
                        id: doc.id,
                        data: serializeFirestoreData(doc.data())
                    });
                });
                results[subcollectionName] = data;
            }
        } catch (error) {
            // 서브컬렉션이 없을 수도 있음
        }
    }
    
    return Object.keys(results).length > 0 ? results : null;
}

/**
 * 메인 백업 함수
 */
async function backupFirestore() {
    const collections = [
        'users',
        'territories',
        'auctions',
        'bids',
        'wallets',
        'ownerships',
        'pixelCanvases',
        'rankings',
        'contests',
        'seasons'
    ];
    
    const backupData = {
        metadata: {
            projectId: process.env.FIREBASE_PROJECT_ID,
            backupDate: new Date().toISOString(),
            timestamp: timestamp,
            collections: []
        },
        data: {}
    };
    
    // 각 컬렉션 백업
    for (const collectionName of collections) {
        const result = await backupCollection(collectionName);
        backupData.metadata.collections.push({
            name: collectionName,
            documentCount: result.documents.length,
            hasError: !!result.error
        });
        
        if (result.documents.length > 0 || result.error) {
            backupData.data[collectionName] = result;
        }
        
        // 특정 컬렉션의 서브컬렉션도 백업
        if (collectionName === 'auctions' && result.documents.length > 0) {
            console.log(`  📂 ${collectionName} 서브컬렉션 백업 중...`);
            for (const doc of result.documents.slice(0, 10)) { // 샘플로 10개만
                const subcollections = await backupSubcollections(collectionName, doc.id);
                if (subcollections) {
                    if (!backupData.data[collectionName].subcollections) {
                        backupData.data[collectionName].subcollections = {};
                    }
                    backupData.data[collectionName].subcollections[doc.id] = subcollections;
                }
            }
        }
    }
    
    // 백업 데이터를 JSON 파일로 저장
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), 'utf8');
    
    // 파일 크기 확인
    const stats = fs.statSync(backupFile);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ 백업 완료!');
    console.log('='.repeat(50));
    console.log(`백업 파일: ${backupFile}`);
    console.log(`파일 크기: ${fileSizeInMB} MB`);
    console.log(`총 컬렉션 수: ${backupData.metadata.collections.length}`);
    console.log(`총 문서 수: ${backupData.metadata.collections.reduce((sum, col) => sum + col.documentCount, 0)}`);
    console.log('\n백업 통계:');
    for (const col of backupData.metadata.collections) {
        if (col.documentCount > 0 || col.hasError) {
            console.log(`  ${col.name}: ${col.documentCount}개 문서${col.hasError ? ' (오류 있음)' : ''}`);
        }
    }
    console.log('='.repeat(50));
    
    return backupFile;
}

// 백업 실행
backupFirestore()
    .then((backupFile) => {
        console.log(`\n💾 백업이 성공적으로 완료되었습니다: ${backupFile}`);
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ 백업 실패:', error);
        process.exit(1);
    });

