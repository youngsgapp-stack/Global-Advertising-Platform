-- Migration: Add winner fields to auctions table and auction_id to ownerships
-- Date: 2025-01-11
-- Description: 
--   1. Add winning_bid_id, winner_user_id, winning_amount to auctions for atomic winner finalization
--   2. Add auction_id to ownerships for idempotent ownership transfer
--   3. Add state machine fields: ending_started_at, ended_at, transferred_at

-- Step 1: Add winner fields to auctions table
DO $$
BEGIN
    -- Add winning_bid_id
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'winning_bid_id'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN winning_bid_id UUID REFERENCES bids(id);
        
        RAISE NOTICE 'Column winning_bid_id added to auctions table';
    ELSE
        RAISE NOTICE 'Column winning_bid_id already exists, skipping';
    END IF;

    -- Add winner_user_id
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'winner_user_id'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN winner_user_id UUID REFERENCES users(id);
        
        RAISE NOTICE 'Column winner_user_id added to auctions table';
    ELSE
        RAISE NOTICE 'Column winner_user_id already exists, skipping';
    END IF;

    -- Add winning_amount
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'winning_amount'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN winning_amount DECIMAL(10, 2);
        
        RAISE NOTICE 'Column winning_amount added to auctions table';
    ELSE
        RAISE NOTICE 'Column winning_amount already exists, skipping';
    END IF;

    -- Add state machine fields
    -- ending_started_at: 옥션 종료 프로세스 시작 시점
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'ending_started_at'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN ending_started_at TIMESTAMP;
        
        RAISE NOTICE 'Column ending_started_at added to auctions table';
    ELSE
        RAISE NOTICE 'Column ending_started_at already exists, skipping';
    END IF;

    -- ended_at: 옥션 종료 시점 (승자 확정 완료)
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'ended_at'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN ended_at TIMESTAMP;
        
        RAISE NOTICE 'Column ended_at added to auctions table';
    ELSE
        RAISE NOTICE 'Column ended_at already exists, skipping';
    END IF;

    -- transferred_at: 소유권 이전 완료 시점
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'auctions' 
        AND column_name = 'transferred_at'
    ) THEN
        ALTER TABLE auctions 
        ADD COLUMN transferred_at TIMESTAMP;
        
        RAISE NOTICE 'Column transferred_at added to auctions table';
    ELSE
        RAISE NOTICE 'Column transferred_at already exists, skipping';
    END IF;
END $$;

-- Step 2: Add indexes for winner fields
CREATE INDEX IF NOT EXISTS idx_auctions_winning_bid_id ON auctions(winning_bid_id);
CREATE INDEX IF NOT EXISTS idx_auctions_winner_user_id ON auctions(winner_user_id);
CREATE INDEX IF NOT EXISTS idx_auctions_ending_started_at ON auctions(ending_started_at);
CREATE INDEX IF NOT EXISTS idx_auctions_ended_at ON auctions(ended_at);
CREATE INDEX IF NOT EXISTS idx_auctions_transferred_at ON auctions(transferred_at);

-- Step 3: Add auction_id to ownerships table for idempotent ownership transfer
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'ownerships' 
        AND column_name = 'auction_id'
    ) THEN
        ALTER TABLE ownerships 
        ADD COLUMN auction_id UUID REFERENCES auctions(id);
        
        RAISE NOTICE 'Column auction_id added to ownerships table';
    ELSE
        RAISE NOTICE 'Column auction_id already exists, skipping';
    END IF;
END $$;

-- Step 4: Add unique constraint on ownerships(auction_id) for idempotency
-- 하나의 옥션당 하나의 소유권 이력만 존재하도록 보장
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'ownerships_auction_id_unique'
    ) THEN
        ALTER TABLE ownerships 
        ADD CONSTRAINT ownerships_auction_id_unique UNIQUE (auction_id);
        
        RAISE NOTICE 'Unique constraint ownerships_auction_id_unique added';
    ELSE
        RAISE NOTICE 'Unique constraint ownerships_auction_id_unique already exists, skipping';
    END IF;
END $$;

-- Step 5: Add index for auction_id in ownerships
CREATE INDEX IF NOT EXISTS idx_ownerships_auction_id ON ownerships(auction_id);

-- Step 6: Add comments for documentation
COMMENT ON COLUMN auctions.winning_bid_id IS '최종 낙찰된 입찰 ID (원자적 승자 확정)';
COMMENT ON COLUMN auctions.winner_user_id IS '최종 낙찰자 사용자 ID';
COMMENT ON COLUMN auctions.winning_amount IS '최종 낙찰 금액';
COMMENT ON COLUMN auctions.ending_started_at IS '옥션 종료 프로세스 시작 시점 (상태머신: ACTIVE -> ENDING)';
COMMENT ON COLUMN auctions.ended_at IS '옥션 종료 시점 (상태머신: ENDING -> ENDED, 승자 확정 완료)';
COMMENT ON COLUMN auctions.transferred_at IS '소유권 이전 완료 시점 (상태머신: ENDED -> TRANSFERRED)';
COMMENT ON COLUMN ownerships.auction_id IS '소유권 이전을 발생시킨 옥션 ID (멱등성 보장용)';

