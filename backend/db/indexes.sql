-- 추가 인덱스 최적화
-- 쿼리 성능 개선을 위한 복합 인덱스 및 커버링 인덱스

-- Territories 복합 인덱스
-- 영토 목록 조회 최적화 (country + status)
CREATE INDEX IF NOT EXISTS idx_territories_country_status 
    ON territories(country, status, updated_at DESC);

-- 영토 목록 조회 최적화 (status + sovereignty)
CREATE INDEX IF NOT EXISTS idx_territories_status_sovereignty 
    ON territories(status, sovereignty, updated_at DESC);

-- Auctions 복합 인덱스
-- 활성 경매 조회 최적화
CREATE INDEX IF NOT EXISTS idx_auctions_territory_status_active 
    ON auctions(territory_id, status) 
    WHERE status = 'active';

-- 경매 종료 시간 인덱스 (활성 경매만)
CREATE INDEX IF NOT EXISTS idx_auctions_status_end_time 
    ON auctions(status, end_time) 
    WHERE status = 'active';

-- Bids 복합 인덱스
-- 경매별 입찰 조회 최적화
CREATE INDEX IF NOT EXISTS idx_bids_auction_created 
    ON bids(auction_id, created_at DESC);

-- 사용자별 입찰 조회
CREATE INDEX IF NOT EXISTS idx_bids_user_created 
    ON bids(user_id, created_at DESC);

-- Ownerships 복합 인덱스
-- 현재 소유 중인 영토 조회 (ended_at이 null)
CREATE INDEX IF NOT EXISTS idx_ownerships_territory_active 
    ON ownerships(territory_id, ended_at) 
    WHERE ended_at IS NULL;

-- 사용자별 소유 영토 조회
CREATE INDEX IF NOT EXISTS idx_ownerships_user_active 
    ON ownerships(user_id, acquired_at DESC) 
    WHERE ended_at IS NULL;

-- Wallet Transactions 복합 인덱스
-- 사용자별 거래 내역 조회
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created 
    ON wallet_transactions(user_id, created_at DESC);

-- 거래 타입별 조회
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_type_created 
    ON wallet_transactions(type, created_at DESC);





