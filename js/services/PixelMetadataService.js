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
                        log.info(`[PixelMetadataService] Using cached metadata (age: ${Math.round(cacheAge / 1000)}s)`);
                        await this._applyMetadata(cached.metaMap);
                        this.loaded = true;
                        this.loading = false;
                        this.retryCount = 0; // 성공 시 재시도 카운트 리셋
                        eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                            count: cached.count,
                            territoryIds: cached.territoryIds,
                            metaMap: cached.metaMap,
                            fromCache: true
                        });
                        return;
                    } else {
                        log.info(`[PixelMetadataService] Cache expired (age: ${Math.round(cacheAge / 1000)}s), fetching fresh data`);
                    }
                }
            }
            
            const response = await fetch('/api/pixels/territories');
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // ⚠️ 중요: "빈 배열"도 정상/오류 구분
            if (!data || !Array.isArray(data.territories)) {
                throw new Error('Invalid response format');
            }
            
            // 0개면 진짜 0개인지, 실패인지 구분
            if (data.count === 0 && data.territories.length === 0) {
                log.info('[PixelMetadataService] No territories with pixels found (empty result)');
                // 빈 결과도 정상으로 처리
            }
            
            // 메타데이터 맵 생성
            const metaMap = new Map();
            for (const territoryInfo of data.territories || []) {
                metaMap.set(territoryInfo.territoryId, {
                    pixelCount: territoryInfo.pixelCount || 0,
                    hasPixelArt: true,
                    updatedAt: territoryInfo.updatedAt || null,
                    fillRatio: territoryInfo.fillRatio || null // optional
                });
            }
            
            // TerritoryManager에 hasPixelArt 플래그 설정
            // ⚠️ 중요: 초기에는 hasPixelArt를 false로 두지 말고, meta 로딩 결과로 채워넣어야 Phase 4가 성립
            const { territoryManager } = await import('../core/TerritoryManager.js');
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
            
            log.info(`[PixelMetadataService] Loaded metadata for ${data.count} territories`);
            
            // ⚠️ 검증용 로그: PIXEL_METADATA_LOADED: count = ?
            console.log(`[PixelMetadataService] PIXEL_METADATA_LOADED: count = ${data.count}`);
            
            // 성공 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_METADATA_LOADED, {
                count: data.count,
                territoryIds: data.territoryIds || [],
                metaMap: metaMap,
                fromCache: false
            });
            
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
        const { territoryManager } = await import('../core/TerritoryManager.js');
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
    invalidate(territoryId) {
        this.pixelMetadata.delete(territoryId);
        // TerritoryManager에서도 제거
        const { territoryManager } = await import('../core/TerritoryManager.js');
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
}

export const pixelMetadataService = new PixelMetadataService();
export default pixelMetadataService;

