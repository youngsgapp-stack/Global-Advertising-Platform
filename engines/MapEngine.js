/**
 * Map Engine - v2 Architecture
 * 책임: 지도 렌더링과 시각화에만 집중 ("보여주기만")
 */
class MapEngine {
    constructor() {
        this.map = null;
        this.eventBus = window.EventBus;
        this.regionCache = new Map(); // Region 정보 캐시
        this.ownershipColors = new Map(); // Ownership Engine에서 받은 색상 정보
        this.pixelTiles = new Map(); // Pixel Engine에서 받은 타일 URL
        this.tileCache = new Map(); // 타일 이미지 캐시 (LRU)
        this.maxCacheSize = 100;
        this.visibleRegions = new Set(); // 현재 화면에 보이는 region ID들
        this.currentZoom = 0;
        this.currentBounds = null;
        
        // 레이어 관리
        this.layers = {
            core: new Map(), // Core Layer 타일
            pixel: new Map(), // Pixel Layer 타일
            community: new Map() // Community Layer 타일
        };
    }

    /**
     * 지도 초기화
     * @param {string} containerId - 지도 컨테이너 ID
     * @param {Object} options - 초기화 옵션
     */
    async initialize(containerId, options = {}) {
        try {
            // MapLibre GL JS 초기화
            this.map = new maplibregl.Map({
                container: containerId,
                style: options.style || 'https://demotiles.maplibre.org/style.json',
                center: options.center || [0, 0],
                zoom: options.zoom || 2,
                projection: 'globe'
            });

            // 지도 로드 완료 대기
            await new Promise((resolve) => {
                this.map.on('load', resolve);
            });

            // 이벤트 리스너 등록
            this.setupEventListeners();

            // Event Bus 구독
            this.subscribeToEvents();

            console.log('[MapEngine] 초기화 완료');
        } catch (error) {
            console.error('[MapEngine] 초기화 실패:', error);
            throw error;
        }
    }

    /**
     * 지도 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 줌 변경
        this.map.on('zoom', () => {
            this.currentZoom = this.map.getZoom();
            this.updateVisibleRegions();
        });

        // 이동 (패닝)
        this.map.on('moveend', () => {
            this.currentBounds = this.map.getBounds();
            this.updateVisibleRegions();
        });

        // 회전
        this.map.on('rotate', () => {
            // 필요시 처리
        });

        // Region 클릭
        this.map.on('click', (e) => {
            this.handleRegionClick(e);
        });
    }

    /**
     * Event Bus 구독
     */
    subscribeToEvents() {
        // Ownership Engine에서 소유권 업데이트 받기
        this.eventBus.on('ownership:updated', (data) => {
            this.updateOwnershipColor(data.regionId, data.color);
        });

        // Pixel Engine에서 타일 업데이트 받기
        this.eventBus.on('pixel:tileUpdated', (data) => {
            this.updatePixelTile(data.regionId, data.tileUrl);
        });

        // Visual 업데이트 받기
        this.eventBus.on('visual:updated', (data) => {
            this.updateVisualLayer(data.regionId, data.layer, data.tileUrl);
        });
    }

    /**
     * 화면에 보이는 Region 업데이트
     */
    updateVisibleRegions() {
        if (!this.map || !this.currentBounds) return;

        const bounds = this.map.getBounds();
        const zoom = this.map.getZoom();
        
        // LOD 전략에 따라 필터링
        const strategy = this.getLoadStrategy(zoom);
        
        // 화면에 보이는 region 계산 (실제 구현은 GeoJSON 기반으로)
        const visibleRegionIds = this.calculateVisibleRegions(bounds, strategy);
        
        // 변경사항이 있으면 Event Bus에 알림
        const previousVisible = new Set(this.visibleRegions);
        this.visibleRegions = new Set(visibleRegionIds);
        
        // 새로 보이는 region
        const newlyVisible = visibleRegionIds.filter(id => !previousVisible.has(id));
        // 더 이상 보이지 않는 region
        const noLongerVisible = Array.from(previousVisible).filter(id => !this.visibleRegions.has(id));

        if (newlyVisible.length > 0 || noLongerVisible.length > 0) {
            this.eventBus.emit('viewport:changed', {
                visible: Array.from(this.visibleRegions),
                newlyVisible,
                noLongerVisible,
                strategy
            });
        }
    }

