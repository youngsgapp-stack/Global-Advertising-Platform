/**
 * PixelDataService - 픽셀 데이터 저장/로드 전담 서비스
 * 설계서 V2에 따른 새로운 데이터 관리 시스템
 * 
 * 책임:
 * - Firebase 저장/로드
 * - 데이터 캐싱
 * - 배치 업데이트
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class PixelDataService {
    constructor() {
        this.cache = new Map(); // territoryId -> cached data
        this.pendingSaves = new Map(); // territoryId -> save data
        this.saveTimeouts = new Map(); // territoryId -> timeout
        this.SAVE_DEBOUNCE_MS = 500; // 자동 저장 debounce 시간
    }
    
    /**
     * 픽셀 데이터 로드
     */
    async loadPixelData(territoryId) {
        // 캐시 확인
        if (this.cache.has(territoryId)) {
            const cached = this.cache.get(territoryId);
            // 캐시가 1분 이내면 사용
            if (Date.now() - cached.timestamp < 60000) {
                log.debug(`[PixelDataService] Using cached data for ${territoryId}`);
                return cached.data;
            }
        }
        
        try {
            // Firebase에서 로드
            const data = await firebaseService.getDocument('pixelCanvases', territoryId);
            
            if (data) {
                // 캐시에 저장
                this.cache.set(territoryId, {
                    data,
                    timestamp: Date.now()
                });
                
                log.info(`[PixelDataService] Loaded pixel data for ${territoryId} (${data.filledPixels || 0} pixels)`);
                return data;
            }
            
            // 데이터가 없으면 빈 데이터 반환 (정상적인 경우)
            return {
                territoryId,
                pixels: [],
                filledPixels: 0,
                lastUpdated: null
            };
            
        } catch (error) {
            // 모든 에러를 조용히 처리 - 존재하지 않는 문서는 정상적인 경우이므로 에러 로그 제거
            // 오프라인 에러나 존재하지 않는 문서는 빈 데이터 반환 (에러 로그 출력하지 않음)
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
     * 픽셀 데이터 저장 (debounced)
     */
    async savePixelData(territoryId, pixelData) {
        // pending 저장에 추가
        this.pendingSaves.set(territoryId, pixelData);
        
        // 기존 timeout 취소
        if (this.saveTimeouts.has(territoryId)) {
            clearTimeout(this.saveTimeouts.get(territoryId));
        }
        
        // 새로운 timeout 설정
        const timeout = setTimeout(async () => {
            await this._executeSave(territoryId);
        }, this.SAVE_DEBOUNCE_MS);
        
        this.saveTimeouts.set(territoryId, timeout);
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
     */
    async _executeSave(territoryId) {
        const pixelData = this.pendingSaves.get(territoryId);
        if (!pixelData) {
            log.warn(`[PixelDataService] No pending save data for ${territoryId}`);
            return;
        }
        
        try {
            // Firebase에 저장
            await firebaseService.setDocument('pixelCanvases', territoryId, {
                ...pixelData,
                lastUpdated: Date.now()
            });
            
            // 캐시 업데이트
            this.cache.set(territoryId, {
                data: pixelData,
                timestamp: Date.now()
            });
            
            // pending 저장 제거
            this.pendingSaves.delete(territoryId);
            this.saveTimeouts.delete(territoryId);
            
            log.info(`[PixelDataService] Saved pixel data for ${territoryId} (${pixelData.filledPixels || 0} pixels)`);
            
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
     * 캐시 클리어
     */
    clearCache(territoryId = null) {
        if (territoryId) {
            this.cache.delete(territoryId);
        } else {
            this.cache.clear();
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

