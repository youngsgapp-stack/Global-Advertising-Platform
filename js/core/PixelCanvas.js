/**
 * PixelCanvas - 픽셀 아트 캔버스 시스템
 * 영토 꾸미기, 픽셀 = 가치 상승, 실시간 동기화
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from './EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';

// 픽셀 도구
export const PIXEL_TOOLS = {
    BRUSH: 'brush',
    ERASER: 'eraser',
    FILL: 'fill',
    PICKER: 'picker'
};

class PixelCanvas {
    constructor() {
        this.territoryId = null;
        this.width = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        this.height = CONFIG.TERRITORY.PIXEL_GRID_SIZE;
        this.pixels = new Map();  // key: "x,y", value: { color, userId, timestamp }
        this.canvas = null;
        this.ctx = null;
        this.pixelSize = 5;  // 각 픽셀의 화면 크기
        
        // 현재 도구 상태
        this.currentTool = PIXEL_TOOLS.BRUSH;
        this.currentColor = '#4ecdc4';
        this.brushSize = 1;
        
        // 드로잉 상태
        this.isDrawing = false;
        this.lastX = null;
        this.lastY = null;
        
        // 히스토리 (undo/redo)
        this.history = [];
        this.historyIndex = -1;
        this.maxHistory = 50;
        
        // 실시간 구독 해제 함수
        this.unsubscribe = null;
    }
    
    /**
     * 캔버스 초기화
     */
    async initialize(territoryId, canvasElement) {
        this.territoryId = territoryId;
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        
        // 캔버스 크기 설정
        this.canvas.width = this.width * this.pixelSize;
        this.canvas.height = this.height * this.pixelSize;
        
        // 배경 그리기
        this.drawBackground();
        
        // Firestore에서 픽셀 데이터 로드
        await this.loadPixelsFromFirestore();
        
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        // 실시간 구독 시작
        this.startRealtimeSync();
        
        // 초기 렌더링
        this.render();
        
        log.info(`PixelCanvas initialized for territory: ${territoryId}`);
        
        eventBus.emit(EVENTS.PIXEL_CANVAS_LOAD, {
            territoryId,
            filledPixels: this.pixels.size
        });
    }
    
    /**
     * 배경 그리기 (체스판 패턴)
     */
    drawBackground() {
        const size = this.pixelSize;
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const isLight = (x + y) % 2 === 0;
                this.ctx.fillStyle = isLight ? '#1a1a2e' : '#16162a';
                this.ctx.fillRect(x * size, y * size, size, size);
            }
        }
    }
    
    /**
     * Firestore에서 픽셀 데이터 로드
     */
    async loadPixelsFromFirestore() {
        try {
            const data = await firebaseService.getDocument('pixelCanvases', this.territoryId);
            
            if (data && data.pixels) {
                // 압축된 픽셀 데이터 디코딩
                this.decodePixels(data.pixels);
                log.info(`Loaded ${this.pixels.size} pixels`);
            }
            
        } catch (error) {
            log.warn('Failed to load pixels:', error);
        }
    }
    
    /**
     * 픽셀 데이터 인코딩 (저장용)
     */
    encodePixels() {
        const encoded = [];
        
        for (const [key, pixel] of this.pixels) {
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
     * 픽셀 데이터 디코딩 (로드용)
     */
    decodePixels(encoded) {
        this.pixels.clear();
        
        for (const p of encoded) {
            this.pixels.set(`${p.x},${p.y}`, {
                color: p.c,
                userId: p.u,
                timestamp: p.t
            });
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 마우스 이벤트
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.handleMouseUp());
        
        // 터치 이벤트 (모바일)
        this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e));
        this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e));
        this.canvas.addEventListener('touchend', () => this.handleMouseUp());
        
        // 키보드 단축키
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }
    
    /**
     * 마우스 좌표를 픽셀 좌표로 변환
     */
    getPixelCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        
        const x = Math.floor((e.clientX - rect.left) * scaleX / this.pixelSize);
        const y = Math.floor((e.clientY - rect.top) * scaleY / this.pixelSize);
        
        return { x: Math.max(0, Math.min(x, this.width - 1)), y: Math.max(0, Math.min(y, this.height - 1)) };
    }
    
    /**
     * 마우스 다운 핸들러
     */
    handleMouseDown(e) {
        e.preventDefault();
        this.isDrawing = true;
        
        const { x, y } = this.getPixelCoords(e);
        this.lastX = x;
        this.lastY = y;
        
        // 히스토리 저장 (드로잉 시작)
        this.saveToHistory();
        
        // 도구별 처리
        this.applyTool(x, y);
        this.render();
    }
    
    /**
     * 마우스 이동 핸들러
     */
    handleMouseMove(e) {
        if (!this.isDrawing) return;
        
        const { x, y } = this.getPixelCoords(e);
        
        // 선 그리기 (Bresenham 알고리즘)
        if (this.lastX !== null && this.lastY !== null) {
            this.drawLine(this.lastX, this.lastY, x, y);
        }
        
        this.lastX = x;
        this.lastY = y;
        this.render();
    }
    
    /**
     * 마우스 업 핸들러
     */
    handleMouseUp() {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.lastX = null;
            this.lastY = null;
            
            // Firestore에 저장
            this.saveToFirestore();
        }
    }
    
    /**
     * 터치 시작 핸들러
     */
    handleTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousedown', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        this.handleMouseDown(mouseEvent);
    }
    
    /**
     * 터치 이동 핸들러
     */
    handleTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const mouseEvent = new MouseEvent('mousemove', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        this.handleMouseMove(mouseEvent);
    }
    
    /**
     * 키보드 핸들러
     */
    handleKeyDown(e) {
        // Ctrl+Z: Undo
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            this.undo();
        }
        // Ctrl+Y: Redo
        if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            this.redo();
        }
        // B: Brush
        if (e.key === 'b') this.setTool(PIXEL_TOOLS.BRUSH);
        // E: Eraser
        if (e.key === 'e') this.setTool(PIXEL_TOOLS.ERASER);
        // F: Fill
        if (e.key === 'f') this.setTool(PIXEL_TOOLS.FILL);
        // I: Color Picker
        if (e.key === 'i') this.setTool(PIXEL_TOOLS.PICKER);
    }
    
    /**
     * 도구 적용
     */
    applyTool(x, y) {
        const user = firebaseService.getCurrentUser();
        const userId = user?.uid || 'anonymous';
        
        switch (this.currentTool) {
            case PIXEL_TOOLS.BRUSH:
                this.drawPixel(x, y, this.currentColor, userId);
                break;
                
            case PIXEL_TOOLS.ERASER:
                this.erasePixel(x, y);
                break;
                
            case PIXEL_TOOLS.FILL:
                this.floodFill(x, y, this.currentColor, userId);
                break;
                
            case PIXEL_TOOLS.PICKER:
                const pixel = this.pixels.get(`${x},${y}`);
                if (pixel) {
                    this.currentColor = pixel.color;
                    eventBus.emit(EVENTS.PIXEL_UPDATE, { type: 'colorPicked', color: pixel.color });
                }
                break;
        }
    }
    
    /**
     * 선 그리기 (Bresenham 알고리즘)
     */
    drawLine(x0, y0, x1, y1) {
        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        
        const user = firebaseService.getCurrentUser();
        const userId = user?.uid || 'anonymous';
        
        while (true) {
            this.applyToolAtPoint(x0, y0, userId);
            
            if (x0 === x1 && y0 === y1) break;
            
            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                x0 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y0 += sy;
            }
        }
    }
    
    /**
     * 특정 점에 도구 적용
     */
    applyToolAtPoint(x, y, userId) {
        // 브러시 크기 적용
        const halfSize = Math.floor(this.brushSize / 2);
        
        for (let dy = -halfSize; dy <= halfSize; dy++) {
            for (let dx = -halfSize; dx <= halfSize; dx++) {
                const px = x + dx;
                const py = y + dy;
                
                if (px >= 0 && px < this.width && py >= 0 && py < this.height) {
                    if (this.currentTool === PIXEL_TOOLS.BRUSH) {
                        this.drawPixel(px, py, this.currentColor, userId);
                    } else if (this.currentTool === PIXEL_TOOLS.ERASER) {
                        this.erasePixel(px, py);
                    }
                }
            }
        }
    }
    
    /**
     * 픽셀 그리기
     */
    drawPixel(x, y, color, userId) {
        const key = `${x},${y}`;
        
        this.pixels.set(key, {
            color,
            userId,
            timestamp: Date.now()
        });
        
        eventBus.emit(EVENTS.PIXEL_DRAW, { x, y, color, userId });
    }
    
    /**
     * 픽셀 지우기
     */
    erasePixel(x, y) {
        const key = `${x},${y}`;
        this.pixels.delete(key);
    }
    
    /**
     * 영역 채우기 (Flood Fill)
     */
    floodFill(startX, startY, fillColor, userId) {
        const targetKey = `${startX},${startY}`;
        const targetPixel = this.pixels.get(targetKey);
        const targetColor = targetPixel?.color || null;
        
        if (targetColor === fillColor) return;
        
        const stack = [[startX, startY]];
        const visited = new Set();
        const maxPixels = 1000; // 성능을 위한 제한
        let filled = 0;
        
        while (stack.length > 0 && filled < maxPixels) {
            const [x, y] = stack.pop();
            const key = `${x},${y}`;
            
            if (visited.has(key)) continue;
            if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
            
            const pixel = this.pixels.get(key);
            const pixelColor = pixel?.color || null;
            
            if (pixelColor !== targetColor) continue;
            
            visited.add(key);
            this.drawPixel(x, y, fillColor, userId);
            filled++;
            
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
    }
    
    /**
     * 캔버스 렌더링
     */
    render() {
        // 배경 다시 그리기
        this.drawBackground();
        
        // 모든 픽셀 그리기
        for (const [key, pixel] of this.pixels) {
            const [x, y] = key.split(',').map(Number);
            this.ctx.fillStyle = pixel.color;
            this.ctx.fillRect(
                x * this.pixelSize,
                y * this.pixelSize,
                this.pixelSize,
                this.pixelSize
            );
        }
        
        // 그리드 오버레이 (선택적)
        if (this.showGrid) {
            this.drawGrid();
        }
    }
    
    /**
     * 그리드 그리기
     */
    drawGrid() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 0.5;
        
        for (let x = 0; x <= this.width; x++) {
            this.ctx.beginPath();
            this.ctx.moveTo(x * this.pixelSize, 0);
            this.ctx.lineTo(x * this.pixelSize, this.height * this.pixelSize);
            this.ctx.stroke();
        }
        
        for (let y = 0; y <= this.height; y++) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y * this.pixelSize);
            this.ctx.lineTo(this.width * this.pixelSize, y * this.pixelSize);
            this.ctx.stroke();
        }
    }
    
    /**
     * Firestore에 저장
     */
    async saveToFirestore() {
        try {
            const data = {
                territoryId: this.territoryId,
                pixels: this.encodePixels(),
                filledPixels: this.pixels.size,
                lastUpdated: Date.now()
            };
            
            await firebaseService.setDocument('pixelCanvases', this.territoryId, data);
            
            // 가치 변경 이벤트 발행
            eventBus.emit(EVENTS.PIXEL_VALUE_CHANGE, {
                territoryId: this.territoryId,
                filledPixels: this.pixels.size,
                value: this.calculateValue()
            });
            
            log.debug('Pixels saved to Firestore');
            
        } catch (error) {
            log.error('Failed to save pixels:', error);
        }
    }
    
    /**
     * 실시간 동기화 시작
     */
    startRealtimeSync() {
        this.unsubscribe = firebaseService.subscribeToDocument(
            'pixelCanvases',
            this.territoryId,
            (data) => {
                if (data && data.pixels && !this.isDrawing) {
                    this.decodePixels(data.pixels);
                    this.render();
                }
            }
        );
    }
    
    /**
     * 히스토리에 저장
     */
    saveToHistory() {
        // 현재 상태 저장
        const state = this.encodePixels();
        
        // 현재 위치 이후의 히스토리 삭제
        this.history = this.history.slice(0, this.historyIndex + 1);
        
        // 새 상태 추가
        this.history.push(state);
        this.historyIndex++;
        
        // 최대 히스토리 제한
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
            this.saveToFirestore();
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
            this.saveToFirestore();
        }
    }
    
    /**
     * 도구 설정
     */
    setTool(tool) {
        this.currentTool = tool;
        eventBus.emit(EVENTS.PIXEL_UPDATE, { type: 'toolChanged', tool });
    }
    
    /**
     * 색상 설정
     */
    setColor(color) {
        this.currentColor = color;
        eventBus.emit(EVENTS.PIXEL_UPDATE, { type: 'colorChanged', color });
    }
    
    /**
     * 브러시 크기 설정
     */
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(size, 10));
    }
    
    /**
     * 캔버스 클리어
     */
    clear() {
        this.saveToHistory();
        this.pixels.clear();
        this.render();
        this.saveToFirestore();
    }
    
    /**
     * 가치 계산
     */
    calculateValue() {
        return this.pixels.size;
    }
    
    /**
     * 기여자 통계
     */
    getContributorStats() {
        const stats = new Map();
        
        for (const [_, pixel] of this.pixels) {
            const count = stats.get(pixel.userId) || 0;
            stats.set(pixel.userId, count + 1);
        }
        
        // 배열로 변환 및 정렬
        return Array.from(stats.entries())
            .map(([userId, count]) => ({ userId, count, percentage: Math.round((count / this.pixels.size) * 100) }))
            .sort((a, b) => b.count - a.count);
    }
    
    /**
     * 캔버스를 이미지로 내보내기
     */
    toDataURL() {
        return this.canvas.toDataURL('image/png');
    }
    
    /**
     * 정리
     */
    cleanup() {
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        this.pixels.clear();
        this.history = [];
        this.territoryId = null;
    }
}

// 싱글톤 인스턴스
export const pixelCanvas = new PixelCanvas();
export default pixelCanvas;

