/**
 * PixelMetadataService - 픽셀 메타데이터 로딩 서비스
 * 
 * 책임:
 * - 픽셀 존재 여부 메타데이터 로드 (공개 API)
 * - TerritoryManager에 hasPixelArt 플래그 설정
 * - 메타데이터 캐싱 (메모리 + IndexedDB)
 * 
 * ⚠️ 전문가 피드백 반영:
 * - 메타 정의: territoryId -> { pixelCount, hasPixelArt, updatedAt, fillRatio(optional) }
 * - "빈 배열"도 정상/오류 구분
 * - 초기에는 hasPixelArt를 false로 두지 말고, meta 로딩 결과로 채우기
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { localCacheService } from './LocalCacheService.js';
// ⚡ 성능 최적화: 정적 import로 변경 (초기 로딩 경로에서 사용되므로 dynamic import보다 빠름)
import { territoryManager } from '../core/TerritoryManager.js';

class PixelMetadataService {
    constructor() {
        // ⚠️ 메타 정의: territoryId -> { pixelCount, hasPixelArt, updatedAt, fillRatio(optional) }
        this.pixelMetadata = new Map(); // territoryId -> { pixelCount, updatedAt, fillRatio }
        this.loaded = false;
        this.loading = false;
        this.lastError = null;
        this.retryCount = 0;
        this.maxRetries = 1; // 1회 자동 재시도
        this.cacheMaxAge = 5 * 60 * 1000; // 5분 TTL
    }
    
    /**
     * 픽셀 메타데이터 로드 (공개 API)
     * ⚠️ 중요: 인증 불필요, 공개 데이터
     * ⚠️ 전문가 피드백: 실패 시 재시도 전략 + 캐시 무효화 기준
     */
    async loadMetadata(forceRefresh = false) {
        if (this.loaded && !forceRefresh) {
            log.debug('[PixelMetadataService] Metadata already loaded, skipping fetch.');
            return;
        }
        if (this.loading) {
            log.debug('[PixelMetadataService] Metadata already loading, awaiting existing promise.');
            return;
        }
        
        this.loading = true;
        this.lastError = null;
        
        try {
            // ⚠️ 추가: IndexedDB 캐시 확인 (가능하면) + 무효화 기준 체크
            if (!forceRefresh) {
                const cached = await this._loadFromCache();
                if (cached && cached.metaMap) {
                    // ⚠️ 캐시 무효화 기준: TTL 또는 updatedAt 기반
                    const cacheAge = Date.now() - (cached.cachedAt || 0);
                    if (cacheAge < this.cacheMaxAge) {
                        const hasPixelArtCount = cached.metaMap.size;
                        log.info(`[PixelMetadataService] Using cached metadata (age: ${Math.round(cacheAge / 1000)}s, hasPixelArt: ${hasPixelArtCount})`);
                        await this._applyMetadata(cached.metaMap);
                        this.loaded = true;
                        this.loading = false;
                        this.retryCount = 0; // 성공 시 재시도 카운트 리셋
                        
                        // ⚡ 핵심: territoryIds 추출
                        const cachedTerritoryIds = cached.territoryIds || [];
                        
                        eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                            count: cached.count,
                            hasPixelArtCount: hasPixelArtCount,
                            territoryIds: cachedTerritoryIds,
                            metaMap: cached.metaMap,
                            fromCache: true
                        });
                        
                        // ⚡ 추가: territoryIds 전용 이벤트 발행 (초기 자동 렌더링용)
                        if (cachedTerritoryIds.length > 0) {
                            eventBus.emit('PIXEL_TERRITORY_IDS_LOADED', { territoryIds: cachedTerritoryIds });
                        }
                        return;
                    } else {
                        log.info(`[PixelMetadataService] Cache expired (age: ${Math.round(cacheAge / 1000)}s), fetching fresh data`);
                    }
                }
            }
            
            // ⚡ 우선순위 1: TerritoryManager 메모리에서 메타 추출 (게스트 지원, API 호출 없음)
            // territories initial preset에 픽셀 메타 필드가 포함되어 있으므로 바로 추출 가능
            if (territoryManager && territoryManager.territories && territoryManager.territories.size > 0) {
                log.info(`[PixelMetadataService] Extracting metadata from TerritoryManager memory (${territoryManager.territories.size} territories loaded)`);
                const extractedData = await this._extractMetadataFromTerritoryManager();
                if (extractedData && extractedData.count > 0) {
                    // TerritoryManager에서 메타 추출 성공
                    const metaMap = extractedData.metaMap;
                    
                    // TerritoryManager에 hasPixelArt 플래그 설정
                    for (const [territoryId, meta] of metaMap.entries()) {
                        const territory = territoryManager.getTerritory(territoryId);
                        if (territory) {
                            territory.hasPixelArt = true;
                            territory.pixelCount = meta.pixelCount;
                            territory.pixelUpdatedAt = meta.updatedAt;
                            if (meta.fillRatio !== null) {
                                territory.fillRatio = meta.fillRatio;
                            }
                        }
                    }
                    
                    // 메타데이터 저장
                    this.pixelMetadata = metaMap;
                    this.loaded = true;
                    
                    // IndexedDB 캐시 저장
                    await this._saveToCache({
                        count: extractedData.count,
                        territoryIds: extractedData.territoryIds,
                        metaMap: metaMap
                    });
                    
                    const hasPixelArtCount = metaMap.size;
                    log.info(`[PixelMetadataService] ✅ Extracted metadata from TerritoryManager: ${extractedData.count} territories (hasPixelArt: ${hasPixelArtCount})`);
                    console.log(`[PixelMetadataService] 📦 Extracted payload size: ${Math.round(JSON.stringify(extractedData).length / 1024)}KB`);
                    console.log(`[PixelMetadataService] 🎨 Metadata applied to ${hasPixelArtCount} territories with pixel art`);
                    console.log(`[PixelMetadataService] PIXEL_METADATA_LOADED: count = ${extractedData.count}, hasPixelArt = ${hasPixelArtCount}`);
                    
                    // ⚡ 핵심: territoryIds 추출
                    const territoryIds = extractedData.territoryIds || [];
                    
                    // 성공 이벤트 발행
                    eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                        count: extractedData.count,
                        hasPixelArtCount: hasPixelArtCount,
                        territoryIds: territoryIds,
                        metaMap: metaMap,
                        fromCache: false,
                        fromTerritoryManager: true
                    });
                    
                    // ⚡ 추가: territoryIds 전용 이벤트 발행 (초기 자동 렌더링용)
                    if (territoryIds.length > 0) {
                        eventBus.emit('PIXEL_TERRITORY_IDS_LOADED', { territoryIds });
                    }
                    
                    this.retryCount = 0;
                    this.loading = false;
                    return; // TerritoryManager에서 추출 성공했으므로 API 호출 불필요
                } else {
                    log.info('[PixelMetadataService] TerritoryManager has territories but no pixel art metadata found, trying API fallback');
                }
            }
            
            // ⚡ 우선순위 2: API 호출 시도 (TerritoryManager에 메타가 없거나 추출 실패한 경우)
            // ⚡ ApiService의 baseURL 사용 (로컬/프로덕션 자동 분기)
            const { apiService } = await import('./ApiService.js');
            await apiService.initialize();
            
            const apiUrl = apiService.baseUrl 
                ? `${apiService.baseUrl}/pixels/territories`
                : '/api/pixels/territories'; // fallback: 상대 경로
            
            // ⚡ 디버깅: API 호출 로그
            console.log(`[PixelMetadataService] 🔍 Fetching metadata from API: ${apiUrl}`);
            log.info(`[PixelMetadataService] Fetching metadata from API: ${apiUrl}`);
            
            const response = await fetch(apiUrl);
            
            // ⚡ 디버깅: 응답 상태 로그
            console.log(`[PixelMetadataService] ✅ Response status: ${response.status} for ${apiUrl}`);
            
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    // ⚡ 401/403 처리: 게스트는 API 접근 불가, TerritoryManager 메타로 이미 처리했거나 빈 메타
                    log.info(`[PixelMetadataService] /api/pixels/territories returned ${response.status}, using TerritoryManager metadata or empty metadata`);
                    // 빈 메타로 처리 (TerritoryManager에서 이미 추출했거나 추출 실패)
                    const emptyData = {
                        count: 0,
                        territories: [],
                        territoryIds: [],
                        metaMap: new Map()
                    };
                    await this._handleEmptyMetadata(emptyData);
                    return;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // ⚡ 디버깅: 응답 데이터 로그
            console.log(`[PixelMetadataService] 📥 Response data:`, {
                status: response.status,
                count: data?.count,
                territoryIdsLength: data?.territoryIds?.length || 0,
                territoriesLength: Array.isArray(data?.territories) ? data.territories.length : 0,
                hasTerritories: !!data?.territories
            });
            
            // ⚠️ 중요: 백엔드 응답 형식 확인
            // 백엔드는 {count, territoryIds, territories} 형태로 반환
            if (!data) {
                throw new Error('Invalid response format: empty data');
            }
            
            // territories가 배열이 아니면 빈 배열로 처리
            const territoriesList = Array.isArray(data.territories) ? data.territories : [];
            const territoryIdsList = Array.isArray(data.territoryIds) ? data.territoryIds : [];
            
            // 0개면 진짜 0개인지, 실패인지 구분
            if ((data.count === 0 || !data.count) && territoriesList.length === 0 && territoryIdsList.length === 0) {
                log.info('[PixelMetadataService] No territories with pixels found (empty result)');
                console.log(`[PixelMetadataService] ⚠️ Empty result: count=${data.count}, territories=${territoriesList.length}, territoryIds=${territoryIdsList.length}`);
                // 빈 결과도 정상으로 처리 (픽셀 데이터가 실제로 없을 수 있음)
            }
            
            // 메타데이터 맵 생성
            const metaMap = new Map();
            for (const territoryInfo of territoriesList) {
                if (territoryInfo && territoryInfo.territoryId) {
                    metaMap.set(territoryInfo.territoryId, {
                        pixelCount: territoryInfo.pixelCount || 0,
                        hasPixelArt: true,
                        updatedAt: territoryInfo.updatedAt || null,
                        fillRatio: territoryInfo.fillRatio || null // optional
                    });
                }
            }
            
            // TerritoryManager에 hasPixelArt 플래그 설정
            // ⚠️ 중요: 초기에는 hasPixelArt를 false로 두지 말고, meta 로딩 결과로 채워넣어야 Phase 4가 성립
            for (const [territoryId, meta] of metaMap.entries()) {
                const territory = territoryManager.getTerritory(territoryId);
                if (territory) {
                    territory.hasPixelArt = true;
                    territory.pixelCount = meta.pixelCount;
                    territory.pixelUpdatedAt = meta.updatedAt;
                    if (meta.fillRatio !== null) {
                        territory.fillRatio = meta.fillRatio;
                    }
                }
            }
            
            // 메타데이터 저장
            this.pixelMetadata = metaMap;
            this.loaded = true;
            
            // ⚠️ 추가: IndexedDB 캐시 저장
            await this._saveToCache({
                count: data.count,
                territoryIds: data.territoryIds || [],
                metaMap: metaMap
            });
            
            // ⚡ 성능 로그: 메타 적용 대상 수
            const hasPixelArtCount = metaMap.size;
            const payloadSize = JSON.stringify(data).length;
            log.info(`[PixelMetadataService] Loaded metadata for ${data.count} territories (hasPixelArt: ${hasPixelArtCount})`);
            console.log(`[PixelMetadataService] 📦 Payload size: ${Math.round(payloadSize / 1024)}KB`);
            console.log(`[PixelMetadataService] 🎨 Metadata applied to ${hasPixelArtCount} territories with pixel art`);
            
            // ⚠️ 검증용 로그: PIXEL_METADATA_LOADED: count = ?
            console.log(`[PixelMetadataService] PIXEL_METADATA_LOADED: count = ${data.count}, hasPixelArt = ${hasPixelArtCount}`);
            
            // ⚡ 핵심: territoryIds를 명확히 추출 (territoryIds 필드 우선, 없으면 territories에서 추출)
            const territoryIds = data.territoryIds || (Array.isArray(data.territories) ? data.territories.map(t => t.territoryId).filter(Boolean) : []);
            
            // 성공 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                count: data.count,
                hasPixelArtCount: hasPixelArtCount,
                territoryIds: territoryIds, // ⚡ 명확한 territoryIds 전달
                metaMap: metaMap,
                fromCache: false
            });
            
            // ⚡ 추가: territoryIds 전용 이벤트 발행 (초기 자동 렌더링용)
            if (territoryIds.length > 0) {
                eventBus.emit('PIXEL_TERRITORY_IDS_LOADED', { territoryIds });
            }
            
            this.retryCount = 0; // 성공 시 재시도 카운트 리셋
        } catch (error) {
            this.lastError = error;
            log.error('[PixelMetadataService] Failed to load metadata:', error);
            
            // ⚠️ 추가: 실패 이벤트 발행 (네트워크 실패/응답 0개/서버 오류 구분)
            let reason = 'unknown';
            if (error.message?.includes('network') || error.message?.includes('fetch')) {
                reason = 'network';
            } else if (error.message?.includes('HTTP')) {
                reason = 'server';
            } else if (error.message?.includes('empty')) {
                reason = 'empty';
            }
            
            // ⚠️ 전문가 피드백: 실패 시 재시도 전략 (1회 자동 재시도)
            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                const retryDelay = 1000 * this.retryCount; // 1초, 2초...
                log.info(`[PixelMetadataService] Retrying metadata load (${this.retryCount}/${this.maxRetries}) after ${retryDelay}ms...`);
                
                setTimeout(() => {
                    this.loading = false; // 재시도 전에 loading 플래그 해제
                    this.loadMetadata(true); // forceRefresh로 재시도
                }, retryDelay);
                return;
            }
            
            // 재시도 횟수 초과 시 실패 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_METADATA_FAILED, {
                error: error,
                reason: reason,
                retryCount: this.retryCount
            });
            
            // ⚠️ 전문가 피드백: 실패해도 "fallback 표시" (빈 메타맵으로라도 이벤트 발행)
            // 이렇게 하면 Phase 4가 열리지 않아도 앱은 계속 동작
            log.warn('[PixelMetadataService] Emitting empty metadata as fallback');
            eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                count: 0,
                territoryIds: [],
                metaMap: new Map(),
                fromCache: false,
                isFallback: true
            });
        } finally {
            if (this.retryCount >= this.maxRetries) {
                this.loading = false;
            }
        }
    }
    
    /**
     * IndexedDB 캐시에서 메타데이터 로드
     */
    async _loadFromCache() {
        try {
            await localCacheService.initialize();
            const cached = await localCacheService.loadFromCache('pixel_metadata');
            if (cached && cached.metaMap) {
                // Map 객체 복원
                const metaMap = new Map(cached.metaMap);
                return {
                    count: cached.count,
                    territoryIds: cached.territoryIds,
                    metaMap: metaMap
                };
            }
        } catch (error) {
            log.debug('[PixelMetadataService] Cache load failed:', error);
        }
        return null;
    }
    
    /**
     * IndexedDB 캐시에 메타데이터 저장
     * ⚠️ 전문가 피드백: cachedAt 추가 (TTL 기반 무효화)
     */
    async _saveToCache(data) {
        try {
            await localCacheService.initialize();
            // Map을 배열로 변환하여 저장
            const cacheData = {
                ...data,
                metaMap: Array.from(data.metaMap.entries()),
                cachedAt: Date.now() // ⚠️ TTL 기반 무효화를 위한 타임스탬프
            };
            await localCacheService.saveToCache('pixel_metadata', cacheData);
        } catch (error) {
            log.debug('[PixelMetadataService] Cache save failed:', error);
        }
    }
    
    /**
     * 메타데이터 적용 (캐시에서 로드한 경우)
     */
    async _applyMetadata(metaMap) {
        for (const [territoryId, meta] of metaMap.entries()) {
            const territory = territoryManager.getTerritory(territoryId);
            if (territory) {
                territory.hasPixelArt = true;
                territory.pixelCount = meta.pixelCount;
                territory.pixelUpdatedAt = meta.updatedAt;
                if (meta.fillRatio !== null) {
                    territory.fillRatio = meta.fillRatio;
                }
            }
        }
        this.pixelMetadata = metaMap;
    }
    
    /**
     * 특정 territory의 픽셀 메타데이터 조회
     */
    hasPixelArt(territoryId) {
        return this.pixelMetadata.has(territoryId);
    }
    
    /**
     * 메타데이터 가져오기
     */
    getMetadata(territoryId) {
        return this.pixelMetadata.get(territoryId) || null;
    }
    
    /**
     * 메타데이터 무효화 (픽셀 저장 후)
     */
    async invalidate(territoryId) {
        this.pixelMetadata.delete(territoryId);
        // TerritoryManager에서도 제거
        const territory = territoryManager.getTerritory(territoryId);
        if (territory) {
            territory.hasPixelArt = undefined;
            territory.pixelCount = undefined;
            territory.pixelUpdatedAt = undefined;
        }
    }
    
    /**
     * 전체 메타데이터 무효화 (강제 새로고침)
     */
    async reload() {
        this.loaded = false;
        this.pixelMetadata.clear();
        await this.loadMetadata();
    }
    
    /**
     * ⚡ TerritoryManager 메모리 데이터에서 픽셀 메타데이터 추출
     * territories initial preset에 픽셀 메타 필드가 포함되어 있으므로 바로 추출 가능
     * 네트워크 재호출 없이 메모리에 있는 territories Map에서 직접 추출
     */
    async _extractMetadataFromTerritoryManager() {
        try {
            // TerritoryManager가 이미 import되어 있음 (파일 상단에 정적 import)
            if (!territoryManager || !territoryManager.territories) {
                log.warn('[PixelMetadataService] TerritoryManager not initialized, cannot extract metadata from memory');
                return null;
            }
            
            // TerritoryManager의 territories Map에서 직접 추출
            const territoriesMap = territoryManager.territories;
            if (!(territoriesMap instanceof Map) || territoriesMap.size === 0) {
                log.warn(`[PixelMetadataService] TerritoryManager.territories is empty (size: ${territoriesMap?.size || 0})`);
                return null;
            }
            
            // 메타데이터 맵 생성
            const metaMap = new Map();
            let count = 0;
            const territoryIds = [];
            
            // ⚡ 디버깅: 샘플 territory 확인 (tamanghasset 등)
            const sampleTerritoryId = 'tamanghasset';
            const sampleEntry = territoriesMap.get(sampleTerritoryId);
            if (sampleEntry) {
                // territories Map 구조: Map<territoryId, { territory, fetchedAt, revision }>
                const sampleTerritory = sampleEntry.territory || sampleEntry;
                console.log('[PixelMetadataService] [CHECK] Sample territory keys:', Object.keys(sampleTerritory));
                console.log('[PixelMetadataService] [CHECK] hasPixelArt/pixelCount/fillRatio:', 
                    sampleTerritory.hasPixelArt, sampleTerritory.pixelCount, sampleTerritory.fillRatio);
                console.log('[PixelMetadataService] [CHECK] raw type:', 
                    typeof sampleTerritory.hasPixelArt, typeof sampleTerritory.pixelCount, typeof sampleTerritory.fillRatio);
            }
            
            // territories Map 순회
            // 구조: Map<territoryId, { territory: {...}, fetchedAt: Date, revision: number }>
            for (const [territoryId, entry] of territoriesMap.entries()) {
                if (!entry) continue;
                
                // entry가 객체이고 territory 속성이 있으면 territory 사용, 없으면 entry 자체가 territory
                const territory = entry.territory || entry;
                if (!territory || !territoryId) continue;
                
                // ⚡ 안전장치: hasPixelArt, pixelCount, fillRatio 중 하나라도 만족하면 픽셀 있다고 판단
                const hasPixelArt = territory.hasPixelArt === true || 
                                   (territory.pixelCount && territory.pixelCount > 0) ||
                                   (territory.fillRatio && territory.fillRatio > 0) ||
                                   (territory.pixelUpdatedAt && (territory.pixelCount > 0 || territory.filledPixels > 0));
                
                // ⚡ 필드명 매핑 (서버에서 다른 이름으로 올 수 있음)
                // 프론트 요청: pixelUpdatedAt, 서버 응답: pixelArtUpdatedAt
                const pixelCount = territory.pixelCount || territory.filledPixels || territory.pixelsCount || territory.pixel_count || 0;
                const fillRatio = territory.fillRatio || 
                                 (territory.filledPixels && territory.totalPixels ? territory.filledPixels / territory.totalPixels : null) ||
                                 (territory.pixelCount && territory.totalPixels ? territory.pixelCount / territory.totalPixels : null) ||
                                 null;
                const updatedAt = territory.pixelUpdatedAt || territory.pixelArtUpdatedAt || territory.updatedAt || null;
                
                if (hasPixelArt || pixelCount > 0 || (fillRatio !== null && fillRatio > 0)) {
                    metaMap.set(territoryId, {
                        pixelCount: pixelCount,
                        hasPixelArt: true,
                        updatedAt: updatedAt,
                        fillRatio: fillRatio
                    });
                    territoryIds.push(territoryId);
                    count++;
                }
            }
            
            log.info(`[PixelMetadataService] Extracted metadata from TerritoryManager memory: ${count} territories with pixel art (total: ${territoriesMap.size})`);
            
            // payload size 계산 (디버깅용)
            const payloadSize = JSON.stringify({
                count,
                territories: Array.from(metaMap.entries()).map(([territoryId, meta]) => ({
                    territoryId,
                    pixelCount: meta.pixelCount,
                    updatedAt: meta.updatedAt,
                    fillRatio: meta.fillRatio
                }))
            }).length;
            console.log(`[PixelMetadataService] 📦 Extracted payload size: ${Math.round(payloadSize / 1024)}KB`);
            
            return {
                count: count,
                territories: Array.from(metaMap.entries()).map(([territoryId, meta]) => ({
                    territoryId,
                    pixelCount: meta.pixelCount,
                    updatedAt: meta.updatedAt,
                    fillRatio: meta.fillRatio
                })),
                territoryIds: territoryIds,
                metaMap: metaMap
            };
        } catch (error) {
            log.error('[PixelMetadataService] Failed to extract metadata from TerritoryManager:', error);
            console.error('[PixelMetadataService] Extraction error details:', error);
            return null;
        }
    }
    
    /**
     * 빈 메타데이터 처리 헬퍼
     */
    async _handleEmptyMetadata(emptyData) {
        this.pixelMetadata = emptyData.metaMap;
        this.loaded = true;
        
        // 메타가 0개면 info 레벨로 (정상 동작 - 비로그인 상태 등)
        log.info('[PixelMetadataService] Loaded metadata: 0 territories with pixel art (normal for unauthenticated or no pixels)');
        
        // 빈 메타 이벤트 발행
        eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
            count: 0,
            hasPixelArtCount: 0,
            territoryIds: [],
            metaMap: new Map(),
            fromCache: false,
            isFallback: true
        });
        
        this.retryCount = 0;
        this.loading = false;
    }
}

export const pixelMetadataService = new PixelMetadataService();
export default pixelMetadataService;

