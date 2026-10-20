/**
 * 영토 거래 기능 API (관심 등록, 대기 예약, 구매 제안, 광고판 주간 예약)
 * 상태 규칙: backend/utils/territory-phase.js
 * 마운트: /api/market (선택 인증)
 */

import express from 'express';
import { query, getPool } from '../db/init.js';
import { invalidateTerritoryCache } from '../redis/cache-utils.js';
import { broadcastTerritoryUpdate } from '../websocket/index.js';
import { validateTerritoryIdParam } from '../utils/territory-id-validator.js';
import { adjustWalletBalance, releaseAuctionHolds } from '../utils/wallet-utils.js';
import { deleteTerritoryPixels } from '../utils/pixel-cleanup.js';
import { getServerBasePrice, PURCHASE_PROTECTION_MULTIPLIERS } from './territories.js';
import {
    getTerritoryPhase, graceEndsAt, auctionStartPolicy, reservationDeposit, weekStartOf,
    SALE_FEE_RATE, OFFER_EXPIRE_DAYS, RESERVATION_CLAIM_HOURS, RESERVATION_MAX_QUEUE
} from '../utils/territory-phase.js';

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const BILLBOARD_WEEKS_AHEAD = 12;
const BOOKING_CANCEL_HOURS = 48;

class MarketError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function resolveTerritoryId(param) {
    return validateTerritoryIdParam(param, { strict: false, autoConvert: true, logWarning: false })?.canonicalId || null;
}

async function getUserId(req, db = { query }) {
    if (!req.user?.uid) return null;
    const result = await db.query(`SELECT id FROM users WHERE firebase_uid = $1`, [req.user.uid]);
    return result.rows[0]?.id || null;
}

function requireUser(userId) {
    if (!userId) throw new MarketError(401, 'Please sign in first');
}

async function hasOfferedReservation(db, territoryId) {
    const result = await db.query(
        `SELECT 1 FROM territory_reservations WHERE territory_id = $1 AND status = 'offered' AND offered_until > NOW() LIMIT 1`,
        [territoryId]
    );
    return result.rows.length > 0;
}

/** 트랜잭션 실행 + 공통 에러 응답 */
async function withTransaction(res, work) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error instanceof MarketError) {
            res.status(error.status).json({ error: error.message, ...error.extra });
        } else if (error.code === 'INSUFFICIENT_BALANCE') {
            res.status(402).json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE', required: error.required, current: error.current });
        } else {
            console.error('[Market] Error:', error);
            res.status(500).json({ error: 'Something went wrong. Please try again.' });
        }
        return undefined;
    } finally {
        client.release();
    }
}

/**
 * 소유권 이전 (구매 제안 수락, 예약 우선 구매, 광고판 교대 공통)
 * @returns {Promise<{ previousOwnerId: string|null }>}
 */
