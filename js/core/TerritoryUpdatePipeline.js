/**
 * TerritoryUpdatePipeline - 영토 갱신 통합 파이프라인
 * 
 * 컨설팅 원칙:
 * - 모든 영토 변경 이벤트(MAP_LOADED, TERRITORY_UPDATE, CONQUERED 등)가 
 *   전부 같은 '갱신 파이프라인'을 거치게 만들기
 * 
 * 책임:
 * - 영토 데이터 로드
 * - 픽셀 데이터 확인 (Firestore 단일 원천)
 * - TerritoryViewState 생성
 * - 맵 업데이트
 * - 픽셀 아트 표시
 */

import { CONFIG, log } from '../config.js';
import { pixelDataService } from '../services/PixelDataService.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';
import { territoryManager } from './TerritoryManager.js';
import { TerritoryViewState } from './TerritoryViewState.js';

class TerritoryUpdatePipeline {
    constructor(pixelMapRenderer) {
        this.pixelMapRenderer = pixelMapRenderer;
        this.map = null;
        this.processingTerritories = new Set(); // 처리 중인 영토 (중복 방지)
        this.initialLoadCompleted = false; // 초기 로드 완료 플래그
        this.initialLoadInProgress = false; // 초기 로드 진행 중 플래그
    }
    
    /**
     * 초기화
     */
    initialize(map) {
        this.map = map;
        log.info('[TerritoryUpdatePipeline] Initialized');
    }
    
