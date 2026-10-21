/**
 * PayPal 서버 연동 (포인트 충전 검증용)
 * 필요 환경변수: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT ('production' | 'sandbox')
 * 웹훅: PAYPAL_WEBHOOK_ID (PayPal 개발자 대시보드에서 웹훅 등록 후 받은 ID)
 */

// js/services/PaymentService.js의 POINT_PACKAGES / CUSTOM_AMOUNT_CONFIG와 동일하게 유지
const POINT_PACKAGES = [
    { amount: 10, points: 100 },
    { amount: 30, points: 350 },
    { amount: 50, points: 600 },
    { amount: 100, points: 1300 }
];
const CUSTOM_POINT_RATE = 10; // $1 = 10pt
const CUSTOM_MIN_AMOUNT = 1;
const CUSTOM_MAX_AMOUNT = 10000;

/**
 * 실제 결제된 USD 금액으로 지급할 포인트 계산
 * @returns {number} 0이면 지급 불가 금액
 */
export function pointsForUsdAmount(amountUsd) {
    const amount = Math.round(parseFloat(amountUsd) * 100) / 100;
    if (!Number.isFinite(amount) || amount < CUSTOM_MIN_AMOUNT || amount > CUSTOM_MAX_AMOUNT) {
        return 0;
    }
    const pkg = POINT_PACKAGES.find(p => p.amount === amount);
    if (pkg) {
        return pkg.points;
    }
    return Math.floor(amount * CUSTOM_POINT_RATE);
}

function getPayPalBaseUrl() {
    return process.env.PAYPAL_ENVIRONMENT === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken(baseUrl) {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        const error = new Error('PayPal credentials are not configured on the server');
        error.code = 'PAYPAL_NOT_CONFIGURED';
        throw error;
    }
    
    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        },
        body: 'grant_type=client_credentials'
    });
    
    if (!response.ok) {
        const error = new Error(`PayPal authentication failed (${response.status})`);
        error.code = 'PAYPAL_AUTH_FAILED';
        throw error;
    }
    
    const data = await response.json();
    return data.access_token;
}

async function authHeaders(baseUrl) {
    const accessToken = await getAccessToken(baseUrl);
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
    };
}

/**
 * 충전 주문 생성. customId(사용자 DB id)를 주문에 새겨 두면 브라우저가 중간에 닫혀도 웹훅이 누구에게 충전할지 알 수 있음
 * @returns {Promise<string>} PayPal 주문 ID
 */
export async function createPayPalOrder({ amount, customId, description }) {
    const baseUrl = getPayPalBaseUrl();
    const headers = await authHeaders(baseUrl);
    const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: { ...headers, 'PayPal-Request-Id': `order-${customId}-${Date.now()}` },
        body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: { currency_code: 'USD', value: Number(amount).toFixed(2) },
                description: String(description || 'Point charge').slice(0, 127),
                custom_id: customId
            }]
        })
    });
    if (!response.ok) {
        const error = new Error(`PayPal order creation failed (${response.status})`);
        error.code = 'PAYPAL_ORDER_FAILED';
        error.details = await response.text().catch(() => '');
        throw error;
    }
    const order = await response.json();
    return order.id;
}

/**
 * 웹훅 서명 검증 (원본 body 문자열을 그대로 넘겨야 숫자/공백이 바뀌지 않음)
 */
export async function verifyPayPalWebhook(headers, rawBody) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) {
        return false;
    }
    const baseUrl = getPayPalBaseUrl();
    const meta = {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId
    };
    if (!meta.transmission_id || !meta.transmission_sig) {
        return false;
    }
    const body = `${JSON.stringify(meta).slice(0, -1)},"webhook_event":${rawBody}}`;
    const response = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: await authHeaders(baseUrl),
        body
    });
    if (!response.ok) {
        const error = new Error(`PayPal webhook verification request failed (${response.status})`);
        error.code = 'PAYPAL_VERIFY_FAILED';
        throw error;
    }
    const result = await response.json();
    return result.verification_status === 'SUCCESS';
}

/**
 * 주문을 캡처하고 (이미 캡처된 주문이면 조회) 검증된 결제 정보를 반환
 * @returns {Promise<{ orderId: string, amount: number, currency: string, captureId: string|null, payerId: string|null, customId: string|null }>}
 */
export async function capturePayPalOrder(orderId) {
    const baseUrl = getPayPalBaseUrl();
    const headers = await authHeaders(baseUrl);
    
    let order;
    const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers
    });
    
    if (captureResponse.ok) {
        order = await captureResponse.json();
    } else {
        const errorBody = await captureResponse.json().catch(() => ({}));
        const alreadyCaptured = captureResponse.status === 422 &&
            (errorBody.details || []).some(d => d.issue === 'ORDER_ALREADY_CAPTURED');
        
        if (!alreadyCaptured) {
            const error = new Error(`PayPal capture failed (${captureResponse.status})`);
            error.code = 'PAYPAL_CAPTURE_FAILED';
            error.details = errorBody;
            throw error;
        }
        
        const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers });
        if (!orderResponse.ok) {
            const error = new Error(`PayPal order lookup failed (${orderResponse.status})`);
            error.code = 'PAYPAL_CAPTURE_FAILED';
            throw error;
        }
        order = await orderResponse.json();
    }
    
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') {
        const error = new Error(`PayPal payment is not completed (order: ${order.status}, capture: ${capture?.status})`);
        error.code = 'PAYPAL_NOT_COMPLETED';
        throw error;
    }
    
    let customId = order.purchase_units?.[0]?.custom_id || capture.custom_id || null;
    if (!customId) {
        const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers });
        if (orderResponse.ok) {
            customId = (await orderResponse.json()).purchase_units?.[0]?.custom_id || null;
        }
    }
    
    return {
        orderId: order.id,
        amount: parseFloat(capture.amount?.value || 0),
        currency: capture.amount?.currency_code,
        captureId: capture.id || null,
        payerId: order.payer?.payer_id || null,
        customId
    };
}
