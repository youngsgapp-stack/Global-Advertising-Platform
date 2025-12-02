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
    RULED: 'ruled',              // 통치됨
    PROTECTED: 'protected'       // 보호 기간 중 (도전 불가)
};

// 보호 기간 설정 (밀리초)
export const PROTECTION_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7일

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
        const { territoryId, properties, country, geometry } = data;
        
        // Firestore에서 최신 데이터 가져오기 (pixelCanvas 정보 포함)
        let territory = this.territories.get(territoryId);
        
        if (!territory) {
            // 새 영토 데이터 생성 (GeoJSON 속성 기반)
            territory = this.createTerritoryFromProperties(territoryId, properties);
            this.territories.set(territoryId, territory);
        }
        
        // Firestore에서 최신 픽셀 정보 로드
        try {
            const firestoreData = await firebaseService.getDocument('territories', territoryId);
            if (firestoreData) {
                // pixelCanvas 정보 병합
                if (firestoreData.pixelCanvas) {
                    territory.pixelCanvas = {
                        ...territory.pixelCanvas,
                        ...firestoreData.pixelCanvas
                    };
                }
                // 기타 최신 정보 병합
                if (firestoreData.ruler) territory.ruler = firestoreData.ruler;
                if (firestoreData.rulerName) territory.rulerName = firestoreData.rulerName;
                if (firestoreData.sovereignty) territory.sovereignty = firestoreData.sovereignty;
                if (firestoreData.territoryValue !== undefined) territory.territoryValue = firestoreData.territoryValue;
                log.debug(`Updated territory ${territoryId} from Firestore with pixelCanvas data`);
            }
        } catch (error) {
            log.warn(`Failed to load territory ${territoryId} from Firestore:`, error);
        }
        
        // 국가 코드 결정: 전달된 country > properties.adm0_a3 > properties.country > properties.country_code
        // adm0_a3는 ISO 3166-1 alpha-3 코드 (예: "USA")를 포함하므로 우선 사용
        let finalCountry = country || 
                          properties?.adm0_a3?.toLowerCase() ||  // adm0_a3 우선 사용 (USA -> usa)
                          properties?.country || 
                          properties?.country_code ||
                          territory.country;
        
        // 잘못된 값 필터링: "territories", "states", "regions" 등은 무시
        const invalidCodes = ['territories', 'states', 'regions', 'prefectures', 'provinces', 'unknown'];
        if (invalidCodes.includes(finalCountry?.toLowerCase())) {
            finalCountry = null;
        }
        
        // country가 슬러그 형식이 아닌 경우 변환 (예: 'United States' -> 'usa')
        if (finalCountry && !CONFIG.COUNTRIES[finalCountry]) {
            // ISO 코드나 국가명일 수 있으므로 변환 시도
            const normalized = finalCountry.toLowerCase().replace(/\s+/g, '-');
            if (CONFIG.COUNTRIES[normalized] && !invalidCodes.includes(normalized)) {
                finalCountry = normalized;
            } else {
                // 국가명으로 검색
                for (const [key, value] of Object.entries(CONFIG.COUNTRIES)) {
                    if (value.name === finalCountry || value.nameKo === finalCountry) {
                        finalCountry = key;
                        break;
                    }
                }
            }
        }
        
        // 여전히 유효하지 않으면 properties에서 다른 필드 시도
        if (!finalCountry || !CONFIG.COUNTRIES[finalCountry]) {
            let altCode = properties?.adm0_a3 ||  // ISO 코드 (예: "USA")
                         properties?.country_code ||
                         properties?.sov_a3 ||
                         properties?.iso_a3;
            
            if (altCode) {
                altCode = altCode.toString().toLowerCase();
                
                // ISO 코드를 슬러그로 변환 시도 (예: "usa" -> "usa", "kor" -> "south-korea")
                const isoToSlug = {
                    'usa': 'usa', 'can': 'canada', 'mex': 'mexico', 'kor': 'south-korea',
                    'jpn': 'japan', 'chn': 'china', 'gbr': 'uk', 'deu': 'germany',
                    'fra': 'france', 'ita': 'italy', 'esp': 'spain', 'ind': 'india',
                    'bra': 'brazil', 'rus': 'russia', 'aus': 'australia'
                };
                
                const slugCode = isoToSlug[altCode] || altCode;
                
                if (!invalidCodes.includes(slugCode) && CONFIG.COUNTRIES[slugCode]) {
                    finalCountry = slugCode;
                } else if (CONFIG.COUNTRIES[altCode]) {
                    finalCountry = altCode;
                }
            }
        }
        
        // 여전히 유효하지 않으면 로그 남기고 null로 설정
        if (!finalCountry || !CONFIG.COUNTRIES[finalCountry]) {
            log.warn(`[TerritoryManager] Invalid country code: ${country}, properties.adm0_a3: ${properties?.adm0_a3}, properties.country: ${properties?.country}`);
            finalCountry = null; // TerritoryPanel에서 다시 시도하도록
        }
        
        // 국가 코드와 지오메트리 추가
        territory.country = finalCountry;
        territory.geometry = geometry;
        territory.properties = properties; // properties도 저장
        
        this.currentTerritory = territory;
        
        // 영토 패널 열기 이벤트 발행
        eventBus.emit(EVENTS.UI_PANEL_OPEN, {
            type: 'territory',
            data: territory
        });
        
        // 픽셀 데이터가 있으면 맵 업데이트 트리거
        if (territory.pixelCanvas && territory.pixelCanvas.filledPixels > 0) {
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { 
                territory: territory 
            });
        }
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
        const { territoryId, userId, userName, tribute, isAdmin = false } = data;
        
        const territory = this.territories.get(territoryId);
        if (!territory) {
            log.error('Territory not found:', territoryId);
            return;
        }
        
        const previousRuler = territory.ruler;
        const now = new Date();
        
        // 영토 상태 업데이트
        territory.sovereignty = SOVEREIGNTY.PROTECTED; // 구매 직후 보호 상태
        territory.ruler = userId;
        territory.rulerName = userName;
        territory.rulerSince = now;
        territory.protectionEndsAt = new Date(now.getTime() + PROTECTION_PERIOD); // 7일 보호
        territory.updatedAt = now;
        territory.purchasedByAdmin = isAdmin; // 관리자 구매 여부
        
        // 역사 기록 추가
        territory.history = territory.history || [];
        territory.history.push({
            type: 'conquered',
            timestamp: now,
            data: {
                newRuler: userName,
                previousRuler: previousRuler,
                tribute: tribute,
                isAdmin: isAdmin
            }
        });
        
        // Firestore 업데이트 (배열 필드 제외)
        try {
            // Firestore에 저장할 때 배열 필드 제외
            const territoryForFirestore = {
                id: territory.id,
                name: territory.name,
                country: territory.country,
                countryCode: territory.countryCode,
                adminLevel: territory.adminLevel,
                population: territory.population,
                area: territory.area,
                sovereignty: territory.sovereignty,
                ruler: territory.ruler,
                rulerName: territory.rulerName,
                rulerSince: territory.rulerSince,
                protectionEndsAt: territory.protectionEndsAt,
                pixelCanvas: {
                    width: territory.pixelCanvas?.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                    height: territory.pixelCanvas?.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                    filledPixels: territory.pixelCanvas?.filledPixels || 0,
                    lastUpdated: territory.pixelCanvas?.lastUpdated || null
                    // pixels 배열은 제외
                },
                territoryValue: territory.territoryValue || 0,
                rankScore: territory.rankScore || 0,
                tribute: territory.tribute,
                currentAuction: territory.currentAuction,
                purchasedByAdmin: territory.purchasedByAdmin,
                createdAt: territory.createdAt,
                updatedAt: territory.updatedAt
                // history, buffs 배열 필드는 제외 (별도 컬렉션에 저장)
            };
            
            await firebaseService.setDocument('territories', territoryId, territoryForFirestore);
            log.info(`Territory ${territoryId} conquered by ${userName}${isAdmin ? ' (Admin)' : ''}`);
            
            // 영토 업데이트 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { territory });
            
        } catch (error) {
            log.error('Failed to update territory in Firestore:', error);
        }
    }
    
    /**
     * 보호 기간 확인
     */
    isProtected(territoryId) {
        const territory = this.territories.get(territoryId);
        if (!territory || !territory.protectionEndsAt) return false;
        
        const protectionEnd = territory.protectionEndsAt instanceof Date 
            ? territory.protectionEndsAt 
            : new Date(territory.protectionEndsAt);
            
        return new Date() < protectionEnd;
    }
    
    /**
     * 보호 기간 남은 시간 가져오기
     */
    getProtectionRemaining(territoryId) {
        const territory = this.territories.get(territoryId);
        if (!territory || !territory.protectionEndsAt) return null;
        
        const protectionEnd = territory.protectionEndsAt instanceof Date 
            ? territory.protectionEndsAt 
            : new Date(territory.protectionEndsAt);
            
        const remaining = protectionEnd - new Date();
        if (remaining <= 0) return null;
        
        const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
        const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        
        return { days, hours, totalMs: remaining };
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

