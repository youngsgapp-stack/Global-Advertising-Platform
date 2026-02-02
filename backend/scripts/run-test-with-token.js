/**
 * 토큰을 사용한 테스트 실행 스크립트
 * 
 * 사용법:
 *   node scripts/run-test-with-token.js
 *   또는
 *   TOKEN="your-token" node scripts/run-test-with-token.js
 */

import 'dotenv/config';

// 환경 변수나 명령줄에서 토큰 가져오기
const TOKEN = process.env.TOKEN || process.argv[2] || null;

if (!TOKEN) {
    console.error('❌ 토큰이 필요합니다!');
    console.error('\n사용법:');
    console.error('  node scripts/run-test-with-token.js "YOUR_TOKEN"');
    console.error('  또는');
    console.error('  TOKEN="YOUR_TOKEN" node scripts/run-test-with-token.js');
    console.error('\n토큰 가져오기:');
    console.error('  브라우저 콘솔에서 firebase.auth().currentUser.getIdToken() 실행');
    process.exit(1);
}

console.log('🔐 토큰 확인됨');
console.log(`   길이: ${TOKEN.length}자`);
console.log(`   시작: ${TOKEN.substring(0, 20)}...`);
console.log('');

// 테스트 실행
import { spawn } from 'child_process';

console.log('🚀 종합 부하 테스트 시작 (토큰 사용)...\n');

const testProcess = spawn('node', [
    'scripts/load-test.js',
    `--token=${TOKEN}`,
    '--concurrent=10',
    '--duration=20'
], {
    stdio: 'inherit',
    shell: true
});

testProcess.on('close', (code) => {
    console.log(`\n✅ 테스트 완료 (종료 코드: ${code})`);
    process.exit(code);
});

testProcess.on('error', (error) => {
    console.error('❌ 테스트 실행 오류:', error);
    process.exit(1);
});









