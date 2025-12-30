-- 마이그레이션: territories.last_winning_amount 추가
-- 실행일: 2025-01-11
-- 설명: 다음 경매 시작가를 위해 이전 낙찰가를 저장하는 컬럼 추가
-- 참고: auctions 테이블의 winning_amount, winner_user_id, winning_bid_id, ended_at, transferred_at는
--       003_add_auction_winner_fields.sql에서 이미 추가됨

-- territories 테이블에 last_winning_amount 필드 추가
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'territories' 
        AND column_name = 'last_winning_amount'
    ) THEN
        ALTER TABLE territories 
        ADD COLUMN last_winning_amount DECIMAL(10, 2);
        
        RAISE NOTICE 'Column last_winning_amount added to territories table';
    ELSE
        RAISE NOTICE 'Column last_winning_amount already exists, skipping';
    END IF;
END $$;

-- 인덱스 추가 (선택사항, 조회 성능 향상)
CREATE INDEX IF NOT EXISTS idx_territories_last_winning_amount ON territories(last_winning_amount) 
WHERE last_winning_amount IS NOT NULL;

-- 주석 추가
COMMENT ON COLUMN territories.last_winning_amount IS '이전 경매의 최종 낙찰가 (다음 경매 시작가로 사용)';

