/**
 * PayPal 결제 → 포인트 충전 (브라우저 캡처 요청과 PayPal 웹훅이 같이 사용)
 * 같은 주문은 몇 번 호출돼도 한 번만 충전됨 (advisory lock + wallet_transactions.reference_id)
 */

import { query, getPool } from '../db/init.js';
import { invalidateUserCache } from '../redis/cache-utils.js';
import { adjustWalletBalance } from './wallet-utils.js';
import { capturePayPalOrder, pointsForUsdAmount } from './paypal.js';

// 친구 초대 보상: 초대받은 사람이 처음 PayPal 충전을 하면 1회 지급 (가짜 계정으로 포인트를 모으지 못하도록)
export const REFERRAL_REWARD_REFERRER = 100;
export const REFERRAL_REWARD_FRIEND = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 초대받은 사용자의 첫 충전 시 양쪽에 보상 지급 (이미 지급했으면 아무것도 안 함)
 * @returns {Promise<number>} 이 사용자에게 지급된 보너스 포인트
 */
export async function grantReferralRewardIfEligible(userId) {
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
            console.error('[PayPal] Referral reward error:', error.message);
        }
        return 0;
    } finally {
        client.release();
    }
}

/**
 * 결제 기록 저장 (실패해도 충전 처리에는 영향 없음)
 */
