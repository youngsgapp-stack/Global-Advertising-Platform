/**
 * Users API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateUserCache } from '../redis/cache-utils.js';
import { isAdminUser } from '../middleware/admin.js';
import { createPayPalOrder, pointsForUsdAmount } from '../utils/paypal.js';
import { creditPayPalOrder, REFERRAL_REWARD_REFERRER, REFERRAL_REWARD_FRIEND } from '../utils/paypal-credit.js';

const router = express.Router();

// 신규 가입 지갑 스타터 포인트 (최저가 영토 1곳 1주일 = 50pt)
const STARTER_BALANCE = 50;

const REFERRAL_ATTACH_WINDOW_DAYS = 7;
const SITE_URL = process.env.SITE_URL || 'https://www.worldadvertisingmap.com';
const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode() {
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
    }
    return code;
}

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
            const nickname = req.user.name || req.user.email || 'User';
            const email = req.user.email || '';
            const insertResult = await query(
                `INSERT INTO users (firebase_uid, email, nickname)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [firebaseUid, email, nickname]
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
        
        console.log('[Users] 📊 Fetching wallet for user:', firebaseUid);
        
        // 사용자 ID 조회 (없으면 생성)
        let userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [firebaseUid]
        );
        
        let userId;
        if (userResult.rows.length === 0) {
            // 사용자가 없으면 먼저 생성
            const nickname = req.user.name || req.user.email || 'User';
            const email = req.user.email || '';
            console.log('[Users] 👤 Creating new user:', { firebaseUid, email, nickname });
            const insertResult = await query(
                `INSERT INTO users (firebase_uid, email, nickname)
                 VALUES ($1, $2, $3)
                 RETURNING id`,
                [firebaseUid, email, nickname]
            );
            userId = insertResult.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }
        
        // Redis에서 먼저 조회 (10초 캐시)
        const cacheKey = `wallet:${userId}`;
        let cached = null;
        
        try {
            cached = await redis.get(cacheKey);
            if (cached && typeof cached === 'object') {
                console.log('[Users] ✅ Wallet loaded from cache');
                return res.json(cached);
            }
        } catch (redisError) {
            console.warn('[Users] ⚠️ Redis cache read error (continuing with DB query):', redisError.message);
            // Redis 오류가 있어도 DB 쿼리는 계속 진행
        }
        
        console.log('[Users] 📊 Fetching wallet from database...');
        
        // DB에서 지갑 조회 (없으면 생성)
        let walletResult = await query(
            `SELECT * FROM wallets WHERE user_id = $1`,
            [userId]
        );
        
        let wallet;
        if (walletResult.rows.length === 0) {
            // 지갑 없으면 생성 (스타터 포인트 지급)
            console.log(`[Users] 💰 Creating new wallet with starter balance: ${STARTER_BALANCE}`);
            const insertResult = await query(
                `INSERT INTO wallets (user_id, balance)
                 VALUES ($1, $2)
                 RETURNING *`,
                [userId, STARTER_BALANCE]
            );
            wallet = insertResult.rows[0];
        } else {
            wallet = walletResult.rows[0];
        }
        
        const walletData = {
            balance: parseFloat(wallet.balance || 0),
            updatedAt: wallet.updated_at,
        };
        
        // Redis에 캐시 - 실패해도 응답은 반환
        try {
            await redis.set(cacheKey, walletData, CACHE_TTL.USER_WALLET);
            console.log('[Users] ✅ Wallet cached in Redis');
        } catch (redisError) {
            console.warn('[Users] ⚠️ Redis cache write error (response still sent):', redisError.message);
        }
        
        console.log('[Users] ✅ Wallet fetched successfully:', walletData);
        res.json(walletData);
    } catch (error) {
        console.error('[Users] ❌❌❌ Wallet error:', {
            message: error.message,
            code: error.code,
            name: error.name,
            stack: error.stack,
            fullError: error
        });
        res.status(500).json({ 
            error: 'Failed to fetch wallet',
            details: error.message,
            errorCode: error.code || 'UNKNOWN_ERROR'
        });
    }
});

/**
 * PUT /api/users/me/wallet
 * 지갑 잔액 직접 변경 (관리자 전용)
 * 일반 사용자의 잔액 변경은 구매/입찰/충전 API에서 서버가 계산함
 */
