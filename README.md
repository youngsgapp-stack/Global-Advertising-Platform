# Mr.Young's Billionaire Homepage 🌍

전 세계 행정구역을 광고 단위로 활용하는 인터랙티브 지도 플랫폼

## 🎯 프로젝트 개요

이 프로젝트는 "The Million Dollar Homepage"의 개념을 전 세계 행정구역으로 확장한 인터랙티브 광고 플랫폼입니다. 사용자는 마치 구글어스처럼 전 세계를 탐색하며, 각 행정구역을 클릭하여 광고를 구매할 수 있습니다.

## ✨ 주요 기능

### 🗺️ 인터랙티브 월드맵
- **줌/팬/드래그**: 구글어스와 같은 직관적인 지도 탐색
- **다단계 줌**: 전 세계 → 대륙 → 국가 → 주/성/도 → 시/군/구
- **정밀한 클릭 감지**: 경계 근처 클릭 시에도 정확한 지역 선택

### 🌏 전 세계 행정구역 지원
- **대한민국**: 시 단위 (서울특별시, 부산광역시 등)
- **미국**: 주 단위 (캘리포니아주, 뉴욕주 등)
- **중국**: 성 단위 (광둥성, 상하이시 등)
- **일본**: 현 단위 (도쿄도, 오사카부 등)
- **기타 국가**: 각국의 행정 체계에 맞는 구분

### 🎨 시각적 구분
- **색상 코딩**: 사용 가능/광고 중/선택됨 상태별 색상 구분
- **경계선 표시**: 각 행정구역의 명확한 경계 시각화
- **호버 효과**: 마우스 오버 시 지역 정보 미리보기

### 💰 광고 시스템
- **지역별 차등 가격**: 인구, 면적, 경제 규모에 따른 가격 책정
- **실시간 상태 관리**: 광고 구매/해제 상태 실시간 반영
- **상세 정보 표시**: 인구, 면적, GDP, 가격 등 상세 정보

## 🛠️ 기술 스택

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **지도 라이브러리**: MapLibre GL JS (오픈소스)
- **데이터 형식**: GeoJSON
- **스타일링**: CSS Grid, Flexbox, CSS Variables
- **반응형 디자인**: Mobile-first 접근

## 📁 프로젝트 구조

```
Mr.Young 억만장자 홈페이지/
├── index.html              # 메인 HTML 파일
├── styles.css              # CSS 스타일시트
├── script.js               # JavaScript 메인 로직
├── data/
│   └── world-regions.geojson # 전 세계 행정구역 데이터
└── README.md               # 프로젝트 문서
```

## 🚀 시작하기

### 1. 프로젝트 클론
```bash
git clone [repository-url]
cd "Mr.Young 억만장자 홈페이지"
```

### 2. 웹 서버 실행
로컬 웹 서버를 실행하여 CORS 문제를 방지합니다:

```bash
# Python 3 사용
python -m http.server 8000

# Node.js 사용
npx http-server

# VS Code Live Server 확장 사용
```

### 3. 브라우저에서 접속
```
http://localhost:8000
```

## 🌐 Netlify 배포 및 도메인 설정

### Netlify 배포
1. Netlify 대시보드에서 새 사이트 생성
2. 프로젝트 폴더를 드래그 앤 드롭하거나 Git 저장소 연결
3. 빌드 설정 없음 (정적 사이트)

### 가비아 도메인을 Netlify에 연결하기

가비아에서 도메인을 구매한 경우, DNS 설정을 통해 Netlify와 연결해야 합니다.

#### 방법 1: Netlify DNS 사용 (권장)

1. **Netlify에서 도메인 추가**
   - Netlify 대시보드 → Site settings → Domain management
   - "Add domain alias" 클릭
   - `worldadvertisingmap.com` 입력

2. **Netlify DNS 서버 정보 확인**
   - Domain management에서 도메인 선택
   - Netlify가 제공하는 DNS 서버 주소 확인 (예: `dns1.p01.nsone.net`, `dns2.p01.nsone.net`)

3. **가비아에서 DNS 서버 변경**
   - 가비아 로그인 → 마이페이지 → 도메인 관리
   - `worldadvertisingmap.com` 선택 → DNS 관리
   - **네임서버 변경** 메뉴 선택
   - Netlify에서 제공한 DNS 서버 주소 입력
   - 저장 후 24-48시간 대기 (일반적으로 몇 시간 내 완료)

#### 방법 2: 가비아 DNS에서 레코드 직접 설정

