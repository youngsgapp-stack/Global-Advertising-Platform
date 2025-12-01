/**
 * TimerManager - 타이머 관리 유틸리티
 * 모든 타이머를 추적하고 정리하여 메모리 누수를 방지합니다.
 */
class TimerManager {
    constructor() {
        this.intervals = new Set();
        this.timeouts = new Set();
        this.animationFrames = new Set();
    }
    
    /**
     * setInterval 래퍼
     * @param {Function} callback - 콜백 함수
     * @param {number} delay - 지연 시간 (ms)
     * @returns {number} 타이머 ID
     */
    setInterval(callback, delay) {
        const id = setInterval(callback, delay);
        this.intervals.add(id);
        return id;
    }
    
    /**
     * setTimeout 래퍼
     * @param {Function} callback - 콜백 함수
     * @param {number} delay - 지연 시간 (ms)
     * @returns {number} 타이머 ID
     */
    setTimeout(callback, delay) {
        const id = setTimeout(() => {
            this.timeouts.delete(id);
            callback();
        }, delay);
        this.timeouts.add(id);
        return id;
    }
    
    /**
     * requestAnimationFrame 래퍼
     * @param {Function} callback - 콜백 함수
     * @returns {number} 애니메이션 프레임 ID
     */
    requestAnimationFrame(callback) {
        const id = requestAnimationFrame(() => {
            this.animationFrames.delete(id);
            callback();
        });
        this.animationFrames.add(id);
        return id;
    }
    
    /**
     * setInterval 정리
     * @param {number} id - 타이머 ID
     */
    clearInterval(id) {
        if (this.intervals.has(id)) {
            clearInterval(id);
            this.intervals.delete(id);
        }
    }
    
    /**
     * setTimeout 정리
     * @param {number} id - 타이머 ID
     */
    clearTimeout(id) {
        if (this.timeouts.has(id)) {
            clearTimeout(id);
            this.timeouts.delete(id);
        }
    }
    
    /**
     * requestAnimationFrame 정리
     * @param {number} id - 애니메이션 프레임 ID
     */
    cancelAnimationFrame(id) {
        if (this.animationFrames.has(id)) {
            cancelAnimationFrame(id);
            this.animationFrames.delete(id);
        }
    }
    
    /**
     * 모든 타이머 정리
     */
    cleanup() {
        // 모든 interval 정리
        for (const id of this.intervals) {
            try {
                clearInterval(id);
            } catch (error) {
                console.warn('[TimerManager] interval 정리 실패:', id, error);
            }
        }
        this.intervals.clear();
        
        // 모든 timeout 정리
        for (const id of this.timeouts) {
            try {
                clearTimeout(id);
            } catch (error) {
                console.warn('[TimerManager] timeout 정리 실패:', id, error);
            }
        }
        this.timeouts.clear();
        
        // 모든 animationFrame 정리
        for (const id of this.animationFrames) {
            try {
                cancelAnimationFrame(id);
            } catch (error) {
                console.warn('[TimerManager] animationFrame 정리 실패:', id, error);
            }
        }
        this.animationFrames.clear();
        
        console.log('[TimerManager] 모든 타이머 정리 완료');
    }
    
    /**
     * 현재 등록된 타이머 수 반환
     * @returns {Object} 타이머 통계
     */
    getStats() {
        return {
            intervals: this.intervals.size,
            timeouts: this.timeouts.size,
            animationFrames: this.animationFrames.size,
            total: this.intervals.size + this.timeouts.size + this.animationFrames.size
        };
    }
}

// 전역에서 사용할 수 있도록 export
if (typeof window !== 'undefined') {
    window.TimerManager = TimerManager;
}

// ES6 모듈 export (선택적)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TimerManager;
}

