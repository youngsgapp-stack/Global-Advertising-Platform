/**
 * 영토 거래 상태 표시 (서버 규칙: backend/utils/territory-phase.js 와 같은 기준)
 */

export const GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(value) {
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * 브라우저가 가진 영토 정보로 상태 추정 (예약 차례/광고판은 서버 응답으로 보정)
 */
export function clientPhase(territory, now = Date.now()) {
    if (!territory) return 'available';
    if (territory.isBillboard) return 'billboard';
    if (!territory.ruler) return 'available';
    const endsAt = territory.protectionEndsAt ? new Date(territory.protectionEndsAt).getTime() : null;
    if (!endsAt) return territory.sovereignty === 'protected' ? 'lifetime' : 'open';
    if (endsAt > now) return 'taken';
    if (endsAt + GRACE_DAYS * DAY_MS > now) return 'grace';
    return 'open';
}

/**
 * @returns {{ icon: string, text: string, className: string }}
 */
export function phaseLabel(phase, { protectionEndsAt = null, graceEndsAt = null, isMine = false, onAuction = false } = {}) {
    if (onAuction) return { icon: '🔥', text: 'On auction', className: 'contested' };
    const grace = graceEndsAt || (protectionEndsAt ? new Date(new Date(protectionEndsAt).getTime() + GRACE_DAYS * DAY_MS) : null);
    switch (phase) {
        case 'taken':
            return { icon: isMine ? '👑' : '🔒', text: `${isMine ? 'Your spot' : 'Taken'} · until ${formatDate(protectionEndsAt)}`, className: 'protected' };
        case 'lifetime':
            return { icon: '👑', text: isMine ? 'Yours forever' : 'Owned forever', className: 'protected' };
        case 'grace':
            return { icon: '⏳', text: isMine ? `Renew by ${formatDate(grace)} to keep it` : `Expiring · owner can renew until ${formatDate(grace)}`, className: 'ruled' };
        case 'reserved':
            return { icon: '🎟️', text: 'Next in line is buying', className: 'ruled' };
        case 'open':
            return { icon: '🔓', text: isMine ? 'Your spot · open for bids' : 'Open for bids', className: 'ruled' };
        case 'billboard':
            return { icon: '📅', text: 'Billboard · book by the week', className: 'protected' };
        default:
            return { icon: '✅', text: 'Available', className: 'unconquered' };
    }
}
