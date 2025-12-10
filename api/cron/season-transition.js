/**
 * 시즌 전환 Cron Job
 * Vercel Cron Job
 * 
 * 시즌 종료 시 자동으로 새 시즌을 시작하고, 시즌별 랭킹을 계산합니다.
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
        console.error('[Season Transition] Failed to initialize Firebase Admin:', error);
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
        
        console.log('[Season Transition] Starting check...');
        
        // 1. 종료된 시즌 찾기
        const endedSeasons = await db.collection('seasons')
            .where('status', '==', 'active')
            .where('endDate', '<=', now)
            .get();
        
        let transitionedCount = 0;
        
        for (const seasonDoc of endedSeasons.docs) {
            const season = seasonDoc.data();
            
            // 시즌 종료 처리
            await seasonDoc.ref.update({
                status: 'ended',
                endedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // 시즌별 최종 랭킹 계산 및 저장
            await calculateSeasonRankings(season.id, db);
            
            console.log(`[Season Transition] Season ${season.id} ended`);
            transitionedCount++;
        }
        
        // 2. 새 시즌 생성 (활성 시즌이 없으면)
        const activeSeasons = await db.collection('seasons')
            .where('status', '==', 'active')
            .get();
        
        if (activeSeasons.empty) {
            // 새 시즌 생성
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
            
            console.log(`[Season Transition] Created new season: ${seasonId}`);
        }
        
        const result = {
            success: true,
            timestamp: nowDate.toISOString(),
            transitionedSeasons: transitionedCount
        };
        
        console.log('[Season Transition] Completed:', result);
        
        return res.status(200).json(result);
        
    } catch (error) {
        console.error('[Season Transition] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

/**
 * 시즌별 랭킹 계산
 */
async function calculateSeasonRankings(seasonId, db) {
    try {
        // 시즌 기간 동안의 영토 소유 및 픽셀 아트 데이터 수집
        const seasonDoc = await db.collection('seasons').doc(seasonId).get();
        if (!seasonDoc.exists) return;
        
        const season = seasonDoc.data();
        const startDate = season.startDate;
        const endDate = season.endDate;
        
        if (!startDate || !endDate) {
            console.warn(`[Season Transition] Season ${seasonId} missing startDate or endDate`);
            return;
        }
        
        // 시즌 기간 동안의 소유권 변경 로그 수집
        const ownershipLogsSnapshot = await db.collection('ownership_logs')
            .where('timestamp', '>=', startDate)
            .where('timestamp', '<=', endDate)
            .get();
        
        const ownershipLogs = ownershipLogsSnapshot.docs.map(doc => doc.data());
        
        // 사용자별 점수 계산
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
        
        // 픽셀 아트 데이터 수집
        // lastUpdated는 Timestamp이거나 숫자일 수 있으므로 둘 다 처리
        const startMillis = startDate.toMillis ? startDate.toMillis() : startDate;
        const endMillis = endDate.toMillis ? endDate.toMillis() : endDate;
        
        const pixelCanvasesSnapshot = await db.collection('pixelCanvases')
            .get();
        
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
        
        // 시즌 점수 계산 (영토 수 * 10 + 픽셀 수 / 100 + 가치 / 100)
        userScores.forEach((score, userId) => {
            score.seasonScore = 
                score.territoryCount * 10 +
                Math.floor(score.pixelCount / 100) +
                Math.floor(score.totalValue / 100);
        });
        
        // 랭킹 저장
        const rankings = Array.from(userScores.values())
            .sort((a, b) => b.seasonScore - a.seasonScore)
            .map((score, index) => ({
                ...score,
                rank: index + 1,
                seasonId
            }));
        
        // Firestore에 저장
        const batch = db.batch();
        rankings.forEach((ranking, index) => {
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

