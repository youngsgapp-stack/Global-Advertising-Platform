/**
 * Slack 알림 API
 * 
 * 중요 이벤트 발생 시 Slack 채널에 알림을 전송합니다.
 * - Firestore 쿼터 초과
 * - 에러율 증가
 * - 경매 종료, 결제 완료 등 중요 이벤트
 */

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
            type, 
            message, 
            priority = 'info',
            data = {}
        } = req.body;
        
        // Slack Webhook URL (선택적 - 없으면 로그만)
        const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
        
        if (!slackWebhookUrl) {
            // Slack Webhook이 없으면 콘솔 로그만
            console.log(`[Slack Notification] ${priority.toUpperCase()}: ${type} - ${message}`, data);
            return res.status(200).json({
                success: true,
                message: 'Notification logged (Slack webhook not configured)'
            });
        }
        
        // Slack 메시지 포맷
        const colorMap = {
            'urgent': '#dc3545',    // 빨간색
            'important': '#ffc107',  // 노란색
            'info': '#17a2b8'        // 파란색
        };
        
        const emojiMap = {
            'urgent': '🚨',
            'important': '⚠️',
            'info': 'ℹ️'
        };
        
        const slackMessage = {
            text: `${emojiMap[priority] || 'ℹ️'} ${type}: ${message}`,
            attachments: [
                {
                    color: colorMap[priority] || colorMap.info,
                    fields: [
                        {
                            title: 'Type',
                            value: type,
                            short: true
                        },
                        {
                            title: 'Priority',
                            value: priority,
                            short: true
                        },
                        {
                            title: 'Timestamp',
                            value: new Date().toISOString(),
                            short: true
                        }
                    ],
                    ...(Object.keys(data).length > 0 && {
                        fields: [
                            ...(data.fields || []),
                            {
                                title: 'Data',
                                value: '```' + JSON.stringify(data, null, 2) + '```',
                                short: false
                            }
                        ]
                    })
                }
            ]
        };
        
        // Slack Webhook 전송
        const response = await fetch(slackWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(slackMessage)
        });
        
        if (!response.ok) {
            throw new Error(`Slack API error: ${response.status}`);
        }
        
        return res.status(200).json({
            success: true,
            message: 'Notification sent to Slack'
        });
        
    } catch (error) {
        console.error('[Slack Notification] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

