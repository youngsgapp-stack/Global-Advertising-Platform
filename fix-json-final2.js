const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'data', 'local-names.json');

console.log('파일 읽는 중...');
const buffer = fs.readFileSync(filePath);

// UTF-8로 디코딩
let content = buffer.toString('utf8');

console.log(`원본 파일 크기: ${content.length} 문자`);

// BOM 제거
if (content.charCodeAt(0) === 0xFEFF) {
  content = content.slice(1);
}

// 파일 끝의 공백/줄바꿈 정리
content = content.trim();

// position 138196에 보이지 않는 문자가 있는지 확인하고 제거
if (content.length >= 138196) {
  console.log(`⚠️ 파일 크기가 ${content.length} 문자입니다. position 138196 이후의 문자를 제거합니다.`);
  
  // position 138195까지만 사용 (에러 위치가 138196이므로)
  content = content.substring(0, 138195 + 1);
  console.log(`파일을 position 138195까지만 사용: ${content.length} 문자`);
  
  // 다시 trim
  content = content.trim();
}

console.log(`최종 파일 크기: ${content.length} 문자`);

// 마지막 5자 확인
console.log('\n최종 파일 끝 5자:');
const last5 = content.slice(-5);
for (let i = 0; i < last5.length; i++) {
  const char = last5[i];
  const code = char.charCodeAt(0);
  const display = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : char;
  console.log(`'${display}' (0x${code.toString(16).padStart(4, '0')}, ${code})`);
}

console.log('\nJSON 파싱 시도 중...');
try {
  const data = JSON.parse(content);
  console.log(`✅ JSON 파싱 성공! ${Object.keys(data).length}개 국가 로드됨`);
  
  // 다시 JSON으로 저장 (깨끗하게, UTF-8, BOM 없이)
  const fixed = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, fixed, { encoding: 'utf8' });
  
  console.log(`✅ 파일 저장 완료! 새 파일 크기: ${fixed.length} 문자`);
  console.log('✅ JSON 파일이 성공적으로 수정되었습니다.');
} catch (error) {
  console.error('❌ JSON 파싱 오류:', error.message);
  
  if (error.message.includes('position')) {
    const match = error.message.match(/position (\d+)/);
    if (match) {
      const pos = parseInt(match[1]);
      console.error(`\n에러 위치: position ${pos}`);
      console.error(`파일 크기: ${content.length} 문자`);
      
      if (pos >= content.length) {
        console.error('⚠️ 에러 위치가 파일 크기보다 큽니다. 파일 끝에 보이지 않는 문자가 있을 수 있습니다.');
        // 파일 끝에서 더 많은 문자 제거
        content = content.substring(0, Math.max(0, pos - 10));
        console.error(`파일을 position ${pos - 10}까지만 사용: ${content.length} 문자`);
        
        // 다시 시도
        try {
          const data = JSON.parse(content);
          console.log(`✅ JSON 파싱 성공! ${Object.keys(data).length}개 국가 로드됨`);
          const fixed = JSON.stringify(data, null, 2);
          fs.writeFileSync(filePath, fixed, { encoding: 'utf8' });
          console.log(`✅ 파일 저장 완료!`);
        } catch (error2) {
          console.error('❌ 여전히 오류 발생:', error2.message);
          process.exit(1);
        }
      }
    }
  } else {
    process.exit(1);
  }
}




