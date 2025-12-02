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
        // 캐시 확인
        if (this.geoJsonCache.has(country)) {
            log.debug(`Using cached GeoJSON for ${country}`);
            return this.geoJsonCache.get(country);
        }
        
        try {
            const url = this.getGeoJsonUrl(country);
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`Failed to fetch GeoJSON: ${response.status}`);
            }
            
            const data = await response.json();
            
            // 캐시에 저장
            this.geoJsonCache.set(country, data);
            log.info(`GeoJSON loaded for ${country}:`, data.features?.length, 'features');
            
            return data;
            
        } catch (error) {
            log.error(`Failed to load GeoJSON for ${country}:`, error);
            throw error;
        }
    }
    
    /**
     * GeoJSON URL 결정
     */
    getGeoJsonUrl(country) {
        const urlMap = {
            'usa': '/data/us-states-accurate.geojson',
            'south-korea': '/data/korea-official.geojson',
            'japan': '/data/japan-prefectures-accurate.geojson',
            'world': '/data/world-regions.geojson'
        };
        
        return urlMap[country] || `/data/${country}.geojson`;
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

