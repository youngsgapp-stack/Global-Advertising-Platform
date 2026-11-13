/**
 * PayPal 결제 → 포인트 충전 (브라우저 캡처 요청과 PayPal 웹훅이 같이 사용)
 * 같은 주문은 몇 번 호출돼도 한 번만 충전됨 (advisory lock + wallet_transactions.reference_id)
 */

import { query, getPool } from '../db/init.js';
import { invalidateUserCache } from '../redis/cache-utils.js';
import { adjustWalletBalance } from './wallet-utils.js';
import { capturePayPalOrder, pointsForUsdAmount, paypalIssue } from './paypal.js';

// 친구 초대 보상: 초대받은 사람이 처음 PayPal 충전을 하면 1회 지급 (가짜 계정으로 포인트를 모으지 못하도록)
export const REFERRAL_REWARD_REFERRER = 100;
export const REFERRAL_REWARD_FRIEND = 50;
// 보상이 충전액보다 커지지 않도록: 최소 충전액, 같은 PayPal 계정은 1번만, 초대한 사람당 최대 횟수
export const REFERRAL_MIN_TOPUP_USD = 10;
export const REFERRAL_MAX_PER_REFERRER = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 초대받은 사용자의 첫 충전 시 양쪽에 보상 지급 (이미 지급했거나 조건이 안 되면 아무것도 안 함)
 * @param {string} userId
 * @param {{ amountUsd: number, payerId?: string|null, client?: object }} payment - client를 주면 그 연결을 씀 (트랜잭션 밖 상태여야 함)
 * @returns {Promise<number>} 이 사용자에게 지급된 보너스 포인트
 */
export async function grantReferralRewardIfEligible(userId, { amountUsd = 0, payerId = null, client: existingClient = null } = {}) {
    if (!(Number(amountUsd) >= REFERRAL_MIN_TOPUP_USD)) return 0;
    const client = existingClient || await getPool().connect();
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
        if (payerId) {
            const samePayer = await client.query(
                `SELECT 1 FROM payments p JOIN users u ON u.id = p.user_id
                 WHERE p.payer_id = $1 AND p.user_id <> $2 AND u.referral_rewarded_at IS NOT NULL LIMIT 1`,
                [payerId, userId]
            );
            if (samePayer.rows.length > 0) {
                await client.query('ROLLBACK');
                return 0;
            }
        }
        const rewarded = await client.query(
            `SELECT COUNT(*) AS n FROM users WHERE referred_by = $1 AND referral_rewarded_at IS NOT NULL`,
            [row.referred_by]
        );
        if (parseInt(rewarded.rows[0].n, 10) >= REFERRAL_MAX_PER_REFERRER) {
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
        await client.query('ROLLBACK').catch(() => {});
        if (error.code !== '42703') {
            console.error('[PayPal] Referral reward error:', error.message);
        }
        return 0;
    } finally {
        if (!existingClient) client.release();
    }
}

/**
 * 결제 기록 저장 (실패해도 충전 처리에는 영향 없음)
 */
