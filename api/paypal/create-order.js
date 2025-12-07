/**
 * PayPal Order 생성 API
 * Vercel Serverless Function
 * 
 * 클라이언트에서 호출하여 PayPal Order를 생성하고 orderID를 반환합니다.
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
        const { amount, currency = 'USD', description } = req.body;
        
        // 입력 검증
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid amount. Amount must be greater than 0.'
            });
        }
        
        // PayPal Client ID와 Secret 가져오기
        const paypalClientId = process.env.PAYPAL_CLIENT_ID;
        const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
        const paypalEnvironment = process.env.PAYPAL_ENVIRONMENT || 'sandbox';
        
        if (!paypalClientId || !paypalClientSecret) {
            console.error('[PayPal API] Missing PayPal credentials');
            return res.status(500).json({
                success: false,
                error: 'PayPal configuration error. Please contact support.'
            });
        }
        
        // PayPal API 엔드포인트 결정
        const paypalBaseUrl = paypalEnvironment === 'production'
            ? 'https://api-m.paypal.com'
            : 'https://api-m.sandbox.paypal.com';
        
        // PayPal Access Token 가져오기
        const accessToken = await getPayPalAccessToken(paypalBaseUrl, paypalClientId, paypalClientSecret);
        
        if (!accessToken) {
            return res.status(500).json({
                success: false,
                error: 'Failed to authenticate with PayPal'
            });
        }
        
        // PayPal Order 생성
        const orderResponse = await fetch(`${paypalBaseUrl}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'PayPal-Request-Id': `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: currency,
                        value: amount.toString()
                    },
                    description: description || 'Point charge'
                }]
            })
        });
        
        if (!orderResponse.ok) {
            const errorData = await orderResponse.text();
            console.error('[PayPal API] Order creation failed:', errorData);
            return res.status(orderResponse.status).json({
                success: false,
                error: 'Failed to create PayPal order',
                details: errorData
            });
        }
        
        const orderData = await orderResponse.json();
        
        console.log('[PayPal API] Order created successfully:', orderData.id);
        
        return res.status(200).json({
            success: true,
            orderID: orderData.id,
            status: orderData.status
        });
        
    } catch (error) {
        console.error('[PayPal API] Error creating order:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

/**
 * PayPal Access Token 가져오기
 */
async function getPayPalAccessToken(baseUrl, clientId, clientSecret) {
    try {
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        
        const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[PayPal API] Failed to get access token:', errorText);
            return null;
        }
        
        const data = await response.json();
        return data.access_token;
        
    } catch (error) {
        console.error('[PayPal API] Error getting access token:', error);
        return null;
    }
}

