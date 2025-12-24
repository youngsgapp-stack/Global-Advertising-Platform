/**
 * Redis 클라이언트 초기화
 * Upstash Redis SDK 또는 일반 Redis 연결
 * 
 * 핵심 원칙:
 * - Redis는 캐시/가속기일 뿐, 실패해도 서비스는 계속 동작해야 함
 * - Redis 실패 시 throw하지 않고 로그만 남김
 * - API는 Redis 실패와 무관하게 정상 응답
 */

import { createClient } from 'redis';
import { Redis } from '@upstash/redis';

let redisClient = null;

/**
 * Redis 클라이언트 초기화
 * Upstash 사용 시: REDIS_URL과 REDIS_TOKEN 사용 (공식 SDK)
 * 일반 Redis 사용 시: REDIS_URL만 사용
 */
export async function initRedis() {
    if (redisClient) {
        return redisClient;
    }
    
    const redisUrl = process.env.REDIS_URL;
    const redisToken = process.env.REDIS_TOKEN; // Upstash용
    
    if (!redisUrl) {
        console.warn('[Redis] ⚠️ REDIS_URL not set, Redis will be disabled');
        redisClient = {
            _type: 'disabled',
        };
        return redisClient;
    }
    
    // Upstash Redis 사용 여부 확인
    if (redisUrl.startsWith('https://') && redisToken) {
        // Upstash Redis SDK 사용
        console.log('📦 Using Upstash Redis SDK');
        try {
            redisClient = new Redis({
                url: redisUrl,
                token: redisToken,
            });
            console.log('✅ Upstash Redis SDK initialized');
            return redisClient;
        } catch (error) {
            console.error('[Redis] ❌ Failed to initialize Upstash Redis SDK:', error);
            redisClient = {
                _type: 'disabled',
            };
            return redisClient;
        }
    }
    
    // 일반 Redis 클라이언트 (로컬 또는 클라우드 Redis)
    console.log('📦 Using standard Redis client');
    try {
        redisClient = createClient({
            url: redisUrl,
        });
        
        redisClient.on('error', (err) => {
            console.error('[Redis] ❌ Redis Client Error:', err);
        });
        
        redisClient.on('connect', () => {
            console.log('[Redis] 🔗 Redis connecting...');
        });
        
        redisClient.on('ready', () => {
            console.log('[Redis] ✅ Redis connected');
        });
        
        await redisClient.connect();
        return redisClient;
    } catch (error) {
        console.error('[Redis] ❌ Failed to connect to Redis:', error);
        redisClient = {
            _type: 'disabled',
        };
        return redisClient;
    }
}

/**
 * Redis 클라이언트 가져오기
 */
export function getRedis() {
    if (!redisClient) {
        console.warn('[Redis] ⚠️ Redis not initialized, returning disabled client');
        return { _type: 'disabled' };
    }
    return redisClient;
}

/**
 * Redis 헬퍼 함수들
 * 핵심 원칙: Redis 실패 시 throw하지 않고 null/false 반환 또는 로그만 남김
 */