export async function recordPayment(orderId, fields) {
    try {
        await query(
            `INSERT INTO payments (order_id, user_id, amount_usd, currency, points, status, capture_id, payer_id, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (order_id) DO UPDATE SET
                user_id = COALESCE(EXCLUDED.user_id, payments.user_id),
                amount_usd = COALESCE(EXCLUDED.amount_usd, payments.amount_usd),
                currency = COALESCE(EXCLUDED.currency, payments.currency),
                points = COALESCE(EXCLUDED.points, payments.points),
                status = CASE WHEN payments.status IN ('credited', 'refunded', 'reversed') THEN payments.status ELSE EXCLUDED.status END,
                capture_id = COALESCE(EXCLUDED.capture_id, payments.capture_id),
                payer_id = COALESCE(EXCLUDED.payer_id, payments.payer_id),
                error = CASE WHEN payments.status IN ('credited', 'refunded', 'reversed') THEN payments.error ELSE EXCLUDED.error END,
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
        console.error('[PayPal] Failed to record payment:', { orderId, status: fields.status, error: error.message });
    }
}

async function resolveChargeUser(orderId, requestUserId, customId) {
    if (customId && UUID_RE.test(customId)) {
        const result = await query(`SELECT id FROM users WHERE id = $1`, [customId]);
        if (result.rows[0]) {
            if (requestUserId && requestUserId !== customId) {
                console.warn('[PayPal] Order belongs to another user, crediting the order owner:', { orderId, requestUserId, customId });
            }
            return customId;
        }
    }
    if (requestUserId) {
        return requestUserId;
    }
    const existing = await query(`SELECT user_id FROM payments WHERE order_id = $1 AND user_id IS NOT NULL`, [orderId]);
    return existing.rows[0]?.user_id || null;
}

/**
 * 주문 캡처(이미 캡처됐으면 조회) → 금액 검증 → 포인트 충전
 * @param {string} orderId
 * @param {{ userId?: string, source: 'client' | 'webhook' }} options  userId: 요청한 로그인 사용자 (웹훅은 없음)
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function creditPayPalOrder(orderId, { userId: requestUserId = null, source } = {}) {
    const referenceId = `paypal:${orderId}`;
    
    let payment;
    try {
        payment = await capturePayPalOrder(orderId);
    } catch (error) {
        console.error(`[PayPal] Capture error (${source}):`, { orderId, code: error.code, message: error.message });
        await recordPayment(orderId, { userId: requestUserId, status: 'failed', error: `${error.code || ''} ${error.message}`.trim() });
        const status = error.code === 'PAYPAL_NOT_CONFIGURED' ? 503 : 402;
        return { status, body: { error: error.message, code: error.code } };
    }
    
    const userId = await resolveChargeUser(orderId, requestUserId, payment.customId);
    const paymentFields = {
        userId,
        amount: payment.amount,
        currency: payment.currency,
        captureId: payment.captureId,
        payerId: payment.payerId
    };
    
    if (!userId) {
        console.error(`[PayPal] Payment captured but no user is linked (${source}):`, { orderId, amount: payment.amount });
        await recordPayment(orderId, { ...paymentFields, status: 'credit_failed', error: 'Paid, but no account is linked to this order. Find the buyer by order ID and add points manually.' });
        return { status: 422, body: { error: 'No account linked to this order', orderID: orderId } };
    }
    
    if (payment.currency !== 'USD') {
        console.error('[PayPal] Currency mismatch:', { orderId, currency: payment.currency });
        await recordPayment(orderId, { ...paymentFields, status: 'rejected', error: `Unsupported currency: ${payment.currency}` });
        return { status: 400, body: { error: `Unsupported currency: ${payment.currency}` } };
    }
    
    const points = pointsForUsdAmount(payment.amount);
    if (points <= 0) {
        console.error('[PayPal] Amount out of range:', { orderId, amount: payment.amount });
        await recordPayment(orderId, { ...paymentFields, status: 'rejected', error: `Unsupported payment amount: ${payment.amount}` });
        return { status: 400, body: { error: `Unsupported payment amount: ${payment.amount}` } };
    }
    
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // 같은 주문의 동시 요청(브라우저 + 웹훅) 직렬화 (중복 충전 방지)
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [referenceId]);
        
        const existing = await client.query(
            `SELECT user_id FROM wallet_transactions WHERE reference_id = $1 AND type = 'charge' LIMIT 1`,
            [referenceId]
        );
        
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            const walletResult = await query(`SELECT balance FROM wallets WHERE user_id = $1`, [existing.rows[0].user_id]);
            return {
                status: 200,
                body: {
                    success: true,
                    alreadyProcessed: true,
                    orderID: orderId,
                    points: 0,
                    balance: parseFloat(walletResult.rows[0]?.balance || 0)
                }
            };
        }
        
        const { balance } = await adjustWalletBalance(client, userId, points, {
            type: 'charge',
            description: `PayPal charge: $${payment.amount}`,
            referenceId
        });
        
        await client.query('COMMIT');
        await invalidateUserCache(userId);
        await recordPayment(orderId, { ...paymentFields, points, status: 'credited', error: source === 'webhook' ? 'Credited automatically by PayPal webhook' : null });
        const referralBonus = await grantReferralRewardIfEligible(userId);
        
        console.log(`[PayPal] Charge completed (${source}):`, { orderId, userId, amount: payment.amount, points, balance, referralBonus });
        return {
            status: 200,
            body: {
                success: true,
                orderID: orderId,
                amount: payment.amount,
                points,
                referralBonus,
                balance: balance + referralBonus
            }
        };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[PayPal] Charge DB error, payment captured! (${source}):`, { orderId, userId, amount: payment.amount, error: error.message });
        await recordPayment(orderId, { ...paymentFields, points, status: 'credit_failed', error: error.message });
        return {
            status: 500,
            body: {
                error: 'Payment captured but points could not be added. Please contact support with your order ID.',
                orderID: orderId
            }
        };
    } finally {
        client.release();
    }
}

/**
 * 환불/지불 거절(차지백) 기록. 포인트 회수는 관리자가 결제 내역에서 확인 후 직접 처리
 */
export async function markPaymentReversed({ orderId, captureId, status, reason }) {
    const result = await query(
        `UPDATE payments SET status = $3, error = $4, updated_at = NOW()
         WHERE ($1::text IS NOT NULL AND order_id = $1) OR ($2::text IS NOT NULL AND capture_id = $2)
         RETURNING order_id, user_id, points`,
        [orderId || null, captureId || null, status, String(reason || '').slice(0, 1000)]
    );
    if (result.rows.length === 0) {
        console.warn('[PayPal] Refund/reversal for unknown payment:', { orderId, captureId, status });
    } else {
        console.warn('[PayPal] Payment marked as', status, result.rows[0]);
    }
}
