/**
 * 경매 종료 Cron Job
 * Vercel Cron Job (1분 주기)
 * 
 * 서버에서 주기적으로 종료 시간이 지난 경매를 확인하고 처리합니다.
 * - 서버 시간 기준 종료 처리
 * - 소유권 부여
 * - 수동 롤백 프로세스 지원
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
        console.error('[End Auctions] Failed to initialize Firebase Admin:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // Cron Job 인증 (Vercel Cron Secret)
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }
    
    try {
        initializeAdmin();
        const db = admin.firestore();
        
        console.log('[End Auctions] Checking for ended auctions...');
        
        const now = admin.firestore.Timestamp.now();
        const oneMinuteAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - 60 * 1000);
        
        // 종료 시간이 지난 활성 경매 조회
        // 종료 시간 이후 1분 이내 입찰은 무효 처리
        const activeAuctionsSnapshot = await db.collection('auctions')
            .where('status', '==', 'active')
            .where('endTime', '<=', now)
            .get();
        
        let processedCount = 0;
        let errorCount = 0;
        
        for (const doc of activeAuctionsSnapshot.docs) {
            try {
                const auction = doc.data();
                const auctionId = doc.id;
                
                // 최종 입찰자 확인
                if (!auction.highestBidder) {
                    // 입찰자가 없으면 경매 취소
                    await db.collection('auctions').doc(auctionId).update({
                        status: 'cancelled',
                        endedAt: now,
                        reason: 'no_bids'
                    });
                    console.log(`[End Auctions] Auction ${auctionId} cancelled (no bids)`);
                    processedCount++;
                    continue;
                }
                
                // 소유권 변경 API 호출 (내부 API)
                const changeOwnershipUrl = `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/territory/change-ownership`;
                const internalApiSecret = process.env.INTERNAL_API_SECRET;
                
                try {
                    const ownershipResponse = await fetch(changeOwnershipUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${internalApiSecret}`
                        },
                        body: JSON.stringify({
                            territoryId: auction.territoryId,
                            userId: auction.highestBidder,
                            userName: auction.highestBidderName || 'Unknown',
                            price: auction.currentBid || auction.startingBid,
                            auctionId: auctionId,
                            reason: 'auction_won',
                            requestId: `auction_${auctionId}_${Date.now()}`
                        })
                    });
                    
                    if (!ownershipResponse.ok) {
                        const errorData = await ownershipResponse.json();
                        throw new Error(errorData.error || 'Failed to transfer ownership');
                    }
                    
                    const ownershipResult = await ownershipResponse.json();
                    
                    // 경매 종료 처리
                    await db.collection('auctions').doc(auctionId).update({
                        status: 'ended',
                        endedAt: now,
                        winner: auction.highestBidder,
                        winnerName: auction.highestBidderName,
                        finalBid: auction.currentBid,
                        transactionId: ownershipResult.transactionId
                    });
                    
                    console.log(`[End Auctions] ✅ Auction ${auctionId} ended. Winner: ${auction.highestBidderName}`);
                    processedCount++;
                    
                } catch (ownershipError) {
                    console.error(`[End Auctions] Failed to transfer ownership for auction ${auctionId}:`, ownershipError);
                    errorCount++;
                    
                    // 경매는 종료 처리하되, 소유권은 실패 상태로 표시
                    await db.collection('auctions').doc(auctionId).update({
                        status: 'ended',
                        endedAt: now,
                        ownershipTransferFailed: true,
                        ownershipTransferError: ownershipError.message
                    });
                }
                
            } catch (error) {
                console.error(`[End Auctions] Error processing auction ${doc.id}:`, error);
                errorCount++;
            }
        }
        
        console.log(`[End Auctions] ✅ Completed. Processed: ${processedCount}, Errors: ${errorCount}`);
        
        return res.status(200).json({
            success: true,
            processed: processedCount,
            errors: errorCount,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[End Auctions] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

