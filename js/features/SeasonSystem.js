/**
 * SeasonSystem - 시즌 시스템
 * 고래 유저 대응 및 맵 활성화를 위한 시즌제 시스템
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';

// 시즌 타입
export const SEASON_TYPE = {
    MONTHLY: 'monthly',   // 월별 시즌
    QUARTERLY: 'quarterly', // 분기별 시즌
    SPECIAL: 'special'    // 특별 이벤트 시즌
};

class SeasonSystem {
    constructor() {
        this.currentSeason = null;
        this.seasonHistory = [];
        this.MAX_TERRITORIES_PER_USER = 50; // 사용자당 최대 소유 영토 수 (고래 유저 대응)
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            await this.loadCurrentSeason();
            this.setupEventListeners();
            log.info('SeasonSystem initialized');
            return true;
        } catch (error) {
            log.error('SeasonSystem initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 영토 구매 시 소유 제한 체크
        eventBus.on(EVENTS.TERRITORY_OWNERSHIP_TRANSFERRED, ({ userId }) => {
            this.checkOwnershipLimit(userId);
        });
    }
    
    /**
     * 현재 시즌 로드
     */
    async loadCurrentSeason() {
        try {
            const now = new Date();
            
            // 현재 활성 시즌 찾기
            // TODO: 시즌 API 엔드포인트가 있으면 사용
            // 현재는 빈 배열로 처리 (나중에 `/api/seasons` 엔드포인트 추가 가능)
            log.warn('[SeasonSystem] Seasons query is not yet supported via API');
            const seasons = []; // await apiService.get('/seasons');
            
            if (seasons && seasons.length > 0) {
                this.currentSeason = seasons[0];
            } else {
                // 시즌이 없으면 새로 생성
                await this.createNewSeason();
            }
            
            log.info(`Current season: ${this.currentSeason?.id || 'None'}`);
        } catch (error) {
            log.warn('Failed to load current season:', error);
        }
    }
    
    /**
     * 새 시즌 생성
     */
    async createNewSeason() {
        try {
            const now = new Date();
            const seasonId = `season_${now.getFullYear()}_${now.getMonth() + 1}`;
            
            // 다음 달 말일 계산
            const endDate = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            
            const season = {
                id: seasonId,
                type: SEASON_TYPE.MONTHLY,
                name: `${now.getFullYear()}년 ${now.getMonth() + 1}월 시즌`,
                startDate: now,
                endDate: endDate,
                status: 'active',
                createdAt: now
            };
            
            await firebaseService.setDocument('seasons', seasonId, season);
            this.currentSeason = season;
            
            log.info(`[SeasonSystem] Created new season: ${seasonId}`);
        } catch (error) {
            log.error('[SeasonSystem] Failed to create new season:', error);
        }
    }
    
    /**
     * 소유 제한 체크 (고래 유저 대응)
     */
    async checkOwnershipLimit(userId) {
        try {
            // 사용자가 소유한 영토 수 확인
            // TODO: 필터링이 필요한 경우 API 엔드포인트 수정 필요
            const allTerritories = await apiService.getTerritories({
                limit: 1000
            });
            const ownedTerritories = allTerritories?.filter(t => t.ruler === userId) || [];
            
            const territoryCount = ownedTerritories?.length || 0;
            
            if (territoryCount > this.MAX_TERRITORIES_PER_USER) {
                log.warn(`[SeasonSystem] User ${userId} exceeds ownership limit: ${territoryCount} > ${this.MAX_TERRITORIES_PER_USER}`);
                
                // 가장 오래된 영토부터 자동 재경매 (선택적)
                // 이건 나중에 구현할 수 있음
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: `소유 제한에 도달했습니다. (최대 ${this.MAX_TERRITORIES_PER_USER}개)`
                });
            }
            
            return {
                count: territoryCount,
                limit: this.MAX_TERRITORIES_PER_USER,
                exceeded: territoryCount > this.MAX_TERRITORIES_PER_USER
            };
        } catch (error) {
            log.error('[SeasonSystem] Failed to check ownership limit:', error);
            return null;
        }
    }
    
    /**
     * 시즌별 랭킹 분리
     */
    async getSeasonRankings(seasonId = null) {
        const targetSeasonId = seasonId || this.currentSeason?.id;
        if (!targetSeasonId) return [];
        
        try {
            // TODO: 랭킹 API 엔드포인트가 있으면 사용
            const rankings = []; // await apiService.get('/rankings');
            
            return rankings || [];
        } catch (error) {
            log.error('[SeasonSystem] Failed to get season rankings:', error);
            return [];
        }
    }
    
    /**
     * 현재 시즌 가져오기
     */
    getCurrentSeason() {
        return this.currentSeason;
    }
    
    /**
     * 소유 제한 가져오기
     */
    getOwnershipLimit() {
        return this.MAX_TERRITORIES_PER_USER;
    }
}

// 싱글톤 인스턴스
export const seasonSystem = new SeasonSystem();
export default seasonSystem;

