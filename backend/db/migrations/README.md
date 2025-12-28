# Database Migrations

이 폴더는 데이터베이스 스키마 변경을 관리합니다.

## 마이그레이션 실행 방법

### 방법 1: psql로 직접 실행 (로컬)
```bash
psql $DATABASE_URL -f migrations/001_add_market_base_price.sql
```

### 방법 2: Node.js 스크립트로 실행
```bash
cd backend
node scripts/run-migration.js migrations/001_add_market_base_price.sql
```

### 방법 3: 서버 시작 시 자동 실행 (개발 환경)
서버 시작 시 `checkSchema()` 함수가 자동으로 마이그레이션을 확인하고 실행합니다.

## 마이그레이션 파일 명명 규칙

- `001_add_market_base_price.sql`
- `002_add_xxx_column.sql`
- `003_modify_xxx_table.sql`

번호는 순차적으로 증가하며, 실행 순서를 보장합니다.

## 주의사항

- **절대 기존 마이그레이션 파일을 수정하지 마세요**
- 새 마이그레이션은 항상 새 파일로 추가하세요
- `IF NOT EXISTS` 체크를 포함하여 안전하게 실행되도록 작성하세요

