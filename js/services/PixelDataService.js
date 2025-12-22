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
import { apiService } from './ApiService.js';
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
        this.offlineRecoveryQueue = new Map(); // territoryId -> { pixelData, retryCount }
        this.recoveryInterval = null; // 오프라인 복구 인터벌
    }
    
    /**
     * 오프라인 복구 설정 (네트워크 복구 시 자동 재시도)
     */
    setupOfflineRecovery(territoryId, pixelData) {
        // 오프라인 복구 큐에 추가
        this.offlineRecoveryQueue.set(territoryId, {
            pixelData,
            retryCount: 0,
            lastRetry: Date.now()
        });
        
        // ⚠️ 응급 조치: 폴링 비활성화 (Firestore 읽기 폭발 방지)
        // 네트워크 복구 이벤트 리스너는 유지 (필요 시에만 실행)
        window.addEventListener('online', () => {
            log.info('[PixelDataService] Network restored, processing offline recovery queue...');
            this.processOfflineRecovery().catch(err => {
                log.error('[PixelDataService] Offline recovery failed:', err);
            });
        });
        
        // ⚠️ 폴링 비활성화: setInterval 제거
        log.warn('[PixelDataService] ⚠️ Recovery interval DISABLED to prevent Firestore read explosion');
        return;
        
        // 아래 코드는 나중에 필요 시 재활성화
        /*
        // 복구 인터벌이 없으면 시작
        if (!this.recoveryInterval) {
            this.recoveryInterval = setInterval(() => {
                this.processOfflineRecovery().catch(err => {
                    log.error('[PixelDataService] Offline recovery failed:', err);
                });
            }, 10000); // 10초마다 체크
        }
        */
    }
    
    /**
     * 오프라인 복구 큐 처리
     */
    async processOfflineRecovery() {
        if (this.offlineRecoveryQueue.size === 0) return;
        if (!navigator.onLine) return;
        
        const now = Date.now();
        const maxRetries = 5;
        const retryDelay = 10000; // 10초
        
        for (const [territoryId, recovery] of this.offlineRecoveryQueue.entries()) {
            // 재시도 간격 확인
            if (now - recovery.lastRetry < retryDelay) continue;
            
            // 최대 재시도 횟수 확인
            if (recovery.retryCount >= maxRetries) {
                log.warn(`[PixelDataService] Max retries reached for ${territoryId}, removing from recovery queue`);
                this.offlineRecoveryQueue.delete(territoryId);
                continue;
            }
            
            try {
                log.info(`[PixelDataService] 🔄 Retrying offline save for ${territoryId} (attempt ${recovery.retryCount + 1}/${maxRetries})`);
                recovery.retryCount++;
                recovery.lastRetry = now;
                
                // 저장 재시도
                await this._executeSave(territoryId);
                
                // 성공 시 큐에서 제거
                this.offlineRecoveryQueue.delete(territoryId);
                log.info(`[PixelDataService] ✅ Offline recovery successful for ${territoryId}`);
                
                // 성공 알림
                eventBus.emit(EVENTS.PIXEL_UPDATE, {
                    type: 'saveStatus',
                    status: 'saved',
                    message: '오프라인 저장이 동기화되었습니다.'
                });
            } catch (error) {
                log.warn(`[PixelDataService] Offline recovery retry failed for ${territoryId}:`, error);
                // 다음 재시도를 위해 큐에 유지
            }
        }
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
    async loadPixelData(territoryId, territory = null, options = {}) {
        const { forceRefresh = false } = options;
        console.log(`🔍 [PixelDataService] ========== loadPixelData START ==========`);
        console.log(`🔍 [PixelDataService] territoryId: ${territoryId}`, {
            territoryProvided: !!territory,
            territoryRuler: territory?.ruler || 'null',
            territorySovereignty: territory?.sovereignty || 'null',
            forceRefresh: forceRefresh
        });
        
        // 규칙 C: Territory 상태를 먼저 확인
        // territory가 전달되지 않으면 TerritoryManager에서 가져오기
        if (!territory) {
            console.log(`🔍 [PixelDataService] Territory not provided, loading from TerritoryManager`);
            try {
                const { territoryManager } = await import('../core/TerritoryManager.js');
                territory = territoryManager.getTerritory(territoryId);
                
                // TerritoryManager에 없으면 API에서 확인
                if (!territory) {
                    console.log(`🔍 [PixelDataService] Territory not in TerritoryManager, loading from API`);
                    try {
                        const apiData = await apiService.getTerritory(territoryId);
                        if (apiData) {
                            // ⚠️ 핵심 수정: TerritoryAdapter를 통해 표준 모델로 변환
                            const { territoryAdapter } = await import('../adapters/TerritoryAdapter.js');
                            territory = territoryAdapter.toStandardModel(apiData);
                            console.log(`🔍 [PixelDataService] ✅ Territory loaded from API and converted via adapter:`, {
                                ruler: territory?.ruler || 'null',
                                ruler_firebase_uid: territory?.ruler_firebase_uid || 'null',
                                sovereignty: territory?.sovereignty || 'null'
                            });
                        }
                    } catch (error) {
                        console.log(`🔍 [PixelDataService] ⚠️ Could not load territory from API:`, error);
                        log.debug(`[PixelDataService] Could not load territory from API:`, error);
                    }
                } else {
                    console.log(`🔍 [PixelDataService] ✅ Territory loaded from TerritoryManager:`, {
                        ruler: territory?.ruler || 'null',
                        ruler_firebase_uid: territory?.ruler_firebase_uid || 'null',
                        sovereignty: territory?.sovereignty || 'null'
                    });
                }
            } catch (error) {
                console.log(`🔍 [PixelDataService] ⚠️ Could not check territory ownership:`, error);
                log.debug(`[PixelDataService] Could not check territory ownership for ${territoryId}, proceeding with load`);
            }
        }
        
        // 규칙 A: 소유자가 없으면 픽셀 데이터를 로드하지 않음
        // ⚠️ 핵심 수정: ruler가 문자열 'null'인 경우도 처리
        // ruler와 ruler_firebase_uid 모두 확인
        const rulerRaw = territory?.ruler;
        const rulerFirebaseUidRaw = territory?.ruler_firebase_uid;
        
        // 문자열 'null'을 실제 null로 변환
        const ruler = (typeof rulerRaw === 'string' && rulerRaw.toLowerCase() === 'null') ? null : rulerRaw;
        const rulerFirebaseUid = (typeof rulerFirebaseUidRaw === 'string' && rulerFirebaseUidRaw.toLowerCase() === 'null') ? null : rulerFirebaseUidRaw;
        
        // 둘 중 하나라도 있으면 소유자가 있는 것으로 판단
        const actualRuler = ruler || rulerFirebaseUid;
        
        console.log(`🔍 [PixelDataService] Ownership check:`, {
            rulerRaw: rulerRaw || 'null',
            rulerFirebaseUidRaw: rulerFirebaseUidRaw || 'null',
            ruler: ruler || 'null',
            rulerFirebaseUid: rulerFirebaseUid || 'null',
            actualRuler: actualRuler || 'null',
            sovereignty: territory?.sovereignty || 'null',
            hasOwner: !!actualRuler,
            isUnconquered: territory?.sovereignty === 'unconquered',
            territoryKeys: territory ? Object.keys(territory) : []
        });
        
        if (territory && (!actualRuler || territory.sovereignty === 'unconquered')) {
            console.log(`🔍 [PixelDataService] ⚠️ Territory ${territoryId} has no owner, returning empty data`);
            log.debug(`[PixelDataService] Territory ${territoryId} has no owner, skipping pixel data load`);
            return {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
        }
        
        console.log(`🔍 [PixelDataService] ✅ Territory ${territoryId} has owner (${actualRuler}), proceeding with pixel data load`);
        
        // ⚠️ 핵심 수정: forceRefresh가 true이면 캐시를 무시하고 API에서 직접 가져오기
        if (!forceRefresh) {
            // 1. 메모리 캐시 확인 (가장 빠름)
            console.log(`🔍 [PixelDataService] Step 1: Checking memory cache`);
            if (this.memoryCache.has(territoryId)) {
                const cached = this.memoryCache.get(territoryId);
                const age = Date.now() - cached.timestamp;
                console.log(`🔍 [PixelDataService] Memory cache found:`, {
                    age: age,
                    ageSeconds: Math.floor(age / 1000),
                    isFresh: age < 60000,
                    pixelsCount: cached.data?.pixels?.length || 0
                });
                // 메모리 캐시가 1분 이내면 사용
                if (age < 60000) {
                    console.log(`🔍 [PixelDataService] ✅ Using memory cache for ${territoryId}`);
                    log.debug(`[PixelDataService] Using memory cache for ${territoryId}`);
                    return cached.data;
                } else {
                    console.log(`🔍 [PixelDataService] ⚠️ Memory cache expired, continuing to next step`);
                }
            } else {
                console.log(`🔍 [PixelDataService] No memory cache found`);
            }
            
            // 2. 로컬 캐시(IndexedDB) 확인 (빠름)
            console.log(`🔍 [PixelDataService] Step 2: Checking local cache (IndexedDB)`);
            await this.initializeLocalCache();
            const localCached = await localCacheService.loadFromCache(territoryId);
            if (localCached) {
                console.log(`🔍 [PixelDataService] ✅ Local cache found:`, {
                    pixelsCount: localCached.pixels?.length || 0,
                    filledPixels: localCached.filledPixels || 0
                });
                log.debug(`[PixelDataService] Using local cache for ${territoryId}`);
                // 메모리 캐시에도 저장
                this.memoryCache.set(territoryId, {
                    data: localCached,
                    timestamp: Date.now()
                });
                return localCached;
            } else {
                console.log(`🔍 [PixelDataService] No local cache found`);
            }
        } else {
            console.log(`🔍 [PixelDataService] ⚠️ forceRefresh=true, skipping all caches and loading from API directly`);
        }
        
        // 3. API에서 로드
        console.log(`🔍 [PixelDataService] Step 3: Loading from API`);
        try {
            const { apiService } = await import('./ApiService.js');
            console.log(`🔍 [PixelDataService] Calling apiService.getPixelData(${territoryId})`);
            const apiData = await apiService.getPixelData(territoryId);
            console.log(`🔍 [PixelDataService] API response received:`, {
                hasApiData: !!apiData,
                hasPixels: !!(apiData && apiData.pixels),
                pixelsLength: apiData?.pixels?.length || 0,
                apiDataKeys: apiData ? Object.keys(apiData) : [],
                fullApiData: apiData // 전체 응답 데이터 확인
            });
            
            // ⚠️ 핵심 디버깅: API 응답의 전체 구조 출력
            if (apiData) {
                console.log(`🔍 [PixelDataService] Full API response structure:`, JSON.stringify(apiData, null, 2));
                console.log(`🔍 [PixelDataService] API response pixels type:`, typeof apiData.pixels, Array.isArray(apiData.pixels));
                if (apiData.pixels) {
                    console.log(`🔍 [PixelDataService] API response pixels length:`, apiData.pixels.length);
                    console.log(`🔍 [PixelDataService] API response pixels sample (first 3):`, apiData.pixels.slice(0, 3));
                }
            }
            
            if (apiData && apiData.pixels && apiData.pixels.length > 0) {
                // API 데이터를 기존 형식으로 변환
                const data = {
                    territoryId: apiData.territoryId,
                    pixels: apiData.pixels,
                    width: apiData.width || 64,
                    height: apiData.height || 64,
                    filledPixels: apiData.filledPixels || apiData.pixels.length,
                    lastUpdated: apiData.lastUpdated
                };
                
                console.log(`🔍 [PixelDataService] ✅ Pixel data converted:`, {
                    territoryId: data.territoryId,
                    pixelsCount: data.pixels.length,
                    filledPixels: data.filledPixels,
                    width: data.width,
                    height: data.height
                });
                
                // 메모리 캐시에 저장
                this.memoryCache.set(territoryId, {
                    data,
                    timestamp: Date.now()
                });
                
                // 로컬 캐시에도 저장 (다음 로드 시 빠르게)
                await localCacheService.saveToCache(territoryId, data);
                
                console.log(`🔍 [PixelDataService] ✅ Pixel data cached (memory + IndexedDB)`);
                log.info(`[PixelDataService] Loaded pixel data from API for ${territoryId} (${data.filledPixels || 0} pixels)`);
                return data;
            }
            
            // 데이터가 없으면 빈 데이터 반환 (정상적인 경우)
            console.log(`🔍 [PixelDataService] ⚠️ API returned no pixel data, returning empty data`);
            const emptyData = {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
            
            // 빈 데이터도 캐시에 저장 (불필요한 API 호출 방지)
            this.memoryCache.set(territoryId, {
                data: emptyData,
                timestamp: Date.now()
            });
            
            console.log(`🔍 [PixelDataService] Returning empty data (no pixels from API)`);
            return emptyData;
            
        } catch (error) {
            // 오프라인 에러나 존재하지 않는 문서는 빈 데이터 반환
            console.log(`🔍 [PixelDataService] ❌ API call failed:`, error);
            log.debug(`[PixelDataService] Failed to load from Firebase for ${territoryId}, returning empty data`);
            const errorData = {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
            console.log(`🔍 [PixelDataService] ========== loadPixelData END (ERROR) ==========`);
            return errorData;
        }
        
        console.log(`🔍 [PixelDataService] ========== loadPixelData END ==========`);
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
            
            // 1. API를 통해 저장 (PostgreSQL이 유일 SoT - 전문가 조언 반영)
            try {
                const { apiService } = await import('./ApiService.js');
                const savePayload = {
                    pixels: dataToSave.pixels,
                    width: dataToSave.width || 64,
                    height: dataToSave.height || 64
                };
                console.log(`🔍 [PixelDataService] Saving pixel data to API:`, {
                    territoryId,
                    pixelsCount: savePayload.pixels?.length || 0,
                    width: savePayload.width,
                    height: savePayload.height,
                    pixelsType: Array.isArray(savePayload.pixels) ? 'array' : typeof savePayload.pixels,
                    pixelsSample: savePayload.pixels?.slice(0, 3) // 처음 3개만 샘플로
                });
                await apiService.savePixelData(territoryId, savePayload);
                console.log(`🔍 [PixelDataService] ✅ Pixel data saved to API successfully`);
                log.info(`[PixelDataService] ✅ Saved pixel data to API for ${territoryId}`);
            } catch (apiError) {
                // ⚠️ 전문가 조언: Firestore fallback 제거 (장애 은폐 방지)
                // API 실패 시 재시도 가능한 형태로 에러 처리
                log.error(`[PixelDataService] ❌ Failed to save to API for ${territoryId}:`, apiError);
                
                // 오프라인 복구 큐에 추가 (네트워크 복구 시 자동 재시도)
                this.setupOfflineRecovery(territoryId, dataToSave);
                
                // 사용자에게 재시도 가능한 에러 알림
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: `픽셀 저장 실패: ${apiError.message || '네트워크 오류'}. 재시도 중...`,
                    duration: 5000
                });
                
                // 에러를 다시 throw하여 호출자가 처리할 수 있도록 함
                throw new Error(`Failed to save pixel data: ${apiError.message}`);
            }
            
            // ⚠️ 핵심 수정: 저장 후 메모리 캐시를 무효화하여 다음 로드 시 API에서 최신 데이터 가져오기
            // 저장된 데이터로 메모리 캐시를 업데이트하지 않고, clearMemoryCache만 호출
            // 이유: Redis에 저장된 데이터와 동기화를 보장하기 위해 API에서 다시 가져오도록 함
            this.clearMemoryCache(territoryId);
            
            // 2. 로컬 캐시(IndexedDB) 업데이트 (오프라인 복구용)
            await this.initializeLocalCache();
            await localCacheService.saveToCache(territoryId, dataToSave);
            
            // Delta 저장 통계 로깅
            if (pixelData.isDelta) {
                log.info(`[PixelDataService] Delta save completed: ${pixelData.changedCount} pixels changed, ${dataToSave.filledPixels} total pixels`);
            }
            
            // pending 저장 제거
            this.pendingSaves.delete(territoryId);
            this.saveTimeouts.delete(territoryId);
            
            log.info(`[PixelDataService] ✅ Saved pixel data for ${territoryId} (${dataToSave.filledPixels || 0} pixels)`);
            
            // ⚠️ 전문가 조언 반영: Postgres를 유일 SoT로 확정
            // 영토의 lastActivityAt 업데이트는 백엔드 API에서 처리 (픽셀 저장 시 자동 업데이트)
            // Firestore 직접 호출 제거 (장애 은폐 방지)
            
            // 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_DATA_SAVED, {
                territoryId,
                filledPixels: pixelData.filledPixels || 0
            });
            
        } catch (error) {
            log.error(`[PixelDataService] Failed to save pixel data for ${territoryId}:`, error);
            
            // ⚠️ CRITICAL: 오프라인 상태 처리 및 자동 복구
            const isNetworkError = error.code === 'unavailable' || 
                                  error.code === 'deadline-exceeded' ||
                                  error.message?.includes('network') ||
                                  error.message?.includes('offline') ||
                                  !navigator.onLine;
            
            if (isNetworkError) {
                log.warn(`[PixelDataService] ⚠️ Network error detected, saving to local cache for recovery: ${territoryId}`);
                
                // 로컬 캐시에 저장 (오프라인 복구용)
                try {
                    await this.initializeLocalCache();
                    await localCacheService.saveToCache(territoryId, pixelData, { offline: true });
                    
                    // 오프라인 저장 이벤트 발행
                    eventBus.emit(EVENTS.PIXEL_UPDATE, {
                        type: 'saveStatus',
                        status: 'offline',
                        message: '오프라인 모드: 로컬에 저장되었습니다. 연결되면 자동으로 동기화됩니다.'
                    });
                    
                    // 네트워크 복구 시 자동 재시도
                    this.setupOfflineRecovery(territoryId, pixelData);
                } catch (cacheError) {
                    log.error(`[PixelDataService] Failed to save to local cache:`, cacheError);
                }
            } else {
                // 네트워크 오류가 아닌 경우 에러 전파
                throw error;
            }
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
            
            // ✅ 백엔드 API 사용
            try {
                await apiService.deletePixelData(territoryId);
                log.info(`[PixelDataService] ✅ Deleted pixel data via API for ${territoryId}`);
            } catch (error) {
                log.warn(`[PixelDataService] Failed to delete pixel data via API for ${territoryId}:`, error);
                // API 실패 시에도 로컬 캐시는 정리
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
     * ⚠️ Firestore 직접 호출 제거: Postgres를 유일 SoT로 사용
     * 메타데이터는 백엔드 API에서 처리
     */
    async updateTerritoryMetadata(territoryId, metadata) {
        try {
            // Firestore 직접 호출 제거 (Postgres를 유일 SoT로 사용)
            // 메타데이터 업데이트는 백엔드 API에서 처리됨
            log.debug(`[PixelDataService] Metadata update skipped (handled by backend API) for ${territoryId}`);
            
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

