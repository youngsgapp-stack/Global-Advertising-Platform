/**
 * HD 사진 API (마운트: /api/hd, 선택 인증)
 * 무료: 산 기간이 1개월(28일) 이상이거나 평생 소장, 광고판 예약 주간
 * 그 외: 주인마다 1번 해제 (1주 가격의 절반, 최소 50pt)
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { invalidateTerritoryCache } from '../redis/cache-utils.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';
import { adjustWalletBalance } from '../utils/wallet-utils.js';
import { isAdminUser } from '../middleware/admin.js';
import { getServerBasePrice } from './territories.js';
import { saveHdImage, deleteHdImage, cleanupReplacedHdImage, detectImageType, publicHdImageUrl } from '../utils/hd-storage.js';

const router = express.Router();
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const FREE_MIN_DAYS = 28;
const LIST_CACHE_KEY = 'hd:images:list';
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveTerritoryId(param) {
    return validateTerritoryIdParam(param, { strict: false, autoConvert: true, logWarning: false })?.canonicalId || null;
}

async function getUserId(req) {
    if (!req.user?.uid) return null;
    return (await query(`SELECT id FROM users WHERE firebase_uid = $1`, [req.user.uid])).rows[0]?.id || null;
}

async function loadTerritory(territoryId) {
    return (await query(
        `SELECT t.id, t.ruler_id, t.sovereignty, t.protection_ends_at, t.base_price, t.market_base_price, t.is_billboard,
                t.hd_image_url, t.hd_image_updated_at, t.hd_unlocked_by,
                (SELECT o.acquired_at FROM ownerships o WHERE o.territory_id = t.id AND o.user_id = t.ruler_id AND o.ended_at IS NULL
                 ORDER BY o.acquired_at DESC LIMIT 1) AS acquired_at
         FROM territories t WHERE t.id = $1`,
        [territoryId]
    )).rows[0] || null;
}

export function hdEntitlement(territory, userId) {
    const isOwner = !!userId && String(territory.ruler_id) === String(userId);
    const unlockPrice = Math.max(50, Math.ceil(getServerBasePrice(territory) * 0.5));
    if (!isOwner) return { isOwner, entitled: false, freeReason: null, unlocked: false, unlockPrice };
    const isLifetime = territory.sovereignty === 'protected' && !territory.protection_ends_at;
    const periodDays = territory.protection_ends_at && territory.acquired_at
        ? (new Date(territory.protection_ends_at) - new Date(territory.acquired_at)) / DAY_MS
        : 0;
    const freeReason = territory.is_billboard ? 'billboard'
        : isLifetime ? 'lifetime'
        : periodDays >= FREE_MIN_DAYS ? 'month_or_longer'
        : null;
    const unlocked = !!territory.hd_unlocked_by && String(territory.hd_unlocked_by) === String(userId);
    return { isOwner, entitled: !!freeReason || unlocked, freeReason, unlocked, unlockPrice };
}

// 지도에 표시할 HD 사진 목록
router.get('/images', async (req, res) => {
    try {
        const cached = await redis.get(LIST_CACHE_KEY);
        if (cached) return res.json(cached);
        const rows = (await query(
            `SELECT id, hd_image_url, hd_image_updated_at FROM territories WHERE hd_image_url IS NOT NULL`
        )).rows;
        const list = rows.map(r => ({
            territoryId: r.id,
            url: publicHdImageUrl(req, r.id, r.hd_image_url, r.hd_image_updated_at),
            updatedAt: r.hd_image_updated_at
        }));
        await redis.set(LIST_CACHE_KEY, list, 60);
        res.json(list);
    } catch (error) {
        if (error.code === '42703') return res.json([]);
        console.error('[HD] List error:', error);
        res.status(500).json({ error: 'Failed to load HD images' });
    }
});

// DB 저장 모드의 이미지 파일 (주소에 버전이 붙어 있어 오래 캐시)
router.get('/territories/:id/image', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const row = territoryId && (await query(
        `SELECT content_type, data FROM territory_hd_images WHERE territory_id = $1`,
        [territoryId]
    )).rows[0];
    if (!row) return res.status(404).end();
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(row.data);
});

// 패널용 상태 (주인이면 무료 여부/해제 가격)
router.get('/territories/:id', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        const territory = territoryId && await loadTerritory(territoryId);
        if (!territory) return res.status(404).json({ error: 'Territory not found' });
        const userId = await getUserId(req);
        res.json({
            territoryId,
            hasImage: !!territory.hd_image_url,
            url: publicHdImageUrl(req, territoryId, territory.hd_image_url, territory.hd_image_updated_at),
            ...hdEntitlement(territory, userId)
        });
    } catch (error) {
        console.error('[HD] Status error:', error);
        res.status(500).json({ error: 'Failed to load HD status' });
    }
});

// 유료 해제 (기간이 1개월 미만인 주인)
router.post('/territories/:id/unlock', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const client = await getPool().connect();
    try {
        const userId = await getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Please sign in first' });
        await client.query('BEGIN');
        await client.query(`SELECT id FROM territories WHERE id = $1 FOR UPDATE`, [territoryId]);
        const territory = await loadTerritory(territoryId);
        if (!territory) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Territory not found' });
        }
        const entitlement = hdEntitlement(territory, userId);
        if (!entitlement.isOwner) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the owner can unlock HD photos' });
        }
        if (entitlement.entitled) {
            await client.query('ROLLBACK');
            return res.json({ success: true, alreadyEntitled: true });
        }
        const { balance } = await adjustWalletBalance(client, userId, -entitlement.unlockPrice, {
            type: 'hd_unlock',
            description: `HD photo unlock: ${territoryId}`,
            referenceId: territoryId
        });
        await client.query(`UPDATE territories SET hd_unlocked_by = $1 WHERE id = $2`, [userId, territoryId]);
        await client.query('COMMIT');
        res.json({ success: true, price: entitlement.unlockPrice, balance });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === 'INSUFFICIENT_BALANCE') {
            return res.status(402).json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE', required: error.required, current: error.current });
        }
        console.error('[HD] Unlock error:', error);
        res.status(500).json({ error: 'Failed to unlock HD photo' });
    } finally {
        client.release();
    }
});

// 업로드 (브라우저에서 영토 모양으로 잘라 1024px 이하 WebP/PNG로 보냄)
router.put('/territories/:id/image',
    express.raw({ type: ['image/webp', 'image/png', 'image/jpeg'], limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
        try {
            const territoryId = resolveTerritoryId(req.params.id);
            const userId = await getUserId(req);
            if (!userId) return res.status(401).json({ error: 'Please sign in first' });
            const territory = territoryId && await loadTerritory(territoryId);
            if (!territory) return res.status(404).json({ error: 'Territory not found' });
            const entitlement = hdEntitlement(territory, userId);
            if (!entitlement.isOwner) return res.status(403).json({ error: 'Only the owner can upload an HD photo' });
            if (!entitlement.entitled) {
                return res.status(402).json({ error: 'Unlock HD photos for this spot first', code: 'HD_LOCKED', unlockPrice: entitlement.unlockPrice });
            }
            const buffer = Buffer.isBuffer(req.body) ? req.body : null;
            const contentType = detectImageType(buffer);
            if (!contentType) return res.status(400).json({ error: 'Please upload a PNG, JPEG or WebP image' });
            
            const storedUrl = await saveHdImage(territoryId, buffer, contentType);
            await cleanupReplacedHdImage(territory.hd_image_url, storedUrl);
            const updated = (await query(
                `UPDATE territories SET hd_image_url = $1, hd_image_updated_at = NOW() WHERE id = $2 AND ruler_id = $3
                 RETURNING hd_image_updated_at`,
                [storedUrl, territoryId, userId]
            )).rows[0];
            if (!updated) return res.status(409).json({ error: 'The owner changed while uploading. Please try again.' });
            await redis.del(LIST_CACHE_KEY);
            await invalidateTerritoryCache(territoryId);
            res.json({ success: true, url: publicHdImageUrl(req, territoryId, storedUrl, updated.hd_image_updated_at), bytes: buffer.length });
        } catch (error) {
            console.error('[HD] Upload error:', error);
            res.status(500).json({ error: 'Failed to save the photo' });
        }
    }
);

router.delete('/territories/:id/image', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        const userId = await getUserId(req);
        const territory = territoryId && await loadTerritory(territoryId);
        if (!territory) return res.status(404).json({ error: 'Territory not found' });
        const isOwner = userId && String(territory.ruler_id) === String(userId);
        if (!isOwner && !isAdminUser(req.user)) return res.status(403).json({ error: 'Only the owner can remove this photo' });
        await deleteHdImage(territoryId, territory.hd_image_url);
        await query(`UPDATE territories SET hd_image_url = NULL, hd_image_updated_at = NULL WHERE id = $1`, [territoryId]);
        await redis.del(LIST_CACHE_KEY);
        await invalidateTerritoryCache(territoryId);
        res.json({ success: true });
    } catch (error) {
        console.error('[HD] Delete error:', error);
        res.status(500).json({ error: 'Failed to remove the photo' });
    }
});

/** 관리자 신고 처리 등에서 사용 */
export async function removeTerritoryHdImage(territoryId) {
    const row = (await query(`SELECT hd_image_url FROM territories WHERE id = $1`, [territoryId])).rows[0];
    await deleteHdImage(territoryId, row?.hd_image_url);
    await query(`UPDATE territories SET hd_image_url = NULL, hd_image_updated_at = NULL WHERE id = $1`, [territoryId]);
    await redis.del(LIST_CACHE_KEY);
}

export { router as hdRouter };
