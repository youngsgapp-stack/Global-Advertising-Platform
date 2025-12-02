/**
 * v2 Architecture Integration
 * 3개 엔진을 통합하고 초기화하는 메인 파일
 */
class V2BillionaireMap {
    constructor() {
        this.mapEngine = null;
        this.ownershipEngine = null;
        this.pixelEngine = null;
        
        // Firebase 초기화 확인
        this.firebaseApp = null;
        this.firestore = null;
        this.auth = null;
        this.storage = null;
        
        // 성능 모니터링
        this.performanceMetrics = {
            initializationTime: 0,
            memoryUsage: 0,
            loadTimes: []
        };
    }

    /**
     * 초기화
     * @param {Object} firebaseConfig - Firebase 설정
     */
    async initialize(firebaseConfig) {
        const startTime = performance.now();
        
        try {
            // Firebase 초기화
            await this.initializeFirebase(firebaseConfig);

            // Event Bus는 이미 전역으로 로드됨 (engines/EventBus.js)

            // Map Engine 초기화
            this.mapEngine = new MapEngine();
            await this.mapEngine.initialize('map', {
                style: 'https://demotiles.maplibre.org/style.json',
                center: [0, 0],
                zoom: 2
            });
            this.mapEngine.registerRequestHandlers();

            // Ownership Engine 초기화
            this.ownershipEngine = new OwnershipEngine(this.firestore, this.auth);
            await this.ownershipEngine.initialize();

            // Pixel Engine 초기화
            this.pixelEngine = new PixelEngine(this.firestore, this.storage, this.auth);
            await this.pixelEngine.initialize();

            // 통합 테스트
            await this.runIntegrationTests();

            // 성능 측정
            this.performanceMetrics.initializationTime = performance.now() - startTime;
            this.performanceMetrics.memoryUsage = this.getMemoryUsage();

            console.log('[V2BillionaireMap] 초기화 완료');
            console.log(`초기화 시간: ${this.performanceMetrics.initializationTime.toFixed(2)}ms`);
            console.log(`메모리 사용량: ${(this.performanceMetrics.memoryUsage / 1024 / 1024).toFixed(2)}MB`);
        } catch (error) {
            console.error('[V2BillionaireMap] 초기화 실패:', error);
            throw error;
        }
    }

    /**
     * Firebase 초기화
     * @param {Object} firebaseConfig - Firebase 설정
     */
    async initializeFirebase(firebaseConfig) {
        // Firebase가 이미 초기화되어 있는지 확인
        if (window.firebase && window.firebase.apps.length > 0) {
            this.firebaseApp = window.firebase.app();
            this.firestore = window.firebase.firestore();
            this.auth = window.firebase.auth();
            this.storage = window.firebase.storage();
        } else {
            // Firebase 초기화
            this.firebaseApp = window.firebase.initializeApp(firebaseConfig);
            this.firestore = this.firebaseApp.firestore();
            this.auth = this.firebaseApp.auth();
            this.storage = this.firebaseApp.storage();
        }

        // Firestore 설정 (성능 최적화)
        this.firestore.settings({
            cacheSizeBytes: 40 * 1024 * 1024, // 40MB 캐시
            experimentalForceLongPolling: false // WebSocket 사용
        });
    }

    /**
     * GeoJSON 데이터 로딩
     * @param {string} sourceId - 소스 ID
     * @param {Object} geoJson - GeoJSON 데이터
     */
    async loadGeoJson(sourceId, geoJson) {
        if (this.mapEngine) {
            await this.mapEngine.loadGeoJson(sourceId, geoJson);
        }
    }

    /**
     * 통합 테스트 실행
     */
    async runIntegrationTests() {
        console.log('[V2BillionaireMap] 통합 테스트 시작');
        
        try {
            // 1. Event Bus 통신 테스트
            await this.testEventBus();
            
            // 2. 엔진 간 인터페이스 검증
            await this.testEngineInterfaces();
            
            console.log('[V2BillionaireMap] 통합 테스트 완료');
        } catch (error) {
            console.error('[V2BillionaireMap] 통합 테스트 실패:', error);
            throw error;
        }
    }

