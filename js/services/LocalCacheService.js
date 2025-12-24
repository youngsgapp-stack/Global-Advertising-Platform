/**
 * LocalCacheService - IndexedDB를 사용한 로컬 캐시 서비스
 * 
 * 책임:
 * - Firebase에서 로드한 픽셀 데이터를 IndexedDB에 캐시
 * - 다음 로드 시 로컬 캐시를 먼저 확인하여 빠른 로딩
 * - 캐시는 삭제하지 않고 계속 유지
 */

import { CONFIG, log } from '../config.js';

class LocalCacheService {
    constructor() {
        this.dbName = 'pixelCanvasCache';
        this.LATEST_SCHEMA_VERSION = 3; // ⚠️ 개선: 최신 스키마 버전 고정
        this.dbVersion = this.LATEST_SCHEMA_VERSION;
        this.storeName = 'pixelCanvases';
        this.sessionStoreName = 'pixelSessions'; // 미완성 세션 저장소
        this.db = null;
        this.initialized = false;
        this._initPromise = null; // ⚠️ 개선: 단일 initialization promise (race condition 방지)
        this._isInitializing = false; // ⚠️ 전문가 조언: 초기화 진행 여부 별도 플래그 (경쟁 조건 방지)
        this._deleteAttempted = false; // ⚠️ 개선: DB 삭제 시도는 1회만
        this._errorCount = 0; // ⚠️ 개선: 에러 카운트 (샘플링 로그용)
        this._errorCountsByType = new Map(); // ⚠️ 개선: 에러 타입별 카운트
        this._initFailureCount = 0; // ⚠️ 개선: 초기화 실패 횟수
        this._cacheDisabled = false; // ⚠️ 개선: 캐시 OFF 모드 플래그
        this._blockedRetryCount = 0; // ⚠️ 개선: blocked 재시도 횟수
        this._blockedRetryTimeout = null; // ⚠️ 전문가 조언: blocked 재시도 timeout 추적 (중복 스케줄 방지)
        
        // ⚠️ 전문가 조언: 캐시 OFF 모드를 세션 스토리지에서 복원
        this._loadCacheDisabledState();
    }
    
    /**
     * IndexedDB 초기화
     * ⚠️ 개선: 단일 initialization promise 패턴으로 race condition 완전 제거
     * ⚠️ 개선: DB 삭제는 최후의 수단, upgrade 중심으로 변경
     * ⚠️ 개선: 에러 처리 강화 (finally에서 promise 정리)
     */
    async initialize() {
        // ⚠️ 개선: 캐시 OFF 모드면 초기화 스킵
        if (this._cacheDisabled) {
            log.debug('[LocalCacheService] Cache disabled, skipping initialization');
            return;
        }
        
        // 이미 초기화되었고 object store가 있는지 확인
        if (this.initialized && this.db) {
            try {
                if (this.db.objectStoreNames.contains(this.storeName)) {
                    return; // 이미 초기화됨
                }
            } catch (error) {
                // DB가 닫혔을 수 있음
                log.warn('[LocalCacheService] DB check failed, reinitializing...', error);
                this.initialized = false;
                this.db = null;
                this._initPromise = null; // 재초기화 필요
            }
        }
        
        // ⚠️ 전문가 조언: 초기화 진행 여부를 별도 플래그로 가드 (경쟁 조건 방지)
        // ⚠️ 최종 피드백: 재시도 중에도 동일 탭에서 추가 open 시도가 합쳐지는지 확인
        if (this._isInitializing || this._initPromise) {
            log.debug('[LocalCacheService] Initialization already in progress, returning existing promise');
            return this._initPromise || Promise.resolve();
        }
        
        // ⚠️ 전문가 조언: 초기화 플래그 설정
        // ⚠️ 최종 피드백: 어떤 경로로 끝나든 반드시 false로 내려가는지 보장
        this._isInitializing = true;
        
        // ⚠️ 개선: 단일 promise 생성 및 저장 (에러 처리 강화)
        this._initPromise = (async () => {
            try {
                await this._doInitialize();
                // ⚠️ 개선: 성공 시 상태 정리
                this.initialized = true;
                this._initFailureCount = 0; // 성공 시 실패 카운트 리셋
                return;
            } catch (error) {
                // ⚠️ 개선: 실패 시 상태 정리
                this._initFailureCount++;
                this.initialized = false;
                
                // ⚠️ 개선: 초기화 2회 실패 시 캐시 OFF 모드 전환
                if (this._initFailureCount >= 2) {
                    log.warn('[LocalCacheService] Initialization failed 2 times, disabling cache');
                    this._setCacheDisabled(true);
                }
                
                throw error;
            } finally {
                // ⚠️ 전문가 조언: finally에서만 promise와 플래그 정리 (경쟁 조건 방지)
                this._initPromise = null;
                this._isInitializing = false;
            }
        })();
        
        return this._initPromise;
    }
    
