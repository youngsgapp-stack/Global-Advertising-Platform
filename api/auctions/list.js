/**
 * Auctions List API - Vercel Edge Function
 * 활성 경매 목록을 서버에서 읽어서 CDN 캐시 제공
 * 
 * 효과: 클라이언트 Firestore 읽기 0회, CDN 캐시 활용
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
  
  try {
    // CDN 캐시 설정 (경매 목록은 5분간 캐시)
    // 경매는 자주 변경되지 않으므로 더 긴 캐시 시간 설정
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=300, stale-while-revalidate=3600'
    );
    
    // Firestore 인스턴스 가져오기
    const firestore = await getFirestoreInstance();
    
    // 활성 경매만 조회
    // 클라이언트 SDK 사용 (Vercel Functions에서 권장)
    const { collection, query, where, getDocs } = require('firebase/firestore');
    const auctionsRef = collection(firestore, 'auctions');
    const q = query(auctionsRef, where('status', '==', 'active'));
    const querySnapshot = await getDocs(q);
    
    const auctions = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // 클라이언트에게 전달 (Firestore 읽기 감소!)
    return res.status(200).json({ 
      auctions,
      count: auctions.length,
      cached: true
    });
    
  } catch (error) {
    console.error('Error fetching auctions:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

