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
        this.processingConquest = new Set(); // 구매 처리 중인 territoryId 추적
        this.isoToSlugMap = null; // ISO 코드 -> 슬러그 매핑 캐시
        this.protectionCheckInterval = null; // 보호 기간 체크 인터벌
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
            
            // ⚠️ CRITICAL: 주기적으로 보호 기간 체크 (서버 cron 실패 시 대비)
            this.startProtectionPeriodCheck();
            
            log.info('TerritoryManager initialized');
            return true;
            
        } catch (error) {
            log.error('TerritoryManager initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 보호 기간 주기적 체크 시작 (서버 cron 실패 시 대비)
     * 5분마다 체크하여 만료된 보호 기간 자동 수정
     */
    startProtectionPeriodCheck() {
        // 기존 인터벌이 있으면 제거
        if (this.protectionCheckInterval) {
            clearInterval(this.protectionCheckInterval);
        }
        
        // 5분마다 체크
        this.protectionCheckInterval = setInterval(() => {
            this.checkExpiredProtections().catch(err => {
                log.error('[TerritoryManager] Failed to check expired protections:', err);
            });
        }, 5 * 60 * 1000); // 5분
        
        // 초기 체크도 수행
        this.checkExpiredProtections().catch(err => {
            log.error('[TerritoryManager] Failed to check expired protections on init:', err);
        });
        
        log.info('[TerritoryManager] ✅ Protection period check started (every 5 minutes)');
    }
    
    /**
     * 만료된 보호 기간 체크 및 자동 수정
     */
    async checkExpiredProtections() {
        const now = new Date();
        let fixedCount = 0;
        
        for (const [territoryId, territory] of this.territories.entries()) {
            if (!territory.protectionEndsAt || territory.sovereignty !== SOVEREIGNTY.PROTECTED) {
                continue;
            }
            
            const protectionEnd = territory.protectionEndsAt instanceof Date 
                ? territory.protectionEndsAt 
                : new Date(territory.protectionEndsAt);
            
            if (now >= protectionEnd) {
                // 보호 기간이 만료되었는데 여전히 PROTECTED 상태인 경우 수정
                log.info(`[TerritoryManager] 🔧 Found expired protection for ${territoryId}, fixing...`);
                await this._fixExpiredProtection(territoryId, territory);
                fixedCount++;
            }
        }
        
        if (fixedCount > 0) {
            log.info(`[TerritoryManager] ✅ Fixed ${fixedCount} expired protection(s)`);
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // ⚠️ 전문가 조언 반영: TERRITORY_CLICKED (입력) 이벤트만 구독
        // TERRITORY_SELECTED는 TerritoryManager가 발행만 하고, 구독하지 않음 (순환 참조 방지)
        eventBus.on(EVENTS.TERRITORY_CLICKED, (data) => {
            log.debug(`[TerritoryManager] 📥 TERRITORY_CLICKED event received: territoryId=${data.territoryId}`);
            this.handleTerritorySelect(data);
        });
        
        // 레거시 호환성: TERRITORY_SELECT도 처리 (deprecated)
        eventBus.on(EVENTS.TERRITORY_SELECT, (data) => {
            log.warn(`[TerritoryManager] ⚠️ Deprecated TERRITORY_SELECT event received, converting to TERRITORY_CLICKED`);
            eventBus.emit(EVENTS.TERRITORY_CLICKED, data);
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
            // ⚠️ 전문가 조언 반영: TerritoryManager를 단일 진실 공급자로 만들기
            // 1단계: GeoJSON 기반 베이스 territory 객체 생성
            let territory = this.territories.get(territoryId);
            
            if (!territory) {
                // 새 영토 데이터 생성 (GeoJSON 속성 기반)
                territory = this.createTerritoryFromProperties(territoryId, properties);
                this.territories.set(territoryId, territory);
            }
            
            // territory.id가 없으면 설정 (중요!)
            if (!territory.id) {
                territory.id = territoryId;
            }
            
            // 2단계: Firestore에서 최신 데이터 가져오기 (반드시 완료 후 이벤트 발행)
            // ⚠️ 전문가 조언: Firestore 읽기가 완료된 후에만 SELECT 이벤트 발행
            let firestoreData = null;
            try {
                log.info(`[TerritoryManager] 📡 Fetching territory from Firestore: territories/${territoryId}`);
                firestoreData = await firebaseService.getDocument('territories', territoryId);
                
                if (firestoreData) {
                    // ⚠️ 전문가 조언: Firestore 문서의 실제 내용을 모두 로깅하여 디버깅
                    log.info(`[TerritoryManager] 📄 Firestore document found for ${territoryId}:`, {
                        hasRuler: firestoreData.ruler !== undefined,
                        ruler: firestoreData.ruler,
                        hasRulerName: firestoreData.rulerName !== undefined,
                        rulerName: firestoreData.rulerName,
                        hasSovereignty: firestoreData.sovereignty !== undefined,
                        sovereignty: firestoreData.sovereignty,
                        hasPrice: firestoreData.price !== undefined,
                        price: firestoreData.price,
                        hasPurchasedByAdmin: firestoreData.purchasedByAdmin !== undefined,
                        purchasedByAdmin: firestoreData.purchasedByAdmin,
                        hasPixelCanvas: firestoreData.pixelCanvas !== undefined,
                        pixelCanvasKeys: firestoreData.pixelCanvas ? Object.keys(firestoreData.pixelCanvas) : null,
                        allKeys: Object.keys(firestoreData),
                        // ⚠️ 전문가 조언: 전체 문서 내용 로깅 (디버깅용 - 콘솔에서 확인)
                        documentKeys: Object.keys(firestoreData),
                        documentSize: JSON.stringify(firestoreData).length
                    });
                    
                    // ⚠️ 전문가 조언: 전체 문서 내용을 콘솔에 출력 (디버깅용)
                    console.log(`[TerritoryManager] 📄 Full Firestore document for ${territoryId}:`, firestoreData);
                    
                    // ⚠️ 전문가 조언: Firestore 문서에 ruler/sovereignty가 없으면 경고
                    if (!firestoreData.ruler && !firestoreData.sovereignty) {
                        log.warn(`[TerritoryManager] ⚠️⚠️⚠️ WARNING: Territory ${territoryId} has NO ruler/sovereignty in Firestore! This territory may have been purchased but the update failed.`);
                        log.warn(`[TerritoryManager] ⚠️ Check if handleTerritoryConquered was called and if Firestore update succeeded.`);
                    }
                    
                    // ⚠️ 전문가 조언: Firestore 데이터를 완전히 병합하여 단일 진실 생성
                    // pixelCanvas 정보 병합
                    if (firestoreData.pixelCanvas) {
                        territory.pixelCanvas = {
                            ...territory.pixelCanvas,
                            ...firestoreData.pixelCanvas
                        };
                    }
                    // 기타 최신 정보 병합 (중요: Firestore 데이터가 우선 - null 값도 허용)
                    if (firestoreData.ruler !== undefined) territory.ruler = firestoreData.ruler;
                    if (firestoreData.rulerName !== undefined) territory.rulerName = firestoreData.rulerName;
                    if (firestoreData.sovereignty !== undefined) territory.sovereignty = firestoreData.sovereignty;
                    if (firestoreData.protectedUntil !== undefined) territory.protectedUntil = firestoreData.protectedUntil;
                    if (firestoreData.rulerSince !== undefined) territory.rulerSince = firestoreData.rulerSince;
                    if (firestoreData.territoryValue !== undefined) territory.territoryValue = firestoreData.territoryValue;
                    if (firestoreData.price !== undefined) territory.price = firestoreData.price;
                    if (firestoreData.purchasedByAdmin !== undefined) territory.purchasedByAdmin = firestoreData.purchasedByAdmin;
                    
                    // ⚠️ 전문가 조언: sovereignty가 없으면 기본값 설정
                    if (territory.sovereignty === undefined || territory.sovereignty === null) {
                        if (territory.ruler) {
                            // ruler가 있으면 ruled로 설정
                            territory.sovereignty = 'ruled';
                            log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} has ruler but no sovereignty, setting to 'ruled'`);
                        } else {
                            // ruler가 없으면 unconquered로 설정
                            territory.sovereignty = 'unconquered';
                            log.debug(`[TerritoryManager] Territory ${territoryId} has no sovereignty, setting to 'unconquered'`);
                        }
                    }
                    
                    log.info(`[TerritoryManager] ✅ Territory ${territoryId} fully hydrated from Firestore: sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}, rulerName=${territory.rulerName || 'null'}`);
                } else {
                    log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} not found in Firestore (may be a new territory)`);
                    // Firestore에 문서가 없으면 기본값 설정
                    if (territory.sovereignty === undefined || territory.sovereignty === null) {
                        territory.sovereignty = 'unconquered';
                    }
                }
            } catch (error) {
                // Firebase SDK 로드 실패 시에도 계속 진행 (기존 territory 데이터 사용)
                log.error(`[TerritoryManager] ❌ Failed to load territory ${territoryId} from Firestore:`, error);
                // 에러 발생 시에도 기본값 설정
                if (territory.sovereignty === undefined || territory.sovereignty === null) {
                    territory.sovereignty = 'unconquered';
                }
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
            
            // ⚠️ 전문가 조언: Firestore 읽기 완료 후 territories Map에 저장 (단일 진실 저장)
            this.territories.set(territoryId, territory);
            this.currentTerritory = territory;
            
            // 영토 조회수 증가 (비동기, 에러 무시)
            this.incrementViewCount(territoryId).catch(err => {
                log.warn(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, err);
            });
            
            // ⚠️ 전문가 조언: territory.id가 반드시 설정되어 있는지 확인
            if (!territory.id) {
                territory.id = territoryId;
                log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} had no id, setting it now`);
            }
            
            // ⚠️ 전문가 조언: Firestore 읽기 완료 후에만 TERRITORY_SELECTED (출력) 이벤트 발행
            // 완전히 하이드레이트된 Territory 객체를 전달 (단일 진실)
            log.info(`[TerritoryManager] 🎯 [TerritoryManager → TERRITORY_SELECTED] Emitting TERRITORY_SELECTED event for ${territoryId}: sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}, id=${territory.id}`);
            eventBus.emit(EVENTS.TERRITORY_SELECTED, {
                territory: territory,      // 완전히 하이드레이트된 객체
                territoryId: territoryId, // territoryId도 명시적으로 전달
                sourceId: sourceId,       // sourceId 전달
                featureId: featureId,     // featureId 전달
                country: finalCountry,     // 최종 결정된 country
                properties: properties,    // properties 전달
                geometry: geometry        // geometry 전달
            });
            
            // 레거시 호환성: TERRITORY_SELECT도 발행 (deprecated)
            eventBus.emit(EVENTS.TERRITORY_SELECT, {
                territory: territory,
                territoryId: territoryId,
                sourceId: sourceId,
                featureId: featureId,
                country: finalCountry,
                properties: properties,
                geometry: geometry
            });
            
            // 영토 패널 열기 이벤트 발행
            eventBus.emit(EVENTS.UI_PANEL_OPEN, {
                type: 'territory',
                data: territory
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
        const { territoryId, userId, userName, tribute, isAdmin = false, protectionDays = null } = data;
        
        // userId가 없으면 조기 반환 (필수 파라미터)
        if (!userId) {
            log.warn(`[TerritoryManager] ⚠️ handleTerritoryConquered called with undefined userId for ${territoryId}, skipping...`);
            log.warn(`[TerritoryManager] Data received:`, data);
            return;
        }
        
        // 중복 호출 방지: 이미 처리 중인 territoryId는 스킵
        if (this.processingConquest.has(territoryId)) {
            log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} is already being processed, skipping duplicate call`);
            return;
        }
        
        this.processingConquest.add(territoryId);
        
        try {
            // ⚠️ 전문가 조언 반영: 구매 프로세스 검증을 위한 상세 로그
            log.info(`[TerritoryManager] 🎯🎯🎯 [구매 프로세스 시작] handleTerritoryConquered CALLED`);
            log.info(`[TerritoryManager] 📋 구매 데이터:`, { 
                territoryId, 
                userId, 
                userName, 
                tribute, 
                isAdmin,
                protectionDays,
                timestamp: new Date().toISOString()
            });
            
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
            
            // 보호 기간 계산
            // protectionDays가 null이면 평생 보호 (매우 큰 값)
            // protectionDays가 있으면 해당 일수만큼 보호
            let protectionEndsAt;
            if (protectionDays === null) {
                // 평생 보호: 100년 후로 설정 (실질적으로 평생)
                protectionEndsAt = new Date(now.getTime() + (100 * 365 * 24 * 60 * 60 * 1000));
                log.info(`[TerritoryManager] Lifetime protection set for ${territoryId}`);
            } else {
                // 지정된 일수만큼 보호
                protectionEndsAt = new Date(now.getTime() + (protectionDays * 24 * 60 * 60 * 1000));
                log.info(`[TerritoryManager] Protection set for ${protectionDays} days for ${territoryId}`);
            }
            
            // 영토 상태 업데이트
            territory.sovereignty = SOVEREIGNTY.PROTECTED; // 구매 직후 보호 상태
            territory.ruler = userId;
            territory.rulerName = userName;
            territory.rulerSince = now;
            territory.protectionEndsAt = protectionEndsAt;
            territory.updatedAt = now;
            territory.purchasedByAdmin = isAdmin; // 관리자 구매 여부
            territory.purchasedPrice = tribute; // 낙찰가 저장
            territory.tribute = tribute; // 낙찰가 저장 (호환성)
            territory.protectionDays = protectionDays; // 보호 기간 일수 저장 (null이면 평생)
            
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
            
            // ⚠️ CRITICAL: Transaction을 사용하여 동시성 보호
            // 두 사용자가 동시에 같은 영토를 구매하려 할 때 race condition 방지
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
            const updateData = {
                sovereignty: territory.sovereignty,
                ruler: territory.ruler,
                rulerName: territory.rulerName,
                rulerSince: rulerSinceTimestamp || nowTimestamp,
                protectionEndsAt: protectionEndsAtTimestamp,
                protectionDays: territory.protectionDays, // 보호 기간 일수 저장
                purchasedByAdmin: territory.purchasedByAdmin || false,
                purchasedPrice: territory.purchasedPrice || tribute, // 낙찰가 저장
                tribute: territory.tribute || tribute, // 낙찰가 저장 (호환성)
                currentAuction: null, // 옥션 종료 후 null로 설정
                updatedAt: nowTimestamp
            };
            
            // ⚠️ 전문가 조언 반영: Firestore 쓰기 직전 로그
            log.info(`[TerritoryManager] 📤 [Firestore 쓰기 직전] Updating Firestore: territories/${territoryId}`);
            log.info(`[TerritoryManager] 📤 업데이트할 데이터:`, {
                territoryId,
                ruler: userId,
                rulerName: userName,
                sovereignty: territory.sovereignty,
                purchasedByAdmin: isAdmin,
                purchasedPrice: tribute,
                updateDataKeys: Object.keys(updateData),
                fullUpdateData: JSON.stringify(updateData, null, 2)
            });
            
            // ⚠️ CRITICAL: Transaction을 사용하여 동시성 보호
            try {
                await firebaseService.runTransaction(async (transaction) => {
                    // Transaction 내에서 영토 상태 확인 (최신 상태 보장)
                    const currentTerritory = await transaction.get('territories', territoryId);
                    
                    if (!currentTerritory) {
                        // 문서가 없으면 생성
                        transaction.set('territories', territoryId, {
                            ...updateData,
                            viewCount: 0,
                            territoryValue: 0,
                            hasPixelArt: false
                        });
                        log.info(`[TerritoryManager] 🔒 Transaction: Creating new territory ${territoryId}`);
                    } else {
                        // ⚠️ CRITICAL: 동시성 검증 - ruler가 이미 설정되어 있으면 실패
                        if (currentTerritory.ruler && currentTerritory.ruler !== userId) {
                            log.error(`[TerritoryManager] ❌❌❌ TRANSACTION ABORTED: Territory ${territoryId} is already owned by ${currentTerritory.ruler}`);
                            throw new Error(`Territory ${territoryId} is already owned by another user`);
                        }
                        
                        // ruler가 null이거나 현재 사용자인 경우에만 업데이트
                        if (currentTerritory.ruler === null || currentTerritory.ruler === userId) {
                            transaction.update('territories', territoryId, updateData);
                            log.info(`[TerritoryManager] 🔒 Transaction: Updating territory ${territoryId}`);
                        } else {
                            log.error(`[TerritoryManager] ❌❌❌ TRANSACTION ABORTED: Territory ${territoryId} ownership conflict`);
                            throw new Error(`Territory ${territoryId} ownership conflict`);
                        }
                    }
                });
                
                log.info(`[TerritoryManager] ✅✅✅ [Transaction 성공] Territory ${territoryId} conquered by ${userName}${isAdmin ? ' (Admin)' : ''}`);
            } catch (transactionError) {
                // Transaction 실패 시 기존 방식으로 fallback (호환성 유지)
                if (transactionError.message && transactionError.message.includes('already owned')) {
                    // 이미 소유된 경우 - 사용자에게 명확한 에러 메시지
                    log.error(`[TerritoryManager] ❌ Territory ${territoryId} purchase failed: already owned`);
                    throw transactionError;
                }
                
                log.warn(`[TerritoryManager] ⚠️ Transaction failed, falling back to regular update:`, transactionError);
                // Fallback: 기존 방식으로 업데이트 시도
                await firebaseService.updateDocument('territories', territoryId, updateData);
            }
            
            // ⚠️ 전문가 조언 반영: Firestore 쓰기 직후 로그
            log.info(`[TerritoryManager] ✅✅✅ [Firestore 쓰기 성공] Territory ${territoryId} conquered by ${userName}${isAdmin ? ' (Admin)' : ''}. Successfully updated in Firestore.`);
            
            // ⚠️ 전문가 조언: 업데이트 후 즉시 확인하여 검증
            try {
                const verifyData = await firebaseService.getDocument('territories', territoryId);
                if (verifyData) {
                    log.info(`[TerritoryManager] ✅ Verification: Firestore document after update:`, {
                        hasRuler: verifyData.ruler !== undefined,
                        ruler: verifyData.ruler,
                        hasSovereignty: verifyData.sovereignty !== undefined,
                        sovereignty: verifyData.sovereignty,
                        rulerMatches: verifyData.ruler === userId
                    });
                    
                    // 검증: ruler가 일치하고 sovereignty가 일치하는지 확인
                    // 단, userId가 undefined인 경우는 이미 조기 반환했으므로 여기서는 항상 유효한 userId가 있어야 함
                    if (verifyData.ruler !== userId) {
                        log.error(`[TerritoryManager] ❌❌❌ VERIFICATION FAILED: Firestore update did not persist correctly!`);
                        log.error(`[TerritoryManager] Expected: ruler=${userId}, sovereignty=${territory.sovereignty}`);
                        log.error(`[TerritoryManager] Actual: ruler=${verifyData.ruler}, sovereignty=${verifyData.sovereignty}`);
                    } else if (verifyData.sovereignty !== territory.sovereignty) {
                        log.warn(`[TerritoryManager] ⚠️ Sovereignty mismatch: expected=${territory.sovereignty}, actual=${verifyData.sovereignty} (may be acceptable)`);
                    } else {
                        log.info(`[TerritoryManager] ✅ Verification passed: ruler and sovereignty match`);
                    }
                } else {
                    log.error(`[TerritoryManager] ❌❌❌ VERIFICATION FAILED: Territory ${territoryId} not found in Firestore after update!`);
                }
            } catch (verifyError) {
                log.error(`[TerritoryManager] ❌ Failed to verify Firestore update:`, verifyError);
            }
            
            // 규칙 B: 소유권이 바뀌면 이전 픽셀 아트 자동 초기화
            // 이전 소유자가 있었고, 새 소유자가 다른 경우에만 삭제
            if (previousRuler && previousRuler !== userId) {
                try {
                    log.info(`[TerritoryManager] 🎨 [픽셀 아트 자동 초기화] Ownership changed from ${previousRuler} to ${userId}, deleting previous pixel art...`);
                    
                    const { pixelDataService } = await import('../services/PixelDataService.js');
                    await pixelDataService.deletePixelData(territoryId);
                    
                    log.info(`[TerritoryManager] ✅ [픽셀 아트 자동 초기화 완료] Territory ${territoryId} pixel art deleted`);
                } catch (pixelDeleteError) {
                    // 픽셀 삭제 실패해도 소유권 변경은 성공한 것으로 처리
                    log.error(`[TerritoryManager] ⚠️ Failed to delete pixel art for ${territoryId}:`, pixelDeleteError);
                }
            }
            
            // 영토 업데이트 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { territory });
            
            // 영토 정복 이벤트 발행 (소유권 변경 완료)
            // ⚠️ 주의: 이 이벤트는 다른 모듈에서 구독할 수 있지만, 
            // TerritoryManager 자체는 이 이벤트를 구독하지 않도록 해야 함 (무한 루프 방지)
            // 대신 TERRITORY_UPDATE 이벤트만 사용하거나, 이벤트 이름을 다르게 해야 함
            // 현재는 TERRITORY_UPDATE만 발행하고, TERRITORY_CONQUERED는 다른 목적으로 사용
            
        } catch (error) {
            // ⚠️ 전문가 조언 반영: Firestore 쓰기 실패 시 상세 로그
            log.error(`[TerritoryManager] ❌❌❌ [Firestore 쓰기 실패] Failed to update territory ${territoryId} in Firestore`);
            log.error(`[TerritoryManager] ❌ 에러 타입: ${error.constructor.name}`);
            log.error(`[TerritoryManager] ❌ 에러 메시지: ${error.message}`);
            log.error(`[TerritoryManager] ❌ 에러 코드: ${error.code || 'N/A'}`);
            log.error(`[TerritoryManager] ❌ 전체 에러 객체:`, error);
            log.error(`[TerritoryManager] ❌ 업데이트하려던 데이터:`, {
                territoryId,
                ruler: userId,
                rulerName: userName,
                sovereignty: territory.sovereignty,
                purchasedByAdmin: isAdmin,
                purchasedPrice: tribute
            });
            // 에러가 발생해도 로컬 캐시는 업데이트되었으므로 계속 진행
        } finally {
            // 처리 완료 후 플래그 제거
            this.processingConquest.delete(territoryId);
        }
    }
    
    /**
     * 보호 기간 확인 (클라이언트 검증 강화)
     * ⚠️ CRITICAL: 서버 cron 실패 시 대비하여 클라이언트에서도 검증
     */
    isProtected(territoryId) {
        const territory = this.territories.get(territoryId);
        if (!territory || !territory.protectionEndsAt) return false;
        
        const protectionEnd = territory.protectionEndsAt instanceof Date 
            ? territory.protectionEndsAt 
            : new Date(territory.protectionEndsAt);
        
        const now = new Date();
        const isStillProtected = now < protectionEnd;
        
        // ⚠️ 보호 기간이 지났는데 sovereignty가 여전히 PROTECTED인 경우 자동 수정
        if (!isStillProtected && territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            log.warn(`[TerritoryManager] ⚠️ Protection expired for ${territoryId} but sovereignty is still PROTECTED, auto-correcting...`);
            // 비동기로 수정 (블로킹하지 않음)
            this._fixExpiredProtection(territoryId, territory).catch(err => {
                log.error(`[TerritoryManager] Failed to fix expired protection for ${territoryId}:`, err);
            });
            return false;
        }
        
        return isStillProtected;
    }
    
    /**
     * 만료된 보호 기간 자동 수정 (서버 cron 실패 시 대비)
     */
    async _fixExpiredProtection(territoryId, territory) {
        try {
            // Firestore에서 최신 상태 확인
            const latestTerritory = await firebaseService.getDocument('territories', territoryId);
            if (!latestTerritory) return;
            
            // 서버에서 이미 수정되었을 수 있으므로 다시 확인
            const protectionEnd = latestTerritory.protectionEndsAt instanceof Date 
                ? latestTerritory.protectionEndsAt 
                : new Date(latestTerritory.protectionEndsAt);
            
            if (new Date() >= protectionEnd && latestTerritory.sovereignty === SOVEREIGNTY.PROTECTED) {
                // 보호 기간이 지났고 여전히 PROTECTED 상태인 경우 RULED로 변경
                log.info(`[TerritoryManager] 🔧 Auto-fixing expired protection for ${territoryId}`);
                
                const Timestamp = firebaseService.getTimestamp();
                await firebaseService.updateDocument('territories', territoryId, {
                    sovereignty: SOVEREIGNTY.RULED,
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                });
                
                // 로컬 캐시도 업데이트
                territory.sovereignty = SOVEREIGNTY.RULED;
                this.territories.set(territoryId, territory);
                
                // 이벤트 발행
                eventBus.emit(EVENTS.TERRITORY_UPDATE, { territory });
                
                log.info(`[TerritoryManager] ✅ Auto-fixed expired protection for ${territoryId}`);
            }
        } catch (error) {
            log.error(`[TerritoryManager] Failed to fix expired protection:`, error);
        }
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
            // 전문가 조언: read → +1 → write 패턴 버리고 atomic increment 사용
            // increment(1) + serverTimestamp()로 단순화하고 동시성 안전성 확보
            
            const docRef = firebaseService._firestore.doc(
                firebaseService.db, 
                'territories', 
                territoryId
            );
            
            // 문서 존재 여부 확인 (territory는 seed 데이터로 미리 생성되어야 함)
            // compat 버전: docRef.get() 직접 사용
            const docSnap = await firebaseService.db.collection('territories').doc(territoryId).get();
            
            if (!docSnap.exists) {
                // territory가 없으면 그냥 실패 (create 허용 안 함)
                log.warn(`[TerritoryManager] Territory ${territoryId} does not exist, skipping view count increment`);
                return;
            }
            
            // Atomic increment 사용 (전문가 조언)
            // increment(1) + serverTimestamp()로 단순화하고 동시성 안전성 확보
            await firebaseService.db.collection('territories').doc(territoryId).update({
                viewCount: firebaseService._firestore.increment(1),
                lastViewedAt: firebaseService._firestore.serverTimestamp(),
                updatedAt: firebaseService._firestore.serverTimestamp()
            });
            
            // 로컬 캐시 업데이트 (최신 값 가져오기)
            const updatedDoc = await firebaseService.db.collection('territories').doc(territoryId).get();
            if (updatedDoc.exists) {
                const data = updatedDoc.data();
            const localTerritory = this.territories.get(territoryId);
            if (localTerritory) {
                    localTerritory.viewCount = data.viewCount || 0;
                    localTerritory.lastViewedAt = data.lastViewedAt?.toDate() || new Date();
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

