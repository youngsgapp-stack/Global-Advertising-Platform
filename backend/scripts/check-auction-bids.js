/**
 * 경매 입찰 상태 확인 스크립트
 * 특정 경매의 입찰 기록과 현재 상태를 확인
 */

import dotenv from 'dotenv';
import { query, initDatabase } from '../db/init.js';

dotenv.config();

async function checkAuctionBids(auctionId) {
    // DB 초기화
    await initDatabase();
    try {
        console.log(`\n🔍 [Check Auction] Checking auction: ${auctionId}\n`);

        // 1. 경매 기본 정보
        const auctionResult = await query(
            `SELECT 
                a.id,
                a.territory_id,
                a.status,
                a.min_bid as starting_bid,
                a.current_bid,
                a.current_bidder_id,
                u.nickname as bidder_nickname,
                a.created_at,
                a.updated_at
            FROM auctions a
            LEFT JOIN users u ON a.current_bidder_id = u.id
            WHERE a.id = $1`,
            [auctionId]
        );

        if (auctionResult.rows.length === 0) {
            console.log('❌ 경매를 찾을 수 없습니다.');
            return;
        }

        const auction = auctionResult.rows[0];
        console.log('📊 [경매 기본 정보]');
        console.log(`   ID: ${auction.id}`);
        console.log(`   Territory ID: ${auction.territory_id}`);
        console.log(`   Status: ${auction.status}`);
        console.log(`   Starting Bid: ${auction.starting_bid} pt`);
        console.log(`   Current Bid (auctions 테이블): ${auction.current_bid} pt`);
        console.log(`   Current Bidder ID: ${auction.current_bidder_id || 'None'}`);
        console.log(`   Current Bidder Name: ${auction.bidder_nickname || 'None'}`);
        console.log(`   Created At: ${auction.created_at}`);
        console.log(`   Updated At: ${auction.updated_at}`);

        // 2. bids 테이블에서 실제 입찰 기록
        const bidsResult = await query(
            `SELECT 
                b.id,
                b.user_id,
                u.nickname,
                u.email,
                b.amount,
                b.created_at
            FROM bids b
            LEFT JOIN users u ON b.user_id = u.id
            WHERE b.auction_id = $1
            ORDER BY b.amount DESC, b.created_at DESC`,
            [auctionId]
        );

        console.log(`\n📋 [입찰 기록] (총 ${bidsResult.rows.length}건)`);
        if (bidsResult.rows.length === 0) {
            console.log('   입찰 기록이 없습니다.');
        } else {
            bidsResult.rows.forEach((bid, index) => {
                console.log(`   ${index + 1}. ${bid.amount} pt - ${bid.nickname || bid.email || 'Unknown'} (${bid.created_at})`);
            });
        }

        // 3. bids 테이블에서 최고 입찰
        const highestBidResult = await query(
            `SELECT MAX(amount) as max_amount, COUNT(*) as bid_count
             FROM bids 
             WHERE auction_id = $1`,
            [auctionId]
        );

        const highestBid = highestBidResult.rows[0]?.max_amount ? parseFloat(highestBidResult.rows[0].max_amount) : null;
        const bidCount = parseInt(highestBidResult.rows[0]?.bid_count || 0, 10);

        console.log(`\n💰 [입찰 통계]`);
        console.log(`   최고 입찰 (bids 테이블): ${highestBid || 'None'} pt`);
        console.log(`   총 입찰 수: ${bidCount}건`);
        console.log(`   auctions.current_bid: ${auction.current_bid} pt`);

        // 4. 불일치 확인
        console.log(`\n⚠️  [불일치 확인]`);
        if (highestBid && parseFloat(auction.current_bid) !== highestBid) {
            console.log(`   ❌ 불일치 발견!`);
            console.log(`      bids 테이블 최고 입찰: ${highestBid} pt`);
            console.log(`      auctions 테이블 current_bid: ${auction.current_bid} pt`);
            console.log(`      차이: ${Math.abs(highestBid - parseFloat(auction.current_bid))} pt`);
        } else if (highestBid && parseFloat(auction.current_bid) === highestBid) {
            console.log(`   ✅ 일치: 두 테이블 모두 ${highestBid} pt`);
        } else {
            console.log(`   ℹ️  입찰 기록이 없습니다.`);
        }

        // 5. 예상 minNextBid
        const increment = 1;
        const effectiveCurrentBid = highestBid || parseFloat(auction.current_bid) || parseFloat(auction.starting_bid) || 0;
        const expectedMinNextBid = effectiveCurrentBid + increment;

        console.log(`\n🎯 [예상 최소 입찰가]`);
        console.log(`   Effective Current Bid: ${effectiveCurrentBid} pt`);
        console.log(`   Expected minNextBid: ${expectedMinNextBid} pt`);
        console.log(`   Increment: ${increment} pt`);

    } catch (error) {
        console.error('❌ 오류 발생:', error);
    }
}

// 명령줄 인자로 auctionId 받기
const auctionId = process.argv[2];

if (!auctionId) {
    console.error('사용법: node check-auction-bids.js <auctionId>');
    console.error('예시: node check-auction-bids.js 543ee8f5-956a-4160-aa99-756b16796bb9');
    process.exit(1);
}

checkAuctionBids(auctionId)
    .then(() => {
        console.log('\n✅ 확인 완료\n');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ 스크립트 실행 실패:', error);
        process.exit(1);
    });

