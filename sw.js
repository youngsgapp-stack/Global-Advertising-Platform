/**
 * Service Worker for Own a Piece of Earth PWA
 * 오프라인 지원 및 캐싱 전략
 */

const CACHE_NAME = 'own-piece-v2';
const STATIC_CACHE_VERSION = '1.0.5'; // 버전 업데이트로 Service Worker 강제 갱신 (JavaScript 캐시 완전 우회)
const DYNAMIC_CACHE_VERSION = '1.0.5';

// 캐시할 정적 파일
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/variables.css',
    '/css/layout.css',
    '/css/components.css',
    '/css/panels.css',
    '/css/pixel-editor-v3.css',
    '/css/ranking.css',
    '/css/timeline.css',
    '/css/recommendation.css',
    '/css/onboarding.css',
    '/js/config.js',
    '/js/app.js',
    '/manifest.json'
];

// 네트워크 우선, 캐시 폴백 (API 요청)
const NETWORK_FIRST_PATTERNS = [
    /\/api\//,
    /firebaseio\.com/,
    /googleapis\.com/,
    /mapbox\.com/
];

// 캐시 우선 (정적 리소스) - JavaScript 제외 (네트워크 우선)
const CACHE_FIRST_PATTERNS = [
    /\.css$/,
    /\.png$/,
    /\.jpg$/,
    /\.jpeg$/,
    /\.svg$/,
    /\.woff$/,
    /\.woff2$/
];

// 네트워크 우선 (JavaScript 파일 - 최신 버전 보장)
const NETWORK_FIRST_JS_PATTERNS = [
    /\.js$/
];

/**
 * 설치 이벤트 - 정적 파일 캐싱
 */
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    
    event.waitUntil(
        caches.open(CACHE_NAME + '-' + STATIC_CACHE_VERSION)
            .then((cache) => {
                console.log('[Service Worker] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                return self.skipWaiting(); // 즉시 활성화
            })
            .catch((error) => {
                console.error('[Service Worker] Cache installation failed:', error);
            })
    );
});

/**
 * 활성화 이벤트 - 오래된 캐시 정리
 */
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            return name.startsWith(CACHE_NAME) && 
                                   name !== CACHE_NAME + '-' + STATIC_CACHE_VERSION &&
                                   name !== CACHE_NAME + '-' + DYNAMIC_CACHE_VERSION;
                        })
                        .map((name) => {
                            console.log('[Service Worker] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                return self.clients.claim(); // 모든 클라이언트 제어
            })
    );
});

/**
 * fetch 이벤트 - 네트워크 요청 가로채기
 * 전문가 조언: 외부 origin 요청은 건드리지 말고 브라우저에 맡김
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // ⚠️ 핵심: 외부 origin 요청은 서비스워커가 건드리지 않음
    // Firebase CDN, Mapbox, 기타 외부 CDN은 브라우저가 직접 처리하도록 함
    if (url.origin !== self.location.origin) {
        return; // 서비스워커가 처리하지 않고 브라우저에 맡김 (CORS preflight 방지)
    }
    
    // GET 요청만 처리
    if (request.method !== 'GET') {
        return;
    }
    
    // favicon.ico 같은 선택적 파일은 네트워크 요청만 시도하고 실패해도 무시
    if (url.pathname.endsWith('/favicon.ico') || 
        url.pathname.endsWith('/robots.txt') ||
        url.pathname.includes('/.well-known/')) {
        event.respondWith(handleOptionalFile(request).catch(() => {
            // 완전히 실패해도 빈 응답 반환 (204는 body 없음)
            return new Response(null, { 
                status: 204,
                statusText: 'No Content'
            });
        }));
        return;
    }
    
    // JavaScript 파일은 네트워크만 사용 (캐시 완전 우회 - 최신 버전 보장)
    // ⚠️ 외부 origin은 이미 위에서 필터링되었으므로 여기서는 같은 origin의 JS만 처리
    if (NETWORK_FIRST_JS_PATTERNS.some(pattern => pattern.test(url.pathname))) {
        event.respondWith(
            fetch(request, { 
                cache: 'no-store'
                // ⚠️ Expires 헤더 제거 - CORS preflight 방지
            }).catch(() => {
                // 에러 발생 시 빈 응답 반환 (에러 방지)
                return new Response(null, { 
                    status: 503,
                    statusText: 'Service Unavailable'
                });
            })
        );
        return;
    }
    
    // ⚠️ 외부 도메인은 이미 위에서 필터링되었으므로 이 부분은 실행되지 않음
    // 같은 origin 내의 API 요청만 처리
    if (NETWORK_FIRST_PATTERNS.some(pattern => pattern.test(url.href))) {
        event.respondWith(networkFirst(request).catch(() => {
            // 에러 발생 시 빈 응답 반환 (에러 방지)
            return new Response(null, { 
                status: 503,
                statusText: 'Service Unavailable'
            });
        }));
        return;
    }
    
    // 정적 리소스는 캐시 우선
    if (CACHE_FIRST_PATTERNS.some(pattern => pattern.test(url.pathname))) {
        event.respondWith(cacheFirst(request).catch(() => {
            // 에러 발생 시 빈 응답 반환
            return new Response(null, { 
                status: 503,
                statusText: 'Service Unavailable'
            });
        }));
        return;
    }
    
    // HTML은 네트워크 우선, 실패 시 캐시
    const acceptHeader = request.headers.get('accept');
    if (acceptHeader && acceptHeader.includes('text/html')) {
        event.respondWith(networkFirst(request, true).catch(() => {
            // 에러 발생 시 빈 응답 반환
            return new Response(null, { 
                status: 503,
                statusText: 'Service Unavailable'
            });
        }));
        return;
    }
    
    // 기본: 네트워크 우선 (에러 처리 포함)
    event.respondWith(networkFirst(request).catch(() => {
        // 에러 발생 시 빈 응답 반환
        return new Response(null, { 
            status: 503,
            statusText: 'Service Unavailable'
        });
    }));
});

/**
 * 선택적 파일 처리 (favicon.ico 등) - 실패해도 에러 없이 처리
 */
