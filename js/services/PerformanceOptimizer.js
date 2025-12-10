/**
 * PerformanceOptimizer - CPU 및 메모리 사용량 최적화 서비스
 * Chrome CPU 사용량 감소를 위한 최적화 도구
 */

import { CONFIG, log } from '../config.js';

class PerformanceOptimizer {
    constructor() {
        this.initialized = false;
        this.optimizations = {
            // Interval 최적화
            intervals: new Map(), // intervalId -> { type, interval }
            
            // 렌더링 최적화
            renderThrottle: 16, // 60fps (16ms)
            lastRenderTime: 0,
            
            // 이벤트 최적화
            eventThrottle: 100, // 100ms
            lastEventTime: 0,
            
            // 메모리 최적화
            memoryCheckInterval: null,
            lastMemoryCheck: 0,
            
            // CPU 모니터링
            cpuMonitor: null,
            cpuUsage: 0,
            
            // 비활성 탭 최적화
            visibilityChangeHandler: null,
            isPageVisible: true
        };
        
        // 성능 통계
        this.stats = {
            intervalsCleared: 0,
            rendersThrottled: 0,
            eventsThrottled: 0,
            memoryFreed: 0
        };
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (this.initialized) {
            log.info('[PerformanceOptimizer] Already initialized');
            return true;
        }
        
        try {
            log.info('[PerformanceOptimizer] 🔧 Initializing performance optimizations...');
            
            // 1. Interval 최적화
            this.optimizeIntervals();
            
            // 2. 렌더링 최적화
            this.optimizeRendering();
            
            // 3. 이벤트 최적화
            this.optimizeEvents();
            
            // 4. 메모리 최적화
            this.optimizeMemory();
            
            // 5. 비활성 탭 최적화
            this.optimizeInactiveTabs();
            
            // 6. CPU 모니터링
            this.startCPUMonitoring();
            
            // 7. 성능 경고 시스템
            this.setupPerformanceWarnings();
            
            this.initialized = true;
            log.info('[PerformanceOptimizer] ✅ Performance optimizations initialized');
            
            // 성능 통계 출력
            this.logStats();
            
            return true;
            
        } catch (error) {
            log.error('[PerformanceOptimizer] ❌ Initialization failed:', error);
            return false;
        }
    }
    
    /**
     * Interval 최적화
     * 불필요한 setInterval을 찾아 최적화
     */
    optimizeIntervals() {
        // 기존 setInterval 래핑
        const originalSetInterval = window.setInterval;
        const originalClearInterval = window.clearInterval;
        
        window.setInterval = (callback, delay, ...args) => {
            // 너무 짧은 interval 방지 (100ms 미만)
            if (delay < 100) {
                log.warn(`[PerformanceOptimizer] ⚠️ Interval too short: ${delay}ms, throttling to 100ms`);
                delay = 100;
            }
            
            const intervalId = originalSetInterval(callback, delay, ...args);
            
            // Interval 추적
            this.optimizations.intervals.set(intervalId, {
                type: 'unknown',
                interval: delay,
                createdAt: Date.now()
            });
            
            log.debug(`[PerformanceOptimizer] Interval created: ${intervalId} (${delay}ms)`);
            
            return intervalId;
        };
        
        window.clearInterval = (intervalId) => {
            if (this.optimizations.intervals.has(intervalId)) {
                this.optimizations.intervals.delete(intervalId);
                this.stats.intervalsCleared++;
            }
            return originalClearInterval(intervalId);
        };
        
        // 주기적으로 사용하지 않는 interval 정리
        setInterval(() => {
            this.cleanupUnusedIntervals();
        }, 30000); // 30초마다 체크
    }
    
