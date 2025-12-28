/**
 * 경매 current_bid 동기화 스크립트
 * auctions 테이블의 current_bid를 bids 테이블의 최고 입찰로 업데이트
 */

import dotenv from 'dotenv';
import { getPool, initDatabase } from '../db/init.js';
import { invalidateAuctionCache } from '../redis/cache-utils.js';

dotenv.config();

async function fixAuctionCurrentBid(auctionId) {
    const client = await getPool().connect();
    
    try {
        console.log(`\n🔧 [Fix Auction] Fixing current_bid for auction: ${auctionId}\n`);

        await client.query('BEGIN');

        // 1. bids 테이블에서 최고 입찰 조회
        const bidsResult = await client.query(
            `SELECT MAX(amount) as max_amount
             FROM bids 
             WHERE auction_id = $1`,
            [auctionId]
        );

        const highestBid = bidsResult.rows[0]?.max_amount ? parseFloat(bidsResult.rows[0].max_amount) : null;

        // 최고 입찰자의 user_id 조회
        let bidderId = null;
        if (highestBid) {
            const bidderResult = await client.query(
                `SELECT user_id 
                 FROM bids 
                 WHERE auction_id = $1 AND amount = $2 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [auctionId, highestBid]
            );
            bidderId = bidderResult.rows[0]?.user_id || null;
        }

        // 2. 현재 경매 정보 조회
        const auctionResult = await client.query(
            `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
            [auctionId]
        );

        if (auctionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.log('❌ 경매를 찾을 수 없습니다.');
            return;
        }

        const auction = auctionResult.rows[0];
        const currentBid = parseFloat(auction.current_bid || 0);

        console.log('📊 [현재 상태]');
        console.log(`   auctions.current_bid: ${currentBid} pt`);
        console.log(`   bids 최고 입찰: ${highestBid || 'None'} pt`);
        console.log(`   current_bidder_id: ${auction.current_bidder_id || 'None'}`);

        if (!highestBid) {
            console.log('ℹ️  입찰 기록이 없습니다. 수정할 필요가 없습니다.');
            await client.query('ROLLBACK');
            return;
        }

        if (currentBid === highestBid && auction.current_bidder_id === bidderId) {
            console.log('✅ 이미 동기화되어 있습니다.');
            await client.query('ROLLBACK');
            return;
        }

        // 3. auctions 테이블 업데이트
        await client.query(
            `UPDATE auctions 
             SET current_bid = $1,
                 current_bidder_id = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [highestBid, bidderId, auctionId]
        );

        await client.query('COMMIT');

        console.log(`\n✅ [수정 완료]`);
        console.log(`   current_bid: ${currentBid} pt → ${highestBid} pt`);
        console.log(`   current_bidder_id: ${auction.current_bidder_id || 'None'} → ${bidderId || 'None'}`);

        // Redis 캐시 무효화
        await invalidateAuctionCache(auctionId, auction.territory_id);
        console.log(`   Redis 캐시 무효화 완료`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ 오류 발생:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 명령줄 인자로 auctionId 받기
const auctionId = process.argv[2];

if (!auctionId) {
    console.error('사용법: node fix-auction-current-bid.js <auctionId>');
    console.error('예시: node fix-auction-current-bid.js 543ee8f5-956a-4160-aa99-756b16796bb9');
    process.exit(1);
}

initDatabase()
    .then(() => fixAuctionCurrentBid(auctionId))
    .then(() => {
        console.log('\n✅ 동기화 완료\n');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ 스크립트 실행 실패:', error);
        process.exit(1);
    });

