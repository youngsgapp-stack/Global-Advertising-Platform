/**
 * POST /api/paypal/webhook
 * PayPal이 결제 상태를 직접 알려주는 주소. 브라우저가 결제 직후 닫혀서 충전 요청을 못 보낸 경우에도 포인트를 넣어줌
 * PayPal은 2xx를 받을 때까지 최대 3일간 재전송하므로, 다시 시도할 가치가 있는 실패만 500으로 응답
 */

import { verifyPayPalWebhook } from '../utils/paypal.js';
import { creditPayPalOrder, markPaymentReversed } from '../utils/paypal-credit.js';

const ORDER_ID_RE = /^[A-Z0-9-]{8,40}$/i;

function captureIdFromLinks(resource) {
    const up = (resource?.links || []).find(link => link.rel === 'up' && /\/captures\//.test(link.href || ''));
    return up ? up.href.split('/captures/')[1]?.split(/[/?]/)[0] : null;
}

export async function paypalWebhookHandler(req, res) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }
    
    if (!process.env.PAYPAL_WEBHOOK_ID) {
        console.warn('[PayPal Webhook] PAYPAL_WEBHOOK_ID is not set, ignoring event', event?.event_type);
        return res.status(503).json({ error: 'Webhook not configured' });
    }
    
    try {
        const verified = await verifyPayPalWebhook(req.headers, rawBody);
        if (!verified) {
            console.warn('[PayPal Webhook] Signature verification failed', { type: event?.event_type, id: event?.id });
            return res.status(400).json({ error: 'Invalid signature' });
        }
    } catch (error) {
        console.error('[PayPal Webhook] Verification error:', error.message);
        return res.status(500).json({ error: 'Verification unavailable' });
    }
    
    const type = event.event_type;
    const resource = event.resource || {};
    console.log('[PayPal Webhook] Event received:', { type, id: event.id, resourceId: resource.id });
    
    try {
        if (type === 'CHECKOUT.ORDER.APPROVED' || type === 'PAYMENT.CAPTURE.COMPLETED') {
            const orderId = type === 'CHECKOUT.ORDER.APPROVED'
                ? resource.id
                : resource.supplementary_data?.related_ids?.order_id;
            if (!orderId || !ORDER_ID_RE.test(orderId)) {
                console.warn('[PayPal Webhook] Event without a usable order ID:', { type, id: event.id });
                return res.json({ received: true });
            }
            const result = await creditPayPalOrder(orderId, { source: 'webhook' });
            if (result.status >= 500) {
                return res.status(500).json({ error: 'Credit failed, please retry' });
            }
        } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
            const refunded = type === 'PAYMENT.CAPTURE.REFUNDED';
            await markPaymentReversed({
                orderId: resource.supplementary_data?.related_ids?.order_id || null,
                captureId: refunded ? captureIdFromLinks(resource) : resource.id,
                status: refunded ? 'refunded' : 'reversed',
                reason: refunded
                    ? `Refunded $${resource.amount?.value || '?'} on PayPal`
                    : `Chargeback/reversal on PayPal (${resource.status_details?.reason || resource.status || 'reversed'})`
            });
        }
        res.json({ received: true });
    } catch (error) {
        console.error('[PayPal Webhook] Processing error:', { type, id: event.id, error: error.message });
        res.status(500).json({ error: 'Processing failed' });
    }
}