    /**
     * LOD (Level of Detail) 전략 결정
     * @param {number} zoom - 현재 줌 레벨
     * @returns {Object} - 로딩 전략
     */
    getLoadStrategy(zoom) {
        if (zoom < 3) {
            return { type: 'country', loadPixel: false, loadCommunity: false };
        } else if (zoom < 6) {
            return { type: 'state', loadPixel: false, loadCommunity: false };
        } else if (zoom < 9) {
            return { type: 'city', loadPixel: true, loadCommunity: false };
        } else {
            return { type: 'detailed', loadPixel: true, loadCommunity: true };
        }
    }

    /**
     * 화면에 보이는 Region 계산 (간단한 구현)
     * 실제로는 GeoJSON과 bounds를 비교하여 계산해야 함
     * @param {Object} bounds - 지도 경계
     * @param {Object} strategy - LOD 전략
     * @returns {Array<string>} - Region ID 배열
     */
    calculateVisibleRegions(bounds, strategy) {
        // TODO: 실제 GeoJSON 기반 계산 로직 구현
        // 현재는 캐시된 region 정보를 기반으로 계산
        const visible = [];
        this.regionCache.forEach((region, id) => {
            if (this.isRegionVisible(region, bounds)) {
                visible.push(id);
            }
        });
        return visible;
    }

    /**
     * Region이 화면에 보이는지 확인
     * @param {Object} region - Region 정보
     * @param {Object} bounds - 지도 경계
     * @returns {boolean}
     */
    isRegionVisible(region, bounds) {
        // TODO: 실제 GeoJSON geometry와 bounds 교차 검사
        // 간단한 구현 예시
        if (!region.geometry || !region.geometry.coordinates) return false;
        // 실제로는 turf.js 같은 라이브러리 사용 권장
        return true;
    }

    /**
     * Region 클릭 처리
     * @param {Object} e - 클릭 이벤트
     */
    handleRegionClick(e) {
        // 클릭된 feature 찾기
        const features = this.map.queryRenderedFeatures(e.point, {
            layers: ['regions'] // 실제 레이어 이름에 맞게 수정
        });

        if (features.length > 0) {
            const feature = features[0];
            const regionId = feature.properties.id || feature.properties.regionId;
            
            if (regionId) {
                // Event Bus를 통해 다른 엔진에 알림
                this.eventBus.emit('region:clicked', {
                    regionId,
                    coordinates: e.lngLat,
                    feature
                });
            }
        }
    }

    /**
     * 소유권 색상 업데이트
     * @param {string} regionId - Region ID
     * @param {string} color - 색상 (hex)
     */
    updateOwnershipColor(regionId, color) {
        this.ownershipColors.set(regionId, color);
        this.renderRegion(regionId);
    }

    /**
     * 픽셀 타일 업데이트
     * @param {string} regionId - Region ID
     * @param {string} tileUrl - 타일 URL
     */
    updatePixelTile(regionId, tileUrl) {
        this.pixelTiles.set(regionId, tileUrl);
        this.layers.pixel.set(regionId, tileUrl);
        this.renderPixelLayer(regionId);
    }

    /**
     * Visual 레이어 업데이트
     * @param {string} regionId - Region ID
     * @param {string} layer - 레이어 타입 (core/pixel/community)
     * @param {string} tileUrl - 타일 URL
     */
    updateVisualLayer(regionId, layer, tileUrl) {
        if (this.layers[layer]) {
            this.layers[layer].set(regionId, tileUrl);
            this.renderLayer(regionId, layer);
        }
    }

    /**
     * Region 렌더링
     * @param {string} regionId - Region ID
     */
    renderRegion(regionId) {
        if (!this.map) return;

        const color = this.ownershipColors.get(regionId) || '#cccccc';
        
        // 지도 스타일 업데이트
        // 실제 구현은 MapLibre GL JS의 setPaintProperty 사용
        try {
            this.map.setPaintProperty('regions', 'fill-color', [
                'case',
                ['==', ['get', 'id'], regionId],
                color,
                ['get', 'fill-color']
            ]);
        } catch (error) {
            console.warn(`[MapEngine] Region 렌더링 실패 (${regionId}):`, error);
        }
    }