1. **Netlify에서 도메인 추가**
   - Netlify 대시보드 → Site settings → Domain management
   - "Add domain alias" 클릭
   - `worldadvertisingmap.com` 입력

2. **Netlify IP 주소 확인**
   - Domain management에서 도메인 선택
   - "Verify DNS configuration" 또는 "Check DNS" 클릭
   - Netlify가 제공하는 IP 주소 확인 (일반적으로 여러 개의 IP 주소)

3. **가비아에서 DNS 레코드 설정**
   - 가비아 로그인 → 마이페이지 → 도메인 관리
   - `worldadvertisingmap.com` 선택 → DNS 관리
   - 다음 레코드 추가:

   **A 레코드 (루트 도메인용):**
   ```
   호스트: @ (또는 비워두기)
   타입: A
   값: Netlify에서 제공한 IP 주소 (여러 개면 모두 추가)
   TTL: 3600 (또는 기본값)
   ```

   **CNAME 레코드 (www 서브도메인용):**
   ```
   호스트: www
   타입: CNAME
   값: worldadvertisingmap.com (또는 Netlify가 제공한 값)
   TTL: 3600 (또는 기본값)
   ```

4. **DNS 전파 대기**
   - DNS 변경 사항이 전 세계에 전파되기까지 24-48시간 소요
   - 온라인 DNS 체크 도구로 확인 가능:
     - https://dnschecker.org
     - https://www.whatsmydns.net

### SSL/TLS 인증서 설정

1. **Let's Encrypt 인증서 자동 발급**
   - DNS 설정이 완료되면 Netlify가 자동으로 Let's Encrypt 인증서 발급
   - 보통 몇 분에서 몇 시간 소요

2. **인증서 발급 실패 시 확인 사항**
   - DNS 설정이 올바르게 전파되었는지 확인
   - 도메인이 Netlify를 가리키고 있는지 확인:
     ```bash
     # 터미널에서 확인
     nslookup worldadvertisingmap.com
     dig worldadvertisingmap.com
     ```
   - Netlify 대시보드에서 "Renew certificate" 버튼 클릭

3. **문제 해결**

   **"worldadvertisingmap.com doesn't appear to be served by Netlify" 오류 발생 시:**
   
   **단계 1: 네임서버 확인**
   ```powershell
   # PowerShell에서 실행
   nslookup -type=NS worldadvertisingmap.com
   ```
   - 결과에 `dns1.p07.nsone.net`, `dns2.p07.nsone.net` 등이 보이면 네임서버는 올바르게 설정됨
   - 보이지 않으면 가비아에서 네임서버 변경이 완료되었는지 확인
   
   **단계 2: DNS 전파 상태 확인**
   - 온라인 도구 사용:
     - https://dnschecker.org → `worldadvertisingmap.com` 입력
     - 전 세계 여러 위치에서 DNS 전파 상태 확인
     - 모든 위치에서 Netlify IP로 조회되면 전파 완료
   
   **단계 3: 대기 및 재시도**
   - DNS 전파는 보통 몇 시간~24시간 소요
   - 네임서버가 올바르게 설정되어 있다면 시간이 지나면 자동으로 해결됨
   - 24시간 후에도 문제가 지속되면:
     - Netlify 대시보드 → Domain management → "Renew certificate" 클릭
     - 또는 Netlify 지원팀에 문의
   
   **단계 4: DNS 캐시 클리어**
   ```powershell
   # Windows에서 DNS 캐시 클리어
   ipconfig /flushdns
   ```

### 확인 방법

1. **DNS 전파 확인**
   ```bash
   # 터미널에서 실행
   nslookup worldadvertisingmap.com
   # 또는
   dig worldadvertisingmap.com
   ```

2. **웹사이트 접속 확인**
   - `http://worldadvertisingmap.com` 접속
   - `https://worldadvertisingmap.com` 접속 (SSL 인증서 발급 후)
   
   **접속이 안 될 때 해결 방법:**
   - **브라우저 캐시 클리어:**
     - Chrome/Edge: `Ctrl + Shift + Delete` → 캐시된 이미지 및 파일 삭제
     - 또는 시크릿 모드로 접속: `Ctrl + Shift + N`
   - **DNS 캐시 클리어:**
     ```powershell
     ipconfig /flushdns
     ```
   - **다른 브라우저로 시도** (Chrome, Firefox, Edge 등)
   - **다른 네트워크로 시도** (모바일 데이터 등)

3. **Netlify 대시보드 확인**
   - Domain management에서 도메인 상태 확인
   - HTTPS 섹션에서 인증서 상태 확인
   - Site overview에서 배포 상태 확인

