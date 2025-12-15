/**
 * 경매 종료 API
 * 
 * Hobby 플랜의 cron job 제한(하루 1회) 때문에 별도 API로 분리
 * 외부 cron 서비스(예: cron-job.org)나 클라이언트에서 주기적으로 호출 가능
 * 
 * 사용법:
 * - 외부 cron 서비스: 1분마다 호출
 * - 또는 클라이언트에서 주기적으로 호출
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
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // 인증 (선택적 - API 키 또는 Secret)
    const authHeader = req.headers.authorization;
    const apiSecret = process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET;
    
    // Secret이 설정되어 있으면 인증 필요
    if (apiSecret && authHeader !== `Bearer ${apiSecret}`) {
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
                
                if (!auction.highestBidder) {
                    await db.collection('auctions').doc(auctionId).update({
                        status: 'cancelled',
                        endedAt: now,
                        reason: 'no_bids'
                    });
                    processedCount++;
                    continue;
                }
                
                // 소유권 변경 API 호출
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
                    
                    await db.collection('auctions').doc(auctionId).update({
                        status: 'ended',
                        endedAt: now,
                        winner: auction.highestBidder,
                        winnerName: auction.highestBidderName,
                        finalBid: auction.currentBid,
                        transactionId: ownershipResult.transactionId
                    });
                    
                    processedCount++;
                    
                } catch (ownershipError) {
                    console.error(`[End Auctions] Failed to transfer ownership for auction ${auctionId}:`, ownershipError);
                    errorCount++;
                    
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

