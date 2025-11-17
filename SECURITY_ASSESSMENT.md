# 🔒 보안 평가 보고서
**프로젝트**: Mr.Young's Billionaire Homepage - Interactive World Map  
**평가 일자**: 2024  
**평가 범위**: 전체 애플리케이션

---

## 📊 보안 평가 요약

### 전체 보안 점수: ⚠️ **35/100** (취약함)

| 카테고리 | 점수 | 상태 |
|---------|------|------|
| 인증 및 권한 관리 | 20/100 | 🔴 심각 |
| 입력 검증 및 XSS 방어 | 15/100 | 🔴 심각 |
| 파일 업로드 보안 | 30/100 | 🟠 취약 |
| 데이터 보호 | 40/100 | 🟠 취약 |
| 통신 보안 | 50/100 | 🟡 보통 |
| 일반 보안 설정 | 40/100 | 🟠 취약 |

---

## 🔴 심각한 보안 취약점 (즉시 수정 필요)

### 1. 하드코딩된 관리자 자격증명 ⚠️ **CRITICAL**

**위치**: `script.js:6469`

```javascript
if (username === 'admin' && password === 'admin123') {
    this.isAdminLoggedIn = true;
    // ...
}
```

**문제점**:
- 관리자 자격증명이 소스 코드에 평문으로 하드코딩됨
- 누구나 브라우저 개발자 도구에서 확인 가능
- 버전 관리 시스템(Git)에 커밋되면 영구 노출
- 브루트포스 공격에 취약

**위험도**: 🔴 **CRITICAL** - 즉시 악용 가능

**권장 조치**:
- ✅ 서버 기반 인증 시스템 구현 필수
- ✅ 비밀번호 해싱 (bcrypt, Argon2)
- ✅ 환경 변수 또는 안전한 설정 파일 사용
- ✅ 세션 토큰/JWT 사용
- ✅ 다단계 인증(MFA) 고려

---

### 2. XSS (Cross-Site Scripting) 취약점 ⚠️ **CRITICAL**

**위치**: 
- `script.js:5989` - 구매 모달 HTML
- `script.js:6102` - 알림 메시지
- `script.js:6210` - 툴팁 내용
- `script.js:5654` - 기업 특징 목록
- `script.js:6992`, `7503` - 로고 이미지

**문제점**:
```javascript
modal.innerHTML = `
    <h4>${region.name_ko}</h4>  // ❌ 사용자 입력이 직접 삽입됨
`;
```

- 사용자 입력값이 `.innerHTML`에 직접 삽입됨
- 악성 스크립트 주입 가능 (`<script>`, `onerror=`, `javascript:` 등)
- 세션 하이재킹, 데이터 탈취 가능

**위험도**: 🔴 **CRITICAL** - 즉시 악용 가능

**권장 조치**:
```javascript
// ✅ 안전한 방법: textContent 사용
const nameEl = document.createElement('h4');
nameEl.textContent = region.name_ko; // HTML 이스케이프 자동

// ✅ 또는 DOMPurify 라이브러리 사용
const safeHTML = DOMPurify.sanitize(userInput);
element.innerHTML = safeHTML;
```

**수정 대상 파일**: `script.js` 전체에서 `innerHTML` 사용 부분

---

### 3. 입력 검증 부재 ⚠️ **HIGH**

**위치**: 
- `script.js:5759-5782` - 기업 정보 저장
- `script.js:6056-6093` - 구매 처리
- `script.js:6607-6653` - 로고 업로드

**문제점**:
```javascript
const companyData = {
    name: document.getElementById('company-name-input').value,  // ❌ 검증 없음
    website: document.getElementById('company-website-input').value,  // ❌ URL 검증 없음
    description: document.getElementById('company-description-input').value,  // ❌ 길이 제한 없음
};
```

- 사용자 입력에 대한 검증이 없음
- SQL Injection은 없지만 (백엔드 없음) XSS 가능
- URL 필드에 `javascript:` 프로토콜 주입 가능
- 파일 크기 제한 없음

