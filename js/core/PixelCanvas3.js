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
import { TerritoryMask } from './TerritoryMask.js';

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
        this.width = CONFIG.TERRITORY.PIXEL_GRID_SIZE; // 128
        this.height = CONFIG.TERRITORY.PIXEL_GRID_SIZE; // 128
        this.gridVersion = CONFIG.TERRITORY.GRID_VERSION; // 2 (128×128)
        this.basePixelSize = 8; // 기본 픽셀 크기
        this.pixelSize = 8; // 현재 픽셀 크기 (줌에 따라 변경)
        
        // 타일 시스템 (128×128 타일 기반 아키텍처)
        this.tileSize = CONFIG.TERRITORY.TILE_SIZE; // 16 (타일 크기, 고정)
        this.tilesX = Math.floor(this.width / this.tileSize); // 8 (가로 타일 수: 128 / 16)
        this.tilesY = Math.floor(this.height / this.tileSize); // 8 (세로 타일 수: 128 / 16)
        
        // 타일 캐시
        this.tileCache = new Map(); // tileId -> TileData
        this.tileRevisionMap = new Map(); // tileId -> revision (클라이언트가 가진 리비전)
        
        // Dirty tiles 추적
        this.dirtyTiles = new Set(); // 변경된 타일 ID 목록
        this.pixelsMap = new Map(); // 현재 픽셀 상태 (타일 시스템용) - ⚠️ 불변식: constructor에서 항상 생성
        this.previousPixelsMap = new Map(); // 이전 상태 (dirty 계산용)
        
        // 영토 메타데이터
        this.territoryMetadata = null;
        
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
        
        // 배경 설정
        this.backgroundMode = 'solid'; // 'solid' | 'checker'
        this.backgroundColor = '#1a1a1a';
        this.checkerSize = 8;
        
        // 마지막 편집 타입 (히스토리용)
        this.lastEditType = 'paint';
        
        // ⚠️ 레거시 모드 플래그: 타일 저장 경로 혼합 방지
        this.isLegacyMode = false; // true면 레거시 저장만 사용, false면 타일 저장 시도
        
        // ⚠️ 재동기화 추적: invalid payload 무시 시 자동 복구용
        this.needsResyncTiles = new Set(); // 재동기화가 필요한 tileId 목록
        this.resyncTimer = null; // 재동기화 타이머
    }
    
    /**
     * 타일 ID 계산
     * @param {number} x - 픽셀 X 좌표
     * @param {number} y - 픽셀 Y 좌표
     * @returns {string} 타일 ID (예: "korea-seoul:0:0")
     */
    getTileId(x, y) {
        if (!this.territoryId) return null;
        const tileX = Math.floor(x / this.tileSize);
        const tileY = Math.floor(y / this.tileSize);
        return `${this.territoryId}:${tileX}:${tileY}`;
    }
    
    /**
     * 타일 좌표 계산
     * @param {string} tileId - 타일 ID
     * @returns {{tileX: number, tileY: number} | null}
     */
    getTileCoords(tileId) {
        if (!tileId) return null;
        const parts = tileId.split(':');
        if (parts.length !== 3) return null;
        return {
            tileX: parseInt(parts[1]),
            tileY: parseInt(parts[2])
        };
    }
    
    /**
     * Dirty tiles 계산 (픽셀 비교 방식)
     * @returns {Set<string>} 변경된 타일 ID 목록
     */
    calculateDirtyTiles() {
        const dirtyTiles = new Set();
        
        // ⚠️ 안전성 체크: pixelsMap과 previousPixelsMap이 존재하는지 확인
        if (!this.pixelsMap || !this.previousPixelsMap) {
            console.warn('[PixelCanvas3] calculateDirtyTiles: pixelsMap or previousPixelsMap is undefined, returning empty set');
            return dirtyTiles;
        }
        
        // 현재 픽셀과 이전 픽셀 비교
        const allKeys = new Set([
            ...this.pixelsMap.keys(),
            ...this.previousPixelsMap.keys()
        ]);
        
        for (const key of allKeys) {
            const currentColor = this.pixelsMap.get(key);
            const previousColor = this.previousPixelsMap.get(key);
            
            // 색상이 변경되었거나 추가/삭제된 경우
            if (currentColor !== previousColor) {
                const [x, y] = key.split(',').map(Number);
                const tileId = this.getTileId(x, y);
                if (tileId) {
                    dirtyTiles.add(tileId);
                }
            }
        }
        
        return dirtyTiles;
    }
    
    /**
     * 타일 추출 (dirty tiles에서 픽셀 데이터 추출)
     * @param {Set<string>} dirtyTiles - 변경된 타일 ID 목록
     * @returns {Array<{tileId: string, pixels: Array, revision: number}>}
     */
    extractTiles(dirtyTiles) {
        const tiles = [];
        
        for (const tileId of dirtyTiles) {
            const coords = this.getTileCoords(tileId);
            if (!coords) continue;
            
            const { tileX, tileY } = coords;
            
            // 타일 영역의 픽셀만 추출
            const pixels = [];
            const startX = tileX * this.tileSize;
            const startY = tileY * this.tileSize;
            const endX = startX + this.tileSize;
            const endY = startY + this.tileSize;
            
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const key = `${x},${y}`;
                    const color = this.pixelsMap.get(key);
                    if (color) {
                        // Sparse 표현: 실제 픽셀만 저장
                        pixels.push({x, y, color});
                    }
                }
            }
            
            // 클라이언트가 가진 리비전 (충돌 감지용)
            const revision = this.tileRevisionMap.get(tileId) || 0;
            
            tiles.push({
                tileId,
                pixels,
                revision
            });
        }
        
        return tiles;
    }
    
    /**
     * 타일 스냅샷 생성 (히스토리용)
     * @param {string} tileId - 타일 ID
     * @param {Map<string, string>} pixelsMap - 픽셀 맵
     * @returns {Object | null} 타일 데이터 또는 null (비어있는 경우)
     */
    getTileSnapshot(tileId, pixelsMap) {
        const coords = this.getTileCoords(tileId);
        if (!coords) return null;
        
        const { tileX, tileY } = coords;
        
        const pixels = [];
        const startX = tileX * this.tileSize;
        const startY = tileY * this.tileSize;
        const endX = startX + this.tileSize;
        const endY = startY + this.tileSize;
        
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const key = `${x},${y}`;
                const color = pixelsMap.get(key);
                if (color) {
                    pixels.push({x, y, color});
                }
            }
        }
        
        // 비어있는 타일은 null 반환
        if (pixels.length === 0) {
            return null;
        }
        
        return {
            tileId,
            pixels,
            revision: this.tileRevisionMap.get(tileId) || 0
        };
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
        
        // ⚠️ 픽셀 표시 캔버스는 무조건 nearest-neighbor (스무딩 OFF)
        this.ctx.imageSmoothingEnabled = false;
        
        // 캔버스 래퍼 찾기
        this.wrapper = this.canvas.parentElement;
        
        // territory 객체 저장
        this.territory = territory || territoryManager.getTerritory(territoryId);
        
        // ⚠️ CRITICAL: 소유권 변경 감지 리스너 설정
        this.setupOwnershipChangeListener();
        
        // 영토 경계 가져오기
        await this.loadTerritoryGeometry();
        
        // ⚠️ 불변식: 캔버스 좌표계는 initialize에서 1회만 고정
        // gridVersion이 2로 고정된 이상, 캔버스 크기/스케일은 여기서만 설정
        // metadata는 나중에 들어와도 "동기화 정보(tileRevisionMap)"로만 반영하고,
        // 캔버스 좌표계/스케일은 절대 재설정하지 않음 (깜빡임/재초기화 방지)
        const dpr = window.devicePixelRatio || 1;
        const baseSize = this.width * this.basePixelSize;
        
        // 실제 픽셀 크기 (DPR 반영)
        this.canvas.width = baseSize * dpr;
        this.canvas.height = baseSize * dpr;
        
        // CSS 표시 크기
        this.canvas.style.width = `${baseSize}px`;
        this.canvas.style.height = `${baseSize}px`;
        
        // 컨텍스트 스케일 조정
        this.ctx.scale(dpr, dpr);
        
        // ⚠️ 스케일 후에도 스무딩 OFF 유지
        this.ctx.imageSmoothingEnabled = false;
        
        // 배경 및 경계선 그리기
        this.drawBackground();
        this.drawTerritoryBoundary();
        
        // ⚠️ 레거시 모드 플래그 초기화 (새 영토 로드 시)
        this.isLegacyMode = false;
        
        // 데이터 로드 (타일 기반)
        // ⚠️ metadata는 여기서 로드되지만, 캔버스 좌표계는 이미 위에서 고정됨
        await this.loadTiles();
        
        // 이벤트 리스너
        this.setupEvents();
        
        // 터치 이벤트 설정 (모바일)
        this.setupTouchEvents();
        
        // 미완성 세션 확인 및 복원
        await this.checkAndRestoreSession();
        
        // ⚠️ 핵심: 픽셀 데이터 로드 완료 후 반드시 렌더링
        // loadTiles()가 완료되었으므로 pixels 데이터가 준비되어 있음
        this.render();
        
        // ⚠️ 추가 안전장치: 픽셀이 로드되었는지 확인하고 없으면 경고
        if (this.pixels.size === 0) {
            log.warn(`[PixelCanvas3] ⚠️ No pixels to render for ${this.territoryId} - canvas will show empty territory`);
        }
        
        // 초기 줌 설정 (영토가 전체 보이도록)
        this.fitToView();
        
        // ⚠️ 핵심: fitToView() 후 한 번 더 렌더링 (줌/패닝 변경 후 픽셀이 보이도록)
        // fitToView()가 transform을 변경하므로 재렌더링 필요
        this.render();
        
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
                        // TerritoryMask 클래스 사용
                        this.territoryMask = new TerritoryMask(
                            feature.geometry,
                            this.territoryBounds,
                            this.width,
                            this.height
                        );
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
     * 영토 경계 마스크 생성 (레거시 호환성용, TerritoryMask 클래스로 대체됨)
     * @deprecated TerritoryMask 클래스를 직접 사용하세요
     */
    createTerritoryMask(geometry) {
        // 레거시 호환성을 위해 Set 반환 (내부적으로는 TerritoryMask 사용)
        if (!this.territoryBounds) return new Set();
        
        const mask = new TerritoryMask(geometry, this.territoryBounds, this.width, this.height);
        return mask.mask; // Set 반환
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
        // 캔버스가 초기화되지 않았으면 스킵
        if (!this.ctx) return;
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
     * 배경 설정
     */
    setBackground(mode, color, checkerSize = 8) {
        this.backgroundMode = mode;
        this.backgroundColor = color;
        this.checkerSize = checkerSize;
    }
    
    /**
     * 영토 마스크 배경 그리기 (스탬프 프리뷰용)
     * 영토 밖 영역을 반투명으로 딤 처리하여 지형 모양 표시
     * @param {CanvasRenderingContext2D} ctx - 렌더링할 컨텍스트
     * @param {number} pixelSize - 픽셀 크기 (확대 배율)
     */
    /**
     * 영토 마스크 딤 처리 (월드 좌표로만 그리기)
     * 
     * ⚠️ 핵심 원칙:
     * - 이 함수는 월드 셀 단위(1×1)로만 그리는 함수
     * - viewTransform 적용은 호출자가 ctx 스택으로 해결
     * - pixelSize 파라미터는 제거 (월드 좌표계만 사용)
     * 
     * 사용 예:
     * ```javascript
     * ctx.save();
     * ctx.translate(viewTransform.tx, viewTransform.ty);
     * ctx.scale(viewTransform.scale, viewTransform.scale);
     * pixelCanvas3.drawTerritoryMaskBackdrop(ctx);
     * ctx.restore();
     * ```
     */
    /**
     * 영토 마스크 딤 처리 (outside-only, 낮은 alpha)
     * 
     * ⚠️ 핵심 원칙:
     * - outside-only: 영토 밖 영역만 딤 처리 (Base Pixels를 절대 가리지 않음)
     * - 낮은 alpha: Base Pixels가 잘 보이도록 alpha를 낮게 설정
     * - 이미지 업로드 프리뷰에서만 사용 (일반 render()에서는 호출하지 않음)
     * 
     * 사용 예:
     * ```javascript
     * ctx.save();
     * ctx.translate(viewTransform.tx, viewTransform.ty);
     * ctx.scale(viewTransform.scale, viewTransform.scale);
     * pixelCanvas3.drawTerritoryMaskBackdrop(ctx);
     * ctx.restore();
     * ```
     */
    drawTerritoryMaskBackdrop(ctx) {
        const W = this.width;
        const H = this.height;
        
        ctx.save();
        ctx.globalAlpha = 0.25; // ⚠️ 낮은 alpha (기존 0.45 → 0.25) - Base Pixels를 가리지 않도록
        
        // ⚠️ outside-only: 영토 밖 영역만 딤 처리
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                if (!this.isInsideTerritory(x, y)) {
                    ctx.fillStyle = '#000'; // 바깥 딤
                    ctx.fillRect(x, y, 1, 1); // 월드 좌표계 (셀 단위)
                }
                // ⚠️ inside 영역은 그리지 않음 (Base Pixels를 가리지 않도록)
            }
        }
        
        ctx.restore();
    }
    
    /**
     * 배경 그리기
     */
    drawBackground() {
        // 캔버스가 초기화되지 않았으면 스킵
        if (!this.ctx) return;
        
        const size = this.basePixelSize;
        
        if (this.backgroundMode === 'checker') {
            // 체커보드 배경
            const checkerColor1 = '#e0e0e0';
            const checkerColor2 = '#c0c0c0';
            const checkerPixelSize = this.checkerSize;
            
            for (let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    const key = `${x},${y}`;
                    const isInside = !this.territoryMask || this.territoryMask.has(key);
                    
                    if (isInside) {
                        const checkerX = Math.floor(x / checkerPixelSize);
                        const checkerY = Math.floor(y / checkerPixelSize);
                        const isCheckerLight = (checkerX + checkerY) % 2 === 0;
                        this.ctx.fillStyle = isCheckerLight ? checkerColor1 : checkerColor2;
                    } else {
                        this.ctx.fillStyle = '#0a0a0a';
                    }
                    this.ctx.fillRect(x * size, y * size, size, size);
                }
            }
        } else {
            // 단색 배경
            for (let y = 0; y < this.height; y++) {
                for (let x = 0; x < this.width; x++) {
                    const key = `${x},${y}`;
                    const isInside = !this.territoryMask || this.territoryMask.has(key);
                    
                    if (isInside) {
                        this.ctx.fillStyle = this.backgroundColor;
                    } else {
                        // 영토 밖은 어둡게
                        this.ctx.fillStyle = '#0a0a0a';
                    }
                    this.ctx.fillRect(x * size, y * size, size, size);
                }
            }
        }
    }
    
    /**
     * 데이터 로드
     */
    /**
     * 타일 기반 로드 (128×128 아키텍처)
     * ⚠️ 핵심 개선: PixelDataService 메모리 캐시 우선 사용
     */
    async loadTiles() {
        try {
            // ⚠️ 우선순위 1: 메모리 캐시 확인 (맵 렌더러가 이미 로드한 데이터 재사용)
            const cachedData = pixelDataService.memoryCache.get(this.territoryId);
            if (cachedData && cachedData.data && cachedData.data.pixels && cachedData.data.pixels.length > 0) {
                log.info(`[PixelCanvas3] Using cached pixel data for ${this.territoryId} (${cachedData.data.pixels.length} pixels)`);
                
                // 캐시된 픽셀 데이터를 pixelsMap에 적용
                this.pixels.clear();
                this.pixelsMap.clear();
                
                for (const pixel of cachedData.data.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (!this.territoryMask || this.territoryMask.has(key)) {
                        const color = pixel.c || pixel.color;
                        if (color) { // null이 아닌 경우만 추가
                            this.pixels.set(key, {
                                color,
                                userId: pixel.u || pixel.userId || 'system',
                                timestamp: pixel.t || pixel.timestamp || Date.now()
                            });
                            this.pixelsMap.set(key, color);
                        }
                    }
                }
                
                // 이전 상태 저장 (dirty 계산용)
                this.previousPixelsMap = new Map(this.pixelsMap);
                
                // 마지막 저장 시점의 픽셀 상태 저장 (Delta 추적용)
                this.lastSavedPixels.clear();
                for (const [key, pixel] of this.pixels.entries()) {
                    this.lastSavedPixels.set(key, { ...pixel });
                }
                this.changedPixels.clear();
                this.dirtyTiles.clear();
                
                // 캐시된 메타데이터 사용
                if (cachedData.metadata) {
                    this.territoryMetadata = cachedData.metadata;
                    // tileRevisionMap 업데이트
                    if (this.territoryMetadata.tileRevisionMap) {
                        if (!this.tileRevisionMap) {
                            this.tileRevisionMap = new Map();
                        }
                        this.tileRevisionMap.clear();
                        for (const [tileId, revision] of Object.entries(this.territoryMetadata.tileRevisionMap)) {
                            this.tileRevisionMap.set(tileId, parseInt(revision) || 0);
                        }
                    }
                } else {
                    // 메타데이터가 없으면 기본값 설정
                    this.territoryMetadata = {
                        territoryId: this.territoryId,
                        gridVersion: 2,
                        territoryRevision: 0,
                        encodingVersion: 1,
                        tileRevisionMap: {},
                        updatedAt: new Date().toISOString(),
                        ownerId: null
                    };
                }
                
                log.info(`[PixelCanvas3] Loaded ${this.pixels.size} pixels from cache`);
                return; // 캐시 사용 시 서버 요청 스킵
            }
            
            // 2. 캐시가 없으면 서버에서 로드
            // 1. 영토 메타데이터 로드 (실패해도 기본값으로 계속 진행)
            // ⚠️ 운영 안전 정책: metadata는 최적화/동기화용이고, tiles 데이터가 있으면 무조건 화면은 떠야 함
            try {
                this.territoryMetadata = await pixelDataService.loadTerritoryMetadata(this.territoryId);
            } catch (metadataError) {
                log.warn('[PixelCanvas3] Metadata load failed, using defaults:', metadataError);
                // 기본 metadata 설정 (gridVersion=2, tileSize=16, tilesX=8, tilesY=8)
                this.territoryMetadata = {
                    territoryId: this.territoryId,
                    gridVersion: 2,
                    territoryRevision: 0,
                    encodingVersion: 1,
                    tileRevisionMap: {},
                    updatedAt: new Date().toISOString(),
                    ownerId: null
                };
            }
            
            // metadata가 없거나 필수 필드가 없으면 기본값 보장
            if (!this.territoryMetadata) {
                this.territoryMetadata = {
                    territoryId: this.territoryId,
                    gridVersion: 2,
                    territoryRevision: 0,
                    encodingVersion: 1,
                    tileRevisionMap: {},
                    updatedAt: new Date().toISOString(),
                    ownerId: null
                };
            }
            
            // 필수 필드 보장
            if (typeof this.territoryMetadata.gridVersion !== 'number') {
                this.territoryMetadata.gridVersion = 2;
            }
            if (!this.territoryMetadata.tileRevisionMap || typeof this.territoryMetadata.tileRevisionMap !== 'object') {
                this.territoryMetadata.tileRevisionMap = {};
            }
            
            // ⚠️ 불변식: metadata는 "동기화 정보"로만 반영
            // 캔버스 좌표계(width/height/tilesX/tilesY/tileSize)는 initialize에서 이미 고정되었으므로
            // metadata의 gridVersion이나 다른 필드로 인해 재설정하지 않음
            // tileRevisionMap만 업데이트하여 동기화 정보 반영
            if (!this.tileRevisionMap) {
                this.tileRevisionMap = new Map();
            }
            this.tileRevisionMap.clear();
            if (this.territoryMetadata.tileRevisionMap) {
                for (const [tileId, revision] of Object.entries(this.territoryMetadata.tileRevisionMap)) {
                    // revision 타입 정규화: 반드시 number로 변환
                    this.tileRevisionMap.set(tileId, parseInt(revision) || 0);
                }
            }
            
            // 2. 필요한 타일 ID 목록 생성 (모든 타일 또는 뷰포트 기반)
            const allTileIds = [];
            for (let ty = 0; ty < this.tilesY; ty++) {
                for (let tx = 0; tx < this.tilesX; tx++) {
                    const tileId = `${this.territoryId}:${tx}:${ty}`;
                    allTileIds.push(tileId);
                }
            }
            
            // 3. 클라이언트 리비전 맵 생성
            const clientRevisions = {};
            for (const tileId of allTileIds) {
                const revision = this.tileRevisionMap.get(tileId) || 0;
                clientRevisions[tileId] = revision;
            }
            
            // 4. 서버에서 필요한 타일만 요청
            const tilesResponse = await pixelDataService.loadTiles(
                this.territoryId,
                allTileIds,
                clientRevisions
            );
            
            // 5. 타일 데이터를 pixelsMap에 적용
            this.pixels.clear();
            this.pixelsMap.clear();
            // ⚠️ changedPixels 초기화 (undefined 오류 방지)
            if (!this.changedPixels) {
                this.changedPixels = new Set();
            }
            this.changedPixels.clear();
            
            for (const tile of tilesResponse.tiles) {
                // 타일 리비전 업데이트
                this.tileRevisionMap.set(tile.tileId, tile.revision);
                
                // 타일 픽셀 적용
                for (const pixel of tile.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (!this.territoryMask || this.territoryMask.has(key)) {
                        // 레거시 pixels 업데이트
                        this.pixels.set(key, {
                            color: pixel.color,
                            userId: 'system',
                            timestamp: Date.now()
                        });
                        
                        // 새로운 pixelsMap 업데이트
                        this.pixelsMap.set(key, pixel.color);
                    }
                }
            }
            
            // 6. 이전 상태 저장 (dirty 계산용)
            this.previousPixelsMap = new Map(this.pixelsMap);
            
            // 7. 마지막 저장 시점의 픽셀 상태 저장 (Delta 추적용)
            this.lastSavedPixels.clear();
            for (const [key, pixel] of this.pixels.entries()) {
                this.lastSavedPixels.set(key, { ...pixel });
            }
            this.changedPixels.clear();
            this.dirtyTiles.clear();
            
            // ⚠️ 핵심: 픽셀 데이터 로드 완료 확인 및 로깅
            if (this.pixels.size === 0) {
                log.warn(`[PixelCanvas3] ⚠️ No pixels loaded for ${this.territoryId} (${tilesResponse.tiles.length} tiles, but 0 pixels)`);
            } else {
                log.info(`[PixelCanvas3] Loaded ${tilesResponse.tiles.length} tiles (${this.pixels.size} pixels)`);
            }
        } catch (error) {
            log.error('[PixelCanvas3] Tile load failed, falling back to legacy load:', error);
            
            // ⚠️ 순서 중요: 모드 플래그 먼저 설정
            this.isLegacyMode = true;
            
            // ⚠️ 안전성 보장: 모든 컬렉션이 존재하는지 확인하고 초기화
            if (!this.pixelsMap) {
                this.pixelsMap = new Map();
            }
            if (!this.previousPixelsMap) {
                this.previousPixelsMap = new Map();
            }
            if (!this.changedPixels) {
                this.changedPixels = new Set();
            }
            if (!this.dirtyTiles) {
                this.dirtyTiles = new Set();
            }
            if (!this.tileCache) {
                this.tileCache = new Map();
            }
            if (!this.tileRevisionMap) {
                this.tileRevisionMap = new Map();
            }
            if (!this.needsResyncTiles) {
                this.needsResyncTiles = new Set();
            }
            
            // 레거시 로드 실행
            await this.load();
        }
    }
    
    /**
     * 레거시 로드 (64×64 호환성)
     * ⚠️ 주의: 타일 모드 전용 필드(changedPixels, tileCache 등)는 constructor에서 이미 생성되어 있으므로 안전
     * ⚠️ 레거시 모드: 이 메서드가 호출되면 isLegacyMode = true로 설정되어 레거시 저장만 사용
     */
    async load() {
        // ⚠️ 레거시 모드 플래그 설정
        this.isLegacyMode = true;
        
        // ⚠️ 안전성 보장: 모든 컬렉션이 존재하는지 확인하고 초기화
        if (!this.pixelsMap) {
            this.pixelsMap = new Map();
        }
        if (!this.previousPixelsMap) {
            this.previousPixelsMap = new Map();
        }
        if (!this.pixels) {
            this.pixels = new Map();
        }
        
        try {
            const data = await pixelDataService.loadPixelData(this.territoryId);
            if (data?.pixels) {
                this.pixels.clear();
                this.pixelsMap.clear();
                this.previousPixelsMap.clear();
                
                for (const pixel of data.pixels) {
                    const key = `${pixel.x},${pixel.y}`;
                    if (!this.territoryMask || this.territoryMask.has(key)) {
                        // 삭제된 픽셀 (c가 null)은 건너뛰기
                        if (pixel.c === null) {
                            continue;
                        }
                        
                        const color = pixel.c || pixel.color;
                        
                        // 레거시 pixels 업데이트
                        this.pixels.set(key, {
                            color,
                            userId: pixel.u || pixel.userId,
                            timestamp: pixel.t || pixel.timestamp
                        });
                        
                        // 새로운 pixelsMap 업데이트
                        this.pixelsMap.set(key, color);
                    }
                }
                
                // 이전 상태 저장 (dirty 계산용)
                this.previousPixelsMap = new Map(this.pixelsMap);
                
                // 마지막 저장 시점의 픽셀 상태 저장 (Delta 추적용)
                this.lastSavedPixels.clear();
                for (const [key, pixel] of this.pixels.entries()) {
                    this.lastSavedPixels.set(key, { ...pixel });
                }
                this.changedPixels.clear();
                this.dirtyTiles.clear();
                
                log.info(`[PixelCanvas3] Loaded ${this.pixels.size} pixels (legacy mode)`);
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
        
        // WebSocket 타일 업데이트 리스너
        // ⚠️ 중복 등록 방지: 기존 리스너가 있으면 먼저 제거
        if (this.tileUpdateListener) {
            eventBus.off('pixel:tiles:updated', this.tileUpdateListener);
            this.tileUpdateListener = null;
        }
        // ⚠️ WebSocket 리스너 설정 (함수 레퍼런스 저장 필수 - cleanup에서 제거용)
        this.tileUpdateListener = (data) => {
            // territoryId 검증은 handleTileUpdates 내부에서도 수행하지만, 여기서도 빠른 필터링
            if (data && data.territoryId === this.territoryId && data.updatedTiles) {
                this.handleTileUpdates(data.updatedTiles);
            }
        };
        eventBus.on('pixel:tiles:updated', this.tileUpdateListener);
        
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
     * 픽셀 삭제 (명시적 API)
     */
    clearPixel(x, y) {
        if (!this.isInsideTerritory(x, y)) return;
        
        const key = `${x},${y}`;
        if (this.pixels.has(key)) {
            // Delta 추적: 삭제된 픽셀도 변경으로 기록
            this.changedPixels.add(key);
            this.pixels.delete(key);
            
            // 새로운 pixelsMap 업데이트
            this.pixelsMap.delete(key);
            
            // Dirty tile 추적 (실시간)
            const tileId = this.getTileId(x, y);
            this.dirtyTiles.add(tileId);
            
            this.hasUnsavedChangesFlag = true;
            this.drawPixelOnCanvas(x, y, null);
            this.updateStats();
        }
    }
    
    /**
     * 브러시 스트로크 적용 (브러시/지우개 공통 엔진)
     * @param {number} x - 중심 X 좌표
     * @param {number} y - 중심 Y 좌표
     * @param {string} mode - 'paint' 또는 'erase'
     */
    applyBrushStroke(x, y, mode = 'paint') {
        if (!this.isInsideTerritory(x, y)) return;
        
        if (this.brushSize === 1) {
            // 단일 픽셀
            if (mode === 'erase') {
                this.clearPixel(x, y);
            } else {
                this.setPixel(x, y, this.color);
            }
        } else {
            // 반경 기반 브러시 (원형)
            const radius = Math.floor(this.brushSize / 2);
            const radiusSquared = radius * radius;
            
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    // 원형 마스크: 거리 체크 (sqrt 제거, r² 방식)
                    if (dx * dx + dy * dy > radiusSquared) continue;
                    
                    const nx = x + dx;
                    const ny = y + dy;
                    
                    if (this.isValidPos(nx, ny) && this.isInsideTerritory(nx, ny)) {
                        if (mode === 'erase') {
                            this.clearPixel(nx, ny);
                        } else {
                            this.setPixel(nx, ny, this.color);
                        }
                    }
                }
            }
        }
    }
    
    /**
     * 픽셀 그리기 (브러시/지우개 공통)
     */
    drawPixel(x, y) {
        if (this.tool === TOOLS.ERASER) {
            this.applyBrushStroke(x, y, 'erase');
        } else if (this.tool === TOOLS.BRUSH) {
            this.applyBrushStroke(x, y, 'paint');
        }
    }
    
    /**
     * 픽셀 설정
     */
    /**
     * 픽셀 설정 (실시간 dirtyTiles 추적)
     * ⚠️ 최적화: previousPixelsMap 전체 복사 대신 실시간 추적
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
        
        // 레거시 pixels 업데이트
        this.pixels.set(key, {
            color,
            userId: user?.uid || 'anonymous',
            timestamp: Date.now()
        });
        
        // 새로운 pixelsMap 업데이트 (타일 시스템용)
        if (color) {
            this.pixelsMap.set(key, color);
        } else {
            this.pixelsMap.delete(key);
        }
        
        // Dirty tile 추적 (실시간)
        const tileId = this.getTileId(x, y);
        this.dirtyTiles.add(tileId);
        
        this.hasUnsavedChangesFlag = true;
        this.drawPixelOnCanvas(x, y, color);
        this.updateStats();
    }
    
    /**
     * 캔버스에 픽셀 그리기
     * color === null이면 배경색으로 그리기 (삭제된 픽셀)
     */
    drawPixelOnCanvas(x, y, color) {
        // 캔버스가 초기화되지 않았으면 스킵
        if (!this.ctx) return;
        
        const size = this.basePixelSize;
        
        if (color === null) {
            // 삭제된 픽셀: 배경색으로 그리기 (배경 설정 반영)
            const key = `${x},${y}`;
            const isInside = !this.territoryMask || this.territoryMask.has(key);
            
            if (!isInside) {
                // 영토 밖은 어둡게
                this.ctx.fillStyle = '#0a0a0a';
            } else if (this.backgroundMode === 'checker') {
                // 체커보드 배경
                const checkerColor1 = '#e0e0e0';
                const checkerColor2 = '#c0c0c0';
                const checkerPixelSize = this.checkerSize;
                const checkerX = Math.floor(x / checkerPixelSize);
                const checkerY = Math.floor(y / checkerPixelSize);
                const isCheckerLight = (checkerX + checkerY) % 2 === 0;
                this.ctx.fillStyle = isCheckerLight ? checkerColor1 : checkerColor2;
            } else {
                // 단색 배경
                this.ctx.fillStyle = this.backgroundColor || '#1a1a1a';
            }
        } else {
            // 픽셀 색상
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
     * 렌더링 (3 레이어 구조로 고정)
     * 
     * 레이어 순서 (절대 변경 금지):
     * 1. Base Pixels (필수, 정적) - 맵에서 보이던 픽셀 데이터
     * 2. Territory Mask/Guide (정적) - dim, 경계선, 그리드 (Base를 가리지 않음)
     * 3. Tool Overlay (동적) - 스탬프 프리뷰, transform box 등
     */
    render() {
        // 캔버스가 초기화되지 않았으면 스킵
        if (!this.ctx) return;
        
        // ⚠️ 픽셀 표시 캔버스는 무조건 nearest-neighbor (스무딩 OFF)
        this.ctx.imageSmoothingEnabled = false;
        
        // ===== 레이어 1: Base Pixels (필수) =====
        // 배경 먼저 그리기 (픽셀이 없는 영역용)
        this.drawBackground();
        
        // 픽셀 데이터 그리기 (맵에서 보이던 그 픽셀들)
        for (const [key, pixel] of this.pixels.entries()) {
            const [x, y] = key.split(',').map(Number);
            this.drawPixelOnCanvas(x, y, pixel.color);
        }
        
        // ===== 레이어 2: Territory Mask/Guide (정적) =====
        // 경계선 그리기 (픽셀 위에 표시)
        this.drawTerritoryBoundary();
        
        // ⚠️ 주의: drawTerritoryMaskBackdrop()은 이미지 업로드 프리뷰에서만 사용
        // 일반 렌더링에서는 호출하지 않음 (Base Pixels를 가리지 않도록)
        
        // ===== 레이어 3: Tool Overlay (동적) =====
        // 스탬프 프리뷰, transform box 등은 별도 메서드에서 처리
        // (이미지 업로드 기능 구현 시 추가)
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
        
        // ⚠️ 진단용: saveRunId 생성 (tiles/legacy 모두 동일한 ID 사용)
        const saveRunId = `save-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        log.info(`[PixelCanvas3] 🔍 Save started`, {
            saveRunId,
            territoryId: this.territoryId,
            isLegacyMode: this.isLegacyMode
        });
        
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
            
            // ⚠️ 핵심 안전장치: tiles 저장 시도 전에 전체 픽셀 데이터 백업
            // tiles 실패 시 빈 payload로 덮어쓰는 것을 방지하기 위해 전체 데이터 백업
            const encoded = this.encodePixels();
            const backupPixelData = {
                territoryId: this.territoryId,
                pixels: encoded, // 전체 픽셀 데이터 (항상 전체 저장용)
                filledPixels: this.pixels.size,
                width: this.width,
                height: this.height,
                bounds: this.territoryBounds,
                isDelta: false // 백업은 항상 전체 저장
            };
            
            // ⚠️ 체크 A: encodePixels()가 "전체 픽셀"을 항상 내보내는지 검증
            log.info('[PixelCanvas3] 🔒 Backup created', {
                canvasPixels: this.pixels.size,
                encodedPixels: encoded?.length || 0,
                isDelta: false,
                territoryId: this.territoryId
            });
            
            // ⚠️ 체크 B: encodePixels() 검증 실패 시 에러
            if (this.pixels.size > 0 && (encoded?.length || 0) === 0) {
                log.error('[PixelCanvas3] ❌ CRITICAL: encodePixels() returned empty array but canvas has pixels!', {
                    canvasPixels: this.pixels.size,
                    encodedPixels: encoded?.length || 0,
                    territoryId: this.territoryId
                });
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: '❌ 저장 실패: 내부 데이터 인코딩 오류가 발생했습니다. 페이지를 새로고침하고 다시 시도해주세요.',
                    duration: 10000
                });
                throw new Error('encodePixels() returned empty array but canvas has pixels - encoding logic error');
            }
            
            // ⚠️ 빈 payload로 덮어쓰기 방지: 강화된 검증
            const hasPixelsOnCanvas = this.pixels.size > 0;
            const hasPixelsInPayload = (pixelData.pixels?.length || 0) > 0;
            
            // 1) 캔버스에 픽셀 있는데 payload가 비면 = 절대 저장하면 안 됨 (데이터 유실 방지)
            if (hasPixelsOnCanvas && !hasPixelsInPayload) {
                log.error('[PixelCanvas3] ❌ Refusing to save: canvas has pixels but payload is empty', {
                    canvasPixels: this.pixels.size,
                    payloadPixels: pixelData.pixels?.length || 0,
                    pixelDataType: pixelData.isDelta ? 'delta' : 'full',
                    territoryId: this.territoryId
                });
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: '❌ 저장 실패: 내부 데이터 불일치(캔버스에는 픽셀이 있는데 전송 데이터가 비었습니다). 새로고침 후 다시 시도해주세요.',
                    duration: 10000
                });
                throw new Error('Refusing to save: canvas has pixels but payload is empty');
            }
            
            // 2) 캔버스도 비고 payload도 비면 저장할 필요 없음
            if (!hasPixelsOnCanvas && !hasPixelsInPayload) {
                log.warn('[PixelCanvas3] ⚠️ Refusing to save: canvas and payload are both empty');
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: '⚠️ 저장할 픽셀이 없습니다.'
                });
                return;
            }
            
            // ⚠️ 저장 경로 분리: 레거시 모드면 타일 저장 시도하지 않음
            if (this.isLegacyMode) {
                // 레거시 저장만 사용
                // ⚠️ 안전장치: payload가 비어있으면 백업 데이터 사용
                const finalPixelData = (pixelData.pixels?.length || 0) > 0 ? pixelData : backupPixelData;
                await pixelDataService.savePixelDataImmediate(this.territoryId, finalPixelData);
            } else {
                // 타일 기반 저장 (128×128 아키텍처)
                try {
            // ⚠️ 최적화: 실시간 추적된 dirtyTiles 사용 (전체 비교 최소화)
            const dirtyTiles = this.dirtyTiles.size > 0 
                ? new Set(this.dirtyTiles) 
                : this.calculateDirtyTiles();
                    
                    if (dirtyTiles.size > 0) {
                    // 2. 타일 추출
                    const tiles = this.extractTiles(dirtyTiles);
                    
                    // 3. 타일 저장
                    const saveResult = await pixelDataService.saveTiles(this.territoryId, tiles);
                    
                    // 4. 타일 리비전 업데이트 (성공한 타일만)
                    for (const updatedTile of saveResult.updatedTiles || []) {
                        this.tileRevisionMap.set(updatedTile.tileId, updatedTile.revision);
                        this.dirtyTiles.delete(updatedTile.tileId); // 성공한 타일은 dirty에서 제거
                    }
                    
                    // 5. 이전 상태 업데이트 (성공 시에만 클리어)
                    // 단, conflict가 있으면 conflict 타일은 dirty에 남겨둠
                    this.previousPixelsMap = new Map(this.pixelsMap);
                    // dirtyTiles는 conflict 처리 후에만 클리어
                    
                    // 6. 영토 메타데이터 업데이트
                    if (saveResult.territoryRevision) {
                        if (!this.territoryMetadata) {
                            this.territoryMetadata = await pixelDataService.loadTerritoryMetadata(this.territoryId);
                        }
                        this.territoryMetadata.territoryRevision = saveResult.territoryRevision;
                        for (const updatedTile of saveResult.updatedTiles) {
                            this.territoryMetadata.tileRevisionMap[updatedTile.tileId] = updatedTile.revision;
                        }
                    }
                    
                    // 충돌 처리 (최적화: conflict 타일만 재동기화 후 재시도)
                    if (saveResult.conflicts && saveResult.conflicts.length > 0) {
                        log.warn('[PixelCanvas3] ⚠️ Tile conflicts detected:', saveResult.conflicts.length, 'tiles');
                        
                        try {
                            // 1. Conflict 타일의 최신 revision 동기화
                            const conflictTileIds = saveResult.conflicts.map(c => c.tileId);
                            log.info(`[PixelCanvas3] 🔄 Resyncing ${conflictTileIds.length} conflict tiles...`);
                            
                            // 2. Conflict 타일들의 revision을 서버 최신 revision으로 업데이트
                            for (const conflict of saveResult.conflicts) {
                                this.tileRevisionMap.set(conflict.tileId, conflict.serverRevision);
                            }
                            
                            // 3. Conflict 타일들만 다시 추출하여 저장 시도 (최신 revision으로)
                            const conflictTiles = this.extractTiles(new Set(conflictTileIds));
                            if (conflictTiles.length > 0) {
                                log.info(`[PixelCanvas3] 🔄 Retrying save for ${conflictTiles.length} conflict tiles with updated revisions...`);
                                const retryResult = await pixelDataService.saveTiles(this.territoryId, conflictTiles);
                                
                                // 재시도 성공 시 revision 업데이트
                                if (retryResult.updatedTiles) {
                                    for (const updatedTile of retryResult.updatedTiles) {
                                        this.tileRevisionMap.set(updatedTile.tileId, updatedTile.revision);
                                        this.dirtyTiles.delete(updatedTile.tileId);
                                        
                                        // 메타데이터도 업데이트
                                        if (this.territoryMetadata) {
                                            this.territoryMetadata.tileRevisionMap[updatedTile.tileId] = updatedTile.revision;
                                        }
                                    }
                                    log.info(`[PixelCanvas3] ✅ Successfully resolved ${retryResult.updatedTiles.length} conflict tiles`);
                                }
                                
                                // 재시도 후에도 conflict가 있으면 경고만 (일부는 저장되었을 수 있음)
                                if (retryResult.conflicts && retryResult.conflicts.length > 0) {
                                    log.warn('[PixelCanvas3] ⚠️ Some tiles still have conflicts after retry:', retryResult.conflicts.length);
                                }
                            }
                            
                            // 4. Conflict 처리 완료 후 성공한 타일들은 dirty에서 제거 (이미 위에서 처리됨)
                            // 남은 dirtyTiles는 다음 저장 시 다시 시도됨
                        } catch (resyncError) {
                            log.error('[PixelCanvas3] ❌ Failed to resync conflict tiles:', resyncError);
                            // Resync 실패해도 이미 일부 타일은 저장되었으므로 계속 진행
                        }
                    } else {
                        // Conflict가 없으면 모든 dirty tiles 클리어
                        this.dirtyTiles.clear();
                    }
                    } else {
                        // 변경이 없으면 저장하지 않음
                        log.debug('[PixelCanvas3] No dirty tiles, skipping save');
                    }
                } catch (error) {
                    // 타일 저장 실패 시 레거시 방식으로 fallback
                    // 단, revision conflict 에러는 이미 위의 conflict 처리 로직에서 처리했으므로 스킵
                    const isConflictError = error.message && (
                        error.message.includes('Revision conflicts') || 
                        error.message.includes('conflict')
                    );
                    
                    if (isConflictError) {
                        log.warn('[PixelCanvas3] Conflict error caught, but already handled above. Skipping legacy fallback.');
                        return; // Conflict는 이미 처리되었으므로 성공으로 간주
                    }
                    
                    log.warn('[PixelCanvas3] Tile save failed, falling back to legacy save:', error);
                    
                    // ⚠️ 핵심 안전장치: tiles 실패 시 백업된 전체 데이터로 저장
                    // pixelData가 Delta 모드이고 비어있을 수 있으므로, 항상 백업 데이터 사용
                    const fallbackPixelData = backupPixelData;
                    
                    // ⚠️ 빈 payload로 덮어쓰기 방지: 백업 데이터도 비어있으면 저장하지 않음
                    if (fallbackPixelData.pixels.length === 0 && this.pixels.size > 0) {
                        // 백업 데이터가 비어있지만 캔버스에는 픽셀이 있는 경우
                        // encodePixels()가 제대로 동작하지 않은 것일 수 있음
                        log.error('[PixelCanvas3] ❌ CRITICAL: Backup pixel data is empty but canvas has pixels! Refusing to save to prevent data loss.');
                        eventBus.emit(EVENTS.UI_NOTIFICATION, {
                            type: 'error',
                            message: '❌ 저장 실패: 데이터 손실 방지를 위해 저장을 중단했습니다. 페이지를 새로고침하고 다시 시도해주세요.',
                            duration: 10000
                        });
                        throw new Error('Backup pixel data is empty but canvas has pixels - refusing to save to prevent data loss');
                    }
                    
                    if (fallbackPixelData.pixels.length === 0) {
                        // 백업 데이터와 캔버스 모두 비어있으면 저장하지 않음
                        log.warn('[PixelCanvas3] ⚠️ Refusing to save: backup data and canvas are both empty');
                        eventBus.emit(EVENTS.UI_NOTIFICATION, {
                            type: 'warning',
                            message: '⚠️ 저장할 픽셀이 없습니다.'
                        });
                        return;
                    }
                    
                    // ⚠️ 레거시 모드로 전환하여 이후 저장도 레거시 경로 사용
                    this.isLegacyMode = true;
                    try {
                        await pixelDataService.savePixelDataImmediate(this.territoryId, fallbackPixelData, { saveRunId });
                        log.info(`[PixelCanvas3] ✅ Legacy save successful after tiles failure (${fallbackPixelData.pixels.length} pixels)`, {
                            saveRunId,
                            territoryId: this.territoryId
                        });
                    } catch (fallbackError) {
                        log.error('[PixelCanvas3] ❌ Legacy fallback save also failed:', fallbackError);
                        throw fallbackError; // 전체 저장도 실패하면 에러 전파
                    }
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
     * ⚠️ 최적화: paint는 pixel-diff, 대량 변경은 tile-snapshot
     */
    saveHistory() {
        // ⚠️ 실시간 추적을 기본으로 사용 (dirtyTiles가 이미 추적됨)
        // calculateDirtyTiles()는 보정용으로만 사용 (Undo/Redo 등 특수 케이스)
        const dirtyTiles = this.dirtyTiles.size > 0 
            ? new Set(this.dirtyTiles) 
            : this.calculateDirtyTiles();
        
        // 변경이 없으면 히스토리 저장하지 않음
        if (dirtyTiles.size === 0) return;
        
        const editType = this.lastEditType || 'paint';
        const isBulkChange = false; // 이미지 업로드 기능 삭제됨
        
        // ⚠️ 히스토리 구조 최적화:
        // - paint(소량 변경) → pixel-diff (경량)
        // - 대량 변경 기능은 새로 구현 예정
        let entry;
        
        if (isBulkChange) {
            // 대량 변경: 타일 스냅샷 사용
            const tileDiffs = [];
            for (const tileId of dirtyTiles) {
                const before = this.getTileSnapshot(tileId, this.previousPixelsMap);
                const after = this.getTileSnapshot(tileId, this.pixelsMap);
                
                tileDiffs.push({
                    tileId,
                    before,
                    after
                });
            }
            
            entry = {
                type: editType,
                format: 'tile-snapshot',
                tiles: tileDiffs,
                timestamp: Date.now()
            };
        } else {
            // 소량 변경 (paint): 픽셀 diff만 저장 (경량)
            const pixelDiffs = [];
            for (const tileId of dirtyTiles) {
                const coords = this.getTileCoords(tileId);
                if (!coords) continue;
                
                const { tileX, tileY } = coords;
                const startX = tileX * this.tileSize;
                const startY = tileY * this.tileSize;
                const endX = startX + this.tileSize;
                const endY = startY + this.tileSize;
                
                const tilePixelDiffs = [];
                for (let y = startY; y < endY; y++) {
                    for (let x = startX; x < endX; x++) {
                        const key = `${x},${y}`;
                        const currentColor = this.pixelsMap.get(key);
                        const previousColor = this.previousPixelsMap.get(key);
                        
                        if (currentColor !== previousColor) {
                            tilePixelDiffs.push({
                                x, y,
                                before: previousColor || null,
                                after: currentColor || null
                            });
                        }
                    }
                }
                
                if (tilePixelDiffs.length > 0) {
                    pixelDiffs.push({
                        tileId,
                        pixels: tilePixelDiffs
                    });
                }
            }
            
            entry = {
                type: editType,
                format: 'pixel-diff',
                tiles: pixelDiffs,
                timestamp: Date.now()
            };
        }
        
        // 히스토리 추가
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(entry);
        this.historyIndex++;
        
        // ⚠️ 히스토리 제한: 스텝 수 + 메모리 상한
        // 1. 스텝 수 제한
        if (this.history.length > this.maxHistory) {
            this.history.shift();
            this.historyIndex--;
        }
        
        // 2. 메모리 상한 체크 (대량 변경 누적 방지)
        const historyMemoryMB = this._estimateHistoryMemory();
        if (historyMemoryMB > this.maxHistoryMemoryMB) {
            // 가장 오래된 엔트리 제거 (메모리 사용량이 큰 것부터)
            this._trimHistoryByMemory();
        }
        
        // ⚠️ 최적화: previousPixelsMap 전체 복사는 최소화
        // dirtyTiles가 있는 타일만 업데이트 (선택적 업데이트)
        for (const tileId of dirtyTiles) {
            const coords = this.getTileCoords(tileId);
            if (!coords) continue;
            
            const { tileX, tileY } = coords;
            const startX = tileX * this.tileSize;
            const startY = tileY * this.tileSize;
            const endX = startX + this.tileSize;
            const endY = startY + this.tileSize;
            
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const key = `${x},${y}`;
                    const currentColor = this.pixelsMap.get(key);
                    if (currentColor) {
                        this.previousPixelsMap.set(key, currentColor);
                    } else {
                        this.previousPixelsMap.delete(key);
                    }
                }
            }
        }
        
        // dirtyTiles 초기화 (저장 완료)
        this.dirtyTiles.clear();
    }
    
    /**
     * 히스토리 메모리 사용량 추정 (MB)
     * ⚠️ 안전장치: 히스토리 메모리 상한 관리
     */
    _estimateHistoryMemory() {
        let totalBytes = 0;
        for (const entry of this.history) {
            // 엔트리 크기 추정 (JSON 문자열 길이 기준)
            const entrySize = JSON.stringify(entry).length;
            totalBytes += entrySize;
        }
        return totalBytes / (1024 * 1024); // MB
    }
    
    /**
     * 히스토리 메모리 상한 초과 시 오래된 엔트리 제거
     */
    _trimHistoryByMemory() {
        while (this._estimateHistoryMemory() > this.maxHistoryMemoryMB && this.history.length > 1) {
            // 가장 오래된 엔트리 제거
            this.history.shift();
            this.historyIndex--;
        }
        log.debug(`[PixelCanvas3] History trimmed to ${this.history.length} entries (${this._estimateHistoryMemory().toFixed(2)}MB)`);
    }
    
    /**
     * Undo (타일 단위)
     * ⚠️ 안전장치: Undo 시 dirtyTiles 재계산 (저장 대상과 UI dirty 분리)
     */
    undo() {
        if (this.historyIndex < 0) return;
        
        const entry = this.history[this.historyIndex];
        
        // 레거시 히스토리 형식 지원 (하위 호환성)
        if (!entry.tiles && entry.length) {
            // 기존 형식: 전체 픽셀 배열
            this.historyIndex--;
            this.decodePixels(this.history[this.historyIndex]);
            this.render();
            return;
        }
        
        // 타일 단위로 복원
        for (const {tileId, before} of entry.tiles) {
            if (before) {
                // 변경 전 상태로 복원
                this.restoreTile(tileId, before);
            } else {
                // 타일이 비어있었던 경우, 해당 타일 영역의 픽셀 삭제
                this.clearTile(tileId);
            }
        }
        
        this.historyIndex--;
        this.previousPixelsMap = new Map(this.pixelsMap);
        this.render();
    }
    
    /**
     * Redo (타일 단위)
     */
    redo() {
        if (this.historyIndex >= this.history.length - 1) return;
        
        this.historyIndex++;
        const entry = this.history[this.historyIndex];
        
        // 레거시 히스토리 형식 지원 (하위 호환성)
        if (!entry.tiles && entry.length) {
            // 기존 형식: 전체 픽셀 배열
            this.decodePixels(entry);
            this.render();
            return;
        }
        
        // 타일 단위로 복원
        for (const {tileId, after} of entry.tiles) {
            if (after) {
                // 변경 후 상태로 복원
                this.restoreTile(tileId, after);
            } else {
                // 타일이 비어있게 된 경우
                this.clearTile(tileId);
            }
        }
        
        this.previousPixelsMap = new Map(this.pixelsMap);
        this.render();
    }
    
    /**
     * 픽셀 디코딩 (레거시 호환성)
     */
    decodePixels(encoded) {
        this.pixels.clear();
        this.pixelsMap.clear();
        if (!encoded) return;
        for (const pixel of encoded) {
            const key = `${pixel.x},${pixel.y}`;
            const color = pixel.c || pixel.color;
            
            // 레거시 pixels 업데이트
            this.pixels.set(key, {
                color,
                userId: pixel.u || pixel.userId,
                timestamp: pixel.t || pixel.timestamp
            });
            
            // 새로운 pixelsMap 업데이트
            if (color) {
                this.pixelsMap.set(key, color);
            }
        }
        
        // 이전 상태 업데이트
        this.previousPixelsMap = new Map(this.pixelsMap);
        this.dirtyTiles.clear();
    }
    
    /**
     * WebSocket 타일 업데이트 처리
     * ⚠️ 운영 안정성: 입력 검증 + 역순/중복 방지
     * @param {Array} updatedTiles - 업데이트된 타일 목록 [{tileId, revision, pixels?}]
     */
    async handleTileUpdates(updatedTiles) {
        // 1. 입력 검증: payload가 없으면 무시
        if (!updatedTiles || !Array.isArray(updatedTiles) || updatedTiles.length === 0) {
            log.debug('[PixelCanvas3] handleTileUpdates: Empty or invalid payload, ignoring');
            return;
        }
        
        // 2. territoryId 검증: 현재 편집 영토와 다르면 무시
        if (!this.territoryId) {
            log.debug('[PixelCanvas3] handleTileUpdates: No territoryId, ignoring');
            return;
        }
        
        try {
            // 3. 타일 ID 범위 검증 및 필터링
            const validTileIds = [];
            for (const tileUpdate of updatedTiles) {
                if (!tileUpdate || !tileUpdate.tileId) {
                    log.warn('[PixelCanvas3] handleTileUpdates: Invalid tile update (missing tileId), skipping');
                    continue;
                }
                
                // 타일 좌표 추출 및 범위 검증
                const coords = this.getTileCoords(tileUpdate.tileId);
                if (!coords) {
                    log.warn(`[PixelCanvas3] handleTileUpdates: Invalid tileId format: ${tileUpdate.tileId}, skipping`);
                    continue;
                }
                
                const { tileX, tileY } = coords;
                // 타일 좌표가 현재 그리드 범위를 벗어나면 무시
                if (tileX < 0 || tileX >= this.tilesX || tileY < 0 || tileY >= this.tilesY) {
                    log.warn(`[PixelCanvas3] handleTileUpdates: Tile out of range: ${tileUpdate.tileId} (${tileX}, ${tileY}), skipping`);
                    continue;
                }
                
                // 4. 리비전 검증: 로컬 리비전보다 낮거나 같으면 무시 (역순/중복 방지)
                const localRevision = this.tileRevisionMap.get(tileUpdate.tileId) || 0;
                if (tileUpdate.revision !== undefined && tileUpdate.revision <= localRevision) {
                    log.debug(`[PixelCanvas3] handleTileUpdates: Stale revision for ${tileUpdate.tileId} (local: ${localRevision}, received: ${tileUpdate.revision}), ignoring`);
                    continue;
                }
                
                validTileIds.push(tileUpdate.tileId);
            }
            
            // 유효한 타일이 없으면 종료
            if (validTileIds.length === 0) {
                log.debug('[PixelCanvas3] handleTileUpdates: No valid tiles after validation, ignoring');
                
                // ⚠️ 재동기화 트리거: 무시된 타일이 있으면 재동기화 필요 타일로 표시
                const ignoredTileIds = updatedTiles
                    .filter(t => t && t.tileId)
                    .map(t => t.tileId)
                    .filter(id => !validTileIds.includes(id));
                
                if (ignoredTileIds.length > 0) {
                    for (const tileId of ignoredTileIds) {
                        this.needsResyncTiles.add(tileId);
                    }
                    // 일정 시간 후 재동기화 트리거 (debounce)
                    this._scheduleResync();
                }
                return;
            }
            
            // 5. 서버에서 최신 타일 데이터 로드
            const tilesResponse = await pixelDataService.loadTiles(
                this.territoryId,
                validTileIds,
                {} // 클라이언트 리비전은 무시하고 최신 데이터 가져오기
            );
            
            // 6. 타일 데이터 적용
            for (const tile of tilesResponse.tiles) {
                if (!tile || !tile.tileId) continue;
                
                // 타일 리비전 업데이트
                this.tileRevisionMap.set(tile.tileId, tile.revision);
                
                // 타일 픽셀 적용
                if (tile.pixels && Array.isArray(tile.pixels)) {
                    for (const pixel of tile.pixels) {
                        if (!pixel || pixel.x === undefined || pixel.y === undefined) continue;
                        
                        const key = `${pixel.x},${pixel.y}`;
                        if (!this.territoryMask || this.territoryMask.has(key)) {
                            this.pixelsMap.set(key, pixel.color);
                            this.pixels.set(key, {
                                color: pixel.color,
                                userId: 'system',
                                timestamp: Date.now()
                            });
                        }
                    }
                }
            }
            
            // 7. 렌더링 업데이트
            this.render();
            log.debug(`[PixelCanvas3] Updated ${validTileIds.length} tiles from WebSocket (filtered from ${updatedTiles.length})`);
        } catch (error) {
            log.error('[PixelCanvas3] Failed to handle tile updates:', error);
            // ⚠️ 에러 발생 시 재동기화 트리거 (드롭 복구)
            const failedTileIds = updatedTiles
                .filter(t => t && t.tileId)
                .map(t => t.tileId);
            for (const tileId of failedTileIds) {
                this.needsResyncTiles.add(tileId);
            }
            this._scheduleResync();
        }
    }
    
    /**
     * 재동기화 스케줄링 (debounce)
     * ⚠️ 운영 안정성: invalid payload 무시 시 자동 복구
     */
    _scheduleResync() {
        // 기존 타이머 취소
        if (this.resyncTimer) {
            clearTimeout(this.resyncTimer);
        }
        
        // 2초 후 재동기화 실행 (debounce)
        this.resyncTimer = setTimeout(async () => {
            if (this.needsResyncTiles.size === 0 || !this.territoryId) {
                return;
            }
            
            try {
                log.debug(`[PixelCanvas3] Triggering resync for ${this.needsResyncTiles.size} tiles`);
                const tileIds = Array.from(this.needsResyncTiles);
                this.needsResyncTiles.clear();
                
                // 서버에서 최신 타일 데이터 재요청
                const tilesResponse = await pixelDataService.loadTiles(
                    this.territoryId,
                    tileIds,
                    {} // 최신 데이터 가져오기
                );
                
                // 타일 데이터 적용
                for (const tile of tilesResponse.tiles) {
                    if (!tile || !tile.tileId) continue;
                    
                    this.tileRevisionMap.set(tile.tileId, tile.revision);
                    
                    if (tile.pixels && Array.isArray(tile.pixels)) {
                        for (const pixel of tile.pixels) {
                            if (!pixel || pixel.x === undefined || pixel.y === undefined) continue;
                            
                            const key = `${pixel.x},${pixel.y}`;
                            if (!this.territoryMask || this.territoryMask.has(key)) {
                                this.pixelsMap.set(key, pixel.color);
                                this.pixels.set(key, {
                                    color: pixel.color,
                                    userId: 'system',
                                    timestamp: Date.now()
                                });
                            }
                        }
                    }
                }
                
                this.render();
                log.debug(`[PixelCanvas3] Resync completed for ${tilesResponse.tiles.length} tiles`);
            } catch (error) {
                log.error('[PixelCanvas3] Resync failed:', error);
                // 재동기화 실패 시 다시 목록에 추가 (다음 기회에 재시도)
                // 하지만 무한 루프 방지를 위해 최대 재시도 횟수 제한 필요 (선택적)
            }
        }, 2000); // 2초 debounce
    }
    
    /**
     * 타일 복원 (undo/redo용)
     */
    restoreTile(tileId, tileData) {
        // 타일 영역의 기존 픽셀 삭제
        this.clearTile(tileId);
        
        // 타일 데이터의 픽셀 복원
        for (const {x, y, color} of tileData.pixels) {
            const key = `${x},${y}`;
            this.pixelsMap.set(key, color);
            
            // 레거시 pixels도 업데이트
            const user = firebaseService.getCurrentUser();
            this.pixels.set(key, {
                color,
                userId: user?.uid || 'anonymous',
                timestamp: Date.now()
            });
        }
        
        // 타일 리비전 업데이트
        this.tileRevisionMap.set(tileId, tileData.revision);
    }
    
    /**
     * 타일 영역의 픽셀 삭제
     */
    clearTile(tileId) {
        const coords = this.getTileCoords(tileId);
        if (!coords) return;
        
        const { tileX, tileY } = coords;
        const startX = tileX * this.tileSize;
        const startY = tileY * this.tileSize;
        const endX = startX + this.tileSize;
        const endY = startY + this.tileSize;
        
        for (let y = startY; y < endY; y++) {
            for (let x = startX; x < endX; x++) {
                const key = `${x},${y}`;
                this.pixelsMap.delete(key);
                this.pixels.delete(key);
            }
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
     * 정리 (리소스 해제)
     */
    /**
     * 정리 (리소스 해제)
     * ⚠️ Idempotent: 여러 번 호출되어도 안전 (open 실패 시에도 안전)
     */
    cleanup() {
        // ⚠️ 재동기화 타이머 정리
        if (this.resyncTimer) {
            clearTimeout(this.resyncTimer);
            this.resyncTimer = null;
        }
        
        // WebSocket 리스너 제거 (null-safe + 중복 호출 safe)
        if (this.tileUpdateListener) {
            eventBus.off('pixel:tiles:updated', this.tileUpdateListener);
            this.tileUpdateListener = null;
        }
        
        // 소유권 변경 리스너 제거 (null-safe + 중복 호출 safe)
        if (this.ownershipChangeListener) {
            eventBus.off(EVENTS.TERRITORY_UPDATE, this.ownershipChangeListener);
            this.ownershipChangeListener = null;
        }
        
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
        
        // ⚠️ 모든 컬렉션 null-safe 정리 (idempotent 보장)
        if (this.pixels) this.pixels.clear();
        if (this.pixelsMap) this.pixelsMap.clear();
        if (this.previousPixelsMap) this.previousPixelsMap.clear();
        if (this.tileCache) this.tileCache.clear();
        if (this.tileRevisionMap) this.tileRevisionMap.clear();
        if (this.dirtyTiles) this.dirtyTiles.clear();
        if (this.changedPixels) this.changedPixels.clear();
        if (this.needsResyncTiles) this.needsResyncTiles.clear();
        if (this.lastSavedPixels) this.lastSavedPixels.clear();
        
        this.history = [];
        this.historyIndex = -1;
        this.territoryId = null;
        this.territory = null;
        this.territoryMetadata = null;
        this.territoryGeometry = null;
        this.territoryBounds = null;
        this.territoryMask = null;
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.isSaving = false;
        this.lastSaveTime = null;
        this.originalOwnerId = null;
        this.isLegacyMode = false; // 레거시 모드 플래그 초기화
        
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
    
    /**
     * 대량 픽셀 적용 (실시간 dirtyTiles 추적)
     * ⚠️ 최적화: bulk 적용 시에도 실시간 추적
     */
    applyBulkPixels(bulkPixels) {
        for (const [key, color] of bulkPixels) {
            const [x, y] = key.split(',').map(Number);
            this.setPixel(x, y, color);
        }
    }
}

export const pixelCanvas3 = new PixelCanvas3();
export default pixelCanvas3;
