-- Migration: Add countryIso column to territories table
-- Date: 2025-01-XX
-- Description: Adds countryIso (ISO 3166-1 alpha-3) column for reliable country identification in auctions

-- Step 1: Add column (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'territories' 
        AND column_name = 'country_iso'
    ) THEN
        ALTER TABLE territories 
        ADD COLUMN country_iso VARCHAR(3);
        
        RAISE NOTICE 'Column country_iso added to territories table';
    ELSE
        RAISE NOTICE 'Column country_iso already exists, skipping';
    END IF;
END $$;

-- Step 2: Create index for performance
CREATE INDEX IF NOT EXISTS idx_territories_country_iso ON territories(country_iso);

-- Step 3: Add comment for documentation
COMMENT ON COLUMN territories.country_iso IS 'ISO 3166-1 alpha-3 country code (e.g., DZA, USA). Required for auction creation.';