**위험도**: 🟠 **HIGH**

**권장 조치**:
```javascript
// ✅ 입력 검증 함수
function validateInput(value, type, maxLength) {
    if (!value || value.trim().length === 0) {
        throw new Error('입력값이 비어있습니다.');
    }
    if (value.length > maxLength) {
        throw new Error(`최대 ${maxLength}자까지 입력 가능합니다.`);
    }
    
    switch(type) {
        case 'url':
            try {
                const url = new URL(value);
                if (!['http:', 'https:'].includes(url.protocol)) {
                    throw new Error('HTTPS/HTTP만 허용됩니다.');
                }
            } catch {
                throw new Error('유효한 URL을 입력해주세요.');
            }
            break;
        case 'text':
            // HTML 태그 제거
            return value.replace(/<[^>]*>/g, '');
    }
    return value.trim();
}
```

---

### 4. 파일 업로드 보안 취약점 ⚠️ **HIGH**

**위치**: `script.js:6607-6653`

**문제점**:
```javascript
if (!file.type.startsWith('image/')) {  // ❌ MIME 타입만 확인
    this.showNotification('이미지 파일만 업로드 가능합니다.', 'error');
    return;
}
```

- 파일 크기 제한 없음 (DoS 공격 가능)
- 파일 내용 검증 없음 (MIME 타입 스푸핑 가능)
- 확장자만 확인하여 악성 파일 업로드 가능
- Base64로 메모리에 저장되어 메모리 부족 가능

**위험도**: 🟠 **HIGH**

**권장 조치**:
```javascript
// ✅ 파일 검증 함수
function validateImageFile(file) {
    // 1. 파일 크기 제한 (10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
        throw new Error('파일 크기는 10MB를 초과할 수 없습니다.');
    }
    
    // 2. 허용된 MIME 타입
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
        throw new Error('JPEG, PNG, GIF, WebP 파일만 허용됩니다.');
    }
    
    // 3. 확장자 검증
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const extension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    if (!allowedExtensions.includes(extension)) {
        throw new Error('허용되지 않은 파일 확장자입니다.');
    }
    
    // 4. 실제 이미지 파일인지 확인 (헤더 검증)
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const arrayBuffer = e.target.result;
            const bytes = new Uint8Array(arrayBuffer);
            
            // JPEG: FF D8 FF
            // PNG: 89 50 4E 47
            // GIF: 47 49 46 38
            const isValid = 
                (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) || // JPEG
                (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) || // PNG
                (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38); // GIF
                
            if (isValid) {
                resolve(true);
            } else {
                reject(new Error('유효한 이미지 파일이 아닙니다.'));
            }
        };
        reader.readAsArrayBuffer(file.slice(0, 10)); // 헤더만 읽기
    });
}
```

---

## 🟠 중요한 보안 취약점 (우선 수정 권장)

### 5. Content Security Policy (CSP) 부재

**문제점**:
- HTML에 CSP 헤더가 없음
- XSS 공격 방어 능력 약함
- 인라인 스크립트 허용
- 외부 리소스 제어 없음

**권장 조치**:
```html
<!-- index.html <head>에 추가 -->
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; 
               script-src 'self' 'unsafe-inline' https://api.mapbox.com; 
               style-src 'self' 'unsafe-inline' https://api.mapbox.com; 
               img-src 'self' data: https:; 
               font-src 'self' data:; 
               connect-src 'self' https://api.mapbox.com https://raw.githubusercontent.com;">
```

---

### 6. 인증 상태 관리 취약점

**문제점**:
```javascript
this.isAdminLoggedIn = true;  // ❌ 메모리에만 저장
```

- 인증 상태가 메모리에만 저장됨
- 페이지 새로고침 시 인증 상태 유실
- 클라이언트 측에서 쉽게 조작 가능

**권장 조치**:
- ✅ 서버 세션 또는 JWT 토큰 사용
- ✅ HTTP-only 쿠키에 토큰 저장
- ✅ 토큰 만료 시간 설정
- ✅ 클라이언트 측 인증 검증 제거

