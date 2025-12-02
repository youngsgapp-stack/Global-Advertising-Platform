/**
 * TerritoryManager - 영토 관리 모듈
 * 영토 데이터 관리, 주권 상태, 가치 계산
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';

// 주권 상태 열거형
export const SOVEREIGNTY = {
    UNCONQUERED: 'unconquered',  // 미정복
    CONTESTED: 'contested',      // 분쟁 중 (옥션 진행)
    RULED: 'ruled'               // 통치됨
};

class TerritoryManager {
    constructor() {
        this.territories = new Map();
        this.currentTerritory = null;
        this.unsubscribers = [];
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // Firestore에서 영토 데이터 로드
            await this.loadTerritoriesFromFirestore();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('TerritoryManager initialized');
            return true;
            
        } catch (error) {
            log.error('TerritoryManager initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 영토 선택 이벤트
        eventBus.on(EVENTS.TERRITORY_SELECT, (data) => {
            this.handleTerritorySelect(data);
        });
        
        // 영토 정복 이벤트
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.handleTerritoryConquered(data);
        });
    }
    
    /**
     * Firestore에서 영토 데이터 로드
     */
    async loadTerritoriesFromFirestore() {
        try {
            const territories = await firebaseService.queryCollection('territories');
            
            for (const territory of territories) {
                this.territories.set(territory.id, territory);
            }
            
            log.info(`Loaded ${territories.length} territories from Firestore`);
            
        } catch (error) {
            log.warn('Failed to load territories from Firestore:', error);
            // Firestore 로드 실패 시 로컬 기본값 사용
        }
    }
    
    /**
     * 영토 선택 처리
     */
    async handleTerritorySelect(data) {
        const { territoryId, properties } = data;
        
        // Firestore에서 최신 데이터 가져오기
        let territory = this.territories.get(territoryId);
        
        if (!territory) {
            // 새 영토 데이터 생성 (GeoJSON 속성 기반)
            territory = this.createTerritoryFromProperties(territoryId, properties);
            this.territories.set(territoryId, territory);
        }
        
        this.currentTerritory = territory;
        
        // 영토 패널 열기 이벤트 발행
        eventBus.emit(EVENTS.UI_PANEL_OPEN, {
            type: 'territory',
            data: territory
        });
    }
    
    /**
     * GeoJSON 속성에서 영토 데이터 생성
     */
    createTerritoryFromProperties(territoryId, properties) {
        return {
            id: territoryId,
            name: {
                ko: properties.name_ko || properties.name || territoryId,
                en: properties.name_en || properties.name || territoryId,
                local: properties.name_local || properties.name || territoryId
            },
            country: properties.country || 'unknown',
            countryCode: properties.country_code || 'XX',
            adminLevel: properties.admin_level || 'Region',
            
            // 통계
            population: properties.population || 0,
            area: properties.area || 0,
            
            // 주권 상태
            sovereignty: properties.sovereignty || SOVEREIGNTY.UNCONQUERED,
            ruler: properties.ruler || null,
            rulerSince: null,
            
            // 픽셀 캔버스
            pixelCanvas: {
                width: CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                height: CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                filledPixels: 0,
                lastUpdated: null
            },
            
            // 가치 & 랭킹
            territoryValue: 0,
            rankScore: 0,
            tribute: properties.price || CONFIG.TERRITORY.DEFAULT_TRIBUTE,
            
            // 역사
            history: [],
            
            // 버프
            buffs: [],
            
            // 옥션
            currentAuction: null,
            
            // 메타
            createdAt: new Date(),
            updatedAt: new Date()
        };
    }
    
    /**
     * 영토 정복 처리
     */
    async handleTerritoryConquered(data) {
        const { territoryId, userId, userName, tribute } = data;
        
        const territory = this.territories.get(territoryId);
        if (!territory) {
            log.error('Territory not found:', territoryId);
            return;
        }
        
        const previousRuler = territory.ruler;
        
        // 영토 상태 업데이트
        territory.sovereignty = SOVEREIGNTY.RULED;
        territory.ruler = userId;
        territory.rulerSince = new Date();
        territory.updatedAt = new Date();
        
        // 역사 기록 추가
        territory.history.push({
            type: 'conquered',
            timestamp: new Date(),
            data: {
                newRuler: userName,
                previousRuler: previousRuler,
                tribute: tribute
            }
        });
        
        // Firestore 업데이트
        try {
            await firebaseService.setDocument('territories', territoryId, territory);
            log.info(`Territory ${territoryId} conquered by ${userName}`);
            
            // 영토 업데이트 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { territory });
            
        } catch (error) {
            log.error('Failed to update territory in Firestore:', error);
        }
    }
    
    /**
     * 영토 가치 계산
     */
    calculateTerritoryValue(territoryId) {
        const territory = this.territories.get(territoryId);
        if (!territory) return 0;
        
        // 기본 가치 = 채워진 픽셀 수
        let value = territory.pixelCanvas.filledPixels;
        
        // 인구 보너스 (인구 100만당 +10)
        value += Math.floor(territory.population / 1000000) * 10;
        
        // 면적 보너스 (면적 10000km²당 +5)
        value += Math.floor(territory.area / 10000) * 5;
        
        territory.territoryValue = value;
        return value;
    }
    
    /**
     * 영토 랭킹 점수 계산
     */
    calculateRankScore(territoryId) {
        const territory = this.territories.get(territoryId);
        if (!territory) return 0;
        
        let score = 0;
        
        // 기본 점수
        score += CONFIG.RANKING.TERRITORY_SCORE;
        
        // 픽셀 점수
        score += territory.pixelCanvas.filledPixels * CONFIG.RANKING.PIXEL_SCORE;
        
        // 가치 점수
        score += territory.territoryValue;
        
        territory.rankScore = score;
        return score;
    }
    
    /**
     * 사용자의 영토 목록 가져오기
     */
    getTerritoriesByUser(userId) {
        const userTerritories = [];
        
        for (const [id, territory] of this.territories) {
            if (territory.ruler === userId) {
                userTerritories.push(territory);
            }
        }
        
        return userTerritories;
    }
    
    /**
     * 국가별 영토 목록 가져오기
     */
    getTerritoriesByCountry(countryCode) {
        const countryTerritories = [];
        
        for (const [id, territory] of this.territories) {
            if (territory.countryCode === countryCode) {
                countryTerritories.push(territory);
            }
        }
        
        return countryTerritories;
    }
    
    /**
     * 국가 점령도 계산
     */
    getCountryOccupation(countryCode, userId) {
        const countryTerritories = this.getTerritoriesByCountry(countryCode);
        const total = countryTerritories.length;
        
        if (total === 0) return { total: 0, owned: 0, percentage: 0 };
        
        const owned = countryTerritories.filter(t => t.ruler === userId).length;
        const percentage = Math.round((owned / total) * 100);
        
        return { total, owned, percentage };
    }
    
    /**
     * 인접 영토 확인
     */
    getAdjacentTerritories(territoryId) {
        // TODO: GeoJSON 기반 인접 영토 계산
        // 현재는 빈 배열 반환
        return [];
    }
    
    /**
     * 영토 실시간 구독
     */
    subscribeToTerritory(territoryId, callback) {
        const unsubscribe = firebaseService.subscribeToDocument(
            'territories',
            territoryId,
            (data) => {
                if (data) {
                    this.territories.set(territoryId, data);
                    callback(data);
                }
            }
        );
        
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
    }
    
    /**
     * 영토 가져오기
     */
    getTerritory(territoryId) {
        return this.territories.get(territoryId);
    }
    
    /**
     * 현재 선택된 영토
     */
    getCurrentTerritory() {
        return this.currentTerritory;
    }
    
    /**
     * 모든 영토 가져오기
     */
    getAllTerritories() {
        return Array.from(this.territories.values());
    }
    
    /**
     * 정리
     */
    cleanup() {
        // 모든 구독 해제
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        this.territories.clear();
        this.currentTerritory = null;
    }
}

// 싱글톤 인스턴스
export const territoryManager = new TerritoryManager();
export default territoryManager;

