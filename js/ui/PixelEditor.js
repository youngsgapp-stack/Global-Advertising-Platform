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
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'pixel-editor-modal') {
        this.createModal(containerId);
        this.setupEventListeners();
        
        log.info('PixelEditor initialized');
    }
    
    /**
     * 모달 생성
     */
    createModal(containerId) {
        this.container = document.createElement('div');
        this.container.id = containerId;
        this.container.className = 'modal pixel-editor-modal hidden';
        this.container.innerHTML = this.getModalHTML();
        document.body.appendChild(this.container);
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
                            <button class="btn btn-primary btn-sm" id="toggle-collab">협업 시작</button>
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
        this.currentTerritory = territory;
        this.isOpen = true;
        
        // 모달 표시
        this.container.classList.remove('hidden');
        
        // 캔버스 초기화
        const canvasElement = document.getElementById('pixel-canvas');
        await pixelCanvas.initialize(territory.id, canvasElement);
        
        // UI 바인딩
        this.bindUIEvents();
        
        // 협업 상태 확인
        this.updateCollabStatus();
        
        // 통계 업데이트
        this.updateStats({
            filledPixels: pixelCanvas.pixels.size,
            value: pixelCanvas.calculateValue()
        });
        
        log.info(`PixelEditor opened for territory: ${territory.id}`);
    }
    
    /**
     * 에디터 닫기
     */
    close() {
        this.isOpen = false;
        this.container.classList.add('hidden');
        
        // 캔버스 정리
        pixelCanvas.cleanup();
        
        this.currentTerritory = null;
    }
    
    /**
     * UI 이벤트 바인딩
     */
    bindUIEvents() {
        // 닫기 버튼
        document.getElementById('close-pixel-editor')?.addEventListener('click', () => this.close());
        
        // 도구 버튼
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                this.setTool(tool);
            });
        });
        
        // 브러시 크기 슬라이더
        const brushSlider = document.getElementById('brush-size-slider');
        brushSlider?.addEventListener('input', (e) => {
            this.brushSize = parseInt(e.target.value);
            pixelCanvas.setBrushSize(this.brushSize);
            document.getElementById('brush-size-value').textContent = `${this.brushSize}px`;
        });
        
        // 컬러 피커
        const colorPicker = document.getElementById('color-picker-input');
        colorPicker?.addEventListener('input', (e) => {
            this.setColor(e.target.value);
        });
        
        // 팔레트 색상
        document.querySelectorAll('.palette-color').forEach(el => {
            el.addEventListener('click', () => {
                this.setColor(el.dataset.color);
            });
        });
        
        // 커스텀 색상 추가
        document.getElementById('add-custom-color')?.addEventListener('click', () => {
            this.addCustomColor(this.currentColor);
        });
        
        // Undo/Redo
        document.getElementById('pixel-undo')?.addEventListener('click', () => pixelCanvas.undo());
        document.getElementById('pixel-redo')?.addEventListener('click', () => pixelCanvas.redo());
        
        // 클리어
        document.getElementById('pixel-clear')?.addEventListener('click', () => {
            if (confirm('모든 픽셀을 지우시겠습니까?')) {
                pixelCanvas.clear();
            }
        });
        
        // 저장
        document.getElementById('pixel-save')?.addEventListener('click', async () => {
            await pixelCanvas.saveToFirestore();
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '저장되었습니다!'
            });
        });
        
        // 내보내기
        document.getElementById('export-png')?.addEventListener('click', () => {
            this.exportAsPNG();
        });
        
        // 협업 토글
        document.getElementById('toggle-collab')?.addEventListener('click', () => {
            this.toggleCollaboration();
        });
        
        // 캔버스 좌표 표시
        const canvas = document.getElementById('pixel-canvas');
        canvas?.addEventListener('mousemove', (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / (canvas.width / CONFIG.TERRITORY.PIXEL_GRID_SIZE));
            const y = Math.floor((e.clientY - rect.top) / (canvas.height / CONFIG.TERRITORY.PIXEL_GRID_SIZE));
            document.getElementById('canvas-coords').textContent = `X: ${x}, Y: ${y}`;
        });
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
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolName);
        });
    }
    
    /**
     * 색상 설정
     */
    setColor(color) {
        this.currentColor = color;
        pixelCanvas.setColor(color);
        
        document.getElementById('current-color-preview').style.background = color;
        document.getElementById('color-picker-input').value = color;
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
        const container = document.getElementById('custom-colors');
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
        const collab = collaborationHub.getCollaboration(this.currentTerritory.id);
        const statusEl = document.getElementById('collab-status');
        const toggleBtn = document.getElementById('toggle-collab');
        const leaderboardSection = document.getElementById('collab-leaderboard-section');
        
        if (collab) {
            statusEl.innerHTML = `
                <span class="status-active">🟢 활성화</span>
                <span class="collaborator-count">${collab.stats.totalContributors}명 참여 중</span>
            `;
            toggleBtn.textContent = '협업 종료';
            leaderboardSection.style.display = 'block';
            this.updateLeaderboard(collab);
        } else {
            statusEl.innerHTML = '<span class="status-inactive">⚫ 비활성화</span>';
            toggleBtn.textContent = '협업 시작';
            leaderboardSection.style.display = 'none';
        }
    }
    
    /**
     * 협업 토글
     */
    async toggleCollaboration() {
        const collab = collaborationHub.getCollaboration(this.currentTerritory.id);
        
        if (collab) {
            // 협업 종료
            await collaborationHub.closeCollaboration(this.currentTerritory.id);
        } else {
            // 협업 시작
            await collaborationHub.openCollaboration(this.currentTerritory.id);
        }
        
        this.updateCollabStatus();
    }
    
    /**
     * 리더보드 업데이트
     */
    updateLeaderboard(collab) {
        const leaderboard = collaborationHub.getLeaderboard(this.currentTerritory.id);
        const container = document.getElementById('collab-leaderboard');
        
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
        
        document.getElementById('pixel-count').textContent = 
            `${data.filledPixels?.toLocaleString() || 0} / ${total.toLocaleString()} 픽셀`;
        
        document.getElementById('total-pixels').textContent = 
            data.filledPixels?.toLocaleString() || '0';
        
        document.getElementById('territory-value').textContent = 
            data.value?.toLocaleString() || '0';
        
        // 내 기여도
        const user = firebaseService.getCurrentUser();
        if (user) {
            const contributors = pixelCanvas.getContributorStats();
            const myContrib = contributors.find(c => c.userId === user.uid);
            document.getElementById('my-contribution').textContent = 
                myContrib ? `${myContrib.count} (${myContrib.percentage}%)` : '0';
        }
    }
    
    /**
     * PNG로 내보내기
     */
    exportAsPNG() {
        const dataURL = pixelCanvas.toDataURL();
        const link = document.createElement('a');
        link.download = `${this.currentTerritory.name.ko || this.currentTerritory.id}_pixel_art.png`;
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

