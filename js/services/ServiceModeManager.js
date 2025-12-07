/**
 * ServiceModeManager - 서비스 모드 관리 시스템
 * Normal / Busy / Emergency 모드 전환 및 기능 제어
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

// 서비스 모드 타입
export const SERVICE_MODE = {
    NORMAL: 'normal',      // 일상 모드
    BUSY: 'busy',          // 높은 부하 모드
    EMERGENCY: 'emergency' // 비상 모드
};

// 모드별 기능 설정
const MODE_CONFIG = {
    [SERVICE_MODE.NORMAL]: {
        // 실시간 기능 모두 활성화
        realtimeRanking: true,
        realtimeRankingInterval: 0, // 0 = 실시간
        pixelEditorEnabled: true,
        animationsEnabled: true,
        effectsEnabled: true,
        mapThumbnailMode: false, // 전체 맵 렌더링
        pixelSaveDelay: 800, // 0.8초
        pixelSaveBatchSize: 1,
        rankingUpdateInterval: 0, // 실시간
        statisticsEnabled: true,
        filtersEnabled: true,
        searchEnabled: true,
        liveIndicatorsEnabled: true
    },
    [SERVICE_MODE.BUSY]: {
        // 일부 기능 제한
        realtimeRanking: true,
        realtimeRankingInterval: 60000, // 1분
        pixelEditorEnabled: true,
        animationsEnabled: false,
        effectsEnabled: false,
        mapThumbnailMode: false,
        pixelSaveDelay: 2000, // 2초
        pixelSaveBatchSize: 5,
        rankingUpdateInterval: 300000, // 5분
        statisticsEnabled: true,
        filtersEnabled: false,
        searchEnabled: false,
        liveIndicatorsEnabled: false
    },
    [SERVICE_MODE.EMERGENCY]: {
        // 최소 기능만 유지
        realtimeRanking: false,
        realtimeRankingInterval: 0,
        pixelEditorEnabled: true, // 소유자만
        animationsEnabled: false,
        effectsEnabled: false,
        mapThumbnailMode: true, // 이미지로만 제공
        pixelSaveDelay: 5000, // 5초
        pixelSaveBatchSize: 10,
        rankingUpdateInterval: 0, // 비활성화
        statisticsEnabled: false,
        filtersEnabled: false,
        searchEnabled: false,
        liveIndicatorsEnabled: false
    }
};

class ServiceModeManager {
    constructor() {
        this.currentMode = SERVICE_MODE.NORMAL;
        this.config = { ...MODE_CONFIG[SERVICE_MODE.NORMAL] };
        this.monitoringInterval = null;
        this.metrics = {
            firestoreReads: 0,
            firestoreWrites: 0,
            firestoreErrors: 0,
            apiErrors: 0,
            pageLoadTime: 0,
            concurrentUsers: 0,
            lastUpdate: Date.now()
        };
    }
    
    /**
     * 초기화
     */
    async initialize() {
        // 로컬 스토리지에서 모드 복원 (관리자가 설정한 경우)
        const savedMode = localStorage.getItem('serviceMode');
        if (savedMode && Object.values(SERVICE_MODE).includes(savedMode)) {
            this.setMode(savedMode, false); // 자동 저장 안 함
        }
        
        // 모니터링 시작
        this.startMonitoring();
        
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        log.info(`[ServiceModeManager] Initialized with mode: ${this.currentMode}`);
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // Firestore 에러 감지
        eventBus.on(EVENTS.APP_ERROR, (data) => {
            if (data.type === 'firestore') {
                this.metrics.firestoreErrors++;
                this.checkAndAdjustMode();
            }
        });
        
        // API 에러 감지
        eventBus.on(EVENTS.API_ERROR, () => {
            this.metrics.apiErrors++;
            this.checkAndAdjustMode();
        });
    }
    
    /**
     * 모드 설정
     */
    setMode(mode, saveToStorage = true) {
        if (!Object.values(SERVICE_MODE).includes(mode)) {
            log.warn(`[ServiceModeManager] Invalid mode: ${mode}`);
            return;
        }
        
        const previousMode = this.currentMode;
        this.currentMode = mode;
        this.config = { ...MODE_CONFIG[mode] };
        
        if (saveToStorage) {
            localStorage.setItem('serviceMode', mode);
        }
        
        log.info(`[ServiceModeManager] Mode changed: ${previousMode} → ${mode}`);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.SERVICE_MODE_CHANGED, {
            previousMode,
            currentMode: mode,
            config: this.config
        });
        
        // UI 업데이트 알림
        if (mode === SERVICE_MODE.EMERGENCY) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: '⚠️ 서비스가 높은 부하 상태입니다. 일부 기능이 제한될 수 있습니다.',
                duration: 5000
            });
        }
    }
    
    /**
     * 현재 모드 가져오기
     */
    getMode() {
        return this.currentMode;
    }
    
    /**
     * 현재 설정 가져오기
     */
    getConfig() {
        return { ...this.config };
    }
    
    /**
     * 특정 기능 활성화 여부 확인
     */
    isFeatureEnabled(feature) {
        return this.config[feature] === true;
    }
    
    /**
     * 모니터링 시작
     */
    startMonitoring() {
        // 10초마다 메트릭 확인
        this.monitoringInterval = setInterval(() => {
            this.updateMetrics();
            this.checkAndAdjustMode();
        }, 10000);
    }
    
    /**
     * 모니터링 중지
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }
    
    /**
     * 메트릭 업데이트
     */
    updateMetrics() {
        // 페이지 로딩 시간 측정
        if (window.performance && window.performance.timing) {
            const timing = window.performance.timing;
            this.metrics.pageLoadTime = timing.loadEventEnd - timing.navigationStart;
        }
        
        // 메트릭 리셋 (1분마다)
        const now = Date.now();
        if (now - this.metrics.lastUpdate > 60000) {
            this.metrics.firestoreReads = 0;
            this.metrics.firestoreWrites = 0;
            this.metrics.firestoreErrors = 0;
            this.metrics.apiErrors = 0;
            this.metrics.lastUpdate = now;
        }
    }
    
    /**
     * 모드 자동 조정
     */
    checkAndAdjustMode() {
        const errorRate = this.calculateErrorRate();
        const loadTime = this.metrics.pageLoadTime;
        
        // Emergency 모드로 전환 조건
        if (errorRate > 0.05 || loadTime > 10000) { // 에러율 5% 이상 또는 로딩 10초 이상
            if (this.currentMode !== SERVICE_MODE.EMERGENCY) {
                log.warn(`[ServiceModeManager] Auto-switching to EMERGENCY mode (errorRate: ${errorRate}, loadTime: ${loadTime}ms)`);
                this.setMode(SERVICE_MODE.EMERGENCY);
            }
        }
        // Busy 모드로 전환 조건
        else if (errorRate > 0.02 || loadTime > 5000) { // 에러율 2% 이상 또는 로딩 5초 이상
            if (this.currentMode === SERVICE_MODE.NORMAL) {
                log.info(`[ServiceModeManager] Auto-switching to BUSY mode (errorRate: ${errorRate}, loadTime: ${loadTime}ms)`);
                this.setMode(SERVICE_MODE.BUSY);
            }
        }
        // Normal 모드로 복귀 조건
        else if (errorRate < 0.01 && loadTime < 3000) {
            if (this.currentMode !== SERVICE_MODE.NORMAL) {
                log.info(`[ServiceModeManager] Auto-switching to NORMAL mode (errorRate: ${errorRate}, loadTime: ${loadTime}ms)`);
                this.setMode(SERVICE_MODE.NORMAL);
            }
        }
    }
    
    /**
     * 에러율 계산
     */
    calculateErrorRate() {
        const total = this.metrics.firestoreReads + this.metrics.firestoreWrites;
        if (total === 0) return 0;
        return (this.metrics.firestoreErrors + this.metrics.apiErrors) / total;
    }
    
    /**
     * 메트릭 기록
     */
    recordMetric(type, value = 1) {
        if (type === 'firestoreRead') {
            this.metrics.firestoreReads += value;
        } else if (type === 'firestoreWrite') {
            this.metrics.firestoreWrites += value;
        } else if (type === 'firestoreError') {
            this.metrics.firestoreErrors += value;
        } else if (type === 'apiError') {
            this.metrics.apiErrors += value;
        }
    }
    
    /**
     * 현재 메트릭 가져오기
     */
    getMetrics() {
        return {
            ...this.metrics,
            errorRate: this.calculateErrorRate(),
            mode: this.currentMode
        };
    }
}

// 싱글톤 인스턴스
export const serviceModeManager = new ServiceModeManager();
export default serviceModeManager;

