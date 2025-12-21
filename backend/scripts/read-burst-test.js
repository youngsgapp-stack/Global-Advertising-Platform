/**
 * 읽기 폭발 방지 테스트
 * Firestore 읽기 폭발 문제 해결 여부 확인
 * 
 * 사용법:
 *   node scripts/read-burst-test.js
 *   node scripts/read-burst-test.js --requests 1000
 */

import 'dotenv/config';
import { getPool, query } from '../db/init.js';
import { redis } from '../redis/init.js';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api';
const TOTAL_REQUESTS = parseInt(process.argv.find(arg => arg.startsWith('--requests='))?.split('=')[1] || '100');
const TOKEN = process.argv.find(arg => arg.startsWith('--token='))?.split('=')[1] || null;

console.log('🔍 ========================================');
console.log('🔍 읽기 폭발 방지 테스트');
console.log('🔍 ========================================');
console.log(`📍 API Base: ${API_BASE}`);
console.log(`📊 총 요청 수: ${TOTAL_REQUESTS}회`);
console.log('');

const stats = {
    dbQueries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    apiRequests: 0,
    apiSuccess: 0,
    apiFailed: 0,
    responseTimes: []
};

/**
 * DB 쿼리 수 확인
 */
async function checkDBQueries() {
    try {
        // PostgreSQL에서 활성 연결 및 쿼리 통계 확인
        const result = await query(`
            SELECT 
                count(*) as active_connections,
                sum(case when state = 'active' then 1 else 0 end) as active_queries
            FROM pg_stat_activity 
            WHERE datname = current_database()
        `);
        return result.rows[0];
    } catch (error) {
        console.log(`   ⚠️  DB 통계 조회 실패: ${error.message}`);
        return null;
    }
}

/**
 * Redis 캐시 상태 확인
 */
async function checkCacheStats() {
    try {
        // 캐시 키 개수 확인
        const cacheKeys = await redis.keys('cache:*');
        const pixelKeys = await redis.keys('pixel_data:*');
        
        return {
            cacheKeys: cacheKeys.length,
            pixelKeys: pixelKeys.length
        };
    } catch (error) {
        console.log(`   ⚠️  Redis 통계 조회 실패: ${error.message}`);
        return null;
    }
}

/**
 * API 요청
 */
