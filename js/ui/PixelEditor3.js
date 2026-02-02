/**
 * PixelEditor3 - 완전히 새로운 픽셀 에디터 UI
 * 모던하고 깔끔한 디자인
 * Version: 2025-01-03-fix-async-close
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { pixelCanvas3, TOOLS } from '../core/PixelCanvas3.js';
import { loadBg, subscribeBg, setBg } from '../stores/BackgroundStore.js';
import { imageStampModal } from './ImageStampModal.js';

/**
 * ViewTransform - World ↔ Screen 좌표계 변환 통일 클래스
 * 
 * 정석 파이프라인:
 * - World: 픽셀 그리드 좌표 (0..gridSize)
 * - Screen: CSS 픽셀 좌표 (DOM overlay도 동일하게 사용)
 * - Canvas buffer: CSS px × DPR (내부용, drawImage 계산에만 사용)
 */
class ViewTransform {
    constructor(pixelSize = 4) {
        this.scale = pixelSize;  // world -> screen 변환 스케일
        this.tx = 0;              // screen px (pan offset)
        this.ty = 0;
    }
    
    /**
     * World 좌표를 Screen 좌표로 변환
     */
    worldToScreen(x, y) {
        return {
            x: x * this.scale + this.tx,
            y: y * this.scale + this.ty
        };
    }
    
    /**
     * Screen 좌표를 World 좌표로 변환
     */
    screenToWorld(x, y) {
        return {
            x: (x - this.tx) / this.scale,
            y: (y - this.ty) / this.scale
        };
    }
    
    /**
     * World 사각형을 Screen 사각형으로 변환
     */
    rectWorldToScreen(rect) {
        const p0 = this.worldToScreen(rect.x, rect.y);
        return {
            x: p0.x,
            y: p0.y,
            width: rect.width * this.scale,
            height: rect.height * this.scale
        };
    }
    
    /**
     * Screen 사각형을 World 사각형으로 변환
     */
    rectScreenToWorld(rect) {
        const p0 = this.screenToWorld(rect.x, rect.y);
        return {
            x: p0.x,
            y: p0.y,
            width: rect.width / this.scale,
            height: rect.height / this.scale
        };
    }
}

/**
 * setupHiDPICanvas - 정석 DPR 처리 함수
 * 
 * 핵심 원칙:
 * 1. 캔버스는 "CSS px 단위로 그리게" 만든다
 * 2. DPR은 ctx에만 한 번 적용한다
 * 3. 이후 drawImage(x,y,w,h)는 전부 CSS px로 넣으면 됨
 * 
 * ⚠️ 무한 루프 방지: 크기가 실제로 변경되었을 때만 버퍼 재설정
 * 
 * @param {HTMLCanvasElement} canvas
 * @param {Object} lastSize - 이전 크기 {cssW, cssH, dpr} (선택사항)
 * @returns {{ctx: CanvasRenderingContext2D, dpr: number, cssW: number, cssH: number, sizeChanged: boolean}}
 */
