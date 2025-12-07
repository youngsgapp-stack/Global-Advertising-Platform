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
        if (!territoryId) {
            log.warn('[TerritoryUpdatePipeline] refreshTerritory: territoryId is missing');
            return;
        }
        
        // forceRefresh 플래그가 있으면 중복 처리 방지 스킵
        const forceRefresh = context.forceRefresh || false;
        
        // 중복 처리 방지 (forceRefresh가 아닌 경우에만)
        if (!forceRefresh && this.processingTerritories.has(territoryId)) {
            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} is already being processed, skipping`);
            return;
        }
        
        this.processingTerritories.add(territoryId);
        
        try {
            // 1. 영토 데이터 로드
            const territory = await this.loadTerritory(territoryId);
            if (!territory) {
                // 영토를 찾지 못한 경우 조용히 종료 (맵이 아직 로드되지 않았을 수 있음)
                log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not found (may not be loaded yet)`);
                return;
            }
            
            // 2. 픽셀 데이터 로드 (Firestore에서 직접 확인 - 단일 원천)
            const pixelData = await pixelDataService.loadPixelData(territoryId);
            
            // 3. TerritoryViewState 생성 (상태 계산)
            const viewState = new TerritoryViewState(territoryId, territory, pixelData);
            
            // 4. 전문가 조언 반영: Properties 기반 접근으로 전환
            // GeoJSON feature의 properties에 hasPixelArt 플래그 추가
            await this.updateTerritoryProperties(territory, viewState);
            
            // 5. 맵 feature state 업데이트 (기존 방식 유지 - 호환성)
            await this.updateMapFeatureState(territory, viewState);
            
            // 6. feature state가 반영되도록 약간의 지연 (맵 렌더링 대기)
            if (viewState.hasPixelArt && this.map) {
                // feature state가 즉시 반영되도록 맵 강제 새로고침
                this.map.triggerRepaint();
                // 약간의 지연 후 픽셀 아트 표시
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            // 7. 픽셀 아트 표시 (있는 경우)
            if (viewState.hasPixelArt) {
                console.log(`[TerritoryUpdatePipeline] 🎨 Displaying pixel art for ${territoryId} (${pixelData.pixels.length} pixels)`);
                await this.displayPixelArt(territory, pixelData);
            } else {
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
            
        } catch (error) {
            log.error(`[TerritoryUpdatePipeline] Failed to refresh territory ${territoryId}:`, error);
        } finally {
            this.processingTerritories.delete(territoryId);
        }
    }
    
    /**
     * 영토 데이터 로드
     * 1. TerritoryManager에서 확인
     * 2. 없으면 Firestore에서 확인
     * 3. 없으면 맵의 GeoJSON 소스에서 feature를 찾아서 생성
     */
    async loadTerritory(territoryId) {
        // 1. TerritoryManager에서 가져오기
        let territory = territoryManager.getTerritory(territoryId);
        if (territory) {
            return territory;
        }
        
        // 2. Firestore에서 로드 시도
        try {
            const firestoreData = await firebaseService.getDocument('territories', territoryId);
            if (firestoreData) {
                territory = firestoreData;
                territoryManager.territories.set(territoryId, territory);
                return territory;
            }
        } catch (error) {
            log.debug(`[TerritoryUpdatePipeline] Territory ${territoryId} not in Firestore (normal for new territories)`);
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
            log.warn(`[TerritoryUpdatePipeline] Missing sourceId/featureId for ${territory.id}, searching in map...`);
            const found = await this.findTerritoryInMap(territory.id);
            if (found) {
                sourceId = found.sourceId;
                featureId = found.featureId;
                // TerritoryManager에 매핑 저장
                territory.sourceId = sourceId;
                territory.featureId = featureId;
                territoryManager.territories.set(territory.id, territory);
                log.info(`[TerritoryUpdatePipeline] ✅ Re-established mapping: territoryId=${territory.id}, sourceId=${sourceId}, featureId=${featureId}`);
            } else {
                log.warn(`[TerritoryUpdatePipeline] Cannot find territory ${territory.id} in map`);
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
                        if (String(actualFeatureId) !== String(featureId)) {
                            console.warn(`[TerritoryUpdatePipeline] ⚠️ Feature ID mismatch for ${territory.id}: stored=${featureId}, actual=${actualFeatureId}`);
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
                console.error(`[TerritoryUpdatePipeline] ❌ Failed to set feature state for ${territory.id}:`, error);
                log.debug(`[TerritoryUpdatePipeline] Failed to set feature state for ${territory.id}:`, error);
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
        if (!this.pixelMapRenderer) {
            log.warn('[TerritoryUpdatePipeline] pixelMapRenderer not available');
            return;
        }
        
        // PixelMapRenderer3의 메서드 사용
        await this.pixelMapRenderer.loadAndDisplayPixelArt(territory);
    }
    
    /**
     * 여러 영토 배치 갱신
     */
    async refreshTerritories(territoryIds, options = {}) {
        const { batchSize = 10 } = options;
        
        log.info(`[TerritoryUpdatePipeline] Refreshing ${territoryIds.length} territories (batch size: ${batchSize})`);
        
        // 배치 처리
        for (let i = 0; i < territoryIds.length; i += batchSize) {
            const batch = territoryIds.slice(i, i + batchSize);
            await Promise.all(batch.map(id => this.refreshTerritory(id)));
            
            // 배치 사이에 약간의 지연 (Firebase 부하 방지)
            if (i + batchSize < territoryIds.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        
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
     */
    getViewportTerritoryIds() {
        if (!this.map) return [];
        
        try {
            const bounds = this.map.getBounds();
            const territoryIds = [];
            
            const style = this.map.getStyle();
            if (!style || !style.sources) return [];
            
            for (const sourceId of Object.keys(style.sources)) {
                try {
                    const source = this.map.getSource(sourceId);
                    if (!source || source.type !== 'geojson') continue;
                    
                    const data = source._data;
                    if (!data || !data.features || data.features.length === 0) continue;
                    
                    for (const feature of data.features) {
                        // 간단한 경계 체크 (정확도는 낮지만 빠름)
                        const geometry = feature.geometry;
                        if (geometry && this.isGeometryInBounds(geometry, bounds)) {
                            const territoryId = feature.properties?.id || feature.id;
                            if (territoryId) {
                                territoryIds.push(territoryId);
                            }
                        }
                    }
                } catch (error) {
                    log.warn(`[TerritoryUpdatePipeline] Error processing source ${sourceId} for viewport:`, error);
                }
            }
            
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
            await this.establishAllTerritoryMappings();
            
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
            
            log.info(`[TerritoryUpdatePipeline] ✅ Established ${totalMappings} territory mappings`);
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to establish territory mappings:', error);
        }
    }
    
    /**
     * Firestore에서 소유된 영토(ruled/protected) 가져오기
     */
    async getOwnedTerritories() {
        try {
            // ruled와 protected를 각각 조회하여 합치기 (or 쿼리 대신)
            const ruledTerritories = await firebaseService.queryCollection('territories', [
                { field: 'sovereignty', op: '==', value: 'ruled' }
            ]);
            
            const protectedTerritories = await firebaseService.queryCollection('territories', [
                { field: 'sovereignty', op: '==', value: 'protected' }
            ]);
            
            // 중복 제거를 위해 Set 사용
            const territoryIds = new Set();
            
            ruledTerritories.forEach(doc => {
                territoryIds.add(doc.id);
            });
            
            protectedTerritories.forEach(doc => {
                territoryIds.add(doc.id);
            });
            
            return Array.from(territoryIds);
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to get owned territories:', error);
            return [];
        }
    }
    
    /**
     * Firestore에서 픽셀 데이터가 있는 모든 영토 ID 가져오기
     */
    async getTerritoriesWithPixelArt() {
        try {
            // pixelCanvases 컬렉션에서 모든 문서 가져오기
            const pixelCanvases = await firebaseService.queryCollection('pixelCanvases');
            
            // 픽셀 데이터가 있는 영토 ID만 필터링
            const territoryIds = pixelCanvases
                .filter(doc => doc.pixels && doc.pixels.length > 0)
                .map(doc => doc.territoryId || doc.id);
            
            return territoryIds;
            
        } catch (error) {
            log.error('[TerritoryUpdatePipeline] Failed to get territories with pixel art:', error);
            return [];
        }
    }
}

export default TerritoryUpdatePipeline;

