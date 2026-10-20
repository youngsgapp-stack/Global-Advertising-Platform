/**
 * 지갑 증감 유틸 (서버 전용)
 * 모든 함수는 BEGIN된 트랜잭션 client를 받아야 함
 */

/**
 * 지갑 잔액을 delta만큼 변경하고 wallet_transactions에 기록
 * @returns {Promise<{ balance: number, walletId: string }>}
 * @throws {Error} code === 'INSUFFICIENT_BALANCE' (잔액이 음수가 되는 경우)
 */
export async function adjustWalletBalance(client, userId, delta, { type, description = '', referenceId = null } = {}) {
    if (!Number.isFinite(delta)) {
        throw new Error(`Invalid wallet delta: ${delta}`);
    }
    
    let walletResult = await client.query(
        `SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId]
    );
    
    if (walletResult.rows.length === 0) {
        walletResult = await client.query(
            `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) RETURNING id, balance`,
            [userId]
        );
    }
    
    const wallet = walletResult.rows[0];
    const currentBalance = parseFloat(wallet.balance || 0);
    const newBalance = currentBalance + delta;
    
    if (newBalance < 0) {
        const error = new Error('Insufficient balance');
        error.code = 'INSUFFICIENT_BALANCE';
        error.required = -delta;
        error.current = currentBalance;
        throw error;
    }
    
    await client.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
        [newBalance, wallet.id]
    );
    
    await client.query(
        `INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [wallet.id, userId, type, delta, description, referenceId]
    );
    
    return { balance: newBalance, walletId: wallet.id };
}

/**
 * 경매 입찰 예치금 참조 키
 */
export function auctionHoldReference(auctionId) {
    return `auction_hold:${auctionId}`;
}

/**
 * 경매에 예치된 입찰금을 모두 돌려줌 (상위 입찰 발생, 경매 삭제/취소 시)
 * @param {string|null} exceptUserId - 이 사용자의 예치금은 유지 (낙찰자 확정 시 사용)
 */
export async function releaseAuctionHolds(client, auctionId, { exceptUserId = null, reason = 'Bid refund' } = {}) {
    const reference = auctionHoldReference(auctionId);
    const holdsResult = await client.query(
        `SELECT user_id, SUM(amount) AS held
         FROM wallet_transactions
         WHERE reference_id = $1 AND type IN ('bid_hold', 'bid_release')
         GROUP BY user_id
         HAVING SUM(amount) < 0`,
        [reference]
    );
    
    for (const row of holdsResult.rows) {
        if (exceptUserId && String(row.user_id) === String(exceptUserId)) {
            continue;
        }
        await adjustWalletBalance(client, row.user_id, -parseFloat(row.held), {
            type: 'bid_release',
            description: reason,
            referenceId: reference
        });
    }
}
