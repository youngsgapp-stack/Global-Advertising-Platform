# 관리자 기능 정리

세계지도 광고판 프로젝트에서 제공하는 관리자 기능과 운영 절차를 한글로 정리한 문서입니다. 로그인 방법부터 대시보드, 지도 내 도구, 모더레이션 흐름, 테스트 체크리스트까지 한 번에 확인할 수 있습니다.

## 개선 체크리스트 (2025-11-26 기준)
- [x] Firebase Functions 기반 관리자 인증 (`authenticateAdmin`) 도입
- [x] Firestore Security Rules에서 관리자 전용 쓰기 권한 강제
- [x] 관리자 대시보드가 Firebase Auth 토큰 만료 시점을 사용해 세션 관리
- [x] 서명 토큰/`localStorage` 기반 다중 탭 세션 공유
- [x] `admin_audit` 컬렉션으로 관리자 감사 로그 축적
- [ ] 관리자/모더레이터/일반 사용자 UI 명확 분리

---

## 1. 접근 및 인증 절차

1. **단축키 진입**  
   - 메인 화면에서 `P` 키를 1초 안에 3번 누르면 관리자 로그인 모달이 열립니다.

2. **자격 증명**
   - 입력한 아이디/비밀번호는 Firebase Functions `authenticateAdmin`으로 전달되어 서버에서만 검증합니다.
   - 조건을 통과하면 Cloud Function이 Custom Token을 발급하고, 클라이언트는 `signInWithCustomToken`으로 Firebase Auth에 로그인합니다.

3. **보안 장치**
   - 빈 입력값 안내, 로그인 시도 알림 제공.
   - `this.loginAttempts` 기반으로 5회 연속 실패 시 15분 잠금.
   - Firebase Auth ID Token의 Custom Claim(`role: 'admin'`)으로 Firestore 권한을 관리합니다.

4. **세션 유지**
   - `admin.html`은 Firebase Auth `onAuthStateChanged`에서 `role === 'admin'`을 확인하고, 아니라면 즉시 메인 맵으로 리다이렉트합니다.
   - 대시보드는 토큰 만료 시간(`tokenResult.expirationTime`)을 세션 카드에 표시합니다.
   - 로그아웃 버튼은 Firebase Auth `signOut`을 실행해 모든 Firestore 권한을 해제합니다.
   - `authenticateAdmin` Cloud Function이 서명된 세션 토큰(`sessionId`, `expiresAt`, `signature`)을 발급하고, 클라이언트는 이를 `localStorage`의 `worldad.adminSession`에 저장합니다.
   - 새 탭/창은 `resumeAdminSession` Cloud Function을 호출해 서명 검증 후 새로운 Custom Token을 받아 자동 로그인하며, `storage` 이벤트로 탭 간 로그인/로그아웃 상태를 동기화합니다.

---

## 2. 관리자 대시보드 (`admin.html`)

| 구역 | 주요 기능 | 참조 데이터 |
| --- | --- | --- |
| 헤더 | 자동 새로고침 상태, 즉시 새로고침, 세션 종료, 라이브 맵 이동 | - |
| 세션 카드 | 만료 예정 시각 표시 | `sessionStorage` |
| 지표 카드 | 총 지역, 점유율, 커뮤니티 상금, 총 결제 금액, 진행 중 옥션 수, 신고 대기 수 | `regions`, `communityPools/global`, `auctions`, `purchases`, `reports` |
| 우선 지역 표 | 상태·단가 기준 상위 12개 지역, CSV 다운로드 버튼 | `regions` |
| 옥션 모니터 | 진행 중 옥션, 종료까지 남은 시간, 현재 입찰가 | `auctions` |
| 결제 기록 | 최근 6건 구매 내역 | `purchases` |
| 신고 목록 | 대기 중인 픽셀 신고 6건, 모더레이션 패널로 이동 버튼 | `reports` |
| 시스템 로그 | `event_logs` 최근 12건, 클립보드 복사 기능 | `event_logs` |

### 추가 기능
- **자동 새로고침**: 60초마다 데이터 갱신, 탭을 다시 활성화할 때도 즉시 동기화.
- **CSV 내보내기**: 현재 로드된 지역 정보를 `world-ad-regions-*.csv`로 저장.
- **로그 복사**: `navigator.clipboard` 사용 (HTTPS나 localhost 환경 필요).
- **오류 안내**: Firebase/Firestore 오류 발생 시 토스트로 메시지 출력.
- **감사 로그 패널**: `admin_audit` 컬렉션에서 최근 12건의 관리자 액션(단일/일괄 지역 저장, 모더레이션 승인·거부, 픽셀 초기화, 전역 동기화 등)을 별도 리스트로 노출하며, 내보내기 버튼은 시스템 로그와 감사 로그를 한 번에 클립보드로 복사합니다.

---

## 3. 메인 지도에서 사용할 수 있는 관리자 도구

관리자 로그인 상태에서만 표시됩니다.

### 3.1 좌측 패널 (`#admin-panel`)
- **로고 관리**: 이미지 업로드, 미리보기, 크기·투명도·회전 조절, 브랜드 색상 프리셋, 제거·초기화.
- **지역 정보 관리**: 한/영 이름, 국가, 행정 레벨, 인구, 면적, 광고 가격과 상태를 수정 후 Firestore 저장.
- **일괄 동기화**: “모든 지역 Firestore 동기화” 버튼으로 가격과 메타데이터를 전체 적용.
- **기업 정보 관리**: 회사명, 산업, 설립년도, 직원 수, 웹사이트, 소개, 특징 입력 및 저장/미리보기.

