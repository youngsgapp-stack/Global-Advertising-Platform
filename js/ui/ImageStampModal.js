/**
 * ImageStampModal - 이미지 스탬프 업로드 모달
 * 
 * 핵심 설계 원칙:
 * 1. 좌표계는 World(셀 단위)와 Screen(CSS px)만 사용
 * 2. 상태의 진실(SSOT)은 rectWorld 하나
 * 3. Territory는 셀 마스크 기준
 * 4. Overlay는 DOM이 아니라 Canvas에서 통합
 * 5. 렌더는 상태를 바꾸지 않음
 * 6. 프리뷰와 적용의 규칙은 같고, 품질만 다름
 * 7. 캔버스 2장 구조 (Static/Dynamic)
 */

import { CONFIG, log } from '../config.js';
import { TerritoryMask } from '../core/TerritoryMask.js';
import { pixelCanvas3 } from '../core/PixelCanvas3.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

/**
 * ViewTransform - World ↔ Screen 좌표계 변환 통일 클래스
 */
class ViewTransform {
    constructor() {
        this.scale = 1.0;  // world -> screen 변환 스케일
        this.tx = 0;        // screen px (pan offset)
        this.ty = 0;
    }
    
    worldToScreen(x, y) {
        return {
            x: x * this.scale + this.tx,
            y: y * this.scale + this.ty
        };
    }
    
    screenToWorld(x, y) {
        return {
            x: (x - this.tx) / this.scale,
            y: (y - this.ty) / this.scale
        };
    }
    
    rectWorldToScreen(rect) {
        const p0 = this.worldToScreen(rect.x, rect.y);
        return {
            x: p0.x,
            y: p0.y,
            width: rect.width * this.scale,
            height: rect.height * this.scale
        };
    }
    
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
 * setupHiDPICanvas - DPR 처리 함수
 */
function setupHiDPICanvas(canvas, lastSize = null) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    
    const sizeChanged = !lastSize || 
        lastSize.cssW !== cssW || 
        lastSize.cssH !== cssH || 
        lastSize.dpr !== dpr;
    
    if (sizeChanged) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    
    const ctx = canvas.getContext('2d');
    
    if (sizeChanged) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    
    return { ctx, dpr, cssW, cssH, sizeChanged };
}

/**
 * ImageStampModal 클래스
 */
class ImageStampModal {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.territory = null;
        this.territoryMask = null;
        
        // 상태 머신
        this.state = 'initializing'; // initializing | ready | userControlled
        
        // 뷰 변환
        this.viewTransform = new ViewTransform();
        this.stageSize = 512; // 정사각형 Stage 크기 (CSS px)
        
        // 캔버스 (2장 구조)
        this.staticCanvas = null;
        this.staticCtx = null;
        this.dynamicCanvas = null;
        this.dynamicCtx = null;
        this.lastStaticSize = null;
        this.lastDynamicSize = null;
        
        // 이미지 데이터
        this.image = null;
        this.imageData = null; // 원본 ImageData
        
        // rectWorld (상태의 진실)
        this.rectWorld = null; // {x, y, width, height} (셀 단위)
        
        // 옵션
        this.options = {
            alphaThreshold: 128, // 투명도 기준 (0-255)
            snap: true,          // 스냅 기본 ON
            clamp: true          // 클램프 기본 ON
        };
        
