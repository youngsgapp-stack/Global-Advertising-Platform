/**
 * 영토 거래 상태(phase) 규칙 — 경매/예약/제안/광고판 기능이 모두 이 기준을 따름
 *
 * available : 주인 없음                         → 누구나 구매/경매
 * taken     : 산 기간이 남아 있음                → 다른 사람은 관심/예약/제안, 마감 7일 전부터 '다음 기간 경매'
 * lifetime  : 평생 소장                          → 다른 사람은 관심/제안만
 * grace     : 기간 끝난 뒤 3일                   → 주인만 연장 가능
 * reserved  : 유예가 끝났고 1순위 예약자 차례(48시간) → 그 예약자만 구매
 * open      : 유예가 끝났고 예약 없음             → 누구나 경매(원래 주인 보상 없음)
 * billboard : 관리자가 지정한 광고판             → 주 단위 예약만
 */

export const GRACE_DAYS = 3;
export const RESERVATION_CLAIM_HOURS = 48;
export const NEXT_PERIOD_AUCTION_WINDOW_DAYS = 7;
export const SALE_FEE_RATE = 0.1;
export const OFFER_EXPIRE_DAYS = 7;
export const RESERVATION_DEPOSIT_RATE = 0.1;
export const RESERVATION_MIN_DEPOSIT = 10;
export const RESERVATION_MAX_QUEUE = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} territory - territories 행 (ruler_id, sovereignty, protection_ends_at, is_billboard)
 * @param {object} [options]
 * @param {boolean} [options.hasOfferedReservation] - 지금 우선 구매권을 받은 예약자가 있는지
 * @param {Date} [options.now]
 */
export function getTerritoryPhase(territory, { hasOfferedReservation = false, now = new Date() } = {}) {
    if (!territory) return 'available';
    if (territory.is_billboard) return 'billboard';
    if (!territory.ruler_id) return 'available';
    const endsAt = territory.protection_ends_at ? new Date(territory.protection_ends_at) : null;
    if (!endsAt) {
        return territory.sovereignty === 'protected' ? 'lifetime' : (hasOfferedReservation ? 'reserved' : 'open');
    }
    if (endsAt > now) return 'taken';
    if (endsAt.getTime() + GRACE_DAYS * DAY_MS > now.getTime()) return 'grace';
    return hasOfferedReservation ? 'reserved' : 'open';
}

export function graceEndsAt(territory) {
    if (!territory?.protection_ends_at) return null;
    return new Date(new Date(territory.protection_ends_at).getTime() + GRACE_DAYS * DAY_MS);
}

/**
 * 경매 시작 가능 여부와 종류
 * @returns {{ allowed: boolean, kind?: string, endTime?: Date, reason?: string, allowedFrom?: Date }}
 */
export function auctionStartPolicy(territory, { userId, isAdmin = false, hasOfferedReservation = false, now = new Date() } = {}) {
    const phase = getTerritoryPhase(territory, { hasOfferedReservation, now });
    const isOwner = userId && territory?.ruler_id && String(territory.ruler_id) === String(userId);
    
    if (phase === 'billboard') {
        return { allowed: false, reason: 'This spot is a billboard. Book a weekly slot instead.' };
    }
    if (isOwner && phase !== 'available') {
        return { allowed: true, kind: 'owner_sale' };
    }
    switch (phase) {
        case 'available':
        case 'open':
            return { allowed: true, kind: 'standard' };
        case 'taken': {
            const endsAt = new Date(territory.protection_ends_at);
            const allowedFrom = new Date(endsAt.getTime() - NEXT_PERIOD_AUCTION_WINDOW_DAYS * DAY_MS);
            if (now < allowedFrom && !isAdmin) {
                return {
                    allowed: false,
                    allowedFrom,
                    reason: `This spot is taken until ${endsAt.toISOString().slice(0, 10)}. A next-period auction can start from ${allowedFrom.toISOString().slice(0, 10)}.`
                };
            }
            if (endsAt.getTime() - now.getTime() < 60 * 60 * 1000) {
                return { allowed: false, reason: 'The current period ends in less than an hour. Try again after it ends.' };
            }
            return { allowed: true, kind: 'next_period', endTime: endsAt };
        }
        case 'lifetime':
            return { allowed: false, reason: 'This spot is owned forever. You can make an offer to the owner instead.' };
        case 'grace':
            return { allowed: false, reason: `The owner can renew until ${graceEndsAt(territory).toISOString().slice(0, 10)}. You can reserve the next turn.` };
        case 'reserved':
            return { allowed: false, reason: 'The next person in line has the first right to buy this spot right now.' };
        default:
            return { allowed: false, reason: 'Auctions are not available for this spot right now.' };
    }
}

export function reservationDeposit(weeklyPrice) {
    return Math.max(RESERVATION_MIN_DEPOSIT, Math.ceil(weeklyPrice * RESERVATION_DEPOSIT_RATE));
}

/** 월요일 00:00 UTC 기준 주 시작일 (YYYY-MM-DD) */
export function weekStartOf(date = new Date()) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    return d.toISOString().slice(0, 10);
}
