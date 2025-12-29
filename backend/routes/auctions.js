/**
 * Auctions API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateAuctionCache, invalidateTerritoryCache, invalidatePixelCache, invalidateCachePattern } from '../redis/cache-utils.js';
import { broadcastBidUpdate, broadcastTerritoryUpdate, broadcastAuctionUpdate } from '../websocket/index.js';
import { serializeAuction, serializeAuctions } from '../utils/auction-serializer.js';
import { calculateProtectionEndsAt, logAuctionEndSuccess } from '../utils/auction-utils.js';

const router = express.Router();

/**
 * GET /api/auctions/:id
 * 경매 상세 조회
 * ⚠️ 전문가 조언 반영: POST /bids와 동일한 기준으로 최신 입찰 상태 반영
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // ⚠️ 체크 A: 데이터 출처 로그
        console.debug(`[GET auction] id=${id}`);
        
        // Redis에서 먼저 조회
        const cacheKey = `auction:${id}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            // ⚠️ 수정: Redis 캐시는 JSON 문자열이므로 파싱 필요
            let parsedCache;
            try {
                // 캐시가 이미 객체인 경우와 문자열인 경우 모두 처리
                parsedCache = typeof cached === 'string' ? JSON.parse(cached) : cached;
                console.debug(`[GET auction] source=redis key=${cacheKey}, currentBid=${parsedCache.currentBid}, minNextBid=${parsedCache.minNextBid}`);
            } catch (parseError) {
                console.error(`[GET auction] Failed to parse cache for ${id}:`, parseError);
                // 파싱 실패 시 캐시 무효화하고 DB에서 재조회
                await redis.del(cacheKey);
                parsedCache = null;
            }
            
            if (!parsedCache) {
                // 파싱 실패로 인해 캐시가 무효화된 경우, DB 조회로 계속 진행
                console.debug(`[GET auction] Cache invalidated due to parse error, falling back to DB`);
            } else {
            
            // ⚠️ 중요: 캐시된 데이터도 최신 입찰 상태를 반영해야 함
            // 캐시는 빠른 응답용이지만, 입찰 상태는 항상 DB에서 최신 확인 필요
            // 따라서 캐시가 있어도 DB에서 최고 입찰을 확인하여 재계산
            const highestBidResult = await query(
                `SELECT MAX(amount) as max_amount FROM bids WHERE auction_id = $1`,
                [id]
            );
            const highestBidFromDB = highestBidResult.rows[0]?.max_amount ? parseFloat(highestBidResult.rows[0].max_amount) : null;
            
            // ⚠️ 체크 B: DB 최고 입찰 vs 캐시 currentBid 비교
            const cachedCurrentBid = parseFloat(parsedCache.currentBid || 0);
            console.debug(`[GET auction] DB highestBid=${highestBidFromDB}, cached currentBid=${cachedCurrentBid}`);
            
            // ⚠️ 전문가 조언 반영: DB 최고 입찰이 캐시보다 높으면 항상 재계산
            // 또는 캐시에 minNextBid가 없으면 재계산
            if (highestBidFromDB && highestBidFromDB > cachedCurrentBid) {
                console.debug(`[GET auction] ⚠️ Cache stale: DB has higher bid (${highestBidFromDB} > ${cachedCurrentBid}), recalculating`);
                // 캐시 무효화하고 DB에서 재조회
                await redis.del(cacheKey);
            } else if (!parsedCache.minNextBid || !parsedCache.increment) {
                // 캐시에 minNextBid/increment가 없으면 재계산
                console.debug(`[GET auction] ⚠️ Cache missing minNextBid/increment, recalculating`);
                await redis.del(cacheKey);
            } else {
                // 캐시가 최신이면 minNextBid/increment만 보완해서 반환
                const increment = 1;
                const effectiveCurrentBid = highestBidFromDB || cachedCurrentBid || parseFloat(parsedCache.startingBid || 0);
                const minNextBid = effectiveCurrentBid + increment;
                
                // ⚠️ 중요: 캐시된 currentBid와 DB 최고 입찰 중 더 큰 값 사용
                const finalCurrentBid = Math.max(effectiveCurrentBid, cachedCurrentBid);
                const finalMinNextBid = finalCurrentBid + increment;
                
                console.debug(`[GET auction] Using cache with DB validation: currentBid=${finalCurrentBid}, minNextBid=${finalMinNextBid}`);
                
                return res.json({
                    ...parsedCache,
                    currentBid: finalCurrentBid,
                    minNextBid: finalMinNextBid,
                    increment: increment
                });
            }
            }
        }
        
        // DB에서 조회 (캐시 없거나 stale인 경우)
        console.debug(`[GET auction] source=db id=${id}`);
        
        // ⚠️ 전문가 조언 반영: bids 테이블에서 최고 입찰 조회
        const highestBidResult = await query(
            `SELECT MAX(amount) as max_amount FROM bids WHERE auction_id = $1`,
            [id]
        );
        const highestBidFromDB = highestBidResult.rows[0]?.max_amount ? parseFloat(highestBidResult.rows[0].max_amount) : null;
        
        // 경매 기본 정보 조회
        const result = await query(
            `SELECT 
                a.*,
                u.nickname as bidder_nickname,
                t.name as territory_name,
                t.code as territory_code,
                t.base_price,
                t.market_base_price
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            LEFT JOIN territories t ON a.territory_id = t.id
            WHERE a.id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const row = result.rows[0];
        
        // ⚠️ 체크 B: auctions 테이블의 current_bid vs bids 테이블의 최고 입찰 비교
        const storedCurrentBid = parseFloat(row.current_bid || 0);
        console.debug(`[GET auction] stored currentBid=${storedCurrentBid}, DB highestBid=${highestBidFromDB}`);
        
        // ⚠️ 전문가 조언 반영: 최신 입찰 상태 반영
        // DB의 current_bid와 bids 테이블의 최고 입찰 중 더 큰 값을 사용
        const effectiveCurrentBid = highestBidFromDB && highestBidFromDB > storedCurrentBid
            ? highestBidFromDB
            : storedCurrentBid;
        
        // ⚠️ 전문가 조언 반영: minNextBid 계산 (POST /bids와 동일한 로직)
        const increment = 1; // 고정 증가액
        const startingBid = parseFloat(row.min_bid || 0);
        const minNextBid = effectiveCurrentBid > 0
            ? effectiveCurrentBid + increment
            : startingBid + increment;
        
        // ⚠️ 체크 C: minNextBid/increment 계산 결과 로그
        console.debug(`[GET auction] calculated: effectiveCurrentBid=${effectiveCurrentBid}, startingBid=${startingBid}, minNextBid=${minNextBid}, increment=${increment}`);
        
        // row에 계산된 값 추가
        const enrichedRow = {
            ...row,
            current_bid: effectiveCurrentBid,
            minNextBid: minNextBid,
            increment: increment
        };
        
        // ⚠️ 재발 방지: serializer를 통한 일관된 변환
        const auction = serializeAuction(enrichedRow);
        
        // ⚠️ 중요: minNextBid와 increment는 serializer에서 추가되지 않으므로 여기서 명시적으로 추가
        auction.minNextBid = minNextBid;
        auction.increment = increment;
        
        // Redis에 캐시 (변환된 형식으로, JSON 문자열로 저장)
        await redis.set(cacheKey, JSON.stringify(auction), CACHE_TTL.AUCTION);
        
        res.json(auction);
    } catch (error) {
        console.error('[Auctions] GET /:id Error:', error);
        console.error('[Auctions] Error stack:', error.stack);
        console.error('[Auctions] Error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail
        });
        res.status(500).json({ 
            error: 'Failed to fetch auction',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/auctions
 * 경매 생성
 */
