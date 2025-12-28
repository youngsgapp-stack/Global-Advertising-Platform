/**
 * TerritoryMask - 영토 마스크 관리 클래스
 * 
 * 핵심 설계 원칙:
 * - GeoJSON 폴리곤은 초기 변환용
 * - 셀 inside/outside가 편집과 렌더의 유일 기준
 * - 모든 좌표는 World 좌표계(셀 단위)만 사용
 */

import { CONFIG, log } from '../config.js';

export class TerritoryMask {
    /**
     * @param {Object} geometry - GeoJSON Polygon 또는 MultiPolygon
     * @param {Object} bounds - {minLng, maxLng, minLat, maxLat}
     * @param {number} width - 그리드 너비 (셀 단위)
     * @param {number} height - 그리드 높이 (셀 단위)
     */
    constructor(geometry, bounds, width, height) {
        this.geometry = geometry;
        this.bounds = bounds;
        this.width = width;
        this.height = height;
        
        // 셀 마스크 (Set<"x,y">)
        this.mask = new Set();
        this.generateMask();
    }
    
    /**
     * 셀 마스크 생성 (GeoJSON 폴리곤 → 셀 집합)
     */
    generateMask() {
        if (!this.bounds || !this.geometry) return;
        
        const { minLng, maxLng, minLat, maxLat } = this.bounds;
        const lngRange = maxLng - minLng;
        const latRange = maxLat - minLat;
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                // 셀 중앙점의 정규화 좌표
                const normalizedX = (x + 0.5) / this.width;
                const normalizedY = (y + 0.5) / this.height;
                
                // 셀 중앙점의 경도/위도
                const lng = minLng + normalizedX * lngRange;
                const lat = maxLat - normalizedY * latRange;
                
                if (this.isPointInGeometry([lng, lat], this.geometry)) {
                    this.mask.add(`${x},${y}`);
                }
            }
        }
        
        log.info(`[TerritoryMask] Generated mask with ${this.mask.size} cells`);
    }
    
    /**
     * 점이 geometry 안에 있는지 확인 (Ray casting 알고리즘)
     */
    isPointInGeometry(point, geometry) {
        const [lng, lat] = point;
        let inside = false;
        
        const testPolygon = (coords) => {
            for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
                const [xi, yi] = coords[i];
                const [xj, yj] = coords[j];
                
                if (((yi > lat) !== (yj > lat)) &&
                    (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                }
            }
        };
        
        if (geometry.type === 'Polygon') {
            testPolygon(geometry.coordinates[0]);
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygon => {
                testPolygon(polygon[0]);
            });
        }
        
        return inside;
    }
    
    /**
     * 셀이 영토 안에 있는지 확인
     * @param {number} x - 셀 X 좌표 (월드 좌표계)
     * @param {number} y - 셀 Y 좌표 (월드 좌표계)
     * @returns {boolean}
     */
    isInside(x, y) {
        return this.mask.has(`${x},${y}`);
    }
    
    /**
     * 셀이 영토 안에 있는지 확인 (키 기반)
     * @param {string} key - "x,y" 형식의 키
     * @returns {boolean}
     */
    has(key) {
        return this.mask.has(key);
    }
    
    /**
     * 영토 경계 사각형 반환 (월드 좌표계)
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    getBounds() {
        if (this.mask.size === 0) {
            return { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
        }
        
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        
        for (const key of this.mask) {
            const [x, y] = key.split(',').map(Number);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        
        return { minX, minY, maxX, maxY };
    }
    
    /**
     * 사각형을 영토 경계 내로 클램프 (기본 정책)
     * @param {Object} rectWorld - {x, y, width, height} (월드 좌표계)
     * @returns {Object} 클램프된 사각형
     */
    clampRect(rectWorld) {
        const bounds = this.getBounds();
        
        let { x, y, width, height } = rectWorld;
        
        // 왼쪽/위 경계
        x = Math.max(x, bounds.minX);
        y = Math.max(y, bounds.minY);
        
        // 오른쪽/아래 경계
        const right = x + width;
        const bottom = y + height;
        if (right > bounds.maxX + 1) {
            width = bounds.maxX + 1 - x;
        }
        if (bottom > bounds.maxY + 1) {
            height = bounds.maxY + 1 - y;
        }
        
        return { x, y, width, height };
    }
    
    /**
     * 사각형과 영토 마스크의 교집합 반환 (적용 단계에서 사용)
     * @param {Object} rectWorld - {x, y, width, height} (월드 좌표계)
     * @returns {Object} 교집합 사각형
     */
    intersectRect(rectWorld) {
        const bounds = this.getBounds();
        
        let { x, y, width, height } = rectWorld;
        
        // 교집합 계산
        const left = Math.max(x, bounds.minX);
        const top = Math.max(y, bounds.minY);
        const right = Math.min(x + width, bounds.maxX + 1);
        const bottom = Math.min(y + height, bounds.maxY + 1);
        
        // 교집합이 없으면 null 반환
        if (left >= right || top >= bottom) {
            return null;
        }
        
        return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top
        };
    }
    
    /**
     * 마스크 크기 반환
     * @returns {number} 영토 안 셀 개수
     */
    size() {
        return this.mask.size;
    }
}