const redisObject = {
    /**
     * Redis에서 값 가져오기
     * 실패 시 null 반환 (에러 throw 안 함)
     */
    get: async (key) => {
        try {
            const client = getRedis();
            
            // Redis가 비활성화된 경우
            if (client._type === 'disabled') {
                return null;
            }
            
            let value;
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                value = await client.get(key);
            } else {
                // 일반 Redis
                value = await client.get(key);
            }
            
            // 값이 없으면 null 반환
            if (value === null || value === undefined) {
                return null;
            }
            
            // 이미 객체면 그대로 반환 (중복 파싱 방지)
            if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
                return value;
            }
            
            // 문자열인 경우에만 JSON.parse 시도
            if (typeof value === 'string') {
                try {
                    return JSON.parse(value);
                } catch (parseError) {
                    console.warn(`[Redis] ⚠️ JSON parse error for key "${key}":`, parseError.message);
                    return null;
                }
            }
            
            // 기타 타입 (숫자, 불린 등)은 그대로 반환
            return value;
        } catch (error) {
            // Redis 실패는 로그만 남기고 null 반환 (API는 계속 동작)
            console.warn(`[Redis] ⚠️ get error for key "${key}" (non-critical):`, error.message);
            return null;
        }
    },
    
    /**
     * Redis에 값 저장하기
     * 핵심: 실패해도 throw하지 않고 로그만 남김 (API는 정상 응답)
     */
    set: async (key, value, ttl = null) => {
        try {
            const client = getRedis();
            
            // Redis가 비활성화된 경우
            if (client._type === 'disabled') {
                return; // 조용히 반환 (에러 아님)
            }
            
            const str = JSON.stringify(value);
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                if (ttl) {
                    await client.setex(key, ttl, str);
                } else {
                    await client.set(key, str);
                }
            } else {
                // 일반 Redis
                if (ttl) {
                    await client.setEx(key, ttl, str);
                } else {
                    await client.set(key, str);
                }
            }
        } catch (error) {
            // Redis 저장 실패는 로그만 남기고 계속 진행 (API는 정상 응답)
            console.warn(`[Redis] ⚠️ set error for key "${key}" (non-critical, API continues):`, error.message);
            // throw하지 않음 - Redis는 캐시일 뿐
        }
    },
    
    /**
     * Redis에서 키 삭제
     * 실패해도 로그만 남김
     */
    del: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return;
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                await client.del(key);
            } else {
                // 일반 Redis
                await client.del(key);
            }
        } catch (error) {
            console.warn(`[Redis] ⚠️ del error for key "${key}" (non-critical):`, error.message);
        }
    },
    
    /**
     * 키 존재 여부 확인
     * 실패 시 false 반환
     */
    exists: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return false;
            }
            
            let result;
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                result = await client.exists(key);
            } else {
                // 일반 Redis
                result = await client.exists(key);
            }
            
            return result > 0;
        } catch (error) {
            console.warn(`[Redis] ⚠️ exists error for key "${key}" (non-critical):`, error.message);
            return false;
        }
    },
    
    /**
     * 패턴으로 키 검색
     * Upstash는 keys를 지원하지 않으므로 빈 배열 반환
     */
    keys: async (pattern) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return [];
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK는 keys를 지원하지 않음
                console.debug(`[Redis] KEYS command not supported in Upstash for pattern: ${pattern}`);
                return [];
            }
            
            // 일반 Redis
            return await client.keys(pattern);
        } catch (error) {
            console.warn(`[Redis] ⚠️ keys error for pattern "${pattern}" (non-critical):`, error.message);
            return [];
        }
    },
    
    /**
     * SCAN 명령어
     * Upstash는 SCAN을 지원하지 않으므로 빈 결과 반환
     */
    scan: async (cursor, options = {}) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return { cursor: '0', keys: [] };
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK는 SCAN을 지원하지 않음
                console.debug('[Redis] SCAN command not supported in Upstash');
                return { cursor: '0', keys: [] };
            }
            
            // 일반 Redis
            return await client.scan(cursor, options);
        } catch (error) {
            console.warn(`[Redis] ⚠️ scan error (non-critical):`, error.message);
            return { cursor: '0', keys: [] };
        }
    },
    
    /**
     * 값 증가
     * 실패 시 0 반환
     */
    incr: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return 0;
            }
            
            let result;
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                result = await client.incr(key);
            } else {
                // 일반 Redis
                result = await client.incr(key);
            }
            
            return parseInt(result) || 0;
        } catch (error) {
            console.warn(`[Redis] ⚠️ incr error for key "${key}" (non-critical):`, error.message);
            return 0;
        }
    },
    
    /**
     * 키 만료 시간 설정
     * 실패해도 로그만 남김
     */
    expire: async (key, seconds) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return;
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                await client.expire(key, seconds);
            } else {
                // 일반 Redis
                await client.expire(key, seconds);
            }
        } catch (error) {
            console.warn(`[Redis] ⚠️ expire error for key "${key}" (non-critical):`, error.message);
        }
    },
    
    /**
     * Set에 멤버 추가 (SADD)
     * Upstash 및 일반 Redis 모두 지원
     */
    sadd: async (key, ...members) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return 0;
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                return await client.sadd(key, ...members);
            } else {
                // 일반 Redis
                return await client.sAdd(key, members);
            }
        } catch (error) {
            console.warn(`[Redis] ⚠️ sadd error for key "${key}" (non-critical):`, error.message);
            return 0;
        }
    },
    
    /**
     * Set의 모든 멤버 조회 (SMEMBERS)
     * Upstash 및 일반 Redis 모두 지원
     */
    smembers: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return [];
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                return await client.smembers(key) || [];
            } else {
                // 일반 Redis
                return await client.sMembers(key) || [];
            }
        } catch (error) {
            console.warn(`[Redis] ⚠️ smembers error for key "${key}" (non-critical):`, error.message);
            return [];
        }
    },
    
    /**
     * Set에서 멤버 제거 (SREM)
     * Upstash 및 일반 Redis 모두 지원
     */
    srem: async (key, ...members) => {
        try {
            const client = getRedis();
            
            if (client._type === 'disabled') {
                return 0;
            }
            
            if (client instanceof Redis) {
                // Upstash Redis SDK
                return await client.srem(key, ...members);
            } else {
                // 일반 Redis
                return await client.sRem(key, members);
            }
        } catch (error) {
            console.warn(`[Redis] ⚠️ srem error for key "${key}" (non-critical):`, error.message);
            return 0;
        }
    },
};

// 명시적으로 export
export { redisObject as redis };
