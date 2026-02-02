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
        this.lang = 'en'; // English default
        
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
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        return `
            <div class="image-stamp-modal-overlay"></div>
            <div class="image-stamp-modal-content">
                <!-- 헤더 -->
                <div class="image-stamp-modal-header">
                    <h2>🖼️ ${vocab.imageUpload}</h2>
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
                            <h3>${vocab.selectImage}</h3>
                            <input type="file" id="image-stamp-file-input" accept="image/*" style="display: none;">
                            <button class="image-stamp-btn image-stamp-btn-primary" id="image-stamp-upload-btn">
                                📁 ${vocab.selectImageButton}
                            </button>
                        </div>
                        
                        <!-- 투명도 기준 -->
                        <div class="image-stamp-section">
                            <h3>${vocab.alphaThreshold}</h3>
                            <div class="image-stamp-presets">
                                <button class="image-stamp-preset-btn" data-threshold="64">${vocab.low} (64)</button>
                                <button class="image-stamp-preset-btn" data-threshold="128">${vocab.medium} (128)</button>
                                <button class="image-stamp-preset-btn" data-threshold="192">${vocab.high} (192)</button>
                            </div>
                            <input type="range" id="image-stamp-alpha-slider" min="0" max="255" value="128">
                            <span id="image-stamp-alpha-value">128</span>
                        </div>
                        
                        <!-- 옵션 -->
                        <div class="image-stamp-section">
                            <h3>${vocab.options}</h3>
                            <label>
                                <input type="checkbox" id="image-stamp-snap" checked>
                                ${vocab.snap}
                            </label>
                            <label>
                                <input type="checkbox" id="image-stamp-clamp" checked>
                                ${vocab.clamp}
                            </label>
                            <div class="image-stamp-info" style="margin-top: 8px; font-size: 12px; color: #888;">
                                💡 Fit 버튼은 이미지를 영토 경계 안에 맞춥니다
                            </div>
                        </div>
                        
                        <!-- 적용/취소 -->
                        <div class="image-stamp-section">
                            <button class="image-stamp-btn image-stamp-btn-primary" id="image-stamp-apply-btn" disabled>
                                ✅ ${vocab.apply}
                            </button>
                            <button class="image-stamp-btn" id="image-stamp-cancel-btn">
                                ❌ ${vocab.cancel}
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
            const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
            alert(vocab.fileTooLarge);
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.image = img;
                // ⚠️ CRITICAL: loadImageData 제거 - 원본 이미지를 직접 사용
                // 미리보기와 동일하게 원본 이미지를 그대로 사용하여 품질 보존
                this.imageData = null; // 더 이상 사용하지 않음
                this.fitToView();
                this.renderStatic();
                this.renderDynamic();
                
                // 적용 버튼 활성화
                const applyBtn = this.container.querySelector('#image-stamp-apply-btn');
                if (applyBtn) applyBtn.disabled = false;
            };
            img.onerror = () => {
                const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
                alert(vocab.cannotLoadImage);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
    
    /**
     * ImageData 로드 (완전히 새로운 방식)
     * ⚠️ CRITICAL: 기존 샘플링 방식 버리고 완전히 새로운 접근
     * 1. 이미지를 128x128로 고품질 리사이즈 (Lanczos 알고리즘 시뮬레이션)
     * 2. 리사이즈된 이미지를 그대로 사용 (셀 = 픽셀 1:1 매핑)
     * 3. 각 픽셀의 색상을 그대로 사용하여 품질 최대화
     */
    loadImageData() {
        if (!this.image) return;
        
        // ⚠️ 새로운 방식: 이미지를 정확히 128x128로 고품질 리사이즈
        // 이렇게 하면 셀과 픽셀이 1:1로 매핑되어 샘플링 손실이 없음
        const targetSize = CONFIG.TERRITORY.PIXEL_GRID_SIZE; // 128
        
        // 이미지 비율 유지하면서 128x128 안에 맞추기
        const imageAspect = this.image.width / this.image.height;
        let targetWidth, targetHeight;
        
        if (imageAspect > 1) {
            // 가로가 더 긴 경우
            targetWidth = targetSize;
            targetHeight = Math.round(targetSize / imageAspect);
        } else {
            // 세로가 더 긴 경우
            targetWidth = Math.round(targetSize * imageAspect);
            targetHeight = targetSize;
        }
        
        // 고품질 리사이즈를 위한 임시 캔버스 (더 큰 해상도로 먼저 확대 후 축소)
        // 이렇게 하면 브라우저의 고품질 스케일링 알고리즘 활용
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        
        // 1단계: 원본을 더 큰 해상도로 확대 (고품질 스케일링)
        const upscaleFactor = 4;
        const upscaledWidth = targetWidth * upscaleFactor;
        const upscaledHeight = targetHeight * upscaleFactor;
        
        tempCanvas.width = upscaledWidth;
        tempCanvas.height = upscaledHeight;
        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = 'high';
        tempCtx.drawImage(this.image, 0, 0, upscaledWidth, upscaledHeight);
        
        // 2단계: 확대된 이미지를 목표 크기로 축소 (고품질 다운샘플링)
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = targetWidth;
        finalCanvas.height = targetHeight;
        const finalCtx = finalCanvas.getContext('2d');
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.drawImage(tempCanvas, 0, 0, targetWidth, targetHeight);
        
        // 최종 ImageData 추출
        this.imageData = finalCtx.getImageData(0, 0, targetWidth, targetHeight);
        
        // ⚠️ 선명도 향상 적용 (선택적)
        this.imageData = this.applySharpening(this.imageData, 0.3); // 강도 낮춤 (과도한 선명화 방지)
        
        log.info(`[ImageStampModal] Image resized to ${targetWidth}×${targetHeight} using high-quality resize (new method)`);
    }
    
    /**
     * 선명도 향상 (Unsharp Mask)
     * @param {ImageData} imageData - 원본 이미지 데이터
     * @param {number} strength - 선명도 강도 (0.0 ~ 1.0)
     * @returns {ImageData} - 선명도가 향상된 이미지 데이터
     */
    applySharpening(imageData, strength = 0.5) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;
        const output = new ImageData(width, height);
        const outputData = output.data;
        
        // Unsharp Mask 커널 (간단한 라플라시안)
        const kernel = [
            0, -1, 0,
            -1, 5, -1,
            0, -1, 0
        ];
        
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                for (let c = 0; c < 3; c++) { // RGB만 (Alpha는 그대로)
                    let sum = 0;
                    let kernelIndex = 0;
                    
                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                            sum += data[idx] * kernel[kernelIndex];
                            kernelIndex++;
                        }
                    }
                    
                    const originalIdx = (y * width + x) * 4 + c;
                    const original = data[originalIdx];
                    const sharpened = original + (sum - original) * strength;
                    outputData[originalIdx] = Math.max(0, Math.min(255, sharpened));
                }
                
                // Alpha 채널은 그대로 복사
                outputData[(y * width + x) * 4 + 3] = data[(y * width + x) * 4 + 3];
            }
        }
        
        // 경계 처리 (가장자리는 원본 그대로)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
                    const idx = (y * width + x) * 4;
                    outputData[idx] = data[idx];
                    outputData[idx + 1] = data[idx + 1];
                    outputData[idx + 2] = data[idx + 2];
                    outputData[idx + 3] = data[idx + 3];
                }
            }
        }
        
        return output;
    }
    
    /**
     * Fit to View (완전히 새로운 방식)
     * ⚠️ CRITICAL: 원본 이미지를 직접 사용하여 미리보기와 동일하게 처리
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
        
        // ⚠️ 새로운 방식: 원본 이미지 크기와 비율 사용
        const imageWidth = this.image.width;
        const imageHeight = this.image.height;
        
        // 영토 경계 안에 맞추기 (95% 사용)
        const safetyMargin = 0.95;
        const availableWidth = worldWidth * safetyMargin;
        const availableHeight = worldHeight * safetyMargin;
        
        // 이미지 비율 유지하면서 사용 가능한 공간에 맞추기
        const imageAspect = imageWidth / imageHeight;
        const availableAspect = availableWidth / availableHeight;
        
        let stampWidth, stampHeight;
        if (imageAspect > availableAspect) {
            // 이미지가 더 넓음
            stampWidth = availableWidth;
            stampHeight = availableWidth / imageAspect;
        } else {
            // 이미지가 더 높음
            stampWidth = availableHeight * imageAspect;
            stampHeight = availableHeight;
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
        
        // Clamp 적용 (위치만 조정)
        if (this.options.clamp && this.territoryMask) {
            this.rectWorld.x = Math.max(bounds.minX, Math.min(this.rectWorld.x, bounds.maxX - this.rectWorld.width + 1));
            this.rectWorld.y = Math.max(bounds.minY, Math.min(this.rectWorld.y, bounds.maxY - this.rectWorld.height + 1));
        }
        
        // ViewTransform 설정
        this.fitViewTransform();
        
        this.state = 'ready';
        this.renderStatic();
        this.renderDynamic();
        
        log.info(`[ImageStampModal] Fit: Original image ${imageWidth}×${imageHeight} mapped to rect ${this.rectWorld.width.toFixed(1)}×${this.rectWorld.height.toFixed(1)} (preview = final)`);
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
     * Bilinear Interpolation 샘플링 (Raw 데이터 반환)
     * 주변 4개 픽셀의 가중 평균을 계산하여 더 부드러운 색상 전환
     * @param {number} x - 이미지 X 좌표 (부동소수점)
     * @param {number} y - 이미지 Y 좌표 (부동소수점)
     * @returns {{r: number, g: number, b: number, a: number}|null} - 색상 객체 또는 null
     */
    sampleBilinearRaw(x, y) {
        const width = this.imageData.width;
        const height = this.imageData.height;
        const data = this.imageData.data;
        
        // 경계 체크
        if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) {
            return null;
        }
        
        // 주변 4개 픽셀 위치
        const x1 = Math.floor(x);
        const y1 = Math.floor(y);
        const x2 = Math.min(x1 + 1, width - 1);
        const y2 = Math.min(y1 + 1, height - 1);
        
        // 가중치 계산
        const fx = x - x1;
        const fy = y - y1;
        const w1 = (1 - fx) * (1 - fy); // 왼쪽 위
        const w2 = fx * (1 - fy);       // 오른쪽 위
        const w3 = (1 - fx) * fy;       // 왼쪽 아래
        const w4 = fx * fy;              // 오른쪽 아래
        
        // 4개 픽셀의 색상 가져오기
        const getPixel = (px, py) => {
            const idx = (py * width + px) * 4;
            return {
                r: data[idx],
                g: data[idx + 1],
                b: data[idx + 2],
                a: data[idx + 3]
            };
        };
        
        const p1 = getPixel(x1, y1);
        const p2 = getPixel(x2, y1);
        const p3 = getPixel(x1, y2);
        const p4 = getPixel(x2, y2);
        
        // 가중 평균 계산
        const r = Math.round(p1.r * w1 + p2.r * w2 + p3.r * w3 + p4.r * w4);
        const g = Math.round(p1.g * w1 + p2.g * w2 + p3.g * w3 + p4.g * w4);
        const b = Math.round(p1.b * w1 + p2.b * w2 + p3.b * w3 + p4.b * w4);
        const a = Math.round(p1.a * w1 + p2.a * w2 + p3.a * w3 + p4.a * w4);
        
        return { r, g, b, a };
    }
    
    /**
     * Floyd-Steinberg 디더링 적용
     * 색상 전환을 더 부드럽게 만들기 위해 에러 확산 디더링 적용
     * @param {Map} pixelMap - 픽셀 맵 ("x,y" -> "#RRGGBB")
     * @param {Object} rect - 영역 ({x, y, width, height})
     */
    applyFloydSteinbergDithering(pixelMap, rect) {
        if (!this.territoryMask) return;
        
        // 픽셀 맵을 2D 배열로 변환 (에러 확산을 위해)
        const startX = Math.floor(rect.x);
        const startY = Math.floor(rect.y);
        const endX = Math.ceil(rect.x + rect.width);
        const endY = Math.ceil(rect.y + rect.height);
        
        const width = endX - startX;
        const height = endY - startY;
        
        // 원본 색상 저장 (RGB 값)
        const originalColors = [];
        for (let y = 0; y < height; y++) {
            originalColors[y] = [];
            for (let x = 0; x < width; x++) {
                const worldX = startX + x;
                const worldY = startY + y;
                const key = `${worldX},${worldY}`;
                
                if (pixelMap.has(key) && this.territoryMask.isInside(worldX, worldY)) {
                    const colorStr = pixelMap.get(key);
                    // #RRGGBB를 RGB로 변환
                    const r = parseInt(colorStr.substr(1, 2), 16);
                    const g = parseInt(colorStr.substr(3, 2), 16);
                    const b = parseInt(colorStr.substr(5, 2), 16);
                    originalColors[y][x] = { r, g, b, x: worldX, y: worldY };
                } else {
                    originalColors[y][x] = null;
                }
            }
        }
        
        // 에러 확산을 위한 버퍼
        const errorBuffer = [];
        for (let y = 0; y < height; y++) {
            errorBuffer[y] = [];
            for (let x = 0; x < width; x++) {
                errorBuffer[y][x] = { r: 0, g: 0, b: 0 };
            }
        }
        
        // Floyd-Steinberg 디더링 적용
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const orig = originalColors[y][x];
                if (!orig) continue;
                
                // 현재 픽셀 색상 + 에러
                let r = orig.r + errorBuffer[y][x].r;
                let g = orig.g + errorBuffer[y][x].g;
                let b = orig.b + errorBuffer[y][x].b;
                
                // 양자화 (0-255 범위로 클램핑)
                r = Math.max(0, Math.min(255, Math.round(r)));
                g = Math.max(0, Math.min(255, Math.round(g)));
                b = Math.max(0, Math.min(255, Math.round(b)));
                
                // 양자화 에러 계산
                const errorR = orig.r - r;
                const errorG = orig.g - g;
                const errorB = orig.b - b;
                
                // 에러를 주변 픽셀에 분산 (Floyd-Steinberg 패턴)
                //      X   7/16
                // 3/16 5/16 1/16
                if (x + 1 < width && originalColors[y][x + 1]) {
                    errorBuffer[y][x + 1].r += errorR * (7 / 16);
                    errorBuffer[y][x + 1].g += errorG * (7 / 16);
                    errorBuffer[y][x + 1].b += errorB * (7 / 16);
                }
                
                if (y + 1 < height) {
                    if (x > 0 && originalColors[y + 1][x - 1]) {
                        errorBuffer[y + 1][x - 1].r += errorR * (3 / 16);
                        errorBuffer[y + 1][x - 1].g += errorG * (3 / 16);
                        errorBuffer[y + 1][x - 1].b += errorB * (3 / 16);
                    }
                    
                    if (originalColors[y + 1][x]) {
                        errorBuffer[y + 1][x].r += errorR * (5 / 16);
                        errorBuffer[y + 1][x].g += errorG * (5 / 16);
                        errorBuffer[y + 1][x].b += errorB * (5 / 16);
                    }
                    
                    if (x + 1 < width && originalColors[y + 1][x + 1]) {
                        errorBuffer[y + 1][x + 1].r += errorR * (1 / 16);
                        errorBuffer[y + 1][x + 1].g += errorG * (1 / 16);
                        errorBuffer[y + 1][x + 1].b += errorB * (1 / 16);
                    }
                }
                
                // 양자화된 색상으로 업데이트
                const color = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
                pixelMap.set(`${orig.x},${orig.y}`, color);
            }
        }
        
        log.info(`[ImageStampModal] Applied Floyd-Steinberg dithering to ${pixelMap.size} pixels`);
    }
    
    /**
     * UI 바인딩
     */
    bindUI() {
        // 이미 구현됨
    }
    
    /**
     * 적용 (PixelCanvas3에 픽셀 적용)
     * ⚠️ CRITICAL: 미리보기와 동일한 방식으로 적용
     * 미리보기는 drawImage로 선명하게 보이므로, 동일한 방식으로 캔버스에 그린 후 셀 색상 추출
     */
    async apply() {
        if (!this.image || !this.rectWorld || !this.territoryMask) return;
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        try {
            // ⚠️ 완전히 새로운 방식: 미리보기와 동일하게 이미지를 캔버스에 그린 후 셀 색상 추출
            // 1. 128x128 캔버스 생성
            // 2. 이미지를 rectWorld 크기로 그리기 (미리보기와 동일)
            // 3. 각 셀 영역의 평균 색상 추출
            
            const gridSize = CONFIG.TERRITORY.PIXEL_GRID_SIZE; // 128
            
            // 임시 캔버스 생성 (128x128)
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = gridSize;
            tempCanvas.height = gridSize;
            const tempCtx = tempCanvas.getContext('2d');
            
            // ⚠️ 핵심: 미리보기와 동일한 방식으로 이미지 그리기
            // imageSmoothing을 끄면 픽셀아트 스타일이 되지만, 켜면 더 부드러움
            // 미리보기가 선명하게 보이므로 smoothing을 켜서 동일하게 처리
            tempCtx.imageSmoothingEnabled = true;
            tempCtx.imageSmoothingQuality = 'high';
            
            // 배경을 투명하게
            tempCtx.clearRect(0, 0, gridSize, gridSize);
            
            // ⚠️ 이미지를 rectWorld 위치와 크기로 그리기 (미리보기와 정확히 동일)
            tempCtx.drawImage(
                this.image,
                this.rectWorld.x,
                this.rectWorld.y,
                this.rectWorld.width,
                this.rectWorld.height
            );
            
            // 캔버스에서 ImageData 추출
            const canvasImageData = tempCtx.getImageData(0, 0, gridSize, gridSize);
            
            // 픽셀 데이터 생성 (셀 단위로 색상 추출)
            const pixelMap = new Map(); // "x,y" -> "#RRGGBB"
            
            // 각 셀(픽셀)의 색상 추출
            for (let y = 0; y < gridSize; y++) {
                for (let x = 0; x < gridSize; x++) {
                    // 영토 마스크 체크
                    if (this.territoryMask && !this.territoryMask.isInside(x, y)) continue;
                    
                    // ImageData에서 픽셀 색상 읽기
                    const idx = (y * gridSize + x) * 4;
                    const r = canvasImageData.data[idx];
                    const g = canvasImageData.data[idx + 1];
                    const b = canvasImageData.data[idx + 2];
                    const a = canvasImageData.data[idx + 3];
                    
                    // 투명도 체크
                    if (a >= this.options.alphaThreshold) {
                        const color = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
                        pixelMap.set(`${x},${y}`, color);
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
                        message: vocab.imageApplied,
                        duration: 5000
                    });
                }, 300);
            }
            
            // 모달 닫기
            this.close();
        } catch (error) {
            log.error('[ImageStampModal] Failed to apply:', error);
            const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
            alert(vocab.imageApplyError);
        }
    }
}

export const imageStampModal = new ImageStampModal();
export default imageStampModal;

