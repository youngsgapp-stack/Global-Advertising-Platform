/**
 * Firebase 토큰 가져오기 헬퍼 스크립트
 * 
 * 브라우저 콘솔에서 실행할 코드 생성
 */

console.log('📋 Firebase 토큰 가져오기 코드\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('브라우저 콘솔(F12)에서 다음 코드를 실행하세요:\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const code = `
// Firebase 토큰 가져오기 및 클립보드 복사
firebase.auth().currentUser.getIdToken().then(token => {
    console.log('✅ 토큰 가져오기 성공!');
    console.log('사용자:', firebase.auth().currentUser.email);
    console.log('\\n토큰:', token);
    console.log('\\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // 클립보드에 복사
    navigator.clipboard.writeText(token).then(() => {
        console.log('✅ 토큰이 클립보드에 복사되었습니다!');
        console.log('\\n이제 터미널에서 다음 명령어를 실행하세요:');
        console.log('node scripts/load-test.js --token "' + token + '"');
        console.log('또는');
        console.log('node scripts/read-burst-test.js --requests 500 --token "' + token + '"');
    }).catch(err => {
        console.error('❌ 클립보드 복사 실패:', err);
        console.log('\\n위의 토큰을 수동으로 복사하세요.');
    });
}).catch(error => {
    console.error('❌ 토큰 가져오기 실패:', error);
    console.log('\\n로그인이 필요합니다! http://localhost:8000 에서 로그인하세요.');
});
`;

console.log(code);
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('💡 팁: 위 코드를 콘솔에 복사-붙여넣기 하면 바로 실행됩니다!\n');






