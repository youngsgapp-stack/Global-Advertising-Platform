/**
 * PixelMapRenderer3 - 맵에 픽셀 데이터 반영 시스템
 * Canvas 이미지를 맵에 오버레이하여 영토 경계에 맞춰 표시
 * 맵 로드 시 모든 영토의 픽셀 아트를 자동으로 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { pixelDataService } from '../services/PixelDataService.js';
import { territoryManager } from './TerritoryManager.js';
import { firebaseService } from '../services/FirebaseService.js';
import mapController from './MapController.js';
import TerritoryUpdatePipeline from './TerritoryUpdatePipeline.js';
import { TerritoryViewState } from './TerritoryViewState.js';

class PixelMapRenderer3 {
    constructor(mapController) {
        this.mapController = mapController;
        this.map = null;
        this.pixelImageCache = new Map(); // territoryId -> image
        this.processedTerritories = new Set(); // 이미 처리한 영토 (중복 방지)
        
        // 통합 갱신 파이프라인 초기화
        this.updatePipeline = new TerritoryUpdatePipeline(this);
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.map = this.mapController.map;
        this.updatePipeline.initialize(this.map);
        this.setupEvents();
        
        // World View 로드 완료 후 초기 로드 (우선순위 1)
        eventBus.once(EVENTS.WORLD_VIEW_LOADED, () => {
            console.log('[PixelMapRenderer3] ✅ WORLD_VIEW_LOADED event received, starting initial load...');
            // World View가 로드되었으므로 Territory 매핑이 가능함
            setTimeout(() => {
                this.waitForLayersAndLoad(3, 500); // 재시도 횟수 감소 (이미 World View 로드됨)
            }, 500);
        });
        
        // 맵 로드 완료 후 파이프라인을 통한 초기 로드 (fallback)
        eventBus.once(EVENTS.MAP_LOADED, () => {
            console.log('[PixelMapRenderer3] ✅ MAP_LOADED event received, waiting for layers...');
            // 레이어가 준비될 때까지 기다린 후 처리
            this.waitForLayersAndLoad();
        });
        
        // APP_READY 이벤트 후에도 다시 시도 (fallback)
        eventBus.once(EVENTS.APP_READY, () => {
            console.log('[PixelMapRenderer3] ✅ APP_READY event received, waiting for layers...');
            setTimeout(() => {
                this.waitForLayersAndLoad();
            }, 2000); // World View 로드를 기다리기 위해 지연 증가
        });
        
        log.info('[PixelMapRenderer3] Initialized with TerritoryUpdatePipeline');
    }
    
    /**
     * 레이어가 준비될 때까지 기다린 후 초기 로드
     */
    async waitForLayersAndLoad(maxRetries = 5, retryDelay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // 맵 스타일에서 GeoJSON 소스 확인
                const style = this.map?.getStyle();
                if (!style || !style.sources) {
                    log.debug(`[PixelMapRenderer3] Attempt ${attempt}: Map style not ready, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                
                // GeoJSON 소스가 있는지 확인
                const geojsonSources = Object.keys(style.sources).filter(sourceId => {
                    try {
                        const source = this.map.getSource(sourceId);
                        return source && source.type === 'geojson';
                    } catch (e) {
                        return false;
                    }
                });
                
                if (geojsonSources.length === 0) {
                    log.debug(`[PixelMapRenderer3] Attempt ${attempt}: No GeoJSON sources found, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                
                // 레이어가 실제로 추가되었는지 확인
                let hasLayers = false;
                for (const sourceId of geojsonSources) {
                    const fillLayerId = `${sourceId}-fill`;
                    if (this.map.getLayer(fillLayerId)) {
                        hasLayers = true;
                        break;
                    }
                }
                
                if (!hasLayers) {
                    log.debug(`[PixelMapRenderer3] Attempt ${attempt}: No fill layers found, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }
                
                // 레이어가 준비되었으므로 초기 로드 실행
                console.log(`[PixelMapRenderer3] ✅ Layers ready (attempt ${attempt}), starting initial load...`);
                console.log(`[PixelMapRenderer3] Found ${geojsonSources.length} GeoJSON sources: ${geojsonSources.join(', ')}`);
                await this.updatePipeline.initialLoad();
                console.log('[PixelMapRenderer3] ✅ Initial load completed');
                return;
                
            } catch (error) {
                log.warn(`[PixelMapRenderer3] Attempt ${attempt} failed:`, error);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
        
        // 최대 재시도 횟수 초과 시에도 시도 (정상적인 동작 - World View 로드 전일 수 있음)
        log.debug(`[PixelMapRenderer3] Max retries reached, attempting initial load anyway (World View may not be loaded yet)...`);
        try {
            await this.updatePipeline.initialLoad();
        } catch (error) {
            log.error('[PixelMapRenderer3] Initial load failed after max retries:', error);
        }
    }
    
    /**
     * 이벤트 설정
     * 컨설팅 원칙: 모든 영토 변경 이벤트가 같은 갱신 파이프라인을 거치도록 통합
     */
    setupEvents() {
        // 픽셀 저장 시 파이프라인을 통한 갱신
        eventBus.on(EVENTS.PIXEL_CANVAS_SAVED, async (data) => {
            const territoryId = data.territoryId || data.territory?.id;
            if (territoryId) {
                console.log(`[PixelMapRenderer3] 🔄 Pixel saved, refreshing territory ${territoryId}`);
                // forceRefresh 플래그로 강제 새로고침
                await this.updatePipeline.refreshTerritory(territoryId, { forceRefresh: true });
            }
        });
        
        // PIXEL_DATA_SAVED 이벤트도 처리 (PixelDataService에서 발행)
        eventBus.on(EVENTS.PIXEL_DATA_SAVED, async (data) => {
            // ⚠️ 핵심 수정: data가 없거나 undefined인 경우 처리
            if (!data) {
                console.warn('[PixelMapRenderer3] PIXEL_DATA_SAVED event received without data');
                return;
            }
            const territoryId = data.territoryId;
            if (territoryId) {
                console.log(`[PixelMapRenderer3] 🔄 Pixel data saved, refreshing territory ${territoryId}`);
                // forceRefresh 플래그로 강제 새로고침
                await this.updatePipeline.refreshTerritory(territoryId, { forceRefresh: true });
            } else {
                console.warn('[PixelMapRenderer3] PIXEL_DATA_SAVED event received without territoryId');
            }
        });
        
        // 영토 업데이트 시 파이프라인을 통한 갱신 (조건 없이 항상 실행)
        // ⚠️ 이벤트 payload의 territory를 신뢰하지 않고 id만 사용
        eventBus.on(EVENTS.TERRITORY_UPDATE, async (data) => {
            const territoryId = data.territoryId || (data.territory && data.territory.id);
            if (territoryId) {
                // forceRefresh 플래그 전달
                await this.updatePipeline.refreshTerritory(territoryId, {
                    forceRefresh: data.forceRefresh || false,
                    revision: data.revision // revision 전달
                });
            }
        });
        
        // 영토 정복 시 파이프라인을 통한 갱신
        eventBus.on(EVENTS.TERRITORY_CONQUERED, async (data) => {
            const territoryId = data.territoryId || data.territory?.id;
            if (territoryId) {
                await this.updatePipeline.refreshTerritory(territoryId);
            }
        });
        
        // 영토 선택 시 파이프라인을 통한 갱신 (조건 없이 항상 실행)
        eventBus.on(EVENTS.TERRITORY_SELECT, async (data) => {
            const territoryId = data.territory?.id || data.territoryId;
            if (territoryId) {
                await this.updatePipeline.refreshTerritory(territoryId);
            }
        });
        
        // 맵 레이어 추가 시 해당 영토들의 픽셀 아트 표시
        eventBus.on(EVENTS.MAP_LAYER_ADDED, async (data) => {
            if (data.sourceId && data.geoJsonData) {
                const territoryIds = this.extractTerritoryIds(data.geoJsonData);
                if (territoryIds.length > 0) {
                    log.info(`[PixelMapRenderer3] MAP_LAYER_ADDED: Refreshing ${territoryIds.length} territories for source ${data.sourceId}`);
                    await this.updatePipeline.refreshTerritories(territoryIds);
                }
            } else if (data.sourceId) {
                // geoJsonData가 없으면 맵에서 직접 가져오기
                try {
                    const source = this.map?.getSource(data.sourceId);
                    if (source && source.type === 'geojson' && source._data) {
                        const territoryIds = this.extractTerritoryIds(source._data);
                        if (territoryIds.length > 0) {
                            log.info(`[PixelMapRenderer3] MAP_LAYER_ADDED: Refreshing ${territoryIds.length} territories for source ${data.sourceId} (from map)`);
                            await this.updatePipeline.refreshTerritories(territoryIds);
                        }
                    }
                } catch (error) {
                    log.warn(`[PixelMapRenderer3] Failed to extract territory IDs from source ${data.sourceId}:`, error);
                }
            }
        });
    }
    
    /**
     * GeoJSON에서 영토 ID 추출
     */
    extractTerritoryIds(geoJsonData) {
        if (!geoJsonData || !geoJsonData.features) return [];
        
        const territoryIds = [];
        for (const feature of geoJsonData.features) {
            const territoryId = feature.properties?.id || feature.id;
            if (territoryId) {
                territoryIds.push(territoryId);
            }
        }
        return territoryIds;
    }
    
    /**
     * 배치 처리 헬퍼: 동시 요청 수 제한
     */
    async processBatch(items, batchSize, processor) {
        const results = [];
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(processor));
            results.push(...batchResults);
            
            // 배치 사이에 약간의 지연 (Firebase 부하 방지)
            if (i + batchSize < items.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        return results;
    }
    
    /**
     * 특정 레이어의 모든 영토 픽셀 아트 로드
     */
    async loadPixelArtsForLayer(sourceId, geoJsonData) {
        if (!this.map || !geoJsonData || !geoJsonData.features) return;
        
        log.info(`[PixelMapRenderer3] Loading pixel arts for layer ${sourceId}...`);
        
        try {
            // 처리할 영토 목록 준비
            const territoriesToProcess = [];
            
            for (const feature of geoJsonData.features) {
                const territoryId = feature.properties?.id || feature.id;
                if (!territoryId) continue;
                
                // 이미 처리한 영토는 건너뛰기
                if (this.processedTerritories.has(territoryId)) continue;
                
                territoriesToProcess.push({ territoryId, feature });
            }
            
            if (territoriesToProcess.length === 0) {
                log.info(`[PixelMapRenderer3] No new territories to process for layer ${sourceId}`);
                return;
            }
            
            // 배치 처리: 동시에 최대 10개씩만 요청 (Firebase 부하 방지)
            const batchSize = 10;
            const results = await this.processBatch(territoriesToProcess, batchSize, async ({ territoryId, feature }) => {
                try {
                    const pixelData = await pixelDataService.loadPixelData(territoryId);
                    return { territoryId, pixelData, feature };
                } catch (error) {
                    return { 
                        territoryId, 
                        pixelData: { pixels: [], filledPixels: 0 }, 
                        feature 
                    };
                }
            });
            
            // 결과 처리
            for (const { territoryId, pixelData, feature } of results) {
                if (!pixelData || !pixelData.pixels || pixelData.pixels.length === 0) continue;
                
                // TerritoryManager에서 영토 데이터 가져오기 또는 생성
                let territory = territoryManager.getTerritory(territoryId);
                if (!territory) {
                    // 영토 데이터가 없으면 기본 객체 생성
                    territory = {
                        id: territoryId,
                        sourceId: sourceId,
                        featureId: feature.id,
                        pixelCanvas: {
                            filledPixels: pixelData.filledPixels || pixelData.pixels.length
                        },
                        geometry: feature.geometry,
                        properties: feature.properties
                    };
                    territoryManager.territories.set(territoryId, territory);
                } else {
                    // 기존 영토 데이터 업데이트
                    territory.sourceId = sourceId;
                    territory.featureId = feature.id;
                    territory.geometry = feature.geometry;
                    territory.pixelCanvas = territory.pixelCanvas || {};
                    territory.pixelCanvas.filledPixels = pixelData.filledPixels || pixelData.pixels.length;
                }
                
                // 픽셀 아트 표시
                await this.loadAndDisplayPixelArt(territory);
                this.processedTerritories.add(territoryId);
            }
            
            log.info(`[PixelMapRenderer3] Processed ${territoriesToProcess.length} territories for layer ${sourceId}`);
            
        } catch (error) {
            log.error(`[PixelMapRenderer3] Failed to load pixel arts for layer ${sourceId}:`, error);
        }
    }
    
    /**
     * 모든 영토의 픽셀 아트 로드 및 표시
     */
    async loadAllPixelArts() {
        if (!this.map) return;
        
        log.info('[PixelMapRenderer3] Loading all pixel arts...');
        
        try {
            // 맵 스타일에서 모든 소스 확인
            const style = this.map.getStyle();
            if (!style || !style.sources) {
                log.warn('[PixelMapRenderer3] Map style not ready');
                return;
            }
            
            const allSourceIds = Object.keys(style.sources);
            log.info(`[PixelMapRenderer3] Found ${allSourceIds.length} sources`);
            
            for (const sourceId of allSourceIds) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    log.info(`[PixelMapRenderer3] Processing source ${sourceId} with ${data.features.length} features`);
                    
                    // 처리할 영토 목록 준비
                    const territoriesToProcess = [];
                    
                    for (const feature of data.features) {
                        const territoryId = feature.properties?.id || feature.id;
                        if (!territoryId) continue;
                        
                        // 이미 처리한 영토는 건너뛰기
                        if (this.processedTerritories.has(territoryId)) continue;
                        
                        territoriesToProcess.push({ territoryId, feature });
                    }
                    
                    if (territoriesToProcess.length === 0) continue;
                    
                    // 배치 처리: 동시에 최대 10개씩만 요청 (Firebase 부하 방지)
                    const batchSize = 10;
                    const results = await this.processBatch(territoriesToProcess, batchSize, async ({ territoryId, feature }) => {
                        try {
                            const pixelData = await pixelDataService.loadPixelData(territoryId);
                            return { territoryId, pixelData, feature };
                        } catch (error) {
                            return { 
                                territoryId, 
                                pixelData: { pixels: [], filledPixels: 0 }, 
                                feature 
                            };
                        }
                    });
                    
                    for (const { territoryId, pixelData, feature } of results) {
                        if (!pixelData || !pixelData.pixels || pixelData.pixels.length === 0) continue;
                        
                        // TerritoryManager에서 영토 데이터 가져오기 또는 생성
                        let territory = territoryManager.getTerritory(territoryId);
                        if (!territory) {
                            territory = {
                                id: territoryId,
                                sourceId: sourceId,
                                featureId: feature.id,
                                pixelCanvas: {
                                    filledPixels: pixelData.filledPixels || pixelData.pixels.length
                                },
                                geometry: feature.geometry,
                                properties: feature.properties
                            };
                            territoryManager.territories.set(territoryId, territory);
                        } else {
                            territory.sourceId = sourceId;
                            territory.featureId = feature.id;
                            territory.geometry = feature.geometry;
                            territory.pixelCanvas = territory.pixelCanvas || {};
                            territory.pixelCanvas.filledPixels = pixelData.filledPixels || pixelData.pixels.length;
                        }
                        
                        // 픽셀 아트 표시
                        await this.loadAndDisplayPixelArt(territory);
                        this.processedTerritories.add(territoryId);
                    }
                } catch (error) {
                    log.warn(`[PixelMapRenderer3] Error processing source ${sourceId}:`, error);
                }
            }
            
            log.info(`[PixelMapRenderer3] Loaded pixel arts for ${this.processedTerritories.size} territories`);
            
        } catch (error) {
            log.error('[PixelMapRenderer3] Failed to load all pixel arts:', error);
        }
    }
    
    /**
     * 저장된 픽셀 데이터를 로드해서 맵에 표시
     */
    async loadAndDisplayPixelArt(territory) {
        if (!this.map || !territory) return;
        
        console.log(`🔍 [PixelMapRenderer3] ========== loadAndDisplayPixelArt START ==========`);
        console.log(`🔍 [PixelMapRenderer3] territory:`, {
            id: territory?.id,
            sourceId: territory?.sourceId || 'null',
            featureId: territory?.featureId || 'null',
            hasGeometry: !!territory?.geometry
        });
        
        try {
            // processedTerritories에서 제거하여 재처리 보장
            // 모바일에서 편집 후 저장했을 때 맵에 즉시 반영되도록 하는 핵심 로직
            this.processedTerritories.delete(territory.id);
            console.log(`🔍 [PixelMapRenderer3] Removed from processedTerritories`);
            
            // 픽셀 데이터 로드 (캐시 무효화 후 최신 데이터)
            console.log(`🔍 [PixelMapRenderer3] Loading pixel data for ${territory.id}`);
            const pixelData = await pixelDataService.loadPixelData(territory.id);
            console.log(`🔍 [PixelMapRenderer3] Pixel data loaded:`, {
                hasPixelData: !!pixelData,
                hasPixels: !!(pixelData && pixelData.pixels),
                pixelsLength: pixelData?.pixels?.length || 0,
                filledPixels: pixelData?.filledPixels || 0
            });
            
            if (!pixelData || !pixelData.pixels || pixelData.pixels.length === 0) {
                console.log(`🔍 [PixelMapRenderer3] ⚠️ No pixel data to display, returning early`);
                return; // 픽셀 데이터가 없으면 종료
            }
            
            // 영토 경계 가져오기
            console.log(`🔍 [PixelMapRenderer3] Getting territory bounds`);
            let bounds = pixelData.bounds;
            if (!bounds) {
                // bounds가 없으면 영토 geometry에서 계산
                const geometry = territory.geometry || await this.getTerritoryGeometry(territory);
                if (!geometry) {
                    console.log(`🔍 [PixelMapRenderer3] ⚠️ No geometry available, returning`);
                    return;
                }
                bounds = this.calculateBounds(geometry);
                console.log(`🔍 [PixelMapRenderer3] ✅ Bounds calculated from geometry:`, bounds);
            } else {
                console.log(`🔍 [PixelMapRenderer3] ✅ Using bounds from pixelData:`, bounds);
            }
            
            // 픽셀 데이터를 Canvas로 렌더링
            console.log(`🔍 [PixelMapRenderer3] Rendering pixels to image`);
            const imageDataUrl = await this.renderPixelsToImage(pixelData, bounds);
            console.log(`🔍 [PixelMapRenderer3] Image rendered:`, {
                hasImageDataUrl: !!imageDataUrl,
                imageDataUrlLength: imageDataUrl?.length || 0
            });
            
            if (imageDataUrl) {
                console.log(`🔍 [PixelMapRenderer3] Updating pixel overlay`);
                await this.updatePixelOverlay(territory, imageDataUrl, bounds);
                console.log(`🔍 [PixelMapRenderer3] ✅ Pixel overlay updated`);
                
                // 모바일에서도 즉시 반영되도록 맵 강제 새로고침
                if (this.map) {
                    console.log(`🔍 [PixelMapRenderer3] Triggering map repaint`);
                    this.map.triggerRepaint();
                    // 약간의 지연 후 다시 새로고침하여 확실하게 반영
                    setTimeout(() => {
                        if (this.map) {
                            this.map.triggerRepaint();
                        }
                    }, 50);
                }
                
            // feature state 업데이트 - 픽셀 아트 존재 표시 (기존 fill 색상 투명하게)
            // 핵심: sourceId/featureId가 없으면 재검색
            console.log(`🔍 [PixelMapRenderer3] Checking sourceId/featureId:`, {
                sourceId: territory.sourceId || 'null',
                featureId: territory.featureId || 'null'
            });
            
            if (territory.sourceId && territory.featureId) {
                console.log(`🔍 [PixelMapRenderer3] Setting feature state`);
                // TerritoryViewState를 사용하여 정확한 feature state 생성 (Firestore 단일 원천)
                const viewState = new TerritoryViewState(territory.id, territory, pixelData);
                const featureState = viewState.toFeatureState();
                
                try {
                    this.map.setFeatureState(
                        { source: territory.sourceId, id: territory.featureId },
                        featureState
                    );
                    
                    // fill-opacity가 즉시 반영되도록 맵 강제 새로고침
                    this.map.triggerRepaint();
                    
                    console.log(`🔍 [PixelMapRenderer3] ✅ Feature state set:`, {
                        hasPixelArt: featureState.hasPixelArt,
                        fillRatio: featureState.pixelFillRatio?.toFixed(2) || 'null',
                        sourceId: territory.sourceId,
                        featureId: territory.featureId
                    });
                    
                    if (featureState.hasPixelArt) {
                        console.log(`[PixelMapRenderer3] ✅ Updated feature state for ${territory.id}: hasPixelArt=${featureState.hasPixelArt}, fillRatio=${featureState.pixelFillRatio.toFixed(2)}, sourceId=${territory.sourceId}, featureId=${territory.featureId}`);
                    }
                } catch (error) {
                    console.log(`🔍 [PixelMapRenderer3] ❌ Failed to set feature state:`, error);
                    log.error(`[PixelMapRenderer3] Failed to set feature state for ${territory.id}:`, error);
                    // 재시도: 매핑 재확립
                    console.log(`🔍 [PixelMapRenderer3] Retrying: re-establishing mapping`);
                    await this.updatePipeline.refreshTerritory(territory.id);
                    territory = territoryManager.getTerritory(territory.id);
                    if (territory && territory.sourceId && territory.featureId) {
                        const viewState = new TerritoryViewState(territory.id, territory, pixelData);
                        const featureState = viewState.toFeatureState();
                        this.map.setFeatureState(
                            { source: territory.sourceId, id: territory.featureId },
                            featureState
                        );
                        this.map.triggerRepaint();
                        console.log(`🔍 [PixelMapRenderer3] ✅ Retry successful`);
                    } else {
                        console.log(`🔍 [PixelMapRenderer3] ⚠️ Retry failed: still no sourceId/featureId`);
                    }
                }
            } else {
                // sourceId/featureId가 없으면 재검색 (World View가 아직 로드되지 않았을 수 있음)
                console.log(`🔍 [PixelMapRenderer3] ⚠️ Missing sourceId/featureId, re-establishing mapping...`);
                log.debug(`[PixelMapRenderer3] Missing sourceId/featureId for ${territory.id}, re-establishing mapping...`);
                await this.updatePipeline.refreshTerritory(territory.id);
                territory = territoryManager.getTerritory(territory.id);
                if (territory && territory.sourceId && territory.featureId) {
                    console.log(`🔍 [PixelMapRenderer3] ✅ Mapping re-established, setting feature state`);
                    const viewState = new TerritoryViewState(territory.id, territory, pixelData);
                    const featureState = viewState.toFeatureState();
                    this.map.setFeatureState(
                        { source: territory.sourceId, id: territory.featureId },
                        featureState
                    );
                    this.map.triggerRepaint();
                    console.log(`🔍 [PixelMapRenderer3] ✅ Feature state set after re-mapping`);
                } else {
                    // World View가 아직 로드되지 않았을 수 있으므로 조용히 실패
                    console.log(`🔍 [PixelMapRenderer3] ⚠️ Mapping still not available (World View may not be loaded)`);
                    log.debug(`[PixelMapRenderer3] Territory ${territory?.id || 'unknown'} mapping not available yet (World View may not be loaded)`);
                }
            }
            }
            
            console.log(`🔍 [PixelMapRenderer3] ========== loadAndDisplayPixelArt END ==========`);
            
        } catch (error) {
            console.log(`🔍 [PixelMapRenderer3] ❌ ERROR in loadAndDisplayPixelArt:`, error);
            log.error('[PixelMapRenderer3] Failed to load and display pixel art:', error);
        }
    }
    
    /**
     * 영토 geometry 가져오기
     */
    async getTerritoryGeometry(territory) {
        if (!this.map || !territory) return null;
        
        try {
            const sourceId = territory.sourceId;
            const featureId = territory.featureId;
            
            if (!sourceId || !featureId) return null;
            
            const source = this.map.getSource(sourceId);
            if (source && source.type === 'geojson') {
                const data = source._data;
                if (data && data.features) {
                    const feature = data.features.find(f => 
                        String(f.id) === String(featureId) ||
                        String(f.properties?.id) === String(featureId)
                    );
                    return feature?.geometry || null;
                }
            }
        } catch (error) {
            log.error('[PixelMapRenderer3] Failed to get territory geometry:', error);
        }
        
        return null;
    }
    
    /**
     * 경계 계산
     */
    calculateBounds(geometry) {
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        
        const processCoordinates = (coords) => {
            if (Array.isArray(coords[0])) {
                coords.forEach(processCoordinates);
            } else if (coords.length >= 2) {
                const [lng, lat] = coords;
                minLng = Math.min(minLng, lng);
                maxLng = Math.max(maxLng, lng);
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
            }
        };
        
        if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach(processCoordinates);
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygon => {
                polygon.forEach(processCoordinates);
            });
        }
        
        return { minLng, maxLng, minLat, maxLat };
    }
    
    /**
     * 픽셀 데이터를 Canvas로 렌더링하여 이미지 생성 (투명 배경)
     */
    async renderPixelsToImage(pixelData, bounds) {
        try {
            const width = pixelData.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            const height = pixelData.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            const pixelSize = 8;
            
            // Canvas 생성 (투명 배경)
            const canvas = document.createElement('canvas');
            canvas.width = width * pixelSize;
            canvas.height = height * pixelSize;
            const ctx = canvas.getContext('2d', { alpha: true });
            
            // 배경을 투명하게 유지 (그리지 않음)
            // 픽셀 아트가 칠해진 부분만 그리기
            
            // 픽셀 그리기
            if (pixelData.pixels && Array.isArray(pixelData.pixels)) {
                for (const pixel of pixelData.pixels) {
                    const x = pixel.x;
                    const y = pixel.y;
                    const color = pixel.c || pixel.color;
                    
                    if (x >= 0 && x < width && y >= 0 && y < height && color) {
                        ctx.fillStyle = color;
                        ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
                    }
                }
            }
            
            // 투명 배경 PNG로 변환
            return canvas.toDataURL('image/png');
            
        } catch (error) {
            log.error('[PixelMapRenderer3] Failed to render pixels to image:', error);
            return null;
        }
    }
    
    /**
     * 맵에서 영토 업데이트
     * 컨설팅 원칙: TerritoryViewState를 사용하여 Firestore 단일 원천 기반으로 상태 계산
     * 
     * @param {Object} territory - 영토 데이터
     * @param {Object} pixelData - 픽셀 데이터 (선택사항, 없으면 Firestore에서 로드)
     */
    async updateTerritoryOnMap(territory, pixelData = null) {
        if (!this.map || !territory) return;
        
        try {
            const sourceId = territory.sourceId;
            const featureId = territory.featureId;
            
            if (!sourceId || !featureId) {
                log.warn('[PixelMapRenderer3] Missing sourceId or featureId:', territory);
                return;
            }
            
            // 픽셀 데이터가 없으면 Firestore에서 로드 (단일 원천)
            if (!pixelData) {
                pixelData = await pixelDataService.loadPixelData(territory.id);
            }
            
            // TerritoryViewState 생성 (상태 계산)
            const viewState = new TerritoryViewState(territory.id, territory, pixelData);
            
            // 픽셀 이미지가 있으면 맵에 오버레이
            if (pixelData?.imageDataUrl && pixelData?.bounds) {
                await this.updatePixelOverlay(territory, pixelData.imageDataUrl, pixelData.bounds);
                this.processedTerritories.add(territory.id);
            } else if (viewState.hasPixelArt) {
                // 픽셀 아트가 있으면 로드해서 표시
                if (!this.processedTerritories.has(territory.id)) {
                    await this.loadAndDisplayPixelArt(territory);
                    this.processedTerritories.add(territory.id);
                }
            }
            
            // TerritoryViewState에서 feature state 가져오기
            const featureState = viewState.toFeatureState();
            
            // 소스 존재 여부 확인
            if (!this.map.getSource(sourceId)) {
                log.debug(`[PixelMapRenderer3] Source ${sourceId} not found in map, skipping feature state update`);
                return;
            }
            
            // Mapbox feature state 업데이트
            try {
                this.map.setFeatureState(
                    { source: sourceId, id: featureId },
                    featureState
                );
            } catch (error) {
                log.debug(`[PixelMapRenderer3] Failed to set feature state for ${territory.id}:`, error);
            }
            
            // fill-opacity가 즉시 반영되도록 맵 강제 새로고침
            this.map.triggerRepaint();
            
            // 소스 데이터 업데이트
            const source = this.map.getSource(sourceId);
            if (source && source.type === 'geojson') {
                const data = source._data;
                if (data && data.features) {
                    const feature = data.features.find(f => 
                        String(f.id) === String(featureId) ||
                        String(f.properties?.id) === String(featureId)
                    );
                    if (feature) {
                        feature.properties = {
                            ...feature.properties,
                            pixelFillRatio: viewState.fillRatio,
                            filledPixels: viewState.filledPixels,
                            territoryValue: territory.territoryValue || 0
                        };
                        source.setData(data);
                    }
                }
            }
            
            log.debug(`[PixelMapRenderer3] Updated map for ${territory.id}: ${viewState.toString()}`);
            
        } catch (error) {
            log.error('[PixelMapRenderer3] Update failed:', error);
        }
    }
    
    /**
     * 채움 비율 계산 (레거시 메서드, TerritoryViewState 사용 권장)
     * @deprecated TerritoryViewState.fillRatio를 사용하세요
     */
    calculateFillRatio(territory) {
        // 하위 호환성을 위해 유지하지만, TerritoryViewState 사용 권장
        const totalPixels = CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        const filledPixels = territory.pixelCanvas?.filledPixels || 0;
        return Math.min(1, filledPixels / totalPixels);
    }
    
    /**
     * 픽셀 아트를 맵에 오버레이
     * 핵심: sourceId/featureId 검증 및 재시도
     */
    async updatePixelOverlay(territory, imageDataUrl, bounds) {
        if (!this.map || !bounds) return;
        
        // sourceId/featureId 검증 (핵심!)
        if (!territory.sourceId || !territory.featureId) {
            log.debug(`[PixelMapRenderer3] Missing sourceId/featureId for ${territory.id}, attempting to re-establish mapping...`);
            
            // TerritoryUpdatePipeline을 통해 매핑 재확립
            await this.updatePipeline.refreshTerritory(territory.id);
            territory = territoryManager.getTerritory(territory.id);
            
            // 여전히 없으면 World View가 아직 로드되지 않았을 수 있으므로 조용히 실패
            if (!territory || !territory.sourceId || !territory.featureId) {
                log.debug(`[PixelMapRenderer3] Territory ${territory?.id || 'unknown'} mapping not available yet (World View may not be loaded)`);
                return;
            }
            
            log.debug(`[PixelMapRenderer3] ✅ Re-established mapping: territoryId=${territory.id}, sourceId=${territory.sourceId}, featureId=${territory.featureId}`);
        }
        
        try {
            const layerId = `pixel-overlay-${territory.id}`;
            const sourceId = `pixel-source-${territory.id}`;
            
            // 기존 리소스 완전히 제거 (순서 중요: 레이어 -> 이미지 -> 소스)
            try {
                if (this.map.getLayer(layerId)) {
                    this.map.removeLayer(layerId);
                }
            } catch (e) {
                // 레이어가 없을 수 있음
            }
            
            try {
                if (this.map.hasImage(layerId)) {
                    this.map.removeImage(layerId);
                }
            } catch (e) {
                // 이미지가 없을 수 있음
            }
            
            try {
                if (this.map.getSource(sourceId)) {
                    this.map.removeSource(sourceId);
                }
            } catch (e) {
                // 소스가 없을 수 있음
            }
            
            // Mapbox가 내부 정리를 완료할 시간 제공
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // 이미지 로드
            const image = await this.loadImage(imageDataUrl);
            this.pixelImageCache.set(territory.id, image);
            
            // 이미지 추가 (존재 확인 후)
            if (!this.map.hasImage(layerId)) {
                this.map.addImage(layerId, image);
            }
            
            // 소스 생성 (존재 확인 후)
            if (!this.map.getSource(sourceId)) {
                const { minLng, maxLng, minLat, maxLat } = bounds;
                this.map.addSource(sourceId, {
                    type: 'image',
                    url: imageDataUrl,
                    coordinates: [
                        [minLng, maxLat], // top-left
                        [maxLng, maxLat], // top-right
                        [maxLng, minLat], // bottom-right
                        [minLng, minLat]  // bottom-left
                    ]
                });
            }
            
            // 레이어 추가 (존재 확인 후, 영토 fill 레이어 위에 배치)
            if (!this.map.getLayer(layerId)) {
                const beforeLayer = `${territory.sourceId}-fill`;
                
                // beforeLayer가 존재하는지 확인
                if (!this.map.getLayer(beforeLayer)) {
                    log.warn(`[PixelMapRenderer3] Fill layer ${beforeLayer} not found, adding overlay without beforeLayer`);
                    // beforeLayer가 없으면 그냥 추가
                    this.map.addLayer({
                        id: layerId,
                        type: 'raster',
                        source: sourceId,
                        paint: {
                            'raster-opacity': 1.0,
                            'raster-fade-duration': 0
                        }
                    });
                } else {
                    // beforeLayer가 있으면 그 앞에 추가
                    this.map.addLayer({
                        id: layerId,
                        type: 'raster',
                        source: sourceId,
                        paint: {
                            'raster-opacity': 1.0,
                            'raster-fade-duration': 0
                        }
                    }, beforeLayer);
                }
            }
            
            log.debug(`[PixelMapRenderer3] Pixel overlay added for ${territory.id}`);
            
            // 참고: fill-opacity는 TerritoryUpdatePipeline에서 feature state를 통해 자동으로 처리됨
            // hasPixelArt feature state가 설정되면 MapController의 fill-opacity 조건이 자동으로 적용됨
            
        } catch (error) {
            log.error('[PixelMapRenderer3] Failed to update pixel overlay:', error);
        }
    }
    
    /**
     * 이미지 로드
     */
    loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }
    
    /**
     * 영토 색상 업데이트
     */
    updateTerritoryColor(territory) {
        this.updateTerritoryOnMap(territory);
    }
}

/**
 * 초기화 함수
 */
export function initPixelMapRenderer3(mapController) {
    const renderer = new PixelMapRenderer3(mapController);
    renderer.initialize();
    return renderer;
}

export default PixelMapRenderer3;