## 🔥 Firebase 설정 (Google 로그인)

### Firebase Console 설정

1. **Firebase 프로젝트 접속**
   - https://console.firebase.google.com/ 접속
   - 프로젝트 선택: `worldad-8be07`

2. **Google 로그인 활성화**
   - Authentication → Sign-in method
   - Google 제공업체 클릭
   - "사용 설정" 토글 활성화
   - 프로젝트 지원 이메일 선택
   - 저장

3. **승인된 도메인 추가**
   - Authentication → Settings → Authorized domains
   - "도메인 추가" 클릭
   - 다음 도메인 추가:
     - `worldadvertisingmap.com`
     - `www.worldadvertisingmap.com`
     - `zesty-sherbet-9a9e5e.netlify.app` (Netlify 기본 도메인)
   - 저장

### 콘솔 오류 해결

**Firebase 오류 (`auth/configuration-not-found`):**
- Firebase Console에서 Google 로그인 활성화 확인
- 승인된 도메인 목록에 현재 도메인 추가 확인

**Mapbox 경고 (anchor, color, intensity, position):**
- Mapbox 라이브러리 내부 경고로 기능에는 영향 없음
- 무시해도 됨

**WebGL 경고:**
- 브라우저 하드웨어 가속 관련 경고
- 기능에는 영향 없음

## 🎮 사용법

### 기본 조작
- **마우스 휠**: 줌 인/아웃
- **드래그**: 지도 이동
- **지역 클릭**: 지역 선택 및 정보 확인
- **마우스 호버**: 지역 정보 미리보기

### 키보드 단축키
- **1, 2, 3**: 줌 레벨 빠른 변경 (전 세계/국가별/지역별)
- **Enter**: 선택된 지역 구매
- **ESC**: 패널/모달 닫기
- **H**: 도움말 표시

### 컨트롤 패널
- **줌 레벨 버튼**: 전 세계/국가별/지역별 빠른 이동
- **범례**: 색상별 상태 확인
- **실시간 통계**: 총 지역 수, 광고 중인 지역, 총 수익, 점유율

### 광고 구매
1. 원하는 지역 클릭
2. 우측 정보 패널에서 상세 정보 확인
3. "이 지역 구매하기" 버튼 클릭 또는 Enter 키
4. 구매 모달에서 광고 정보 입력
5. 구매 확인 후 완료

## 📊 데이터 구조

### GeoJSON Feature Properties
```json
{
  "id": "unique_region_id",
  "name_ko": "한국어 지역명",
  "name_en": "영어 지역명",
  "name_local": "현지어 지역명",
  "country": "국가명",
  "country_code": "국가 코드",
  "admin_level": "행정구역 레벨",
  "population": "인구수",
  "area": "면적 (km²)",
  "gdp_per_capita": "1인당 GDP",
  "occupied": "광고 중 여부",
  "price": "광고 가격 (USD)",
  "currency": "통화",
  "timezone": "시간대",
  "coordinates": [경도, 위도]
}
```

## 🎨 색상 시스템

- **🟢 사용 가능**: `#4ecdc4` (청록색)
- **🔴 광고 중**: `#ff6b6b` (빨간색)
- **🟡 선택됨**: `#feca57` (노란색)
- **⚪ 경계선**: `#ffffff` (흰색)

## 🔮 향후 계획

### Phase 1: 기본 기능 완성 ✅
- [x] 인터랙티브 지도 구현
- [x] 행정구역 데이터 로드
- [x] 클릭 감지 및 하이라이트
- [x] 정보 패널 표시
- [x] 구매 모달 시스템
- [x] 실시간 통계 대시보드
- [x] 키보드 단축키 지원
- [x] 도움말 시스템
- [x] 알림 시스템

### Phase 2: 고급 기능
- [ ] 3D 구면 지구본 모드
- [ ] 더 많은 국가/지역 데이터 추가
- [ ] 실시간 광고 상태 동기화
- [ ] 결제 시스템 연동

### Phase 3: 플랫폼 확장
- [ ] 사용자 계정 시스템
- [ ] 광고 관리 대시보드
- [ ] 통계 및 분석 기능
- [ ] API 개발

## 🤝 기여하기

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. 자세한 내용은 `LICENSE` 파일을 참조하세요.

## 📞 연락처

- **프로젝트**: Mr.Young's Billionaire Homepage
- **개발자**: Mr.Young
- **이메일**: contact@mryoung.com

---

**"전 세계를 하나의 광고 캔버스로 만들어보세요!"** 🌍✨
