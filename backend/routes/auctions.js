/**
 * Auctions API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { broadcastBidUpdate } from '../websocket/index.js';

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
        
        // Redis에 캐시 (30초)
        await redis.set(cacheKey, auction, 30);
        
        res.json(auction);
    } catch (error) {
        console.error('[Auctions] Error:', error);
        res.status(500).json({ error: 'Failed to fetch auction' });
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
        
        if (new Date(auction.end_time) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Auction has ended' });
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
        await client.query(
            `UPDATE territories 
             SET updated_at = NOW()
             WHERE id = $1`,
            [auction.territory_id]
        );
        
        // 트랜잭션 커밋
        await client.query('COMMIT');
        
        // Redis 캐시 삭제
        await redis.del(`auction:${auctionId}`);
        await redis.del(`territory:${auction.territory_id}`);
        
        // WebSocket으로 브로드캐스트
        broadcastBidUpdate({
            auctionId,
            territoryId: auction.territory_id,
            amount,
            bidderId: userId,
            bidderNickname: req.user.name || req.user.email,
        });
        
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

