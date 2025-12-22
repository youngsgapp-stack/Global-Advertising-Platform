/**
 * Cron Job 라우터
 * Vercel Cron Job에서 호출되는 백엔드 API
 * PostgreSQL + Redis 기반
 */

import express from 'express';
import logger from '../utils/logger.js';
import { query } from '../db/init.js';
import redis from '../redis/init.js';

const router = express.Router();

/**
 * Cron Job 핸들러
 * GET /api/cron?job=all
 * POST /api/cron?job=all
 */
router.post('/', async (req, res) => {
    try {
        const jobType = req.query.job || req.body.job || 'all';
        
        logger.info(`[Cron] Starting job: ${jobType}`);
        
        const results = {};
        
        // 모든 작업 실행 또는 특정 작업만 실행
        if (jobType === 'all' || jobType === 'calculate-rankings') {
            results.rankings = await calculateRankings();
        }
        
        if (jobType === 'all' || jobType === 'check-expired') {
            results.expired = await checkExpiredTerritories();
        }
        
        if (jobType === 'all' || jobType === 'season-transition') {
            results.season = await seasonTransition();
        }
        
        logger.info('[Cron] Completed:', results);
        
        return res.status(200).json({
            success: true,
            jobType,
            results,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('[Cron] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});

// GET도 지원 (Vercel Cron Job이 GET으로 호출할 수도 있음)
router.get('/', async (req, res) => {
    return router.post(req, res);
});

/**
 * 랭킹 계산
 */
async function calculateRankings() {
    try {
        logger.info('[Calculate Rankings] Starting ranking calculation...');
        
        // PostgreSQL에서 모든 영토 데이터 조회
        const territoriesResult = await query(`
            SELECT 
                id, 
                ruler, 
                ruler_name,
                territory_value,
                purchased_price,
                country_code,
                country_iso
            FROM territories
            WHERE ruler IS NOT NULL
        `);
        
        // 사용자별 통계 계산
        const userStats = new Map();
        
        for (const territory of territoriesResult.rows) {
            const userId = territory.ruler;
            if (!userId) continue;
            
            if (!userStats.has(userId)) {
                userStats.set(userId, {
                    territoryCount: 0,
                    totalValue: 0,
                    totalPixels: 0,
                    countries: new Set(),
                    continents: new Set()
                });
            }
            
            const stats = userStats.get(userId);
            stats.territoryCount++;
            stats.totalValue += parseFloat(territory.territory_value || territory.purchased_price || 0);
            
            // 국가 추가
            if (territory.country_code || territory.country_iso) {
                const countryCode = territory.country_code || territory.country_iso;
                stats.countries.add(countryCode);
                
                // 대륙 추가
                const continent = getContinent(countryCode);
                if (continent) {
                    stats.continents.add(continent);
                }
            }
        }
        
        // 픽셀 수 계산 (Redis 또는 PostgreSQL에서)
        // TODO: 픽셀 데이터 구조에 따라 구현 필요
        
        // 랭킹 데이터 저장
        let processedCount = 0;
        for (const [userId, stats] of userStats) {
            const hegemonyScore = calculateHegemonyScore(stats);
            
            await query(`
                INSERT INTO rankings (
                    user_id,
                    territory_count,
                    total_value,
                    total_pixels,
                    country_count,
                    continent_count,
                    countries,
                    continents,
                    hegemony_score,
                    global_coverage_index,
                    updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                ON CONFLICT (user_id) 
                DO UPDATE SET
                    territory_count = EXCLUDED.territory_count,
                    total_value = EXCLUDED.total_value,
                    total_pixels = EXCLUDED.total_pixels,
                    country_count = EXCLUDED.country_count,
                    continent_count = EXCLUDED.continent_count,
                    countries = EXCLUDED.countries,
                    continents = EXCLUDED.continents,
                    hegemony_score = EXCLUDED.hegemony_score,
                    global_coverage_index = EXCLUDED.global_coverage_index,
                    updated_at = NOW()
            `, [
                userId,
                stats.territoryCount || 0,
                stats.totalValue || 0,
                stats.totalPixels || 0,
                stats.countries ? stats.countries.size : 0,
                stats.continents ? stats.continents.size : 0,
                stats.countries ? Array.from(stats.countries) : [],
                stats.continents ? Array.from(stats.continents) : [],
                hegemonyScore || 0,
                hegemonyScore || 0
            ]);
            
            processedCount++;
        }
        
        logger.info(`[Calculate Rankings] ✅ Completed. Processed ${processedCount} rankings.`);
        
        return {
            success: true,
            processed: processedCount
        };
        
    } catch (error) {
        logger.error('[Calculate Rankings] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 만료된 영토 확인
 */
async function checkExpiredTerritories() {
    try {
        logger.info('[Check Expired Territories] Starting check...');
        
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. 1주일 고정 기간이 지난 영토 확인
        const territoriesAfterOneWeek = await query(`
            SELECT id, current_auction, can_be_challenged, is_permanent, lease_ends_at
            FROM territories
            WHERE initial_protection_ends_at <= $1
            AND can_be_challenged = false
            AND is_permanent = false
            AND lease_ends_at IS NULL
            LIMIT 100
        `, [oneWeekAgo]);
        
        let autoPermanentCount = 0;
        for (const territory of territoriesAfterOneWeek.rows) {
            // 경매가 활성화되어 있으면 스킵
            if (territory.current_auction) {
                const auctionResult = await query(`
                    SELECT status FROM auctions WHERE id = $1 AND status = 'active'
                `, [territory.current_auction]);
                
                if (auctionResult.rows.length > 0) {
                    await query(`
                        UPDATE territories 
                        SET can_be_challenged = true, updated_at = NOW()
                        WHERE id = $1
                    `, [territory.id]);
                    continue;
                }
            }
            
            // 무한 고정으로 전환
            await query(`
                UPDATE territories 
                SET can_be_challenged = false, is_permanent = true, updated_at = NOW()
                WHERE id = $1
            `, [territory.id]);
            
            autoPermanentCount++;
        }
        
        // 2. 방치 감지 (30일 이상 활동 없음)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const abandonedTerritories = await query(`
            SELECT id, ruler, ruler_name, purchased_price, country_iso, current_auction
            FROM territories
            WHERE is_permanent = true
            AND last_activity_at < $1
            AND lease_ends_at IS NULL
            LIMIT 100
        `, [thirtyDaysAgo]);
        
        let abandonedCount = 0;
        for (const territory of abandonedTerritories.rows) {
            // 경매가 활성화되어 있으면 스킵
            if (territory.current_auction) {
                const auctionResult = await query(`
                    SELECT status FROM auctions WHERE id = $1 AND status = 'active'
                `, [territory.current_auction]);
                
                if (auctionResult.rows.length > 0) {
                    continue;
                }
            }
            
            // 경매 생성
            const auctionResult = await query(`
                INSERT INTO auctions (
                    territory_id,
                    territory_name,
                    country_iso,
                    status,
                    starting_price,
                    current_price,
                    bid_count,
                    created_at,
                    ends_at,
                    reason
                ) VALUES ($1, $2, $3, 'active', $4, $4, 0, NOW(), $5, 'abandoned_auto_reauction')
                RETURNING id
            `, [
                territory.id,
                'Territory ' + territory.id,
                territory.country_iso,
                territory.purchased_price || 100,
                new Date(now.getTime() + 24 * 60 * 60 * 1000)
            ]);
            
            const auctionId = auctionResult.rows[0].id;
            
            await query(`
                UPDATE territories 
                SET current_auction = $1,
                    can_be_challenged = true,
                    is_permanent = false,
                    updated_at = NOW()
                WHERE id = $2
            `, [auctionId, territory.id]);
            
            abandonedCount++;
        }
        
        // 3. 임대 기간 만료된 영토 확인
        const expiredLeases = await query(`
            SELECT id, ruler, ruler_name, lease_type, purchased_price, country_iso
            FROM territories
            WHERE lease_ends_at <= NOW()
            AND lease_ends_at IS NOT NULL
            AND is_permanent = false
            LIMIT 100
        `);
        
        let expiredLeaseCount = 0;
        for (const territory of expiredLeases.rows) {
            // 경매 생성
            const auctionResult = await query(`
                INSERT INTO auctions (
                    territory_id,
                    territory_name,
                    country_iso,
                    status,
                    starting_price,
                    current_price,
                    bid_count,
                    created_at,
                    ends_at,
                    reason
                ) VALUES ($1, $2, $3, 'active', $4, $4, 0, NOW(), $5, 'lease_expired')
                RETURNING id
            `, [
                territory.id,
                'Territory ' + territory.id,
                territory.country_iso,
                territory.purchased_price || 100,
                new Date(now.getTime() + 24 * 60 * 60 * 1000)
            ]);
            
            const auctionId = auctionResult.rows[0].id;
            
            await query(`
                UPDATE territories 
                SET ruler = NULL,
                    ruler_name = NULL,
                    ruler_since = NULL,
                    sovereignty = 'available',
                    current_auction = $1,
                    can_be_challenged = true,
                    lease_type = NULL,
                    lease_ends_at = NULL,
                    updated_at = NOW()
                WHERE id = $2
            `, [auctionId, territory.id]);
            
            expiredLeaseCount++;
        }
        
        return {
            success: true,
            stats: {
                autoPermanentCount,
                abandonedCount,
                expiredLeaseCount
            }
        };
        
    } catch (error) {
        logger.error('[Check Expired Territories] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 시즌 전환
 */
async function seasonTransition() {
    try {
        logger.info('[Season Transition] Starting check...');
        
        const now = new Date();
        
        // 1. 종료된 시즌 찾기
        const endedSeasons = await query(`
            SELECT id, start_date, end_date
            FROM seasons
            WHERE status = 'active'
            AND end_date <= NOW()
        `);
        
        let transitionedCount = 0;
        for (const season of endedSeasons.rows) {
            await query(`
                UPDATE seasons 
                SET status = 'ended', ended_at = NOW()
                WHERE id = $1
            `, [season.id]);
            
            // TODO: 시즌별 랭킹 계산
            // await calculateSeasonRankings(season.id);
            
            transitionedCount++;
        }
        
        // 2. 새 시즌 생성
        const activeSeasons = await query(`
            SELECT id FROM seasons WHERE status = 'active'
        `);
        
        if (activeSeasons.rows.length === 0) {
            const seasonId = `season_${now.getFullYear()}_${now.getMonth() + 1}`;
            const endDate = new Date(now.getFullYear(), now.getMonth() + 2, 0);
            
            await query(`
                INSERT INTO seasons (
                    id,
                    type,
                    name,
                    start_date,
                    end_date,
                    status,
                    created_at
                ) VALUES ($1, 'monthly', $2, $3, $4, 'active', NOW())
            `, [
                seasonId,
                `${now.getFullYear()}년 ${now.getMonth() + 1}월 시즌`,
                now,
                endDate
            ]);
        }
        
        return {
            success: true,
            transitionedSeasons: transitionedCount
        };
        
    } catch (error) {
        logger.error('[Season Transition] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 패권 점수 계산
 */
function calculateHegemonyScore(stats) {
    const territoryScore = (stats.territoryCount || 0) * 100;
    const valueScore = stats.totalValue || 0;
    const pixelScore = (stats.totalPixels || 0) * 1;
    const countryBonus = (stats.countries ? stats.countries.size : 0) * 500;
    const continentBonus = (stats.continents ? stats.continents.size : 0) * 1000;
    
    return territoryScore + valueScore + pixelScore + countryBonus + continentBonus;
}

/**
 * 국가 코드로 대륙 반환
 */
function getContinent(countryCode) {
    const continentMap = {
        'kr': 'asia', 'jp': 'asia', 'cn': 'asia', 'in': 'asia', 'sg': 'asia',
        'uk': 'europe', 'fr': 'europe', 'de': 'europe', 'it': 'europe', 'es': 'europe',
        'us': 'north-america', 'ca': 'north-america', 'mx': 'north-america',
        'br': 'south-america', 'ar': 'south-america', 'cl': 'south-america',
        'za': 'africa', 'eg': 'africa', 'ng': 'africa',
        'au': 'oceania', 'nz': 'oceania'
    };
    
    return continentMap[countryCode?.toLowerCase()] || null;
}

export default router;

