/**
 * Event Bus System for v2 Architecture
 * 중앙 이벤트 버스를 통한 엔진 간 통신
 */
class EventBus {
    constructor() {
        this.listeners = new Map();
        this.requestHandlers = new Map();
        this.requestIdCounter = 0;
        this.pendingRequests = new Map();
    }

    /**
     * 이벤트 구독
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     * @returns {Function} - 구독 해제 함수
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);

        // 구독 해제 함수 반환
        return () => {
            this.off(event, callback);
        };
    }

    /**
     * 이벤트 구독 해제
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     */
    off(event, callback) {
        if (!this.listeners.has(event)) return;
        
        const callbacks = this.listeners.get(event);
        const index = callbacks.indexOf(callback);
        if (index > -1) {
            callbacks.splice(index, 1);
        }

        // 리스너가 없으면 맵에서 제거
        if (callbacks.length === 0) {
            this.listeners.delete(event);
        }
    }

    /**
     * 이벤트 발생 (비동기)
     * @param {string} event - 이벤트 이름
     * @param {*} data - 이벤트 데이터
     */
    emit(event, data) {
        const callbacks = this.listeners.get(event) || [];
        callbacks.forEach(cb => {
            try {
                cb(data);
            } catch (error) {
                console.error(`[EventBus] Error in event handler for "${event}":`, error);
            }
        });
    }

    /**
     * 이벤트 발생 (동기)
     * @param {string} event - 이벤트 이름
     * @param {*} data - 이벤트 데이터
     */
    emitSync(event, data) {
        const callbacks = this.listeners.get(event) || [];
        callbacks.forEach(cb => {
            try {
                cb(data);
            } catch (error) {
                console.error(`[EventBus] Error in event handler for "${event}":`, error);
            }
        });
    }

    /**
     * 한 번만 실행되는 이벤트 구독
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     */
    once(event, callback) {
        const wrapper = (data) => {
            callback(data);
            this.off(event, wrapper);
        };
        this.on(event, wrapper);
    }

    /**
     * 요청-응답 패턴: 요청 핸들러 등록
     * @param {string} event - 이벤트 이름
     * @param {Function} handler - 요청 핸들러 함수 (data) => Promise<response>
     */
    registerRequestHandler(event, handler) {
        this.requestHandlers.set(event, handler);
    }

    /**
     * 요청-응답 패턴: 요청 핸들러 제거
     * @param {string} event - 이벤트 이름
     */
    unregisterRequestHandler(event) {
        this.requestHandlers.delete(event);
    }

    /**
     * 요청-응답 패턴: 요청 전송
     * @param {string} event - 이벤트 이름
     * @param {*} data - 요청 데이터
     * @param {number} timeout - 타임아웃 (ms, 기본값: 5000)
     * @returns {Promise<*>} - 응답 데이터
     */
    async request(event, data = {}, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;
            
            // 타임아웃 설정
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request timeout for "${event}"`));
            }, timeout);

            // 요청 저장
            this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

            // 요청 핸들러 호출
            const handler = this.requestHandlers.get(event);
            if (!handler) {
                clearTimeout(timeoutId);
                this.pendingRequests.delete(requestId);
                reject(new Error(`No handler registered for "${event}"`));
                return;
            }

            // 핸들러 실행
            Promise.resolve(handler(data))
                .then(response => {
                    clearTimeout(timeoutId);
                    this.pendingRequests.delete(requestId);
                    resolve(response);
                })
                .catch(error => {
                    clearTimeout(timeoutId);
                    this.pendingRequests.delete(requestId);
                    reject(error);
                });
        });
    }

    /**
     * 모든 리스너 제거
     */
    clear() {
        this.listeners.clear();
        this.requestHandlers.clear();
        this.pendingRequests.forEach(({ timeoutId }) => {
            clearTimeout(timeoutId);
        });
        this.pendingRequests.clear();
    }

    /**
     * 디버깅: 현재 구독 중인 이벤트 목록
     * @returns {Object} - 이벤트별 리스너 수
     */
    getSubscriptions() {
        const subscriptions = {};
        this.listeners.forEach((callbacks, event) => {
            subscriptions[event] = callbacks.length;
        });
        return subscriptions;
    }
}

// 전역 EventBus 인스턴스 생성
window.EventBus = new EventBus();

