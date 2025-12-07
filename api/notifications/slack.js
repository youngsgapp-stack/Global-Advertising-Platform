/**
 * Slack Notification API
 * Vercel Serverless Function
 * 
 * 중요 이벤트를 Slack에 알림
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
            level, // 'urgent', 'important', 'info'
            title,
            message,
            details
        } = req.body;
        
        // 입력 검증
        if (!title || !message) {
            return res.status(400).json({
                success: false,
                error: 'Title and message are required'
            });
        }
        
        const webhookUrl = process.env.SLACK_WEBHOOK_URL;
        if (!webhookUrl) {
            console.warn('[Slack] Webhook URL not configured');
            return res.status(200).json({
                success: false,
                error: 'Slack webhook not configured',
                message: 'Notification logged but not sent'
            });
        }
        
        // 레벨에 따른 색상 및 이모지
        const levelConfig = {
            urgent: { color: '#dc3545', emoji: '🚨' },
            important: { color: '#ffc107', emoji: '⚠️' },
            info: { color: '#17a2b8', emoji: 'ℹ️' }
        };
        
        const config = levelConfig[level] || levelConfig.info;
        
        // Slack 메시지 포맷
        const slackMessage = {
            text: `${config.emoji} ${title}`,
            attachments: [
                {
                    color: config.color,
                    title: title,
                    text: message,
                    fields: details ? Object.entries(details).map(([key, value]) => ({
                        title: key,
                        value: String(value),
                        short: true
                    })) : [],
                    footer: 'Global Advertising Platform',
                    ts: Math.floor(Date.now() / 1000)
                }
            ]
        };
        
        // Slack에 전송
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(slackMessage)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Slack API error: ${errorText}`);
        }
        
        console.log('[Slack] Notification sent:', title);
        
        return res.status(200).json({
            success: true,
            message: 'Notification sent to Slack'
        });
        
    } catch (error) {
        console.error('[Slack] Error sending notification:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

