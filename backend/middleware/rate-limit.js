/**
 * 간단한 IP 기반 요청 횟수 제한 (메모리, 단일 서버 인스턴스용)
 * 서버를 여러 대로 늘리면 Redis 기반으로 바꿔야 함
 */

const buckets = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
            buckets.delete(key);
        }
    }
}, 60 * 1000).unref();

/**
 * @param {Object} options
 * @param {string} options.name - 버킷 이름 (제한 종류별로 분리)
 * @param {number} options.windowMs - 시간 창 (밀리초)
 * @param {number} options.max - 시간 창 내 최대 요청 수
 * @param {(req) => boolean} [options.skip] - true면 제한하지 않음
 */
export function rateLimit({ name, windowMs, max, skip }) {
    return (req, res, next) => {
        if (req.method === 'OPTIONS' || (skip && skip(req))) {
            return next();
        }
        
        const key = `${name}:${req.ip}`;
        const now = Date.now();
        let bucket = buckets.get(key);
        
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        
        bucket.count++;
        
        if (bucket.count > max) {
            const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                error: 'Too many requests',
                message: `Please wait ${retryAfterSec} seconds and try again.`
            });
        }
        
        next();
    };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 전체 API: IP당 분당 300회
export const apiRateLimit = rateLimit({
    name: 'api',
    windowMs: 60 * 1000,
    max: 300,
    skip: req => req.path === '/health'
});

// 쓰기 요청: IP당 분당 60회
export const writeRateLimit = rateLimit({
    name: 'write',
    windowMs: 60 * 1000,
    max: 60,
    skip: req => !WRITE_METHODS.has(req.method)
});

// 돈이 오가는 요청(구매/입찰/충전/경매 생성): IP당 분당 20회
export const moneyRateLimit = rateLimit({
    name: 'money',
    windowMs: 60 * 1000,
    max: 20,
    skip: req => req.method !== 'POST'
});
