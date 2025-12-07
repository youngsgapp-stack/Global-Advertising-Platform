/**
 * Ranking Calculation Cron Job
 * Vercel Serverless Function (Cron)
 * 
 * 주기적으로 랭킹을 재계산하여 Firestore에 저장합니다.
 * 원천 데이터(territories, wallets, pixelCanvases)만 신뢰합니다.
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

// 대륙 결정 헬퍼 함수
function getContinent(countryCode) {
    const continentMap = {
        // 북미
        'US': 'north_america', 'CA': 'north_america', 'MX': 'north_america',
        // 남미
        'BR': 'south_america', 'AR': 'south_america',
        // 유럽
        'DE': 'europe', 'FR': 'europe', 'GB': 'europe', 'IT': 'europe', 
        'ES': 'europe', 'NL': 'europe', 'PL': 'europe', 'BE': 'europe',
        'SE': 'europe', 'AT': 'europe', 'DK': 'europe', 'FI': 'europe',
        'IE': 'europe', 'PT': 'europe', 'GR': 'europe', 'CZ': 'europe',
        'RO': 'europe', 'HU': 'europe', 'BG': 'europe',
        // 아시아
        'CN': 'asia', 'JP': 'asia', 'KR': 'asia', 'IN': 'asia',
        'ID': 'asia', 'SA': 'asia', 'TR': 'asia', 'RU': 'asia',
        // 오세아니아
        'AU': 'oceania',
        // 아프리카
        'ZA': 'africa'
    };
    
    return continentMap[countryCode] || null;
}

// 패권 점수 계산
function calculateHegemonyScore(stats) {
    const TERRITORY_SCORE = 100;
    const PIXEL_SCORE = 1;
    const COUNTRY_DOMINATION = 500;
    const CONTINENT_DOMINATION = 1000;
    
    let score = 0;
    
    // 영토 수 점수
    score += stats.territoryCount * TERRITORY_SCORE;
    
    // 총 가치 점수
    score += stats.totalValue || 0;
    
    // 픽셀 점수
    score += (stats.totalPixels || 0) * PIXEL_SCORE;
    
    // 국가 지배 보너스
    score += stats.countries.size * COUNTRY_DOMINATION;
    
    // 대륙 보너스
    score += stats.continents.size * CONTINENT_DOMINATION;
    
    return score;
}

// 비정상적인 값 증가 감지
function detectAnomaly(currentStats, previousStats) {
    if (!previousStats) return false;
    
    // 가치가 5분 사이 100배 이상 증가하면 비정상
    if (currentStats.totalValue > previousStats.totalValue * 100) {
        return true;
    }
    
    // 영토 수가 비정상적으로 급증
    if (currentStats.territoryCount > previousStats.territoryCount + 50) {
        return true;
    }
    
    return false;
}

export default async function handler(req, res) {
    // Cron 요청 검증 (Vercel Cron은 특정 헤더를 보냄)
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
        
        console.log('[Ranking] Starting ranking calculation...');
        
        // 1. 원천 데이터 수집: territories
        const territoriesSnapshot = await firestore.collection('territories')
            .where('ruler', '!=', null)
            .get();
        
        const userStats = new Map();
        
        // 사용자별 통계 집계
        for (const doc of territoriesSnapshot.docs) {
            const territory = doc.data();
            const userId = territory.ruler;
            
            if (!userId) continue;
            
            if (!userStats.has(userId)) {
                userStats.set(userId, {
                    userId,
                    territoryCount: 0,
                    totalValue: 0,
                    totalPixels: 0,
                    totalViews: 0,
                    countries: new Set(),
                    continents: new Set()
                });
            }
            
            const stats = userStats.get(userId);
            stats.territoryCount++;
            stats.totalValue += territory.territoryValue || territory.purchasedPrice || 0;
            stats.totalViews += territory.viewCount || 0;
            
            // 국가 코드 추가
            if (territory.countryCode) {
                stats.countries.add(territory.countryCode);
                const continent = getContinent(territory.countryCode);
                if (continent) {
                    stats.continents.add(continent);
                }
            }
        }
        
        // 2. 원천 데이터 수집: pixelCanvases (픽셀 수)
        const pixelCanvasesSnapshot = await firestore.collection('pixelCanvases').get();
        
        for (const doc of pixelCanvasesSnapshot.docs) {
            const canvas = doc.data();
            const territoryId = canvas.territoryId;
            
            // 해당 영토의 소유자 찾기
            const territoryDoc = await firestore.collection('territories').doc(territoryId).get();
            if (!territoryDoc.exists) continue;
            
            const territory = territoryDoc.data();
            const userId = territory.ruler;
            
            if (!userId || !userStats.has(userId)) continue;
            
            // 픽셀 수 계산
            const pixelData = canvas.pixelData || {};
            let filledPixels = 0;
            for (const key in pixelData) {
                if (pixelData[key] !== null && pixelData[key] !== undefined) {
                    filledPixels++;
                }
            }
            
            userStats.get(userId).totalPixels += filledPixels;
        }
        
        // 3. 랭킹 계산 및 저장
        const batch = firestore.batch();
        const rankingsToSave = [];
        const anomalies = [];
        
        for (const [userId, stats] of userStats) {
            // 이전 랭킹 데이터 가져오기 (비정상 감지용)
            let previousRanking = null;
            try {
                const prevRankingDoc = await firestore.collection('rankings').doc(userId).get();
                if (prevRankingDoc.exists) {
                    previousRanking = prevRankingDoc.data();
                }
            } catch (error) {
                // 이전 랭킹이 없으면 무시
            }
            
            const hegemonyScore = calculateHegemonyScore(stats);
            
            // 비정상 감지
            if (previousRanking) {
                const currentStats = {
                    totalValue: stats.totalValue,
                    territoryCount: stats.territoryCount
                };
                const prevStats = {
                    totalValue: previousRanking.totalValue || 0,
                    territoryCount: previousRanking.territoryCount || 0
                };
                
                if (detectAnomaly(currentStats, prevStats)) {
                    anomalies.push({
                        userId,
                        currentStats,
                        previousStats: prevStats
                    });
                    console.warn('[Ranking] Anomaly detected for user:', userId);
                    // 비정상인 경우 랭킹 반영 보류 (관리자 리뷰 필요)
                    continue;
                }
            }
            
            const ranking = {
                userId,
                territoryCount: stats.territoryCount || 0,
                totalValue: stats.totalValue || 0,
                totalPixels: stats.totalPixels || 0,
                totalViews: stats.totalViews || 0,
                countryCount: stats.countries.size || 0,
                continentCount: stats.continents.size || 0,
                countries: Array.from(stats.countries),
                continents: Array.from(stats.continents),
                globalCoverageIndex: hegemonyScore,
                hegemonyScore: hegemonyScore, // 하위 호환성
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                calculatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            rankingsToSave.push({ userId, ranking });
            
            // 배치에 추가
            const rankingRef = firestore.collection('rankings').doc(userId);
            batch.set(rankingRef, ranking);
        }
        
        // 배치 커밋
        await batch.commit();
        
        console.log('[Ranking] ✅ Rankings calculated and saved:', {
            totalUsers: rankingsToSave.length,
            anomalies: anomalies.length
        });
        
        // 비정상 케이스가 있으면 로그에 기록
        if (anomalies.length > 0) {
            console.warn('[Ranking] Anomalies detected:', anomalies);
            // TODO: 관리자에게 알림 (Slack/Email)
        }
        
        return res.status(200).json({
            success: true,
            message: 'Rankings calculated successfully',
            totalUsers: rankingsToSave.length,
            anomalies: anomalies.length
        });
        
    } catch (error) {
        console.error('[Ranking] ❌ Error calculating rankings:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
}

