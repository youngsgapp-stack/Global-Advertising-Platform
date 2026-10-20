-- HD 사진: 영토 모양으로 잘린 고화질 사진(최대 1024px). 저장 위치는 backend/utils/hd-storage.js
ALTER TABLE territories ADD COLUMN IF NOT EXISTS hd_image_url TEXT;
ALTER TABLE territories ADD COLUMN IF NOT EXISTS hd_image_updated_at TIMESTAMP;
-- 유료 해제한 주인 (주인이 바뀌면 초기화)
ALTER TABLE territories ADD COLUMN IF NOT EXISTS hd_unlocked_by UUID;

-- DB 저장 모드에서 쓰는 이미지 원본 (HD_STORAGE=firebase면 비어 있음)
CREATE TABLE IF NOT EXISTS territory_hd_images (
    territory_id VARCHAR(255) PRIMARY KEY REFERENCES territories(id) ON DELETE CASCADE,
    content_type VARCHAR(40) NOT NULL,
    data BYTEA NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 주인이 바뀌면 이전 주인의 광고 링크와 HD 사진을 함께 지움 (006의 트리거 함수를 확장)
CREATE OR REPLACE FUNCTION clear_territory_ad_on_owner_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ruler_id IS DISTINCT FROM OLD.ruler_id THEN
        NEW.ad_url = NULL;
        NEW.ad_title = NULL;
        NEW.ad_clicks = 0;
        NEW.ad_hidden = false;
        NEW.ad_updated_at = NULL;
        NEW.hd_image_url = NULL;
        NEW.hd_image_updated_at = NULL;
        NEW.hd_unlocked_by = NULL;
        DELETE FROM territory_hd_images WHERE territory_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