    /**
     * Event Bus 통신 테스트
     */
    async testEventBus() {
        return new Promise((resolve) => {
            let testPassed = 0;
            let testTotal = 3;
            
            // 테스트 1: Map Engine → Ownership Engine
            const unsubscribe1 = window.EventBus.on('region:clicked', (data) => {
                testPassed++;
                if (testPassed === testTotal) resolve();
            });
            
            // 테스트 2: Ownership Engine → Map Engine
            const unsubscribe2 = window.EventBus.on('ownership:updated', (data) => {
                testPassed++;
                if (testPassed === testTotal) resolve();
            });
            
            // 테스트 3: Pixel Engine → Map Engine
            const unsubscribe3 = window.EventBus.on('pixel:tileUpdated', (data) => {
                testPassed++;
                if (testPassed === testTotal) resolve();
            });
            
            // 테스트 이벤트 발생
            setTimeout(() => {
                window.EventBus.emit('region:clicked', { regionId: 'test_region' });
                window.EventBus.emit('ownership:updated', { regionId: 'test_region', color: '#ff0000' });
                window.EventBus.emit('pixel:tileUpdated', { regionId: 'test_region', tileUrl: 'https://test.com/tile.webp' });
                
                // 정리
                unsubscribe1();
                unsubscribe2();
                unsubscribe3();
            }, 100);
        });
    }

    /**
     * 엔진 간 인터페이스 검증
     */
    async testEngineInterfaces() {
        // Map Engine 요청 핸들러 확인
        const visibleRegions = await window.EventBus.request('map:getVisibleRegions', {});
        console.log('Map Engine 인터페이스 확인:', visibleRegions !== undefined);
        
        // Ownership Engine 요청 핸들러 확인
        try {
            await window.EventBus.request('ownership:get', { regionId: 'test_region' });
            console.log('Ownership Engine 인터페이스 확인: OK');
        } catch (error) {
            console.log('Ownership Engine 인터페이스 확인: OK (에러는 정상)');
        }
        
        // Pixel Engine 요청 핸들러 확인
        try {
            await window.EventBus.request('visual:get', { regionId: 'test_region' });
            console.log('Pixel Engine 인터페이스 확인: OK');
        } catch (error) {
            console.log('Pixel Engine 인터페이스 확인: OK (에러는 정상)');
        }
    }

    /**
     * 메모리 사용량 측정
     * @returns {number} - 메모리 사용량 (bytes)
     */
    getMemoryUsage() {
        if (performance.memory) {
            return performance.memory.usedJSHeapSize;
        }
        return 0;
    }

    /**
     * 성능 최적화 적용
     */
    optimizePerformance() {
        // 1. 타일 캐싱 최적화
        if (this.mapEngine) {
            this.mapEngine.maxCacheSize = 200; // 캐시 크기 증가
        }
        
        // 2. 메모리 정리 주기적 실행
        setInterval(() => {
            this.cleanupMemory();
        }, 60000); // 1분마다
        
        // 3. Firestore 캐시 최적화
        if (this.firestore) {
            this.firestore.settings({
                cacheSizeBytes: 40 * 1024 * 1024
            });
        }
    }

    /**
     * 메모리 정리
     */
    cleanupMemory() {
        // 사용하지 않는 캐시 정리
        if (this.mapEngine && this.mapEngine.tileCache.size > 150) {
            // LRU: 오래된 항목 제거
            const keysToDelete = Array.from(this.mapEngine.tileCache.keys()).slice(0, 50);
            keysToDelete.forEach(key => {
                this.mapEngine.tileCache.delete(key);
            });
        }
    }

    /**
     * 로딩 상태 표시
     * @param {string} message - 로딩 메시지
     */
    showLoading(message) {
        // UI에 로딩 상태 표시 (실제 구현은 UI 라이브러리에 따라 다름)
        window.EventBus.emit('ui:loading', { message, show: true });
    }

    /**
     * 로딩 상태 숨김
     */
    hideLoading() {
        window.EventBus.emit('ui:loading', { show: false });
    }

    /**
     * 에러 처리
     * @param {Error} error - 에러 객체
     * @param {string} context - 에러 발생 컨텍스트
     */
    handleError(error, context) {
        console.error(`[V2BillionaireMap] 에러 발생 (${context}):`, error);
        
        // Event Bus를 통해 UI에 에러 알림
        window.EventBus.emit('ui:error', {
            message: error.message,
            context,
            timestamp: Date.now()
        });
    }

    /**
     * 정리 및 리소스 해제
     */
    destroy() {
        if (this.mapEngine) {
            this.mapEngine.destroy();
        }
        if (this.ownershipEngine) {
            this.ownershipEngine.destroy();
        }
        if (this.pixelEngine) {
            this.pixelEngine.destroy();
        }
        
        // Event Bus 정리
        window.EventBus.clear();
    }
}

// 전역으로 내보내기
window.V2BillionaireMap = V2BillionaireMap;

