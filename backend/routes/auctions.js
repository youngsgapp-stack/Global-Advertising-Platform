/**
 * Auctions API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateAuctionCache } from '../redis/cache-utils.js';
import { broadcastBidUpdate, broadcastTerritoryUpdate, broadcastAuctionUpdate } from '../websocket/index.js';

const router = express.Router();

/**
 * GET /api/auctions/:id
 * 경매 상세 조회
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Redis에서 먼저 조회
        const cacheKey = `auction:${id}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // DB에서 조회
        const result = await query(
            `SELECT 
                a.*,
                u.nickname as bidder_nickname,
                t.name as territory_name,
                t.code as territory_code
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            LEFT JOIN territories t ON a.territory_id = t.id
            WHERE a.id = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Auction not found' });
        }
        
        const auction = result.rows[0];
        
        // Redis에 캐시
        await redis.set(cacheKey, auction, CACHE_TTL.AUCTION);
        
        res.json(auction);
    } catch (error) {
        console.error('[Auctions] Error:', error);
        res.status(500).json({ error: 'Failed to fetch auction' });
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
                territory.country
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
        
        // WebSocket 브로드캐스트
        broadcastAuctionUpdate(auction.id, {
            id: auction.id,
            territoryId: auction.territory_id,
            status: auction.status,
            startingBid: parseFloat(auction.min_bid || auction.current_bid || 0),
            currentBid: parseFloat(auction.current_bid || 0),
            endTime: auction.end_time,
            createdAt: auction.created_at
        });
        
        broadcastTerritoryUpdate(territoryId, {
            id: territoryId,
            currentAuctionId: auction.id,
            status: territory.ruler_id ? territory.status : 'contested',
            updatedAt: new Date().toISOString()
        });
        
        res.json({
            success: true,
            auction: {
                id: auction.id,
                territoryId: auction.territory_id,
                status: auction.status,
                startingBid: parseFloat(auction.min_bid || auction.current_bid || 0),
                currentBid: parseFloat(auction.current_bid || 0),
                endTime: auction.end_time,
                createdAt: auction.created_at
            }
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
            status
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
        
        const minBid = auction.current_bid 
            ? parseFloat(auction.current_bid) * 1.1 // 현재가의 110%
            : parseFloat(auction.min_bid);
        
        if (amount < minBid) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Bid amount too low',
                minBid 
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
        
        res.json({
            success: true,
            bid: bidResult.rows[0],
            auction: {
                id: auctionId,
                currentBid: amount,
                currentBidderId: userId,
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Auctions] Bid error:', error);
        res.status(500).json({ error: 'Failed to place bid' });
    } finally {
        client.release();
    }
});

export { router as auctionsRouter };

