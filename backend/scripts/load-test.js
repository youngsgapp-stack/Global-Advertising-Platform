/**
 * 종합 부하 테스트 스크립트
 * 읽기 폭발 방지 및 대규모 트래픽 대비 테스트
 * 
 * 사용법:
 *   node scripts/load-test.js
 *   node scripts/load-test.js --concurrent 50
 *   node scripts/load-test.js --duration 60
 */

import 'dotenv/config';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api';
const CONCURRENT = parseInt(process.argv.find(arg => arg.startsWith('--concurrent='))?.split('=')[1] || '10');
const DURATION = parseInt(process.argv.find(arg => arg.startsWith('--duration='))?.split('=')[1] || '30');
const TOKEN = process.argv.find(arg => arg.startsWith('--token='))?.split('=')[1] || null;

console.log('🚀 ========================================');
console.log('🚀 종합 부하 테스트 시작');
console.log('🚀 ========================================');
console.log(`📍 API Base: ${API_BASE}`);
console.log(`👥 동시 요청: ${CONCURRENT}개`);
console.log(`⏱️  테스트 시간: ${DURATION}초`);
console.log(`🔐 인증 토큰: ${TOKEN ? '✅ 있음' : '❌ 없음'}`);
console.log('');

const results = {
    total: 0,
    success: 0,
    failed: 0,
    errors: [],
    responseTimes: [],
    startTime: Date.now()
};

/**
 * HTTP 요청 헬퍼
 */
