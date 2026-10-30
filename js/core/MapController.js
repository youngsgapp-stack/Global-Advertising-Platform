/**
 * MapController - 지도 제어 모듈
 * Mapbox GL JS 통합 및 지도 상호작용 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { territoryManager } from './TerritoryManager.js';
import { firebaseService } from '../services/FirebaseService.js';
import { initPixelMapRenderer3 } from './PixelMapRenderer3.js';
import { auctionSystem } from '../features/AuctionSystem.js';
import { resolveCollidingTerritoryId } from '../data/territory-id-collisions.js';

function polygonsOf(geometry) {
    if (geometry?.type === 'Polygon') return [geometry.coordinates];
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
    return [];
}

function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function pointInGeometry(point, geometry) {
    return polygonsOf(geometry).some(([outer, ...holes]) =>
        pointInRing(point, outer) && !holes.some(hole => pointInRing(point, hole)));
}

function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(area / 2);
}

function geometryArea(geometry) {
    return polygonsOf(geometry).reduce((sum, polygon) => sum + ringArea(polygon[0]), 0);
}

// 가장 큰 외곽선 안쪽의 한 점 (꼭짓점 평균이 바깥이면 마주보는 꼭짓점들의 중점 중 안쪽 점)
function representativePoint(geometry) {
    const outers = polygonsOf(geometry).map(polygon => polygon[0]);
    if (!outers.length) return null;
    const outer = outers.sort((a, b) => ringArea(b) - ringArea(a))[0];
    const center = outer.reduce((acc, [x, y]) => [acc[0] + x / outer.length, acc[1] + y / outer.length], [0, 0]);
    if (pointInRing(center, outer)) return center;
    const n = outer.length;
    for (let i = 0; i < n / 2; i++) {
        const a = outer[i];
        const b = outer[Math.floor(i + n / 2) % n];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInRing(mid, outer)) return mid;
    }
    return outer[0];
}

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
        // ⚠️ Step 5-4: 지연 로딩을 위한 추적
        this.lastQueryTime = 0; // 마지막 쿼리 시간
        this.lastQueryPosition = null; // 마지막 쿼리 위치 { center, zoom }
        this.queryDebounceTimer = null; // 쿼리 디바운스 타이머
        this.QUERY_DEBOUNCE_DELAY = 500; // 500ms 지연
        this.MIN_QUERY_DISTANCE = 0.01; // 최소 이동 거리 (도 단위)
        
        // ⚠️ 중요: Territory ID → Feature 인덱스 테이블
        // 이 테이블을 통해 O(1)로 feature를 찾을 수 있으며, 이름 기반 매칭 문제를 해결합니다.
        // Map<territoryId, { sourceId, featureId, feature }>
        this.territoryIndex = new Map();
        
        // 경매 애니메이션 프레임 ID
        this.auctionAnimationFrame = null;
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
                // [NEW] MAP_STYLE_LOADED 이벤트 발행 (Ready Gate용)
                eventBus.emit(EVENTS.MAP_STYLE_LOADED);
            });
            
            // 지도 로드 완료 대기
            await this.waitForMapLoad();
            this.map.on('idle', () => this.syncOwnedFeatureStates());
            eventBus.on(EVENTS.TERRITORY_UPDATE, () => setTimeout(() => this.syncOwnedFeatureStates(), 300));
            
            // 네비게이션 컨트롤 추가
            this.map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
            
            // 모바일 최적화
            this.initMobileOptimizations();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            // 경매 이벤트 리스너 설정
            this.setupAuctionEventListeners();
            
            // PixelMapRenderer3 초기화 (완전히 새로 구축된 맵 렌더링 시스템)
            this.pixelMapRenderer = initPixelMapRenderer3(this);
            
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
     * 주인이 있는 영토에 feature-state owned=true (땅 색을 칠하지 않는 데 사용)
     * idle마다 불리지만 바뀐 영토만 setFeatureState 하므로 가벼움
     */
    syncOwnedFeatureStates() {
        const source = this.map?.getSource('world-territories');
        const features = source?._data?.features;
        if (!features) return;
        const owned = new Set();
        for (const territory of territoryManager.territories?.values?.() || []) {
            if (territory?.ruler) owned.add(territory.id);
        }
        // 소스가 새로 만들어지면 feature-state가 사라지므로 처음부터 다시 표시
        if (this.ownedSourceData !== source._data) {
            this.ownedSourceData = source._data;
            this.ownedTerritoryIds = new Set();
        }
        const previous = this.ownedTerritoryIds;
        for (const feature of features) {
            const id = feature.properties?.id;
            if (feature.id == null || id == null) continue;
            const isOwned = owned.has(id);
            if (isOwned !== previous.has(id)) {
                this.map.setFeatureState({ source: 'world-territories', id: feature.id }, { owned: isOwned });
            }
        }
        this.ownedTerritoryIds = owned;
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
     * 모바일 최적화 설정
     */
    initMobileOptimizations() {
        if (!this.map) return;
        
        // 모바일 디바이스 감지
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        if (isMobile) {
            // 모바일에서 터치 제스처 최적화
            this.map.dragRotate = false; // 드래그 회전 비활성화
            this.map.touchZoomRotate = true; // 터치 줌/회전 활성화
            
            // 터치 이벤트 최적화
            this.map.touchPitch = false; // 터치 피치 비활성화
            
            log.info('[MapController] Mobile optimizations applied');
        }
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
        // ⚠️ Step 5-4: 지연 로딩 적용 (일정 시간/거리 이상 이동한 뒤에만 쿼리)
        this.map.on('moveend', () => {
            const center = this.map.getCenter();
            const zoom = this.map.getZoom();
            const bounds = this.map.getBounds();
            
            // ⚠️ Step 5-4: 지연 로딩 - 마지막 쿼리 이후 일정 시간/거리 이상 이동했을 때만 쿼리
            const now = Date.now();
            const timeSinceLastQuery = now - this.lastQueryTime;
            const shouldQuery = this.shouldTriggerQuery(center, zoom);
            
            if (shouldQuery) {
                // 디바운스: 500ms 안에 다시 움직이면 마지막 위치 기준 한 번만 실행
                if (this.queryDebounceTimer) {
                    clearTimeout(this.queryDebounceTimer);
                }
                
                this.queryDebounceTimer = setTimeout(() => {
                    this.lastQueryTime = Date.now();
                    this.lastQueryPosition = { center, zoom };
                    this.queryDebounceTimer = null;
                    
                    eventBus.emit(EVENTS.MAP_MOVE, {
                        center,
                        zoom,
                        bounds
                    });
                }, this.QUERY_DEBOUNCE_DELAY);
            } else {
                // 쿼리 없이 이벤트만 발행 (UI 업데이트용)
                eventBus.emit(EVENTS.MAP_MOVE, {
                    center,
                    zoom,
                    bounds
                });
            }
        });
        
        // 픽셀 캔버스 업데이트는 PixelMapRenderer에서 처리 (V2)
        // PixelMapRenderer가 이미 이벤트를 구독하고 있음
        
        // 영토 업데이트 이벤트 (일반적인 업데이트는 PixelMapRenderer가 처리)
    }
    
    /**
     * ⚠️ Step 5-4: 쿼리 트리거 여부 판단
     * 마지막 쿼리 이후 일정 시간/거리 이상 이동했을 때만 true 반환
     */
    shouldTriggerQuery(center, zoom) {
        const now = Date.now();
        const timeSinceLastQuery = now - this.lastQueryTime;
        
        // 첫 쿼리인 경우
        if (this.lastQueryTime === 0 || !this.lastQueryPosition) {
            return true;
        }
        
        // 마지막 쿼리 이후 5초 이상 지났는지 확인
        const MIN_QUERY_INTERVAL = 5000; // 5초
        if (timeSinceLastQuery >= MIN_QUERY_INTERVAL) {
            return true;
        }
        
        // 마지막 쿼리 위치에서 일정 거리 이상 이동했는지 확인
        const lastCenter = this.lastQueryPosition.center;
        if (lastCenter) {
            const distance = center.distanceTo(lastCenter);
            if (distance > this.MIN_QUERY_DISTANCE) {
                return true;
            }
        }
        
        // 줌 레벨이 일정 이상 변경되었는지 확인
        const lastZoom = this.lastQueryPosition.zoom;
        if (lastZoom !== undefined) {
            const zoomDiff = Math.abs(zoom - lastZoom);
            if (zoomDiff > 0.1) {
                return true;
            }
        }
        
        // 위 조건에 해당하지 않으면 쿼리 불필요
        return false;
    }
    
    /**
     * 픽셀 캔버스 업데이트 처리
     */
    handlePixelCanvasUpdate(data) {
        console.log('[MapController] handlePixelCanvasUpdate called:', data);
        const { territoryId, filledPixels, territory } = data;
        log.info(`[MapController] Pixel canvas updated - Territory: ${territoryId}, Filled Pixels: ${filledPixels}`);
        
        // territory 객체가 직접 전달되면 사용, 없으면 TerritoryManager에서 가져오기
        let targetTerritory = territory;
        if (!targetTerritory) {
            log.warn(`⚠️ Territory object not in event data, fetching from TerritoryManager...`);
            targetTerritory = territoryManager.getTerritory(territoryId);
        }
        
        // TerritoryManager에서 최신 정보로 업데이트 (sourceId, featureId 확보)
        if (!targetTerritory) {
            log.error(`❌ Territory ${territoryId} not found!`);
            return;
        }
        
        const latestTerritory = territoryManager.getTerritory(territoryId);
        if (latestTerritory) {
            // 최신 정보로 업데이트 (sourceId, featureId 중요!)
            targetTerritory = {
                ...targetTerritory,
                ...latestTerritory,
                pixelCanvas: targetTerritory.pixelCanvas || latestTerritory.pixelCanvas
            };
        }
        
        console.log(`[MapController] About to call updateTerritoryLayerVisual for: ${territoryId}`);
        console.log(`[MapController] Target territory:`, {
            id: targetTerritory.id,
            hasSourceId: !!targetTerritory.sourceId,
            sourceId: targetTerritory.sourceId,
            hasFeatureId: !!targetTerritory.featureId,
            featureId: targetTerritory.featureId,
            country: targetTerritory.country,
            filledPixels: targetTerritory.pixelCanvas?.filledPixels || filledPixels
        });
        
        log.info(`[MapController] Updating map visual for territory: ${territoryId}`);
        log.debug(`[MapController] Territory info:`, {
            id: targetTerritory.id,
            hasSourceId: !!targetTerritory.sourceId,
            sourceId: targetTerritory.sourceId,
            hasFeatureId: !!targetTerritory.featureId,
            featureId: targetTerritory.featureId,
            country: targetTerritory.country,
            filledPixels: targetTerritory.pixelCanvas?.filledPixels || filledPixels
        });
        
        // sourcesLoaded 동기화 (먼저 실행)
        this.syncSourcesLoaded();
        console.log(`[MapController] Sources after sync: ${Array.from(this.sourcesLoaded).join(', ') || '(none)'}`);
        log.debug(`[MapController] Sources after sync: ${Array.from(this.sourcesLoaded).join(', ') || '(none)'}`);
        
        // 즉시 업데이트 시도
        console.log(`[MapController] Calling updateTerritoryLayerVisual now...`);
        try {
            this.updateTerritoryLayerVisual(targetTerritory);
            console.log(`[MapController] updateTerritoryLayerVisual returned`);
        } catch (error) {
            console.error(`[MapController] Error in updateTerritoryLayerVisual:`, error);
            log.error(`[MapController] Error in updateTerritoryLayerVisual:`, error);
        }
        
        // source를 찾지 못한 경우 재시도 (맵이 로드될 때까지 기다림)
        // sourcesLoaded가 비어있거나, Territory에 sourceId가 없으면 재시도
        const needsRetry = this.sourcesLoaded.size === 0 || !targetTerritory.sourceId;
        if (needsRetry) {
            log.warn(`⚠️ No sources loaded yet or sourceId missing. Will retry map update after delay...`, {
                sourcesLoadedSize: this.sourcesLoaded.size,
                hasSourceId: !!targetTerritory.sourceId,
                country: targetTerritory.country
            });
            
            // 재시도 로직 (최대 3번, 1초 간격)
            let retryCount = 0;
            const maxRetries = 3;
            const retryInterval = 1000;
            
            const retryUpdate = () => {
                retryCount++;
                log.info(`🔄 Retrying map update for territory ${territoryId} (attempt ${retryCount}/${maxRetries})...`);
                
                // sourcesLoaded 동기화 시도
                this.syncSourcesLoaded();
                
                // 업데이트 다시 시도
                this.updateTerritoryLayerVisual(targetTerritory);
                
                // 아직도 실패하고 재시도 횟수가 남아있으면 계속
                if (retryCount < maxRetries && this.sourcesLoaded.size === 0) {
                    setTimeout(retryUpdate, retryInterval);
                } else if (this.sourcesLoaded.size === 0) {
                    log.error(`❌ Failed to find sources after ${maxRetries} retries`);
                }
            };
            
            setTimeout(retryUpdate, retryInterval);
        }
    }
    
    /**
     * 영토 레이어 시각적 업데이트 (픽셀 데이터 반영)
     */
    updateTerritoryLayerVisual(territory) {
        console.log('[MapController] updateTerritoryLayerVisual called:', {
            territoryId: territory?.id,
            hasMap: !!this.map,
            hasTerritory: !!territory,
            pixelCanvas: territory?.pixelCanvas
        });
        
        if (!this.map || !territory || !territory.id) {
            log.warn('[MapController] Cannot update: missing map, territory, or territory.id');
            return;
        }
        
        try {
            const territoryId = territory.id;
            console.log(`[MapController] Updating territory layer visual for: ${territoryId}`);
            log.info(`[MapController] Updating territory layer visual for: ${territoryId}`);
            
            // sourcesLoaded 동기화 (맵에 실제로 로드된 source 확인)
            if (this.sourcesLoaded.size === 0) {
                log.debug('sourcesLoaded is empty, syncing with map sources...');
                this.syncSourcesLoaded();
            }
            
            // 모든 territory source 찾기 (다양한 방법으로)
            let sources = Array.from(this.sourcesLoaded);
            
            // 방법 1: 맵의 모든 레이어에서 source 추출
            if (sources.length === 0) {
                try {
                    const mapStyle = this.map.getStyle();
                    if (mapStyle && mapStyle.layers) {
                        const sourceIdsFromLayers = new Set();
                        mapStyle.layers.forEach(layer => {
                            if (layer.source && layer.type === 'fill') {
                                sourceIdsFromLayers.add(layer.source);
                            }
                        });
                        sources = Array.from(sourceIdsFromLayers);
                        log.info(`✅ Found ${sources.length} sources from map layers: ${sources.join(', ')}`);
                    }
                } catch (e) {
                    log.warn('Failed to extract sources from layers:', e);
                }
            }
            
            // 방법 2: 맵 style의 모든 source 확인
            if (sources.length === 0) {
                log.warn(`sourcesLoaded is empty, checking all map sources for territory ${territoryId}...`);
                try {
                    const mapStyle = this.map.getStyle();
                    if (mapStyle && mapStyle.sources) {
                        // 모든 GeoJSON source 찾기
                        sources = Object.keys(mapStyle.sources).filter(sourceId => {
                            try {
                                const source = this.map.getSource(sourceId);
                                return source && source.type === 'geojson';
                            } catch (e) {
                                return false;
                            }
                        });
                        log.info(`✅ Found ${sources.length} geojson sources from map style: ${sources.join(', ')}`);
                    }
                } catch (error) {
                    log.error('Error checking map sources:', error);
                }
            }
            
            // 방법 3: 현재 국가 기반 source ID 예측
            if (sources.length === 0 && territory.country) {
                const countrySlug = territory.country.toLowerCase();
                const possibleSourceIds = [
                    `territories-${countrySlug}`,
                    `states-${countrySlug}`,
                    `regions-${countrySlug}`,
                    `prefectures-${countrySlug}`
                ];
                
                for (const possibleId of possibleSourceIds) {
                    try {
                        const source = this.map.getSource(possibleId);
                        if (source && source.type === 'geojson') {
                            sources.push(possibleId);
                            log.info(`✅ Found source by prediction: ${possibleId}`);
                        }
                    } catch (e) {
                        // Source가 없으면 무시
                    }
                }
            }
            
            // 방법 4: currentCountry 기반 source ID 예측
            if (sources.length === 0 && this.currentCountry) {
                const countrySlug = this.currentCountry.toLowerCase();
                const possibleSourceIds = [
                    `territories-${countrySlug}`,
                    `states-${countrySlug}`,
                    `regions-${countrySlug}`
                ];
                
                for (const possibleId of possibleSourceIds) {
                    try {
                        const source = this.map.getSource(possibleId);
                        if (source && source.type === 'geojson') {
                            sources.push(possibleId);
                            log.info(`✅ Found source by currentCountry: ${possibleId}`);
                        }
                    } catch (e) {
                        // Source가 없으면 무시
                    }
                }
            }
            
            // 방법 5: Territory에 저장된 sourceId 사용
            if (territory.sourceId) {
                try {
                    const source = this.map.getSource(territory.sourceId);
                    if (source && source.type === 'geojson') {
                        if (!sources.includes(territory.sourceId)) {
                            sources.unshift(territory.sourceId);
                        }
                        log.debug(`✅ Using stored sourceId: ${territory.sourceId}`);
                    }
                } catch (e) {
                    log.warn(`Stored sourceId ${territory.sourceId} not found on map`);
                }
            }
            
            log.debug(`Checking ${sources.length} sources for territory ${territoryId}: ${sources.join(', ')}`);
            
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
                    console.log(`[MapController] ✅ Feature found for ${territoryId} in source ${sourceId}`);
                    log.info(`[MapController] Feature found for territory ${territoryId} in source ${sourceId}`);
                    
                    // 픽셀 데이터로 속성 업데이트 (변수 범위를 넓게 설정)
                    const filledPixels = territory.pixelCanvas?.filledPixels || 0;
                    const width = territory.pixelCanvas?.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const height = territory.pixelCanvas?.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const totalPixels = width * height;
                    const pixelFillRatio = totalPixels > 0 ? filledPixels / totalPixels : 0;
                    
                    console.log(`[MapController] Pixel data: ${filledPixels} pixels, ratio: ${(pixelFillRatio * 100).toFixed(1)}%`);
                    
                    if (territory.pixelCanvas) {
                        // 속성 업데이트
                        feature.properties.filledPixels = filledPixels;
                        feature.properties.pixelCanvasWidth = width;
                        feature.properties.pixelCanvasHeight = height;
                        feature.properties.pixelFillRatio = pixelFillRatio;
                        feature.properties.pixelCanvasUpdated = Date.now();
                        
                        log.info(`Updated feature properties: ${filledPixels} pixels (${(pixelFillRatio * 100).toFixed(1)}% filled)`);
                    }
                    
                    // sovereignty 업데이트 - 픽셀 데이터가 있으면 반드시 'ruled'로 설정 (색상 변경을 위해 필수!)
                    // sovereignty가 없거나 픽셀을 그린 territory는 'ruled'로 설정하여 색상 변화 활성화
                    if (filledPixels > 0) {
                        feature.properties.sovereignty = territory.sovereignty || 'ruled';
                        console.log(`[MapController] Set sovereignty to '${feature.properties.sovereignty}' for ${territoryId} (has ${filledPixels} pixels)`);
                    } else if (territory.sovereignty) {
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
                                    filledPixels: filledPixels,
                                    // sovereignty를 확실히 설정 (색상 변경을 위해 필수)
                                    sovereignty: feature.properties.sovereignty || (filledPixels > 0 ? 'ruled' : f.properties.sovereignty)
                                }
                            }));
                        }
                        return f;
                    });
                    
                    const updatedGeoJson = {
                        type: 'FeatureCollection',
                        features: updatedFeatures
                    };
                    
                    // ===== 옵션 1: 레이어 완전 재생성 방식 (가장 확실한 방법) =====
                    const fillLayerId = `${sourceId}-fill`;
                    
                    // 1단계: Source 데이터 업데이트
                    source.setData(updatedGeoJson);
                    
                    console.log(`[MapController] ✅ Source ${sourceId} updated - ${filledPixels} pixels (${(pixelFillRatio * 100).toFixed(1)}%), sovereignty: ${feature.properties.sovereignty}`);
                    log.info(`[MapController] Source ${sourceId} updated for ${territoryId}`);
                    
                    // 2단계: Fill 레이어 완전히 제거 후 재생성 (가장 확실한 방법)
                    if (this.map.getLayer(fillLayerId)) {
                        console.log(`[MapController] Removing layer ${fillLayerId} for recreation...`);
                        
                        // 레이어 순서 유지를 위해 다음 레이어 ID 찾기
                        const style = this.map.getStyle();
                        const layerIndex = style.layers.findIndex(l => l.id === fillLayerId);
                        let beforeLayer = null;
                        
                        // 현재 레이어 다음에 오는 레이어 찾기
                        if (layerIndex >= 0 && layerIndex < style.layers.length - 1) {
                            for (let i = layerIndex + 1; i < style.layers.length; i++) {
                                const nextLayer = style.layers[i];
                                if (nextLayer.source === sourceId || nextLayer.id.startsWith(sourceId + '-')) {
                                    beforeLayer = nextLayer.id;
                                    break;
                                }
                            }
                        }
                        
                        // 레이어 제거
                        this.map.removeLayer(fillLayerId);
                        console.log(`[MapController] Layer ${fillLayerId} removed`);
                        
                        // 3단계: Source 데이터 업데이트 완료 대기 후 레이어 재생성
                        source.once('data', () => {
                            console.log(`[MapController] Source data event fired, recreating layer...`);
                            
                            // 짧은 지연 후 레이어 재생성 (Mapbox가 source 업데이트를 완전히 처리하도록)
                            setTimeout(() => {
                                try {
                                    // Fill 레이어 재생성 (addTerritoryLayer와 동일한 정의 사용)
                                    this.map.addLayer({
                                        id: fillLayerId,
                                        type: 'fill',
                                        source: sourceId,
                                        paint: {
                                            'fill-color': [
                                                'case',
                                                ['==', ['get', 'sovereignty'], 'ruled'], [
                                                    'interpolate',
                                                    ['linear'],
                                                    ['coalesce', ['get', 'pixelFillRatio'], 0],
                                                    0, CONFIG.COLORS.SOVEREIGNTY.RULED,
                                                    0.25, '#ff8c8c',
                                                    0.5, '#ffb347',
                                                    0.75, '#ffd700',
                                                    1, '#90ee90'
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
                                                // 미점유 & 경매중: 해당 지역 고유 색상 사용 (countryColor 우선, 없으면 hashColor, 그것도 없으면 기본 색상)
                                                ['coalesce', 
                                                    ['get', 'countryColor'], 
                                                    ['get', 'hashColor'], 
                                                    CONFIG.COLORS.SOVEREIGNTY.UNCONQUERED
                                                ]
                                            ],
                                            'fill-opacity': [
                                                'case',
                                                // 주인이 있는 땅은 나라 색을 칠하지 않음 (지도가 그대로 보이게)
                                                ['boolean', ['feature-state', 'owned'], false], 0,
                                                // hasPixelArt가 true면 배경색 완전히 투명 (픽셀 아트만 표시)
                                                ['boolean', ['feature-state', 'hasPixelArt'], false], 0,
                                                // 픽셀 아트가 없는 경우: hover/selected 상태에 따라 투명도 조절
                                                ['boolean', ['feature-state', 'hover'], false], 0.7,
                                                ['boolean', ['feature-state', 'selected'], false], 0.8,
                                                0.5  // 기본: 위성 배경이 살짝 비치도록 투명도 낮춤
                                            ],
                                            'fill-color-transition': {
                                                duration: 500,
                                                delay: 0
                                            }
                                        }
                                    }, beforeLayer);
                                    
                                    console.log(`[MapController] ✅ Layer ${fillLayerId} recreated`);
                                    
                                    // 레이어 재생성 후 맵 강제 새로고침
                                    this.map.triggerRepaint();
                                    
                                    // 렌더링 완료 확인
                                    this.map.once('render', () => {
                                        console.log(`[MapController] ✅✅✅ Map render completed - visual update SHOULD BE VISIBLE NOW! ✅✅✅`);
                                        log.info(`[MapController] Territory ${territoryId} visual update completed`);
                                    });
                                } catch (error) {
                                    console.error(`[MapController] ❌ Failed to recreate layer:`, error);
                                    log.error(`[MapController] Failed to recreate layer ${fillLayerId}:`, error);
                                }
                            }, 100); // 100ms 지연
                        });
                    } else {
                        // 레이어가 없으면 단순히 맵 새로고침
                        source.once('data', () => {
                            this.map.triggerRepaint();
                        });
                    }
                    
                    // 즉시 맵 새로고침 (이벤트와 병행)
                    this.map.triggerRepaint();
                    
                    break; // 첫 번째 매칭된 feature만 업데이트
                }
            }
            
            if (!found) {
                log.error(`❌ Territory ${territoryId} not found in any source!`);
                log.error(`Available sources: ${sources.length > 0 ? sources.join(', ') : '(none)'}`);
                log.error(`Territory info:`, {
                    id: territory.id,
                    name: territory.name,
                    country: territory.country,
                    sourceId: territory.sourceId,
                    featureId: territory.featureId,
                    pixelCanvas: territory.pixelCanvas
                });
                
                // sourcesLoaded 상태 확인
                log.warn(`sourcesLoaded set: ${Array.from(this.sourcesLoaded).join(', ') || '(empty)'}`);
                log.warn(`currentCountry: ${this.currentCountry}`);
                
                // 모든 source의 feature ID 목록 출력 (디버깅용)
                if (sources.length > 0) {
                    for (const sourceId of sources.slice(0, 5)) {
                        const source = this.map.getSource(sourceId);
                        if (source && source.type === 'geojson' && source._data && source._data.features) {
                            const featureIds = source._data.features.slice(0, 10).map(f => ({
                                id: f.id,
                                propsId: f.properties?.id,
                                name: f.properties?.name,
                                originalId: f.properties?.originalId
                            }));
                            log.warn(`Sample feature IDs from ${sourceId} (${source._data.features.length} features):`, featureIds);
                            
                            // territoryId와 유사한 이름 찾기
                            const similarFeatures = source._data.features.filter(f => {
                                const name = String(f.properties?.name || '').toLowerCase();
                                const id = String(f.properties?.id || f.id || '').toLowerCase();
                                const territoryIdLower = String(territoryId).toLowerCase();
                                return name.includes(territoryIdLower) || 
                                       territoryIdLower.includes(name) ||
                                       id.includes(territoryIdLower) ||
                                       territoryIdLower.includes(id);
                            });
                            if (similarFeatures.length > 0) {
                                log.warn(`Similar features in ${sourceId}:`, similarFeatures.slice(0, 3).map(f => ({
                                    id: f.id,
                                    propsId: f.properties?.id,
                                    name: f.properties?.name
                                })));
                            }
                        }
                    }
                } else {
                    // source가 없으면 재시도 로직
                    log.warn(`⚠️ No sources found. Will retry in 2 seconds...`);
                    setTimeout(() => {
                        log.info(`🔄 Retrying map update for territory ${territoryId}...`);
                        this.updateTerritoryLayerVisual(territory);
                    }, 2000);
                    
                    // 맵의 모든 source 나열
                    try {
                        const mapStyle = this.map.getStyle();
                        if (mapStyle && mapStyle.sources) {
                            const allSources = Object.keys(mapStyle.sources);
                            log.warn(`All sources on map (${allSources.length}):`, allSources);
                            
                            // 모든 레이어에서 source 추출
                            if (mapStyle.layers) {
                                const layerSources = new Set();
                                mapStyle.layers.forEach(layer => {
                                    if (layer.source) {
                                        layerSources.add(layer.source);
                                    }
                                });
                                log.warn(`All sources from layers (${layerSources.size}):`, Array.from(layerSources));
                            }
                        }
                    } catch (e) {
                        log.error('Failed to get map sources:', e);
                    }
                }
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
        if (this.globalAdminLoadPromise) {
            return this.globalAdminLoadPromise;
        }
        this.globalAdminLoadPromise = this.fetchGlobalAdminData().finally(() => {
            this.globalAdminLoadPromise = null;
        });
        return this.globalAdminLoadPromise;
    }
    
    /**
     * Natural Earth Admin 1 데이터 다운로드
     * 사이트에 올린 경량본(경계 극점 보존 단순화 + 사용하는 속성만, 원본과 feature 순서/이름 동일)을 우선 사용하고,
     * 실패하면 원본(약 40MB)으로 대체
     */
    async fetchGlobalAdminData() {
        const sources = [
            { url: '/data/world-admin1.v1.json', timeoutMs: 60000 },
            { url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson', timeoutMs: 90000 }
        ];
        
        for (const { url, timeoutMs } of sources) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    log.info(`Loading global admin boundaries from ${url} (attempt ${attempt})`);
                    const response = await fetch(url, { signal: controller.signal, cache: 'default' });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const data = await response.json();
                    if (!Array.isArray(data?.features) || data.features.length === 0) {
                        throw new Error('Empty admin boundaries data');
                    }
                    this.globalAdminData = data;
                    this.globalAdminLoaded = true;
                    log.info(`Global admin data loaded: ${data.features.length} regions`);
                    return data;
                } catch (error) {
                    log.warn(`Failed to load global admin data from ${url} (attempt ${attempt}):`, error.name === 'AbortError' ? 'timeout' : error.message);
                    if (attempt < 2) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } finally {
                    clearTimeout(timeoutId);
                }
            }
        }
        
        log.error('Failed to load global admin data from all sources');
        return null;
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
        
        // 정규화된 GeoJSON 반환 (territory ID는 세계 화면과 같은 규칙으로 생성)
        return {
            type: 'FeatureCollection',
            features: filtered.map((feature, index) => {
                const globalIndex = this.globalAdminData.features.indexOf(feature);
                return {
                    ...feature,
                    id: index,
                    properties: {
                        ...feature.properties,
                        id: this.getWorldTerritoryId(feature, globalIndex),
                        name: feature.properties.name || feature.properties.name_en || feature.properties.admin || `Region ${index + 1}`,
                        country: countryCode,
                        sovereignty: 'unconquered'
                    }
                };
            })
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
                    await this.alignLocalIdsWithWorld(normalized, country);
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
     * 로컬 GeoJSON(미국/한국/일본)의 지역을 세계 지도(Natural Earth) 지역과 짝지어 같은 territory ID를 사용
     * (한국 파일은 한글 이름이라 이름 기반 ID가 비고, 일본 파일은 이름이 없어 DB ID와 맞지 않음)
     * 이름(영/한/일/현지어)으로 먼저 찾고, 없으면 대표 지점을 포함하는 가장 작은 지역으로 찾음
     */
    async alignLocalIdsWithWorld(data, country) {
        const iso = { usa: 'USA', 'south-korea': 'KOR', japan: 'JPN' }[country];
        if (!iso || !data?.features) return;
        await this.loadGlobalAdminData();
        if (!this.globalAdminData) return;
        
        const candidates = [];
        this.globalAdminData.features.forEach((feature, index) => {
            if (feature.properties?.adm0_a3 === iso) candidates.push({ feature, index });
        });
        
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
        for (const feature of data.features) {
            const p = feature.properties || {};
            const localNames = [p.name, p.NAME, p.name_en, p.NAME_1, p.nam, p.nam_ja].filter(Boolean).map(norm);
            let match = candidates.find(({ feature: w }) => {
                const wp = w.properties;
                return [wp.name, wp.name_en, wp.name_ko, wp.name_ja, wp.name_local, wp.woe_name]
                    .filter(Boolean).map(norm).some(n => localNames.includes(n));
            });
            if (!match) {
                const point = representativePoint(feature.geometry);
                match = point && candidates
                    .filter(({ feature: w }) => pointInGeometry(point, w.geometry))
                    .sort((a, b) => geometryArea(a.feature.geometry) - geometryArea(b.feature.geometry))[0];
            }
            if (match) {
                const id = this.getWorldTerritoryId(match.feature, match.index);
                feature.properties.id = id;
                feature.properties.territoryId = id;
            }
        }
    }
    
    /**
     * Natural Earth admin-1 feature의 territory ID (DB 기본키와 동일)
     * 세계 화면과 국가 화면이 반드시 이 함수로 ID를 만들어야 같은 영토를 가리킴
     * @param {object} feature - globalAdminData의 feature
     * @param {number} globalIndex - globalAdminData.features 내 인덱스
     */
    getWorldTerritoryId(feature, globalIndex) {
        const props = feature.properties || {};
        const name = props.name || props.name_en || `Region ${globalIndex}`;
        const baseId = this.normalizeTerritoryId(props.id || feature.id || `world-${globalIndex}`, name);
        return resolveCollidingTerritoryId(baseId, props.adm0_a3);
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
     * 
     * ⚠️ 중요: 각 feature에 새로운 Territory ID 형식("COUNTRY_ISO3::ADMIN_CODE")을 생성합니다.
     * 이는 이름 기반 매칭 문제를 해결하기 위한 핵심 변경사항입니다.
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
                
                // 새로운 Territory ID 생성 시도 (COUNTRY_ISO3::ADMIN_CODE 형식)
                let territoryId = null;
                let legacyId = null;
                let countryIso = null;
                
                // TerritoryIdUtils를 사용하여 새로운 ID 생성
                try {
                    const props = feature.properties || {};
                    
                    // 1. countryIso 추출 (adm0_a3 우선)
                    countryIso = props.adm0_a3 || props.country_code || props.iso_a3;
                    if (countryIso) {
                        countryIso = String(countryIso).toUpperCase().trim();
                        
                        // 2. adminCode 추출 (우선순위: adm1_code > ne_id > gid > id)
                        let adminCode = props.adm1_code || props.ne_id || props.gid || props.id || feature.id;
                        
                        if (countryIso.length === 3 && adminCode) {
                            adminCode = String(adminCode).trim();
                            territoryId = `${countryIso}::${adminCode}`;
                            
                            // Legacy ID 생성 (이름 기반)
                            if (name) {
                                legacyId = String(name)
                                    .toLowerCase()
                                    .trim()
                                    .replace(/[^\w\s-]/g, '')
                                    .replace(/\s+/g, '-')
                                    .replace(/-+/g, '-')
                                    .replace(/^-|-$/g, '');
                            }
                            
                            log.debug(`[MapController] Created new Territory ID: ${territoryId} (legacy: ${legacyId || 'N/A'})`);
                        }
                    }
                } catch (error) {
                    log.warn(`[MapController] Failed to create Territory ID from feature:`, error);
                }
                
                // Territory ID 생성 실패 시 기존 방식 사용 (하위 호환)
                if (!territoryId) {
                    territoryId = this.normalizeTerritoryId(rawId, name, country);
                    legacyId = territoryId; // 기존 방식은 legacy ID와 동일
                }
                
                // 색상 생성 (지역 이름 및 국가 코드 기반)
                const finalName = name || feature.properties?.NAME || feature.properties?.name_en || `Region ${index + 1}`;
                const countryCode = countryIso || country || 'unknown';
                const hashColor = this.stringToColor(finalName);
                const countryColor = this.stringToColor(countryCode);
                
                return {
                    ...feature,
                    id: feature.id ?? index,
                    properties: {
                        ...feature.properties,
                        territoryId: territoryId,  // 새로운 Territory ID (COUNTRY_ISO3::ADMIN_CODE)
                        id: legacyId || territoryId,  // 하위 호환을 위한 기존 ID (legacy)
                        originalId: rawId, // 원본 ID 보존
                        name: finalName,
                        country: country,
                        countryCode: countryCode,
                        hashColor: hashColor,  // 지역 이름 기반 색상
                        countryColor: countryColor,  // 국가 코드 기반 색상
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
    /**
     * Territory ID로 Feature 조회 (O(1) 인덱스 테이블 사용)
     * 
     * ⚠️ 중요: 이 메서드는 이름 기반 매칭 대신 인덱스 테이블을 사용하여
     * 정확하고 빠르게 feature를 찾습니다.
     * 
     * @param {string} territoryId - Territory ID (새로운 형식: "SGP::ADM1_003" 또는 legacy: "south-east")
     * @returns {{ sourceId: string, featureId: string|number, feature: object } | null}
     */
    getTerritoryFeature(territoryId) {
        if (!territoryId) {
            return null;
        }
        
        // 인덱스 테이블에서 직접 조회 (O(1))
        const indexEntry = this.territoryIndex.get(territoryId);
        if (indexEntry) {
            log.debug(`[MapController] Found territory in index: ${territoryId} -> ${indexEntry.sourceId}:${indexEntry.featureId}`);
            return indexEntry;
        }
        
        // 인덱스에 없으면 null 반환 (이름 기반 매칭은 더 이상 사용하지 않음)
        log.debug(`[MapController] Territory not found in index: ${territoryId}`);
        return null;
    }
    
    /**
     * Territory ID 인덱스 테이블 초기화
     * 모든 소스가 제거될 때 인덱스도 함께 초기화
     */
    clearTerritoryIndex() {
        this.territoryIndex.clear();
        log.debug('[MapController] Territory index cleared');
    }
    
    clearAllTerritoryLayers() {
        // 경매 애니메이션 중지
        this.stopAuctionAnimation();
        
        // Territory 인덱스 테이블도 초기화
        this.clearTerritoryIndex();
        
        // 먼저 모든 레이어를 찾아서 제거 (Source를 사용하는 모든 레이어)
        const layersToRemove = [];
        const sourcesToRemove = new Set();
        
        // activeLayerIds에 있는 Source들
        for (const sourceId of this.activeLayerIds) {
            sourcesToRemove.add(sourceId);
            
            // 각 Source에 연결된 모든 레이어 ID 생성
            const layerIds = [
                `${sourceId}-fill`,
                `${sourceId}-line`,
                `${sourceId}-auction-glow`,
                `${sourceId}-auction-border`,
                `${sourceId}-auction-inner`,
                `${sourceId}-auction-pulse`,  // 추가: auction-pulse 레이어
                `${sourceId}-owned-border`
            ];
            
            layersToRemove.push(...layerIds);
        }
        
        // 맵에 있는 모든 레이어를 확인하여 해당 Source를 사용하는 레이어도 찾기
        const style = this.map.getStyle();
        if (style && style.layers) {
            for (const layer of style.layers) {
                // activeLayerIds에 있는 Source를 사용하는 레이어 찾기
                if (layer.source && sourcesToRemove.has(layer.source)) {
                    if (!layersToRemove.includes(layer.id)) {
                        layersToRemove.push(layer.id);
                    }
                }
                // 레이어 ID가 sourceId로 시작하는 경우도 확인
                for (const sourceId of sourcesToRemove) {
                    if (layer.id && layer.id.startsWith(sourceId)) {
                        if (!layersToRemove.includes(layer.id)) {
                            layersToRemove.push(layer.id);
                        }
                    }
                }
            }
        }
        
        // 모든 레이어 제거 (Source 제거 전에)
                for (const layerId of layersToRemove) {
            try {
                    if (this.map.getLayer(layerId)) {
                        this.map.removeLayer(layerId);
                }
            } catch (e) {
                log.warn(`Failed to remove layer ${layerId}:`, e);
                    }
                }
                
        // 모든 Source 제거 (레이어 제거 후)
        for (const sourceId of sourcesToRemove) {
            try {
                if (this.map.getSource(sourceId)) {
                    this.map.removeSource(sourceId);
                }
            } catch (e) {
                log.warn(`Failed to remove source ${sourceId}:`, e);
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
        // 다른 나라 행정구역 표시 유지를 위해 clearAllTerritoryLayers 제거
        // In Country View mode, clear previous layers first
        // if (this.viewMode === 'country' && !sourceId.startsWith('world-')) {
        //     this.clearAllTerritoryLayers();
        // }
        
        // 각 feature에 해시 기반 색상 추가 및 TerritoryManager 데이터 동기화
        // 핵심: GeoJSON 단계에서 territoryId를 명시적으로 심고, TerritoryManager에 매핑 확립
        if (geoJsonData && geoJsonData.features) {
            geoJsonData.features = geoJsonData.features.map((feature, index) => {
                // 1. territoryId 확정 (명시적으로 설정)
                let territoryId = feature.properties?.id || feature.id;
                
                // territoryId가 없거나 숫자만 있으면 정규화
                if (!territoryId || String(territoryId).match(/^\d+$/)) {
                    const name = feature.properties?.name || 
                                 feature.properties?.NAME_1 || 
                                 feature.properties?.NAME_2 ||
                                 feature.properties?.name_en ||
                                 '';
                    if (name) {
                        territoryId = this.normalizeTerritoryId(territoryId || '', name, feature.properties?.country || '');
                    } else {
                        territoryId = territoryId || `${sourceId}-${index}`;
                    }
                }
                
                // 2. feature.id 확정 (Mapbox가 사용하는 ID)
                const featureId = feature.id ?? index;
                
                // 3. properties에 territoryId 명시적으로 설정 (항상)
                feature.properties = feature.properties || {};
                
                // 새로운 Territory ID 형식이 있으면 우선 사용 (properties.territoryId는 normalizeGeoJson에서 생성됨)
                const featureNewTerritoryId = feature.properties?.territoryId;
                let finalTerritoryId = territoryId;
                
                if (featureNewTerritoryId && featureNewTerritoryId.includes('::')) {
                    // 새로운 형식 사용
                    feature.properties.id = featureNewTerritoryId;
                    feature.properties.territoryId = featureNewTerritoryId;
                    feature.properties.legacyId = territoryId;  // 하위 호환을 위한 legacy ID 보존
                    finalTerritoryId = featureNewTerritoryId;
                } else {
                    // Legacy 형식 사용
                    feature.properties.id = territoryId;
                    feature.properties.territoryId = territoryId;
                }
                
                // 4. feature.id도 설정 (Mapbox 매칭용)
                feature.id = featureId;
                
                // 5. 색상 설정 (지역 이름 및 국가 코드 기반)
                const name = feature.properties.name || 
                             feature.properties.NAME_1 || 
                             feature.properties.NAME_2 ||
                             finalTerritoryId;
                const countryCode = feature.properties?.country || 
                                   feature.properties?.countryCode || 
                                   feature.properties?.country_iso || 
                                   'unknown';
                
                // hashColor와 countryColor 모두 설정 (이중 폴백 보장)
                feature.properties.hashColor = this.stringToColor(name);
                feature.properties.countryColor = this.stringToColor(countryCode);
                
                // 6. TerritoryManager에 매핑 확립 (핵심!)
                let territory = territoryManager.getTerritory(finalTerritoryId);
                if (!territory) {
                    // TerritoryManager에 없는 경우 생성
                    territory = territoryManager.createTerritoryFromProperties(
                        finalTerritoryId,
                        feature.properties
                    );
                    territoryManager.territories.set(finalTerritoryId, territory);
                }
                
                // 7. sourceId/featureId 매핑 확립 (항상 업데이트)
                territory.sourceId = sourceId;
                territory.featureId = featureId;
                territory.geometry = feature.geometry;
                territory.properties = feature.properties;
                
                // 7-1. Territory ID 인덱스 테이블에 추가 (새로운 Territory ID 체계)
                // 새로운 형식이면 인덱스에 추가
                if (featureNewTerritoryId && featureNewTerritoryId.includes('::')) {
                    this.territoryIndex.set(featureNewTerritoryId, {
                        sourceId: sourceId,
                        featureId: featureId,
                        feature: feature,
                        legacyId: territoryId  // 하위 호환을 위한 legacy ID
                    });
                    log.debug(`[MapController] Added to territoryIndex: ${featureNewTerritoryId} -> ${sourceId}:${featureId}`);
                }
                
                // Legacy ID도 인덱스에 추가 (하위 호환)
                if (territoryId && territoryId !== featureNewTerritoryId) {
                    this.territoryIndex.set(territoryId, {
                        sourceId: sourceId,
                        featureId: featureId,
                        feature: feature,
                        newTerritoryId: featureNewTerritoryId  // 새로운 ID 참조
                    });
                }
                
                // 8. 픽셀 정보 동기화 (TerritoryManager에서)
                if (territory.pixelCanvas) {
                    const filledPixels = territory.pixelCanvas.filledPixels || 0;
                    const width = territory.pixelCanvas.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const height = territory.pixelCanvas.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
                    const totalPixels = width * height;
                    const pixelFillRatio = totalPixels > 0 ? filledPixels / totalPixels : 0;
                    
                    feature.properties.filledPixels = filledPixels;
                    feature.properties.pixelCanvasWidth = width;
                    feature.properties.pixelCanvasHeight = height;
                    feature.properties.pixelFillRatio = pixelFillRatio;
                }
                
                // 9. sovereignty 동기화
                if (territory.sovereignty) {
                    feature.properties.sovereignty = territory.sovereignty;
                }
                
                log.debug(`[MapController] Established mapping: territoryId=${territoryId}, sourceId=${sourceId}, featureId=${featureId}`);
                
                return feature;
            });
        }
        
        // If source already exists, update it
        if (this.map.getSource(sourceId)) {
            this.map.getSource(sourceId).setData(geoJsonData);
            // source가 이미 존재해도 sourcesLoaded에 추가 (중요!)
            if (!this.sourcesLoaded.has(sourceId)) {
                this.sourcesLoaded.add(sourceId);
                log.debug(`Added existing source to sourcesLoaded: ${sourceId}`);
            }
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
                    // 정복된 영토: 픽셀 채움 비율에 따라 색상 변화 (Feature State + Properties 모두 지원)
                    ['==', ['get', 'sovereignty'], 'ruled'], [
                        'interpolate',
                        ['linear'],
                        [
                            'coalesce',
                            ['feature-state', 'pixelFillRatio'],  // Feature State 우선
                            ['get', 'pixelFillRatio'],              // Properties 폴백
                            0
                        ],
                        0, CONFIG.COLORS.SOVEREIGNTY.RULED,  // 0%: 기본 빨강
                        0.25, '#ff8c8c',  // 25%: 밝은 빨강
                        0.5, '#ffb347',   // 50%: 주황
                        0.75, '#ffd700',  // 75%: 금색
                        1, '#90ee90'      // 100%: 밝은 초록 (완성도 높음)
                    ],
                    ['==', ['get', 'sovereignty'], 'protected'], [
                        'interpolate',
                        ['linear'],
                        [
                            'coalesce',
                            ['feature-state', 'pixelFillRatio'],
                            ['get', 'pixelFillRatio'],
                            0
                        ],
                        0, CONFIG.COLORS.SOVEREIGNTY.RULED,
                        0.25, '#ff8c8c',
                        0.5, '#ffb347',
                        0.75, '#ffd700',
                        1, '#90ee90'
                    ],
                    // 미점유 & 경매중: 해당 지역 고유 색상 사용 (countryColor 우선, 없으면 hashColor, 그것도 없으면 기본 색상)
                    ['coalesce', 
                        ['get', 'countryColor'], 
                        ['get', 'hashColor'], 
                        CONFIG.COLORS.SOVEREIGNTY.UNCONQUERED
                    ]
                ],
                'fill-opacity': [
                    'case',
                    // 주인이 있는 땅은 나라 색을 칠하지 않음 (지도가 그대로 보이게)
                    ['boolean', ['feature-state', 'owned'], false], 0,
                    // 전문가 조언 반영: properties 기반 접근 (feature-state와 병행)
                    // properties.hasPixelArt를 우선 확인 (더 안정적)
                    ['boolean', ['get', 'hasPixelArt'], false], 0,
                    // feature-state도 확인 (호환성 유지)
                    ['boolean', ['feature-state', 'hasPixelArt'], false], 0,
                    // 픽셀 아트가 없는 경우: hover/selected 상태에 따라 투명도 조절
                    ['boolean', ['feature-state', 'hover'], false], 0.7,
                    ['boolean', ['feature-state', 'selected'], false], 0.8,
                    0.5  // 기본: 위성 배경이 살짝 비치도록 투명도 낮춤
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
        
        // 경매 중 영역 - 경계선만 표시 (line layer)
        // ⚠️ 사용자 요청: 전체를 주황색으로 덮지 않고 경계선만 표시
        // 특히 그 지역을 클릭했을 때만 경매 중이면 지역 경계선만 약간 티나는 정도로만 표시
        this.map.addLayer({
            id: `${sourceId}-auction-border`,
            type: 'line',
            source: sourceId,
            filter: ['==', ['get', 'auctionStatus'], 'active'],  // 경매 중만 표시
            paint: {
                'line-color': '#ff6600',  // 주황색
                'line-width': [
                    'case',
                    // 선택된 territory일 때만 경계선 표시 (약간 두껍게)
                    ['boolean', ['feature-state', 'selected'], false], 2.5,
                    // hover 상태일 때도 약간 표시
                    ['boolean', ['feature-state', 'hover'], false], 1.5,
                    // 기본: 거의 보이지 않게 (0.5px)
                    0.5
                ],
                'line-opacity': [
                    'case',
                    // 선택된 territory일 때만 선명하게 표시
                    ['boolean', ['feature-state', 'selected'], false], 0.8,
                    // hover 상태일 때도 약간 표시
                    ['boolean', ['feature-state', 'hover'], false], 0.4,
                    // 기본: 거의 보이지 않게
                    0.2
                ],
                'line-dasharray': [2, 2]  // 점선으로 표시하여 더 눈에 띄게
            }
        });
        
        // 경매 중 영역 - 내부 펄스 애니메이션 (fill layer) - 채우기 제거 (경계선만 사용)
        this.map.addLayer({
            id: `${sourceId}-auction-pulse`,
            type: 'fill',
            source: sourceId,
            filter: ['==', ['get', 'auctionStatus'], 'active'],  // 경매 중만 표시
            paint: {
                'fill-color': '#ff6600',  // 주황색
                // ⚠️ 채우기 완전히 제거 (경계선만 사용)
                'fill-opacity': 0  // 채우기 제거
            }
        });
        
        // 경매 중 영역 애니메이션 시작 (레이어가 추가될 때마다 호출되지만, 실제로는 경매가 있는 territory만 표시됨)
        // 애니메이션은 AUCTION_START/UPDATE 이벤트에서 시작되므로 여기서는 호출하지 않음
        // this.startAuctionAnimation(sourceId);
        
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
        
        // 레이어 추가 완료 후 픽셀 아트 자동 표시
        setTimeout(() => {
            eventBus.emit(EVENTS.MAP_LAYER_ADDED, {
                sourceId: sourceId,
                geoJsonData: geoJsonData
            });
        }, 500);
    }
    
    /**
     * 맵에서 실제로 로드된 source들을 sourcesLoaded에 동기화
     */
    syncSourcesLoaded() {
        if (!this.map) return;
        
        try {
            const mapStyle = this.map.getStyle();
            if (!mapStyle || !mapStyle.sources) return;
            
            // 모든 GeoJSON source 찾기
            const allGeojsonSources = Object.keys(mapStyle.sources).filter(sourceId => {
                try {
                    const source = this.map.getSource(sourceId);
                    return source && source.type === 'geojson';
                } catch (e) {
                    return false;
                }
            });
            
            // sourcesLoaded에 추가
            allGeojsonSources.forEach(sourceId => {
                if (!this.sourcesLoaded.has(sourceId)) {
                    this.sourcesLoaded.add(sourceId);
                    log.debug(`Synced source to sourcesLoaded: ${sourceId}`);
                }
            });
            
            log.info(`✅ Synced ${allGeojsonSources.length} sources to sourcesLoaded`);
        } catch (error) {
            log.error('Failed to sync sourcesLoaded:', error);
        }
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
                
                // 소스 존재 여부 확인
                if (!this.map.getSource(sourceId)) {
                    return;
                }
                
                // 이전 호버 해제
                if (this.hoveredTerritoryId !== null) {
                    try {
                        this.map.setFeatureState(
                            { source: sourceId, id: this.hoveredTerritoryId },
                            { hover: false }
                        );
                    } catch (error) {
                        // 소스가 제거된 경우 무시
                        log.debug('Source removed during hover:', sourceId);
                    }
                }
                
                // 새 호버 설정
                this.hoveredTerritoryId = feature.id;
                try {
                    this.map.setFeatureState(
                        { source: sourceId, id: this.hoveredTerritoryId },
                        { hover: true }
                    );
                } catch (error) {
                    log.debug('Failed to set hover state:', error);
                }
                
                // ⚠️ Step 5-4: 호버 시 Firestore 읽기 없이 로컬 데이터만 사용
                // properties에서 기본 정보만 추출하여 이벤트 발행 (Firestore 호출 없음)
                eventBus.emit(EVENTS.TERRITORY_HOVER, {
                    territoryId: feature.properties.id || feature.id,
                    properties: feature.properties,
                    lngLat: e.lngLat,
                    // ⚠️ Step 5-4: 호버는 로컬 데이터만 사용, Firestore 읽기 없음
                    fromCache: true
                });
            }
        });
        
        // 마우스 이탈
        this.map.on('mouseleave', fillLayerId, () => {
            this.map.getCanvas().style.cursor = '';
            
            if (this.hoveredTerritoryId !== null) {
                // 소스 존재 여부 확인
                if (this.map.getSource(sourceId)) {
                    try {
                        this.map.setFeatureState(
                            { source: sourceId, id: this.hoveredTerritoryId },
                            { hover: false }
                        );
                    } catch (error) {
                        // 소스가 제거된 경우 무시
                        log.debug('Source removed during mouseleave:', sourceId);
                    }
                }
            }
            this.hoveredTerritoryId = null;
        });
        
        // 클릭
        // ⚠️ Step 5-4: 클릭 시에만 Firestore 읽기 (호버는 읽지 않음)
        this.map.on('click', fillLayerId, (e) => {
            if (e.features.length > 0) {
                const feature = e.features[0];
                // ⚠️ Step 5-4: 클릭 시에만 selectTerritory 호출 (Firestore 읽기 발생)
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
        
        // 국가 코드 추출: sourceId에서 추출 > feature.properties > currentCountry (fallback만)
        // sourceId 형식: 'territories-usa', 'states-usa', 'regions-south-korea', 'prefectures-japan'
        // ⚠️ currentCountry는 fallback으로만 사용 (모든 territory의 country를 덮어쓰지 않도록)
        let countryCode = null;
        
        // sourceId에서 국가 코드 추출
        if (!countryCode && sourceId) {
            // 'territories-usa' -> 'usa'
            // 'states-usa' -> 'usa'
            // 'regions-south-korea' -> 'south-korea'
            const parts = sourceId.split('-');
            if (parts.length >= 2) {
                const extractedCode = parts.slice(1).join('-');
                // 잘못된 값 필터링
                const invalidCodes = ['territories', 'states', 'regions', 'prefectures', 'provinces'];
                if (!invalidCodes.includes(extractedCode.toLowerCase())) {
                    countryCode = extractedCode;
                }
            }
        }
        
        // feature.properties에서 국가 코드 추출 시도 (ISO 코드 우선)
        if (!countryCode && feature.properties) {
            // ISO 코드 (adm0_a3) 우선 사용
            if (feature.properties.adm0_a3) {
                const isoCode = feature.properties.adm0_a3.toUpperCase();
                // TerritoryManager의 ISO to slug 매핑 사용 (더 완전한 매핑)
                const isoToSlugMap = territoryManager.createIsoToSlugMap();
                const slugCode = isoToSlugMap[isoCode];
                if (slugCode && CONFIG.COUNTRIES[slugCode]) {
                    countryCode = slugCode;
                    log.debug(`[MapController] Converted ISO code ${isoCode} to slug ${slugCode}`);
                } else {
                    // 매핑에 없으면 소문자로 변환 시도
                    const lowerIsoCode = isoCode.toLowerCase();
                    if (CONFIG.COUNTRIES[lowerIsoCode]) {
                        countryCode = lowerIsoCode;
                    }
                }
            }
            
            if (!countryCode) {
                countryCode = feature.properties.country || 
                             feature.properties.country_code ||
                             feature.properties.sov_a3?.toLowerCase();
            }
        }
        
        // 잘못된 값 필터링
        const invalidCodes = ['territories', 'states', 'regions', 'prefectures', 'provinces'];
        if (countryCode && invalidCodes.includes(countryCode.toLowerCase())) {
            countryCode = null;
        }
        
        // 최종 fallback: currentCountry (하지만 경고 로그)
        if (!countryCode || countryCode === 'unknown') {
            if (this.currentCountry && CONFIG.COUNTRIES[this.currentCountry]) {
                countryCode = this.currentCountry;
                log.warn(`[MapController] Using currentCountry as fallback: ${countryCode} for sourceId: ${sourceId} (this may be incorrect for territories from other countries)`);
            } else {
            countryCode = 'unknown';
                log.warn(`[MapController] Could not determine country code for sourceId: ${sourceId}, currentCountry: ${this.currentCountry}, feature.properties: ${JSON.stringify(feature.properties)}`);
            }
        } else {
            log.debug(`[MapController] Determined country code: ${countryCode} from sourceId: ${sourceId}, currentCountry: ${this.currentCountry}`);
        }
        
        // ⚠️ 중요: 새로운 Territory ID 형식 우선 사용
        // properties.territoryId가 있으면 (새로운 형식: "SGP::ADM1_003") 우선 사용
        const newTerritoryId = feature.properties?.territoryId;
        const rawTerritoryId = feature.properties.id || feature.id; // 원본 ID (항상 정의)
        let finalTerritoryId = null;
        
        if (newTerritoryId && newTerritoryId.includes('::')) {
            // 새로운 Territory ID 형식 사용
            finalTerritoryId = newTerritoryId;
            log.debug(`[MapController] Using new Territory ID format: ${finalTerritoryId}`);
        } else if (typeof feature.properties?.id === 'string' && !/^\d+$/.test(feature.properties.id)) {
            // 지도 레이어를 만들 때 정한 ID 그대로 사용 (getWorldTerritoryId: 국가 간 이름 충돌 접미사 포함)
            finalTerritoryId = feature.properties.id;
        } else {
            // Legacy 형식: 이름 기반 정규화
            const territoryName = feature.properties.name || feature.properties.NAME_1 || feature.properties.NAME_2;
            finalTerritoryId = this.normalizeTerritoryId(rawTerritoryId, territoryName, countryCode);
            log.debug(`[MapController] Using legacy Territory ID format: ${finalTerritoryId}`);
        }
        
        // ⚠️ 전문가 조언 반영: MapController는 TERRITORY_CLICKED (입력) 이벤트만 발행
        // TerritoryManager가 이 이벤트를 듣고 Firestore를 읽은 후 TERRITORY_SELECTED (출력) 발행
        log.info(`[MapController] 🎯 [MapController → TERRITORY_CLICKED] Territory clicked: ${finalTerritoryId}, emitting TERRITORY_CLICKED event...`);
        
        eventBus.emit(EVENTS.TERRITORY_CLICKED, {
            territoryId: finalTerritoryId,
            properties: feature.properties,
            geometry: feature.geometry,
            country: countryCode,
            featureId: feature.id,
            sourceId: sourceId,
            originalId: rawTerritoryId
        });
        
        log.debug(`🗺️ Territory selected: ${finalTerritoryId} (feature.id: ${feature.id}) from source ${sourceId}`);
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
     * 경매 중 영역 펄스 애니메이션 (전역 애니메이션 루프)
     * 
     * ⚠️ 중요: 모든 source의 경매 레이어를 하나의 애니메이션 루프로 처리
     * territory별 개별 프레임이 아닌, 전역 루프 하나로 모든 경매 territory 처리
     * 
     * ⚠️ 1단계 검증: 애니메이션 루프 임시 비활성화
     */
    startAuctionAnimation() {
        // ⚠️ 1단계 검증: 애니메이션 루프 임시 비활성화
        log.info(`[MapController] ⚠️ 1단계 검증 중: 애니메이션 루프 비활성화됨`);
        return;  // 임시로 애니메이션 시작하지 않음
        
        // 이미 애니메이션 중인지 확인
        if (this.auctionAnimationFrame) {
            log.debug(`[MapController] Auction animation already running`);
            return;
        }
        
        let startTime = null;
        const animate = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const elapsed = timestamp - startTime;
            
            // 1.5초 주기 펄스 (더 빠른 펄스) - opacity 범위 확대 (0.4 ~ 1.0)
            const pulse = 0.4 + 0.6 * Math.abs(Math.sin(elapsed / 750 * Math.PI));
            
            // 테두리 width 펄스 (더 큰 범위: 6 ~ 12)
            const widthPulse = 6 + 6 * Math.abs(Math.sin(elapsed / 600 * Math.PI));
            
            // 모든 source의 경매 펄스 레이어에 애니메이션 적용
            if (this.map) {
                try {
                    const style = this.map.getStyle();
                    if (style && style.layers) {
                        // 모든 경매 펄스 레이어 찾기 (fill layer)
                        const pulseLayers = style.layers.filter(layer => 
                            layer.id && layer.id.endsWith('-auction-pulse')
                        );
                        
                        if (pulseLayers.length > 0) {
                            // 각 펄스 레이어에 애니메이션 적용
                            for (const layer of pulseLayers) {
                                try {
                                    const sourceId = layer.source;
                                    if (!sourceId) continue;
                                    
                                    const source = this.map.getSource(sourceId);
                                    if (!source || source.type !== 'geojson' || !source._data) continue;
                                    
                                    // 경매 중이고 선택된 feature 찾기
                                    const activeFeatures = source._data.features.filter(f => 
                                        f.properties?.auctionStatus === 'active'
                                    );
                                    
                                    // 선택된 feature만 애니메이션 적용
                                    activeFeatures.forEach(feature => {
                                        try {
                                            // 선택된 feature인지 확인
                                            const isSelected = this.selectedTerritoryId !== null && 
                                                              String(this.selectedTerritoryId) === String(feature.id);
                                            
                                            if (isSelected) {
                                                // feature-state로 pulseOpacity 설정
                                                this.map.setFeatureState(
                                                    { source: sourceId, id: feature.id },
                                                    { pulseOpacity: pulse }
                                                );
                                            }
                                        } catch (error) {
                                            // 개별 feature 업데이트 실패는 무시
                                        }
                                    });
                                } catch (error) {
                                    // 레이어 업데이트 실패는 무시
                                    log.debug(`[MapController] Failed to update ${layer.id}:`, error);
            }
                            }
                            
                            // 경매 레이어가 있으면 애니메이션 계속
            this.auctionAnimationFrame = requestAnimationFrame(animate);
                        } else {
                            // 경매 레이어가 없으면 애니메이션 중지
                            this.auctionAnimationFrame = null;
                            log.debug(`[MapController] No auction pulse layers found, stopping animation`);
                            return;
                        }
                    } else {
                        // 스타일이 없으면 애니메이션 중지
                        this.auctionAnimationFrame = null;
                        return;
                    }
                } catch (error) {
                    // 오류 발생 시 애니메이션 중지
                    cancelAnimationFrame(this.auctionAnimationFrame);
                    this.auctionAnimationFrame = null;
                    log.warn(`[MapController] Auction animation error:`, error);
                    return;
                }
            } else {
                // 맵이 없으면 애니메이션 중지
                this.auctionAnimationFrame = null;
                return;
            }
        };
        
        this.auctionAnimationFrame = requestAnimationFrame(animate);
        log.info(`[MapController] Global auction animation started`);
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
     * 경매 이벤트 리스너 설정
     * 
     * ⚠️ 중요: TerritoryManager를 Single Source of Truth로 사용
     * - TerritoryManager가 territory의 절대 ID, sourceId, featureId를 모두 알고 있어야 함
     * - Auction은 territoryId만 알고 있고, 나머지는 TerritoryManager에서 가져옴
     */
    setupAuctionEventListeners() {
        // ⚠️ 1단계 검증: 애니메이션 로직 임시 비활성화
        // 레이어 자체가 보이는지 확인하기 위해 애니메이션은 나중에 활성화
        // TERRITORY_SELECT 이벤트: 경매 중인 territory를 선택한 경우 애니메이션 시작
        eventBus.on(EVENTS.TERRITORY_SELECT, (data) => {
            const { territoryId, sourceId, featureId } = data;
            log.info(`[MapController] 🎯 TERRITORY_SELECT event received: territoryId=${territoryId}, sourceId=${sourceId}, featureId=${featureId}`);
            
            if (!territoryId || !sourceId || featureId === undefined) {
                log.warn(`[MapController] ⚠️ Missing required data: territoryId=${territoryId}, sourceId=${sourceId}, featureId=${featureId}`);
                return;
            }
            
            // ⚠️ 1단계 검증: 애니메이션 로직 임시 비활성화
            // 레이어가 기본적으로 보이는지 확인 후 나중에 활성화
            log.info(`[MapController] ⚠️ 1단계 검증 중: 애니메이션 로직 비활성화됨`);
            return;  // 임시로 애니메이션 시작하지 않음
            
            // 경매 상태 확인 및 애니메이션 시작
            const checkAndStartAnimation = (retryCount = 0) => {
                // 1. feature.properties에서 auctionStatus 확인
                const source = this.map?.getSource(sourceId);
                const feature = source?._data?.features?.find(f => String(f.id) === String(featureId));
                const hasAuctionStatus = feature?.properties?.auctionStatus === 'active';
                
                // 2. TerritoryManager에서 sovereignty 확인
                const territory = territoryManager.getTerritory(territoryId);
                const hasContestedSovereignty = territory?.sovereignty === 'contested';
                
                // 3. AuctionSystem에서 activeAuctions 확인
                let hasActiveAuction = false;
                try {
                    // activeAuctions Map에서 territoryId로 경매 찾기
                    for (const [auctionId, auction] of auctionSystem.activeAuctions.entries()) {
                        if (auction.territoryId === territoryId && auction.status === 'active') {
                            hasActiveAuction = true;
                            break;
                        }
                    }
                } catch (error) {
                    log.debug(`[MapController] Failed to check AuctionSystem:`, error);
                }
                
                const isAuctionActive = hasAuctionStatus || hasContestedSovereignty || hasActiveAuction;
                
                log.info(`[MapController] 🔍 Checking auction status for ${territoryId} (retry ${retryCount}):`, {
                    territoryExists: !!territory,
                    sovereignty: territory?.sovereignty,
                    hasAuctionStatus,
                    hasContestedSovereignty,
                    isAuctionActive,
                    selectedTerritoryId: this.selectedTerritoryId,
                    featureId: featureId,
                    match: this.selectedTerritoryId === featureId,
                    sourceId: sourceId
                });
                
                // selectedTerritoryId는 feature.id이고, featureId는 이벤트에서 전달된 값
                // 둘 다 같은 feature를 가리키므로 매칭 확인
                const isSelected = this.selectedTerritoryId === featureId || 
                                  (this.selectedTerritoryId !== null && feature && String(this.selectedTerritoryId) === String(feature.id));
                
                if (isAuctionActive && isSelected) {
                    try {
                        // pulseOpacity를 초기값(0)으로 설정하여 즉시 표시
                        this.map.setFeatureState(
                            { source: sourceId, id: featureId },
                            { pulseOpacity: 0 }
                        );
                        log.info(`[MapController] ✅ Set pulseOpacity=0 for territory: ${territoryId}`);
                        
                        // 애니메이션 루프가 시작되지 않았다면 시작
                        if (!this.auctionAnimationFrame) {
                            this.startAuctionAnimation();
                            log.info(`[MapController] ✅ Started auction animation for selected territory: ${territoryId}`);
                        } else {
                            log.info(`[MapController] ℹ️ Animation already running for territory: ${territoryId}`);
                        }
                    } catch (error) {
                        log.warn(`[MapController] ❌ Failed to set pulseOpacity for selected territory:`, error);
                    }
                } else {
                    if ((!territory || !feature) && retryCount < 3) {
                        // TerritoryManager나 feature가 아직 로드되지 않았을 수 있으므로 재시도
                        log.debug(`[MapController] ⏳ Territory or feature not ready, retrying... (${retryCount + 1}/3)`);
                        setTimeout(() => checkAndStartAnimation(retryCount + 1), 300);
                    } else {
                        log.debug(`[MapController] ℹ️ Territory ${territoryId} is not in auction or not selected:`, {
                            isAuctionActive,
                            sovereignty: territory?.sovereignty,
                            auctionStatus: feature?.properties?.auctionStatus,
                            selectedMatch: this.selectedTerritoryId === featureId
                        });
                    }
                }
            };
            
            // 즉시 확인 및 재시도
            setTimeout(() => checkAndStartAnimation(0), 100);
            setTimeout(() => checkAndStartAnimation(1), 500);
            setTimeout(() => checkAndStartAnimation(2), 1000);
        });
        
        // 경매 시작 이벤트
        eventBus.on(EVENTS.AUCTION_START, (data) => {
            const { auction } = data;
            if (auction && auction.territoryId) {
                // ==========================================
                // 레벨 1: 데이터 계층 - TerritoryManager 확인
                // ==========================================
                log.info(`[MapController] 🔍 [LEVEL 1] Checking TerritoryManager for: ${auction.territoryId}`);
                let territory = territoryManager.getTerritory(auction.territoryId);
                
                if (territory) {
                    log.info(`[MapController] ✅ [LEVEL 1] Territory found in TerritoryManager:`, {
                        id: territory.id,
                        sourceId: territory.sourceId,
                        featureId: territory.featureId,
                        country: territory.country
                    });
                    
                    // ⚠️ ID 불일치 확인
                    if (territory.id !== auction.territoryId) {
                        log.warn(`[MapController] ⚠️ [LEVEL 1] ID MISMATCH!`);
                        log.warn(`[MapController] ⚠️ Auction.territoryId: "${auction.territoryId}"`);
                        log.warn(`[MapController] ⚠️ Territory.id: "${territory.id}"`);
                        log.warn(`[MapController] ⚠️ This is likely a legacy ID issue!`);
                    }
                } else {
                    log.warn(`[MapController] ⚠️ [LEVEL 1] Territory NOT found in TerritoryManager: ${auction.territoryId}`);
                    log.warn(`[MapController] ⚠️ Available territories:`, 
                        Array.from(territoryManager.territories.keys()).slice(0, 10)
                    );
                }
                
                // TerritoryManager에 없으면 맵에서 찾아서 TerritoryManager에 저장
                let sourceId = territory?.sourceId || null;
                let featureId = territory?.featureId || null;
                
                if (!territory || !sourceId || !featureId) {
                    log.info(`[MapController] 🔍 [LEVEL 1] Searching map for territory: ${auction.territoryId}`);
                    
                    // 맵의 모든 source에서 territory 찾기
                    if (this.map) {
                        const allSources = Object.keys(this.map.getStyle().sources || {});
                        for (const possibleSourceId of allSources) {
                            try {
                                const source = this.map.getSource(possibleSourceId);
                                if (source && source.type === 'geojson' && source._data) {
                                    // 강화된 매칭 로직
                                    const feature = source._data.features?.find(f => {
                                        const props = f.properties || {};
                                        
                                        // 1. 정확한 ID 매칭
                                        if (String(props.id) === String(auction.territoryId) ||
                                            String(props.territoryId) === String(auction.territoryId) ||
                                            String(f.id) === String(auction.territoryId)) {
                                            return true;
                                        }
                                        
                                        // 2. 이름 기반 매칭 (legacy 지원)
                                        const featureName = props.name || props.name_en || '';
                                        if (featureName) {
                                            const normalizedName = featureName.toLowerCase()
                                                .trim()
                                                .replace(/[^\w\s-]/g, '')
                                                .replace(/\s+/g, '-')
                                                .replace(/-+/g, '-')
                                                .replace(/^-|-$/g, '');
                                            const normalizedTerritoryId = String(auction.territoryId).toLowerCase();
                                            
                                            if (normalizedName === normalizedTerritoryId) {
                                                return true;
                                            }
                                        }
                                        
                                        return false;
                                    });
                                    
                                    if (feature) {
                                        sourceId = possibleSourceId;
                                        featureId = feature.id;
                                        
                                        // TerritoryManager에 저장 (없으면 생성)
                                        if (!territory) {
                                            territory = {
                                                id: auction.territoryId,
                                                country: feature.properties?.adm0_a3 ? 
                                                    territoryManager.createIsoToSlugMap()[feature.properties.adm0_a3.toUpperCase()] : 
                                                    'unknown',
                                                properties: feature.properties
                                            };
                                        }
                                        
                                        territory.sourceId = sourceId;
                                        territory.featureId = featureId;
                                        
                                        // TerritoryManager에 저장
                                        territoryManager.territories.set(auction.territoryId, territory);
                                        
                                        log.info(`[MapController] ✅ [LEVEL 1] Found territory in map and saved to TerritoryManager:`, {
                                            sourceId: sourceId,
                                            featureId: featureId,
                                            matchedBy: String(feature.properties?.id) === String(auction.territoryId) ? 'id' :
                                                      String(feature.properties?.territoryId) === String(auction.territoryId) ? 'territoryId' :
                                                      String(feature.id) === String(auction.territoryId) ? 'feature.id' : 'name'
                                        });
                                        break;
                                    }
                                }
                            } catch (error) {
                                // 소스 접근 실패 시 무시
                            }
                        }
                    }
                }
                
                // 최종 fallback: world-territories
                if (!sourceId) {
                    sourceId = 'world-territories';
                    log.warn(`[MapController] ⚠️ [LEVEL 1] Using fallback sourceId: ${sourceId}`);
                }
                
                // ==========================================
                // 레벨 2: Mapbox Source & Feature 확인
                // ==========================================
                if (!territory || !sourceId || !featureId) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Cannot proceed: missing territory info`);
                    log.warn(`[MapController] ⚠️ territory: ${!!territory}, sourceId: ${sourceId}, featureId: ${featureId}`);
                    return;
                }
                
                log.info(`[MapController] 🔍 [LEVEL 2] Checking Mapbox source: ${sourceId}`);
                
                // ⚠️ 중요: 맵이 아직 준비되지 않았으면 재시도
                if (!this.map) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Map not ready yet, will retry in 1 second`);
                    setTimeout(() => {
                        eventBus.emit(EVENTS.AUCTION_START, { auction });
                    }, 1000);
                    return;
                }
                
                // Source가 아직 준비되지 않았으면 재시도
                if (!this.map.getSource(sourceId)) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Source ${sourceId} not ready yet, will retry in 1 second`);
                    setTimeout(() => {
                        eventBus.emit(EVENTS.AUCTION_START, { auction });
                    }, 1000);
                    return;
                }
                
                if (this.map && this.map.getSource(sourceId)) {
                    try {
                        const source = this.map.getSource(sourceId);
                        if (source && source._data && source._data.features) {
                            log.info(`[MapController] ✅ [LEVEL 2] Source exists with ${source._data.features.length} features`);
                            
                            // TerritoryManager의 featureId로 직접 찾기
                            const feature = source._data.features.find(f => 
                                String(f.id) === String(featureId) ||
                                String(f.properties?.id) === String(auction.territoryId) ||
                                String(f.properties?.territoryId) === String(auction.territoryId)
                            );
                            
                            if (feature) {
                                log.info(`[MapController] ✅ [LEVEL 2] Feature found by featureId:`, {
                                    featureId: feature.id,
                                    propertiesId: feature.properties?.id,
                                    propertiesTerritoryId: feature.properties?.territoryId,
                                    currentAuctionStatus: feature.properties?.auctionStatus
                                });
                                
                                // ==========================================
                                // 레벨 3: Properties 업데이트 및 레이어 확인
                                // ==========================================
                                log.info(`[MapController] 🔍 [LEVEL 3] Updating properties and checking layers`);
                                
                                // ⚠️ 중요: 새로운 객체 생성하여 setData 호출
                                const newData = JSON.parse(JSON.stringify(source._data));
                                const newFeature = newData.features.find(f => 
                                    String(f.id) === String(featureId) ||
                                    String(f.properties?.id) === String(feature.properties?.id) ||
                                    String(f.properties?.territoryId) === String(feature.properties?.territoryId)
                                );
                                
                                if (newFeature) {
                                    // Properties에 auctionStatus 설정
                                    newFeature.properties.auctionStatus = 'active';
                                    
                                    // Territory 객체에도 저장
                                    if (territory) {
                                        territory.auctionStatus = 'active';
                                    }
                                    
                                    // GeoJSON source 업데이트
                                    source.setData(newData);
                                    
                                    log.info(`[MapController] ✅ [LEVEL 3] Updated auctionStatus to 'active'`);
                                    
                                    // 레이어 확인
                                    const pulseLayerId = `${sourceId}-auction-pulse`;
                                    const layer = this.map.getLayer(pulseLayerId);
                                    
                                    if (layer) {
                                        log.info(`[MapController] ✅ [LEVEL 3] Layer exists: ${pulseLayerId}`);
                                        log.info(`[MapController] 🔍 [LEVEL 3] Layer filter:`, layer.filter);
                                        log.info(`[MapController] 🔍 [LEVEL 3] Layer source: ${layer.source}`);
                                        
                                        // 실제로 properties에 active가 들어갔는지 확인
                                        const verifySource = this.map.getSource(sourceId);
                                        const verifyFeature = verifySource._data.features.find(f => 
                                            String(f.id) === String(featureId)
                                        );
                                        
                                        if (verifyFeature?.properties?.auctionStatus === 'active') {
                                            log.info(`[MapController] ✅ [LEVEL 3] Verified: feature has auctionStatus='active'`);
                                            log.info(`[MapController] ✅ [LEVEL 3] Filter should match: ['==', ['get', 'auctionStatus'], 'active']`);
                                            log.info(`[MapController] ℹ️ [LEVEL 3] Animation will show when territory is selected`);
                                        } else {
                                            log.warn(`[MapController] ⚠️ [LEVEL 3] VERIFICATION FAILED!`);
                                            log.warn(`[MapController] ⚠️ Feature auctionStatus: ${verifyFeature?.properties?.auctionStatus || 'NOT FOUND'}`);
                                        }
                                    } else {
                                        log.warn(`[MapController] ⚠️ [LEVEL 3] Layer NOT found: ${pulseLayerId}`);
                                        log.warn(`[MapController] ⚠️ Available auction layers:`, 
                                            this.map.getStyle().layers
                                                .filter(l => l.id && l.id.includes('auction'))
                                                .map(l => ({ id: l.id, source: l.source, filter: l.filter }))
                                        );
                                    }
                                    
                                    // 전역 애니메이션 루프 시작
                                    if (!this.auctionAnimationFrame) {
                                        this.startAuctionAnimation();
                                        log.info(`[MapController] ✅ [LEVEL 3] Global auction animation started`);
                                    } else {
                                        log.debug(`[MapController] 🔍 [LEVEL 3] Animation already running`);
                                    }
                                } else {
                                    log.warn(`[MapController] ⚠️ [LEVEL 3] Could not find feature in newData object`);
                                }
                            } else {
                                log.warn(`[MapController] ⚠️ [LEVEL 2] Feature NOT found by featureId: ${featureId}`);
                                log.warn(`[MapController] ⚠️ This suggests a mismatch between TerritoryManager and Mapbox source`);
                            }
                        } else {
                            log.warn(`[MapController] ⚠️ [LEVEL 2] Source has no data or features`);
                        }
                    } catch (error) {
                        log.warn(`[MapController] ⚠️ [LEVEL 2] Error updating auctionStatus:`, error);
                    }
                } else {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Source ${sourceId} not found in map`);
                }
            }
        });
        
        // 경매 업데이트 이벤트 (입찰 발생 시) - AUCTION_START와 동일한 로직
        eventBus.on(EVENTS.AUCTION_UPDATE, (data) => {
            const { auction } = data;
            if (auction && auction.territoryId) {
                // ==========================================
                // 레벨 1: 데이터 계층 - TerritoryManager 확인
                // ==========================================
                log.info(`[MapController] 🔍 [LEVEL 1] Checking TerritoryManager for: ${auction.territoryId} (UPDATE)`);
                let territory = territoryManager.getTerritory(auction.territoryId);
                
                if (territory) {
                    log.info(`[MapController] ✅ [LEVEL 1] Territory found in TerritoryManager:`, {
                        id: territory.id,
                        sourceId: territory.sourceId,
                        featureId: territory.featureId,
                        country: territory.country
                    });
                } else {
                    log.warn(`[MapController] ⚠️ [LEVEL 1] Territory NOT found in TerritoryManager: ${auction.territoryId} (UPDATE)`);
                }
                
                // TerritoryManager에 없으면 맵에서 찾아서 저장 (AUCTION_START와 동일)
                let sourceId = territory?.sourceId || null;
                let featureId = territory?.featureId || null;
                
                if (!territory || !sourceId || !featureId) {
                    log.info(`[MapController] 🔍 [LEVEL 1] Searching map for territory: ${auction.territoryId} (UPDATE)`);
                    
                    if (this.map) {
                        const allSources = Object.keys(this.map.getStyle().sources || {});
                        for (const possibleSourceId of allSources) {
                            try {
                                const source = this.map.getSource(possibleSourceId);
                                if (source && source.type === 'geojson' && source._data) {
                                    const feature = source._data.features?.find(f => {
                                        const props = f.properties || {};
                                        
                                        if (String(props.id) === String(auction.territoryId) ||
                                            String(props.territoryId) === String(auction.territoryId) ||
                                            String(f.id) === String(auction.territoryId)) {
                                            return true;
                                        }
                                        
                                        const featureName = props.name || props.name_en || '';
                                        if (featureName) {
                                            const normalizedName = featureName.toLowerCase()
                                                .trim()
                                                .replace(/[^\w\s-]/g, '')
                                                .replace(/\s+/g, '-')
                                                .replace(/-+/g, '-')
                                                .replace(/^-|-$/g, '');
                                            const normalizedTerritoryId = String(auction.territoryId).toLowerCase();
                                            if (normalizedName === normalizedTerritoryId) {
                                                return true;
                                            }
                                        }
                                        
                                        return false;
                                    });
                                    
                                    if (feature) {
                                        sourceId = possibleSourceId;
                                        featureId = feature.id;
                                        
                                        if (!territory) {
                                            territory = {
                                                id: auction.territoryId,
                                                country: feature.properties?.adm0_a3 ? 
                                                    territoryManager.createIsoToSlugMap()[feature.properties.adm0_a3.toUpperCase()] : 
                                                    'unknown',
                                                properties: feature.properties
                                            };
                                        }
                                        
                                        territory.sourceId = sourceId;
                                        territory.featureId = featureId;
                                        territoryManager.territories.set(auction.territoryId, territory);
                                        
                                        log.info(`[MapController] ✅ [LEVEL 1] Found territory in map and saved (UPDATE)`);
                                        break;
                                    }
                                }
                            } catch (error) {
                                // 소스 접근 실패 시 무시
                            }
                        }
                    }
                }
                
                if (!sourceId) {
                    sourceId = 'world-territories';
                    log.warn(`[MapController] ⚠️ [LEVEL 1] Using fallback sourceId: ${sourceId} (UPDATE)`);
                }
                
                // ==========================================
                // 레벨 2: Mapbox Source & Feature 확인 (AUCTION_START와 동일)
                // ==========================================
                if (!territory || !sourceId || !featureId) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Cannot proceed: missing territory info (UPDATE)`);
                    return;
                }
                
                log.info(`[MapController] 🔍 [LEVEL 2] Checking Mapbox source: ${sourceId} (UPDATE)`);
                
                // ⚠️ 중요: 맵이 아직 준비되지 않았으면 재시도
                if (!this.map) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Map not ready yet, will retry in 1 second (UPDATE)`);
                    setTimeout(() => {
                        eventBus.emit(EVENTS.AUCTION_UPDATE, { auction });
                    }, 1000);
                    return;
                }
                
                // Source가 아직 준비되지 않았으면 재시도
                if (!this.map.getSource(sourceId)) {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Source ${sourceId} not ready yet, will retry in 1 second (UPDATE)`);
                    setTimeout(() => {
                        eventBus.emit(EVENTS.AUCTION_UPDATE, { auction });
                    }, 1000);
                    return;
                }
                
                if (this.map && this.map.getSource(sourceId)) {
                    try {
                        const source = this.map.getSource(sourceId);
                        if (source && source._data && source._data.features) {
                            log.info(`[MapController] ✅ [LEVEL 2] Source exists with ${source._data.features.length} features (UPDATE)`);
                            
                            // TerritoryManager의 featureId로 직접 찾기
                            const feature = source._data.features.find(f => 
                                String(f.id) === String(featureId) ||
                                String(f.properties?.id) === String(auction.territoryId) ||
                                String(f.properties?.territoryId) === String(auction.territoryId)
                            );
                            
                            if (feature) {
                                log.info(`[MapController] ✅ [LEVEL 2] Feature found by featureId (UPDATE)`);
                                
                                // ==========================================
                                // 레벨 3: Properties 업데이트 (AUCTION_START와 동일)
                                // ==========================================
                                log.info(`[MapController] 🔍 [LEVEL 3] Updating properties for featureId: ${featureId} (UPDATE)`);
                                
                                // ⚠️ 중요: 깊은 복사로 새 객체 생성
                                const newData = JSON.parse(JSON.stringify(source._data));
                                
                                // featureId로 정확히 찾기
                                const newFeature = newData.features.find(f => 
                                    String(f.id) === String(featureId)
                                );
                                
                                if (!newFeature) {
                                    log.warn(`[MapController] ⚠️ [LEVEL 3] Feature NOT found in newData by featureId: ${featureId} (UPDATE)`);
                                    log.warn(`[MapController] ⚠️ Available feature IDs:`, 
                                        newData.features.slice(0, 5).map(f => ({
                                            id: f.id,
                                            propertiesId: f.properties?.id,
                                            propertiesTerritoryId: f.properties?.territoryId
                                        }))
                                    );
                                } else {
                                    // Properties에 auctionStatus 설정
                                    if (!newFeature.properties) {
                                        newFeature.properties = {};
                                    }
                                    newFeature.properties.auctionStatus = 'active';
                                    
                                    log.info(`[MapController] 🔍 [LEVEL 3] Set auctionStatus='active' on feature:`, {
                                        id: newFeature.id,
                                        propertiesId: newFeature.properties?.id,
                                        propertiesTerritoryId: newFeature.properties?.territoryId,
                                        auctionStatus: newFeature.properties.auctionStatus
                                    });
                                    
                                    if (territory) {
                                        territory.auctionStatus = 'active';
                                    }
                                    
                                    // GeoJSON source 업데이트
                                    source.setData(newData);
                                    
                                    log.info(`[MapController] ✅ [LEVEL 3] Updated auctionStatus to 'active' and called setData (UPDATE)`);
                                    
                                    // ⚠️ 중요: setData는 비동기적으로 작동할 수 있으므로 약간의 지연 후 검증
                                    setTimeout(() => {
                                        // 레이어 확인
                                        const pulseLayerId = `${sourceId}-auction-pulse`;
                                        const layer = this.map.getLayer(pulseLayerId);
                                        
                                        if (layer) {
                                            log.info(`[MapController] ✅ [LEVEL 3] Layer exists: ${pulseLayerId} (UPDATE)`);
                                            log.info(`[MapController] 🔍 [LEVEL 3] Layer filter:`, layer.filter);
                                            log.info(`[MapController] 🔍 [LEVEL 3] Layer source: ${layer.source}`);
                                            
                                            // 실제로 properties에 active가 들어갔는지 확인
                                            const verifySource = this.map.getSource(sourceId);
                                            if (!verifySource || !verifySource._data) {
                                                log.warn(`[MapController] ⚠️ [LEVEL 3] Cannot verify: source or data not available (UPDATE)`);
                                                return;
                                            }
                                            
                                            const verifyFeature = verifySource._data.features.find(f => 
                                                String(f.id) === String(featureId)
                                            );
                                            
                                            if (verifyFeature) {
                                                log.info(`[MapController] 🔍 [LEVEL 3] Verification feature found:`, {
                                                    id: verifyFeature.id,
                                                    propertiesId: verifyFeature.properties?.id,
                                                    auctionStatus: verifyFeature.properties?.auctionStatus
                                                });
                                                
                                                if (verifyFeature.properties?.auctionStatus === 'active') {
                                                    log.info(`[MapController] ✅ [LEVEL 3] Verified: feature has auctionStatus='active' (UPDATE)`);
                                                    log.info(`[MapController] ✅ [LEVEL 3] Filter should match: ['==', ['get', 'auctionStatus'], 'active'] (UPDATE)`);
                                                    log.info(`[MapController] ℹ️ [LEVEL 3] Animation will show when territory is selected (UPDATE)`);
                                                } else {
                                                    log.warn(`[MapController] ⚠️ [LEVEL 3] VERIFICATION FAILED! (UPDATE)`);
                                                    log.warn(`[MapController] ⚠️ Feature auctionStatus: ${verifyFeature.properties?.auctionStatus || 'NOT FOUND'} (UPDATE)`);
                                                    log.warn(`[MapController] ⚠️ All properties:`, Object.keys(verifyFeature.properties || {}));
                                                }
                                            } else {
                                                log.warn(`[MapController] ⚠️ [LEVEL 3] Verification feature NOT found by featureId: ${featureId} (UPDATE)`);
                                            }
                                        } else {
                                            log.warn(`[MapController] ⚠️ [LEVEL 3] Layer NOT found: ${pulseLayerId} (UPDATE)`);
                                            log.warn(`[MapController] ⚠️ Available auction layers:`, 
                                                this.map.getStyle().layers
                                                    .filter(l => l.id && l.id.includes('auction'))
                                                    .map(l => ({ id: l.id, source: l.source, filter: l.filter }))
                                            );
                                        }
                                    }, 100); // 100ms 지연 후 검증
                                    
                                    // 전역 애니메이션 루프 시작
                                    if (!this.auctionAnimationFrame) {
                                        this.startAuctionAnimation();
                                        log.info(`[MapController] ✅ [LEVEL 3] Global auction animation started (UPDATE)`);
                                    } else {
                                        log.debug(`[MapController] 🔍 [LEVEL 3] Animation already running (UPDATE)`);
                                    }
                                }
                            } else {
                                log.warn(`[MapController] ⚠️ [LEVEL 2] Feature NOT found by featureId: ${featureId} (UPDATE)`);
                            }
                        }
                    } catch (error) {
                        log.warn(`[MapController] ⚠️ [LEVEL 2] Error updating auctionStatus (UPDATE):`, error);
                    }
                } else {
                    log.warn(`[MapController] ⚠️ [LEVEL 2] Source ${sourceId} not found (UPDATE)`);
                }
            }
        });
        
        // 경매 종료 이벤트
        eventBus.on(EVENTS.AUCTION_END, (data) => {
            const { auction } = data;
            if (auction && auction.territoryId) {
                // 영토의 sourceId 찾기
                const territory = territoryManager.getTerritory(auction.territoryId);
                let sourceId = territory?.sourceId || 'world-territories';
                
                // ⚠️ 중요: Properties 기반 접근 - auctionStatus를 'none'으로 설정
                if (this.map && this.map.getSource(sourceId)) {
                    try {
                        const source = this.map.getSource(sourceId);
                        if (source && source._data && source._data.features) {
                            // Feature 찾기
                            const feature = source._data.features.find(f => 
                                String(f.properties?.id) === String(auction.territoryId) ||
                                String(f.properties?.territoryId) === String(auction.territoryId) ||
                                String(f.id) === String(auction.territoryId)
                            );
                            
                            if (feature) {
                                // Properties에 auctionStatus를 'none'으로 설정
                                feature.properties.auctionStatus = 'none';
                                
                                // Territory 객체에도 저장
                                if (territory) {
                                    territory.auctionStatus = 'none';
                                }
                                
                                // GeoJSON source 업데이트
                                source.setData(source._data);
                                
                                log.info(`[MapController] ✅ Updated territory ${auction.territoryId} auctionStatus to 'none'`);
                            }
                        }
                    } catch (error) {
                        log.warn(`[MapController] Failed to update auctionStatus for ${auction.territoryId} (on end):`, error);
                    }
                }
                
                // 모든 경매가 종료되었는지 확인하고 애니메이션 중지 여부 결정
                // (현재는 단순히 중지하지만, 나중에 여러 경매가 있을 때를 고려하여 개선 가능)
                // TODO: 모든 active auction을 확인하여 하나라도 있으면 애니메이션 계속
            }
            
            // 경매 애니메이션 중지 (모든 경매가 종료된 경우)
            // TODO: 여러 경매가 있을 때는 모든 경매가 종료되었는지 확인 후 중지
            // this.stopAuctionAnimation();
            log.info('[MapController] Auction ended');
        });
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
            
            // Load global admin data (재시도 로직 포함)
            await this.loadGlobalAdminData();
            
            if (!this.globalAdminData) {
                log.warn('Failed to load global admin data, but continuing...');
                // 데이터가 없어도 앱은 계속 작동 (나중에 재시도 가능)
                // Territory 매핑은 World View가 로드된 후에 재시도됨
                return false;
            }
            
            // Create color map for countries
            const countryColors = new Map();
            
            // Add all regions as one layer with country colors
            // 핵심: territoryId를 명시적으로 설정하고 TerritoryManager에 매핑 확립
            const worldData = {
                type: 'FeatureCollection',
                features: this.globalAdminData.features.map((feature, index) => {
                    // countryCode 추출 (여러 속성 시도)
                    const countryCode = feature.properties.sov_a3 || 
                                      feature.properties.admin || 
                                      feature.properties.iso_a2 ||
                                      feature.properties.iso_3166_2?.split('-')[0] ||
                                      feature.properties.adm0_a3 ||
                                      'unknown';
                    
                    // Get or generate color for this country
                    if (!countryColors.has(countryCode)) {
                        countryColors.set(countryCode, this.stringToColor(countryCode));
                    }
                    
                    // territoryId 정규화 (이름 기반, 국가 간 이름 충돌 시 국가 접미사)
                    const name = feature.properties.name || feature.properties.name_en || `Region ${index}`;
                    const territoryId = this.getWorldTerritoryId(feature, index);
                    
                    // feature.id 확정
                    const featureId = index;
                    
                    // TerritoryManager에 매핑 확립
                    let territory = territoryManager.getTerritory(territoryId);
                    if (!territory) {
                        territory = territoryManager.createTerritoryFromProperties(territoryId, {
                            name: name,
                            country: countryCode,
                            sovereignty: 'unconquered'
                        });
                        territoryManager.territories.set(territoryId, territory);
                    }
                    
                    // sourceId/featureId 매핑 확립
                    territory.sourceId = 'world-territories';
                    territory.featureId = featureId;
                    territory.geometry = feature.geometry;
                    
                    // countryColor가 항상 설정되도록 보장
                    const countryColor = countryColors.get(countryCode) || this.stringToColor(countryCode);
                    const hashColor = this.stringToColor(name);
                    
                    // properties 설정 시 색상 속성을 마지막에 덮어쓰도록 보장
                    territory.properties = {
                        ...feature.properties,
                        id: territoryId,
                        territoryId: territoryId,
                        name: name,
                        country: countryCode,
                        countryCode: countryCode,
                        sovereignty: 'unconquered',
                        // 색상 속성은 마지막에 설정하여 덮어쓰기 보장
                        hashColor: hashColor,
                        countryColor: countryColor
                    };
                    
                    return {
                        ...feature,
                        id: featureId,
                        properties: territory.properties
                    };
                })
            };
            
            log.info(`Generated colors for ${countryColors.size} countries`);
            
            // Add world layer
            const sourceExists = this.map.getSource('world-territories');
            
            if (sourceExists) {
                // 기존 소스가 있으면 데이터 업데이트
                this.map.getSource('world-territories').setData(worldData);
                // 레이어 강제 업데이트를 위해 레이어 제거 후 다시 추가
                if (this.map.getLayer('world-territories-fill')) {
                    this.map.removeLayer('world-territories-fill');
                }
                if (this.map.getLayer('world-territories-line')) {
                    this.map.removeLayer('world-territories-line');
                }
            } else {
                this.map.addSource('world-territories', {
                    type: 'geojson',
                    data: worldData,
                    generateId: true
                });
            }
            
            // 레이어 추가 (소스가 이미 있어도 레이어는 새로 추가)
            if (!this.map.getLayer('world-territories-fill')) {
                // 월드뷰 영토 레이어 - 위성 배경이 비치도록 투명도 조정
                // 배경색 숨김 조건을 hasPixelArt 하나로 단순화
                // sovereignty에 따라 색상 변경: 소유한 영토는 빨간색, 미정복은 국가 색상
                this.map.addLayer({
                    id: 'world-territories-fill',
                    type: 'fill',
                    source: 'world-territories',
                    paint: {
                        'fill-color': [
                            'case',
                            // 소유한 영토 (ruled 또는 protected)는 빨간색
                            ['==', ['get', 'sovereignty'], 'ruled'], CONFIG.COLORS.SOVEREIGNTY.RULED,
                            ['==', ['get', 'sovereignty'], 'protected'], CONFIG.COLORS.SOVEREIGNTY.RULED,
                            // 경매 중인 영토는 주황색
                            ['==', ['get', 'sovereignty'], 'contested'], CONFIG.COLORS.SOVEREIGNTY.CONTESTED,
                            // 미정복 영토는 국가 색상 (countryColor가 없으면 hashColor, 그것도 없으면 기본 색상 사용)
                            ['coalesce', 
                                ['get', 'countryColor'], 
                                ['get', 'hashColor'], 
                                CONFIG.COLORS.SOVEREIGNTY.UNCONQUERED
                            ]
                        ],
                        'fill-opacity': [
                            'case',
                            // 주인이 있는 땅은 나라 색을 칠하지 않음 (지도가 그대로 보이게)
                            ['boolean', ['feature-state', 'owned'], false], 0,
                            // hasPixelArt가 true면 배경색 완전히 투명 (픽셀 아트만 표시)
                            ['boolean', ['feature-state', 'hasPixelArt'], false], 0,
                            // 픽셀 아트가 없는 경우: hover/selected 상태에 따라 투명도 조절
                            ['boolean', ['feature-state', 'hover'], false], 0.7,
                            ['boolean', ['feature-state', 'selected'], false], 0.8,
                            0.5  // 기본: 위성 배경이 살짝 비치도록
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
                
                // ⚠️ 중요: 경매 레이어 추가 - 내부 펄스 애니메이션
                // ⚠️ 경매 중 영역 - 경계선만 표시 (line layer)
                // 사용자 요청: 전체를 주황색으로 덮지 않고 경계선만 표시
                this.map.addLayer({
                    id: 'world-territories-auction-border',
                    type: 'line',
                    source: 'world-territories',
                    filter: ['==', ['get', 'auctionStatus'], 'active'],  // 경매 중만 표시
                    paint: {
                        'line-color': '#ff6600',  // 주황색
                        'line-width': [
                            'case',
                            // 선택된 territory일 때만 경계선 표시 (약간 두껍게)
                            ['boolean', ['feature-state', 'selected'], false], 2.5,
                            // hover 상태일 때도 약간 표시
                            ['boolean', ['feature-state', 'hover'], false], 1.5,
                            // 기본: 거의 보이지 않게 (0.5px)
                            0.5
                        ],
                        'line-opacity': [
                            'case',
                            // 선택된 territory일 때만 선명하게 표시
                            ['boolean', ['feature-state', 'selected'], false], 0.8,
                            // hover 상태일 때도 약간 표시
                            ['boolean', ['feature-state', 'hover'], false], 0.4,
                            // 기본: 거의 보이지 않게
                            0.2
                        ],
                        'line-dasharray': [2, 2]  // 점선으로 표시하여 더 눈에 띄게
                    }
                });
                
                // 경매 중 영역 - 내부 펄스 애니메이션 (fill layer) - 채우기 제거 (경계선만 사용)
                this.map.addLayer({
                    id: 'world-territories-auction-pulse',
                    type: 'fill',
                    source: 'world-territories',
                    filter: ['==', ['get', 'auctionStatus'], 'active'],  // 경매 중만 표시
                    paint: {
                        'fill-color': '#ff6600',  // 주황색
                        // ⚠️ 채우기 완전히 제거 (경계선만 사용)
                        'fill-opacity': 0  // 채우기 제거
                    }
                });
                
                this.setupTerritoryInteractions('world-territories');
            }
            
            this.activeLayerIds.add('world-territories');
            
            // [NEW] LAYERS_READY 이벤트 발행 (Ready Gate용)
            // world-territories 소스와 레이어가 모두 추가된 후 발행
            eventBus.emit(EVENTS.LAYERS_READY, {
                sourceId: 'world-territories',
                layerIds: ['world-territories-fill', 'world-territories-line']
            });
            
            // Fly to world view
            this.flyTo([0, 20], 2);
            
            log.info(`World View loaded: ${worldData.features.length} regions`);
            
            // World View 로드 완료 이벤트 발생
            eventBus.emit(EVENTS.WORLD_VIEW_LOADED, {
                featureCount: worldData.features.length,
                sourceId: 'world-territories'
            });
            
            // ⚡ 안정성: 중복 실행 방지 가드
            if (this._hasStartedInitialDeferredWork) {
                log.debug('[MapController] Initial deferred work already started, skipping');
                return true;
            }
            
            // ⚡ 안정성: 예외 발생 시에도 플래그가 영원히 true로 고정되지 않게 try/finally 사용
            try {
                this._hasStartedInitialDeferredWork = true;
                
                // ⚡ 성능 최적화: 지도 첫 프레임 보장 후 idle 실행
                // World View 로드 후 소유한 영토 상태 업데이트는 지도 첫 렌더 후 idle 시간에 수행
                const scheduleOwnedTerritoriesUpdate = () => {
                    // ⚡ 안정성: 중복 실행 방지 (이미 실행 중이면 스킵)
                    if (this._ownedTerritoriesUpdateScheduled) {
                        return;
                    }
                    this._ownedTerritoriesUpdateScheduled = true;
                    
                    if (window.requestIdleCallback) {
                        requestIdleCallback(() => {
                            this.updateOwnedTerritoriesInWorldView().catch(err => {
                                log.warn('[MapController] Failed to update owned territories in idle:', err);
                            }).finally(() => {
                                // ⚡ 안정성: 완료 후 플래그 해제 (재시도 가능 상태로)
                                this._ownedTerritoriesUpdateScheduled = false;
                            });
                        }, { timeout: 2000 });
                    } else {
                        setTimeout(() => {
                            this.updateOwnedTerritoriesInWorldView().catch(err => {
                                log.warn('[MapController] Failed to update owned territories:', err);
                            }).finally(() => {
                                // ⚡ 안정성: 완료 후 플래그 해제
                                this._ownedTerritoriesUpdateScheduled = false;
                            });
                        }, 2000);
                    }
                };
                
                // 지도 첫 렌더 보장 후 실행
                if (this.map) {
                    // 첫 render 이벤트 후 300ms 지연 (지도 보이는 순간 다음 단계로)
                    this.map.once('render', () => {
                        setTimeout(() => {
                            scheduleOwnedTerritoriesUpdate();
                        }, 300);
                    });
                    
                    // idle 이벤트도 대기 (더 확실한 보장) - 하지만 이미 실행 중이면 스킵
                    this.map.once('idle', () => {
                        scheduleOwnedTerritoriesUpdate();
                    });
                    
                    // idle이 오지 않는 경우를 대비한 fallback (2초 후)
                    setTimeout(() => {
                        scheduleOwnedTerritoriesUpdate();
                    }, 2000);
                } else {
                    // map이 없으면 바로 스케줄링
                    scheduleOwnedTerritoriesUpdate();
                }
            } catch (error) {
                // ⚡ 안정성: 예외 발생 시 플래그 해제하여 재시도 가능하게
                log.error('[MapController] Error in initial deferred work setup:', error);
                this._hasStartedInitialDeferredWork = false;
                throw error;
            }
            
            return true;
            
        } catch (error) {
            log.error('Failed to load World View:', error);
            return false;
        }
    }
    
    /**
     * World View에서 소유한 영토 상태 업데이트
     */
    async updateOwnedTerritoriesInWorldView() {
        try {
            if (!this.pixelMapRenderer || !this.pixelMapRenderer.updatePipeline) {
                log.warn('[MapController] PixelMapRenderer not available, skipping owned territories update');
                return;
            }
            
            // World View가 완전히 로드될 때까지 약간 대기 (Territory 매핑 확립)
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // TerritoryUpdatePipeline을 통해 소유한 영토 가져오기
            const ownedTerritoryIds = await this.pixelMapRenderer.updatePipeline.getOwnedTerritories();
            
            if (ownedTerritoryIds.length === 0) {
                log.debug('[MapController] No owned territories to update in World View');
                return;
            }
            
            log.info(`[MapController] Updating ${ownedTerritoryIds.length} owned territories in World View...`);
            
            // 소유한 영토들을 배치로 갱신
            await this.pixelMapRenderer.updatePipeline.refreshTerritories(ownedTerritoryIds, { batchSize: 20 });
            
            log.info(`[MapController] ✅ Updated ${ownedTerritoryIds.length} owned territories in World View`);
            
        } catch (error) {
            log.error('[MapController] Failed to update owned territories in World View:', error);
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


