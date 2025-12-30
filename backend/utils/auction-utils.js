/**
 * Auction Utility Functions
 * 옥션 관련 공통 유틸리티 함수
 */

/**
 * 입찰금액에 따른 보호기간 계산 (일수)
 * ⚠️ 전문가 조언: winning_amount 기준으로 계산
 * 
 * @param {number} bidAmount - 입찰금액 (포인트)
 * @returns {number} 보호기간 (일수)
 */
export function calculateProtectionDays(bidAmount) {
    // 안전한 파싱 및 검증
    const amount = parseFloat(bidAmount);
    if (!isFinite(amount) || amount <= 0) {
        return 7; // 기본값: 1주일
    }
    
    // 입찰금액에 따른 보호기간 계산
    if (amount >= 400) {
        return 30; // 400pt 이상: 1개월 (30일)
    } else if (amount >= 300) {
        return 28; // 300-399pt: 4주일
    } else if (amount >= 200) {
        return 21; // 200-299pt: 3주일
    } else if (amount >= 100) {
        return 14; // 100-199pt: 2주일
    } else {
        return 7;  // 0-99pt: 1주일
    }
}

/**
 * 보호 기간 종료 시각 계산 (입찰금액 기반)
 * ⚠️ 전문가 조언: DB now() 기준으로 계산하는 것이 더 안정적
 * 하지만 함수 호출 시점의 Date.now()를 사용 (트랜잭션 내에서 호출 시 DB now()와 거의 동일)
 * 
 * @param {number} bidAmount - 입찰금액 (포인트)
 * @returns {Date} 보호 종료 시각
 */
export function calculateProtectionEndsAtFromBid(bidAmount) {
    const protectionDays = calculateProtectionDays(bidAmount);
    return new Date(Date.now() + protectionDays * 24 * 60 * 60 * 1000);
}

/**
 * 보호 기간 종료 시각 계산 (일수 기반, 레거시 호환)
 * ✅ 모든 종료 로직(admin, cron, 복구)에서 동일한 계산 사용
 * 
 * @param {number} protectionDays - 보호 기간 (일수), 기본값 7일
 * @returns {Date} 보호 종료 시각
 */
export function calculateProtectionEndsAt(protectionDays = 7) {
    return new Date(Date.now() + protectionDays * 24 * 60 * 60 * 1000);
}

/**
 * 옥션 종료 성공 로그 출력
 * ✅ 종료 성공 시 상세 정보를 한 줄로 로깅
 * 
 * @param {Object} params
 * @param {string} params.auctionId - 옥션 ID
 * @param {string} params.territoryId - 영토 ID
 * @param {string|null} params.winnerUserId - 낙찰자 사용자 ID (없으면 null)
 * @param {Date} params.protectionEndsAt - 보호 종료 시각
 * @param {number} params.processingTimeMs - 처리 소요 시간 (밀리초)
 * @param {string} params.source - 종료 소스 ('admin', 'cron', 'recovery')
 */
export function logAuctionEndSuccess({ 
    auctionId, 
    territoryId, 
    winnerUserId, 
    protectionEndsAt, 
    processingTimeMs,
    source = 'unknown'
}) {
    console.log(`[Auction End Success] auctionId=${auctionId} territoryId=${territoryId} winnerUserId=${winnerUserId || 'null'} protectionEndsAt=${protectionEndsAt.toISOString()} processingTime=${processingTimeMs}ms source=${source}`);
}

/**
 * 옥션 종료 처리 공통 함수
 * ⚠️ 전문가 조언: 모든 종료 처리는 이 함수 하나로만 처리
 * - 관리자 종료, cron 자동 종료, 수동 종료 모두 이 함수 사용
 * 
 * @param {Object} params
 * @param {Object} params.client - PostgreSQL 클라이언트 (트랜잭션 내)
 * @param {string} params.auctionId - 옥션 ID
 * @param {Object} params.auction - 옥션 정보 (bids 테이블 조회 결과 포함)
 * @param {string} params.source - 종료 소스 ('admin', 'cron', 'manual')
 * @returns {Promise<Object>} 종료 결과 { hasWinner, finalBid, finalBidderId, finalBidderNickname, winningBidId, protectionEndsAt, newMarketBase }
 */
