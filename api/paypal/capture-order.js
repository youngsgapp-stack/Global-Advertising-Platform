/**
 * PayPal Order Capture API
 * Vercel Serverless Function
 * 
 * 클라이언트에서 호출하여 PayPal Order를 capture하고,
 * Firestore에 결제 기록 및 포인트 충전을 처리합니다.
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
        const { orderID, userId, amount, points } = req.body;
        
        // 입력 검증
        if (!orderID) {
            return res.status(400).json({
                success: false,
                error: 'Order ID is required'
            });
        }
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
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
                error: 'PayPal configuration error'
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
        
        // PayPal Order Capture
        const captureResponse = await fetch(`${paypalBaseUrl}/v2/checkout/orders/${orderID}/capture`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        if (!captureResponse.ok) {
            const errorData = await captureResponse.text();
            console.error('[PayPal API] Capture failed:', errorData);
            return res.status(captureResponse.status).json({
                success: false,
                error: 'Failed to capture PayPal order',
                details: errorData
            });
        }
        
        const captureData = await captureResponse.json();
        
        // Capture 상태 확인
        if (captureData.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                error: `Order capture status is ${captureData.status}, not COMPLETED`
            });
        }
        
        console.log('[PayPal API] Order captured successfully:', orderID);
        
        // Firebase Admin 초기화
        await initFirebaseAdmin();
        
        // Firestore에 결제 기록 저장
        const paymentRecord = {
            transactionId: orderID,
            method: 'paypal',
            amount: amount || parseFloat(captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0),
            points: points || 0,
            status: 'completed',
            pointStatus: 'pending',
            processingStage: 'validation',
            userId: userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentDetails: {
                status: captureData.status,
                payer: captureData.payer,
                purchase_units: captureData.purchase_units,
                fullResponse: captureData
            },
            paypalOrderId: orderID,
            paypalPayerId: captureData.payer?.payer_id
        };
        
        // 중복 결제 방지 체크
        const paymentRef = firestore.collection('payments').doc(`payment_${orderID}`);
        const existingPayment = await paymentRef.get();
        
        if (existingPayment.exists) {
            const existingData = existingPayment.data();
            if (existingData.pointStatus === 'completed') {
                console.warn('[Payment] Duplicate payment detected:', orderID);
                return res.status(200).json({
                    success: true,
                    orderID: orderID,
                    message: 'Payment already processed',
                    alreadyProcessed: true
                });
            }
        }
        
        // 결제 기록 저장
        await paymentRef.set(paymentRecord);
        console.log('[Payment] Payment record saved to Firestore:', orderID);
        
        // 포인트 충전 처리
        if (points && points > 0) {
            const walletRef = firestore.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            
            const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
            const newBalance = currentBalance + points;
            
            // 지갑 업데이트
            await walletRef.set({
                balance: newBalance,
                totalCharged: admin.firestore.FieldValue.increment(points),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            // 거래 내역 저장
            const transactionRef = walletRef.collection('transactions').doc(`txn_${Date.now()}`);
            await transactionRef.set({
                type: 'charge',
                amount: points,
                balanceAfter: newBalance,
                description: `PayPal charge: $${amount || 0}`,
                metadata: {
                    transactionId: orderID,
                    method: 'paypal'
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // 결제 기록 업데이트 (포인트 충전 완료)
            await paymentRef.update({
                pointStatus: 'completed',
                processingStage: 'completed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log('[Payment] Points added to wallet:', {
                userId: userId,
                points: points,
                newBalance: newBalance
            });
        }
        
        return res.status(200).json({
            success: true,
            orderID: orderID,
            status: captureData.status,
            points: points,
            message: 'Payment captured and points added successfully'
        });
        
    } catch (error) {
        console.error('[PayPal API] Error capturing order:', error);
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

