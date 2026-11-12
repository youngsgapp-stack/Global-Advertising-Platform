/**
 * 픽셀 아트 백업/복구: Redis(실제 저장소)의 타일을 Postgres에 압축 보관
 * 바뀐 땅만 백업 (territory_revision 비교), 땅마다 최근 KEEP_PER_TERRITORY개까지 보관
 */
import zlib from 'zlib';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';

const LIST_SET_KEY = 'pixels:territories:set';
const KEEP_PER_TERRITORY = 7;

const parseMaybe = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

async function readPixelArt(territoryId) {
    const tileRevisions = (await redis.hgetall(`territory_tile_rev:${territoryId}`)) || {};
    const tileIds = Object.keys(tileRevisions);
    const tiles = {};
    for (let i = 0; i < tileIds.length; i += 32) {
        const chunk = tileIds.slice(i, i + 32);
        const values = await redis.mget(chunk.map(id => `tile_data:${id}`));
        chunk.forEach((id, k) => { if (values[k]) tiles[id] = parseMaybe(values[k]); });
    }
    const legacy = tileIds.length ? null : parseMaybe(await redis.getFromRedis(`pixel_data:${territoryId}`));
    const pixelCount = Object.values(tiles).reduce((sum, tile) => sum + (tile?.pixels?.length || 0), 0) +
        (legacy?.pixels?.length || 0);
    return {
        revision: Number(await redis.getFromRedis(`territory_revision:${territoryId}`)) || 0,
        tiles,
        meta: parseMaybe(await redis.getFromRedis(`territory_meta:${territoryId}`)),
        legacy: legacy?.pixels?.length ? legacy : null,
        pixelCount
    };
}

/** @returns {Promise<{ checked: number, backedUp: number }>} */
export async function backupPixelArt() {
    const ids = (await redis.smembers(LIST_SET_KEY)) || [];
    if (!ids.length) return { checked: 0, backedUp: 0 };
    const latest = new Map((await query(
        `SELECT DISTINCT ON (territory_id) territory_id, revision
         FROM pixel_art_backups ORDER BY territory_id, backed_up_at DESC`
    )).rows.map(r => [r.territory_id, Number(r.revision)]));

    let backedUp = 0;
    for (const territoryId of ids) {
        try {
            const revision = Number(await redis.getFromRedis(`territory_revision:${territoryId}`)) || 0;
            if (revision !== 0 && latest.get(territoryId) === revision) continue;
            const art = await readPixelArt(territoryId);
            if (!art.pixelCount) continue;
            const data = zlib.gzipSync(Buffer.from(JSON.stringify(art)));
            await query(
                `INSERT INTO pixel_art_backups (territory_id, revision, tile_count, pixel_count, data)
                 VALUES ($1, $2, $3, $4, $5)`,
                [territoryId, art.revision, Object.keys(art.tiles).length, art.pixelCount, data]
            );
            await query(
                `DELETE FROM pixel_art_backups WHERE territory_id = $1 AND id NOT IN (
                    SELECT id FROM pixel_art_backups WHERE territory_id = $1 ORDER BY backed_up_at DESC LIMIT $2
                 )`,
                [territoryId, KEEP_PER_TERRITORY]
            );
            backedUp++;
        } catch (error) {
            console.warn('[PixelBackup] Backup failed for', territoryId, error.message);
        }
    }
    if (backedUp) console.log(`[PixelBackup] Backed up ${backedUp} of ${ids.length} spots`);
    return { checked: ids.length, backedUp };
}

export async function listPixelBackups(territoryId) {
    const params = [];
    let where = '';
    if (territoryId) {
        params.push(territoryId);
        where = 'WHERE territory_id = $1';
    }
    const result = await query(
        `SELECT id, territory_id, revision, tile_count, pixel_count, octet_length(data) AS bytes, backed_up_at
         FROM pixel_art_backups ${where} ORDER BY territory_id, backed_up_at DESC LIMIT 500`,
        params
    );
    return result.rows;
}

/**
 * 백업에서 한 땅의 그림을 Redis로 되돌림 (backupId가 없으면 가장 최근 백업)
 * 버전 번호는 예전 값으로 되돌리지 않고 올림 → 방문자 브라우저에 남은 그림도 새로 받아짐
 */
export async function restorePixelArt(territoryId, backupId = null) {
    const row = (await query(
        backupId
            ? `SELECT data FROM pixel_art_backups WHERE territory_id = $1 AND id = $2`
            : `SELECT data FROM pixel_art_backups WHERE territory_id = $1 ORDER BY backed_up_at DESC LIMIT 1`,
        backupId ? [territoryId, backupId] : [territoryId]
    )).rows[0];
    if (!row) return { restored: false, reason: 'No backup for this spot' };
    const art = JSON.parse(zlib.gunzipSync(row.data).toString('utf8'));
    const tileRevKey = `territory_tile_rev:${territoryId}`;

    const current = (await redis.hgetall(tileRevKey)) || {};
    for (const tileId of Object.keys(current)) {
        if (!art.tiles?.[tileId]) {
            await redis.del(`tile_data:${tileId}`);
            await redis.hdel(tileRevKey, tileId);
        }
    }
    for (const [tileId, tile] of Object.entries(art.tiles || {})) {
        const tileRevision = await redis.incr(`tile_revision:${tileId}`);
        await redis.set(`tile_data:${tileId}`, { ...tile, revision: tileRevision, updatedAt: new Date().toISOString() });
        await redis.hset(tileRevKey, tileId, String(tileRevision));
    }

    const territoryRevision = await redis.incr(`territory_revision:${territoryId}`);
    const meta = { ...(art.meta || {}), territoryRevision, updatedAt: new Date().toISOString() };
    await redis.set(`territory_meta:${territoryId}`, meta);

    if (art.legacy) {
        await redis.set(`pixel_data:${territoryId}`, { ...art.legacy, revision: territoryRevision, updatedAt: meta.updatedAt });
    } else {
        await redis.del(`pixel_data:${territoryId}`);
    }
    await redis.del(`pixels:${territoryId}`);
    await redis.sadd(LIST_SET_KEY, territoryId);
    await redis.del('pixels:territories:list');
    return { restored: true, tiles: Object.keys(art.tiles || {}).length, revision: territoryRevision };
}
