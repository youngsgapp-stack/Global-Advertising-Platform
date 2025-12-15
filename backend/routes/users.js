/**
 * Users API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateUserCache } from '../redis/cache-utils.js';

const router = express.Router();

/**
 * GET /api/users/me
 * 현재 사용자 정보 조회
 */
router.get('/me', async (req, res) => {
    try {
        const firebaseUid = req.user.uid;
        
        // DB에서 사용자 조회 (없으면 생성)
        let result = await query(
            `SELECT * FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        let user;
        if (result.rows.length === 0) {
            // 사용자 없으면 생성
            const insertResult = await query(
                `INSERT INTO users (firebase_uid, email, nickname)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [firebaseUid, req.user.email, req.user.name || req.user.email]
            );
            user = insertResult.rows[0];
        } else {
            user = result.rows[0];
        }
        
        res.json({
            id: user.id,
            firebaseUid: user.firebase_uid,
            email: user.email,
            nickname: user.nickname,
            avatarUrl: user.avatar_url,
            createdAt: user.created_at,
        });
    } catch (error) {
        console.error('[Users] Error:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

/**
 * GET /api/users/me/wallet
 * 현재 사용자 지갑 조회
 */
router.get('/me/wallet', async (req, res) => {
    try {
        const firebaseUid = req.user.uid;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // Redis에서 먼저 조회 (10초 캐시)
        const cacheKey = `wallet:${userId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // DB에서 지갑 조회 (없으면 생성)
        let walletResult = await query(
            `SELECT * FROM wallets WHERE user_id = $1`,
            [userId]
        );
        
        let wallet;
        if (walletResult.rows.length === 0) {
            // 지갑 없으면 생성 (스타터 포인트 400 지급)
            const insertResult = await query(
                `INSERT INTO wallets (user_id, balance)
                 VALUES ($1, 400)
                 RETURNING *`,
                [userId]
            );
            wallet = insertResult.rows[0];
        } else {
            wallet = walletResult.rows[0];
        }
        
        const walletData = {
            balance: parseFloat(wallet.balance || 0),
            updatedAt: wallet.updated_at,
        };
        
        // Redis에 캐시
        await redis.set(cacheKey, walletData, CACHE_TTL.USER_WALLET);
        
        res.json(walletData);
    } catch (error) {
        console.error('[Users] Wallet error:', error);
        res.status(500).json({ error: 'Failed to fetch wallet' });
    }
});

/**
 * PUT /api/users/me/wallet
 * 현재 사용자 지갑 업데이트 (잔액 변경, 거래 내역 추가)
 */
router.put('/me/wallet', async (req, res) => {
    try {
        const firebaseUid = req.user.uid;
        const { balance, transaction } = req.body;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // 트랜잭션으로 지갑 업데이트 및 거래 내역 추가
        const pool = getPool();
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // 지갑 업데이트
            let walletResult;
            if (balance !== undefined) {
                walletResult = await client.query(
                    `UPDATE wallets 
                     SET balance = $1, updated_at = NOW()
                     WHERE user_id = $2
                     RETURNING *`,
                    [balance, userId]
                );
            } else {
                // balance가 없으면 현재 잔액 조회
                walletResult = await client.query(
                    `SELECT * FROM wallets WHERE user_id = $1`,
                    [userId]
                );
            }
            
            // 거래 내역 추가 (있는 경우)
            if (transaction) {
                await client.query(
                    `INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference_id)
                     VALUES ((SELECT id FROM wallets WHERE user_id = $1), $1, $2, $3, $4, $5)`,
                    [
                        userId,
                        transaction.type || 'adjustment',
                        transaction.amount || 0,
                        transaction.description || '',
                        transaction.referenceId || null
                    ]
                );
            }
            
            await client.query('COMMIT');
            
            const wallet = walletResult.rows[0];
            const walletData = {
                balance: parseFloat(wallet.balance || 0),
                updatedAt: wallet.updated_at,
            };
            
            // Redis 캐시 무효화
            await invalidateUserCache(userId);
            
            res.json(walletData);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('[Users] Wallet update error:', error);
        res.status(500).json({ error: 'Failed to update wallet' });
    }
});

/**
 * GET /api/users/me/wallet/transactions
 * 현재 사용자 지갑 거래 내역 조회
 */
router.get('/me/wallet/transactions', async (req, res) => {
    try {
        const firebaseUid = req.user.uid;
        const { limit = 50, offset = 0 } = req.query;
        
        // 사용자 ID 조회
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userId = userResult.rows[0].id;
        
        // 거래 내역 조회
        const result = await query(
            `SELECT 
                wt.*,
                w.id as wallet_id
             FROM wallet_transactions wt
             JOIN wallets w ON wt.wallet_id = w.id
             WHERE w.user_id = $1
             ORDER BY wt.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, parseInt(limit, 10), parseInt(offset, 10)]
        );
        
        const transactions = result.rows.map(tx => ({
            id: tx.id,
            type: tx.type,
            amount: parseFloat(tx.amount || 0),
            description: tx.description,
            referenceId: tx.reference_id,
            createdAt: tx.created_at
        }));
        
        res.json(transactions);
    } catch (error) {
        console.error('[Users] Transactions error:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

export { router as usersRouter };