    /**
     * 실제 초기화 로직
     * ⚠️ 개선: upgrade 중심으로 변경, DB 삭제는 최후의 수단
     * ⚠️ 개선: 최신 버전 고정 방식으로 변경 (+1 증가 대신)
     * ⚠️ 개선: 멀티 탭 이슈 처리 (onversionchange, onblocked)
     */
    async _doInitialize() {
        return new Promise((resolve, reject) => {
            // ⚠️ 개선: 최신 버전으로 열기 (버전 스킵 업그레이드)
            const request = indexedDB.open(this.dbName, this.LATEST_SCHEMA_VERSION);
            
            // ⚠️ 전문가 조언: 멀티 탭 이슈 처리 - blocked 이벤트 (지수 백오프 재시도)
            request.onblocked = () => {
                log.warn('[LocalCacheService] IndexedDB upgrade blocked by another tab');
                this._blockedRetryCount++;
                
                // ⚠️ 개선: blocked가 지속되면 캐시 OFF 모드로 전환
                if (this._blockedRetryCount >= 3) {
                    log.warn('[LocalCacheService] Blocked persisted, disabling cache');
                    this._setCacheDisabled(true);
                    reject(new Error('IndexedDB upgrade blocked persistently'));
                    return;
                }
                
                // ⚠️ 전문가 조언: 지수 백오프로 실제 open 재시도 수행 (중복 스케줄 방지)
                if (this._blockedRetryTimeout) {
                    clearTimeout(this._blockedRetryTimeout);
                }
                
                const delay = Math.min(500 * Math.pow(2, this._blockedRetryCount - 1), 2000); // 500ms → 1s → 2s
                log.info(`[LocalCacheService] Retrying after ${delay}ms (attempt ${this._blockedRetryCount})...`);
                
                this._blockedRetryTimeout = setTimeout(async () => {
                    this._blockedRetryTimeout = null;
                    try {
                        // 실제 재시도: 새로운 open 요청
                        await this._doInitialize();
                        resolve();
                    } catch (retryError) {
                        // 재시도 실패는 상위에서 처리
                        reject(retryError);
                    }
                }, delay);
            };
            
            request.onerror = () => {
                const error = request.error;
                this._recordError(error);
                log.error('[LocalCacheService] Failed to open IndexedDB:', error);
                reject(error);
            };
            
            request.onsuccess = () => {
                this.db = request.result;
                
                // ⚠️ 전문가 조언: 멀티 탭 이슈 처리 - versionchange 이벤트 (AbortError 처리)
                this.db.onversionchange = () => {
                    log.info('[LocalCacheService] Version change detected, closing DB connection');
                    
                    // ⚠️ 전문가 조언: 열려있는 트랜잭션이 abort될 수 있으므로 에러 카운트로 처리
                    // ⚠️ 최종 피드백: AbortError가 업그레이드 시점인지 평상시인지 분리 모니터링
                    try {
                        // 진행 중인 트랜잭션 정리
                        if (this.db && this.db.objectStoreNames) {
                            // DB 닫기 (트랜잭션 자동 abort)
                            this.db.close();
                        }
                    } catch (error) {
                        // AbortError는 정상적인 상황 (다른 탭에서 upgrade 중)
                        if (error.name === 'AbortError') {
                            // ⚠️ 최종 피드백: 업그레이드 시점의 AbortError는 정상이므로 별도 카운트
                            // 업그레이드 시점이므로 "versionchange" 카테고리로 기록
                            this._recordError({ name: 'VersionChangeAbortError', message: 'Transaction aborted during version change (normal)' });
                            log.debug('[LocalCacheService] Transaction aborted due to version change (normal - upgrade in progress)');
                        } else {
                            log.warn('[LocalCacheService] Error during version change:', error);
                            this._recordError(error);
                        }
                    }
                    
                    this.db = null;
                    this.initialized = false;
                    this._initPromise = null; // 재초기화 가능하도록
                    this._isInitializing = false; // 플래그도 리셋
                };
                
                // ⚠️ 개선: object store가 없으면 최신 버전으로 upgrade 시도
                if (!this.db.objectStoreNames.contains(this.storeName)) {
                    log.warn(`[LocalCacheService] Object store '${this.storeName}' not found. Attempting upgrade to latest version...`);
                    
                    // ⚠️ 개선: DB 삭제는 1회만 시도
                    if (this._deleteAttempted) {
                        log.error('[LocalCacheService] DB deletion already attempted, cannot recover');
                        reject(new Error('Object store missing and deletion already attempted'));
                        return;
                    }
                    
                    // ⚠️ 개선: 최신 버전으로 한 번에 업그레이드 (버전 스킵)
                    this.db.close();
                    this.db = null;
                    
                    const upgradeRequest = indexedDB.open(this.dbName, this.LATEST_SCHEMA_VERSION);
                    
                    upgradeRequest.onupgradeneeded = (event) => {
                        const db = event.target.result;
                        log.info('[LocalCacheService] Upgrade triggered, creating missing object stores...');
                        
                        // 픽셀 캔버스 데이터 저장소 생성
                        if (!db.objectStoreNames.contains(this.storeName)) {
                            const store = db.createObjectStore(this.storeName, { keyPath: 'territoryId' });
                            store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
                            // ⚠️ 개선: 메타데이터 인덱스 추가
                            store.createIndex('revision', 'revision', { unique: false });
                            log.info('[LocalCacheService] Object store created during upgrade');
                        }
                        
                        // 미완성 세션 저장소 생성
                        if (!db.objectStoreNames.contains(this.sessionStoreName)) {
                            const sessionStore = db.createObjectStore(this.sessionStoreName, { keyPath: 'territoryId' });
                            sessionStore.createIndex('lastModified', 'lastModified', { unique: false });
                            log.info('[LocalCacheService] Session store created during upgrade');
                        }
                    };
                    
                    // ⚠️ 개선: 멀티 탭 이슈 처리 - blocked
                    upgradeRequest.onblocked = () => {
                        log.warn('[LocalCacheService] Upgrade blocked by another tab');
                        this._blockedRetryCount++;
                        if (this._blockedRetryCount >= 3) {
                            this._cacheDisabled = true;
                            reject(new Error('IndexedDB upgrade blocked persistently'));
                        }
                    };
                    
                    upgradeRequest.onsuccess = () => {
                        this.db = upgradeRequest.result;
                        this.dbVersion = this.LATEST_SCHEMA_VERSION; // ⚠️ 개선: 최신 버전 고정
                        
                        // ⚠️ 전문가 조언: versionchange 이벤트 핸들러 추가 (AbortError 처리)
                        this.db.onversionchange = () => {
                            log.info('[LocalCacheService] Version change detected, closing DB connection');
                            
                            // ⚠️ 전문가 조언: 열려있는 트랜잭션이 abort될 수 있으므로 에러 카운트로 처리
                            // ⚠️ 최종 피드백: AbortError가 업그레이드 시점인지 평상시인지 분리 모니터링
                            try {
                                if (this.db && this.db.objectStoreNames) {
                                    this.db.close();
                                }
                            } catch (error) {
                                if (error.name === 'AbortError') {
                                    // ⚠️ 최종 피드백: 업그레이드 시점의 AbortError는 정상이므로 별도 카운트
                                    this._recordError({ name: 'VersionChangeAbortError', message: 'Transaction aborted during version change (normal)' });
                                    log.debug('[LocalCacheService] Transaction aborted due to version change (normal - upgrade in progress)');
                                } else {
                                    log.warn('[LocalCacheService] Error during version change:', error);
                                    this._recordError(error);
                                }
                            }
                            
                            this.db = null;
                            this.initialized = false;
                            this._initPromise = null;
                            this._isInitializing = false; // 플래그도 리셋
                        };
                        
                        // 최종 확인
                        if (!this.db.objectStoreNames.contains(this.storeName)) {
                            // ⚠️ 개선: upgrade 실패 시에만 삭제 시도 (최후의 수단)
                            log.warn('[LocalCacheService] Upgrade failed to create object store, attempting deletion as last resort...');
                            this._deleteAttempted = true;
                            this._attemptDeleteAndRecreate(resolve, reject);
                            return;
                        }
                        
                        log.info('[LocalCacheService] IndexedDB upgraded to latest version and initialized successfully');
                        this._blockedRetryCount = 0; // 성공 시 리셋
                        resolve();
                    };
                    
                    upgradeRequest.onerror = () => {
                        const error = upgradeRequest.error;
                        this._recordError(error);
                        log.error('[LocalCacheService] Failed to upgrade IndexedDB:', error);
                        // upgrade 실패 시 삭제 시도
                        this._deleteAttempted = true;
                        this._attemptDeleteAndRecreate(resolve, reject);
                    };
                    
                    return;
                }
                
                log.info('[LocalCacheService] IndexedDB initialized');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;
                log.info(`[LocalCacheService] Upgrade needed: ${oldVersion} → ${this.LATEST_SCHEMA_VERSION}, creating object stores...`);
                
                // ⚠️ 개선: 버전 스킵 업그레이드 지원 (v1/v2에서 최신 버전으로 한 번에)
                // 픽셀 캔버스 데이터 저장소 생성
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'territoryId' });
                    store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
                    // ⚠️ 개선: 메타데이터 인덱스 추가
                    store.createIndex('revision', 'revision', { unique: false });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    log.info('[LocalCacheService] Object store created');
                }
                
                // 미완성 세션 저장소 생성
                if (!db.objectStoreNames.contains(this.sessionStoreName)) {
                    const sessionStore = db.createObjectStore(this.sessionStoreName, { keyPath: 'territoryId' });
                    sessionStore.createIndex('lastModified', 'lastModified', { unique: false });
                    log.info('[LocalCacheService] Session store created');
                }
            };
        });
    }
    
    /**
     * ⚠️ 개선: 에러 타입별 카운트 기록
     */
    _recordError(error) {
        if (!error) return;
        
        const errorType = error.name || error.constructor?.name || 'UnknownError';
        const currentCount = this._errorCountsByType.get(errorType) || 0;
        this._errorCountsByType.set(errorType, currentCount + 1);
        this._errorCount++;
        
        // 샘플링 로그 (1회/10회마다)
        if (this._errorCount === 1 || this._errorCount % 10 === 0) {
            log.warn(`[LocalCacheService] Error recorded (total: ${this._errorCount}):`, {
                errorType,
                errorCount: this._errorCount,
                errorCountsByType: Object.fromEntries(this._errorCountsByType)
            });
        }
    }
    
    /**
     * ⚠️ 최후의 수단: DB 삭제 후 재생성
     * 여러 탭 문제 대비: onversionchange 처리
     */
    _attemptDeleteAndRecreate(resolve, reject) {
        if (this.db) {
            this.db.close();
        }
        this.db = null;
        
        // ⚠️ 개선: 여러 탭 문제 대비
        const deleteRequest = indexedDB.deleteDatabase(this.dbName);
        
        deleteRequest.onsuccess = () => {
            log.warn('[LocalCacheService] Database deleted, recreating as last resort...');
            
            // ⚠️ 개선: 최신 버전으로 재생성
            const recreateRequest = indexedDB.open(this.dbName, this.LATEST_SCHEMA_VERSION);
            
            recreateRequest.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'territoryId' });
                    store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
                    store.createIndex('revision', 'revision', { unique: false });
                }
                
                if (!db.objectStoreNames.contains(this.sessionStoreName)) {
                    const sessionStore = db.createObjectStore(this.sessionStoreName, { keyPath: 'territoryId' });
                    sessionStore.createIndex('lastModified', 'lastModified', { unique: false });
                }
            };
            
            recreateRequest.onsuccess = () => {
                this.db = recreateRequest.result;
                
                if (!this.db.objectStoreNames.contains(this.storeName)) {
                    log.error('[LocalCacheService] Object store still not found after recreation');
                    reject(new Error('Object store creation failed after deletion'));
                    return;
                }
                
                log.warn('[LocalCacheService] IndexedDB recreated after deletion (data lost)');
                resolve();
            };
            
            recreateRequest.onerror = () => {
                log.error('[LocalCacheService] Failed to recreate IndexedDB:', recreateRequest.error);
                reject(recreateRequest.error);
            };
        };
        
        deleteRequest.onerror = () => {
            log.error('[LocalCacheService] Failed to delete database:', deleteRequest.error);
            reject(deleteRequest.error);
        };
    }
    
    /**
     * 픽셀 데이터 캐시에 저장
     * @param {string} territoryId - 영토 ID
     * @param {Object} pixelData - 픽셀 데이터
     */
    async saveToCache(territoryId, pixelData) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            log.warn('[LocalCacheService] DB not available, skipping cache save');
            return;
        }
        
        // ⚠️ 핵심 수정: object store가 존재하는지 확인
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            log.warn(`[LocalCacheService] Object store '${this.storeName}' not found, reinitializing...`);
            try {
                this.initialized = false;
                await this.initialize();
                if (!this.db || !this.db.objectStoreNames.contains(this.storeName)) {
                    log.warn(`[LocalCacheService] Object store '${this.storeName}' still not found after reinitialization, skipping save`);
                    return;
                }
            } catch (error) {
                log.error(`[LocalCacheService] Failed to reinitialize after missing object store:`, error);
                return;
            }
        }
        
        return new Promise((resolve, reject) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                
                // ⚠️ 개선: 캐시 메타데이터 추가 (revision/updatedAt 기반 검증용)
                const cacheData = {
                    territoryId,
                    pixelData,
                    lastUpdated: Date.now(),
                    cachedAt: Date.now(),
                    // ⚠️ 개선: 서버 메타데이터 저장 (캐시 일관성 검증용)
                    revision: pixelData.revision || null,
                    updatedAt: pixelData.updatedAt || pixelData.lastUpdated || Date.now(),
                    payloadHash: pixelData.payloadHash || null // 선택적: 데이터 무결성 검증용
                };
                
                const request = store.put(cacheData);
                
                request.onsuccess = () => {
                    log.debug(`[LocalCacheService] Cached pixel data for ${territoryId}`);
                    resolve();
                };
                
                request.onerror = () => {
                    log.warn(`[LocalCacheService] Failed to cache data for ${territoryId}:`, request.error);
                    reject(request.error);
                };
            } catch (error) {
                log.warn(`[LocalCacheService] Transaction error for save ${territoryId}:`, error);
                reject(error);
            }
        });
    }
    
    /**
     * 캐시에서 픽셀 데이터 로드 (메타데이터 포함)
     * ⚠️ 개선: 메타데이터와 함께 반환하여 캐시 일관성 검증 가능
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<{pixelData: Object, metadata: Object}|null>} 캐시된 데이터와 메타데이터 또는 null
     */
    async loadFromCacheWithMetadata(territoryId) {
        return this._loadFromCacheInternal(territoryId, true);
    }
    
    /**
     * 캐시에서 픽셀 데이터 로드 (하위 호환성)
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Object|null>} 캐시된 픽셀 데이터 또는 null
     */
    async loadFromCache(territoryId) {
        const result = await this._loadFromCacheInternal(territoryId, false);
        return result?.pixelData || result || null;
    }
    
    /**
     * 캐시에서 픽셀 데이터 로드 (내부 구현)
     * ⚠️ 핵심: 배포 환경에서 object store가 없을 수 있으므로, 모든 에러를 catch하여 null 반환
     * 에러가 발생해도 절대 throw하지 않고 null을 반환하여 API에서 로드하도록 함
     * @param {string} territoryId - 영토 ID
     * @param {boolean} withMetadata - 메타데이터 포함 여부
     * @returns {Promise<Object|null>} 캐시된 데이터 또는 null
     */
    async _loadFromCacheInternal(territoryId, withMetadata = false) {
        try {
            // ⚠️ 개선: 단일 initialization promise 사용 (폴링 제거)
            if (!this.initialized && !this._initPromise) {
                await this.initialize().catch(err => {
                    log.warn(`[LocalCacheService] Initialize failed in loadFromCache for ${territoryId}:`, err);
                    return null; // 초기화 실패해도 계속 진행
                });
            } else if (this._initPromise) {
                // 초기화 중이면 같은 promise를 await (race condition 방지)
                await this._initPromise.catch(() => {
                    // 초기화 실패해도 계속 진행
                });
            }
            
            // 초기화 후에도 DB가 없으면 null 반환
            if (!this.db) {
                log.debug(`[LocalCacheService] DB not available for ${territoryId}`);
                return null;
            }
            
            // ⚠️ 핵심 수정: object store가 존재하는지 확인 (에러 발생 가능)
            let hasStore = false;
            try {
                hasStore = this.db.objectStoreNames.contains(this.storeName);
            } catch (checkError) {
                // objectStoreNames 확인 중 에러 발생 시 null 반환
                log.warn(`[LocalCacheService] Failed to check object store for ${territoryId}:`, checkError);
                return null;
            }
            
            if (!hasStore) {
                log.warn(`[LocalCacheService] Object store '${this.storeName}' not found for ${territoryId}, reinitializing...`);
                // object store가 없으면 초기화를 다시 시도
                try {
                    this.initialized = false;
                    await this.initialize();
                    
                    // 재초기화 후에도 없으면 null 반환 (에러 throw 안 함)
                    try {
                        if (!this.db || !this.db.objectStoreNames.contains(this.storeName)) {
                            log.warn(`[LocalCacheService] Object store '${this.storeName}' still not found after reinitialization for ${territoryId}`);
                            return null;
                        }
                    } catch (recheckError) {
                        log.warn(`[LocalCacheService] Failed to recheck object store for ${territoryId}:`, recheckError);
                        return null;
                    }
                } catch (reinitError) {
                    log.warn(`[LocalCacheService] Failed to reinitialize for ${territoryId}:`, reinitError);
                    return null;
                }
            }
            
            // ⚠️ 핵심: transaction 실행 전에 한 번 더 확인하고, 모든 에러를 catch
            return new Promise((resolve) => {
                try {
                    // transaction 실행 전 최종 확인
                    if (!this.db) {
                        log.debug(`[LocalCacheService] DB not available for transaction ${territoryId}`);
                        resolve(null);
                        return;
                    }
                    
                    let finalCheck = false;
                    try {
                        finalCheck = this.db.objectStoreNames.contains(this.storeName);
                    } catch (finalCheckError) {
                        log.warn(`[LocalCacheService] Final check failed for ${territoryId}:`, finalCheckError);
                        resolve(null);
                        return;
                    }
                    
                    if (!finalCheck) {
                        log.debug(`[LocalCacheService] Object store not available for transaction ${territoryId}`);
                        resolve(null);
                        return;
                    }
                    
                    const transaction = this.db.transaction([this.storeName], 'readonly');
                    const store = transaction.objectStore(this.storeName);
                    const request = store.get(territoryId);
                    
                    request.onsuccess = () => {
                        const result = request.result;
                        if (result && result.pixelData) {
                            log.debug(`[LocalCacheService] Loaded cached data for ${territoryId}`);
                            // ⚠️ 개선: 메타데이터와 함께 반환 (캐시 일관성 검증용)
                            if (withMetadata) {
                                resolve({
                                    pixelData: result.pixelData,
                                    metadata: {
                                        lastUpdated: result.lastUpdated,
                                        cachedAt: result.cachedAt,
                                        revision: result.revision,
                                        updatedAt: result.updatedAt,
                                        payloadHash: result.payloadHash
                                    }
                                });
                            } else {
                                resolve(result.pixelData);
                            }
                        } else {
                            resolve(null);
                        }
                    };
                    
                    request.onerror = () => {
                        // ⚠️ 핵심: 에러 발생 시 null 반환 (에러 throw 안 함)
                        log.warn(`[LocalCacheService] Request error for ${territoryId}:`, request.error);
                        resolve(null);
                    };
                    
                    transaction.onerror = () => {
                        // ⚠️ 핵심: transaction 에러도 null 반환
                        log.warn(`[LocalCacheService] Transaction error for ${territoryId}:`, transaction.error);
                        resolve(null);
                    };
                } catch (error) {
                    // ⚠️ 핵심: 모든 에러를 catch하여 null 반환 (에러 throw 안 함)
                    log.warn(`[LocalCacheService] Exception in loadFromCache for ${territoryId}:`, error);
                    resolve(null);
                }
            });
            } catch (error) {
                // ⚠️ 개선: 에러 모니터링 (샘플링 로그 - 1회/세션당 1번)
                this._errorCount++;
                if (this._errorCount === 1 || this._errorCount % 10 === 0) {
                    log.warn(`[LocalCacheService] Top-level error in loadFromCache (count: ${this._errorCount}):`, error);
                    // ⚠️ 개선: 운영 모니터링용 (Sentry 등에 breadcrumb 추가 가능)
                    if (typeof window !== 'undefined' && window.Sentry) {
                        window.Sentry.addBreadcrumb({
                            category: 'indexeddb',
                            message: `loadFromCache error (${this._errorCount}th)`,
                            level: 'warning',
                            data: { territoryId, errorCount: this._errorCount }
                        });
                    }
                }
                return null;
            }
        }
    
    /**
     * 캐시에 데이터가 있는지 확인
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<boolean>} 캐시 존재 여부
     */
    async hasCache(territoryId) {
        const cached = await this.loadFromCache(territoryId);
        return cached !== null;
    }
    
    /**
     * 캐시된 데이터의 마지막 업데이트 시간 가져오기
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<number|null>} 마지막 업데이트 timestamp 또는 null
     */
    async getLastUpdated(territoryId) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return null;
        }
        
        // ⚠️ 핵심 수정: object store가 존재하는지 확인
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            return null;
        }
        
        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(territoryId);
                
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && result.lastUpdated) {
                        resolve(result.lastUpdated);
                    } else {
                        resolve(null);
                    }
                };
                
                request.onerror = () => {
                    resolve(null);
                };
            } catch (error) {
                resolve(null);
            }
        });
    }
    
    /**
     * 특정 영토의 캐시 삭제 (선택적 - 필요시에만 사용)
     * @param {string} territoryId - 영토 ID
     */
    async clearCache(territoryId) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return;
        }
        
        // ⚠️ 핵심 수정: object store가 존재하는지 확인
        if (!this.db.objectStoreNames.contains(this.storeName)) {
            log.debug(`[LocalCacheService] Object store '${this.storeName}' not found, nothing to clear`);
            return;
        }
        
        return new Promise((resolve, reject) => {
            try {
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.delete(territoryId);
                
                request.onsuccess = () => {
                    log.debug(`[LocalCacheService] Cleared cache for ${territoryId}`);
                    resolve();
                };
                
                request.onerror = () => {
                    log.warn(`[LocalCacheService] Failed to clear cache for ${territoryId}:`, request.error);
                    reject(request.error);
                };
            } catch (error) {
                log.warn(`[LocalCacheService] Transaction error for clearCache ${territoryId}:`, error);
                reject(error);
            }
        });
    }
    
    /**
     * 모든 캐시 삭제 (선택적 - 필요시에만 사용)
     */
    async clearAllCache() {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            
            request.onsuccess = () => {
                log.info('[LocalCacheService] Cleared all cache');
                resolve();
            };
            
            request.onerror = () => {
                log.warn('[LocalCacheService] Failed to clear all cache:', request.error);
                reject(request.error);
            };
        });
    }
    
    /**
     * 미완성 세션 저장 (편집 중인 상태)
     * @param {string} territoryId - 영토 ID
     * @param {Object} sessionData - 세션 데이터 (pixels, metadata 등)
     */
    async saveSession(territoryId, sessionData) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            log.warn('[LocalCacheService] DB not available, skipping session save');
            return;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.sessionStoreName], 'readwrite');
            const store = transaction.objectStore(this.sessionStoreName);
            
            const session = {
                territoryId,
                ...sessionData,
                lastModified: Date.now(),
                savedAt: Date.now()
            };
            
            const request = store.put(session);
            
            request.onsuccess = () => {
                log.debug(`[LocalCacheService] Saved session for ${territoryId}`);
                resolve();
            };
            
            request.onerror = () => {
                log.warn(`[LocalCacheService] Failed to save session for ${territoryId}:`, request.error);
                reject(request.error);
            };
        });
    }
    
    /**
     * 미완성 세션 로드
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Object|null>} 세션 데이터 또는 null
     */
    async loadSession(territoryId) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return null;
        }
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.sessionStoreName], 'readonly');
            const store = transaction.objectStore(this.sessionStoreName);
            const request = store.get(territoryId);
            
            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    log.debug(`[LocalCacheService] Loaded session for ${territoryId}`);
                    resolve(result);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => {
                log.warn(`[LocalCacheService] Failed to load session for ${territoryId}:`, request.error);
                resolve(null);
            };
        });
    }
    
    /**
     * 미완성 세션 삭제 (복원 완료 후)
     * @param {string} territoryId - 영토 ID
     */
    async clearSession(territoryId) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return;
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.sessionStoreName], 'readwrite');
            const store = transaction.objectStore(this.sessionStoreName);
            const request = store.delete(territoryId);
            
            request.onsuccess = () => {
                log.debug(`[LocalCacheService] Cleared session for ${territoryId}`);
                resolve();
            };
            
            request.onerror = () => {
                log.warn(`[LocalCacheService] Failed to clear session for ${territoryId}:`, request.error);
                reject(request.error);
            };
        });
    }
    
    /**
     * 세션 존재 여부 확인
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<boolean>} 세션 존재 여부
     */
    async hasSession(territoryId) {
        const session = await this.loadSession(territoryId);
        return session !== null;
    }
    
    /**
     * ⚠️ 전문가 조언: 캐시 OFF 모드를 세션 스토리지에 저장
     */
    _setCacheDisabled(disabled) {
        this._cacheDisabled = disabled;
        try {
            if (typeof sessionStorage !== 'undefined') {
                if (disabled) {
                    sessionStorage.setItem('pixelCanvasCache_disabled', 'true');
                    sessionStorage.setItem('pixelCanvasCache_disabled_at', Date.now().toString());
                } else {
                    sessionStorage.removeItem('pixelCanvasCache_disabled');
                    sessionStorage.removeItem('pixelCanvasCache_disabled_at');
                }
            }
        } catch (error) {
            log.warn('[LocalCacheService] Failed to save cache disabled state:', error);
        }
    }
    
    /**
     * ⚠️ 전문가 조언: 세션 스토리지에서 캐시 OFF 모드 복원
     */
    _loadCacheDisabledState() {
        try {
            if (typeof sessionStorage !== 'undefined') {
                const disabled = sessionStorage.getItem('pixelCanvasCache_disabled');
                if (disabled === 'true') {
                    const disabledAt = parseInt(sessionStorage.getItem('pixelCanvasCache_disabled_at') || '0', 10);
                    const now = Date.now();
                    const oneDay = 24 * 60 * 60 * 1000;
                    
                    // ⚠️ 전문가 조언: 하루 TTL로 저장 (특정 환경에서 지속 실패 시 API-only로 고정)
                    if (now - disabledAt < oneDay) {
                        this._cacheDisabled = true;
                        log.info('[LocalCacheService] Cache disabled state restored from session storage');
                    } else {
                        // 하루가 지났으면 다시 시도
                        sessionStorage.removeItem('pixelCanvasCache_disabled');
                        sessionStorage.removeItem('pixelCanvasCache_disabled_at');
                        log.info('[LocalCacheService] Cache disabled state expired, will retry');
                    }
                }
            }
        } catch (error) {
            log.warn('[LocalCacheService] Failed to load cache disabled state:', error);
        }
    }
    
    /**
     * IndexedDB 상태 검증 및 복구
     * ⚠️ 개선: 필요시에만 실행 (저비용 검증)
     * 배포 전 테스트 및 자동 복구용
     * @param {boolean} deep - true면 deep fix 수행 (기본값: false)
     * @returns {Promise<{valid: boolean, fixed: boolean, details: Object}>}
     */
    async validateAndFix(deep = false) {
        const result = {
            valid: false,
            fixed: false,
            details: {
                dbExists: false,
                dbOpen: false,
                storeExists: false,
                sessionStoreExists: false,
                errors: []
            }
        };
        
        try {
            // 1. DB가 열려있는지 확인
            if (this.db) {
                result.details.dbOpen = true;
                result.details.dbExists = true;
                
                // 2. Object store 존재 확인
                try {
                    result.details.storeExists = this.db.objectStoreNames.contains(this.storeName);
                    result.details.sessionStoreExists = this.db.objectStoreNames.contains(this.sessionStoreName);
                } catch (error) {
                    result.details.errors.push(`Failed to check object stores: ${error.message}`);
                }
                
                // 3. 모든 것이 정상이면 valid
                if (result.details.storeExists && result.details.sessionStoreExists) {
                    result.valid = true;
                    return result;
                }
            } else {
                result.details.dbExists = false;
            }
            
            // 4. 문제가 있으면 복구 시도 (deep 모드에서만)
            if (deep) {
                log.warn('[LocalCacheService] IndexedDB validation failed, attempting deep fix...');
                this.initialized = false;
                this.db = null;
                this._initPromise = null; // 재초기화 허용
                
                try {
                    await this.initialize();
                
                // 재검증
                if (this.db) {
                    result.details.dbOpen = true;
                    result.details.dbExists = true;
                    try {
                        result.details.storeExists = this.db.objectStoreNames.contains(this.storeName);
                        result.details.sessionStoreExists = this.db.objectStoreNames.contains(this.sessionStoreName);
                    } catch (error) {
                        result.details.errors.push(`Failed to recheck object stores: ${error.message}`);
                    }
                    
                    if (result.details.storeExists && result.details.sessionStoreExists) {
                        result.valid = true;
                        result.fixed = true;
                        log.info('[LocalCacheService] IndexedDB fixed successfully');
                    } else {
                        result.details.errors.push('Object stores still missing after fix attempt');
                    }
                } else {
                    result.details.errors.push('Failed to open DB during fix attempt');
                }
                } catch (fixError) {
                    result.details.errors.push(`Fix attempt failed: ${fixError.message}`);
                    log.error('[LocalCacheService] Failed to fix IndexedDB:', fixError);
                }
            } else {
                // ⚠️ 개선: deep 모드가 아니면 빠른 검증만 수행
                result.details.errors.push('Validation failed but deep fix not requested');
            }
            
        } catch (error) {
            result.details.errors.push(`Validation error: ${error.message}`);
            log.error('[LocalCacheService] Validation error:', error);
        }
        
        return result;
    }
    
    /**
     * IndexedDB를 의도적으로 손상시켜서 테스트 (개발용)
     * 배포 전 테스트용 - 로컬에서만 사용
     * ⚠️ 핵심: DB를 삭제하고 object store 없이 다시 생성하여 손상 상태 재현
     */
    async simulateCorruption() {
        // 프로덕션 환경 체크 (CONFIG에 ENV가 없으면 항상 허용)
        const isProduction = typeof CONFIG !== 'undefined' && CONFIG.ENV === 'production';
        if (isProduction) {
            log.error('[LocalCacheService] simulateCorruption should not be called in production');
            return;
        }
        
        log.warn('[LocalCacheService] Simulating IndexedDB corruption for testing...');
        
        return new Promise((resolve, reject) => {
            try {
                // 1. 현재 DB 닫기
                if (this.db) {
                    this.db.close();
                }
                this.initialized = false;
                this.db = null;
                
                // 2. DB 삭제
                const deleteRequest = indexedDB.deleteDatabase(this.dbName);
                
                deleteRequest.onsuccess = () => {
                    log.info('[LocalCacheService] Database deleted, recreating without object stores...');
                    
                    // 3. DB를 다시 열기 (버전을 낮춰서 onupgradeneeded가 실행되지 않도록)
                    // 또는 onupgradeneeded에서 object store를 생성하지 않도록
                    const openRequest = indexedDB.open(this.dbName, 1); // 낮은 버전 사용
                    
                    openRequest.onsuccess = () => {
                        this.db = openRequest.result;
                        // ⚠️ 핵심: object store를 확인하지 않고 초기화 완료로 표시
                        // 이렇게 하면 loadFromCache에서 에러가 발생할 것
                        this.initialized = true;
                        log.warn('[LocalCacheService] Corruption simulated - object stores are missing');
                        resolve();
                    };
                    
                    openRequest.onerror = () => {
                        log.error('[LocalCacheService] Failed to open DB after deletion:', openRequest.error);
                        reject(openRequest.error);
                    };
                    
                    // onupgradeneeded가 실행되어도 object store를 생성하지 않음
                    openRequest.onupgradeneeded = () => {
                        log.warn('[LocalCacheService] Upgrade needed but NOT creating object stores (simulating corruption)');
                        // 의도적으로 object store를 생성하지 않음
                    };
                };
                
                deleteRequest.onerror = () => {
                    log.error('[LocalCacheService] Failed to delete database:', deleteRequest.error);
                    reject(deleteRequest.error);
                };
            } catch (error) {
                log.error('[LocalCacheService] Error simulating corruption:', error);
                reject(error);
            }
        });
    }
}

