/**
 * 픽셀 아트 백업/복구: Redis(실제 저장소)의 타일을 하루 한 번 Postgres에 압축 보관
 * 바뀐 땅만 백업 (territory_revision 비교) → Redis·DB 사용량이 거의 늘지 않음
 */
import zlib from 'zlib';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';

const LIST_SET_KEY = 'pixels:territories:set';

async function readPixelArt(territoryId) {
    const tileRevisions = (await redis.hgetall(`territory_tile_rev:${territoryId}`)) || {};
    const tileIds = Object.keys(tileRevisions);
    const tiles = {};
    for (let i = 0; i < tileIds.length; i += 32) {
        const chunk = tileIds.slice(i, i + 32);
        const values = await redis.mget(chunk.map(id => `tile_data:${id}`));
        chunk.forEach((id, k) => { if (values[k]) tiles[id] = values[k]; });
    }
    const legacy = tileIds.length ? null : await redis.getFromRedis(`pixel_data:${territoryId}`);
    return {
        revision: Number(await redis.getFromRedis(`territory_revision:${territoryId}`)) || 0,
        tileRevisions,
        tiles,
        meta: await redis.getFromRedis(`territory_meta:${territoryId}`),
        legacy: legacy?.pixels?.length ? legacy : null
    };
}

/** @returns {Promise<{ checked: number, backedUp: number }>} */
export async function backupPixelArt() {
    const ids = (await redis.smembers(LIST_SET_KEY)) || [];
    if (!ids.length) return { checked: 0, backedUp: 0 };
    const existing = new Map((await query(`SELECT territory_id, revision FROM pixel_art_backups`).catch(error => {
        if (error.code === '42P01') return { rows: [] };
        throw error;
    })).rows.map(r => [r.territory_id, Number(r.revision)]));
    
    let backedUp = 0;
    for (const territoryId of ids) {
        try {
            const revision = Number(await redis.getFromRedis(`territory_revision:${territoryId}`)) || 0;
            if (existing.has(territoryId) && existing.get(territoryId) === revision && revision !== 0) continue;
            const art = await readPixelArt(territoryId);
            const tileCount = Object.keys(art.tiles).length;
            if (!tileCount && !art.legacy) continue;
            const data = zlib.gzipSync(Buffer.from(JSON.stringify(art)));
            await query(
                `INSERT INTO pixel_art_backups (territory_id, revision, tile_count, data, backed_up_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (territory_id) DO UPDATE SET revision = $2, tile_count = $3, data = $4, backed_up_at = NOW()`,
                [territoryId, art.revision, tileCount, data]
            );
            backedUp++;
        } catch (error) {
            console.warn('[PixelBackup] Backup failed for', territoryId, error.message);
        }
    }
    if (backedUp) console.log(`[PixelBackup] Backed up ${backedUp} of ${ids.length} spots`);
    return { checked: ids.length, backedUp };
}

/** 백업에서 한 땅의 그림을 Redis로 되돌림 */
export async function restorePixelArt(territoryId) {
    const row = (await query(`SELECT data FROM pixel_art_backups WHERE territory_id = $1`, [territoryId])).rows[0];
    if (!row) return { restored: false, reason: 'No backup for this spot' };
    const art = JSON.parse(zlib.gunzipSync(row.data).toString('utf8'));
    for (const [tileId, tile] of Object.entries(art.tiles || {})) {
        await redis.set(`tile_data:${tileId}`, tile);
        const tileRevision = art.tileRevisions?.[tileId];
        if (tileRevision !== undefined) {
            await redis.set(`tile_revision:${tileId}`, Number(tileRevision));
            await redis.hset(`territory_tile_rev:${territoryId}`, tileId, tileRevision);
        }
    }
    if (art.legacy) await redis.set(`pixel_data:${territoryId}`, art.legacy);
    else await redis.del(`pixel_data:${territoryId}`);
    if (art.meta) await redis.set(`territory_meta:${territoryId}`, art.meta);
    if (art.revision) await redis.set(`territory_revision:${territoryId}`, art.revision);
    await redis.sadd(LIST_SET_KEY, territoryId);
    await redis.del('pixels:territories:list');
    return { restored: true, tiles: Object.keys(art.tiles || {}).length };
}
