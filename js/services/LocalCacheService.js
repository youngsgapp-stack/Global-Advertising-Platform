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
        this.dbVersion = 2; // 버전 업그레이드 (세션 저장소 추가)
        this.storeName = 'pixelCanvases';
        this.sessionStoreName = 'pixelSessions'; // 미완성 세션 저장소
        this.db = null;
        this.initialized = false;
    }
    
    /**
     * IndexedDB 초기화
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => {
                log.error('[LocalCacheService] Failed to open IndexedDB:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                this.db = request.result;
                this.initialized = true;
                log.info('[LocalCacheService] IndexedDB initialized');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 픽셀 캔버스 데이터 저장소 생성
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'territoryId' });
                    store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
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
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            const cacheData = {
                territoryId,
                pixelData,
                lastUpdated: Date.now(),
                cachedAt: Date.now()
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
        });
    }
    
    /**
     * 캐시에서 픽셀 데이터 로드
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Object|null>} 캐시된 픽셀 데이터 또는 null
     */
    async loadFromCache(territoryId) {
        if (!this.initialized) {
            await this.initialize();
        }
        
        if (!this.db) {
            return null;
        }
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(territoryId);
            
            request.onsuccess = () => {
                const result = request.result;
                if (result && result.pixelData) {
                    log.debug(`[LocalCacheService] Loaded cached data for ${territoryId}`);
                    resolve(result.pixelData);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => {
                log.warn(`[LocalCacheService] Failed to load cache for ${territoryId}:`, request.error);
                resolve(null);
            };
        });
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
        
        return new Promise((resolve) => {
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
        
        return new Promise((resolve, reject) => {
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
}

// 싱글톤 인스턴스
export const localCacheService = new LocalCacheService();
export default localCacheService;

