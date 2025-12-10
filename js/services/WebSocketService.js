/**
 * WebSocketService - 실시간 업데이트를 위한 WebSocket 클라이언트
 * Firestore onSnapshot 대신 사용
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class WebSocketService {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // 1초부터 시작
        this.isConnecting = false;
        this.isConnected = false;
        this.messageHandlers = new Map(); // type -> handler function
        this.heartbeatInterval = null;
    }
    
    /**
     * WebSocket URL 가져오기
     */
    getWebSocketUrl() {
        // API 서비스와 동일한 호스트 사용
        const apiUrl = CONFIG.API_BASE_URL || 'http://localhost:3000/api';
        const wsUrl = apiUrl.replace(/^https?:\/\//, '').replace(/\/api$/, '');
        // Railway는 HTTPS이므로 WSS 사용
        const protocol = apiUrl.startsWith('https://') || window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${wsUrl}/ws`;
    }
    
    /**
     * 연결 시작
     */
    async connect() {
        if (this.isConnecting || this.isConnected) {
            return;
        }
        
        this.isConnecting = true;
        
        try {
            // Firebase 토큰 가져오기
            const user = firebaseService.getCurrentUser();
            if (!user) {
                log.warn('[WebSocketService] User not authenticated, cannot connect');
                this.isConnecting = false;
                return;
            }
            
            const token = await user.getIdToken();
            const wsUrl = `${this.getWebSocketUrl()}?token=${token}`;
            
            log.info('[WebSocketService] 🔌 Connecting to WebSocket...');
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                log.info('[WebSocketService] ✅ Connected');
                this.isConnected = true;
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.reconnectDelay = 1000;
                
                // 하트비트 시작
                this.startHeartbeat();
                
                // 연결 이벤트 발행
                eventBus.emit(EVENTS.WEBSOCKET_CONNECTED);
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    log.error('[WebSocketService] Failed to parse message:', error);
                }
            };
            
            this.ws.onerror = (error) => {
                log.error('[WebSocketService] ❌ Error:', error);
                this.isConnecting = false;
            };
            
            this.ws.onclose = (event) => {
                log.warn('[WebSocketService] 🔌 Disconnected', event.code, event.reason);
                this.isConnected = false;
                this.isConnecting = false;
                this.stopHeartbeat();
                
                // 연결 종료 이벤트 발행
                eventBus.emit(EVENTS.WEBSOCKET_DISCONNECTED);
                
                // 재연결 시도
                if (event.code !== 1000) { // 정상 종료가 아닌 경우
                    this.scheduleReconnect();
                }
            };
            
        } catch (error) {
            log.error('[WebSocketService] Connection failed:', error);
            this.isConnecting = false;
            this.scheduleReconnect();
        }
    }
    
    /**
     * 재연결 예약
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error('[WebSocketService] Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        
        log.info(`[WebSocketService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect();
        }, delay);
    }
    
    /**
     * 메시지 처리
     */
    handleMessage(message) {
        log.debug('[WebSocketService] 📨 Message received:', message.type);
        
        // 등록된 핸들러 호출
        const handler = this.messageHandlers.get(message.type);
        if (handler) {
            handler(message.data);
        }
        
        // 이벤트 버스로도 발행
        eventBus.emit(`websocket:${message.type}`, message.data);
    }
    
    /**
     * 메시지 핸들러 등록
     */
    on(type, handler) {
        this.messageHandlers.set(type, handler);
    }
    
    /**
     * 메시지 핸들러 제거
     */
    off(type) {
        this.messageHandlers.delete(type);
    }
    
    /**
     * 하트비트 시작
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000); // 30초마다
    }
    
    /**
     * 하트비트 중지
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    /**
     * 연결 종료
     */
    disconnect() {
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.isConnected = false;
        this.stopHeartbeat();
    }
    
    /**
     * 연결 상태 확인
     */
    isConnectedState() {
        return this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}

// 싱글톤 인스턴스
export const webSocketService = new WebSocketService();

