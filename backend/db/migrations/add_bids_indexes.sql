-- ✅ 관리자 옥션 목록 성능 개선을 위한 인덱스
-- bids 테이블 최고가 입찰 조회 최적화

-- 1. 최고가 입찰 조회를 위한 복합 인덱스 (동률 처리 규칙 반영)
-- ORDER BY amount DESC, created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_bids_auction_amount_desc 
ON bids(auction_id, amount DESC, created_at DESC, id DESC);

-- 2. 경매별 입찰 조회를 위한 보조 인덱스
CREATE INDEX IF NOT EXISTS idx_bids_auction_created 
ON bids(auction_id, created_at DESC);

-- 3. 옥션 필터링/정렬 최적화 (관리자 목록에서 사용)
CREATE INDEX IF NOT EXISTS idx_auctions_status_created 
ON auctions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auctions_end_time 
ON auctions(end_time) WHERE status = 'active';

-- 인덱스 생성 확인 쿼리
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('bids', 'auctions') ORDER BY tablename, indexname;

