const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'data', 'local-names.json');

console.log('파일 읽는 중...');
const buffer = fs.readFileSync(filePath);

console.log(`원본 파일 크기: ${buffer.length} 바이트`);

// UTF-8로 디코딩
let content = buffer.toString('utf8');

console.log(`디코딩 후 크기: ${content.length} 문자`);

// BOM 제거
if (content.charCodeAt(0) === 0xFEFF) {
  console.log('BOM 제거 중...');
  content = content.slice(1);
}

// 파일 끝의 공백/줄바꿈 정리
content = content.trim();

// 파일 끝에 보이지 않는 문자 제거
// position 138196에 보이지 않는 문자가 있을 수 있으므로, 파일 끝에서부터 정상적인 JSON 문자만 유지
let lastValidPos = content.length - 1;
while (lastValidPos >= 0) {
  const char = content[lastValidPos];
  const code = char.charCodeAt(0);
  
  // 정상적인 JSON 문자인지 확인
  if (char === '}' || char === ']' || char === '"' || char === '\n' || char === ' ' || char === '\t' ||
      (code >= 0x20 && code <= 0x7E) || // ASCII 인쇄 가능 문자
      (code >= 0x80 && code <= 0xFFFF)) { // 유니코드 문자
    if (code !== 0xFEFF && code !== 0x0000 && code !== 0x000B && code !== 0x000C) {
      // 정상적인 문자
      break;
    }
  }
  
  lastValidPos--;
}

if (lastValidPos < content.length - 1) {
  console.log(`파일 끝에서 ${content.length - 1 - lastValidPos}개 문자 제거`);
  content = content.substring(0, lastValidPos + 1);
}

// 다시 trim (안전을 위해)
content = content.trim();

console.log(`최종 파일 크기: ${content.length} 문자`);

// 마지막 10자 확인
console.log('\n최종 파일 끝 10자:');
const last10 = content.slice(-10);
for (let i = 0; i < last10.length; i++) {
  const char = last10[i];
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
  process.exit(1);
}



