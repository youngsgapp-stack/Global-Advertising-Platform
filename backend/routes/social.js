/**
 * 방문자 반응·조회수·주간 랭킹 (/api/social)
 * - 조회수: 같은 사람(로그인 사용자 또는 IP+브라우저)은 영토마다 하루 한 번만 셈
 * - 반응: 한 사람당 영토마다 하나 (바꾸거나 취소 가능, 자기 땅에는 못 누름)
 */

import express from 'express';
import crypto from 'crypto';
import { query } from '../db/init.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';

const router = express.Router();

export const REACTIONS = ['heart', 'fire', 'laugh', 'wow', 'clap'];
const WEEKLY_CACHE_MS = 60 * 1000;
let weeklyCache = null;

function resolveTerritoryId(param) {
    return validateTerritoryIdParam(param, { strict: false, autoConvert: true, logWarning: false })?.canonicalId || null;
}

async function getUserId(req) {
    if (!req.user?.uid) return null;
    const result = await query(`SELECT id FROM users WHERE firebase_uid = $1`, [req.user.uid]);
    return result.rows[0]?.id || null;
}

function visitorHash(req, userId) {
    const basis = userId ? `u:${userId}` : `a:${req.ip}|${req.get('user-agent') || ''}`;
    return crypto.createHash('md5').update(basis).digest('hex');
}

async function loadSocial(territoryId, userId) {
    const [views, reactions, mine, owner] = await Promise.all([
        query(
            `SELECT COALESCE((SELECT view_count FROM territories WHERE id = $1), 0) AS total,
                    COALESCE((SELECT SUM(views) FROM territory_views_daily WHERE territory_id = $1 AND day >= CURRENT_DATE - 6), 0) AS week`,
            [territoryId]
        ),
        query(`SELECT emoji, COUNT(*)::int AS n FROM territory_reactions WHERE territory_id = $1 GROUP BY emoji`, [territoryId]),
        userId
            ? query(`SELECT emoji FROM territory_reactions WHERE territory_id = $1 AND user_id = $2`, [territoryId, userId])
            : Promise.resolve({ rows: [] }),
        query(`SELECT ruler_id FROM territories WHERE id = $1`, [territoryId])
    ]);
    const counts = Object.fromEntries(REACTIONS.map(r => [r, 0]));
    for (const row of reactions.rows) {
        if (counts[row.emoji] !== undefined) counts[row.emoji] = row.n;
    }
    return {
        territoryId,
        views: { total: Number(views.rows[0]?.total) || 0, week: Number(views.rows[0]?.week) || 0 },
        reactions: counts,
        totalReactions: Object.values(counts).reduce((a, b) => a + b, 0),
        myReaction: mine.rows[0]?.emoji || null,
        isOwner: !!userId && owner.rows[0]?.ruler_id === userId
    };
}

/**
 * POST /api/social/territories/:id/view
 */
router.post('/territories/:id/view', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    if (!territoryId) return res.status(400).json({ error: 'Invalid territory ID' });
    try {
        const userId = await getUserId(req);
        const visitor = visitorHash(req, userId);
        const result = await query(
            `WITH ins AS (
                INSERT INTO territory_view_log (territory_id, day, visitor)
                SELECT $1::varchar, CURRENT_DATE, $2::char(32) WHERE EXISTS (SELECT 1 FROM territories WHERE id = $1::varchar)
                ON CONFLICT DO NOTHING
                RETURNING 1
             ), daily AS (
                INSERT INTO territory_views_daily (territory_id, day, views)
                SELECT $1::varchar, CURRENT_DATE, 1 FROM ins
                ON CONFLICT (territory_id, day) DO UPDATE SET views = territory_views_daily.views + 1
                RETURNING 1
             )
             UPDATE territories SET view_count = COALESCE(view_count, 0) + 1
             WHERE id = $1::varchar AND EXISTS (SELECT 1 FROM ins)
             RETURNING view_count`,
            [territoryId, visitor]
        );
        res.json({ counted: result.rowCount > 0 });
    } catch (error) {
        console.error('[Social] View error:', error.message);
        res.status(500).json({ error: 'Failed to record view' });
    }
});

/**
 * GET /api/social/territories/:id
 */
router.get('/territories/:id', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    if (!territoryId) return res.status(400).json({ error: 'Invalid territory ID' });
    try {
        res.json(await loadSocial(territoryId, await getUserId(req)));
    } catch (error) {
        console.error('[Social] Load error:', error.message);
        res.status(500).json({ error: 'Failed to load reactions' });
    }
});

/**
 * PUT /api/social/territories/:id/reaction  { emoji }  (같은 걸 다시 보내면 그대로, 다른 걸 보내면 바뀜)
 * DELETE /api/social/territories/:id/reaction
 */
