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
import { apiService } from '../services/ApiService.js';
import { localCacheService } from '../services/LocalCacheService.js';
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
        this.maxHistory = 30; // 전문가 권장: 20~50단계로 제한하여 메모리 최적화
        
        // 자동 저장
        this.saveTimeout = null;
        this.saveDelay = 1000; // 1초로 단축 (기존 800ms)
        this.lastSavedState = null;
        this.hasUnsavedChangesFlag = false;
        this.isSaving = false; // 저장 중 플래그
        this.lastSaveTime = null; // 마지막 저장 시각
        
        // 세션 저장 (미완성 작업 복원용)
        this.sessionSaveInterval = null;
        this.sessionSaveDelay = 5000; // 5초마다 세션 저장 (전문가 권장: 5~8초)
        this.lastSessionSaveTime = 0; // 마지막 세션 저장 시각 (최소 간격 제어용)
        this.sessionSaveMinInterval = 5000; // 최소 저장 간격 5초
        
        // Delta 저장 (변경된 픽셀만 추적)
        this.lastSavedPixels = new Map(); // 마지막 전체 저장 시점의 픽셀 상태 (snapshot)
        this.changedPixels = new Set(); // 변경된 픽셀 키 추적
        this.lastFullSaveTime = null; // 마지막 전체 저장 시각
        this.DELTA_SAVE_THRESHOLD_ABSOLUTE = 400; // Delta 저장 절대 임계값 (300~500개 권장)
        this.DELTA_SAVE_THRESHOLD_RATIO = 0.3; // Delta 저장 상대 임계값 (30%)
        
        // 캔버스 래퍼 (줌/패닝용)
        this.wrapper = null;
        
        // 터치 제스처
        this.touchStartDistance = 0;
        this.touchStartZoom = 1;
        this.touchStartPanX = 0;
        this.touchStartPanY = 0;
        this.touchStartX = 0;
        this.touchStartY = 0;
        
        // 소유권 변경 감지
        this.ownershipChangeListener = null;
        this.originalOwnerId = null; // 편집 시작 시 소유자 ID
    }
    
    /**
     * 소유권 변경 감지 리스너 설정
     */
    setupOwnershipChangeListener() {
        // 기존 리스너 제거
        if (this.ownershipChangeListener) {
            eventBus.off(EVENTS.TERRITORY_UPDATE, this.ownershipChangeListener);
        }
        
        // 편집 시작 시 소유자 ID 저장
        if (this.territory && this.territory.ruler) {
            this.originalOwnerId = this.territory.ruler;
        }
        
        // TERRITORY_UPDATE 이벤트 구독
        this.ownershipChangeListener = async (data) => {
            const territoryId = data.territory?.id || data.territoryId;
            if (territoryId !== this.territoryId) return;
            
            const { firebaseService } = await import('../services/FirebaseService.js');
            const currentUser = firebaseService.getCurrentUser();
            
            if (currentUser && data.territory) {
                const newOwnerId = data.territory.ruler;
                
                // 소유권이 변경되었는지 확인
                if (newOwnerId && newOwnerId !== this.originalOwnerId && newOwnerId !== currentUser.uid) {
                    log.error(`[PixelCanvas3] ⚠️ Ownership changed during editing! Territory ${this.territoryId} is now owned by ${newOwnerId}`);
                    
                    // 사용자에게 알림
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'warning',
                        message: '⚠️ 이 영토의 소유권이 변경되었습니다. 편집할 수 없습니다.'
                    });
                    
                    // 저장 상태 업데이트
                    eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                        type: 'saveStatus', 
                        status: 'error',
                        error: 'Ownership changed',
                        message: '소유권이 변경되어 편집할 수 없습니다'
                    });
                    
                    // 원래 소유자 ID 업데이트
                    this.originalOwnerId = newOwnerId;
                } else if (newOwnerId === currentUser.uid) {
                    // 현재 사용자가 소유자가 된 경우
                    this.originalOwnerId = newOwnerId;
                }
            }
        };
        
        eventBus.on(EVENTS.TERRITORY_UPDATE, this.ownershipChangeListener);
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
        
        // ⚠️ CRITICAL: 소유권 변경 감지 리스너 설정
        this.setupOwnershipChangeListener();
        
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
        
        // 미완성 세션 확인 및 복원
        await this.checkAndRestoreSession();
        
        // 초기 렌더링
        this.render();
        
        // 초기 줌 설정 (영토가 전체 보이도록)
        this.fitToView();
        
        // 세션 자동 저장 비활성화 (수동 저장만 사용)
        // this.startSessionAutoSave();
        
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
                        // 삭제된 픽셀 (c가 null)은 건너뛰기
                        if (pixel.c === null) {
                            continue;
                        }
                        
                        this.pixels.set(key, {
                            color: pixel.c || pixel.color,
                            userId: pixel.u || pixel.userId,
                            timestamp: pixel.t || pixel.timestamp
                        });
                    }
                }
                
                // 마지막 저장 시점의 픽셀 상태 저장 (Delta 추적용)
                this.lastSavedPixels.clear();
                for (const [key, pixel] of this.pixels.entries()) {
                    this.lastSavedPixels.set(key, { ...pixel });
                }
                this.changedPixels.clear();
                
                log.info(`[PixelCanvas3] Loaded ${this.pixels.size} pixels`);
            }
        } catch (error) {
            log.error('[PixelCanvas3] Load failed:', error);
        }
    }
    
    /**
     * 미완성 세션 확인 및 복원
     */
    async checkAndRestoreSession() {
        try {
            const session = await localCacheService.loadSession(this.territoryId);
            if (!session) {
                return; // 세션이 없으면 그냥 진행
            }
            
            // Firebase에서 최신 데이터 가져오기
            const firestoreData = await pixelDataService.loadPixelData(this.territoryId);
            const firestoreLastUpdated = firestoreData?.lastUpdated || 0;
            const sessionLastModified = session.lastModified || 0;
            
            // 세션이 Firebase보다 최신이면 복원 제안
            if (sessionLastModified > firestoreLastUpdated) {
                const shouldRestore = await this.showRestoreDialog(session);
                if (shouldRestore) {
                    await this.restoreSession(session);
                } else {
                    // 복원하지 않으면 세션 삭제
                    await localCacheService.clearSession(this.territoryId);
                }
            } else {
                // Firebase가 최신이면 세션 삭제
                await localCacheService.clearSession(this.territoryId);
            }
        } catch (error) {
            log.error('[PixelCanvas3] Failed to check session:', error);
        }
    }
    
    /**
     * 복원 다이얼로그 표시
     * @param {Object} session - 세션 데이터
     * @returns {Promise<boolean>} 복원 여부
     */
    async showRestoreDialog(session) {
        return new Promise((resolve) => {
            const sessionTime = new Date(session.lastModified).toLocaleString('ko-KR');
            const message = `마지막 미완성 작업을 발견했습니다.\n\n` +
                          `작업 시간: ${sessionTime}\n` +
                          `채워진 픽셀: ${session.pixels?.length || 0}개\n\n` +
                          `이 작업을 이어서 불러오시겠습니까?`;
            
            const confirmed = confirm(message);
            resolve(confirmed);
        });
    }
    
    /**
     * 세션 복원
     * @param {Object} session - 세션 데이터
     */
    async restoreSession(session) {
        try {
            if (session.pixels) {
                this.pixels.clear();
                for (const pixel of session.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (!this.territoryMask || this.territoryMask.has(key)) {
                        this.pixels.set(key, {
                            color: pixel.c || pixel.color,
                            userId: pixel.u || pixel.userId,
                            timestamp: pixel.t || pixel.timestamp
                        });
                    }
                }
                
                // 렌더링
                this.render();
                
                // 상태 업데이트
                this.hasUnsavedChangesFlag = true;
                this.updateStats();
                
                log.info(`[PixelCanvas3] Restored session with ${this.pixels.size} pixels`);
                
                // 이벤트 발행
                eventBus.emit(EVENTS.PIXEL_UPDATE, {
                    type: 'sessionRestored',
                    pixelCount: this.pixels.size
                });
            }
        } catch (error) {
            log.error('[PixelCanvas3] Failed to restore session:', error);
        }
    }
    
    /**
     * 세션 자동 저장 시작
     */
    startSessionAutoSave() {
        // 기존 인터벌 제거
        if (this.sessionSaveInterval) {
            clearInterval(this.sessionSaveInterval);
        }
        
        // 5초마다 세션 저장 (전문가 권장: 5~8초)
        // 최소 간격 체크는 saveSession 내부에서 처리
        this.sessionSaveInterval = setInterval(() => {
            this.saveSession();
        }, this.sessionSaveDelay);
    }
    
    /**
     * 세션 저장 (미완성 작업)
     * 전문가 권장: 최소 간격 체크로 과도 저장 방지
     */
    async saveSession() {
        if (!this.territoryId || this.pixels.size === 0) {
            return; // 픽셀이 없으면 저장하지 않음
        }
        
        // 최소 간격 체크 (전문가 권장: 유휴 3초 + 최소 간격 5초)
        const now = Date.now();
        if (now - this.lastSessionSaveTime < this.sessionSaveMinInterval) {
            return; // 최소 간격 미달 시 스킵
        }
        
        try {
            const sessionData = {
                pixels: this.encodePixels(),
                filledPixels: this.pixels.size,
                width: this.width,
                height: this.height,
                bounds: this.territoryBounds
            };
            
            await localCacheService.saveSession(this.territoryId, sessionData);
            this.lastSessionSaveTime = now;
            log.debug(`[PixelCanvas3] Saved session for ${this.territoryId}`);
        } catch (error) {
            log.warn('[PixelCanvas3] Failed to save session:', error);
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
            // 자동저장 제거 - 수동 저장만 사용
            // this.autoSave();
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
                // Delta 추적: 삭제된 픽셀도 변경으로 기록
                this.changedPixels.add(key);
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
        
        // Delta 추적: 변경된 픽셀 기록
        const previousPixel = this.pixels.get(key);
        if (!previousPixel || previousPixel.color !== color) {
            this.changedPixels.add(key);
        }
        
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
        
        // 자동저장 제거 - 수동 저장만 사용
        // this.autoSave();
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
     * 자동 저장 (debounced)
     * 저장 중이면 스킵
     * Delta 저장 사용: 변경된 픽셀이 전체의 30% 미만이면 Delta 저장
     */
    autoSave() {
        // 이미 저장 중이면 스킵
        if (this.isSaving) {
            return;
        }
        
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        
        // 저장 상태 이벤트 발행 (저장 예정)
        eventBus.emit(EVENTS.PIXEL_UPDATE, { 
            type: 'saveStatus', 
            status: 'pending',
            message: '저장 예정...'
        });
        
        this.saveTimeout = setTimeout(() => {
            // Delta 저장 여부 결정 (전문가 권장: 절대치 + 상대치 조합)
            const totalPixels = this.width * this.height;
            const changedCount = this.changedPixels.size;
            const changedRatio = changedCount / totalPixels;
            
            // 절대치 체크: 400개 이상이면 전체 저장
            // 상대치 체크: 30% 이상이면 전체 저장
            // 둘 다 통과하면 Delta 저장
            const useDelta = changedCount > 0 && 
                           changedCount < this.DELTA_SAVE_THRESHOLD_ABSOLUTE && 
                           changedRatio < this.DELTA_SAVE_THRESHOLD_RATIO;
            
            this.save(useDelta);
        }, this.saveDelay);
    }
    
    /**
     * 저장 (무조건 Firebase에 저장)
     * Delta 저장 모드: 변경된 픽셀만 저장 (선택적)
     */
    async save(useDelta = false) {
        if (!this.territoryId) return;
        
        // 이미 저장 중이면 스킵
        if (this.isSaving) {
            log.debug('[PixelCanvas3] Already saving, skipping...');
            return;
        }
        
        // ⚠️ CRITICAL: 저장 전 소유권 검증 (편집 중 소유권 변경 감지)
        const { territoryManager } = await import('./TerritoryManager.js');
        const { firebaseService } = await import('../services/FirebaseService.js');
        const currentUser = firebaseService.getCurrentUser();
        
        if (currentUser) {
            const territory = territoryManager.getTerritory(this.territoryId);
            if (territory) {
                // Firestore에서 최신 소유권 확인 (캐시 불일치 방지)
                try {
                    const latestTerritory = await apiService.getTerritory(this.territoryId);
                    if (latestTerritory) {
                        // 소유권이 변경되었는지 확인
                        if (latestTerritory.ruler && latestTerritory.ruler !== currentUser.uid) {
                            log.error(`[PixelCanvas3] ❌ Ownership changed! Territory ${this.territoryId} is now owned by ${latestTerritory.ruler}, not ${currentUser.uid}`);
                            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                                type: 'error',
                                message: '⚠️ 이 영토의 소유권이 변경되었습니다. 편집할 수 없습니다.'
                            });
                            eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                                type: 'saveStatus', 
                                status: 'error',
                                error: 'Ownership changed',
                                message: '소유권이 변경되어 저장할 수 없습니다'
                            });
                            throw new Error('Territory ownership changed during editing');
                        }
                        
                        // 로컬 캐시도 업데이트
                        territory.ruler = latestTerritory.ruler;
                        territory.rulerName = latestTerritory.rulerName;
                        territory.sovereignty = latestTerritory.sovereignty;
                    }
                } catch (error) {
                    if (error.message && error.message.includes('Ownership changed')) {
                        throw error; // 소유권 변경 에러는 전파
                    }
                    log.warn('[PixelCanvas3] Failed to verify ownership, proceeding with save:', error);
                }
            }
        }
        
        this.isSaving = true;
        
        try {
            // 저장 시작 이벤트
            eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                type: 'saveStatus', 
                status: 'saving',
                message: '저장 중...'
            });
            
            let pixelData;
            
            // Delta 저장은 최근 전체 저장(snapshot) 기준으로만 diff
            // 전문가 권장: 두 번 연속 Delta 저장 시 병합 문제 방지
            if (useDelta && this.changedPixels.size > 0 && this.lastFullSaveTime !== null) {
                // Delta 저장: 변경된 픽셀만 인코딩 (lastSavedPixels 기준)
                const changedPixelsArray = [];
                for (const key of this.changedPixels) {
                    const pixel = this.pixels.get(key);
                    const lastSavedPixel = this.lastSavedPixels.get(key);
                    
                    // 현재 픽셀과 마지막 저장 시점의 픽셀 비교
                    if (pixel) {
                        const [x, y] = key.split(',').map(Number);
                        // 마지막 저장과 다르면 변경으로 기록
                        if (!lastSavedPixel || lastSavedPixel.color !== pixel.color) {
                            changedPixelsArray.push({
                                x, y,
                                c: pixel.color,
                                u: pixel.userId,
                                t: pixel.timestamp
                            });
                        }
                    } else if (lastSavedPixel) {
                        // 삭제된 픽셀 (마지막 저장에는 있었지만 현재는 없음)
                        const [x, y] = key.split(',').map(Number);
                        changedPixelsArray.push({
                            x, y,
                            c: null, // 삭제 표시
                            u: null,
                            t: Date.now()
                        });
                    }
                }
                
                pixelData = {
                    territoryId: this.territoryId,
                    pixels: changedPixelsArray,
                    filledPixels: this.pixels.size,
                    width: this.width,
                    height: this.height,
                    bounds: this.territoryBounds,
                    isDelta: true, // Delta 저장 플래그
                    changedCount: changedPixelsArray.length,
                    baseSnapshotTime: this.lastFullSaveTime // 기준 snapshot 시각
                };
            } else {
                // 전체 저장: 모든 픽셀 저장
                pixelData = {
                    territoryId: this.territoryId,
                    pixels: this.encodePixels(),
                    filledPixels: this.pixels.size,
                    width: this.width,
                    height: this.height,
                    bounds: this.territoryBounds,
                    isDelta: false
                };
            }
            
            // 무조건 Firebase에 저장 (debounce 없이 즉시)
            // Delta 저장 실패 시 전체 저장으로 fallback (전문가 권장)
            try {
                await pixelDataService.savePixelDataImmediate(this.territoryId, pixelData);
            } catch (error) {
                // Delta 저장 실패 시 전체 저장으로 fallback
                if (useDelta && pixelData.isDelta) {
                    log.warn('[PixelCanvas3] Delta save failed, falling back to full save:', error);
                    pixelData = {
                        territoryId: this.territoryId,
                        pixels: this.encodePixels(),
                        filledPixels: this.pixels.size,
                        width: this.width,
                        height: this.height,
                        bounds: this.territoryBounds,
                        isDelta: false
                    };
                    await pixelDataService.savePixelDataImmediate(this.territoryId, pixelData);
                } else {
                    throw error; // 전체 저장도 실패하면 에러 전파
                }
            }
            
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
                
                // 모바일에서도 맵에 즉시 반영되도록 추가 이벤트 발행
                // 편집기 모달이 열려있어도 맵 업데이트가 실행되도록 보장
                eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                    territoryId: this.territoryId,
                    territory: {
                        ...territory,
                        pixelCanvas: metadata.pixelCanvas,
                        territoryValue: metadata.territoryValue,
                        sourceId: territory.sourceId,
                        featureId: territory.featureId
                    }
                });
                
                log.info(`[PixelCanvas3] Emitted TERRITORY_UPDATE event for ${this.territoryId} to ensure map refresh`);
            }
            
            this.lastSavedState = JSON.stringify(this.encodePixels());
            this.hasUnsavedChangesFlag = false;
            this.lastSaveTime = Date.now();
            
            // 저장 후 변경 추적 초기화 및 snapshot 업데이트
            // 전문가 권장: 전체 저장 시에만 snapshot 업데이트
            if (!useDelta || !pixelData.isDelta) {
                // 전체 저장 시 snapshot 업데이트
                this.lastSavedPixels.clear();
                for (const [key, pixel] of this.pixels.entries()) {
                    this.lastSavedPixels.set(key, { ...pixel });
                }
                this.lastFullSaveTime = Date.now();
                this.changedPixels.clear();
            } else {
                // Delta 저장 시에는 snapshot 유지, 변경 추적만 초기화
                this.changedPixels.clear();
            }
            
            // Firebase 저장 완료 후 세션 삭제 (저장된 작업은 세션에 보관할 필요 없음)
            await localCacheService.clearSession(this.territoryId);
            
            // 저장 후 캐시 무효화하여 다음 로드 시 최신 데이터를 가져오도록 보장
            // 모바일에서 편집 후 저장했을 때 맵에 즉시 반영되도록 하는 핵심 로직
            pixelDataService.clearMemoryCache(this.territoryId);
            log.info(`[PixelCanvas3] Cleared memory cache for ${this.territoryId} after save`);
            
            // 저장 완료 이벤트
            const saveTime = new Date(this.lastSaveTime).toLocaleTimeString('ko-KR', { 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            });
            
            eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                type: 'saveStatus', 
                status: 'saved',
                message: `저장됨 · ${saveTime}`,
                saveTime: this.lastSaveTime
            });
            // ⚠️ 핵심 수정: territoryId를 포함하여 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_DATA_SAVED, {
                territoryId: this.territoryId,
                filledPixels: this.pixels.size
            });
            
            log.info(`[PixelCanvas3] Saved ${this.pixels.size} pixels to Firebase`);
        } catch (error) {
            log.error('[PixelCanvas3] Save failed:', error);
            eventBus.emit(EVENTS.PIXEL_UPDATE, { 
                type: 'saveStatus', 
                status: 'error',
                error: error.message,
                message: '저장 실패'
            });
            
            // 사용자에게 알림
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '저장에 실패했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.'
            });
            
            throw error;
        } finally {
            this.isSaving = false;
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
            // 자동저장 제거 - 수동 저장만 사용
            // this.autoSave();
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
            // 자동저장 제거 - 수동 저장만 사용
            // this.autoSave();
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
        // 자동저장 제거 - 수동 저장만 사용
        // this.autoSave();
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
        // 저장 중이면 완료될 때까지 대기
        if (this.isSaving) {
            log.debug('[PixelCanvas3] Waiting for save to complete before cleanup...');
            // 저장 완료를 기다리지 않고 타임아웃 설정
            setTimeout(() => {
                if (this.isSaving) {
                    log.warn('[PixelCanvas3] Save timeout, forcing cleanup');
                    this.isSaving = false;
                }
            }, 5000);
        }
        
        // 소유권 변경 리스너 제거
        if (this.ownershipChangeListener) {
            eventBus.off(EVENTS.TERRITORY_UPDATE, this.ownershipChangeListener);
            this.ownershipChangeListener = null;
        }
        
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
        this.isSaving = false;
        this.lastSaveTime = null;
        this.originalOwnerId = null;
        
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        
        // 세션 저장 인터벌 제거
        if (this.sessionSaveInterval) {
            clearInterval(this.sessionSaveInterval);
            this.sessionSaveInterval = null;
        }
        
        // 정리 전에 마지막 세션 저장
        if (this.territoryId && this.pixels.size > 0) {
            this.saveSession();
        }
    }
}

export const pixelCanvas3 = new PixelCanvas3();
export default pixelCanvas3;
