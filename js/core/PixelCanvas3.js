/**
 * PixelCanvas3 - 영토 경계 기반 픽셀 캔버스 시스템
 * 영토의 실제 GeoJSON 경계를 캔버스에 표시하고 편집
 * 줌/패닝 기능 포함
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { pixelDataService } from '../services/PixelDataService.js';
import { territoryManager } from './TerritoryManager.js';
import { firebaseService } from '../services/FirebaseService.js';
import mapController from './MapController.js';

// 픽셀 도구
export const TOOLS = {
    BRUSH: 'brush',
    ERASER: 'eraser',
    FILL: 'fill',
    PICKER: 'picker',
    PAN: 'pan' // 이동 도구
};

class PixelCanvas3 {
    constructor() {
        this.territoryId = null;
        this.territory = null;
        this.canvas = null;
        this.ctx = null;
        this.width = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        this.height = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        this.basePixelSize = 8; // 기본 픽셀 크기
        this.pixelSize = 8; // 현재 픽셀 크기 (줌에 따라 변경)
        
        // 줌 및 패닝
        this.zoom = 1.0; // 줌 레벨 (0.5 ~ 5.0)
        this.minZoom = 0.5;
        this.maxZoom = 5.0;
        this.panX = 0; // 패닝 X 오프셋
        this.panY = 0; // 패닝 Y 오프셋
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        
        // 영토 경계 데이터
        this.territoryGeometry = null;
        this.territoryBounds = null;
        this.territoryMask = null;
        
        // 픽셀 데이터
        this.pixels = new Map();
        
        // 도구 상태
        this.tool = TOOLS.BRUSH;
        this.color = '#4ecdc4';
        this.brushSize = 1;
        
        // 드로잉 상태
        this.isDrawing = false;
        this.lastPos = null;
        
        // 히스토리
        this.history = [];
        this.historyIndex = -1;
        this.maxHistory = 50;
        
        // 자동 저장
        this.saveTimeout = null;
        this.saveDelay = 800;
        this.lastSavedState = null;
        this.hasUnsavedChangesFlag = false;
        
        // 캔버스 래퍼 (줌/패닝용)
        this.wrapper = null;
        
        // 터치 제스처
        this.touchStartDistance = 0;
        this.touchStartZoom = 1;
        this.touchStartPanX = 0;
        this.touchStartPanY = 0;
        this.touchStartX = 0;
        this.touchStartY = 0;
    }
    
    /**
     * 초기화
     */
    async initialize(territoryId, canvasElement, territory = null) {
        this.territoryId = territoryId;
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        
        // 캔버스 래퍼 찾기
        this.wrapper = this.canvas.parentElement;
        
        // territory 객체 저장
        this.territory = territory || territoryManager.getTerritory(territoryId);
        
        // 영토 경계 가져오기
        await this.loadTerritoryGeometry();
        
        // 캔버스 크기 설정 (실제 픽셀 크기)
        const baseSize = this.width * this.basePixelSize;
        this.canvas.width = baseSize;
        this.canvas.height = baseSize;
        
        // 배경 및 경계선 그리기
        this.drawBackground();
        this.drawTerritoryBoundary();
        
        // 데이터 로드
        await this.load();
        
        // 이벤트 리스너
        this.setupEvents();
        
        // 터치 이벤트 설정 (모바일)
        this.setupTouchEvents();
        
        // 초기 렌더링
        this.render();
        
        // 초기 줌 설정 (영토가 전체 보이도록)
        this.fitToView();
        
        log.info(`[PixelCanvas3] Initialized for ${territoryId}`);
    }
    
    /**
     * 모바일 터치 제스처 설정
     */
    setupTouchEvents() {
        if (!this.canvas) return;
        
        // 핀치 줌 (2손가락)
        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                this.touchStartDistance = Math.hypot(
                    touch2.clientX - touch1.clientX,
                    touch2.clientY - touch1.clientY
                );
                this.touchStartZoom = this.zoom;
                e.preventDefault();
            } else if (e.touches.length === 1) {
                const touch = e.touches[0];
                this.touchStartX = touch.clientX;
                this.touchStartY = touch.clientY;
                this.touchStartPanX = this.panX;
                this.touchStartPanY = this.panY;
            }
        });
        
        this.canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                const touch1 = e.touches[0];
                const touch2 = e.touches[1];
                const distance = Math.hypot(
                    touch2.clientX - touch1.clientX,
                    touch2.clientY - touch1.clientY
                );
                const scale = distance / this.touchStartDistance;
                const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.touchStartZoom * scale));
                this.setZoom(newZoom);
                e.preventDefault();
            } else if (e.touches.length === 1) {
                if (this.tool === TOOLS.PAN) {
                    const touch = e.touches[0];
                    const deltaX = touch.clientX - this.touchStartX;
                    const deltaY = touch.clientY - this.touchStartY;
                    this.panX = this.touchStartPanX + deltaX;
                    this.panY = this.touchStartPanY + deltaY;
                    this.updateCanvasTransform();
                } else {
                    // 터치 드로잉
                    const touch = e.touches[0];
                    const rect = this.canvas.getBoundingClientRect();
                    const scale = this.zoom;
                    const x = (touch.clientX - rect.left - this.panX) / scale;
                    const y = (touch.clientY - rect.top - this.panY) / scale;
                    const pos = this.getPixelPosFromCoords(x, y);
                    if (pos && this.isDrawing) {
                        this.draw(pos.x, pos.y);
                    }
                }
                e.preventDefault();
            }
        });
        
        // 터치 드로잉 시작
        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1 && this.tool !== TOOLS.PAN) {
                const touch = e.touches[0];
                const rect = this.canvas.getBoundingClientRect();
                const scale = this.zoom;
                const x = (touch.clientX - rect.left - this.panX) / scale;
                const y = (touch.clientY - rect.top - this.panY) / scale;
                const pos = this.getPixelPosFromCoords(x, y);
                if (pos) {
                    this.startDrawing(pos.x, pos.y);
                    e.preventDefault();
                }
            }
        });
        
        this.canvas.addEventListener('touchend', (e) => {
            if (this.isDrawing) {
                this.stopDrawing();
                e.preventDefault();
            }
        });
    }
    
    /**
     * 좌표에서 픽셀 위치 가져오기
     */
    getPixelPosFromCoords(x, y) {
        const pixelX = Math.floor(x / this.basePixelSize);
        const pixelY = Math.floor(y / this.basePixelSize);
        if (this.isValidPos(pixelX, pixelY)) {
            return { x: pixelX, y: pixelY };
        }
        return null;
    }
    
    /**
     * 영토가 전체 보이도록 줌 조정
     */
    fitToView() {
        if (!this.wrapper) return;
        
        const wrapperWidth = this.wrapper.clientWidth;
        const wrapperHeight = this.wrapper.clientHeight;
        const canvasWidth = this.canvas.width;
        const canvasHeight = this.canvas.height;
        
        // 여유 공간을 두고 맞추기
        const padding = 40;
        const scaleX = (wrapperWidth - padding) / canvasWidth;
        const scaleY = (wrapperHeight - padding) / canvasHeight;
        const scale = Math.min(scaleX, scaleY, this.maxZoom);
        
        this.zoom = Math.max(scale, this.minZoom);
        this.panX = 0;
        this.panY = 0;
        
        this.updateCanvasTransform();
    }
    
    /**
     * 캔버스 변환 업데이트
     */
    updateCanvasTransform() {
        if (!this.canvas) return;
        
        this.pixelSize = this.basePixelSize * this.zoom;
        
        const scale = this.zoom;
        const translateX = this.panX;
        const translateY = this.panY;
        
        this.canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        this.canvas.style.transformOrigin = '0 0';
    }
    
    /**
     * 줌 인
     */
    zoomIn(factor = 1.2) {
        const newZoom = this.zoom * factor;
        this.setZoom(newZoom);
    }
    
    /**
     * 줌 아웃
     */
    zoomOut(factor = 1.2) {
        const newZoom = this.zoom / factor;
        this.setZoom(newZoom);
    }
    
    /**
     * 줌 설정
     */
    setZoom(zoom) {
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
        this.updateCanvasTransform();
        this.emitZoomChange();
    }
    
    /**
     * 줌 변경 이벤트 발행
     */
    emitZoomChange() {
        eventBus.emit(EVENTS.PIXEL_UPDATE, {
            type: 'zoomChanged',
            zoom: this.zoom
        });
    }
    
    /**
     * 영토 GeoJSON geometry 가져오기
     */
    async loadTerritoryGeometry() {
        if (!this.territory) return;
        
        try {
            const map = mapController.map;
            if (!map) {
                log.warn('[PixelCanvas3] Map not available');
                return;
            }
            
            const sourceId = this.territory.sourceId;
            const featureId = this.territory.featureId;
            
            if (!sourceId || !featureId) {
                log.warn('[PixelCanvas3] Missing sourceId or featureId');
                return;
            }
            
            const source = map.getSource(sourceId);
            if (source && source.type === 'geojson') {
                const data = source._data;
                if (data && data.features) {
                    const feature = data.features.find(f => 
                        String(f.id) === String(featureId) ||
                        String(f.properties?.id) === String(featureId)
                    );
                    
                    if (feature && feature.geometry) {
                        this.territoryGeometry = feature.geometry;
                        this.territoryBounds = this.calculateBounds(feature.geometry);
                        this.territoryMask = this.createTerritoryMask(feature.geometry);
                        log.info('[PixelCanvas3] Territory geometry loaded');
                    }
                }
            }
        } catch (error) {
            log.error('[PixelCanvas3] Failed to load territory geometry:', error);
        }
    }
    
    /**
     * 경계 계산
     */
    calculateBounds(geometry) {
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        
        const processCoordinates = (coords) => {
            if (Array.isArray(coords[0])) {
                coords.forEach(processCoordinates);
            } else if (coords.length >= 2) {
                const [lng, lat] = coords;
                minLng = Math.min(minLng, lng);
                maxLng = Math.max(maxLng, lng);
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
            }
        };
        
        if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach(processCoordinates);
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygon => {
                polygon.forEach(processCoordinates);
            });
        }
        
        return { minLng, maxLng, minLat, maxLat };
    }
    
    /**
     * 영토 경계 마스크 생성
     */
    createTerritoryMask(geometry) {
        const mask = new Set();
        
        if (!this.territoryBounds) return mask;
        
        const { minLng, maxLng, minLat, maxLat } = this.territoryBounds;
        const lngRange = maxLng - minLng;
        const latRange = maxLat - minLat;
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const normalizedX = (x + 0.5) / this.width;
                const normalizedY = (y + 0.5) / this.height;
                
                const lng = minLng + normalizedX * lngRange;
                const lat = maxLat - normalizedY * latRange;
                
                if (this.isPointInGeometry([lng, lat], geometry)) {
                    mask.add(`${x},${y}`);
                }
            }
        }
        
        return mask;
    }
    
    /**
     * 점이 geometry 안에 있는지 확인
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
     * 영토 경계선 그리기
     */
    drawTerritoryBoundary() {
        if (!this.territoryGeometry || !this.territoryBounds) return;
        
        const { minLng, maxLng, minLat, maxLat } = this.territoryBounds;
        const lngRange = maxLng - minLng;
        const latRange = maxLat - minLat;
        
        this.ctx.strokeStyle = '#4ecdc4';
        this.ctx.lineWidth = 2;
        
        this.ctx.beginPath();
        
        if (this.territoryGeometry.type === 'Polygon') {
            this.territoryGeometry.coordinates[0].forEach((coord, idx) => {
                const normalizedX = (coord[0] - minLng) / lngRange;
                const normalizedY = (maxLat - coord[1]) / latRange;
                
                const x = normalizedX * this.width * this.basePixelSize;
                const y = normalizedY * this.height * this.basePixelSize;
                
                if (idx === 0) {
                    this.ctx.moveTo(x, y);
                } else {
                    this.ctx.lineTo(x, y);
                }
            });
            this.ctx.closePath();
        } else if (this.territoryGeometry.type === 'MultiPolygon') {
            this.territoryGeometry.coordinates.forEach(polygon => {
                polygon[0].forEach((coord, idx) => {
                    const normalizedX = (coord[0] - minLng) / lngRange;
                    const normalizedY = (maxLat - coord[1]) / latRange;
                    
                    const x = normalizedX * this.width * this.basePixelSize;
                    const y = normalizedY * this.height * this.basePixelSize;
                    
                    if (idx === 0) {
                        this.ctx.moveTo(x, y);
                    } else {
                        this.ctx.lineTo(x, y);
                    }
                });
                this.ctx.closePath();
            });
        }
        
        this.ctx.stroke();
    }
    
    /**
     * 배경 그리기
     */
    drawBackground() {
        const size = this.basePixelSize;
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const key = `${x},${y}`;
                const isInside = !this.territoryMask || this.territoryMask.has(key);
                
                const isLight = (x + y) % 2 === 0;
                if (isInside) {
                    this.ctx.fillStyle = isLight ? '#1a1a1a' : '#141414';
                } else {
                    this.ctx.fillStyle = '#0a0a0a';
                }
                this.ctx.fillRect(x * size, y * size, size, size);
            }
        }
    }
    
    /**
     * 데이터 로드
     */
    async load() {
        try {
            const data = await pixelDataService.loadPixelData(this.territoryId);
            if (data?.pixels) {
                this.pixels.clear();
                for (const pixel of data.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (!this.territoryMask || this.territoryMask.has(key)) {
                        this.pixels.set(key, {
                            color: pixel.c || pixel.color,
                            userId: pixel.u || pixel.userId,
                            timestamp: pixel.t || pixel.timestamp
                        });
                    }
                }
                log.info(`[PixelCanvas3] Loaded ${this.pixels.size} pixels`);
            }
        } catch (error) {
            log.error('[PixelCanvas3] Load failed:', error);
        }
    }
    
    /**
     * 이벤트 설정
     */
    setupEvents() {
        if (!this.canvas) return;
        
        // 마우스 이벤트
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
        
        // 휠 줌
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.setZoom(this.zoom * delta);
        });
        
        // 패닝 (우클릭 드래그 또는 Shift + 드래그)
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
        
        // 터치 이벤트는 setupTouchEvents()에서 처리
        
        // 키보드 단축키
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                this.undo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                this.redo();
            } else if (e.key === ' ' || e.key === 'Space') {
                e.preventDefault();
                this.canvas.style.cursor = 'grab';
            }
        });
        
        document.addEventListener('keyup', (e) => {
            if (e.key === ' ' || e.key === 'Space') {
                this.canvas.style.cursor = 'crosshair';
            }
        });
    }
    
    /**
     * 화면 좌표를 픽셀 좌표로 변환 (줌/패닝 고려)
     */
    getPixelPos(e) {
        if (!this.canvas) {
            return { x: 0, y: 0 };
        }
        
        // 캔버스의 실제 DOM 위치 (transform이 적용된 후의 실제 화면 위치)
        const canvasRect = this.canvas.getBoundingClientRect();
        
        // 마우스 위치를 캔버스 기준 좌표로 변환 (transform이 적용되기 전 원본 크기 기준)
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;
        
        // transform이 적용된 캔버스의 실제 화면 크기
        const scaledWidth = canvasRect.width;
        const scaledHeight = canvasRect.height;
        
        // 원본 캔버스 크기
        const naturalWidth = this.width * this.basePixelSize;
        const naturalHeight = this.height * this.basePixelSize;
        
        // 스케일 비율 (실제 화면 크기 / 원본 크기)
        const scaleX = scaledWidth / naturalWidth;
        const scaleY = scaledHeight / naturalHeight;
        
        // 원본 캔버스 기준 좌표로 변환
        const canvasLocalX = mouseX / scaleX;
        const canvasLocalY = mouseY / scaleY;
        
        // 픽셀 좌표로 변환
        const pixelX = Math.floor(canvasLocalX / this.basePixelSize);
        const pixelY = Math.floor(canvasLocalY / this.basePixelSize);
        
        // 범위 체크
        if (pixelX < 0 || pixelX >= this.width || pixelY < 0 || pixelY >= this.height) {
            return { x: -1, y: -1 }; // 캔버스 밖
        }
        
        return { x: pixelX, y: pixelY };
    }
    
    /**
     * 마우스 다운
     */
    onMouseDown(e) {
        // 이동 도구 모드 또는 패닝 모드 (우클릭 또는 Shift+드래그)
        if (this.tool === TOOLS.PAN || e.button === 2 || (e.button === 0 && e.shiftKey)) {
            this.isPanning = true;
            this.panStartX = e.clientX - this.panX;
            this.panStartY = e.clientY - this.panY;
            if (this.canvas) {
                this.canvas.style.cursor = 'grabbing';
            }
            return;
        }
        
        // 드로잉 모드
        const { x, y } = this.getPixelPos(e);
        if (!this.isValidPos(x, y)) return;
        if (!this.isInsideTerritory(x, y)) return;
        
        this.isDrawing = true;
        this.saveHistory();
        
        if (this.tool === TOOLS.FILL) {
            this.floodFill(x, y);
        } else if (this.tool === TOOLS.PICKER) {
            this.pickColor(x, y);
        } else {
            this.drawPixel(x, y);
        }
        
        this.lastPos = { x, y };
    }
    
    /**
     * 마우스 이동
     */
    onMouseMove(e) {
        if (this.isPanning) {
            this.panX = e.clientX - this.panStartX;
            this.panY = e.clientY - this.panStartY;
            this.updateCanvasTransform();
            return;
        }
        
        if (!this.isDrawing) return;
        
        const { x, y } = this.getPixelPos(e);
        if (!this.isValidPos(x, y)) return;
        if (!this.isInsideTerritory(x, y)) return;
        
        if (this.tool === TOOLS.BRUSH || this.tool === TOOLS.ERASER) {
            if (this.brushSize > 1 && this.lastPos) {
                this.drawLine(this.lastPos.x, this.lastPos.y, x, y);
            } else {
                this.drawPixel(x, y);
            }
        }
        
        this.lastPos = { x, y };
    }
    
    /**
     * 마우스 업
     */
    onMouseUp() {
        if (this.isPanning) {
            this.isPanning = false;
            if (this.canvas) {
                this.canvas.style.cursor = 'crosshair';
            }
        }
        
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastPos = null;
            this.autoSave();
        }
    }
    
    /**
     * 유효한 위치인지 확인
     */
    isValidPos(x, y) {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }
    
    /**
     * 영토 경계 안에 있는지 확인
     */
    isInsideTerritory(x, y) {
        if (!this.territoryMask) return true;
        return this.territoryMask.has(`${x},${y}`);
    }
    
    /**
     * 픽셀 그리기
     */
    drawPixel(x, y) {
        if (!this.isInsideTerritory(x, y)) return;
        
        if (this.tool === TOOLS.ERASER) {
            const key = `${x},${y}`;
            if (this.pixels.has(key)) {
                this.pixels.delete(key);
                this.drawPixelOnCanvas(x, y, null);
                this.updateStats();
            }
        } else if (this.tool === TOOLS.BRUSH) {
            if (this.brushSize === 1) {
                this.setPixel(x, y, this.color);
            } else {
                const radius = Math.floor(this.brushSize / 2);
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (this.isValidPos(nx, ny) && this.isInsideTerritory(nx, ny)) {
                            this.setPixel(nx, ny, this.color);
                        }
                    }
                }
            }
        }
    }
    
    /**
     * 픽셀 설정
     */
    setPixel(x, y, color) {
        if (!this.isInsideTerritory(x, y)) return;
        
        const key = `${x},${y}`;
        const user = firebaseService.getCurrentUser();
        
        this.pixels.set(key, {
            color,
            userId: user?.uid || 'anonymous',
            timestamp: Date.now()
        });
        
        this.hasUnsavedChangesFlag = true;
        this.drawPixelOnCanvas(x, y, color);
        this.updateStats();
    }
    
    /**
     * 캔버스에 픽셀 그리기
     */
    drawPixelOnCanvas(x, y, color) {
        const size = this.basePixelSize;
        if (color === null) {
            const isLight = (x + y) % 2 === 0;
            const isInside = !this.territoryMask || this.territoryMask.has(`${x},${y}`);
            this.ctx.fillStyle = isInside 
                ? (isLight ? '#1a1a1a' : '#141414')
                : '#0a0a0a';
        } else {
            this.ctx.fillStyle = color;
        }
        this.ctx.fillRect(x * size, y * size, size, size);
    }
    
    /**
     * 선 그리기
     */
    drawLine(x1, y1, x2, y2) {
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        const sx = x1 < x2 ? 1 : -1;
        const sy = y1 < y2 ? 1 : -1;
        let err = dx - dy;
        
        let x = x1;
        let y = y1;
        
        while (true) {
            this.drawPixel(x, y);
            
            if (x === x2 && y === y2) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
    }
    
    /**
     * 색상 선택
     */
    pickColor(x, y) {
        const key = `${x},${y}`;
        const pixel = this.pixels.get(key);
        if (pixel) {
            this.color = pixel.color;
            eventBus.emit(EVENTS.PIXEL_UPDATE, {
                type: 'colorPicked',
                color: pixel.color
            });
        }
    }
    
    /**
     * 플러드 필
     */
    floodFill(startX, startY) {
        if (!this.isInsideTerritory(startX, startY)) return;
        
        const key = `${startX},${startY}`;
        const targetPixel = this.pixels.get(key);
        const targetColor = targetPixel ? targetPixel.color : null;
        
        if (targetColor === this.color) return;
        
        const stack = [[startX, startY]];
        const visited = new Set();
        const user = firebaseService.getCurrentUser();
        
        while (stack.length > 0) {
            const [x, y] = stack.pop();
            const pixelKey = `${x},${y}`;
            
            if (visited.has(pixelKey)) continue;
            if (!this.isValidPos(x, y)) continue;
            if (!this.isInsideTerritory(x, y)) continue;
            
            const currentPixel = this.pixels.get(pixelKey);
            const currentColor = currentPixel ? currentPixel.color : null;
            
            if (currentColor !== targetColor) continue;
            
            visited.add(pixelKey);
            this.setPixel(x, y, this.color);
            
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        
        this.autoSave();
    }
    
    /**
     * 렌더링
     */
    render() {
        this.drawBackground();
        this.drawTerritoryBoundary();
        for (const [key, pixel] of this.pixels.entries()) {
            const [x, y] = key.split(',').map(Number);
            this.drawPixelOnCanvas(x, y, pixel.color);
        }
    }
    
    /**
     * 통계 업데이트
     */
    updateStats() {
        eventBus.emit(EVENTS.PIXEL_VALUE_CHANGE, {
            territoryId: this.territoryId,
            filledPixels: this.pixels.size,
            value: this.calculateValue()
        });
    }
    
    /**
     * 가치 계산
     */
    calculateValue() {
        return this.pixels.size;
    }
    
    /**
     * 자동 저장
     */
    autoSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        
        this.saveTimeout = setTimeout(() => {
            this.save();
        }, this.saveDelay);
    }
    
    /**
     * 저장
     */
    async save() {
        if (!this.territoryId) return;
        
        try {
            eventBus.emit(EVENTS.PIXEL_UPDATE, { type: 'saveStatus', status: 'saving' });
            
            const pixelData = {
                territoryId: this.territoryId,
                pixels: this.encodePixels(),
                filledPixels: this.pixels.size,
                width: this.width,
                height: this.height,
                bounds: this.territoryBounds
            };
            
            await pixelDataService.savePixelData(this.territoryId, pixelData);
            
            const metadata = {
                pixelCanvas: {
                    width: this.width,
                    height: this.height,
                    filledPixels: this.pixels.size,
                    lastUpdated: Date.now()
                },
                territoryValue: this.calculateValue()
            };
            
            await pixelDataService.updateTerritoryMetadata(this.territoryId, metadata);
            
            const territory = territoryManager.getTerritory(this.territoryId);
            if (territory) {
                const imageDataUrl = this.toDataURL();
                
                eventBus.emit(EVENTS.PIXEL_CANVAS_SAVED, {
                    territoryId: this.territoryId,
                    filledPixels: this.pixels.size,
                    imageDataUrl: imageDataUrl,
                    bounds: this.territoryBounds,
                    territory: {
                        ...territory,
                        pixelCanvas: metadata.pixelCanvas,
                        territoryValue: metadata.territoryValue,
                        sourceId: territory.sourceId,
                        featureId: territory.featureId
                    }
                });
            }
            
            this.lastSavedState = JSON.stringify(this.encodePixels());
            this.hasUnsavedChangesFlag = false;
            
            eventBus.emit(EVENTS.PIXEL_UPDATE, { type: 'saveStatus', status: 'saved' });
            eventBus.emit(EVENTS.PIXEL_DATA_SAVED);
            
            log.info(`[PixelCanvas3] Saved ${this.pixels.size} pixels`);
        } catch (error) {
            log.error('[PixelCanvas3] Save failed:', error);
            eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                type: 'saveStatus', 
                status: 'error',
                error: error.message 
            });
            
            // 사용자에게 알림
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '저장에 실패했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.'
            });
            
            throw error;
        }
    }
    
    /**
     * 저장되지 않은 변경사항이 있는지 확인
     */
    hasUnsavedChanges() {
        if (!this.lastSavedState) return this.pixels.size > 0;
        const currentState = JSON.stringify(this.encodePixels());
        return currentState !== this.lastSavedState || this.hasUnsavedChangesFlag;
    }
    
    /**
     * 픽셀 인코딩
     */
    encodePixels() {
        const encoded = [];
        for (const [key, pixel] of this.pixels.entries()) {
            const [x, y] = key.split(',').map(Number);
            encoded.push({
                x, y,
                c: pixel.color,
                u: pixel.userId,
                t: pixel.timestamp
            });
        }
        return encoded;
    }
    
    /**
     * 히스토리 저장
     */
    saveHistory() {
        const state = this.encodePixels();
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(state);
        this.historyIndex++;
        
        if (this.history.length > this.maxHistory) {
            this.history.shift();
            this.historyIndex--;
        }
    }
    
    /**
     * Undo
     */
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.decodePixels(this.history[this.historyIndex]);
            this.render();
            this.autoSave();
        }
    }
    
    /**
     * Redo
     */
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.decodePixels(this.history[this.historyIndex]);
            this.render();
            this.autoSave();
        }
    }
    
    /**
     * 픽셀 디코딩
     */
    decodePixels(encoded) {
        this.pixels.clear();
        if (!encoded) return;
        for (const pixel of encoded) {
            const key = `${pixel.x},${pixel.y}`;
            this.pixels.set(key, {
                color: pixel.c || pixel.color,
                userId: pixel.u || pixel.userId,
                timestamp: pixel.t || pixel.timestamp
            });
        }
    }
    
    /**
     * 도구 설정
     */
    setTool(tool) {
        this.tool = tool;
        
        // 커서 변경
        if (this.canvas) {
            if (tool === TOOLS.PAN) {
                this.canvas.style.cursor = 'grab';
            } else if (tool === TOOLS.PICKER) {
                this.canvas.style.cursor = 'crosshair';
            } else {
                this.canvas.style.cursor = 'crosshair';
            }
        }
    }
    
    /**
     * 색상 설정
     */
    setColor(color) {
        this.color = color;
    }
    
    /**
     * 브러시 크기 설정
     */
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(size, 10));
    }
    
    /**
     * 클리어
     */
    clear() {
        this.saveHistory();
        this.pixels.clear();
        this.render();
        this.autoSave();
    }
    
    /**
     * 이미지로 내보내기
     */
    toDataURL() {
        return this.canvas.toDataURL('image/png');
    }
    
    /**
     * 정리
     */
    cleanup() {
        this.pixels.clear();
        this.history = [];
        this.historyIndex = -1;
        this.territoryId = null;
        this.territory = null;
        this.territoryGeometry = null;
        this.territoryBounds = null;
        this.territoryMask = null;
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
    }
}

export const pixelCanvas3 = new PixelCanvas3();
export default pixelCanvas3;
