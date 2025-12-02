/**
 * TerritoryDataService - 영토 실데이터 관리
 * 인구, 면적, GDP, 가격 산정
 * 면적 기반 픽셀 수 및 광고 가격 계산
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

// 지역 계수 (전략적 중요도)
const REGION_MULTIPLIER = {
    'capital': 2.0,      // 수도
    'major_city': 1.5,   // 대도시
    'coastal': 1.3,      // 해안 지역
    'border': 1.2,       // 국경 지역
    'inland': 1.0,       // 내륙
    'remote': 0.8        // 오지
};

// 국가별 경제 계수
const COUNTRY_ECONOMIC_FACTOR = {
    'USA': 1.5, 'JPN': 1.4, 'DEU': 1.3, 'GBR': 1.3, 'FRA': 1.2,
    'KOR': 1.2, 'CHN': 1.1, 'IND': 0.9, 'BRA': 0.9, 'RUS': 1.0,
    'AUS': 1.2, 'CAN': 1.3, 'SGP': 1.6, 'ARE': 1.5, 'CHE': 1.6,
    'NOR': 1.4, 'SWE': 1.3, 'NLD': 1.3, 'default': 1.0
};

// 픽셀 계산 상수
const PIXEL_CONFIG = {
    MIN_PIXELS: 100,        // 최소 픽셀 수
    MAX_PIXELS: 10000,      // 최대 픽셀 수
    AREA_DIVISOR: 1000,     // 면적을 픽셀로 변환할 때 나눌 값 (km² / DIVISOR)
    PRICE_PER_PIXEL: 0.1    // 픽셀당 기본 가격 ($)
};

// Wikidata 행정구역 타입 매핑 (국가 코드 → Wikidata 클래스 ID)
// 전 세계 100+ 국가 지원
const WIKIDATA_ADMIN_TYPES = {
    // === 북미 (North America) ===
    'USA': 'Q35657',      // state of the United States
    'CAN': 'Q11828004',   // province or territory of Canada
    'MEX': 'Q171079',     // state of Mexico
    
    // === 남미 (South America) ===
    'BRA': 'Q856076',     // state of Brazil
    'ARG': 'Q44753',      // province of Argentina
    'CHL': 'Q1615742',    // region of Chile
    'COL': 'Q200547',     // department of Colombia
    'PER': 'Q867741',     // region of Peru
    'VEN': 'Q856076',     // state of Venezuela
    'ECU': 'Q842112',     // province of Ecuador
    'BOL': 'Q200547',     // department of Bolivia
    'PRY': 'Q200547',     // department of Paraguay
    'URY': 'Q200547',     // department of Uruguay
    
    // === 유럽 (Europe) ===
    'GBR': 'Q211690',     // country of the United Kingdom
    'DEU': 'Q1221156',    // state of Germany
    'FRA': 'Q36784',      // region of France
    'ITA': 'Q16110',      // region of Italy
    'ESP': 'Q10742',      // autonomous community of Spain
    'PRT': 'Q1615742',    // district of Portugal (using province)
    'NLD': 'Q134390',     // province of the Netherlands
    'BEL': 'Q878521',     // province of Belgium
    'CHE': 'Q23058',      // canton of Switzerland
    'AUT': 'Q261543',     // state of Austria
    'POL': 'Q150093',     // voivodeship of Poland
    'CZE': 'Q108163',     // region of the Czech Republic
    'SWE': 'Q193556',     // county of Sweden
    'NOR': 'Q1615742',    // county of Norway
    'DNK': 'Q1615742',    // region of Denmark
    'FIN': 'Q1615742',    // region of Finland
    'IRL': 'Q1615742',    // province of Ireland
    'GRC': 'Q207299',     // region of Greece
    'HUN': 'Q1615742',    // county of Hungary
    'ROU': 'Q1615742',    // county of Romania
    'BGR': 'Q209824',     // province of Bulgaria
    'HRV': 'Q1615742',    // county of Croatia
    'SVK': 'Q1615742',    // region of Slovakia
    'SVN': 'Q1615742',    // statistical region of Slovenia
    'SRB': 'Q1615742',    // district of Serbia
    'UKR': 'Q3348196',    // oblast of Ukraine
    'BLR': 'Q3348196',    // oblast of Belarus
    
    // === 아시아 (Asia) ===
    'RUS': 'Q835714',     // federal subject of Russia
    'CHN': 'Q1615742',    // province of China
    'JPN': 'Q50337',      // prefecture of Japan
    'KOR': 'Q2311958',    // province of South Korea (도/특별시)
    'PRK': 'Q1615742',    // province of North Korea
    'TWN': 'Q1615742',    // county of Taiwan
    'IND': 'Q131541',     // state of India
    'IDN': 'Q1615742',    // province of Indonesia
    'THA': 'Q1615742',    // province of Thailand
    'VNM': 'Q1615742',    // province of Vietnam
    'PHL': 'Q1615742',    // province of Philippines
    'MYS': 'Q1615742',    // state of Malaysia
    'SGP': 'Q1615742',    // planning area of Singapore
    'PAK': 'Q1615742',    // province of Pakistan
    'BGD': 'Q1615742',    // division of Bangladesh
    'MMR': 'Q1615742',    // state of Myanmar
    'NPL': 'Q1615742',    // province of Nepal
    'LKA': 'Q1615742',    // province of Sri Lanka
    'KHM': 'Q1615742',    // province of Cambodia
    'LAO': 'Q1615742',    // province of Laos
    'MNG': 'Q1615742',    // province of Mongolia
    'KAZ': 'Q1615742',    // region of Kazakhstan
    'UZB': 'Q1615742',    // region of Uzbekistan
    'TKM': 'Q1615742',    // region of Turkmenistan
    'KGZ': 'Q1615742',    // region of Kyrgyzstan
    'TJK': 'Q1615742',    // region of Tajikistan
    
    // === 중동 (Middle East) ===
    'TUR': 'Q48336',      // province of Turkey
    'IRN': 'Q1615742',    // province of Iran
    'IRQ': 'Q1615742',    // governorate of Iraq
    'SAU': 'Q1615742',    // province of Saudi Arabia
    'ARE': 'Q1615742',    // emirate of UAE
    'ISR': 'Q1615742',    // district of Israel
    'JOR': 'Q1615742',    // governorate of Jordan
    'LBN': 'Q1615742',    // governorate of Lebanon
    'SYR': 'Q1615742',    // governorate of Syria
    'YEM': 'Q1615742',    // governorate of Yemen
    'OMN': 'Q1615742',    // governorate of Oman
    'KWT': 'Q1615742',    // governorate of Kuwait
    'QAT': 'Q1615742',    // municipality of Qatar
    'BHR': 'Q1615742',    // governorate of Bahrain
    
    // === 아프리카 (Africa) ===
    'EGY': 'Q204910',     // governorate of Egypt
    'ZAF': 'Q134626',     // province of South Africa
    'NGA': 'Q1615742',    // state of Nigeria
    'KEN': 'Q1615742',    // county of Kenya
    'ETH': 'Q1615742',    // region of Ethiopia
    'TZA': 'Q1615742',    // region of Tanzania
    'MAR': 'Q1615742',    // region of Morocco
    'DZA': 'Q1615742',    // province of Algeria
    'TUN': 'Q1615742',    // governorate of Tunisia
    'GHA': 'Q1615742',    // region of Ghana
    'CIV': 'Q1615742',    // region of Ivory Coast
    'CMR': 'Q1615742',    // region of Cameroon
    'UGA': 'Q1615742',    // district of Uganda
    'AGO': 'Q1615742',    // province of Angola
    'MOZ': 'Q1615742',    // province of Mozambique
    'ZWE': 'Q1615742',    // province of Zimbabwe
    'ZMB': 'Q1615742',    // province of Zambia
    'SEN': 'Q1615742',    // region of Senegal
    'MLI': 'Q1615742',    // region of Mali
    'NER': 'Q1615742',    // region of Niger
    'TCD': 'Q1615742',    // region of Chad
    'SDN': 'Q1615742',    // state of Sudan
    'SSD': 'Q1615742',    // state of South Sudan
    'COD': 'Q1615742',    // province of DR Congo
    'COG': 'Q1615742',    // department of Congo
    
    // === 오세아니아 (Oceania) ===
    'AUS': 'Q5852411',    // state or territory of Australia
    'NZL': 'Q1615742',    // region of New Zealand
    'PNG': 'Q1615742',    // province of Papua New Guinea
    'FJI': 'Q1615742',    // division of Fiji
    
    // === 추가 아시아 국가 ===
    'HKG': 'Q1615742',    // district of Hong Kong
    'BRN': 'Q1615742',    // district of Brunei
    'BTN': 'Q1615742',    // district of Bhutan
    'MDV': 'Q1615742',    // atoll of Maldives
    'TLS': 'Q1615742',    // district of Timor-Leste
    'AFG': 'Q1615742',    // province of Afghanistan
    'PSE': 'Q1615742',    // governorate of Palestine
    
    // === 추가 유럽 국가 ===
    'LTU': 'Q1615742',    // county of Lithuania
    'LVA': 'Q1615742',    // municipality of Latvia
    'EST': 'Q1615742',    // county of Estonia
    'CYP': 'Q1615742',    // district of Cyprus
    'LUX': 'Q1615742',    // canton of Luxembourg
    'MLT': 'Q1615742',    // local council of Malta
    'ALB': 'Q1615742',    // county of Albania
    'MKD': 'Q1615742',    // statistical region of North Macedonia
    'MNE': 'Q1615742',    // municipality of Montenegro
    'BIH': 'Q1615742',    // entity of Bosnia
    'MDA': 'Q1615742',    // district of Moldova
    'ISL': 'Q1615742',    // region of Iceland
    'GEO': 'Q1615742',    // region of Georgia
    'ARM': 'Q1615742',    // province of Armenia
    'AZE': 'Q1615742',    // district of Azerbaijan
    
    // === 추가 북미/카리브해 국가 ===
    'CUB': 'Q1615742',    // province of Cuba
    'JAM': 'Q1615742',    // parish of Jamaica
    'HTI': 'Q1615742',    // department of Haiti
    'DOM': 'Q1615742',    // province of Dominican Republic
    'GTM': 'Q1615742',    // department of Guatemala
    'HND': 'Q1615742',    // department of Honduras
    'SLV': 'Q1615742',    // department of El Salvador
    'NIC': 'Q1615742',    // department of Nicaragua
    'CRI': 'Q1615742',    // province of Costa Rica
    'PAN': 'Q1615742',    // province of Panama
    'BLZ': 'Q1615742',    // district of Belize
    'PRI': 'Q1615742',    // municipality of Puerto Rico
    
    // === 추가 남미 국가 ===
    'GUY': 'Q1615742',    // region of Guyana
    'SUR': 'Q1615742',    // district of Suriname
    
    // === 추가 아프리카 국가 ===
    'LBY': 'Q1615742',    // district of Libya
    'RWA': 'Q1615742',    // province of Rwanda
    'BWA': 'Q1615742',    // district of Botswana
    'NAM': 'Q1615742',    // region of Namibia
    'MDG': 'Q1615742',    // region of Madagascar
    'MUS': 'Q1615742',    // district of Mauritius
};

// 캐시된 행정구역 데이터
const ADMIN_DATA_CACHE = new Map();

// 국가 슬러그 → ISO 3자리 코드 매핑
const COUNTRY_SLUG_TO_ISO = {
    // 아시아
    'south-korea': 'KOR', 'japan': 'JPN', 'china': 'CHN', 'taiwan': 'TWN',
    'hong-kong': 'HKG', 'india': 'IND', 'indonesia': 'IDN', 'thailand': 'THA',
    'vietnam': 'VNM', 'malaysia': 'MYS', 'singapore': 'SGP', 'philippines': 'PHL',
    'pakistan': 'PAK', 'bangladesh': 'BGD', 'myanmar': 'MMR', 'cambodia': 'KHM',
    'laos': 'LAO', 'mongolia': 'MNG', 'nepal': 'NPL', 'sri-lanka': 'LKA',
    'kazakhstan': 'KAZ', 'uzbekistan': 'UZB', 'north-korea': 'PRK',
    'brunei': 'BRN', 'bhutan': 'BTN', 'maldives': 'MDV', 'timor-leste': 'TLS',
    
    // 중동
    'saudi-arabia': 'SAU', 'uae': 'ARE', 'qatar': 'QAT', 'iran': 'IRN',
    'iraq': 'IRQ', 'israel': 'ISR', 'jordan': 'JOR', 'lebanon': 'LBN',
    'oman': 'OMN', 'kuwait': 'KWT', 'bahrain': 'BHR', 'syria': 'SYR',
    'yemen': 'YEM', 'palestine': 'PSE', 'turkey': 'TUR', 'afghanistan': 'AFG',
    
    // 유럽
    'germany': 'DEU', 'france': 'FRA', 'uk': 'GBR', 'italy': 'ITA',
    'spain': 'ESP', 'netherlands': 'NLD', 'poland': 'POL', 'belgium': 'BEL',
    'sweden': 'SWE', 'austria': 'AUT', 'switzerland': 'CHE', 'norway': 'NOR',
    'portugal': 'PRT', 'greece': 'GRC', 'czech-republic': 'CZE', 'romania': 'ROU',
    'hungary': 'HUN', 'denmark': 'DNK', 'finland': 'FIN', 'ireland': 'IRL',
    'bulgaria': 'BGR', 'slovakia': 'SVK', 'croatia': 'HRV', 'lithuania': 'LTU',
    'slovenia': 'SVN', 'latvia': 'LVA', 'estonia': 'EST', 'cyprus': 'CYP',
    'luxembourg': 'LUX', 'malta': 'MLT', 'russia': 'RUS', 'ukraine': 'UKR',
    'belarus': 'BLR', 'serbia': 'SRB', 'albania': 'ALB', 'north-macedonia': 'MKD',
    'montenegro': 'MNE', 'bosnia': 'BIH', 'moldova': 'MDA', 'iceland': 'ISL',
    'georgia': 'GEO', 'armenia': 'ARM', 'azerbaijan': 'AZE',
    
    // 북미
    'usa': 'USA', 'canada': 'CAN', 'mexico': 'MEX', 'cuba': 'CUB',
    'jamaica': 'JAM', 'haiti': 'HTI', 'dominican-republic': 'DOM',
    'guatemala': 'GTM', 'honduras': 'HND', 'el-salvador': 'SLV',
    'nicaragua': 'NIC', 'costa-rica': 'CRI', 'panama': 'PAN',
    'belize': 'BLZ', 'puerto-rico': 'PRI',
    
    // 남미
    'brazil': 'BRA', 'argentina': 'ARG', 'chile': 'CHL', 'colombia': 'COL',
    'peru': 'PER', 'venezuela': 'VEN', 'ecuador': 'ECU', 'bolivia': 'BOL',
    'paraguay': 'PRY', 'uruguay': 'URY', 'guyana': 'GUY', 'suriname': 'SUR',
    
    // 아프리카
    'south-africa': 'ZAF', 'egypt': 'EGY', 'nigeria': 'NGA', 'kenya': 'KEN',
    'ethiopia': 'ETH', 'ghana': 'GHA', 'morocco': 'MAR', 'algeria': 'DZA',
    'tunisia': 'TUN', 'libya': 'LBY', 'sudan': 'SDN', 'tanzania': 'TZA',
    'uganda': 'UGA', 'rwanda': 'RWA', 'senegal': 'SEN', 'ivory-coast': 'CIV',
    'cameroon': 'CMR', 'angola': 'AGO', 'mozambique': 'MOZ', 'zimbabwe': 'ZWE',
    'zambia': 'ZMB', 'botswana': 'BWA', 'namibia': 'NAM', 'madagascar': 'MDG',
    'mauritius': 'MUS', 'congo-drc': 'COD',
    
    // 오세아니아
    'australia': 'AUS', 'new-zealand': 'NZL', 'fiji': 'FJI', 'papua-new-guinea': 'PNG'
};

class TerritoryDataService {
    constructor() {
        this.territoryData = new Map();
        this.countryStats = new Map();
        this.adminDataCache = new Map(); // 행정구역 실데이터 캐시
        this.initialized = false;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            log.info('TerritoryDataService initializing...');
            
            // REST Countries API에서 국가 데이터 로드
            await this.loadCountryData();
            
            this.initialized = true;
            log.info('TerritoryDataService initialized');
            
        } catch (error) {
            log.error('TerritoryDataService init failed:', error);
        }
    }
    
    /**
     * 국가 데이터 로드 (REST Countries API)
     */
    async loadCountryData() {
        try {
            const response = await fetch('https://restcountries.com/v3.1/all?fields=name,cca3,population,area,capital,region,subregion,flags,currencies,languages');
            
            if (!response.ok) {
                throw new Error('Failed to fetch country data');
            }
            
            const countries = await response.json();
            
            for (const country of countries) {
                const code = country.cca3;
                this.countryStats.set(code, {
                    name: country.name.common,
                    officialName: country.name.official,
                    population: country.population || 0,
                    area: country.area || 0,  // km²
                    capital: country.capital?.[0] || 'N/A',
                    region: country.region || 'Unknown',
                    subregion: country.subregion || 'Unknown',
                    flag: country.flags?.emoji || '🏳️',
                    currencies: country.currencies || {},
                    languages: country.languages || {},
                    // 계산된 값
                    density: country.area > 0 ? Math.round(country.population / country.area) : 0,
                    basePrice: this.calculateBasePrice(country.population, country.area, code)
                });
            }
            
            log.info(`Loaded data for ${this.countryStats.size} countries`);
            
        } catch (error) {
            log.error('Failed to load country data:', error);
            // 폴백: 기본 데이터 사용
            this.loadFallbackData();
        }
    }
    
    /**
     * 국가 슬러그를 ISO 코드로 변환
     */
    convertToISOCode(countrySlug) {
        if (!countrySlug) return null;
        
        // 이미 ISO 코드인 경우 (대문자 3자리)
        const upperCode = countrySlug.toUpperCase();
        if (upperCode.length === 3 && WIKIDATA_ADMIN_TYPES[upperCode]) {
            return upperCode;
        }
        
        // 슬러그에서 ISO 코드로 변환
        const slug = countrySlug.toLowerCase();
        return COUNTRY_SLUG_TO_ISO[slug] || upperCode;
    }
    
    /**
     * Wikidata에서 행정구역 실데이터 로드
     * @param {string} countryCode - 국가 코드 또는 슬러그 (예: 'USA', 'usa', 'south-korea')
     */
    async loadAdminDataFromWikidata(countryCode) {
        // 국가 코드 정규화 (슬러그 → ISO 코드)
        const isoCode = this.convertToISOCode(countryCode);
        
        const adminType = WIKIDATA_ADMIN_TYPES[isoCode];
        if (!adminType) {
            log.warn(`No Wikidata mapping for country: ${countryCode} (ISO: ${isoCode})`);
            return null;
        }
        
        // 캐시 확인 (ISO 코드로)
        if (this.adminDataCache.has(isoCode)) {
            return this.adminDataCache.get(isoCode);
        }
        
        try {
            const sparqlQuery = `
                SELECT ?item ?itemLabel ?area ?population WHERE {
                    ?item wdt:P31 wd:${adminType}.
                    OPTIONAL { ?item wdt:P2046 ?area. }
                    OPTIONAL { ?item wdt:P1082 ?population. }
                    SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ko". }
                }
            `;
            
            const url = 'https://query.wikidata.org/sparql?' + 
                new URLSearchParams({ query: sparqlQuery, format: 'json' });
            
            const response = await fetch(url, {
                headers: { 'Accept': 'application/sparql-results+json' }
            });
            
            if (!response.ok) {
                throw new Error(`Wikidata API error: ${response.status}`);
            }
            
            const data = await response.json();
            const adminData = new Map();
            
            for (const result of data.results.bindings) {
                const name = result.itemLabel?.value || '';
                const area = result.area?.value ? parseFloat(result.area.value) : null;
                const population = result.population?.value ? parseInt(result.population.value) : null;
                
                if (name) {
                    // 이름 정규화 (대소문자 무시, 공백 처리)
                    const normalizedName = name.toLowerCase().trim();
                    adminData.set(normalizedName, {
                        name: name,
                        area: area,  // km²
                        population: population,
                        wikidataId: result.item?.value?.split('/').pop()
                    });
                    
                    // 영어 이름과 한국어 이름 모두 매핑
                    // 예: "Texas" → { area: 695662, population: 29145505 }
                }
            }
            
            // 캐시에 저장 (ISO 코드로)
            this.adminDataCache.set(isoCode, adminData);
            log.info(`Loaded ${adminData.size} admin regions from Wikidata for ${isoCode}`);
            
            return adminData;
            
        } catch (error) {
            log.error(`Failed to load Wikidata for ${countryCode}:`, error);
            return null;
        }
    }
    
    /**
     * 영토 이름으로 Wikidata 실데이터 조회
     */
    async getWikidataForTerritory(territoryName, countryCode) {
        const adminData = await this.loadAdminDataFromWikidata(countryCode);
        if (!adminData) return null;
        
        // 이름 정규화
        const normalizedName = territoryName.toLowerCase().trim();
        
        // 직접 매칭
        if (adminData.has(normalizedName)) {
            return adminData.get(normalizedName);
        }
        
        // 부분 매칭 (예: "Texas" ↔ "State of Texas")
        for (const [key, value] of adminData) {
            if (key.includes(normalizedName) || normalizedName.includes(key)) {
                return value;
            }
        }
        
        return null;
    }
    
    /**
     * 폴백 데이터 (API 실패 시)
     */
    loadFallbackData() {
        const fallbackData = {
            'USA': { name: 'United States', population: 331000000, area: 9833520 },
            'KOR': { name: 'South Korea', population: 51780000, area: 100210 },
            'JPN': { name: 'Japan', population: 125800000, area: 377975 },
            'CHN': { name: 'China', population: 1412000000, area: 9596960 },
            'DEU': { name: 'Germany', population: 83200000, area: 357114 },
            'GBR': { name: 'United Kingdom', population: 67220000, area: 242495 },
            'FRA': { name: 'France', population: 67390000, area: 643801 },
            'IND': { name: 'India', population: 1380000000, area: 3287263 },
            'BRA': { name: 'Brazil', population: 212600000, area: 8515767 },
            'RUS': { name: 'Russia', population: 144100000, area: 17098242 },
            'AUS': { name: 'Australia', population: 25690000, area: 7692024 },
            'CAN': { name: 'Canada', population: 38010000, area: 9984670 },
            'MEX': { name: 'Mexico', population: 128900000, area: 1964375 },
            'SGP': { name: 'Singapore', population: 5686000, area: 728 },
            'ARE': { name: 'UAE', population: 9890000, area: 83600 }
        };
        
        for (const [code, data] of Object.entries(fallbackData)) {
            this.countryStats.set(code, {
                ...data,
                density: Math.round(data.population / data.area),
                basePrice: this.calculateBasePrice(data.population, data.area, code)
            });
        }
        
        log.info('Loaded fallback data for', Object.keys(fallbackData).length, 'countries');
    }
    
    /**
     * 기본 가격 계산
     * 공식: (인구 ÷ 10000) × (면적_km² ÷ 1000) × 경제계수 × 0.01
     * 결과를 적정 범위로 조정
     */
    calculateBasePrice(population, area, countryCode) {
        if (!population || !area) return 100; // 기본값
        
        const popFactor = population / 10000;
        const areaFactor = Math.sqrt(area); // 면적은 제곱근으로 (너무 커지지 않게)
        const econFactor = COUNTRY_ECONOMIC_FACTOR[countryCode] || COUNTRY_ECONOMIC_FACTOR.default;
        
        // 기본 가격 계산
        let price = (popFactor * areaFactor * econFactor) / 1000;
        
        // 범위 제한 ($10 ~ $100,000)
        price = Math.max(10, Math.min(100000, price));
        
        // 깔끔한 숫자로 반올림
        if (price < 100) {
            price = Math.round(price / 5) * 5;
        } else if (price < 1000) {
            price = Math.round(price / 10) * 10;
        } else if (price < 10000) {
            price = Math.round(price / 100) * 100;
        } else {
            price = Math.round(price / 1000) * 1000;
        }
        
        return price;
    }
    
    /**
     * 행정구역 가격 계산 - 픽셀 수 기반
     */
    calculateTerritoryPrice(territory, countryCode) {
        // 픽셀 수 기반 가격 계산
        const pixelCount = this.calculatePixelCount(territory, countryCode);
        const econFactor = this.getEconomicFactor(countryCode);
        
        // 기본 가격 = 픽셀 수 × 픽셀당 가격 × 경제계수
        let price = pixelCount * PIXEL_CONFIG.PRICE_PER_PIXEL * econFactor;
        
        // 지역 타입에 따른 보너스
        const regionMult = this.getRegionMultiplier(territory);
        price = price * regionMult;
        
        // 깔끔한 숫자로 반올림 ($5 ~ $50,000 범위)
        price = Math.max(5, Math.min(50000, price));
        
        if (price < 50) {
            price = Math.round(price / 5) * 5;
        } else if (price < 500) {
            price = Math.round(price / 10) * 10;
        } else if (price < 5000) {
            price = Math.round(price / 50) * 50;
        } else {
            price = Math.round(price / 100) * 100;
        }
        
        return Math.round(price);
    }
    
    /**
     * 면적 기반 픽셀 수 계산
     */
    calculatePixelCount(territory, countryCode) {
        // 면적 데이터 추출 (Natural Earth 데이터에서)
        const area = this.extractArea(territory, countryCode);
        
        if (!area || area <= 0) {
            return PIXEL_CONFIG.MIN_PIXELS;
        }
        
        // 면적 → 픽셀 변환
        // 작은 지역도 최소 픽셀 보장, 큰 지역은 최대 픽셀로 제한
        let pixels = Math.sqrt(area) * 10; // 제곱근 사용하여 스케일 조정
        
        pixels = Math.max(PIXEL_CONFIG.MIN_PIXELS, Math.min(PIXEL_CONFIG.MAX_PIXELS, pixels));
        
        return Math.round(pixels);
    }
    
    /**
     * 영토에서 면적 추출 (km² 단위)
     * 우선순위: Wikidata 캐시 > GeoJSON 속성 > 지오메트리 계산 > 추정치
     */
    extractArea(territory, countryCode) {
        const props = territory.properties || territory;
        let area = null;
        
        // 국가 코드 정규화 (슬러그 → ISO 코드)
        const isoCode = this.convertToISOCode(countryCode);
        
        // 0. Wikidata 캐시에서 실제 데이터 조회 (가장 정확)
        const territoryName = this.extractTerritoryName(props);
        if (territoryName && this.adminDataCache.has(isoCode)) {
            const adminData = this.adminDataCache.get(isoCode);
            const normalizedName = territoryName.toLowerCase().trim();
            
            // 직접 매칭
            if (adminData.has(normalizedName)) {
                const wikidataInfo = adminData.get(normalizedName);
                if (wikidataInfo.area && wikidataInfo.area > 0) {
                    return Math.round(wikidataInfo.area);
                }
            }
            
            // 부분 매칭
            for (const [key, value] of adminData) {
                if ((key.includes(normalizedName) || normalizedName.includes(key)) && value.area > 0) {
                    return Math.round(value.area);
                }
            }
        }
        
        // 1. Natural Earth Admin 1 데이터 속성 시도
        const areaFields = [
            'area_sqkm', 'AREA', 'area', 'Shape_Area', 'arealand',
            'areakm2', 'area_km2', 'AREA_KM2', 'region_area'
        ];
        
        for (const field of areaFields) {
            if (props[field] && typeof props[field] === 'number' && props[field] > 0) {
                area = props[field];
                break;
            }
        }
        
        // 2. Shape_Area가 있으면 제곱미터에서 km²로 변환 (일부 GeoJSON)
        if (!area && props.Shape_Area) {
            const shapeArea = parseFloat(props.Shape_Area);
            if (shapeArea > 0) {
                area = shapeArea > 1000 ? shapeArea / 1000000 : shapeArea * 12365;
            }
        }
        
        // 3. 지오메트리에서 면적 계산 시도 (구면 기하학)
        if (!area && territory.geometry) {
            area = this.calculateGeometryArea(territory.geometry);
        }
        
        // 4. 고유 ID 기반 해시로 변형 (각 지역마다 다른 값을 갖도록)
        if (!area) {
            const id = props.id || props.name || props.fid || Math.random();
            const hash = this.hashString(String(id));
            
            const countryData = this.getCountryStats(countryCode);
            const baseArea = countryData?.area ? countryData.area / 50 : 10000;
            const variation = 0.5 + (hash % 100) / 100;
            area = baseArea * variation;
        }
        
        return Math.round(area);
    }
    
    /**
     * 영토 이름 추출 헬퍼
     */
    extractTerritoryName(props) {
        const nameFields = ['name', 'NAME', 'name_en', 'NAME_EN', 'admin', 'ADMIN'];
        for (const field of nameFields) {
            if (props[field]) {
                if (typeof props[field] === 'object') {
                    return props[field].en || props[field].ko || Object.values(props[field])[0];
                }
                return props[field];
            }
        }
        return null;
    }
    
    /**
     * 영토에서 인구 추출
     * 우선순위: Wikidata 캐시 > GeoJSON 속성 > 추정치
     */
    extractPopulation(territory, countryCode) {
        const props = territory.properties || territory;
        
        // 국가 코드 정규화 (슬러그 → ISO 코드)
        const isoCode = this.convertToISOCode(countryCode);
        
        // 0. Wikidata 캐시에서 실제 데이터 조회 (가장 정확)
        const territoryName = this.extractTerritoryName(props);
        if (territoryName && this.adminDataCache.has(isoCode)) {
            const adminData = this.adminDataCache.get(isoCode);
            const normalizedName = territoryName.toLowerCase().trim();
            
            // 직접 매칭
            if (adminData.has(normalizedName)) {
                const wikidataInfo = adminData.get(normalizedName);
                if (wikidataInfo.population && wikidataInfo.population > 0) {
                    return Math.round(wikidataInfo.population);
                }
            }
            
            // 부분 매칭
            for (const [key, value] of adminData) {
                if ((key.includes(normalizedName) || normalizedName.includes(key)) && value.population > 0) {
                    return Math.round(value.population);
                }
            }
        }
        
        // 1. Natural Earth Admin 1 데이터의 인구 관련 필드들
        const popFields = [
            'pop_est', 'population', 'POP_EST', 'POPULATION', 'pop',
            'pop2020', 'pop2019', 'pop2015', 'census_pop', 'region_pop'
        ];
        
        for (const field of popFields) {
            const val = props[field];
            if (val && typeof val === 'number' && val > 0) {
                return Math.round(val);
            }
        }
        
        // 2. 문자열로 저장된 인구 처리
        for (const field of popFields) {
            const val = props[field];
            if (val && typeof val === 'string') {
                const parsed = parseInt(val.replace(/,/g, ''), 10);
                if (!isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }
        }
        
        // 3. 고유 ID 기반 해시로 변형 (각 지역마다 다른 값을 갖도록)
        const id = props.id || props.name || props.fid || Math.random();
        const hash = this.hashString(String(id));
        
        const countryData = this.getCountryStats(countryCode);
        const basePop = countryData?.population ? countryData.population / 50 : 1000000;
        const variation = 0.3 + (hash % 140) / 100;
        
        return Math.round(basePop * variation);
    }
    
    /**
     * 문자열 해시 생성 (일관된 랜덤값을 위해)
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 32비트 정수로 변환
        }
        return Math.abs(hash);
    }
    
    /**
     * 지오메트리에서 대략적인 면적 계산 (km²)
     */
    /**
     * 지오메트리에서 면적 계산 (km² 단위)
     * 구면 기하학을 사용한 정확한 다각형 면적 계산
     */
    calculateGeometryArea(geometry) {
        try {
            if (!geometry || !geometry.coordinates) return null;
            
            const EARTH_RADIUS = 6371; // km
            
            // 라디안 변환
            const toRad = deg => deg * Math.PI / 180;
            
            // 구면 다각형 면적 계산 (Shoelace formula의 구면 버전)
            const ringArea = (coords) => {
                if (!coords || coords.length < 4) return 0;
                
                let total = 0;
                const len = coords.length;
                
                for (let i = 0; i < len - 1; i++) {
                    const p1 = coords[i];
                    const p2 = coords[(i + 1) % len];
                    
                    const lng1 = toRad(p1[0]);
                    const lat1 = toRad(p1[1]);
                    const lng2 = toRad(p2[0]);
                    const lat2 = toRad(p2[1]);
                    
                    total += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
                }
                
                return Math.abs(total * EARTH_RADIUS * EARTH_RADIUS / 2);
            };
            
            // 폴리곤 면적 계산 (외부 링 - 내부 링들)
            const polygonArea = (rings) => {
                if (!rings || rings.length === 0) return 0;
                
                // 외부 링
                let area = ringArea(rings[0]);
                
                // 내부 링(holes)은 빼기
                for (let i = 1; i < rings.length; i++) {
                    area -= ringArea(rings[i]);
                }
                
                return Math.abs(area);
            };
            
            let totalArea = 0;
            
            if (geometry.type === 'Polygon') {
                totalArea = polygonArea(geometry.coordinates);
            } else if (geometry.type === 'MultiPolygon') {
                for (const polygon of geometry.coordinates) {
                    totalArea += polygonArea(polygon);
                }
            }
            
            return totalArea > 0 ? Math.round(totalArea) : null;
            
        } catch (e) {
            log.warn('Area calculation failed:', e);
            return null;
        }
    }
    
    /**
     * 지역 유형에 따른 가격 배수 결정
     */
    getRegionMultiplier(territory) {
        const props = territory.properties || territory;
        
        // name이 객체일 수 있음 (예: {en: "...", ko: "..."})
        let rawName = props.name || props.name_en || '';
        if (typeof rawName === 'object') {
            rawName = rawName.en || rawName.ko || Object.values(rawName)[0] || '';
        }
        const name = String(rawName).toLowerCase();
        
        // 수도 지역
        const capitals = ['seoul', 'tokyo', 'washington', 'london', 'paris', 'berlin', 
                         'beijing', 'moscow', 'canberra', 'ottawa', 'capital', 'district'];
        if (capitals.some(cap => name.includes(cap))) {
            return REGION_MULTIPLIER.capital;
        }
        
        // 대도시
        const majorCities = ['new york', 'los angeles', 'chicago', 'osaka', 'shanghai',
                            'mumbai', 'são paulo', 'city', 'metro', 'urban'];
        if (majorCities.some(city => name.includes(city))) {
            return REGION_MULTIPLIER.major_city;
        }
        
        // 해안 지역 (일반적인 해안 관련 키워드)
        const coastal = ['coastal', 'beach', 'shore', 'bay', 'port', 'harbor'];
        if (coastal.some(c => name.includes(c))) {
            return REGION_MULTIPLIER.coastal;
        }
        
        return REGION_MULTIPLIER.inland;
    }
    
    /**
     * 국가별 경제 계수 반환
     */
    getEconomicFactor(countryCode) {
        // ISO 코드 변환
        const codeMap = {
            'usa': 'USA', 'south-korea': 'KOR', 'japan': 'JPN',
            'china': 'CHN', 'germany': 'DEU', 'uk': 'GBR',
            'france': 'FRA', 'india': 'IND', 'brazil': 'BRA',
            'russia': 'RUS', 'australia': 'AUS', 'canada': 'CAN',
            'singapore': 'SGP', 'uae': 'ARE', 'switzerland': 'CHE',
            'norway': 'NOR', 'sweden': 'SWE', 'netherlands': 'NLD'
        };
        
        const iso3 = codeMap[countryCode] || countryCode?.toUpperCase() || 'default';
        return COUNTRY_ECONOMIC_FACTOR[iso3] || COUNTRY_ECONOMIC_FACTOR.default;
    }
    
    /**
     * 국가 통계 가져오기
     */
    getCountryStats(countryCode) {
        // ISO 3166-1 alpha-3 코드 변환
        const codeMap = {
            'usa': 'USA', 'south-korea': 'KOR', 'japan': 'JPN',
            'china': 'CHN', 'germany': 'DEU', 'uk': 'GBR',
            'france': 'FRA', 'india': 'IND', 'brazil': 'BRA',
            'russia': 'RUS', 'australia': 'AUS', 'canada': 'CAN',
            'mexico': 'MEX', 'singapore': 'SGP', 'uae': 'ARE',
            'italy': 'ITA', 'spain': 'ESP', 'netherlands': 'NLD',
            'switzerland': 'CHE', 'sweden': 'SWE', 'norway': 'NOR',
            'saudi-arabia': 'SAU', 'turkey': 'TUR', 'indonesia': 'IDN',
            'thailand': 'THA', 'vietnam': 'VNM', 'malaysia': 'MYS',
            'philippines': 'PHL', 'egypt': 'EGY', 'south-africa': 'ZAF',
            'argentina': 'ARG', 'chile': 'CHL', 'colombia': 'COL',
            'peru': 'PER', 'nigeria': 'NGA', 'kenya': 'KEN'
        };
        
        const iso3 = codeMap[countryCode] || countryCode.toUpperCase();
        return this.countryStats.get(iso3) || null;
    }
    
    /**
     * 영토 데이터 설정
     */
    setTerritoryData(territoryId, data) {
        this.territoryData.set(territoryId, {
            ...data,
            updatedAt: Date.now()
        });
    }
    
    /**
     * 영토 데이터 가져오기
     */
    getTerritoryData(territoryId) {
        return this.territoryData.get(territoryId) || null;
    }
    
    /**
     * 숫자 포맷
     */
    formatNumber(num) {
        if (num >= 1000000000) {
            return (num / 1000000000).toFixed(1) + 'B';
        } else if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toLocaleString();
    }
    
    /**
     * 면적 포맷
     */
    formatArea(km2) {
        if (km2 >= 1000000) {
            return (km2 / 1000000).toFixed(2) + 'M km²';
        } else if (km2 >= 1000) {
            return (km2 / 1000).toFixed(1) + 'K km²';
        }
        return km2.toLocaleString() + ' km²';
    }
    
    /**
     * 가격 포맷 (포인트)
     */
    formatPrice(price) {
        return price.toLocaleString() + ' pt';
    }
}

// 싱글톤
export const territoryDataService = new TerritoryDataService();
export default territoryDataService;