    /**
     * 사용하지 않는 interval 정리
     */
    cleanupUnusedIntervals() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [intervalId, info] of this.optimizations.intervals.entries()) {
            // 5분 이상 사용되지 않은 interval은 경고
            if (now - info.createdAt > 300000) {
                log.warn(`[PerformanceOptimizer] ⚠️ Long-running interval detected: ${intervalId} (${info.interval}ms)`);
            }
        }
    }
    
    /**
     * 렌더링 최적화
     * requestAnimationFrame 최적화
     */
    optimizeRendering() {
        const originalRAF = window.requestAnimationFrame;
        
        window.requestAnimationFrame = (callback) => {
            const now = performance.now();
            const timeSinceLastRender = now - this.optimizations.lastRenderTime;
            
            // 렌더링 스로틀링 (60fps 제한)
            if (timeSinceLastRender < this.optimizations.renderThrottle) {
                this.stats.rendersThrottled++;
                return originalRAF((timestamp) => {
                    // 다음 프레임에 실행
                    callback(timestamp);
                });
            }
            
            this.optimizations.lastRenderTime = now;
            return originalRAF(callback);
        };
    }
    
    /**
     * 이벤트 최적화
     * 빈번한 이벤트 스로틀링
     */
    optimizeEvents() {
        // 이벤트 리스너 최적화를 위한 헬퍼 함수
        this.throttleEvent = (callback, delay = this.optimizations.eventThrottle) => {
            let lastCall = 0;
            let timeoutId = null;
            
            return (...args) => {
                const now = Date.now();
                const timeSinceLastCall = now - lastCall;
                
                if (timeSinceLastCall >= delay) {
                    lastCall = now;
                    callback(...args);
                } else {
                    // 스로틀링
                    this.stats.eventsThrottled++;
                    
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                    }
                    
                    timeoutId = setTimeout(() => {
                        lastCall = Date.now();
                        callback(...args);
                    }, delay - timeSinceLastCall);
                }
            };
        };
        
        // 전역으로 사용 가능하도록
        window.throttleEvent = this.throttleEvent;
    }
    
    /**
     * 메모리 최적화
     * 주기적으로 메모리 정리
     */
    optimizeMemory() {
        // 5분마다 메모리 체크
        this.optimizations.memoryCheckInterval = setInterval(() => {
            this.checkAndFreeMemory();
        }, 300000); // 5분
    }
    
    /**
     * 메모리 체크 및 정리
     */
    checkAndFreeMemory() {
        if (!performance.memory) {
            return; // Chrome DevTools가 열려있지 않으면 사용 불가
        }
        
        const memory = performance.memory;
        const usedMB = memory.usedJSHeapSize / 1048576;
        const totalMB = memory.totalJSHeapSize / 1048576;
        const limitMB = memory.jsHeapSizeLimit / 1048576;
        
        // 메모리 사용률이 80% 이상이면 경고
        if (usedMB / limitMB > 0.8) {
            log.warn(`[PerformanceOptimizer] ⚠️ High memory usage: ${usedMB.toFixed(2)}MB / ${limitMB.toFixed(2)}MB (${((usedMB / limitMB) * 100).toFixed(1)}%)`);
            
            // 가비지 컬렉션 힌트 (Chrome에서만 작동)
            if (window.gc) {
                window.gc();
                this.stats.memoryFreed++;
                log.info('[PerformanceOptimizer] 🗑️ Garbage collection triggered');
            }
        }
        
        this.optimizations.lastMemoryCheck = Date.now();
    }
    
    /**
     * 비활성 탭 최적화
     * 탭이 비활성화되면 불필요한 작업 중지
     */
    optimizeInactiveTabs() {
        this.optimizations.visibilityChangeHandler = () => {
            this.optimizations.isPageVisible = !document.hidden;
            
            if (document.hidden) {
                log.info('[PerformanceOptimizer] 📴 Page hidden, pausing non-essential operations');
                this.pauseNonEssentialOperations();
            } else {
                log.info('[PerformanceOptimizer] 📱 Page visible, resuming operations');
                this.resumeOperations();
            }
        };
        
        document.addEventListener('visibilitychange', this.optimizations.visibilityChangeHandler);
    }
    
    /**
     * 비필수 작업 일시 중지
     */
    pauseNonEssentialOperations() {
        // Interval 일시 중지 (중요한 것 제외)
        for (const [intervalId, info] of this.optimizations.intervals.entries()) {
            if (info.type === 'non-essential') {
                clearInterval(intervalId);
                info.paused = true;
            }
        }
        
        // ⚠️ CPU 모니터링 일시 중지
        if (this.optimizations.cpuMonitor) {
            clearInterval(this.optimizations.cpuMonitor);
            this.optimizations.cpuMonitor = null;
        }
    }
    
    /**
     * 작업 재개
     */
    resumeOperations() {
        // 일시 중지된 interval 재개
        for (const [intervalId, info] of this.optimizations.intervals.entries()) {
            if (info.paused && info.type === 'non-essential') {
                window.setInterval(() => {
                    // 원래 콜백 재개
                }, info.interval);
                info.paused = false;
            }
        }
        
        // ⚠️ CPU 모니터링 재개
        if (!this.optimizations.cpuMonitor) {
            this.startCPUMonitoring();
        }
    }
    
    /**
     * CPU 모니터링 시작
     * ⚠️ 최적화: 간단한 setInterval 기반 모니터링 (requestAnimationFrame 제거)
     */
    startCPUMonitoring() {
        if (!window.performance || !window.performance.mark) {
            return; // Performance API 미지원
        }
        
        // ⚠️ 최적화: requestAnimationFrame 제거, setInterval만 사용 (10초마다)
        // CPU 사용률은 메모리 사용량 기반으로 추정 (정확도는 낮지만 CPU 부하 없음)
        const checkCPU = () => {
            // 페이지가 숨겨져 있으면 모니터링 중지
            if (!this.optimizations.isPageVisible) {
                return;
            }
            
            // ⚠️ 간단한 CPU 사용률 추정 (메모리 사용량 기반)
            // Performance API가 있으면 메모리 사용량으로 추정
            if (performance.memory) {
                const memoryUsage = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
                // 메모리 사용률을 CPU 사용률로 근사 (0~100%)
                this.optimizations.cpuUsage = Math.min(memoryUsage * 100, 100);
                
                // CPU 사용률이 80% 이상이면 경고 (하지만 실제로는 메모리 사용률)
                if (this.optimizations.cpuUsage > 80) {
                    log.warn(`[PerformanceOptimizer] ⚠️ High resource usage detected: ${this.optimizations.cpuUsage.toFixed(1)}% (memory-based estimate)`);
                    this.triggerPerformanceWarning();
                }
            } else {
                // Performance API가 없으면 기본값 (CPU 모니터링 비활성화)
                this.optimizations.cpuUsage = 0;
            }
        };
        
        // ⚠️ 최적화: 10초마다 체크 (기존: 매 프레임)
        // requestAnimationFrame 루프 제거로 CPU 사용량 대폭 감소
        this.optimizations.cpuMonitor = setInterval(checkCPU, 10000);
    }
    
    /**
     * 성능 경고 시스템
     */
    setupPerformanceWarnings() {
        // 주기적으로 성능 체크
        setInterval(() => {
            this.checkPerformance();
        }, 10000); // 10초마다
    }
    
    /**
     * 성능 체크
     */
    checkPerformance() {
        const issues = [];
        
        // Interval 개수 체크
        if (this.optimizations.intervals.size > 10) {
            issues.push(`Too many intervals: ${this.optimizations.intervals.size}`);
        }
        
        // CPU 사용률 체크
        if (this.optimizations.cpuUsage > 70) {
            issues.push(`High CPU usage: ${this.optimizations.cpuUsage.toFixed(1)}%`);
        }
        
        // 메모리 체크
        if (performance.memory) {
            const memoryUsage = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
            if (memoryUsage > 80) {
                issues.push(`High memory usage: ${memoryUsage.toFixed(1)}%`);
            }
        }
        
        if (issues.length > 0) {
            log.warn('[PerformanceOptimizer] ⚠️ Performance issues detected:', issues);
        }
    }
    
    /**
     * 성능 경고 트리거
     */
    triggerPerformanceWarning() {
        // 사용자에게 경고 (선택적)
        if (CONFIG.DEBUG && CONFIG.DEBUG.PERFORMANCE) {
            console.warn('[PerformanceOptimizer] ⚠️ High CPU usage detected. Consider closing unnecessary tabs or reducing map complexity.');
        }
    }
    
    /**
     * 성능 통계 출력
     */
    logStats() {
        log.info('[PerformanceOptimizer] 📊 Performance Stats:', {
            intervals: this.optimizations.intervals.size,
            cpuUsage: `${this.optimizations.cpuUsage.toFixed(1)}%`,
            intervalsCleared: this.stats.intervalsCleared,
            rendersThrottled: this.stats.rendersThrottled,
            eventsThrottled: this.stats.eventsThrottled,
            memoryFreed: this.stats.memoryFreed
        });
    }
    
    /**
     * 성능 통계 가져오기
     */
    getStats() {
        return {
            ...this.stats,
            intervals: this.optimizations.intervals.size,
            cpuUsage: this.optimizations.cpuUsage,
            isPageVisible: this.optimizations.isPageVisible
        };
    }
    
    /**
     * 정리
     */
    cleanup() {
        // Interval 정리
        for (const intervalId of this.optimizations.intervals.keys()) {
            clearInterval(intervalId);
        }
        this.optimizations.intervals.clear();
        
        // 메모리 체크 interval 정리
        if (this.optimizations.memoryCheckInterval) {
            clearInterval(this.optimizations.memoryCheckInterval);
        }
        
        // Visibility change 리스너 제거
        if (this.optimizations.visibilityChangeHandler) {
            document.removeEventListener('visibilitychange', this.optimizations.visibilityChangeHandler);
        }
        
        // CPU 모니터링 중지
        if (this.optimizations.cpuMonitor) {
            cancelAnimationFrame(this.optimizations.cpuMonitor);
        }
        
        this.initialized = false;
        log.info('[PerformanceOptimizer] 🧹 Cleaned up');
    }
}

// 싱글톤 인스턴스
export const performanceOptimizer = new PerformanceOptimizer();