router.put('/me/wallet', async (req, res) => {
    try {
        if (!isAdminUser(req.user)) {
            return res.status(403).json({
                error: 'Direct wallet updates are not allowed',
                message: 'Balance changes are processed by purchase, bid, and payment APIs.'
            });
        }
        
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
 * POST /api/users/me/wallet/paypal-capture
 * PayPal 주문을 서버에서 캡처/검증하고, 실제 결제 금액 기준으로 포인트 충전
 */
router.post('/me/wallet/paypal-capture', async (req, res) => {
    const { orderID } = req.body || {};
    
    if (!orderID || typeof orderID !== 'string' || !/^[A-Z0-9-]{8,40}$/i.test(orderID)) {
        return res.status(400).json({ error: 'Valid PayPal order ID is required' });
    }
    
    let userId;
    try {
        const userResult = await query(
            `SELECT id FROM users WHERE firebase_uid = $1`,
            [req.user.uid]
        );
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        userId = userResult.rows[0].id;
    } catch (error) {
        console.error('[Users] PayPal capture user lookup error:', error);
        return res.status(500).json({ error: 'Failed to process payment' });
    }
    
    const result = await creditPayPalOrder(orderID, { userId, source: 'client' });
    res.status(result.status).json(result.body);
});

/**
 * POST /api/users/me/wallet/paypal-order
 * 충전 주문 생성 (주문에 사용자 id를 새겨서, 결제 후 창이 닫혀도 웹훅으로 충전되게 함)
 */
router.post('/me/wallet/paypal-order', async (req, res) => {
    const amount = Math.round(parseFloat(req.body?.amount) * 100) / 100;
    const points = pointsForUsdAmount(amount);
    if (points <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    
    try {
        const userResult = await query(`SELECT id FROM users WHERE firebase_uid = $1`, [req.user.uid]);
        const userId = userResult.rows[0]?.id;
        if (!userId) {
            return res.status(404).json({ error: 'User not found' });
        }
        const orderID = await createPayPalOrder({
            amount,
            customId: userId,
            description: `${points.toLocaleString('en-US')} points - World Ad Map`
        });
        res.json({ success: true, orderID });
    } catch (error) {
        console.error('[Users] PayPal order creation error:', { code: error.code, message: error.message, details: error.details });
        const status = error.code === 'PAYPAL_NOT_CONFIGURED' ? 503 : 502;
        res.status(status).json({ error: 'Could not start the PayPal payment. Please try again.' });
    }
});

/**
 * GET /api/users/me/wallet/transactions
 * 현재 사용자 지갑 거래 내역 조회
 */
router.get('/me/referral', async (req, res) => {
    try {
        const userResult = await query(`SELECT id, referral_code FROM users WHERE firebase_uid = $1`, [req.user.uid]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        let code = user.referral_code;
        for (let attempt = 0; !code && attempt < 5; attempt++) {
            const candidate = generateReferralCode();
            const updated = await query(
                `UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL
                 AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code = $1)
                 RETURNING referral_code`,
                [candidate, user.id]
            ).catch(error => (error.code === '23505' ? { rows: [] } : Promise.reject(error)));
            code = updated.rows[0]?.referral_code || null;
        }
        if (!code) {
            return res.status(500).json({ error: 'Failed to create invite code' });
        }
        const stats = await query(
            `SELECT COUNT(*) AS invited, COUNT(referral_rewarded_at) AS rewarded FROM users WHERE referred_by = $1`,
            [user.id]
        );
        res.json({
            code,
            link: `${SITE_URL}/?ref=${code}`,
            invited: parseInt(stats.rows[0].invited, 10),
            rewarded: parseInt(stats.rows[0].rewarded, 10),
            rewardReferrer: REFERRAL_REWARD_REFERRER,
            rewardFriend: REFERRAL_REWARD_FRIEND
        });
    } catch (error) {
        console.error('[Users] Referral info error:', error);
        res.status(500).json({ error: 'Failed to load invite info' });
    }
});

/**
 * POST /api/users/me/referral
 * 초대 링크로 가입한 사용자가 초대 코드를 연결 (가입 후 7일 이내, 아직 충전 전, 본인 코드 불가, 1회만)
 */
router.post('/me/referral', async (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid invite code' });
    }
    try {
        const userResult = await query(
            `SELECT u.id, u.referred_by, u.created_at,
                    EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.user_id = u.id AND w.type = 'charge') AS has_charged
             FROM users u WHERE u.firebase_uid = $1`,
            [req.user.uid]
        );
        const user = userResult.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (user.referred_by) {
            return res.json({ success: true, alreadyLinked: true });
        }
        const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000;
        if (ageDays > REFERRAL_ATTACH_WINDOW_DAYS || user.has_charged) {
            return res.status(400).json({ error: 'Invite codes can only be used by new members before their first top-up' });
        }
        const referrer = await query(`SELECT id FROM users WHERE referral_code = $1`, [code]);
        const referrerId = referrer.rows[0]?.id;
        if (!referrerId) {
            return res.status(404).json({ error: 'Invite code not found' });
        }
        if (String(referrerId) === String(user.id)) {
            return res.status(400).json({ error: 'You cannot use your own invite code' });
        }
        await query(`UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL`, [referrerId, user.id]);
        res.json({ success: true, rewardFriend: REFERRAL_REWARD_FRIEND });
    } catch (error) {
        console.error('[Users] Referral link error:', error);
        res.status(500).json({ error: 'Failed to use invite code' });
    }
});

router.get('/me/territories/expiring', async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 30);
    try {
        const result = await query(
            `SELECT t.id, t.name, t.sovereignty, t.protection_ends_at
             FROM territories t
             JOIN users u ON u.id = t.ruler_id
             WHERE u.firebase_uid = $1
               AND (
                    (t.sovereignty = 'protected' AND t.protection_ends_at IS NOT NULL
                        AND t.protection_ends_at < NOW() + ($2 || ' days')::interval)
                    OR t.sovereignty = 'ruled'
               )
             ORDER BY t.protection_ends_at NULLS FIRST`,
            [req.user.uid, String(days)]
        );
        res.json(result.rows.map(row => ({
            id: row.id,
            name: row.name,
            sovereignty: row.sovereignty,
            protectionEndsAt: row.protection_ends_at,
            expired: row.sovereignty === 'ruled'
        })));
    } catch (error) {
        console.error('[Users] Expiring territories error:', error);
        res.status(500).json({ error: 'Failed to fetch expiring territories' });
    }
});

/**
 * GET /api/users/me/wallet/transactions
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

