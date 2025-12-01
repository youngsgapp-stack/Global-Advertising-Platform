/**
 * EventManager - 이벤트 리스너 관리 유틸리티
 * 모든 이벤트 리스너를 추적하고 정리하여 메모리 누수를 방지합니다.
 */
class EventManager {
    constructor() {
        this.listeners = new Map();
        this.mapListeners = new Map(); // MapLibre GL JS 이벤트 리스너
    }
    
    /**
     * DOM 요소에 이벤트 리스너 추가
     * @param {HTMLElement|Window|Document} element - 이벤트를 등록할 요소
     * @param {string} event - 이벤트 타입
     * @param {Function} handler - 이벤트 핸들러
     * @param {Object} options - 이벤트 옵션 (capture, once, passive 등)
     * @returns {string} 리스너 키 (나중에 제거할 때 사용)
     */
    add(element, event, handler, options = {}) {
        if (!element || !event || !handler) {
            console.warn('[EventManager] 잘못된 파라미터:', { element, event, handler });
            return null;
        }
        
        const key = this.generateKey(element, event);
        
        // 기존 리스너가 있으면 먼저 제거
        if (this.listeners.has(key)) {
            this.remove(element, event);
        }
        
        element.addEventListener(event, handler, options);
        this.listeners.set(key, { element, event, handler, options });
        
        return key;
    }
    
    /**
     * MapLibre GL JS 맵 이벤트 리스너 추가
     * @param {Object} map - MapLibre GL JS 맵 인스턴스
     * @param {string} event - 이벤트 타입
     * @param {Function} handler - 이벤트 핸들러
     * @returns {string} 리스너 키
     */
    addMapListener(map, event, handler) {
        if (!map || !event || !handler) {
            console.warn('[EventManager] 잘못된 맵 리스너 파라미터:', { map, event, handler });
            return null;
        }
        
        const key = `map_${event}_${Date.now()}_${Math.random()}`;
        
        map.on(event, handler);
        this.mapListeners.set(key, { map, event, handler });
        
        return key;
    }
    
    /**
     * 이벤트 리스너 제거
     * @param {HTMLElement|Window|Document} element - 이벤트를 등록한 요소
     * @param {string} event - 이벤트 타입
     */
    remove(element, event) {
        const key = this.generateKey(element, event);
        const listener = this.listeners.get(key);
        
        if (listener) {
            listener.element.removeEventListener(listener.event, listener.handler, listener.options);
            this.listeners.delete(key);
        }
    }
    
    /**
     * 맵 이벤트 리스너 제거
     * @param {string} key - 리스너 키
     */
    removeMapListener(key) {
        const listener = this.mapListeners.get(key);
        
        if (listener) {
            listener.map.off(listener.event, listener.handler);
            this.mapListeners.delete(key);
        }
    }
    
    /**
     * 모든 이벤트 리스너 정리
     */
    cleanup() {
        // DOM 이벤트 리스너 정리
        for (const [key, listener] of this.listeners) {
            try {
                listener.element.removeEventListener(listener.event, listener.handler, listener.options);
            } catch (error) {
                console.warn('[EventManager] 리스너 제거 실패:', key, error);
            }
        }
        this.listeners.clear();
        
        // 맵 이벤트 리스너 정리
        for (const [key, listener] of this.mapListeners) {
            try {
                listener.map.off(listener.event, listener.handler);
            } catch (error) {
                console.warn('[EventManager] 맵 리스너 제거 실패:', key, error);
            }
        }
        this.mapListeners.clear();
        
        console.log('[EventManager] 모든 이벤트 리스너 정리 완료');
    }
    
    /**
     * 리스너 키 생성
     * @param {HTMLElement|Window|Document} element - 요소
     * @param {string} event - 이벤트 타입
     * @returns {string} 리스너 키
     */
    generateKey(element, event) {
        let elementId = '';
        
        if (element === window) {
            elementId = 'window';
        } else if (element === document) {
            elementId = 'document';
        } else if (element && element.id) {
            elementId = element.id;
        } else if (element && element.tagName) {
            elementId = `${element.tagName}_${Math.random().toString(36).substr(2, 9)}`;
        } else {
            elementId = `element_${Math.random().toString(36).substr(2, 9)}`;
        }
        
        return `${elementId}_${event}`;
    }
    
    /**
     * 현재 등록된 리스너 수 반환
     * @returns {Object} 리스너 통계
     */
    getStats() {
        return {
            domListeners: this.listeners.size,
            mapListeners: this.mapListeners.size,
            total: this.listeners.size + this.mapListeners.size
        };
    }
}

// 전역에서 사용할 수 있도록 export
if (typeof window !== 'undefined') {
    window.EventManager = EventManager;
}

// ES6 모듈 export (선택적)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EventManager;
}

