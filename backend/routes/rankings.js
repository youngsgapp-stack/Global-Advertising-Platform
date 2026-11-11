/**
 * Rankings API Routes
 * 랭킹 시스템
 */

import express from 'express';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL } from '../redis/cache-utils.js';

const router = express.Router();

/**
 * GET /api/rankings
 * 랭킹 목록 조회
 */
router.get('/', async (req, res) => {
    try {
        const type = ['global_coverage', 'territory_count', 'total_value'].includes(req.query.type) ? req.query.type : 'global_coverage';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
        
        // Redis에서 먼저 조회 (5분 캐시)
        const cacheKey = `rankings:${type}:${limit}`;
        let cached = null;
        
        try {
            cached = await redis.get(cacheKey);
            if (cached && typeof cached === 'object') {
                console.log('[Rankings] ✅ Rankings loaded from cache');
                return res.json(cached);
            }
        } catch (redisError) {
            console.warn('[Rankings] ⚠️ Redis cache read error (continuing with DB query):', redisError.message);
            // Redis 오류가 있어도 DB 쿼리는 계속 진행
        }
        
        console.log('[Rankings] 📊 Fetching rankings from database...', { type, limit });
        
        // TODO: DB에 rankings 테이블이 있으면 조회
        // 현재는 영토 소유권 기반으로 랭킹 계산
        let rankings = [];
        
        if (type === 'global_coverage' || type === 'territory_count') {
            // 영토 개수 기반 랭킹
            const result = await query(
                `SELECT 
                    u.id,
                    u.firebase_uid,
                    u.nickname,
                    COUNT(t.id) as territory_count,
                    COALESCE(SUM(t.base_price), 0) as total_value
                 FROM users u
                 LEFT JOIN territories t ON t.ruler_id = u.id
                 WHERE t.ruler_id IS NOT NULL
                 GROUP BY u.id, u.firebase_uid, u.nickname
                 ORDER BY territory_count DESC, total_value DESC
                 LIMIT $1`,
                [limit]
            );
            
            rankings = result.rows.map((row, index) => ({
                rank: index + 1,
                userId: row.firebase_uid,
                nickname: row.nickname,
                territoryCount: parseInt(row.territory_count || 0),
                totalValue: parseFloat(row.total_value || 0),
                hegemonyScore: parseInt(row.territory_count || 0) * 100 // 간단한 점수 계산
            }));
        } else if (type === 'total_value') {
            // 총 가치 기반 랭킹
            const result = await query(
                `SELECT 
                    u.id,
                    u.firebase_uid,
                    u.nickname,
                    COUNT(t.id) as territory_count,
                    COALESCE(SUM(t.base_price), 0) as total_value
                 FROM users u
                 LEFT JOIN territories t ON t.ruler_id = u.id
                 WHERE t.ruler_id IS NOT NULL
                 GROUP BY u.id, u.firebase_uid, u.nickname
                 ORDER BY total_value DESC, territory_count DESC
                 LIMIT $1`,
                [limit]
            );
            
            rankings = result.rows.map((row, index) => ({
                rank: index + 1,
                userId: row.firebase_uid,
                nickname: row.nickname,
                territoryCount: parseInt(row.territory_count || 0),
                totalValue: parseFloat(row.total_value || 0),
                hegemonyScore: parseFloat(row.total_value || 0)
            }));
        }
        
        const result = { type, rankings };
        
        // Redis에 캐시 - 실패해도 응답은 반환
        try {
            await redis.set(cacheKey, result, CACHE_TTL.RANKING);
            console.log('[Rankings] ✅ Rankings cached in Redis');
        } catch (redisError) {
            console.warn('[Rankings] ⚠️ Redis cache write error (response still sent):', redisError.message);
        }
        
        console.log('[Rankings] ✅ Rankings fetched successfully:', { type, count: rankings.length });
        res.json(result);
    } catch (error) {
        console.error('[Rankings] ❌❌❌ Error:', {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
            fullError: error
        });
        res.status(500).json({ 
            error: 'Failed to fetch rankings'
        });
    }
});

/**
 * GET /api/rankings/:userId
 * 특정 사용자 랭킹 조회
 */
router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // 사용자 정보 조회
        const userResult = await query(
            `SELECT 
                u.id,
                u.firebase_uid,
                u.nickname,
                COUNT(t.id) as territory_count,
                COALESCE(SUM(t.base_price), 0) as total_value
             FROM users u
             LEFT JOIN territories t ON t.ruler_id = u.id
             WHERE u.firebase_uid = $1
             GROUP BY u.id, u.firebase_uid, u.nickname`,
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        
        // 전체 랭킹에서 순위 계산
        const allRankingsResult = await query(
            `SELECT 
                u.id,
                COUNT(t.id) as territory_count
             FROM users u
             LEFT JOIN territories t ON t.ruler_id = u.id
             WHERE t.ruler_id IS NOT NULL
             GROUP BY u.id
             ORDER BY territory_count DESC`
        );
        
        const userTerritoryCount = parseInt(user.territory_count || 0);
        let rank = 1;
        for (const row of allRankingsResult.rows) {
            if (row.id === user.id) break;
            rank++;
        }
        
        res.json({
            rank,
            userId: user.firebase_uid,
            nickname: user.nickname,
            territoryCount: userTerritoryCount,
            totalValue: parseFloat(user.total_value || 0),
            hegemonyScore: userTerritoryCount * 100
        });
    } catch (error) {
        console.error('[Rankings] Error:', error);
        res.status(500).json({ error: 'Failed to fetch user ranking' });
    }
});

export { router as rankingsRouter };