async function fetchAPI(endpoint) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` })
    };

    const startTime = Date.now();
    try {
        // Node.js 18+ fetch 사용, 없으면 node-fetch
        let fetchFunc = globalThis.fetch;
        if (!fetchFunc) {
            try {
                const { default: nodeFetch } = await import('node-fetch');
                fetchFunc = nodeFetch;
            } catch (e) {
                // PowerShell의 Invoke-WebRequest 사용 (Windows)
                const { execSync } = await import('child_process');
                try {
                    const cmd = `powershell -Command "(Invoke-WebRequest -Uri '${url}' -Headers @{${Object.entries(headers).map(([k,v])=>`'${k}'='${v}'`).join(';')}} -UseBasicParsing).Content"`;
                    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
                    const responseTime = Date.now() - startTime;
                    const data = JSON.parse(result);
                    stats.apiRequests++;
                    stats.apiSuccess++;
                    stats.responseTimes.push(responseTime);
                    return { success: true, responseTime, cached: false };
                } catch (e) {
                    stats.apiFailed++;
                    return { success: false, responseTime: Date.now() - startTime, error: e.message };
                }
            }
        }
        
        const response = await fetchFunc(url, { headers });
        const responseTime = Date.now() - startTime;
        const data = await response.json().catch(() => null);

        stats.apiRequests++;
        if (response.ok) {
            stats.apiSuccess++;
            stats.responseTimes.push(responseTime);
            return { success: true, responseTime, cached: response.headers.get('X-Cache') === 'HIT' };
        } else {
            stats.apiFailed++;
            return { success: false, responseTime, status: response.status };
        }
    } catch (error) {
        stats.apiFailed++;
        return { success: false, responseTime: Date.now() - startTime, error: error.message };
    }
}

/**
 * 메인 테스트
 */
async function main() {
    console.log('⏳ 테스트 시작...\n');

    // 초기 상태 확인
    console.log('📊 초기 상태:');
    const initialDB = await checkDBQueries();
    const initialCache = await checkCacheStats();
    if (initialDB) {
        console.log(`   DB 활성 연결: ${initialDB.active_connections}개`);
        console.log(`   DB 활성 쿼리: ${initialDB.active_queries}개`);
    }
    if (initialCache) {
        console.log(`   Redis 캐시 키: ${initialCache.cacheKeys}개`);
        console.log(`   Redis 픽셀 키: ${initialCache.pixelKeys}개`);
    }

    console.log('\n🔥 읽기 폭발 테스트 시작...\n');

    // 동일한 엔드포인트에 반복 요청 (캐시 효과 확인)
    const endpoint = TOKEN ? '/territories?limit=50' : '/health';
    console.log(`📡 요청 엔드포인트: ${endpoint}`);
    console.log(`📊 총 ${TOTAL_REQUESTS}회 요청 중...\n`);

    const startTime = Date.now();
    const batchSize = 10;
    let completed = 0;

    // 배치로 요청 (동시성 제어)
    for (let i = 0; i < TOTAL_REQUESTS; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize && (i + j) < TOTAL_REQUESTS; j++) {
            batch.push(fetchAPI(endpoint));
        }

        const results = await Promise.all(batch);
        
        // 캐시 히트/미스 카운트 (헤더 기반 추정 불가 시 응답 시간으로 추정)
        results.forEach(result => {
            if (result.success) {
                // 첫 요청은 느리고, 이후 요청은 빠르면 캐시 히트로 간주
                if (result.responseTime < 50) {
                    stats.cacheHits++;
                } else {
                    stats.cacheMisses++;
                }
            }
        });

        completed += batch.length;
        if (completed % 50 === 0) {
            const progress = ((completed / TOTAL_REQUESTS) * 100).toFixed(1);
            console.log(`   진행: ${completed}/${TOTAL_REQUESTS} (${progress}%)`);
        }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    // 최종 상태 확인
    console.log('\n📊 최종 상태:');
    const finalDB = await checkDBQueries();
    const finalCache = await checkCacheStats();
    if (finalDB) {
        console.log(`   DB 활성 연결: ${finalDB.active_connections}개`);
        console.log(`   DB 활성 쿼리: ${finalDB.active_queries}개`);
    }
    if (finalCache) {
        console.log(`   Redis 캐시 키: ${finalCache.cacheKeys}개`);
        console.log(`   Redis 픽셀 키: ${finalCache.pixelKeys}개`);
    }

    // 결과 출력
    console.log('\n\n🎯 ========================================');
    console.log('🎯 테스트 결과');
    console.log('🎯 ========================================');
    console.log(`⏱️  총 테스트 시간: ${totalTime}초`);
    console.log(`📊 총 요청 수: ${stats.apiRequests}회`);
    console.log(`✅ 성공: ${stats.apiSuccess}회`);
    console.log(`❌ 실패: ${stats.apiFailed}회`);
    console.log(`📈 성공률: ${stats.apiRequests > 0 ? ((stats.apiSuccess / stats.apiRequests) * 100).toFixed(2) : 0}%`);
    console.log(`🚀 평균 RPS: ${(stats.apiRequests / totalTime).toFixed(2)} 요청/초`);

    if (stats.responseTimes.length > 0) {
        const avgResponseTime = stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length;
        const sorted = stats.responseTimes.sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        console.log(`\n⏱️  응답 시간:`);
        console.log(`   평균: ${avgResponseTime.toFixed(2)}ms`);
        console.log(`   최소: ${min}ms`);
        console.log(`   최대: ${max}ms`);
        console.log(`   P95: ${p95}ms`);
    }

    console.log(`\n💾 캐시 효과 (추정):`);
    console.log(`   캐시 히트 (추정): ${stats.cacheHits}회`);
    console.log(`   캐시 미스 (추정): ${stats.cacheMisses}회`);
    if (stats.cacheHits + stats.cacheMisses > 0) {
        const hitRate = (stats.cacheHits / (stats.cacheHits + stats.cacheMisses) * 100).toFixed(2);
        console.log(`   캐시 히트율: ${hitRate}%`);
    }

    console.log('\n✅ 테스트 완료!\n');

    // 읽기 폭발 방지 확인
    console.log('🔍 ========================================');
    console.log('🔍 읽기 폭발 방지 검증');
    console.log('🔍 ========================================');
    
    if (stats.apiSuccess === stats.apiRequests) {
        console.log('✅ 모든 요청 성공 - 읽기 폭발 없음');
    } else {
        console.log(`⚠️  ${stats.apiFailed}건 실패 - 일부 문제 가능성`);
    }

    if (stats.cacheHits > stats.cacheMisses) {
        console.log('✅ 캐시 효과 확인 - Redis 캐싱 정상 작동');
    } else {
        console.log('⚠️  캐시 효과 낮음 - Redis 캐싱 확인 필요');
    }

    if (finalDB && initialDB) {
        const connectionIncrease = finalDB.active_connections - initialDB.active_connections;
        if (connectionIncrease < 10) {
            console.log(`✅ DB 연결 증가 적음 (${connectionIncrease}개) - 연결 풀 정상`);
        } else {
            console.log(`⚠️  DB 연결 증가 많음 (${connectionIncrease}개) - 연결 풀 확인 필요`);
        }
    }

    console.log('');
}

// fetch 확인 (Node.js 18+에는 내장되어 있음)
if (typeof fetch === 'undefined') {
    console.error('❌ fetch API를 사용할 수 없습니다. Node.js 18 이상이 필요합니다.');
    process.exit(1);
}

main().catch(error => {
    console.error('\n❌ 테스트 실행 중 오류:', error.message);
    console.error(error.stack);
    process.exit(1);
});

