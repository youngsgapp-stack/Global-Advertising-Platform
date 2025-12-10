/**
 * Redis 클라이언트 초기화
 * Upstash Redis REST API 또는 일반 Redis 연결
 */

import { createClient } from 'redis';

let redisClient = null;

/**
 * Redis 클라이언트 초기화
 * Upstash 사용 시: REDIS_URL과 REDIS_TOKEN 사용
 * 일반 Redis 사용 시: REDIS_URL만 사용
 */
export async function initRedis() {
    if (redisClient) {
        return redisClient;
    }
    
    const redisUrl = process.env.REDIS_URL;
    const redisToken = process.env.REDIS_TOKEN; // Upstash용
    
    if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is required');
    }
    
    // Upstash REST API 사용 여부 확인
    if (redisUrl.startsWith('https://') && redisToken) {
        // Upstash REST API 사용
        console.log('📦 Using Upstash Redis REST API');
        redisClient = {
            // REST API 방식이므로 실제 클라이언트 대신 REST 호출 사용
            // redis 헬퍼 함수에서 직접 처리
            _type: 'upstash',
            _url: redisUrl,
            _token: redisToken,
        };
        console.log('✅ Upstash Redis configured');
        return redisClient;
    }
    
    // 일반 Redis 클라이언트 (로컬 또는 클라우드 Redis)
    console.log('📦 Using standard Redis client');
    redisClient = createClient({
        url: redisUrl,
    });
    
    redisClient.on('error', (err) => {
        console.error('❌ Redis Client Error:', err);
    });
    
    redisClient.on('connect', () => {
        console.log('🔗 Redis connecting...');
    });
    
    redisClient.on('ready', () => {
        console.log('✅ Redis connected');
    });
    
    await redisClient.connect();
    
    return redisClient;
}

/**
 * Redis 클라이언트 가져오기
 */
export function getRedis() {
    if (!redisClient) {
        throw new Error('Redis not initialized. Call initRedis() first.');
    }
    return redisClient;
}

/**
 * Upstash REST API 호출
 */
async function upstashRequest(command, ...args) {
    const client = getRedis();
    if (client._type !== 'upstash') {
        throw new Error('Upstash request called but client is not Upstash type');
    }
    
    const response = await fetch(`${client._url}/${command}/${args.join('/')}`, {
        headers: {
            'Authorization': `Bearer ${client._token}`,
        },
    });
    
    if (!response.ok) {
        throw new Error(`Upstash API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.result;
}

/**
 * Redis 헬퍼 함수들
 * 지연 초기화 방식으로 변경하여 import 시점에 에러 발생 방지
 */
export const redis = {
    get: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'upstash') {
                // Upstash REST API
                const value = await upstashRequest('get', key);
                return value ? JSON.parse(value) : null;
            }
            
            // 일반 Redis
            const value = await client.get(key);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            console.error('[Redis] get error:', error);
            return null;
        }
    },
    
    set: async (key, value, ttl = null) => {
        try {
            const client = getRedis();
            const str = JSON.stringify(value);
            
            if (client._type === 'upstash') {
                // Upstash REST API
                if (ttl) {
                    await upstashRequest('setex', key, ttl, str);
                } else {
                    await upstashRequest('set', key, str);
                }
                return;
            }
            
            // 일반 Redis
            if (ttl) {
                await client.setEx(key, ttl, str);
            } else {
                await client.set(key, str);
            }
        } catch (error) {
            console.error('[Redis] set error:', error);
        }
    },
    
    del: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'upstash') {
                await upstashRequest('del', key);
                return;
            }
            
            await client.del(key);
        } catch (error) {
            console.error('[Redis] del error:', error);
        }
    },
    
    exists: async (key) => {
        try {
            const client = getRedis();
            
            if (client._type === 'upstash') {
                const result = await upstashRequest('exists', key);
                return result > 0;
            }
            
            return await client.exists(key);
        } catch (error) {
            console.error('[Redis] exists error:', error);
            return false;
        }
    },
};


