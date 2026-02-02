/**
 * 간단한 연결 테스트
 * 백엔드 서버 상태 확인
 */

const API_BASE = 'http://localhost:3000/api';

async function testConnection() {
    console.log('🔍 백엔드 서버 연결 테스트\n');
    console.log(`📍 API Base: ${API_BASE}\n`);

    try {
        console.log('⏳ 헬스체크 요청 중...');
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        
        console.log('✅ 서버 응답 성공!');
        console.log(`   Status: ${response.status}`);
        console.log(`   Data:`, data);
        
        return true;
    } catch (error) {
        console.log('❌ 서버 연결 실패!');
        console.log(`   Error: ${error.message}`);
        console.log('\n⚠️  백엔드 서버가 실행되지 않았습니다.');
        console.log('   다음 명령어로 서버를 실행하세요:');
        console.log('   cd backend');
        console.log('   npm run dev\n');
        return false;
    }
}

testConnection().then(connected => {
    if (!connected) {
        process.exit(1);
    }
});









