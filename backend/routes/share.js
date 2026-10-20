/**
 * 공유 링크 미리보기 (카카오톡/트위터/페이스북 등은 JS를 실행하지 않고 OG 태그만 읽음)
 * - GET /api/share/:id            → 영토별 OG 태그 HTML (사람은 지도 화면으로 바로 이동)
 * - GET /api/share/:id/image.png  → 영토 픽셀 아트 미리보기 이미지 (1200×630)
 * 사이트 도메인에서는 vercel.json rewrite로 /s/:id 로 제공
 */

import express from 'express';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';
import { encodePng, parseColor } from '../utils/png.js';

const router = express.Router();

const SITE_URL = process.env.SITE_URL || 'https://www.worldadvertisingmap.com';
const GRID_SIZE = 128;
const TILE_SIZE = 16;
const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;
const imageCache = new Map(); // territoryId → { key, png }

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function resolveTerritoryId(param) {
    return validateTerritoryIdParam(param, { strict: false, autoConvert: true, logWarning: false })?.canonicalId || null;
}

function displayName(row, territoryId) {
    let name = row?.name || row?.name_en || '';
    if (typeof name === 'string' && name.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(name);
            name = parsed.en || parsed.local || '';
        } catch {
            // 일반 문자열
        }
    }
    if (!name || name === territoryId) {
        name = territoryId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    return name;
}

/**
 * 영토 픽셀 읽기 (타일 저장소 우선, 없으면 예전 pixel_data)
 * @returns {Promise<{ pixels: Array<{x:number,y:number,color:string}>, revisionKey: string }>}
 */
async function loadTerritoryPixels(territoryId) {
    const revisions = await redis.hgetall(`territory_tile_rev:${territoryId}`) || {};
    const tileIds = Object.keys(revisions);
    if (tileIds.length > 0) {
        const pixels = [];
        for (const tileId of tileIds) {
            const raw = await redis.get(`tile_data:${tileId}`);
            const tile = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(tile?.pixels)) continue;
            const parts = tileId.split(':');
            const tileX = parseInt(parts[parts.length - 2], 10) || 0;
            const tileY = parseInt(parts[parts.length - 1], 10) || 0;
            for (const p of tile.pixels) {
                const local = p.x < TILE_SIZE && p.y < TILE_SIZE;
                pixels.push({
                    x: local ? tileX * TILE_SIZE + p.x : p.x,
                    y: local ? tileY * TILE_SIZE + p.y : p.y,
                    color: p.color
                });
            }
        }
        const revisionKey = tileIds.sort().map(id => `${id}=${revisions[id]}`).join('|');
        return { pixels, revisionKey };
    }
    const legacyRaw = await redis.get(`pixel_data:${territoryId}`);
    const legacy = typeof legacyRaw === 'string' ? JSON.parse(legacyRaw) : legacyRaw;
    return {
        pixels: Array.isArray(legacy?.pixels) ? legacy.pixels : [],
        revisionKey: `legacy:${legacy?.revision || legacy?.updatedAt || 0}`
    };
}

/**
 * 1200×630 미리보기: 어두운 배경 + 청록 테두리 카드 안에 픽셀 아트를 정수 배율로 확대
 */
