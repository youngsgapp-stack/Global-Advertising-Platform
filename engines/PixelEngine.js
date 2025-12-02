/**
 * Pixel Engine - v2 Architecture
 * 책임: 픽셀 편집 도구 ("지도 밖에서 돌아가는 독립적인 창작 도구")
 */
class PixelEngine {
    constructor(firestore, storage, auth) {
        this.firestore = firestore;
        this.storage = storage;
        this.auth = auth;
        this.eventBus = window.EventBus;
        
        // 편집 상태
        this.canvas = null;
        this.ctx = null;
        this.pixelData = null; // 편집 모드에서만 로딩
        this.currentRegionId = null;
        this.isEditMode = false;
        
        // 편집 도구
        this.currentColor = '#000000';
        this.brushSize = 1;
        this.tool = 'brush'; // 'brush' | 'eraser' | 'fill'
        
        // 히스토리 관리
        this.history = [];
        this.historyIndex = -1;
        this.maxHistorySize = 50;
        
        // 협업
        this.collaborators = new Map(); // userId -> { cursor, color }
        this.collaborationListener = null;
        
        // 타일 캐시
        this.tileCache = new Map();
    }

    /**
     * 초기화
     */
    async initialize() {
        // Event Bus 구독
        this.subscribeToEvents();
        
        // Event Bus 요청 핸들러 등록
        this.registerRequestHandlers();
        
        console.log('[PixelEngine] 초기화 완료');
    }

    /**
     * Event Bus 구독
     */
    subscribeToEvents() {
        // 소유권 검증 요청
        this.eventBus.on('pixel:verifyOwnership', async (data) => {
            const hasOwnership = await this.verifyOwnership(data.regionId);
            this.eventBus.emit('pixel:ownershipVerified', {
                regionId: data.regionId,
                hasOwnership
            });
        });
    }

    /**
     * Event Bus 요청 핸들러 등록
     */
    registerRequestHandlers() {
        // Visual 데이터 조회
        this.eventBus.registerRequestHandler('visual:get', async (data) => {
            return await this.getVisual(data.regionId);
        });
    }

    /**
     * 편집 모드 진입
     * @param {string} regionId - Region ID
     * @param {HTMLElement} canvasElement - Canvas 요소
     */
    async enterEditMode(regionId, canvasElement) {
        try {
            // 소유권 검증
            const hasOwnership = await this.verifyOwnership(regionId);
            if (!hasOwnership) {
                throw new Error('이 지역을 소유하고 있지 않습니다.');
            }

            this.currentRegionId = regionId;
            this.canvas = canvasElement;
            this.ctx = this.canvas.getContext('2d');
            this.isEditMode = true;

            // 캔버스 크기 설정 (128×128)
            this.canvas.width = 128;
            this.canvas.height = 128;

            // 기존 타일이 있으면 이미지를 픽셀 데이터로 변환
            const visual = await this.getVisual(regionId);
            if (visual && visual.pixelTileUrl) {
                await this.loadTileToCanvas(visual.pixelTileUrl);
            } else {
                // 타일이 없으면 빈 캔버스로 시작
                this.clearCanvas();
            }

            // 픽셀 데이터 초기화
            this.pixelData = this.canvasToPixelData();

            // 히스토리 초기화
            this.history = [this.pixelDataToImageData(this.pixelData)];
            this.historyIndex = 0;

            // 협업 리스너 시작
            this.startCollaboration();

            // 이벤트 리스너 설정
            this.setupCanvasEventListeners();

            // Event Bus에 알림
            this.eventBus.emit('pixel:editStarted', { regionId });

            console.log(`[PixelEngine] 편집 모드 진입: ${regionId}`);
        } catch (error) {
            console.error('[PixelEngine] 편집 모드 진입 실패:', error);
            throw error;
        }
    }

    /**
     * 편집 모드 종료
     */
    async exitEditMode() {
        if (!this.isEditMode) return;

        // 협업 리스너 중지
        this.stopCollaboration();

        // 이벤트 리스너 제거
        this.removeCanvasEventListeners();

        // 메모리 정리
        this.pixelData = null;
        this.canvas = null;
        this.ctx = null;
        this.currentRegionId = null;
        this.isEditMode = false;
        this.history = [];
        this.historyIndex = -1;

        // Event Bus에 알림
        this.eventBus.emit('pixel:editEnded', { regionId: this.currentRegionId });

        console.log('[PixelEngine] 편집 모드 종료');
    }