async function handleOptionalFile(request) {
    try {
        const networkResponse = await fetch(request, {
            // 타임아웃 설정으로 빠른 실패
            signal: AbortSignal.timeout(2000)
        });
        if (networkResponse && networkResponse.ok) {
            return networkResponse;
        }
    } catch (error) {
        // 선택적 파일이므로 에러를 조용히 무시
        // console.debug는 프로덕션에서도 실행되므로 제거
    }
    
    // 파일이 없으면 빈 응답 반환 (404 에러 방지)
    // 204 No Content는 body를 가질 수 없으므로 null 사용
    return new Response(null, {
        status: 204, // No Content
        statusText: 'No Content',
        headers: { 'Content-Type': 'image/x-icon' }
    });
}

/**
 * 네트워크 우선 전략 (API, 동적 콘텐츠)
 */
async function networkFirst(request, isHtml = false) {
    try {
        // 타임아웃 설정으로 무한 대기 방지
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const networkResponse = await fetch(request, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // 성공하면 캐시에 저장 (HTML만)
        if (isHtml && networkResponse.ok) {
            try {
                const cache = await caches.open(CACHE_NAME + '-' + DYNAMIC_CACHE_VERSION);
                cache.put(request, networkResponse.clone());
            } catch (cacheError) {
                // 캐시 저장 실패는 무시
            }
        }
        
        return networkResponse;
    } catch (error) {
        // 네트워크 실패 시 캐시에서 가져오기
        try {
            const cachedResponse = await caches.match(request);
            if (cachedResponse) {
                return cachedResponse;
            }
        } catch (cacheError) {
            // 캐시 조회 실패는 무시
        }
        
        // HTML 요청이 실패하고 캐시도 없으면 오프라인 페이지
        if (isHtml) {
            return new Response(
                '<!DOCTYPE html><html><head><title>Offline</title></head><body><h1>You are offline</h1><p>Please check your internet connection.</p></body></html>',
                {
                    headers: { 'Content-Type': 'text/html' },
                    status: 200
                }
            );
        }
        
        // 에러를 다시 throw하지 않고 빈 응답 반환 (콘솔 에러 방지)
        // 에러는 이미 catch 블록에서 처리되었으므로 throw하지 않음
        return new Response(null, {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

/**
 * 캐시 우선 전략 (정적 리소스)
 */
async function cacheFirst(request) {
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
        return cachedResponse;
    }
    
    try {
        const networkResponse = await fetch(request);
        
        // 캐시에 저장
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME + '-' + STATIC_CACHE_VERSION);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
    } catch (error) {
        console.error('[Service Worker] Fetch failed:', error);
        throw error;
    }
}

/**
 * 백그라운드 동기화 (선택적)
 */
self.addEventListener('sync', (event) => {
    if (event.tag === 'background-sync') {
        event.waitUntil(doBackgroundSync());
    }
});

async function doBackgroundSync() {
    // 백그라운드 동기화 로직
    console.log('[Service Worker] Background sync');
}

