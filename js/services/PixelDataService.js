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
                    message: 'Offline save synchronized.'
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
        // ⚡ 가드: territoryId가 없으면 즉시 반환 (undefined 방지)
        if (!territoryId || territoryId === 'undefined' || territoryId === 'null') {
            log.warn(`[PixelDataService] ⚠️ loadPixelData called with invalid territoryId: ${territoryId}, skipping`);
            return {
                territoryId: null,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
        }
        
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
        
        // ⚡ 게스트 지원: 소유권이 없어도 픽셀 데이터는 조회 가능 (view는 public)
        // 편집/저장만 auth 필요
        // 소유권 체크는 저장 시에만 수행
        if (territory && (!actualRuler || territory.sovereignty === 'unconquered')) {
            console.log(`🔍 [PixelDataService] ℹ️ Territory ${territoryId} has no owner, but proceeding with pixel data load (guest view allowed)`);
            log.debug(`[PixelDataService] Territory ${territoryId} has no owner, but loading pixel data for guest view`);
            // 게스트도 픽셀아트를 볼 수 있도록 계속 진행 (빈 데이터 반환하지 않음)
        } else if (actualRuler) {
            console.log(`🔍 [PixelDataService] ✅ Territory ${territoryId} has owner (${actualRuler}), proceeding with pixel data load`);
        }
        
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
            try {
                await this.initializeLocalCache();
                const cacheResult = await localCacheService.loadFromCacheWithMetadata(territoryId);
                
                if (cacheResult && cacheResult.pixelData) {
                    // ⚠️ 개선: 캐시 메타데이터 기반 검증 (서버 revision/updatedAt 비교)
                    const cacheMetadata = cacheResult.metadata || {};
                    const cacheUpdatedAt = cacheMetadata.updatedAt || cacheMetadata.lastUpdated;
                    const cacheRevision = cacheMetadata.revision;
                    
                    console.log(`🔍 [PixelDataService] ✅ Local cache found:`, {
                        pixelsCount: cacheResult.pixelData.pixels?.length || 0,
                        filledPixels: cacheResult.pixelData.filledPixels || 0,
                        cachedAt: cacheUpdatedAt,
                        revision: cacheRevision
                    });
                    
                    // ⚠️ 개선: 서버 메타데이터와 비교 (TTL보다 정확)
                    // 서버에서 territory 메타데이터를 먼저 가져와서 revision/updatedAt 비교
                    // 지금은 API 응답에 메타데이터가 포함되어 있으므로, API 호출 후 비교
                    // 여기서는 일단 캐시를 사용하고, API 응답 후 서버 메타와 비교하여 무효화
                    
                    // ⚠️ 개선: TTL은 fallback으로만 사용 (서버 메타가 없을 때)
                    const CACHE_MAX_AGE = 30 * 60 * 1000; // 30분 (fallback)
                    const cacheAge = Date.now() - (cacheUpdatedAt || 0);
                    
                    // 서버 메타데이터가 있으면 그것을 우선, 없으면 TTL 사용
                    // 실제 비교는 API 응답 후에 수행 (아래 코드에서)
                    
                    log.debug(`[PixelDataService] Using local cache for ${territoryId} (will validate with server metadata)`);
                    // 메모리 캐시에도 저장
                    this.memoryCache.set(territoryId, {
                        data: cacheResult.pixelData,
                        timestamp: Date.now(),
                        metadata: cacheMetadata // ⚠️ 개선: 메타데이터도 저장
                    });
                    
                    // ⚠️ 개선: 캐시를 반환하되, API 응답 후 서버 메타와 비교하여 무효화
                    // 지금은 일단 캐시를 반환하고, API 응답이 오면 비교
                    return cacheResult.pixelData;
                } else {
                    console.log(`🔍 [PixelDataService] No local cache found`);
                }
            } catch (cacheError) {
                // IndexedDB 에러는 조용히 처리하고 API에서 로드 계속 진행
                console.log(`🔍 [PixelDataService] ⚠️ Local cache error (will load from API):`, cacheError);
                log.warn(`[PixelDataService] Local cache error for ${territoryId}, continuing with API load:`, cacheError);
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
                // ⚠️ 개선: 메타데이터 포함 (캐시 일관성 검증용)
                const data = {
                    territoryId: apiData.territoryId,
                    pixels: apiData.pixels,
                    width: apiData.width || 64,
                    height: apiData.height || 64,
                    filledPixels: apiData.filledPixels || apiData.pixels.length,
                    lastUpdated: apiData.lastUpdated || Date.now(),
                    // ⚠️ 개선: 서버 메타데이터 저장
                    revision: apiData.revision || apiData.version || null,
                    updatedAt: apiData.updatedAt || apiData.lastUpdated || Date.now(),
                    payloadHash: apiData.payloadHash || null // 선택적
                };
                
                console.log(`🔍 [PixelDataService] ✅ Pixel data converted:`, {
                    territoryId: data.territoryId,
                    pixelsCount: data.pixels.length,
                    filledPixels: data.filledPixels,
                    width: data.width,
                    height: data.height
                });
                
                // ⚠️ 개선: 서버 메타데이터와 캐시 메타데이터 비교
                const cachedMetadata = this.memoryCache.get(territoryId)?.metadata;
                if (cachedMetadata) {
                    const serverRevision = data.revision;
                    const serverUpdatedAt = data.updatedAt;
                    const cacheRevision = cachedMetadata.revision;
                    const cacheUpdatedAt = cachedMetadata.updatedAt || cachedMetadata.lastUpdated;
                    
                    // ⚠️ 개선: 서버 메타데이터가 더 최신이면 캐시 무효화
                    if (serverRevision && cacheRevision && serverRevision !== cacheRevision) {
                        console.log(`🔍 [PixelDataService] ⚠️ Server revision (${serverRevision}) differs from cache (${cacheRevision}), cache invalidated`);
                        this.clearMemoryCache(territoryId);
                        // IndexedDB 캐시도 무효화
                        await localCacheService.clearCache(territoryId).catch(() => {});
                    } else if (serverUpdatedAt && cacheUpdatedAt) {
                        // ⚠️ 개선: updatedAt 비교 (ISO 문자열 또는 숫자 모두 처리)
                        const serverTime = typeof serverUpdatedAt === 'string' ? new Date(serverUpdatedAt).getTime() : serverUpdatedAt;
                        const cacheTime = typeof cacheUpdatedAt === 'string' ? new Date(cacheUpdatedAt).getTime() : cacheUpdatedAt;
                        
                        if (serverTime && cacheTime && serverTime > cacheTime) {
                            console.log(`🔍 [PixelDataService] ⚠️ Server updatedAt (${new Date(serverTime)}) is newer than cache (${new Date(cacheTime)}), cache invalidated`);
                            this.clearMemoryCache(territoryId);
                            await localCacheService.clearCache(territoryId).catch(() => {});
                        }
                    }
                }
                
                // 메모리 캐시에 저장 (메타데이터 포함)
                this.memoryCache.set(territoryId, {
                    data,
                    timestamp: Date.now(),
                    metadata: { // ⚠️ 개선: 메타데이터도 저장
                        revision: data.revision,
                        updatedAt: data.updatedAt,
                        lastUpdated: data.lastUpdated
                    }
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
                    message: `Pixel editing is too fast. Please try again after ${rateLimitCheck.retryAfter} seconds.`,
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
     * @param {string} territoryId - 영토 ID
     * @param {object} pixelData - 픽셀 데이터
     * @param {object} options - 옵션
     * @param {string} options.saveRunId - 저장 실행 ID (진단용)
     */
    async savePixelDataImmediate(territoryId, pixelData, options = {}) {
        // pending 저장 업데이트
        this.pendingSaves.set(territoryId, pixelData);
        
        // saveRunId 저장 (나중에 _executeSave에서 사용)
        if (options.saveRunId) {
            if (!this.saveRunIds) {
                this.saveRunIds = new Map();
            }
            this.saveRunIds.set(territoryId, options.saveRunId);
        }
        
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
                    width: dataToSave.width || 128,
                    height: dataToSave.height || 128
                };
                
                // ⚠️ 페이로드 크기 검증 및 로깅
                const payloadJson = JSON.stringify(savePayload);
                const payloadSizeKB = (payloadJson.length / 1024).toFixed(2);
                const payloadSizeMB = (payloadJson.length / (1024 * 1024)).toFixed(2);
                
                console.log(`🔍 [PixelDataService] Saving pixel data to API:`, {
                    territoryId,
                    pixelsCount: savePayload.pixels?.length || 0,
                    width: savePayload.width,
                    height: savePayload.height,
                    payloadSizeKB: `${payloadSizeKB} KB`,
                    payloadSizeMB: `${payloadSizeMB} MB`,
                    pixelsType: Array.isArray(savePayload.pixels) ? 'array' : typeof savePayload.pixels,
                    pixelsSample: savePayload.pixels?.slice(0, 3) // 처음 3개만 샘플로
                });
                
                // ⚠️ 페이로드 크기 경고 (10MB 이상이면 경고)
                if (parseFloat(payloadSizeMB) > 10) {
                    log.warn(`[PixelDataService] ⚠️ Large payload size: ${payloadSizeMB} MB for ${territoryId}. Server may reject.`);
                }
                
                // ⚠️ 진단용: saveRunId 헤더 전달
                const saveRunId = this.saveRunIds?.get(territoryId);
                await apiService.savePixelData(territoryId, savePayload, { saveRunId });
                console.log(`🔍 [PixelDataService] ✅ Pixel data saved to API successfully`);
                log.info(`[PixelDataService] ✅ Saved pixel data to API for ${territoryId} (${payloadSizeKB} KB)`);
            } catch (apiError) {
                // ⚠️ CRITICAL: 413 Payload Too Large 에러는 타일 저장으로 전환해야 함
                // 하지만 레거시 저장 경로는 더 이상 사용하지 않으므로 에러를 그대로 전파
                
                // ⚠️ 에러 상세 정보 로깅
                const errorDetails = {
                    territoryId,
                    errorMessage: apiError.message,
                    errorStatus: apiError.status,
                    pixelsCount: dataToSave.pixels?.length || 0,
                    payloadSize: JSON.stringify(dataToSave).length,
                    payloadSizeKB: `${(JSON.stringify(dataToSave).length / 1024).toFixed(2)} KB`
                };
                
                // 413 에러인 경우 특별한 로깅
                if (apiError.status === 413 || apiError.message?.includes('Payload Too Large') || apiError.message?.includes('entity too large')) {
                    log.error(`[PixelDataService] ❌ 413 Payload Too Large for ${territoryId}`, errorDetails);
                    log.error(`[PixelDataService] ⚠️ CRITICAL: Legacy save endpoint rejected payload. Use tile-based save instead.`);
                } else {
                    log.error(`[PixelDataService] ❌ Failed to save to API for ${territoryId}:`, apiError);
                    log.error(`[PixelDataService] Error details:`, errorDetails);
                }
                
                // 서버 응답 본문이 있으면 로깅
                if (apiError.response) {
                    try {
                        const errorBody = await apiError.response.text();
                        log.error(`[PixelDataService] Server error response:`, errorBody);
                    } catch (e) {
                        // 응답 본문 파싱 실패는 무시
                    }
                }
                
                // 오프라인 복구 큐에 추가 (네트워크 복구 시 자동 재시도)
                this.setupOfflineRecovery(territoryId, dataToSave);
                
                // 사용자에게 재시도 가능한 에러 알림
                const userMessage = apiError.status === 500 
                    ? '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
                    : `Pixel save failed: ${apiError.message || 'Network error'}. Retrying...`;
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: userMessage,
                    duration: 5000
                });
                
                // 에러를 다시 throw하여 호출자가 처리할 수 있도록 함
                throw new Error(`Failed to save pixel data: ${apiError.message || 'Server error'}`);
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
                        message: 'Offline mode: Saved locally. Will sync automatically when connected.'
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
    
    /**
     * 영토 메타데이터 로드 (타일 시스템용)
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Object>} 영토 메타데이터
     */
    async loadTerritoryMetadata(territoryId) {
        try {
            // ⚠️ URL 중복 방지: baseUrl에 이미 /api가 포함되어 있으므로 /api 제거
            const response = await apiService.get(`/territories/${territoryId}/pixels/metadata`);
            return response;
        } catch (error) {
            log.error(`[PixelDataService] Failed to load territory metadata for ${territoryId}:`, error);
            // 기본값 반환
            return {
                territoryId,
                gridVersion: 2,
                territoryRevision: 0,
                tileRevisionMap: {},
                updatedAt: new Date().toISOString(),
                ownerId: null
            };
        }
    }
    
    /**
     * 타일 데이터 로드 (타일 시스템용)
     * @param {string} territoryId - 영토 ID
     * @param {Array<string>} tileIds - 요청할 타일 ID 목록
     * @param {Object} clientRevisions - 클라이언트가 가진 타일 리비전 맵 {tileId: revision}
     * @returns {Promise<Object>} {tiles: Array, unchanged: Array}
     */
    async loadTiles(territoryId, tileIds, clientRevisions = {}) {
        try {
            const tilesParam = tileIds.join(',');
            const revisionsParam = JSON.stringify(clientRevisions);
            
            // ⚠️ URL 중복 방지: baseUrl에 이미 /api가 포함되어 있으므로 /api 제거
            const response = await apiService.get(
                `/territories/${territoryId}/pixels/tiles`,
                { tiles: tilesParam, revisions: revisionsParam }
            );
            
            return response;
        } catch (error) {
            log.error(`[PixelDataService] Failed to load tiles for ${territoryId}:`, error);
            return { tiles: [], unchanged: [] };
        }
    }
    
    /**
     * 타일 데이터 저장 (타일 시스템용)
     * ⚠️ 운영 안정성: chunk 분할, 409 충돌 재동기화 처리
     * @param {string} territoryId - 영토 ID
     * @param {Array<Object>} tiles - 저장할 타일 데이터 [{tileId, pixels, revision}]
     * @returns {Promise<Object>} {success, updatedTiles, conflicts, territoryRevision}
     */
    async saveTiles(territoryId, tiles) {
        try {
            // ⚠️ 가드레일: chunk 분할 (대량 변경 대응)
            const MAX_TILES_PER_CHUNK = CONFIG.TERRITORY.TILE_SYSTEM?.SAVE_CHUNK_SIZE || 50;
            
            if (tiles.length <= MAX_TILES_PER_CHUNK) {
                // 작은 요청은 바로 전송
                return await this._saveTilesChunk(territoryId, tiles);
            }
            
            // 대량 요청은 chunk로 분할하여 순차 전송
            const chunks = [];
            for (let i = 0; i < tiles.length; i += MAX_TILES_PER_CHUNK) {
                chunks.push(tiles.slice(i, i + MAX_TILES_PER_CHUNK));
            }
            
            log.info(`[PixelDataService] Splitting ${tiles.length} tiles into ${chunks.length} chunks`);
            
            const results = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunkResult = await this._saveTilesChunk(territoryId, chunks[i]);
                results.push(chunkResult);
                // ⚠️ 최적화: conflict 발생 시에도 모든 chunk 처리 후 결과 병합
                // PixelCanvas3에서 conflict 타일만 재시도하도록 변경
            }
            
            // 모든 chunk 결과 병합 (conflict 포함)
            const allConflicts = results.flatMap(r => r.conflicts || []);
            const allUpdatedTiles = results.flatMap(r => r.updatedTiles || []);
            
            return {
                success: allConflicts.length === 0, // conflict가 없으면 success
                updatedTiles: allUpdatedTiles,
                conflicts: allConflicts.length > 0 ? allConflicts : undefined,
                territoryRevision: results[results.length - 1]?.territoryRevision
            };
        } catch (error) {
            log.error(`[PixelDataService] Failed to save tiles for ${territoryId}:`, error);
            throw error;
        }
    }
    
    /**
     * 타일 chunk 저장 (내부)
     */
    async _saveTilesChunk(territoryId, tiles) {
        // ⚠️ 진단용: tiles 저장 요청 payload 요약 출력
        const tileCount = Array.isArray(tiles) ? tiles.length : 0;
        const chunkBytes = JSON.stringify({ tiles }).length;
        const width = tiles?.[0]?.pixels ? Math.max(...tiles.map(t => Math.max(...(t.pixels || []).map(p => p.x || 0)))) : 0;
        const height = tiles?.[0]?.pixels ? Math.max(...tiles.map(t => Math.max(...(t.pixels || []).map(p => p.y || 0)))) : 0;
        const revision = tiles?.[0]?.revision || 0;
        
        console.log('[PixelDataService] 🔍 [tiles payload]', {
            territoryId,
            keys: ['tiles'],
            tileCount,
            chunkBytes: `${(chunkBytes / 1024).toFixed(2)} KB`,
            width,
            height,
            revision,
            tilesSample: Array.isArray(tiles) && tiles.length > 0 ? {
                tileId: tiles[0].tileId,
                pixelsCount: tiles[0].pixels?.length || 0,
                revision: tiles[0].revision
            } : null
        });
        
        try {
            // ⚠️ URL 중복 방지: baseUrl에 이미 /api가 포함되어 있으므로 /api 제거
            const response = await apiService.post(
                `/territories/${territoryId}/pixels/tiles`,
                { tiles }
            );
            
            // 성공 시 이벤트 발행
            if (response.success) {
                eventBus.emit(EVENTS.PIXEL_DATA_SAVED, {
                    territoryId,
                    updatedTiles: response.updatedTiles,
                    territoryRevision: response.territoryRevision
                });
            }
            
            return response;
        } catch (error) {
            // ⚠️ 409 Conflict 에러를 정상 응답으로 변환 (conflict 타일만 재시도하기 위해)
            if (error.status === 409 && error.details) {
                // error.details에 이미 파싱된 응답 데이터가 있을 수 있음
                const conflictData = error.details;
                if (conflictData.conflicts) {
                    log.warn(`[PixelDataService] 409 Conflict detected for ${territoryId}, converting to response object (${conflictData.conflicts.length} conflicts)`);
                    // Conflict 응답을 정상 응답 형태로 반환
                    const conflictResponse = {
                        success: false,
                        conflicts: conflictData.conflicts,
                        updatedTiles: conflictData.updatedTiles || [],
                        territoryRevision: conflictData.territoryRevision
                    };
                    return conflictResponse;
                }
            }
            // 409가 아니거나 파싱 실패한 경우 원래 에러 throw
            throw error;
        }
    }
    
    /**
     * 409 충돌 재동기화 처리
     * ⚠️ 재동기화 플로우: metadata 재조회 → conflict tiles 재다운로드 → 편집 재적용
     */
    async _handleConflictResync(territoryId, conflictResponse) {
        log.warn(`[PixelDataService] Conflict detected, starting resync for ${territoryId}`);
        
        try {
            // 1. metadata 재조회
            const metadata = await this.loadTerritoryMetadata(territoryId);
            
            // 2. conflict tiles 재다운로드 (서버에서 제공한 최신 데이터 사용)
            if (conflictResponse.conflictTiles && conflictResponse.conflictTiles.length > 0) {
                // 서버가 제공한 최신 타일 데이터로 타일 리비전 맵 업데이트
                for (const tile of conflictResponse.conflictTiles) {
                    // 클라이언트의 타일 리비전 맵 업데이트는 PixelCanvas3에서 처리
                    log.debug(`[PixelDataService] Conflict tile ${tile.tileId} updated to revision ${tile.revision}`);
                }
            }
            
            // 3. 재동기화 이벤트 발행 (PixelCanvas3에서 처리)
            eventBus.emit('pixel:tiles:conflict', {
                territoryId,
                conflicts: conflictResponse.conflicts,
                conflictTiles: conflictResponse.conflictTiles,
                metadata
            });
            
            return conflictResponse;
        } catch (error) {
            log.error(`[PixelDataService] Failed to resync after conflict:`, error);
            return conflictResponse;
        }
    }
}

// 싱글톤 인스턴스
export const pixelDataService = new PixelDataService();
export default pixelDataService;