---

### 7. HTTPS 강제 부재

**문제점**:
- HTTPS 사용 강제 없음
- 민감한 데이터가 평문으로 전송될 가능성
- 중간자 공격(MITM) 취약

**권장 조치**:
- ✅ 프로덕션 환경에서 HTTPS 필수
- ✅ HSTS (HTTP Strict Transport Security) 헤더 추가
- ✅ SSL/TLS 인증서 설정

---

### 8. 외부 리소스 신뢰 문제

**위치**: `script.js` 여러 곳

**문제점**:
```javascript
const response = await fetch('https://raw.githubusercontent.com/...');
```

- 외부 CDN/GitHub 리소스를 직접 사용
- 서브리소스 무결성(SRI) 검증 없음
- CDN 해킹 시 악성 코드 주입 가능

**권장 조치**:
```html
<!-- SRI 해시 추가 -->
<script src="https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.js" 
        integrity="sha384-..." 
        crossorigin="anonymous"></script>
```

---

### 9. 데이터 영구 저장 없음

**문제점**:
- 모든 데이터가 메모리에만 저장됨
- 페이지 새로고침 시 데이터 유실
- localStorage/sessionStorage 미사용
- 백엔드 데이터베이스 없음

**권장 조치**:
- ✅ 백엔드 API 및 데이터베이스 구현
- ✅ 데이터 암호화 저장
- ✅ 정기 백업

---

## 🟡 개선 권장 사항

### 10. 로깅 및 모니터링 부재

**권장 조치**:
- ✅ 관리자 로그인 시도 로깅
- ✅ 파일 업로드 이벤트 로깅
- ✅ 오류 추적 시스템 (Sentry 등)
- ✅ 보안 이벤트 모니터링

---

### 11. Rate Limiting 부재

**권장 조치**:
- ✅ 로그인 시도 제한 (예: 5회 실패 후 차단)
- ✅ 파일 업로드 빈도 제한
- ✅ API 호출 제한

---

### 12. 보안 헤더 부재

**권장 조치**:
```javascript
// 서버 설정 (예: Node.js Express)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});
```

---

## 📝 즉시 수정 체크리스트

### 🔴 Critical (즉시 수정)
- [ ] 하드코딩된 자격증명 제거 및 서버 인증 구현
- [ ] 모든 `innerHTML` 사용 부분을 `textContent` 또는 DOMPurify로 변경
- [ ] 사용자 입력 검증 함수 구현
- [ ] 파일 업로드 검증 강화 (크기, 타입, 내용 검증)

### 🟠 High (우선 수정)
- [ ] Content Security Policy 추가
- [ ] 인증 토큰 시스템 구현
- [ ] HTTPS 강제 및 HSTS 설정
- [ ] 외부 리소스 SRI 추가

### 🟡 Medium (점진적 개선)
- [ ] 로깅 및 모니터링 시스템 구축
- [ ] Rate Limiting 구현
- [ ] 보안 헤더 추가
- [ ] 정기 보안 감사 계획

---

## 🛠️ 권장 보안 도구 및 라이브러리

### 프론트엔드
- **DOMPurify**: HTML 정화 라이브러리
- **xss**: XSS 방어 라이브러리
- **validator.js**: 입력 검증

### 백엔드 (향후 구현 시)
- **bcrypt**: 비밀번호 해싱
- **jsonwebtoken**: JWT 토큰 생성
- **helmet**: Express 보안 미들웨어
- **express-rate-limit**: Rate limiting
- **express-validator**: 입력 검증

---

## 📚 참고 자료

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [MDN Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [Web.dev Security](https://web.dev/security/)

---

## 📞 보안 관련 문의

보안 취약점을 발견하신 경우, 신속하게 연락해주시기 바랍니다.

---

**평가 완료일**: 2024  
**다음 평가 예정일**: 보안 수정 완료 후 재평가 권장
