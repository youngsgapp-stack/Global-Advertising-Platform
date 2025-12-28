/**
 * 경매 startingBid 오염 레코드 일괄 정정 스크립트
 * 
 * 전문가 조언 반영: DB에 잘못 저장된 startingBid를 territoryPrice 기반으로 정정
 * - startingBid는 territory.base_price 또는 market_base_price + 1이어야 함
 * - 잘못된 값(startingBid < 10 또는 startingBid가 territoryPrice와 크게 다름)을 정정
 */

import { query, initDatabase, getPool } from '../db/init.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * 경매 startingBid 정정
 */
async function fixAuctionStartingBid() {
    console.log('[Fix StartingBid] Starting auction startingBid correction...');
    
    await initDatabase();
    const client = await getPool().connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. 잘못된 startingBid를 가진 경매 조회
        // - min_bid가 10 미만이거나 NULL인 경우
        // - 또는 territory의 base_price/market_base_price와 크게 다른 경우
        const auctionsResult = await client.query(`
            SELECT 
                a.id as auction_id,
                a.territory_id,
                a.min_bid as current_starting_bid,
                a.status,
                t.base_price,
                t.market_base_price,
                COALESCE(t.market_base_price, t.base_price, 100) as territory_price
            FROM auctions a
            JOIN territories t ON a.territory_id = t.id
            WHERE a.status = 'active'
                AND (
                    a.min_bid IS NULL 
                    OR a.min_bid < 10 
                    OR ABS(a.min_bid - (COALESCE(t.market_base_price, t.base_price, 100) + 1)) > 10
                )
            ORDER BY a.created_at DESC
        `);
        
        const auctionsToFix = auctionsResult.rows;
        console.log(`[Fix StartingBid] Found ${auctionsToFix.length} auctions with invalid startingBid`);
        
        if (auctionsToFix.length === 0) {
            console.log('[Fix StartingBid] ✅ No auctions need correction');
            await client.query('COMMIT');
            return;
        }
        
        let fixedCount = 0;
        let skippedCount = 0;
        
        for (const auction of auctionsToFix) {
            const territoryPrice = parseFloat(auction.territory_price || 0);
            const correctStartingBid = Math.max(10, Math.floor(territoryPrice) + 1); // 최소 10pt
            const currentStartingBid = parseFloat(auction.current_starting_bid || 0);
            const diff = Math.abs(currentStartingBid - correctStartingBid);
            
            // 10pt 차이 이상이면 정정
            if (diff > 10 || currentStartingBid < 10) {
                // ⚠️ 중요: 입찰이 이미 있는 경매는 정정하지 않음 (데이터 무결성 보호)
                const bidsResult = await client.query(
                    `SELECT COUNT(*) as bid_count FROM bids WHERE auction_id = $1`,
                    [auction.auction_id]
                );
                
                const bidCount = parseInt(bidsResult.rows[0].bid_count || 0);
                
                if (bidCount > 0) {
                    console.log(`[Fix StartingBid] ⚠️ Skipping auction ${auction.auction_id}: has ${bidCount} bids (cannot modify startingBid after bids)`);
                    skippedCount++;
                    continue;
                }
                
                // startingBid 정정
                await client.query(
                    `UPDATE auctions 
                     SET min_bid = $1, 
                         updated_at = NOW()
                     WHERE id = $2`,
                    [correctStartingBid, auction.auction_id]
                );
                
                console.log(`[Fix StartingBid] ✅ Fixed auction ${auction.auction_id}:`, {
                    territoryId: auction.territory_id,
                    oldStartingBid: currentStartingBid,
                    newStartingBid: correctStartingBid,
                    territoryPrice: territoryPrice,
                    basePrice: auction.base_price,
                    marketBasePrice: auction.market_base_price
                });
                
                fixedCount++;
            } else {
                console.log(`[Fix StartingBid] ⚠️ Skipping auction ${auction.auction_id}: diff (${diff}) is within tolerance`);
                skippedCount++;
            }
        }
        
        await client.query('COMMIT');
        
        console.log('\n[Fix StartingBid] Summary:');
        console.log(`  - Fixed: ${fixedCount}`);
        console.log(`  - Skipped: ${skippedCount}`);
        console.log(`  - Total: ${auctionsToFix.length}`);
        console.log('[Fix StartingBid] ✅ Correction completed!');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Fix StartingBid] ❌ Error:', error);
        throw error;
    } finally {
        client.release();
    }
}

// 스크립트 직접 실행 시
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].includes('fix-auction-starting-bid.js')) {
    fixAuctionStartingBid()
        .then(() => {
            console.log('[Fix StartingBid] Script completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('[Fix StartingBid] Script failed:', error);
            process.exit(1);
        });
}

export { fixAuctionStartingBid };

