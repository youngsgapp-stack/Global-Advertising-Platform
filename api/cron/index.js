/**
 * 통합 Cron Job
 * Vercel Cron Job
 * 
 * ⚠️ 마이그레이션 완료: Firestore 비활성화, 백엔드 API로 리다이렉트
 * 
 * 모든 cron 작업을 하나의 함수로 통합하여 Serverless Functions 개수를 줄입니다.
 * - 랭킹 계산
 * - 만료된 영토 확인
 * - 경매 종료 처리
 * - 시즌 전환
 */

// ⚠️ Firestore Admin SDK 제거 (번들 크기 감소 및 Firestore 호출 완전 차단)
// import admin from 'firebase-admin'; // 제거됨

export default async function handler(req, res) {
    // Cron Job 인증
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }
    
    // ⚠️ 마이그레이션 완료: Firestore 비활성화, 백엔드 API로 리다이렉트
    const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:3001';
    
    try {
        // 백엔드 API로 리다이렉트
        const jobType = req.query.job || req.body.job || 'all';
        const backendUrl = `${BACKEND_API_URL}/api/cron?job=${jobType}`;
        
        const response = await fetch(backendUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(req.headers.authorization && { 'Authorization': req.headers.authorization })
            },
            body: JSON.stringify(req.body || {})
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Backend API error' }));
            return res.status(response.status).json(errorData);
        }
        
        const result = await response.json();
        return res.status(200).json(result);
        
        /* 원래 코드 (Firestore 사용 - 비활성화됨)
        initializeAdmin();
        const db = admin.firestore();
        
        // 작업 타입 가져오기 (쿼리 파라미터 또는 body에서)
        const jobType = req.query.job || req.body.job || 'all';
        
        console.log(`[Cron] Starting job: ${jobType}`);
        
        const results = {};
        
        // 모든 작업 실행 또는 특정 작업만 실행
        // 참고: 경매 종료는 별도 API(/api/auctions/end)로 분리됨 (Hobby 플랜 cron 제한 때문)
        if (jobType === 'all' || jobType === 'calculate-rankings') {
            results.rankings = await calculateRankings(db);
        }
        
        if (jobType === 'all' || jobType === 'check-expired') {
            results.expired = await checkExpiredTerritories(db);
        }
        
        // 경매 종료는 별도 API로 분리 (1분마다 실행 필요)
        // if (jobType === 'all' || jobType === 'end-auctions') {
        //     results.auctions = await endAuctions(db);
        // }
        
        if (jobType === 'all' || jobType === 'season-transition') {
            results.season = await seasonTransition(db);
        }
        
        console.log('[Cron] Completed:', results);
        
        return res.status(200).json({
            success: true,
            jobType,
            results,
            timestamp: new Date().toISOString()
        });
        */
        
    } catch (error) {
        console.error('[Cron] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

/**
 * 랭킹 계산
 */
async function calculateRankings(db) {
    try {
        console.log('[Calculate Rankings] Starting ranking calculation...');
        
        // 1. 모든 영토 데이터 로드
        const territoriesSnapshot = await db.collection('territories').get();
        const territories = {};
        
        territoriesSnapshot.forEach(doc => {
            const data = doc.data();
            territories[doc.id] = data;
        });
        
        // 2. 모든 픽셀 캔버스 데이터 로드
        const pixelCanvasesSnapshot = await db.collection('pixelCanvases').get();
        const pixelCanvases = {};
        
        pixelCanvasesSnapshot.forEach(doc => {
            const data = doc.data();
            pixelCanvases[doc.id] = data;
        });
        
        // 3. 사용자별 통계 계산
        const userStats = new Map();
        
        for (const [territoryId, territory] of Object.entries(territories)) {
            if (!territory.ruler) continue;
            
            const userId = territory.ruler;
            if (!userStats.has(userId)) {
                userStats.set(userId, {
                    territoryCount: 0,
                    totalValue: 0,
                    totalPixels: 0,
                    countries: new Set(),
                    continents: new Set()
                });
            }
            
            const stats = userStats.get(userId);
            stats.territoryCount++;
            stats.totalValue += (territory.territoryValue || territory.purchasedPrice || 0);
            
            // 픽셀 수 계산
            const pixelCanvas = pixelCanvases[territoryId];
            if (pixelCanvas && pixelCanvas.filledPixels) {
                stats.totalPixels += pixelCanvas.filledPixels;
            }
            
            // 국가 추가
            if (territory.countryCode) {
                stats.countries.add(territory.countryCode);
            }
            
            // 대륙 추가
            if (territory.countryCode) {
                const continent = getContinent(territory.countryCode);
                if (continent) {
                    stats.continents.add(continent);
                }
            }
        }
        
        // 4. 랭킹 계산 및 저장
        const batch = db.batch();
        let processedCount = 0;
        
        for (const [userId, stats] of userStats) {
            // 패권 점수 계산
            const hegemonyScore = calculateHegemonyScore(stats);
            
            // 비정상 값 증가 감지
            const previousRankingRef = db.collection('rankings').doc(userId);
            const previousRankingDoc = await previousRankingRef.get();
            
            if (previousRankingDoc.exists) {
                const previous = previousRankingDoc.data();
                const valueIncrease = stats.totalValue / (previous.totalValue || 1);
                
                if (valueIncrease > 100) {
                    console.warn(`[Calculate Rankings] Suspicious value increase for user ${userId}: ${valueIncrease}x`);
                    await db.collection('suspicious_activities').add({
                        userId,
                        type: 'ranking_manipulation',
                        previousValue: previous.totalValue,
                        currentValue: stats.totalValue,
                        increase: valueIncrease,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
            
            // 랭킹 데이터 생성
            const ranking = {
                userId,
                territoryCount: stats.territoryCount || 0,
                totalValue: stats.totalValue || 0,
                totalPixels: stats.totalPixels || 0,
                totalViews: 0,
                countryCount: stats.countries ? stats.countries.size : 0,
                continentCount: stats.continents ? stats.continents.size : 0,
                countries: stats.countries ? Array.from(stats.countries) : [],
                continents: stats.continents ? Array.from(stats.continents) : [],
                globalCoverageIndex: hegemonyScore || 0,
                hegemonyScore: hegemonyScore || 0,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            batch.set(previousRankingRef, ranking, { merge: true });
            processedCount++;
            
            if (processedCount % 500 === 0) {
                await batch.commit();
                console.log(`[Calculate Rankings] Processed ${processedCount} rankings...`);
            }
        }
        
        if (processedCount % 500 !== 0) {
            await batch.commit();
        }
        
        console.log(`[Calculate Rankings] ✅ Completed. Processed ${processedCount} rankings.`);
        
        return {
            success: true,
            processed: processedCount
        };
        
    } catch (error) {
        console.error('[Calculate Rankings] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 만료된 영토 확인
 */
async function checkExpiredTerritories(db) {
    try {
        const now = admin.firestore.Timestamp.now();
        const nowDate = new Date();
        
        console.log('[Check Expired Territories] Starting check...');
        
        // 1. 1주일 고정 기간이 지난 영토 확인
        const oneWeekAgo = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneWeekAgoTimestamp = admin.firestore.Timestamp.fromDate(oneWeekAgo);
        
        const territoriesAfterOneWeek = await db.collection('territories')
            .where('initialProtectionEndsAt', '<=', oneWeekAgoTimestamp)
            .where('canBeChallenged', '==', false)
            .where('isPermanent', '==', false)
            .where('leaseEndsAt', '==', null)
            .limit(100)
            .get();
        
        let autoPermanentCount = 0;
        for (const doc of territoriesAfterOneWeek.docs) {
            const territory = doc.data();
            
            if (territory.currentAuction) {
                const auctionRef = db.collection('auctions').doc(territory.currentAuction);
                const auctionDoc = await auctionRef.get();
                
                if (auctionDoc.exists && auctionDoc.data().status === 'active') {
                    await doc.ref.update({
                        canBeChallenged: true,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    continue;
                }
            }
            
            await doc.ref.update({
                canBeChallenged: false,
                isPermanent: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            await db.collection('ownership_logs').add({
                territoryId: doc.id,
                type: 'auto_permanent',
                message: '1주일 고정 기간 종료, 입찰 없음으로 인해 무한 고정으로 전환',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            autoPermanentCount++;
        }
        
        // 2. 방치 감지
        const thirtyDaysAgo = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);
        
        const abandonedTerritories = await db.collection('territories')
            .where('isPermanent', '==', true)
            .where('lastActivityAt', '<', thirtyDaysAgoTimestamp)
            .where('leaseEndsAt', '==', null)
            .limit(100)
            .get();
        
        const filteredAbandoned = [];
        for (const doc of abandonedTerritories.docs) {
            const territory = doc.data();
            
            if (territory.initialProtectionEndsAt) {
                const protectionEndsAt = territory.initialProtectionEndsAt.toDate();
                if (nowDate < protectionEndsAt) {
                    continue;
                }
            }
            
            if (territory.currentAuction) {
                const auctionRef = db.collection('auctions').doc(territory.currentAuction);
                const auctionDoc = await auctionRef.get();
                if (auctionDoc.exists && auctionDoc.data().status === 'active') {
                    continue;
                }
            }
            
            filteredAbandoned.push(doc);
        }
        
        let abandonedCount = 0;
        for (const doc of filteredAbandoned) {
            const territory = doc.data();
            
            if (!territory.abandonedWarning) {
                await doc.ref.update({
                    abandonedWarning: true,
                    abandonedWarningAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                abandonedCount++;
            } else {
                const warningAt = territory.abandonedWarningAt?.toDate();
                if (warningAt) {
                    const sevenDaysAfterWarning = new Date(warningAt.getTime() + 7 * 24 * 60 * 60 * 1000);
                    if (nowDate >= sevenDaysAfterWarning) {
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
                            endsAt: admin.firestore.Timestamp.fromDate(new Date(nowDate.getTime() + 24 * 60 * 60 * 1000)),
                            reason: 'abandoned_auto_reauction'
                        });
                        
                        await doc.ref.update({
                            currentAuction: auctionRef.id,
                            canBeChallenged: true,
                            isPermanent: false,
                            abandonedWarning: false,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        
                        await db.collection('ownership_logs').add({
                            territoryId: doc.id,
                            type: 'auto_reauction',
                            reason: 'abandoned',
                            previousOwner: territory.ruler,
                            previousOwnerName: territory.rulerName,
                            message: '30일 이상 활동 없음으로 인해 자동 재경매 시작',
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                }
            }
        }
        
        // 3. 임대 기간 만료된 영토 확인
        const expiredLeases = await db.collection('territories')
            .where('leaseEndsAt', '<=', now)
            .where('leaseEndsAt', '!=', null)
            .where('isPermanent', '==', false)
            .limit(100)
            .get();
        
        let expiredLeaseCount = 0;
        for (const doc of expiredLeases.docs) {
            const territory = doc.data();
            
            await db.collection('ownership_logs').add({
                territoryId: doc.id,
                type: 'lease_expired',
                previousOwner: territory.ruler,
                previousOwnerName: territory.rulerName,
                leaseType: territory.leaseType,
                message: `임대 기간 만료 (${territory.leaseType})`,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
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
                endsAt: admin.firestore.Timestamp.fromDate(new Date(nowDate.getTime() + 24 * 60 * 60 * 1000)),
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
        }
        
        return {
            success: true,
            stats: {
                autoPermanentCount,
                abandonedCount,
                expiredLeaseCount
            }
        };
        
    } catch (error) {
        console.error('[Check Expired Territories] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 경매 종료 처리
 */
async function endAuctions(db) {
    try {
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
        
        return {
            success: true,
            processed: processedCount,
            errors: errorCount
        };
        
    } catch (error) {
        console.error('[End Auctions] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 시즌 전환
 */
async function seasonTransition(db) {
    try {
        const now = admin.firestore.Timestamp.now();
        const nowDate = new Date();
        
        console.log('[Season Transition] Starting check...');
        
        // 1. 종료된 시즌 찾기
        const endedSeasons = await db.collection('seasons')
            .where('status', '==', 'active')
            .where('endDate', '<=', now)
            .get();
        
        let transitionedCount = 0;
        
        for (const seasonDoc of endedSeasons.docs) {
            const season = seasonDoc.data();
            
            await seasonDoc.ref.update({
                status: 'ended',
                endedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            await calculateSeasonRankings(season.id, db);
            
            transitionedCount++;
        }
        
        // 2. 새 시즌 생성
        const activeSeasons = await db.collection('seasons')
            .where('status', '==', 'active')
            .get();
        
        if (activeSeasons.empty) {
            const seasonId = `season_${nowDate.getFullYear()}_${nowDate.getMonth() + 1}`;
            const endDate = new Date(nowDate.getFullYear(), nowDate.getMonth() + 2, 0);
            
            await db.collection('seasons').doc(seasonId).set({
                id: seasonId,
                type: 'monthly',
                name: `${nowDate.getFullYear()}년 ${nowDate.getMonth() + 1}월 시즌`,
                startDate: admin.firestore.Timestamp.fromDate(nowDate),
                endDate: admin.firestore.Timestamp.fromDate(endDate),
                status: 'active',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        return {
            success: true,
            transitionedSeasons: transitionedCount
        };
        
    } catch (error) {
        console.error('[Season Transition] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 시즌별 랭킹 계산
 */
async function calculateSeasonRankings(seasonId, db) {
    try {
        const seasonDoc = await db.collection('seasons').doc(seasonId).get();
        if (!seasonDoc.exists) return;
        
        const season = seasonDoc.data();
        const startDate = season.startDate;
        const endDate = season.endDate;
        
        if (!startDate || !endDate) {
            console.warn(`[Season Transition] Season ${seasonId} missing startDate or endDate`);
            return;
        }
        
        const ownershipLogsSnapshot = await db.collection('ownership_logs')
            .where('timestamp', '>=', startDate)
            .where('timestamp', '<=', endDate)
            .get();
        
        const ownershipLogs = ownershipLogsSnapshot.docs.map(doc => doc.data());
        
        const userScores = new Map();
        
        ownershipLogs.forEach(log => {
            const userId = log.newOwner;
            if (!userId) return;
            
            if (!userScores.has(userId)) {
                userScores.set(userId, {
                    userId,
                    userName: log.newOwnerName || 'Unknown',
                    territoryCount: 0,
                    pixelCount: 0,
                    totalValue: 0,
                    seasonScore: 0
                });
            }
            
            const score = userScores.get(userId);
            score.territoryCount++;
            score.totalValue += log.price || 0;
        });
        
        const startMillis = startDate.toMillis ? startDate.toMillis() : startDate;
        const endMillis = endDate.toMillis ? endDate.toMillis() : endDate;
        
        const pixelCanvasesSnapshot = await db.collection('pixelCanvases').get();
        
        const pixelCanvases = pixelCanvasesSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(canvas => {
                if (!canvas.lastUpdated) return false;
                const lastUpdatedMillis = canvas.lastUpdated.toMillis 
                    ? canvas.lastUpdated.toMillis() 
                    : (canvas.lastUpdated instanceof admin.firestore.Timestamp 
                        ? canvas.lastUpdated.toMillis() 
                        : canvas.lastUpdated);
                return lastUpdatedMillis >= startMillis && lastUpdatedMillis <= endMillis;
            });
        
        pixelCanvases.forEach(canvas => {
            const ownerId = canvas.ownerId || canvas.ruler;
            if (!ownerId || !userScores.has(ownerId)) return;
            
            const score = userScores.get(ownerId);
            score.pixelCount += canvas.filledPixels || 0;
        });
        
        userScores.forEach((score, userId) => {
            score.seasonScore = 
                score.territoryCount * 10 +
                Math.floor(score.pixelCount / 100) +
                Math.floor(score.totalValue / 100);
        });
        
        const rankings = Array.from(userScores.values())
            .sort((a, b) => b.seasonScore - a.seasonScore)
            .map((score, index) => ({
                ...score,
                rank: index + 1,
                seasonId
            }));
        
        const batch = db.batch();
        rankings.forEach((ranking) => {
            const rankingRef = db.collection('season_rankings').doc(`${seasonId}_${ranking.userId}`);
            batch.set(rankingRef, {
                ...ranking,
                seasonId,
                calculatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        
        await batch.commit();
        
        console.log(`[Season Transition] Calculated ${rankings.length} season rankings for ${seasonId}`);
    } catch (error) {
        console.error('[Season Transition] Failed to calculate season rankings:', error);
    }
}

/**
 * 패권 점수 계산
 */
function calculateHegemonyScore(stats) {
    const territoryScore = (stats.territoryCount || 0) * 100;
    const valueScore = stats.totalValue || 0;
    const pixelScore = (stats.totalPixels || 0) * 1;
    const countryBonus = (stats.countries ? stats.countries.size : 0) * 500;
    const continentBonus = (stats.continents ? stats.continents.size : 0) * 1000;
    
    return territoryScore + valueScore + pixelScore + countryBonus + continentBonus;
}

/**
 * 국가 코드로 대륙 반환
 */
function getContinent(countryCode) {
    const continentMap = {
        'kr': 'asia', 'jp': 'asia', 'cn': 'asia', 'in': 'asia', 'sg': 'asia',
        'uk': 'europe', 'fr': 'europe', 'de': 'europe', 'it': 'europe', 'es': 'europe',
        'us': 'north-america', 'ca': 'north-america', 'mx': 'north-america',
        'br': 'south-america', 'ar': 'south-america', 'cl': 'south-america',
        'za': 'africa', 'eg': 'africa', 'ng': 'africa',
        'au': 'oceania', 'nz': 'oceania'
    };
    
    return continentMap[countryCode?.toLowerCase()] || null;
}

