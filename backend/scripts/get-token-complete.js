/**
 * 완전한 토큰 가져오기 코드 (브라우저 콘솔용)
 * 로그인 상태 확인 포함
 */

console.log('📋 Firebase 토큰 가져오기 코드 (로그인 상태 확인 포함)\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('브라우저 콘솔(F12)에서 다음 코드를 실행하세요:\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const code = `
// 로그인 상태 확인 및 토큰 가져오기 (완전한 버전)
(async function() {
    console.log('🔍 로그인 상태 확인 중...');
    
    // Firebase Auth 초기화 대기
    await new Promise((resolve) => {
        const unsubscribe = firebase.auth().onAuthStateChanged((user) => {
            unsubscribe();
            resolve(user);
        });
    });
    
    const user = firebase.auth().currentUser;
    
    if (!user) {
        console.error('❌ 로그인이 필요합니다!');
        console.log('\\n📝 다음 중 하나를 실행하세요:');
        console.log('1. 페이지에서 로그인 버튼 클릭');
        console.log('2. 또는 직접 로그인:');
        console.log('   firebase.auth().signInWithEmailAndPassword("your-email@example.com", "password")');
        console.log('\\n로그인 후 이 코드를 다시 실행하세요.');
        return;
    }
    
    console.log('✅ 로그인됨:', user.email);
    console.log('⏳ 토큰 가져오는 중...');
    
    try {
        const token = await user.getIdToken();
        console.log('\\n✅ 토큰 가져오기 성공!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('토큰:', token);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        await navigator.clipboard.writeText(token);
        console.log('\\n✅ 토큰이 클립보드에 복사되었습니다!');
        console.log('\\n📋 이제 터미널에서 다음 명령어를 실행하세요:');
        console.log('\\n  node scripts/load-test.js --token "' + token + '"');
        console.log('\\n  또는');
        console.log('\\n  node scripts/read-burst-test.js --requests 500 --token "' + token + '"');
        console.log('');
    } catch (error) {
        console.error('\\n❌ 토큰 가져오기 실패:', error.message);
        console.log('에러 상세:', error);
    }
})();
`;

console.log(code);
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('💡 사용법:\n');
console.log('1. 위 코드 전체를 복사');
console.log('2. 브라우저 콘솔(F12)에 붙여넣기');
console.log('3. Enter 키 누르기');
console.log('4. 로그인이 안 되어 있다면 먼저 로그인');
console.log('5. 토큰이 클립보드에 복사되면 터미널에서 사용\n');






