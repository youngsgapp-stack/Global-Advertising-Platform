/**
 * TerritoryViewState - 영토 뷰 상태 단일 모델
 * 모든 영토 상태 계산을 중앙화하여 일관성 보장
 * 
 * 컨설팅 원칙:
 * - hasPixelArt / shouldHideFill을 여기서 계산
 * - Firestore 단일 원천 기반
 */

import { CONFIG, log } from '../config.js';

export class TerritoryViewState {
    /**
     * @param {string} territoryId - 영토 ID
     * @param {Object} territory - 영토 데이터 (TerritoryManager에서)
     * @param {Object} pixelData - 픽셀 데이터 (PixelDataService에서, Firestore 직접 확인)
     */
    constructor(territoryId, territory, pixelData) {
        this.territoryId = territoryId;
        this.territory = territory || {};
        this.pixelData = pixelData || null;
    }
    
    /**
     * 픽셀 아트 존재 여부 (Firestore에서 직접 확인한 결과)
     * 단일 진실의 원천: pixelData.pixels 배열만 확인
     */
    get hasPixelArt() {
        return this.pixelData?.pixels?.length > 0;
    }
    
    /**
     * 배경색 숨김 여부 (hasPixelArt만으로 결정)
     * 단순화: hasPixelArt = true면 배경색 숨김
     */
    get shouldHideFill() {
        return this.hasPixelArt;
    }
    
    /**
     * 채움 비율 (0 ~ 1)
     */
    get fillRatio() {
        if (!this.hasPixelArt) return 0;
        
        const totalPixels = CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        const filledPixels = this.pixelData.filledPixels || this.pixelData.pixels.length;
        return Math.min(1, filledPixels / totalPixels);
    }
    
    /**
     * 채워진 픽셀 수
     */
    get filledPixels() {
        if (!this.hasPixelArt) return 0;
        return this.pixelData.filledPixels || this.pixelData.pixels.length;
    }
    
    /**
     * 주권 상태
     */
    get sovereignty() {
        return this.territory?.sovereignty || 'unconquered';
    }
    
    /**
     * Mapbox feature state로 변환
     * MapController의 fill-opacity 조건에서 사용
     */
    toFeatureState() {
        return {
            hasPixelArt: this.hasPixelArt,
            pixelFillRatio: this.fillRatio,
            sovereignty: this.sovereignty,
            filledPixels: this.filledPixels
        };
    }
    
    /**
     * 디버그용 문자열 표현
     */
    toString() {
        return `TerritoryViewState(${this.territoryId}): hasPixelArt=${this.hasPixelArt}, fillRatio=${this.fillRatio.toFixed(2)}, sovereignty=${this.sovereignty}`;
    }
}

export default TerritoryViewState;



