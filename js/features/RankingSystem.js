/**
 * RankingSystem - 광고/아트/소유 플랫폼 랭킹 시스템
 * Top Spaces, Top Owners, Global Coverage Index
 * 게임 랭킹이 아닌 "디스커버리 & 큐레이션" 도구
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';
import { territoryManager } from '../core/TerritoryManager.js';

// 랭킹 타입 (광고/아트 플랫폼 언어로 재브랜딩)
export const RANKING_TYPE = {
    TERRITORY_COUNT: 'territory_count',   // Top Collectors
    TOTAL_VALUE: 'total_value',           // Top Investors
    PIXEL_COVERAGE: 'pixel_coverage',      // Largest Galleries
    GLOBAL_COVERAGE: 'global_coverage',    // Global Coverage Index (기존 Hegemony)
    MOST_VIEWED: 'most_viewed'             // Most Viewed Spaces (트래픽 랭킹)
};

class RankingSystem {
    constructor() {
        this.rankings = new Map();
        this.globalCoverageBoard = []; // 기존 hegemonyBoard → globalCoverageBoard
        this.countryOccupation = new Map();
        this.isUpdating = false; // 무한 재귀 방지 플래그
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 랭킹 데이터 로드
            await this.loadRankings();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('RankingSystem initialized');
            return true;
            
        } catch (error) {
            log.error('RankingSystem initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 영토 정복 시 랭킹 업데이트
        eventBus.on(EVENTS.TERRITORY_CONQUERED, () => {
            this.updateAllRankings();
        });
        
        // 픽셀 가치 변경 시
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, () => {
            this.updateAllRankings();
        });
    }
    
    /**
     * 랭킹 데이터 로드
     */
    async loadRankings() {
        try {
            // TODO: API에 랭킹 엔드포인트가 있으면 사용
            // 현재는 랭킹 데이터가 API에 없으므로 빈 배열로 처리
            // 백엔드에 `/api/rankings` 엔드포인트 추가 필요
            log.warn('[RankingSystem] loadRankings is not yet supported via API, using empty array');
            const rankingsData = [];
            
            for (const ranking of rankingsData) {
                // API 응답 형식 변환
                const rankingData = {
                    userId: ranking.userId,
                    nickname: ranking.nickname,
                    territoryCount: ranking.territoryCount || 0,
                    totalValue: ranking.totalValue || 0,
                    hegemonyScore: ranking.hegemonyScore || ranking.territoryCount * 100,
                    rank: ranking.rank
                };
                this.rankings.set(ranking.userId, rankingData);
            }
            
            this.globalCoverageBoard = rankingsData.slice(0, 10);
            
            log.info(`Loaded ${rankingsData.length} ranking entries`);
            
        } catch (error) {
            log.warn('Failed to load rankings:', error);
        }
    }
    
    /**
     * 모든 랭킹 업데이트
     */
    async updateAllRankings() {
        // 이미 업데이트 중이면 스킵 (무한 재귀 방지)
        if (this.isUpdating) {
            log.debug('RankingSystem: Update already in progress, skipping');
            return;
        }
        
        this.isUpdating = true;
        
        try {
            const territories = territoryManager.getAllTerritories();
            const userStats = new Map();
            
            // 사용자별 통계 집계
            for (const territory of territories) {
                if (!territory.ruler) continue;
                
                const userId = territory.ruler;
                
                if (!userStats.has(userId)) {
                    userStats.set(userId, {
                        userId,
                        territoryCount: 0,
                        totalValue: 0,
                        totalPixels: 0,
                        totalViews: 0, // 조회수 합계 추가
                        countries: new Set(),
                        continents: new Set()
                    });
                }
                
                const stats = userStats.get(userId);
                stats.territoryCount++;
                stats.totalValue += territory.territoryValue || 0;
                stats.totalPixels += territory.pixelCanvas?.filledPixels || 0;
                stats.totalViews += territory.viewCount || 0; // 조회수 합계
                stats.countries.add(territory.countryCode);
                
                // 대륙 추가 (국가 코드 기반)
                const continent = this.getContinent(territory.countryCode);
                if (continent) stats.continents.add(continent);
            }
            
            // 패권 점수 계산 및 저장
            for (const [userId, stats] of userStats) {
                const hegemonyScore = this.calculateHegemonyScore(stats);
                
                // Set을 배열로 변환 (Firestore 호환성)
                // undefined 값 방지를 위해 기본값 설정
                const ranking = {
                    userId,
                    territoryCount: stats.territoryCount || 0,
                    totalValue: stats.totalValue || 0,
                    totalPixels: stats.totalPixels || 0,
                    totalViews: stats.totalViews || 0, // 조회수 합계 추가
                    countryCount: stats.countries ? stats.countries.size : 0,
                    continentCount: stats.continents ? stats.continents.size : 0,
                    countries: stats.countries ? Array.from(stats.countries) : [], // Set을 배열로 변환
                    continents: stats.continents ? Array.from(stats.continents) : [], // Set을 배열로 변환
                    globalCoverageIndex: hegemonyScore || 0, // hegemonyScore → globalCoverageIndex
                    hegemonyScore: hegemonyScore || 0, // 하위 호환성 유지
                    updatedAt: new Date()
                };
                
                this.rankings.set(userId, ranking);
                
                // ⚠️ 핵심 수정: Firestore 대신 API 사용 (또는 제거)
                // 랭킹은 백엔드에서 자동으로 계산되므로 클라이언트에서 저장할 필요 없음
                // 필요시 백엔드 API를 통해 랭킹 업데이트
                // firebaseService.setDocument('rankings', userId, ranking).catch(err => {
                //     log.warn('Failed to save ranking:', err);
                // });
            }
            
            // Global Coverage 보드 업데이트
            this.updateGlobalCoverageBoard();
            
            // 이벤트 발행
            eventBus.emit(EVENTS.RANKING_UPDATE, {
                globalCoverageBoard: this.globalCoverageBoard,
                hegemonyBoard: this.globalCoverageBoard // 하위 호환성 유지
            });
        } catch (error) {
            log.error('Failed to update rankings:', error);
        } finally {
            this.isUpdating = false;
        }
    }
    
    /**
     * Global Coverage Index 계산
     * (기존 패권 점수, 광고/아트 플랫폼 언어로 재브랜딩)
     * 전세계 주요 지역에 얼마나 고르게 노출되고 있는지 나타내는 지표
     */
    calculateHegemonyScore(stats) {
        let score = 0;
        
        // 영토 수 점수
        score += stats.territoryCount * CONFIG.RANKING.TERRITORY_SCORE;
        
        // 총 가치 점수
        score += stats.totalValue;
        
        // 픽셀 점수
        score += stats.totalPixels * CONFIG.RANKING.PIXEL_SCORE;
        
        // 국가 지배 보너스
        score += stats.countries.size * CONFIG.RANKING.COUNTRY_DOMINATION;
        
        // 대륙 보너스
        score += stats.continents.size * CONFIG.RANKING.CONTINENT_DOMINATION;
        
        return score;
    }
    
    /**
     * Global Coverage 보드 업데이트
     * (기존 패권 보드, 광고/아트 플랫폼 언어로 재브랜딩)
     */
    updateGlobalCoverageBoard() {
        const allRankings = Array.from(this.rankings.values());
        
        // Global Coverage Index 기준 정렬
        allRankings.sort((a, b) => (b.globalCoverageIndex || b.hegemonyScore) - (a.globalCoverageIndex || a.hegemonyScore));
        
        // Top 10
        this.globalCoverageBoard = allRankings.slice(0, 10);
        
        // 순위 부여
        this.globalCoverageBoard.forEach((entry, index) => {
            entry.rank = index + 1;
        });
    }
    
    /**
     * 하위 호환성: 패권 보드 가져오기 (기존 코드 호환)
     */
    getHegemonyBoard() {
        return this.globalCoverageBoard;
    }
    
    /**
     * 국가별 점령도 계산
     */
    calculateCountryOccupation() {
        const territories = territoryManager.getAllTerritories();
        const countryStats = new Map();
        
        for (const territory of territories) {
            const countryCode = territory.countryCode;
            
            if (!countryStats.has(countryCode)) {
                countryStats.set(countryCode, {
                    total: 0,
                    occupied: 0,
                    rulers: new Map()
                });
            }
            
            const stats = countryStats.get(countryCode);
            stats.total++;
            
            if (territory.ruler) {
                stats.occupied++;
                
                const rulerCount = stats.rulers.get(territory.ruler) || 0;
                stats.rulers.set(territory.ruler, rulerCount + 1);
            }
        }
        
        // 점령도 및 최다 점유자 계산
        for (const [countryCode, stats] of countryStats) {
            const percentage = Math.round((stats.occupied / stats.total) * 100);
            
            // 최다 점유자 찾기
            let topRuler = null;
            let topCount = 0;
            for (const [ruler, count] of stats.rulers) {
                if (count > topCount) {
                    topRuler = ruler;
                    topCount = count;
                }
            }
            
            this.countryOccupation.set(countryCode, {
                total: stats.total,
                occupied: stats.occupied,
                percentage,
                topRuler,
                topRulerCount: topCount,
                topRulerPercentage: Math.round((topCount / stats.total) * 100)
            });
        }
        
        return this.countryOccupation;
    }
    
    /**
     * 대륙 결정
     */
    getContinent(countryCode) {
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
    
    /**
     * 사용자 랭킹 가져오기
     */
    getUserRanking(userId) {
        return this.rankings.get(userId);
    }
    
    /**
     * Global Coverage 보드 가져오기
     */
    getGlobalCoverageBoard() {
        return this.globalCoverageBoard;
    }
    
    /**
     * 국가 점령도 가져오기
     */
    getCountryOccupation(countryCode) {
        if (!this.countryOccupation.has(countryCode)) {
            this.calculateCountryOccupation();
        }
        return this.countryOccupation.get(countryCode);
    }
    
    /**
     * 모든 국가 점령도
     */
    getAllCountryOccupations() {
        this.calculateCountryOccupation();
        return Object.fromEntries(this.countryOccupation);
    }
    
    /**
     * 특정 타입별 랭킹
     */
    getRankingByType(type, limit = 10) {
        const allRankings = Array.from(this.rankings.values());
        
        switch (type) {
            case RANKING_TYPE.TERRITORY_COUNT:
                allRankings.sort((a, b) => b.territoryCount - a.territoryCount);
                break;
            case RANKING_TYPE.TOTAL_VALUE:
                allRankings.sort((a, b) => b.totalValue - a.totalValue);
                break;
            case RANKING_TYPE.PIXEL_COVERAGE:
                allRankings.sort((a, b) => b.totalPixels - a.totalPixels);
                break;
            case RANKING_TYPE.GLOBAL_COVERAGE:
            default:
                allRankings.sort((a, b) => (b.globalCoverageIndex || b.hegemonyScore) - (a.globalCoverageIndex || a.hegemonyScore));
        }
        
        return allRankings.slice(0, limit).map((entry, index) => ({
            ...entry,
            rank: index + 1
        }));
    }
    
    /**
     * 사용자 순위 (전체 중)
     * Global Coverage Index 기준
     */
    getUserGlobalRank(userId) {
        const sortedRankings = Array.from(this.rankings.values())
            .sort((a, b) => (b.globalCoverageIndex || b.hegemonyScore) - (a.globalCoverageIndex || a.hegemonyScore));
        
        const index = sortedRankings.findIndex(r => r.userId === userId);
        return index === -1 ? null : index + 1;
    }
    
    /**
     * 사용자 순위 퍼센트 (상위 몇 %)
     */
    getUserRankPercentile(userId) {
        const allRankings = Array.from(this.rankings.values());
        if (allRankings.length === 0) return null;
        
        const sortedRankings = allRankings
            .sort((a, b) => (b.globalCoverageIndex || b.hegemonyScore) - (a.globalCoverageIndex || a.hegemonyScore));
        
        const index = sortedRankings.findIndex(r => r.userId === userId);
        if (index === -1) return null;
        
        // 상위 몇 % 계산 (낮을수록 좋음, 1위 = 상위 0%)
        const percentile = ((index + 1) / allRankings.length) * 100;
        return Math.round(percentile * 10) / 10; // 소수점 1자리
    }
    
    /**
     * 영토별 조회수 랭킹 (영토 기준, 사용자 기준 아님)
     * Most Viewed Spaces - 가장 많이 본 영토 목록
     */
    async getMostViewedTerritories(limit = 10) {
        try {
            log.debug('[RankingSystem] Fetching most viewed territories...');
            
            // API를 사용하여 모든 영토를 가져와서 클라이언트에서 필터링/정렬
            let territories = [];
            try {
                // 모든 영토 가져오기
                const allTerritories = await apiService.getTerritories({
                    limit: 10000 // 모든 영토 조회
                });
                
                // viewCount가 있는 것만 필터링하고 정렬
                territories = allTerritories
                    .filter(t => (t.viewCount || 0) > 0)
                    .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
                    .slice(0, limit);
                
                log.debug('[RankingSystem] Found territories via alternative method:', territories.length);
            } catch (altError) {
                log.error('[RankingSystem] Alternative method also failed:', altError);
                // TerritoryManager에서 메모리 캐시 사용
                const cachedTerritories = territoryManager.getAllTerritories();
                territories = Array.from(cachedTerritories.values())
                    .filter(t => (t.viewCount || 0) > 0)
                    .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
                    .slice(0, limit)
                    .map(t => ({
                        id: t.id,
                        ...t
                    }));
                log.debug('[RankingSystem] Using cached territories:', territories.length);
            }
            
            if (territories.length === 0) {
                log.info('[RankingSystem] No territories with viewCount found');
                return [];
            }
            
            return territories.map((territory, index) => ({
                territoryId: territory.id || territory.territoryId,
                territoryName: territory.name?.en || territory.name?.ko || territory.name?.local || territory.id,
                countryCode: territory.countryCode || territory.country,
                viewCount: territory.viewCount || 0,
                ruler: territory.ruler || null,
                rulerName: territory.rulerName || null,
                rank: index + 1
            }));
        } catch (error) {
            log.error('[RankingSystem] Failed to get most viewed territories:', error);
            return [];
        }
    }
}

// 싱글톤 인스턴스
export const rankingSystem = new RankingSystem();
export default rankingSystem;

