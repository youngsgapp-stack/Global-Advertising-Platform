/**
 * PixelEditor3 - 완전히 새로운 픽셀 에디터 UI
 * 모던하고 깔끔한 디자인
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { pixelCanvas3, TOOLS } from '../core/PixelCanvas3.js';

// 색상 팔레트
const PALETTE = [
    '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00',
    '#ff00ff', '#00ffff', '#ff6b6b', '#4ecdc4', '#feca57', '#a29bfe',
    '#fd79a8', '#00b894', '#e17055', '#74b9ff', '#dfe6e9', '#636e72',
    '#2d3436', '#fab1a0', '#81ecec', '#55efc4', '#fdcb6e', '#e84393'
];

class PixelEditor3 {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.tool = TOOLS.BRUSH;
        this.color = '#4ecdc4';
        this.brushSize = 1;
        this.customColors = [];
        this.shortcutsModalVisible = false;
        this.keyboardHandler = null;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.createModal();
        this.setupEvents();
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
        return `
            <div class="pixel-editor-3-overlay"></div>
            <div class="pixel-editor-3-content">
                <!-- 헤더 -->
                <div class="pixel-editor-3-header">
                    <h2>🎨 영토 꾸미기</h2>
                    <div class="pixel-editor-3-actions">
                        <button class="pixel-editor-3-btn" id="pixel-undo-3" title="실행 취소 (Ctrl+Z)">
                            <span>↩</span>
                        </button>
                        <button class="pixel-editor-3-btn" id="pixel-redo-3" title="다시 실행 (Ctrl+Y)">
                            <span>↪</span>
                        </button>
                        <button class="pixel-editor-3-btn" id="pixel-clear-3" title="전체 지우기">
                            <span>🗑</span>
                        </button>
                        <button class="pixel-editor-3-btn" id="pixel-shortcuts-3" title="키보드 단축키 가이드">⌨️</button>
                        <div class="pixel-editor-3-save-status" id="pixel-save-status-3">
                            <span>✅</span>
                            <span>저장됨</span>
                        </div>
                        <button class="pixel-editor-3-close" id="pixel-close-3">×</button>
                    </div>
                </div>
                
                <!-- 본문 -->
                <div class="pixel-editor-3-body">
                    <!-- 좌측: 도구 -->
                    <div class="pixel-editor-3-sidebar pixel-editor-3-tools">
                        <!-- 도구 -->
                        <div class="pixel-editor-3-section">
                            <h3>도구</h3>
                            <div class="pixel-editor-3-tool-grid">
                                <button class="pixel-editor-3-tool-btn active" data-tool="brush" title="브러시">
                                    <span class="tool-icon">✏</span>
                                    <span>브러시</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="eraser" title="지우개">
                                    <span class="tool-icon">🧹</span>
                                    <span>지우개</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="fill" title="채우기">
                                    <span class="tool-icon">🪣</span>
                                    <span>채우기</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="picker" title="스포이드">
                                    <span class="tool-icon">💉</span>
                                    <span>스포이드</span>
                                </button>
                                <button class="pixel-editor-3-tool-btn" data-tool="pan" title="이동 (Space)">
                                    <span class="tool-icon">✋</span>
                                    <span>이동</span>
                                </button>
                            </div>
                        </div>
                        
                        <!-- 브러시 크기 -->
                        <div class="pixel-editor-3-section">
                            <h3>브러시 크기</h3>
                            <div class="pixel-editor-3-brush-control">
                                <input type="range" id="pixel-brush-size-3" min="1" max="10" value="1">
                                <span id="pixel-brush-size-value-3">1px</span>
                            </div>
                        </div>
                        
                        <!-- 색상 -->
                        <div class="pixel-editor-3-section">
                            <h3>색상</h3>
                            <div class="pixel-editor-3-color-picker">
                                <div class="pixel-editor-3-color-preview" id="pixel-color-preview-3" style="background: ${this.color}"></div>
                                <input type="color" id="pixel-color-input-3" value="${this.color}">
                            </div>
                        </div>
                        
                        <!-- 팔레트 -->
                        <div class="pixel-editor-3-section">
                            <h3>팔레트</h3>
                            <div class="pixel-editor-3-palette">
                                ${PALETTE.map(color => `
                                    <div class="pixel-editor-3-palette-color" data-color="${color}" style="background: ${color}"></div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                    
                    <!-- 중앙: 캔버스 -->
                    <div class="pixel-editor-3-main">
                        <div class="pixel-editor-3-loading-overlay" id="pixel-loading-3" style="display: none;">
                            <div class="pixel-editor-3-loading-spinner"></div>
                            <p>픽셀 아트 로딩 중...</p>
                        </div>
                        <div class="pixel-editor-3-canvas-wrapper">
                            <canvas id="pixel-canvas-3"></canvas>
                            <!-- 줌 컨트롤 -->
                            <div class="pixel-editor-3-zoom-controls">
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-in-3" title="줌 인 (+ / 휠 업)">+</button>
                                <div class="pixel-editor-3-zoom-display" id="pixel-zoom-value-3">100%</div>
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-out-3" title="줌 아웃 (- / 휠 다운)">−</button>
                                <button class="pixel-editor-3-zoom-btn" id="pixel-zoom-fit-3" title="전체 보기 (F)">⌂</button>
                                <div class="pixel-editor-3-zoom-hint">Shift+드래그: 이동</div>
                            </div>
                        </div>
                        <div class="pixel-editor-3-canvas-info">
                            <span id="pixel-count-3">0 / ${(CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE).toLocaleString()} 픽셀</span>
                            <span id="pixel-coords-3">X: 0, Y: 0</span>
                        </div>
                    </div>
                    
                    <!-- 우측: 통계 -->
                    <div class="pixel-editor-3-sidebar pixel-editor-3-stats">
                        <div class="pixel-editor-3-section">
                            <h3>📊 통계</h3>
                            <div class="pixel-editor-3-stat-list">
                                <div class="pixel-editor-3-stat-item">
                                    <span>총 픽셀</span>
                                    <span id="pixel-total-3">0</span>
                                </div>
                                <div class="pixel-editor-3-stat-item">
                                    <span>영토 가치</span>
                                    <span id="pixel-value-3">0</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="pixel-editor-3-section">
                            <h3>🖼 내보내기</h3>
                            <button class="pixel-editor-3-btn pixel-editor-3-btn-primary" id="pixel-export-3">
                                PNG 다운로드
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
                this.updateSaveStatus(data.status, data.error);
            }
        });
    }
    
    /**
     * 열기
     */
    async open(territory) {
        if (!territory?.id) {
            log.error('[PixelEditor3] Invalid territory');
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '영토 정보를 찾을 수 없습니다.'
            });
            return;
        }
        
        this.showLoading('영토 정보 로딩 중...');
        this.currentTerritory = territory;
        this.isOpen = true;
        this.container?.classList.remove('hidden');
        
        try {
            // 캔버스 초기화 (territory 객체도 전달)
            const canvas = document.getElementById('pixel-canvas-3');
            if (canvas) {
                this.showLoading('픽셀 아트 로딩 중...');
                await pixelCanvas3.initialize(territory.id, canvas, territory);
            }
            
            // UI 바인딩
            this.bindUI();
            
            // 통계 업데이트
            this.updateStats({
                filledPixels: pixelCanvas3.pixels.size,
                value: pixelCanvas3.calculateValue()
            });
            
            log.info(`[PixelEditor3] Opened for ${territory.id}`);
        } catch (error) {
            log.error('[PixelEditor3] Failed to open:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '픽셀 편집기를 열 수 없습니다. 잠시 후 다시 시도해주세요.'
            });
            this.close();
        } finally {
            this.hideLoading();
        }
    }
    
    /**
     * 로딩 표시
     */
    showLoading(message = '로딩 중...') {
        const loadingEl = this.container?.querySelector('#pixel-loading-3');
        if (loadingEl) {
            const pEl = loadingEl.querySelector('p');
            if (pEl) pEl.textContent = message;
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
    close() {
        if (pixelCanvas3?.hasUnsavedChanges && pixelCanvas3.hasUnsavedChanges()) {
            const confirmed = confirm(
                '저장되지 않은 변경사항이 있습니다.\n\n' +
                '정말로 편집기를 닫으시겠습니까?\n' +
                '(변경사항은 자동으로 저장됩니다)'
            );
            if (!confirmed) return;
        }
        
        this.isOpen = false;
        this.container?.classList.add('hidden');
        if (pixelCanvas3) {
            pixelCanvas3.cleanup();
        }
        this.currentTerritory = null;
        this.hideShortcutsModal();
    }
    
    /**
     * UI 바인딩
     */
    bindUI() {
        if (!this.container) return;
        
        // 닫기
        const closeBtn = this.container.querySelector('#pixel-close-3');
        if (closeBtn) {
            closeBtn.onclick = () => this.close();
        }
        
        // 오버레이 클릭
        const overlay = this.container.querySelector('.pixel-editor-3-overlay');
        if (overlay) {
            overlay.onclick = () => this.close();
        }
        
        // 도구 버튼
        this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(btn => {
            btn.onclick = () => {
                const tool = btn.dataset.tool;
                this.setTool(tool);
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
        
        // Undo/Redo
        const undoBtn = this.container.querySelector('#pixel-undo-3');
        if (undoBtn) undoBtn.onclick = () => pixelCanvas3.undo();
        
        const redoBtn = this.container.querySelector('#pixel-redo-3');
        if (redoBtn) redoBtn.onclick = () => pixelCanvas3.redo();
        
        // 클리어
        const clearBtn = this.container.querySelector('#pixel-clear-3');
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (confirm('모든 픽셀을 지우시겠습니까?')) {
                    pixelCanvas3.clear();
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
            
            // Space: 이동 도구 (캔버스에서만)
            if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (!e.repeat) {
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
                    if (pixelCanvas3) {
                        pixelCanvas3.fitToView();
                    }
                }
            } else if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                this.setTool(TOOLS.PICKER);
                const pickerBtn = this.container.querySelector('[data-tool="picker"]');
                if (pickerBtn) {
                    this.container.querySelectorAll('.pixel-editor-3-tool-btn').forEach(b => b.classList.remove('active'));
                    pickerBtn.classList.add('active');
                }
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
        
        // Space 키 up 시 브러시로 복귀
        document.addEventListener('keyup', (e) => {
            if (!this.isOpen) return;
            if (e.key === ' ' && this.tool === TOOLS.PAN) {
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
     * 통계 업데이트
     */
    updateStats(data) {
        const total = CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        
        const countEl = this.container?.querySelector('#pixel-count-3');
        if (countEl) {
            countEl.textContent = `${data.filledPixels?.toLocaleString() || 0} / ${total.toLocaleString()} 픽셀`;
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
    updateSaveStatus(status, error = null) {
        const statusEl = this.container?.querySelector('#pixel-save-status-3');
        if (!statusEl) return;
        
        const icon = statusEl.querySelector('span:first-child');
        const text = statusEl.querySelector('span:last-child');
        
        // 기존 클래스 제거
        statusEl.classList.remove('saving', 'saved', 'error');
        
        if (status === 'saving') {
            icon.textContent = '💾';
            text.textContent = '저장 중...';
            statusEl.classList.add('saving');
        } else if (status === 'saved') {
            icon.textContent = '✅';
            text.textContent = '저장됨';
            statusEl.classList.add('saved');
            // 3초 후 약하게 표시
            setTimeout(() => {
                if (this.container?.querySelector('#pixel-save-status-3')) {
                    icon.textContent = '💾';
                    text.textContent = '저장됨';
                }
            }, 3000);
        } else if (status === 'error') {
            icon.textContent = '⚠️';
            text.textContent = '저장 실패';
            statusEl.classList.add('error');
            statusEl.title = error || '저장 중 오류가 발생했습니다. 다시 시도해주세요.';
            // 5초 후 자동으로 다시 저장 시도
            setTimeout(() => {
                if (pixelCanvas3 && this.isOpen) {
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
        
        const modal = document.createElement('div');
        modal.className = 'pixel-shortcuts-modal';
        modal.innerHTML = `
            <div class="pixel-shortcuts-content">
                <div class="pixel-shortcuts-header">
                    <h3>⌨️ 키보드 단축키</h3>
                    <button class="pixel-shortcuts-close" onclick="this.closest('.pixel-shortcuts-modal').remove()">×</button>
                </div>
                <div class="pixel-shortcuts-list">
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>Z</kbd></div>
                        <div class="shortcut-desc">실행 취소</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>Y</kbd></div>
                        <div class="shortcut-desc">다시 실행</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>S</kbd></div>
                        <div class="shortcut-desc">수동 저장</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>Space</kbd></div>
                        <div class="shortcut-desc">이동 도구 (누르는 동안)</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>B</kbd></div>
                        <div class="shortcut-desc">브러시 도구</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>E</kbd></div>
                        <div class="shortcut-desc">지우개</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>I</kbd></div>
                        <div class="shortcut-desc">스포이드</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>+</kbd> / <kbd>-</kbd></div>
                        <div class="shortcut-desc">줌 인/아웃</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>F</kbd></div>
                        <div class="shortcut-desc">전체 보기</div>
                    </div>
                    <div class="shortcut-item">
                        <div class="shortcut-keys"><kbd>ESC</kbd></div>
                        <div class="shortcut-desc">모달 닫기</div>
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
}

export const pixelEditor3 = new PixelEditor3();
export default pixelEditor3;