### 3.2 지도/모달 연동
- **정보 모달 편집 버튼**: 지역/기업 모달에서 “편집”을 누르면 관리자 패널이 자동으로 열립니다.
.- **픽셀 스튜디오**: `openPixelStudio()`를 통해 소유자·관리자만 픽셀 아트를 편집.
- **알림 시스템**: `showNotification()`으로 모든 관리자 작업 결과를 즉시 안내.

---

## 4. 모더레이션 및 커뮤니티 기능

| 기능 | 설명 |
| --- | --- |
| 신고 접수 | `reportPixelArt()`가 `reports` 컬렉션에 신고(사유/내용/신고자)를 저장 |
| 모더레이터 권한 | `moderators` 컬렉션 정보를 캐싱, 관리자 로그인 시 자동으로 권한 부여 |
| 모더레이션 패널 | `#moderation-panel`에서 리스트 확인, 승인 시 `resetPixelArt()` 호출 |
| 커뮤니티 상금 | `subscribeToCommunityPool()` 실시간 구독, 낙찰 금액의 10%가 자동 적립 |
| 무료 픽셀 드랍 | `triggerCommunityAirdrop()`로 조건 충족 시 무료 픽셀 배포 |

---

## 5. 테스트 및 운영 체크리스트

1. `P`키 3번 → 로그인 모달이 뜨는지 확인.
2. 잘못된 로그인 5회 입력 시 잠금 메시지가 출력되는지 확인.
3. 관리자 로그인 성공 후 `admin.html`에서 Firebase Auth 토큰이 만료되면 자동으로 권한이 해제되는지 확인.
4. 수동/자동 새로고침 모두 Firestore 데이터가 최신으로 반영되는지 확인.
5. CSV 내보내기 시 UTF-8 인코딩과 쉼표 구분이 올바른지 확인.
6. HTTPS/localhost 환경에서 로그 복사가 정상 작동하는지 확인.
7. `firestore.rules`에서 관리자 전용 컬렉션(`regions`, `companies`, `events`) 쓰기가 차단되는지 주기적으로 검토.
8. 관리자 로그인 후 새 탭에서 `admin.html` 또는 `index.html`을 열었을 때 별도 로그인 없이 관리자 모드가 유지되는지 확인.
9. 한 탭에서 `세션 종료`를 누르면 다른 탭에서도 `storage` 이벤트를 통해 즉시 로그아웃되는지 확인.
10. Local Storage의 `worldad.adminSession`을 삭제하면 새 탭의 자동 로그인이 차단되는지 확인(만료 처리 시나리오).

---

## 6. 감사 로그 정책

- **저장 위치**: Firestore `admin_audit` 컬렉션 (rules 상 `role: 'admin'` 클레임이 있는 계정만 읽기/쓰기 가능, 수정·삭제 불가).
- **필드 구조**

| 필드 | 설명 |
| --- | --- |
| `action` | `region.update`, `region.bulk_save`, `region.bulk_sync`, `report.approve`, `report.reject`, `pixel.reset` 등 고정된 액션 키 |
| `actor.uid / actor.email` | 작업을 수행한 관리자 Firebase Auth 정보 |
| `context.regionId` | 영향받은 지역 ID (있을 경우) |
| `context.mapMode` | 작업 당시 선택된 지도 모드 |
| `details` | 필드 변경 요약(단일 편집) 또는 결과 통계(일괄 저장/동기화, 모더레이션 메모 등) |
| `createdAt` | 서버 타임스탬프 |

- **가시성**: `admin.html` → Telemetry 패널에서 시스템 로그와 별도의 “감사 로그” 리스트로 최근 12건 노출, `내보내기` 버튼은 두 로그 세트를 동시에 복사.
- **수집 범위**
  - 단일 지역 저장 (`saveRegionInfo` → Firestore `regions` 기록 성공 시 필드 요약 저장)
  - 일괄 저장/동기화 (`saveAllRegionsToFirestore`, `syncAllRegionsToFirestore`) 완료 시 총 처리 개수 기록
  - 신고 승인/거부, 픽셀 초기화 시 영향 지역/모더레이터 메모 기록
- **운영 팁**
  1. Firestore 콘솔에서 `admin_audit`을 필터링해 장기 보관/외부 BI로 내보낼 수 있습니다.
  2. 배포 후 첫 저장/신고 승인 시 Telemetry → 감사 로그에 해당 액션이 생성되는지 확인합니다.
  3. 비관리자 세션으로는 쓰기 권한이 없으므로, 로그 부재 시 관리자 토큰 만료 여부를 우선 확인하세요.

---

## 7. 향후 개선 아이디어

- **서버 기반 인증**: Firebase Custom Claims나 Cloud Functions로 관리자 인증을 서버에서 검증.
- **감사 리포트 자동화**: `admin_audit` 스냅샷을 BigQuery/Spreadsheet로 내보내 월간 감사 보고서를 자동 작성.
- **권한 구분 UI**: 관리자/모더레이터/일반 사용자용 버튼을 명확히 분리.

---

이 문서를 참고해 관리자 기능을 점검하고, 운영 공백 없이 안정적으로 서비스를 유지해주세요.

