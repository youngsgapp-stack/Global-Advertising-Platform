/**
 * 데이터베이스 연결 테스트 스크립트
 * DATABASE_URL 검증 및 연결 테스트
 */

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

console.log('🔍 데이터베이스 연결 테스트\n');

// DATABASE_URL 확인
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    console.error('❌ DATABASE_URL 환경 변수가 설정되지 않았습니다.');
    console.error('   .env 파일에 DATABASE_URL을 설정하세요.');
    process.exit(1);
}

console.log('📊 DATABASE_URL 분석:');
console.log(`   길이: ${dbUrl.length}자`);
console.log(`   시작: ${dbUrl.substring(0, 30)}...`);

// URL 파싱
try {
    const url = new URL(dbUrl);
    console.log(`\n📋 연결 정보:`);
    console.log(`   프로토콜: ${url.protocol}`);
    console.log(`   호스트: ${url.hostname}`);
    console.log(`   포트: ${url.port || '기본값'}`);
    console.log(`   데이터베이스: ${url.pathname.substring(1)}`);
    console.log(`   사용자: ${url.username}`);
    console.log(`   비밀번호: ${url.password ? '***설정됨***' : '❌ 없음'}`);
    
    if (!url.password || url.password === '[YOUR-PASSWORD]' || url.password.length < 3) {
        console.error('\n❌ 비밀번호가 올바르게 설정되지 않았습니다!');
        console.error('   DATABASE_URL에서 비밀번호를 확인하세요.');
        console.error('   형식: postgresql://user:password@host:port/database');
        process.exit(1);
    }
} catch (error) {
    console.error(`\n❌ DATABASE_URL 파싱 실패: ${error.message}`);
    console.error('   올바른 형식: postgresql://user:password@host:port/database');
    process.exit(1);
}

// 연결 테스트
console.log('\n⏳ 데이터베이스 연결 시도 중...');

const client = new Client({
    connectionString: dbUrl
});

client.connect()
    .then(() => {
        console.log('✅ 데이터베이스 연결 성공!');
        
        // 간단한 쿼리 테스트
        return client.query('SELECT NOW() as current_time, version() as pg_version');
    })
    .then(result => {
        console.log(`\n📊 데이터베이스 정보:`);
        console.log(`   현재 시간: ${result.rows[0].current_time}`);
        console.log(`   PostgreSQL 버전: ${result.rows[0].pg_version.split(',')[0]}`);
        
        return client.end();
    })
    .then(() => {
        console.log('\n✅ 연결 테스트 완료!\n');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ 데이터베이스 연결 실패!');
        console.error(`   에러: ${error.message}`);
        console.error(`   코드: ${error.code}`);
        
        if (error.code === '28P01') {
            console.error('\n💡 해결 방법:');
            console.error('   1. DATABASE_URL의 비밀번호가 올바른지 확인하세요');
            console.error('   2. Supabase 대시보드에서 Connection Pooling URL을 확인하세요');
            console.error('   3. 비밀번호에 특수문자가 있으면 URL 인코딩이 필요할 수 있습니다');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('\n💡 해결 방법:');
            console.error('   1. 데이터베이스 서버가 실행 중인지 확인하세요');
            console.error('   2. 호스트와 포트가 올바른지 확인하세요');
        } else if (error.code === 'ENOTFOUND') {
            console.error('\n💡 해결 방법:');
            console.error('   1. 호스트 이름이 올바른지 확인하세요');
            console.error('   2. 인터넷 연결을 확인하세요');
        }
        
        process.exit(1);
    });









