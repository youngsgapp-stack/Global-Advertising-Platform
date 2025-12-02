/**
 * TerritoryDataService - 영토 실데이터 관리
 * 인구, 면적, GDP, 가격 산정
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
    'default': 1.0
};

class TerritoryDataService {
    constructor() {
        this.territoryData = new Map();
        this.countryStats = new Map();
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
     * 행정구역 가격 계산
     */
    calculateTerritoryPrice(territory, countryCode) {
        const countryData = this.countryStats.get(countryCode);
        if (!countryData) return 100;
        
        // Natural Earth 데이터에서 인구 추출
        const pop = territory.properties?.pop_est || 
                    territory.properties?.population ||
                    countryData.population / 50; // 대략 50개 지역으로 나눔
        
        const area = territory.properties?.area_sqkm ||
                     territory.properties?.AREA ||
                     countryData.area / 50;
        
        // 지역 타입 판단
        const name = (territory.properties?.name || '').toLowerCase();
        let regionType = 'inland';
        
        if (name.includes('capital') || name.includes('seoul') || 
            name.includes('tokyo') || name.includes('washington')) {
            regionType = 'capital';
        } else if (name.includes('city') || name.includes('metro')) {
            regionType = 'major_city';
        }
        
        const regionMult = REGION_MULTIPLIER[regionType] || 1.0;
        
        // 가격 계산
        let price = this.calculateBasePrice(pop, area, countryCode) * regionMult;
        
        // 범위 조정
        price = Math.max(10, Math.min(50000, price));
        
        return Math.round(price);
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
     * 가격 포맷
     */
    formatPrice(price) {
        return '$' + price.toLocaleString();
    }
}

// 싱글톤
export const territoryDataService = new TerritoryDataService();
export default territoryDataService;

