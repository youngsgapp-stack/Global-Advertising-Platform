/**
 * Auctions List API Route
 * 활성 경매 목록 조회
 */

import express from 'express';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL } from '../redis/cache-utils.js';

const router = express.Router();

/**
 * GET /api/auctions
 * 활성 경매 목록 조회
 * Query params:
 *   - status: auction status (active, pending, ended, cancelled)
 *   - country: filter by country
 *   - season: filter by season
 *   - limit: limit results (default: 100)
 */
router.get('/', async (req, res) => {
    try {
        const { status = 'active', country, season, limit = 100 } = req.query;
        
        console.log('[Auctions] 📊 Fetching auctions...', { status, country, season, limit });
        
        // Redis 캐시 키 생성
        const cacheKey = `auctions:${status}:${country || 'all'}:${season || 'all'}`;
        let cached = null;
        
        try {
            cached = await redis.get(cacheKey);
            if (cached && typeof cached === 'object') {
                console.log('[Auctions] ✅ Auctions loaded from cache');
                return res.json(cached);
            }
        } catch (redisError) {
            console.warn('[Auctions] ⚠️ Redis cache read error (continuing with DB query):', redisError.message);
            // Redis 오류가 있어도 DB 쿼리는 계속 진행
        }
        
        console.log('[Auctions] 📊 Fetching auctions from database...');
        
        // 쿼리 빌드
        let queryText = `
            SELECT 
                a.*,
                u.nickname as bidder_nickname,
                t.name as territory_name,
                t.code as territory_code,
                t.country as territory_country
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            LEFT JOIN territories t ON a.territory_id = t.id
            WHERE a.status = $1
        `;
        const params = [status];
        let paramIndex = 2;
        
        if (country) {
            queryText += ` AND a.country = $${paramIndex}`;
            params.push(country);
            paramIndex++;
        }
        
        if (season) {
            queryText += ` AND a.season = $${paramIndex}`;
            params.push(parseInt(season));
            paramIndex++;
        }
        
        queryText += ` ORDER BY a.created_at DESC LIMIT $${paramIndex}`;
        params.push(parseInt(limit));
        
        const result = await query(queryText, params);
        
        const auctions = result.rows.map(row => ({
            id: row.id,
            territoryId: row.territory_id,
            territoryName: row.territory_name,
            territoryCode: row.territory_code,
            country: row.territory_country || row.country,
            status: row.status,
            startTime: row.start_time,
            endTime: row.end_time,
            minBid: parseFloat(row.min_bid || 0),
            currentBid: parseFloat(row.current_bid || 0),
            currentBidderId: row.current_bidder_id,
            currentBidderName: row.bidder_nickname,
            season: row.season,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
        
        const response = {
            auctions,
            total: auctions.length,
            status,
            filters: { country, season },
        };
        
        // Redis에 캐시 - 실패해도 응답은 반환
        try {
            await redis.set(cacheKey, response, CACHE_TTL.AUCTION);
            console.log('[Auctions] ✅ Auctions cached in Redis');
        } catch (redisError) {
            console.warn('[Auctions] ⚠️ Redis cache write error (response still sent):', redisError.message);
        }
        
        console.log('[Auctions] ✅ Auctions fetched successfully:', { count: auctions.length });
        res.json(response);
    } catch (error) {
        console.error('[Auctions] ❌❌❌ Error:', {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
            fullError: error
        });
        res.status(500).json({ 
            error: 'Failed to fetch auctions',
            details: error.message,
            errorCode: error.code || 'UNKNOWN_ERROR'
        });
    }
});

export { router as auctionsListRouter };