    /**
     * 소유권 검증
     * @param {string} regionId - Region ID
     * @returns {Promise<boolean>}
     */
    async verifyOwnership(regionId) {
        try {
            const ownership = await this.eventBus.request('ownership:get', { regionId });
            if (!ownership) return false;
            
            const userId = this.auth.currentUser?.uid;
            return ownership.ownerId === userId && ownership.status === 'owned';
        } catch (error) {
            console.error('[PixelEngine] 소유권 검증 실패:', error);
            return false;
        }
    }

    /**
     * 타일 이미지를 캔버스로 로딩
     * @param {string} tileUrl - 타일 URL
     */
    async loadTileToCanvas(tileUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                this.ctx.clearRect(0, 0, 128, 128);
                this.ctx.drawImage(img, 0, 0, 128, 128);
                resolve();
            };
            img.onerror = reject;
            img.src = tileUrl;
        });
    }

    /**
     * 캔버스 초기화
     */
    clearCanvas() {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, 128, 128);
    }

    /**
     * 캔버스를 픽셀 데이터로 변환
     * @returns {Array<Object>} - 픽셀 데이터 배열
     */
    canvasToPixelData() {
        const imageData = this.ctx.getImageData(0, 0, 128, 128);
        const pixels = [];
        
        for (let i = 0; i < imageData.data.length; i += 4) {
            const x = (i / 4) % 128;
            const y = Math.floor((i / 4) / 128);
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            const a = imageData.data[i + 3];
            
            if (a > 0) {
                const color = `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
                pixels.push({ x, y, color });
            }
        }
        
        return pixels;
    }

    /**
     * 픽셀 데이터를 ImageData로 변환
     * @param {Array<Object>} pixelData - 픽셀 데이터
     * @returns {ImageData}
     */
    pixelDataToImageData(pixelData) {
        const imageData = this.ctx.createImageData(128, 128);
        
        pixelData.forEach(pixel => {
            const index = (pixel.y * 128 + pixel.x) * 4;
            const color = this.hexToRgb(pixel.color);
            imageData.data[index] = color.r;
            imageData.data[index + 1] = color.g;
            imageData.data[index + 2] = color.b;
            imageData.data[index + 3] = 255;
        });
        
        return imageData;
    }

    /**
     * Hex 색상을 RGB로 변환
     * @param {string} hex - Hex 색상
     * @returns {Object} - { r, g, b }
     */
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 0, b: 0 };
    }

    /**
     * 캔버스 이벤트 리스너 설정
     */
    setupCanvasEventListeners() {
        this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
    }

    /**
     * 캔버스 이벤트 리스너 제거
     */
    removeCanvasEventListeners() {
        if (!this.canvas) return;
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('mouseup', this.onMouseUp);
        this.canvas.removeEventListener('mouseleave', this.onMouseUp);
    }

    /**
     * 마우스 다운 이벤트
     * @param {MouseEvent} e - 마우스 이벤트
     */
    onMouseDown(e) {
        if (!this.isEditMode) return;
        this.isDrawing = true;
        this.drawPixel(e);
    }

    /**
     * 마우스 이동 이벤트
     * @param {MouseEvent} e - 마우스 이벤트
     */
    onMouseMove(e) {
        if (!this.isEditMode) return;
        if (this.isDrawing) {
            this.drawPixel(e);
        }
    }

    /**
     * 마우스 업 이벤트
     */
    onMouseUp() {
        if (!this.isEditMode) return;
        if (this.isDrawing) {
            this.isDrawing = false;
            this.saveToHistory();
            this.syncToFirestore();
        }
    }

    /**
     * 픽셀 그리기
     * @param {MouseEvent} e - 마우스 이벤트
     */
    drawPixel(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) * (128 / rect.width));
        const y = Math.floor((e.clientY - rect.top) * (128 / rect.height));
        
        if (x < 0 || x >= 128 || y < 0 || y >= 128) return;

        if (this.tool === 'brush') {
            this.ctx.fillStyle = this.currentColor;
            this.ctx.fillRect(x, y, this.brushSize, this.brushSize);
        } else if (this.tool === 'eraser') {
            this.ctx.clearRect(x, y, this.brushSize, this.brushSize);
        } else if (this.tool === 'fill') {
            this.fillArea(x, y, this.currentColor);
        }

        // 픽셀 데이터 업데이트
        this.updatePixelData(x, y, this.currentColor);
    }

    /**
     * 영역 채우기 (Flood Fill)
     * @param {number} x - 시작 X 좌표
     * @param {number} y - 시작 Y 좌표
     * @param {string} fillColor - 채울 색상
     */
    fillArea(x, y, fillColor) {
        const imageData = this.ctx.getImageData(0, 0, 128, 128);
        const targetColor = this.getPixelColor(imageData, x, y);
        
        if (targetColor === fillColor) return;

        const stack = [[x, y]];
        const visited = new Set();

        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const key = `${cx},${cy}`;
            
            if (visited.has(key)) continue;
            if (cx < 0 || cx >= 128 || cy < 0 || cy >= 128) continue;
            
            const currentColor = this.getPixelColor(imageData, cx, cy);
            if (currentColor !== targetColor) continue;

            visited.add(key);
            this.setPixelColor(imageData, cx, cy, fillColor);

            stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }

        this.ctx.putImageData(imageData, 0, 0);
    }

    /**
     * 픽셀 색상 가져오기
     * @param {ImageData} imageData - 이미지 데이터
     * @param {number} x - X 좌표
     * @param {number} y - Y 좌표
     * @returns {string} - Hex 색상
     */
    getPixelColor(imageData, x, y) {
        const index = (y * 128 + x) * 4;
        const r = imageData.data[index];
        const g = imageData.data[index + 1];
        const b = imageData.data[index + 2];
        return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
    }

    /**
     * 픽셀 색상 설정
     * @param {ImageData} imageData - 이미지 데이터
     * @param {number} x - X 좌표
     * @param {number} y - Y 좌표
     * @param {string} color - Hex 색상
     */
    setPixelColor(imageData, x, y, color) {
        const index = (y * 128 + x) * 4;
        const rgb = this.hexToRgb(color);
        imageData.data[index] = rgb.r;
        imageData.data[index + 1] = rgb.g;
        imageData.data[index + 2] = rgb.b;
        imageData.data[index + 3] = 255;
    }

    /**
     * 픽셀 데이터 업데이트
     * @param {number} x - X 좌표
     * @param {number} y - Y 좌표
     * @param {string} color - 색상
     */
    updatePixelData(x, y, color) {
        if (!this.pixelData) return;
        
        const index = this.pixelData.findIndex(p => p.x === x && p.y === y);
        if (index >= 0) {
            this.pixelData[index].color = color;
        } else {
            this.pixelData.push({ x, y, color });
        }
    }

    /**
     * 히스토리에 저장
     */
    saveToHistory() {
        const currentData = this.canvasToPixelData();
        const imageData = this.pixelDataToImageData(currentData);
        
        // 현재 인덱스 이후의 히스토리 제거
        this.history = this.history.slice(0, this.historyIndex + 1);
        
        // 새 상태 추가
        this.history.push(imageData);
        this.historyIndex++;
        
        // 최대 크기 제한
        if (this.history.length > this.maxHistorySize) {
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
            const imageData = this.history[this.historyIndex];
            this.ctx.putImageData(imageData, 0, 0);
            this.pixelData = this.canvasToPixelData();
        }
    }

    /**
     * Redo
     */
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            const imageData = this.history[this.historyIndex];
            this.ctx.putImageData(imageData, 0, 0);
            this.pixelData = this.canvasToPixelData();
        }
    }

    /**
     * Firestore에 동기화
     */
    async syncToFirestore() {
        if (!this.currentRegionId || !this.pixelData) return;

        try {
            await this.firestore.collection('pixels_editing').doc(this.currentRegionId).set({
                pixels: this.pixelData,
                lastEdit: {
                    userId: this.auth.currentUser?.uid,
                    timestamp: this.firestore.FieldValue.serverTimestamp()
                },
                metadata: {
                    editingUsers: [this.auth.currentUser?.uid],
                    updatedAt: this.firestore.FieldValue.serverTimestamp()
                }
            }, { merge: true });
        } catch (error) {
            console.error('[PixelEngine] Firestore 동기화 실패:', error);
        }
    }

    /**
     * 협업 리스너 시작
     */
    startCollaboration() {
        if (!this.currentRegionId) return;

        this.collaborationListener = this.firestore.collection('pixels_editing')
            .doc(this.currentRegionId)
            .onSnapshot((doc) => {
                if (!doc.exists) return;
                
                const data = doc.data();
                const otherUserId = data.lastEdit?.userId;
                
                // 자신의 편집은 무시
                if (otherUserId === this.auth.currentUser?.uid) return;
                
                // 다른 사용자의 편집 적용
                if (data.pixels) {
                    this.applyPixelData(data.pixels);
                }
            });
    }

    /**
     * 협업 리스너 중지
     */
    stopCollaboration() {
        if (this.collaborationListener) {
            this.collaborationListener();
            this.collaborationListener = null;
        }
    }

    /**
     * 픽셀 데이터 적용
     * @param {Array<Object>} pixelData - 픽셀 데이터
     */
    applyPixelData(pixelData) {
        pixelData.forEach(pixel => {
            this.ctx.fillStyle = pixel.color;
            this.ctx.fillRect(pixel.x, pixel.y, 1, 1);
        });
        this.pixelData = this.canvasToPixelData();
    }

    /**
     * 저장 및 타일 생성
     */
    async saveAndGenerateTile() {
        if (!this.currentRegionId || !this.canvas) {
            throw new Error('편집 모드가 아닙니다.');
        }

        try {
            // 1. 캔버스를 이미지로 변환
            const imageBlob = await new Promise((resolve) => {
                this.canvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/webp', 0.9);
            });

            // 2. 타일 서버에 업로드
            const tileUrl = await this.uploadTile(this.currentRegionId, imageBlob);

            // 3. Firestore에 메타데이터만 저장
            const visualRef = this.firestore.collection('visuals').doc(this.currentRegionId);
            const currentVisual = await visualRef.get();
            const currentVersion = currentVisual.exists ? (currentVisual.data().metadata?.pixel?.version || 0) : 0;

            await visualRef.set({
                pixelTileUrl: tileUrl,
                tileUpdatedAt: this.firestore.FieldValue.serverTimestamp(),
                metadata: {
                    pixel: {
                        version: currentVersion + 1,
                        pixelCount: this.countNonTransparentPixels(),
                        lastEditedBy: this.auth.currentUser?.uid,
                        updatedAt: this.firestore.FieldValue.serverTimestamp()
                    }
                }
            }, { merge: true });

            // 4. 편집 중 데이터 삭제
            await this.firestore.collection('pixels_editing').doc(this.currentRegionId).delete();

            // 5. Map Engine에 타일 URL 전달
            this.eventBus.emit('pixel:tileUpdated', {
                regionId: this.currentRegionId,
                tileUrl
            });

            // 6. 편집 모드 종료
            await this.exitEditMode();

            console.log(`[PixelEngine] 저장 완료: ${this.currentRegionId}`);
        } catch (error) {
            console.error('[PixelEngine] 저장 실패:', error);
            throw error;
        }
    }

    /**
     * 타일 업로드
     * @param {string} regionId - Region ID
     * @param {Blob} imageBlob - 이미지 Blob
     * @returns {Promise<string>} - 타일 URL
     */
    async uploadTile(regionId, imageBlob) {
        const fileName = `pixel/${regionId}.webp`;
        const storageRef = this.storage.ref(fileName);
        await storageRef.put(imageBlob);
        return await storageRef.getDownloadURL();
    }

    /**
     * 투명하지 않은 픽셀 개수 계산
     * @returns {number}
     */
    countNonTransparentPixels() {
        if (!this.pixelData) return 0;
        return this.pixelData.length;
    }

    /**
     * Visual 데이터 조회
     * @param {string} regionId - Region ID
     * @returns {Promise<Object|null>}
     */
    async getVisual(regionId) {
        try {
            const doc = await this.firestore.collection('visuals').doc(regionId).get();
            if (doc.exists) {
                return { id: doc.id, ...doc.data() };
            }
            return null;
        } catch (error) {
            console.error(`[PixelEngine] Visual 조회 실패 (${regionId}):`, error);
            return null;
        }
    }

    /**
     * 색상 설정
     * @param {string} color - Hex 색상
     */
    setColor(color) {
        this.currentColor = color;
    }

    /**
     * 브러시 크기 설정
     * @param {number} size - 브러시 크기
     */
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(10, size));
    }

    /**
     * 도구 설정
     * @param {string} tool - 도구 ('brush' | 'eraser' | 'fill')
     */
    setTool(tool) {
        this.tool = tool;
    }

    /**
     * 정리 및 리소스 해제
     */
    destroy() {
        this.exitEditMode();
        this.tileCache.clear();
        this.collaborators.clear();
    }
}

// 전역으로 내보내기
window.PixelEngine = PixelEngine;

