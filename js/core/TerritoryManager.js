/**
 * TerritoryManager - 영토 관리 모듈
 * 영토 데이터 관리, 주권 상태, 가치 계산
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { analyticsService } from '../services/AnalyticsService.js';

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
        this.processingTerritoryId = null; // 무한 루프 방지
        this.isoToSlugMap = null; // ISO 코드 -> 슬러그 매핑 캐시
    }
    
    /**
     * ISO 코드를 슬러그로 변환하는 매핑 생성
     */
    createIsoToSlugMap() {
        if (this.isoToSlugMap) {
            return this.isoToSlugMap;
        }
        
        // TerritoryDataService의 COUNTRY_SLUG_TO_ISO를 역으로 변환
        // 하지만 TerritoryDataService는 export하지 않으므로 직접 매핑 생성
        const isoToSlug = {
            // 주요 국가
            'USA': 'usa', 'CAN': 'canada', 'MEX': 'mexico', 'KOR': 'south-korea',
            'JPN': 'japan', 'CHN': 'china', 'GBR': 'uk', 'DEU': 'germany',
            'FRA': 'france', 'ITA': 'italy', 'ESP': 'spain', 'IND': 'india',
            'BRA': 'brazil', 'RUS': 'russia', 'AUS': 'australia',
            'SGP': 'singapore', 'MYS': 'malaysia', 'IDN': 'indonesia',
            'THA': 'thailand', 'VNM': 'vietnam', 'PHL': 'philippines',
            'SAU': 'saudi-arabia', 'ARE': 'uae', 'QAT': 'qatar', 'IRN': 'iran',
            'ISR': 'israel', 'TUR': 'turkey', 'EGY': 'egypt',
            'ZAF': 'south-africa', 'NGA': 'nigeria', 'KEN': 'kenya',
            'EGY': 'egypt', 'DZA': 'algeria', 'MAR': 'morocco', 'TUN': 'tunisia',
            'NER': 'niger', 'MLI': 'mali', 'MRT': 'mauritania', 'SEN': 'senegal', 'GHA': 'ghana',
            'CIV': 'ivory-coast', 'CMR': 'cameroon', 'UGA': 'uganda',
            'TZA': 'tanzania', 'ETH': 'ethiopia', 'SDN': 'sudan', 'SDS': 'south-sudan',
            'GRL': 'greenland', 'DN1': 'greenland',
            // 추가 국가들
            'PAK': 'pakistan', 'BGD': 'bangladesh', 'MMR': 'myanmar',
            'KHM': 'cambodia', 'LAO': 'laos', 'MNG': 'mongolia',
            'NPL': 'nepal', 'LKA': 'sri-lanka', 'KAZ': 'kazakhstan',
            'UZB': 'uzbekistan', 'PRK': 'north-korea', 'TWN': 'taiwan',
            'HKG': 'hong-kong', 'BRN': 'brunei', 'BTN': 'bhutan',
            'MDV': 'maldives', 'TLS': 'timor-leste', 'IRQ': 'iraq',
            'JOR': 'jordan', 'LBN': 'lebanon', 'OMN': 'oman',
            'KWT': 'kuwait', 'BHR': 'bahrain', 'SYR': 'syria',
            'YEM': 'yemen', 'PSE': 'palestine', 'AFG': 'afghanistan',
            'NLD': 'netherlands', 'POL': 'poland', 'BEL': 'belgium',
            'SWE': 'sweden', 'AUT': 'austria', 'CHE': 'switzerland',
            'NOR': 'norway', 'PRT': 'portugal', 'GRC': 'greece',
            'CZE': 'czech-republic', 'ROU': 'romania', 'HUN': 'hungary',
            'DNK': 'denmark', 'FIN': 'finland', 'IRL': 'ireland',
            'BGR': 'bulgaria', 'SVK': 'slovakia', 'HRV': 'croatia',
            'LTU': 'lithuania', 'SVN': 'slovenia', 'LVA': 'latvia',
            'EST': 'estonia', 'CYP': 'cyprus', 'LUX': 'luxembourg',
            'MLT': 'malta', 'UKR': 'ukraine', 'BLR': 'belarus',
            'SRB': 'serbia', 'ALB': 'albania', 'MKD': 'north-macedonia',
            'MNE': 'montenegro', 'BIH': 'bosnia', 'MDA': 'moldova',
            'ISL': 'iceland', 'GEO': 'georgia', 'ARM': 'armenia',
            'AZE': 'azerbaijan', 'CUB': 'cuba', 'JAM': 'jamaica',
            'HTI': 'haiti', 'DOM': 'dominican-republic', 'GTM': 'guatemala',
            // 아프리카 추가
            'LBY': 'libya', 'RWA': 'rwanda', 'AGO': 'angola', 'MOZ': 'mozambique',
            'ZWE': 'zimbabwe', 'ZMB': 'zambia', 'BWA': 'botswana', 'NAM': 'namibia',
            'MDG': 'madagascar', 'MUS': 'mauritius', 'COD': 'congo-drc',
            'BFA': 'burkina-faso', 'BEN': 'benin', 'TGO': 'togo', 'GIN': 'guinea',
            'GNB': 'guinea-bissau', 'SLE': 'sierra-leone', 'LBR': 'liberia',
            'GMB': 'gambia', 'CPV': 'cape-verde', 'STP': 'sao-tome-and-principe',
            'GNQ': 'equatorial-guinea', 'GAB': 'gabon', 'CAF': 'central-african-republic',
            'TCD': 'chad', 'SSD': 'south-sudan', 'ERI': 'eritrea', 'DJI': 'djibouti',
            'SOM': 'somalia', 'COM': 'comoros', 'SYC': 'seychelles', 'SWZ': 'eswatini',
            'LSO': 'lesotho', 'MWI': 'malawi', 'BDI': 'burundi',
            // 남미 추가
            'ARG': 'argentina', 'CHL': 'chile', 'COL': 'colombia', 'PER': 'peru',
            'VEN': 'venezuela', 'ECU': 'ecuador', 'BOL': 'bolivia', 'PRY': 'paraguay',
            'URY': 'uruguay', 'GUY': 'guyana', 'SUR': 'suriname',
            'TTO': 'trinidad-and-tobago', 'BRB': 'barbados', 'JAM': 'jamaica',
            'BHS': 'bahamas', 'BLZ': 'belize', 'CRI': 'costa-rica', 'PAN': 'panama',
            'NIC': 'nicaragua', 'HND': 'honduras', 'SLV': 'el-salvador',
            // 아시아 추가
            'AFG': 'afghanistan', 'IRN': 'iran', 'IRQ': 'iraq', 'SYR': 'syria',
            'YEM': 'yemen', 'OMN': 'oman', 'ARE': 'uae', 'QAT': 'qatar',
            'BHR': 'bahrain', 'KWT': 'kuwait', 'SAU': 'saudi-arabia',
            'JOR': 'jordan', 'LBN': 'lebanon', 'ISR': 'israel', 'PSE': 'palestine',
            'LKA': 'sri-lanka', 'MDV': 'maldives', 'BTN': 'bhutan', 'NPL': 'nepal',
            'MMR': 'myanmar', 'LAO': 'laos', 'KHM': 'cambodia', 'VNM': 'vietnam',
            'MYS': 'malaysia', 'SGP': 'singapore', 'BRN': 'brunei', 'IDN': 'indonesia',
            'PHL': 'philippines', 'TLS': 'timor-leste', 'PNG': 'papua-new-guinea',
            'FJI': 'fiji', 'VUT': 'vanuatu', 'SLB': 'solomon-islands',
            'WSM': 'samoa', 'TON': 'tonga', 'KIR': 'kiribati', 'PLW': 'palau',
            'FSM': 'micronesia', 'MHL': 'marshall-islands', 'NRU': 'nauru',
            'TUV': 'tuvalu', 'NZL': 'new-zealand',
            // 유럽 추가
            'AND': 'andorra', 'MCO': 'monaco', 'SMR': 'san-marino', 'VAT': 'vatican',
            'LIE': 'liechtenstein', 'MNE': 'montenegro', 'BIH': 'bosnia',
            'MKD': 'north-macedonia', 'ALB': 'albania', 'GRC': 'greece',
            'MLT': 'malta', 'CYP': 'cyprus', 'TUR': 'turkey'
        };
        
        this.isoToSlugMap = isoToSlug;
        return isoToSlug;
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
        // 이미 territory 객체가 전달된 경우 (TerritoryListPanel 등에서)
        if (data.territory) {
            const territory = data.territory;
            this.currentTerritory = territory;
            
            // territoryId가 없으면 territory.id에서 가져오기
            const territoryId = data.territoryId || territory.id;
            
            // 영토 조회수 증가 (비동기, 에러 무시)
            if (territoryId) {
                this.incrementViewCount(territoryId).catch(err => {
                    log.warn(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, err);
                });
            }
            
            // 영토 패널 열기 이벤트만 발행 (무한 루프 방지)
            eventBus.emit(EVENTS.UI_PANEL_OPEN, {
                type: 'territory',
                data: territory
            });
            return;
        }
        
        // territoryId가 없는 경우 처리 불가
        if (!data.territoryId) {
            log.warn('[TerritoryManager] handleTerritorySelect: territoryId is missing', data);
            return;
        }
        
        const { territoryId, properties = {}, country, geometry, featureId, sourceId, territory } = data;
        
        // 무한 루프 방지: 이미 처리 중인 영토는 건너뛰기
        if (this.processingTerritoryId === territoryId) {
            log.warn(`[TerritoryManager] Territory ${territoryId} is already being processed, skipping`);
            return;
        }
        
        this.processingTerritoryId = territoryId;
        
        try {
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
        // ISO 코드는 대문자로 처리하여 매핑 시도
        // ⚠️ mapController.currentCountry는 사용하지 않음 (모든 territory의 country를 덮어쓰지 않도록)
        let finalCountry = country;
        
        // ISO 코드를 먼저 슬러그로 변환 시도
        if (!finalCountry && properties?.adm0_a3) {
            const isoCode = properties.adm0_a3.toUpperCase();
            const isoToSlugMap = this.createIsoToSlugMap();
            const slugCode = isoToSlugMap[isoCode];
            if (slugCode && CONFIG.COUNTRIES[slugCode]) {
                finalCountry = slugCode;
            }
        }
        
        // 여전히 없으면 다른 필드 시도
        if (!finalCountry) {
            finalCountry = properties?.country || 
                          properties?.country_code ||
                          territory.country;
        }
        
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
                altCode = altCode.toString().toUpperCase(); // ISO 코드는 대문자로 처리
                
                // TerritoryDataService의 COUNTRY_SLUG_TO_ISO를 역으로 사용하여 ISO -> 슬러그 변환
                // 먼저 직접 매핑 시도
                const isoToSlugMap = this.createIsoToSlugMap();
                const slugCode = isoToSlugMap[altCode];
                
                if (slugCode && !invalidCodes.includes(slugCode) && CONFIG.COUNTRIES[slugCode]) {
                    finalCountry = slugCode;
                } else {
                    // properties.admin이나 properties.geonunit에서 국가명 추출 시도
                    let countryName = properties?.admin || properties?.geonunit;
                    if (countryName) {
                        // 국가명 정규화 (예: "S. Sudan" → "South Sudan", "U.S.A." → "United States")
                        const countryNameNormalizations = {
                            's. sudan': 'south sudan',
                            's sudan': 'south sudan',
                            'south sudan': 'south sudan',
                            'u.s.a.': 'united states',
                            'usa': 'united states',
                            'u.k.': 'united kingdom',
                            'uk': 'united kingdom',
                            'uae': 'united arab emirates',
                            'dr congo': 'congo-drc',
                            'drc': 'congo-drc',
                            'côte d\'ivoire': 'ivory coast',
                            'ivory coast': 'ivory coast'
                        };
                        
                        const normalizedKey = countryName.toLowerCase().trim();
                        const normalizedValue = countryNameNormalizations[normalizedKey] || normalizedKey;
                        countryName = normalizedValue;
                        
                        // 국가명을 슬러그로 변환 시도
                        const normalizedName = countryName.toLowerCase().replace(/\s+/g, '-');
                        if (CONFIG.COUNTRIES[normalizedName]) {
                            finalCountry = normalizedName;
                        } else {
                            // 국가명으로 검색 (부분 일치도 시도)
                            for (const [key, value] of Object.entries(CONFIG.COUNTRIES)) {
                                const valueNameLower = value.name?.toLowerCase() || '';
                                const valueNameKoLower = value.nameKo?.toLowerCase() || '';
                                const countryNameLower = countryName.toLowerCase();
                                
                                if (valueNameLower === countryNameLower || 
                                    valueNameKoLower === countryNameLower ||
                                    valueNameLower.includes(countryNameLower) ||
                                    countryNameLower.includes(valueNameLower)) {
                                    finalCountry = key;
                                    break;
                                }
                            }
                        }
                    }
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
            
            // Feature ID와 Source ID도 저장 (맵 업데이트 시 사용)
            territory.featureId = featureId;
            territory.sourceId = sourceId;
            
            this.currentTerritory = territory;
            
            // 영토 조회수 증가 (비동기, 에러 무시)
            this.incrementViewCount(territoryId).catch(err => {
                log.warn(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, err);
            });
            
            // 영토 패널 열기 이벤트 발행 (TERRITORY_SELECT는 다시 발행하지 않음 - 무한 루프 방지)
            eventBus.emit(EVENTS.UI_PANEL_OPEN, {
                type: 'territory',
                data: territory
            });
            
            // 영토 업데이트 이벤트 발행 (조건 없이 항상 발행 - 파이프라인에서 Firestore 확인)
            // 컨설팅 원칙: 메모리 캐시가 아닌 Firestore 단일 원천으로 판단
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { 
                territory: territory 
            });
            
            // 영토 선택 이벤트 발행 (조건 없이 항상 발행 - 파이프라인에서 Firestore 확인)
            // territoryId, sourceId, featureId도 함께 전달하여 undefined 문제 방지
            eventBus.emit(EVENTS.TERRITORY_SELECT, {
                territory: territory,
                territoryId: territoryId,  // territoryId도 명시적으로 전달
                sourceId: sourceId,       // sourceId 전달
                featureId: featureId      // featureId 전달
            });
        } finally {
            // 처리 완료 후 플래그 해제 (약간의 지연 후)
            setTimeout(() => {
                if (this.processingTerritoryId === territoryId) {
                    this.processingTerritoryId = null;
                }
            }, 500);
        }
    }
    
    /**
     * GeoJSON 속성에서 영토 데이터 생성
     */
    createTerritoryFromProperties(territoryId, properties = {}) {
        const props = properties || {};
        return {
            id: territoryId,
            name: {
                ko: props.name_ko || props.name || props.NAME_1 || props.NAME_2 || territoryId,
                en: props.name_en || props.name || props.NAME_1 || props.NAME_2 || territoryId,
                local: props.name_local || props.name || props.NAME_1 || props.NAME_2 || territoryId
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
        
        log.info(`[TerritoryManager] Handling territory conquered: ${territoryId} by ${userName} (${userId})${isAdmin ? ' [Admin]' : ''}`);
        
        // territories Map에서 먼저 확인
        let territory = this.territories.get(territoryId);
        
        // Map에 없으면 Firestore에서 가져오기 또는 기본 영토 생성
        if (!territory) {
            log.warn(`[TerritoryManager] Territory ${territoryId} not in territories Map, loading from Firestore...`);
            try {
                const firestoreData = await firebaseService.getDocument('territories', territoryId);
                if (firestoreData) {
                    territory = firestoreData;
                    // territories Map에 추가
                    this.territories.set(territoryId, territory);
                    log.info(`[TerritoryManager] Loaded territory ${territoryId} from Firestore`);
                } else {
                    // Firestore에도 없으면 기본 영토 객체 생성
                    log.warn(`[TerritoryManager] Territory ${territoryId} not in Firestore, creating basic territory object...`);
                    territory = this.createTerritoryObject(territoryId, null, null);
                    this.territories.set(territoryId, territory);
                }
            } catch (error) {
                log.error(`[TerritoryManager] Failed to load territory ${territoryId} from Firestore:`, error);
                // 에러가 발생해도 기본 영토 객체 생성
                territory = this.createTerritoryObject(territoryId, null, null);
                this.territories.set(territoryId, territory);
            }
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
        territory.purchasedPrice = tribute; // 낙찰가 저장
        territory.tribute = tribute; // 낙찰가 저장 (호환성)
        
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
        
        // Firestore 업데이트 (updateDocument 사용하여 기존 필드 유지)
        try {
            const Timestamp = firebaseService.getTimestamp();
            const nowTimestamp = Timestamp ? Timestamp.now() : new Date();
            
            // protectionEndsAt을 Timestamp로 변환
            let protectionEndsAtTimestamp;
            if (territory.protectionEndsAt) {
                if (Timestamp) {
                    protectionEndsAtTimestamp = Timestamp.fromDate(territory.protectionEndsAt);
                } else {
                    protectionEndsAtTimestamp = territory.protectionEndsAt;
                }
            }
            
            // rulerSince를 Timestamp로 변환
            let rulerSinceTimestamp;
            if (territory.rulerSince) {
                if (Timestamp) {
                    rulerSinceTimestamp = Timestamp.fromDate(territory.rulerSince);
                } else {
                    rulerSinceTimestamp = territory.rulerSince;
                }
            }
            
            // updateDocument를 사용하여 기존 필드 유지하면서 업데이트
            await firebaseService.updateDocument('territories', territoryId, {
                sovereignty: territory.sovereignty,
                ruler: territory.ruler,
                rulerName: territory.rulerName,
                rulerSince: rulerSinceTimestamp || nowTimestamp,
                protectionEndsAt: protectionEndsAtTimestamp,
                purchasedByAdmin: territory.purchasedByAdmin || false,
                purchasedPrice: territory.purchasedPrice || tribute, // 낙찰가 저장
                tribute: territory.tribute || tribute, // 낙찰가 저장 (호환성)
                currentAuction: null, // 옥션 종료 후 null로 설정
                updatedAt: nowTimestamp
            });
            
            log.info(`[TerritoryManager] ✅ Territory ${territoryId} conquered by ${userName}${isAdmin ? ' (Admin)' : ''}. Updated in Firestore.`);
            
            // 영토 업데이트 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { territory });
            
        } catch (error) {
            log.error(`[TerritoryManager] ❌ Failed to update territory ${territoryId} in Firestore:`, error);
            // 에러가 발생해도 로컬 캐시는 업데이트되었으므로 계속 진행
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
     * 영토 조회수 증가
     * @param {string} territoryId - 영토 ID
     */
    async incrementViewCount(territoryId) {
        if (!territoryId) return;
        
        try {
            // 중기 해결: 서버 사이드 API 사용 (권장)
            // 단기 해결: 클라이언트에서 직접 업데이트 (현재)
            // ⚠️ Vercel Functions 개수 제한으로 인해 클라이언트 직접 업데이트로 전환
            // 임시 테스트 rules (firestore.rules.test)를 Firebase 콘솔에 배포 필요
            const USE_SERVER_API = false; // 서버 API 사용 여부 (환경 변수로 제어 가능)
            
            if (USE_SERVER_API) {
                // 서버 사이드 API 호출
                const response = await fetch('/api/territory/increment-view', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ territoryId })
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || '조회수 업데이트 실패');
                }
                
                const data = await response.json();
                
                // 로컬 캐시 업데이트
                const localTerritory = this.territories.get(territoryId);
                if (localTerritory) {
                    localTerritory.viewCount = data.viewCount;
                    localTerritory.lastViewedAt = new Date();
                }
            } else {
                // 단기 해결: 클라이언트에서 직접 업데이트
                // Firestore에서 현재 조회수 가져오기
                const territory = await firebaseService.getDocument('territories', territoryId);
                const currentViews = territory?.viewCount || 0;
                
                // 조회수 증가 (Firestore increment 연산 사용)
                await firebaseService.updateDocument('territories', territoryId, {
                    viewCount: currentViews + 1,
                    lastViewedAt: new Date()
                }, true); // merge=true로 기존 데이터 유지
                
                // 로컬 캐시도 업데이트
                const localTerritory = this.territories.get(territoryId);
                if (localTerritory) {
                    localTerritory.viewCount = currentViews + 1;
                    localTerritory.lastViewedAt = new Date();
                }
            }
            
            // Analytics 이벤트 추적
            if (typeof analyticsService !== 'undefined') {
                analyticsService.trackEvent('territory_viewed', {
                    territory_id: territoryId
                });
            }
        } catch (error) {
            log.warn(`[TerritoryManager] Failed to increment view count:`, error);
            // 에러가 발생해도 앱은 계속 작동
        }
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