async function fetchAPI(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` }),
        ...options.headers
    };

    const startTime = Date.now();
    try {
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });

        const responseTime = Date.now() - startTime;
        const data = await response.json().catch(() => null);

        return {
            success: response.ok,
            status: response.status,
            responseTime,
            data: data ? (typeof data === 'object' ? JSON.stringify(data).substring(0, 100) : String(data)) : null
        };
    } catch (error) {
        const responseTime = Date.now() - startTime;
        return {
            success: false,
            status: 0,
            responseTime,
            error: error.message
        };
    }
}

/**
 * 테스트 케이스 실행
 */
async function runTest(testName, endpoint, options = {}) {
    console.log(`\n📊 ${testName}`);
    console.log(`   Endpoint: ${endpoint}`);
    
    const testResults = {
        name: testName,
        total: 0,
        success: 0,
        failed: 0,
        responseTimes: [],
        errors: []
    };

    const endTime = Date.now() + (DURATION * 1000);
    const promises = [];

    // 동시 요청 생성
    while (Date.now() < endTime || promises.length > 0) {
        // 새로운 요청 시작
        if (Date.now() < endTime && promises.length < CONCURRENT) {
            const promise = fetchAPI(endpoint, options).then(result => {
                testResults.total++;
                results.total++;
                
                if (result.success) {
                    testResults.success++;
                    results.success++;
                    testResults.responseTimes.push(result.responseTime);
                    results.responseTimes.push(result.responseTime);
                } else {
                    testResults.failed++;
                    results.failed++;
                    testResults.errors.push({
                        status: result.status,
                        error: result.error || 'Unknown error'
                    });
                    results.errors.push({
                        test: testName,
                        status: result.status,
                        error: result.error || 'Unknown error'
                    });
                }
            }).catch(error => {
                testResults.total++;
                results.total++;
                testResults.failed++;
                results.failed++;
                const errorMsg = error.message || 'Unknown error';
                testResults.errors.push({ error: errorMsg });
                results.errors.push({ test: testName, error: errorMsg });
            });

            promises.push(promise);
        }

        // 완료된 요청 제거
        await Promise.race(promises).catch(() => {});
        promises.filter((p, i) => {
            const done = Promise.resolve(p).then(() => true).catch(() => true);
            if (done) promises.splice(i, 1);
        });

        // 짧은 대기 (CPU 부하 감소)
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    // 남은 요청 완료 대기
    await Promise.allSettled(promises);

    // 결과 출력
    const avgResponseTime = testResults.responseTimes.length > 0
        ? (testResults.responseTimes.reduce((a, b) => a + b, 0) / testResults.responseTimes.length).toFixed(2)
        : 0;
    const minResponseTime = testResults.responseTimes.length > 0
        ? Math.min(...testResults.responseTimes)
        : 0;
    const maxResponseTime = testResults.responseTimes.length > 0
        ? Math.max(...testResults.responseTimes)
        : 0;
    const p95ResponseTime = testResults.responseTimes.length > 0
        ? testResults.responseTimes.sort((a, b) => a - b)[Math.floor(testResults.responseTimes.length * 0.95)]
        : 0;

    console.log(`   ✅ 성공: ${testResults.success}회`);
    console.log(`   ❌ 실패: ${testResults.failed}회`);
    console.log(`   ⏱️  평균 응답시간: ${avgResponseTime}ms`);
    console.log(`   📈 최소: ${minResponseTime}ms, 최대: ${maxResponseTime}ms, P95: ${p95ResponseTime}ms`);
    console.log(`   📊 성공률: ${testResults.total > 0 ? ((testResults.success / testResults.total) * 100).toFixed(2) : 0}%`);

    if (testResults.errors.length > 0 && testResults.errors.length <= 5) {
        console.log(`   ⚠️  오류 (최대 5개):`);
        testResults.errors.slice(0, 5).forEach(err => {
            console.log(`      - ${err.status || 'N/A'}: ${err.error || 'Unknown'}`);
        });
    }

    return testResults;
}

/**
 * 메인 테스트 실행
 */
async function main() {
    console.log('⏳ 테스트 시작...\n');

    try {
        // 1. 헬스체크
        await runTest('1. 헬스체크', '/health');

        // 2. 영토 목록 (캐시 테스트) - 인증 필요
        if (TOKEN) {
            await runTest('2. 영토 목록 (50개)', '/territories?limit=50');
            await runTest('3. 영토 목록 (100개)', '/territories?limit=100');
            await runTest('4. 영토 목록 (필터)', '/territories?status=unconquered&limit=50');
        } else {
            console.log('\n⚠️  2-4. 영토 목록: 토큰 필요 (건너뜀)');
            console.log('   토큰 가져오기: 브라우저 콘솔에서 firebase.auth().currentUser.getIdToken() 실행');
        }

        // 3. 픽셀 데이터 (Redis 캐시 테스트)
        if (TOKEN) {
            await runTest('5. 픽셀 영토 목록', '/pixels/territories');
        } else {
            console.log('\n⚠️  5. 픽셀 영토 목록: 토큰 필요 (건너뜀)');
        }

        // 4. 경매 목록
        if (TOKEN) {
            await runTest('6. 활성 경매 목록', '/auctions?status=active');
            await runTest('7. 경매 목록 (모두)', '/auctions');
        } else {
            console.log('\n⚠️  6-7. 경매 목록: 토큰 필요 (건너뜀)');
        }

        // 5. 맵 스냅샷 (캐시 테스트)
        if (TOKEN) {
            await runTest('8. 맵 스냅샷', '/map/snapshot');
        } else {
            console.log('\n⚠️  8. 맵 스냅샷: 토큰 필요 (건너뜀)');
        }

        // 최종 결과
        console.log('\n\n🎯 ========================================');
        console.log('🎯 종합 결과');
        console.log('🎯 ========================================');
        const totalTime = ((Date.now() - results.startTime) / 1000).toFixed(2);
        console.log(`⏱️  총 테스트 시간: ${totalTime}초`);
        console.log(`📊 총 요청 수: ${results.total}회`);
        console.log(`✅ 성공: ${results.success}회`);
        console.log(`❌ 실패: ${results.failed}회`);
        console.log(`📈 성공률: ${results.total > 0 ? ((results.success / results.total) * 100).toFixed(2) : 0}%`);
        console.log(`🚀 평균 RPS: ${(results.total / totalTime).toFixed(2)} 요청/초`);

        if (results.responseTimes.length > 0) {
            const avgResponseTime = results.responseTimes.reduce((a, b) => a + b, 0) / results.responseTimes.length;
            const sorted = results.responseTimes.sort((a, b) => a - b);
            const p95 = sorted[Math.floor(sorted.length * 0.95)];
            const p99 = sorted[Math.floor(sorted.length * 0.99)];

            console.log(`⏱️  평균 응답시간: ${avgResponseTime.toFixed(2)}ms`);
            console.log(`📈 P95 응답시간: ${p95}ms`);
            console.log(`📈 P99 응답시간: ${p99}ms`);
        }

        if (results.errors.length > 0) {
            console.log(`\n⚠️  오류 발생: ${results.errors.length}건`);
            if (results.errors.length <= 10) {
                console.log('   주요 오류:');
                const errorCounts = {};
                results.errors.forEach(err => {
                    const key = `${err.status || 'N/A'}: ${err.error || 'Unknown'}`;
                    errorCounts[key] = (errorCounts[key] || 0) + 1;
                });
                Object.entries(errorCounts).slice(0, 5).forEach(([error, count]) => {
                    console.log(`   - ${error} (${count}회)`);
                });
            }
        }

        console.log('\n✅ 테스트 완료!\n');

    } catch (error) {
        console.error('\n❌ 테스트 실행 중 오류:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// fetch 폴리필 (Node.js 18+)
if (typeof fetch === 'undefined') {
    const { default: fetch } = await import('node-fetch');
    global.fetch = fetch;
}

main();

