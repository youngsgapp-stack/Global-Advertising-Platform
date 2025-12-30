/**
 * Cron Job 라우터
 * Vercel Cron Job에서 호출되는 백엔드 API
 * PostgreSQL + Redis 기반
 */

import express from 'express';
import logger from '../utils/logger.js';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { invalidateAuctionCache, invalidateTerritoryCache } from '../redis/cache-utils.js';
import { broadcastTerritoryUpdate, broadcastAuctionUpdate } from '../websocket/index.js';
import { calculateProtectionEndsAt, logAuctionEndSuccess, finalizeAuctionEnd } from '../utils/auction-utils.js';

const router = express.Router();

/**
 * Cron Job 핸들러
 * GET /api/cron?job=all
 * POST /api/cron?job=all
 */
router.post('/', async (req, res) => {
    try {
        // ⚠️ cron 보안: 서버 내부 시크릿 토큰 체크
        const cronSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
        const providedSecret = req.headers['x-cron-secret'] || req.query.secret || req.body.secret;
        
        if (cronSecret && providedSecret !== cronSecret) {
            logger.warn(`[Cron] Unauthorized access attempt from ${req.ip}`);
            return res.status(401).json({
                success: false,
                error: 'Unauthorized: Invalid cron secret'
            });
        }
        
        const jobType = req.query.job || req.body.job || 'all';
        
        logger.info(`[Cron] Starting job: ${jobType}`, {
            ip: req.ip,
            userAgent: req.get('user-agent'),
            timestamp: new Date().toISOString()
        });
        
        const results = {};
        
        // 모든 작업 실행 또는 특정 작업만 실행
        if (jobType === 'all' || jobType === 'calculate-rankings') {
            results.rankings = await calculateRankings();
        }
        
        if (jobType === 'all' || jobType === 'check-expired') {
            results.expired = await checkExpiredTerritories();
        }
        
        if (jobType === 'all' || jobType === 'end-auctions') {
            results.auctions = await endExpiredAuctions();
        }
        
        if (jobType === 'all' || jobType === 'season-transition') {
            results.season = await seasonTransition();
        }
        
        // ⚠️ 관측성: 실행 결과 로깅 및 집계
        const summary = {
            jobType,
            timestamp: new Date().toISOString(),
            results: {},
            summary: {}
        };
        
        // 결과 요약 생성
        if (results.auctions) {
            summary.summary.auctions = {
                ended: results.auctions.ended || 0,
                errors: results.auctions.errors || 0
            };
        }
        if (results.expired) {
            summary.summary.expired = results.expired.stats || {};
        }
        if (results.rankings) {
            summary.summary.rankings = {
                processed: results.rankings.processed || 0
            };
        }
        
        logger.info('[Cron] Completed:', summary);
        
        // ⚠️ 실패 알림: 에러가 있으면 경고 로그 (향후 슬랙/디스코드 연동 가능)
        const hasErrors = Object.values(results).some(result => 
            result && result.success === false
        );
        if (hasErrors) {
            logger.warn('[Cron] ⚠️ Some jobs failed:', results);
        }
        
        return res.status(200).json({
            success: true,
            jobType,
            results,
            summary: summary.summary,
            timestamp: summary.timestamp
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
        
        // rankings 테이블 존재 여부 확인
        const rankingsTableCheck = await query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'rankings'
            )
        `);
        
        if (!rankingsTableCheck.rows[0].exists) {
            logger.info('[Calculate Rankings] ⚠️ rankings table does not exist, skipping rankings save');
            return {
                success: true,
                skipped: true,
                message: 'rankings table does not exist',
                processed: 0
            };
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
 * 만료된 경매 종료 처리
 * ⚠️ 중요: EMA 계산은 백엔드에서만 수행 (프론트엔드 신뢰 불가)
 */
async function endExpiredAuctions() {
    try {
        // ⚠️ idempotency 로그: runId 생성 (같은 실행 묶음 추적)
        const runId = `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        logger.info(`[End Expired Auctions] Starting check... [runId: ${runId}]`);
        
        const client = await getPool().connect();
        let endedCount = 0;
        let errorCount = 0;
        const endedAuctionIds = []; // ⚠️ idempotency 로그: 종료 처리한 auction ID 목록
        const updatedTerritoryIds = []; // ⚠️ idempotency 로그: 시장가 갱신된 territory ID 목록
        const MAX_LOG_IDS = 10; // 상위 10개만 로그에 기록, 나머지는 카운트만
        
        try {
            // ⚠️ 입찰 시도로 큐에 추가된 경매도 함께 처리
            // ⚠️ 큐는 Redis Set으로 운영 (중복 자동 방지)
            const pendingEndIds = await redis.smembers('auctions:pending-end');
            const queueSize = pendingEndIds ? pendingEndIds.length : 0;
            
            // ⚠️ 큐 크기 모니터링: 길이가 계속 증가하면 경고 로그
            if (queueSize > 50) {
                logger.warn(`[End Expired Auctions] ⚠️ Queue size is large: ${queueSize} auctions pending. This may indicate cron issues.`);
            } else if (queueSize > 0) {
                logger.info(`[End Expired Auctions] Found ${queueSize} auctions in pending-end queue [runId: ${runId}]`);
            }
            
            // 종료 시간이 지났지만 아직 active 상태인 경매 조회
            // 큐에 있는 경매도 포함 (OR 조건 추가)
            const expiredAuctions = await query(`
                SELECT 
                    a.id,
                    a.territory_id,
                    a.current_bid,
                    a.current_bidder_id,
                    a.protection_days,
                    t.market_base_price,
                    t.base_price,
                    t.ruler_id as current_owner_id,
                    u.nickname as bidder_nickname,
                    u.firebase_uid as bidder_firebase_uid
                FROM auctions a
                LEFT JOIN territories t ON a.territory_id = t.id
                LEFT JOIN users u ON a.current_bidder_id = u.id
                WHERE a.status = 'active'
                AND (
                    a.end_time <= NOW()
                    ${pendingEndIds && pendingEndIds.length > 0 ? `OR a.id = ANY($1::uuid[])` : ''}
                )
                ORDER BY a.end_time ASC
                LIMIT 50
            `, pendingEndIds && pendingEndIds.length > 0 ? [pendingEndIds] : []);
            
            logger.info(`[End Expired Auctions] Found ${expiredAuctions.rows.length} expired auctions`);
            
            for (const auction of expiredAuctions.rows) {
                await client.query('BEGIN');
                
                try {
                    // ⚠️ 트랜잭션 경합 방지: status='active' 조건으로 중복 종료 방지
                    const updateResult = await client.query(`
                        UPDATE auctions 
                        SET status = 'ended', 
                            ended_at = NOW(),
                            updated_at = NOW()
                        WHERE id = $1 
                        AND status = 'active'
                        RETURNING *
                    `, [auction.id]);
                    
                    // 영향받은 row가 0이면 이미 종료된 경매 (다른 프로세스가 처리)
                    if (updateResult.rows.length === 0) {
                        await client.query('ROLLBACK');
                        logger.info(`[End Expired Auctions] Auction ${auction.id} already ended by another process [runId: ${runId}]`);
                        // 큐에서 제거 (이미 처리됨)
                        await redis.srem('auctions:pending-end', auction.id);
                        continue;
                    }
                    
                    // ⚠️ 전문가 조언 반영: 공통 종료 함수 사용
                    // auction 객체 구조 맞추기 (finalizeAuctionEnd가 필요로 하는 필드)
                    const auctionForFinalize = {
                        ...auction,
                        status: 'active', // 아직 처리 전이므로 active로 설정 (finalizeAuctionEnd 내부에서 ended로 변경)
                        market_base_price: auction.market_base_price,
                        base_price: auction.base_price
                    };
                    
                    const endResult = await finalizeAuctionEnd({
                        client,
                        auctionId: auction.id,
                        auction: auctionForFinalize,
                        source: 'cron'
                    });
                    
                    const { hasWinner, finalBid, finalBidderId, finalBidderNickname, protectionEndsAt, newMarketBase } = endResult;
                    
                    // ✅ 성공 로그 출력
                    logAuctionEndSuccess({
                        auctionId: auction.id,
                        territoryId: auction.territory_id,
                        winnerUserId: finalBidderId || null,
                        protectionEndsAt: protectionEndsAt || null,
                        processingTimeMs: 0, // cron은 배치 처리이므로 개별 시간 측정 생략
                        source: 'cron'
                    });
                    
                    if (hasWinner) {
                        logger.info(`[End Expired Auctions] ✅ Auction ${auction.id} ended. Winner: ${finalBidderNickname} (${finalBidderId}), Bid: ${finalBid}, Market base: ${newMarketBase}`);
                        
                        // ⚠️ idempotency 로그: 시장가 갱신된 territory ID 기록
                        if (updatedTerritoryIds.length < MAX_LOG_IDS) {
                            updatedTerritoryIds.push(auction.territory_id);
                        }
                    } else {
                        logger.info(`[End Expired Auctions] ✅ Auction ${auction.id} ended with no winner. Territory ${auction.territory_id} restored.`);
                    }
                    
                    // 큐에서 제거 (처리 완료)
                    await redis.srem('auctions:pending-end', auction.id);
                    
                    await client.query('COMMIT');
                    endedCount++;
                    
                    // ⚠️ 캐시 무효화
                    await invalidateAuctionCache(auction.id, auction.territory_id);
                    await invalidateTerritoryCache(auction.territory_id);
                    
                    // ⚠️ WebSocket 브로드캐스트 순서 및 payload 보완
                    // 순서: 1) auction ended, 2) territory 업데이트 (새 ruler, market_base_price, protectionEndsAt)
                    try {
                        // 1단계: 경매 종료 브로드캐스트
                        await broadcastAuctionUpdate({
                            id: auction.id,
                            status: 'ended',
                            territoryId: auction.territory_id,
                            finalBid: hasWinner ? finalBid : null,
                            winnerId: hasWinner ? auction.current_bidder_id : null,
                            winnerName: hasWinner ? auction.bidder_nickname : null
                        });
                        
                        // 2단계: 영토 업데이트 브로드캐스트 (market_base_price 포함)
                        // 최신 영토 정보 조회
                        const updatedTerritory = await query(`
                            SELECT 
                                id as territoryId,
                                market_base_price,
                                base_price,
                                sovereignty,
                                status,
                                current_auction_id,
                                ruler_id,
                                ruler_name as ruler,
                                protection_ends_at as protectionEndsAt
                            FROM territories
                            WHERE id = $1
                        `, [auction.territory_id]);
                        
                        if (updatedTerritory.rows.length > 0) {
                            const territory = updatedTerritory.rows[0];
                            await broadcastTerritoryUpdate(auction.territory_id, {
                                territoryId: territory.territoryid,
                                market_base_price: parseFloat(territory.market_base_price || 0),
                                base_price: parseFloat(territory.base_price || 0),
                                sovereignty: territory.sovereignty,
                                status: territory.status,
                                current_auction_id: territory.current_auction_id,
                                ruler: territory.ruler,
                                ruler_id: territory.ruler_id,
                                protectionEndsAt: territory.protectionendsat
                            });
                        } else {
                            // 영토 정보가 없으면 기본 브로드캐스트
                            await broadcastTerritoryUpdate(auction.territory_id);
                        }
                    } catch (wsError) {
                        // ⚠️ 브로드캐스트 실패 로그는 반드시 남기기 (UI 싱크 문제 디버깅의 핵심)
                        logger.error(`[End Expired Auctions] ❌ WebSocket broadcast failed for auction ${auction.id}, territory ${auction.territory_id}:`, {
                            error: wsError.message,
                            stack: wsError.stack,
                            auctionId: auction.id,
                            territoryId: auction.territory_id,
                            runId: runId
                        });
                    }
                    
                } catch (error) {
                    await client.query('ROLLBACK');
                    logger.error(`[End Expired Auctions] Error ending auction ${auction.id}:`, error);
                    errorCount++;
                }
            }
            
        } finally {
            client.release();
        }
        
        // ⚠️ 관측성: 상세 결과 로깅 (idempotency 로그 포함)
        const result = {
            success: true,
            ended: endedCount,
            errors: errorCount,
            timestamp: new Date().toISOString(),
            runId: runId, // ⚠️ idempotency 로그: runId 추가 (같은 실행 묶음 추적)
            // ⚠️ idempotency 로그: 처리한 auction/territory ID 목록 (최대 10개)
            endedAuctionIds: endedAuctionIds.length > 0 ? endedAuctionIds : undefined,
            updatedTerritoryIds: updatedTerritoryIds.length > 0 ? updatedTerritoryIds : undefined,
            // 나머지는 카운트만
            totalEndedAuctions: endedCount,
            totalUpdatedTerritories: updatedTerritoryIds.length + (endedCount > MAX_LOG_IDS ? endedCount - MAX_LOG_IDS : 0)
        };
        
        logger.info(`[End Expired Auctions] ✅ Completed. Ended: ${endedCount}, Errors: ${errorCount} [runId: ${runId}]`, {
            ...result,
            // 상세 ID 목록은 별도 로그로 (너무 길어질 수 있으므로)
            detail: {
                endedAuctionIds: endedAuctionIds.length > 0 ? endedAuctionIds : 'none',
                updatedTerritoryIds: updatedTerritoryIds.length > 0 ? updatedTerritoryIds : 'none',
                moreAuctions: endedCount > MAX_LOG_IDS ? `${endedCount - MAX_LOG_IDS} more` : 'none'
            }
        });
        
        // 에러가 있으면 경고
        if (errorCount > 0) {
            logger.warn(`[End Expired Auctions] ⚠️ ${errorCount} errors occurred during processing [runId: ${runId}]`);
        }
        
        return result;
        
    } catch (error) {
        logger.error('[End Expired Auctions] Error:', error);
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