function setupHiDPICanvas(canvas, lastSize = null) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    // CSS 크기 (표시 크기)
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    
    // 크기 변경 감지 (무한 루프 방지)
    const sizeChanged = !lastSize || 
        lastSize.cssW !== cssW || 
        lastSize.cssH !== cssH || 
        lastSize.dpr !== dpr;
    
    // 크기가 실제로 변경되었을 때만 버퍼 재설정
    if (sizeChanged) {
        // 버퍼 크기 (실제 해상도)
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    
    const ctx = canvas.getContext('2d');
    
    // 크기가 변경되었거나 처음이면 transform 재설정
    if (sizeChanged) {
        // 이제부터 ctx 좌표계는 "CSS px"가 된다
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    
    return { ctx, dpr, cssW, cssH, sizeChanged };
}

// 색상 팔레트 (16색으로 제한 - Wplace 스타일)
const PALETTE = [
    '#000000', // 검정
    '#ffffff', // 흰색
    '#ff0000', // 빨강
    '#00ff00', // 초록
    '#0000ff', // 파랑
    '#ffff00', // 노랑
    '#ff00ff', // 마젠타
    '#00ffff', // 시안
    '#ff6b6b', // 연한 빨강
    '#4ecdc4', // 청록
    '#feca57', // 주황
    '#a29bfe', // 보라
    '#fd79a8', // 분홍
    '#00b894', // 민트
    '#e17055', // 갈색
    '#74b9ff'  // 하늘색
];

class PixelEditor3 {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.tool = TOOLS.BRUSH;
        // Wplace 스타일: 기본 색상을 팔레트 첫 번째 색으로 설정
        this.color = PALETTE.length > 0 ? PALETTE[2] : '#4ecdc4'; // 빨강으로 시작
        this.brushSize = 1;
        this.customColors = [];
        this.shortcutsModalVisible = false;
        this.keyboardHandler = null;
        this.panModeFromSpace = false; // Space 키로 이동 모드 진입 여부
        this.lang = 'en'; // English default
        
        // 배경 설정 (BackgroundStore에서 로드)
        const bgState = loadBg();
        this.backgroundMode = bgState.mode;
        this.backgroundColor = bgState.color;
        this.checkerSize = bgState.checkerSize;
        
        // BackgroundStore 구독 (배경 변경 시 동기화)
        this.bgUnsubscribe = subscribeBg((bgState) => {
            this.backgroundMode = bgState.mode;
            this.backgroundColor = bgState.color;
            this.checkerSize = bgState.checkerSize;
            
            // PixelCanvas3에 배경 설정 적용 (캔버스가 초기화된 경우에만)
            if (pixelCanvas3 && pixelCanvas3.canvas) {
                pixelCanvas3.setBackground(bgState.mode, bgState.color, bgState.checkerSize);
                pixelCanvas3.render();
            }
        });
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.createModal();
        this.setupEvents();
        // ImageStampModal 초기화
        imageStampModal.initialize();
        log.info('[PixelEditor3] Initialized');
    }
    
    /**
     * 모달 생성
     */
    createModal() {
        // 기존 모달 제거
        const existing = document.getElementById('pixel-editor-3');
        if (existing) existing.remove();
        
        this.container = document.createElement('div');
        this.container.id = 'pixel-editor-3';
        this.container.className = 'pixel-editor-3 hidden';
        this.container.innerHTML = this.getHTML();
        document.body.appendChild(this.container);
    }
    
    /**
     * HTML 생성
     */
    getHTML() {
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        return `
            <div class="pixel-editor-3-overlay"></div>
            <div class="pixel-editor-3-content">
                <!-- 헤더 (Wplace 스타일 - 간결하게) -->
                <div class="pixel-editor-3-header">
                    <div class="pixel-editor-3-header-left">
                        <h2>🎨 ${vocab.pixelArtEditor}</h2>
                        <div class="pixel-editor-3-territory-info" id="pixel-territory-info-3">
                            <span class="territory-name">${vocab.territorySelected}</span>
                        </div>
                    </div>
                    <div class="pixel-editor-3-actions">
                        <button class="pixel-editor-3-btn pixel-editor-3-btn-save" id="pixel-save-btn-3" title="Save (Ctrl+S)">
                            <span>💾</span>
                            <span>Save</span>
                        </button>
                        <div class="pixel-editor-3-save-status" id="pixel-save-status-3">
                            <span>✅</span>
                            <span>Saved</span>
                        </div>
                        <button class="pixel-editor-3-btn" id="pixel-undo-3" title="Undo (Ctrl+Z)">
                            <span>↩</span>
                        </button>
                        <button class="pixel-editor-3-btn" id="pixel-redo-3" title="Redo (Ctrl+Y)">
                            <span>↪</span>
                        </button>
                        <button class="pixel-editor-3-btn" id="pixel-clear-3" title="Clear All">
                            <span>🗑</span>
                        </button>
                        <button class="pixel-editor-3-close" id="pixel-close-3">×</button>
                    </div>
                </div>
                
                <!-- 본문 -->
                <div class="pixel-editor-3-body">
                    <!-- 좌측: 도구 -->
                    <div class="pixel-editor-3-sidebar pixel-editor-3-tools">
                        <!-- 이미지 업로드 (눈에 띄는 위치) -->
                        <div class="pixel-editor-3-section pixel-editor-3-image-upload-section">
                            <button class="pixel-editor-3-btn pixel-editor-3-btn-image-upload" id="pixel-image-upload-3">
                                <span>🖼️</span>
                                <span>Draw from Image</span>
                            </button>
                            <div class="pixel-editor-3-image-upload-hint">
                                <small>Upload a photo to convert to pixel art</small>
                            </div>
                        </div>
                        
                        <!-- 도구 (3개로 최소화 - Wplace 스타일) -->
                        <div class="pixel-editor-3-section">
                            <h3>Tools</h3>
                            <div class="pixel-editor-3-tool-grid">
                                <button class="pixel-editor-3-tool-btn active" data-tool="brush" title="Brush (B)">
                                    <span class="tool-icon">✏</span>
                                    <span>Brush</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="eraser" title="Eraser (E)">
                                    <span class="tool-icon">🧹</span>
                                    <span>Eraser</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="fill" title="Fill (F)">
                                    <span class="tool-icon">🪣</span>
                                    <span>Fill</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="pan" title="Pan (drag to move screen, or hold Space)">
                                    <span class="tool-icon">✋</span>
                                    <span>Pan</span>
                                </button>
                            </div>
                            <div class="pixel-editor-3-tool-hint">
                                <small>Space: Pan | I: Eyedropper</small>
                            </div>
                        </div>
                        
                        <!-- 브러시 크기 -->
                        <div class="pixel-editor-3-section">
                            <h3>Brush Size</h3>
                            <div class="pixel-editor-3-brush-control">
                                <input type="range" id="pixel-brush-size-3" min="1" max="10" value="1">
                                <span id="pixel-brush-size-value-3">1px</span>
                            </div>
                        </div>
                        
                        <!-- 색상 -->
                        <div class="pixel-editor-3-section">
                            <h3>Color</h3>
                            <div class="pixel-editor-3-color-picker">
                                <div class="pixel-editor-3-color-preview" id="pixel-color-preview-3" style="background: ${this.color}"></div>
                                <input type="color" id="pixel-color-input-3" value="${this.color}">
                            </div>
                        </div>
                        
                        <!-- 팔레트 (16색) -->
                        <div class="pixel-editor-3-section">
                            <h3>Palette (16 colors)</h3>
                            <div class="pixel-editor-3-palette">
                                ${PALETTE.map(color => `
                                    <div class="pixel-editor-3-palette-color" data-color="${color}" style="background: ${color}" title="${color}"></div>
                                `).join('')}
                            </div>
                            <div class="pixel-editor-3-palette-hint">
                                <small>Click to select color</small>
                            </div>
                        </div>
                        
                        <!-- 배경 -->
                        <div class="pixel-editor-3-section">
                            <h3>Background</h3>
                            <div class="pixel-editor-3-background-presets">
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'solid' && this.backgroundColor === '#1a1a1a' ? 'active' : ''}" data-mode="solid" data-color="#1a1a1a" title="Dark">Dark</button>
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'solid' && this.backgroundColor === '#808080' ? 'active' : ''}" data-mode="solid" data-color="#808080" title="Mid Gray">Mid</button>
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'solid' && this.backgroundColor === '#c0c0c0' ? 'active' : ''}" data-mode="solid" data-color="#c0c0c0" title="Light Gray">Light</button>
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'solid' && this.backgroundColor === '#ffffff' ? 'active' : ''}" data-mode="solid" data-color="#ffffff" title="White">White</button>
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'checker' ? 'active' : ''}" data-mode="checker" title="Checkerboard">Checker</button>
                                <button class="pixel-editor-3-bg-preset-btn ${this.backgroundMode === 'solid' && !['#1a1a1a', '#808080', '#c0c0c0', '#ffffff'].includes(this.backgroundColor) ? 'active' : ''}" data-mode="custom" title="Custom">Custom</button>
                            </div>
                            <div class="pixel-editor-3-background-custom" id="pixel-bg-custom-3" style="display: ${this.backgroundMode === 'solid' && !['#1a1a1a', '#808080', '#c0c0c0', '#ffffff'].includes(this.backgroundColor) ? 'flex' : 'none'}; gap: 8px; align-items: center; margin-top: 8px;">
                                <input type="color" id="pixel-bg-color-input-3" value="${this.backgroundColor}" style="width: 60px; height: 30px;">
                                <span style="font-size: 12px; color: #aaa;">Select color</span>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 중앙: 캔버스 -->
                    <div class="pixel-editor-3-main">
                        <div class="pixel-editor-3-loading-overlay" id="pixel-loading-3" style="display: none;">
                            <div class="pixel-editor-3-loading-spinner"></div>
                            <p>Loading pixel art...</p>
                        </div>
                        <div class="pixel-editor-3-canvas-wrapper">
                            <canvas id="pixel-canvas-3"></canvas>
                            <!-- 줌 컨트롤 -->
                            <div class="pixel-editor-3-zoom-controls">
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-in-3" title="Zoom In (+ / Wheel Up)">+</button>
                                <div class="pixel-editor-3-zoom-display" id="pixel-zoom-value-3">100%</div>
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-out-3" title="Zoom Out (- / Wheel Down)">−</button>
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-fit-3" title="Fit View (F)">⌂</button>
                                <div class="pixel-editor-3-zoom-hint">Shift+Drag: Pan</div>
                            </div>
                        </div>
                        <div class="pixel-editor-3-canvas-info">
                            <span id="pixel-count-3">0 / ${(CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE).toLocaleString()} ${vocab.pixel}</span>
                            <span id="pixel-coords-3">X: 0, Y: 0</span>
                        </div>
                    </div>
                    
                    <!-- 우측: 통계 -->
                    <div class="pixel-editor-3-sidebar pixel-editor-3-stats">
                        <div class="pixel-editor-3-section">
                            <h3>📊 ${vocab.statistics}</h3>
                            <div class="pixel-editor-3-stat-list">
                                <div class="pixel-editor-3-stat-item">
                                    <span>${vocab.totalPixels}</span>
                                    <span id="pixel-total-3">0</span>
                                </div>
                                <div class="pixel-editor-3-stat-item">
                                    <span>${vocab.territoryValue}</span>
                                    <span id="pixel-value-3">0</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="pixel-editor-3-section">
                            <h3>💾 ${vocab.export}</h3>
                            <button class="pixel-editor-3-btn" id="pixel-export-3">
                                💾 ${vocab.downloadPNG}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    /**
     * 이벤트 설정
     */
    setupEvents() {
        eventBus.on(EVENTS.UI_MODAL_OPEN, (data) => {
            if (data.type === 'pixelEditor') {
                this.open(data.data);
            }
        });
        
        eventBus.on(EVENTS.PIXEL_UPDATE, (data) => {
            if (data.type === 'colorPicked') {
                this.setColor(data.color);
            }
        });
        
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, (data) => {
            this.updateStats(data);
        });
        
        eventBus.on(EVENTS.PIXEL_DATA_SAVED, () => {
            this.updateSaveStatus('saved');
        });
        
        // 저장 상태 이벤트 리스너
        eventBus.on(EVENTS.PIXEL_UPDATE, (data) => {
            if (data.type === 'saveStatus') {
                this.updateSaveStatus(data.status, data.error, data.message, data.saveTime);
            }
        });
        
        // beforeunload 이벤트 - 저장되지 않은 변경사항이 있으면 경고
        this.beforeUnloadHandler = (e) => {
            if (this.isOpen && pixelCanvas3 && pixelCanvas3.hasUnsavedChanges()) {
                // 저장 중이면 경고
                if (pixelCanvas3.isSaving) {
                    e.preventDefault();
                    e.returnValue = 'Saving in progress. Recent changes may be lost if you leave.';
                    return e.returnValue;
                }
                
                // Warn if there are unsaved changes
                e.preventDefault();
                e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
                return e.returnValue;
            }
        };
        
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
    
    /**
     * 열기
     */
    async open(territory) {
        if (!territory?.id) {
            log.error('[PixelEditor3] Invalid territory');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Territory information not found.'
            });
            return;
        }
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        this.showLoading(vocab.loadingTerritoryInfo);
        this.currentTerritory = territory;
        this.isOpen = true;
        this.container?.classList.remove('hidden');
        
        try {
            // 캔버스 초기화 (territory 객체도 전달)
            const canvas = document.getElementById('pixel-canvas-3');
            if (canvas) {
                this.showLoading(vocab.loadingPixelArt);
                await pixelCanvas3.initialize(territory.id, canvas, territory);
            }
            
            // UI 바인딩
            this.bindUI();
            
            // 배경 설정 적용
            pixelCanvas3.setBackground(this.backgroundMode, this.backgroundColor, this.checkerSize);
            
            // 통계 업데이트
            this.updateStats({
                filledPixels: pixelCanvas3.pixels.size,
                value: pixelCanvas3.calculateValue()
            });
            
            // 영토 정보 업데이트
            this.updateTerritoryInfo();
            
            log.info(`[PixelEditor3] Opened for ${territory.id}`);
        } catch (error) {
            log.error('[PixelEditor3] Failed to open:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Unable to open pixel editor. Please try again later.'
            });
            await this.close();
        } finally {
            this.hideLoading();
        }
    }
    
    /**
     * 로딩 표시
     */
    showLoading(message = null) {
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const loadingEl = this.container?.querySelector('#pixel-loading-3');
        if (loadingEl) {
            const pEl = loadingEl.querySelector('p');
            if (pEl) pEl.textContent = message || vocab.loadingPixelArt;
            loadingEl.style.display = 'flex';
        }
    }
    
    /**
     * 로딩 숨기기
     */
    hideLoading() {
        const loadingEl = this.container?.querySelector('#pixel-loading-3');
        if (loadingEl) {
            loadingEl.style.display = 'none';
        }
    }
    
    /**
     * 닫기
     */
    async close() {
        // BackgroundStore 구독 해제
        if (this.bgUnsubscribe) {
            this.bgUnsubscribe();
            this.bgUnsubscribe = null;
        }
        
        // 저장 중이면 사용자에게 확인
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        if (pixelCanvas3?.isSaving) {
            const confirmed = confirm(
                `${vocab.savingInProgress}\n\n${vocab.cancelSaveAndClose}\n${vocab.confirmCancel}`
            );
            if (confirmed) {
                // 저장 취소하고 즉시 닫기
                if (pixelCanvas3.saveTimeout) {
                    clearTimeout(pixelCanvas3.saveTimeout);
                    pixelCanvas3.saveTimeout = null;
                }
                pixelCanvas3.isSaving = false;
                // 닫기 계속 진행
            } else {
                // 저장 완료를 기다림
                const checkSave = setInterval(async () => {
                    if (!pixelCanvas3.isSaving) {
                        clearInterval(checkSave);
                        await this.close();
                    }
                }, 100);
                
                // 최대 5초 대기
                setTimeout(() => {
                    clearInterval(checkSave);
                    if (pixelCanvas3.isSaving) {
                        // 타임아웃 시 강제로 닫기
                        pixelCanvas3.isSaving = false;
                        // 편집기 닫기
                        this.isOpen = false;
                        this.container?.classList.add('hidden');
                        if (pixelCanvas3) {
                            pixelCanvas3.cleanup();
                        }
                    }
                }, 5000);
                return;
            }
        }
        
        if (pixelCanvas3?.hasUnsavedChanges && pixelCanvas3.hasUnsavedChanges()) {
            const confirmed = confirm(
                `${vocab.unsavedChanges}\n\n${vocab.reallyClose}\n${vocab.autoSave}`
            );
            if (!confirmed) return;
        }
        
        // 편집기를 닫기 전에 현재 영토 ID 저장
        const territoryId = this.currentTerritory?.id;
        
        this.isOpen = false;
        this.container?.classList.add('hidden');
        if (pixelCanvas3) {
            pixelCanvas3.cleanup();
        }
        this.currentTerritory = null;
        this.hideShortcutsModal();
        
        // beforeunload 이벤트 리스너 제거
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }
        
        // 편집기를 닫은 후 맵에 픽셀 아트가 즉시 반영되도록 영토 새로고침
        // 모바일에서 편집 후 저장했을 때 맵에 즉시 보이도록 하는 핵심 로직
        if (territoryId) {
            // 캐시 무효화하여 최신 데이터를 가져오도록 보장
            const { pixelDataService } = await import('../services/PixelDataService.js');
            pixelDataService.clearMemoryCache(territoryId);
            
            // processedTerritories에서 제거하여 재처리 보장 (MapController를 통해 접근)
            try {
                const mapController = (await import('../core/MapController.js')).default;
                if (mapController && mapController.pixelMapRenderer && mapController.pixelMapRenderer.processedTerritories) {
                    mapController.pixelMapRenderer.processedTerritories.delete(territoryId);
                    log.info(`[PixelEditor3] Removed ${territoryId} from processedTerritories`);
                }
            } catch (error) {
                log.warn(`[PixelEditor3] Failed to access pixelMapRenderer:`, error);
            }
            
            // 약간의 지연 후 새로고침 (모달이 완전히 닫힌 후)
            setTimeout(() => {
                eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                    territoryId: territoryId,
                    territory: { id: territoryId },
                    forceRefresh: true // 강제 새로고침 플래그
                });
                log.info(`[PixelEditor3] Triggered territory refresh for ${territoryId} after closing editor (cache cleared)`);
            }, 100);
            
            // 추가로 더 긴 지연 후 한 번 더 새로고침 (모바일에서 확실하게 반영되도록)
            setTimeout(() => {
                eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                    territoryId: territoryId,
                    territory: { id: territoryId },
                    forceRefresh: true
                });
                log.info(`[PixelEditor3] Triggered second territory refresh for ${territoryId} after closing editor`);
            }, 500);
        }
    }
    
    /**
     * UI 바인딩
     */
    bindUI() {
        if (!this.container) return;
        
        // 닫기
        const closeBtn = this.container.querySelector('#pixel-close-3');
        if (closeBtn) {
            closeBtn.onclick = async () => {
                await this.close();
            };
        }
        
        // 오버레이 클릭
        const overlay = this.container.querySelector('.pixel-editor-3-overlay');
        if (overlay) {
            overlay.onclick = async () => {
                await this.close();
            };
        }
        
        // 도구 버튼
        this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(btn => {
            btn.onclick = () => {
                const tool = btn.dataset.tool;
                this.setTool(tool);
                // 이동 도구 버튼 클릭 시 Space 키 플래그 해제 (고정 이동 모드)
                if (tool === 'pan') {
                    this.panModeFromSpace = false;
                }
                this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });
        
        // 브러시 크기
        const brushSlider = this.container.querySelector('#pixel-brush-size-3');
        if (brushSlider) {
            brushSlider.oninput = (e) => {
                this.brushSize = parseInt(e.target.value);
                pixelCanvas3.setBrushSize(this.brushSize);
                const valueDisplay = this.container.querySelector('#pixel-brush-size-value-3');
                if (valueDisplay) {
                    valueDisplay.textContent = `${this.brushSize}px`;
                }
            };
        }
        
        // 색상 피커
        const colorInput = this.container.querySelector('#pixel-color-input-3');
        if (colorInput) {
            colorInput.oninput = (e) => {
                this.setColor(e.target.value);
            };
        }
        
        // 팔레트
        this.container.querySelectorAll('.pixel-editor-3-palette-color').forEach(el => {
            el.onclick = () => {
                this.setColor(el.dataset.color);
            };
        });
        
        // 배경 프리셋 버튼
        this.container.querySelectorAll('.pixel-editor-3-bg-preset-btn').forEach(btn => {
            btn.onclick = () => {
                const mode = btn.dataset.mode;
                const color = btn.dataset.color;
                
                if (mode === 'checker') {
                    this.setBackground('checker', null);
                } else if (mode === 'custom') {
                    const customArea = this.container.querySelector('#pixel-bg-custom-3');
                    if (customArea) customArea.style.display = 'flex';
                    this.setBackground('solid', this.backgroundColor);
                } else {
                    this.setBackground('solid', color);
                }
                
                // 활성 상태 업데이트
                this.container.querySelectorAll('.pixel-editor-3-bg-preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });
        
        // 배경 커스텀 색상
        const bgColorInput = this.container.querySelector('#pixel-bg-color-input-3');
        if (bgColorInput) {
            bgColorInput.oninput = (e) => {
                this.setBackground('solid', e.target.value);
            };
        }
        
        // Undo/Redo
        const undoBtn = this.container.querySelector('#pixel-undo-3');
        if (undoBtn) undoBtn.onclick = () => pixelCanvas3.undo();
        
        const redoBtn = this.container.querySelector('#pixel-redo-3');
        if (redoBtn) redoBtn.onclick = () => pixelCanvas3.redo();
        
        // 클리어
        const clearBtn = this.container.querySelector('#pixel-clear-3');
        if (clearBtn) {
            clearBtn.onclick = () => {
                const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
                if (confirm(vocab.clearAll)) {
                    pixelCanvas3.clear();
                }
            };
        }
        
        // 이미지 업로드 (좌측 사이드바에서)
        const imageUploadBtn = this.container.querySelector('#pixel-image-upload-3');
        if (imageUploadBtn) {
            imageUploadBtn.onclick = () => {
                if (this.currentTerritory) {
                    imageStampModal.open(this.currentTerritory);
                }
            };
        }
        
        // 저장 버튼
        const saveBtn = this.container.querySelector('#pixel-save-btn-3');
        if (saveBtn) {
            saveBtn.onclick = () => {
                if (pixelCanvas3 && !pixelCanvas3.isSaving) {
                    pixelCanvas3.save();
                }
            };
        }
        
        // 내보내기
        const exportBtn = this.container.querySelector('#pixel-export-3');
        if (exportBtn) {
            exportBtn.onclick = () => {
                const dataURL = pixelCanvas3.toDataURL();
                const link = document.createElement('a');
                link.download = `${this.currentTerritory.name?.ko || this.currentTerritory.id}_pixel.png`;
                link.href = dataURL;
                link.click();
            };
        }
        
        // 영토 정보 업데이트
        this.updateTerritoryInfo();
        
        // 줌 컨트롤
        const zoomInBtn = this.container.querySelector('#pixel-zoom-in-3');
        if (zoomInBtn) {
            zoomInBtn.onclick = () => pixelCanvas3.zoomIn();
        }
        
        const zoomOutBtn = this.container.querySelector('#pixel-zoom-out-3');
        if (zoomOutBtn) {
            zoomOutBtn.onclick = () => pixelCanvas3.zoomOut();
        }
        
        const zoomFitBtn = this.container.querySelector('#pixel-zoom-fit-3');
        if (zoomFitBtn) {
            zoomFitBtn.onclick = () => pixelCanvas3.fitToView();
        }
        
        // 줌 변경 이벤트
        eventBus.on(EVENTS.PIXEL_UPDATE, (data) => {
            if (data.type === 'zoomChanged') {
                const zoomValueEl = this.container?.querySelector('#pixel-zoom-value-3');
                if (zoomValueEl) {
                    zoomValueEl.textContent = `${Math.round(data.zoom * 100)}%`;
                }
            }
        });
        
        // 단축키 가이드 버튼
        const shortcutsBtn = this.container.querySelector('#pixel-shortcuts-3');
        if (shortcutsBtn) {
            shortcutsBtn.onclick = () => this.showShortcutsModal();
        }
        
        // 키보드 단축키
        this.keyboardHandler = (e) => {
            if (!this.isOpen) return;
            
            // ESC: 단축키 모달 닫기 또는 편집기 닫기
            if (e.key === 'Escape') {
                if (this.shortcutsModalVisible) {
                    this.hideShortcutsModal();
                    e.preventDefault();
                    return;
                }
                // 편집기는 close()에서 확인 다이얼로그 표시
            }
            
            // Ctrl+S: 수동 저장
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (pixelCanvas3) {
                    pixelCanvas3.save();
                }
                return;
            }
            
            // Ctrl+Z: 실행 취소
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (pixelCanvas3) pixelCanvas3.undo();
                return;
            }
            
            // Ctrl+Y 또는 Ctrl+Shift+Z: 다시 실행
            if (((e.ctrlKey || e.metaKey) && e.key === 'y') || 
                ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                if (pixelCanvas3) pixelCanvas3.redo();
                return;
            }
            
            // Space: 이동 도구 (캔버스에서만, 누르는 동안만)
            if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (!e.repeat) {
                    // Space 키로 진입한 경우 플래그 설정
                    this.panModeFromSpace = true;
                    this.setTool(TOOLS.PAN);
                    const panBtn = this.container.querySelector('[data-tool="pan"]');
                    if (panBtn) {
                        this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                        panBtn.classList.add('active');
                    }
                }
                return;
            }
            
            // 도구 단축키 (B, E, F, I)
            if (e.key === 'b' || e.key === 'B') {
                e.preventDefault();
                this.setTool(TOOLS.BRUSH);
                const brushBtn = this.container.querySelector('[data-tool="brush"]');
                if (brushBtn) {
                    this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                    brushBtn.classList.add('active');
                }
            } else if (e.key === 'e' || e.key === 'E') {
                e.preventDefault();
                this.setTool(TOOLS.ERASER);
                const eraserBtn = this.container.querySelector('[data-tool="eraser"]');
                if (eraserBtn) {
                    this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                    eraserBtn.classList.add('active');
                }
            } else if (e.key === 'f' || e.key === 'F') {
                if (!e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    // F키는 채우기 도구로 사용
                    this.setTool(TOOLS.FILL);
                    const fillBtn = this.container.querySelector('[data-tool="fill"]');
                    if (fillBtn) {
                        this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                        fillBtn.classList.add('active');
                    }
                }
            } else if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                // 스포이드는 숨겨진 도구로 사용 가능
                this.setTool(TOOLS.PICKER);
            }
            
            // 줌 단축키
            if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                if (pixelCanvas3) pixelCanvas3.zoomIn();
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                if (pixelCanvas3) pixelCanvas3.zoomOut();
            }
        };
        
        document.addEventListener('keydown', this.keyboardHandler);
        
        // Space 키 up 시 브러시로 복귀 (Space 키로 진입한 경우에만)
        document.addEventListener('keyup', (e) => {
            if (!this.isOpen) return;
            if (e.key === ' ' && this.tool === TOOLS.PAN && this.panModeFromSpace) {
                this.panModeFromSpace = false;
                this.setTool(TOOLS.BRUSH);
                const brushBtn = this.container.querySelector('[data-tool="brush"]');
                if (brushBtn) {
                    this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                    brushBtn.classList.add('active');
                }
            }
        });
        
        // 캔버스 좌표 표시
        const canvas = this.container.querySelector('#pixel-canvas-3');
        if (canvas) {
            canvas.onmousemove = (e) => {
                const pos = pixelCanvas3.getPixelPos(e);
                const coordsEl = this.container.querySelector('#pixel-coords-3');
                if (coordsEl) {
                    coordsEl.textContent = `X: ${pos.x}, Y: ${pos.y}`;
                }
            };
        }
    }
    
    /**
     * 도구 설정
     */
    setTool(tool) {
        this.tool = tool;
        pixelCanvas3.setTool(tool);
    }
    
    /**
     * 색상 설정
     */
    setColor(color) {
        this.color = color;
        pixelCanvas3.setColor(color);
        
        const preview = this.container?.querySelector('#pixel-color-preview-3');
        if (preview) preview.style.background = color;
        
        const input = this.container?.querySelector('#pixel-color-input-3');
        if (input) input.value = color;
    }
    
    /**
     * 배경 설정 (BackgroundStore로 동기화)
     */
    setBackground(mode, color) {
        this.backgroundMode = mode;
        if (color) {
            this.backgroundColor = color;
        }
        
        // BackgroundStore에 저장 (모든 구독자에게 자동 알림)
        setBg({
            mode: mode,
            color: color || this.backgroundColor,
            checkerSize: this.checkerSize
        });
        
        // PixelCanvas3에 배경 설정 전달 (구독 콜백에서도 처리되지만 명시적으로)
        pixelCanvas3.setBackground(mode, color || this.backgroundColor, this.checkerSize);
        
        // 렌더링 업데이트
        pixelCanvas3.render();
    }
    
    /**
     * 통계 업데이트
     */
    updateStats(data) {
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const total = CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        
        const countEl = this.container?.querySelector('#pixel-count-3');
        if (countEl) {
            countEl.textContent = `${data.filledPixels?.toLocaleString() || 0} / ${total.toLocaleString()} ${vocab.pixel}`;
        }
        
        const totalEl = this.container?.querySelector('#pixel-total-3');
        if (totalEl) {
            totalEl.textContent = data.filledPixels?.toLocaleString() || '0';
        }
        
        const valueEl = this.container?.querySelector('#pixel-value-3');
        if (valueEl) {
            valueEl.textContent = data.value?.toLocaleString() || '0';
        }
    }
    
    /**
     * 저장 상태 업데이트
     */
    updateSaveStatus(status, error = null, message = null, saveTime = null) {
        const statusEl = this.container?.querySelector('#pixel-save-status-3');
        if (!statusEl) return;
        
        const icon = statusEl.querySelector('span:first-child');
        const text = statusEl.querySelector('span:last-child');
        
        // 기존 클래스 제거
        statusEl.classList.remove('saving', 'saved', 'error', 'pending');
        
        if (status === 'saving') {
            icon.textContent = '💾';
            text.textContent = message || 'Saving...';
            statusEl.classList.add('saving');
        } else if (status === 'saved') {
            icon.textContent = '✅';
            if (saveTime) {
                const timeStr = new Date(saveTime).toLocaleTimeString('ko-KR', { 
                    hour: '2-digit', 
                    minute: '2-digit', 
                    second: '2-digit' 
                });
                text.textContent = message || `Saved · ${timeStr}`;
            } else {
                text.textContent = message || 'Saved';
            }
            statusEl.classList.add('saved');
            // Show faded after 3 seconds
            setTimeout(() => {
                if (this.container?.querySelector('#pixel-save-status-3')) {
                    icon.textContent = '💾';
                    if (saveTime) {
                        const timeStr = new Date(saveTime).toLocaleTimeString('en-US', { 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            second: '2-digit' 
                        });
                        text.textContent = `Saved · ${timeStr}`;
                    } else {
                        text.textContent = 'Saved';
                    }
                }
            }, 3000);
        } else if (status === 'pending') {
            icon.textContent = '⏳';
            text.textContent = message || 'Pending...';
            statusEl.classList.add('pending');
        } else if (status === 'error') {
            icon.textContent = '⚠️';
            text.textContent = message || 'Save failed';
            statusEl.classList.add('error');
            statusEl.title = error || 'An error occurred while saving. Please try again.';
            // 5초 후 자동으로 다시 저장 시도
            setTimeout(() => {
                if (pixelCanvas3 && this.isOpen && !pixelCanvas3.isSaving) {
                    pixelCanvas3.save();
                }
            }, 5000);
        }
    }
    
    /**
     * 단축키 가이드 모달 표시
     */
    showShortcutsModal() {
        if (this.shortcutsModalVisible) {
            this.hideShortcutsModal();
            return;
        }
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const modal = document.createElement('div');
        modal.className = 'pixel-shortcuts-modal';
        modal.innerHTML = `
            <div class="pixel-shortcuts-content">
                <div class="pixel-shortcuts-header">
                    <h3>⌨️ ${vocab.keyboardShortcuts}</h3>
                    <button class="pixel-shortcuts-close" onclick="this.closest('.pixel-shortcuts-modal').remove()">×</button>
                </div>
                <div class="pixel-shortcuts-list">
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>Z</kbd></div>
                        <div class="shortcut-desc">${vocab.undo}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>Y</kbd></div>
                        <div class="shortcut-desc">${vocab.redo}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>S</kbd></div>
                        <div class="shortcut-desc">${vocab.manualSave}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Space</kbd></div>
                        <div class="shortcut-desc">${vocab.panTool}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>B</kbd></div>
                        <div class="shortcut-desc">${vocab.brushTool}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>E</kbd></div>
                        <div class="shortcut-desc">${vocab.eraserTool}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>I</kbd></div>
                        <div class="shortcut-desc">${vocab.eyedropperTool}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>+</kbd> / <kbd>-</kbd></div>
                        <div class="shortcut-desc">${vocab.zoomInOut}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>F</kbd></div>
                        <div class="shortcut-desc">${vocab.fitView}</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>ESC</kbd></div>
                        <div class="shortcut-desc">${vocab.closeModal}</div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        this.shortcutsModalVisible = true;
        
        // ESC 키로 닫기
        const closeHandler = (e) => {
            if (e.key === 'Escape' && this.shortcutsModalVisible) {
                this.hideShortcutsModal();
            }
        };
        document.addEventListener('keydown', closeHandler, { once: true });
        
        // 클릭으로 닫기
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideShortcutsModal();
            }
        });
    }
    
    /**
     * 단축키 가이드 모달 숨기기
     */
    hideShortcutsModal() {
        const modal = document.querySelector('.pixel-shortcuts-modal');
        if (modal) {
            modal.remove();
        }
        this.shortcutsModalVisible = false;
    }
    
    /**
     * 영토 정보 업데이트
     */
    updateTerritoryInfo() {
        const infoEl = this.container?.querySelector('#pixel-territory-info-3');
        if (infoEl && this.currentTerritory) {
            const nameEl = infoEl.querySelector('.territory-name');
            if (nameEl) {
                const name = this.currentTerritory.name?.ko || 
                            this.currentTerritory.name?.en || 
                            this.currentTerritory.id;
                nameEl.textContent = name;
            }
        }
    }
    
}


export const pixelEditor3 = new PixelEditor3();
export default pixelEditor3;

