-- Copies of each spot's pixel art (Redis is the live store; these let us restore art if Redis loses data or a drawing is vandalised)
CREATE TABLE IF NOT EXISTS pixel_art_backups (
    id SERIAL PRIMARY KEY,
    territory_id VARCHAR(255) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    tile_count INTEGER NOT NULL DEFAULT 0,
    pixel_count INTEGER NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    backed_up_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pixel_art_backups_territory ON pixel_art_backups(territory_id, backed_up_at DESC);
