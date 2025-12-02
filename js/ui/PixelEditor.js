/**
 * PixelEditor - 픽셀 에디터 UI
 * 캔버스 도구, 색상 팔레트, 레이어 컨트롤
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { pixelCanvas, PIXEL_TOOLS } from '../core/PixelCanvas.js';
import { collaborationHub } from '../features/CollaborationHub.js';
import { firebaseService } from '../services/FirebaseService.js';

// 기본 색상 팔레트
const DEFAULT_PALETTE = [
    '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00',
    '#ff00ff', '#00ffff', '#ff6b6b', '#4ecdc4', '#feca57', '#a29bfe',
    '#fd79a8', '#00b894', '#e17055', '#74b9ff', '#dfe6e9', '#636e72',
    '#2d3436', '#fab1a0', '#81ecec', '#55efc4', '#fdcb6e', '#e84393'
];

class PixelEditor {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.currentTool = PIXEL_TOOLS.BRUSH;
        this.currentColor = '#4ecdc4';
        this.brushSize = 1;
        this.customColors = [];
        this.eventListenersBound = false; // 이벤트 바인딩 여부 추적
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'pixel-editor-modal') {
        console.log('🔥🔥🔥 PixelEditor.initialize() CALLED! 🔥🔥🔥');
        this.createModal(containerId);
        this.setupEventListeners();
        log.info('PixelEditor initialized');
    }
    
    /**
     * 모달 생성
     */
    createModal(containerId) {
        console.log('🔥 Creating pixel editor modal...');
        this.container = document.createElement('div');
        this.container.id = containerId;
        this.container.className = 'pixel-editor-modal hidden';
        this.container.innerHTML = this.getModalHTML();
        document.body.appendChild(this.container);
        console.log('✅ Pixel editor modal created:', this.container);
    }
    
    /**
     * 모달 HTML
     */
    getModalHTML() {
        return `
            <div class="modal-content pixel-editor-content">
                <div class="modal-header">
                    <h2>🎨 영토 꾸미기</h2>
                    <div class="editor-actions">
                        <button class="btn btn-secondary" id="pixel-undo" title="실행 취소 (Ctrl+Z)">↩️</button>
                        <button class="btn btn-secondary" id="pixel-redo" title="다시 실행 (Ctrl+Y)">↪️</button>
                        <button class="btn btn-secondary" id="pixel-clear" title="전체 지우기">🗑️</button>
                        <button class="btn btn-primary" id="pixel-save" title="저장">💾 저장</button>
                        <button class="close-btn" id="close-pixel-editor">&times;</button>
                    </div>
                </div>
                
                <div class="editor-body">
                    <!-- 좌측: 도구 패널 -->
                    <div class="tools-panel">
                        <div class="tools-section">
                            <h4>도구</h4>
                            <div class="tool-buttons">
                                <button class="tool-btn active" data-tool="brush" title="브러시 (B)">
                                    <span class="tool-icon">✏️</span>
                                    <span class="tool-name">브러시</span>
                                </button>
                                <button class="tool-btn" data-tool="eraser" title="지우개 (E)">
                                    <span class="tool-icon">🧹</span>
                                    <span class="tool-name">지우개</span>
                                </button>
                                <button class="tool-btn" data-tool="fill" title="채우기 (F)">
                                    <span class="tool-icon">🪣</span>
                                    <span class="tool-name">채우기</span>
                                </button>
                                <button class="tool-btn" data-tool="picker" title="스포이드 (I)">
                                    <span class="tool-icon">💉</span>
                                    <span class="tool-name">스포이드</span>
                                </button>
                            </div>
                        </div>
                        
                        <div class="tools-section">
                            <h4>브러시 크기</h4>
                            <div class="brush-size-control">
                                <input type="range" id="brush-size-slider" min="1" max="10" value="1">
                                <span id="brush-size-value">1px</span>
                            </div>
                        </div>
                        
                        <div class="tools-section">
                            <h4>현재 색상</h4>
                            <div class="current-color-display">
                                <div class="color-preview" id="current-color-preview" style="background: ${this.currentColor}"></div>
                                <input type="color" id="color-picker-input" value="${this.currentColor}">
                            </div>
                        </div>
                        
                        <div class="tools-section">
                            <h4>팔레트</h4>
                            <div class="color-palette" id="color-palette">
                                ${DEFAULT_PALETTE.map(color => `
                                    <div class="palette-color" data-color="${color}" style="background: ${color}" title="${color}"></div>
                                `).join('')}
                            </div>
                        </div>
                        
                        <div class="tools-section">
                            <h4>내 색상</h4>
                            <div class="custom-colors" id="custom-colors"></div>
                            <button class="btn btn-secondary btn-sm" id="add-custom-color">+ 추가</button>
                        </div>
                    </div>
                    
                    <!-- 중앙: 캔버스 -->
                    <div class="canvas-container">
                        <div class="canvas-wrapper">
                            <canvas id="pixel-canvas"></canvas>
                        </div>
                        <div class="canvas-info">
                            <span id="pixel-count">0 / 10,000 픽셀</span>
                            <span id="canvas-coords">X: 0, Y: 0</span>
                        </div>
                    </div>
                    
                    <!-- 우측: 협업 패널 -->
                    <div class="collab-panel">
                        <div class="collab-section">
                            <h4>👥 협업</h4>
                            <div id="collab-status" class="collab-status">
                                <span class="status-text">비활성화</span>
                            </div>
                            <button class="btn btn-primary btn-sm" id="toggle-collab">Start Collab</button>
                        </div>
                        
                        <div class="collab-section" id="collab-leaderboard-section" style="display: none;">
                            <h4>🏆 기여 랭킹</h4>
                            <div class="collab-leaderboard" id="collab-leaderboard"></div>
                        </div>
                        
                        <div class="collab-section">
                            <h4>📊 통계</h4>
                            <div class="pixel-stats">
                                <div class="stat-row">
                                    <span>총 픽셀</span>
                                    <span id="total-pixels">0</span>
                                </div>
                                <div class="stat-row">
                                    <span>내 기여</span>
                                    <span id="my-contribution">0</span>
                                </div>
                                <div class="stat-row">
                                    <span>영토 가치</span>
                                    <span id="territory-value">0</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="collab-section">
                            <h4>🖼️ 내보내기</h4>
                            <button class="btn btn-secondary btn-sm" id="export-png">PNG 다운로드</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 모달 열기 이벤트
        eventBus.on(EVENTS.UI_MODAL_OPEN, (data) => {
            if (data.type === 'pixelEditor') {
                this.open(data.data);
            }
        });
        
        // 픽셀 업데이트 이벤트
        eventBus.on(EVENTS.PIXEL_UPDATE, (data) => {
            if (data.type === 'colorPicked') {
                this.setColor(data.color);
            } else if (data.type === 'toolChanged') {
                this.updateToolUI(data.tool);
            }
        });
        
        // 픽셀 가치 변경
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, (data) => {
            this.updateStats(data);
        });
    }
    
    /**
     * 에디터 열기
     */
    async open(territory) {
        console.log('🔥🔥🔥 PixelEditor.open() CALLED! 🔥🔥🔥');
        console.log('Territory:', territory);
        log.info(`PixelEditor opening for territory: ${territory?.id}`);
        
        if (!territory || !territory.id) {
            console.error('❌ Invalid territory provided!');
            return;
        }
        
        this.currentTerritory = territory;
        this.isOpen = true;
        
        // 모달 표시
        if (this.container) {
            this.container.classList.remove('hidden');
            console.log('✅ Modal shown');
        } else {
            console.error('❌ Container not found!');
            return;
        }
        
        // 캔버스 초기화
        const canvasElement = document.getElementById('pixel-canvas');
        if (!canvasElement) {
            console.error('❌ Canvas element not found!');
            return;
        }
        
        console.log('🔥 Initializing pixel canvas...');
        await pixelCanvas.initialize(territory.id, canvasElement);
        console.log('✅ Pixel canvas initialized');
        
        // UI 바인딩 (한 번만)
        if (!this.eventListenersBound) {
            console.log('🔥 Binding UI events (first time)...');
            this.bindUIEvents();
            this.eventListenersBound = true;
        } else {
            console.log('⚠️ UI events already bound, re-binding anyway...');
            this.bindUIEvents();
        }
        
        // 협업 상태 확인
        this.updateCollabStatus();
        
        // 통계 업데이트
        this.updateStats({
            filledPixels: pixelCanvas.pixels.size,
            value: pixelCanvas.calculateValue()
        });
        
        log.info(`PixelEditor opened for territory: ${territory.id}`);
        console.log('✅ PixelEditor opened successfully!');
    }
    
    /**
     * 에디터 닫기
     */
    close() {
        this.isOpen = false;
        if (this.container) {
            this.container.classList.add('hidden');
        }
        
        // 캔버스 정리
        pixelCanvas.cleanup();
        
        this.currentTerritory = null;
    }
    
    /**
     * UI 이벤트 바인딩 (완전히 재작성)
     */
    bindUIEvents() {
        console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
        console.log('🔥🔥🔥 bindUIEvents() CALLED! 🔥🔥🔥');
        console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
        log.info('🔧 Binding UI events in PixelEditor...');
        
        if (!this.container) {
            console.error('❌ Container not found! Cannot bind events.');
            return;
        }
        
        // 저장 버튼 직접 찾기 및 이벤트 등록
        const saveButton = this.container.querySelector('#pixel-save');
        console.log('🔥 Checking save button:', saveButton);
        console.log('Container:', this.container);
        console.log('Container HTML:', this.container.innerHTML.substring(0, 500));
        
        if (saveButton) {
            console.log('✅ Save button found! Text:', saveButton.textContent);
            
            // 기존 리스너 제거
            const newSaveButton = saveButton.cloneNode(true);
            saveButton.parentNode?.replaceChild(newSaveButton, saveButton);
            
            // 새 리스너 추가
            newSaveButton.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
                console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
                console.log('🔥🔥🔥 SAVE BUTTON CLICKED! 🔥🔥🔥');
                console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
                console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
                
                // 즉시 alert
                alert('💾💾💾 저장 버튼 클릭됨! 💾💾💾');
                
                await this.handleSave();
            }, { capture: true }); // 캡처 단계에서 먼저 처리
            
            console.log('✅ Save button event listener added!');
        } else {
            console.error('❌❌❌ Save button NOT FOUND! ❌❌❌');
            // 모든 버튼 찾기
            const allButtons = this.container.querySelectorAll('button');
            console.log('All buttons in container:', Array.from(allButtons).map(b => ({
                id: b.id,
                text: b.textContent?.trim(),
                classes: Array.from(b.classList)
            })));
        }
        
        // 닫기 버튼
        const closeBtn = this.container.querySelector('#close-pixel-editor');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }
        
        // 도구 버튼
        this.container.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                this.setTool(tool);
            });
        });
        
        // 브러시 크기 슬라이더
        const brushSlider = this.container.querySelector('#brush-size-slider');
        if (brushSlider) {
            brushSlider.addEventListener('input', (e) => {
                this.brushSize = parseInt(e.target.value);
                pixelCanvas.setBrushSize(this.brushSize);
                const valueDisplay = this.container.querySelector('#brush-size-value');
                if (valueDisplay) {
                    valueDisplay.textContent = `${this.brushSize}px`;
                }
            });
        }
        
        // 컬러 피커
        const colorPicker = this.container.querySelector('#color-picker-input');
        if (colorPicker) {
            colorPicker.addEventListener('input', (e) => {
                this.setColor(e.target.value);
            });
        }
        
        // 팔레트 색상
        this.container.querySelectorAll('.palette-color').forEach(el => {
            el.addEventListener('click', () => {
                this.setColor(el.dataset.color);
            });
        });
        
        // 커스텀 색상 추가
        const addColorBtn = this.container.querySelector('#add-custom-color');
        if (addColorBtn) {
            addColorBtn.addEventListener('click', () => {
                this.addCustomColor(this.currentColor);
            });
        }
        
        // Undo/Redo
        const undoBtn = this.container.querySelector('#pixel-undo');
        if (undoBtn) {
            undoBtn.addEventListener('click', () => pixelCanvas.undo());
        }
        
        const redoBtn = this.container.querySelector('#pixel-redo');
        if (redoBtn) {
            redoBtn.addEventListener('click', () => pixelCanvas.redo());
        }
        
        // 클리어
        const clearBtn = this.container.querySelector('#pixel-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('모든 픽셀을 지우시겠습니까?')) {
                    pixelCanvas.clear();
                }
            });
        }
        
        // 내보내기
        const exportBtn = this.container.querySelector('#export-png');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportAsPNG();
            });
        }
        
        // 협업 토글
        const collabBtn = this.container.querySelector('#toggle-collab');
        if (collabBtn) {
            collabBtn.addEventListener('click', () => {
                this.toggleCollaboration();
            });
        }
        
        // 캔버스 좌표 표시
        const canvas = this.container.querySelector('#pixel-canvas');
        if (canvas) {
            canvas.addEventListener('mousemove', (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = Math.floor((e.clientX - rect.left) / (canvas.width / CONFIG.TERRITORY.PIXEL_GRID_SIZE));
                const y = Math.floor((e.clientY - rect.top) / (canvas.height / CONFIG.TERRITORY.PIXEL_GRID_SIZE));
                const coordsEl = this.container.querySelector('#canvas-coords');
                if (coordsEl) {
                    coordsEl.textContent = `X: ${x}, Y: ${y}`;
                }
            });
        }
        
        console.log('✅ All UI events bound!');
    }
    
    /**
     * 저장 핸들러
     */
    async handleSave() {
        console.log('🔥🔥🔥 handleSave() CALLED! 🔥🔥🔥');
        log.info('💾 Handle save called in PixelEditor');
        
        try {
            console.log('🔥 Step 1: Calling saveToFirestore...');
            log.info('💾 Calling saveToFirestore...');
            
            await pixelCanvas.saveToFirestore();
            
            console.log('✅ Step 2: saveToFirestore completed successfully!');
            log.info('✅ saveToFirestore completed successfully!');
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '저장되었습니다!'
            });
            
            console.log('✅ Step 3: All done!');
        } catch (error) {
            console.error('❌❌❌ ERROR in handleSave ❌❌❌');
            console.error('Error:', error);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            log.error('❌ ERROR in handleSave:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '저장 실패: ' + (error.message || '알 수 없는 오류')
            });
        }
    }
    
    /**
     * 도구 설정
     */
    setTool(toolName) {
        this.currentTool = toolName;
        pixelCanvas.setTool(toolName);
        this.updateToolUI(toolName);
    }
    
    /**
     * 도구 UI 업데이트
     */
    updateToolUI(toolName) {
        this.container?.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolName);
        });
    }
    
    /**
     * 색상 설정
     */
    setColor(color) {
        this.currentColor = color;
        pixelCanvas.setColor(color);
        
        const preview = this.container?.querySelector('#current-color-preview');
        if (preview) {
            preview.style.background = color;
        }
        
        const picker = this.container?.querySelector('#color-picker-input');
        if (picker) {
            picker.value = color;
        }
    }
    
    /**
     * 커스텀 색상 추가
     */
    addCustomColor(color) {
        if (this.customColors.includes(color)) return;
        
        this.customColors.push(color);
        this.updateCustomColorsUI();
    }
    
    /**
     * 커스텀 색상 UI 업데이트
     */
    updateCustomColorsUI() {
        const container = this.container?.querySelector('#custom-colors');
        if (!container) return;
        
        container.innerHTML = this.customColors.map(color => `
            <div class="palette-color custom" data-color="${color}" style="background: ${color}" title="${color}"></div>
        `).join('');
        
        container.querySelectorAll('.palette-color').forEach(el => {
            el.addEventListener('click', () => {
                this.setColor(el.dataset.color);
            });
        });
    }
    
    /**
     * 협업 상태 업데이트
     */
    updateCollabStatus() {
        if (!this.currentTerritory) return;
        
        const collab = collaborationHub.getCollaboration(this.currentTerritory.id);
        const statusEl = this.container?.querySelector('#collab-status');
        const toggleBtn = this.container?.querySelector('#toggle-collab');
        const leaderboardSection = this.container?.querySelector('#collab-leaderboard-section');
        
        if (statusEl && toggleBtn) {
            if (collab) {
                statusEl.innerHTML = `
                    <span class="status-active">🟢 활성화</span>
                    <span class="collaborator-count">${collab.stats.totalContributors}명 참여 중</span>
                `;
                toggleBtn.textContent = '협업 종료';
                if (leaderboardSection) {
                    leaderboardSection.style.display = 'block';
                }
                this.updateLeaderboard(collab);
            } else {
                statusEl.innerHTML = '<span class="status-inactive">⚫ 비활성화</span>';
                toggleBtn.textContent = 'Start Collab';
                if (leaderboardSection) {
                    leaderboardSection.style.display = 'none';
                }
            }
        }
    }
    
    /**
     * 협업 토글
     */
    async toggleCollaboration() {
        if (!this.currentTerritory) return;
        
        const collab = collaborationHub.getCollaboration(this.currentTerritory.id);
        
        if (collab) {
            await collaborationHub.closeCollaboration(this.currentTerritory.id);
        } else {
            await collaborationHub.openCollaboration(this.currentTerritory.id);
        }
        
        this.updateCollabStatus();
    }
    
    /**
     * 리더보드 업데이트
     */
    updateLeaderboard(collab) {
        if (!this.currentTerritory) return;
        
        const leaderboard = collaborationHub.getLeaderboard(this.currentTerritory.id);
        const container = this.container?.querySelector('#collab-leaderboard');
        
        if (!container) return;
        
        container.innerHTML = leaderboard.slice(0, 5).map((entry, index) => `
            <div class="leaderboard-item ${index < 3 ? 'top-3' : ''}">
                <span class="rank">${this.getRankIcon(index + 1)}</span>
                <span class="name">${entry.userName}</span>
                <span class="pixels">${entry.pixelCount} px</span>
            </div>
        `).join('');
    }
    
    /**
     * 랭크 아이콘
     */
    getRankIcon(rank) {
        const icons = { 1: '🥇', 2: '🥈', 3: '🥉' };
        return icons[rank] || `${rank}위`;
    }
    
    /**
     * 통계 업데이트
     */
    updateStats(data) {
        const total = CONFIG.TERRITORY.PIXEL_GRID_SIZE * CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        
        const pixelCountEl = this.container?.querySelector('#pixel-count');
        if (pixelCountEl) {
            pixelCountEl.textContent = `${data.filledPixels?.toLocaleString() || 0} / ${total.toLocaleString()} 픽셀`;
        }
        
        const totalPixelsEl = this.container?.querySelector('#total-pixels');
        if (totalPixelsEl) {
            totalPixelsEl.textContent = data.filledPixels?.toLocaleString() || '0';
        }
        
        const valueEl = this.container?.querySelector('#territory-value');
        if (valueEl) {
            valueEl.textContent = data.value?.toLocaleString() || '0';
        }
        
        // 내 기여도
        const user = firebaseService.getCurrentUser();
        if (user) {
            const contributors = pixelCanvas.getContributorStats();
            const myContrib = contributors.find(c => c.userId === user.uid);
            const myContribEl = this.container?.querySelector('#my-contribution');
            if (myContribEl) {
                myContribEl.textContent = myContrib ? `${myContrib.count} (${myContrib.percentage}%)` : '0';
            }
        }
    }
    
    /**
     * PNG로 내보내기
     */
    exportAsPNG() {
        const dataURL = pixelCanvas.toDataURL();
        const link = document.createElement('a');
        link.download = `${this.currentTerritory.name?.ko || this.currentTerritory.id}_pixel_art.png`;
        link.href = dataURL;
        link.click();
        
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'success',
            message: 'PNG 파일이 다운로드되었습니다!'
        });
    }
}

// 싱글톤 인스턴스
export const pixelEditor = new PixelEditor();
export default pixelEditor;
