-- Daily copy of every spot's pixel art (Redis is the live store; this lets us restore it if Redis loses data)
CREATE TABLE IF NOT EXISTS pixel_art_backups (
    territory_id VARCHAR(255) PRIMARY KEY,
    revision BIGINT,
    tile_count INTEGER NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    backed_up_at TIMESTAMP NOT NULL DEFAULT NOW()
);
