/**
 * Territory API - Vercel Edge Function
 * 클라이언트가 직접 Firestore를 읽는 대신, 서버를 통해 읽어서 캐싱 제공
 * 
 * 효과: 클라이언트 Firestore 읽기 0회, 서버 캐시 활용
 */

// Firebase 설정 (환경 변수에서 로드, 없으면 config.js 값 사용)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'AIzaSyAa0BTlcqX9T1PYaHTiv3CmjmZ6srmdZVY',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'worldad-8be07.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'worldad-8be07',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'worldad-8be07.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '460480155784',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '1:460480155784:web:68e6cea86cf492b3b64f3d'
};

// Firebase 초기화 (서버 사이드에서만 실행)
let db = null;
let app = null;

async function getFirestoreInstance() {
  if (db) return db;
  
  // Vercel Functions에서는 클라이언트 SDK 사용 (간단하고 효과적)
  const { initializeApp } = require('firebase/app');
  const { getFirestore } = require('firebase/firestore');
  
  if (!app) {
    app = initializeApp(firebaseConfig);
  }
  db = getFirestore(app);
  
  return db;
}

// Vercel Serverless Function 형식
module.exports = async (req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // URL에서 id 추출: /api/territories/texas → id = 'texas'
  const id = req.query.id || req.url.split('/').pop();
  
  if (!id) {
    return res.status(400).json({ error: 'Territory ID is required' });
  }
  
  try {
    // CDN 캐시 설정
    // public: CDN에서 캐시 가능
    // s-maxage=60: CDN에서 60초간 캐시
    // stale-while-revalidate=300: 캐시 만료 후 300초간 stale 데이터 제공하면서 백그라운드에서 재검증
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=60, stale-while-revalidate=300'
    );
    
    // Firestore 인스턴스 가져오기
    const firestore = await getFirestoreInstance();
    
    // Firestore에서 읽기 (서버에서만 발생)
    let territorySnap;
    try {
      // Admin SDK인 경우
      if (firestore.collection) {
        territorySnap = await firestore.collection('territories').doc(id).get();
      } else {
        // 클라이언트 SDK인 경우
        const { doc, getDoc } = require('firebase/firestore');
        const territoryRef = doc(firestore, 'territories', id);
        territorySnap = await getDoc(territoryRef);
      }
    } catch (error) {
      console.error('Firestore read error:', error);
      throw error;
    }
    
    // Admin SDK와 클라이언트 SDK의 차이 처리
    const exists = territorySnap.exists || (territorySnap.exists !== false && territorySnap.data);
    if (!exists) {
      return res.status(404).json({ error: 'Territory not found' });
    }
    
    const territory = {
      id: territorySnap.id || id,
      ...(territorySnap.data ? territorySnap.data() : territorySnap.data)
    };
    
    // 클라이언트에게 전달 (Firestore 읽기 0회!)
    return res.status(200).json(territory);
    
  } catch (error) {
    console.error('Error fetching territory:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