    /**
     * 영토 갱신 파이프라인 (핵심 메서드)
     * 모든 영토 관련 이벤트가 이 파이프라인을 거침
     * 
     * @param {string} territoryId - 영토 ID
     * @param {Object} context - 추가 컨텍스트 (선택사항)
     */
    async refreshTerritory(territoryId, context = {}) {
        console.log(`🔍 [TerritoryUpdatePipeline] ========== refreshTerritory START ==========`);
        console.log(`🔍 [TerritoryUpdatePipeline] territoryId: ${territoryId}`, context);
        
        if (!territoryId) {
            log.warn('[TerritoryUpdatePipeline] refreshTerritory: territoryId is missing');
            return;
        }
        
        // forceRefresh 플래그가 있으면 중복 처리 방지 스킵
        const forceRefresh = context.forceRefresh || false;
        console.log(`🔍 [TerritoryUpdatePipeline] forceRefresh: ${forceRefresh}`);
        
        // 중복 처리 방지 (forceRefresh가 아닌 경우에만)
        if (!forceRefresh && this.processingTerritories.has(territoryId)) {
            console.log(`🔍 [TerritoryUpdatePipeline] ⚠️ Territory ${territoryId} is already being processed, skipping`);
            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} is already being processed, skipping`);
            return;
        }
        
        this.processingTerritories.add(territoryId);
        
        try {
            // ⚠️ 핵심 수정: forceRefresh가 true이면 캐시를 먼저 무효화
            if (forceRefresh) {
                console.log(`🔍 [TerritoryUpdatePipeline] 🔄 Force refresh requested for ${territoryId}, invalidating caches`);
                log.info(`[TerritoryUpdatePipeline] 🔄 Force refresh requested for ${territoryId}, invalidating caches`);
                pixelDataService.clearMemoryCache(territoryId);
                const { localCacheService } = await import('../services/LocalCacheService.js');
                await localCacheService.clearCache(territoryId).catch(err => {
                    log.warn(`[TerritoryUpdatePipeline] Failed to clear IndexedDB cache:`, err);
                });
            }
            
            // 1. 영토 데이터 로드
            console.log(`🔍 [TerritoryUpdatePipeline] Step 1: Loading territory data for ${territoryId}`);
            const territory = await this.loadTerritory(territoryId);
            if (!territory) {
                console.log(`🔍 [TerritoryUpdatePipeline] ⚠️ Territory ${territoryId} not found (may not be loaded yet)`);
                log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not found (may not be loaded yet)`);
                return;
            }
            console.log(`🔍 [TerritoryUpdatePipeline] ✅ Territory loaded:`, {
                id: territory.id,
                ruler: territory.ruler || 'null',
                ruler_firebase_uid: territory.ruler_firebase_uid || 'null',
                sovereignty: territory.sovereignty
            });
            
            // ⚠️ CRITICAL: Territory 업데이트 시 관련 캐시 무효화
            // 소유권이 변경되었거나 sovereignty가 변경된 경우 캐시 무효화
            const previousTerritory = territoryManager.getTerritory(territoryId);
            if (previousTerritory) {
                const ownershipChanged = previousTerritory.ruler !== territory.ruler;
                const sovereigntyChanged = previousTerritory.sovereignty !== territory.sovereignty;
                
                console.log(`🔍 [TerritoryUpdatePipeline] Territory state check:`, {
                    ownershipChanged,
                    sovereigntyChanged,
                    previousRuler: previousTerritory.ruler || 'null',
                    currentRuler: territory.ruler || 'null'
                });
                
                if (ownershipChanged || sovereigntyChanged || forceRefresh) {
                    console.log(`🔍 [TerritoryUpdatePipeline] 🔄 Territory ${territoryId} state changed, invalidating caches`);
                    log.info(`[TerritoryUpdatePipeline] 🔄 Territory ${territoryId} state changed, invalidating caches`);
                    // 픽셀 데이터 캐시 무효화
                    pixelDataService.clearMemoryCache(territoryId);
                    // IndexedDB 캐시도 무효화 (소유권 변경 시)
                    if (ownershipChanged || forceRefresh) {
                        const { localCacheService } = await import('../services/LocalCacheService.js');
                        await localCacheService.clearCache(territoryId).catch(err => {
                            log.warn(`[TerritoryUpdatePipeline] Failed to clear IndexedDB cache:`, err);
                        });
                    }
                }
            }
            
            // 2. 픽셀 데이터 로드 (소유권 검증 포함)
            // 규칙 C: Territory 상태를 먼저 확인하고, 소유자가 없으면 픽셀 데이터를 로드하지 않음
            // ⚠️ 핵심 수정: forceRefresh가 true이면 캐시를 무시하고 API에서 직접 가져오기
            console.log(`🔍 [TerritoryUpdatePipeline] Step 2: Loading pixel data for ${territoryId} (forceRefresh=${forceRefresh})`);
            const pixelData = await pixelDataService.loadPixelData(territoryId, territory, { forceRefresh });
            console.log(`🔍 [TerritoryUpdatePipeline] ✅ Pixel data loaded:`, {
                territoryId: pixelData.territoryId,
                pixelsCount: pixelData.pixels?.length || 0,
                filledPixels: pixelData.filledPixels || 0,
                hasPixels: !!(pixelData.pixels && pixelData.pixels.length > 0),
                pixelDataKeys: Object.keys(pixelData)
            });
            
            // 3. TerritoryViewState 생성 (상태 계산)
            console.log(`🔍 [TerritoryUpdatePipeline] Step 3: Creating view state`);
            const viewState = new TerritoryViewState(territoryId, territory, pixelData);
            
            // ⚠️ 전문가 피드백: Phase 5가 Phase 4 표시를 지우지 않도록 보장
            // 메타에서 세팅한 hasPixelArt=true가 "단일 진실 소스"로 유지돼야 함
            if (context.preserveHasPixelArt && territory.hasPixelArt === true) {
                // Phase 4에서 메타 기반으로 설정한 hasPixelArt를 보존
                viewState.hasPixelArt = true;
                log.debug(`[TerritoryUpdatePipeline] Preserving hasPixelArt=true from metadata for ${territoryId}`);
            }
            
            console.log(`🔍 [TerritoryUpdatePipeline] ✅ View state created:`, {
                hasPixelArt: viewState.hasPixelArt,
                viewStateKeys: Object.keys(viewState)
            });
            
            // 4. 전문가 조언 반영: Properties 기반 접근으로 전환
            // GeoJSON feature의 properties에 hasPixelArt 플래그 추가
            console.log(`🔍 [TerritoryUpdatePipeline] Step 4: Updating territory properties`);
            await this.updateTerritoryProperties(territory, viewState);
            
            // 5. 맵 feature state 업데이트 (기존 방식 유지 - 호환성)
            console.log(`🔍 [TerritoryUpdatePipeline] Step 5: Updating map feature state`);
            const t3Start = performance.now();
            await this.updateMapFeatureState(territory, viewState);
            const t3End = performance.now();
            console.log(`[TerritoryUpdatePipeline] ⏱️ Feature-state update time: ${Math.round(t3End - t3Start)}ms`);
            
            // 6. feature state가 반영되도록 약간의 지연 (맵 렌더링 대기)
            if (viewState.hasPixelArt && this.map) {
                console.log(`🔍 [TerritoryUpdatePipeline] Step 6: Triggering map repaint (hasPixelArt=true)`);
                // feature state가 즉시 반영되도록 맵 강제 새로고침
                this.map.triggerRepaint();
                // 약간의 지연 후 픽셀 아트 표시
                await new Promise(resolve => setTimeout(resolve, 50));
            } else {
                console.log(`🔍 [TerritoryUpdatePipeline] Step 6: Skipping repaint (hasPixelArt=${viewState.hasPixelArt}, map=${!!this.map})`);
            }
            
            // 7. 픽셀 아트 표시 (있는 경우)
            // ⚠️ 핵심 수정: 픽셀 데이터가 있으면 항상 표시 (hasPixelArt 체크 제거)
            console.log(`🔍 [TerritoryUpdatePipeline] Step 7: Checking if pixel art should be displayed`);
            console.log(`🔍 [TerritoryUpdatePipeline] Pixel data check:`, {
                hasPixelData: !!pixelData,
                hasPixels: !!(pixelData && pixelData.pixels),
                pixelsLength: pixelData?.pixels?.length || 0,
                condition: !!(pixelData && pixelData.pixels && pixelData.pixels.length > 0)
            });
            
            if (pixelData && pixelData.pixels && pixelData.pixels.length > 0) {
                console.log(`🔍 [TerritoryUpdatePipeline] 🎨 Displaying pixel art for ${territoryId} (${pixelData.pixels.length} pixels)`);
                console.log(`[TerritoryUpdatePipeline] 🎨 Displaying pixel art for ${territoryId} (${pixelData.pixels.length} pixels)`);
                const t4Start = performance.now();
                await this.displayPixelArt(territory, pixelData);
                const t4End = performance.now();
                console.log(`[TerritoryUpdatePipeline] ⏱️ Pixel image render time: ${Math.round(t4End - t4Start)}ms`);
                console.log(`🔍 [TerritoryUpdatePipeline] ✅ displayPixelArt completed`);
            } else {
                console.log(`🔍 [TerritoryUpdatePipeline] ⚠️ No pixel art to display for ${territoryId}`, {
                    pixelData: pixelData ? 'exists' : 'null',
                    pixels: pixelData?.pixels ? `array[${pixelData.pixels.length}]` : 'null/undefined',
                    reason: !pixelData ? 'no pixelData' : !pixelData.pixels ? 'no pixels array' : pixelData.pixels.length === 0 ? 'empty pixels array' : 'unknown'
                });
                console.debug(`[TerritoryUpdatePipeline] No pixel art for ${territoryId}`);
            }
            
            // 모바일에서도 맵에 즉시 반영되도록 추가 새로고침
            // 편집 후 저장했을 때 맵이 보이지 않는 상태에서도 업데이트가 확실히 반영되도록
            if (viewState.hasPixelArt && this.map) {
                // 여러 번 새로고침하여 확실하게 반영
                this.map.triggerRepaint();
                setTimeout(() => {
                    if (this.map) {
                        this.map.triggerRepaint();
                    }
                }, 100);
                setTimeout(() => {
                    if (this.map) {
                        this.map.triggerRepaint();
                    }
                }, 300);
            }
            
            // 로그를 줄이기 위해 hasPixelArt가 true인 경우만 상세 로그 출력
            if (viewState.hasPixelArt) {
                console.log(`[TerritoryUpdatePipeline] ✅ Refreshed territory ${territoryId}: ${viewState.toString()}`);
            } else {
                console.debug(`[TerritoryUpdatePipeline] Refreshed territory ${territoryId}: ${viewState.toString()}`);
            }
            
            console.log(`🔍 [TerritoryUpdatePipeline] ========== refreshTerritory END (SUCCESS) ==========`);
            
        } catch (error) {
            console.log(`🔍 [TerritoryUpdatePipeline] ========== refreshTerritory END (ERROR) ==========`);
            console.log(`🔍 [TerritoryUpdatePipeline] ❌ ERROR:`, error);
            log.error(`[TerritoryUpdatePipeline] Failed to refresh territory ${territoryId}:`, error);
        } finally {
            this.processingTerritories.delete(territoryId);
            console.log(`🔍 [TerritoryUpdatePipeline] Removed from processingTerritories`);
        }
    }
    
    /**
     * 영토 데이터 로드
     * 1. TerritoryManager에서 확인
     * 2. 없으면 Firestore에서 확인
     * 3. 없으면 맵의 GeoJSON 소스에서 feature를 찾아서 생성
     */
    async loadTerritory(territoryId) {
        // ⚠️ 핵심 수정: 항상 API에서 최신 데이터를 가져와서 TerritoryAdapter로 변환
        // TerritoryManager에 저장된 데이터는 오래되었을 수 있으므로 API에서 최신 데이터를 가져옴
        try {
            const apiData = await apiService.getTerritory(territoryId);
            if (apiData) {
                // TerritoryAdapter를 통해 표준 모델로 변환
                const { territoryAdapter } = await import('../adapters/TerritoryAdapter.js');
                const territory = territoryAdapter.toStandardModel(apiData);
                
                // TerritoryManager에도 업데이트 (다음 호출 시 빠르게 접근 가능)
                territoryManager.territories.set(territoryId, territory);
                
                console.log(`🔍 [TerritoryUpdatePipeline] ✅ Territory loaded from API and converted via adapter:`, {
                    id: territory.id,
                    ruler: territory.ruler || 'null',
                    ruler_firebase_uid: territory.ruler_firebase_uid || 'null',
                    sovereignty: territory.sovereignty
                });
                return territory;
            }
        } catch (error) {
            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not in API, trying TerritoryManager:`, error.message);
            
            // API에서 가져오지 못한 경우에만 TerritoryManager에서 가져오기
            const territory = territoryManager.getTerritory(territoryId);
            if (territory) {
                console.log(`🔍 [TerritoryUpdatePipeline] ⚠️ Using cached territory from TerritoryManager (API failed):`, {
                    id: territory.id,
                    ruler: territory.ruler || 'null',
                    ruler_firebase_uid: territory.ruler_firebase_uid || 'null',
                    sovereignty: territory.sovereignty
                });
                return territory;
            }
        }
        
        // 3. 맵의 GeoJSON 소스에서 feature 찾아서 territory 객체 생성
        if (!this.map) {
            log.warn(`[TerritoryUpdatePipeline] Map not available for territory ${territoryId}`);
            return null;
        }
        
        try {
            const style = this.map.getStyle();
            if (!style || !style.sources) {
                return null;
            }
            
            // 모든 소스를 순회하며 feature 찾기
            for (const sourceId of Object.keys(style.sources)) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    // feature 찾기 (강화된 매칭 로직)
                    const feature = data.features.find(f => {
                        const propsId = f.properties?.id || f.properties?.territoryId;
                        const featureId = f.id;
                        
                        // 1. 직접 매칭
                        if (String(propsId) === String(territoryId)) return true;
                        if (String(featureId) === String(territoryId)) return true;
                        
                        // 2. world- 접두사 제거 후 매칭
                        const cleanTerritoryId = String(territoryId).replace(/^world-/, '');
                        const cleanPropsId = String(propsId || '').replace(/^world-/, '');
                        if (cleanPropsId && cleanPropsId === cleanTerritoryId) return true;
                        
                        // 3. properties.name 기반 매칭
                        const featureName = f.properties?.name || f.properties?.name_en || '';
                        if (featureName) {
                            const normalizedName = this.normalizeTerritoryId('', featureName, '');
                            if (normalizedName === String(territoryId)) return true;
                        }
                        
                        return false;
                    });
                    
                    if (feature) {
                        // TerritoryManager의 createTerritoryFromProperties 사용
                        territory = territoryManager.createTerritoryFromProperties(
                            territoryId,
                            feature.properties || {}
                        );
                        
                        // 맵 관련 정보 추가 (매핑 확립)
                        territory.sourceId = sourceId;
                        territory.featureId = feature.id;
                        territory.geometry = feature.geometry;
                        territory.properties = feature.properties;
                        
                        // TerritoryManager에 저장 (항상 업데이트)
                        territoryManager.territories.set(territoryId, territory);
                        
                        log.info(`[TerritoryUpdatePipeline] ✅ Established mapping: territoryId=${territoryId}, sourceId=${sourceId}, featureId=${feature.id}`);
                        return territory;
                    }
                } catch (error) {
                    log.warn(`[TerritoryUpdatePipeline] Error processing source ${sourceId}:`, error);
                }
            }
            
            // 찾지 못한 경우
            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not found in any GeoJSON source`);
            return null;
            
        } catch (error) {
            log.error(`[TerritoryUpdatePipeline] Failed to load territory ${territoryId} from map:`, error);
            return null;
        }
    }
    
    /**
     * GeoJSON feature의 properties 업데이트 (전문가 조언: properties 기반 접근)
     * fill-opacity 표현식이 properties를 직접 참조하도록 변경
     */
    async updateTerritoryProperties(territory, viewState) {
        if (!this.map || !territory) return;
        
        let sourceId = territory.sourceId;
        let featureId = territory.featureId;
        
        // sourceId/featureId가 없으면 재검색
        if (!sourceId || !featureId) {
            const found = await this.findTerritoryInMap(territory.id);
            if (found) {
                sourceId = found.sourceId;
                featureId = found.featureId;
                territory.sourceId = sourceId;
                territory.featureId = featureId;
            } else {
                return;
            }
        }
        
        try {
            const source = this.map.getSource(sourceId);
            if (!source || source.type !== 'geojson' || !source._data) {
                return;
            }
            
            // GeoJSON feature 찾기
            const feature = source._data.features?.find(f => {
                const propsId = f.properties?.id || f.properties?.territoryId;
                return String(propsId) === String(territory.id) || String(f.id) === String(featureId);
            });
            
            if (feature) {
                // properties에 hasPixelArt 플래그 추가 (픽셀 아트가 있든 없든 항상 업데이트)
                if (!feature.properties) {
                    feature.properties = {};
                }
                
                // 항상 업데이트 (픽셀 아트가 없는 경우 false로 설정)
                feature.properties.hasPixelArt = viewState.hasPixelArt;
                feature.properties.pixelFillRatio = viewState.fillRatio;
                
                // GeoJSON 소스 업데이트 (setData로 전체 재설정)
                // 주의: setData는 전체 소스를 재설정하므로 다른 영토의 properties도 유지됨
                this.map.getSource(sourceId).setData(source._data);
                
                if (viewState.hasPixelArt) {
                    console.log(`[TerritoryUpdatePipeline] ✅ Updated properties for ${territory.id}: hasPixelArt=${viewState.hasPixelArt}`);
                } else {
                    console.debug(`[TerritoryUpdatePipeline] Updated properties for ${territory.id}: hasPixelArt=${viewState.hasPixelArt}`);
                }
            } else {
                console.warn(`[TerritoryUpdatePipeline] ⚠️ Feature not found for ${territory.id} in source ${sourceId}`);
            }
        } catch (error) {
            log.error(`[TerritoryUpdatePipeline] Failed to update properties for ${territory.id}:`, error);
        }
    }
    
    /**
     * 맵 feature state 업데이트
     * 핵심: sourceId/featureId가 없으면 재검색하여 매핑 확립
     * 전문가 조언 반영: 실제 렌더링된 feature와 state 대상이 일치하는지 검증
     */
    async updateMapFeatureState(territory, viewState) {
        if (!this.map || !territory) return;
        
        let sourceId = territory.sourceId;
        let featureId = territory.featureId;
        
        // sourceId/featureId가 없으면 재검색
        if (!sourceId || !featureId) {
            // World View가 아직 로드되지 않았을 수 있으므로 조용히 재검색
            log.debug(`[TerritoryUpdatePipeline] Missing sourceId/featureId for ${territory.id}, searching in map...`);
            const found = await this.findTerritoryInMap(territory.id);
            if (found) {
                sourceId = found.sourceId;
                featureId = found.featureId;
                // TerritoryManager에 매핑 저장
                territory.sourceId = sourceId;
                territory.featureId = featureId;
                territoryManager.territories.set(territory.id, territory);
                log.debug(`[TerritoryUpdatePipeline] ✅ Re-established mapping: territoryId=${territory.id}, sourceId=${sourceId}, featureId=${featureId}`);
            } else {
                // World View가 아직 로드되지 않았을 수 있으므로 경고만 (에러 아님)
                log.debug(`[TerritoryUpdatePipeline] Territory ${territory.id} not found in map yet (World View may not be loaded)`);
                return;
            }
        }
        
        try {
            // TerritoryViewState에서 feature state 가져오기
            const featureState = viewState.toFeatureState();
            
            // 소스 존재 여부 확인
            if (!this.map.getSource(sourceId)) {
                log.debug(`[TerritoryUpdatePipeline] Source ${sourceId} not found in map, skipping feature state update`);
                return;
            }
            
            // 전문가 조언 반영: 실제 GeoJSON feature 확인
            try {
                const source = this.map.getSource(sourceId);
                if (source && source.type === 'geojson' && source._data) {
                    const actualFeature = source._data.features?.find(f => {
                        const propsId = f.properties?.id || f.properties?.territoryId;
                        return String(propsId) === String(territory.id) || String(f.id) === String(featureId);
                    });
                    
                    if (actualFeature) {
                        const actualFeatureId = actualFeature.id;
                        const actualSourceId = sourceId;
                        
                        // 실제 feature ID와 저장된 feature ID가 다른 경우 수정
                        // World View 로드 시 feature ID가 인덱스 기반으로 재할당되므로 자동 수정
                        if (String(actualFeatureId) !== String(featureId)) {
                            // 디버그 레벨로 변경 (너무 많은 경고 방지)
                            log.debug(`[TerritoryUpdatePipeline] Feature ID updated for ${territory.id}: ${featureId} → ${actualFeatureId}`);
                            featureId = actualFeatureId;
                            territory.featureId = actualFeatureId;
                            territoryManager.territories.set(territory.id, territory);
                        }
                        
                        console.log(`[TerritoryUpdatePipeline] ✅ Verified feature for ${territory.id}: source=${actualSourceId}, id=${actualFeatureId}`);
                    } else {
                        console.warn(`[TerritoryUpdatePipeline] ⚠️ Cannot find actual feature in GeoJSON for ${territory.id}`);
                    }
                }
            } catch (error) {
                log.debug(`[TerritoryUpdatePipeline] Feature verification failed for ${territory.id}:`, error);
            }
            
            // Mapbox feature state 업데이트
            try {
                // 소스 존재 여부 확인
                if (!this.map.getSource(sourceId)) {
                    console.warn(`[TerritoryUpdatePipeline] ⚠️ Feature-state failed: source not found (${territory.id}, sourceId=${sourceId})`);
                    log.debug(`[TerritoryUpdatePipeline] Feature-state failed: source not found for ${territory.id}`);
                    return;
                }
                
                // featureId 확인
                if (!featureId && featureId !== 0) {
                    console.warn(`[TerritoryUpdatePipeline] ⚠️ Feature-state failed: featureId missing (${territory.id})`);
                    log.debug(`[TerritoryUpdatePipeline] Feature-state failed: featureId missing for ${territory.id}`);
                    return;
                }
                
                this.map.setFeatureState(
                    { source: sourceId, id: featureId },
                    featureState
                );
                
                // feature state가 제대로 설정되었는지 확인
                const verifyState = this.map.getFeatureState({ source: sourceId, id: featureId });
                if (verifyState && verifyState.hasPixelArt !== featureState.hasPixelArt) {
                    console.warn(`[TerritoryUpdatePipeline] ⚠️ Feature state mismatch for ${territory.id}: expected hasPixelArt=${featureState.hasPixelArt}, got ${verifyState.hasPixelArt}`);
                } else if (verifyState && verifyState.hasPixelArt === featureState.hasPixelArt) {
                    console.log(`[TerritoryUpdatePipeline] ✅ Feature state verified for ${territory.id}: hasPixelArt=${verifyState.hasPixelArt}`);
                }
            } catch (error) {
                // ⚡ 성능 로그: feature-state 실패 원인 분류
                let failureReason = 'unknown';
                if (error.message?.includes('source') || error.message?.includes('Source')) {
                    failureReason = 'source_not_found';
                } else if (error.message?.includes('feature') || error.message?.includes('id')) {
                    failureReason = 'featureId_invalid';
                } else if (error.message?.includes('state')) {
                    failureReason = 'state_error';
                }
                console.error(`[TerritoryUpdatePipeline] ❌ Feature-state failed (${failureReason}) for ${territory.id}:`, error);
                log.debug(`[TerritoryUpdatePipeline] Feature-state failed (${failureReason}) for ${territory.id}:`, error);
            }
            
            // fill-opacity가 즉시 반영되도록 맵 강제 새로고침 (여러 번 호출하여 확실하게)
            this.map.triggerRepaint();
            
            // feature state가 확실히 반영되도록 추가 새로고침
            setTimeout(() => {
                if (this.map) {
                    this.map.triggerRepaint();
                }
            }, 10);
            
            // 강제로 레이어 다시 그리기 (더 확실한 방법)
            try {
                const fillLayerId = `${sourceId}-fill`;
                if (this.map.getLayer(fillLayerId)) {
                    // 레이어를 다시 추가하여 강제로 업데이트
                    this.map.triggerRepaint();
                }
            } catch (error) {
                // 레이어가 없으면 무시
            }
            
            // 로그를 줄이기 위해 hasPixelArt가 true인 경우만 상세 로그 출력
            if (featureState.hasPixelArt) {
                console.log(`[TerritoryUpdatePipeline] ✅ Updated feature state for ${territory.id}: hasPixelArt=${featureState.hasPixelArt}, fillRatio=${featureState.pixelFillRatio.toFixed(2)}, sourceId=${sourceId}, featureId=${featureId}`);
            } else {
                console.debug(`[TerritoryUpdatePipeline] Updated feature state for ${territory.id}: hasPixelArt=${featureState.hasPixelArt}`);
            }
            
        } catch (error) {
            log.error(`[TerritoryUpdatePipeline] Failed to update feature state for ${territory.id}:`, error);
        }
    }
    
    /**
     * 맵에서 영토 찾기 (재검색용)
     */
    async findTerritoryInMap(territoryId) {
        if (!this.map) return null;
        
        try {
            const style = this.map.getStyle();
            if (!style || !style.sources) return null;
            
            // 모든 소스를 순회하며 feature 찾기
            for (const sourceId of Object.keys(style.sources)) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    // feature 찾기 (강화된 매칭 로직)
                    const feature = data.features.find(f => {
                        const propsId = f.properties?.id || f.properties?.territoryId;
                        const featureId = f.id;
                        
                        // 1. 직접 매칭
                        if (String(propsId) === String(territoryId)) return true;
                        if (String(featureId) === String(territoryId)) return true;
                        
                        // 2. world- 접두사 제거 후 매칭
                        const cleanTerritoryId = String(territoryId).replace(/^world-/, '');
                        const cleanPropsId = String(propsId || '').replace(/^world-/, '');
                        if (cleanPropsId && cleanPropsId === cleanTerritoryId) return true;
                        
                        // 3. properties.name 기반 매칭
                        const featureName = f.properties?.name || f.properties?.name_en || '';
                        if (featureName) {
                            // 간단한 정규화
                            const normalizedName = String(featureName)
                                .toLowerCase()
                                .trim()
                                .replace(/[^\w\s-]/g, '')
                                .replace(/\s+/g, '-')
                                .replace(/-+/g, '-')
                                .replace(/^-|-$/g, '');
                            if (normalizedName === String(territoryId).toLowerCase()) return true;
                        }
                        
                        return false;
                    });
                    
                    if (feature) {
                        return {
                            sourceId: sourceId,
                            featureId: feature.id,
                            feature: feature
                        };
                    }
                } catch (error) {
                    log.warn(`[TerritoryUpdatePipeline] Error searching in source ${sourceId}:`, error);
                }
            }
            
            return null;
            
        } catch (error) {
            log.error(`[TerritoryUpdatePipeline] Failed to find territory ${territoryId} in map:`, error);
            return null;
        }
    }
    
    /**
     * 픽셀 아트 표시
     */
    async displayPixelArt(territory, pixelData) {
        console.log(`🔍 [TerritoryUpdatePipeline] ========== displayPixelArt START ==========`);
        console.log(`🔍 [TerritoryUpdatePipeline] territory:`, {
            id: territory?.id,
            sourceId: territory?.sourceId || 'null',
            featureId: territory?.featureId || 'null'
        });
        console.log(`🔍 [TerritoryUpdatePipeline] pixelData:`, {
            territoryId: pixelData?.territoryId,
            pixelsCount: pixelData?.pixels?.length || 0,
            filledPixels: pixelData?.filledPixels || 0
        });
        
        if (!this.pixelMapRenderer) {
            console.log(`🔍 [TerritoryUpdatePipeline] ❌ pixelMapRenderer not available`);
            log.warn('[TerritoryUpdatePipeline] pixelMapRenderer not available');
            return;
        }
        
        console.log(`🔍 [TerritoryUpdatePipeline] Calling pixelMapRenderer.loadAndDisplayPixelArt`);
        // PixelMapRenderer3의 메서드 사용
        await this.pixelMapRenderer.loadAndDisplayPixelArt(territory);
        console.log(`🔍 [TerritoryUpdatePipeline] ✅ displayPixelArt completed`);
        console.log(`🔍 [TerritoryUpdatePipeline] ========== displayPixelArt END ==========`);
    }
    
    /**
     * 여러 영토 배치 갱신
     */
    async refreshTerritories(territoryIds, options = {}) {
        const { batchSize = 10 } = options;
        
        log.info(`[TerritoryUpdatePipeline] Refreshing ${territoryIds.length} territories (batch size: ${batchSize})`);
        
        const t5Start = performance.now();
        
        // 배치 처리
        for (let i = 0; i < territoryIds.length; i += batchSize) {
            const batchStart = performance.now();
            const batch = territoryIds.slice(i, i + batchSize);
            const actualProcessed = batch.length; // ⚡ 실제 처리된 항목 수
            await Promise.all(batch.map(id => this.refreshTerritory(id)));
            const batchEnd = performance.now();
            const batchTime = batchEnd - batchStart;
            
            // ⚡ 성능 로그: 배치당 걸린 시간 + 실제 처리 항목 수
            const batchNum = Math.floor(i / batchSize) + 1;
            console.log(`[TerritoryUpdatePipeline] ⏱️ Batch ${batchNum} (${actualProcessed}/${batchSize} territories): ${Math.round(batchTime)}ms`);
            
            // 배치 사이에 약간의 지연 (Firebase 부하 방지)
            if (i + batchSize < territoryIds.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        
        const t5End = performance.now();
        console.log(`[TerritoryUpdatePipeline] ⏱️ refreshTerritories total time: ${Math.round(t5End - t5Start)}ms for ${territoryIds.length} territories`);
        log.info(`[TerritoryUpdatePipeline] Completed refreshing ${territoryIds.length} territories`);
    }
    
    /**
     * 모든 영토 ID 가져오기 (맵에서)
     */
    async getAllTerritoryIds() {
        if (!this.map) return [];
        
        try {
            const style = this.map.getStyle();
            if (!style || !style.sources) return [];
            
            const territoryIds = [];
            
            for (const sourceId of Object.keys(style.sources)) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    for (const feature of data.features) {
                        const territoryId = feature.properties?.id || feature.id;
                        if (territoryId) {
                            territoryIds.push(territoryId);
                        }
                    }
                } catch (error) {
                    log.warn(`[TerritoryUpdatePipeline] Error processing source ${sourceId}:`, error);
                }
            }
            
            return territoryIds;
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to get all territory IDs:', error);
            return [];
        }
    }
    
    /**
     * 모든 영토 갱신 (초기 로드)
     */
    async refreshAllTerritories() {
        log.info('[TerritoryUpdatePipeline] Refreshing all territories...');
        
        const allTerritoryIds = await this.getAllTerritoryIds();
        
        if (allTerritoryIds.length === 0) {
            log.warn('[TerritoryUpdatePipeline] No territories found');
            return;
        }
        
        await this.refreshTerritories(allTerritoryIds, { batchSize: 10 });
    }
    
    /**
     * 뷰포트 내 영토 ID 가져오기
     * ⚡ 성능 최적화: 캐시 + debounce로 호출 비용 최소화
     */
    getViewportTerritoryIds() {
        if (!this.map) return [];
        
        try {
            // ⚡ 성능 최적화: 캐시 확인 (bounds가 같으면 재사용)
            const bounds = this.map.getBounds();
            const boundsKey = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
            const now = Date.now();
            
            if (this._viewportTerritoryIdsCache && 
                this._viewportTerritoryIdsCache.boundsKey === boundsKey &&
                (now - this._viewportTerritoryIdsCache.timestamp) < 1000) { // 1초 캐시
                return this._viewportTerritoryIdsCache.territoryIds;
            }
            
            // ⚡ 성능 최적화: queryRenderedFeatures 사용 (1단계: 렌더된 것만 - 즉시 처리)
            const territoryIds = [];
            try {
                const renderedFeatures = this.map.queryRenderedFeatures({
                    layers: [] // 모든 레이어 (필요시 특정 레이어만 지정 가능)
                });
                
                for (const feature of renderedFeatures) {
                    const territoryId = feature.properties?.id || feature.id;
                    if (territoryId && !territoryIds.includes(territoryId)) {
                        territoryIds.push(territoryId);
                    }
                }
                
                // ⚡ 안정성: queryRenderedFeatures는 렌더된 것만 잡히므로,
                // 2단계(idle batch)에서는 전체 기반으로 누락된 것 보완
                // (이 부분은 TerritoryManager의 overlay에서 처리됨)
            } catch (error) {
                // queryRenderedFeatures 실패 시 fallback: 기존 방식 (전체 기반)
                log.debug('[TerritoryUpdatePipeline] queryRenderedFeatures failed, using fallback method (full scan)');
                const style = this.map.getStyle();
                if (style && style.sources) {
                    for (const sourceId of Object.keys(style.sources)) {
                        try {
                            const source = this.map.getSource(sourceId);
                            if (!source || source.type !== 'geojson') continue;
                            
                            const data = source._data;
                            if (!data || !data.features || data.features.length === 0) continue;
                            
                            for (const feature of data.features) {
                                const geometry = feature.geometry;
                                if (geometry && this.isGeometryInBounds(geometry, bounds)) {
                                    const territoryId = feature.properties?.id || feature.id;
                                    if (territoryId && !territoryIds.includes(territoryId)) {
                                        territoryIds.push(territoryId);
                                    }
                                }
                            }
                        } catch (err) {
                            log.warn(`[TerritoryUpdatePipeline] Error processing source ${sourceId} for viewport:`, err);
                        }
                    }
                }
            }
            
            // 캐시 저장
            this._viewportTerritoryIdsCache = {
                boundsKey,
                territoryIds,
                timestamp: now
            };
            
            return territoryIds;
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to get viewport territory IDs:', error);
            return [];
        }
    }
    
    /**
     * Geometry가 bounds 내에 있는지 확인 (간단한 체크)
     */
    isGeometryInBounds(geometry, bounds) {
        // TODO: 더 정확한 구현 필요
        // 현재는 항상 true 반환 (모든 영토 포함)
        return true;
    }
    
    /**
     * 초기 로드: 픽셀 데이터가 있는 영토만 로드
     * 핵심: 모든 영토의 매핑을 확실히 확립한 후 픽셀 아트 표시
     */
    async initialLoad() {
        // 이미 완료되었거나 진행 중이면 스킵
        if (this.initialLoadCompleted || this.initialLoadInProgress) {
            console.log('[TerritoryUpdatePipeline] Initial load already completed or in progress, skipping...');
            return;
        }
        
        this.initialLoadInProgress = true;
        console.log('[TerritoryUpdatePipeline] 🚀 Starting initial load (all owned territories with pixel art)...');
        
        try {
            // 0. 먼저 맵의 모든 영토 매핑 확립 (핵심!)
            // World View가 로드되지 않았을 수 있으므로 재시도 로직 포함
            let mappingsEstablished = 0;
            for (let retry = 0; retry < 3; retry++) {
            await this.establishAllTerritoryMappings();
                const style = this.map?.getStyle();
                const worldSource = style?.sources?.['world-territories'];
                if (worldSource && worldSource._data && worldSource._data.features) {
                    mappingsEstablished = worldSource._data.features.length;
                    if (mappingsEstablished > 0) break;
                }
                if (retry < 2) {
                    log.debug(`[TerritoryUpdatePipeline] No mappings found, retrying... (${retry + 1}/3)`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            // 1. Firestore에서 픽셀 데이터가 있는 모든 영토 ID 가져오기 (단일 원천)
            const territoriesWithPixelArt = await this.getTerritoriesWithPixelArt();
            console.log(`[TerritoryUpdatePipeline] Found ${territoriesWithPixelArt.length} territories with pixel art`);
            
            // 2. Firestore에서 소유된 영토(ruled/protected) 가져오기
            const ownedTerritories = await this.getOwnedTerritories();
            console.log(`[TerritoryUpdatePipeline] Found ${ownedTerritories.length} owned territories`);
            
            // 3. 픽셀 아트가 있는 소유 영토와 픽셀 아트가 없는 소유 영토 모두 처리
            const allTerritoriesToRefresh = new Set([
                ...territoriesWithPixelArt,
                ...ownedTerritories
            ]);
            console.log(`[TerritoryUpdatePipeline] Total territories to refresh: ${allTerritoriesToRefresh.size}`);
            
            if (allTerritoriesToRefresh.size === 0) {
                console.log('[TerritoryUpdatePipeline] No territories to refresh');
                this.initialLoadCompleted = true;
                return;
            }
            
            // 4. 뷰포트 내 영토 우선 로드
            const viewportTerritories = this.getViewportTerritoryIds();
            const viewportToRefresh = Array.from(allTerritoriesToRefresh).filter(id => viewportTerritories.includes(id));
            const remainingToRefresh = Array.from(allTerritoriesToRefresh).filter(id => !viewportTerritories.includes(id));
            
            // 5. 뷰포트 내 영토 즉시 로드
            if (viewportToRefresh.length > 0) {
                console.log(`[TerritoryUpdatePipeline] Loading ${viewportToRefresh.length} viewport territories...`);
                await this.refreshTerritories(viewportToRefresh, { batchSize: 10 });
                
                // 뷰포트 영토 로드 후 맵 강제 새로고침
                if (this.map) {
                    this.map.triggerRepaint();
                    console.log(`[TerritoryUpdatePipeline] 🎨 Triggered map repaint after viewport load`);
                }
            }
            
            // 6. 나머지 영토는 백그라운드에서 배치 로드
            if (remainingToRefresh.length > 0) {
                console.log(`[TerritoryUpdatePipeline] Loading ${remainingToRefresh.length} remaining territories in background...`);
                // 백그라운드에서 실행 (await 하지 않음)
                this.refreshTerritories(remainingToRefresh, { batchSize: 10 }).then(() => {
                    // 백그라운드 로드 완료 후 맵 새로고침
                    if (this.map) {
                        this.map.triggerRepaint();
                        console.log(`[TerritoryUpdatePipeline] 🎨 Triggered map repaint after background load`);
                    }
                }).catch(error => {
                    log.error('[TerritoryUpdatePipeline] Background load failed:', error);
                });
            }
            
            this.initialLoadCompleted = true;
            console.log('[TerritoryUpdatePipeline] ✅ Initial load completed');
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Initial load failed:', error);
            this.initialLoadInProgress = false; // 실패 시 다시 시도 가능하도록
        }
    }
    
    /**
     * 맵의 모든 영토 매핑 확립 (초기 로드 시 실행)
     * 핵심: GeoJSON의 모든 feature에 대해 TerritoryManager에 sourceId/featureId 매핑 저장
     */
    async establishAllTerritoryMappings() {
        if (!this.map) {
            log.warn('[TerritoryUpdatePipeline] Map not available for establishing mappings');
            return;
        }
        
        try {
            const style = this.map.getStyle();
            if (!style || !style.sources) {
                log.warn('[TerritoryUpdatePipeline] Map style not ready');
                return;
            }
            
            let totalMappings = 0;
            
            // 모든 GeoJSON 소스 순회
            for (const sourceId of Object.keys(style.sources)) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    // 각 feature에 대해 매핑 확립
                    for (const feature of data.features) {
                        const territoryId = feature.properties?.id || feature.properties?.territoryId || feature.id;
                        if (!territoryId) continue;
                        
                        // TerritoryManager에서 영토 가져오기 또는 생성
                        let territory = territoryManager.getTerritory(territoryId);
                        if (!territory) {
                            territory = territoryManager.createTerritoryFromProperties(
                                territoryId,
                                feature.properties || {}
                            );
                            territoryManager.territories.set(territoryId, territory);
                        }
                        
                        // 매핑 확립 (항상 업데이트)
                        territory.sourceId = sourceId;
                        territory.featureId = feature.id;
                        territory.geometry = feature.geometry;
                        territory.properties = feature.properties;
                        
                        totalMappings++;
                    }
                    
                    log.debug(`[TerritoryUpdatePipeline] Established ${data.features.length} mappings for source ${sourceId}`);
                    
                } catch (error) {
                    log.warn(`[TerritoryUpdatePipeline] Error establishing mappings for source ${sourceId}:`, error);
                }
            }
            
            // 0개 매핑은 World View가 아직 로드되지 않았을 때 발생 (정상)
            if (totalMappings > 0) {
            log.info(`[TerritoryUpdatePipeline] ✅ Established ${totalMappings} territory mappings`);
            } else {
                log.debug(`[TerritoryUpdatePipeline] No territory mappings yet (World View may not be loaded)`);
            }
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to establish territory mappings:', error);
        }
    }
    
    /**
     * Firestore에서 소유된 영토(ruled/protected) 가져오기
     * Firebase SDK 로드 실패 시 맵의 GeoJSON 소스와 TerritoryManager 캐시 사용
     */
    async getOwnedTerritories() {
        try {
            // 로그인하지 않은 경우 빈 배열 반환
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                log.debug('[TerritoryUpdatePipeline] User not authenticated, returning empty owned territories');
                return [];
            }
            
            // API에서 ruled와 protected 영토 조회
            const ruledTerritories = await apiService.getTerritories({
                status: 'ruled',
                limit: 1000
            });
            
            const protectedTerritories = await apiService.getTerritories({
                status: 'protected',
                limit: 1000
            });
            
            // 중복 제거를 위해 Set 사용
            const territoryIds = new Set();
            
            if (Array.isArray(ruledTerritories)) {
                ruledTerritories.forEach(territory => {
                    territoryIds.add(territory.id || territory.territoryId);
                });
            }
            
            if (Array.isArray(protectedTerritories)) {
                protectedTerritories.forEach(territory => {
                    territoryIds.add(territory.id || territory.territoryId);
                });
            }
            
            return Array.from(territoryIds);
        } catch (error) {
            // 인증 오류는 조용히 처리 (로그인 전에는 정상)
            if (error.message === 'User not authenticated') {
                log.debug('[TerritoryUpdatePipeline] User not authenticated, checking map and cache');
            } else {
                log.warn('[TerritoryUpdatePipeline] Failed to get owned territories from Firestore, checking map and cache:', error);
            }
            
            const ownedTerritories = new Set();
            
            // 1. TerritoryManager의 메모리 데이터 확인
            for (const [territoryId, territory] of territoryManager.territories) {
                if (territory.sovereignty === 'ruled' || territory.sovereignty === 'protected') {
                    ownedTerritories.add(territoryId);
                }
            }
            
            // 2. 맵의 GeoJSON 소스에서 직접 확인 (TerritoryManager가 비어있을 수 있음)
            if (this.map && ownedTerritories.size === 0) {
                try {
                    const style = this.map.getStyle();
                    if (style && style.sources) {
                        for (const sourceId of Object.keys(style.sources)) {
                            const source = this.map.getSource(sourceId);
                            if (!source || source.type !== 'geojson' || !source._data) continue;
                            
                            const features = source._data.features || [];
                            for (const feature of features) {
                                const territoryId = feature.properties?.id || feature.properties?.territoryId;
                                const sovereignty = feature.properties?.sovereignty;
                                
                                if (territoryId && (sovereignty === 'ruled' || sovereignty === 'protected')) {
                                    ownedTerritories.add(territoryId);
                                }
                            }
                        }
                    }
                } catch (mapError) {
                    log.debug('[TerritoryUpdatePipeline] Error checking map sources:', mapError);
                }
            }
            
            log.info(`[TerritoryUpdatePipeline] Found ${ownedTerritories.size} owned territories from cache/map`);
            return Array.from(ownedTerritories);
        }
    }
    
    /**
     * Firestore에서 픽셀 데이터가 있는 모든 영토 ID 가져오기 (소유권 필터링)
     * 
     * 핵심 규칙 A: 소유자가 없는 영토에는 절대 픽셀 아트를 표시하지 않는다.
     * - ruler != null && sovereignty != 'unconquered' 인 영토만 반환
     */
    async getTerritoriesWithPixelArt() {
        try {
            // 로그인하지 않은 경우 빈 배열 반환
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                log.debug('[TerritoryUpdatePipeline] User not authenticated, returning empty pixel art territories');
                return [];
            }
            
            // API에서 픽셀 데이터가 있는 영토 ID 목록 가져오기
            // ⚠️ 핵심 수정: getTerritoriesWithPixels 메서드가 없을 수 있으므로 try-catch로 처리
            let territoryIdsWithPixels = [];
            try {
                if (typeof apiService.getTerritoriesWithPixels === 'function') {
                    territoryIdsWithPixels = await apiService.getTerritoriesWithPixels();
                } else {
                    log.debug('[TerritoryUpdatePipeline] getTerritoriesWithPixels API method not available, skipping API call');
                    throw new Error('API method not available');
                }
            } catch (apiError) {
                log.debug('[TerritoryUpdatePipeline] Failed to get territories with pixels from API, will use IndexedDB fallback:', apiError.message);
                // API 호출 실패 시 IndexedDB로 fallback (아래 catch 블록에서 처리)
                throw apiError;
            }
            
            // 규칙 A: 소유권 상태 확인 - 소유자가 있는 영토만 필터링
            const ownedTerritoryIds = [];
            for (const territoryId of territoryIdsWithPixels) {
                try {
                    const territory = await apiService.getTerritory(territoryId);
                    // 소유자가 있고, unconquered가 아닌 경우만 포함
                    if (territory && (territory.ruler || territory.ruler_id || territory.rulerName) && territory.status !== 'unconquered' && territory.sovereignty !== 'unconquered') {
                        ownedTerritoryIds.push(territoryId);
                    }
                } catch (error) {
                    // 영토를 찾지 못한 경우 제외
                    log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not found, excluding from pixel art list`);
                }
            }
            
            log.info(`[TerritoryUpdatePipeline] Found ${ownedTerritoryIds.length} owned territories with pixel art (filtered from ${territoryIdsWithPixels.length} total)`);
            return ownedTerritoryIds;
            
        } catch (error) {
            // 인증 오류는 조용히 처리 (로그인 전에는 정상)
            if (error.message === 'User not authenticated') {
                log.debug('[TerritoryUpdatePipeline] User not authenticated, checking IndexedDB cache');
            } else {
                log.warn('[TerritoryUpdatePipeline] Failed to get territories with pixel art from Firestore, checking IndexedDB cache:', error);
            }
            
            const territoriesWithPixelArt = [];
            
            try {
                // IndexedDB에서 직접 모든 캐시된 픽셀 데이터 확인
                const dbName = 'pixelCanvasCache';
                const storeName = 'pixelCanvases'; // LocalCacheService의 storeName
                
                // IndexedDB 열기
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open(dbName, 2);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                
                // 모든 캐시된 데이터 가져오기
                const transaction = db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAll();
                
                const allCachedData = await new Promise((resolve, reject) => {
                    request.onsuccess = () => resolve(request.result || []);
                    request.onerror = () => reject(request.error);
                });
                
                // 픽셀 데이터가 있는 territory만 필터링 (소유권 검증 포함)
                for (const cached of allCachedData) {
                    if (cached && cached.pixelData && cached.pixelData.pixels && cached.pixelData.pixels.length > 0) {
                        const territoryId = cached.territoryId;
                        // 규칙 A: 소유권 상태 확인
                        try {
                            const territory = await apiService.getTerritory(territoryId);
                            // 소유자가 있고, unconquered가 아닌 경우만 포함
                            if (territory && (territory.ruler || territory.ruler_id || territory.rulerName) && territory.status !== 'unconquered' && territory.sovereignty !== 'unconquered') {
                                territoriesWithPixelArt.push(territoryId);
                            }
                        } catch (error) {
                            // 영토를 찾지 못한 경우 제외
                            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not found in fallback, excluding`);
                        }
                    }
                }
                
                db.close();
                
            } catch (indexedDBError) {
                log.warn('[TerritoryUpdatePipeline] Failed to check IndexedDB cache:', indexedDBError);
                
                // IndexedDB 실패 시 TerritoryManager의 territory를 순회하면서 확인
                for (const [territoryId, territory] of territoryManager.territories) {
                    try {
                        const pixelData = await pixelDataService.loadPixelData(territoryId);
                        if (pixelData && pixelData.pixels && pixelData.pixels.length > 0) {
                            territoriesWithPixelArt.push(territoryId);
                        }
                    } catch (pixelError) {
                        // 개별 territory 확인 실패는 무시
                        log.debug(`[TerritoryUpdatePipeline] Failed to check pixel data for ${territoryId}:`, pixelError);
                    }
                }
            }
            
            log.info(`[TerritoryUpdatePipeline] Found ${territoriesWithPixelArt.length} territories with pixel art from IndexedDB cache`);
            return territoriesWithPixelArt;
        }
    }
}

export default TerritoryUpdatePipeline;

