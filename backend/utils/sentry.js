/**
 * Sentry 에러 추적 설정
 */

import * as Sentry from '@sentry/node';

// ProfilingIntegration은 네이티브 바이너리가 필요합니다.
// 로컬 환경에서 모듈이 없을 경우를 대비해 안전하게 로드합니다.
let ProfilingIntegration = null;
try {
    const { ProfilingIntegration: LoadedProfilingIntegration } = await import('@sentry/profiling-node');
    ProfilingIntegration = LoadedProfilingIntegration;
} catch (error) {
    console.warn('[Sentry] Profiling integration not available, skipping profiling:', error.message);
}

let isInitialized = false;

/**
 * Sentry 초기화
 */
export function initSentry() {
    if (isInitialized) {
        return;
    }
    
    const dsn = process.env.SENTRY_DSN;
    const environment = process.env.NODE_ENV || 'development';
    
    if (!dsn) {
        // Sentry는 선택사항이므로 조용하게 스킵 (프로덕션에서는 로그 출력 안 함)
        if (environment !== 'production') {
            console.log('[Sentry] SENTRY_DSN not configured, skipping Sentry initialization (optional)');
        }
        return;
    }
    
    Sentry.init({
        dsn,
        environment,
        integrations: [
            ...(ProfilingIntegration ? [new ProfilingIntegration()] : []),
        ],
        // 성능 모니터링 샘플링 (100% in production, 50% in development)
        tracesSampleRate: environment === 'production' ? 1.0 : 0.5,
        // 프로파일링 샘플링 (ProfilingIntegration이 있을 때만)
        profilesSampleRate: ProfilingIntegration
            ? (environment === 'production' ? 1.0 : 0.5)
            : 0,
        // 에러 필터링
        beforeSend(event, hint) {
            // 민감한 정보 제거
            if (event.request) {
                delete event.request.cookies;
                if (event.request.headers) {
                    delete event.request.headers.authorization;
                }
            }
            
            return event;
        },
    });
    
    isInitialized = true;
    console.log('[Sentry] Initialized successfully');
}

/**
 * Sentry 에러 캡처
 */
export function captureError(error, context = {}) {
    if (!isInitialized) {
        return;
    }
    
    Sentry.captureException(error, {
        tags: context.tags || {},
        extra: context.extra || {},
        user: context.user || {},
    });
}

/**
 * Sentry 메시지 캡처
 */
export function captureMessage(message, level = 'info', context = {}) {
    if (!isInitialized) {
        return;
    }
    
    Sentry.captureMessage(message, {
        level,
        tags: context.tags || {},
        extra: context.extra || {},
    });
}

/**
 * Sentry 트랜잭션 (성능 추적)
 */
export function startTransaction(name, op, context = {}) {
    if (!isInitialized) {
        return null;
    }
    
    return Sentry.startTransaction({
        name,
        op,
        ...context,
    });
}

export { Sentry };