async function transferOwnership(client, territoryId, newOwnerId, { protectionEndsAt, price }) {
    const current = (await client.query(`SELECT ruler_id FROM territories WHERE id = $1 FOR UPDATE`, [territoryId])).rows[0];
    const previousOwnerId = current?.ruler_id || null;
    const activeAuctions = await client.query(`SELECT id FROM auctions WHERE territory_id = $1 AND status = 'active'`, [territoryId]);
    for (const row of activeAuctions.rows) {
        await releaseAuctionHolds(client, row.id, { reason: `Auction cancelled: ${territoryId} changed hands` });
        await client.query(`UPDATE auctions SET status = 'cancelled', ended_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
    }
    if (previousOwnerId && String(previousOwnerId) !== String(newOwnerId)) {
        await client.query(`UPDATE ownerships SET ended_at = NOW() WHERE territory_id = $1 AND ended_at IS NULL`, [territoryId]);
        await client.query(
            `INSERT INTO ownerships (territory_id, user_id, acquired_at, price) VALUES ($1, $2, NOW(), $3)`,
            [territoryId, newOwnerId, price || 0]
        );
    } else if (!previousOwnerId) {
        await client.query(
            `INSERT INTO ownerships (territory_id, user_id, acquired_at, price) VALUES ($1, $2, NOW(), $3)`,
            [territoryId, newOwnerId, price || 0]
        );
    }
    await client.query(
        `UPDATE territories
         SET ruler_id = $1,
             ruler_name = (SELECT COALESCE(nickname, 'Someone') FROM users WHERE id = $1),
             sovereignty = 'protected', status = 'protected',
             protection_ends_at = $2,
             current_auction_id = NULL,
             updated_at = NOW()
         WHERE id = $3`,
        [newOwnerId, protectionEndsAt, territoryId]
    );
    return { previousOwnerId };
}

async function afterOwnershipChange(territoryId, { previousOwnerId, newOwnerId }) {
    if (previousOwnerId && String(previousOwnerId) !== String(newOwnerId)) {
        await deleteTerritoryPixels(territoryId).catch(error => console.warn('[Market] Pixel cleanup failed:', error.message));
    }
    await invalidateTerritoryCache(territoryId);
    broadcastTerritoryUpdate(territoryId, { id: territoryId, rulerId: newOwnerId, updatedAt: new Date().toISOString() });
}

function sendError(res, error) {
    if (error instanceof MarketError) {
        return res.status(error.status).json({ error: error.message, ...error.extra });
    }
    console.error('[Market] Error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ---------------------------------------------------------------------------
// 영토 거래 정보 (패널에서 사용, 사용자별 정보 포함이라 캐시하지 않음)
// ---------------------------------------------------------------------------
router.get('/territories/:id', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        if (!territoryId) throw new MarketError(400, 'Invalid territory ID');
        const userId = await getUserId(req);
        const territory = (await query(
            `SELECT id, ruler_id, sovereignty, protection_ends_at, base_price, market_base_price, is_billboard FROM territories WHERE id = $1`,
            [territoryId]
        )).rows[0];
        if (!territory) throw new MarketError(404, 'Territory not found');
        
        const offered = await hasOfferedReservation({ query }, territoryId);
        const phase = getTerritoryPhase(territory, { hasOfferedReservation: offered });
        const isOwner = !!userId && String(territory.ruler_id) === String(userId);
        const weeklyPrice = getServerBasePrice(territory);
        
        const [watchers, watching, queue, myOffer, incoming, activeAuction] = await Promise.all([
            query(`SELECT COUNT(*) AS n FROM territory_watches WHERE territory_id = $1`, [territoryId]),
            userId ? query(`SELECT 1 FROM territory_watches WHERE territory_id = $1 AND user_id = $2`, [territoryId, userId]) : { rows: [] },
            query(
                `SELECT id, user_id, status, offered_until, deposit FROM territory_reservations
                 WHERE territory_id = $1 AND status IN ('waiting', 'offered') ORDER BY created_at`,
                [territoryId]
            ),
            userId ? query(
                `SELECT id, amount, status, expires_at FROM territory_offers WHERE territory_id = $1 AND buyer_id = $2 AND status = 'pending'`,
                [territoryId, userId]
            ) : { rows: [] },
            isOwner ? query(
                `SELECT o.id, o.amount, o.message, o.expires_at, o.created_at, COALESCE(u.nickname, 'Someone') AS buyer
                 FROM territory_offers o LEFT JOIN users u ON u.id = o.buyer_id
                 WHERE o.territory_id = $1 AND o.status = 'pending' ORDER BY o.amount DESC`,
                [territoryId]
            ) : { rows: [] },
            query(`SELECT id, kind, end_time FROM auctions WHERE territory_id = $1 AND status = 'active' LIMIT 1`, [territoryId])
        ]);
        
        const myIndex = queue.rows.findIndex(r => userId && String(r.user_id) === String(userId));
        const myReservation = myIndex >= 0 ? queue.rows[myIndex] : null;
        const auctionPolicy = activeAuction.rows.length > 0
            ? { allowed: false, reason: 'An auction is already running on this spot.' }
            : auctionStartPolicy(territory, { userId, hasOfferedReservation: offered });
        
        res.json({
            territoryId,
            phase,
            isOwner,
            weeklyPrice,
            protectionEndsAt: territory.protection_ends_at,
            graceEndsAt: graceEndsAt(territory),
            watchCount: parseInt(watchers.rows[0].n, 10),
            watching: watching.rows.length > 0,
            reservations: {
                count: queue.rows.length,
                deposit: reservationDeposit(weeklyPrice),
                myId: myReservation?.id || null,
                myPosition: myIndex >= 0 ? myIndex + 1 : null,
                myStatus: myReservation?.status || null,
                offeredUntil: myReservation?.status === 'offered' ? myReservation.offered_until : null,
                canReserve: !isOwner && ['taken', 'grace', 'open'].includes(phase) && queue.rows.length < RESERVATION_MAX_QUEUE && !myReservation
            },
            offers: {
                minAmount: weeklyPrice,
                mine: myOffer.rows[0] ? { id: myOffer.rows[0].id, amount: parseFloat(myOffer.rows[0].amount), expiresAt: myOffer.rows[0].expires_at } : null,
                incoming: incoming.rows.map(o => ({ id: o.id, amount: parseFloat(o.amount), message: o.message, buyer: o.buyer, expiresAt: o.expires_at, createdAt: o.created_at })),
                canOffer: !isOwner && !!territory.ruler_id && phase !== 'billboard',
                feeRate: SALE_FEE_RATE
            },
            auction: {
                active: activeAuction.rows[0] ? { id: activeAuction.rows[0].id, kind: activeAuction.rows[0].kind, endTime: activeAuction.rows[0].end_time } : null,
                canStart: auctionPolicy.allowed,
                kind: auctionPolicy.kind || null,
                reason: auctionPolicy.reason || null,
                allowedFrom: auctionPolicy.allowedFrom || null
            }
        });
    } catch (error) {
        sendError(res, error);
    }
});

// ---------------------------------------------------------------------------
// 관심 등록
// ---------------------------------------------------------------------------
router.post('/territories/:id/watch', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        const userId = await getUserId(req);
        requireUser(userId);
        await query(
            `INSERT INTO territory_watches (territory_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [territoryId, userId]
        );
        res.json({ success: true, watching: true });
    } catch (error) {
        if (error.code === '23503') return res.status(404).json({ error: 'Territory not found' });
        sendError(res, error);
    }
});

