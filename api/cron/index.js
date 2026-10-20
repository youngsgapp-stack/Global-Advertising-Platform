/**
 * 통합 Cron Job
 * Vercel Cron Job
 * 
 * ⚠️ 마이그레이션 완료: Firestore 비활성화, 백엔드 API로 리다이렉트
 * 
 * 모든 cron 작업을 하나의 함수로 통합하여 Serverless Functions 개수를 줄입니다.
 * - 랭킹 계산
 * - 만료된 영토 확인
 * - 경매 종료 처리
 * - 시즌 전환
 */

// ⚠️ Firestore Admin SDK 제거 (번들 크기 감소 및 Firestore 호출 완전 차단)
// import admin from 'firebase-admin'; // 제거됨

// Vercel Serverless Function 형식 (CommonJS)
module.exports = async function handler(req, res) {
    // Cron Job 인증
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }
    
    // ⚠️ 마이그레이션 완료: Firestore 비활성화, 백엔드 API로 리다이렉트
    const BACKEND_API_URL = process.env.BACKEND_API_URL || 'https://global-advertising-platform-production.up.railway.app';
    const jobType = (req.query && req.query.job) || (req.body && req.body.job) || 'all';
    const backendUrl = `${BACKEND_API_URL}/api/cron?job=${encodeURIComponent(jobType)}`;
    
    try {
        
        // ⚠️ 로그 추가: Vercel Cron Job 실행 확인용
        console.log(`[Cron] ⚡ Vercel Cron Job triggered: job=${jobType}, time=${new Date().toISOString()}`);
        console.log(`[Cron] 🔄 Redirecting to backend API: ${backendUrl}`);
        
        const startTime = Date.now();
        
        // 타임아웃 설정 (30초)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        try {
            const response = await fetch(backendUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(req.headers.authorization && { 'Authorization': req.headers.authorization }),
                    ...(cronSecret && { 'X-Cron-Secret': cronSecret })
                },
                body: JSON.stringify(req.body || {}),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            const duration = Date.now() - startTime;
        
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Backend API error' }));
                console.error(`[Cron] ❌ Backend API error (${response.status}):`, errorData);
                return res.status(response.status).json(errorData);
            }
            
            const result = await response.json();
            console.log(`[Cron] ✅ Backend API success: duration=${duration}ms, result=`, result);
            
            return res.status(200).json({
                success: true,
                jobType,
                backendUrl,
                duration: `${duration}ms`,
                timestamp: new Date().toISOString(),
                result
            });
            
        } catch (fetchError) {
            clearTimeout(timeoutId);
            const duration = Date.now() - startTime;
            
            if (fetchError.name === 'AbortError') {
                console.error(`[Cron] ❌ Backend API timeout after ${duration}ms`);
                return res.status(504).json({
                    success: false,
                    error: 'Backend API timeout',
                    message: 'Backend API did not respond within 30 seconds',
                    duration: `${duration}ms`
                });
            }
            
            throw fetchError; // 다른 에러는 상위 catch로 전달
        }
        
    } catch (error) {
        console.error('[Cron] ❌ Error redirecting to backend API:', error);
        console.error('[Cron] Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause
        });
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error',
            message: 'Failed to redirect to backend API. Please check BACKEND_API_URL environment variable and backend server status.',
            backendUrl
        });
    }
}
