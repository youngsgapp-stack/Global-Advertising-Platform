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
        this.globalAdminData = null;  // Global admin data
        this.globalAdminLoaded = false;
        this.viewMode = 'country';  // 'world' or 'country'
        this.activeLayerIds = new Set();  // Track active layers
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
     * 전 세계 행정구역 데이터 로드 (Natural Earth Admin 1)
     */
    async loadGlobalAdminData() {
        if (this.globalAdminLoaded && this.globalAdminData) {
            return this.globalAdminData;
        }
        
        try {
            log.info('Loading global admin boundaries data...');
            
            // Natural Earth Admin 1 데이터 (주/도 레벨)
            const url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch global admin data: ${response.status}`);
            }
            
            this.globalAdminData = await response.json();
            this.globalAdminLoaded = true;
            
            log.info(`Global admin data loaded: ${this.globalAdminData.features?.length} regions`);
            return this.globalAdminData;
            
        } catch (error) {
            log.error('Failed to load global admin data:', error);
            return null;
        }
    }
    
    /**
     * 국가별 행정구역 필터링
     */
    filterAdminByCountry(countryCode) {
        if (!this.globalAdminData) return null;
        
        // 국가 코드 매핑 (우리 코드 -> ISO/Natural Earth 코드)
        const countryNameMap = {
            'usa': ['United States of America', 'United States', 'US', 'USA'],
            'south-korea': ['South Korea', 'Korea, Republic of', 'KOR', 'Republic of Korea'],
            'japan': ['Japan', 'JPN'],
            'china': ['China', 'CHN', "People's Republic of China"],
            'india': ['India', 'IND'],
            'germany': ['Germany', 'DEU'],
            'france': ['France', 'FRA'],
            'uk': ['United Kingdom', 'GBR', 'Great Britain'],
            'italy': ['Italy', 'ITA'],
            'spain': ['Spain', 'ESP'],
            'brazil': ['Brazil', 'BRA'],
            'canada': ['Canada', 'CAN'],
            'russia': ['Russia', 'RUS', 'Russian Federation'],
            'australia': ['Australia', 'AUS'],
            'mexico': ['Mexico', 'MEX'],
            'indonesia': ['Indonesia', 'IDN'],
            'turkey': ['Turkey', 'TUR', 'Türkiye'],
            'saudi-arabia': ['Saudi Arabia', 'SAU'],
            'south-africa': ['South Africa', 'ZAF'],
            'argentina': ['Argentina', 'ARG'],
            'netherlands': ['Netherlands', 'NLD'],
            'switzerland': ['Switzerland', 'CHE'],
            'poland': ['Poland', 'POL'],
            'belgium': ['Belgium', 'BEL'],
            'sweden': ['Sweden', 'SWE'],
            'austria': ['Austria', 'AUT'],
            'norway': ['Norway', 'NOR'],
            'uae': ['United Arab Emirates', 'ARE'],
            'thailand': ['Thailand', 'THA'],
            'vietnam': ['Vietnam', 'VNM', 'Viet Nam'],
            'malaysia': ['Malaysia', 'MYS'],
            'singapore': ['Singapore', 'SGP'],
            'philippines': ['Philippines', 'PHL'],
            'egypt': ['Egypt', 'EGY'],
            'nigeria': ['Nigeria', 'NGA'],
            'pakistan': ['Pakistan', 'PAK'],
            'bangladesh': ['Bangladesh', 'BGD'],
            'iran': ['Iran', 'IRN'],
            'iraq': ['Iraq', 'IRQ'],
            'israel': ['Israel', 'ISR'],
            'ukraine': ['Ukraine', 'UKR'],
            'portugal': ['Portugal', 'PRT'],
            'greece': ['Greece', 'GRC'],
            'czech-republic': ['Czech Republic', 'Czechia', 'CZE'],
            'romania': ['Romania', 'ROU'],
            'hungary': ['Hungary', 'HUN'],
            'denmark': ['Denmark', 'DNK'],
            'finland': ['Finland', 'FIN'],
            'ireland': ['Ireland', 'IRL'],
            'new-zealand': ['New Zealand', 'NZL'],
            'chile': ['Chile', 'CHL'],
            'colombia': ['Colombia', 'COL'],
            'peru': ['Peru', 'PER'],
            'venezuela': ['Venezuela', 'VEN'],
            'kenya': ['Kenya', 'KEN'],
            'morocco': ['Morocco', 'MAR'],
            'algeria': ['Algeria', 'DZA'],
            'qatar': ['Qatar', 'QAT'],
            'kuwait': ['Kuwait', 'KWT']
        };
        
        const countryNames = countryNameMap[countryCode] || [countryCode];
        
        const filtered = this.globalAdminData.features.filter(feature => {
            const props = feature.properties;
            const admin = props.admin || props.sovereign || props.name_en || '';
            const iso = props.iso_a2 || props.iso_3166_2 || '';
            const sov = props.sov_a3 || '';
            
            return countryNames.some(name => 
                admin.toLowerCase().includes(name.toLowerCase()) ||
                iso.toUpperCase().includes(name.toUpperCase()) ||
                sov.toUpperCase().includes(name.toUpperCase())
            );
        });
        
        if (filtered.length === 0) {
            log.warn(`No admin regions found for ${countryCode}`);
            return null;
        }
        
        // 정규화된 GeoJSON 반환
        return {
            type: 'FeatureCollection',
            features: filtered.map((feature, index) => ({
                ...feature,
                id: index,
                properties: {
                    ...feature.properties,
                    id: `${countryCode}-${index}`,
                    name: feature.properties.name || feature.properties.name_en || feature.properties.admin || `Region ${index + 1}`,
                    country: countryCode,
                    sovereignty: 'unconquered'
                }
            }))
        };
    }
    
    /**
     * GeoJSON 데이터 로드
     * @param {string} country - 국가 코드
     */
    async loadGeoJsonData(country) {
        // 캐시 확인
        if (this.geoJsonCache.has(country)) {
            log.debug(`Using cached GeoJSON for ${country}`);
            return this.geoJsonCache.get(country);
        }
        
        try {
            // 로컬 파일 우선 확인
            const localUrl = this.getLocalGeoJsonUrl(country);
            if (localUrl) {
                log.info(`Loading local GeoJSON for ${country}...`);
                const response = await fetch(localUrl);
                if (response.ok) {
                    const data = await response.json();
                    const normalized = this.normalizeGeoJson(data, country);
                    this.geoJsonCache.set(country, normalized);
                    log.info(`Local GeoJSON loaded for ${country}: ${normalized.features?.length} regions`);
                    return normalized;
                }
            }
            
            // 전 세계 데이터에서 필터링
            log.info(`Loading ${country} from global admin data...`);
            await this.loadGlobalAdminData();
            
            if (this.globalAdminData) {
                const filtered = this.filterAdminByCountry(country);
                if (filtered && filtered.features.length > 0) {
                    this.geoJsonCache.set(country, filtered);
                    log.info(`Filtered GeoJSON for ${country}: ${filtered.features.length} regions`);
                    return filtered;
                }
            }
            
            log.warn(`No GeoJSON data available for ${country}`);
            return null;
            
        } catch (error) {
            log.error(`Failed to load GeoJSON for ${country}:`, error);
            return null;
        }
    }
    
    /**
     * 로컬 GeoJSON URL 확인
     */
    getLocalGeoJsonUrl(country) {
        const localMap = {
            'usa': '/data/us-states-accurate.geojson',
            'south-korea': '/data/korea-official.geojson',
            'japan': '/data/japan-prefectures-accurate.geojson'
        };
        return localMap[country] || null;
    }
    
    /**
     * GeoJSON 데이터 정규화
     */
    normalizeGeoJson(data, country) {
        if (data.type === 'Feature') {
            data = {
                type: 'FeatureCollection',
                features: [data]
            };
        }
        
        if (data.features) {
            data.features = data.features.map((feature, index) => ({
                ...feature,
                id: feature.id ?? index,
                properties: {
                    ...feature.properties,
                    id: feature.properties?.id || `${country}-${index}`,
                    name: feature.properties?.name || feature.properties?.NAME || feature.properties?.name_en || `Region ${index + 1}`,
                    country: country,
                    sovereignty: 'unconquered'
                }
            }));
        }
        
        return data;
    }
    
    /**
     * 지원 국가 목록 (전 세계)
     */
    getSupportedCountries() {
        if (typeof CONFIG !== 'undefined' && CONFIG.COUNTRIES) {
            return Object.keys(CONFIG.COUNTRIES);
        }
        return ['usa', 'south-korea', 'japan'];
    }
    
    /**
     * 국가 지원 여부 확인 - 모든 국가 지원
     */
    isCountrySupported(country) {
        return true;  // Natural Earth 데이터로 모든 국가 지원
    }
    
    /**
     * Clear all territory layers (for Country View mode)
     */
    clearAllTerritoryLayers() {
        for (const sourceId of this.activeLayerIds) {
            const fillLayerId = `${sourceId}-fill`;
            const lineLayerId = `${sourceId}-line`;
            
            try {
                if (this.map.getLayer(fillLayerId)) {
                    this.map.removeLayer(fillLayerId);
                }
                if (this.map.getLayer(lineLayerId)) {
                    this.map.removeLayer(lineLayerId);
                }
                if (this.map.getSource(sourceId)) {
                    this.map.removeSource(sourceId);
                }
            } catch (e) {
                log.warn(`Failed to remove layer ${sourceId}:`, e);
            }
        }
        this.activeLayerIds.clear();
        this.sourcesLoaded.clear();
        log.info('All territory layers cleared');
    }
    
    /**
     * Set view mode (world or country)
     */
    setViewMode(mode) {
        this.viewMode = mode;
        log.info(`View mode set to: ${mode}`);
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'info',
            message: mode === 'world' ? '🌍 World View' : '📍 Country View'
        });
    }
    
    /**
     * Get current view mode
     */
    getViewMode() {
        return this.viewMode;
    }
    
    /**
     * Territory layer addition
     * @param {string} sourceId - Source ID
     * @param {object} geoJsonData - GeoJSON data
     */
    addTerritoryLayer(sourceId, geoJsonData) {
        // In Country View mode, clear previous layers first
        if (this.viewMode === 'country' && !sourceId.startsWith('world-')) {
            this.clearAllTerritoryLayers();
        }
        
        // If source already exists, update it
        if (this.map.getSource(sourceId)) {
            this.map.getSource(sourceId).setData(geoJsonData);
            return;
        }
        
        // Add source
        this.map.addSource(sourceId, {
            type: 'geojson',
            data: geoJsonData,
            generateId: true
        });
        
        // Fill layer (territory fill)
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
        
        // Border layer
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
        
        // Setup hover/select interactions
        this.setupTerritoryInteractions(sourceId);
        
        this.sourcesLoaded.add(sourceId);
        this.activeLayerIds.add(sourceId);
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
        const country = CONFIG.COUNTRIES[countryCode];
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
    
    /**
     * Generate color from string (hash-based)
     */
    stringToColor(str) {
        if (!str) return '#4ecdc4';
        
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        // Generate HSL color with good saturation and lightness
        const h = Math.abs(hash) % 360;
        const s = 50 + (Math.abs(hash >> 8) % 30);  // 50-80%
        const l = 40 + (Math.abs(hash >> 16) % 20); // 40-60%
        
        return `hsl(${h}, ${s}%, ${l}%)`;
    }
    
    /**
     * Load World View - Display all countries at once with unique colors
     */
    async loadWorldView() {
        try {
            log.info('Loading World View...');
            this.setViewMode('world');
            this.clearAllTerritoryLayers();
            
            // Load global admin data
            await this.loadGlobalAdminData();
            
            if (!this.globalAdminData) {
                log.error('Failed to load global admin data');
                return false;
            }
            
            // Create color map for countries
            const countryColors = new Map();
            
            // Add all regions as one layer with country colors
            const worldData = {
                type: 'FeatureCollection',
                features: this.globalAdminData.features.map((feature, index) => {
                    const countryCode = feature.properties.sov_a3 || feature.properties.admin || 'unknown';
                    
                    // Get or generate color for this country
                    if (!countryColors.has(countryCode)) {
                        countryColors.set(countryCode, this.stringToColor(countryCode));
                    }
                    
                    return {
                        ...feature,
                        id: index,
                        properties: {
                            ...feature.properties,
                            id: `world-${index}`,
                            name: feature.properties.name || feature.properties.name_en || `Region ${index}`,
                            country: feature.properties.admin || countryCode,
                            countryCode: countryCode,
                            countryColor: countryColors.get(countryCode),
                            sovereignty: 'unconquered'
                        }
                    };
                })
            };
            
            log.info(`Generated colors for ${countryColors.size} countries`);
            
            // Add world layer
            if (this.map.getSource('world-territories')) {
                this.map.getSource('world-territories').setData(worldData);
            } else {
                this.map.addSource('world-territories', {
                    type: 'geojson',
                    data: worldData,
                    generateId: true
                });
                
                this.map.addLayer({
                    id: 'world-territories-fill',
                    type: 'fill',
                    source: 'world-territories',
                    paint: {
                        'fill-color': ['get', 'countryColor'],
                        'fill-opacity': [
                            'case',
                            ['boolean', ['feature-state', 'hover'], false], 0.85,
                            ['boolean', ['feature-state', 'selected'], false], 0.9,
                            0.65
                        ]
                    }
                });
                
                this.map.addLayer({
                    id: 'world-territories-line',
                    type: 'line',
                    source: 'world-territories',
                    paint: {
                        'line-color': '#ffffff',
                        'line-width': [
                            'case',
                            ['boolean', ['feature-state', 'hover'], false], 1.5,
                            0.5
                        ],
                        'line-opacity': 0.7
                    }
                });
                
                this.setupTerritoryInteractions('world-territories');
            }
            
            this.activeLayerIds.add('world-territories');
            
            // Fly to world view
            this.flyTo([0, 20], 2);
            
            log.info(`World View loaded: ${worldData.features.length} regions`);
            return true;
            
        } catch (error) {
            log.error('Failed to load World View:', error);
            return false;
        }
    }
    
    /**
     * Toggle between World View and Country View
     */
    toggleViewMode() {
        if (this.viewMode === 'world') {
            this.setViewMode('country');
            this.clearAllTerritoryLayers();
            // Reload current country if any
            if (this.currentCountry) {
                eventBus.emit('reload-country', { country: this.currentCountry });
            }
        } else {
            this.loadWorldView();
        }
    }
}

// 싱글톤 인스턴스
export const mapController = new MapController();
export default mapController;