router.delete('/territories/:id/watch', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        const userId = await getUserId(req);
        requireUser(userId);
        await query(`DELETE FROM territory_watches WHERE territory_id = $1 AND user_id = $2`, [territoryId, userId]);
        res.json({ success: true, watching: false });
    } catch (error) {
        sendError(res, error);
    }
});

// ---------------------------------------------------------------------------
// 대기 예약
// ---------------------------------------------------------------------------
router.post('/territories/:id/reservations', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        const territory = (await client.query(
            `SELECT id, ruler_id, sovereignty, protection_ends_at, base_price, market_base_price, is_billboard FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        )).rows[0];
        if (!territory) throw new MarketError(404, 'Territory not found');
        const phase = getTerritoryPhase(territory, { hasOfferedReservation: await hasOfferedReservation(client, territoryId) });
        if (String(territory.ruler_id) === String(userId)) throw new MarketError(400, 'This is already your spot');
        if (!['taken', 'grace', 'open'].includes(phase)) {
            throw new MarketError(409, phase === 'available'
                ? 'This spot is available now. You can claim it directly.'
                : 'Reservations are not available for this spot.');
        }
        const queueSize = (await client.query(
            `SELECT COUNT(*) AS n FROM territory_reservations WHERE territory_id = $1 AND status IN ('waiting', 'offered')`,
            [territoryId]
        )).rows[0].n;
        if (parseInt(queueSize, 10) >= RESERVATION_MAX_QUEUE) throw new MarketError(409, 'The waiting list for this spot is full');
        
        const deposit = reservationDeposit(getServerBasePrice(territory));
        const inserted = await client.query(
            `INSERT INTO territory_reservations (territory_id, user_id, deposit) VALUES ($1, $2, $3)
             ON CONFLICT (territory_id, user_id) WHERE status IN ('waiting', 'offered') DO NOTHING RETURNING id`,
            [territoryId, userId, deposit]
        );
        if (inserted.rows.length === 0) throw new MarketError(409, 'You are already on the waiting list');
        const reservationId = inserted.rows[0].id;
        const { balance } = await adjustWalletBalance(client, userId, -deposit, {
            type: 'reserve_hold',
            description: `Reservation deposit: ${territoryId}`,
            referenceId: `reservation:${reservationId}`
        });
        return { reservationId, deposit, position: parseInt(queueSize, 10) + 1, balance };
    });
    if (result) res.json({ success: true, ...result });
});

router.delete('/reservations/:rid', async (req, res) => {
    const reservationId = parseInt(req.params.rid, 10);
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        const reservation = (await client.query(
            `SELECT * FROM territory_reservations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [reservationId, userId]
        )).rows[0];
        if (!reservation) throw new MarketError(404, 'Reservation not found');
        if (reservation.status === 'offered') {
            // 차례가 온 뒤 포기: 예약금은 돌려주지 않음 (대기열을 잡아둔 비용)
            await client.query(`UPDATE territory_reservations SET status = 'expired', updated_at = NOW() WHERE id = $1`, [reservationId]);
            return { refunded: 0 };
        }
        if (reservation.status !== 'waiting') throw new MarketError(409, 'This reservation is already closed');
        await client.query(`UPDATE territory_reservations SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [reservationId]);
        const deposit = parseFloat(reservation.deposit);
        await adjustWalletBalance(client, userId, deposit, {
            type: 'reserve_release',
            description: `Reservation cancelled: ${reservation.territory_id}`,
            referenceId: `reservation:${reservationId}`
        });
        return { refunded: deposit };
    });
    if (result) res.json({ success: true, ...result });
});

/** 차례가 온 예약자의 우선 구매 (예약금은 구매가에서 차감) */
router.post('/territories/:id/reservations/claim', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const raw = req.body?.protectionDays;
    const protectionDays = raw === null || raw === undefined || raw === 'lifetime' ? null : Number(raw);
    const multiplier = PURCHASE_PROTECTION_MULTIPLIERS[protectionDays === null ? 'lifetime' : protectionDays];
    let change = null;
    const result = await withTransaction(res, async (client) => {
        if (!multiplier) throw new MarketError(400, 'Invalid protection period');
        const userId = await getUserId(req, client);
        requireUser(userId);
        const reservation = (await client.query(
            `SELECT * FROM territory_reservations
             WHERE territory_id = $1 AND user_id = $2 AND status = 'offered' AND offered_until > NOW() FOR UPDATE`,
            [territoryId, userId]
        )).rows[0];
        if (!reservation) throw new MarketError(409, 'It is not your turn for this spot (or your turn has expired)');
        const territory = (await client.query(
            `SELECT id, base_price, market_base_price FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        )).rows[0];
        const price = Math.ceil(getServerBasePrice(territory) * multiplier);
        const deposit = parseFloat(reservation.deposit);
        const { balance } = await adjustWalletBalance(client, userId, -(price - deposit), {
            type: 'purchase',
            description: `Reserved spot claimed: ${territoryId} (deposit ${deposit} pt applied)`,
            referenceId: territoryId
        });
        const protectionEndsAt = protectionDays === null ? null : new Date(Date.now() + protectionDays * DAY_MS);
        const { previousOwnerId } = await transferOwnership(client, territoryId, userId, { protectionEndsAt, price });
        await client.query(`UPDATE territory_reservations SET status = 'converted', updated_at = NOW() WHERE id = $1`, [reservation.id]);
        change = { previousOwnerId, newOwnerId: userId };
        return { price, depositApplied: deposit, balance, protectionEndsAt };
    });
    if (result) {
        await afterOwnershipChange(territoryId, change);
        res.json({ success: true, ...result });
    }
});

