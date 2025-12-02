/**
 * MapController - 지도 제어 모듈
 * Mapbox GL JS 통합 및 지도 상호작용 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';

class MapController {
    constructor() {
        this.map = null;
        this.isGlobeMode = true;
        this.currentCountry = null;
        this.hoveredTerritoryId = null;
        this.selectedTerritoryId = null;
        this.geoJsonCache = new Map();
        this.sourcesLoaded = new Set();
    }
    
    /**
     * 지도 초기화
     * @param {string} containerId - 지도 컨테이너 ID
     */
    async initialize(containerId = 'map') {
        try {
            // Mapbox 토큰 설정
            mapboxgl.accessToken = CONFIG.MAPBOX.ACCESS_TOKEN;
            
            // 지도 생성
            this.map = new mapboxgl.Map({
                container: containerId,
                style: CONFIG.MAPBOX.STYLE,
                center: CONFIG.MAPBOX.DEFAULT_CENTER,
                zoom: CONFIG.MAPBOX.DEFAULT_ZOOM,
                projection: 'globe',  // 3D 지구본 모드
                maxZoom: CONFIG.MAPBOX.MAX_ZOOM,
                minZoom: CONFIG.MAPBOX.MIN_ZOOM
            });
            
            // 지구본 분위기 설정
            this.map.on('style.load', () => {
                this.setupGlobeAtmosphere();
            });
            
            // 지도 로드 완료 대기
            await this.waitForMapLoad();
            
            // 네비게이션 컨트롤 추가
            this.map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('Map initialized successfully');
            eventBus.emit(EVENTS.MAP_LOADED, { map: this.map });
            
            return true;
            
        } catch (error) {
            log.error('Map initialization failed:', error);
            eventBus.emit(EVENTS.APP_ERROR, { type: 'map', error });
            return false;
        }
    }
    
    /**
     * 지도 로드 대기
     */
    waitForMapLoad() {
        return new Promise((resolve) => {
            if (this.map.loaded()) {
                resolve();
            } else {
                this.map.on('load', resolve);
            }
        });
    }
    
    /**
     * 지구본 분위기 효과 설정
     */
    setupGlobeAtmosphere() {
        this.map.setFog({
            color: 'rgb(10, 10, 26)',        // 우주 배경색
            'high-color': 'rgb(30, 30, 60)', // 고도 색상
            'horizon-blend': 0.02,           // 지평선 블렌드
            'space-color': 'rgb(10, 10, 26)', // 우주 색상
            'star-intensity': 0.6            // 별 강도
        });
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 클릭 이벤트
        this.map.on('click', (e) => {
            eventBus.emit(EVENTS.MAP_CLICK, {
                lngLat: e.lngLat,
                point: e.point
            });
        });
        
        // 줌 이벤트
        this.map.on('zoomend', () => {
            eventBus.emit(EVENTS.MAP_ZOOM, {
                zoom: this.map.getZoom()
            });
        });
        
        // 이동 이벤트
        this.map.on('moveend', () => {
            eventBus.emit(EVENTS.MAP_MOVE, {
                center: this.map.getCenter(),
                zoom: this.map.getZoom(),
                bounds: this.map.getBounds()
            });
        });
    }
    
    /**
     * GeoJSON 데이터 로드
     * @param {string} country - 국가 코드
     */
    async loadGeoJsonData(country) {
        // 지원 국가 확인
        if (!this.isCountrySupported(country)) {
            log.warn(`국가 ${country}는 아직 지원되지 않습니다.`);
            return null;
        }
        
        // 캐시 확인
        if (this.geoJsonCache.has(country)) {
            log.debug(`Using cached GeoJSON for ${country}`);
            return this.geoJsonCache.get(country);
        }
        
        try {
            const urlInfo = this.getGeoJsonUrl(country);
            if (!urlInfo) {
                log.warn(`No GeoJSON URL for ${country}`);
                return null;
            }
            
            log.info(`Loading GeoJSON for ${country} from ${urlInfo.isLocal ? 'local' : 'CDN'}...`);
            
            const response = await fetch(urlInfo.url);
            
            if (!response.ok) {
                throw new Error(`Failed to fetch GeoJSON: ${response.status}`);
            }
            
            let data = await response.json();
            
            // 외부 소스인 경우 데이터 변환이 필요할 수 있음
            if (!urlInfo.isLocal) {
                data = this.normalizeGeoJson(data, country);
            }
            
            // 캐시에 저장
            this.geoJsonCache.set(country, data);
            log.info(`GeoJSON loaded for ${country}:`, data.features?.length || 1, 'features');
            
            return data;
            
        } catch (error) {
            log.error(`Failed to load GeoJSON for ${country}:`, error);
            // 외부 소스 실패 시 대체 소스 시도
            return await this.loadFallbackGeoJson(country);
        }
    }
    
    /**
     * 대체 GeoJSON 로드 (OSM Nominatim)
     */
    async loadFallbackGeoJson(country) {
        // ISO 3166-1 alpha-2 코드 매핑
        const isoCodeMap = {
            // 아시아
            'china': 'CN', 'taiwan': 'TW', 'hong-kong': 'HK', 'india': 'IN',
            'indonesia': 'ID', 'thailand': 'TH', 'vietnam': 'VN', 'malaysia': 'MY',
            'singapore': 'SG', 'philippines': 'PH', 'pakistan': 'PK', 'bangladesh': 'BD',
            'myanmar': 'MM', 'cambodia': 'KH', 'laos': 'LA', 'mongolia': 'MN',
            'nepal': 'NP', 'sri-lanka': 'LK', 'kazakhstan': 'KZ', 'uzbekistan': 'UZ',
            'north-korea': 'KP', 'brunei': 'BN', 'bhutan': 'BT', 'maldives': 'MV',
            'timor-leste': 'TL',
            // 중동
            'saudi-arabia': 'SA', 'uae': 'AE', 'qatar': 'QA', 'iran': 'IR',
            'iraq': 'IQ', 'israel': 'IL', 'jordan': 'JO', 'lebanon': 'LB',
            'oman': 'OM', 'kuwait': 'KW', 'bahrain': 'BH', 'syria': 'SY',
            'yemen': 'YE', 'palestine': 'PS', 'turkey': 'TR', 'afghanistan': 'AF',
            // 유럽
            'germany': 'DE', 'france': 'FR', 'uk': 'GB', 'italy': 'IT',
            'spain': 'ES', 'netherlands': 'NL', 'poland': 'PL', 'belgium': 'BE',
            'sweden': 'SE', 'austria': 'AT', 'switzerland': 'CH', 'norway': 'NO',
            'portugal': 'PT', 'greece': 'GR', 'czech-republic': 'CZ', 'romania': 'RO',
            'hungary': 'HU', 'denmark': 'DK', 'finland': 'FI', 'ireland': 'IE',
            'bulgaria': 'BG', 'slovakia': 'SK', 'croatia': 'HR', 'lithuania': 'LT',
            'slovenia': 'SI', 'latvia': 'LV', 'estonia': 'EE', 'cyprus': 'CY',
            'luxembourg': 'LU', 'malta': 'MT', 'russia': 'RU', 'ukraine': 'UA',
            'belarus': 'BY', 'serbia': 'RS', 'albania': 'AL', 'north-macedonia': 'MK',
            'montenegro': 'ME', 'bosnia': 'BA', 'moldova': 'MD', 'iceland': 'IS',
            'georgia': 'GE', 'armenia': 'AM', 'azerbaijan': 'AZ',
            // 북미
            'canada': 'CA', 'mexico': 'MX', 'cuba': 'CU', 'jamaica': 'JM',
            'haiti': 'HT', 'dominican-republic': 'DO', 'guatemala': 'GT', 'honduras': 'HN',
            'el-salvador': 'SV', 'nicaragua': 'NI', 'costa-rica': 'CR', 'panama': 'PA',
            'belize': 'BZ', 'puerto-rico': 'PR',
            // 남미
            'brazil': 'BR', 'argentina': 'AR', 'chile': 'CL', 'colombia': 'CO',
            'peru': 'PE', 'venezuela': 'VE', 'ecuador': 'EC', 'bolivia': 'BO',
            'paraguay': 'PY', 'uruguay': 'UY', 'guyana': 'GY', 'suriname': 'SR',
            // 아프리카
            'south-africa': 'ZA', 'egypt': 'EG', 'nigeria': 'NG', 'kenya': 'KE',
            'ethiopia': 'ET', 'ghana': 'GH', 'morocco': 'MA', 'algeria': 'DZ',
            'tunisia': 'TN', 'libya': 'LY', 'sudan': 'SD', 'tanzania': 'TZ',
            'uganda': 'UG', 'rwanda': 'RW', 'senegal': 'SN', 'ivory-coast': 'CI',
            'cameroon': 'CM', 'angola': 'AO', 'mozambique': 'MZ', 'zimbabwe': 'ZW',
            'zambia': 'ZM', 'botswana': 'BW', 'namibia': 'NA', 'madagascar': 'MG',
            'mauritius': 'MU', 'congo-drc': 'CD',
            // 오세아니아
            'australia': 'AU', 'new-zealand': 'NZ', 'fiji': 'FJ', 'papua-new-guinea': 'PG'
        };
        
        const iso2 = isoCodeMap[country];
        if (!iso2) return null;
        
        try {
            // OSM Admin Boundaries API 사용
            const url = `https://nominatim.openstreetmap.org/search?country=${iso2}&polygon_geojson=1&format=geojson&limit=1`;
            const response = await fetch(url, {
                headers: { 'User-Agent': 'BillionaireHomepage/2.0' }
            });
            
            if (!response.ok) return null;
            
            const data = await response.json();
            if (data.features && data.features.length > 0) {
                const normalized = this.normalizeGeoJson(data, country);
                this.geoJsonCache.set(country, normalized);
                log.info(`Fallback GeoJSON loaded for ${country}`);
                return normalized;
            }
        } catch (error) {
            log.error(`Fallback GeoJSON also failed for ${country}:`, error);
        }
        
        return null;
    }
    
    /**
     * GeoJSON 데이터 정규화
     */
    normalizeGeoJson(data, country) {
        // 단일 Feature인 경우 FeatureCollection으로 변환
        if (data.type === 'Feature') {
            data = {
                type: 'FeatureCollection',
                features: [data]
            };
        }
        
        // 각 feature에 id와 필수 속성 추가
        if (data.features) {
            data.features = data.features.map((feature, index) => ({
                ...feature,
                id: feature.id || `${country}-${index}`,
                properties: {
                    ...feature.properties,
                    id: feature.properties?.id || `${country}-${index}`,
                    name: feature.properties?.name || feature.properties?.NAME || feature.properties?.admin || country,
                    country: country,
                    sovereignty: 'unconquered'
                }
            }));
        }
        
        return data;
    }
    
    /**
     * GeoJSON URL 결정
     * 로컬 파일 우선, 없으면 외부 CDN 사용
     */
    getGeoJsonUrl(country) {
        // 로컬 파일 (고품질)
        const localMap = {
            'usa': '/data/us-states-accurate.geojson',
            'south-korea': '/data/korea-official.geojson',
            'japan': '/data/japan-prefectures-accurate.geojson',
            'world': '/data/world-regions.geojson'
        };
        
        if (localMap[country]) {
            return { url: localMap[country], isLocal: true };
        }
        
        // 외부 CDN - ISO 3166-1 alpha-3 코드 매핑 (전 세계 200+ 국가)
        const isoCodeMap = {
            // 아시아
            'china': 'CHN', 'taiwan': 'TWN', 'hong-kong': 'HKG', 'india': 'IND',
            'indonesia': 'IDN', 'thailand': 'THA', 'vietnam': 'VNM', 'malaysia': 'MYS',
            'singapore': 'SGP', 'philippines': 'PHL', 'pakistan': 'PAK', 'bangladesh': 'BGD',
            'myanmar': 'MMR', 'cambodia': 'KHM', 'laos': 'LAO', 'mongolia': 'MNG',
            'nepal': 'NPL', 'sri-lanka': 'LKA', 'kazakhstan': 'KAZ', 'uzbekistan': 'UZB',
            'north-korea': 'PRK', 'brunei': 'BRN', 'bhutan': 'BTN', 'maldives': 'MDV',
            'timor-leste': 'TLS',
            
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
            'canada': 'CAN', 'mexico': 'MEX', 'cuba': 'CUB', 'jamaica': 'JAM',
            'haiti': 'HTI', 'dominican-republic': 'DOM', 'guatemala': 'GTM', 'honduras': 'HND',
            'el-salvador': 'SLV', 'nicaragua': 'NIC', 'costa-rica': 'CRI', 'panama': 'PAN',
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
            'australia': 'AUS', 'new-zealand': 'NZL', 'fiji': 'FJI', 'papua-new-guinea': 'PNG',
            
            'european-union': 'EU'
        };
        
        const isoCode = isoCodeMap[country];
        if (isoCode) {
            // GADM (Global Administrative Areas) CDN 사용
            return { 
                url: `https://raw.githubusercontent.com/datasets/geo-countries/master/data/${isoCode}.geojson`,
                isLocal: false,
                isoCode: isoCode
            };
        }
        
        return null;
    }
    
    /**
     * 지원 국가 목록 (전 세계)
     */
    getSupportedCountries() {
        // CONFIG.COUNTRIES의 모든 키를 반환
        if (typeof CONFIG !== 'undefined' && CONFIG.COUNTRIES) {
            return Object.keys(CONFIG.COUNTRIES);
        }
        // 폴백: 기본 국가 목록
        return ['usa', 'south-korea', 'japan'];
    }
    
    /**
     * 국가 지원 여부 확인
     */
    isCountrySupported(country) {
        // 로컬 파일이 있거나 ISO 코드 매핑이 있으면 지원
        const urlInfo = this.getGeoJsonUrl(country);
        return urlInfo !== null;
    }
    
    /**
     * 영토 레이어 추가
     * @param {string} sourceId - 소스 ID
     * @param {object} geoJsonData - GeoJSON 데이터
     */
    addTerritoryLayer(sourceId, geoJsonData) {
        // 이미 소스가 있으면 업데이트
        if (this.map.getSource(sourceId)) {
            this.map.getSource(sourceId).setData(geoJsonData);
            return;
        }
        
        // 소스 추가
        this.map.addSource(sourceId, {
            type: 'geojson',
            data: geoJsonData,
            generateId: true
        });
        
        // Fill 레이어 (영토 채우기)
        this.map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            paint: {
                'fill-color': [
                    'case',
                    ['==', ['get', 'sovereignty'], 'ruled'], CONFIG.COLORS.SOVEREIGNTY.RULED,
                    ['==', ['get', 'sovereignty'], 'contested'], CONFIG.COLORS.SOVEREIGNTY.CONTESTED,
                    CONFIG.COLORS.SOVEREIGNTY.UNCONQUERED
                ],
                'fill-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false], 0.8,
                    ['boolean', ['feature-state', 'selected'], false], 0.9,
                    0.6
                ]
            }
        });
        
        // 경계선 레이어
        this.map.addLayer({
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#ffffff',
                'line-width': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 3,
                    ['boolean', ['feature-state', 'hover'], false], 2,
                    1
                ],
                'line-opacity': 0.8
            }
        });
        
        // 호버/선택 이벤트 설정
        this.setupTerritoryInteractions(sourceId);
        
        this.sourcesLoaded.add(sourceId);
        log.info(`Territory layer added: ${sourceId}`);
    }
    
    /**
     * 영토 상호작용 설정
     */
    setupTerritoryInteractions(sourceId) {
        const fillLayerId = `${sourceId}-fill`;
        
        // 마우스 진입
        this.map.on('mouseenter', fillLayerId, (e) => {
            this.map.getCanvas().style.cursor = 'pointer';
            
            if (e.features.length > 0) {
                const feature = e.features[0];
                
                // 이전 호버 해제
                if (this.hoveredTerritoryId !== null) {
                    this.map.setFeatureState(
                        { source: sourceId, id: this.hoveredTerritoryId },
                        { hover: false }
                    );
                }
                
                // 새 호버 설정
                this.hoveredTerritoryId = feature.id;
                this.map.setFeatureState(
                    { source: sourceId, id: this.hoveredTerritoryId },
                    { hover: true }
                );
                
                eventBus.emit(EVENTS.TERRITORY_HOVER, {
                    territoryId: feature.properties.id || feature.id,
                    properties: feature.properties,
                    lngLat: e.lngLat
                });
            }
        });
        
        // 마우스 이탈
        this.map.on('mouseleave', fillLayerId, () => {
            this.map.getCanvas().style.cursor = '';
            
            if (this.hoveredTerritoryId !== null) {
                this.map.setFeatureState(
                    { source: sourceId, id: this.hoveredTerritoryId },
                    { hover: false }
                );
            }
            this.hoveredTerritoryId = null;
        });
        
        // 클릭
        this.map.on('click', fillLayerId, (e) => {
            if (e.features.length > 0) {
                const feature = e.features[0];
                this.selectTerritory(sourceId, feature);
            }
        });
    }
    
    /**
     * 영토 선택
     */
    selectTerritory(sourceId, feature) {
        // 이전 선택 해제
        if (this.selectedTerritoryId !== null) {
            this.map.setFeatureState(
                { source: sourceId, id: this.selectedTerritoryId },
                { selected: false }
            );
            eventBus.emit(EVENTS.TERRITORY_DESELECT, {
                territoryId: this.selectedTerritoryId
            });
        }
        
        // 새 선택
        this.selectedTerritoryId = feature.id;
        this.map.setFeatureState(
            { source: sourceId, id: this.selectedTerritoryId },
            { selected: true }
        );
        
        eventBus.emit(EVENTS.TERRITORY_SELECT, {
            territoryId: feature.properties.id || feature.id,
            properties: feature.properties,
            geometry: feature.geometry
        });
    }
    
    /**
     * 지도 이동
     */
    flyTo(center, zoom, options = {}) {
        this.map.flyTo({
            center,
            zoom,
            duration: options.duration || 2000,
            essential: true,
            ...options
        });
    }
    
    /**
     * 국가로 이동
     */
    flyToCountry(countryCode) {
        const country = CONFIG.G20_COUNTRIES[countryCode];
        if (country) {
            this.flyTo(country.center, country.zoom);
            this.currentCountry = countryCode;
            eventBus.emit(EVENTS.MAP_MODE_CHANGE, { country: countryCode });
        }
    }
    
    /**
     * 글로브/평면 모드 전환
     */
    toggleProjection() {
        this.isGlobeMode = !this.isGlobeMode;
        this.map.setProjection(this.isGlobeMode ? 'globe' : 'mercator');
        
        if (this.isGlobeMode) {
            this.setupGlobeAtmosphere();
        }
        
        log.info(`Projection changed to: ${this.isGlobeMode ? 'globe' : 'mercator'}`);
    }
    
    /**
     * 지도 리사이즈
     */
    resize() {
        if (this.map) {
            this.map.resize();
        }
    }
    
    /**
     * 지도 인스턴스 가져오기
     */
    getMap() {
        return this.map;
    }
    
    /**
     * 현재 줌 레벨
     */
    getZoom() {
        return this.map?.getZoom() || 0;
    }
    
    /**
     * 현재 중심점
     */
    getCenter() {
        return this.map?.getCenter() || { lng: 0, lat: 0 };
    }
}

// 싱글톤 인스턴스
export const mapController = new MapController();
export default mapController;

