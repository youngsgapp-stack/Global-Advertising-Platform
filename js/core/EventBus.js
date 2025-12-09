/**
 * EventBus - 전역 이벤트 시스템
 * 모듈 간 느슨한 결합을 위한 pub/sub 패턴
 */

class EventBus {
    constructor() {
        this.listeners = new Map();
        this.onceListeners = new Map();
    }
    
    /**
     * 이벤트 구독
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     * @returns {Function} - 구독 해제 함수
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        
        // 구독 해제 함수 반환
        return () => this.off(event, callback);
    }
    
    /**
     * 1회성 이벤트 구독
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     */
    once(event, callback) {
        if (!this.onceListeners.has(event)) {
            this.onceListeners.set(event, new Set());
        }
        this.onceListeners.get(event).add(callback);
    }
    
    /**
     * 이벤트 구독 해제
     * @param {string} event - 이벤트 이름
     * @param {Function} callback - 콜백 함수
     */
    off(event, callback) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).delete(callback);
        }
        if (this.onceListeners.has(event)) {
            this.onceListeners.get(event).delete(callback);
        }
    }
    
    /**
     * 이벤트 발행
     * @param {string} event - 이벤트 이름
     * @param {*} data - 전달할 데이터
     */
    emit(event, data) {
        // 일반 리스너 호출
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`[EventBus] Error in listener for "${event}":`, error);
                }
            });
        }
        
        // 1회성 리스너 호출 후 제거
        if (this.onceListeners.has(event)) {
            this.onceListeners.get(event).forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`[EventBus] Error in once listener for "${event}":`, error);
                }
            });
            this.onceListeners.delete(event);
        }
    }
    
    /**
     * 특정 이벤트의 모든 리스너 제거
     * @param {string} event - 이벤트 이름
     */
    clear(event) {
        this.listeners.delete(event);
        this.onceListeners.delete(event);
    }
    
    /**
     * 모든 리스너 제거
     */
    clearAll() {
        this.listeners.clear();
        this.onceListeners.clear();
    }
    
    /**
     * 디버그용: 등록된 이벤트 목록
     */
    getEvents() {
        return [...this.listeners.keys(), ...this.onceListeners.keys()];
    }
}

// v2 이벤트 타입 정의
export const EVENTS = {
    // 앱 생명주기
    APP_READY: 'app:ready',
    APP_ERROR: 'app:error',
    
    // 인증
    AUTH_STATE_CHANGED: 'auth:stateChanged',
    AUTH_LOGIN: 'auth:login',
    AUTH_LOGOUT: 'auth:logout',
    AUTH_ERROR: 'auth:error',
    
    // 지도
    MAP_LOADED: 'map:loaded',
    MAP_CLICK: 'map:click',
    MAP_HOVER: 'map:hover',
    MAP_ZOOM: 'map:zoom',
    MAP_MOVE: 'map:move',
    MAP_MODE_CHANGE: 'map:modeChange',
    MAP_LAYER_ADDED: 'map:layerAdded',
    WORLD_VIEW_LOADED: 'map:worldViewLoaded',  // World View 로드 완료
    
    // 영토
    // ⚠️ 전문가 조언 반영: 입력/출력 이벤트 분리
    TERRITORY_CLICKED: 'territory:clicked',      // 입력: 클릭/선택 요청 (territoryId, properties만 있음)
    TERRITORY_SELECTED: 'territory:selected',    // 출력: 완전히 하이드레이트된 Territory 객체 준비 완료
    TERRITORY_SELECT: 'territory:select',        // 레거시 호환성 유지 (deprecated)
    TERRITORY_DESELECT: 'territory:deselect',
    TERRITORY_CONQUERED: 'territory:conquered',
    TERRITORY_UPDATE: 'territory:update',
    TERRITORY_HOVER: 'territory:hover',
    
    // 옥션
    AUCTION_START: 'auction:start',
    AUCTION_BID: 'auction:bid',
    AUCTION_END: 'auction:end',
    AUCTION_UPDATE: 'auction:update',
    
    // 픽셀 캔버스
    PIXEL_DRAW: 'pixel:draw',
    PIXEL_UPDATE: 'pixel:update',
    PIXEL_CANVAS_LOAD: 'pixel:canvasLoad',
    PIXEL_VALUE_CHANGE: 'pixel:valueChange',
    PIXEL_CANVAS_UPDATED: 'pixel:canvasUpdated',
    PIXEL_CANVAS_SAVED: 'pixel:canvasSaved',
    PIXEL_DATA_SAVED: 'pixel:dataSaved',
    PIXEL_DATA_DELETED: 'pixel:dataDeleted',  // 소유권 변경 시 픽셀 아트 삭제
    
    // 랭킹
    RANKING_UPDATE: 'ranking:update',
    HEGEMONY_CHANGE: 'hegemony:change',
    
    // 버프
    BUFF_APPLIED: 'buff:applied',
    BUFF_EXPIRED: 'buff:expired',
    
    // 공동작업
    COLLAB_JOIN: 'collab:join',
    COLLAB_LEAVE: 'collab:leave',
    COLLAB_UPDATE: 'collab:update',
    
    // UI
    UI_PANEL_OPEN: 'ui:panelOpen',
    UI_PANEL_CLOSE: 'ui:panelClose',
    UI_MODAL_OPEN: 'ui:modalOpen',
    UI_MODAL_CLOSE: 'ui:modalClose',
    UI_NOTIFICATION: 'ui:notification',
    
    // 결제
    PAYMENT_START: 'payment:start',
    PAYMENT_SUCCESS: 'payment:success',
    PAYMENT_ERROR: 'payment:error',
    PAYMENT_CANCEL: 'payment:cancel',
    
    // 서비스 모드
    SERVICE_MODE_CHANGED: 'service:modeChanged',
    
    // 보안 & Rate Limiting
    SUSPICIOUS_ACTIVITY: 'security:suspiciousActivity',
    RATE_LIMIT_EXCEEDED: 'security:rateLimitExceeded',
    
    // 소유권
    TERRITORY_OWNERSHIP_TRANSFERRED: 'territory:ownershipTransferred',
    
    // API
    API_ERROR: 'api:error'
};

// 싱글톤 인스턴스 생성 및 내보내기
export const eventBus = new EventBus();
export default eventBus;

