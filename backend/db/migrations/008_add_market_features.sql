-- 영토 거래 기능: 경매 종류/생성자, 관심 등록, 대기 예약, 구매 제안, 광고판(주간 예약)
-- 상태 규칙은 backend/utils/territory-phase.js 참고

-- 경매 종류: standard(빈 땅/만료된 땅), owner_sale(주인이 판매, 낙찰금 90% 주인 지급), next_period(다음 기간 경매, 주인 동액 매칭 우선)
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'standard';
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS seller_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 관심 등록 (비면 알림)
CREATE TABLE IF NOT EXISTS territory_watches (
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notified_key VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (territory_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_territory_watches_user ON territory_watches(user_id);

-- 대기 예약: 예약금을 걸고 다음 차례 대기. 주인이 유예 기간 안에 연장하지 않으면 1순위에게 48시간 우선 구매권
CREATE TABLE IF NOT EXISTS territory_reservations (
    id SERIAL PRIMARY KEY,
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deposit DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting', -- waiting | offered | converted | cancelled | expired
    offered_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_territory_reservations_queue ON territory_reservations(territory_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_reservations_active_unique
    ON territory_reservations(territory_id, user_id) WHERE status IN ('waiting', 'offered');

-- 구매 제안: 제안 금액을 예치, 주인이 수락하면 거래(주인 90%), 7일 지나면 자동 환불
CREATE TABLE IF NOT EXISTS territory_offers (
    id SERIAL PRIMARY KEY,
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
    amount DECIMAL(10,2) NOT NULL,
    message VARCHAR(200),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled | expired
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_territory_offers_territory ON territory_offers(territory_id, status);
CREATE INDEX IF NOT EXISTS idx_territory_offers_buyer ON territory_offers(buyer_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_offers_pending_unique
    ON territory_offers(territory_id, buyer_id) WHERE status = 'pending';

-- 광고판: 관리자가 지정한 인기 영토는 소유 대신 주 단위(월요일 00:00 UTC 시작)로 예약
ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_billboard BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS billboard_bookings (
    id SERIAL PRIMARY KEY,
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'booked', -- booked | active | done | cancelled
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billboard_bookings_slot_unique
    ON billboard_bookings(territory_id, week_start) WHERE status IN ('booked', 'active');
CREATE INDEX IF NOT EXISTS idx_billboard_bookings_user ON billboard_bookings(user_id, status);