router.put('/territories/:id/reaction', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const emoji = req.body?.emoji;
    if (!territoryId) return res.status(400).json({ error: 'Invalid territory ID' });
    if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction' });
    try {
        const userId = await getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Log in to react' });
        const owner = await query(`SELECT ruler_id FROM territories WHERE id = $1`, [territoryId]);
        if (owner.rows.length === 0) return res.status(404).json({ error: 'Territory not found' });
        if (!owner.rows[0].ruler_id) return res.status(409).json({ error: 'Nobody owns this spot yet' });
        if (owner.rows[0].ruler_id === userId) return res.status(403).json({ error: "You can't react to your own spot" });
        await query(
            `INSERT INTO territory_reactions (territory_id, user_id, emoji)
             VALUES ($1, $2, $3)
             ON CONFLICT (territory_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()`,
            [territoryId, userId, emoji]
        );
        weeklyCache = null;
        res.json(await loadSocial(territoryId, userId));
    } catch (error) {
        console.error('[Social] React error:', error.message);
        res.status(500).json({ error: 'Failed to save reaction' });
    }
});

router.delete('/territories/:id/reaction', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    if (!territoryId) return res.status(400).json({ error: 'Invalid territory ID' });
    try {
        const userId = await getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Log in to react' });
        await query(`DELETE FROM territory_reactions WHERE territory_id = $1 AND user_id = $2`, [territoryId, userId]);
        weeklyCache = null;
        res.json(await loadSocial(territoryId, userId));
    } catch (error) {
        console.error('[Social] Unreact error:', error.message);
        res.status(500).json({ error: 'Failed to remove reaction' });
    }
});

/**
 * GET /api/social/weekly
 * 이번 주 많이 본 곳 / 반응 많은 곳 / 새로 산 곳 / 역대 조회수 (명예의 전당)
 */
router.get('/weekly', async (req, res) => {
    if (weeklyCache && Date.now() - weeklyCache.at < WEEKLY_CACHE_MS) {
        return res.json(weeklyCache.data);
    }
    try {
        const name = `COALESCE(NULLIF(t.name_en, ''), NULLIF(t.name, ''), t.id)`;
        const [mostViewed, mostLoved, newest, hallOfFame] = await Promise.all([
            query(
                `SELECT t.id, ${name} AS name, t.country, u.nickname AS owner, SUM(v.views)::int AS views
                 FROM territory_views_daily v
                 JOIN territories t ON t.id = v.territory_id
                 LEFT JOIN users u ON u.id = t.ruler_id
                 WHERE v.day >= CURRENT_DATE - 6
                 GROUP BY t.id, t.name_en, t.name, t.country, u.nickname
                 ORDER BY views DESC
                 LIMIT 10`
            ),
            query(
                `SELECT t.id, ${name} AS name, t.country, u.nickname AS owner,
                        COUNT(*)::int AS reactions,
                        MODE() WITHIN GROUP (ORDER BY r.emoji) AS top_emoji
                 FROM territory_reactions r
                 JOIN territories t ON t.id = r.territory_id
                 LEFT JOIN users u ON u.id = t.ruler_id
                 WHERE r.updated_at >= NOW() - INTERVAL '7 days'
                 GROUP BY t.id, t.name_en, t.name, t.country, u.nickname
                 ORDER BY reactions DESC
                 LIMIT 10`
            ),
            query(
                `SELECT DISTINCT ON (t.id) t.id, ${name} AS name, t.country, u.nickname AS owner, o.acquired_at
                 FROM ownerships o
                 JOIN territories t ON t.id = o.territory_id AND t.ruler_id = o.user_id
                 LEFT JOIN users u ON u.id = t.ruler_id
                 WHERE o.acquired_at >= NOW() - INTERVAL '7 days'
                 ORDER BY t.id, o.acquired_at DESC`
            ),
            query(
                `SELECT t.id, ${name} AS name, t.country, u.nickname AS owner, t.view_count AS views
                 FROM territories t
                 LEFT JOIN users u ON u.id = t.ruler_id
                 WHERE COALESCE(t.view_count, 0) > 0
                 ORDER BY t.view_count DESC
                 LIMIT 10`
            )
        ]);
        const data = {
            mostViewed: mostViewed.rows,
            mostLoved: mostLoved.rows,
            newest: newest.rows.sort((a, b) => new Date(b.acquired_at) - new Date(a.acquired_at)).slice(0, 10),
            hallOfFame: hallOfFame.rows,
            generatedAt: new Date().toISOString()
        };
        weeklyCache = { at: Date.now(), data };
        res.json(data);
    } catch (error) {
        console.error('[Social] Weekly error:', error.message);
        res.status(500).json({ error: 'Failed to load rankings' });
    }
});

/**
 * 주기 작업: 하루 한 번 세기용 방문 기록(8일 지난 것)과 오래된 일별 조회수(120일) 정리
 */
export async function cleanupSocialData() {
    await query(`DELETE FROM territory_view_log WHERE day < CURRENT_DATE - 8`);
    await query(`DELETE FROM territory_views_daily WHERE day < CURRENT_DATE - 120`);
}

export { router as socialRouter };
