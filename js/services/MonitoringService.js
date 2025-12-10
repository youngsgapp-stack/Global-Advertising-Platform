/**
 * MonitoringService - 모니터링 및 알림 시스템
 * Firestore 메트릭, API 에러율, 페이지 로딩 시간 추적
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { serviceModeManager } from './ServiceModeManager.js';
import { firebaseService } from './FirebaseService.js';

class MonitoringService {
    constructor() {
        this.metrics = {
            firestore: {
                reads: 0,
                writes: 0,
                errors: 0,
                lastError: null,
                // ⚠️ Step 5-3: 기능별/컬렉션별 read count 추적
                readsByCollection: new Map(), // collectionName -> count
                readsByOperation: new Map(),  // operation -> count (getDocument, queryCollection, onSnapshot)
                readsByPage: new Map(),       // page/feature -> count
                readsByTime: []               // { timestamp, count, collection } - 최근 100개
            },
            api: {
                requests: 0,
                errors: 0,
                lastError: null,
                responseTimes: []
            },
            performance: {
                pageLoadTime: 0,
                renderTime: 0,
                firstContentfulPaint: 0
            },
            user: {
                concurrentUsers: 0,
                activeUsers: new Set()
            }
        };
        
        this.alerts = {
            firestoreErrorRate: 0.05,      // 5%
            apiErrorRate: 0.05,            // 5%
            pageLoadTime: 10000,           // 10초
            firestoreQuota: 0.8            // 80%
        };
        
        this.reportingInterval = 60000; // 1분마다 리포트
        this.reportingTimer = null;
        this.performanceObserver = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        // Performance API 모니터링
        this.setupPerformanceMonitoring();
        
        // 주기적 리포트
        this.startReporting();
        
        log.info('[MonitoringService] Initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // Firestore 에러
        eventBus.on(EVENTS.APP_ERROR, (data) => {
            if (data.type === 'firestore') {
                this.recordFirestoreError(data.error);
            }
        });
        
        // API 에러
        eventBus.on(EVENTS.API_ERROR, (data) => {
            this.recordApiError(data.error);
        });
        
        // 의심스러운 활동
        eventBus.on(EVENTS.SUSPICIOUS_ACTIVITY, (data) => {
            this.recordSuspiciousActivity(data);
        });
        
        // Rate Limit 초과
        eventBus.on(EVENTS.RATE_LIMIT_EXCEEDED, (data) => {
            this.recordRateLimitExceeded(data);
        });
    }
    
    /**
     * Performance API 모니터링 설정
     */
    setupPerformanceMonitoring() {
        if (!window.performance || !window.performance.timing) {
            log.warn('[MonitoringService] Performance API not available');
            return;
        }
        
        // 페이지 로딩 시간 측정
        window.addEventListener('load', () => {
            const timing = window.performance.timing;
            this.metrics.performance.pageLoadTime = timing.loadEventEnd - timing.navigationStart;
            this.metrics.performance.renderTime = timing.domComplete - timing.domLoading;
            this.metrics.performance.firstContentfulPaint = timing.responseEnd - timing.navigationStart;
            
            // 서비스 모드 메트릭 업데이트
            serviceModeManager.recordMetric('pageLoadTime', this.metrics.performance.pageLoadTime);
            
            // 알림 체크
            this.checkAlerts();
        });
        
        // Performance Observer (Resource Timing)
        if ('PerformanceObserver' in window) {
            try {
                this.performanceObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.entryType === 'resource') {
                            const duration = entry.responseEnd - entry.startTime;
                            this.metrics.api.responseTimes.push(duration);
                            
                            // 최근 100개만 유지
                            if (this.metrics.api.responseTimes.length > 100) {
                                this.metrics.api.responseTimes.shift();
                            }
                        }
                    }
                });
                
                this.performanceObserver.observe({ entryTypes: ['resource'] });
            } catch (error) {
                log.warn('[MonitoringService] PerformanceObserver not supported:', error);
            }
        }
    }
    
    /**
     * Firestore 읽기 기록
     * ⚠️ Step 5-3: 기능별/컬렉션별 read count 추적
     */
    recordFirestoreRead(count = 1, context = {}) {
        this.metrics.firestore.reads += count;
        serviceModeManager.recordMetric('firestoreRead', count);
        
        // ⚠️ Step 5-3: 컬렉션별 추적
        if (context.collection) {
            const current = this.metrics.firestore.readsByCollection.get(context.collection) || 0;
            this.metrics.firestore.readsByCollection.set(context.collection, current + count);
        }
        
        // ⚠️ Step 5-3: 작업 유형별 추적
        const operation = context.operation || 'unknown';
        const currentOp = this.metrics.firestore.readsByOperation.get(operation) || 0;
        this.metrics.firestore.readsByOperation.set(operation, currentOp + count);
        
        // ⚠️ Step 5-3: 페이지/기능별 추적
        if (context.page || context.feature) {
            const pageKey = context.page || context.feature;
            const currentPage = this.metrics.firestore.readsByPage.get(pageKey) || 0;
            this.metrics.firestore.readsByPage.set(pageKey, currentPage + count);
        }
        
        // ⚠️ Step 5-3: 시간별 추적 (최근 100개만 유지)
        this.metrics.firestore.readsByTime.push({
            timestamp: Date.now(),
            count,
            collection: context.collection,
            operation: operation
        });
        if (this.metrics.firestore.readsByTime.length > 100) {
            this.metrics.firestore.readsByTime.shift();
        }
        
        // ⚠️ Step 5-3: 이상치 감지 (10분 내 5,000회 이상 읽기)
        const recentReads = this.metrics.firestore.readsByTime
            .filter(entry => Date.now() - entry.timestamp < 10 * 60 * 1000)
            .reduce((sum, entry) => sum + entry.count, 0);
        
        if (recentReads > 5000) {
            log.warn(`[MonitoringService] ⚠️ 이상치 감지: 10분 내 ${recentReads}회 읽기 발생`, {
                collection: context.collection,
                operation: operation,
                page: context.page || context.feature
            });
        }
    }
    
    /**
     * Firestore 쓰기 기록
     */
    recordFirestoreWrite(count = 1) {
        this.metrics.firestore.writes += count;
        serviceModeManager.recordMetric('firestoreWrite', count);
    }
    
    /**
     * Firestore 에러 기록
     */
    recordFirestoreError(error) {
        this.metrics.firestore.errors++;
        this.metrics.firestore.lastError = {
            message: error.message || error,
            code: error.code,
            timestamp: Date.now()
        };
        
        serviceModeManager.recordMetric('firestoreError', 1);
        this.checkAlerts();
    }
    
    /**
     * API 요청 기록
     */
    recordApiRequest(responseTime = null) {
        this.metrics.api.requests++;
        if (responseTime !== null) {
            this.metrics.api.responseTimes.push(responseTime);
            if (this.metrics.api.responseTimes.length > 100) {
                this.metrics.api.responseTimes.shift();
            }
        }
    }
    
    /**
     * API 에러 기록
     */
    recordApiError(error) {
        this.metrics.api.errors++;
        this.metrics.api.lastError = {
            message: error.message || error,
            status: error.status,
            timestamp: Date.now()
        };
        
        serviceModeManager.recordMetric('apiError', 1);
        this.checkAlerts();
    }
    
    /**
     * 의심스러운 활동 기록
     */
    recordSuspiciousActivity(data) {
        log.warn('[MonitoringService] Suspicious activity detected:', data);
        
        // 서버로 리포트 (향후 구현)
        // this.reportToServer('suspicious_activity', data);
    }
    
    /**
     * Rate Limit 초과 기록
     */
    recordRateLimitExceeded(data) {
        log.warn('[MonitoringService] Rate limit exceeded:', data);
        
        // 서버로 리포트 (향후 구현)
        // this.reportToServer('rate_limit_exceeded', data);
    }
    
    /**
     * 알림 체크
     */
    checkAlerts() {
        const firestoreErrorRate = this.getFirestoreErrorRate();
        const apiErrorRate = this.getApiErrorRate();
        const pageLoadTime = this.metrics.performance.pageLoadTime;
        
        // Firestore 에러율 알림
        if (firestoreErrorRate > this.alerts.firestoreErrorRate) {
            this.triggerAlert('firestore_error_rate', {
                rate: firestoreErrorRate,
                threshold: this.alerts.firestoreErrorRate
            });
        }
        
        // API 에러율 알림
        if (apiErrorRate > this.alerts.apiErrorRate) {
            this.triggerAlert('api_error_rate', {
                rate: apiErrorRate,
                threshold: this.alerts.apiErrorRate
            });
        }
        
        // 페이지 로딩 시간 알림
        if (pageLoadTime > this.alerts.pageLoadTime) {
            this.triggerAlert('page_load_time', {
                time: pageLoadTime,
                threshold: this.alerts.pageLoadTime
            });
        }
    }
    
    /**
     * 알림 트리거
     */
    triggerAlert(type, data) {
        log.warn(`[MonitoringService] Alert triggered: ${type}`, data);
        
        // UI 알림
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'warning',
            message: `⚠️ 시스템 모니터링: ${this.getAlertMessage(type, data)}`,
            duration: 5000
        });
        
        // 서버로 리포트 (향후 구현)
        // this.reportToServer('alert', { type, data });
    }
    
    /**
     * 알림 메시지 생성
     */
    getAlertMessage(type, data) {
        switch (type) {
            case 'firestore_error_rate':
                return `Firestore 에러율이 ${(data.rate * 100).toFixed(1)}%로 높습니다.`;
            case 'api_error_rate':
                return `API 에러율이 ${(data.rate * 100).toFixed(1)}%로 높습니다.`;
            case 'page_load_time':
                return `페이지 로딩 시간이 ${(data.time / 1000).toFixed(1)}초로 느립니다.`;
            default:
                return '시스템 성능 이슈가 감지되었습니다.';
        }
    }
    
    /**
     * Firestore 에러율 계산
     */
    getFirestoreErrorRate() {
        const total = this.metrics.firestore.reads + this.metrics.firestore.writes;
        if (total === 0) return 0;
        return this.metrics.firestore.errors / total;
    }
    
    /**
     * API 에러율 계산
     */
    getApiErrorRate() {
        if (this.metrics.api.requests === 0) return 0;
        return this.metrics.api.errors / this.metrics.api.requests;
    }
    
    /**
     * 평균 API 응답 시간 계산
     */
    getAverageApiResponseTime() {
        if (this.metrics.api.responseTimes.length === 0) return 0;
        const sum = this.metrics.api.responseTimes.reduce((a, b) => a + b, 0);
        return sum / this.metrics.api.responseTimes.length;
    }
    
    /**
     * 리포트 시작
     */
    startReporting() {
        this.reportingTimer = setInterval(() => {
            this.generateReport();
        }, this.reportingInterval);
    }
    
    /**
     * 리포트 중지
     */
    stopReporting() {
        if (this.reportingTimer) {
            clearInterval(this.reportingTimer);
            this.reportingTimer = null;
        }
    }
    
    /**
     * 리포트 생성
     */
    generateReport() {
        const report = {
            timestamp: Date.now(),
            metrics: {
                firestore: {
                    reads: this.metrics.firestore.reads,
                    writes: this.metrics.firestore.writes,
                    errors: this.metrics.firestore.errors,
                    errorRate: this.getFirestoreErrorRate()
                },
                api: {
                    requests: this.metrics.api.requests,
                    errors: this.metrics.api.errors,
                    errorRate: this.getApiErrorRate(),
                    averageResponseTime: this.getAverageApiResponseTime()
                },
                performance: {
                    ...this.metrics.performance
                }
            },
            serviceMode: serviceModeManager.getMode(),
            alerts: this.checkAlerts()
        };
        
        log.debug('[MonitoringService] Report generated:', report);
        
        // 서버로 리포트 전송 (향후 구현)
        // this.sendReportToServer(report);
        
        // 메트릭 리셋 (선택적)
        // this.resetMetrics();
    }
    
    /**
     * 메트릭 리셋
     */
    resetMetrics() {
        this.metrics.firestore.reads = 0;
        this.metrics.firestore.writes = 0;
        this.metrics.firestore.errors = 0;
        this.metrics.api.requests = 0;
        this.metrics.api.errors = 0;
        this.metrics.api.responseTimes = [];
    }
    
    /**
     * 현재 메트릭 가져오기
     */
    getMetrics() {
        return {
            ...this.metrics,
            firestoreErrorRate: this.getFirestoreErrorRate(),
            apiErrorRate: this.getApiErrorRate(),
            averageApiResponseTime: this.getAverageApiResponseTime()
        };
    }
    
    /**
     * 정리
     */
    cleanup() {
        this.stopReporting();
        if (this.performanceObserver) {
            this.performanceObserver.disconnect();
        }
    }
}

// 싱글톤 인스턴스
export const monitoringService = new MonitoringService();
export default monitoringService;