router.post('/', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const {
            territoryId,
            startingBid,
            minBid,
            endTime,
            protectionDays,
            type = 'standard'
        } = req.body;
        const firebaseUid = req.user.uid;
        
        if (!territoryId) {
            return res.status(400).json({ error: 'Territory ID is required' });
        }
        
        if (!startingBid || startingBid <= 0) {
            return res.status(400).json({ error: 'Valid starting bid is required' });
        }
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 1. 영토 정보 조회
        const territoryResult = await client.query(
            `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Territory not found' });
        }
        
        const territory = territoryResult.rows[0];
        
        // ⚠️ 전문가 조언 반영: countryIso 필수 검증
        // 경매 생성 시 countryIso가 없으면 경매를 생성할 수 없음
        const countryIso = territory.country_iso;
        if (!countryIso || countryIso.length !== 3) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ 
                error: 'Cannot create auction: countryIso is required',
                message: `Territory ${territoryId} must have a valid countryIso (ISO 3166-1 alpha-3). Got: ${countryIso || 'null'}. Territory must have valid country information.`,
                territoryId,
                countryIso: countryIso || null
            });
        }
        
        // 2. 영토 상태 확인 - ruled, protected, 또는 unconquered 상태에서 경매 시작 가능
        // ⚠️ 중요: Protected 상태에서도 경매 시작 가능
        // 보호 기간은 소유권 보호용이며, 경매는 보호 기간 중에도 누구나 시작 가능
        // contested 상태는 이미 경매가 진행 중이므로 불가
        if (territory.status === 'contested') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Auction already in progress' });
        }
        
        if (territory.status !== 'ruled' && territory.status !== 'protected' && territory.status !== 'unconquered') {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `Territory must be in ruled, protected, or unconquered status to start auction. Current status: ${territory.status}`
            });
        }
        
        // 5. 이미 활성 경매가 있는지 확인
        const existingAuctionResult = await client.query(
            `SELECT id FROM auctions 
             WHERE territory_id = $1 AND status = 'active'`,
            [territoryId]
        );
        
        if (existingAuctionResult.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Active auction already exists for this territory' });
        }
        
        // 6. 사용자 정보 조회
        let userId;
        const userResult = await client.query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            // 사용자가 없으면 생성
            const newUserResult = await client.query(
                `INSERT INTO users (firebase_uid, email) 
                 VALUES ($1, $2) 
                 RETURNING id`,
                [firebaseUid, req.user.email]
            );
            userId = newUserResult.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }
        
        // 7. 소유자 확인 제거 - 보호 기간이 지나면 누구나 경매 시작 가능
        // (Protected 상태는 이미 위에서 체크했으므로, 여기까지 오면 보호 기간이 지난 상태)
        
        // 8. 경매 종료 시간 결정
        let auctionEndTime = endTime;
        if (!auctionEndTime) {
            // 기본값: 24시간 후
            const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
            auctionEndTime = endDate.toISOString();
        }
        
        // 9. 경매 생성
        const auctionResult = await client.query(
            `INSERT INTO auctions (
                territory_id, 
                status, 
                start_time, 
                end_time, 
                min_bid, 
                current_bid,
                country,
                created_at,
                updated_at
            )
            VALUES ($1, 'active', NOW(), $2, $3, $4, $5, NOW(), NOW())
            RETURNING *`,
            [
                territoryId,
                auctionEndTime,
                minBid || startingBid,
                startingBid,
                countryIso // ⚠️ 중요: countryIso 사용 (ISO 3166-1 alpha-3)
            ]
        );
        
        const auction = auctionResult.rows[0];
        
        // 10. 영토 상태 업데이트 (미점유 영토인 경우 CONTESTED로 변경)
        if (!territory.ruler_id && territory.status === 'unconquered') {
            await client.query(
                `UPDATE territories 
                 SET status = 'contested',
                     current_auction_id = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [auction.id, territoryId]
            );
        } else {
            // 이미 소유된 영토는 current_auction_id만 업데이트
            await client.query(
                `UPDATE territories 
                 SET current_auction_id = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [auction.id, territoryId]
            );
        }
        
        await client.query('COMMIT');
        
        // Redis 캐시 무효화
        await invalidateAuctionCache(auction.id, territoryId);
        
        // ⚠️ 재발 방지: serializer를 통한 일관된 변환
        const serializedAuction = serializeAuction(auction);
        
        // WebSocket 브로드캐스트
        broadcastAuctionUpdate(auction.id, serializedAuction);
        
        broadcastTerritoryUpdate(territoryId, {
            id: territoryId,
            currentAuctionId: auction.id,
            status: territory.ruler_id ? territory.status : 'contested',
            updatedAt: new Date().toISOString()
        });
        
        // ⚠️ 재발 방지: 위에서 이미 serialize한 객체 재사용
        res.json({
            success: true,
            auction: serializedAuction
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Auctions] Create error:', error);
        res.status(500).json({ error: 'Failed to create auction' });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/auctions/:id
 * 경매 업데이트
 */
router.put('/:id', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: auctionId } = req.params;
        const {
            currentBid,
            startingBid,
            minBid,
            currentBidderId,
            status,
            endTime
        } = req.body;
        
        await client.query('BEGIN');
        
        // 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        
        // 업데이트할 필드 구성
        const updates = [];
        const params = [];
        let paramIndex = 1;
        
        if (currentBid !== undefined) {
            updates.push(`current_bid = $${paramIndex}`);
            params.push(currentBid);
            paramIndex++;
        }
        
        if (startingBid !== undefined || minBid !== undefined) {
            updates.push(`min_bid = $${paramIndex}`);
            params.push(startingBid || minBid);
            paramIndex++;
        }
        
        if (currentBidderId !== undefined) {
            updates.push(`current_bidder_id = $${paramIndex}`);
            params.push(currentBidderId);
            paramIndex++;
        }
        
        if (status !== undefined) {
            updates.push(`status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }
        
        if (endTime !== undefined) {
            updates.push(`end_time = $${paramIndex}`);
            params.push(endTime);
            paramIndex++;
        }
        
        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        updates.push(`updated_at = NOW()`);
        params.push(auctionId);
        
        // 경매 업데이트
        const updateResult = await client.query(
            `UPDATE auctions 
             SET ${updates.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING *`,
            params
        );
        
        await client.query('COMMIT');
        
        const updatedAuction = updateResult.rows[0];
        
        // Redis 캐시 무효화
        await invalidateAuctionCache(auctionId, auction.territory_id);
        
        // WebSocket 브로드캐스트
        broadcastAuctionUpdate(auctionId, {
            id: updatedAuction.id,
            currentBid: parseFloat(updatedAuction.current_bid || 0),
            startingBid: parseFloat(updatedAuction.min_bid || 0),
            currentBidderId: updatedAuction.current_bidder_id,
            status: updatedAuction.status,
            updatedAt: updatedAuction.updated_at
        });
        
        res.json({
            success: true,
            auction: {
                id: updatedAuction.id,
                territoryId: updatedAuction.territory_id,
                status: updatedAuction.status,
                startingBid: parseFloat(updatedAuction.min_bid || 0),
                currentBid: parseFloat(updatedAuction.current_bid || 0),
                currentBidderId: updatedAuction.current_bidder_id,
                updatedAt: updatedAuction.updated_at
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Auctions] Update error:', error);
        res.status(500).json({ error: 'Failed to update auction' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/auctions/:id/bids
 * 입찰 생성
 */
router.post('/:id/bids', async (req, res) => {
    const client = await getPool().connect();
    
    try {
        const { id: auctionId } = req.params;
        const { amount } = req.body;
        const firebaseUid = req.user.uid;
        
        // ⚠️ 디버깅 로그: 서버에서 받은 요청 확인 (가장 중요)
        console.log('[Bid] REQUEST BODY', { 
            amount: req.body.amount, 
            amountType: typeof req.body.amount,
            auctionId: req.params.id,
            bodyKeys: Object.keys(req.body)
        });
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid bid amount' });
        }
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 1. 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        
        // 2. 유효성 검사
        if (auction.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Auction is not active' });
        }
        
        // ⚠️ 중요: endTime이 지났으면 즉시 종료 처리 (cron 지연 보완)
        const now = new Date();
        const endTime = new Date(auction.end_time);
        if (endTime < now) {
            await client.query('ROLLBACK');
            
            // ⚠️ 즉시 종료 처리를 위한 가벼운 트리거 (Redis 큐)
            // cron 누락 시에도 자연 회복성 확보, UX 개선 (화면 갱신 시간 단축)
            try {
                // Redis에 종료 대기 경매 ID 추가 (중복 방지: SET 사용)
                await redis.sadd('auctions:pending-end', auctionId);
                // TTL 설정 (1시간 후 자동 삭제, cron이 처리하면 바로 삭제됨)
                await redis.expire('auctions:pending-end', 3600);
            } catch (queueError) {
                // 큐 추가 실패해도 입찰 거부는 정상 처리 (cron이 곧 처리할 것)
                console.warn(`[Auctions] Failed to queue auction ${auctionId} for immediate end:`, queueError);
            }
            
            return res.status(400).json({ 
                error: 'Auction has ended',
                endedAt: auction.end_time,
                message: 'This auction has ended. The results will be finalized shortly.'
            });
        }
        
        // ⚠️ 전문가 조언 반영: 최소 입찰가 계산 로직 단일화 (서버 권위)
        // - DB의 bids 테이블에서 최고 입찰가 조회 (FOR UPDATE로 동시성 안전)
        // - 입찰이 없으면 territoryPrice (min_bid) 기준
        // - increment는 1pt로 고정
        const bidsResult = await client.query(
            `SELECT MAX(amount) as highest_bid FROM bids WHERE auction_id = $1`,
            [auctionId]
        );
        
        const highestBid = bidsResult.rows[0]?.highest_bid;
        const currentBid = highestBid ? parseFloat(highestBid) : 0;
        const startingBid = parseFloat(auction.min_bid || 0);
        const increment = 1; // 1pt 고정
        
        // minNextBid 계산: 입찰이 있으면 최고입찰가 + 1pt, 없으면 startingBid
        const minNextBid = currentBid > 0 
            ? currentBid + increment 
            : startingBid;
        
        console.log(`[Auctions] Bid validation for ${auctionId}:`, {
            highestBid,
            currentBid,
            startingBid,
            minNextBid,
            bidAmount: amount
        });
        
        if (amount < minNextBid) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Bid amount too low',
                minNextBid,
                currentBid,
                increment,
                message: `Minimum bid is ${minNextBid} pt (current: ${currentBid} pt, increment: ${increment} pt)`
            });
        }
        
        // 3. 사용자 정보 조회 (users 테이블에서 firebase_uid로 찾기)
        let userId;
        const userResult = await client.query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            // 사용자가 없으면 생성
            const newUserResult = await client.query(
                `INSERT INTO users (firebase_uid, email) 
                 VALUES ($1, $2) 
                 RETURNING id`,
                [firebaseUid, req.user.email]
            );
            userId = newUserResult.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }
        
        // 4. 입찰 생성
        const bidResult = await client.query(
            `INSERT INTO bids (auction_id, user_id, amount)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [auctionId, userId, amount]
        );
        
        // 5. 경매 정보 업데이트
        await client.query(
            `UPDATE auctions 
             SET current_bid = $1, 
                 current_bidder_id = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [amount, userId, auctionId]
        );
        
        // 6. 영토 정보 업데이트 (캐시 무효화를 위해)
        const territoryUpdateResult = await client.query(
            `UPDATE territories 
             SET updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [auction.territory_id]
        );
        
        // 트랜잭션 커밋
        await client.query('COMMIT');
        
        // Redis 캐시 무효화
        await invalidateAuctionCache(auctionId, auction.territory_id);
        
        // WebSocket으로 입찰 업데이트 브로드캐스트
        broadcastBidUpdate({
            auctionId,
            territoryId: auction.territory_id,
            amount,
            bidderId: userId,
            bidderNickname: req.user.name || req.user.email,
        });
        
        // 경매 업데이트 브로드캐스트
        const userInfoResult = await query(
            `SELECT nickname, email FROM users WHERE id = $1`,
            [userId]
        );
        broadcastAuctionUpdate(auctionId, {
            currentBid: amount,
            currentBidderId: userId,
            currentBidderNickname: userInfoResult.rows[0]?.nickname || req.user.email,
            updatedAt: new Date().toISOString()
        });
        
        // 영토 업데이트도 브로드캐스트 (입찰로 인한 영토 상태 변경 반영)
        if (territoryUpdateResult.rows.length > 0) {
            const territory = territoryUpdateResult.rows[0];
            
            // 사용자 정보 조회
            const userInfoResult = await query(
                `SELECT nickname, email FROM users WHERE id = $1`,
                [userId]
            );
            
            // 입찰 업데이트 브로드캐스트
            broadcastBidUpdate({
                auctionId: auctionId,
                territoryId: auction.territory_id,
                amount: amount,
                bidderId: userId,
                bidderNickname: userInfoResult.rows[0]?.nickname || req.user.email
            });
            
            // 경매 업데이트 브로드캐스트
            broadcastAuctionUpdate(auctionId, {
                currentBid: amount,
                currentBidderId: userId,
                currentBidderNickname: userInfoResult.rows[0]?.nickname || req.user.email,
                updatedAt: new Date().toISOString()
            });
            
            // 영토 업데이트 브로드캐스트
            broadcastTerritoryUpdate(auction.territory_id, {
                id: territory.id,
                status: territory.status,
                rulerId: territory.ruler_id,
                rulerNickname: userInfoResult.rows[0]?.nickname || req.user.email,
                updatedAt: territory.updated_at,
                currentAuctionId: auctionId
            });
        }
        
        // ⚠️ 전문가 조언 반영: 응답에 minNextBid 포함 (프론트에서 계산하지 않도록)
        const newMinNextBid = amount + increment;
        
        // ⚠️ 재발 방지: serializer를 통한 일관된 변환 + 추가 필드
        const serializedAuction = serializeAuction({
            ...auction,
            current_bid: amount, // 업데이트된 입찰가
            current_bidder_id: userId
        });
        
        // minNextBid와 increment는 serializer에 없으므로 추가
        serializedAuction.minNextBid = newMinNextBid;
        serializedAuction.increment = increment;
        
        res.json({
            success: true,
            bid: bidResult.rows[0],
            auction: serializedAuction
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Auctions] Bid error:', error);
        res.status(500).json({ error: 'Failed to place bid' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/auctions/:id/end
 * 경매 수동 종료 (관리자 또는 경매 생성자만 가능)
 * ⚠️ 전문가 조언 반영: Firestore runTransaction 대신 API 사용
 */
router.post('/:id/end', async (req, res) => {
    // ✅ 변수 스코프 문제 해결: 함수 최상단에 선언
    const { id: auctionId } = req.params;
    const startTime = Date.now(); // 처리 시간 측정
    const client = await getPool().connect();
    
    try {
        const firebaseUid = req.user.uid;
        
        // 트랜잭션 시작
        await client.query('BEGIN');
        
        // 1. 경매 정보 조회 (FOR UPDATE는 auctions 테이블에만 적용)
        const auctionResult = await client.query(
            `SELECT 
                a.*,
                t.base_price,
                t.market_base_price,
                t.ruler_id as current_owner_id,
                t.ruler_name as current_owner_name,
                u.nickname as bidder_nickname,
                u.firebase_uid as bidder_firebase_uid
            FROM auctions a
            LEFT JOIN territories t ON a.territory_id = t.id
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.id = $1
            FOR UPDATE OF a`,
            [auctionId]
        );
        
        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = auctionResult.rows[0];
        
        // 2. 이미 종료된 경매인지 확인 (멱등성 보장)
        if (auction.status === 'ended') {
            await client.query('ROLLBACK');
            // 이미 종료된 경우 200 OK로 반환 (멱등성)
            return res.json({
                success: true,
                message: 'Auction already ended',
                auction: {
                    id: auctionId,
                    status: 'ended',
                    endedAt: auction.end_time
                }
            });
        }
        
        if (auction.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Auction is not active',
                status: auction.status
            });
        }
        
        // 3. 권한 확인 (관리자 또는 경매 생성자만 종료 가능)
        // TODO: 경매 생성자 확인 로직 추가 필요 (auctions 테이블에 created_by 필드가 있다면)
        // 현재는 관리자만 허용
        const isAdmin = firebaseUid && (
            firebaseUid.startsWith('admin_') ||
            req.user.email?.includes('admin')
        );
        
        if (!isAdmin) {
            await client.query('ROLLBACK');
            return res.status(403).json({ 
                error: 'Only admins can manually end auctions'
            });
        }
        
        // 4. 경매 종료 처리 (cron.js의 endExpiredAuctions 로직 참고)
        // ⚠️ 레이스 방어: bids 테이블에서 최종 승자 재확인 (종료 직전 입찰 방어)
        // 종료 시간 이전의 입찰만 유효 (DB 기준으로 확정)
        // ✅ 개선: winning_bid_id도 함께 가져와서 원자적으로 승자 확정
        const bidsResult = await client.query(
            `SELECT 
                id,
                amount,
                user_id,
                created_at
            FROM bids 
            WHERE auction_id = $1 
                AND created_at <= (SELECT end_time FROM auctions WHERE id = $1)
            ORDER BY amount DESC, created_at ASC
            LIMIT 1`,
            [auctionId]
        );
        
        // 최종 승자 결정: bids 테이블의 최고 입찰 vs auctions 테이블의 current_bid
        let finalBid = parseFloat(auction.current_bid || 0);
        let finalBidderId = auction.current_bidder_id;
        let finalBidderNickname = auction.bidder_nickname;
        let winningBidId = null;
        
        if (bidsResult.rows.length > 0) {
            const highestBidFromBids = parseFloat(bidsResult.rows[0].amount || 0);
            if (highestBidFromBids > finalBid) {
                // bids 테이블에 더 높은 입찰이 있으면 그것을 사용
                finalBid = highestBidFromBids;
                finalBidderId = bidsResult.rows[0].user_id;
                winningBidId = bidsResult.rows[0].id;
                
                // 입찰자 정보 재조회
                const bidderInfoResult = await client.query(
                    `SELECT nickname, firebase_uid FROM users WHERE id = $1`,
                    [finalBidderId]
                );
                if (bidderInfoResult.rows.length > 0) {
                    finalBidderNickname = bidderInfoResult.rows[0].nickname || 'Unknown';
                }
            } else if (finalBid > 0) {
                // current_bid가 더 높은 경우, 해당 입찰을 찾아서 winning_bid_id 설정
                const currentBidResult = await client.query(
                    `SELECT id FROM bids 
                     WHERE auction_id = $1 AND amount = $2 AND user_id = $3
                     ORDER BY created_at ASC
                     LIMIT 1`,
                    [auctionId, finalBid, finalBidderId]
                );
                if (currentBidResult.rows.length > 0) {
                    winningBidId = currentBidResult.rows[0].id;
                }
            }
        }
        
        const hasWinner = finalBidderId && finalBid > 0;
        
        // ✅ 개선: 승자 확정값을 원자적으로 저장 (winning_bid_id, winner_user_id, winning_amount)
        // 경매 상태를 ended로 업데이트하고 승자 확정값 저장
        await client.query(
            `UPDATE auctions 
             SET status = 'ended', 
                 ended_at = NOW(),
                 updated_at = NOW(),
                 current_bid = $1,
                 current_bidder_id = $2,
                 winning_bid_id = $3,
                 winner_user_id = $4,
                 winning_amount = $5
             WHERE id = $6`,
            [finalBid, finalBidderId, winningBidId, hasWinner ? finalBidderId : null, hasWinner ? finalBid : null, auctionId]
        );
        
        // 5. 영토 소유권 이전 전에 territories 테이블 락 (동시성 보장)
        if (hasWinner && auction.territory_id) {
            const territoryLockResult = await client.query(
                `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
                [auction.territory_id]
            );
            
            if (territoryLockResult.rows.length === 0) {
                await client.query('ROLLBACK');
                console.error(`[Auctions] Territory ${auction.territory_id} not found for auction ${auctionId}`);
                return res.status(404).json({ 
                    error: 'Territory not found',
                    territoryId: auction.territory_id
                });
            }
        }
        
        if (hasWinner) {
            // 낙찰자가 있는 경우: 소유권 이전 및 market_base_price 갱신
            let currentMarketBase = parseFloat(auction.market_base_price || auction.base_price || 0);
            
            if (!currentMarketBase || currentMarketBase <= 0) {
                currentMarketBase = parseFloat(auction.base_price || finalBid || 100);
            }
            
            // EMA 계산
            const EMA_WEIGHT_OLD = 0.7;
            const EMA_WEIGHT_NEW = 0.3;
            const rawEMA = currentMarketBase * EMA_WEIGHT_OLD + finalBid * EMA_WEIGHT_NEW;
            const CAP_MULTIPLIER = 3.0;
            const capped = Math.min(rawEMA, currentMarketBase * CAP_MULTIPLIER);
            const FLOOR_MULTIPLIER = 0.7;
            const floored = Math.max(capped, currentMarketBase * FLOOR_MULTIPLIER);
            const newMarketBase = Math.ceil(floored);
            
            // ✅ 개선: 보호 기간 계산 통일 (유틸리티 함수 사용)
            // 모든 종료 로직(admin, cron, 복구)에서 동일한 계산 사용
            const protectionEndsAt = calculateProtectionEndsAt(7);
            
            // ✅ 개선: 영토 소유권 이전 (멱등성 보장)
            // 이미 동일 ruler_id면 스킵 (멱등성)
            // protection_days 컬럼 제거: protection_ends_at만 사용
            const territoryUpdateResult = await client.query(
                `UPDATE territories 
                 SET ruler_id = $1,
                     ruler_name = $2,
                     sovereignty = 'protected',
                     status = 'protected',
                     protection_ends_at = $3,
                     market_base_price = $4,
                     current_auction_id = NULL,
                     updated_at = NOW()
                 WHERE id = $5
                   AND (ruler_id IS DISTINCT FROM $1 OR ruler_id IS NULL)`,
                [
                    finalBidderId,
                    finalBidderNickname || 'Unknown',
                    protectionEndsAt,
                    newMarketBase,
                    auction.territory_id
                ]
            );
            
            // 소유권이 실제로 변경되었는지 확인
            if (territoryUpdateResult.rowCount === 0) {
                console.log(`[Auctions] Territory ${auction.territory_id} already has ruler ${finalBidderId}, skipping update (idempotent)`);
            }
            
            // ✅ 개선: 소유권 이력 기록 (멱등성 보장)
            // ownerships에 auction_id를 포함하고, 유니크 제약으로 중복 방지
            // ON CONFLICT로 이미 존재하면 스킵 (멱등성)
            await client.query(
                `INSERT INTO ownerships (territory_id, user_id, acquired_at, price, auction_id)
                 VALUES ($1, $2, NOW(), $3, $4)
                 ON CONFLICT (auction_id) DO NOTHING`,
                [auction.territory_id, finalBidderId, finalBid, auctionId]
            );
            
            // 소유권 이전 완료 표시
            await client.query(
                `UPDATE auctions 
                 SET transferred_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1`,
                [auctionId]
            );
        } else {
            // 낙찰자 없음: 영토 상태 복구 (락 필요)
            if (auction.territory_id) {
                await client.query(
                    `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
                    [auction.territory_id]
                );
            }
            
            if (auction.current_owner_id) {
                await client.query(
                    `UPDATE territories 
                     SET sovereignty = 'ruled',
                         status = 'ruled',
                         current_auction_id = NULL,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [auction.territory_id]
                );
            } else {
                await client.query(
                    `UPDATE territories 
                     SET sovereignty = 'unconquered',
                     status = 'unconquered',
                     ruler_id = NULL,
                     ruler_name = NULL,
                     current_auction_id = NULL,
                     updated_at = NOW()
                     WHERE id = $1`,
                    [auction.territory_id]
                );
            }
        }
        
        // 트랜잭션 커밋
        await client.query('COMMIT');
        
        // 캐시 무효화 (소유권 변경 시 모든 관련 캐시 무효화)
        await invalidateAuctionCache(auctionId, auction.territory_id);
        await invalidateTerritoryCache(auction.territory_id);
        
        // 픽셀/오버레이 캐시 무효화 (영토 소유권 변경 시 렌더링 캐시도 무효화)
        if (auction.territory_id) {
            await invalidatePixelCache(auction.territory_id);
        }
        
        // 맵 스냅샷 및 오버레이 캐시 무효화
        await invalidateCachePattern('map:*');
        await invalidateCachePattern('overlay:*');
        
        // 관리자 목록 캐시 무효화 (옥션 목록, 영토 목록)
        await invalidateCachePattern('admin:*');
        
        // WebSocket 브로드캐스트
        broadcastAuctionUpdate(auctionId, {
            status: 'ended',
            endedAt: new Date().toISOString()
        });
        
        if (hasWinner) {
            broadcastTerritoryUpdate(auction.territory_id, {
                rulerId: finalBidderId,
                rulerNickname: finalBidderNickname || 'Unknown',
                sovereignty: 'protected',
                status: 'protected',
                currentAuctionId: null,
                updatedAt: new Date().toISOString()
            });
        }
        
        res.json({
            success: true,
            auction: {
                id: auctionId,
                status: 'ended',
                endedAt: new Date().toISOString(),
                winner: hasWinner ? {
                    userId: finalBidderId,
                    userName: finalBidderNickname || 'Unknown',
                    bid: finalBid
                } : null
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Auctions] Error ending auction:', error);
        res.status(500).json({ error: 'Failed to end auction', details: error.message });
    } finally {
        client.release();
    }
});

export { router as auctionsRouter };

