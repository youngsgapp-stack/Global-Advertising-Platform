/**
 * Territories API Routes
 */

import express from 'express';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';

const router = express.Router();

/**
 * GET /api/territories/:id
 * 영토 상세 조회
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Redis에서 먼저 조회
        const cacheKey = `territory:${id}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // DB에서 조회
        const result = await query(
            `SELECT 
                t.*,
                u.nickname as ruler_nickname,
                u.email as ruler_email,
                a.id as auction_id,
                a.status as auction_status,
                a.current_bid as auction_current_bid,
                a.end_time as auction_end_time
            FROM territories t
            LEFT JOIN users u ON t.ruler_id = u.id
            LEFT JOIN auctions a ON t.current_auction_id = a.id AND a.status = 'active'
            WHERE t.id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = result.rows[0];
        
        // Redis에 캐시 (1시간)
        await redis.set(cacheKey, territory, 3600);
        
        res.json(territory);
    } catch (error) {
        console.error('[Territories] Error:', error);
        res.status(500).json({ error: 'Failed to fetch territory' });
    }
});

/**
 * GET /api/territories/:id/auctions/active
 * 영토의 활성 경매 조회
 */
router.get('/:id/auctions/active', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await query(
            `SELECT 
                a.*,
                u.nickname as bidder_nickname
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.territory_id = $1 AND a.status = 'active'
            ORDER BY a.created_at DESC
            LIMIT 1`,
            [id]
        );
        
        res.json(result.rows[0] || null);
    } catch (error) {
        console.error('[Territories] Error:', error);
        res.status(500).json({ error: 'Failed to fetch active auction' });
    }
});

export { router as territoriesRouter };

