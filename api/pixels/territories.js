/**
 * Pixels Territories API - Vercel Serverless Function
 * 픽셀 데이터가 있는 영토 목록 조회 (공개 API)
 * 백엔드 API로 프록시
 */

// 백엔드 API URL (환경 변수에서 로드)
const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:3001';

// Vercel Serverless Function 형식
module.exports = async (req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // 백엔드 API로 프록시
    const backendUrl = `${BACKEND_API_URL}/api/pixels/territories`;
    
    // 백엔드 API 호출 (공개 API이므로 인증 토큰 전달 불필요)
    const response = await fetch(backendUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // 선택적: 인증 토큰이 있으면 전달 (백엔드에서 optionalAuthenticateToken 사용)
        ...(req.headers.authorization && { 'Authorization': req.headers.authorization })
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Backend API error' }));
      return res.status(response.status).json(errorData);
    }
    
    const data = await response.json();
    
    // CDN 캐시 설정 (메타데이터는 5분 캐시)
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=300, stale-while-revalidate=600'
    );
    
    return res.status(200).json(data);
    
  } catch (error) {
    console.error('[Pixels Territories API] Error fetching from backend:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};

