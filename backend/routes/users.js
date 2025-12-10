/**
 * Users API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';

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
        
        // Redis에 캐시 (10초)
        await redis.set(cacheKey, walletData, 10);
        
        res.json(walletData);
    } catch (error) {
        console.error('[Users] Wallet error:', error);
        res.status(500).json({ error: 'Failed to fetch wallet' });
    }
});

export { router as usersRouter };

