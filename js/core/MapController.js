/**
 * MapController - 지도 제어 모듈
 * Mapbox GL JS 통합 및 지도 상호작용 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { territoryManager } from './TerritoryManager.js';
import { firebaseService } from '../services/FirebaseService.js';

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
     * Standard 스타일에 맞게 밝고 선명한 분위기
     */
    setupGlobeAtmosphere() {
        this.map.setFog({
            color: 'rgb(220, 235, 255)',      // 대기권 색상 (밝은 하늘색)
            'high-color': 'rgb(70, 130, 220)', // 고도 색상 (선명한 파란색)
            'horizon-blend': 0.03,            // 지평선 블렌드 (살짝 더 넓게)
            'space-color': 'rgb(15, 20, 35)', // 우주 색상 (어두운 남색)
            'star-intensity': 0.6             // 별 강도
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
        
        // 픽셀 캔버스 업데이트 이벤트
        eventBus.on(EVENTS.PIXEL_CANVAS_SAVED, (data) => {
            this.handlePixelCanvasUpdate(data);
        });
        
        // 영토 업데이트 이벤트
        eventBus.on(EVENTS.TERRITORY_UPDATE, (data) => {
            if (data.territory) {
                // 약간의 지연을 두고 업데이트 (다른 업데이트와 충돌 방지)
                setTimeout(() => {
                    this.updateTerritoryLayerVisual(data.territory);
                }, 50);
            }
        });
    }
    
    /**
     * 픽셀 캔버스 업데이트 처리
     */
    handlePixelCanvasUpdate(data) {
        const { territoryId, filledPixels, territory } = data;
        log.info(`🎨 Pixel canvas updated for territory ${territoryId}: ${filledPixels} pixels`);
        
        // territory 객체가 직접 전달되면 사용, 없으면 TerritoryManager에서 가져오기
        let targetTerritory = territory;
        if (!targetTerritory) {
            targetTerritory = territoryManager.getTerritory(territoryId);
        }
        
        if (targetTerritory) {
            log.info(`📍 Updating map visual for territory ${territoryId}`);
            this.updateTerritoryLayerVisual(targetTerritory);
        } else {
            log.error(`❌ Territory ${territoryId} not found in TerritoryManager`);
        }
    }
    
    /**
     * 영토 레이어 시각적 업데이트 (픽셀 데이터 반영)
     */
    updateTerritoryLayerVisual(territory) {
        if (!this.map || !territory || !territory.id) {
            log.warn('Cannot update territory layer visual: missing map, territory, or territory.id');
            return;
        }
        
        try {
            const territoryId = territory.id;
            log.debug(`Updating territory layer visual for: ${territoryId}`, {
                pixelCanvas: territory.pixelCanvas,
                filledPixels: territory.pixelCanvas?.filledPixels
            });
            
            // 모든 territory source 찾기
            const sources = Array.from(this.sourcesLoaded);
            log.debug(`Checking ${sources.length} sources for territory ${territoryId}`);
            
            let found = false;
            
            for (const sourceId of sources) {
                const source = this.map.getSource(sourceId);
                if (!source || source.type !== 'geojson') continue;
                
                // GeoJSON 데이터 가져오기 (깊은 복사)
                let geoJsonData = source._data;
                if (!geoJsonData || !geoJsonData.features) continue;
                
                // 해당 territory feature 찾기 (다양한 ID 형식 시도) - 강화된 매칭
                let feature = null;
                
                // 우선순위 1: 저장된 featureId와 sourceId로 직접 찾기 (가장 정확하고 빠름)
                if (territory.featureId && territory.sourceId === sourceId) {
                    feature = geoJsonData.features.find(f => String(f.id) === String(territory.featureId));
                    if (feature) {
                        log.info(`✅ Found feature by stored featureId: ${territory.featureId} in source ${sourceId}`);
                    }
                }
                
                // 우선순위 2: 일반 매칭 로직
                if (!feature) {
                    feature = geoJsonData.features.find(f => {
                        const props = f.properties || {};
                        const fid = String(props.id || f.id || '').toLowerCase();
                        const featureName = String(props.name || props.NAME_1 || props.NAME_2 || '').toLowerCase();
                        const territoryIdLower = String(territoryId).toLowerCase();
                        
                        // 1. ID 직접 매칭 (소문자 변환)
                        if (fid === territoryIdLower || 
                            fid === `world-${territoryIdLower}` ||
                            territoryIdLower === `world-${fid}`) {
                            log.debug(`✅ Matched by direct ID: ${fid} === ${territoryIdLower}`);
                            return true;
                        }
                        
                        // 2. ID 부분 매칭
                        if (fid.includes(territoryIdLower) || territoryIdLower.includes(fid)) {
                            log.debug(`✅ Matched by partial ID: ${fid} <-> ${territoryIdLower}`);
                            return true;
                        }
                        
                        // 3. 이름 매칭 (다양한 변형 시도)
                        if (territory.name) {
                            const namesToMatch = [
                                territory.name.en?.toLowerCase(),
                                territory.name.ko?.toLowerCase(),
                                territory.name.local?.toLowerCase(),
                                territoryIdLower.replace(/-/g, ' '),
                                territoryIdLower
                            ].filter(Boolean);
                            
                            for (const nameToMatch of namesToMatch) {
                                if (featureName === nameToMatch || 
                                    featureName.includes(nameToMatch) || 
                                    nameToMatch.includes(featureName)) {
                                    log.debug(`✅ Matched by name: ${featureName} <-> ${nameToMatch}`);
                                    return true;
                                }
                            }
                        }
                        
                        // 4. properties에 저장된 territoryId와 매칭
                        if (props.territoryId && String(props.territoryId).toLowerCase() === territoryIdLower) {
                            log.debug(`✅ Matched by property territoryId: ${props.territoryId}`);
                            return true;
                        }
                        
                        // 5. originalId와 매칭 (GeoJSON 정규화 시 보존된 원본 ID)
                        if (props.originalId && String(props.originalId).toLowerCase() === territoryIdLower) {
                            log.debug(`✅ Matched by originalId: ${props.originalId}`);
                            return true;
                        }
                        
                        // 6. 이름에서 정규화된 ID 생성하여 매칭
                        if (featureName) {
                            const normalizedFromName = featureName
                                .toLowerCase()
                                .replace(/[^\w\s-]/g, '')
                                .replace(/\s+/g, '-')
                                .replace(/-+/g, '-')
                                .replace(/^-|-$/g, '');
                            if (normalizedFromName === territoryIdLower) {
                                log.debug(`✅ Matched by normalized name: ${normalizedFromName}`);
                                return true;
                            }
                        }
                        
                        return false;
                    });
                }
                
                // Feature를 찾지 못한 경우 디버깅 정보 출력
                if (!feature && geoJsonData.features.length > 0) {
                    const sampleFeature = geoJsonData.features[0];
                    log.warn(`🔍 Feature not found for ${territoryId}. Sample feature:`, {
                        id: sampleFeature.id,
                        propertiesId: sampleFeature.properties?.id,
                        name: sampleFeature.properties?.name,
                        searchingFor: territoryId,
                        territoryName: territory.name
                    });
                }
                
                if (feature) {
                    found = true;
                    log.debug(`Found feature for territory ${territoryId} in source ${sourceId}`);
                    
                    // 픽셀 데이터로 속성 업데이트 (변수 범위를 넓게 설정)
                    const filledPixels = territory.pixelCanvas?.filledPixels || 0;
                    const width = territory.pixelCanvas?.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const height = territory.pixelCanvas?.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const totalPixels = width * height;
                    const pixelFillRatio = totalPixels > 0 ? filledPixels / totalPixels : 0;
                    
                    if (territory.pixelCanvas) {
                        // 속성 업데이트
                        feature.properties.filledPixels = filledPixels;
                        feature.properties.pixelCanvasWidth = width;
                        feature.properties.pixelCanvasHeight = height;
                        feature.properties.pixelFillRatio = pixelFillRatio;
                        feature.properties.pixelCanvasUpdated = Date.now();
                        
                        log.info(`Updated feature properties: ${filledPixels} pixels (${(pixelFillRatio * 100).toFixed(1)}% filled)`);
                    }
                    
                    // sovereignty도 업데이트 (있으면)
                    if (territory.sovereignty) {
                        feature.properties.sovereignty = territory.sovereignty;
                    }
                    
                    // territory ID를 properties에 명시적으로 저장
                    feature.properties.id = territoryId;
                    
                    // source 데이터 업데이트 - 깊은 복사로 새 객체 생성
                    // 모든 feature를 순회하며 매칭되는 feature 업데이트
                    const updatedFeatures = geoJsonData.features.map(f => {
                        const fid = String(f.properties?.id || f.id || '').toLowerCase();
                        const fOriginalId = String(f.properties?.originalId || '').toLowerCase();
                        const fName = String(f.properties?.name || f.properties?.NAME_1 || '').toLowerCase();
                        const territoryIdLower = String(territoryId).toLowerCase();
                        
                        // 여러 방식으로 매칭 시도
                        const isMatch = fid === territoryIdLower ||
                                       fOriginalId === territoryIdLower ||
                                       f === feature ||
                                       (fName && this.normalizeTerritoryId(fid, fName, '') === territoryIdLower) ||
                                       (territory.name && fName === String(territory.name.en || territory.name.local || '').toLowerCase());
                        
                        if (isMatch) {
                            // 업데이트된 feature 반환 (완전한 복사)
                            return JSON.parse(JSON.stringify({
                                ...f,
                                properties: {
                                    ...f.properties,
                                    ...feature.properties,
                                    id: territoryId, // 정규화된 ID로 통일
                                    pixelFillRatio: pixelFillRatio,
                                    filledPixels: filledPixels
                                }
                            }));
                        }
                        return f;
                    });
                    
                    const updatedGeoJson = {
                        type: 'FeatureCollection',
                        features: updatedFeatures
                    };
                    
                    // source 데이터 업데이트 (완전히 새로운 객체)
                    source.setData(updatedGeoJson);
                    
                    log.info(`✅ Source ${sourceId} data updated for territory ${territoryId} - ${filledPixels} pixels (${(pixelFillRatio * 100).toFixed(1)}% filled)`);
                    
                    // 맵 레이어 강제 업데이트 (다중 방법 시도)
                    const fillLayerId = `${sourceId}-fill`;
                    
                    // 방법 1: Mapbox setFeatureState로 직접 업데이트
                    try {
                        const featureId = feature.id || feature.properties.id || feature.properties.originalId || territoryId;
                        
                        // 여러 ID 형식으로 시도
                        const idsToTry = [feature.id, feature.properties.id, feature.properties.originalId, territoryId].filter(Boolean);
                        for (const idToTry of idsToTry) {
                            try {
                                this.map.setFeatureState(
                                    { source: sourceId, id: idToTry },
                                    {
                                        pixelFillRatio: pixelFillRatio,
                                        filledPixels: filledPixels,
                                        updated: Date.now()
                                    }
                                );
                                log.debug(`✅ Feature state set for ${territoryId} using ID: ${idToTry}`);
                                break; // 성공하면 중단
                            } catch (e) {
                                // 다음 ID 시도
                            }
                        }
                    } catch (e) {
                        log.warn(`Failed to set feature state:`, e);
                    }
                    
                    // 방법 2: 맵 강제 새로고침 (즉시)
                    this.map.triggerRepaint();
                    
                    // 방법 3: 레이어 paint 속성 직접 업데이트 (pixelFillRatio 기반 색상)
                    if (this.map.getLayer(fillLayerId)) {
                        // paint 속성 다시 읽어서 강제 재계산
                        const currentPaint = this.map.getPaintProperty(fillLayerId, 'fill-color');
                        
                        // 약간의 지연 후 강제 새로고침
                        setTimeout(() => {
                            // 레이어를 일시적으로 제거 후 다시 추가하여 강제 새로고침
                            const layerDef = this.map.getLayer(fillLayerId);
                            if (layerDef) {
                                // paint 속성 다시 설정
                                this.map.setPaintProperty(fillLayerId, 'fill-color', currentPaint);
                                
                                // 맵 줌을 미세하게 변경하여 강제 새로고침
                                const currentZoom = this.map.getZoom();
                                this.map.zoomTo(currentZoom + 0.0001, { duration: 0 });
                                setTimeout(() => {
                                    this.map.zoomTo(currentZoom, { duration: 0 });
                                    this.map.triggerRepaint();
                                    log.info(`🔄 Map fully refreshed for territory ${territoryId}`);
                                }, 50);
                            }
                        }, 100);
                    }
                    
                    break; // 첫 번째 매칭된 feature만 업데이트
                }
            }
            
            if (!found) {
                log.error(`❌ Territory ${territoryId} not found in any source!`);
                log.error(`Available sources: ${sources.join(', ')}`);
                log.error(`Territory info:`, {
                    id: territory.id,
                    name: territory.name,
                    pixelCanvas: territory.pixelCanvas
                });
                
                // 모든 source의 feature ID 목록 출력 (디버깅용)
                for (const sourceId of sources.slice(0, 3)) { // 처음 3개
                    const source = this.map.getSource(sourceId);
                    if (source && source.type === 'geojson' && source._data && source._data.features) {
                        const featureIds = source._data.features.slice(0, 5).map(f => ({
                            id: f.id,
                            propsId: f.properties?.id,
                            name: f.properties?.name
                        }));
                        log.warn(`Sample feature IDs from ${sourceId}:`, featureIds);
                    }
                }
                
                // Territory 정보 출력
                log.warn(`Territory info:`, {
                    id: territory.id,
                    name: territory.name,
                    pixelCanvas: territory.pixelCanvas
                });
            }
            
        } catch (error) {
            log.error('Failed to update territory layer visual:', error);
        }
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
     * Territory ID 정규화 - 이름 기반으로 일관된 ID 생성
     */
    normalizeTerritoryId(rawId, name, countryCode) {
        // 이름이 있으면 이름 기반 ID 생성
        if (name) {
            const normalizedName = String(name)
                .toLowerCase()
                .trim()
                .replace(/[^\w\s-]/g, '') // 특수문자 제거
                .replace(/\s+/g, '-')     // 공백을 하이픈으로
                .replace(/-+/g, '-')      // 연속 하이픈 제거
                .replace(/^-|-$/g, '');   // 시작/끝 하이픈 제거
            
            if (normalizedName) {
                return normalizedName;
            }
        }
        
        // 이름이 없거나 숫자 ID인 경우 원본 반환 (하지만 문자열로)
        return String(rawId || 'unknown');
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
            data.features = data.features.map((feature, index) => {
                const rawId = feature.properties?.id || feature.id || `${country}-${index}`;
                const name = feature.properties?.name || feature.properties?.NAME || feature.properties?.name_en || feature.properties?.NAME_1;
                const normalizedId = this.normalizeTerritoryId(rawId, name, country);
                
                return {
                    ...feature,
                    id: feature.id ?? index,
                    properties: {
                        ...feature.properties,
                        id: normalizedId,  // 정규화된 ID 사용
                        originalId: rawId, // 원본 ID 보존
                        name: name || feature.properties?.NAME || feature.properties?.name_en || `Region ${index + 1}`,
                        country: country,
                        sovereignty: feature.properties?.sovereignty || 'unconquered'
                    }
                };
            });
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
        // 경매 애니메이션 중지
        this.stopAuctionAnimation();
        
        for (const sourceId of this.activeLayerIds) {
            const fillLayerId = `${sourceId}-fill`;
            const lineLayerId = `${sourceId}-line`;
            const auctionGlowId = `${sourceId}-auction-glow`;
            const auctionBorderId = `${sourceId}-auction-border`;
            const auctionInnerId = `${sourceId}-auction-inner`;
            const ownedBorderId = `${sourceId}-owned-border`;
            
            try {
                // 모든 관련 레이어 제거
                const layersToRemove = [
                    fillLayerId, lineLayerId, 
                    auctionGlowId, auctionBorderId, auctionInnerId, 
                    ownedBorderId
                ];
                
                for (const layerId of layersToRemove) {
                    if (this.map.getLayer(layerId)) {
                        this.map.removeLayer(layerId);
                    }
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
        
        // 각 feature에 해시 기반 색상 추가 및 TerritoryManager 데이터 동기화
        if (geoJsonData && geoJsonData.features) {
            geoJsonData.features = geoJsonData.features.map(feature => {
                const name = feature.properties?.name || 
                             feature.properties?.NAME_1 || 
                             feature.properties?.NAME_2 ||
                             feature.properties?.id || 
                             feature.id || '';
                feature.properties.hashColor = this.stringToColor(name);
                
                // TerritoryManager에서 territory 데이터 가져와서 픽셀 정보 동기화
                const territoryId = feature.properties?.id || feature.id;
                if (territoryId) {
                    const territory = territoryManager.getTerritory(territoryId);
                    if (territory && territory.pixelCanvas) {
                        const filledPixels = territory.pixelCanvas.filledPixels || 0;
                        const width = territory.pixelCanvas.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                        const height = territory.pixelCanvas.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                        const totalPixels = width * height;
                        const pixelFillRatio = totalPixels > 0 ? filledPixels / totalPixels : 0;
                        
                        feature.properties.filledPixels = filledPixels;
                        feature.properties.pixelCanvasWidth = width;
                        feature.properties.pixelCanvasHeight = height;
                        feature.properties.pixelFillRatio = pixelFillRatio;
                        
                        if (territory.sovereignty) {
                            feature.properties.sovereignty = territory.sovereignty;
                        }
                    }
                }
                
                return feature;
            });
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
        // 픽셀 채움 비율에 따른 색상 변화 추가
        // 경매 중(contested)도 기본 색상 유지 - 테두리로만 구분
        // 미점유(unconquered) 영토는 국가별 고유 색상 사용
        this.map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            paint: {
                'fill-color': [
                    'case',
                    // 정복된 영토: 픽셀 채움 비율에 따라 색상 변화
                    ['==', ['get', 'sovereignty'], 'ruled'], [
                        'interpolate',
                        ['linear'],
                        ['coalesce', ['get', 'pixelFillRatio'], 0],
                        0, CONFIG.COLORS.SOVEREIGNTY.RULED,  // 0%: 기본 빨강
                        0.25, '#ff8c8c',  // 25%: 밝은 빨강
                        0.5, '#ffb347',   // 50%: 주황
                        0.75, '#ffd700',  // 75%: 금색
                        1, '#90ee90'      // 100%: 밝은 초록 (완성도 높음)
                    ],
                    ['==', ['get', 'sovereignty'], 'protected'], [
                        'interpolate',
                        ['linear'],
                        ['coalesce', ['get', 'pixelFillRatio'], 0],
                        0, CONFIG.COLORS.SOVEREIGNTY.RULED,
                        0.25, '#ff8c8c',
                        0.5, '#ffb347',
                        0.75, '#ffd700',
                        1, '#90ee90'
                    ],
                    // 미점유 & 경매중: 해당 지역 고유 색상 사용
                    ['coalesce', ['get', 'hashColor'], CONFIG.COLORS.SOVEREIGNTY.UNCONQUERED]
                ],
                'fill-opacity': [
                    'case',
                    ['boolean', ['feature-state', 'hover'], false], 0.7,
                    ['boolean', ['feature-state', 'selected'], false], 0.8,
                    0.5  // 위성 배경이 살짝 비치도록 투명도 낮춤
                ],
                // 애니메이션 효과: 색상 전환 시간 500ms
                'fill-color-transition': {
                    duration: 500,
                    delay: 0
                }
            }
        });
        
        // Border layer (기본) - 위성 배경에서 더 잘 보이도록 테두리 강화
        this.map.addLayer({
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#ffffff',
                'line-width': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], 4,
                    ['boolean', ['feature-state', 'hover'], false], 3,
                    1
                ],
                'line-opacity': 0.8
            }
        });
        
        // 경매 중 영역 - 글로우 효과 (외곽 후광)
        this.map.addLayer({
            id: `${sourceId}-auction-glow`,
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'sovereignty'], 'contested'],
            paint: {
                'line-color': '#ff6600',  // 주황색 글로우
                'line-width': 12,
                'line-opacity': 0.4,
                'line-blur': 4
            }
        });
        
        // 경매 중 영역 - 중간 테두리 (밝은 주황)
        this.map.addLayer({
            id: `${sourceId}-auction-border`,
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'sovereignty'], 'contested'],
            paint: {
                'line-color': '#ff9500',  // 밝은 주황색
                'line-width': 6,
                'line-opacity': 0.9
            }
        });
        
        // 경매 중 영역 - 내부 점선 (흰색)
        this.map.addLayer({
            id: `${sourceId}-auction-inner`,
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'sovereignty'], 'contested'],
            paint: {
                'line-color': '#ffffff',
                'line-width': 2,
                'line-opacity': 1,
                'line-dasharray': [4, 3]
            }
        });
        
        // 경매 중 영역 애니메이션 시작
        this.startAuctionAnimation(sourceId);
        
        // 소유된 영역 특별 테두리 (빨간색)
        this.map.addLayer({
            id: `${sourceId}-owned-border`,
            type: 'line',
            source: sourceId,
            filter: ['any', 
                ['==', ['get', 'sovereignty'], 'ruled'],
                ['==', ['get', 'sovereignty'], 'protected']
            ],
            paint: {
                'line-color': CONFIG.COLORS.SOVEREIGNTY.RULED,
                'line-width': 3,
                'line-opacity': 0.9
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
        
        // 국가 코드 추출: currentCountry > sourceId에서 추출 > feature.properties
        // sourceId 형식: 'territories-usa', 'states-usa', 'regions-south-korea', 'prefectures-japan'
        let countryCode = this.currentCountry;
        
        // sourceId에서 국가 코드 추출
        if (!countryCode && sourceId) {
            // 'territories-usa' -> 'usa'
            // 'states-usa' -> 'usa'
            // 'regions-south-korea' -> 'south-korea'
            const parts = sourceId.split('-');
            if (parts.length >= 2) {
                // 첫 번째 부분 (territories, states, regions, etc) 제거하고 나머지 합침
                countryCode = parts.slice(1).join('-');
            }
        }
        
        // feature.properties에서 국가 코드 추출 시도
        if (!countryCode && feature.properties) {
            countryCode = feature.properties.country || 
                         feature.properties.country_code ||
                         feature.properties.sov_a3?.toLowerCase();
        }
        
        // 최종 fallback: 'unknown'
        if (!countryCode || countryCode === 'unknown') {
            log.warn(`[MapController] Could not determine country code for sourceId: ${sourceId}, currentCountry: ${this.currentCountry}, feature.properties: ${JSON.stringify(feature.properties)}`);
            countryCode = 'unknown';
        } else {
            log.debug(`[MapController] Determined country code: ${countryCode} from sourceId: ${sourceId}, currentCountry: ${this.currentCountry}`);
        }
        
        // Territory ID 정규화 - 이름 기반으로 일관된 ID 생성
        const rawTerritoryId = feature.properties.id || feature.id;
        const territoryName = feature.properties.name || feature.properties.NAME_1 || feature.properties.NAME_2;
        const normalizedTerritoryId = this.normalizeTerritoryId(rawTerritoryId, territoryName, countryCode);
        
        // properties.id에 정규화된 ID 저장 (일관성 유지)
        feature.properties.id = normalizedTerritoryId;
        feature.properties.originalId = rawTerritoryId; // 원본 ID 보존
        
        eventBus.emit(EVENTS.TERRITORY_SELECT, {
            territoryId: normalizedTerritoryId,
            properties: feature.properties,
            geometry: feature.geometry,
            country: countryCode,
            featureId: feature.id,  // 원본 feature ID도 함께 전달
            sourceId: sourceId,     // source ID도 함께 전달
            originalId: rawTerritoryId // 원본 ID도 전달
        });
        
        log.debug(`🗺️ Territory selected: ${emittedTerritoryId} (feature.id: ${feature.id}) from source ${sourceId}`);
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
     * 경매 중 영역 펄스 애니메이션
     */
    startAuctionAnimation(sourceId) {
        const glowLayerId = `${sourceId}-auction-glow`;
        const borderLayerId = `${sourceId}-auction-border`;
        
        // 이미 애니메이션 중인지 확인
        if (this.auctionAnimationFrame) {
            cancelAnimationFrame(this.auctionAnimationFrame);
        }
        
        let startTime = null;
        const animate = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const elapsed = timestamp - startTime;
            
            // 2초 주기 펄스 (0.3 ~ 0.7 opacity)
            const pulse = 0.3 + 0.4 * Math.abs(Math.sin(elapsed / 1000 * Math.PI));
            
            // 글로우 레이어가 있으면 opacity 업데이트
            if (this.map && this.map.getLayer(glowLayerId)) {
                this.map.setPaintProperty(glowLayerId, 'line-opacity', pulse);
            }
            
            // 테두리 width 펄스 (5 ~ 8)
            const widthPulse = 5 + 3 * Math.abs(Math.sin(elapsed / 800 * Math.PI));
            if (this.map && this.map.getLayer(borderLayerId)) {
                this.map.setPaintProperty(borderLayerId, 'line-width', widthPulse);
            }
            
            this.auctionAnimationFrame = requestAnimationFrame(animate);
        };
        
        this.auctionAnimationFrame = requestAnimationFrame(animate);
    }
    
    /**
     * 경매 애니메이션 중지
     */
    stopAuctionAnimation() {
        if (this.auctionAnimationFrame) {
            cancelAnimationFrame(this.auctionAnimationFrame);
            this.auctionAnimationFrame = null;
        }
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
                
                // 월드뷰 영토 레이어 - 위성 배경이 비치도록 투명도 조정
                this.map.addLayer({
                    id: 'world-territories-fill',
                    type: 'fill',
                    source: 'world-territories',
                    paint: {
                        'fill-color': ['get', 'countryColor'],
                        'fill-opacity': [
                            'case',
                            ['boolean', ['feature-state', 'hover'], false], 0.7,
                            ['boolean', ['feature-state', 'selected'], false], 0.8,
                            0.5  // 위성 배경이 살짝 비치도록
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
                            ['boolean', ['feature-state', 'hover'], false], 2,
                            1  // 테두리 더 두껍게
                        ],
                        'line-opacity': 0.85  // 테두리 더 선명하게
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


