/**
 * Map API Routes
 * 맵 스냅샷 및 영토 목록 조회
 */

import express from 'express';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL } from '../redis/cache-utils.js';

const router = express.Router();

/**
 * GET /api/map/snapshot
 * 전체 맵 스냅샷 조회
 * 초기에는 DB에서 가져오고, 나중에는 CDN에서 제공하도록 변경 예정
 */
router.get('/snapshot', async (req, res) => {
    try {
        // Redis에서 먼저 조회 (5분 캐시)
        const cacheKey = 'map:snapshot';
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // DB에서 영토 목록 조회
        const result = await query(
            `SELECT 
                id,
                code,
                name,
                name_en,
                country,
                continent,
                status,
                ruler_id,
                ruler_name,
                sovereignty,
                base_price,
                current_auction_id,
                updated_at
            FROM territories
            ORDER BY updated_at DESC`
        );
        
        const snapshot = {
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            territories: result.rows.map(row => ({
                id: row.id,
                code: row.code,
                name: row.name,
                name_en: row.name_en,
                country: row.country,
                continent: row.continent,
                status: row.status,
                ruler: row.ruler_id ? {
                    id: row.ruler_id,
                    name: row.ruler_name,
                } : null,
                sovereignty: row.sovereignty,
                basePrice: parseFloat(row.base_price || 0),
                hasAuction: !!row.current_auction_id,
            }))
        };
        
        // Redis에 캐시
        await redis.set(cacheKey, snapshot, CACHE_TTL.MAP_SNAPSHOT);
        
        res.json(snapshot);
    } catch (error) {
        console.error('[Map] Error:', error);
        res.status(500).json({ error: 'Failed to fetch map snapshot' });
    }
});

export { router as mapRouter };

