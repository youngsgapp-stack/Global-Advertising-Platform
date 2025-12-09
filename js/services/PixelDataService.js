/**
 * PixelDataService - 픽셀 데이터 저장/로드 전담 서비스
 * 설계서 V2에 따른 새로운 데이터 관리 시스템
 * 
 * 책임:
 * - Firebase 저장/로드 (무조건 Firebase에 저장)
 * - IndexedDB 로컬 캐시 (빠른 로딩을 위한 캐시)
 * - 배치 업데이트
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { localCacheService } from './LocalCacheService.js';
import { rateLimiter, RATE_LIMIT_TYPE } from './RateLimiter.js';
import { serviceModeManager } from './ServiceModeManager.js';

class PixelDataService {
    constructor() {
        this.memoryCache = new Map(); // territoryId -> cached data (메모리 캐시)
        this.pendingSaves = new Map(); // territoryId -> save data
        this.saveTimeouts = new Map(); // territoryId -> timeout
        this.SAVE_DEBOUNCE_MS = 1000; // 자동 저장 debounce 시간 (1초로 단축)
        this.localCacheInitialized = false;
        this.pendingPixels = new Map(); // territoryId -> pixel edit queue
    }
    
    /**
     * 로컬 캐시 서비스 초기화
     */
    async initializeLocalCache() {
        if (!this.localCacheInitialized) {
            try {
                await localCacheService.initialize();
                this.localCacheInitialized = true;
            } catch (error) {
                log.warn('[PixelDataService] Failed to initialize local cache:', error);
            }
        }
    }
    
    /**
     * 픽셀 데이터 로드 (소유권 중심 설계)
     * 
     * 핵심 규칙 C: 캐시는 Territory의 종속물
     * - Territory 상태를 먼저 확인하고, 소유자가 없으면 픽셀 데이터를 로드하지 않음
     * - 소유자가 있는 경우에만 캐시/Firestore에서 픽셀 데이터 로드
     * 
     * 우선순위: 메모리 캐시 → 로컬 캐시(IndexedDB) → Firebase
     */
    async loadPixelData(territoryId, territory = null) {
        // 규칙 C: Territory 상태를 먼저 확인
        // territory가 전달되지 않으면 TerritoryManager에서 가져오기
        if (!territory) {
            try {
                const { territoryManager } = await import('../core/TerritoryManager.js');
                territory = territoryManager.getTerritory(territoryId);
                
                // TerritoryManager에 없으면 Firestore에서 확인
                if (!territory) {
                    const { firebaseService } = await import('./FirebaseService.js');
                    territory = await firebaseService.getDocument('territories', territoryId);
                }
            } catch (error) {
                log.debug(`[PixelDataService] Could not check territory ownership for ${territoryId}, proceeding with load`);
            }
        }
        
        // 규칙 A: 소유자가 없으면 픽셀 데이터를 로드하지 않음
        if (territory && (!territory.ruler || territory.sovereignty === 'unconquered')) {
            log.debug(`[PixelDataService] Territory ${territoryId} has no owner, skipping pixel data load`);
            return {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
        }
        // 1. 메모리 캐시 확인 (가장 빠름)
        if (this.memoryCache.has(territoryId)) {
            const cached = this.memoryCache.get(territoryId);
            // 메모리 캐시가 1분 이내면 사용
            if (Date.now() - cached.timestamp < 60000) {
                log.debug(`[PixelDataService] Using memory cache for ${territoryId}`);
                return cached.data;
            }
        }
        
        // 2. 로컬 캐시(IndexedDB) 확인 (빠름)
        await this.initializeLocalCache();
        const localCached = await localCacheService.loadFromCache(territoryId);
        if (localCached) {
            log.debug(`[PixelDataService] Using local cache for ${territoryId}`);
            // 메모리 캐시에도 저장
            this.memoryCache.set(territoryId, {
                data: localCached,
                timestamp: Date.now()
            });
            return localCached;
        }
        
        // 3. Firebase에서 로드 (느림, 하지만 최신 데이터)
        try {
            const data = await firebaseService.getDocument('pixelCanvases', territoryId);
            
            if (data) {
                // 메모리 캐시에 저장
                this.memoryCache.set(territoryId, {
                    data,
                    timestamp: Date.now()
                });
                
                // 로컬 캐시에도 저장 (다음 로드 시 빠르게)
                await localCacheService.saveToCache(territoryId, data);
                
                log.info(`[PixelDataService] Loaded pixel data from Firebase for ${territoryId} (${data.filledPixels || 0} pixels)`);
                return data;
            }
            
            // 데이터가 없으면 빈 데이터 반환 (정상적인 경우)
            const emptyData = {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
            
            // 빈 데이터도 캐시에 저장 (불필요한 Firebase 호출 방지)
            this.memoryCache.set(territoryId, {
                data: emptyData,
                timestamp: Date.now()
            });
            
            return emptyData;
            
        } catch (error) {
            // 오프라인 에러나 존재하지 않는 문서는 빈 데이터 반환
            log.debug(`[PixelDataService] Failed to load from Firebase for ${territoryId}, returning empty data`);
            return {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
        }
    }
    
    /**
     * 픽셀 아트 존재 여부 확인 (Firestore 단일 원천)
     * 컨설팅 원칙: "픽셀 존재 여부의 진짜 원천을 Firestore(or 인덱스) 하나로 고정해라."
     * 
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<boolean>} 픽셀 아트 존재 여부
     */
    async hasPixelArt(territoryId) {
        const pixelData = await this.loadPixelData(territoryId);
        return pixelData?.pixels?.length > 0;
    }
    
    /**
     * 픽셀 데이터 저장 (debounced + Rate Limiting)
     */
    async savePixelData(territoryId, pixelData, userId = null) {
        // Rate Limiting 체크 (사용자가 있는 경우)
        if (userId) {
            const pixelCount = pixelData.pixels?.length || pixelData.filledPixels || 0;
            const rateLimitCheck = await rateLimiter.checkLimit(userId, RATE_LIMIT_TYPE.PIXEL_EDIT, pixelCount);
            
            if (!rateLimitCheck.allowed) {
                log.warn(`[PixelDataService] Rate limit exceeded for user ${userId}, territory ${territoryId}`);
                
                // 큐에 추가 (나중에 처리)
                if (!this.pendingPixels.has(territoryId)) {
                    this.pendingPixels.set(territoryId, []);
                }
                this.pendingPixels.get(territoryId).push({ pixelData, userId });
                
                // 사용자에게 알림
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: `픽셀 편집이 너무 빠릅니다. ${rateLimitCheck.retryAfter}초 후 다시 시도해주세요.`,
                    duration: 3000
                });
                
                return { success: false, rateLimited: true, retryAfter: rateLimitCheck.retryAfter };
            }
        }
        
        // 서비스 모드에 따른 저장 딜레이 조정
        const modeConfig = serviceModeManager.getConfig();
        const saveDelay = modeConfig.pixelSaveDelay || this.SAVE_DEBOUNCE_MS;
        
        // pending 저장에 추가
        this.pendingSaves.set(territoryId, pixelData);
        
        // 기존 timeout 취소
        if (this.saveTimeouts.has(territoryId)) {
            clearTimeout(this.saveTimeouts.get(territoryId));
        }
        
        // 새로운 timeout 설정 (서비스 모드에 따라 조정)
        const timeout = setTimeout(async () => {
            await this._executeSave(territoryId);
        }, saveDelay);
        
        this.saveTimeouts.set(territoryId, timeout);
        
        return { success: true };
    }
    
    /**
     * 즉시 저장 (debounce 없이)
     */
    async savePixelDataImmediate(territoryId, pixelData) {
        // pending 저장 업데이트
        this.pendingSaves.set(territoryId, pixelData);
        
        // 기존 timeout 취소
        if (this.saveTimeouts.has(territoryId)) {
            clearTimeout(this.saveTimeouts.get(territoryId));
        }
        
        // 즉시 저장 실행
        await this._executeSave(territoryId);
    }
    
    /**
     * 실제 저장 실행
     * 무조건 Firebase에 저장하고, 저장 후 로컬 캐시 업데이트
     * Delta 저장 지원: 변경된 픽셀만 저장하는 경우 전체 데이터와 병합
     */
    async _executeSave(territoryId) {
        const pixelData = this.pendingSaves.get(territoryId);
        if (!pixelData) {
            log.warn(`[PixelDataService] No pending save data for ${territoryId}`);
            return;
        }
        
        try {
            let dataToSave;
            
            // Delta 저장인 경우 기존 데이터와 병합
            if (pixelData.isDelta && pixelData.pixels) {
                // 기존 데이터 로드
                const existingData = await this.loadPixelData(territoryId);
                const existingPixelsMap = new Map();
                
                // 기존 픽셀을 맵에 저장
                if (existingData?.pixels) {
                    for (const pixel of existingData.pixels) {
                        const key = `${pixel.x},${pixel.y}`;
                        existingPixelsMap.set(key, pixel);
                    }
                }
                
                // Delta 픽셀 적용
                for (const pixel of pixelData.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (pixel.c === null) {
                        // 삭제된 픽셀
                        existingPixelsMap.delete(key);
                    } else {
                        // 추가/수정된 픽셀
                        existingPixelsMap.set(key, {
                            x: pixel.x,
                            y: pixel.y,
                            c: pixel.c,
                            u: pixel.u,
                            t: pixel.t
                        });
                    }
                }
                
                // 맵을 배열로 변환
                const mergedPixels = Array.from(existingPixelsMap.values());
                
                dataToSave = {
                    territoryId,
                    pixels: mergedPixels,
                    filledPixels: mergedPixels.length,
                    width: pixelData.width || existingData?.width,
                    height: pixelData.height || existingData?.height,
                    bounds: pixelData.bounds || existingData?.bounds,
                    lastUpdated: Date.now(),
                    isDelta: false // 병합 후에는 전체 데이터
                };
                
                log.info(`[PixelDataService] Merged delta save: ${pixelData.changedCount} changes applied to ${existingPixelsMap.size} total pixels`);
            } else {
                // 전체 저장
                dataToSave = {
                    ...pixelData,
                    lastUpdated: Date.now()
                };
            }
            
            // 1. 무조건 Firebase에 저장
            await firebaseService.setDocument('pixelCanvases', territoryId, dataToSave);
            
            // 2. 메모리 캐시 업데이트
            this.memoryCache.set(territoryId, {
                data: dataToSave,
                timestamp: Date.now()
            });
            
            // 3. 로컬 캐시(IndexedDB) 업데이트
            await this.initializeLocalCache();
            await localCacheService.saveToCache(territoryId, dataToSave);
            
            // Delta 저장 통계 로깅
            if (pixelData.isDelta) {
                log.info(`[PixelDataService] Delta save completed: ${pixelData.changedCount} pixels changed, ${dataToSave.filledPixels} total pixels`);
            }
            
            // pending 저장 제거
            this.pendingSaves.delete(territoryId);
            this.saveTimeouts.delete(territoryId);
            
            log.info(`[PixelDataService] Saved pixel data to Firebase for ${territoryId} (${pixelData.filledPixels || 0} pixels)`);
            
            // 영토의 lastActivityAt 업데이트 (활동 기반 유지권 시스템)
            try {
                // Firestore Timestamp 사용
                const { Timestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
                await firebaseService.updateDocument('territories', territoryId, {
                    lastActivityAt: Timestamp.now()
                });
                log.debug(`[PixelDataService] Updated lastActivityAt for territory ${territoryId}`);
            } catch (error) {
                log.warn(`[PixelDataService] Failed to update lastActivityAt for territory ${territoryId}:`, error);
                // 영토 업데이트 실패해도 픽셀 저장은 성공한 것으로 처리
            }
            
            // 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_DATA_SAVED, {
                territoryId,
                filledPixels: pixelData.filledPixels || 0
            });
            
        } catch (error) {
            log.error(`[PixelDataService] Failed to save pixel data for ${territoryId}:`, error);
            throw error;
        }
    }
    
    /**
     * 픽셀 아트 삭제 (소유권 변경 시 자동 초기화용)
     * 
     * 규칙 B: 소유권이 바뀌면 이전 픽셀은 즉시 '죽은 상태'가 된다
     * - Firestore pixelCanvases 문서 삭제
     * - IndexedDB 캐시 삭제
     * - 메모리 캐시 삭제
     * - territories 컬렉션의 pixelCanvas 필드 삭제
     */
    async deletePixelData(territoryId) {
        try {
            log.info(`[PixelDataService] Deleting pixel data for territory ${territoryId} (ownership changed)`);
            
            // 1. Firestore pixelCanvases 문서 삭제
            try {
                await firebaseService.deleteDocument('pixelCanvases', territoryId);
                log.info(`[PixelDataService] Deleted pixelCanvases document for ${territoryId}`);
            } catch (error) {
                // 문서가 없으면 정상 (이미 삭제되었거나 없었던 경우)
                log.debug(`[PixelDataService] pixelCanvases document not found or already deleted for ${territoryId}`);
            }
            
            // 2. territories 컬렉션의 pixelCanvas 필드 삭제
            try {
                await firebaseService.updateDocument('territories', territoryId, {
                    pixelCanvas: null,
                    territoryValue: 0,
                    hasPixelArt: false
                });
                log.info(`[PixelDataService] Cleared pixelCanvas metadata for territory ${territoryId}`);
            } catch (error) {
                log.warn(`[PixelDataService] Failed to clear pixelCanvas metadata for ${territoryId}:`, error);
            }
            
            // 3. IndexedDB 캐시 삭제
            try {
                await this.initializeLocalCache();
                await localCacheService.clearCache(territoryId);
                log.info(`[PixelDataService] Deleted IndexedDB cache for ${territoryId}`);
            } catch (error) {
                log.warn(`[PixelDataService] Failed to delete IndexedDB cache for ${territoryId}:`, error);
            }
            
            // 4. 메모리 캐시 삭제
            this.clearMemoryCache(territoryId);
            log.info(`[PixelDataService] Cleared memory cache for ${territoryId}`);
            
            // 5. 이벤트 발행 (픽셀 아트 삭제 알림)
            eventBus.emit(EVENTS.PIXEL_DATA_DELETED, {
                territoryId
            });
            
            log.info(`[PixelDataService] ✅ Successfully deleted all pixel data for territory ${territoryId}`);
            
        } catch (error) {
            log.error(`[PixelDataService] Failed to delete pixel data for ${territoryId}:`, error);
            throw error;
        }
    }
    
    /**
     * 영토 메타데이터 업데이트
     */
    async updateTerritoryMetadata(territoryId, metadata) {
        try {
            await firebaseService.setDocument('territories', territoryId, {
                pixelCanvas: metadata.pixelCanvas,
                territoryValue: metadata.territoryValue
            }, true); // merge: true
            
            log.debug(`[PixelDataService] Updated territory metadata for ${territoryId}`);
            
        } catch (error) {
            log.error(`[PixelDataService] Failed to update territory metadata for ${territoryId}:`, error);
            throw error;
        }
    }
    
    /**
     * 메모리 캐시 클리어 (로컬 캐시는 유지)
     */
    clearMemoryCache(territoryId = null) {
        if (territoryId) {
            this.memoryCache.delete(territoryId);
        } else {
            this.memoryCache.clear();
        }
    }
    
    /**
     * 배치 저장 (여러 영토 동시 저장)
     */
    async batchSave(pixelDataMap) {
        const saves = [];
        
        for (const [territoryId, pixelData] of pixelDataMap.entries()) {
            saves.push(this.savePixelDataImmediate(territoryId, pixelData));
        }
        
        await Promise.all(saves);
        log.info(`[PixelDataService] Batch saved ${saves.length} territories`);
    }
}

// 싱글톤 인스턴스
export const pixelDataService = new PixelDataService();
export default pixelDataService;

