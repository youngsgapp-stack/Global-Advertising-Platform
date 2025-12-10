/**
 * Performance Configuration
 * CPU 및 메모리 사용량 최적화 설정
 */

export const PERFORMANCE_CONFIG = {
    // Interval 최적화
    INTERVALS: {
        // 최소 interval 간격 (ms)
        MIN_INTERVAL: 100,
        
        // 최대 동시 interval 개수
        MAX_INTERVALS: 10,
        
        // Interval 정리 주기 (ms)
        CLEANUP_INTERVAL: 30000, // 30초
    },
    
    // 렌더링 최적화
    RENDERING: {
        // 목표 FPS
        TARGET_FPS: 60,
        
        // 프레임 스로틀링 (ms)
        FRAME_THROTTLE: 16, // 60fps
        
        // 렌더링 배치 크기
        BATCH_SIZE: 10,
        
        // 렌더링 지연 (ms)
        RENDER_DELAY: 0,
    },
    
    // 이벤트 최적화
    EVENTS: {
        // 이벤트 스로틀링 (ms)
        THROTTLE_DELAY: 100,
        
        // 이벤트 디바운싱 (ms)
        DEBOUNCE_DELAY: 300,
        
        // 최대 이벤트 큐 크기
        MAX_QUEUE_SIZE: 100,
    },
    
    // 메모리 최적화
    MEMORY: {
        // 메모리 체크 주기 (ms)
        CHECK_INTERVAL: 300000, // 5분
        
        // 메모리 경고 임계값 (%)
        WARNING_THRESHOLD: 80,
        
        // 메모리 위험 임계값 (%)
        CRITICAL_THRESHOLD: 90,
        
        // 캐시 크기 제한
        MAX_CACHE_SIZE: 100, // MB
    },
    
    // CPU 최적화
    CPU: {
        // CPU 경고 임계값 (%)
        WARNING_THRESHOLD: 50,
        
        // CPU 위험 임계값 (%)
        CRITICAL_THRESHOLD: 70,
        
        // 모니터링 주기 (ms)
        MONITOR_INTERVAL: 1000,
    },
    
    // 맵 최적화
    MAP: {
        // 영토 레이어 업데이트 스로틀링 (ms)
        LAYER_UPDATE_THROTTLE: 100,
        
        // 동시 업데이트 최대 개수
        MAX_CONCURRENT_UPDATES: 5,
        
        // 픽셀 렌더링 배치 크기
        PIXEL_BATCH_SIZE: 20,
        
        // 맵 줌 레벨별 최적화
        ZOOM_OPTIMIZATION: {
            // 낮은 줌 레벨에서 레이어 숨김
            HIDE_LAYERS_BELOW_ZOOM: 3,
            
            // 높은 줌 레벨에서만 상세 렌더링
            DETAIL_RENDERING_ABOVE_ZOOM: 8,
        },
    },
    
    // 비활성 탭 최적화
    INACTIVE_TAB: {
        // 비활성화 시 작업 일시 중지
        PAUSE_ON_HIDDEN: true,
        
        // 일시 중지할 작업 타입
        PAUSABLE_OPERATIONS: [
            'non-essential-intervals',
            'background-rendering',
            'analytics-tracking'
        ],
    },
    
    // 디버그 모드
    DEBUG: {
        // 성능 로그 출력
        ENABLE_LOGS: false,
        
        // 성능 통계 표시
        SHOW_STATS: false,
        
        // CPU 사용률 표시
        SHOW_CPU_USAGE: false,
    },
};