export async function finalizeAuctionEnd({ client, auctionId, auction, source = 'unknown' }) {
    // 1. 레이스 방어: bids 테이블에서 최종 승자 재확인 (종료 직전 입찰 방어)
    const bidsResult = await client.query(
        `SELECT 
            id,
            amount,
            user_id,
            created_at
        FROM bids 
        WHERE auction_id = $1 
            AND created_at <= (SELECT end_time FROM auctions WHERE id = $1)
        ORDER BY amount DESC, created_at ASC
        LIMIT 1`,
        [auctionId]
    );
    
    // 최종 승자 결정: bids 테이블의 최고 입찰 vs auctions 테이블의 current_bid
    let finalBid = parseFloat(auction.current_bid || 0);
    let finalBidderId = auction.current_bidder_id;
    let finalBidderNickname = auction.bidder_nickname || 'Unknown';
    let winningBidId = null;
    
    if (bidsResult.rows.length > 0) {
        const highestBidFromBids = parseFloat(bidsResult.rows[0].amount || 0);
        if (highestBidFromBids > finalBid) {
            // bids 테이블에 더 높은 입찰이 있으면 그것을 사용
            finalBid = highestBidFromBids;
            finalBidderId = bidsResult.rows[0].user_id;
            winningBidId = bidsResult.rows[0].id;
            
            // 입찰자 정보 재조회
            const bidderInfoResult = await client.query(
                `SELECT nickname, firebase_uid FROM users WHERE id = $1`,
                [finalBidderId]
            );
            if (bidderInfoResult.rows.length > 0) {
                finalBidderNickname = bidderInfoResult.rows[0].nickname || 'Unknown';
            }
        } else if (finalBid > 0) {
            // current_bid가 더 높은 경우, 해당 입찰을 찾아서 winning_bid_id 설정
            const currentBidResult = await client.query(
                `SELECT id FROM bids 
                 WHERE auction_id = $1 AND amount = $2 AND user_id = $3
                 ORDER BY created_at ASC
                 LIMIT 1`,
                [auctionId, finalBid, finalBidderId]
            );
            if (currentBidResult.rows.length > 0) {
                winningBidId = currentBidResult.rows[0].id;
            }
        }
    }
    
    const hasWinner = finalBidderId && finalBid > 0;
    const isAlreadyEnded = auction.status === 'ended';
    
    // 2. 경매 상태를 ended로 업데이트하고 승자 확정값 저장 (winning_amount 기준)
    // 이미 종료된 경우에는 상태 업데이트를 스킵하고 승자 확정값만 갱신 (복구용)
    if (!isAlreadyEnded) {
        // 아직 종료되지 않은 경우에만 상태 업데이트
        await client.query(
            `UPDATE auctions 
             SET status = 'ended', 
                 ended_at = NOW(),
                 updated_at = NOW(),
                 current_bid = $1,
                 current_bidder_id = $2,
                 winning_bid_id = $3,
                 winner_user_id = $4,
                 winning_amount = $5
             WHERE id = $6`,
            [finalBid, finalBidderId, winningBidId, hasWinner ? finalBidderId : null, hasWinner ? finalBid : null, auctionId]
        );
    } else {
        // 이미 종료된 경우에는 승자 확정값만 갱신 (복구용)
        await client.query(
            `UPDATE auctions 
             SET updated_at = NOW(),
                 current_bid = $1,
                 current_bidder_id = $2,
                 winning_bid_id = $3,
                 winner_user_id = $4,
                 winning_amount = $5
             WHERE id = $6`,
            [finalBid, finalBidderId, winningBidId, hasWinner ? finalBidderId : null, hasWinner ? finalBid : null, auctionId]
        );
    }
    
    // 3. 영토 소유권 이전 및 보호기간 설정 (winning_amount 기준)
    let protectionEndsAt = null;
    let newMarketBase = null;
    
    if (hasWinner && auction.territory_id) {
        // 영토 테이블 락 (동시성 보장)
        const territoryLockResult = await client.query(
            `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
            [auction.territory_id]
        );
        
        if (territoryLockResult.rows.length === 0) {
            throw new Error(`Territory ${auction.territory_id} not found for auction ${auctionId}`);
        }
        
        // EMA 계산 (market_base_price 갱신)
        let currentMarketBase = parseFloat(auction.market_base_price || auction.base_price || 0);
        
        if (!currentMarketBase || currentMarketBase <= 0) {
            currentMarketBase = parseFloat(auction.base_price || finalBid || 100);
        }
        
        if (finalBid > 0) {
            const EMA_WEIGHT_OLD = 0.7;
            const EMA_WEIGHT_NEW = 0.3;
            const rawEMA = currentMarketBase * EMA_WEIGHT_OLD + finalBid * EMA_WEIGHT_NEW;
            const CAP_MULTIPLIER = 3.0;
            const capped = Math.min(rawEMA, currentMarketBase * CAP_MULTIPLIER);
            const FLOOR_MULTIPLIER = 0.7;
            const floored = Math.max(capped, currentMarketBase * FLOOR_MULTIPLIER);
            newMarketBase = Math.ceil(floored);
        } else {
            newMarketBase = currentMarketBase;
        }
        
        // ⚠️ 전문가 조언: 보호기간은 winning_amount 기준으로 계산
        protectionEndsAt = calculateProtectionEndsAtFromBid(finalBid);
        
        // 영토 소유권 이전 (멱등성 보장)
        const territoryUpdateResult = await client.query(
            `UPDATE territories 
             SET ruler_id = $1,
                 ruler_name = $2,
                 sovereignty = 'protected',
                 status = 'protected',
                 protection_ends_at = $3,
                 market_base_price = $4,
                 last_winning_amount = $5,
                 current_auction_id = NULL,
                 updated_at = NOW()
             WHERE id = $6
               AND (ruler_id IS DISTINCT FROM $1 OR ruler_id IS NULL)`,
            [
                finalBidderId,
                finalBidderNickname,
                protectionEndsAt,
                newMarketBase,
                finalBid, // last_winning_amount 저장
                auction.territory_id
            ]
        );
        
        // 소유권이 실제로 변경되었는지 확인
        if (territoryUpdateResult.rowCount === 0) {
            console.log(`[FinalizeAuctionEnd] Territory ${auction.territory_id} already has ruler ${finalBidderId}, skipping update (idempotent)`);
        }
        
        // 소유권 이력 기록 (멱등성 보장)
        await client.query(
            `INSERT INTO ownerships (territory_id, user_id, acquired_at, price, auction_id)
             VALUES ($1, $2, NOW(), $3, $4)
             ON CONFLICT (auction_id) DO NOTHING`,
            [auction.territory_id, finalBidderId, finalBid, auctionId]
        );
        
        // 소유권 이전 완료 표시
        await client.query(
            `UPDATE auctions 
             SET transferred_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [auctionId]
        );
    } else {
        // 낙찰자 없음: 영토 상태 복구
        if (auction.territory_id) {
            await client.query(
                `SELECT * FROM territories WHERE id = $1 FOR UPDATE`,
                [auction.territory_id]
            );
            
            if (auction.current_owner_id) {
                await client.query(
                    `UPDATE territories 
                     SET sovereignty = 'ruled',
                         status = 'ruled',
                         current_auction_id = NULL,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [auction.territory_id]
                );
            } else {
                await client.query(
                    `UPDATE territories 
                     SET sovereignty = 'unconquered',
                         status = 'unconquered',
                         ruler_id = NULL,
                         ruler_name = NULL,
                         current_auction_id = NULL,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [auction.territory_id]
                );
            }
        }
    }
    
    return {
        hasWinner,
        finalBid,
        finalBidderId,
        finalBidderNickname,
        winningBidId,
        protectionEndsAt,
        newMarketBase
    };
}

