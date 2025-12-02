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
     */
    extractArea(territory, countryCode) {
        const props = territory.properties || territory;
        
        // 1. Natural Earth Admin 1 데이터 속성 시도
        // Natural Earth 10m admin_1 데이터의 면적 관련 필드들
        let area = null;
        
        // 직접적인 면적 속성
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
            // Shape_Area는 보통 제곱미터 또는 제곱도
            const shapeArea = parseFloat(props.Shape_Area);
            if (shapeArea > 0) {
                // 값이 매우 작으면 제곱도, 크면 제곱미터로 추정
                area = shapeArea > 1000 ? shapeArea / 1000000 : shapeArea * 12365; // 1 sq deg ≈ 12365 km²
            }
        }
        
        // 3. 지오메트리에서 면적 계산 시도 (대략적)
        if (!area && territory.geometry) {
            area = this.calculateGeometryArea(territory.geometry);
        }
        
        // 4. 고유 ID 기반 해시로 변형 (각 지역마다 다른 값을 갖도록)
        if (!area) {
            const id = props.id || props.name || props.fid || Math.random();
            const hash = this.hashString(String(id));
            
            // 국가 데이터에서 평균 면적을 기반으로 ±50% 변동
            const countryData = this.getCountryStats(countryCode);
            const baseArea = countryData?.area ? countryData.area / 50 : 10000;
            const variation = 0.5 + (hash % 100) / 100; // 0.5 ~ 1.5
            area = baseArea * variation;
        }
        
        return Math.round(area);
    }
    
    /**
     * 영토에서 인구 추출
     */
    extractPopulation(territory, countryCode) {
        const props = territory.properties || territory;
        
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
        
        // 국가 데이터에서 평균 인구를 기반으로 ±50% 변동
        const countryData = this.getCountryStats(countryCode);
        const basePop = countryData?.population ? countryData.population / 50 : 1000000;
        const variation = 0.3 + (hash % 140) / 100; // 0.3 ~ 1.7
        
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
    calculateGeometryArea(geometry) {
        try {
            if (!geometry || !geometry.coordinates) return null;
            
            // Polygon 또는 MultiPolygon의 바운딩 박스로 대략적 면적 추정
            let minLng = Infinity, maxLng = -Infinity;
            let minLat = Infinity, maxLat = -Infinity;
            
            const processCoords = (coords) => {
                if (typeof coords[0] === 'number') {
                    const [lng, lat] = coords;
                    minLng = Math.min(minLng, lng);
                    maxLng = Math.max(maxLng, lng);
                    minLat = Math.min(minLat, lat);
                    maxLat = Math.max(maxLat, lat);
                } else {
                    coords.forEach(processCoords);
                }
            };
            
            processCoords(geometry.coordinates);
            
            if (minLng === Infinity) return null;
            
            // 위경도 차이로 면적 추정 (1도 ≈ 111km)
            const lngDiff = maxLng - minLng;
            const latDiff = maxLat - minLat;
            const midLat = (minLat + maxLat) / 2;
            
            // 위도에 따른 경도 보정
            const lngKm = lngDiff * 111 * Math.cos(midLat * Math.PI / 180);
            const latKm = latDiff * 111;
            
            // 바운딩 박스의 약 60% 정도가 실제 영역 (불규칙한 모양 보정)
            return lngKm * latKm * 0.6;
            
        } catch (e) {
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
     * 가격 포맷
     */
    formatPrice(price) {
        return '$' + price.toLocaleString();
    }
}

// 싱글톤
export const territoryDataService = new TerritoryDataService();
export default territoryDataService;

