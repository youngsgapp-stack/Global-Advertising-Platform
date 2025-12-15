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
                // 로그인하지 않은 사용자는 조용히 실패 (재연결 시도 안 함)
                log.debug('[WebSocketService] User not authenticated, skipping WebSocket connection');
                this.isConnecting = false;
                this.reconnectAttempts = 0; // 재연결 시도 초기화
                return;
            }
            
            // 관리자 사용자 모드: 가상 사용자인 경우 실제 Firebase Auth 사용자의 토큰 사용
            let token;
            if (user.isAdmin || user.adminMode || (user.uid && user.uid.startsWith('admin_'))) {
                const realAuthUser = firebaseService.getRealAuthUser();
                if (realAuthUser && typeof realAuthUser.getIdToken === 'function') {
                    log.debug('[WebSocketService] Using real Firebase Auth token for admin user mode');
                    try {
                        token = await realAuthUser.getIdToken();
                        log.debug('[WebSocketService] Successfully obtained token for admin user mode');
                    } catch (tokenError) {
                        log.debug('[WebSocketService] Failed to get token from real auth user:', tokenError.message);
                        this.isConnecting = false;
                        this.reconnectAttempts = 0; // 재연결 시도 초기화
                        return;
                    }
                } else {
                    log.debug('[WebSocketService] Admin user mode requires real Firebase Auth user');
                    this.isConnecting = false;
                    this.reconnectAttempts = 0; // 재연결 시도 초기화
                    return;
                }
            } else if (typeof user.getIdToken === 'function') {
                try {
                    token = await user.getIdToken();
                } catch (tokenError) {
                    log.debug('[WebSocketService] Failed to get token from user:', tokenError.message);
                    this.isConnecting = false;
                    this.reconnectAttempts = 0; // 재연결 시도 초기화
                    return;
                }
            } else {
                log.debug('[WebSocketService] User object does not have getIdToken method');
                this.isConnecting = false;
                this.reconnectAttempts = 0; // 재연결 시도 초기화
                return;
            }
            
            const wsUrl = `${this.getWebSocketUrl()}?token=${token}`;
            
            log.debug('[WebSocketService] 🔌 Connecting to WebSocket...');
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                log.debug('[WebSocketService] ✅ Connected');
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
                log.debug('[WebSocketService] ❌ Connection error (will retry if token is valid)');
                this.isConnecting = false;
            };
            
            this.ws.onclose = (event) => {
                this.isConnected = false;
                this.isConnecting = false;
                this.stopHeartbeat();
                
                // 연결 종료 이벤트 발행
                eventBus.emit(EVENTS.WEBSOCKET_DISCONNECTED);
                
                // 토큰 오류(1008)인 경우 재연결 시도 안 함
                if (event.code === 1008) {
                    // Invalid token 오류 - 로그인하지 않았거나 토큰이 유효하지 않음
                    log.debug('[WebSocketService] 🔌 Disconnected: Invalid token (user may not be logged in)');
                    this.reconnectAttempts = 0; // 재연결 시도 초기화
                    return;
                }
                
                // 정상 종료(1000)가 아닌 경우에만 재연결 시도
                if (event.code !== 1000) {
                    log.debug(`[WebSocketService] 🔌 Disconnected (code: ${event.code}), will retry...`);
                    this.scheduleReconnect();
                } else {
                    log.debug('[WebSocketService] 🔌 Disconnected: Normal closure');
                    this.reconnectAttempts = 0;
                }
            };
            
        } catch (error) {
            log.debug('[WebSocketService] Connection failed:', error.message);
            this.isConnecting = false;
            // 토큰 관련 오류가 아닌 경우에만 재연결 시도
            if (!error.message?.includes('token') && !error.message?.includes('auth')) {
                this.scheduleReconnect();
            } else {
                this.reconnectAttempts = 0;
            }
        }
    }
    
    /**
     * 재연결 예약
     */
    scheduleReconnect() {
        // 로그인하지 않은 사용자는 재연결 시도 안 함
        const user = firebaseService.getCurrentUser();
        if (!user) {
            log.debug('[WebSocketService] User not authenticated, skipping reconnect');
            this.reconnectAttempts = 0;
            return;
        }
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.debug('[WebSocketService] Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        
        log.debug(`[WebSocketService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            // 재연결 전에 다시 사용자 확인
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                log.debug('[WebSocketService] User logged out during reconnect, cancelling');
                this.reconnectAttempts = 0;
                return;
            }
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

