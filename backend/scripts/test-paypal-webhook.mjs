/**
 * PayPal 웹훅/충전 통합 테스트: PayPal API는 가짜(fetch 대체)로, DB는 별도 스키마(paypal_test)에서 실제로 실행하고 끝나면 삭제
 * 실행: cd backend && node scripts/test-paypal-webhook.mjs
 */
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';

const SCHEMA = 'paypal_test';
// 트랜잭션 풀러(6543)는 SET search_path를 운영 서버 연결과 공유하므로 반드시 세션 모드(5432)로 접속
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(':6543/', ':5432/');
process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.PAYPAL_ENVIRONMENT = 'sandbox';
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST';

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await admin.query(`CREATE SCHEMA ${SCHEMA}`);
for (const table of ['users', 'wallets', 'wallet_transactions']) {
    await admin.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
}
await admin.query(`SET search_path TO ${SCHEMA}`);
for (const file of ['005_add_payments.sql', '007_add_referrals.sql']) {
    await admin.query(readFileSync(`db/migrations/${file}`, 'utf8'));
}
process.env.PGOPTIONS = `-c search_path=${SCHEMA}`;

// 가짜 PayPal
const orders = new Map();
const calls = [];
let verifyStatus = 'SUCCESS';
let lastVerifyBody = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    if (!String(url).includes('paypal.com')) return realFetch(url, options);
    calls.push({ url, method: options.method || 'GET' });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith('/v1/oauth2/token')) return json(200, { access_token: 'tok' });
    if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
        lastVerifyBody = JSON.parse(options.body);
        return json(200, { verification_status: verifyStatus });
    }
    if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        const id = `ORDER${orders.size + 1}TEST`;
        orders.set(id, { id, status: 'APPROVED', unit: body.purchase_units[0], captured: false });
        return json(201, { id, status: 'CREATED' });
    }
    const m = url.match(/\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
        const order = orders.get(decodeURIComponent(m[1]));
        if (!order) return json(404, {});
        const view = () => ({
            id: order.id,
            status: order.captured ? 'COMPLETED' : order.status,
            payer: { payer_id: 'PAYER1' },
            purchase_units: [{
                custom_id: order.unit.custom_id,
                payments: order.captured ? { captures: [{ id: `CAP-${order.id}`, status: 'COMPLETED', amount: order.unit.amount }] } : undefined
            }]
        });
        if (m[2]) {
            if (order.captured) return json(422, { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
            order.captured = true;
        }
        return json(200, view());
    }
    throw new Error(`unexpected fetch ${url}`);
};

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

function fakeRes() {
    return {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}
const headers = {
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
    'paypal-transmission-id': 'T1', 'paypal-transmission-sig': 'SIG', 'paypal-transmission-time': '2026-10-21T00:00:00Z'
};
async function sendWebhook(handler, event, extraHeaders = headers) {
    const res = fakeRes();
    await handler({ body: Buffer.from(JSON.stringify(event)), headers: extraHeaders }, res);
    return res;
}

try {
    const { initDatabase, query } = await import('../db/init.js');
    const { initRedis } = await import('../redis/init.js');
    await initDatabase();
    await initRedis();
    const sp = (await query('SHOW search_path')).rows[0].search_path;
    if (!sp.includes(SCHEMA)) throw new Error(`search_path not isolated: ${sp}`);
    
    const { paypalWebhookHandler } = await import('../routes/paypal-webhook.js');
    const { creditPayPalOrder } = await import('../utils/paypal-credit.js');
    const { createPayPalOrder } = await import('../utils/paypal.js');
    
    const user = (await query(`INSERT INTO users (firebase_uid, email, nickname) VALUES ('uid-buyer', 'buyer@test.dev', 'buyer') RETURNING id`)).rows[0].id;
    await query(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0)`, [user]);
    const balance = async () => parseFloat((await query(`SELECT balance FROM wallets WHERE user_id = $1`, [user])).rows[0].balance);
    const payment = async (orderId) => (await query(`SELECT status, user_id, points, error FROM payments WHERE order_id = $1`, [orderId])).rows[0];
    
    // 1) 주문 생성 시 사용자 id가 주문에 새겨짐
    const orderId = await createPayPalOrder({ amount: 10, customId: user, description: '100 points' });
    check('order carries user id (custom_id)', orders.get(orderId).unit.custom_id === user);
    check('order amount formatted', orders.get(orderId).unit.amount.value === '10.00');
    
    // 2) 브라우저가 닫혀서 캡처를 못 한 경우: 웹훅(ORDER.APPROVED)이 캡처+충전
    let res = await sendWebhook(paypalWebhookHandler, { id: 'EV1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } });
    check('approved webhook -> 200', res.statusCode === 200, String(res.statusCode));
    check('approved webhook credits 100pt', await balance() === 100, String(await balance()));
    check('payment recorded as credited via webhook', (await payment(orderId))?.status === 'credited');
    check('verify request embeds raw event + webhook id', lastVerifyBody?.webhook_id === 'WH-TEST' && lastVerifyBody?.webhook_event?.id === 'EV1');
    
    // 3) 이어서 CAPTURE.COMPLETED + 브라우저 캡처 요청이 늦게 와도 중복 충전 없음
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAP-${orderId}`, supplementary_data: { related_ids: { order_id: orderId } } } });
    check('capture.completed webhook -> 200', res.statusCode === 200);
    const late = await creditPayPalOrder(orderId, { userId: user, source: 'client' });
    check('late browser capture says alreadyProcessed', late.status === 200 && late.body.alreadyProcessed === true);
    check('no double credit', await balance() === 100, String(await balance()));
    
    // 4) 동시에 웹훅과 브라우저가 처리해도 한 번만 충전
    const order2 = await createPayPalOrder({ amount: 30, customId: user });
    await Promise.all([
        sendWebhook(paypalWebhookHandler, { id: 'EV3', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order2 } }),
        creditPayPalOrder(order2, { userId: user, source: 'client' })
    ]);
    check('concurrent webhook + browser credit once (350pt)', await balance() === 450, String(await balance()));
    
    // 5) 서명이 틀리면 거부, 아무것도 안 함
    verifyStatus = 'FAILURE';
    const order3 = await createPayPalOrder({ amount: 10, customId: user });
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV4', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order3 } });
    check('bad signature -> 400', res.statusCode === 400);
    check('bad signature: not captured, not credited', !orders.get(order3).captured && await balance() === 450);
    verifyStatus = 'SUCCESS';
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV5', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: order3 } }, {});
    check('missing signature headers -> 400', res.statusCode === 400);
    
    // 6) 환불 / 차지백 기록
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV6', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND1', amount: { value: '10.00' }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${orderId}` }] } });
    check('refund webhook -> 200', res.statusCode === 200);
    check('payment marked refunded', (await payment(orderId))?.status === 'refunded');
    await creditPayPalOrder(orderId, { userId: user, source: 'client' });
    check('refunded status is not overwritten by a late credit call', (await payment(orderId))?.status === 'refunded');
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV7', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: `CAP-${order2}`, status: 'REVERSED', supplementary_data: { related_ids: { order_id: order2 } } } });
    check('chargeback marked reversed', (await payment(order2))?.status === 'reversed');
    check('points are not auto-deducted (admin decides)', await balance() === 450);
    
    // 7) 옛날 방식 주문(사용자 표시 없음)이 웹훅으로만 오면: 미지급으로 기록해서 관리자가 처리
    orders.set('LEGACY0001', { id: 'LEGACY0001', status: 'APPROVED', unit: { amount: { currency_code: 'USD', value: '10.00' } }, captured: false });
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV8', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'LEGACY0001' } });
    check('legacy order without user -> 200 (no endless retries)', res.statusCode === 200);
    check('legacy order recorded as credit_failed', (await payment('LEGACY0001'))?.status === 'credit_failed');
    const legacyClient = await creditPayPalOrder('LEGACY0001', { userId: user, source: 'client' });
    check('legacy order still credited when the browser call arrives', legacyClient.status === 200 && (await payment('LEGACY0001'))?.status === 'credited' && await balance() === 550, String(await balance()));
    
    // 8) 지원 안 하는 금액은 거절
    const order4 = await createPayPalOrder({ amount: 0.5, customId: user });
    const small = await creditPayPalOrder(order4, { userId: user, source: 'client' });
    check('amount below $1 rejected', small.status === 400 && (await payment(order4))?.status === 'rejected');
    
    // 9) 웹훅 ID가 없으면 무시 (503)
    delete process.env.PAYPAL_WEBHOOK_ID;
    res = await sendWebhook(paypalWebhookHandler, { id: 'EV9', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'X' } });
    check('no PAYPAL_WEBHOOK_ID -> 503', res.statusCode === 503);
} catch (error) {
    check('test run crashed', false, error.stack);
} finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query('RESET search_path');
    await admin.end();
    console.log(results.join('\n'));
    const failed = results.filter(r => r.startsWith('FAIL')).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}