export async function recordPayment(orderId, fields) {
    try {
        await query(
            `INSERT INTO payments (order_id, user_id, amount_usd, currency, points, status, capture_id, payer_id, error, provider)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
                fields.error ? String(fields.error).slice(0, 1000) : null,
                fields.sandbox ? 'paypal_sandbox' : 'paypal'
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
 * @param {{ userId?: string, source: 'client' | 'webhook', sandbox?: boolean }} options  userId: 요청한 로그인 사용자 (웹훅은 없음)
 *   sandbox: 관리자 테스트 결제 (연습용 PayPal). 포인트는 'test_charge'로 들어가 매출·추천 보상에 잡히지 않음
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function creditPayPalOrder(orderId, { userId: requestUserId = null, source, sandbox = false } = {}) {
    const referenceId = `paypal:${orderId}`;
    const chargeType = sandbox ? 'test_charge' : 'charge';
    
    let payment;
    try {
        payment = await capturePayPalOrder(orderId, sandbox ? 'sandbox' : 'live');
    } catch (error) {
        if (error.code === 'PAYPAL_PENDING') {
            console.warn(`[PayPal] Capture pending (${source}):`, { orderId, reason: error.reason });
            await recordPayment(orderId, { userId: requestUserId, sandbox, status: 'pending', error: `PayPal pending: ${error.reason || 'unknown'}` });
            return {
                status: 200,
                body: {
                    success: false,
                    pending: true,
                    reason: error.reason,
                    orderID: orderId,
                    error: `PayPal is holding this payment${error.reason ? ` (${error.reason})` : ''}. Your points will be added automatically as soon as PayPal releases it (Order ID: ${orderId}).`
                }
            };
        }
        const issue = paypalIssue(error.details);
        console.error(`[PayPal] Capture error (${source}):`, { orderId, code: error.code, issue, message: error.message });
        await recordPayment(orderId, { userId: requestUserId, sandbox, status: 'failed', error: `${error.code || ''} ${issue} ${error.message}`.trim() });
        const status = error.code === 'PAYPAL_NOT_CONFIGURED' ? 503 : 402;
        return { status, body: { error: issue ? `${error.message} (${issue})` : error.message, code: error.code, issue } };
    }
    
    const userId = await resolveChargeUser(orderId, requestUserId, payment.customId);
    const paymentFields = {
        userId,
        sandbox,
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
            `SELECT user_id FROM wallet_transactions WHERE reference_id = $1 AND type IN ('charge', 'test_charge') LIMIT 1`,
            [referenceId]
        );
        
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            const walletResult = await client.query(`SELECT balance FROM wallets WHERE user_id = $1`, [existing.rows[0].user_id]);
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
            type: chargeType,
            description: sandbox ? `PayPal TEST charge (sandbox): $${payment.amount}` : `PayPal charge: $${payment.amount}`,
            referenceId
        });
        
        await client.query('COMMIT');
        await invalidateUserCache(userId);
        await recordPayment(orderId, { ...paymentFields, points, status: 'credited', error: source === 'webhook' ? 'Credited automatically by PayPal webhook' : null });
        const referralBonus = sandbox ? 0 : await grantReferralRewardIfEligible(userId, { amountUsd: payment.amount, payerId: payment.payerId, client });
        
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
 * 환불/지불 거절(차지백): 기록하고 충전했던 포인트를 회수 (남은 잔액까지만, 모자란 만큼은 관리자 확인용으로 기록)
 * 같은 결제는 몇 번 호출돼도 한 번만 회수됨 (reference_id)
 */
export async function markPaymentReversed({ orderId, captureId, status, reason }) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE payments SET status = $3, error = $4, updated_at = NOW()
             WHERE ($1::text IS NOT NULL AND order_id = $1) OR ($2::text IS NOT NULL AND capture_id = $2)
             RETURNING order_id, user_id, points`,
            [orderId || null, captureId || null, status, String(reason || '').slice(0, 1000)]
        );
        const payment = result.rows[0];
        if (!payment) {
            await client.query('ROLLBACK');
            console.warn('[PayPal] Refund/reversal for unknown payment:', { orderId, captureId, status });
            return;
        }
        const points = parseInt(payment.points, 10) || 0;
        const referenceId = `paypal_reversal:${payment.order_id}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [referenceId]);
        const already = await client.query(`SELECT 1 FROM wallet_transactions WHERE reference_id = $1 LIMIT 1`, [referenceId]);
        if (payment.user_id && points > 0 && already.rows.length === 0) {
            const wallet = await client.query(`SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`, [payment.user_id]);
            const available = Math.max(0, Math.floor(parseFloat(wallet.rows[0]?.balance || 0)));
            const takeBack = Math.min(points, available);
            if (takeBack > 0) {
                await adjustWalletBalance(client, payment.user_id, -takeBack, {
                    type: 'refund_reversal',
                    description: `PayPal ${status}: points taken back (order ${payment.order_id})`,
                    referenceId
                });
            }
            if (takeBack < points) {
                await client.query(
                    `UPDATE payments SET error = LEFT(COALESCE(error, '') || $2, 1000) WHERE order_id = $1`,
                    [payment.order_id, ` | ${points - takeBack} pt could not be taken back (already spent) - review this account`]
                );
            }
        }
        await client.query('COMMIT');
        if (payment.user_id) await invalidateUserCache(payment.user_id);
        console.warn('[PayPal] Payment marked as', status, payment);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
