/**
 * Auction End Cron Job
 * Vercel Serverless Function (Cron)
 * 
 * 주기적으로 종료 시간이 지난 경매를 확인하고 종료 처리합니다.
 * 서버 시간이 절대 기준입니다.
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
    // Cron 요청 검증
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }
    
    try {
        // Firebase Admin 초기화
        await initFirebaseAdmin();
        
        console.log('[Auction] Checking for ended auctions...');
        
        const now = admin.firestore.Timestamp.now();
        
        // 종료 시간이 지난 활성 경매 조회
        const activeAuctionsSnapshot = await firestore.collection('auctions')
            .where('status', '==', 'active')
            .where('endTime', '<=', now)
            .get();
        
        if (activeAuctionsSnapshot.empty) {
            console.log('[Auction] No auctions to end');
            return res.status(200).json({
                success: true,
                message: 'No auctions to end',
                endedCount: 0
            });
        }
        
        const endedAuctions = [];
        const errors = [];
        
        for (const doc of activeAuctionsSnapshot.docs) {
            const auction = doc.data();
            const auctionId = doc.id;
            
            try {
                // 최고 입찰자 확인
                if (!auction.highestBidder) {
                    // 입찰자가 없는 경우 경매 취소
                    await doc.ref.update({
                        status: 'cancelled',
                        endedAt: now,
                        reason: 'no_bids'
                    });
                    console.log(`[Auction] Cancelled auction ${auctionId} (no bids)`);
                    endedAuctions.push({ auctionId, status: 'cancelled', reason: 'no_bids' });
                    continue;
                }
                
                // 소유권 변경 API 호출 (서버 사이드)
                const ownershipChangeUrl = `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/territory/change-ownership`;
                
                const ownershipResponse = await fetch(ownershipChangeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET || 'internal-secret'}`
                    },
                    body: JSON.stringify({
                        territoryId: auction.territoryId,
                        userId: auction.highestBidder,
                        userName: auction.highestBidderName || 'Unknown',
                        price: auction.currentBid || auction.startingBid,
                        auctionId: auctionId,
                        reason: 'auction_won',
                        requestId: `auction_end_${auctionId}_${Date.now()}`
                    })
                });
                
                if (!ownershipResponse.ok) {
                    const errorData = await ownershipResponse.json();
                    throw new Error(`Ownership transfer failed: ${errorData.error || 'Unknown error'}`);
                }
                
                // 경매 종료 처리
                await doc.ref.update({
                    status: 'ended',
                    endedAt: now,
                    winner: auction.highestBidder,
                    winnerName: auction.highestBidderName,
                    finalBid: auction.currentBid || auction.startingBid
                });
                
                console.log(`[Auction] ✅ Ended auction ${auctionId}, winner: ${auction.highestBidder}`);
                endedAuctions.push({ 
                    auctionId, 
                    status: 'ended', 
                    winner: auction.highestBidder,
                    finalBid: auction.currentBid || auction.startingBid
                });
                
            } catch (error) {
                console.error(`[Auction] ❌ Error ending auction ${auctionId}:`, error);
                errors.push({
                    auctionId,
                    error: error.message
                });
            }
        }
        
        console.log('[Auction] ✅ Auction end process completed:', {
            endedCount: endedAuctions.length,
            errorCount: errors.length
        });
        
        return res.status(200).json({
            success: true,
            message: 'Auction end process completed',
            endedCount: endedAuctions.length,
            endedAuctions,
            errors
        });
        
    } catch (error) {
        console.error('[Auction] ❌ Error in auction end cron:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

