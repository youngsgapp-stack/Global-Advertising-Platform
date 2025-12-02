/**
 * RankingSystem - 랭킹 및 패권 시스템
 * 사용자/영토 랭킹, 국가 점령도, 세계 패권 보드
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager } from '../core/TerritoryManager.js';

// 랭킹 타입
export const RANKING_TYPE = {
    TERRITORY_COUNT: 'territory_count',   // 영토 수
    TOTAL_VALUE: 'total_value',           // 총 가치
    PIXEL_COVERAGE: 'pixel_coverage',     // 픽셀 점유율
    HEGEMONY: 'hegemony'                  // 패권 점수
};

class RankingSystem {
    constructor() {
        this.rankings = new Map();
        this.hegemonyBoard = [];
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
            const rankingsData = await firebaseService.queryCollection('rankings', [], 
                { field: 'hegemonyScore', direction: 'desc' },
                100
            );
            
            for (const ranking of rankingsData) {
                this.rankings.set(ranking.userId, ranking);
            }
            
            this.hegemonyBoard = rankingsData.slice(0, 10);
            
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
                        countries: new Set(),
                        continents: new Set()
                    });
                }
                
                const stats = userStats.get(userId);
                stats.territoryCount++;
                stats.totalValue += territory.territoryValue || 0;
                stats.totalPixels += territory.pixelCanvas?.filledPixels || 0;
                stats.countries.add(territory.countryCode);
                
                // 대륙 추가 (국가 코드 기반)
                const continent = this.getContinent(territory.countryCode);
                if (continent) stats.continents.add(continent);
            }
            
            // 패권 점수 계산 및 저장
            for (const [userId, stats] of userStats) {
                const hegemonyScore = this.calculateHegemonyScore(stats);
                
                // Set을 배열로 변환 (Firestore 호환성)
                const ranking = {
                    userId,
                    territoryCount: stats.territoryCount,
                    totalValue: stats.totalValue,
                    totalPixels: stats.totalPixels,
                    countryCount: stats.countries.size,
                    continentCount: stats.continents.size,
                    countries: Array.from(stats.countries), // Set을 배열로 변환
                    continents: Array.from(stats.continents), // Set을 배열로 변환
                    hegemonyScore,
                    updatedAt: new Date()
                };
                
                this.rankings.set(userId, ranking);
                
                // Firestore 저장 (비동기)
                firebaseService.setDocument('rankings', userId, ranking).catch(err => {
                    log.warn('Failed to save ranking:', err);
                });
            }
            
            // 패권 보드 업데이트
            this.updateHegemonyBoard();
            
            // 이벤트 발행
            eventBus.emit(EVENTS.RANKING_UPDATE, {
                hegemonyBoard: this.hegemonyBoard
            });
        } catch (error) {
            log.error('Failed to update rankings:', error);
        } finally {
            this.isUpdating = false;
        }
    }
    
    /**
     * 패권 점수 계산
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
     * 패권 보드 업데이트
     */
    updateHegemonyBoard() {
        const allRankings = Array.from(this.rankings.values());
        
        // 패권 점수 기준 정렬
        allRankings.sort((a, b) => b.hegemonyScore - a.hegemonyScore);
        
        // Top 10
        this.hegemonyBoard = allRankings.slice(0, 10);
        
        // 순위 부여
        this.hegemonyBoard.forEach((entry, index) => {
            entry.rank = index + 1;
        });
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
     * 패권 보드 가져오기
     */
    getHegemonyBoard() {
        return this.hegemonyBoard;
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
            case RANKING_TYPE.HEGEMONY:
            default:
                allRankings.sort((a, b) => b.hegemonyScore - a.hegemonyScore);
        }
        
        return allRankings.slice(0, limit).map((entry, index) => ({
            ...entry,
            rank: index + 1
        }));
    }
    
    /**
     * 사용자 순위 (전체 중)
     */
    getUserGlobalRank(userId) {
        const sortedRankings = Array.from(this.rankings.values())
            .sort((a, b) => b.hegemonyScore - a.hegemonyScore);
        
        const index = sortedRankings.findIndex(r => r.userId === userId);
        return index === -1 ? null : index + 1;
    }
}

// 싱글톤 인스턴스
export const rankingSystem = new RankingSystem();
export default rankingSystem;

