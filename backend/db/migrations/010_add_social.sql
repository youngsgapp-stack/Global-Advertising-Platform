-- 방문자 반응(한 사람당 영토마다 하나, 바꿀 수 있음)과 일별 조회수 (주간 랭킹용)

CREATE TABLE IF NOT EXISTS territory_reactions (
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji VARCHAR(16) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (territory_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_territory_reactions_updated ON territory_reactions(updated_at DESC);

CREATE TABLE IF NOT EXISTS territory_views_daily (
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (territory_id, day)
);
CREATE INDEX IF NOT EXISTS idx_territory_views_daily_day ON territory_views_daily(day);

-- 같은 사람(로그인 사용자 또는 IP+브라우저 해시)은 하루 한 번만 조회수로 셈. 8일 지난 기록은 주기 작업이 지움
CREATE TABLE IF NOT EXISTS territory_view_log (
    territory_id VARCHAR(255) NOT NULL,
    day DATE NOT NULL,
    visitor CHAR(32) NOT NULL,
    PRIMARY KEY (territory_id, day, visitor)
);
CREATE INDEX IF NOT EXISTS idx_territory_view_log_day ON territory_view_log(day);

-- 주인이 바뀌면 이전 주인 그림에 달린 반응은 지움 (조회수는 영토 인기라 유지)
CREATE OR REPLACE FUNCTION clear_territory_reactions_on_owner_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ruler_id IS DISTINCT FROM OLD.ruler_id THEN
        DELETE FROM territory_reactions WHERE territory_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clear_territory_reactions_on_owner_change ON territories;
CREATE TRIGGER trg_clear_territory_reactions_on_owner_change
    AFTER UPDATE OF ruler_id ON territories
    FOR EACH ROW
    EXECUTE FUNCTION clear_territory_reactions_on_owner_change();
