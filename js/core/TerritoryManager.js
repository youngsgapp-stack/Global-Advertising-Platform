/**
 * TerritoryManager - 영토 관리 모듈
 * 영토 데이터 관리, 주권 상태, 가치 계산
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';
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
        this.territories = new Map(); // territoryId -> { territory, fetchedAt, revision }
        this.currentTerritory = null;
        this.unsubscribers = [];
        this.processingTerritoryId = null; // 무한 루프 방지
        this.processingConquest = new Set(); // 구매 처리 중인 territoryId 추적
        this.isoToSlugMap = null; // ISO 코드 -> 슬러그 매핑 캐시
        
        // ⚠️ 캐시 TTL 설정 (기본 5분)
        this.CACHE_TTL_MS = 5 * 60 * 1000; // 5분
        this.protectionCheckInterval = null; // 보호 기간 체크 인터벌
        this._lastFetched = new Map(); // ⚡ 캐시: territoryId -> 마지막 fetch 시간 (가이드 권장)
        this.CACHE_TTL = 30 * 1000; // ⚡ 30초 캐시 (가이드 권장)
        this.localNames = null; // 국가별 현지어 이름 매핑 테이블
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
            console.log('[TerritoryManager] 🚀 initialize() started');
            log.info('[TerritoryManager] 🚀 initialize() started');
            
            // 현지어 이름 매핑 테이블 로드
            console.log('[TerritoryManager] 📚 Loading local names...');
            log.info('[TerritoryManager] 📚 Loading local names...');
            await this.loadLocalNames();
            console.log('[TerritoryManager] ✅ Local names loaded');
            log.info('[TerritoryManager] ✅ Local names loaded');
            
            // ⚠️ 전문가 조언 반영: 이벤트 리스너를 먼저 설정하여 로그인 이벤트를 놓치지 않도록
            // 타이밍 이슈 해결: setupEventListeners()를 먼저 호출하여 AUTH_STATE_CHANGED 이벤트를 구독
            log.info('[TerritoryManager] 🔧 Setting up event listeners...');
            this.setupEventListeners();
            
            // Firestore에서 영토 데이터 로드
            console.log('[TerritoryManager] 📥 Calling loadTerritoriesFromFirestore()...');
            log.info('[TerritoryManager] 📥 Calling loadTerritoriesFromFirestore()...');
            await this.loadTerritoriesFromFirestore();
            console.log('[TerritoryManager] ✅ loadTerritoriesFromFirestore() completed');
            log.info('[TerritoryManager] ✅ loadTerritoriesFromFirestore() completed');
            
            // ⚠️ 타이밍 이슈 해결: initialize() 시점에 이미 로그인되어 있을 수 있으므로
            // 잠시 후 한 번 더 확인 (onAuthStateChanged가 아직 호출되지 않았을 수 있음)
            setTimeout(async () => {
                const realAuthUser = firebaseService.getRealAuthUser ? firebaseService.getRealAuthUser() : null;
                const currentUser = firebaseService.getCurrentUser();
                const user = realAuthUser || currentUser;
                
                console.log('[TerritoryManager] 🔄 Retry check after 2s delay...');
                console.log('[TerritoryManager] 🔄 getRealAuthUser():', realAuthUser ? `${realAuthUser.email}` : 'null');
                console.log('[TerritoryManager] 🔄 getCurrentUser():', currentUser ? `${currentUser.email}` : 'null');
                console.log('[TerritoryManager] 🔄 territories.size:', this.territories.size);
                log.info('[TerritoryManager] 🔄 Retry check after 2s delay...');
                log.info('[TerritoryManager] 🔄 getRealAuthUser():', realAuthUser ? `${realAuthUser.email}` : 'null');
                log.info('[TerritoryManager] 🔄 getCurrentUser():', currentUser ? `${currentUser.email}` : 'null');
                log.info('[TerritoryManager] 🔄 territories.size:', this.territories.size);
                
                if (user && this.territories.size === 0) {
                    log.info('[TerritoryManager] 🔄 Retrying loadTerritoriesFromFirestore() after delay (user was already logged in)');
                    await this.loadTerritoriesFromFirestore();
                } else if (!user) {
                    log.info('[TerritoryManager] ⚠️ Still no user after delay, waiting for AUTH_STATE_CHANGED event');
                } else {
                    log.info('[TerritoryManager] ✅ Territories already loaded, skipping retry');
                }
            }, 2000); // 2초 후 재시도
            
            // ⚠️ CRITICAL: 주기적으로 보호 기간 체크 (서버 cron 실패 시 대비)
            this.startProtectionPeriodCheck();
            
            log.info('TerritoryManager initialized');
            return true;
            
        } catch (error) {
            log.error('[TerritoryManager] ❌ TerritoryManager initialization failed:', error);
            log.error('[TerritoryManager] ❌ Error stack:', error.stack);
            console.error('[TerritoryManager] ❌ Full error details:', error);
            return false;
        }
    }
    
    /**
     * 현지어 이름 매핑 테이블 로드
     * 국가별 지역명 → 현지어 매핑을 JSON 파일에서 로드
     */
    async loadLocalNames() {
        try {
            log.info('[TerritoryManager] 🔄 Starting to load local-names.json...');
            
            // 여러 경로 시도 (개발/프로덕션 환경 대응)
            const possiblePaths = [
                '/data/local-names.json',
                './data/local-names.json',
                '../data/local-names.json',
                'data/local-names.json'
            ];
            
            let response = null;
            let lastError = null;
            
            for (const path of possiblePaths) {
                try {
                    response = await fetch(path);
                    if (response.ok) {
                        log.info(`[TerritoryManager] ✅ Found local-names.json at: ${path}`);
                        break;
                    }
                } catch (err) {
                    lastError = err;
                    log.debug(`[TerritoryManager] ⚠️ Failed to load from ${path}:`, err.message);
                }
            }
            
            if (!response || !response.ok) {
                log.error(`[TerritoryManager] ❌ Failed to load local-names.json from all paths`);
                log.error(`[TerritoryManager] ❌ Last error:`, lastError);
                log.error(`[TerritoryManager] ❌ Tried paths:`, possiblePaths);
                this.localNames = {};
                return;
            }
            
            log.info('[TerritoryManager] ✅ Successfully fetched local-names.json, parsing JSON...');
            const jsonText = await response.text();
            log.debug(`[TerritoryManager] JSON text length: ${jsonText.length} characters`);
            
            if (!jsonText || jsonText.trim().length === 0) {
                log.error(`[TerritoryManager] ❌ local-names.json is empty`);
                this.localNames = {};
                return;
            }
            
            try {
                this.localNames = JSON.parse(jsonText);
            } catch (parseError) {
                log.error(`[TerritoryManager] ❌ JSON parse error:`, parseError);
                log.error(`[TerritoryManager] ❌ Parse error message: ${parseError.message}`);
                
                // JSON 파싱 에러 위치 찾기
                if (parseError.message.includes('position')) {
                    const match = parseError.message.match(/position (\d+)/);
                    if (match) {
                        const pos = parseInt(match[1]);
                        
                        // 라인 번호 계산
                        const textBeforeError = jsonText.substring(0, pos);
                        const lineNumber = textBeforeError.split('\n').length;
                        const columnNumber = textBeforeError.split('\n').pop().length + 1;
                        
                        log.error(`[TerritoryManager] ❌ Error at position ${pos} (line ${lineNumber}, column ${columnNumber})`);
                        
                        // 에러 주변 컨텍스트 표시
                        const start = Math.max(0, pos - 200);
                        const end = Math.min(jsonText.length, pos + 200);
                        const context = jsonText.substring(start, end);
                        const contextStartLine = jsonText.substring(0, start).split('\n').length;
                        const contextEndLine = jsonText.substring(0, end).split('\n').length;
                        
                        log.error(`[TerritoryManager] ❌ JSON context (lines ${contextStartLine}-${contextEndLine}):`);
                        log.error(`[TerritoryManager] ❌ ${context}`);
                        
                        // 라인별로 표시 (더 읽기 쉽게)
                        const lines = context.split('\n');
                        const errorLineIndex = textBeforeError.split('\n').length - contextStartLine;
                        lines.forEach((line, index) => {
                            if (index === errorLineIndex) {
                                log.error(`[TerritoryManager] ❌ >>> ${line} <<< (ERROR HERE)`);
                            } else {
                                log.debug(`[TerritoryManager]     ${line}`);
                            }
                        });
                    }
                }
                this.localNames = {};
                return;
            }
            
            // 디버깅: 로드된 데이터 확인
            if (!this.localNames || typeof this.localNames !== 'object') {
                log.error(`[TerritoryManager] ❌ local-names.json is not a valid object:`, typeof this.localNames);
                this.localNames = {};
                return;
            }
            
            // 빈 객체 체크
            if (Object.keys(this.localNames).length === 0) {
                log.error(`[TerritoryManager] ❌ local-names.json is an empty object`);
                this.localNames = {};
                return;
            }
            
            const totalMappings = Object.values(this.localNames).reduce((sum, country) => {
                return sum + Object.keys(country).length;
            }, 0);
            const countryCount = Object.keys(this.localNames).length;
            
            log.info(`[TerritoryManager] ✅ Loaded local names mapping: ${countryCount} countries, ${totalMappings} territories`);
            
            // 디버깅: 주요 국가 확인
            const importantCountries = ['china', 'south-korea', 'india', 'japan', 'serbia'];
            for (const country of importantCountries) {
                if (this.localNames[country]) {
                    const territoryCount = Object.keys(this.localNames[country]).length;
                    log.info(`[TerritoryManager] ✅ ${country}: ${territoryCount} territories`);
                } else {
                    log.debug(`[TerritoryManager] ${country} not found in local-names.json`);
                }
            }
        } catch (error) {
            log.error('[TerritoryManager] ❌ Failed to load local-names.json:', error);
            log.error('[TerritoryManager] ❌ Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            this.localNames = {};
        }
    }
    
    /**
     * displayName 생성 (영어 + 현지어 조합)
     * @param {object} territory - Territory 객체
     * @returns {object} displayName 객체 { en, local, ko }
     */
    createDisplayName(territory) {
        if (!territory) {
            return { en: null, local: null, ko: null };
        }
        
        let countryCode = territory.country?.toLowerCase()?.replace(/\s+/g, '-') || 
                          territory.countryCode?.toLowerCase()?.replace(/\s+/g, '-') ||
                          null;
        
        // 국가 코드 매핑 (알려진 별칭/변형 처리)
        if (countryCode) {
            const countryCodeMapping = {
                'kos': 'serbia',        // 코소보는 세르비아의 일부
                'ch1': 'china',         // 중국 지역 코드
                'ch2': 'china',
                'ch3': 'china',
                'obili': 'serbia',      // 코소보 지역
                'kosovo-polje': 'serbia',
                'lipljan': 'serbia'
            };
            
            // 매핑이 있으면 사용
            if (countryCodeMapping[countryCode]) {
                countryCode = countryCodeMapping[countryCode];
            }
        }
        
        // territoryId 가져오기 (code 또는 id 사용, 둘 다 정규화)
        let territoryId = territory.code || territory.id || null;
        const originalTerritoryId = territoryId;
        
        // territoryId 정규화 (괄호 제거 등) - 원본은 보존하고 정규화된 버전으로 조회
        const normalizedTerritoryId = territoryId ? this.normalizeTerritoryId(territoryId) : null;
        
        // 영어 이름 결정 (우선순위: name_en > name > id)
        const englishName = territory.name_en || 
                           (typeof territory.name === 'string' ? territory.name : territory.name?.en) ||
                           normalizedTerritoryId ||
                           originalTerritoryId ||
                           'Unknown Territory';
        
        // 현지어 이름 가져오기 (매핑 테이블에서) - 정규화된 ID 사용
        // ⚠️ 중요: this.localNames가 로드되지 않았으면 null 반환
        let localName = null;
        if (countryCode && normalizedTerritoryId && this.localNames) {
            localName = this.getLocalName(countryCode, normalizedTerritoryId);
        } else if (countryCode && normalizedTerritoryId && !this.localNames) {
            log.debug(`[TerritoryManager] this.localNames is not loaded yet for ${normalizedTerritoryId} in ${countryCode}`);
        }
        
        // 디버깅: 상세 로그 (항상 출력)
        if (countryCode && normalizedTerritoryId) {
            log.info(`[TerritoryManager] createDisplayName - countryCode: ${countryCode}, originalTerritoryId: ${originalTerritoryId}, normalizedTerritoryId: ${normalizedTerritoryId}, localName: ${localName}`);
            
            // ⚠️ CRITICAL: this.localNames 상태 확인
            if (!this.localNames) {
                log.error(`[TerritoryManager] ❌ this.localNames is null or undefined! local-names.json may not be loaded yet.`);
            } else if (Object.keys(this.localNames).length === 0) {
                log.error(`[TerritoryManager] ❌ this.localNames is empty object! local-names.json may have failed to load.`);
            } else {
                log.debug(`[TerritoryManager] this.localNames has ${Object.keys(this.localNames).length} countries`);
            }
            
            if (!localName) {
                // 디버그 레벨로 변경하여 로그 감소 (에러만 유지)
                if (!this.localNames) {
                    log.error(`[TerritoryManager] ❌ this.localNames is null or undefined! local-names.json may not be loaded yet.`);
                } else if (Object.keys(this.localNames).length === 0) {
                    log.error(`[TerritoryManager] ❌ this.localNames is empty object! local-names.json may have failed to load.`);
                } else {
                    log.debug(`[TerritoryManager] localName is null for ${normalizedTerritoryId} in ${countryCode}`);
                }
            }
        } else {
            log.debug(`[TerritoryManager] Cannot get localName: countryCode=${countryCode}, normalizedTerritoryId=${normalizedTerritoryId}`);
        }
        
        // name 객체에서도 시도 (기존 데이터 호환성)
        const nameLocal = typeof territory.name === 'object' ? territory.name?.local : null;
        
        // 최종 현지어 결정 (우선순위: 매핑 테이블 > name.local > 영어 이름)
        // ⚠️ 중요: localName이 있으면 무조건 사용 (영어 이름과 같아도 현지어로 인식)
        // localName이 null이면 nameLocal을 사용하고, 그것도 null이면 englishName을 사용
        const finalLocalName = localName || nameLocal || englishName;
        
        // 한국어 결정 (한국이면 local과 동일, 아니면 null)
        const koName = countryCode === 'south-korea' ? finalLocalName : 
                      (typeof territory.name === 'object' ? territory.name?.ko : null) ||
                      null;
        
        const displayName = {
            en: englishName,
            local: finalLocalName, // localName이 있으면 현지어, 없으면 영어 이름
            ko: koName,
            // 디버깅용: localName이 매핑에서 온 것인지 표시
            hasLocalMapping: !!localName
        };
        
        // 디버깅: displayName 생성 로그
        if (countryCode && normalizedTerritoryId) {
            log.info(`[TerritoryManager] Created displayName for ${normalizedTerritoryId} (${countryCode}):`, {
                originalTerritoryId: originalTerritoryId,
                normalizedTerritoryId: normalizedTerritoryId,
                en: displayName.en,
                local: displayName.local,
                ko: displayName.ko,
                hasLocalMapping: !!localName,
                localNameFromMapping: localName,
                nameLocal: nameLocal,
                territoryCode: territory.code,
                territoryId: territory.id
            });
        } else {
            log.debug(`[TerritoryManager] Cannot create displayName: countryCode=${countryCode}, normalizedTerritoryId=${normalizedTerritoryId}`);
        }
        
        return displayName;
    }
    
    /**
     * territoryId 정규화 헬퍼 함수
     * @param {string} territoryId - 영토 ID (다양한 형식 지원)
     * @returns {string} 정규화된 territoryId
     */
    normalizeTerritoryId(territoryId) {
        if (!territoryId) return '';
        
        let normalized = String(territoryId).toLowerCase().trim();
        const original = normalized;
        
        // 괄호와 괄호 안의 내용 제거 (예: "yunnan (ch1)" -> "yunnan")
        normalized = normalized.replace(/\s*\([^)]*\)\s*/g, '').trim();
        
        // 대괄호와 대괄호 안의 내용 제거 (예: "yunnan [ch1]" -> "yunnan")
        normalized = normalized.replace(/\s*\[[^\]]*\]\s*/g, '').trim();
        
        // 중괄호와 중괄호 안의 내용 제거 (예: "yunnan {ch1}" -> "yunnan")
        normalized = normalized.replace(/\s*\{[^}]*\}\s*/g, '').trim();
        
        // 앞뒤 공백 제거
        normalized = normalized.trim();
        
        // 디버깅: 정규화 결과 로그
        if (original !== normalized) {
            log.debug(`[TerritoryManager] normalizeTerritoryId: "${original}" -> "${normalized}"`);
        }
        
        return normalized;
    }
    
    /**
     * 현지어 이름 가져오기
     * @param {string} countryCode - 국가 코드 (예: 'south-korea', 'china')
     * @param {string} territoryId - 영토 ID (예: 'north-gyeongsang', 'qinghai', 'yunnan (ch1)')
     * @returns {string|null} 현지어 이름 또는 null
     */
    getLocalName(countryCode, territoryId) {
        if (!this.localNames || !countryCode || !territoryId) {
            return null;
        }
        
        // 국가 코드 정규화 (소문자, 하이픈 처리)
        let normalizedCountryCode = countryCode.toLowerCase().trim();
        
        // 국가 코드 매핑 (알려진 별칭/변형 처리)
        const countryCodeMapping = {
            'kos': 'serbia',        // 코소보는 세르비아의 일부
            'ch1': 'china',         // 중국 지역 코드
            'ch2': 'china',
            'ch3': 'china',
            'obili': 'serbia',      // 코소보 지역
            'kosovo-polje': 'serbia',
            'lipljan': 'serbia'
        };
        
        // 매핑이 있으면 사용
        if (countryCodeMapping[normalizedCountryCode]) {
            normalizedCountryCode = countryCodeMapping[normalizedCountryCode];
        }
        
        // territoryId 정규화 (모든 형식 지원)
        let normalizedTerritoryId = this.normalizeTerritoryId(territoryId);
        
        // 매핑 테이블에서 찾기
        const countryMapping = this.localNames[normalizedCountryCode];
        if (!countryMapping) {
            // 디버깅: 왜 매핑을 찾지 못했는지 확인
            if (!this.localNames) {
                log.error(`[TerritoryManager] getLocalName: ❌ this.localNames is null or undefined!`);
            } else if (Object.keys(this.localNames).length === 0) {
                log.error(`[TerritoryManager] getLocalName: ❌ this.localNames is empty object! local-names.json may have failed to load.`);
            } else {
                // 디버그 레벨로 변경하여 로그 감소
                log.debug(`[TerritoryManager] getLocalName: No country mapping found for "${normalizedCountryCode}"`);
            }
            return null;
        }
        
        // 정확한 매칭 시도
        if (countryMapping[normalizedTerritoryId]) {
            log.debug(`[TerritoryManager] getLocalName: ✅ Found exact match for ${territoryId} -> ${normalizedTerritoryId} = ${countryMapping[normalizedTerritoryId]}`);
            return countryMapping[normalizedTerritoryId];
        }
        
        // 하이픈을 언더스코어로 변환하여 시도 (north-gyeongsang -> north_gyeongsang)
        const underscoreId = normalizedTerritoryId.replace(/-/g, '_');
        if (countryMapping[underscoreId]) {
            log.debug(`[TerritoryManager] getLocalName: ✅ Found match with underscore for ${territoryId} -> ${underscoreId} = ${countryMapping[underscoreId]}`);
            return countryMapping[underscoreId];
        }
        
        // 언더스코어를 하이픈으로 변환하여 시도 (north_gyeongsang -> north-gyeongsang)
        const hyphenId = normalizedTerritoryId.replace(/_/g, '-');
        if (countryMapping[hyphenId]) {
            log.debug(`[TerritoryManager] getLocalName: ✅ Found match with hyphen for ${territoryId} -> ${hyphenId} = ${countryMapping[hyphenId]}`);
            return countryMapping[hyphenId];
        }
        
        // 부분 매칭 시도 (예: "yunnan-ch1" -> "yunnan")
        const parts = normalizedTerritoryId.split(/[-_\s]+/);
        if (parts.length > 1) {
            // 첫 번째 부분만 사용 (예: "yunnan-ch1" -> "yunnan")
            const firstPart = parts[0];
            if (countryMapping[firstPart]) {
                log.debug(`[TerritoryManager] getLocalName: ✅ Found match with first part for ${territoryId} -> ${firstPart} = ${countryMapping[firstPart]}`);
                return countryMapping[firstPart];
            }
        }
        
        // territoryId 별칭 매핑 (특정 지역의 다른 이름 처리)
        const territoryIdMapping = {
            'kosovo-polje': 'kosovo-and-metohija',
            'lipljan': 'kosovo-and-metohija',
            'obili': 'kosovo-and-metohija'
        };
        
        if (territoryIdMapping[normalizedTerritoryId] && countryMapping[territoryIdMapping[normalizedTerritoryId]]) {
            log.debug(`[TerritoryManager] getLocalName: ✅ Found match via territoryId mapping for ${territoryId} -> ${territoryIdMapping[normalizedTerritoryId]} = ${countryMapping[territoryIdMapping[normalizedTerritoryId]]}`);
            return countryMapping[territoryIdMapping[normalizedTerritoryId]];
        }
        
        // 부분 문자열 매칭 시도 (예: "kosovo-polje" -> "kosovo-and-metohija")
        const territoryKeys = Object.keys(countryMapping);
        const partialMatch = territoryKeys.find(key => 
            normalizedTerritoryId.includes(key) || key.includes(normalizedTerritoryId)
        );
        if (partialMatch) {
            log.debug(`[TerritoryManager] getLocalName: ✅ Found partial match for ${territoryId} -> ${partialMatch} = ${countryMapping[partialMatch]}`);
            return countryMapping[partialMatch];
        }
        
        log.debug(`[TerritoryManager] getLocalName: ❌ No match found for ${territoryId} (normalized: ${normalizedTerritoryId}) in country ${normalizedCountryCode}`);
        return null;
    }
    
    /**
     * 보호 기간 주기적 체크 시작 (서버 cron 실패 시 대비)
     * 5분마다 체크하여 만료된 보호 기간 자동 수정
     * ⚠️ 응급 조치: 폴링 비활성화 (Firestore 읽기 폭발 방지)
     * TODO: Cloud Functions Cron으로 이동 필요
     */
    startProtectionPeriodCheck() {
        // ⚠️ 응급 조치: 폴링 비활성화
        log.warn('[TerritoryManager] ⚠️ Protection check interval DISABLED to prevent Firestore read explosion');
        log.warn('[TerritoryManager] TODO: Move to Cloud Functions Cron job');
        return;
        
        // 아래 코드는 나중에 Cloud Functions로 이동 예정
        /*
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
        */
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
        
        // ⚠️ 응급 조치: TERRITORY_SELECT 이벤트 제거 (중복 읽기 방지)
        // 레거시 호환성 제거 - TERRITORY_CLICKED만 사용
        // eventBus.on(EVENTS.TERRITORY_SELECT, ...) 제거됨
        
        // 영토 정복 이벤트
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.handleTerritoryConquered(data);
        });
        
        // ⚠️ 전문가 조언 반영: 로그인 후 territories 로드
        // 타이밍 이슈 해결: initialize() 시점에 로그인하지 않았을 수 있으므로
        // 로그인 이벤트를 구독하여 로그인 후 territories를 로드
        eventBus.on(EVENTS.AUTH_STATE_CHANGED, async (data) => {
            if (data.user) {
                log.info('[TerritoryManager] 🔐 User logged in, loading territories...');
                // 이미 로드되었는지 확인 (중복 로드 방지)
                if (this.territories.size === 0) {
                    await this.loadTerritoriesFromFirestore();
                } else {
                    // 이미 로드되었으면 ownership overlay만 업데이트
                    await this.loadOwnershipOverlay();
                }
            }
        });
        
        // AUTH_LOGIN 이벤트도 구독 (이중 안전장치)
        eventBus.on(EVENTS.AUTH_LOGIN, async (data) => {
            if (data.user) {
                log.info('[TerritoryManager] 🔐 AUTH_LOGIN event received, loading territories...');
                // 이미 로드되었는지 확인 (중복 로드 방지)
                if (this.territories.size === 0) {
                    await this.loadTerritoriesFromFirestore();
                } else {
                    // 이미 로드되었으면 ownership overlay만 업데이트
                    await this.loadOwnershipOverlay();
                }
            }
        });
    }
    
    /**
     * API에서 영토 데이터 로드 (Firestore 대신)
     */
    /**
     * ⚠️ 전문가 조언 반영: 초기 로드 전략 개선
     * - Firestore는 지형/메타데이터 용으로만 사용 (소유권 정보 제외)
     * - 소유권(ownership/ruler)은 백엔드 DB/API에서만 로드
     * - 초기 로드 시 ownership overlay를 별도로 받아서 merge
     */
    async loadTerritoriesFromFirestore() {
        try {
            console.log('[TerritoryManager] 🔄 loadTerritoriesFromFirestore() called');
            log.info('[TerritoryManager] 🔄 loadTerritoriesFromFirestore() called');
            
            // ⚠️ 로그인 상태 확인 (getRealAuthUser 우선 사용 - 타이밍 이슈 해결)
            // getRealAuthUser()는 this.auth.currentUser를 직접 반환하므로 더 신뢰할 수 있음
            const realAuthUser = firebaseService.getRealAuthUser ? firebaseService.getRealAuthUser() : null;
            const currentUser = firebaseService.getCurrentUser();
            const user = realAuthUser || currentUser; // realAuthUser를 우선 사용
            
            // ⚠️ 디버깅: 로그인 상태 상세 확인
            console.log('[TerritoryManager] 🔍 Checking authentication status...');
            console.log('[TerritoryManager] 🔍 getRealAuthUser():', realAuthUser ? `${realAuthUser.email} (${realAuthUser.uid})` : 'null');
            console.log('[TerritoryManager] 🔍 getCurrentUser():', currentUser ? `${currentUser.email} (${currentUser.uid})` : 'null');
            log.info('[TerritoryManager] 🔍 Checking authentication status...');
            log.info('[TerritoryManager] 🔍 getRealAuthUser():', realAuthUser ? `${realAuthUser.email} (${realAuthUser.uid})` : 'null');
            log.info('[TerritoryManager] 🔍 getCurrentUser():', currentUser ? `${currentUser.email} (${currentUser.uid})` : 'null');
            
            // ⚠️ 직접 auth.currentUser 확인 (디버깅용)
            if (firebaseService.auth && firebaseService.auth.currentUser) {
                console.log('[TerritoryManager] 🔍 firebaseService.auth.currentUser:', `${firebaseService.auth.currentUser.email} (${firebaseService.auth.currentUser.uid})`);
                log.info('[TerritoryManager] 🔍 firebaseService.auth.currentUser:', `${firebaseService.auth.currentUser.email} (${firebaseService.auth.currentUser.uid})`);
            } else {
                console.log('[TerritoryManager] 🔍 firebaseService.auth.currentUser: null or auth not available');
                log.info('[TerritoryManager] 🔍 firebaseService.auth.currentUser: null or auth not available');
            }
            
            if (!user) {
                // ⚠️ 검증을 위해 info 레벨로 변경 (로그인 상태 확인용)
                console.log('[TerritoryManager] ⚠️ User not authenticated, skipping territory load');
                console.log('[TerritoryManager] ⚠️ Will retry when user logs in (AUTH_STATE_CHANGED or AUTH_LOGIN event)');
                log.info('[TerritoryManager] ⚠️ User not authenticated, skipping territory load');
                log.info('[TerritoryManager] ⚠️ Will retry when user logs in (AUTH_STATE_CHANGED or AUTH_LOGIN event)');
                return;
            }
            
            console.log('[TerritoryManager] 🔄 Starting loadTerritoriesFromFirestore()...');
            console.log('[TerritoryManager] ✅ User authenticated:', user.email || user.uid);
            log.info('[TerritoryManager] 🔄 Starting loadTerritoriesFromFirestore()...');
            log.info('[TerritoryManager] ✅ User authenticated:', user.email || user.uid);
            
            // ⚠️ 전문가 조언 반영: 초기 로드
            // 백엔드 GET /api/territories 엔드포인트는 이미 ruler_firebase_uid를 포함하도록 수정됨
            // 따라서 초기 로드 시 이미 소유권 정보가 포함되어 있을 수 있음
            console.log('[TerritoryManager] 📡 Calling apiService.getTerritories()...');
            const territories = await apiService.getTerritories();
            console.log('[TerritoryManager] 📡 Received territories from API:', territories?.length || 0);
            
            // TerritoryAdapter를 사용하여 표준 모델로 변환 (변환 로직 중앙화)
            const { territoryAdapter } = await import('../adapters/TerritoryAdapter.js');
            const standardTerritories = territoryAdapter.toStandardModels(territories);
            console.log('[TerritoryManager] 🔄 Converted to standard territories:', standardTerritories.length);
            
            // ⚠️ 전문가 조언: 소유권 정보는 명시적으로 overlay하여 일관성 보장
            // loadOwnershipOverlay()에서 추가로 확인 및 업데이트
            
            for (const territory of standardTerritories) {
                // ⚠️ 캐시 메타데이터 추가 (fetchedAt, revision)
                this.territories.set(territory.id, {
                    territory,
                    fetchedAt: new Date(),
                    revision: Date.now()
                });
            }
            
            console.log(`[TerritoryManager] ✅ Loaded ${standardTerritories.length} territories metadata from API`);
            log.info(`[TerritoryManager] ✅ Loaded ${standardTerritories.length} territories metadata from API`);
            
            // ⚠️ 전문가 조언 반영: 초기 로드 후 ownership overlay 자동 주입
            // 새로고침 후에도 바로 owner/비owner가 맞게 표시되도록
            console.log('[TerritoryManager] 🔄 Calling loadOwnershipOverlay()...');
            await this.loadOwnershipOverlay();
            console.log('[TerritoryManager] ✅ loadOwnershipOverlay() completed');
            
        } catch (error) {
            // 인증 오류는 조용히 처리 (로그인 전에는 정상)
            if (error.message === 'User not authenticated') {
                log.debug('[TerritoryManager] User not authenticated, skipping territory load');
                return;
            }
            log.warn('[TerritoryManager] Failed to load territories from API:', error);
            // API 로드 실패 시 로컬 기본값 사용
        }
    }
    
    /**
     * ⚠️ 전문가 조언 반영: 초기 로드 후 ownership overlay 주입
     * 새로고침 후에도 바로 owner/비owner가 맞게 표시되도록 소유권 정보를 overlay
     * 
     * 이 메서드는 이미 로드된 territories 메타데이터에 소유권 정보를 주입합니다.
     * 백엔드 GET /api/territories 엔드포인트에서 이미 ruler_firebase_uid를 포함하므로,
     * 초기 로드 시 이미 소유권 정보가 포함되어 있을 수 있지만,
     * 명시적으로 overlay하여 일관성을 보장합니다.
     */
    async loadOwnershipOverlay() {
        try {
            console.log('[TerritoryManager] 🔄 loadOwnershipOverlay() called');
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                // ⚠️ 검증을 위해 info 레벨로 변경 (로그인 상태 확인용)
                console.log('[TerritoryManager] ⚠️ User not authenticated, skipping ownership overlay (this is normal if not logged in)');
                log.info('[TerritoryManager] ⚠️ User not authenticated, skipping ownership overlay (this is normal if not logged in)');
                return;
            }
            
            console.log('[TerritoryManager] 🔄 Loading ownership overlay...');
            log.info('[TerritoryManager] 🔄 Loading ownership overlay...');
            
            // ⚠️ 전문가 조언: 전체 territory를 한 개씩 GET 하지 말고, 한 번에 가져오는 형태
            // 기존 getTerritories() 엔드포인트는 이미 ruler_firebase_uid를 포함하도록 수정됨
            console.log('[TerritoryManager] 📡 Calling apiService.getTerritories() for ownership overlay...');
            const territories = await apiService.getTerritories();
            console.log('[TerritoryManager] 📡 Received territories for ownership overlay:', territories?.length || 0);
            
            if (!territories || !Array.isArray(territories)) {
                console.warn('[TerritoryManager] ⚠️ Invalid territories response for ownership overlay');
                log.warn('[TerritoryManager] ⚠️ Invalid territories response for ownership overlay');
                return;
            }
            
            // ⚠️ 디버깅: API 응답 샘플 확인 (소유권 정보 포함 여부)
            const sampleTerritories = territories.slice(0, 5);
            const sampleData = sampleTerritories.map(t => ({
                id: t.id,
                ruler_id: t.ruler_id,
                ruler_firebase_uid: t.ruler_firebase_uid,
                ruler_nickname: t.ruler_nickname,
                sovereignty: t.sovereignty,
                status: t.status,
                // 전체 객체의 키 확인
                allKeys: Object.keys(t)
            }));
            console.log('[TerritoryManager] 🔍 Sample API responses (first 5):', sampleData);
            console.log('[TerritoryManager] 🔍 Full first territory object:', JSON.stringify(territories[0], null, 2));
            
            // ⚠️ 디버깅: ruler_firebase_uid가 있는 territory 개수 확인
            const territoriesWithRulerFirebaseUid = territories.filter(t => t.ruler_firebase_uid).length;
            const territoriesWithRulerId = territories.filter(t => t.ruler_id).length;
            console.log(`[TerritoryManager] 🔍 API response stats: ${territoriesWithRulerFirebaseUid} with ruler_firebase_uid, ${territoriesWithRulerId} with ruler_id`);
            
            // ⚠️ 디버깅: 현재 사용자가 소유한 territory 찾기
            const currentUserFirebaseUid = firebaseService.getCurrentUser()?.uid;
            if (currentUserFirebaseUid) {
                const ownedTerritories = territories.filter(t => t.ruler_firebase_uid === currentUserFirebaseUid);
                console.log(`[TerritoryManager] 🔍 Current user (${currentUserFirebaseUid}) owns ${ownedTerritories.length} territories`);
                if (ownedTerritories.length > 0) {
                    console.log(`[TerritoryManager] 🔍 Owned territory IDs:`, ownedTerritories.slice(0, 10).map(t => t.id));
                }
            }
            
            // TerritoryAdapter를 사용하여 표준 모델로 변환
            const { territoryAdapter } = await import('../adapters/TerritoryAdapter.js');
            let updatedCount = 0;
            let territoriesWithRuler = 0;
            let territoriesWithoutRuler = 0;
            
            console.log('[TerritoryManager] 🔄 Processing territories for ownership overlay...');
            for (const apiTerritory of territories) {
                const standardTerritory = territoryAdapter.toStandardModel(apiTerritory);
                const territoryId = standardTerritory.id;
                
                // 소유권 정보 통계
                if (standardTerritory.ruler) {
                    territoriesWithRuler++;
                } else {
                    territoriesWithoutRuler++;
                }
                
                // 기존 territory 가져오기
                const existing = this.territories.get(territoryId);
                if (existing && existing.territory) {
                    // 소유권 정보 overlay (merge)
                    const existingTerritory = existing.territory;
                    
                    // ⚠️ 전문가 조언: ruler_firebase_uid를 우선 사용
                    if (standardTerritory.ruler) {
                        const hadRulerBefore = !!existingTerritory.ruler;
                        existingTerritory.ruler = standardTerritory.ruler;
                        existingTerritory.rulerId = standardTerritory.rulerId;
                        existingTerritory.rulerName = standardTerritory.rulerName;
                        existingTerritory.sovereignty = standardTerritory.sovereignty;
                        existingTerritory.status = standardTerritory.status;
                        
                        if (!hadRulerBefore) {
                            updatedCount++;
                        }
                    } else if (existingTerritory.ruler) {
                        // 기존에 소유권이 있었는데 새로 가져온 데이터에 없으면 유지 (이미 로드된 것이 최신일 수 있음)
                        log.debug(`[TerritoryManager] Territory ${territoryId} has existing ruler but API returned null, keeping existing`);
                    }
                } else {
                    // 기존 territory가 없으면 새로 추가 (초기 로드에서 누락된 경우)
                    this.territories.set(territoryId, {
                        territory: standardTerritory,
                        fetchedAt: new Date(),
                        revision: Date.now()
                    });
                    updatedCount++;
                }
            }
            
            console.log(`[TerritoryManager] 📊 Ownership overlay stats: ${territoriesWithRuler} with ruler, ${territoriesWithoutRuler} without ruler`);
            console.log(`[TerritoryManager] ✅ Ownership overlay completed: ${updatedCount} territories updated`);
            log.info(`[TerritoryManager] ✅ Ownership overlay completed: ${updatedCount} territories updated`);
            
            // ⚠️ 이벤트 발행: 소유권 정보가 업데이트되었음을 알림
            eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                territoryId: null, // 전체 업데이트
                forceRefresh: true,
                revision: Date.now()
            });
            
        } catch (error) {
            // 인증 오류는 조용히 처리
            if (error.message === 'User not authenticated') {
                log.debug('[TerritoryManager] User not authenticated, skipping ownership overlay');
                return;
            }
            log.warn('[TerritoryManager] Failed to load ownership overlay:', error);
            // 실패해도 계속 진행 (기존 데이터 사용)
        }
    }
    
    /**
     * API 응답 데이터를 내부 형식으로 정규화
     * 
     * ⚠️ DEPRECATED: TerritoryAdapter를 사용하세요
     * 하위 호환성을 위해 유지하지만, 새로운 코드는 TerritoryAdapter를 사용해야 합니다.
     * 
     * @deprecated Use territoryAdapter.toStandardModel() instead
     */
    normalizeTerritoryData(apiTerritory) {
        // Fallback: 기존 로직 (하위 호환성)
        // 새로운 코드는 TerritoryAdapter를 직접 import하여 사용해야 함
        const rulerFirebaseUid = apiTerritory.ruler_firebase_uid;
        const rulerId = apiTerritory.ruler_id;
        const rulerName = apiTerritory.ruler_name || apiTerritory.ruler_nickname;
        const sovereignty = apiTerritory.sovereignty || apiTerritory.status;
        
        return {
            ...apiTerritory,
            ruler: rulerFirebaseUid || rulerId || apiTerritory.ruler,
            rulerName: rulerName,
            sovereignty: sovereignty,
            ruler_id: rulerId,
            ruler_firebase_uid: rulerFirebaseUid
        };
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
            
            // 영토 조회수 증가 (로그인한 사용자만, 비동기, 에러 무시)
            const currentUser = firebaseService.getCurrentUser();
            if (territoryId && currentUser) {
                this.incrementViewCount(territoryId).catch(err => {
                    log.debug(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, err.message);
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
            // ⚡ 캐시 확인: 30초 이내면 캐시된 데이터 사용 (가이드 권장)
            let firestoreData = null;
            const now = Date.now();
            const lastFetched = this._lastFetched.get(territoryId);
            let usedViewModel = false;
            
            // ⚡ 최적화: 로컬 데이터로 먼저 패널 열기, API 호출은 백그라운드로 처리
            // 1. 먼저 로컬 데이터로 displayName 생성 및 패널 열기 준비
            territory.displayName = this.createDisplayName(territory);
            
            // 2. API 호출은 백그라운드로 처리 (패널 열기를 블로킹하지 않음)
            const fetchApiData = async () => {
                // ⚠️ 최적화: 캐시된 territory가 있고 최근에 fetch했으면 Firestore 읽기 완전히 스킵
                if (territory && lastFetched && (now - lastFetched) < this.CACHE_TTL) {
                    log.debug(`[TerritoryManager] ✅ Using fully cached territory ${territoryId} (${Math.floor((now - lastFetched) / 1000)}s ago, skipping all Firestore reads)`);
                    return null; // 캐시된 데이터 사용, Firestore 읽기 완전히 스킵
                }
                
                // ⚠️ 전문가 조언 반영: 소유권 정보는 백엔드 DB/API에서만 로드
                // 새 백엔드 API에서 읽기 (소유권 정보 포함)
                try {
                    log.info(`[TerritoryManager] 📡 Fetching territory from API (background): territories/${territoryId}`);
                    const apiData = await apiService.getTerritory(territoryId);
                    
                    // ⚠️ 전문가 조언 반영: TerritoryAdapter를 사용하여 표준 모델로 변환
                    // ruler_firebase_uid를 확실히 가져오기 위해 adapter 사용
                    if (apiData) {
                        const { territoryAdapter } = await import('../adapters/TerritoryAdapter.js');
                        const standardTerritory = territoryAdapter.toStandardModel(apiData);
                        
                        // ⚠️ 전문가 조언: ruler_firebase_uid가 null이면 조인 실패 또는 저장 실패
                        if (!standardTerritory.ruler && apiData.ruler_id) {
                            log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} has ruler_id but no ruler_firebase_uid (JOIN may have failed)`);
                        }
                        
                        // 표준 모델을 기존 형식으로 변환 (호환성 유지)
                        const convertedData = {
                            ...apiData,
                            ruler: standardTerritory.ruler, // ruler_firebase_uid
                            rulerId: standardTerritory.rulerId,
                            rulerName: standardTerritory.rulerName,
                            sovereignty: standardTerritory.sovereignty,
                            status: standardTerritory.status,
                            price: standardTerritory.basePrice,
                        };
                        
                        // ⚡ 캐시 업데이트: fetch 시간 기록
                        this._lastFetched.set(territoryId, Date.now());
                        return convertedData;
                    }
                    return null;
                } catch (error) {
                    // API 호출 실패 시에도 계속 진행 (기존 territory 데이터 사용)
                    // ⚡ 연결 거부/타임아웃 오류는 조용히 처리 (API 서버가 없을 때 정상)
                    if (error.message && (error.message.includes('timeout') || error.message.includes('offline') || error.message.includes('Connection refused'))) {
                        log.debug(`[TerritoryManager] ⚡ API server offline, using local data for ${territoryId}`);
                    } else {
                        log.error(`[TerritoryManager] ❌ Failed to load territory ${territoryId} from API:`, error);
                    }
                    return null;
                }
            };
            
            // ⚠️ 중요: 소유주 정보가 없으면 API 응답을 기다림 (최대 2초)
            const hasRuler = territory.ruler && territory.ruler.trim() !== '';
            if (!hasRuler) {
                log.info(`[TerritoryManager] Territory ${territoryId} has no ruler, waiting for API response...`);
                try {
                    firestoreData = await Promise.race([
                        fetchApiData(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
                    ]);
                    if (firestoreData) {
                        this.mergeApiData(territory, firestoreData, territoryId);
                        log.info(`[TerritoryManager] ✅ Updated territory ${territoryId} with API data: ruler=${territory.ruler}`);
                    }
                } catch (timeoutError) {
                    log.warn(`[TerritoryManager] ⚠️ API fetch timeout for ${territoryId}, proceeding with local data`);
                    // 타임아웃 시 백그라운드로 계속 시도
                    fetchApiData().then(firestoreData => {
                        if (firestoreData) {
                            this.mergeApiData(territory, firestoreData, territoryId);
                            // 업데이트 후 이벤트 재발행
                            eventBus.emit(EVENTS.TERRITORY_UPDATE, { territoryId, territory });
                        }
                    }).catch(err => {
                        log.debug(`[TerritoryManager] Background API fetch failed for ${territoryId}:`, err.message);
                    });
                }
            } else {
                // 소유주가 있으면 백그라운드에서 업데이트만 수행
                fetchApiData().then(firestoreData => {
                    if (firestoreData) {
                        this.mergeApiData(territory, firestoreData, territoryId);
                    }
                }).catch(err => {
                    log.debug(`[TerritoryManager] Background API fetch failed for ${territoryId}:`, err.message);
                });
            }
            
            // 즉시 로컬 데이터로 진행 (API 응답을 기다리지 않음)
            firestoreData = null;
            
            // API 데이터 병합은 백그라운드에서 처리되므로 여기서는 기본값만 설정
            if (territory.sovereignty === undefined || territory.sovereignty === null) {
                territory.sovereignty = 'unconquered';
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
            log.debug(`[TerritoryManager] Invalid country code: ${country}, properties.adm0_a3: ${properties?.adm0_a3}, properties.country: ${properties?.country}`);
            finalCountry = null; // TerritoryPanel에서 다시 시도하도록
        }
        
            // 국가 코드와 지오메트리 추가
            territory.country = finalCountry;
            territory.geometry = geometry;
            territory.properties = properties; // properties도 저장
            
            // Feature ID와 Source ID도 저장 (맵 업데이트 시 사용)
            territory.featureId = featureId;
            territory.sourceId = sourceId;
            
            // ⚠️ 중요: displayName을 다시 생성 (country와 properties가 업데이트된 후)
            // 이렇게 하면 local-names.json에서 현지어를 제대로 가져올 수 있습니다
            territory.displayName = this.createDisplayName(territory);
            
            this.currentTerritory = territory;
            
            // ⚠️ 전문가 조언: API 읽기 완료 후 territories Map에 저장 (단일 진실 저장)
            this.territories.set(territoryId, territory);
            this.currentTerritory = territory;
            
            // 영토 조회수 증가 (로그인한 사용자만, 비동기, 에러 무시)
            const currentUser = firebaseService.getCurrentUser();
            if (currentUser) {
                this.incrementViewCount(territoryId).catch(err => {
                    log.debug(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, err.message);
                });
            }
            
            // ⚠️ 전문가 조언: territory.id가 반드시 설정되어 있는지 확인
            if (!territory.id) {
                territory.id = territoryId;
                log.warn(`[TerritoryManager] ⚠️ Territory ${territoryId} had no id, setting it now`);
            }
            
            // ⚠️ 전문가 조언: API 읽기 완료 후에만 TERRITORY_SELECTED (출력) 이벤트 발행
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
            
            // ⚠️ 응급 조치: TERRITORY_SELECT 이벤트 제거 (중복 읽기 방지)
            // TERRITORY_SELECTED만 발행
            // eventBus.emit(EVENTS.TERRITORY_SELECT, ...) 제거됨
            
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
        
        // 국가 코드 결정 (우선순위: country > country_code > adm0_a3)
        let countryCode = props.country?.toLowerCase()?.replace(/\s+/g, '-') ||
                         props.country_code?.toLowerCase()?.replace(/\s+/g, '-') ||
                         null;
        
        // adm0_a3가 ISO 코드인 경우 슬러그로 변환
        if (!countryCode && props.adm0_a3) {
            const isoCode = props.adm0_a3.toUpperCase();
            const isoToSlugMap = this.createIsoToSlugMap();
            countryCode = isoToSlugMap[isoCode] || props.adm0_a3.toLowerCase();
        }
        
        // territoryId 정규화 (괄호 제거 등)
        const normalizedTerritoryId = this.normalizeTerritoryId(territoryId);
        
        // 현지어 이름 가져오기 (매핑 테이블에서)
        const localNameFromMapping = countryCode ? this.getLocalName(countryCode, normalizedTerritoryId) : null;
        
        // 영어 이름 결정
        const englishName = props.name_en || props.name || props.NAME_1 || props.NAME_2 || territoryId;
        
        // 현지어 결정 (우선순위: GeoJSON의 name_local > 매핑 테이블 > 영어 이름)
        const localName = props.name_local || localNameFromMapping || englishName;
        
        const territory = {
            id: territoryId,
            name: {
                ko: props.name_ko || englishName,
                en: englishName,
                local: localName
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
            
            // displayName 추가 (표시용 이름: 영어 + 현지어)
            displayName: null, // 나중에 createDisplayName으로 설정
            
            // 픽셀 캔버스
            pixelCanvas: {
                width: CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                height: CONFIG.TERRITORY.PIXEL_GRID_SIZE,
                filledPixels: 0,
                lastUpdated: null
            },
            
            // displayName 추가 (표시용 이름: 영어 + 현지어)
            displayName: null, // 나중에 createDisplayName으로 설정
            
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
        
        // displayName 생성 및 추가
        territory.displayName = this.createDisplayName(territory);
        
        return territory;
    }
    
    /**
     * API 데이터를 territory 객체에 병합
     * @param {object} territory - 기존 territory 객체
     * @param {object} apiData - API에서 가져온 데이터
     * @param {string} territoryId - 영토 ID
     */
    mergeApiData(territory, apiData, territoryId) {
        if (!territory || !apiData) {
            return;
        }
        
        // API 데이터 병합
        if (apiData.ruler || apiData.ruler_firebase_uid || apiData.ruler_id) {
            territory.ruler = apiData.ruler_firebase_uid || apiData.ruler || apiData.ruler_id || apiData.ruler?.firebase_uid || apiData.ruler?.id;
        }
        if (apiData.ruler_name || apiData.rulerName) {
            territory.rulerName = apiData.ruler_name || apiData.rulerName;
        }
        if (apiData.status || apiData.sovereignty) {
            territory.sovereignty = apiData.status || apiData.sovereignty;
        }
        if (apiData.base_price || apiData.price) {
            territory.tribute = apiData.base_price || apiData.price;
        }
        if (apiData.protection_ends_at || apiData.protectionEndsAt) {
            territory.protectionEndsAt = apiData.protection_ends_at || apiData.protectionEndsAt;
        }
        if (apiData.ruler_since || apiData.rulerSince) {
            territory.rulerSince = apiData.ruler_since || apiData.rulerSince;
        }
        
        // ⚠️ 중요: displayName을 다시 생성 (API 데이터 병합 후)
        // country와 id가 업데이트되었을 수 있으므로
        territory.displayName = this.createDisplayName(territory);
        
        // territories Map 업데이트
        this.territories.set(territoryId, territory);
        
        // ⚠️ 이벤트는 id만 전달 (구독자는 스토어에서 읽기)
        eventBus.emit(EVENTS.TERRITORY_UPDATE, { 
            territoryId: territory.id,
            revision: Date.now()
        });
        
        log.debug(`[TerritoryManager] mergeApiData - Merged API data for ${territoryId}, displayName updated`);
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
        
        // ⚠️ Territory ID 정규화 (legacy/new 형식 모두 지원)
        let normalizedTerritoryId = territoryId;
        let territory = this.territories.get(territoryId);
        
        // territory가 있으면 정규화 시도
        if (territory) {
            const { normalizeTerritoryId } = await import('../utils/TerritoryIdUtils.js');
            normalizedTerritoryId = normalizeTerritoryId(territoryId, territory);
            if (normalizedTerritoryId !== territoryId) {
                log.info(`[TerritoryManager] Territory ID normalized: ${territoryId} -> ${normalizedTerritoryId}`);
                // 정규화된 ID로 territory 다시 가져오기
                territory = this.territories.get(normalizedTerritoryId) || territory;
            }
        }
        
        // 중복 호출 방지: 이미 처리 중인 territoryId는 스킵 (정규화된 ID 사용)
        if (this.processingConquest.has(normalizedTerritoryId)) {
            log.warn(`[TerritoryManager] ⚠️ Territory ${normalizedTerritoryId} is already being processed, skipping duplicate call`);
            return;
        }
        
        this.processingConquest.add(normalizedTerritoryId);
        
        try {
            // ⚠️ 전문가 조언 반영: 구매 프로세스 검증을 위한 상세 로그
            log.info(`[TerritoryManager] 🎯🎯🎯 [구매 프로세스 시작] handleTerritoryConquered CALLED`);
            log.info(`[TerritoryManager] 📋 구매 데이터:`, { 
                territoryId: normalizedTerritoryId, 
                originalTerritoryId: territoryId,
                userId, 
                userName, 
                tribute, 
                isAdmin,
                protectionDays,
                timestamp: new Date().toISOString()
            });
            
            // territories Map에서 먼저 확인 (정규화된 ID 사용)
            if (!territory) {
                territory = this.territories.get(normalizedTerritoryId);
            }
        
            // Map에 없으면 API에서 가져오기 또는 기본 영토 생성 (정규화된 ID 사용)
            if (!territory) {
                log.warn(`[TerritoryManager] Territory ${normalizedTerritoryId} not in territories Map, loading from API...`);
                try {
                    // 정규화된 ID로 API 조회 시도
                    let apiData = await apiService.getTerritory(normalizedTerritoryId);
                    
                    // 정규화된 ID로 찾지 못했으면 원본 ID로 시도
                    if (!apiData && normalizedTerritoryId !== territoryId) {
                        try {
                            apiData = await apiService.getTerritory(territoryId);
                        } catch (err) {
                            // 원본 ID로도 찾지 못함
                            log.debug(`[TerritoryManager] Territory ${territoryId} not found via API`);
                        }
                    }
                    
                    if (apiData) {
                        territory = this.normalizeTerritoryData(apiData);
                        // territories Map에 추가 (정규화된 ID 사용)
                        this.territories.set(normalizedTerritoryId, territory);
                        log.info(`[TerritoryManager] Loaded territory ${normalizedTerritoryId} from API`);
                    } else {
                        // API에도 없으면 기본 영토 객체 생성
                        log.warn(`[TerritoryManager] Territory ${normalizedTerritoryId} not in API, creating basic territory object...`);
                        territory = this.createTerritoryObject(normalizedTerritoryId, null, null);
                        this.territories.set(normalizedTerritoryId, territory);
                    }
                } catch (error) {
                    log.error(`[TerritoryManager] Failed to load territory ${normalizedTerritoryId} from API:`, error);
                    // 에러가 발생해도 기본 영토 객체 생성
                    territory = this.createTerritoryObject(normalizedTerritoryId, null, null);
                    this.territories.set(normalizedTerritoryId, territory);
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
            
            // ⚠️ 전문가 조언 반영: API 호출 시 Canonical ID 사용 (원본 territoryId)
            // normalizedTerritoryId는 Display용이므로 API에는 사용하지 않음
            log.info(`[TerritoryManager] 📤 [백엔드 API 호출] Updating territory via API: ${territoryId} (Canonical ID)`);
            log.info(`[TerritoryManager] 📤 업데이트할 데이터:`, {
                territoryId: territoryId, // Canonical ID 사용
                displayId: normalizedTerritoryId, // Display ID (참고용)
                ruler: userId,
                rulerName: userName,
                sovereignty: territory.sovereignty,
                purchasedByAdmin: isAdmin,
                purchasedPrice: tribute,
                protectionEndsAt: protectionEndsAt.toISOString(),
                protectionDays: protectionDays
            });
            
            try {
                // 백엔드 API를 통한 영토 업데이트 (Canonical ID 사용)
                const updatePayload = {
                    rulerFirebaseUid: userId,  // Firebase UID 전달
                    rulerName: userName,
                    sovereignty: territory.sovereignty,
                    protectionEndsAt: protectionEndsAt.toISOString(),
                    purchasedPrice: tribute,
                    purchasedByAdmin: isAdmin || false
                };
                
                // ⚠️ 중요: 원본 territoryId 사용 (Canonical ID)
                const updatedTerritory = await apiService.updateTerritory(territoryId, updatePayload);
                
                log.info(`[TerritoryManager] ✅✅✅ [백엔드 API 성공] Territory ${territoryId} (Canonical) conquered by ${userName}${isAdmin ? ' (Admin)' : ''}. Successfully updated via API.`);
                
                // API에서 반환된 데이터로 territory 객체 업데이트
                if (updatedTerritory) {
                    const normalized = this.normalizeTerritoryData(updatedTerritory);
                    territory.ruler = normalized.ruler || userId;
                    territory.rulerName = normalized.ruler_name || normalized.rulerName || userName;
                    territory.sovereignty = normalized.sovereignty || normalized.status || territory.sovereignty;
                    territory.protectionEndsAt = normalized.protection_ends_at || normalized.protectionEndsAt || protectionEndsAt;
                    territory.updatedAt = new Date();
                    
                    // ⚠️ 중요: territories Map에 업데이트된 territory 저장 (Canonical ID로 저장)
                    this.territories.set(territoryId, territory);
                    // Display ID로도 저장 (하위 호환성)
                    if (normalizedTerritoryId !== territoryId) {
                        this.territories.set(normalizedTerritoryId, territory);
                    }
                    log.info(`[TerritoryManager] ✅ Territory ${territoryId} (Canonical) updated in territories Map: ruler=${territory.ruler}, sovereignty=${territory.sovereignty}`);
                }
            } catch (apiError) {
                // API 오류 시 사용자에게 명확한 에러 메시지
                if (apiError.message && (apiError.message.includes('already owned') || apiError.message.includes('ownership'))) {
                    log.error(`[TerritoryManager] ❌ Territory ${territoryId} (Canonical) purchase failed: already owned`);
                    throw apiError;
                }
                
                log.error(`[TerritoryManager] ❌ 백엔드 API 업데이트 실패:`, apiError);
                throw new Error(`Failed to update territory: ${apiError.message}`);
            }
            
            // WebSocket 이벤트를 통해 UI가 자동으로 업데이트됨
            // 별도의 검증은 불필요 (백엔드에서 트랜잭션으로 처리됨)
            
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
            
            // ⚠️ 이벤트는 id만 전달 (구독자는 스토어에서 읽기)
            eventBus.emit(EVENTS.TERRITORY_UPDATE, { 
                territoryId: territoryId, // Canonical ID
                forceRefresh: true, // 강제 새로고침
                revision: Date.now() // revision 추가
            });
            
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
            // API에서 최신 상태 확인
            const latestTerritoryData = await apiService.getTerritory(territoryId);
            if (!latestTerritoryData) return;
            
            const latestTerritory = this.normalizeTerritoryData(latestTerritoryData);
            
            // 서버에서 이미 수정되었을 수 있으므로 다시 확인
            const protectionEnd = latestTerritory.protectionEndsAt instanceof Date 
                ? latestTerritory.protectionEndsAt 
                : new Date(latestTerritory.protectionEndsAt);
            
            if (new Date() >= protectionEnd && latestTerritory.sovereignty === SOVEREIGNTY.PROTECTED) {
                // 보호 기간이 지났고 여전히 PROTECTED 상태인 경우 RULED로 변경
                log.info(`[TerritoryManager] 🔧 Auto-fixing expired protection for ${territoryId}`);
                
                // ✅ 백엔드 API 사용
                try {
                    await apiService.updateTerritory(territoryId, {
                        sovereignty: 'ruled',
                        status: 'ruled'
                    });
                    log.info(`[TerritoryManager] ✅ Updated territory status to ruled via API`);
                } catch (error) {
                    log.warn(`[TerritoryManager] Failed to update territory status via API:`, error);
                }
                
                // 로컬 캐시도 업데이트
                territory.sovereignty = SOVEREIGNTY.RULED;
                this.territories.set(territoryId, territory);
                
                // ⚠️ 이벤트는 id만 전달 (구독자는 스토어에서 읽기)
                eventBus.emit(EVENTS.TERRITORY_UPDATE, { 
                    territoryId: territory.id,
                    revision: Date.now()
                });
                
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
            // API를 통해 조회수 증가 (백엔드에서 atomic increment 처리)
            try {
                await apiService.post(`/territories/${territoryId}/view`, {});
                
                // 로컬 캐시 업데이트
                const localTerritory = this.territories.get(territoryId);
                if (localTerritory) {
                    localTerritory.viewCount = (localTerritory.viewCount || 0) + 1;
                    localTerritory.lastViewedAt = new Date();
                }
            } catch (error) {
                log.warn(`[TerritoryManager] Failed to increment view count for ${territoryId}:`, error);
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
     * 영토 실시간 구독 (WebSocket 사용)
     */
    subscribeToTerritory(territoryId, callback) {
        // Firestore onSnapshot 대신 EventBus의 TERRITORY_UPDATE 이벤트 구독
        // WebSocket이 이 이벤트를 발행함
        const eventHandler = (eventData) => {
            const territory = eventData.territory;
            if (territory && (territory.id === territoryId || territory.territoryId === territoryId)) {
                this.territories.set(territoryId, territory);
                callback(territory);
            }
        };
        
        eventBus.on(EVENTS.TERRITORY_UPDATE, eventHandler);
        
        // 구독 해제 함수 반환
        const unsubscribe = () => {
            eventBus.off(EVENTS.TERRITORY_UPDATE, eventHandler);
        };
        
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
     * [NEW] Territory에 hasPixelArt 플래그 설정
     * ⚠️ 전문가 피드백: 초기에는 hasPixelArt를 false로 두지 말고, meta 로딩 결과로 채우기
     */
    setHasPixelArt(territoryId, hasPixelArt, pixelCount = null, pixelUpdatedAt = null, fillRatio = null) {
        const territory = this.getTerritory(territoryId);
        if (territory) {
            territory.hasPixelArt = hasPixelArt;
            if (pixelCount !== null) {
                territory.pixelCount = pixelCount;
            }
            if (pixelUpdatedAt !== null) {
                territory.pixelUpdatedAt = pixelUpdatedAt;
            }
            if (fillRatio !== null) {
                territory.fillRatio = fillRatio;
            }
        }
    }
    
    /**
     * [NEW] Territory의 hasPixelArt 플래그 가져오기
     */
    hasPixelArt(territoryId) {
        const territory = this.getTerritory(territoryId);
        return territory?.hasPixelArt === true;
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

