# WorldAd Backend API Server

Postgres + Redis + WebSocket 기반 백엔드 서버

## 🚀 시작하기

### 1. 환경 변수 설정

```bash
cp .env.example .env
# .env 파일을 편집하여 실제 값 입력
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 데이터베이스 마이그레이션

```bash
# Supabase/Postgres에 연결한 후
psql $DATABASE_URL -f db/schema.sql
```

또는 Supabase Dashboard에서 SQL Editor를 열고 `db/schema.sql` 내용 실행

### 4. 서버 실행

```bash
# 개발 모드 (자동 재시작)
npm run dev

# 프로덕션 모드
npm start
```

## 📁 프로젝트 구조

```
backend/
├── server.js              # 메인 서버 파일
├── middleware/
│   └── auth.js           # Firebase 인증 미들웨어
├── routes/
│   ├── auth.js           # 인증 라우터
│   ├── map.js            # 맵 API
│   ├── territories.js    # 영토 API
│   ├── auctions.js       # 경매 API
│   └── users.js          # 사용자 API
├── db/
│   ├── init.js           # DB 초기화
│   └── schema.sql        # 데이터베이스 스키마
├── redis/
│   └── init.js           # Redis 초기화
├── websocket/
│   └── index.js          # WebSocket 서버
└── .env.example          # 환경 변수 예제
```

## 🔌 API 엔드포인트

### 인증
- `GET /api/health` - 헬스체크 (인증 불필요)
- `GET /api/auth/verify` - 토큰 검증 정보

### 맵
- `GET /api/map/snapshot` - 맵 스냅샷 조회

### 영토
- `GET /api/territories/:id` - 영토 상세 조회
- `GET /api/territories/:id/auctions/active` - 활성 경매 조회

### 경매
- `GET /api/auctions/:id` - 경매 상세 조회
- `POST /api/auctions/:id/bids` - 입찰 생성

### 사용자
- `GET /api/users/me` - 현재 사용자 정보
- `GET /api/users/me/wallet` - 지갑 조회

## 🔐 인증

모든 API (health 제외)는 Firebase ID 토큰이 필요합니다.

```javascript
// 프론트엔드에서
const token = await firebase.auth().currentUser.getIdToken();
fetch('https://api.example.com/api/territories/123', {
    headers: {
        'Authorization': `Bearer ${token}`
    }
});
```

## 🌐 WebSocket

실시간 업데이트를 위해 WebSocket 연결:

```javascript
const token = await firebase.auth().currentUser.getIdToken();
const ws = new WebSocket(`wss://api.example.com/ws?token=${token}`);

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'bidUpdate') {
        // 입찰 업데이트 처리
    }
};
```

## 🗄️ 데이터베이스

### Supabase 사용 시

1. [Supabase](https://supabase.com)에서 프로젝트 생성
2. Settings → Database → Connection String 복사
3. `DATABASE_URL`에 설정

### 스키마 생성

```bash
psql $DATABASE_URL -f db/schema.sql
```

## 📦 Redis

### Upstash 사용 시

1. [Upstash](https://upstash.com)에서 Redis 인스턴스 생성
2. REST API URL 복사
3. `REDIS_URL`에 설정

## 🚢 배포

### Railway

1. GitHub 저장소 연결
2. 환경 변수 설정
3. 자동 배포

### Render

1. New Web Service
2. GitHub 저장소 선택
3. 환경 변수 설정
4. Build Command: `npm install`
5. Start Command: `npm start`

