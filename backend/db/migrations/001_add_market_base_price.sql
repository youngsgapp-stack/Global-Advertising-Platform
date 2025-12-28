-- Migration: Add market_base_price column to territories table
-- Date: 2025-01-11
-- Description: Adds market_base_price column for dynamic pricing based on auction results

-- Step 1: Add column (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'territories' 
        AND column_name = 'market_base_price'
    ) THEN
        ALTER TABLE territories 
        ADD COLUMN market_base_price DECIMAL(10, 2);
        
        RAISE NOTICE 'Column market_base_price added to territories table';
    ELSE
        RAISE NOTICE 'Column market_base_price already exists, skipping';
    END IF;
END $$;

-- Step 2: Set default value for existing rows (if NULL)
-- Use base_price as initial value if market_base_price is NULL
UPDATE territories 
SET market_base_price = COALESCE(base_price, 0)
WHERE market_base_price IS NULL;

-- Step 3: Add comment for documentation
COMMENT ON COLUMN territories.market_base_price IS '시장 기준가 (경매 낙찰가에 따라 갱신)';

