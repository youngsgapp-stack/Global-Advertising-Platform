/**
 * CacheService - 캐싱 전략 관리 서비스
 * CDN, 브라우저 캐시, 이미지 렌더링 캐싱
 */

import { CONFIG, log } from '../config.js';
import { serviceModeManager } from './ServiceModeManager.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class CacheService {
    constructor() {
        this.imageCache = new Map(); // territoryId -> { imageData, timestamp, url }
        this.rankingCache = new Map(); // rankingType -> { data, timestamp }
        this.staticDataCache = new Map(); // key -> { data, timestamp }
        this.cacheExpiry = {
            image: 3600000,      // 1시간
            ranking: 300000,     // 5분
            static: 86400000     // 24시간
        };
    }
    
    /**
     * 초기화
     */
    async initialize() {
        // 서비스 모드 변경 시 캐시 정리
        eventBus.on(EVENTS.SERVICE_MODE_CHANGED, () => {
            this.clearExpiredCache();
        });
        
        // 주기적으로 만료된 캐시 정리 (10분마다)
        setInterval(() => {
            this.clearExpiredCache();
        }, 600000);
        
        log.info('[CacheService] Initialized');
    }
    
    /**
     * 이미지 캐시 저장
     * @param {string} territoryId - 영토 ID
     * @param {string} imageData - 이미지 데이터 (Data URL 또는 Blob URL)
     * @param {string} url - CDN URL (선택)
     */
    cacheImage(territoryId, imageData, url = null) {
        this.imageCache.set(territoryId, {
            imageData,
            url,
            timestamp: Date.now()
        });
        
        log.debug(`[CacheService] Cached image for territory ${territoryId}`);
    }
    
    /**
     * 이미지 캐시 가져오기
     * @param {string} territoryId - 영토 ID
     * @returns {Object|null} 캐시된 이미지 데이터
     */
    getCachedImage(territoryId) {
        const cached = this.imageCache.get(territoryId);
        if (!cached) return null;
        
        // 만료 확인
        const age = Date.now() - cached.timestamp;
        if (age > this.cacheExpiry.image) {
            this.imageCache.delete(territoryId);
            return null;
        }
        
        return cached;
    }
    
    /**
     * 랭킹 데이터 캐시 저장
     * @param {string} rankingType - 랭킹 타입
     * @param {Array} data - 랭킹 데이터
     */
    cacheRanking(rankingType, data) {
        this.rankingCache.set(rankingType, {
            data,
            timestamp: Date.now()
        });
        
        log.debug(`[CacheService] Cached ranking data for ${rankingType}`);
    }
    
    /**
     * 랭킹 데이터 캐시 가져오기
     * @param {string} rankingType - 랭킹 타입
     * @returns {Array|null} 캐시된 랭킹 데이터
     */
    getCachedRanking(rankingType) {
        const cached = this.rankingCache.get(rankingType);
        if (!cached) return null;
        
        // 만료 확인
        const age = Date.now() - cached.timestamp;
        const modeConfig = serviceModeManager.getConfig();
        const expiry = modeConfig.rankingUpdateInterval || this.cacheExpiry.ranking;
        
        if (age > expiry) {
            this.rankingCache.delete(rankingType);
            return null;
        }
        
        return cached.data;
    }
    
    /**
     * 정적 데이터 캐시 저장
     * @param {string} key - 캐시 키
     * @param {*} data - 데이터
     */
    cacheStaticData(key, data) {
        this.staticDataCache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
    
    /**
     * 정적 데이터 캐시 가져오기
     * @param {string} key - 캐시 키
     * @returns {*|null} 캐시된 데이터
     */
    getCachedStaticData(key) {
        const cached = this.staticDataCache.get(key);
        if (!cached) return null;
        
        // 만료 확인
        const age = Date.now() - cached.timestamp;
        if (age > this.cacheExpiry.static) {
            this.staticDataCache.delete(key);
            return null;
        }
        
        return cached.data;
    }
    
    /**
     * 만료된 캐시 정리
     */
    clearExpiredCache() {
        const now = Date.now();
        let cleared = 0;
        
        // 이미지 캐시 정리
        for (const [key, value] of this.imageCache.entries()) {
            if (now - value.timestamp > this.cacheExpiry.image) {
                this.imageCache.delete(key);
                cleared++;
            }
        }
        
        // 랭킹 캐시 정리
        for (const [key, value] of this.rankingCache.entries()) {
            const modeConfig = serviceModeManager.getConfig();
            const expiry = modeConfig.rankingUpdateInterval || this.cacheExpiry.ranking;
            if (now - value.timestamp > expiry) {
                this.rankingCache.delete(key);
                cleared++;
            }
        }
        
        // 정적 데이터 캐시 정리
        for (const [key, value] of this.staticDataCache.entries()) {
            if (now - value.timestamp > this.cacheExpiry.static) {
                this.staticDataCache.delete(key);
                cleared++;
            }
        }
        
        if (cleared > 0) {
            log.debug(`[CacheService] Cleared ${cleared} expired cache entries`);
        }
    }
    
    /**
     * 특정 캐시 삭제
     * @param {string} type - 캐시 타입 ('image', 'ranking', 'static')
     * @param {string} key - 캐시 키 (선택)
     */
    clearCache(type, key = null) {
        if (type === 'image') {
            if (key) {
                this.imageCache.delete(key);
            } else {
                this.imageCache.clear();
            }
        } else if (type === 'ranking') {
            if (key) {
                this.rankingCache.delete(key);
            } else {
                this.rankingCache.clear();
            }
        } else if (type === 'static') {
            if (key) {
                this.staticDataCache.delete(key);
            } else {
                this.staticDataCache.clear();
            }
        } else if (type === 'all') {
            this.imageCache.clear();
            this.rankingCache.clear();
            this.staticDataCache.clear();
        }
        
        log.info(`[CacheService] Cleared cache: ${type}${key ? ` (${key})` : ''}`);
    }
    
    /**
     * 캐시 통계 가져오기
     */
    getCacheStats() {
        return {
            images: this.imageCache.size,
            rankings: this.rankingCache.size,
            static: this.staticDataCache.size,
            total: this.imageCache.size + this.rankingCache.size + this.staticDataCache.size
        };
    }
}

// 싱글톤 인스턴스
export const cacheService = new CacheService();
export default cacheService;

