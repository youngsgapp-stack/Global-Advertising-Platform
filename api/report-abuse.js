/**
 * 어뷰징 리포트 API
 * 
 * 사용자가 정책 위반 콘텐츠를 신고할 수 있습니다.
 * - 랜드/픽셀 정책 위반 신고
 * - 관리자가 나중에 리뷰 및 처리
 */

import admin from 'firebase-admin';

// Firebase Admin 초기화
let adminInitialized = false;

function initializeAdmin() {
    if (adminInitialized) return;
    
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
        
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        adminInitialized = true;
    } catch (error) {
        console.error('[Report Abuse] Failed to initialize Firebase Admin:', error);
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
        initializeAdmin();
        
        const { 
            territoryId,
            pixelCanvasId,
            userId,
            userName,
            reportType,
            description,
            screenshotUrl
        } = req.body;
        
        // 필수 파라미터 검증
        if (!territoryId && !pixelCanvasId) {
            return res.status(400).json({
                success: false,
                error: 'Either territoryId or pixelCanvasId is required'
            });
        }
        
        if (!userId || !reportType) {
            return res.status(400).json({
                success: false,
                error: 'userId and reportType are required'
            });
        }
        
        const validReportTypes = [
            'inappropriate_content',
            'copyright_violation',
            'spam',
            'harassment',
            'other'
        ];
        
        if (!validReportTypes.includes(reportType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid reportType. Must be one of: ${validReportTypes.join(', ')}`
            });
        }
        
        const db = admin.firestore();
        
        // 리포트 저장
        const reportId = `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const report = {
            id: reportId,
            territoryId: territoryId || null,
            pixelCanvasId: pixelCanvasId || null,
            reportedBy: userId,
            reportedByName: userName || 'Anonymous',
            reportType,
            description: description || '',
            screenshotUrl: screenshotUrl || null,
            status: 'pending', // pending, reviewed, resolved, dismissed
            reviewedBy: null,
            reviewedAt: null,
            resolution: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('abuse_reports').doc(reportId).set(report);
        
        // Slack 알림 (선택적)
        const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
        if (slackWebhookUrl) {
            try {
                await fetch(slackWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: `⚠️ Abuse Report: ${reportType}`,
                        attachments: [{
                            color: '#ffc107',
                            fields: [
                                { title: 'Report ID', value: reportId, short: true },
                                { title: 'Type', value: reportType, short: true },
                                { title: 'Territory ID', value: territoryId || 'N/A', short: true },
                                { title: 'Reported By', value: userName || userId, short: true },
                                { title: 'Description', value: description || 'No description', short: false }
                            ]
                        }]
                    })
                });
            } catch (slackError) {
                console.warn('[Report Abuse] Failed to send Slack notification:', slackError);
            }
        }
        
        return res.status(200).json({
            success: true,
            reportId,
            message: 'Report submitted successfully. We will review it soon.'
        });
        
    } catch (error) {
        console.error('[Report Abuse] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

