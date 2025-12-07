/**
 * Abuse Report API
 * Vercel Serverless Function
 * 
 * 사용자가 정책 위반 콘텐츠를 신고
 */

// Firebase Admin SDK 초기화 (서버 사이드)
let admin = null;
let firestore = null;

async function initFirebaseAdmin() {
    if (admin) {
        return; // 이미 초기화됨
    }
    
    try {
        // Firebase Admin SDK 동적 로드
        const adminModule = await import('firebase-admin');
        admin = adminModule.default;
        
        // 이미 초기화되어 있지 않으면 초기화
        if (!admin.apps.length) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
            
            if (!serviceAccount.project_id) {
                throw new Error('Firebase service account not configured');
            }
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        firestore = admin.firestore();
        console.log('[Firebase Admin] Initialized successfully');
        
    } catch (error) {
        console.error('[Firebase Admin] Initialization error:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // POST 요청만 허용
    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed. Use POST.'
        });
    }
    
    try {
        const { 
            reporterId,
            reporterName,
            targetType, // 'territory', 'pixel_art', 'user'
            targetId,
            reason, // 'inappropriate_content', 'spam', 'harassment', 'other'
            description,
            evidence // 선택적: 스크린샷 URL 등
        } = req.body;
        
        // 입력 검증
        if (!reporterId) {
            return res.status(400).json({
                success: false,
                error: 'Reporter ID is required'
            });
        }
        
        if (!targetType || !targetId) {
            return res.status(400).json({
                success: false,
                error: 'Target type and ID are required'
            });
        }
        
        const validTargetTypes = ['territory', 'pixel_art', 'user'];
        if (!validTargetTypes.includes(targetType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid target type. Must be one of: ${validTargetTypes.join(', ')}`
            });
        }
        
        const validReasons = ['inappropriate_content', 'spam', 'harassment', 'other'];
        const finalReason = reason || 'other';
        if (!validReasons.includes(finalReason)) {
            return res.status(400).json({
                success: false,
                error: `Invalid reason. Must be one of: ${validReasons.join(', ')}`
            });
        }
        
        // Firebase Admin 초기화
        await initFirebaseAdmin();
        
        // 신고 기록 저장
        const reportId = `report_${targetType}_${targetId}_${Date.now()}`;
        const report = {
            reporterId,
            reporterName: reporterName || 'Anonymous',
            targetType,
            targetId,
            reason: finalReason,
            description: description || '',
            evidence: evidence || null,
            status: 'pending', // 'pending', 'reviewed', 'resolved', 'dismissed'
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await firestore.collection('abuseReports').doc(reportId).set(report);
        
        console.log('[Abuse Report] Report submitted:', reportId);
        
        // 관리자에게 알림 (Slack - 선택적)
        if (process.env.SLACK_WEBHOOK_URL) {
            try {
                const slackUrl = `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/notifications/slack`;
                await fetch(slackUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        level: 'important',
                        title: '🚨 Abuse Report Submitted',
                        message: `New abuse report: ${targetType} ${targetId}`,
                        details: {
                            Reporter: reporterName || reporterId,
                            Reason: finalReason,
                            Description: description || 'No description'
                        }
                    })
                });
            } catch (slackError) {
                console.warn('[Abuse Report] Failed to send Slack notification:', slackError);
            }
        }
        
        return res.status(200).json({
            success: true,
            reportId,
            message: 'Report submitted successfully. We will review it soon.'
        });
        
    } catch (error) {
        console.error('[Abuse Report] Error submitting report:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

