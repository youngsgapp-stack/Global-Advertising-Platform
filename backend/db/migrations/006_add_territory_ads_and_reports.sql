-- 영토 광고 링크 (주인이 다는 웹사이트 링크 + 한 줄 소개 + 클릭 수)
ALTER TABLE territories ADD COLUMN IF NOT EXISTS ad_url TEXT;
ALTER TABLE territories ADD COLUMN IF NOT EXISTS ad_title VARCHAR(80);
ALTER TABLE territories ADD COLUMN IF NOT EXISTS ad_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE territories ADD COLUMN IF NOT EXISTS ad_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE territories ADD COLUMN IF NOT EXISTS ad_updated_at TIMESTAMP;
-- POST /api/territories/:id/view 가 쓰는 조회수 (기존 DB에 컬럼이 없어 집계가 실패하고 있었음)
ALTER TABLE territories ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;

-- 주인이 바뀌면(구매/낙찰/관리자 지정/초기화) 이전 주인의 광고는 자동으로 지움
CREATE OR REPLACE FUNCTION clear_territory_ad_on_owner_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ruler_id IS DISTINCT FROM OLD.ruler_id THEN
        NEW.ad_url = NULL;
        NEW.ad_title = NULL;
        NEW.ad_clicks = 0;
        NEW.ad_hidden = false;
        NEW.ad_updated_at = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clear_territory_ad_on_owner_change ON territories;
CREATE TRIGGER trg_clear_territory_ad_on_owner_change
    BEFORE UPDATE OF ruler_id ON territories
    FOR EACH ROW
    EXECUTE FUNCTION clear_territory_ad_on_owner_change();

-- 그림/링크 신고
CREATE TABLE IF NOT EXISTS territory_reports (
    id SERIAL PRIMARY KEY,
    territory_id VARCHAR(255) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
    reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(20) NOT NULL,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    action VARCHAR(30),
    resolved_by VARCHAR(255),
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_territory_reports_status ON territory_reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_reports_open_unique
    ON territory_reports(territory_id, reporter_id) WHERE status = 'open';
