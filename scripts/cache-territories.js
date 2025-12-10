/**
 * GitHub Actions용 영토 데이터 캐싱 스크립트
 * 
 * Firestore에서 인기 영토 데이터를 읽어서 JSON 파일로 저장
 * GitHub Pages를 통해 정적 파일로 제공
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Firebase Admin 초기화
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error('FIREBASE_SERVICE_ACCOUNT 환경 변수가 설정되지 않았습니다.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (error) {
  console.error('FIREBASE_SERVICE_ACCOUNT JSON 파싱 오류:', error);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function cacheTerritories() {
  try {
    console.log('📡 Firestore에서 영토 데이터 가져오는 중...');
    
    // 인기 영토들 캐싱 (구매 가격 기준 상위 200개)
    const territoriesSnapshot = await db.collection('territories')
      .orderBy('purchasedPrice', 'desc')
      .limit(200)
      .get();
    
    const cache = {};
    let count = 0;
    
    territoriesSnapshot.forEach(doc => {
      const data = doc.data();
      // 필요한 필드만 캐싱 (용량 절약)
      cache[doc.id] = {
        id: doc.id,
        ruler: data.ruler || null,
        rulerName: data.rulerName || null,
        sovereignty: data.sovereignty || null,
        purchasedPrice: data.purchasedPrice || null,
        protectedUntil: data.protectedUntil ? data.protectedUntil.toMillis() : null,
        country: data.country || null,
        adminLevel: data.adminLevel || null,
        hasPixelArt: data.hasPixelArt || false,
        lastActivityAt: data.lastActivityAt ? data.lastActivityAt.toMillis() : null
      };
      count++;
    });
    
    // 캐시 디렉토리 생성
    const cacheDir = path.join(__dirname, '../data/cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // JSON 파일로 저장
    const cacheFile = path.join(cacheDir, 'territories.json');
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    
    console.log(`✅ ${count}개 영토 캐싱 완료`);
    console.log(`📁 저장 위치: ${cacheFile}`);
    console.log(`📦 파일 크기: ${(fs.statSync(cacheFile).size / 1024).toFixed(2)} KB`);
    
  } catch (error) {
    console.error('❌ 캐싱 오류:', error);
    process.exit(1);
  }
}

// 실행
cacheTerritories()
  .then(() => {
    console.log('✅ 캐싱 작업 완료');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ 치명적 오류:', error);
    process.exit(1);
  });

