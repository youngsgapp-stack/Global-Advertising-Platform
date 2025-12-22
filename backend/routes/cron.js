/**
 * Cron Job 라우터
 * Vercel Cron Job에서 호출되는 백엔드 API
 * PostgreSQL + Redis 기반
 */

import express from 'express';
import logger from '../utils/logger.js';
import { query } from '../db/init.js';
import { redis } from '../redis/init.js';

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
 * 주의: 컬럼이 없을 수 있으므로 방어적 처리
 */
async function calculateRankings() {
    try {
        logger.info('[Calculate Rankings] Starting ranking calculation...');
        
        // price 컬럼 존재 여부 확인 (purchased_price 또는 base_price)
        const priceColumnCheck = await query(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'territories'
            AND column_name IN ('purchased_price', 'base_price', 'price')
            ORDER BY 
                CASE column_name
                    WHEN 'purchased_price' THEN 1
                    WHEN 'base_price' THEN 2
                    WHEN 'price' THEN 3
                END
            LIMIT 1
        `);
        
        if (priceColumnCheck.rows.length === 0) {
            logger.warn('[Calculate Rankings] ⚠️ No price column found (purchased_price/base_price/price), skipping');
            return {
                success: true,
                skipped: true,
                message: 'No price column found in territories table',
                processed: 0
            };
        }
        
        const priceColumn = priceColumnCheck.rows[0].column_name;
        logger.info(`[Calculate Rankings] Using price column: ${priceColumn}`);
        
        // country 컬럼 확인 (country_code가 없을 수 있음)
        // 스키마 확인: table_schema를 명시적으로 'public'으로 지정
        const countryColumnCheck = await query(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'territories'
            AND column_name IN ('country_code', 'country')
            ORDER BY 
                CASE column_name
                    WHEN 'country_code' THEN 1
                    WHEN 'country' THEN 2
                END
            LIMIT 1
        `);
        
        const countryColumn = countryColumnCheck.rows.length > 0 ? countryColumnCheck.rows[0].column_name : null;
        
        // 탐지 결과 명확한 로그 출력 (배포 후 확인용)
        logger.info(`[Calculate Rankings] 🔍 Country column detection: countryColumn=${countryColumn || 'null'}, found=${countryColumnCheck.rows.length > 0}, schema=public, table=territories`);
        
        if (!countryColumn) {
            logger.warn('[Calculate Rankings] ⚠️ No country column found (country_code/country), skipping country-based calculations');
        } else {
            logger.info(`[Calculate Rankings] ✅ Using country column: ${countryColumn}`);
        }
        
        // PostgreSQL에서 모든 영토 데이터 조회
        // country 컬럼이 없으면 country 정보 제외
        let territoriesQuery = `
            SELECT 
                t.id, 
                t.ruler_id, 
                t.ruler_name,
                t."${priceColumn}" as territory_price,
                u.firebase_uid as ruler_firebase_uid
        `;
        
        if (countryColumn) {
            territoriesQuery += `, t."${countryColumn}" as territory_country`;
        }
        
        territoriesQuery += `
            FROM territories t
            LEFT JOIN users u ON t.ruler_id = u.id
            WHERE t.ruler_id IS NOT NULL
        `;
        
        const territoriesResult = await query(territoriesQuery);
        
        // 사용자별 통계 계산
        const userStats = new Map();
        
        for (const territory of territoriesResult.rows) {
            // ruler_firebase_uid를 우선 사용, 없으면 ruler_id 사용
            const userId = territory.ruler_firebase_uid || territory.ruler_id;
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
            stats.totalValue += parseFloat(territory.territory_price || 0);
            
            // 국가 추가 (country 컬럼이 있는 경우만)
            if (countryColumn && territory.territory_country) {
                const countryCode = territory.territory_country;
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
        // 주의: initial_protection_ends_at, can_be_challenged, is_permanent 컬럼이 없을 수 있음
        // lease_ends_at도 없을 수 있으므로 컬럼 존재 여부 확인
        let autoPermanentCount = 0;
        
        // lease_ends_at 컬럼 존재 여부 확인
        const leaseColumnCheck = await query(`
            SELECT EXISTS (
                SELECT FROM information_schema.columns 
                WHERE table_schema = 'public' 
                AND table_name = 'territories'
                AND column_name = 'lease_ends_at'
            )
        `);
        
        const hasLeaseColumn = leaseColumnCheck.rows[0].exists;
        
        let territoriesAfterOneWeek;
        if (hasLeaseColumn) {
            territoriesAfterOneWeek = await query(`
                SELECT id, current_auction_id, status, sovereignty
                FROM territories
                WHERE ruler_id IS NOT NULL
                AND status = 'ruled'
                AND (lease_ends_at IS NULL OR lease_ends_at > NOW())
                LIMIT 100
            `);
        } else {
            // lease_ends_at 컬럼이 없으면 모든 ruled 영토 확인
            territoriesAfterOneWeek = await query(`
                SELECT id, current_auction_id, status, sovereignty
                FROM territories
                WHERE ruler_id IS NOT NULL
                AND status = 'ruled'
                LIMIT 100
            `);
        }
        
        for (const territory of territoriesAfterOneWeek.rows) {
            // 경매가 활성화되어 있으면 스킵
            if (territory.current_auction_id) {
                const auctionResult = await query(`
                    SELECT status FROM auctions WHERE id = $1 AND status = 'active'
                `, [territory.current_auction_id]);
                
                if (auctionResult.rows.length > 0) {
                    // 경매가 활성화되어 있으면 상태 유지
                    continue;
                }
            }
            
            // 영토 상태는 그대로 유지 (자동으로 permanent로 전환하지 않음)
            // 필요시 나중에 추가
            autoPermanentCount++;
        }
        
        // 2. 방치 감지 (30일 이상 활동 없음)
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        // price 컬럼 확인
        const priceColumnCheck = await query(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'territories'
            AND column_name IN ('purchased_price', 'base_price', 'price')
            ORDER BY 
                CASE column_name
                    WHEN 'purchased_price' THEN 1
                    WHEN 'base_price' THEN 2
                    WHEN 'price' THEN 3
                END
            LIMIT 1
        `);
        
        const priceColumn = priceColumnCheck.rows.length > 0 ? priceColumnCheck.rows[0].column_name : 'base_price';
        
        // country 컬럼 확인
        const countryColumnCheck = await query(`
            SELECT column_name
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'territories'
            AND column_name IN ('country_code', 'country')
            ORDER BY 
                CASE column_name
                    WHEN 'country_code' THEN 1
                    WHEN 'country' THEN 2
                END
            LIMIT 1
        `);
        
        const countryColumn = countryColumnCheck.rows.length > 0 ? countryColumnCheck.rows[0].column_name : null;
        
        // 탐지 결과 명확한 로그 출력 (배포 후 확인용)
        logger.info(`[Check Expired Territories] 🔍 Country column detection: countryColumn=${countryColumn || 'null'}, found=${countryColumnCheck.rows.length > 0}, schema=public, table=territories`);
        
        // 동적 쿼리 구성 (country 컬럼이 없으면 제외)
        let abandonedQuery = `
            SELECT id, ruler_id, ruler_name, "${priceColumn}" as territory_price, current_auction_id
        `;
        
        if (countryColumn) {
            abandonedQuery += `, "${countryColumn}" as territory_country`;
            logger.info(`[Check Expired Territories] ✅ Using country column: ${countryColumn}`);
        } else {
            logger.info(`[Check Expired Territories] ⚠️ No country column found, country will be set to 'unknown' in auctions`);
        }
        
        abandonedQuery += `
            FROM territories
            WHERE ruler_id IS NOT NULL
            AND status = 'ruled'
            AND updated_at < $1
        `;
        
        if (hasLeaseColumn) {
            abandonedQuery += ` AND (lease_ends_at IS NULL OR lease_ends_at > NOW())`;
        }
        
        abandonedQuery += ` LIMIT 100`;
        
        const abandonedTerritories = await query(abandonedQuery, [thirtyDaysAgo]);
        
        let abandonedCount = 0;
        for (const territory of abandonedTerritories.rows) {
            // 경매가 활성화되어 있으면 스킵
            if (territory.current_auction_id) {
                const auctionResult = await query(`
                    SELECT status FROM auctions WHERE id = $1 AND status = 'active'
                `, [territory.current_auction_id]);
                
                if (auctionResult.rows.length > 0) {
                    continue;
                }
            }
            
            // 경매 생성
            const auctionResult = await query(`
                INSERT INTO auctions (
                    territory_id,
                    territory_name,
                    country,
                    status,
                    starting_bid,
                    current_bid,
                    bid_count,
                    created_at,
                    end_time,
                    reason
                ) VALUES ($1, $2, $3, 'active', $4, $4, 0, NOW(), $5, 'abandoned_auto_reauction')
                RETURNING id
            `, [
                territory.id,
                'Territory ' + territory.id,
                (countryColumn && territory.territory_country) ? territory.territory_country : 'unknown',
                territory.territory_price || 100,
                new Date(now.getTime() + 24 * 60 * 60 * 1000)
            ]);
            
            const auctionId = auctionResult.rows[0].id;
            
            await query(`
                UPDATE territories 
                SET current_auction_id = $1,
                    status = 'auction',
                    updated_at = NOW()
                WHERE id = $2
            `, [auctionId, territory.id]);
            
            abandonedCount++;
        }
        
        // 3. 임대 기간 만료된 영토 확인
        // 주의: lease_ends_at 컬럼이 없을 수 있으므로 테이블 존재 여부 확인
        let expiredLeaseCount = 0;
        try {
            // lease_ends_at 컬럼 존재 여부 확인
            const columnCheck = await query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.columns 
                    WHERE table_schema = 'public' 
                    AND table_name = 'territories'
                    AND column_name = 'lease_ends_at'
                )
            `);
            
            if (columnCheck.rows[0].exists) {
                // price 컬럼 확인
                const priceColumnCheck = await query(`
                    SELECT column_name
                    FROM information_schema.columns 
                    WHERE table_schema = 'public' 
                    AND table_name = 'territories'
                    AND column_name IN ('purchased_price', 'base_price', 'price')
                    ORDER BY 
                        CASE column_name
                            WHEN 'purchased_price' THEN 1
                            WHEN 'base_price' THEN 2
                            WHEN 'price' THEN 3
                        END
                    LIMIT 1
                `);
                
                const priceColumn = priceColumnCheck.rows.length > 0 ? priceColumnCheck.rows[0].column_name : 'base_price';
                
                // country 컬럼 확인
                const countryColumnCheck2 = await query(`
                    SELECT column_name
                    FROM information_schema.columns 
                    WHERE table_schema = 'public' 
                    AND table_name = 'territories'
                    AND column_name IN ('country_code', 'country')
                    ORDER BY 
                        CASE column_name
                            WHEN 'country_code' THEN 1
                            WHEN 'country' THEN 2
                        END
                    LIMIT 1
                `);
                
                const countryColumn2 = countryColumnCheck2.rows.length > 0 ? countryColumnCheck2.rows[0].column_name : null;
                
                // 탐지 결과 명확한 로그 출력 (배포 후 확인용)
                logger.info(`[Check Expired Territories - Lease] 🔍 Country column detection: countryColumn=${countryColumn2 || 'null'}, found=${countryColumnCheck2.rows.length > 0}, schema=public, table=territories`);
                
                // 동적 쿼리 구성 (country 컬럼이 없으면 제외)
                let expiredLeasesQuery = `
                    SELECT id, ruler_id, ruler_name, "${priceColumn}" as territory_price
                `;
                
                if (countryColumn2) {
                    expiredLeasesQuery += `, "${countryColumn2}" as territory_country`;
                    logger.info(`[Check Expired Territories - Lease] ✅ Using country column: ${countryColumn2}`);
                } else {
                    logger.info(`[Check Expired Territories - Lease] ⚠️ No country column found, country will be set to 'unknown' in auctions`);
                }
                
                expiredLeasesQuery += `
                    FROM territories
                    WHERE lease_ends_at <= NOW()
                    AND lease_ends_at IS NOT NULL
                    AND ruler_id IS NOT NULL
                    LIMIT 100
                `;
                
                const expiredLeases = await query(expiredLeasesQuery);
                
                for (const territory of expiredLeases.rows) {
                    // 경매 생성
                    const auctionResult = await query(`
                        INSERT INTO auctions (
                            territory_id,
                            territory_name,
                            country,
                            status,
                            starting_bid,
                            current_bid,
                            bid_count,
                            created_at,
                            end_time,
                            reason
                        ) VALUES ($1, $2, $3, 'active', $4, $4, 0, NOW(), $5, 'lease_expired')
                        RETURNING id
                    `, [
                        territory.id,
                        'Territory ' + territory.id,
                        (countryColumn2 && territory.territory_country) ? territory.territory_country : 'unknown',
                        territory.territory_price || 100,
                        new Date(now.getTime() + 24 * 60 * 60 * 1000)
                    ]);
                    
                    const auctionId = auctionResult.rows[0].id;
                    
                    await query(`
                        UPDATE territories 
                        SET ruler_id = NULL,
                            ruler_name = NULL,
                            sovereignty = 'available',
                            status = 'auction',
                            current_auction_id = $1,
                            lease_ends_at = NULL,
                            updated_at = NOW()
                        WHERE id = $2
                    `, [auctionId, territory.id]);
                    
                    expiredLeaseCount++;
                }
            }
        } catch (error) {
            logger.warn('[Check Expired Territories] lease_ends_at column does not exist, skipping lease expiration check');
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
 * 주의: seasons 테이블이 없으면 스킵
 */
async function seasonTransition() {
    try {
        logger.info('[Season Transition] Starting check...');
        
        // seasons 테이블 존재 여부 확인
        const tableCheck = await query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'seasons'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            logger.info('[Season Transition] ⚠️ seasons table does not exist, skipping');
            return {
                success: true,
                skipped: true,
                message: 'seasons table does not exist'
            };
        }
        
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