// ---------------------------------------------------------------------------
// 구매 제안
// ---------------------------------------------------------------------------
router.post('/territories/:id/offers', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const amount = Number(req.body?.amount);
    const message = String(req.body?.message || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 200);
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        if (!Number.isInteger(amount) || amount <= 0) throw new MarketError(400, 'Offer must be a whole number of points');
        const territory = (await client.query(
            `SELECT id, ruler_id, base_price, market_base_price, is_billboard FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        )).rows[0];
        if (!territory) throw new MarketError(404, 'Territory not found');
        if (!territory.ruler_id) throw new MarketError(409, 'This spot has no owner. You can claim it directly.');
        if (territory.is_billboard) throw new MarketError(409, 'Billboard spots are booked by the week');
        if (String(territory.ruler_id) === String(userId)) throw new MarketError(400, 'This is already your spot');
        const minAmount = getServerBasePrice(territory);
        if (amount < minAmount) throw new MarketError(400, `Offers start from ${minAmount} pt (one week's price)`, { minAmount });
        
        const inserted = await client.query(
            `INSERT INTO territory_offers (territory_id, buyer_id, seller_id, amount, message, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * interval '1 day'))
             ON CONFLICT (territory_id, buyer_id) WHERE status = 'pending' DO NOTHING RETURNING id, expires_at`,
            [territoryId, userId, territory.ruler_id, amount, message || null, OFFER_EXPIRE_DAYS]
        );
        if (inserted.rows.length === 0) throw new MarketError(409, 'You already have an open offer on this spot. Cancel it to make a new one.');
        const offerId = inserted.rows[0].id;
        const { balance } = await adjustWalletBalance(client, userId, -amount, {
            type: 'offer_hold',
            description: `Offer on ${territoryId}`,
            referenceId: `offer:${offerId}`
        });
        return { offerId, amount, expiresAt: inserted.rows[0].expires_at, balance };
    });
    if (result) res.json({ success: true, ...result });
});