    /**
     * Pixel 레이어 렌더링
     * @param {string} regionId - Region ID
     */
    async renderPixelLayer(regionId) {
        if (!this.map) return;

        const tileUrl = this.pixelTiles.get(regionId);
        if (!tileUrl) return;

        // 타일 이미지 로딩
        const image = await this.loadTileImage(tileUrl);
        if (!image) return;

        // 지도에 이미지 추가
        const imageId = `pixel_${regionId}`;
        if (!this.map.hasImage(imageId)) {
            this.map.addImage(imageId, image);
        }

        // 레이어 스타일 업데이트
        // 실제 구현은 MapLibre GL JS의 레이어 시스템 사용
    }

    /**
     * 레이어 렌더링
     * @param {string} regionId - Region ID
     * @param {string} layerType - 레이어 타입
     */
    async renderLayer(regionId, layerType) {
        const tileUrl = this.layers[layerType]?.get(regionId);
        if (!tileUrl) return;

        const image = await this.loadTileImage(tileUrl);
        if (!image) return;

        const imageId = `${layerType}_${regionId}`;
        if (!this.map.hasImage(imageId)) {
            this.map.addImage(imageId, image);
        }
    }

    /**
     * 타일 이미지 로딩 (캐싱 포함)
     * @param {string} tileUrl - 타일 URL
     * @returns {Promise<Image>}
     */
    loadTileImage(tileUrl) {
        // 캐시 확인
        if (this.tileCache.has(tileUrl)) {
            return Promise.resolve(this.tileCache.get(tileUrl));
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                // 캐시에 저장
                this.setCachedTile(tileUrl, img);
                resolve(img);
            };
            img.onerror = reject;
            img.src = tileUrl;
        });
    }

    /**
     * 타일 캐시에 저장 (LRU)
     * @param {string} tileUrl - 타일 URL
     * @param {Image} image - 이미지 객체
     */
    setCachedTile(tileUrl, image) {
        if (this.tileCache.size >= this.maxCacheSize) {
            // LRU: 가장 오래된 항목 제거
            const firstKey = this.tileCache.keys().next().value;
            this.tileCache.delete(firstKey);
        }
        this.tileCache.set(tileUrl, image);
    }

    /**
     * Region 정보 캐시에 추가
     * @param {string} regionId - Region ID
     * @param {Object} regionInfo - Region 정보
     */
    cacheRegionInfo(regionId, regionInfo) {
        this.regionCache.set(regionId, regionInfo);
    }

    /**
     * GeoJSON 데이터 로딩 및 렌더링
     * @param {string} sourceId - 소스 ID
     * @param {Object} geoJson - GeoJSON 데이터
     */
    async loadGeoJson(sourceId, geoJson) {
        if (!this.map) return;

        // 소스 추가
        if (this.map.getSource(sourceId)) {
            this.map.getSource(sourceId).setData(geoJson);
        } else {
            this.map.addSource(sourceId, {
                type: 'geojson',
                data: geoJson
            });
        }

        // 레이어 추가
        if (!this.map.getLayer('regions')) {
            this.map.addLayer({
                id: 'regions',
                type: 'fill',
                source: sourceId,
                paint: {
                    'fill-color': '#cccccc',
                    'fill-opacity': 0.5
                }
            });
        }

        // Region 정보 캐시에 저장
        if (geoJson.features) {
            geoJson.features.forEach(feature => {
                const regionId = feature.properties.id || feature.properties.regionId;
                if (regionId) {
                    this.cacheRegionInfo(regionId, {
                        id: regionId,
                        name: feature.properties.name,
                        geometry: feature.geometry
                    });
                }
            });
        }
    }

    /**
     * Event Bus 요청 핸들러 등록
     */
    registerRequestHandlers() {
        // 현재 보이는 region 목록 요청
        this.eventBus.registerRequestHandler('map:getVisibleRegions', () => {
            return Promise.resolve(Array.from(this.visibleRegions));
        });

        // Region 정보 요청
        this.eventBus.registerRequestHandler('map:getRegionInfo', (data) => {
            const regionInfo = this.regionCache.get(data.regionId);
            return Promise.resolve(regionInfo || null);
        });
    }

    /**
     * 정리 및 리소스 해제
     */
    destroy() {
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.regionCache.clear();
        this.ownershipColors.clear();
        this.pixelTiles.clear();
        this.tileCache.clear();
        this.visibleRegions.clear();
    }
}

// 전역으로 내보내기
window.MapEngine = MapEngine;

