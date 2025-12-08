/**
 * 만료된 영토 자동 재경매 Cron Job
 * Vercel Cron Job
 * 
 * 전문가 제안 + 사용자 아이디어 반영:
 * - 처음 구매시 1주일 고정
 * - 1주일 동안 입찰 없을시 무한 고정
 * - 입찰 있을시 기존 경매 시스템
 * - 방치 감지: 30일 이상 활동 없음 시 임대 기간 단축
 * - 프리미엄 상품: 1달 임대, 1년 임대, 영구 임대
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
        console.error('[Check Expired Territories] Failed to initialize Firebase Admin:', error);
        throw error;
    }
}

export default async function handler(req, res) {
    // Cron Job 인증
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        initializeAdmin();
        const db = admin.firestore();
        const now = admin.firestore.Timestamp.now();
        const nowDate = new Date();
        
        console.log('[Check Expired Territories] Starting check...');
        
        // 1. 1주일 고정 기간이 지난 영토 확인 (입찰 없으면 무한 고정으로 전환)
        const oneWeekAgo = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneWeekAgoTimestamp = admin.firestore.Timestamp.fromDate(oneWeekAgo);
        
        const territoriesAfterOneWeek = await db.collection('territories')
            .where('initialProtectionEndsAt', '<=', oneWeekAgoTimestamp)
            .where('canBeChallenged', '==', false)
            .where('isPermanent', '==', false)
            .where('leaseEndsAt', '==', null) // 기본 임대 모델만
            .limit(100)
            .get();
        
        let autoPermanentCount = 0;
        for (const doc of territoriesAfterOneWeek.docs) {
            const territory = doc.data();
            
            // 현재 활성 경매가 있는지 확인
            if (territory.currentAuction) {
                const auctionRef = db.collection('auctions').doc(territory.currentAuction);
                const auctionDoc = await auctionRef.get();
                
                if (auctionDoc.exists && auctionDoc.data().status === 'active') {
                    // 활성 경매가 있으면 canBeChallenged = true로 설정 (경매 진행)
                    await doc.ref.update({
                        canBeChallenged: true,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[Check Expired Territories] Territory ${doc.id} has active auction, canBeChallenged = true`);
                    continue;
                }
            }
            
            // 입찰이 없으면 무한 고정으로 전환
            await doc.ref.update({
                canBeChallenged: false,
                isPermanent: true, // 무한 고정
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // 히스토리 업데이트
            await db.collection('ownership_logs').add({
                territoryId: doc.id,
                type: 'auto_permanent',
                message: '1주일 고정 기간 종료, 입찰 없음으로 인해 무한 고정으로 전환',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            autoPermanentCount++;
            console.log(`[Check Expired Territories] Territory ${doc.id} auto-converted to permanent`);
        }
        
        // 2. 방치 감지: 개선된 소유 모델 기준
        // - 무한 고정(isPermanent=true)인 영토만 방치 감지 대상
        // - 30일 이상 활동 없음 감지
        // - 1주일 고정 기간 중이거나 경매 진행 중인 영토는 제외
        const thirtyDaysAgo = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);
        
        // 무한 고정(isPermanent=true)이고, 1주일 고정 기간이 지났으며, 경매 진행 중이 아닌 영토만 체크
        const abandonedTerritories = await db.collection('territories')
            .where('isPermanent', '==', true)
            .where('lastActivityAt', '<', thirtyDaysAgoTimestamp)
            .where('leaseEndsAt', '==', null) // 프리미엄 상품이 아닌 경우만
            .limit(100)
            .get();
        
        // 추가 필터링: 1주일 고정 기간이 지났는지 확인
        const filteredAbandoned = [];
        for (const doc of abandonedTerritories.docs) {
            const territory = doc.data();
            
            // 1주일 고정 기간이 아직 지나지 않았으면 제외
            if (territory.initialProtectionEndsAt) {
                const protectionEndsAt = territory.initialProtectionEndsAt.toDate();
                if (nowDate < protectionEndsAt) {
                    continue; // 아직 보호 기간 중
                }
            }
            
            // 경매 진행 중이면 제외
            if (territory.currentAuction) {
                const auctionRef = db.collection('auctions').doc(territory.currentAuction);
                const auctionDoc = await auctionRef.get();
                if (auctionDoc.exists && auctionDoc.data().status === 'active') {
                    continue; // 경매 진행 중
                }
            }
            
            filteredAbandoned.push(doc);
        }
        
        let abandonedCount = 0;
        for (const doc of filteredAbandoned) {
            const territory = doc.data();
            
            // 방치 경고 (첫 번째 경고)
            if (!territory.abandonedWarning) {
                await doc.ref.update({
                    abandonedWarning: true,
                    abandonedWarningAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                console.log(`[Check Expired Territories] Territory ${doc.id} marked as abandoned (warning)`);
                abandonedCount++;
            } else {
                // 이미 경고를 받았고, 추가로 7일이 지났으면 자동 재경매
                const warningAt = territory.abandonedWarningAt?.toDate();
                if (warningAt) {
                    const sevenDaysAfterWarning = new Date(warningAt.getTime() + 7 * 24 * 60 * 60 * 1000);
                    if (nowDate >= sevenDaysAfterWarning) {
                        // 자동 재경매 시작
                        const auctionRef = db.collection('auctions').doc();
                        await auctionRef.set({
                            territoryId: doc.id,
                            territoryName: territory.name || territory.territoryName || 'Unknown',
                            countryIso: territory.countryIso || territory.country,
                            status: 'active',
                            startingPrice: territory.purchasedPrice || 100,
                            currentPrice: territory.purchasedPrice || 100,
                            highestBidder: null,
                            highestBidderName: null,
                            bidCount: 0,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            endsAt: admin.firestore.Timestamp.fromDate(new Date(nowDate.getTime() + 24 * 60 * 60 * 1000)), // 24시간 후
                            reason: 'abandoned_auto_reauction'
                        });
                        
                        await doc.ref.update({
                            currentAuction: auctionRef.id,
                            canBeChallenged: true,
                            isPermanent: false,
                            abandonedWarning: false,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        // 히스토리 업데이트
                        await db.collection('ownership_logs').add({
                            territoryId: doc.id,
                            type: 'auto_reauction',
                            reason: 'abandoned',
                            previousOwner: territory.ruler,
                            previousOwnerName: territory.rulerName,
                            message: '30일 이상 활동 없음으로 인해 자동 재경매 시작',
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        console.log(`[Check Expired Territories] Territory ${doc.id} auto-reauction started`);
                    }
                }
            }
        }
        
        // 3. 임대 기간 만료된 영토 확인 (프리미엄 상품)
        const expiredLeases = await db.collection('territories')
            .where('leaseEndsAt', '<=', now)
            .where('leaseEndsAt', '!=', null)
            .where('isPermanent', '==', false)
            .limit(100)
            .get();
        
        let expiredLeaseCount = 0;
        for (const doc of expiredLeases.docs) {
            const territory = doc.data();
            
            // 히스토리 업데이트
            await db.collection('ownership_logs').add({
                territoryId: doc.id,
                type: 'lease_expired',
                previousOwner: territory.ruler,
                previousOwnerName: territory.rulerName,
                leaseType: territory.leaseType,
                message: `임대 기간 만료 (${territory.leaseType})`,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // 자동 재경매 시작
            const auctionRef = db.collection('auctions').doc();
            await auctionRef.set({
                territoryId: doc.id,
                territoryName: territory.name || territory.territoryName || 'Unknown',
                countryIso: territory.countryIso || territory.country,
                status: 'active',
                startingPrice: territory.purchasedPrice || 100,
                currentPrice: territory.purchasedPrice || 100,
                highestBidder: null,
                highestBidderName: null,
                bidCount: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                endsAt: admin.firestore.Timestamp.fromDate(new Date(nowDate.getTime() + 24 * 60 * 60 * 1000)), // 24시간 후
                reason: 'lease_expired'
            });
            
            await doc.ref.update({
                ruler: null,
                rulerName: null,
                rulerSince: null,
                sovereignty: 'available',
                currentAuction: auctionRef.id,
                canBeChallenged: true,
                leaseType: null,
                leaseEndsAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            expiredLeaseCount++;
            console.log(`[Check Expired Territories] Territory ${doc.id} lease expired, reauction started`);
        }
        
        const result = {
            success: true,
            timestamp: nowDate.toISOString(),
            stats: {
                autoPermanentCount,
                abandonedCount,
                expiredLeaseCount
            }
        };
        
        console.log('[Check Expired Territories] Completed:', result);
        
        return res.status(200).json(result);
        
    } catch (error) {
        console.error('[Check Expired Territories] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