async function closeOffer(client, offer, status, reason) {
    await client.query(`UPDATE territory_offers SET status = $1, updated_at = NOW() WHERE id = $2`, [status, offer.id]);
    await adjustWalletBalance(client, offer.buyer_id, parseFloat(offer.amount), {
        type: 'offer_release',
        description: reason,
        referenceId: `offer:${offer.id}`
    });
}

router.post('/offers/:oid/:action', async (req, res) => {
    const offerId = parseInt(req.params.oid, 10);
    const action = req.params.action;
    if (!['accept', 'decline', 'cancel'].includes(action)) {
        return res.status(404).json({ error: 'Unknown action' });
    }
    let change = null;
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        const offer = (await client.query(`SELECT * FROM territory_offers WHERE id = $1 FOR UPDATE`, [offerId])).rows[0];
        if (!offer || offer.status !== 'pending') throw new MarketError(404, 'This offer is no longer open');
        
        if (action === 'cancel') {
            if (String(offer.buyer_id) !== String(userId)) throw new MarketError(403, 'Only the buyer can cancel this offer');
            await closeOffer(client, offer, 'cancelled', `Offer cancelled: ${offer.territory_id}`);
            return { status: 'cancelled' };
        }
        
        const territory = (await client.query(
            `SELECT id, ruler_id, sovereignty, protection_ends_at FROM territories WHERE id = $1 FOR UPDATE`,
            [offer.territory_id]
        )).rows[0];
        if (!territory || String(territory.ruler_id) !== String(userId)) throw new MarketError(403, 'Only the current owner can answer this offer');
        
        if (action === 'decline') {
            await closeOffer(client, offer, 'declined', `Offer declined: ${offer.territory_id}`);
            return { status: 'declined' };
        }
        
        // 수락: 구매자는 남은 기간(평생 포함)을 이어받고, 기간이 끝나 있었다면 최소 7일 보장
        const amount = parseFloat(offer.amount);
        const isLifetime = territory.sovereignty === 'protected' && !territory.protection_ends_at;
        const remaining = territory.protection_ends_at ? new Date(territory.protection_ends_at).getTime() : 0;
        const protectionEndsAt = isLifetime ? null : new Date(Math.max(remaining, Date.now() + 7 * DAY_MS));
        const { previousOwnerId } = await transferOwnership(client, offer.territory_id, offer.buyer_id, { protectionEndsAt, price: amount });
        await client.query(`UPDATE territory_offers SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [offer.id]);
        const payout = Math.floor(amount * (1 - SALE_FEE_RATE));
        await adjustWalletBalance(client, userId, payout, {
            type: 'sale',
            description: `Sold ${offer.territory_id} (${amount} pt offer, ${Math.round(SALE_FEE_RATE * 100)}% fee)`,
            referenceId: `offer:${offer.id}`
        });
        // 같은 영토의 다른 제안은 모두 환불
        const others = await client.query(
            `SELECT * FROM territory_offers WHERE territory_id = $1 AND status = 'pending' AND id <> $2 FOR UPDATE`,
            [offer.territory_id, offer.id]
        );
        for (const other of others.rows) {
            await closeOffer(client, other, 'cancelled', `Offer refunded: ${offer.territory_id} was sold to someone else`);
        }
        change = { previousOwnerId, newOwnerId: offer.buyer_id, territoryId: offer.territory_id };
        return { status: 'accepted', payout };
    });
    if (result) {
        if (change) await afterOwnershipChange(change.territoryId, change);
        res.json({ success: true, ...result });
    }
});

// ---------------------------------------------------------------------------
// 광고판 (주 단위 예약)
// ---------------------------------------------------------------------------
function upcomingWeeks(count = BILLBOARD_WEEKS_AHEAD) {
    const first = new Date(`${weekStartOf()}T00:00:00Z`);
    return Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10));
}

router.get('/territories/:id/billboard', async (req, res) => {
    try {
        const territoryId = resolveTerritoryId(req.params.id);
        const userId = await getUserId(req);
        const territory = (await query(
            `SELECT id, is_billboard, base_price, market_base_price FROM territories WHERE id = $1`,
            [territoryId]
        )).rows[0];
        if (!territory) throw new MarketError(404, 'Territory not found');
        if (!territory.is_billboard) throw new MarketError(409, 'This spot is not a billboard');
        const weeks = upcomingWeeks();
        const bookings = await query(
            `SELECT b.id, to_char(b.week_start, 'YYYY-MM-DD') AS week_start, b.user_id, b.status, COALESCE(u.nickname, 'Someone') AS nickname
             FROM billboard_bookings b LEFT JOIN users u ON u.id = b.user_id
             WHERE b.territory_id = $1 AND b.status IN ('booked', 'active') AND b.week_start >= $2::date`,
            [territoryId, weeks[0]]
        );
        const byWeek = new Map(bookings.rows.map(b => [b.week_start, b]));
        const price = getServerBasePrice(territory);
        res.json({
            territoryId,
            weeklyPrice: price,
            cancelHours: BOOKING_CANCEL_HOURS,
            weeks: weeks.map(week => {
                const booking = byWeek.get(week);
                const mine = booking && userId && String(booking.user_id) === String(userId);
                const startsInMs = new Date(`${week}T00:00:00Z`).getTime() - Date.now();
                return {
                    weekStart: week,
                    status: booking ? (mine ? 'mine' : 'booked') : 'free',
                    bookingId: mine ? booking.id : null,
                    bookedBy: booking && !mine ? booking.nickname : null,
                    canCancel: !!mine && booking.status === 'booked' && startsInMs > BOOKING_CANCEL_HOURS * 60 * 60 * 1000,
                    price
                };
            })
        });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/territories/:id/billboard/bookings', async (req, res) => {
    const territoryId = resolveTerritoryId(req.params.id);
    const requested = Array.isArray(req.body?.weeks) ? [...new Set(req.body.weeks.map(String))] : [];
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        const allowedWeeks = new Set(upcomingWeeks());
        if (requested.length === 0 || requested.length > BILLBOARD_WEEKS_AHEAD || requested.some(w => !allowedWeeks.has(w))) {
            throw new MarketError(400, `Pick weeks within the next ${BILLBOARD_WEEKS_AHEAD} weeks`);
        }
        const territory = (await client.query(
            `SELECT id, is_billboard, base_price, market_base_price FROM territories WHERE id = $1 FOR UPDATE`,
            [territoryId]
        )).rows[0];
        if (!territory?.is_billboard) throw new MarketError(409, 'This spot is not a billboard');
        const price = getServerBasePrice(territory);
        const taken = await client.query(
            `SELECT to_char(week_start, 'YYYY-MM-DD') AS week FROM billboard_bookings
             WHERE territory_id = $1 AND status IN ('booked', 'active') AND week_start = ANY($2::date[])`,
            [territoryId, requested]
        );
        if (taken.rows.length > 0) {
            throw new MarketError(409, `Already booked: ${taken.rows.map(r => r.week).join(', ')}`, { takenWeeks: taken.rows.map(r => r.week) });
        }
        const ids = [];
        for (const week of requested.sort()) {
            const inserted = await client.query(
                `INSERT INTO billboard_bookings (territory_id, user_id, week_start, price) VALUES ($1, $2, $3, $4) RETURNING id`,
                [territoryId, userId, week, price]
            );
            ids.push(inserted.rows[0].id);
        }
        const total = price * requested.length;
        const { balance } = await adjustWalletBalance(client, userId, -total, {
            type: 'booking',
            description: `Billboard ${territoryId}: ${requested.length} week(s)`,
            referenceId: `billboard:${territoryId}`
        });
        return { bookingIds: ids, weeks: requested.sort(), total, balance };
    });
    if (result) {
        processBillboards().catch(() => {});
        res.json({ success: true, ...result });
    }
});

router.delete('/bookings/:bid', async (req, res) => {
    const bookingId = parseInt(req.params.bid, 10);
    const result = await withTransaction(res, async (client) => {
        const userId = await getUserId(req, client);
        requireUser(userId);
        const booking = (await client.query(
            `SELECT * FROM billboard_bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [bookingId, userId]
        )).rows[0];
        if (!booking || booking.status !== 'booked') throw new MarketError(404, 'Booking not found');
        if (new Date(booking.week_start).getTime() - Date.now() <= BOOKING_CANCEL_HOURS * 60 * 60 * 1000) {
            throw new MarketError(409, `Bookings can be cancelled up to ${BOOKING_CANCEL_HOURS} hours before the week starts`);
        }
        await client.query(`UPDATE billboard_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [bookingId]);
        await adjustWalletBalance(client, userId, parseFloat(booking.price), {
            type: 'booking_refund',
            description: `Billboard booking cancelled: ${booking.territory_id}`,
            referenceId: `billboard:${booking.territory_id}`
        });
        return { refunded: parseFloat(booking.price) };
    });
    if (result) res.json({ success: true, ...result });
});

// ---------------------------------------------------------------------------
// 로그인 알림 (받은 제안, 예약 차례, 관심 영토 소식)
// ---------------------------------------------------------------------------
router.get('/me/notices', async (req, res) => {
    try {
        const userId = await getUserId(req);
        requireUser(userId);
        const [offers, turns, watches] = await Promise.all([
            query(
                `SELECT o.territory_id, t.name, COUNT(*) AS n, MAX(o.amount) AS best
                 FROM territory_offers o JOIN territories t ON t.id = o.territory_id
                 WHERE t.ruler_id = $1 AND o.status = 'pending'
                 GROUP BY o.territory_id, t.name`,
                [userId]
            ),
            query(
                `SELECT r.territory_id, t.name, r.offered_until FROM territory_reservations r JOIN territories t ON t.id = r.territory_id
                 WHERE r.user_id = $1 AND r.status = 'offered' AND r.offered_until > NOW()`,
                [userId]
            ),
            query(
                `SELECT w.territory_id, w.notified_key, t.name, t.ruler_id, t.sovereignty, t.protection_ends_at, t.is_billboard,
                        EXISTS (SELECT 1 FROM auctions a WHERE a.territory_id = t.id AND a.status = 'active') AS has_auction,
                        EXISTS (SELECT 1 FROM territory_reservations r WHERE r.territory_id = t.id AND r.status = 'offered' AND r.offered_until > NOW()) AS has_offered
                 FROM territory_watches w JOIN territories t ON t.id = w.territory_id
                 WHERE w.user_id = $1`,
                [userId]
            )
        ]);
        const watchAlerts = [];
        for (const w of watches.rows) {
            const phase = getTerritoryPhase(w, { hasOfferedReservation: w.has_offered });
            const event = w.has_auction ? 'auction' : (['available', 'open'].includes(phase) ? phase : null);
            if (!event) continue;
            const key = `${event}:${w.ruler_id || ''}:${w.protection_ends_at ? new Date(w.protection_ends_at).getTime() : ''}`;
            if (w.notified_key === key) continue;
            watchAlerts.push({ territoryId: w.territory_id, name: w.name, event });
            await query(`UPDATE territory_watches SET notified_key = $1 WHERE territory_id = $2 AND user_id = $3`, [key, w.territory_id, userId]);
        }
        res.json({
            offersReceived: offers.rows.map(o => ({ territoryId: o.territory_id, name: o.name, count: parseInt(o.n, 10), best: parseFloat(o.best) })),
            reservationTurns: turns.rows.map(r => ({ territoryId: r.territory_id, name: r.name, offeredUntil: r.offered_until })),
            watchAlerts
        });
    } catch (error) {
        sendError(res, error);
    }
});

// ---------------------------------------------------------------------------
// 주기 작업 (server.js에서 1분마다 실행)
// ---------------------------------------------------------------------------

/** 유예가 끝난 영토의 1순위 예약자에게 48시간 우선 구매권, 지난 차례는 만료(예약금 미환불) */
async function processReservations() {
    await query(
        `UPDATE territory_reservations SET status = 'expired', updated_at = NOW()
         WHERE status = 'offered' AND offered_until <= NOW()`
    );
    const candidates = await query(
        `SELECT DISTINCT ON (r.territory_id) r.id, r.territory_id, t.ruler_id, t.sovereignty, t.protection_ends_at, t.is_billboard
         FROM territory_reservations r JOIN territories t ON t.id = r.territory_id
         WHERE r.status = 'waiting'
           AND NOT EXISTS (SELECT 1 FROM territory_reservations o WHERE o.territory_id = r.territory_id AND o.status = 'offered')
           AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.territory_id = r.territory_id AND a.status = 'active')
         ORDER BY r.territory_id, r.created_at`
    );
    let offered = 0;
    for (const row of candidates.rows) {
        const phase = getTerritoryPhase(row);
        if (phase !== 'open' && phase !== 'available') continue;
        await query(
            `UPDATE territory_reservations SET status = 'offered', offered_until = NOW() + ($2::int * interval '1 hour'), updated_at = NOW()
             WHERE id = $1 AND status = 'waiting'`,
            [row.id, RESERVATION_CLAIM_HOURS]
        );
        await invalidateTerritoryCache(row.territory_id);
        offered++;
    }
    return offered;
}

/** 7일 지난 구매 제안 환불 */
async function expireOffers() {
    const client = await getPool().connect();
    try {
        const expired = await client.query(`SELECT * FROM territory_offers WHERE status = 'pending' AND expires_at <= NOW() LIMIT 100`);
        for (const offer of expired.rows) {
            await client.query('BEGIN');
            try {
                const locked = (await client.query(`SELECT * FROM territory_offers WHERE id = $1 AND status = 'pending' FOR UPDATE`, [offer.id])).rows[0];
                if (locked) await closeOffer(client, locked, 'expired', `Offer expired: ${offer.territory_id}`);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('[Market] Offer expiry failed:', offer.id, error.message);
            }
        }
        return expired.rows.length;
    } finally {
        client.release();
    }
}

/** 광고판 주간 교대: 이번 주 예약자에게 영토를 넘기고, 예약이 없으면 비움 */
async function processBillboards() {
    const thisWeek = weekStartOf();
    const weekEnd = new Date(new Date(`${thisWeek}T00:00:00Z`).getTime() + 7 * DAY_MS);
    const billboards = await query(
        `SELECT t.id, t.ruler_id, b.id AS booking_id, b.user_id AS booker_id, b.price
         FROM territories t
         LEFT JOIN billboard_bookings b ON b.territory_id = t.id AND b.week_start = $1::date AND b.status IN ('booked', 'active')
         WHERE t.is_billboard = true`,
        [thisWeek]
    );
    for (const row of billboards.rows) {
        const needsChange = row.booker_id
            ? String(row.ruler_id) !== String(row.booker_id)
            : !!row.ruler_id;
        const client = await getPool().connect();
        let change = null;
        try {
            await client.query('BEGIN');
            await client.query(
                `UPDATE billboard_bookings SET status = 'done', updated_at = NOW()
                 WHERE territory_id = $1 AND status = 'active' AND week_start < $2::date`,
                [row.id, thisWeek]
            );
            if (row.booker_id) {
                await client.query(`UPDATE billboard_bookings SET status = 'active', updated_at = NOW() WHERE id = $1`, [row.booking_id]);
                if (needsChange) {
                    const { previousOwnerId } = await transferOwnership(client, row.id, row.booker_id, { protectionEndsAt: weekEnd, price: row.price });
                    change = { previousOwnerId, newOwnerId: row.booker_id };
                } else {
                    await client.query(`UPDATE territories SET protection_ends_at = $1, sovereignty = 'protected', status = 'protected' WHERE id = $2`, [weekEnd, row.id]);
                }
            } else if (needsChange) {
                await client.query(`UPDATE ownerships SET ended_at = NOW() WHERE territory_id = $1 AND ended_at IS NULL`, [row.id]);
                await client.query(
                    `UPDATE territories SET ruler_id = NULL, ruler_name = NULL, sovereignty = 'unconquered', status = 'unconquered',
                         protection_ends_at = NULL, current_auction_id = NULL, updated_at = NOW()
                     WHERE id = $1`,
                    [row.id]
                );
                change = { previousOwnerId: row.ruler_id, newOwnerId: null };
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Market] Billboard rotation failed:', row.id, error.message);
            change = null;
        } finally {
            client.release();
        }
        if (change) await afterOwnershipChange(row.id, change);
    }
}

export async function processMarketJobs() {
    await processReservations();
    await expireOffers();
    await processBillboards();
}

export { router as marketRouter };