// 싱글톤 인스턴스
export const localCacheService = new LocalCacheService();
export default localCacheService;

// ⚠️ 개선: 배포 전 테스트용 - 개발 환경에서만 노출
if (typeof window !== 'undefined') {
    // ⚠️ 개선: 운영 빌드에서 제거 (보안/오남용 방지)
    const isProduction = typeof CONFIG !== 'undefined' && CONFIG.ENV === 'production';
    const isDev = !isProduction || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (isDev) {
        window.testIndexedDB = {
            validate: (deep = false) => localCacheService.validateAndFix(deep),
            simulateCorruption: () => localCacheService.simulateCorruption(),
            clearAll: () => localCacheService.clearAllCache(),
            getStatus: () => ({
                initialized: localCacheService.initialized,
                hasDB: !!localCacheService.db,
                storeExists: localCacheService.db?.objectStoreNames.contains(localCacheService.storeName) || false,
                sessionStoreExists: localCacheService.db?.objectStoreNames.contains(localCacheService.sessionStoreName) || false,
                errorCount: localCacheService._errorCount,
                errorCountsByType: Object.fromEntries(localCacheService._errorCountsByType),
                cacheDisabled: localCacheService._cacheDisabled,
                initFailureCount: localCacheService._initFailureCount,
                blockedRetryCount: localCacheService._blockedRetryCount
            })
        };
        
        // ⚠️ 테스트용: localCacheService도 전역에서 접근 가능하도록
        window.localCacheService = localCacheService;
        
        console.log('🧪 [LocalCacheService] Test utilities available:');
        console.log('   - window.testIndexedDB (test functions)');
        console.log('   - window.localCacheService (direct access)');
    }
}