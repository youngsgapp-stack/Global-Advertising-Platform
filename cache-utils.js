/**
 * IndexedDB 기반 캐싱 유틸리티
 * Firestore 읽기 작업 최적화를 위한 클라이언트 측 캐싱
 */

class FirestoreCache {
    constructor(dbName = 'worldad-cache', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
        this.initPromise = null;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                console.warn('[CACHE] IndexedDB를 지원하지 않습니다. 캐싱이 비활성화됩니다.');
                resolve(false);
                return;
            }

            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => {
                console.error('[CACHE] IndexedDB 초기화 실패:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('[CACHE] IndexedDB 초기화 완료');
                resolve(true);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 캐시 데이터 저장소
                if (!db.objectStoreNames.contains('cache')) {
                    const cacheStore = db.createObjectStore('cache', { keyPath: 'key' });
                    cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // 메타데이터 저장소 (마지막 업데이트 시간 등)
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }
            };
        });

        return this.initPromise;
    }

    async get(key, ttl = 5 * 60 * 1000) {
        await this.init();
        if (!this.db) return null;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['cache'], 'readonly');
            const store = transaction.objectStore('cache');
            const request = store.get(key);

            request.onsuccess = () => {
                const result = request.result;
                if (!result) {
                    resolve(null);
                    return;
                }

                const age = Date.now() - result.timestamp;
                if (age > ttl) {
                    // 캐시 만료 - 삭제
                    this.delete(key).catch(console.error);
                    resolve(null);
                    return;
                }

                resolve(result.data);
            };

            request.onerror = () => {
                console.error('[CACHE] 캐시 읽기 실패:', request.error);
                resolve(null); // 에러 시 null 반환 (캐시 없음으로 처리)
            };
        });
    }

    async set(key, data) {
        await this.init();
        if (!this.db) return false;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['cache'], 'readwrite');
            const store = transaction.objectStore('cache');
            const request = store.put({
                key,
                data,
                timestamp: Date.now()
            });

            request.onsuccess = () => {
                resolve(true);
            };

            request.onerror = () => {
                console.error('[CACHE] 캐시 저장 실패:', request.error);
                resolve(false); // 에러 시에도 false만 반환
            };
        });
    }

    async delete(key) {
        await this.init();
        if (!this.db) return false;

        return new Promise((resolve) => {
            const transaction = this.db.transaction(['cache'], 'readwrite');
            const store = transaction.objectStore('cache');
            const request = store.delete(key);

            request.onsuccess = () => {
                resolve(true);
            };

            request.onerror = () => {
                console.error('[CACHE] 캐시 삭제 실패:', request.error);
                resolve(false);
            };
        });
    }

    async clear() {
        await this.init();
        if (!this.db) return false;

        return new Promise((resolve) => {
            const transaction = this.db.transaction(['cache'], 'readwrite');
            const store = transaction.objectStore('cache');
            const request = store.clear();

            request.onsuccess = () => {
                console.log('[CACHE] 모든 캐시 삭제 완료');
                resolve(true);
            };

            request.onerror = () => {
                console.error('[CACHE] 캐시 전체 삭제 실패:', request.error);
                resolve(false);
            };
        });
    }

    async setLastUpdateTime(collectionName, timestamp) {
        await this.init();
        if (!this.db) return false;

        return new Promise((resolve) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            const request = store.put({
                key: `lastUpdate_${collectionName}`,
                timestamp
            });

            request.onsuccess = () => resolve(true);
            request.onerror = () => {
                console.error('[CACHE] 메타데이터 저장 실패:', request.error);
                resolve(false);
            };
        });
    }

    async getLastUpdateTime(collectionName) {
        await this.init();
        if (!this.db) return null;

        return new Promise((resolve) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.get(`lastUpdate_${collectionName}`);

            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.timestamp : null);
            };

            request.onerror = () => {
                console.error('[CACHE] 메타데이터 읽기 실패:', request.error);
                resolve(null);
            };
        });
    }

    // 오래된 캐시 정리 (TTL 초과)
    async cleanup(maxAge = 24 * 60 * 60 * 1000) {
        await this.init();
        if (!this.db) return 0;

        return new Promise((resolve) => {
            const transaction = this.db.transaction(['cache'], 'readwrite');
            const store = transaction.objectStore('cache');
            const index = store.index('timestamp');
            const now = Date.now();
            let deletedCount = 0;

            const request = index.openCursor();
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) {
                    if (deletedCount > 0) {
                        console.log(`[CACHE] ${deletedCount}개의 만료된 캐시 항목 삭제`);
                    }
                    resolve(deletedCount);
                    return;
                }

                const age = now - cursor.value.timestamp;
                if (age > maxAge) {
                    cursor.delete();
                    deletedCount++;
                }
                cursor.continue();
            };

            request.onerror = () => {
                console.error('[CACHE] 캐시 정리 실패:', request.error);
                resolve(deletedCount);
            };
        });
    }
}

// 싱글톤 인스턴스
const firestoreCache = new FirestoreCache();

// 초기화 및 주기적 정리
if (typeof window !== 'undefined') {
    firestoreCache.init().then(() => {
        // 1시간마다 오래된 캐시 정리
        setInterval(() => {
            firestoreCache.cleanup().catch(console.error);
        }, 60 * 60 * 1000);
    }).catch(console.error);
}

// 전역에서 사용 가능하도록 export
if (typeof window !== 'undefined') {
    window.firestoreCache = firestoreCache;
}

// ES 모듈 지원
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FirestoreCache, firestoreCache };
}

