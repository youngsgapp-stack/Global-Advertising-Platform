/**
 * Users API Routes
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { redis } from '../redis/init.js';
import { CACHE_TTL, invalidateUserCache } from '../redis/cache-utils.js';
import { isAdminUser } from '../middleware/admin.js';
import { adjustWalletBalance } from '../utils/wallet-utils.js';
import { capturePayPalOrder, pointsForUsdAmount } from '../utils/paypal.js';

const router = express.Router();

// 신규 가입 지갑 스타터 포인트 (최저가 영토 1곳 1주일 = 50pt)
const STARTER_BALANCE = 50;

// 친구 초대 보상: 초대받은 사람이 처음 PayPal 충전을 하면 1회 지급 (가짜 계정으로 포인트를 모으지 못하도록)
const REFERRAL_REWARD_REFERRER = 100;
const REFERRAL_REWARD_FRIEND = 50;
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
 * 초대받은 사용자의 첫 충전 시 양쪽에 보상 지급 (이미 지급했으면 아무것도 안 함)
 * @returns {Promise<number>} 이 사용자에게 지급된 보너스 포인트
 */
async function grantReferralRewardIfEligible(userId) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT referred_by, referral_rewarded_at FROM users WHERE id = $1 FOR UPDATE`,
            [userId]
        );
        const row = result.rows[0];
        if (!row?.referred_by || row.referral_rewarded_at) {
            await client.query('ROLLBACK');
            return 0;
        }
        const reference = `referral:${userId}`;
        await adjustWalletBalance(client, row.referred_by, REFERRAL_REWARD_REFERRER, {
            type: 'referral_bonus',
            description: 'Friend invite reward (your friend made their first top-up)',
            referenceId: reference
        });
        await adjustWalletBalance(client, userId, REFERRAL_REWARD_FRIEND, {
            type: 'referral_bonus',
            description: 'Welcome bonus for joining with an invite',
            referenceId: reference
        });
        await client.query(`UPDATE users SET referral_rewarded_at = NOW() WHERE id = $1`, [userId]);
        await client.query('COMMIT');
        await invalidateUserCache(userId);
        await invalidateUserCache(row.referred_by);
        return REFERRAL_REWARD_FRIEND;
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code !== '42703') {
            console.error('[Users] Referral reward error:', error.message);
        }
        return 0;
    } finally {
        client.release();
    }
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
 * 결제 기록 저장 (실패해도 충전 처리에는 영향 없음)
 */
async function recordPayment(orderId, fields) {
    try {
        await query(
            `INSERT INTO payments (order_id, user_id, amount_usd, currency, points, status, capture_id, payer_id, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (order_id) DO UPDATE SET
                user_id = COALESCE(EXCLUDED.user_id, payments.user_id),
                amount_usd = COALESCE(EXCLUDED.amount_usd, payments.amount_usd),
                currency = COALESCE(EXCLUDED.currency, payments.currency),
                points = COALESCE(EXCLUDED.points, payments.points),
                status = CASE WHEN payments.status = 'credited' THEN payments.status ELSE EXCLUDED.status END,
                capture_id = COALESCE(EXCLUDED.capture_id, payments.capture_id),
                payer_id = COALESCE(EXCLUDED.payer_id, payments.payer_id),
                error = CASE WHEN payments.status = 'credited' THEN payments.error ELSE EXCLUDED.error END,
                updated_at = NOW()`,
            [
                orderId,
                fields.userId ?? null,
                fields.amount ?? null,
                fields.currency ?? null,
                fields.points ?? null,
                fields.status,
                fields.captureId ?? null,
                fields.payerId ?? null,
                fields.error ? String(fields.error).slice(0, 1000) : null
            ]
        );
    } catch (error) {
        console.error('[Users] Failed to record payment:', { orderId, status: fields.status, error: error.message });
    }
}

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
    const referenceId = `paypal:${orderID}`;
    
    let payment;
    try {
        payment = await capturePayPalOrder(orderID);
    } catch (error) {
        console.error('[Users] PayPal capture error:', { orderID, code: error.code, message: error.message });
        await recordPayment(orderID, { userId, status: 'failed', error: `${error.code || ''} ${error.message}`.trim() });
        const status = error.code === 'PAYPAL_NOT_CONFIGURED' ? 503 : 402;
        return res.status(status).json({ error: error.message, code: error.code });
    }
    
    const paymentFields = {
        userId,
        amount: payment.amount,
        currency: payment.currency,
        captureId: payment.captureId,
        payerId: payment.payerId
    };
    
    if (payment.currency !== 'USD') {
        console.error('[Users] PayPal capture currency mismatch:', { orderID, currency: payment.currency });
        await recordPayment(orderID, { ...paymentFields, status: 'rejected', error: `Unsupported currency: ${payment.currency}` });
        return res.status(400).json({ error: `Unsupported currency: ${payment.currency}` });
    }
    
    const points = pointsForUsdAmount(payment.amount);
    if (points <= 0) {
        console.error('[Users] PayPal capture amount out of range:', { orderID, amount: payment.amount });
        await recordPayment(orderID, { ...paymentFields, status: 'rejected', error: `Unsupported payment amount: ${payment.amount}` });
        return res.status(400).json({ error: `Unsupported payment amount: ${payment.amount}` });
    }
    
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // 같은 주문의 동시 요청 직렬화 (중복 충전 방지)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [referenceId]);
        
        const existing = await client.query(
            `SELECT user_id FROM wallet_transactions WHERE reference_id = $1 AND type = 'charge' LIMIT 1`,
            [referenceId]
        );
        
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            const walletResult = await query(`SELECT balance FROM wallets WHERE user_id = $1`, [userId]);
            return res.json({
                success: true,
                alreadyProcessed: true,
                orderID,
                points: 0,
                balance: parseFloat(walletResult.rows[0]?.balance || 0)
            });
        }
        
        const { balance } = await adjustWalletBalance(client, userId, points, {
            type: 'charge',
            description: `PayPal charge: $${payment.amount}`,
            referenceId
        });
        
        await client.query('COMMIT');
        await invalidateUserCache(userId);
        await recordPayment(orderID, { ...paymentFields, points, status: 'credited' });
        const referralBonus = await grantReferralRewardIfEligible(userId);
        
        console.log('[Users] PayPal charge completed:', { orderID, userId, amount: payment.amount, points, balance, referralBonus });
        res.json({
            success: true,
            orderID,
            amount: payment.amount,
            points,
            referralBonus,
            balance: balance + referralBonus
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Users] PayPal charge DB error (payment captured!):', { orderID, userId, amount: payment.amount, error: error.message });
        await recordPayment(orderID, { ...paymentFields, points, status: 'credit_failed', error: error.message });
        res.status(500).json({
            error: 'Payment captured but points could not be added. Please contact support with your order ID.',
            orderID
        });
    } finally {
        client.release();
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

