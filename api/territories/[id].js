/**
 * Territory API - Vercel Edge Function
 * ⚠️ 마이그레이션 완료: Firestore 비활성화, 백엔드 API로 리다이렉트
 * 
 * 이제 백엔드 API (PostgreSQL + Redis)를 사용하므로 Firestore 읽기를 완전히 제거했습니다.
 */

// 백엔드 API URL (환경 변수에서 로드)
const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:3001';

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
    // ⚠️ Firestore 읽기 제거: 백엔드 API로 리다이렉트
    const backendUrl = `${BACKEND_API_URL}/api/territories/${id}`;
    
    // 백엔드 API 호출
    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // 인증 토큰이 있으면 전달
        ...(req.headers.authorization && { 'Authorization': req.headers.authorization })
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Backend API error' }));
      return res.status(response.status).json(errorData);
    }
    
    const territory = await response.json();
    
    // CDN 캐시 설정
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=60, stale-while-revalidate=300'
    );
    
    return res.status(200).json(territory);
    
  } catch (error) {
    console.error('Error fetching territory from backend:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

