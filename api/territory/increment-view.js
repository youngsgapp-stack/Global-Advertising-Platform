/**
 * Territory View Count Increment API
 * 영토 조회수 증가를 서버 사이드에서 처리
 * 
 * 전문가 조언: viewCount를 클라이언트에서 직접 업데이트하는 것은 보안상 위험하므로
 * 서버 사이드에서 처리하여 rate limiting 및 스팸 방지 가능
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Firebase Admin SDK 초기화 (이미 초기화되어 있으면 재사용)
let db;
try {
  if (!global.firebaseAdminApp) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    
    if (!serviceAccount.project_id) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT 환경 변수가 설정되지 않았습니다.');
    }
    
    global.firebaseAdminApp = initializeApp({
      credential: cert(serviceAccount)
    });
  }
  
  db = getFirestore(global.firebaseAdminApp);
} catch (error) {
  console.error('Firebase Admin 초기화 실패:', error);
}

/**
 * Rate limiting을 위한 간단한 메모리 캐시
 * 프로덕션에서는 Redis 등을 사용하는 것을 권장
 */
const rateLimitCache = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1분
const RATE_LIMIT_MAX_REQUESTS = 10; // 1분당 최대 10회

function checkRateLimit(identifier) {
  const now = Date.now();
  const key = identifier;
  
  if (!rateLimitCache.has(key)) {
    rateLimitCache.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  const record = rateLimitCache.get(key);
  
  if (now > record.resetAt) {
    // 윈도우가 지났으므로 리셋
    rateLimitCache.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  record.count++;
  return true;
}

export default async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { territoryId } = req.body;
    
    if (!territoryId || typeof territoryId !== 'string') {
      return res.status(400).json({ error: 'territoryId is required' });
    }
    
    // Rate limiting 체크
    // IP 주소 또는 User-Agent를 식별자로 사용
    const identifier = req.headers['x-forwarded-for'] || 
                      req.headers['x-real-ip'] || 
                      req.connection.remoteAddress || 
                      'unknown';
    
    if (!checkRateLimit(identifier)) {
      return res.status(429).json({ 
        error: 'Too many requests',
        message: '조회수 업데이트는 1분당 최대 10회까지 가능합니다.'
      });
    }
    
    if (!db) {
      throw new Error('Firebase Admin이 초기화되지 않았습니다.');
    }
    
    // Firestore에서 영토 문서 참조
    const territoryRef = db.collection('territories').doc(territoryId);
    
    // Atomic increment 사용 (race condition 방지)
    await territoryRef.update({
      viewCount: FieldValue.increment(1),
      lastViewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    
    // 업데이트된 문서 가져오기 (선택사항)
    const doc = await territoryRef.get();
    const updatedData = doc.data();
    
    return res.status(200).json({
      success: true,
      territoryId,
      viewCount: updatedData.viewCount || 0,
      message: '조회수가 성공적으로 증가했습니다.'
    });
    
  } catch (error) {
    console.error('[increment-view] Error:', error);
    
    // Firebase 관련 오류 처리
    if (error.code === 'permission-denied') {
      return res.status(403).json({ 
        error: 'Permission denied',
        message: '조회수 업데이트 권한이 없습니다.'
      });
    }
    
    if (error.code === 'not-found') {
      return res.status(404).json({ 
        error: 'Territory not found',
        message: '해당 영토를 찾을 수 없습니다.'
      });
    }
    
    return res.status(500).json({ 
      error: 'Internal server error',
      message: '조회수 업데이트 중 오류가 발생했습니다.'
    });
  }
}

