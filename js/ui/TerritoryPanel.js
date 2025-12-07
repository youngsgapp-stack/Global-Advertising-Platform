/**
 * TerritoryPanel - 영토 정보 패널 UI
 * 영토 상세 정보, 역사, 버프, 액션 버튼 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { SOVEREIGNTY, territoryManager } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';
import { buffSystem } from '../features/BuffSystem.js';
import { auctionSystem, AUCTION_STATUS } from '../features/AuctionSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryDataService } from '../services/TerritoryDataService.js';
import { walletService } from '../services/WalletService.js';

class TerritoryPanel {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.lang = 'en';  // English default
        this.countryData = null;
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
        
        // 영토 선택 이벤트 - TerritoryManager에서 처리된 territory를 받아서 패널 열기
        eventBus.on(EVENTS.TERRITORY_SELECT, async (data) => {
            const territoryId = data.territoryId || data.territory?.id;
            log.info(`[TerritoryPanel] TERRITORY_SELECT event received: territoryId=${territoryId}, territory.id=${data.territory?.id}, country=${data.country}, properties.adm0_a3=${data.properties?.adm0_a3}`);
            
            if (!territoryId) {
                log.warn(`[TerritoryPanel] TERRITORY_SELECT event missing territoryId`);
                return;
            }
            
            // ⚠️ 중요: 이벤트 데이터의 properties와 country를 우선 사용 (맵에서 직접 가져온 정확한 데이터)
            // TerritoryManager의 territory는 이전에 잘못된 country로 저장되었을 수 있음
            let territory = null;
            
            // 1. 이벤트 데이터에 territory 객체가 있고 완전한 정보가 있으면 사용
            if (data.territory && data.territory.id && data.territory.properties) {
                territory = data.territory;
                log.debug(`[TerritoryPanel] Using territory from event data: ${territory.id}`);
            } else {
                // 2. TerritoryManager에서 가져오되, 이벤트 데이터의 country와 properties로 덮어쓰기
                territory = territoryManager.getTerritory(territoryId);
                if (territory) {
                    // 이벤트 데이터의 정확한 country와 properties로 업데이트
                    if (data.country) {
                        territory.country = data.country;
                        log.debug(`[TerritoryPanel] Updated territory.country from event: ${data.country}`);
                    }
                    if (data.properties) {
                        territory.properties = { ...territory.properties, ...data.properties };
                        log.debug(`[TerritoryPanel] Updated territory.properties from event`);
                    }
                    if (data.sourceId) territory.sourceId = data.sourceId;
                    if (data.featureId) territory.featureId = data.featureId;
                    if (data.geometry) territory.geometry = data.geometry;
                } else {
                    // 3. TerritoryManager에 없으면 이벤트 데이터로 territory 객체 생성
                    log.warn(`[TerritoryPanel] Territory ${territoryId} not found in TerritoryManager, creating from event data`);
                    territory = {
                        id: territoryId,
                        name: data.properties?.name || data.properties?.name_en || territoryId,
                        country: data.country,
                        properties: data.properties,
                        geometry: data.geometry,
                        sourceId: data.sourceId,
                        featureId: data.featureId
                    };
                }
            }
            
            if (!territory) {
                log.error(`[TerritoryPanel] Cannot open panel: no territory data for ${territoryId}`);
                return;
            }
            
            log.info(`[TerritoryPanel] Opening panel for territory: ${territory.id}, name: ${territory.name || territory.properties?.name}, country: ${territory.country}`);
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
                    
                    // 옥션 데이터 새로고침
                    await auctionSystem.loadActiveAuctions();
                    
                    // 업데이트된 옥션 데이터 가져오기
                    const updatedAuction = auctionSystem.activeAuctions.get(auctionId);
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
    render() {
        const t = this.currentTerritory;
        if (!t) return;
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        // 소유자 체크: 일반 사용자 소유 또는 관리자 모드에서 관리자가 구매한 영토
        const isOwner = user && (
            t.ruler === user.uid || 
            (isAdmin && t.purchasedByAdmin)
        );
        // 로그인한 사용자만 경매 정보 표시
        const auction = user ? auctionSystem.getAuctionByTerritory(t.id) : null;
        
        // 보호 기간 확인
        const protectionRemaining = territoryManager.getProtectionRemaining(t.id);
        const isProtected = !!protectionRemaining;
        
        // 이름 추출 (객체일 수 있으므로 처리) - 먼저 정의 필요
        const territoryName = this.extractName(t.name) || 
                              this.extractName(t.properties?.name) || 
                              this.extractName(t.properties?.name_en) || 
                              'Unknown Territory';
        
        // 국가 코드 결정 (우선순위: territory.country > properties > fallback)
        // properties에서 사용 가능한 필드: adm0_a3 (USA), country (United States of America), countryCode (US1), sov_a3 (US1)
        let countryCode = t.country || 
                        t.properties?.country || 
                        t.properties?.country_code ||
                        t.properties?.adm0_a3?.toLowerCase() ||  // adm0_a3 우선 사용 (USA -> usa)
                        t.properties?.sov_a3?.toLowerCase() ||
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
            let altCode = t.properties?.adm0_a3 ||  // ISO 코드 (예: "USA")
                         t.properties?.country_code || 
                         t.properties?.sov_a3 ||
                         t.properties?.iso_a3;
            
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
                    let countryName = t.properties?.admin || t.properties?.geonunit;
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
            
            // 여전히 없으면 territoryId에서 국가 코드 추출 시도
            if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
                // territoryId 형식: "singapore-0", "usa-1" 등
                const territoryIdParts = t.id?.split('-');
                if (territoryIdParts && territoryIdParts.length > 0) {
                    const possibleCountryCode = territoryIdParts[0];
                    if (CONFIG.COUNTRIES[possibleCountryCode]) {
                        countryCode = possibleCountryCode;
                        log.debug(`[TerritoryPanel] Using country code from territoryId: ${countryCode} for ${territoryName}`);
                    }
                }
            }
            
            // 여전히 없으면 'unknown'으로 설정 (mapController.currentCountry는 사용하지 않음)
            // ⚠️ mapController.currentCountry를 사용하면 모든 territory의 country가 덮어써질 수 있음
            if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
                countryCode = 'unknown';
                log.warn(`[TerritoryPanel] Invalid country code: ${t.country}, territory: ${territoryName}, properties: ${JSON.stringify(t.properties)}`);
            }
        }
        
        // Get real country data
        this.countryData = territoryDataService.getCountryStats(countryCode);
        const countryInfo = CONFIG.COUNTRIES[countryCode] || {};
        
        // 인구/면적 데이터 추출 (TerritoryDataService 사용)
        // countryCode 디버깅: 최종 결정된 countryCode 로그
        if (!countryInfo.name) {
            log.warn(`[TerritoryPanel] Country info not found for code: ${countryCode}, territory: ${territoryName}`);
        }
        
        const population = territoryDataService.extractPopulation(t, countryCode);
        const area = territoryDataService.extractArea(t, countryCode);
        
        // 디버깅: 인구/면적 데이터 확인
        if (territoryName.toLowerCase() === 'texas') {
            log.debug(`[TerritoryPanel] Texas - countryCode: ${countryCode}, isoCode: ${territoryDataService.convertToISOCode(countryCode)}, population: ${population}, area: ${area}`);
        }
        
        // 픽셀 수 계산 (면적 기반)
        const pixelCount = territoryDataService.calculatePixelCount(t, countryCode);
        
        // 가격 계산 (픽셀 수 기반)
        const realPrice = territoryDataService.calculateTerritoryPrice(t, countryCode);
        
        // 국가명: CONFIG에서 가져오거나, 없으면 countryCode를 그대로 사용 (절대 properties.admin 사용 안 함)
        const countryName = countryInfo.name || countryInfo.nameKo || countryCode || 'Unknown';
        const countryFlag = countryInfo.flag || '🏳️';
        
        // 소유권 상태 텍스트
        // 경매 중이면 "Bidding" 표시, 아니면 일반 상태 표시
        let sovereigntyText = vocab[t.sovereignty] || 'Available';
        if (t.sovereignty === 'protected' || isProtected) {
            sovereigntyText = '🛡️ Protected';
        } else if (auction && auction.status === AUCTION_STATUS.ACTIVE) {
            // 활성 경매가 있으면 "Bidding" 표시
            sovereigntyText = '⏳ Bidding';
        } else if (t.sovereignty === SOVEREIGNTY.CONTESTED && !auction) {
            // CONTESTED 상태인데 경매가 없으면 UNCONQUERED로 복구
            sovereigntyText = '✅ Available';
            // 비동기로 상태 복구
            setTimeout(async () => {
                try {
                    const Timestamp = firebaseService.getTimestamp();
                    await firebaseService.updateDocument('territories', t.id, {
                        sovereignty: SOVEREIGNTY.UNCONQUERED,
                        currentAuction: null,
                        updatedAt: Timestamp ? Timestamp.now() : new Date()
                    });
                    t.sovereignty = SOVEREIGNTY.UNCONQUERED;
                    t.currentAuction = null;
                    // 패널 다시 렌더링
                    this.render();
                    this.bindActions();
                } catch (error) {
                    log.error('Failed to fix territory state:', error);
                }
            }, 0);
        }
        
        this.container.innerHTML = `
            <div class="panel-header">
                <div class="territory-title">
                    <span class="territory-icon">${this.getTerritoryIcon(t.sovereignty)}</span>
                    <h2>${territoryName}</h2>
                </div>
                <button class="close-btn" id="close-territory-panel">&times;</button>
            </div>
            
            <div class="panel-content">
                <!-- Sovereignty Status -->
                <div class="sovereignty-section">
                    <div class="sovereignty-badge ${isProtected ? 'protected' : (t.sovereignty || 'unconquered')}">
                        <span class="sovereignty-icon">${isProtected ? '🛡️' : this.getSovereigntyIcon(t.sovereignty)}</span>
                        <span class="sovereignty-text">${sovereigntyText}</span>
                    </div>
                    ${t.ruler ? `
                        <div class="ruler-info">
                            <span class="ruler-label">👑 Owner:</span>
                            <span class="ruler-name">${t.rulerName || 'Unknown'}</span>
                            ${t.purchasedByAdmin ? '<span class="admin-badge">🔧 Admin</span>' : ''}
                        </div>
                        ${isProtected ? `
                            <div class="protection-info">
                                <span class="protection-icon">🛡️</span>
                                <span>Protected for ${protectionRemaining.days}d ${protectionRemaining.hours}h</span>
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
                ${auction ? this.renderAuction(auction) : ''}
                
                <!-- Action Buttons -->
                <div class="territory-actions">
                    ${this.renderActions(t, isOwner, auction, realPrice, auction ? this.getEffectiveAuctionBid(auction) : null)}
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
                    <h3>⚔️ Auction Ended</h3>
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
                    // Firestore에서 최신 데이터 로드
                    try {
                        const latestData = await firebaseService.getDocument('territories', territory.id);
                        if (latestData) {
                            // 영토 데이터 업데이트
                            Object.assign(territory, latestData);
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
                    <h3>⚔️ Auction Ending...</h3>
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
        
        // 입찰자가 있는지 확인
        const hasBids = !!auction.highestBidder;
        
        // startingBid 검증 (잘못된 값이면 수정) - 항상 검증 (50pt 이상이 아니어도)
        let startingBid = auction.startingBid || 10;
        
        // 영토 실제 가격 기반으로 항상 검증 (territory가 있으면)
        if (territory) {
            const countryCode = territory.country || 'unknown';
            const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
            const correctStartingBid = realPrice 
                ? Math.max(Math.floor(realPrice * auctionRatio), 10)
                : 10;
            
            // startingBid가 올바른 값과 다르면 무조건 수정
            if (startingBid !== correctStartingBid) {
                log.warn(`[TerritoryPanel] ⚠️ Invalid startingBid ${startingBid} detected in renderAuction, correcting to ${correctStartingBid} (realPrice: ${realPrice}, country: ${countryCode})`);
                startingBid = correctStartingBid;
                auction.startingBid = correctStartingBid;
                
                // activeAuctions Map도 업데이트 (메모리 캐시 동기화)
                if (auctionSystem.activeAuctions.has(auction.id)) {
                    const cachedAuction = auctionSystem.activeAuctions.get(auction.id);
                    cachedAuction.startingBid = correctStartingBid;
                    if (!hasBids) {
                        cachedAuction.currentBid = correctStartingBid;
                    }
                    log.debug(`[TerritoryPanel] Updated cached auction ${auction.id} in activeAuctions Map`);
                }
                
                // 비동기로 Firestore 업데이트 (렌더링 블로킹 방지)
                if (firebaseService.isAuthenticated()) {
                    firebaseService.updateDocument('auctions', auction.id, {
                        startingBid: correctStartingBid,
                        currentBid: hasBids ? auction.currentBid : correctStartingBid,
                        updatedAt: firebaseService.getTimestamp()
                    }).then(() => {
                        log.info(`[TerritoryPanel] ✅ Successfully updated auction ${auction.id} in Firestore: startingBid=${correctStartingBid}`);
                    }).catch(err => {
                        log.warn(`[TerritoryPanel] Failed to update startingBid in Firestore:`, err);
                    });
                } else {
                    log.debug(`[TerritoryPanel] Skipping Firestore update (user not authenticated)`);
                }
            }
        }
        
        // 입찰자가 없으면 startingBid를 직접 사용 (화면 표시와 일치)
        // 입찰자가 있으면 currentBid 또는 bids 배열의 최고 입찰가 사용
        let effectiveCurrentBid;
        if (!hasBids) {
            // 입찰자가 없으면 startingBid를 그대로 사용 (currentBid는 무시)
            effectiveCurrentBid = startingBid;
        } else {
            // 입찰자가 있으면 bids 배열의 최고 입찰가를 우선 확인
            let highestBidFromArray = 0;
            if (auction.bids && Array.isArray(auction.bids) && auction.bids.length > 0) {
                highestBidFromArray = Math.max(...auction.bids.map(b => b.amount || b.buffedAmount || 0));
            }
            
            // currentBid와 bids 배열의 최고 입찰가 중 더 큰 값 사용
            const candidateBid = Math.max(
                auction.currentBid || 0,
                highestBidFromArray
            );
            
            // 최소 startingBid 이상이어야 함
            effectiveCurrentBid = candidateBid >= startingBid
                ? candidateBid
                : startingBid;
            
            // 디버깅 로그
            if (candidateBid !== auction.currentBid) {
                log.warn(`[TerritoryPanel] ⚠️ currentBid (${auction.currentBid}) doesn't match highest bid from array (${highestBidFromArray}), using ${effectiveCurrentBid}`);
            }
        }
        
        // minIncrement 계산
        // 입찰자가 있든 없든 항상 1pt 증가액 사용 (1pt 단위 입찰)
        const effectiveMinIncrement = 1;
        
        return `
            <div class="auction-section">
                <h3>⚔️ Active Auction</h3>
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
     * 경매의 유효한 입찰가 계산 (입찰자가 없으면 startingBid 사용)
     * 주의: 이 함수는 화면 표시용이므로 auction.startingBid를 직접 사용
     * 하지만 startingBid가 잘못된 값이면 검증하여 수정
     */
    getEffectiveAuctionBid(auction) {
        if (!auction) return null;
        
        // startingBid 검증 (잘못된 값이면 수정) - 60pt 같은 잘못된 값 강제 수정
        let startingBid = auction.startingBid || 10;
        
        // startingBid가 50pt 이상이면 의심스러움 - 영토 실제 가격 기반으로 검증
        if (startingBid >= 50 && this.currentTerritory) {
            const countryCode = this.currentTerritory.country || 'unknown';
            const realPrice = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
            const correctStartingBid = realPrice 
                ? Math.max(Math.floor(realPrice * auctionRatio), 10)
                : 10;
            
            if (startingBid !== correctStartingBid) {
                log.warn(`[TerritoryPanel] Invalid startingBid ${startingBid} in getEffectiveAuctionBid, correcting to ${correctStartingBid} (realPrice: ${realPrice})`);
                startingBid = correctStartingBid;
                auction.startingBid = correctStartingBid;
                // 비동기로 Firestore 업데이트 (렌더링 블로킹 방지)
                if (firebaseService.isAuthenticated()) {
                    firebaseService.updateDocument('auctions', auction.id, {
                        startingBid: correctStartingBid
                    }).catch(err => {
                        log.warn(`[TerritoryPanel] Failed to update startingBid:`, err);
                    });
                }
            }
        }
        
        // 입찰자가 없으면 startingBid를 그대로 반환
        if (!auction.highestBidder) {
            return startingBid;
        }
        
        // 입찰자가 있으면 currentBid 사용 (최소 startingBid 이상이어야 함)
        return Math.max(auction.currentBid || startingBid || 10, startingBid || 10);
    }
    
    /**
     * Action Buttons Rendering
     */
    renderActions(territory, isOwner, auction, realPrice = 100, effectiveAuctionBid = null) {
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        const isProtected = territoryManager.isProtected(territory.id);
        
        if (!user) {
            return `
                <button class="action-btn login-btn" id="login-to-conquer">
                    🔐 Sign in to Claim
                </button>
            `;
        }
        
        // 소유자인 경우 - 꾸미기 버튼
        if ((territory.sovereignty === SOVEREIGNTY.RULED || territory.sovereignty === SOVEREIGNTY.PROTECTED) && isOwner) {
            return `
                <button class="action-btn pixel-btn" id="open-pixel-editor">
                    🎨 Decorate Territory
                </button>
                <button class="action-btn collab-btn" id="open-collaboration">
                    👥 Open Collaboration
                </button>
            `;
        }
        
        // 경매 중인 경우에도 즉시 구매 가능하도록 "Claim Now" 버튼 표시
        if (auction && auction.status === AUCTION_STATUS.ACTIVE) {
            const user = firebaseService.getCurrentUser();
            const isUserHighestBidder = auction.highestBidder === user?.uid;
            const hasBids = !!auction.highestBidder;
            
            // 가격 비교 정보 (유효한 입찰가 사용 - 입찰자가 없으면 startingBid 사용)
            const auctionCurrentBid = effectiveAuctionBid !== null 
                ? effectiveAuctionBid 
                : this.getEffectiveAuctionBid(auction);
            
            // 최소 입찰가 계산 (현재 입찰가 + 1pt)
            const minBid = auctionCurrentBid + 1;
            
            // Buy Now 가격 결정
            // 입찰가가 원래 구매가보다 낮으면 원래 구매가 사용
            // 입찰가가 원래 구매가를 넘어섰으면 최소 입찰가보다 높게 설정 (일반 경매 시장 규칙: 현재 입찰가의 110-115%)
            let buyNowPrice = realPrice;
            if (auctionCurrentBid >= realPrice) {
                // 입찰가가 원래 구매가를 넘어섰을 때: 최소 입찰가의 115% 또는 최소 입찰가 + 10pt 중 큰 값
                const adjustedPrice = Math.max(
                    Math.ceil(minBid * 1.15), // 최소 입찰가의 115%
                    minBid + 10 // 또는 최소 입찰가 + 10pt
                );
                buyNowPrice = adjustedPrice;
            }
            
            const priceDifference = buyNowPrice - auctionCurrentBid;
            const isCheaper = priceDifference < 0;
            
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
                        <span class="price-value">${this.formatNumber(buyNowPrice)} pt</span>
                    </div>
                    ${auctionCurrentBid >= realPrice ? `
                        <div class="price-comparison note">
                            <span class="note-icon">📈</span>
                            <span>Buy Now price adjusted (current bid exceeded original price)</span>
                        </div>
                    ` : isCheaper ? `
                        <div class="price-comparison save">
                            <span class="save-icon">💰</span>
                            <span>Save ${this.formatNumber(Math.abs(priceDifference))} pt vs current bid</span>
                        </div>
                    ` : priceDifference > 0 ? `
                        <div class="price-comparison note">
                            <span class="note-icon">ℹ️</span>
                            <span>${this.formatNumber(priceDifference)} pt more than current bid</span>
                        </div>
                    ` : ''}
                    ${hasBids ? `
                        <div class="auction-warning">
                            <span class="warning-icon">⚠️</span>
                            <span>This will cancel the active auction</span>
                        </div>
                    ` : ''}
                    ${isUserHighestBidder ? `
                        <div class="bidder-notice">
                            <span class="notice-icon">💬</span>
                            <span>You are the highest bidder. Your bid will be refunded if you buy now.</span>
                        </div>
                    ` : ''}
                    <button class="action-btn conquest-btn" id="instant-conquest" data-buy-now-price="${buyNowPrice}">
                        ⚔️ Buy Now (${this.formatNumber(buyNowPrice)} pt)
                    </button>
                </div>
                
                <div class="action-divider">
                    <span>OR</span>
                </div>
                
                <div class="action-option-card">
                    <div class="option-header">
                        <span class="option-icon">⏳</span>
                        <span class="option-title">Continue Bidding</span>
                        <span class="option-badge auction">Auction</span>
                    </div>
                    <div class="option-price">
                        <span class="price-label">${hasBids ? 'Current Bid:' : 'Starting Bid:'}</span>
                        <span class="price-value">${this.formatNumber(auctionCurrentBid)} pt</span>
                    </div>
                    ${!hasBids ? `
                        <div class="no-bids-notice">
                            <span class="notice-icon">💡</span>
                            <span>No bids yet. Be the first to bid!</span>
                        </div>
                    ` : ''}
                    <div class="auction-action-hint">
                        <span class="hint-icon">💡</span>
                        <span>Place your bid in the auction section above</span>
                    </div>
                </div>
            `;
        }
        
        // 보호 기간 중인 경우 - 경매 입찰은 가능 (7일 후 낙찰)
        if (isProtected && !isOwner) {
            const remaining = territoryManager.getProtectionRemaining(territory.id);
            return `
                <div class="protected-notice">
                    <span class="protected-icon">🛡️</span>
                    <span>Protected Territory</span>
                    <small>Auction ends in ${remaining.days}d ${remaining.hours}h</small>
                </div>
                <button class="action-btn auction-btn" id="start-auction">
                    🏷️ Start Auction (ends after protection)
                </button>
            `;
        }
        
        // 미정복 영토 - 구매 가능
        if (territory.sovereignty === SOVEREIGNTY.UNCONQUERED || (!territory.ruler && !auction)) {
            return `
                <button class="action-btn conquest-btn" id="instant-conquest">
                    ⚔️ Claim Now (${this.formatNumber(realPrice)} pt)
                </button>
                <button class="action-btn auction-btn" id="start-auction">
                    🏷️ Start Auction
                </button>
            `;
        }
        
        // 다른 사람 소유 영토 (보호 기간 아님, 경매 없음)
        // 관리자 모드이고 관리자가 점유한 영토인 경우 challenge 버튼 표시하지 않음
        if (territory.ruler && !isOwner && !auction) {
            // 관리자 모드이고 관리자가 점유한 영토인지 확인
            const isAdminOwned = isAdmin && territory.purchasedByAdmin;
            
            if (isAdminOwned) {
                // 관리자가 점유한 영토는 관리자 모드에서 challenge 버튼 표시하지 않음
                return `
                    <div class="admin-territory-notice">
                        <span class="notice-icon">🔧</span>
                        <span>관리자가 점유한 영토입니다</span>
                    </div>
                `;
            }
            
            return `
                <button class="action-btn challenge-btn" id="challenge-ruler">
                    ⚔️ Challenge Owner
                </button>
            `;
        }
        
        // 기본: 아무 버튼도 표시하지 않음
        return '';
    }
    
    /**
     * 액션 바인딩
     */
    bindActions() {
        // 닫기 버튼
        const closeBtn = document.getElementById('close-territory-panel');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }
        
        // 로그인 버튼
        const loginBtn = document.getElementById('login-to-conquer');
        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            });
        }
        
        // 즉시 정복 버튼
        const conquestBtn = document.getElementById('instant-conquest');
        if (conquestBtn) {
            conquestBtn.addEventListener('click', () => this.handleInstantConquest());
        }
        
        // 옥션 시작 버튼
        const auctionBtn = document.getElementById('start-auction');
        if (auctionBtn) {
            auctionBtn.addEventListener('click', () => this.handleStartAuction());
        }
        
        // 입찰 버튼
        const bidBtn = document.getElementById('place-bid-btn');
        if (bidBtn) {
            bidBtn.addEventListener('click', () => this.handlePlaceBid());
        }
        
        // Owner Challenge 버튼
        const challengeBtn = document.getElementById('challenge-ruler');
        if (challengeBtn) {
            challengeBtn.addEventListener('click', () => this.handleChallengeOwner());
        }
        
        // 픽셀 에디터 버튼
        const pixelBtn = document.getElementById('open-pixel-editor');
        if (pixelBtn) {
            pixelBtn.addEventListener('click', () => {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { 
                    type: 'pixelEditor', 
                    data: this.currentTerritory 
                });
            });
        }
        
        // 소셜 공유 버튼
        this.container.querySelectorAll('.share-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const platform = e.currentTarget.dataset.platform;
                this.shareTerritory(platform);
            });
        });
    }
    
    /**
     * 영토 공유
     */
    shareTerritory(platform) {
        const t = this.currentTerritory;
        if (!t) return;
        
        const territoryName = this.extractName(t.name) || t.id;
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
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to claim this territory'
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
        
        const territoryName = this.extractName(this.currentTerritory.name) || 
                             this.extractName(this.currentTerritory.properties?.name) ||
                             this.currentTerritory.id;
        
        // 관리자 모드: 일반 구매 프로세스 사용 (PaymentService에서 자동 포인트 충전 처리)
        
        // 경매가 활성화되어 있는지 확인
        const activeAuction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isUserHighestBidder = activeAuction && activeAuction.highestBidder === user.uid;
        
        // 경매가 활성화되어 있고 입찰자가 있는 경우 확인 다이얼로그
        if (activeAuction && activeAuction.status === AUCTION_STATUS.ACTIVE && activeAuction.highestBidder) {
            const confirmMessage = isUserHighestBidder
                ? `This will cancel the auction and refund your bid of ${this.formatNumber(activeAuction.currentBid)} pt. Continue?`
                : `This will cancel the active auction. The current highest bidder will be refunded. Continue?`;
            
            if (!confirm(confirmMessage)) {
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
        
        // Buy Now 가격 결정 (경매 중일 때 조정된 가격 사용)
        let price;
        if (activeAuction && activeAuction.status === AUCTION_STATUS.ACTIVE) {
            // 버튼에서 data-buy-now-price 속성 읽기
            const buyNowBtn = document.getElementById('instant-conquest');
            const adjustedPrice = buyNowBtn?.dataset?.buyNowPrice;
            
            if (adjustedPrice) {
                price = parseFloat(adjustedPrice);
            } else {
                // 속성이 없으면 계산
                const countryCode = this.currentTerritory.country || 
                                   this.currentTerritory.properties?.country || 
                                   'unknown';
                const basePrice = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
                
                // 입찰가 확인
                const auctionCurrentBid = this.getEffectiveAuctionBid(activeAuction);
                const minBid = auctionCurrentBid + 1;
                
                // 입찰가가 원래 구매가를 넘어섰으면 조정
                if (auctionCurrentBid >= basePrice) {
                    price = Math.max(
                        Math.ceil(minBid * 1.15), // 최소 입찰가의 115%
                        minBid + 10 // 또는 최소 입찰가 + 10pt
                    );
                } else {
                    price = basePrice;
                }
            }
        } else {
            // 경매가 없으면 일반 가격 계산
            const countryCode = this.currentTerritory.country || 
                               this.currentTerritory.properties?.country || 
                               'unknown';
            price = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
        }
        
        try {
            // 결제 시작 이벤트 (PaymentService에서 처리)
            eventBus.emit(EVENTS.PAYMENT_START, {
                type: 'conquest',
                territoryId: this.currentTerritory.id,
                territoryName: territoryName,
                amount: price,
                cancelAuction: !!activeAuction
            });
            
        } catch (error) {
            log.error('Conquest failed:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Failed to process purchase. Please try again.'
            });
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
                message: 'Please sign in to challenge the owner'
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
        if (!this.currentTerritory.ruler) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'This territory has no owner'
            });
            return;
        }
        
        // 자신의 영토인지 확인
        if (this.currentTerritory.ruler === user.uid) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'You already own this territory'
            });
            return;
        }
        
        // 확인 다이얼로그
        const territoryName = this.extractName(this.currentTerritory.name) || 
                             this.extractName(this.currentTerritory.properties?.name) ||
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
                message: '🎯 Challenge started! Auction is now active!'
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Challenge owner failed:', error);
            
            // 사용자 친화적 에러 메시지
            let errorMessage = 'Failed to start challenge';
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
     * 입찰 처리
     */
    async handlePlaceBid() {
        const input = document.getElementById('bid-amount-input');
        if (!input) return;
        
        const bidAmount = parseInt(input.value, 10);
        const user = firebaseService.getCurrentUser();
        const auction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isAdmin = this.isAdminMode();
        
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
        
        try {
            // 관리자 모드가 아닌 경우에만 포인트 차감
            if (!isAdmin) {
                await walletService.deductPoints(bidAmount, `Auction bid for ${auction.territoryId}`, 'bid', {
                    auctionId: auction.id,
                    territoryId: auction.territoryId
                });
            }
            
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
            
            // 옥션 데이터 새로고침 (Firestore에서 최신 데이터 가져오기)
            await auctionSystem.loadActiveAuctions();
            
            // 현재 옥션 데이터 다시 가져오기 (최신 데이터 보장)
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
            
            let errorMessage = 'Failed to place bid';
            if (error.message.includes('Minimum')) {
                errorMessage = error.message;
            } else if (error.message.includes('not active')) {
                errorMessage = 'Auction has ended';
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage
            });
        }
    }
    
    // ==================== 헬퍼 메서드 ====================
    
    /**
     * 이름 추출 (객체일 수 있으므로 문자열로 변환)
     */
    extractName(name) {
        if (!name) return null;
        if (typeof name === 'string') return name;
        if (typeof name === 'object') {
            return name.en || name.ko || name.local || Object.values(name)[0] || null;
        }
        return String(name);
    }
    
    getTerritoryIcon(sovereignty) {
        const icons = {
            [SOVEREIGNTY.UNCONQUERED]: '🏴',
            [SOVEREIGNTY.CONTESTED]: '⚔️',
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


