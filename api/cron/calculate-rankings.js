/**
 * 랭킹 계산 Cron Job
 * Vercel Cron Job (15분 주기)
 * 
 * 서버에서 주기적으로 랭킹을 계산하여 Firestore에 저장합니다.
 * - 원천 데이터만 신뢰 (territories, pixelCanvases)
 * - 비정상 값 증가 감지
 * - 서버 전용 쓰기
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
        console.error('[Calculate Rankings] Failed to initialize Firebase Admin:', error);
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
            
            // 대륙 추가 (간단한 매핑)
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
            
            // 비정상 값 증가 감지 (이전 랭킹과 비교)
            const previousRankingRef = db.collection('rankings').doc(userId);
            const previousRankingDoc = await previousRankingRef.get();
            
            if (previousRankingDoc.exists) {
                const previous = previousRankingDoc.data();
                const valueIncrease = stats.totalValue / (previous.totalValue || 1);
                
                // 5분 사이 가치가 100배 이상 증가하면 의심
                if (valueIncrease > 100) {
                    console.warn(`[Calculate Rankings] Suspicious value increase for user ${userId}: ${valueIncrease}x`);
                    // 관리자 리뷰 대상에 추가 (별도 컬렉션)
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
                totalViews: 0, // 조회수는 별도로 관리
                countryCount: stats.countries ? stats.countries.size : 0,
                continentCount: stats.continents ? stats.continents.size : 0,
                countries: stats.countries ? Array.from(stats.countries) : [],
                continents: stats.continents ? Array.from(stats.continents) : [],
                globalCoverageIndex: hegemonyScore || 0,
                hegemonyScore: hegemonyScore || 0, // 하위 호환성
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            // Firestore에 저장
            batch.set(previousRankingRef, ranking, { merge: true });
            processedCount++;
            
            // 배치 크기 제한 (500개)
            if (processedCount % 500 === 0) {
                await batch.commit();
                console.log(`[Calculate Rankings] Processed ${processedCount} rankings...`);
            }
        }
        
        // 남은 배치 커밋
        if (processedCount % 500 !== 0) {
            await batch.commit();
        }
        
        console.log(`[Calculate Rankings] ✅ Completed. Processed ${processedCount} rankings.`);
        
        return res.status(200).json({
            success: true,
            processed: processedCount,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[Calculate Rankings] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
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
 * 국가 코드로 대륙 반환 (간단한 매핑)
 */
function getContinent(countryCode) {
    const continentMap = {
        // 아시아
        'kr': 'asia', 'jp': 'asia', 'cn': 'asia', 'in': 'asia', 'sg': 'asia',
        // 유럽
        'uk': 'europe', 'fr': 'europe', 'de': 'europe', 'it': 'europe', 'es': 'europe',
        // 북미
        'us': 'north-america', 'ca': 'north-america', 'mx': 'north-america',
        // 남미
        'br': 'south-america', 'ar': 'south-america', 'cl': 'south-america',
        // 아프리카
        'za': 'africa', 'eg': 'africa', 'ng': 'africa',
        // 오세아니아
        'au': 'oceania', 'nz': 'oceania'
    };
    
    return continentMap[countryCode?.toLowerCase()] || null;
}

