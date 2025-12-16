/**
 * TerritoryPanel - 영토 정보 패널 UI
 * 영토 상세 정보, 역사, 버프, 액션 버튼 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { SOVEREIGNTY, territoryManager } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';
import { buffSystem } from '../features/BuffSystem.js';
import { auctionSystem, AUCTION_STATUS, AUCTION_TYPE } from '../features/AuctionSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';
import { territoryDataService } from '../services/TerritoryDataService.js';
import { walletService } from '../services/WalletService.js';
import { rateLimiter, RATE_LIMIT_TYPE } from '../services/RateLimiter.js';

// View Mode 정의 (전문가 조언 반영)
const VIEW_MODE = {
    AVAILABLE: 'available',           // 아무도 소유하지 않음, 경매 없음
    AVAILABLE_AUCTION: 'available_auction', // 아무도 소유하지 않음, 경매 중
    MINE_IDLE: 'mine_idle',           // 내가 소유, 경매 없음
    MINE_AUCTION: 'mine_auction',     // 내가 소유, 경매 중
    OTHER_IDLE: 'other_idle',         // 남이 소유, 경매 없음
    OTHER_AUCTION: 'other_auction'    // 남이 소유, 경매 중
};

class TerritoryPanel {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.lang = 'en';  // English default
        this.countryData = null;
        this.isProcessingBid = false;  // ⚡ 입찰 처리 중 플래그 (중복 클릭 방지)
    }
    
    /**
     * 관리자 모드 확인
     */
    isAdminMode() {
        const adminAuth = sessionStorage.getItem('adminAuth');
        const adminUserMode = sessionStorage.getItem('adminUserMode');
        return !!(adminAuth && adminUserMode === 'true');
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'territory-panel') {
        this.container = document.getElementById(containerId);
        
        if (!this.container) {
            // 컨테이너가 없으면 생성
            this.container = document.createElement('div');
            this.container.id = containerId;
            this.container.className = 'territory-panel hidden';
            document.body.appendChild(this.container);
        }
        
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        log.info('TerritoryPanel initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 패널 열기 이벤트
        eventBus.on(EVENTS.UI_PANEL_OPEN, (data) => {
            if (data.type === 'territory') {
                this.open(data.data);
            }
        });
        
        // 패널 닫기 이벤트
        eventBus.on(EVENTS.UI_PANEL_CLOSE, (data) => {
            if (data.type === 'territory') {
                this.close();
            }
        });
        
        // ⚠️ 응급 조치: 이벤트 단순화 - TERRITORY_SELECTED만 구독 (중복 읽기 방지)
        // TERRITORY_SELECT 이벤트 리스너 제거됨
        eventBus.on(EVENTS.TERRITORY_SELECTED, async (data) => {
            const territoryId = data.territoryId || data.territory?.id;
            log.info(`[TerritoryPanel] 📥 [TerritoryPanel ← TERRITORY_SELECTED] TERRITORY_SELECTED event received: territoryId=${territoryId}, territory.id=${data.territory?.id}, country=${data.country}, properties.adm0_a3=${data.properties?.adm0_a3}`);
            
            if (!territoryId) {
                log.warn(`[TerritoryPanel] ⚠️ TERRITORY_SELECTED event missing territoryId`);
                return;
            }
            
            // ⚠️ 전문가 조언 반영: TerritoryManager가 완전히 하이드레이트된 territory 객체를 제공하므로
            // 이벤트의 territory 객체를 우선 사용 (단일 진실 원칙)
            let territory = null;
            
            // 이벤트 데이터에 territory 객체가 있으면 사용 (TerritoryManager가 완전히 하이드레이트한 객체)
            if (data.territory && data.territory.id) {
                territory = data.territory;
                log.info(`[TerritoryPanel] ✅ Using fully hydrated territory from event: id=${territory.id}, sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}`);
                
                // 이벤트 데이터의 추가 정보로 보완 (geometry, properties 등)
                if (data.geometry) territory.geometry = data.geometry;
                if (data.properties) {
                    territory.properties = { ...territory.properties, ...data.properties };
                }
                if (data.sourceId) territory.sourceId = data.sourceId;
                if (data.featureId) territory.featureId = data.featureId;
                if (data.country) territory.country = data.country;
            } else {
                // 이벤트에 territory 객체가 없으면 TerritoryManager에서 가져오기 (fallback)
                log.warn(`[TerritoryPanel] ⚠️ TERRITORY_SELECTED event missing territory object, fetching from TerritoryManager`);
                territory = territoryManager.getTerritory(territoryId);
                if (territory) {
                    // territory.id가 없으면 설정
                    if (!territory.id) {
                        territory.id = territoryId;
                    }
                    // 이벤트 데이터의 정확한 country와 properties로 업데이트
                    if (data.country) {
                        territory.country = data.country;
                    }
                    if (data.properties) {
                        territory.properties = { ...territory.properties, ...data.properties };
                    }
                    if (data.sourceId) territory.sourceId = data.sourceId;
                    if (data.featureId) territory.featureId = data.featureId;
                    if (data.geometry) territory.geometry = data.geometry;
                } else {
                    // TerritoryManager에 없으면 이벤트 데이터로 territory 객체 생성 (최후의 수단)
                    log.error(`[TerritoryPanel] ❌ Territory ${territoryId} not found in TerritoryManager, creating from event data`);
                    territory = {
                        id: territoryId,
                        name: data.properties?.name || data.properties?.name_en || territoryId,
                        country: data.country,
                        properties: data.properties,
                        geometry: data.geometry,
                        sourceId: data.sourceId,
                        featureId: data.featureId,
                        sovereignty: 'unconquered', // 기본값
                        ruler: null,
                        rulerName: null
                    };
                }
            }
            
            if (!territory) {
                log.error(`[TerritoryPanel] ❌ Cannot open panel: no territory data for ${territoryId}`);
                return;
            }
            
            // ⚠️ 전문가 조언: territory.id가 반드시 설정되어 있는지 확인
            if (!territory.id) {
                territory.id = territoryId;
                log.warn(`[TerritoryPanel] ⚠️ Territory ${territoryId} had no id, setting it now`);
            }
            
            log.info(`[TerritoryPanel] 📋 Opening panel for territory: id=${territory.id}, sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}, rulerName=${territory.rulerName || 'null'}`);
            
            // 디버깅: name 객체 구조 확인
            const nameDebug = territory.name ? (typeof territory.name === 'object' ? JSON.stringify(territory.name) : territory.name) : 'null';
            log.debug(`[TerritoryPanel] Opening panel for territory: ${territory.id}, name: ${nameDebug}, country: ${territory.country}`);
            this.open(territory);
        });
        
        // 영토 업데이트 이벤트
        // 옥션 업데이트 이벤트 리스닝 (다른 사용자의 입찰 반영)
        eventBus.on(EVENTS.AUCTION_UPDATE, async (data) => {
            if (data && data.auction && this.currentTerritory) {
                const auctionId = data.auction.id;
                const territoryId = data.auction.territoryId;
                
                // 현재 표시 중인 영토의 옥션이면 패널 새로고침
                if (territoryId === this.currentTerritory.id || 
                    (this.currentTerritory.currentAuction && this.currentTerritory.currentAuction.id === auctionId)) {
                    log.debug(`[TerritoryPanel] Auction ${auctionId} updated, refreshing panel`);
                    
                    // ⚡ 최적화: 전체 경매 재로드 대신 이벤트 데이터로 직접 업데이트
                    // loadActiveAuctions()는 이미 handleBid에서 캐시를 업데이트했으므로 불필요
                    // 이벤트로 전달된 데이터를 직접 사용
                    const updatedAuction = data.auction;
                    if (updatedAuction && this.currentTerritory) {
                        this.currentTerritory.currentAuction = updatedAuction;
                    }
                    
                    // 패널 새로고침
                    this.render();
                    this.bindActions();
                }
            }
        });
        
        eventBus.on(EVENTS.TERRITORY_UPDATE, (data) => {
            if (this.currentTerritory && this.currentTerritory.id === data.territory.id) {
                this.updateContent(data.territory);
            }
        });
    }
    
    /**
     * 패널 열기
     */
    open(territory) {
        this.currentTerritory = territory;
        this.isOpen = true;
        
        // HTML 렌더링
        this.render();
        
        // 패널 표시
        this.container.classList.remove('hidden');
        
        // 이벤트 바인딩
        this.bindActions();
        
        // 다른 큰 패널들은 닫기 (TerritoryPanel은 작은 패널이므로 유지 가능)
        // 하지만 TerritoryListPanel과 RankingBoard는 닫기
        this.closeLargePanels();
    }
    
    /**
     * 큰 패널들 닫기 (TerritoryPanel은 작은 사이드 패널이므로 다른 큰 패널들과 겹칠 수 있음)
     */
    closeLargePanels() {
        // TerritoryListPanel 닫기
        const territoryListPanel = document.getElementById('territory-list-panel');
        if (territoryListPanel) {
            territoryListPanel.classList.add('hidden');
        }
        
        // RankingBoard 닫기
        const rankingBoard = document.getElementById('ranking-board');
        if (rankingBoard) {
            rankingBoard.classList.add('hidden');
        }
    }
    
    /**
     * 패널 닫기
     */
    close() {
        this.isOpen = false;
        this.currentTerritory = null;
        this.container.classList.add('hidden');
    }
    
    /**
     * 콘텐츠 업데이트
     */
    updateContent(territory) {
        this.currentTerritory = territory;
        this.render();
        this.bindActions();
    }
    
    /**
     * 패널 렌더링
     */
    async render() {
        const t = this.currentTerritory;
        if (!t) return;
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        
        // ⚠️ 전문가 조언 반영: TerritoryPanel은 Firestore를 직접 건드리지 않음
        // TerritoryManager가 이미 완전히 하이드레이트된 territory 객체를 제공하므로
        // 그대로 사용 (단일 진실 원칙)
        const territory = t;
        
        log.debug(`[TerritoryPanel] Rendering territory ${territory.id}: sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}, rulerName=${territory.rulerName || 'null'}`);
        
        // 소유자 체크: 일반 사용자 소유 또는 관리자 모드에서 관리자가 구매한 영토
        const isOwner = user && (
            territory.ruler === user.uid || 
            (isAdmin && territory.purchasedByAdmin)
        );
        // 로그인한 사용자만 경매 정보 표시
        const auction = user ? auctionSystem.getAuctionByTerritory(territory.id) : null;
        
        // 보호 기간 확인
        const protectionRemaining = territoryManager.getProtectionRemaining(territory.id);
        const isProtected = !!protectionRemaining;
        
        // 국가 코드 결정 (우선순위: territory.country > properties > fallback)
        // 이름 추출 전에 countryCode를 먼저 결정해야 extractName에서 사용 가능
        // properties에서 사용 가능한 필드: adm0_a3 (USA), country (United States of America), countryCode (US1), sov_a3 (US1)
        let countryCode = territory.country || 
                        territory.properties?.country || 
                        territory.properties?.country_code ||
                        territory.properties?.adm0_a3?.toLowerCase() ||  // adm0_a3 우선 사용 (USA -> usa)
                        territory.properties?.sov_a3?.toLowerCase() ||
                        'unknown';
        
        // 잘못된 값 필터링: "territories", "states", "regions" 등은 무시
        const invalidCodes = ['territories', 'states', 'regions', 'prefectures', 'provinces', 'unknown'];
        if (invalidCodes.includes(countryCode?.toLowerCase())) {
            countryCode = null;
        }
        
        // countryCode가 국가명인 경우 슬러그로 변환 시도 (예: "United States of America" -> "usa")
        if (countryCode && !CONFIG.COUNTRIES[countryCode]) {
            const normalized = countryCode.toLowerCase().replace(/\s+/g, '-');
            if (CONFIG.COUNTRIES[normalized]) {
                countryCode = normalized;
            } else {
                // 국가명으로 검색
                for (const [key, value] of Object.entries(CONFIG.COUNTRIES)) {
                    if (value.name === countryCode || value.nameKo === countryCode) {
                        countryCode = key;
                        break;
                    }
                }
            }
        }
        
        // countryCode가 없거나 유효하지 않은 경우, properties에서 다시 시도
        if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
            // properties에서 다른 필드 시도 (adm0_a3 우선)
            let altCode = territory.properties?.adm0_a3 ||  // ISO 코드 (예: "USA")
                         territory.properties?.country_code || 
                         territory.properties?.sov_a3 ||
                         territory.properties?.iso_a3;
            
            if (altCode) {
                altCode = altCode.toString().toUpperCase(); // ISO 코드는 대문자로 처리
                
                // ISO 코드를 슬러그로 변환하는 매핑
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
                    'NER': 'niger', 'MLI': 'mali', 'SEN': 'senegal', 'GHA': 'ghana',
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
                    'TTO': 'trinidad-and-tobago', 'BRB': 'barbados',
                    'BHS': 'bahamas', 'BLZ': 'belize', 'CRI': 'costa-rica', 'PAN': 'panama',
                    'NIC': 'nicaragua', 'HND': 'honduras', 'SLV': 'el-salvador',
                    // 아시아/오세아니아 추가
                    'PNG': 'papua-new-guinea', 'FJI': 'fiji', 'VUT': 'vanuatu', 'SLB': 'solomon-islands',
                    'WSM': 'samoa', 'TON': 'tonga', 'KIR': 'kiribati', 'PLW': 'palau',
                    'FSM': 'micronesia', 'MHL': 'marshall-islands', 'NRU': 'nauru',
                    'TUV': 'tuvalu', 'NZL': 'new-zealand',
                    // 유럽 추가
                    'AND': 'andorra', 'MCO': 'monaco', 'SMR': 'san-marino', 'VAT': 'vatican',
                    'LIE': 'liechtenstein'
                };
                
                const slugCode = isoToSlug[altCode];
                
                if (slugCode && !invalidCodes.includes(slugCode) && CONFIG.COUNTRIES[slugCode]) {
                    countryCode = slugCode;
                } else {
                    // properties.admin이나 properties.geonunit에서 국가명 추출 시도
                    let countryName = territory.properties?.admin || territory.properties?.geonunit;
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
                            countryCode = normalizedName;
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
                                    countryCode = key;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            
        }
        
        // 이름 추출 (displayName 우선 사용) - 먼저 선언
        let territoryName = null;
        
        // countryCode 결정 (territoryName 사용 전에 완료)
        if (territory.country && !countryCode) {
            // 여전히 없으면 territoryId에서 국가 코드 추출 시도
            if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
                // territoryId 형식: "singapore-0", "usa-1" 등
                const territoryIdParts = territory.id?.split('-');
                if (territoryIdParts && territoryIdParts.length > 0) {
                    const possibleCountryCode = territoryIdParts[0];
                    if (CONFIG.COUNTRIES[possibleCountryCode]) {
                        countryCode = possibleCountryCode;
                        log.debug(`[TerritoryPanel] Using country code from territoryId: ${countryCode} for ${territory.id}`);
                    }
                }
            }
            
            // 여전히 없으면 'unknown'으로 설정 (mapController.currentCountry는 사용하지 않음)
            // ⚠️ mapController.currentCountry를 사용하면 모든 territory의 country가 덮어써질 수 있음
            if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
                countryCode = 'unknown';
                log.warn(`[TerritoryPanel] Invalid country code: ${territory.country}, territory: ${territory.id}, properties: ${JSON.stringify(territory.properties)}`);
            }
        }
        
        // 1. displayName 우선 사용 (TerritoryManager에서 준비된 표시용 이름)
        if (territory.displayName) {
            log.info(`[TerritoryPanel] Using displayName for ${territory.id}:`, territory.displayName);
            territoryName = this.extractName(territory.displayName, countryCode);
            log.info(`[TerritoryPanel] Extracted name from displayName: ${territoryName} (countryCode: ${countryCode})`);
        } else {
            log.warn(`[TerritoryPanel] ⚠️ No displayName for ${territory.id}, creating it now...`);
            // displayName이 없으면 지금 생성 (TerritoryManager에서 생성하지 않은 경우)
            if (territoryManager && typeof territoryManager.createDisplayName === 'function') {
                territory.displayName = territoryManager.createDisplayName(territory);
                log.debug(`[TerritoryPanel] Created displayName for ${territory.id}:`, territory.displayName);
                territoryName = this.extractName(territory.displayName, countryCode);
                log.debug(`[TerritoryPanel] Extracted name from created displayName:`, territoryName);
            } else {
                log.debug(`[TerritoryPanel] Cannot create displayName, using fallback`);
            }
        }
        
        // 2. displayName이 없으면 기존 방식 사용 (하위 호환성)
        if (!territoryName) {
            territoryName = this.extractName(territory.name, countryCode);
        }
        if (!territoryName) {
            territoryName = this.extractName(territory.properties?.name, countryCode);
        }
        if (!territoryName) {
            territoryName = this.extractName(territory.properties?.name_en, countryCode);
        }
        if (!territoryName) {
            // 최후의 수단: territoryId 사용
            territoryName = territory.id || 'Unknown Territory';
        }
        
        // 디버깅: 이름 추출 실패 시에만 로그
        if (territoryName === 'Unknown Territory' || !territoryName || territoryName === territory.id) {
            log.warn(`[TerritoryPanel] ⚠️ Failed to extract proper name for ${territory.id}`, {
                nameObject: territory.name,
                propertiesName: territory.properties?.name,
                propertiesNameEn: territory.properties?.name_en,
                countryCode,
                extractedName: territoryName
            });
        }
        
        // Get real country data
        this.countryData = territoryDataService.getCountryStats(countryCode);
        const countryInfo = CONFIG.COUNTRIES[countryCode] || {};
        
        // 인구/면적 데이터 추출 (TerritoryDataService 사용)
        // countryCode 디버깅: 최종 결정된 countryCode 로그
        if (!countryInfo.name && countryCode !== 'unknown') {
            log.warn(`[TerritoryPanel] Country info not found for code: ${countryCode}, territory: ${territoryName}`);
        }
        
        const population = territoryDataService.extractPopulation(territory, countryCode);
        const area = territoryDataService.extractArea(territory, countryCode);
        
        // 디버깅: 인구/면적 데이터 확인
        if (territoryName.toLowerCase() === 'texas') {
            log.debug(`[TerritoryPanel] Texas - countryCode: ${countryCode}, isoCode: ${territoryDataService.convertToISOCode(countryCode)}, population: ${population}, area: ${area}`);
        }
        
        // 픽셀 수 계산 (면적 기반)
        const pixelCount = territoryDataService.calculatePixelCount(territory, countryCode);
        
        // 가격 계산 (픽셀 수 기반)
        const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        
        // 국가명: CONFIG에서 가져오거나, 없으면 countryCode를 그대로 사용 (절대 properties.admin 사용 안 함)
        const countryName = countryInfo.name || countryInfo.nameKo || countryCode || 'Unknown';
        const countryFlag = countryInfo.flag || '🏳️';
        
        // UI 상태 단순화: Available / Owned / On Auction 3개만 표시
        // 내부적으로는 SOVEREIGNTY를 사용하되, 사용자에게는 단순화된 상태만 보여줌
        let uiStatus = 'available';  // 'available' | 'owned' | 'auction'
        let sovereigntyText = 'Available';
        let sovereigntyIcon = '✅';
        let sovereigntyClass = 'unconquered';
        
        // ⚠️ 중요: 소유자 상태 우선 체크
        // 소유자가 있는 경우에도 경매는 정상적으로 표시됨 (소유권 획득 경매)
        const hasOwner = territory.ruler && territory.ruler.trim() !== '';
        const hasActiveAuction = auction && auction.status === AUCTION_STATUS.ACTIVE;
        
        // 소유자가 있는 경우 우선 (경매가 있어도 소유자 상태 표시)
        if (territory.ruler && territory.sovereignty !== SOVEREIGNTY.UNCONQUERED) {
            uiStatus = 'owned';
            sovereigntyText = 'Owned';
            sovereigntyIcon = '👑';
            sovereigntyClass = isProtected ? 'protected' : 'ruled';
        }
        // 경매 중인 경우 (소유자가 없는 경우만)
        else if (hasActiveAuction && !hasOwner) {
            uiStatus = 'auction';
            sovereigntyText = 'On Auction';
            sovereigntyIcon = '⏳';
            sovereigntyClass = 'contested';
        }
        // 소유자가 없는 경우
        else {
            uiStatus = 'available';
            sovereigntyText = 'Available';
            sovereigntyIcon = '✅';
            sovereigntyClass = 'unconquered';
            
            // CONTESTED 상태인데 경매가 없으면 UNCONQUERED로 복구
            if (territory.sovereignty === SOVEREIGNTY.CONTESTED && !auction) {
                setTimeout(async () => {
                    try {
                        // TODO: API에 영토 상태 업데이트 엔드포인트가 있으면 사용
                        // 현재는 로컬 상태만 업데이트
                        log.info('[TerritoryPanel] Fixing territory state locally (API update endpoint needed)');
                        territory.sovereignty = SOVEREIGNTY.UNCONQUERED;
                        territory.currentAuction = null;
                        await this.render();
                        this.bindActions();
                    } catch (error) {
                        log.error('Failed to fix territory state:', error);
                    }
                }, 0);
            }
        }
        
        this.container.innerHTML = `
            <div class="panel-header">
                <div class="territory-title">
                    <span class="territory-icon">${this.getTerritoryIcon(territory.sovereignty)}</span>
                    <h2>${territoryName}</h2>
                </div>
                <button class="close-btn" id="close-territory-panel">&times;</button>
            </div>
            
            <div class="panel-content">
                <!-- Sovereignty Status -->
                <div class="sovereignty-section">
                    <div class="sovereignty-badge ${sovereigntyClass}">
                        <span class="sovereignty-icon">${sovereigntyIcon}</span>
                        <span class="sovereignty-text">${sovereigntyText}</span>
                    </div>
                    ${territory.ruler ? `
                        <div class="ruler-info">
                            <span class="ruler-label">👑 Owner:</span>
                            <span class="ruler-name">${territory.rulerName || 'Unknown'}</span>
                            ${territory.purchasedByAdmin ? '<span class="admin-badge">🔧 Admin</span>' : ''}
                        </div>
                        ${isProtected && protectionRemaining ? `
                            <div class="protection-info">
                                <span class="protection-icon">🛡️</span>
                                <span>Protected for ${protectionRemaining.days || 0}d ${protectionRemaining.hours || 0}h</span>
                            </div>
                        ` : ''}
                    ` : ''}
                </div>
                
                <!-- Territory Info Card -->
                <div class="territory-info-card">
                    <div class="info-row">
                        <span class="info-label">${countryFlag} Country</span>
                        <span class="info-value">${countryName}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">👥 Population</span>
                        <span class="info-value">${territoryDataService.formatNumber(population)}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">📏 Area</span>
                        <span class="info-value">${territoryDataService.formatArea(area)}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">🔗 Share</span>
                        <span class="info-value">
                            <div class="share-buttons" style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                                <button class="share-btn share-twitter" data-platform="twitter" title="Twitter 공유">
                                    <span>🐦</span>
                                </button>
                                <button class="share-btn share-facebook" data-platform="facebook" title="Facebook 공유">
                                    <span>📘</span>
                                </button>
                                <button class="share-btn share-kakao" data-platform="kakao" title="카카오톡 공유">
                                    <span>💬</span>
                                </button>
                                <button class="share-btn share-copy" data-platform="copy" title="링크 복사">
                                    <span>📋</span>
                                </button>
                            </div>
                        </span>
                    </div>
                    <div class="info-row highlight">
                        <span class="info-label">💰 Price</span>
                        <span class="info-value price">${territoryDataService.formatPrice(realPrice)}</span>
                    </div>
                </div>
                
                <!-- Pixel Info -->
                <div class="pixel-info-card">
                    <div class="pixel-header">
                        <span>🎨 Ad Space</span>
                        <span class="pixel-count">${this.formatNumber(pixelCount)} px</span>
                    </div>
                    <div class="pixel-bar">
                        <div class="pixel-bar-fill" style="width: ${Math.min(100, (pixelCount / 100))}%"></div>
                    </div>
                </div>
                
                <!-- Auction Info (if exists) -->
                ${auction && auction.status === AUCTION_STATUS.ACTIVE ? this.renderAuction(auction) : ''}
                
                <!-- Protection Extension Auctions List (if owned territory, shows summary) -->
                ${isOwner ? this.renderProtectionExtensionAuctions(territory) : ''}
                
                <!-- Action Buttons -->
                <div class="territory-actions">
                    ${this.renderActions(territory, isOwner, auction, realPrice, auction ? this.getEffectiveAuctionBid(auction) : null)}
                </div>
            </div>
        `;
    }
    
    /**
     * 버프 섹션 렌더링
     */
    renderBuffs(territory) {
        if (!territory.ruler) return '';
        
        const buffs = buffSystem.formatBuffsForUI(territory.ruler, this.lang);
        
        if (buffs.length === 0) return '';
        
        return `
            <div class="buffs-section">
                <h3>⚡ 적용 버프</h3>
                <div class="buff-list">
                    ${buffs.map(buff => `
                        <div class="buff-item" style="border-color: ${buff.color}">
                            <span class="buff-icon">${buff.icon}</span>
                            <span class="buff-name">${buff.name}</span>
                            <span class="buff-bonus">${buff.bonusText}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    /**
     * 역사 섹션 렌더링
     */
    renderHistory(territory) {
        const history = territory.history || [];
        
        if (history.length === 0) return '';
        
        // 최근 5개만 표시
        const recentHistory = history.slice(-5).reverse();
        
        return `
            <div class="history-section">
                <h3>📜 Territory History</h3>
                <ul class="history-timeline">
                    ${recentHistory.map(event => `
                        <li class="history-item ${event.type}">
                            <span class="history-date">${this.formatDate(event.timestamp)}</span>
                            <span class="history-text">${this.getEventText(event)}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }
    
    /**
     * Protection Extension Auctions Rendering
     */
    renderProtectionExtensionAuctions(territory) {
        const protectionAuctions = this.getProtectionExtensionAuctions(territory.id);
        
        if (protectionAuctions.length === 0) {
            return '';
        }
        
        const auctionCards = protectionAuctions.map(auction => {
            const periodLabels = {
                7: '1 Week',
                30: '1 Month',
                365: '1 Year',
                null: 'Lifetime'
            };
            
            const periodLabel = periodLabels[auction.protectionDays];
            const hasBids = !!auction.highestBidder;
            const currentBid = hasBids ? auction.currentBid : auction.startingBid;
            const timeRemaining = this.getTimeRemaining(auction.endTime);
            
            return `
                <div class="protection-auction-card">
                    <div class="protection-auction-header">
                        <span class="auction-icon">🛡️</span>
                        <h4>${periodLabel} Extension</h4>
                    </div>
                    <div class="protection-auction-info">
                        <div class="bid-info">
                            <span class="bid-label">${hasBids ? 'Current Bid' : 'Starting Bid'}:</span>
                            <span class="bid-value">${this.formatNumber(currentBid)} pt</span>
                        </div>
                        <div class="time-info">
                            <span class="time-label">Time Left:</span>
                            <span class="time-value">${timeRemaining}</span>
                        </div>
                        ${hasBids ? `
                            <div class="bidder-info">
                                <span class="bidder-label">Highest Bidder:</span>
                                <span class="bidder-name">${auction.highestBidderName || 'Unknown'}</span>
                            </div>
                        ` : `
                            <div class="no-bids-notice">
                                <span class="notice-icon">💡</span>
                                <span>No bids yet. Be the first to bid!</span>
                            </div>
                        `}
                    </div>
                </div>
            `;
        }).join('');
        
        return `
            <div class="protection-extension-auctions-section">
                <h3>🛡️ Protection Extension Auctions</h3>
                <div class="protection-auctions-grid">
                    ${auctionCards}
                </div>
            </div>
        `;
    }
    
    /**
     * Auction Section Rendering
     */
    renderAuction(auction) {
        // 영토 정보 가져오기 (실제 가격 계산용)
        const territory = this.currentTerritory;
        let realTerritoryPrice = null;
        
        if (territory) {
            // 영토의 실제 가격 계산
            const countryCode = territory.country || 
                              territory.properties?.country || 
                              territory.properties?.adm0_a3?.toLowerCase() || 
                              'unknown';
            realTerritoryPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        }
        
        // 경매가 종료되었는지 확인
        if (auction.status === 'ended' || auction.status === AUCTION_STATUS.ENDED) {
            return `
                <div class="auction-section auction-ended">
                    <h3>Auction Ended</h3>
                    <div class="auction-info">
                        <div class="auction-result">
                            ${auction.highestBidder 
                                ? `<span>Winner: ${auction.highestBidderName || 'Unknown'}</span><span>Final Bid: ${this.formatNumber(auction.currentBid)} pt</span>`
                                : '<span>No bids placed</span>'
                            }
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 경매 종료 시간 확인
        const endTime = auction.endTime;
        let isExpired = false;
        
        if (endTime) {
            let endDate;
            // Firestore Timestamp 처리
            if (endTime && typeof endTime === 'object') {
                if (endTime.toDate && typeof endTime.toDate === 'function') {
                    endDate = endTime.toDate();
                } else if (endTime.seconds) {
                    endDate = new Date(endTime.seconds * 1000);
                } else if (endTime instanceof Date) {
                    endDate = endTime;
                } else {
                    endDate = new Date(endTime);
                }
            } else {
                endDate = new Date(endTime);
            }
            
            if (endDate && !isNaN(endDate.getTime())) {
                const now = new Date();
                if (endDate.getTime() <= now.getTime()) {
                    isExpired = true;
                }
            }
        }
        
        // 만료된 경매는 종료 처리
        if (isExpired) {
            // 옥션 종료 처리 (비동기)
            const endPromise = auctionSystem.endAuction(auction.id).catch(err => {
                log.error('[TerritoryPanel] Failed to end expired auction:', err);
            });
            
            // 옥션 종료 후 영토 상태 업데이트 대기
            endPromise.then(async () => {
                // 영토 상태 다시 로드
                const territory = territoryManager.getTerritory(territory.id);
                if (territory) {
                    // API에서 최신 데이터 로드
                    try {
                        const latestData = await apiService.getTerritory(territory.id);
                        if (latestData) {
                            // API 응답을 내부 형식으로 변환
                            const normalizedData = territoryManager.normalizeTerritoryData 
                                ? territoryManager.normalizeTerritoryData(latestData)
                                : latestData;
                            
                            // 영토 데이터 업데이트
                            Object.assign(territory, normalizedData);
                            territoryManager.territories.set(territory.id, territory);
                            
                            // 패널 다시 렌더링
                            this.render();
                            log.info('[TerritoryPanel] Territory updated after auction end');
                        }
                    } catch (error) {
                        log.warn('[TerritoryPanel] Failed to reload territory after auction end:', error);
                    }
                }
            });
            
            // 종료 중임을 표시
            return `
                <div class="auction-section auction-ending">
                    <h3>Auction Ending...</h3>
                    <div class="auction-info">
                        <div class="auction-result">
                            Processing auction results...
                            ${auction.highestBidder 
                                ? `<br><small>Winner: ${auction.highestBidderName || 'Unknown'}</small>`
                                : '<br><small>No bids placed</small>'
                            }
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 가격 정보는 단일 출처 함수 사용 (전문가 조언 반영)
        const priceInfo = this.getUserFacingPriceInfo(auction, territory);
        if (!priceInfo) {
            return '<div class="auction-section">Invalid auction data</div>';
        }
        
        const hasBids = priceInfo.hasBids;
        const startingBid = priceInfo.startingBid;
        const effectiveCurrentBid = priceInfo.currentBid;
        // 입찰자가 있든 없든 항상 1pt 증가액 사용 (1pt 단위 입찰)
        const effectiveMinIncrement = 1;
        
        // 보호 기간 연장 경매인지 확인
        const isProtectionExtension = auction.type === AUCTION_TYPE.PROTECTION_EXTENSION;
        
        // 보호 기간 레이블
        const periodLabels = {
            7: '1 Week',
            30: '1 Month',
            365: '1 Year',
            null: 'Lifetime'
        };
        const periodLabel = isProtectionExtension && auction.protectionDays !== undefined 
            ? periodLabels[auction.protectionDays] || 'Unknown'
            : null;
        
        return `
            <div class="auction-section ${isProtectionExtension ? 'protection-extension' : ''}">
                <h3>${isProtectionExtension ? `🛡️ Protection Extension Auction (${periodLabel})` : 'Active Auction'}</h3>
                <div class="auction-info">
                    ${hasBids ? `
                        <div class="current-bid">
                            <span class="bid-label">Current Bid</span>
                            <span class="bid-amount">${this.formatNumber(effectiveCurrentBid)} pt</span>
                        </div>
                        <div class="highest-bidder">
                            <span class="bidder-label">Highest Bidder</span>
                            <span class="bidder-name">${auction.highestBidderName || 'Unknown'}</span>
                        </div>
                    ` : `
                        <div class="starting-bid">
                            <span class="bid-label">Starting Bid</span>
                            <span class="bid-amount">${this.formatNumber(startingBid)} pt</span>
                        </div>
                        <div class="no-bids-notice">
                            <span class="notice-icon">💡</span>
                            <span>No bids yet. Be the first to bid!</span>
                        </div>
                    `}
                    <div class="time-remaining">
                        <span class="time-label">Time Left</span>
                        <span class="time-value">${this.getTimeRemaining(auction.endTime)}</span>
                    </div>
                </div>
                <div class="bid-input-group">
                    <input type="number" id="bid-amount-input" 
                           placeholder="Bid amount" 
                           min="${hasBids ? (effectiveCurrentBid + effectiveMinIncrement) : (startingBid + 1)}"
                           value="${hasBids ? (effectiveCurrentBid + effectiveMinIncrement) : (startingBid + 1)}">
                    <button class="bid-btn" id="place-bid-btn">Place Bid</button>
                </div>
            </div>
        `;
    }
    
    /**
     * 경매의 유효한 입찰가 계산 (단일 출처 사용 - 전문가 조언 반영)
     * @deprecated getUserFacingPriceInfo() 사용 권장
     */
    getEffectiveAuctionBid(auction) {
        if (!auction || !this.currentTerritory) return null;
        
        const priceInfo = this.getUserFacingPriceInfo(auction, this.currentTerritory);
        return priceInfo ? priceInfo.currentBid : null;
    }
    
    /**
     * View Mode 결정 (전문가 조언 반영)
     * 상태를 사람이 이해하기 쉬운 View Mode로 압축
     */
    determineViewMode(territory, auction, isOwner) {
        const hasOwner = territory.ruler && territory.ruler.trim() !== '';
        const hasActiveAuction = auction && auction.status === AUCTION_STATUS.ACTIVE;
        
        log.info('[TerritoryPanel] determineViewMode:', {
            territoryId: territory.id,
            hasOwner,
            isOwner,
            hasActiveAuction,
            auctionStatus: auction?.status,
            auctionId: auction?.id
        });
        
        if (!hasOwner && !hasActiveAuction) {
            return VIEW_MODE.AVAILABLE;
        }
        if (!hasOwner && hasActiveAuction) {
            return VIEW_MODE.AVAILABLE_AUCTION;
        }
        if (isOwner && !hasActiveAuction) {
            log.info('[TerritoryPanel] View mode: MINE_IDLE (owner, no auction)');
            return VIEW_MODE.MINE_IDLE;
        }
        if (isOwner && hasActiveAuction) {
            log.info('[TerritoryPanel] View mode: MINE_AUCTION (owner, active auction)');
            return VIEW_MODE.MINE_AUCTION;
        }
        if (hasOwner && !isOwner && !hasActiveAuction) {
            return VIEW_MODE.OTHER_IDLE;
        }
        if (hasOwner && !isOwner && hasActiveAuction) {
            return VIEW_MODE.OTHER_AUCTION;
        }
        
        // 기본값
        log.warn('[TerritoryPanel] View mode: AVAILABLE (default fallback)');
        return VIEW_MODE.AVAILABLE;
    }
    
    /**
     * 경매 시작가 계산 (단일 출처 - 전문가 조언 반영)
     */
    getAuctionStartingPrice(auction, territory) {
        if (!auction || !territory) return null;
        
        // 영토 실제 가격 계산
        const countryCode = territory.country || 
                          territory.properties?.country || 
                          territory.properties?.adm0_a3?.toLowerCase() || 
                          'unknown';
        const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        const correctStartingBid = realPrice ? realPrice + 1 : 10;
        
        // 경매에 startingBid가 있으면 검증 후 사용
        if (auction.startingBid && auction.startingBid > 0) {
            // startingBid가 올바른 값인지 검증 (realPrice + 1과 비교)
            // 10pt 차이 이내면 허용 (버프나 다른 요인 고려)
            const diff = Math.abs(auction.startingBid - correctStartingBid);
            if (diff <= 10) {
                return auction.startingBid;
            } else {
                // 잘못된 값이면 올바른 값으로 수정
                log.warn(`[TerritoryPanel] Invalid startingBid ${auction.startingBid} in getAuctionStartingPrice, using correct value ${correctStartingBid} (realPrice: ${realPrice})`);
                return correctStartingBid;
            }
        }
        
        // startingBid가 없으면 계산된 값 반환
        return correctStartingBid;
    }
    
    /**
     * 사용자에게 표시할 경매 가격 정보 (단일 출처)
     */
    getUserFacingPriceInfo(auction, territory) {
        if (!auction) return null;
        
        const startingBid = this.getAuctionStartingPrice(auction, territory);
        const hasBids = !!auction.highestBidder;
        const currentBid = hasBids 
            ? Math.max(auction.currentBid || startingBid, startingBid)
            : startingBid;
        const minNextBid = currentBid + 1;
        
        return {
            startingBid,
            currentBid,
            minNextBid,
            hasBids,
            highestBidder: auction.highestBidder,
            highestBidderName: auction.highestBidderName
        };
    }
    
    /**
     * Action Buttons Rendering (View Mode 기반 - 전문가 조언 반영)
     */
    renderActions(territory, isOwner, auction, realPrice = 100, effectiveAuctionBid = null) {
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        
        if (!user) {
            return `
                <button class="action-btn login-btn" id="login-to-conquer">
                    🔐 Sign in to Purchase
                </button>
            `;
        }
        
        // View Mode 결정
        const viewMode = this.determineViewMode(territory, auction, isOwner);
        log.info('[TerritoryPanel] renderActions - viewMode:', viewMode, 'for territory:', territory.id);
        
        // View Mode별 UI 렌더링
        switch (viewMode) {
            case VIEW_MODE.AVAILABLE:
                // 아무도 소유하지 않음, 경매 없음
                return `
                    <button class="action-btn conquest-btn" id="instant-conquest">
                        🏴 Claim This Spot (${this.formatNumber(realPrice)} pt)
                    </button>
                    <button class="action-btn auction-btn" id="start-auction">
                        🏷️ Start Auction
                    </button>
                `;
                
            case VIEW_MODE.AVAILABLE_AUCTION:
                // 아무도 소유하지 않음, 경매 중
                // 전문가 조언: 소유자 없는 경매에만 Buy Now 허용 가능
                const priceInfo1 = this.getUserFacingPriceInfo(auction, territory);
                if (!priceInfo1) return '';
                
                const isUserHighestBidder1 = auction.highestBidder === user?.uid;
                const minBid1 = priceInfo1.minNextBid;
                
                // Buy Now 가격: realPrice 또는 현재 입찰가의 115%
                let buyNowPrice1 = realPrice;
                if (priceInfo1.currentBid >= realPrice) {
                    buyNowPrice1 = Math.max(
                        Math.ceil(minBid1 * 1.15),
                        minBid1 + 10
                    );
                }
                
                return `
                    <div class="action-options-header">
                        <h4>📋 Choose Your Action</h4>
                        <p class="action-hint">You have two options to acquire this territory</p>
                    </div>
                    
                    <div class="action-option-card">
                        <div class="option-header">
                            <span class="option-icon">⚡</span>
                            <span class="option-title">Buy Now</span>
                            <span class="option-badge instant">Instant</span>
                        </div>
                        <div class="option-price">
                            <span class="price-label">Price:</span>
                            <span class="price-value">${this.formatNumber(buyNowPrice1)} pt</span>
                        </div>
                        <button class="action-btn conquest-btn" id="instant-conquest" data-buy-now-price="${buyNowPrice1}">
                            Buy Now (${this.formatNumber(buyNowPrice1)} pt)
                        </button>
                    </div>
                    
                    <div class="action-divider">
                        <span>OR</span>
                    </div>
                    
                    <div class="action-option-card">
                        <div class="option-header">
                            <span class="option-icon">⏳</span>
                            <span class="option-title">Bid to Claim</span>
                            <span class="option-badge auction">Auction</span>
                        </div>
                        <div class="option-price">
                            <span class="price-label">${priceInfo1.hasBids ? 'Current Bid:' : 'Starting Bid:'}</span>
                            <span class="price-value">${this.formatNumber(priceInfo1.currentBid)} pt</span>
                        </div>
                        ${!priceInfo1.hasBids ? `
                            <div class="no-bids-notice">
                                <span class="notice-icon">💡</span>
                                <span>No bids yet. Be the first to bid!</span>
                            </div>
                        ` : ''}
                        <div class="auction-action-hint">
                            <span class="hint-icon">💡</span>
                            <span>Place your bid in the auction section above (minimum: ${this.formatNumber(priceInfo1.minNextBid)} pt)</span>
                        </div>
                    </div>
                `;
                
            case VIEW_MODE.MINE_IDLE:
                // 내가 소유, 경매 없음
                return `
                    <button class="action-btn pixel-btn" id="open-pixel-editor">
                        🎨 Edit My Spot
                    </button>
                    <button class="action-btn collab-btn" id="open-collaboration">
                        👥 Open Collaboration
                    </button>
                    <button class="action-btn auction-btn" id="start-territory-auction">
                        🏷️ Start Auction
                    </button>
                `;
                
            case VIEW_MODE.MINE_AUCTION:
                // 내가 소유, 경매 중
                // 전문가 조언: 소유 지역 경매는 오직 입찰만, Buy Now 없음
                const priceInfo2 = this.getUserFacingPriceInfo(auction, territory);
                if (!priceInfo2) return '';
                
                const isUserHighestBidder2 = auction.highestBidder === user?.uid;
                
                return `
                    <div class="auction-active-notice">
                        <span class="info-icon">ℹ️</span>
                        <span>Your territory is under challenge. Bid to defend your ownership.</span>
                    </div>
                    <button class="action-btn pixel-btn" id="open-pixel-editor">
                        🎨 Edit My Spot
                    </button>
                    <button class="action-btn collab-btn" id="open-collaboration">
                        👥 Open Collaboration
                    </button>
                    <div class="action-option-card">
                        <div class="option-header">
                            <span class="option-icon">🛡️</span>
                            <span class="option-title">Bid to Defend</span>
                            <span class="option-badge auction">Auction</span>
                        </div>
                        <div class="option-price">
                            <span class="price-label">${priceInfo2.hasBids ? 'Current Bid:' : 'Starting Bid:'}</span>
                            <span class="price-value">${this.formatNumber(priceInfo2.currentBid)} pt</span>
                            ${isUserHighestBidder2 ? `
                                <span class="bidder-badge">(You are leading)</span>
                            ` : ''}
                        </div>
                        ${!priceInfo2.hasBids ? `
                            <div class="no-bids-notice">
                                <span class="notice-icon">💡</span>
                                <span>No bids yet. Be the first to bid!</span>
                            </div>
                        ` : ''}
                        <div class="auction-action-hint">
                            <span class="hint-icon">💡</span>
                            <span>Place your bid in the auction section above (minimum: ${this.formatNumber(priceInfo2.minNextBid)} pt)</span>
                        </div>
                    </div>
                `;
                
            case VIEW_MODE.OTHER_IDLE:
                // 남이 소유, 경매 없음
                const isAdminOwned = isAdmin && territory.purchasedByAdmin;
                
                if (isAdminOwned) {
                    return `
                        <div class="admin-territory-notice">
                            <span class="notice-icon">🔧</span>
                            <span>Admin-owned territory</span>
                        </div>
                    `;
                }
                
                return `
                    <button class="action-btn auction-btn" id="start-territory-auction">
                        🏷️ Start Auction
                    </button>
                `;
                
            case VIEW_MODE.OTHER_AUCTION:
                // 남이 소유, 경매 중
                // 전문가 조언: 소유 지역 경매는 오직 입찰만, Buy Now 없음
                const priceInfo3 = this.getUserFacingPriceInfo(auction, territory);
                if (!priceInfo3) return '';
                
                const isProtected = territoryManager.isProtected(territory.id);
                const protectionRemaining = isProtected ? territoryManager.getProtectionRemaining(territory.id) : null;
                
                return `
                    ${isProtected && protectionRemaining ? `
                        <div class="protected-notice">
                            <span class="protected-icon">🛡️</span>
                            <span>Protected Territory</span>
                            <small>Protection ends in ${protectionRemaining.days || 0}d ${protectionRemaining.hours || 0}h</small>
                        </div>
                    ` : ''}
                    <div class="action-option-card">
                        <div class="option-header">
                            <span class="option-icon">⚔️</span>
                            <span class="option-title">Bid to Conquer</span>
                            <span class="option-badge auction">Auction</span>
                        </div>
                        <div class="option-price">
                            <span class="price-label">${priceInfo3.hasBids ? 'Current Bid:' : 'Starting Bid:'}</span>
                            <span class="price-value">${this.formatNumber(priceInfo3.currentBid)} pt</span>
                            ${priceInfo3.highestBidderName ? `
                                <span class="bidder-info">by ${priceInfo3.highestBidderName}</span>
                            ` : ''}
                        </div>
                        ${!priceInfo3.hasBids ? `
                            <div class="no-bids-notice">
                                <span class="notice-icon">💡</span>
                                <span>No bids yet. Be the first to bid!</span>
                            </div>
                        ` : ''}
                        <div class="auction-action-hint">
                            <span class="hint-icon">💡</span>
                            <span>Place your bid in the auction section above (minimum: ${this.formatNumber(priceInfo3.minNextBid)} pt)</span>
                        </div>
                    </div>
                `;
                
            default:
                return '';
        }
    }
    
    /**
     * 액션 바인딩 (이벤트 위임 패턴 적용 - 전문가 조언 반영)
     */
    bindActions() {
        if (!this.container) return;
        
        // 기존 리스너 제거 (중복 방지)
        if (this._actionClickHandler) {
            this.container.removeEventListener('click', this._actionClickHandler);
        }
        
        // 이벤트 위임: container에 단일 리스너로 모든 버튼 클릭 처리
        this._actionClickHandler = (e) => {
            // 버튼이나 클릭 가능한 요소를 찾음
            const target = e.target.closest('button[id], [id].action-btn, [id].auction-btn');
            if (!target) return;
            
            const id = target.id;
            log.info('[TerritoryPanel] Action button clicked:', id);
            
            // 닫기 버튼
            if (id === 'close-territory-panel') {
                e.preventDefault();
                this.close();
                return;
            }
            
            // 로그인 버튼
            if (id === 'login-to-conquer') {
                e.preventDefault();
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
                return;
            }
            
            // 즉시 정복 버튼
            if (id === 'instant-conquest') {
                e.preventDefault();
                e.stopPropagation();
                log.info('[TerritoryPanel] instant-conquest button clicked');
                this.handleInstantConquest().catch(error => {
                    log.error('[TerritoryPanel] Error in handleInstantConquest:', error);
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: 'Failed to process purchase. Please try again.'
                    });
                });
                return;
            }
            
            // 옥션 시작 버튼
            if (id === 'start-auction') {
                e.preventDefault();
                this.handleStartAuction();
                return;
            }
            
            // 입찰 버튼
            if (id === 'place-bid-btn') {
                e.preventDefault();
                this.handlePlaceBid();
                return;
            }
            
            // Owner Challenge 버튼
            if (id === 'challenge-ruler') {
                e.preventDefault();
                this.handleChallengeOwner();
                return;
            }
            
            // Protection Extension Auction 버튼
            if (id === 'start-protection-extension-auction') {
                e.preventDefault();
                this.handleStartProtectionExtensionAuction();
                return;
            }
            
            // Start Territory Auction 버튼 (소유자가 있는 지역의 경매 시작)
            if (id === 'start-territory-auction') {
                e.preventDefault();
                e.stopPropagation();
                log.info('[TerritoryPanel] start-territory-auction button clicked');
                this.showTerritoryAuctionOptionsModal();
                return;
            }
            
            // 픽셀 에디터 버튼
            if (id === 'open-pixel-editor') {
                e.preventDefault();
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { 
                    type: 'pixelEditor', 
                    data: this.currentTerritory 
                });
                return;
            }
            
            // 협업 버튼
            if (id === 'open-collaboration') {
                e.preventDefault();
                // TODO: 협업 모달 열기
                return;
            }
        };
        
        // 리스너 추가
        this.container.addEventListener('click', this._actionClickHandler);
        
        // 소셜 공유 버튼 (이벤트 위임)
        this.container.addEventListener('click', (e) => {
            const shareBtn = e.target.closest('.share-btn');
            if (shareBtn) {
                e.preventDefault();
                const platform = shareBtn.dataset.platform;
                this.shareTerritory(platform);
            }
        });
    }
    
    /**
     * 영토 공유
     */
    shareTerritory(platform) {
        const t = this.currentTerritory;
        if (!t) return;
        
        const countryCode = t.country || t.properties?.adm0_a3?.toLowerCase() || 'unknown';
        const territoryName = this.extractName(t.name, countryCode) || t.id;
        const shareUrl = `${window.location.origin}${window.location.pathname}?territory=${t.id}`;
        const shareText = `🌍 Check out this territory: ${territoryName} on Own a Piece of Earth!`;
        const shareTitle = `Own a Piece of Earth - ${territoryName}`;
        
        let shareWindowUrl = '';
        
        switch (platform) {
            case 'twitter':
                shareWindowUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
                break;
            case 'facebook':
                shareWindowUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
                break;
            case 'kakao':
                // 카카오톡 공유는 JavaScript SDK 필요 (선택적)
                if (window.Kakao && window.Kakao.isInitialized()) {
                    window.Kakao.Share.sendDefault({
                        objectType: 'feed',
                        content: {
                            title: shareTitle,
                            description: shareText,
                            imageUrl: `${window.location.origin}/og-image.png`,
                            link: {
                                mobileWebUrl: shareUrl,
                                webUrl: shareUrl,
                            },
                        },
                    });
                    return;
                } else {
                    // 카카오 SDK 없으면 일반 링크 공유
                    this.copyToClipboard(shareUrl);
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'success',
                        message: '링크가 클립보드에 복사되었습니다!'
                    });
                    return;
                }
            case 'copy':
                this.copyToClipboard(shareUrl);
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'success',
                    message: '링크가 클립보드에 복사되었습니다!'
                });
                return;
            default:
                return;
        }
        
        if (shareWindowUrl) {
            window.open(shareWindowUrl, '_blank', 'width=600,height=400');
        }
    }
    
    /**
     * 클립보드에 복사
     */
    async copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
        } catch (error) {
            log.error('Failed to copy to clipboard:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '클립보드 복사에 실패했습니다.'
            });
        }
    }
    
    /**
     * 즉시 정복 처리
     */
    async handleInstantConquest() {
        log.info('[TerritoryPanel] handleInstantConquest called');
        
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        
        // 로그인 체크
        if (!user) {
            log.warn('[TerritoryPanel] User not logged in');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to purchase this territory'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            log.error('[TerritoryPanel] No territory selected');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '선택된 영토가 없습니다'
            });
            return;
        }
        
        log.info('[TerritoryPanel] Territory selected:', this.currentTerritory.id);
        
        const countryCode = this.currentTerritory.country || 
                           this.currentTerritory.properties?.adm0_a3?.toLowerCase() || 
                           this.currentTerritory.properties?.country || 
                           'unknown';
        const territoryName = this.extractName(this.currentTerritory.name, countryCode) || 
                             this.extractName(this.currentTerritory.properties?.name, countryCode) ||
                             this.currentTerritory.id;
        
        // 경매가 활성화되어 있는지 확인
        const activeAuction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isUserHighestBidder = activeAuction && activeAuction.highestBidder === user.uid;
        
        // 경매가 활성화되어 있고 입찰자가 있는 경우 확인 다이얼로그
        if (activeAuction && activeAuction.status === AUCTION_STATUS.ACTIVE && activeAuction.highestBidder) {
            const confirmMessage = isUserHighestBidder
                ? `This will cancel the auction and refund your bid of ${this.formatNumber(activeAuction.currentBid)} pt. Continue?`
                : `This will cancel the active auction. The current highest bidder will be refunded. Continue?`;
            
            if (!confirm(confirmMessage)) {
                log.info('[TerritoryPanel] User cancelled auction cancellation');
                return;
            }
            
            // 경매 취소 처리
            try {
                await auctionSystem.endAuction(activeAuction.id);
                log.info(`Auction ${activeAuction.id} cancelled due to instant purchase`);
            } catch (error) {
                log.warn('Failed to cancel auction, continuing with purchase:', error);
            }
        }
        
        // 기본 가격 계산
        let basePrice = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
        
        log.info('[TerritoryPanel] Base price calculated:', basePrice);
        
        // 경매 중일 때 Buy Now 가격 조정
        if (activeAuction && activeAuction.status === AUCTION_STATUS.ACTIVE) {
            const buyNowBtn = document.getElementById('instant-conquest');
            const adjustedPrice = buyNowBtn?.dataset?.buyNowPrice;
            
            if (adjustedPrice) {
                basePrice = parseFloat(adjustedPrice);
                log.info('[TerritoryPanel] Using adjusted price from button:', basePrice);
            } else {
                const auctionCurrentBid = this.getEffectiveAuctionBid(activeAuction);
                const minBid = auctionCurrentBid + 1;
                
                if (auctionCurrentBid >= basePrice) {
                    basePrice = Math.max(
                        Math.ceil(minBid * 1.15),
                        minBid + 10
                    );
                    log.info('[TerritoryPanel] Adjusted price based on auction bid:', basePrice);
                }
            }
        }
        
        // 구매 옵션 선택 모달 표시
        log.info('[TerritoryPanel] Showing purchase options modal');
        try {
            this.showPurchaseOptionsModal(basePrice, territoryName, activeAuction);
            log.info('[TerritoryPanel] Purchase options modal shown successfully');
        } catch (error) {
            log.error('[TerritoryPanel] Failed to show purchase options modal:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Failed to open purchase options. Please try again.'
            });
        }
    }
    
    /**
     * 구매 옵션 선택 모달 표시
     */
    showPurchaseOptionsModal(basePrice, territoryName, activeAuction) {
        log.info('[TerritoryPanel] showPurchaseOptionsModal called', { basePrice, territoryName });
        
        // 구매 옵션 정의
        const purchaseOptions = [
            {
                id: 'week',
                label: '1주일',
                labelEn: '1 Week',
                days: 7,
                multiplier: 1.0,
                icon: '📅',
                description: '7일 보호 기간',
                descriptionEn: '7 days protection'
            },
            {
                id: 'month',
                label: '1개월',
                labelEn: '1 Month',
                days: 30,
                multiplier: 3.5,
                icon: '📆',
                description: '30일 보호 기간',
                descriptionEn: '30 days protection'
            },
            {
                id: 'year',
                label: '1년',
                labelEn: '1 Year',
                days: 365,
                multiplier: 30.0,
                icon: '🗓️',
                description: '365일 보호 기간',
                descriptionEn: '365 days protection'
            },
            {
                id: 'lifetime',
                label: '평생',
                labelEn: 'Lifetime',
                days: null, // null = 평생
                multiplier: 100.0,
                icon: '👑',
                description: '영구 보호',
                descriptionEn: 'Permanent protection'
            }
        ];
        
        // 모달 HTML 생성
        const optionsHTML = purchaseOptions.map(option => {
            const price = Math.ceil(basePrice * option.multiplier);
            const isLifetime = option.id === 'lifetime';
            return `
                <div class="purchase-option-card" data-option-id="${option.id}" data-days="${option.days || 'lifetime'}" data-price="${price}">
                    <div class="option-header">
                        <span class="option-icon">${option.icon}</span>
                        <div class="option-title">
                            <h3>${option.label}</h3>
                            <span class="option-label-en">${option.labelEn}</span>
                        </div>
                    </div>
                    <div class="option-body">
                        <div class="option-price">
                            <span class="price-value">${this.formatNumber(price)}</span>
                            <span class="price-unit">pt</span>
                        </div>
                        <div class="option-description">${option.description}</div>
                        ${isLifetime ? '<div class="option-badge">⭐ Best Value</div>' : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        const modalHTML = `
            <div class="purchase-options-modal" id="purchase-options-modal">
                <div class="modal-overlay"></div>
                <div class="modal-content purchase-options-content">
                    <div class="modal-header">
                        <h2>🏴 구매 옵션 선택</h2>
                        <button class="modal-close" id="close-purchase-options">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="territory-info-summary">
                            <span class="territory-name">${territoryName}</span>
                            <span class="base-price">기본 가격: ${this.formatNumber(basePrice)} pt</span>
                        </div>
                        <div class="purchase-options-grid">
                            ${optionsHTML}
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" id="cancel-purchase-options">취소</button>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달이 있으면 제거
        const existingModal = document.getElementById('purchase-options-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        log.info('[TerritoryPanel] Modal HTML inserted into DOM');
        
        // DOM이 업데이트될 시간을 주기 위해 약간의 지연
        // 이벤트 바인딩을 다음 이벤트 루프에서 실행
        setTimeout(() => {
            this.bindPurchaseOptionsModalEvents(territoryName, activeAuction);
        }, 0);
    }
    
    /**
     * 구매 옵션 모달 이벤트 바인딩
     */
    bindPurchaseOptionsModalEvents(territoryName, activeAuction) {
        const modal = document.getElementById('purchase-options-modal');
        if (!modal) {
            log.error('[TerritoryPanel] Modal element not found after insertion!');
            return;
        }
        
        log.info('[TerritoryPanel] Modal styled and displayed');
        
        const closeBtn = document.getElementById('close-purchase-options');
        const cancelBtn = document.getElementById('cancel-purchase-options');
        const overlay = modal.querySelector('.modal-overlay');
        const optionCards = modal.querySelectorAll('.purchase-option-card');
        
        log.info('[TerritoryPanel] Found elements:', {
            closeBtn: !!closeBtn,
            cancelBtn: !!cancelBtn,
            overlay: !!overlay,
            optionCards: optionCards.length
        });
        
        // 닫기 버튼
        const closeModal = () => {
            log.info('[TerritoryPanel] Closing purchase options modal');
            modal.remove();
        };
        
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeModal();
            });
        }
        
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeModal();
            });
        }
        
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                e.stopPropagation();
                closeModal();
            });
        }
        
        // ESC 키로 닫기
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);
        
        // 옵션 카드 클릭
        if (optionCards.length === 0) {
            log.error('[TerritoryPanel] No option cards found!');
            return;
        }
        
        optionCards.forEach((card, index) => {
            const optionId = card.dataset.optionId;
            log.info(`[TerritoryPanel] Binding click event to option card ${index}:`, {
                optionId,
                hasDataset: !!card.dataset,
                element: card
            });
            
            // 클릭 이벤트
            card.addEventListener('click', (e) => {
                log.info(`[TerritoryPanel] ✅ Option card clicked!`, {
                    optionId,
                    target: e.target?.className,
                    currentTarget: e.currentTarget?.className,
                    dataset: card.dataset
                });
                
                // 이벤트 전파 중지
                e.stopPropagation();
                e.preventDefault();
                
                // 선택 표시
                optionCards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                
                // 구매 진행
                const days = card.dataset.days === 'lifetime' ? null : parseInt(card.dataset.days);
                const price = parseInt(card.dataset.price);
                
                log.info(`[TerritoryPanel] Processing purchase:`, {
                    optionId,
                    days,
                    price,
                    territoryName
                });
                
                closeModal();
                this.processPurchaseWithOption(price, days, territoryName, activeAuction);
            });
            
            // 디버깅: 마우스 이벤트도 확인
            card.addEventListener('mousedown', () => {
                log.info(`[TerritoryPanel] Option card mousedown: ${optionId}`);
            });
            
            card.addEventListener('mouseenter', () => {
                log.debug(`[TerritoryPanel] Option card mouseenter: ${optionId}`);
            });
        });
        
        log.info(`[TerritoryPanel] ✅ All events bound to ${optionCards.length} option cards`);
    }
    
    /**
     * 선택한 옵션으로 구매 처리
     * ⚠️ CRITICAL: 로딩 상태 표시 및 사용자 피드백 개선
     */
    async processPurchaseWithOption(price, protectionDays, territoryName, activeAuction) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to purchase this territory'
            });
            return;
        }
        
        // ⚠️ 로딩 상태 표시
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'info',
            message: '🔄 구매 처리 중... 잠시만 기다려주세요.'
        });
        
        try {
            // 잔액 확인
            const { walletService } = await import('../services/WalletService.js');
            const currentBalance = walletService.getBalance();
            
            if (currentBalance < price) {
                const shortage = price - currentBalance;
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: `❌ 잔액이 부족합니다. ${this.formatNumber(shortage)} pt가 더 필요합니다.`
                });
                return;
            }
            
            // ⚠️ 사용자 피드백: 잔액 차감 시작
            log.info(`[TerritoryPanel] 💰 Processing purchase: ${price} pt for ${territoryName} (${protectionDays || 'lifetime'} days)`);
            
            // 잔액 차감
            await walletService.deductPoints(price, `Territory purchase: ${territoryName}`, 'purchase', {
                territoryId: this.currentTerritory.id,
                protectionDays: protectionDays,
                territoryName: territoryName
            });
            
            // ⚠️ 사용자 피드백: 구매 처리 중
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'info',
                message: '✅ 포인트 차감 완료. 영토 구매 처리 중...'
            });
            
            // 결제 시작 이벤트 (PaymentService에서 처리)
            // protectionDays를 이벤트에 포함하여 TerritoryManager에서 사용할 수 있도록 함
            eventBus.emit(EVENTS.PAYMENT_START, {
                type: 'conquest',
                territoryId: this.currentTerritory.id,
                territoryName: territoryName,
                amount: price,
                protectionDays: protectionDays, // null이면 평생
                cancelAuction: !!activeAuction
            });
            
            // ⚠️ 사용자 피드백: 성공
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `🎉 ${territoryName} 구매 완료!`
            });
            
        } catch (error) {
            log.error('Purchase failed:', error);
            
            // ⚠️ 사용자 친화적 에러 메시지
            let errorMessage = '구매 처리에 실패했습니다.';
            let errorType = 'error';
            
            if (error.message?.includes('Insufficient balance')) {
                errorMessage = `❌ 잔액이 부족합니다. ${this.formatNumber(price)} pt가 필요합니다.`;
                errorType = 'error';
            } else if (error.message?.includes('already owned') || error.message?.includes('already ruled')) {
                errorMessage = '⚠️ 이 영토는 이미 다른 사용자가 구매했습니다.';
                errorType = 'warning';
            } else if (error.message?.includes('Auction in progress')) {
                errorMessage = '⚠️ 이 영토는 현재 경매 중입니다.';
                errorType = 'warning';
            } else if (error.message?.includes('network') || error.message?.includes('offline')) {
                errorMessage = '🌐 네트워크 연결을 확인하고 다시 시도해주세요.';
                errorType = 'error';
            } else if (error.message?.includes('Ownership changed')) {
                errorMessage = '⚠️ 구매 중 소유권이 변경되었습니다. 잔액은 환불됩니다.';
                errorType = 'warning';
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: errorType,
                message: errorMessage
            });
            
            // 포인트 환불 시도 (구매 실패 시)
            if (error.message?.includes('already owned') || error.message?.includes('Ownership changed')) {
                try {
                    const { walletService } = await import('../services/WalletService.js');
                    await walletService.addPoints(price, `Refund: Purchase failed for ${territoryName}`, 'bid_refund', {
                        territoryId: this.currentTerritory.id,
                        reason: 'purchase_failed'
                    });
                    log.info(`[TerritoryPanel] ✅ Refunded ${price} pt due to purchase failure`);
                } catch (refundError) {
                    log.error('[TerritoryPanel] Failed to refund points:', refundError);
                }
            }
        }
    }
    
    /**
     * 옥션 시작 처리
     */
    async handleStartAuction() {
        const user = firebaseService.getCurrentUser();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to start an auction'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No territory selected'
            });
            return;
        }
        
        try {
            // 옥션 생성
            await auctionSystem.createAuction(this.currentTerritory.id);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '🎯 Auction started! Place your bids!'
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Auction start failed:', error);
            
            // 사용자 친화적 에러 메시지
            let errorMessage = 'Failed to start auction';
            if (error.message.includes('Authentication')) {
                errorMessage = 'Please sign in first';
            } else if (error.message.includes('not found')) {
                errorMessage = 'Territory not found';
            } else if (error.message.includes('in progress')) {
                errorMessage = 'An auction is already in progress';
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage
            });
        }
    }
    
    /**
     * Owner Challenge 처리
     * 다른 사용자가 소유한 영토에 대해 경매를 시작하여 소유권을 도전
     */
    async handleChallengeOwner() {
        const user = firebaseService.getCurrentUser();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: '경매를 시작하려면 로그인이 필요합니다'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '선택된 영토가 없습니다'
            });
            return;
        }
        
        // 소유자 확인
        if (!this.currentTerritory.ruler) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '이 영토에는 소유자가 없습니다'
            });
            return;
        }
        
        // 자신의 영토인지 확인
        if (this.currentTerritory.ruler === user.uid) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: '이미 소유하고 있는 영토입니다'
            });
            return;
        }
        
        // 확인 다이얼로그
        const countryCode = this.currentTerritory.country || 
                           this.currentTerritory.properties?.adm0_a3?.toLowerCase() || 
                           'unknown';
        const territoryName = this.extractName(this.currentTerritory.name, countryCode) || 
                             this.extractName(this.currentTerritory.properties?.name, countryCode) ||
                             this.currentTerritory.id;
        const ownerName = this.currentTerritory.rulerName || 'Unknown';
        
        if (!confirm(`이 영토(${territoryName})의 소유자(${ownerName})에게 도전하시겠습니까?\n\n경매가 시작되며, 최고 입찰자가 새로운 소유자가 됩니다.`)) {
            return;
        }
        
        try {
            // 경매 생성 (handleStartAuction과 동일한 로직)
            await auctionSystem.createAuction(this.currentTerritory.id);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '경매가 시작되었습니다!'
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Challenge owner failed:', error);
            
            // 사용자 친화적 에러 메시지
            let errorMessage = '경매 시작에 실패했습니다';
            if (error.message.includes('Authentication')) {
                errorMessage = '먼저 로그인해주세요';
            } else if (error.message.includes('not found')) {
                errorMessage = '영토를 찾을 수 없습니다';
            } else if (error.message.includes('in progress') || error.message.includes('already exists')) {
                errorMessage = '이미 진행 중인 경매가 있습니다';
                // 경매 정보를 다시 로드하여 표시
                this.render();
                this.bindActions();
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage
            });
        }
    }
    
    /**
     * 입찰 처리
     */
    async handlePlaceBid() {
        // ⚡ 중복 클릭 방지: 이미 처리 중이면 무시
        if (this.isProcessingBid) {
            log.debug('[TerritoryPanel] Bid already processing, ignoring duplicate click');
            return;
        }
        
        const input = document.getElementById('bid-amount-input');
        if (!input) return;
        
        const bidAmount = parseInt(input.value, 10);
        const user = firebaseService.getCurrentUser();
        const auction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isAdmin = this.isAdminMode();
        
        // ⚡ 처리 시작 플래그 설정
        this.isProcessingBid = true;
        
        // 버튼 비활성화 (UI 피드백)
        const bidButton = document.getElementById('place-bid-btn');
        if (bidButton) {
            bidButton.disabled = true;
            bidButton.textContent = 'Processing...';
        }
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to place a bid'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!auction) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No active auction found'
            });
            return;
        }
        
        // 입찰 금액 검증
        if (!bidAmount || isNaN(bidAmount) || bidAmount <= 0) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please enter a valid bid amount'
            });
            return;
        }
        
        // 입찰자가 있는지 확인
        const hasBids = !!auction.highestBidder;
        
        // 입찰자가 없으면 무조건 startingBid 사용 (currentBid는 무시)
        // 입찰자가 있으면 currentBid 사용
        let effectiveCurrentBid;
        if (!hasBids) {
            // 입찰자가 없으면 startingBid를 그대로 사용 (currentBid는 확인하지 않음)
            // 화면에 표시된 startingBid와 일치해야 함
            effectiveCurrentBid = auction.startingBid || 10;
            log.debug('[TerritoryPanel] No bids yet, using startingBid:', effectiveCurrentBid);
        } else {
            // 입찰자가 있으면 currentBid 사용 (최소 startingBid 이상이어야 함)
            effectiveCurrentBid = auction.currentBid && auction.currentBid >= (auction.startingBid || 0)
                ? auction.currentBid
                : (auction.startingBid || 10);
            log.debug('[TerritoryPanel] Has bids, using currentBid:', effectiveCurrentBid);
        }
        
        // minIncrement 계산
        // 입찰자가 있든 없든 항상 1pt 증가액 사용 (1pt 단위 입찰)
        const effectiveMinIncrement = 1;
        
        const minBid = effectiveCurrentBid + effectiveMinIncrement;
        
        // 디버깅 로그
        log.debug('[TerritoryPanel] Bid validation:', {
            startingBid: auction.startingBid,
            currentBid: auction.currentBid,
            highestBidder: auction.highestBidder,
            hasBids,
            effectiveCurrentBid,
            effectiveMinIncrement,
            minBid,
            bidAmount
        });
        
        if (bidAmount < minBid) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `Minimum bid is ${this.formatNumber(minBid)} pt`
            });
            return;
        }
        
        // 관리자 모드가 아닌 경우에만 잔액 체크
        if (!isAdmin) {
            const currentBalance = walletService.getBalance();
            if (currentBalance < bidAmount) {
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: `Insufficient balance. You have ${this.formatNumber(currentBalance)} pt`
                });
                // PaymentService의 충전 모달 열기
                eventBus.emit(EVENTS.PAYMENT_START, {
                    type: 'bid',
                    amount: bidAmount
                });
                return;
            }
        }
        
        // ⚠️ Step 6-4: READ_ONLY 모드 체크
        const { serviceModeManager } = await import('../services/ServiceModeManager.js');
        if (serviceModeManager.currentMode === serviceModeManager.SERVICE_MODE.READ_ONLY) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: '현재는 입찰이 제한된 상태입니다. 다시 시도해주세요.',
                duration: 5000
            });
            return;
        }
        
        try {
            // Rate Limiting 체크 (관리자가 아닌 경우에만)
            if (!isAdmin && user?.uid) {
                const rateLimitCheck = await rateLimiter.checkLimit(user.uid, RATE_LIMIT_TYPE.AUCTION_BID);
                if (!rateLimitCheck.allowed) {
                    const waitTime = rateLimitCheck.retryAfter ? Math.ceil(rateLimitCheck.retryAfter / 1000) : 0;
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: `⚠️ Too many bids. Please wait ${waitTime > 0 ? waitTime + ' seconds' : 'a moment'} before bidding again.`,
                        duration: 5000
                    });
                    return;
                }
            }
            
            // ⚠️ Step 6-3: Optimistic Update - 입찰 전 상태 저장
            const previousAuctionState = JSON.parse(JSON.stringify(auction)); // Deep copy
            const previousWalletBalance = !isAdmin ? walletService.currentBalance : null;
            
            // Optimistic Update: UI에 즉시 반영
            auction.currentBid = bidAmount;
            auction.highestBidder = user.uid;
            auction.highestBidderName = user.displayName || user.email;
            if (!auction.bids) auction.bids = [];
            auction.bids.push({
                userId: user.uid,
                userName: user.displayName || user.email,
                amount: bidAmount,
                timestamp: new Date()
            });
            
            // 로컬 캐시에 즉시 반영
            auctionSystem.activeAuctions.set(auction.id, auction);
            if (this.currentTerritory) {
                this.currentTerritory.currentAuction = auction;
            }
            
            // UI 즉시 업데이트
            this.render();
            this.bindActions();
            
            // 관리자 모드가 아닌 경우에만 포인트 차감
            if (!isAdmin) {
                await walletService.deductPoints(bidAmount, `Auction bid for ${auction.territoryId}`, 'bid', {
                    auctionId: auction.id,
                    territoryId: auction.territoryId
                });
            }
            
            // ⚠️ Step 6-1: 서버 권위 강화 - 실제 서버 호출 (현재는 클라이언트 트랜잭션, 나중에 Cloud Functions로 전환)
            await auctionSystem.handleBid({
                auctionId: auction.id,
                bidAmount,
                userId: user.uid,
                userName: user.displayName || user.email,
                isAdmin: isAdmin  // ✅ 관리자 플래그 추가
            });
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `🎯 Bid placed: ${this.formatNumber(bidAmount)} pt`
            });
            
            // 입력 필드 초기화
            input.value = '';
            
            // ⚠️ 응급 조치: 입찰 후 Firestore 재조회 제거 (불필요한 읽기 방지)
            // handleBid가 이미 로컬 캐시(activeAuctions)를 업데이트했으므로 Firestore 재조회 불필요
            // 로컬 캐시에서 직접 가져오기
            const updatedAuction = auctionSystem.activeAuctions.get(auction.id);
            if (updatedAuction && this.currentTerritory) {
                // currentTerritory의 옥션 정보 업데이트
                this.currentTerritory.currentAuction = updatedAuction;
                
                // 디버깅: 입찰가 확인
                const highestBid = updatedAuction.bids && Array.isArray(updatedAuction.bids) && updatedAuction.bids.length > 0
                    ? Math.max(...updatedAuction.bids.map(b => b.amount || b.buffedAmount || 0))
                    : 0;
                
                log.info(`[TerritoryPanel] ✅ Bid placed successfully. Updated auction data:`, {
                    auctionId: auction.id,
                    currentBid: updatedAuction.currentBid,
                    highestBidFromArray: highestBid,
                    bidsCount: updatedAuction.bids?.length || 0,
                    highestBidder: updatedAuction.highestBidder
                });
            } else {
                log.warn(`[TerritoryPanel] ⚠️ Failed to get updated auction data for ${auction.id}`);
            }
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Bid failed:', error);
            
            // ⚠️ Step 6-3: Optimistic Update 롤백
            try {
                if (previousAuctionState) {
                    auctionSystem.activeAuctions.set(auction.id, previousAuctionState);
                    if (this.currentTerritory) {
                        this.currentTerritory.currentAuction = previousAuctionState;
                    }
                }
                if (previousWalletBalance !== null && !isAdmin) {
                    // 지갑 잔액 롤백 (실제로는 서버에서 처리되지만, UI만 롤백)
                    walletService.currentBalance = previousWalletBalance;
                    eventBus.emit('wallet:balance-updated', { balance: previousWalletBalance });
                }
                // UI 롤백
                this.render();
                this.bindActions();
            } catch (rollbackError) {
                log.error('[TerritoryPanel] Failed to rollback optimistic update:', rollbackError);
            }
            
            let errorMessage = 'Failed to place bid';
            let shouldRetry = false;
            
            // ⚠️ Step 6-4: Firebase 할당량 초과 에러 처리 - 저비용 모드 전환
            if (error.code === 'resource-exhausted' || error.code === 'quota-exceeded' || 
                error.message?.includes('Quota exceeded') || error.message?.includes('resource-exhausted')) {
                errorMessage = '⚠️ Service temporarily unavailable due to high traffic. Please try again in a few moments.';
                log.warn('[TerritoryPanel] Firestore quota exceeded, switching to read-only mode');
                
                // ⚠️ Step 6-4: 저비용 모드 전환
                const { serviceModeManager } = await import('../services/ServiceModeManager.js');
                serviceModeManager.setMode(serviceModeManager.SERVICE_MODE.READ_ONLY, { reason: 'quota-exceeded' });
            } 
            // 최소 입찰가 에러
            else if (error.message.includes('Minimum')) {
                errorMessage = error.message;
            } 
            // 경매 종료 에러
            else if (error.message.includes('not active')) {
                errorMessage = 'Auction has ended';
            }
            // 일반적인 에러
            else if (error.message) {
                errorMessage = `Bid failed: ${error.message}`;
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage,
                duration: error.code === 'resource-exhausted' || error.code === 'quota-exceeded' ? 8000 : 5000
            });
        } finally {
            // ⚡ 처리 완료 플래그 해제 및 버튼 복원
            this.isProcessingBid = false;
            const bidButton = document.getElementById('place-bid-btn');
            if (bidButton) {
                bidButton.disabled = false;
                bidButton.textContent = 'Place Bid';
            }
        }
    }
    
    // ==================== 헬퍼 메서드 ====================
    
    /**
     * 이름 추출 (객체일 수 있으므로 문자열로 변환)
     */
    /**
     * 국가별 언어 필드 매핑 (영어 기본, 괄호 안에 현지어 표시)
     */
    getCountryLanguageField(countryCode) {
        if (!countryCode) return null;
        
        // 국가별 언어 필드 매핑
        const countryLangMap = {
            // 아시아
            'south-korea': 'ko', 'north-korea': 'ko',
            'japan': 'ja',
            'china': 'zh', 'taiwan': 'zh', 'hong-kong': 'zh',
            'thailand': 'th',
            'vietnam': 'vi',
            'indonesia': 'id',
            'malaysia': 'ms',
            'philippines': 'tl',
            'india': 'hi',
            'myanmar': 'my',
            'cambodia': 'km',
            'laos': 'lo',
            'mongolia': 'mn',
            'nepal': 'ne',
            'sri-lanka': 'si',
            'kazakhstan': 'kk',
            'uzbekistan': 'uz',
            'bangladesh': 'bn',
            'pakistan': 'ur',
            'afghanistan': 'ps',
            'iran': 'fa',
            'iraq': 'ar',
            'saudi-arabia': 'ar', 'uae': 'ar', 'qatar': 'ar', 'kuwait': 'ar',
            'bahrain': 'ar', 'oman': 'ar', 'yemen': 'ar', 'jordan': 'ar',
            'lebanon': 'ar', 'syria': 'ar', 'palestine': 'ar',
            'israel': 'he',
            'turkey': 'tr',
            // 유럽
            'germany': 'de',
            'france': 'fr',
            'spain': 'es',
            'italy': 'it',
            'portugal': 'pt',
            'greece': 'el',
            'poland': 'pl',
            'romania': 'ro',
            'hungary': 'hu',
            'czech-republic': 'cs',
            'netherlands': 'nl',
            'belgium': 'nl', // 또는 'fr'
            'sweden': 'sv',
            'norway': 'no',
            'denmark': 'da',
            'finland': 'fi',
            'russia': 'ru',
            'ukraine': 'uk',
            'belarus': 'be',
            'serbia': 'sr',
            'croatia': 'hr',
            'slovakia': 'sk',
            'slovenia': 'sl',
            'bulgaria': 'bg',
            'albania': 'sq',
            'georgia': 'ka',
            'armenia': 'hy',
            'azerbaijan': 'az',
            // 남미
            'brazil': 'pt',
            'argentina': 'es',
            'chile': 'es',
            'colombia': 'es',
            'peru': 'es',
            'venezuela': 'es',
            'ecuador': 'es',
            'bolivia': 'es',
            'paraguay': 'es',
            'uruguay': 'es',
            'mexico': 'es',
            // 아프리카
            'egypt': 'ar',
            'morocco': 'ar',
            'algeria': 'ar',
            'tunisia': 'ar',
            'libya': 'ar',
            'sudan': 'ar',
            'ethiopia': 'am',
            'kenya': 'sw',
            'tanzania': 'sw',
            'uganda': 'sw',
            'rwanda': 'rw',
            'ghana': 'ak',
            'nigeria': 'yo', // 또는 'ig', 'ha'
            'senegal': 'wo',
            'mali': 'fr',
            'ivory-coast': 'fr',
            'cameroon': 'fr',
            // 오세아니아
            'australia': 'en',
            'new-zealand': 'en',
            'fiji': 'fj',
            'papua-new-guinea': 'en'
        };
        
        return countryLangMap[countryCode] || null;
    }
    
    /**
     * 지역명 추출 및 포맷팅 (영어(현지어) 형식)
     */
    extractName(name, countryCode = null) {
        if (!name) return null;
        
        let nameObj = null;
        
        // 문자열인 경우 JSON 형식인지 확인
        if (typeof name === 'string') {
            // JSON 형식의 문자열인지 확인 (예: '{"ko":"텍사스","en":"Texas"}')
            if (name.trim().startsWith('{') && name.trim().endsWith('}')) {
                try {
                    const parsed = JSON.parse(name);
                    if (typeof parsed === 'object' && parsed !== null) {
                        nameObj = parsed;
                    }
                } catch (e) {
                    // JSON 파싱 실패 시 일반 문자열로 처리
                    return name;
                }
            } else {
                // 일반 문자열인 경우 그대로 반환
                return name;
            }
        } else if (typeof name === 'object' && name !== null) {
            nameObj = name;
        } else {
            return String(name);
        }
        
        // 객체인 경우 영어(현지어) 형식으로 포맷팅
        if (nameObj) {
            // 모든 값 가져오기 (null/undefined/빈 문자열 제외)
            const allValues = Object.values(nameObj).filter(v => {
                if (v == null) return false;
                const str = String(v).trim();
                return str !== '' && str !== 'undefined' && str !== 'null';
            });
            
            if (allValues.length === 0) {
                log.warn('[TerritoryPanel] extractName - No valid values in nameObj:', nameObj);
                return null;
            }
            
            // 영어 이름 찾기 (우선순위: en > local > 첫 번째 값)
            let englishName = nameObj.en;
            if (!englishName || englishName === '' || englishName === 'undefined' || englishName === 'null') {
                englishName = nameObj.local;
            }
            if (!englishName || englishName === '' || englishName === 'undefined' || englishName === 'null') {
                // 첫 번째 유효한 값 사용
                englishName = allValues[0];
            }
            
            // 영어 이름이 없으면 null 반환
            if (!englishName || englishName === '' || englishName === 'undefined' || englishName === 'null') {
                log.warn('[TerritoryPanel] extractName - No valid englishName found:', nameObj);
                return null;
            }
            
            // 국가별 언어 필드 가져오기
            const localLang = countryCode ? this.getCountryLanguageField(countryCode) : null;
            let localName = null;
            
            // ⚠️ 중요: displayName 객체는 { en, local, ko } 형태이므로 local 필드를 우선 확인
            // 현지어 찾기 (우선순위: local 필드 > 국가별 언어 필드 > ko)
            // ⚠️ 중요: nameObj.local이 영어 이름과 같아도 현지어로 인식 (hasLocalMapping이 true인 경우)
            log.info(`[TerritoryPanel] extractName - Processing nameObj:`, nameObj, `countryCode: ${countryCode}`);
            log.info(`[TerritoryPanel] extractName - englishName: ${englishName}, nameObj.local: ${nameObj.local}, nameObj.ko: ${nameObj.ko}, hasLocalMapping: ${nameObj.hasLocalMapping}`);
            
            // ⚠️ CRITICAL: hasLocalMapping이 true이면 nameObj.local을 무조건 현지어로 사용
            if (nameObj.hasLocalMapping && nameObj.local && nameObj.local !== '' && nameObj.local !== 'undefined' && nameObj.local !== 'null') {
                localName = nameObj.local;
                log.info(`[TerritoryPanel] extractName - ✅ Found local name from .local field (hasLocalMapping=true): ${localName} (countryCode: ${countryCode})`);
            } else if (nameObj.local && nameObj.local !== '' && nameObj.local !== 'undefined' && nameObj.local !== 'null') {
                // hasLocalMapping이 false이거나 없어도 local 필드가 있으면 사용
                localName = nameObj.local;
                log.info(`[TerritoryPanel] extractName - ✅ Found local name from .local field: ${localName} (countryCode: ${countryCode})`);
            } else if (localLang && nameObj[localLang] && nameObj[localLang] !== '' && nameObj[localLang] !== 'undefined' && nameObj[localLang] !== 'null') {
                localName = nameObj[localLang];
                log.info(`[TerritoryPanel] extractName - ✅ Found local name from .${localLang} field: ${localName} (countryCode: ${countryCode})`);
            } else if (nameObj.ko && nameObj.ko !== '' && nameObj.ko !== 'undefined' && nameObj.ko !== 'null') {
                localName = nameObj.ko;
                log.info(`[TerritoryPanel] extractName - ✅ Found local name from .ko field: ${localName} (countryCode: ${countryCode})`);
            } else {
                log.warn(`[TerritoryPanel] extractName - ⚠️ No local name found. nameObj.local: ${nameObj.local}, localLang: ${localLang}, nameObj[localLang]: ${localLang ? nameObj[localLang] : 'N/A'}, hasLocalMapping: ${nameObj.hasLocalMapping}`);
            }
            
            // ⚠️ CRITICAL: hasLocalMapping이 true이면 영어와 같아도 "영어(현지어)" 형식으로 표시
            if (nameObj.hasLocalMapping && localName && englishName) {
                const result = `${String(englishName)}(${String(localName)})`;
                log.info(`[TerritoryPanel] extractName - ✅ Returning formatted name (hasLocalMapping=true): ${result} (englishName: ${englishName}, localName: ${localName})`);
                return result;
            }
            
            // 영어와 현지어가 다르고 둘 다 있으면 "영어(현지어)" 형식으로 반환
            if (englishName && localName && englishName !== localName) {
                const result = `${String(englishName)}(${String(localName)})`;
                log.info(`[TerritoryPanel] extractName - ✅ Returning formatted name: ${result} (englishName: ${englishName}, localName: ${localName})`);
                return result;
            }
            
            // 영어만 있으면 영어만 반환
            log.info(`[TerritoryPanel] extractName - ⚠️ Returning english name only: ${englishName} (no local name found)`);
            return String(englishName);
        }
        
        return null;
    }
    
    getTerritoryIcon(sovereignty) {
        const icons = {
            [SOVEREIGNTY.UNCONQUERED]: '🏴',
            [SOVEREIGNTY.CONTESTED]: '🏷️',
            [SOVEREIGNTY.RULED]: '🏰'
        };
        return icons[sovereignty] || '🏴';
    }
    
    getSovereigntyIcon(sovereignty) {
        const icons = {
            [SOVEREIGNTY.UNCONQUERED]: '✅',
            [SOVEREIGNTY.CONTESTED]: '⏳',
            [SOVEREIGNTY.RULED]: '👑'
        };
        return icons[sovereignty] || '❓';
    }
    
    formatNumber(num) {
        if (!num) return '0';
        return num.toLocaleString();
    }
    
    formatDate(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        return d.toLocaleDateString(this.lang === 'ko' ? 'ko-KR' : 'en-US');
    }
    
    getPixelPercentage(territory) {
        if (!territory.pixelCanvas) return 0;
        const total = territory.pixelCanvas.width * territory.pixelCanvas.height;
        return Math.round((territory.pixelCanvas.filledPixels / total) * 100);
    }
    
    getTimeRemaining(endTime) {
        if (!endTime) return '-';
        
        let end;
        // Firestore Timestamp 객체 처리
        if (endTime && typeof endTime === 'object') {
            if (endTime.toDate && typeof endTime.toDate === 'function') {
                // Firestore Timestamp
                end = endTime.toDate();
            } else if (endTime.seconds) {
                // Timestamp 객체 (seconds 필드가 있는 경우)
                end = new Date(endTime.seconds * 1000);
            } else if (endTime instanceof Date) {
                end = endTime;
            } else {
                // 일반 객체나 다른 형태
                end = new Date(endTime);
            }
        } else {
            // 문자열이나 숫자
            end = new Date(endTime);
        }
        
        // 유효한 날짜인지 확인
        if (isNaN(end.getTime())) {
            return '시간 계산 오류';
        }
        
        const now = new Date();
        const diff = end.getTime() - now.getTime();
        
        if (diff <= 0) return '종료됨';
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        return `${hours}시간 ${minutes}분`;
    }
    
    /**
     * 보호 기간 연장 경매 가져오기
     */
    getProtectionExtensionAuctions(territoryId) {
        const allAuctions = auctionSystem.getAllActiveAuctions();
        return allAuctions.filter(auction => 
            auction.territoryId === territoryId && 
            auction.type === 'protection_extension' &&
            auction.status === 'active'
        );
    }
    
    /**
     * 보호 기간 연장 경매 시작 처리
     */
    async handleStartProtectionExtensionAuction() {
        const user = firebaseService.getCurrentUser();
        
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to start protection extension auction'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No territory selected'
            });
            return;
        }
        
        // 소유자 확인
        if (this.currentTerritory.ruler !== user.uid) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Only territory owner can start protection extension auction'
            });
            return;
        }
        
        // 보호 기간 옵션 모달 표시
        this.showProtectionExtensionAuctionModal();
    }
    
    /**
     * 보호 기간 연장 경매 옵션 모달 표시
     */
    showProtectionExtensionAuctionModal() {
        const countryCode = this.currentTerritory.country || 
                           this.currentTerritory.properties?.adm0_a3?.toLowerCase() || 
                           this.currentTerritory.properties?.country || 
                           'unknown';
        const territoryName = this.extractName(this.currentTerritory.name, countryCode) || 
                             this.extractName(this.currentTerritory.properties?.name, countryCode) ||
                             this.currentTerritory.id;
        const basePrice = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
        
        // 보호 기간 옵션 정의 (아이디어 1: 가격 차등화)
        const protectionOptions = [
            {
                id: 'week',
                label: '1 Week',
                days: 7,
                multiplier: 1.0,
                icon: '📅',
                description: '7 days extension',
                pricePerDay: (basePrice * 1.0 / 7).toFixed(1)
            },
            {
                id: 'month',
                label: '1 Month',
                days: 30,
                multiplier: 4.0,
                icon: '📆',
                description: '30 days extension',
                pricePerDay: (basePrice * 4.0 / 30).toFixed(1)
            },
            {
                id: 'year',
                label: '1 Year',
                days: 365,
                multiplier: 50.0,
                icon: '🗓️',
                description: '365 days extension',
                pricePerDay: (basePrice * 50.0 / 365).toFixed(1)
            },
            {
                id: 'lifetime',
                label: 'Lifetime',
                days: null,
                multiplier: 500.0,
                icon: '👑',
                description: 'Permanent protection',
                pricePerDay: null
            }
        ];
        
        // 기존 보호 기간 연장 경매 확인
        const existingAuctions = this.getProtectionExtensionAuctions(this.currentTerritory.id);
        const existingPeriods = existingAuctions.map(a => a.protectionDays);
        
        const optionsHTML = protectionOptions.map(option => {
            const price = Math.ceil(basePrice * option.multiplier);
            const alreadyExists = existingPeriods.includes(option.days);
            const isDisabled = alreadyExists;
            
            return `
                <div class="purchase-option-card ${isDisabled ? 'disabled' : ''}" 
                     data-option-id="${option.id}" 
                     data-days="${option.days || 'lifetime'}" 
                     data-price="${price}"
                     ${isDisabled ? 'style="opacity: 0.5; cursor: not-allowed;"' : ''}>
                    <div class="option-header">
                        <span class="option-icon">${option.icon}</span>
                        <div class="option-title">
                            <h3>${option.label}</h3>
                            ${option.pricePerDay ? `<span class="option-label-en">${option.pricePerDay} pt/day</span>` : ''}
                        </div>
                        ${alreadyExists ? `<span class="option-badge">Active</span>` : ''}
                    </div>
                    <div class="option-body">
                        <div class="option-price">
                            <span class="price-value">${this.formatNumber(price)}</span>
                            <span class="price-unit">pt</span>
                        </div>
                        <div class="option-description">${option.description}</div>
                        ${alreadyExists ? `
                            <div class="option-warning">
                                <span class="warning-icon">⚠️</span>
                                <span>Auction already active for this period</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        const modalHTML = `
            <div class="modal-overlay" id="protection-extension-auction-modal">
                <div class="modal-content purchase-options-modal">
                    <div class="modal-header">
                        <h2>🛡️ Extend Protection (Auction)</h2>
                        <button class="close-btn" id="close-protection-auction-modal">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="purchase-options-info">
                            <p>Choose a protection period to start an auction. Highest bidder wins the extension.</p>
                            <p><strong>Territory:</strong> ${territoryName}</p>
                            <p><strong>Base Price:</strong> ${this.formatNumber(basePrice)} pt</p>
                        </div>
                        <div class="purchase-options-grid">
                            ${optionsHTML}
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달 제거
        const existingModal = document.getElementById('protection-extension-auction-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // 이벤트 바인딩
        this.bindProtectionExtensionAuctionModalEvents();
    }
    
    /**
     * 지역 소유권 획득 경매 옵션 모달 표시
     * 소유자가 있는 지역에서 경매를 시작할 때 기간 옵션 선택
     */
    showTerritoryAuctionOptionsModal() {
        log.info('[TerritoryPanel] showTerritoryAuctionOptionsModal() called');
        
        const user = firebaseService.getCurrentUser();
        
        if (!user) {
            log.warn('[TerritoryPanel] User not logged in, showing login modal');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to start an auction'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            log.error('[TerritoryPanel] No territory selected');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No territory selected'
            });
            return;
        }
        
        log.info('[TerritoryPanel] Showing territory auction options modal for:', this.currentTerritory.id);
        
        const countryCode = this.currentTerritory.country || this.currentTerritory.properties?.adm0_a3?.toLowerCase() || 'unknown';
        const territoryName = this.extractName(this.currentTerritory.name, countryCode) || this.currentTerritory.id;
        const basePrice = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
        
        // 기간 옵션 정의
        const options = [
            {
                id: 'week',
                days: 7,
                label: '1 Week',
                description: 'Own for 7 days with protection',
                priceMultiplier: 1.0
            },
            {
                id: 'month',
                days: 30,
                label: '1 Month',
                description: 'Own for 1 month with protection',
                priceMultiplier: 4.0
            },
            {
                id: 'year',
                days: 365,
                label: '1 Year',
                description: 'Own for 1 year with protection',
                priceMultiplier: 50.0
            },
            {
                id: 'lifetime',
                days: null,
                label: 'Lifetime',
                description: 'Own forever with permanent protection',
                priceMultiplier: 500.0
            }
        ];
        
        // 옵션 HTML 생성
        const optionsHTML = options.map((option, index) => {
            const price = Math.max(Math.ceil(basePrice * option.priceMultiplier), 10);
            const isBestValue = option.id === 'month'; // 1개월이 가장 합리적인 선택으로 표시
            const periodText = option.days === null 
                ? 'Permanent' 
                : option.days === 7 
                    ? '7 Days' 
                    : option.days === 30 
                        ? '30 Days' 
                        : '365 Days';
            
            return `
                <div class="purchase-option-card ${isBestValue ? 'best-value' : ''}" data-option-id="${option.id}" data-days="${option.days || 'lifetime'}" data-price="${price}">
                    ${isBestValue ? '<div class="best-value-badge">✨ Best Value</div>' : ''}
                    <div class="option-header">
                        <span class="option-label">${option.label}</span>
                        <span class="option-period">${periodText} Protection</span>
                    </div>
                    <div class="option-body">
                        <div class="option-price-section">
                            <div class="price-label">Starting Bid</div>
                            <div class="option-price">
                                <span class="price-value">${this.formatNumber(price)}</span>
                                <span class="price-unit">pt</span>
                            </div>
                        </div>
                        <div class="option-details">
                            <div class="option-description">${option.description}</div>
                            <div class="option-hint">
                                ${option.id === 'week' ? '💡 Quick ownership for 7 days' : ''}
                                ${option.id === 'month' ? '💡 Balanced choice for monthly protection' : ''}
                                ${option.id === 'year' ? '💡 Secure ownership for a full year' : ''}
                                ${option.id === 'lifetime' ? '💡 Own forever with permanent protection' : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        const modalHTML = `
            <div class="purchase-options-modal" id="territory-auction-options-modal">
                <div class="modal-overlay"></div>
                <div class="purchase-options-content">
                    <div class="modal-header">
                        <h2>🏷️ Start Territory Auction</h2>
                        <button class="modal-close" id="close-territory-auction-modal">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="purchase-options-info">
                            <div class="info-header">
                                <h3>🏷️ Select Auction Duration</h3>
                                <p class="info-description">Choose a protection period. The highest bidder will own <strong>${territoryName}</strong> with the selected protection period.</p>
                            </div>
                            <div class="territory-summary">
                                <div class="summary-item">
                                    <span class="summary-label">Territory:</span>
                                    <span class="summary-value">${territoryName}</span>
                                </div>
                                <div class="summary-item">
                                    <span class="summary-label">Base Price:</span>
                                    <span class="summary-value">${this.formatNumber(basePrice)} pt</span>
                                </div>
                            </div>
                        </div>
                        <div class="purchase-options-grid">
                            ${optionsHTML}
                        </div>
                        <div class="auction-info-footer">
                            <div class="info-icon">ℹ️</div>
                            <div class="info-text">
                                <strong>How it works:</strong> Each option shows the starting bid price. Other users can bid higher, and the highest bidder wins the territory with the selected protection period.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달 제거
        const existingModal = document.getElementById('territory-auction-options-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        log.info('[TerritoryPanel] Modal HTML inserted into DOM for territory:', this.currentTerritory.id);
        
        // 이벤트 바인딩
        this.bindTerritoryAuctionOptionsModalEvents();
        log.info('[TerritoryPanel] Modal events bound');
    }
    
    /**
     * 지역 소유권 획득 경매 옵션 모달 이벤트 바인딩
     */
    bindTerritoryAuctionOptionsModalEvents() {
        const modal = document.getElementById('territory-auction-options-modal');
        if (!modal) return;
        
        // 닫기 버튼
        const closeBtn = document.getElementById('close-territory-auction-modal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.remove();
            });
        }
        
        // 오버레이 클릭 시 닫기
        const overlay = modal.querySelector('.modal-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                e.stopPropagation();
                modal.remove();
            });
        }
        
        // 옵션 카드 클릭 (이벤트 위임 사용)
        modal.addEventListener('click', async (e) => {
            const card = e.target.closest('.purchase-option-card');
            if (!card) return;
            
            e.preventDefault();
            e.stopPropagation();
            
            const optionId = card.dataset.optionId;
            const days = card.dataset.days === 'lifetime' ? null : parseInt(card.dataset.days, 10);
            const price = parseInt(card.dataset.price, 10);
            
            const optionLabels = {
                'week': '1 Week',
                'month': '1 Month',
                'year': '1 Year',
                'lifetime': 'Lifetime'
            };
            
            const confirmMessage = `Start auction for ${optionLabels[optionId]} ownership?\n\nStarting bid: ${this.formatNumber(price)} pt\n\nHighest bidder will own this territory with ${optionLabels[optionId]} protection.`;
            
            if (!confirm(confirmMessage)) {
                return;
            }
            
            try {
                // 경매 생성 (기간 옵션 포함)
                await auctionSystem.createAuction(this.currentTerritory.id, {
                    protectionDays: days,
                    startingBid: price
                });
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'success',
                    message: `Territory auction started for ${optionLabels[optionId]}!`
                });
                
                // 모달 닫기
                modal.remove();
                
                // 패널 갱신
                this.render();
                this.bindActions();
                
            } catch (error) {
                log.error('Failed to start territory auction:', error);
                
                let errorMessage = 'Failed to start auction';
                if (error.message.includes('already exists')) {
                    errorMessage = 'An auction is already in progress for this territory';
                } else if (error.message.includes('Authentication')) {
                    errorMessage = 'Please sign in first';
                }
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: errorMessage
                });
            }
        });
    }
    
    /**
     * 보호 기간 연장 경매 모달 이벤트 바인딩
     */
    bindProtectionExtensionAuctionModalEvents() {
        // 닫기 버튼
        const closeBtn = document.getElementById('close-protection-auction-modal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                const modal = document.getElementById('protection-extension-auction-modal');
                if (modal) modal.remove();
            });
        }
        
        // 오버레이 클릭 시 닫기
        const overlay = document.getElementById('protection-extension-auction-modal');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                }
            });
        }
        
        // 옵션 카드 클릭
        document.querySelectorAll('#protection-extension-auction-modal .purchase-option-card').forEach(card => {
            if (card.classList.contains('disabled')) return;
            
            card.addEventListener('click', async (e) => {
                e.preventDefault();
                const optionId = card.dataset.optionId;
                const days = card.dataset.days === 'lifetime' ? null : parseInt(card.dataset.days, 10);
                const price = parseInt(card.dataset.price, 10);
                
                const optionLabels = {
                    'week': '1 Week',
                    'month': '1 Month',
                    'year': '1 Year',
                    'lifetime': 'Lifetime'
                };
                
                const confirmMessage = `Start auction for ${optionLabels[optionId]} protection extension?\n\nStarting bid: ${this.formatNumber(price)} pt`;
                
                if (!confirm(confirmMessage)) {
                    return;
                }
                
                try {
                    await auctionSystem.createProtectionExtensionAuction(
                        this.currentTerritory.id,
                        days
                    );
                    
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'success',
                        message: `Protection extension auction started for ${optionLabels[optionId]}!`
                    });
                    
                    // 모달 닫기
                    const modal = document.getElementById('protection-extension-auction-modal');
                    if (modal) modal.remove();
                    
                    // 패널 갱신
                    this.render();
                    this.bindActions();
                    
                } catch (error) {
                    log.error('Failed to start protection extension auction:', error);
                    
                    let errorMessage = 'Failed to start auction';
                    if (error.message.includes('already exists')) {
                        errorMessage = `Auction for ${optionLabels[optionId]} already exists`;
                    } else if (error.message.includes('Authentication')) {
                        errorMessage = 'Please sign in first';
                    } else if (error.message.includes('Only territory owner')) {
                        errorMessage = 'Only territory owner can start protection extension auction';
                    }
                    
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'error',
                        message: errorMessage
                    });
                }
            });
        });
    }
    
    getEventText(event) {
        const { type, data } = event;
        
        switch (type) {
            case 'conquered':
                return `${data.newRuler}이(가) 영토를 정복했습니다`;
            case 'pixel_milestone':
                return `${data.milestone} 픽셀 달성! 🎉`;
            case 'auction_started':
                return 'Auction started';
            default:
                return event.narrative || '알 수 없는 이벤트';
        }
    }
}

// 싱글톤 인스턴스
export const territoryPanel = new TerritoryPanel();
export default territoryPanel;