        // 드래그/리사이즈 상태
        this.isDragging = false;
        this.isResizing = false;
        this.dragStart = null;
        this.resizeHandle = null;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.createModal();
        this.setupEvents();
        log.info('[ImageStampModal] Initialized');
    }
    
    /**
     * 모달 생성
     */
    createModal() {
        const existing = document.getElementById('image-stamp-modal');
        if (existing) existing.remove();
        
        this.container = document.createElement('div');
        this.container.id = 'image-stamp-modal';
        this.container.className = 'image-stamp-modal hidden';
        this.container.innerHTML = this.getHTML();
        document.body.appendChild(this.container);
    }
    
    /**
     * HTML 생성
     */
    getHTML() {
        return `
            <div class="image-stamp-modal-overlay"></div>
            <div class="image-stamp-modal-content">
                <!-- 헤더 -->
                <div class="image-stamp-modal-header">
                    <h2>🖼️ 이미지 업로드</h2>
                    <div class="image-stamp-modal-actions">
                        <button class="image-stamp-btn" id="image-stamp-fit-btn" title="Fit">Fit</button>
                        <button class="image-stamp-btn" id="image-stamp-center-btn" title="Center">Center</button>
                        <button class="image-stamp-close" id="image-stamp-close">×</button>
                    </div>
                </div>
                
                <!-- 본문 -->
                <div class="image-stamp-modal-body">
                    <!-- 좌측: Preview Stage -->
                    <div class="image-stamp-stage-wrapper">
                        <div class="image-stamp-stage" id="image-stamp-stage" style="width: ${this.stageSize}px; height: ${this.stageSize}px;">
                            <canvas id="image-stamp-static-canvas"></canvas>
                            <canvas id="image-stamp-dynamic-canvas"></canvas>
                        </div>
                        <div class="image-stamp-zoom-controls">
                            <button class="image-stamp-zoom-btn" id="image-stamp-zoom-out">−</button>
                            <span class="image-stamp-zoom-value" id="image-stamp-zoom-value">100%</span>
                            <button class="image-stamp-zoom-btn" id="image-stamp-zoom-in">+</button>
                        </div>
                    </div>
                    
                    <!-- 우측: Tool Panel -->
                    <div class="image-stamp-tool-panel">
                        <!-- 파일 업로드 -->
                        <div class="image-stamp-section">
                            <h3>이미지 선택</h3>
                            <input type="file" id="image-stamp-file-input" accept="image/*" style="display: none;">
                            <button class="image-stamp-btn image-stamp-btn-primary" id="image-stamp-upload-btn">
                                📁 이미지 선택
                            </button>
                        </div>
                        
                        <!-- 투명도 기준 -->
                        <div class="image-stamp-section">
                            <h3>투명도 기준</h3>
                            <div class="image-stamp-presets">
                                <button class="image-stamp-preset-btn" data-threshold="64">낮음 (64)</button>
                                <button class="image-stamp-preset-btn" data-threshold="128">보통 (128)</button>
                                <button class="image-stamp-preset-btn" data-threshold="192">높음 (192)</button>
                            </div>
                            <input type="range" id="image-stamp-alpha-slider" min="0" max="255" value="128">
                            <span id="image-stamp-alpha-value">128</span>
                        </div>
                        
                        <!-- 옵션 -->
                        <div class="image-stamp-section">
                            <h3>옵션</h3>
                            <label>
                                <input type="checkbox" id="image-stamp-snap" checked>
                                스냅 (셀 단위 정렬)
                            </label>
                            <label>
                                <input type="checkbox" id="image-stamp-clamp" checked>
                                클램프 (영토 경계 내로 제한)
                            </label>
                        </div>
                        
                        <!-- 적용/취소 -->
                        <div class="image-stamp-section">
                            <button class="image-stamp-btn image-stamp-btn-primary" id="image-stamp-apply-btn" disabled>
                                ✅ 적용
                            </button>
                            <button class="image-stamp-btn" id="image-stamp-cancel-btn">
                                ❌ 취소
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
        // 닫기
        const closeBtn = this.container.querySelector('#image-stamp-close');
        if (closeBtn) {
            closeBtn.onclick = () => this.close();
        }
        
        const overlay = this.container.querySelector('.image-stamp-modal-overlay');
        if (overlay) {
            overlay.onclick = () => this.close();
        }
        
        // 파일 업로드
        const uploadBtn = this.container.querySelector('#image-stamp-upload-btn');
        const fileInput = this.container.querySelector('#image-stamp-file-input');
        if (uploadBtn && fileInput) {
            uploadBtn.onclick = () => fileInput.click();
            fileInput.onchange = (e) => this.handleFileSelect(e);
        }
        
        // 투명도 슬라이더
        const alphaSlider = this.container.querySelector('#image-stamp-alpha-slider');
        const alphaValue = this.container.querySelector('#image-stamp-alpha-value');
        if (alphaSlider && alphaValue) {
            alphaSlider.oninput = (e) => {
                this.options.alphaThreshold = parseInt(e.target.value);
                alphaValue.textContent = this.options.alphaThreshold;
                this.renderDynamic();
            };
        }
        
        // 투명도 프리셋
        this.container.querySelectorAll('.image-stamp-preset-btn').forEach(btn => {
            btn.onclick = () => {
                const threshold = parseInt(btn.dataset.threshold);
                this.options.alphaThreshold = threshold;
                if (alphaSlider) alphaSlider.value = threshold;
                if (alphaValue) alphaValue.textContent = threshold;
                this.renderDynamic();
            };
        });
        
        // 옵션
        const snapCheckbox = this.container.querySelector('#image-stamp-snap');
        const clampCheckbox = this.container.querySelector('#image-stamp-clamp');
        if (snapCheckbox) {
            snapCheckbox.onchange = (e) => {
                this.options.snap = e.target.checked;
                if (this.rectWorld) {
                    this.updateRectWorld(this.rectWorld);
                    this.renderDynamic();
                }
            };
        }
        if (clampCheckbox) {
            clampCheckbox.onchange = (e) => {
                this.options.clamp = e.target.checked;
                if (this.rectWorld) {
                    this.updateRectWorld(this.rectWorld);
                    this.renderDynamic();
                }
            };
        }
        
        // Fit/Center
        const fitBtn = this.container.querySelector('#image-stamp-fit-btn');
        const centerBtn = this.container.querySelector('#image-stamp-center-btn');
        if (fitBtn) fitBtn.onclick = () => this.fitToView();
        if (centerBtn) centerBtn.onclick = () => this.centerView();
        
        // 줌
        const zoomInBtn = this.container.querySelector('#image-stamp-zoom-in');
        const zoomOutBtn = this.container.querySelector('#image-stamp-zoom-out');
        if (zoomInBtn) zoomInBtn.onclick = () => this.zoomIn();
        if (zoomOutBtn) zoomOutBtn.onclick = () => this.zoomOut();
        
        // 적용/취소
        const applyBtn = this.container.querySelector('#image-stamp-apply-btn');
        const cancelBtn = this.container.querySelector('#image-stamp-cancel-btn');
        if (applyBtn) applyBtn.onclick = () => this.apply();
        if (cancelBtn) cancelBtn.onclick = () => this.close();
        
        // 캔버스 이벤트 (드래그/리사이즈)
        this.setupCanvasEvents();
    }
    
    /**
     * 캔버스 이벤트 설정
     */
    setupCanvasEvents() {
        const dynamicCanvas = this.container.querySelector('#image-stamp-dynamic-canvas');
        if (!dynamicCanvas) return;
        
        // 마우스 이벤트
        dynamicCanvas.onmousedown = (e) => this.handleMouseDown(e);
        dynamicCanvas.onmousemove = (e) => this.handleMouseMove(e);
        dynamicCanvas.onmouseup = (e) => this.handleMouseUp(e);
        dynamicCanvas.onwheel = (e) => this.handleWheel(e);
        
        // 터치 이벤트 (모바일 지원)
        dynamicCanvas.ontouchstart = (e) => {
            e.preventDefault();
            if (e.touches.length === 1) {
                const touch = e.touches[0];
                this.handleMouseDown({
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    button: 0
                });
            }
        };
        dynamicCanvas.ontouchmove = (e) => {
            e.preventDefault();
            if (e.touches.length === 1) {
                const touch = e.touches[0];
                this.handleMouseMove({
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
            }
        };
        dynamicCanvas.ontouchend = (e) => {
            e.preventDefault();
            this.handleMouseUp({});
        };
    }
    
    /**
     * 열기
     */
    async open(territory) {
        if (!territory?.id) {
            log.error('[ImageStampModal] Invalid territory');
            return;
        }
        
        this.territory = territory;
        this.isOpen = true;
        this.container?.classList.remove('hidden');
        
        // TerritoryMask 생성
        await this.initializeTerritoryMask();
        
        // 캔버스 초기화
        this.initializeCanvases();
        
        // 초기 상태: ready
        this.state = 'ready';
        
        // UI 바인딩
        this.bindUI();
        
        log.info(`[ImageStampModal] Opened for ${territory.id}`);
    }
    
    /**
     * TerritoryMask 초기화
     */
    async initializeTerritoryMask() {
        try {
            // PixelCanvas3에서 geometry 가져오기
            const geometry = pixelCanvas3.territoryGeometry;
            const bounds = pixelCanvas3.territoryBounds;
            
            if (!geometry || !bounds) {
                log.error('[ImageStampModal] No geometry found');
                return;
            }
            
            const width = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            const height = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            
            this.territoryMask = new TerritoryMask(geometry, bounds, width, height);
            log.info('[ImageStampModal] TerritoryMask initialized');
        } catch (error) {
            log.error('[ImageStampModal] Failed to initialize TerritoryMask:', error);
        }
    }
    
    /**
     * 캔버스 초기화
     */
    initializeCanvases() {
        // Static Canvas
        this.staticCanvas = this.container.querySelector('#image-stamp-static-canvas');
        if (this.staticCanvas) {
            this.staticCanvas.width = this.stageSize;
            this.staticCanvas.height = this.stageSize;
            this.staticCanvas.style.width = `${this.stageSize}px`;
            this.staticCanvas.style.height = `${this.stageSize}px`;
            this.staticCtx = this.staticCanvas.getContext('2d');
        }
        
        // Dynamic Canvas
        this.dynamicCanvas = this.container.querySelector('#image-stamp-dynamic-canvas');
        if (this.dynamicCanvas) {
            this.dynamicCanvas.width = this.stageSize;
            this.dynamicCanvas.height = this.stageSize;
            this.dynamicCanvas.style.width = `${this.stageSize}px`;
            this.dynamicCanvas.style.height = `${this.stageSize}px`;
            this.dynamicCtx = this.dynamicCanvas.getContext('2d');
        }
        
        // 초기 렌더
        this.renderStatic();
    }
    
    /**
     * 닫기
     */
    close() {
        this.isOpen = false;
        this.container?.classList.add('hidden');
        
        // 상태 초기화
        this.image = null;
        this.imageData = null;
        this.rectWorld = null;
        this.state = 'initializing';
        
        log.info('[ImageStampModal] Closed');
    }
    
    /**
     * 파일 선택 처리
     */
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        // 파일 크기 체크 (10MB)
        if (file.size > 10 * 1024 * 1024) {
            alert('파일 크기가 너무 큽니다. (최대 10MB)');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.image = img;
                this.loadImageData();
                this.fitToView();
                this.renderStatic();
                this.renderDynamic();
                
                // 적용 버튼 활성화
                const applyBtn = this.container.querySelector('#image-stamp-apply-btn');
                if (applyBtn) applyBtn.disabled = false;
            };
            img.onerror = () => {
                alert('이미지를 불러올 수 없습니다.');
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
    
    /**
     * ImageData 로드 (고품질 스케일링 적용)
     * 이미지를 더 큰 해상도로 스케일링하여 디테일 보존
     */
    loadImageData() {
        if (!this.image) return;
        
        // 고품질 스케일링: 이미지를 최대 4배까지 확대하여 샘플링 정밀도 향상
        // 단, 너무 크면 성능 문제가 있으므로 최대 크기 제한
        const maxScale = 4;
        const targetWidth = Math.min(this.image.width * maxScale, 2048);
        const targetHeight = Math.min(this.image.height * maxScale, 2048);
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d');
        
        // 고품질 이미지 스케일링 설정
        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = 'high';
        
        // 이미지를 더 큰 해상도로 스케일링
        tempCtx.drawImage(this.image, 0, 0, targetWidth, targetHeight);
        
        this.imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
        
        log.info(`[ImageStampModal] Image scaled to ${targetWidth}×${targetHeight} for better quality`);
    }
    
    /**
     * Fit to View (초기 fit, 1회만)
     */
    fitToView() {
        if (!this.image) return;
        
        // territoryMask가 없으면 전체 영역 사용
        const bounds = this.territoryMask ? this.territoryMask.getBounds() : {
            minX: 0,
            minY: 0,
            maxX: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1,
            maxY: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1
        };
        const worldWidth = bounds.maxX - bounds.minX + 1;
        const worldHeight = bounds.maxY - bounds.minY + 1;
        
        // 이미지 비율 유지하면서 영토에 맞게 조정
        const imageAspect = this.image.width / this.image.height;
        const worldAspect = worldWidth / worldHeight;
        
        let stampWidth, stampHeight;
        if (imageAspect > worldAspect) {
            // 이미지가 더 넓음
            stampWidth = worldWidth;
            stampHeight = worldWidth / imageAspect;
        } else {
            // 이미지가 더 높음
            stampWidth = worldHeight * imageAspect;
            stampHeight = worldHeight;
        }
        
        // 중앙 배치
        const stampX = bounds.minX + (worldWidth - stampWidth) / 2;
        const stampY = bounds.minY + (worldHeight - stampHeight) / 2;
        
        this.rectWorld = {
            x: stampX,
            y: stampY,
            width: stampWidth,
            height: stampHeight
        };
        
        // 스냅 적용
        if (this.options.snap) {
            this.snapRectWorld();
        }
        
        // 클램프 적용
        if (this.options.clamp && this.territoryMask) {
            this.rectWorld = this.territoryMask.clampRect(this.rectWorld);
        }
        
        // ViewTransform 설정 (월드 전체가 보이도록)
        this.fitViewTransform();
        
        this.state = 'ready';
        this.renderStatic();
        this.renderDynamic();
    }
    
    /**
     * ViewTransform을 월드 전체가 보이도록 설정
     */
    fitViewTransform() {
        // territoryMask가 없으면 전체 영역 사용
        const bounds = this.territoryMask ? this.territoryMask.getBounds() : {
            minX: 0,
            minY: 0,
            maxX: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1,
            maxY: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1
        };
        const worldWidth = bounds.maxX - bounds.minX + 1;
        const worldHeight = bounds.maxY - bounds.minY + 1;
        
        // 레터박싱 (월드 전체가 Stage에 들어오도록)
        const scaleX = this.stageSize / worldWidth;
        const scaleY = this.stageSize / worldHeight;
        const scale = Math.min(scaleX, scaleY) * 0.9; // 10% 여백
        
        this.viewTransform.scale = scale;
        this.viewTransform.tx = (this.stageSize - worldWidth * scale) / 2 - bounds.minX * scale;
        this.viewTransform.ty = (this.stageSize - worldHeight * scale) / 2 - bounds.minY * scale;
        
        this.updateZoomDisplay();
    }
    
    /**
     * 중앙 배치
     */
    centerView() {
        // territoryMask가 없으면 전체 영역 사용
        const bounds = this.territoryMask ? this.territoryMask.getBounds() : {
            minX: 0,
            minY: 0,
            maxX: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1,
            maxY: CONFIG.TERRITORY.PIXEL_GRID_SIZE - 1
        };
        const worldWidth = bounds.maxX - bounds.minX + 1;
        const worldHeight = bounds.maxY - bounds.minY + 1;
        
        this.viewTransform.tx = (this.stageSize - worldWidth * this.viewTransform.scale) / 2 - bounds.minX * this.viewTransform.scale;
        this.viewTransform.ty = (this.stageSize - worldHeight * this.viewTransform.scale) / 2 - bounds.minY * this.viewTransform.scale;
        
        this.renderStatic();
        this.renderDynamic();
    }
    
    /**
     * 줌 인
     */
    zoomIn() {
        this.viewTransform.scale *= 1.2;
        this.centerView();
        this.updateZoomDisplay();
    }
    
    /**
     * 줌 아웃
     */
    zoomOut() {
        this.viewTransform.scale /= 1.2;
        this.centerView();
        this.updateZoomDisplay();
    }
    
    /**
     * 줌 표시 업데이트
     */
    updateZoomDisplay() {
        const zoomValue = this.container.querySelector('#image-stamp-zoom-value');
        if (zoomValue) {
            zoomValue.textContent = `${Math.round(this.viewTransform.scale * 100)}%`;
        }
    }
    
    /**
     * 스냅 적용 (셀 단위)
     */
    snapRectWorld() {
        if (!this.rectWorld) return;
        
        this.rectWorld.x = Math.round(this.rectWorld.x);
        this.rectWorld.y = Math.round(this.rectWorld.y);
        this.rectWorld.width = Math.round(this.rectWorld.width);
        this.rectWorld.height = Math.round(this.rectWorld.height);
    }
    
    /**
     * rectWorld 업데이트 (스냅/클램프 적용)
     */
    updateRectWorld(rect) {
        this.rectWorld = { ...rect };
        
        if (this.options.snap) {
            this.snapRectWorld();
        }
        
        if (this.options.clamp && this.territoryMask && typeof this.territoryMask.clampRect === 'function') {
            this.rectWorld = this.territoryMask.clampRect(this.rectWorld);
        }
    }
    
    /**
     * Static Canvas 렌더 (정적 - 배경, 마스크, 그리드)
     */
    renderStatic() {
        if (!this.staticCtx || !this.territoryMask) return;
        
        const { ctx, cssW, cssH } = setupHiDPICanvas(this.staticCanvas, this.lastStaticSize);
        this.lastStaticSize = { cssW, cssH, dpr: window.devicePixelRatio || 1 };
        
        // Clear
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, cssW, cssH);
        
        // World Layer (viewTransform 적용)
        ctx.save();
        ctx.translate(this.viewTransform.tx, this.viewTransform.ty);
        ctx.scale(this.viewTransform.scale, this.viewTransform.scale);
        
        // Territory Mask Dim (영토 밖만 딤)
        if (this.territoryMask) {
            ctx.globalAlpha = 0.25;
            for (let y = 0; y < CONFIG.TERRITORY.PIXEL_GRID_SIZE; y++) {
                for (let x = 0; x < CONFIG.TERRITORY.PIXEL_GRID_SIZE; x++) {
                    if (!this.territoryMask.isInside(x, y)) {
                        ctx.fillStyle = '#000';
                        ctx.fillRect(x, y, 1, 1);
                    }
                }
            }
            ctx.globalAlpha = 1.0;
        }
        
        ctx.restore();
    }
    
    /**
     * Dynamic Canvas 렌더 (동적 - 스탬프, Transform Box, 핸들)
     */
    renderDynamic() {
        if (!this.dynamicCtx || !this.image || !this.rectWorld) return;
        
        const { ctx, cssW, cssH } = setupHiDPICanvas(this.dynamicCanvas, this.lastDynamicSize);
        this.lastDynamicSize = { cssW, cssH, dpr: window.devicePixelRatio || 1 };
        
        // Clear
        ctx.clearRect(0, 0, cssW, cssH);
        
        // World Layer (viewTransform 적용)
        ctx.save();
        ctx.translate(this.viewTransform.tx, this.viewTransform.ty);
        ctx.scale(this.viewTransform.scale, this.viewTransform.scale);
        
        // 스탬프 미리보기
        this.renderStampPreview(ctx);
        
        // Transform Box + 핸들
        this.renderTransformBox(ctx);
        
        ctx.restore();
    }
    
    /**
     * 스탬프 미리보기 렌더
     */
    renderStampPreview(ctx) {
        if (!this.rectWorld) return;
        
        // 원본 이미지를 rectWorld 크기로 그리기
        ctx.drawImage(
            this.image,
            this.rectWorld.x,
            this.rectWorld.y,
            this.rectWorld.width,
            this.rectWorld.height
        );
    }
    
    /**
     * Transform Box 렌더 (사각형 + 핸들)
     */
    renderTransformBox(ctx) {
        if (!this.rectWorld) return;
        
        const { x, y, width, height } = this.rectWorld;
        
        // 사각형 테두리
        ctx.strokeStyle = '#4ecdc4';
        ctx.lineWidth = 2 / this.viewTransform.scale;
        ctx.setLineDash([]);
        ctx.strokeRect(x, y, width, height);
        
        // 핸들 (8개) - 간단하게 4개만
        const handleSize = 8 / this.viewTransform.scale;
        ctx.fillStyle = '#4ecdc4';
        
        // 모서리 핸들
        const handles = [
            { x: x, y: y }, // 왼쪽 위
            { x: x + width, y: y }, // 오른쪽 위
            { x: x + width, y: y + height }, // 오른쪽 아래
            { x: x, y: y + height } // 왼쪽 아래
        ];
        
        handles.forEach(handle => {
            ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
        });
    }
    
    /**
     * 마우스 다운 처리
     */
    handleMouseDown(e) {
        if (!this.rectWorld) return;
        
        const screenPos = {
            x: e.clientX - this.dynamicCanvas.getBoundingClientRect().left,
            y: e.clientY - this.dynamicCanvas.getBoundingClientRect().top
        };
        const worldPos = this.viewTransform.screenToWorld(screenPos.x, screenPos.y);
        
        // 핸들 체크
        const handle = this.getHandleAt(worldPos.x, worldPos.y);
        if (handle) {
            this.isResizing = true;
            this.resizeHandle = handle;
        } else if (this.isPointInRect(worldPos.x, worldPos.y, this.rectWorld)) {
            this.isDragging = true;
        }
        
        this.dragStart = worldPos;
    }
    
    /**
     * 마우스 이동 처리
     */
    handleMouseMove(e) {
        if (!this.rectWorld) return;
        
        const screenPos = {
            x: e.clientX - this.dynamicCanvas.getBoundingClientRect().left,
            y: e.clientY - this.dynamicCanvas.getBoundingClientRect().top
        };
        const worldPos = this.viewTransform.screenToWorld(screenPos.x, screenPos.y);
        
        if (this.isDragging && this.dragStart) {
            // 드래그: 이동
            const dx = worldPos.x - this.dragStart.x;
            const dy = worldPos.y - this.dragStart.y;
            
            this.updateRectWorld({
                x: this.rectWorld.x + dx,
                y: this.rectWorld.y + dy,
                width: this.rectWorld.width,
                height: this.rectWorld.height
            });
            
            this.dragStart = worldPos;
            this.renderDynamic();
        } else if (this.isResizing && this.dragStart && this.resizeHandle) {
            // 리사이즈
            const dx = worldPos.x - this.dragStart.x;
            const dy = worldPos.y - this.dragStart.y;
            
            let newRect = { ...this.rectWorld };
            
            // 핸들에 따라 크기 조정
            if (this.resizeHandle === 'top-left') {
                newRect.x += dx;
                newRect.y += dy;
                newRect.width -= dx;
                newRect.height -= dy;
            } else if (this.resizeHandle === 'top-right') {
                newRect.y += dy;
                newRect.width += dx;
                newRect.height -= dy;
            } else if (this.resizeHandle === 'bottom-right') {
                newRect.width += dx;
                newRect.height += dy;
            } else if (this.resizeHandle === 'bottom-left') {
                newRect.x += dx;
                newRect.width -= dx;
                newRect.height += dy;
            }
            
            this.updateRectWorld(newRect);
            this.dragStart = worldPos;
            this.renderDynamic();
        }
    }
    
    /**
     * 마우스 업 처리
     */
    handleMouseUp(e) {
        this.isDragging = false;
        this.isResizing = false;
        this.resizeHandle = null;
        this.dragStart = null;
    }
    
    /**
     * 휠 처리 (줌)
     */
    handleWheel(e) {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.viewTransform.scale *= delta;
        this.centerView();
        this.updateZoomDisplay();
    }
    
    /**
     * 핸들 위치 확인
     */
    getHandleAt(x, y) {
        if (!this.rectWorld) return null;
        
        const handleSize = 8 / this.viewTransform.scale;
        const { x: rx, y: ry, width, height } = this.rectWorld;
        
        const handles = [
            { pos: 'top-left', x: rx, y: ry },
            { pos: 'top-right', x: rx + width, y: ry },
            { pos: 'bottom-right', x: rx + width, y: ry + height },
            { pos: 'bottom-left', x: rx, y: ry + height }
        ];
        
        for (const handle of handles) {
            const dx = x - handle.x;
            const dy = y - handle.y;
            if (Math.abs(dx) < handleSize && Math.abs(dy) < handleSize) {
                return handle.pos;
            }
        }
        
        return null;
    }
    
    /**
     * 점이 사각형 안에 있는지 확인
     */
    isPointInRect(x, y, rect) {
        return x >= rect.x && x <= rect.x + rect.width &&
               y >= rect.y && y <= rect.y + rect.height;
    }
    
    /**
     * UI 바인딩
     */
    bindUI() {
        // 이미 구현됨
    }
    
    /**
     * 적용 (PixelCanvas3에 픽셀 적용)
     */
    async apply() {
        if (!this.imageData || !this.rectWorld || !this.territoryMask) return;
        
        try {
            // 픽셀 데이터 생성 (셀 단위 샘플링)
            const pixelMap = new Map(); // "x,y" -> "#RRGGBB"
            
            let intersectRect = this.rectWorld;
            if (this.territoryMask && typeof this.territoryMask.intersectRect === 'function') {
                intersectRect = this.territoryMask.intersectRect(this.rectWorld);
                if (!intersectRect) {
                    alert('영토 경계와 교집합이 없습니다.');
                    return;
                }
            }
            
            // 고품질 샘플링: 셀 중심점에서 정밀하게 샘플링 (이미지가 스케일링되어 있어 더 정확함)
            for (let y = Math.floor(intersectRect.y); y < Math.ceil(intersectRect.y + intersectRect.height); y++) {
                for (let x = Math.floor(intersectRect.x); x < Math.ceil(intersectRect.x + intersectRect.width); x++) {
                    if (this.territoryMask && !this.territoryMask.isInside(x, y)) continue;
                    
                    // 셀 중심점의 이미지 좌표 계산 (부동소수점 정밀도)
                    const cellCenterX = x + 0.5;
                    const cellCenterY = y + 0.5;
                    
                    const imageX = ((cellCenterX - this.rectWorld.x) / this.rectWorld.width) * this.imageData.width;
                    const imageY = ((cellCenterY - this.rectWorld.y) / this.rectWorld.height) * this.imageData.height;
                    
                    // 가장 가까운 픽셀 위치 (반올림으로 가장 정확한 픽셀 선택)
                    const px = Math.round(imageX);
                    const py = Math.round(imageY);
                    
                    // 경계 체크
                    if (px >= 0 && px < this.imageData.width && py >= 0 && py < this.imageData.height) {
                        const idx = (py * this.imageData.width + px) * 4;
                        const r = this.imageData.data[idx];
                        const g = this.imageData.data[idx + 1];
                        const b = this.imageData.data[idx + 2];
                        const a = this.imageData.data[idx + 3];
                        
                        // 투명도 체크
                        if (a >= this.options.alphaThreshold) {
                            const color = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
                            pixelMap.set(`${x},${y}`, color);
                        }
                    }
                }
            }
            
            // PixelCanvas3에 bulk 적용
            if (pixelCanvas3 && pixelMap.size > 0) {
                // 히스토리 저장
                pixelCanvas3.saveHistory();
                
                // bulk 적용
                await pixelCanvas3.applyBulkPixels(pixelMap);
                
                // 렌더
                pixelCanvas3.render();
                
                log.info(`[ImageStampModal] Applied ${pixelMap.size} pixels`);
                
                // 도움말 알림 표시
                setTimeout(() => {
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'info',
                        message: '✨ 이미지가 적용되었습니다! 부족한 부분은 브러시 도구로 직접 점을 찍어 보완할 수 있습니다.',
                        duration: 5000
                    });
                }, 300);
            }
            
            // 모달 닫기
            this.close();
        } catch (error) {
            log.error('[ImageStampModal] Failed to apply:', error);
            alert('이미지 적용 중 오류가 발생했습니다.');
        }
    }
}

export const imageStampModal = new ImageStampModal();
export default imageStampModal;

