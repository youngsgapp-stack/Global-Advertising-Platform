-- Auctions must never carry NaN or non-positive bid floors (NaN made every bid "high enough")

UPDATE auctions a
SET min_bid = GREATEST(COALESCE(NULLIF(t.market_base_price, 'NaN'), 100), 1)
FROM territories t
WHERE a.territory_id = t.id
  AND (a.min_bid = 'NaN' OR a.min_bid <= 0);

UPDATE auctions
SET current_bid = min_bid
WHERE current_bid = 'NaN';

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_min_bid_valid;
ALTER TABLE auctions ADD CONSTRAINT auctions_min_bid_valid
    CHECK (min_bid IS NULL OR (min_bid <> 'NaN' AND min_bid > 0)) NOT VALID;

ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_current_bid_valid;
ALTER TABLE auctions ADD CONSTRAINT auctions_current_bid_valid
    CHECK (current_bid IS NULL OR (current_bid <> 'NaN' AND current_bid >= 0)) NOT VALID;
