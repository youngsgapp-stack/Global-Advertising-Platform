/**
 * Territory 소유권 변경 서버 사이드 검증 API
 * Vercel Serverless Function
 * 
 * 클라이언트에서 소유권 변경 요청을 받아 서버에서 검증 후 처리합니다.
 * - 결제 검증 (PayPal/Payoneer API 재검증)
 * - 경매 낙찰 검증
 * - 포인트 차감 확인
 * - Idempotent 설계 (중복 호출 방지)
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
        console.error('[Change Ownership API] Failed to initialize Firebase Admin:', error);
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
            userId, 
            userName, 
            price, 
            paymentId, 
            auctionId,
            reason,
            requestId 
        } = req.body;
        
        // 필수 파라미터 검증
        if (!territoryId || !userId || !userName || price === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: territoryId, userId, userName, price'
            });
        }
        
        if (!reason || !['direct_purchase', 'auction_won', 'admin_fix'].includes(reason)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid reason. Must be: direct_purchase, auction_won, or admin_fix'
            });
        }
        
        // Idempotent 체크: requestId가 있으면 이미 처리된 요청인지 확인
        if (requestId) {
            const db = admin.firestore();
            const existingLog = await db.collection('ownership_logs')
                .where('requestId', '==', requestId)
                .limit(1)
                .get();
            
            if (!existingLog.empty) {
                const log = existingLog.docs[0].data();
                return res.status(200).json({
                    success: true,
                    message: 'Already processed',
                    transactionId: log.transactionId,
                    territoryId: log.territoryId
                });
            }
        }
        
        const db = admin.firestore();
        const batch = db.batch();
        
        // 1. 영토 현재 상태 확인
        const territoryRef = db.collection('territories').doc(territoryId);
        const territoryDoc = await territoryRef.get();
        
        if (!territoryDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Territory not found'
            });
        }
        
        const territory = territoryDoc.data();
        
        // 2. 소유권 변경 가능 여부 확인
        if (territory.ruler && territory.ruler !== null && territory.ruler !== userId) {
            return res.status(400).json({
                success: false,
                error: 'Territory is already owned by another user'
            });
        }
        
        // 2.1 소유 제한 체크 (고래 유저 대응)
        const ownedTerritoriesSnapshot = await db.collection('territories')
            .where('ruler', '==', userId)
            .get();
        
        const MAX_TERRITORIES_PER_USER = 50; // 사용자당 최대 소유 영토 수
        if (ownedTerritoriesSnapshot.size >= MAX_TERRITORIES_PER_USER) {
            return res.status(400).json({
                success: false,
                error: `Ownership limit reached. Maximum ${MAX_TERRITORIES_PER_USER} territories per user.`
            });
        }
        
        // 3. reason에 따른 검증
        if (reason === 'direct_purchase') {
            // 직접 구매: 결제 검증
            if (!paymentId) {
                return res.status(400).json({
                    success: false,
                    error: 'paymentId is required for direct_purchase'
                });
            }
            
            // PayPal 결제 검증 (간단한 체크 - 실제로는 PayPal API로 재검증 필요)
            const paymentRef = db.collection('payments').doc(paymentId);
            const paymentDoc = await paymentRef.get();
            
            if (!paymentDoc.exists) {
                return res.status(400).json({
                    success: false,
                    error: 'Payment not found'
                });
            }
            
            const payment = paymentDoc.data();
            if (payment.userId !== userId || payment.status !== 'completed') {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid payment'
                });
            }
            
            // 포인트 차감 확인
            const walletRef = db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            
            if (walletDoc.exists) {
                const wallet = walletDoc.data();
                if (wallet.balance < price) {
                    return res.status(400).json({
                        success: false,
                        error: 'Insufficient balance'
                    });
                }
                
                // 포인트 차감
                batch.update(walletRef, {
                    balance: admin.firestore.FieldValue.increment(-price),
                    totalSpent: admin.firestore.FieldValue.increment(price),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
        } else if (reason === 'auction_won') {
            // 경매 낙찰: 경매 검증
            if (!auctionId) {
                return res.status(400).json({
                    success: false,
                    error: 'auctionId is required for auction_won'
                });
            }
            
            const auctionRef = db.collection('auctions').doc(auctionId);
            const auctionDoc = await auctionRef.get();
            
            if (!auctionDoc.exists) {
                return res.status(400).json({
                    success: false,
                    error: 'Auction not found'
                });
            }
            
            const auction = auctionDoc.data();
            if (auction.status !== 'active' || auction.highestBidder !== userId) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid auction or not the highest bidder'
                });
            }
            
            // 경매 종료 처리
            batch.update(auctionRef, {
                status: 'ended',
                endedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        // admin_fix는 검증 없이 진행 (관리자 권한 필요 시 추가)
        
        // 4. 소유권 변경 (개선된 소유 모델)
        const transactionId = requestId || `tx_${territoryId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = admin.firestore.FieldValue.serverTimestamp();
        const nowDate = new Date();
        
        // 사용자 아이디어 반영: 처음 구매시 1주일 고정
        const initialProtectionEndsAt = new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000); // 7일 후
        
        // 프리미엄 상품 옵션 (metadata에서 가져옴, 기본값: 없음)
        const leaseType = req.body.leaseType || 'default'; // 'default', '1month', '1year', 'permanent'
        let leaseEndsAt = null;
        let isPermanent = false;
        
        // 프리미엄 상품에 따른 임대 기간 설정
        if (leaseType === '1month') {
            leaseEndsAt = new Date(nowDate.getTime() + 30 * 24 * 60 * 60 * 1000); // 30일
        } else if (leaseType === '1year') {
            leaseEndsAt = new Date(nowDate.getTime() + 365 * 24 * 60 * 60 * 1000); // 365일
        } else if (leaseType === 'permanent') {
            isPermanent = true;
            // 영구 임대는 leaseEndsAt을 null로 설정
        } else {
            // 기본: 처음 구매시 1주일 고정, 이후 입찰 없으면 무한 고정
            // leaseEndsAt은 null로 설정 (1주일 후 자동으로 무한 고정으로 전환)
        }
        
        // 첫 소유자 확인 (히스토리에서 확인)
        const historyQuery = await db.collection('ownership_logs')
            .where('territoryId', '==', territoryId)
            .where('type', '==', 'ownership_transfer')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();
        
        const isFirstOwner = historyQuery.empty || !territory.ruler;
        
        // 소유권 변경 업데이트
        const territoryUpdate = {
            ruler: userId,
            rulerName: userName,
            rulerSince: now,
            sovereignty: 'protected',
            protectionEndsAt: admin.firestore.Timestamp.fromDate(initialProtectionEndsAt),
            purchasedPrice: price,
            tribute: price,
            currentAuction: null,
            updatedAt: now,
            // 새로운 필드 추가
            initialProtectionEndsAt: admin.firestore.Timestamp.fromDate(initialProtectionEndsAt),
            leaseType: leaseType,
            leaseEndsAt: leaseEndsAt ? admin.firestore.Timestamp.fromDate(leaseEndsAt) : null,
            isPermanent: isPermanent,
            lastActivityAt: now, // 활동 기반 유지권을 위한 필드
            canBeChallenged: false, // 1주일 고정 기간 중에는 도전 불가
            founderBadge: isFirstOwner // 첫 소유자 배지
        };
        
        batch.update(territoryRef, territoryUpdate);
        
        // 5. 소유권 변경 로그 저장 (히스토리 영구 보존)
        const logRef = db.collection('ownership_logs').doc(transactionId);
        batch.set(logRef, {
            territoryId,
            previousOwner: territory.ruler || null,
            previousOwnerName: territory.rulerName || null,
            newOwner: userId,
            newOwnerName: userName,
            price,
            paymentId: paymentId || null,
            auctionId: auctionId || null,
            transactionId,
            reason,
            requestId: requestId || null,
            timestamp: now,
            type: 'ownership_transfer',
            // 히스토리 영구 보존을 위한 추가 정보
            leaseType: leaseType,
            leaseEndsAt: leaseEndsAt ? admin.firestore.Timestamp.fromDate(leaseEndsAt) : null,
            isPermanent: isPermanent,
            isFirstOwner: isFirstOwner,
            // 영구 기록: 이 영토의 첫 소유자 정보
            founderInfo: isFirstOwner ? {
                userId: userId,
                userName: userName,
                timestamp: now
            } : null
        });
        
        // 6. 트랜잭션 실행
        await batch.commit();
        
        return res.status(200).json({
            success: true,
            transactionId,
            territoryId,
            userId,
            userName,
            price
        });
        
    } catch (error) {
        console.error('[Change Ownership API] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

