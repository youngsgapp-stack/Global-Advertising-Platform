/**
 * Territory Ownership Change API
 * Vercel Serverless Function
 * 
 * 서버 사이드에서 영토 소유권 변경을 검증하고 처리합니다.
 * Idempotent 설계로 중복 호출 안전
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
            territoryId, 
            userId, 
            userName, 
            price, 
            paymentId, 
            auctionId,
            reason,
            requestId 
        } = req.body;
        
        // 입력 검증
        if (!territoryId) {
            return res.status(400).json({
                success: false,
                error: 'Territory ID is required'
            });
        }
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }
        
        if (!userName) {
            return res.status(400).json({
                success: false,
                error: 'User name is required'
            });
        }
        
        if (price === undefined || price === null) {
            return res.status(400).json({
                success: false,
                error: 'Price is required'
            });
        }
        
        // reason 검증
        const validReasons = ['direct_purchase', 'auction_won', 'admin_fix'];
        const finalReason = reason || 'direct_purchase';
        if (!validReasons.includes(finalReason)) {
            return res.status(400).json({
                success: false,
                error: `Invalid reason. Must be one of: ${validReasons.join(', ')}`
            });
        }
        
        // Firebase Admin 초기화
        await initFirebaseAdmin();
        
        // Idempotent 체크: requestId가 있으면 이미 처리된 요청인지 확인
        if (requestId) {
            const existingLogRef = firestore.collection('territoryOwnershipLogs')
                .where('requestId', '==', requestId)
                .limit(1);
            
            const existingLogs = await existingLogRef.get();
            if (!existingLogs.empty) {
                const existingLog = existingLogs.docs[0].data();
                console.log('[Ownership] Request already processed:', requestId);
                return res.status(200).json({
                    success: true,
                    alreadyProcessed: true,
                    message: 'Request already processed',
                    transactionId: existingLog.transactionId,
                    territoryId: existingLog.territoryId
                });
            }
        }
        
        // 영토 현재 상태 확인
        const territoryRef = firestore.collection('territories').doc(territoryId);
        const territoryDoc = await territoryRef.get();
        
        if (!territoryDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Territory not found'
            });
        }
        
        const territory = territoryDoc.data();
        
        // 소유권 변경 가능 여부 확인
        if (territory.ruler && territory.ruler !== null) {
            if (territory.ruler === userId) {
                return res.status(400).json({
                    success: false,
                    error: 'You already own this territory'
                });
            } else {
                // 다른 사람이 소유 중인 경우 - 경매 낙찰인 경우에만 허용
                if (finalReason !== 'auction_won' && finalReason !== 'admin_fix') {
                    return res.status(400).json({
                        success: false,
                        error: 'Territory is already owned by another user'
                    });
                }
            }
        }
        
        // 결제 검증 (direct_purchase인 경우)
        if (finalReason === 'direct_purchase' && paymentId) {
            const paymentRef = firestore.collection('payments').doc(`payment_${paymentId}`);
            const paymentDoc = await paymentRef.get();
            
            if (!paymentDoc.exists) {
                return res.status(400).json({
                    success: false,
                    error: 'Payment record not found'
                });
            }
            
            const payment = paymentDoc.data();
            if (payment.userId !== userId) {
                return res.status(403).json({
                    success: false,
                    error: 'Payment does not belong to this user'
                });
            }
            
            if (payment.status !== 'completed' || payment.pointStatus !== 'completed') {
                return res.status(400).json({
                    success: false,
                    error: 'Payment not completed'
                });
            }
        }
        
        // 경매 검증 (auction_won인 경우)
        if (finalReason === 'auction_won' && auctionId) {
            const auctionRef = firestore.collection('auctions').doc(auctionId);
            const auctionDoc = await auctionRef.get();
            
            if (!auctionDoc.exists) {
                return res.status(400).json({
                    success: false,
                    error: 'Auction record not found'
                });
            }
            
            const auction = auctionDoc.data();
            if (auction.highestBidder !== userId) {
                return res.status(403).json({
                    success: false,
                    error: 'User is not the highest bidder'
                });
            }
            
            if (auction.status !== 'ended') {
                return res.status(400).json({
                    success: false,
                    error: 'Auction not ended yet'
                });
            }
        }
        
        // 포인트 차감 확인 (direct_purchase인 경우)
        if (finalReason === 'direct_purchase') {
            const walletRef = firestore.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            
            if (!walletDoc.exists) {
                return res.status(400).json({
                    success: false,
                    error: 'Wallet not found'
                });
            }
            
            const wallet = walletDoc.data();
            if (wallet.balance < price) {
                return res.status(400).json({
                    success: false,
                    error: 'Insufficient balance'
                });
            }
            
            // 포인트 차감
            await walletRef.update({
                balance: admin.firestore.FieldValue.increment(-price),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // 거래 내역 저장
            const transactionRef = walletRef.collection('transactions').doc(`txn_${Date.now()}`);
            await transactionRef.set({
                type: 'territory_purchase',
                amount: -price,
                balanceAfter: wallet.balance - price,
                description: `Territory purchase: ${territoryId}`,
                metadata: {
                    territoryId: territoryId,
                    paymentId: paymentId
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        // 트랜잭션 ID 생성
        const transactionId = requestId || `tx_${territoryId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // 소유권 변경 (트랜잭션 사용)
        const batch = firestore.batch();
        
        const nowTimestamp = admin.firestore.FieldValue.serverTimestamp();
        const protectionEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7일
        const protectionEndsAtTimestamp = admin.firestore.Timestamp.fromDate(protectionEndsAt);
        
        // 영토 업데이트
        batch.update(territoryRef, {
            ruler: userId,
            rulerName: userName,
            rulerSince: nowTimestamp,
            sovereignty: 'protected',
            protectionEndsAt: protectionEndsAtTimestamp,
            purchasedPrice: price,
            tribute: price,
            currentAuction: null,
            updatedAt: nowTimestamp
        });
        
        // 소유권 변경 로그 저장
        const ownershipLogRef = firestore.collection('territoryOwnershipLogs').doc(transactionId);
        const ownershipLog = {
            territoryId,
            previousOwner: territory.ruler || null,
            newOwner: userId,
            newOwnerName: userName,
            price,
            paymentId: paymentId || null,
            auctionId: auctionId || null,
            transactionId,
            requestId: requestId || null,
            reason: finalReason,
            timestamp: nowTimestamp,
            type: 'ownership_transfer'
        };
        batch.set(ownershipLogRef, ownershipLog);
        
        // 트랜잭션 커밋
        await batch.commit();
        
        console.log('[Ownership] ✅ Ownership transferred:', {
            territoryId,
            userId,
            userName,
            price,
            reason: finalReason,
            transactionId
        });
        
        return res.status(200).json({
            success: true,
            transactionId,
            territoryId,
            userId,
            userName,
            price,
            reason: finalReason
        });
        
    } catch (error) {
        console.error('[Ownership] ❌ Error transferring ownership:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