function renderPreview(pixels) {
    const rgba = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
    const fill = (x0, y0, w, h, [r, g, b]) => {
        for (let y = Math.max(0, y0); y < Math.min(IMAGE_HEIGHT, y0 + h); y++) {
            for (let x = Math.max(0, x0); x < Math.min(IMAGE_WIDTH, x0 + w); x++) {
                const i = (y * IMAGE_WIDTH + x) * 4;
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
                rgba[i + 3] = 255;
            }
        }
    };
    
    fill(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT, [10, 14, 26]);
    
    // 그림이 차지하는 영역만 잘라서 최대한 크게
    let minX = GRID_SIZE, minY = GRID_SIZE, maxX = -1, maxY = -1;
    for (const p of pixels) {
        if (p.x < 0 || p.y < 0 || p.x >= GRID_SIZE || p.y >= GRID_SIZE) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    const artW = maxX - minX + 1;
    const artH = maxY - minY + 1;
    const padding = 8;
    const maxBox = IMAGE_HEIGHT - 80;
    const scale = Math.max(1, Math.floor(Math.min((IMAGE_WIDTH - 160) / (artW + padding * 2), maxBox / (artH + padding * 2))));
    const boxW = (artW + padding * 2) * scale;
    const boxH = (artH + padding * 2) * scale;
    const boxX = Math.floor((IMAGE_WIDTH - boxW) / 2);
    const boxY = Math.floor((IMAGE_HEIGHT - boxH) / 2);
    
    fill(boxX - 6, boxY - 6, boxW + 12, boxH + 12, [78, 205, 196]);
    fill(boxX, boxY, boxW, boxH, [26, 35, 50]);
    for (const p of pixels) {
        const color = parseColor(p.color);
        if (!color || p.x < minX || p.y < minY || p.x > maxX || p.y > maxY) continue;
        fill(boxX + (p.x - minX + padding) * scale, boxY + (p.y - minY + padding) * scale, scale, scale, color);
    }
    return encodePng(IMAGE_WIDTH, IMAGE_HEIGHT, rgba);
}

router.get('/:id/image.png', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const fallback = `${SITE_URL}/og-image.png`;
    if (!territoryId) {
        return res.redirect(302, fallback);
    }
    try {
        const { pixels, revisionKey } = await loadTerritoryPixels(territoryId);
        if (pixels.length === 0) {
            return res.redirect(302, fallback);
        }
        let cached = imageCache.get(territoryId);
        if (!cached || cached.key !== revisionKey) {
            cached = { key: revisionKey, png: renderPreview(pixels) };
            imageCache.set(territoryId, cached);
            if (imageCache.size > 200) {
                imageCache.delete(imageCache.keys().next().value);
            }
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.send(cached.png);
    } catch (error) {
        console.error('[Share] Image error:', error);
        res.redirect(302, fallback);
    }
});

router.get('/:id', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    if (!territoryId) {
        return res.redirect(302, SITE_URL);
    }
    const mapUrl = `${SITE_URL}/?territory=${encodeURIComponent(territoryId)}`;
    try {
        const result = await query(
            `SELECT t.id, t.name, t.name_en, t.sovereignty, t.base_price, t.ad_title, u.nickname
             FROM territories t LEFT JOIN users u ON u.id = t.ruler_id
             WHERE t.id = $1`,
            [territoryId]
        ).catch(error => (error.code === '42703'
            ? query(`SELECT t.id, t.name, t.name_en, t.sovereignty, t.base_price, u.nickname
                     FROM territories t LEFT JOIN users u ON u.id = t.ruler_id WHERE t.id = $1`, [territoryId])
            : Promise.reject(error)));
        const row = result.rows[0];
        if (!row) {
            return res.redirect(302, SITE_URL);
        }
        const name = displayName(row, territoryId);
        const owned = row.sovereignty === 'ruled' || row.sovereignty === 'protected';
        const title = `${name} — Own a Piece of Earth`;
        const description = owned
            ? `${row.ad_title ? `${row.ad_title} · ` : ''}Owned by ${row.nickname || 'a player'}. See their spot on the world map.`
            : `${name} is available from ${Math.round(parseFloat(row.base_price) || 50)} pt a week. Claim it and put your art or ad on the world map.`;
        const shareUrl = `${SITE_URL}/s/${encodeURIComponent(territoryId)}`;
        const imageUrl = `${SITE_URL}/s/${encodeURIComponent(territoryId)}/image.png`;
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Own a Piece of Earth">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="${IMAGE_WIDTH}">
<meta property="og:image:height" content="${IMAGE_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<link rel="canonical" href="${escapeHtml(mapUrl)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(mapUrl)}">
</head>
<body>
<p><a href="${escapeHtml(mapUrl)}">Open ${escapeHtml(name)} on the map</a></p>
<script>location.replace(${JSON.stringify(mapUrl).replace(/</g, '\\u003c')});</script>
</body>
</html>`);
    } catch (error) {
        console.error('[Share] Page error:', error);
        res.redirect(302, mapUrl);
    }
});

export { router as shareRouter };
