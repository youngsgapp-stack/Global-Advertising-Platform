/**
 * 소유권이 바뀔 때 예약 정리 (모든 소유권 이전 경로에서 같은 트랜잭션 안에서 호출)
 * - 차례가 와 있던(offered) 다른 예약자: 기회를 잃었으므로 예약금 환불 후 종료
 * - 새 주인 자신의 대기 예약: 의미가 없어졌으므로 환불 후 종료
 */
import { adjustWalletBalance } from './wallet-utils.js';

export async function hasActiveOfferedReservation(client, territoryId) {
    const result = await client.query(
        `SELECT 1 FROM territory_reservations WHERE territory_id = $1 AND status = 'offered' AND offered_until > NOW() LIMIT 1`,
        [territoryId]
    ).catch(error => (error.code === '42P01' ? { rows: [] } : Promise.reject(error)));
    return result.rows.length > 0;
}

export async function releaseReservationsOnOwnerChange(client, territoryId, newOwnerId) {
    const result = await client.query(
        `SELECT id, user_id, deposit, status FROM territory_reservations
         WHERE territory_id = $1
           AND (status = 'offered' OR (status = 'waiting' AND user_id = $2))
         FOR UPDATE`,
        [territoryId, newOwnerId]
    ).catch(error => (error.code === '42P01' ? { rows: [] } : Promise.reject(error)));
    
    for (const reservation of result.rows) {
        if (reservation.status === 'offered' && String(reservation.user_id) === String(newOwnerId)) {
            continue;
        }
        await client.query(
            `UPDATE territory_reservations SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
            [reservation.id]
        );
        const deposit = parseFloat(reservation.deposit) || 0;
        if (deposit > 0) {
            await adjustWalletBalance(client, reservation.user_id, deposit, {
                type: 'reserve_release',
                description: `Reservation refunded: ${territoryId} changed hands`,
                referenceId: `reservation:${reservation.id}`
            });
        }
    }
    
    // 이전 주인에게 온 구매 제안은 새 주인이 받을 수 없으므로 환불 (새 주인 본인의 제안은 수락 처리 중일 수 있어 제외)
    const offers = await client.query(
        `SELECT id, buyer_id, amount FROM territory_offers
         WHERE territory_id = $1 AND status = 'pending' AND buyer_id <> $2
         FOR UPDATE`,
        [territoryId, newOwnerId]
    ).catch(error => (error.code === '42P01' ? { rows: [] } : Promise.reject(error)));
    for (const offer of offers.rows) {
        await client.query(`UPDATE territory_offers SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [offer.id]);
        await adjustWalletBalance(client, offer.buyer_id, parseFloat(offer.amount), {
            type: 'offer_release',
            description: `Offer refunded: ${territoryId} changed hands`,
            referenceId: `offer:${offer.id}`
        });
    }
}
