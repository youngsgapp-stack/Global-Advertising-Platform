/**
 * 옥션 종료 후 영토 소유권 이전 상태 확인 스크립트
 * 
 * 사용법:
 * node backend/scripts/check-auction-ownership-transfer.js <territoryId>
 * 예: node backend/scripts/check-auction-ownership-transfer.js tamanghasset
 */

import { query, getPool } from '../db/init.js';

async function checkAuctionOwnershipTransfer(territoryId) {
    const client = await getPool().connect();
    
    try {
        console.log(`\n🔍 옥션 및 영토 소유권 상태 확인: ${territoryId}\n`);
        console.log('='.repeat(80));
        
        // 1. 영토 정보 조회
        console.log('\n📋 1. 영토 정보');
        const territoryResult = await client.query(
            `SELECT 
                id,
                name,
                ruler_id,
                ruler_name,
                ruler_firebase_uid,
                sovereignty,
                status,
                current_auction_id,
                protection_ends_at,
                market_base_price,
                updated_at
            FROM territories 
            WHERE id = $1`,
            [territoryId]
        );
        
        if (territoryResult.rows.length === 0) {
            console.log(`❌ 영토를 찾을 수 없습니다: ${territoryId}`);
            return;
        }
        
        const territory = territoryResult.rows[0];
        console.log('영토 정보:');
        console.log(`  - ID: ${territory.id}`);
        console.log(`  - 이름: ${territory.name || 'N/A'}`);
        console.log(`  - 소유자 ID (ruler_id): ${territory.ruler_id || 'NULL'}`);
        console.log(`  - 소유자 이름 (ruler_name): ${territory.ruler_name || 'NULL'}`);
        console.log(`  - 소유자 Firebase UID: ${territory.ruler_firebase_uid || 'NULL'}`);
        console.log(`  - 주권 상태 (sovereignty): ${territory.sovereignty || 'NULL'}`);
        console.log(`  - 상태 (status): ${territory.status || 'NULL'}`);
        console.log(`  - 현재 옥션 ID: ${territory.current_auction_id || 'NULL'}`);
        console.log(`  - 보호 종료 시간: ${territory.protection_ends_at || 'NULL'}`);
        console.log(`  - 시장 기준가: ${territory.market_base_price || 'NULL'}`);
        console.log(`  - 업데이트 시간: ${territory.updated_at || 'NULL'}`);
        
        // 2. 옥션 정보 조회 (현재 옥션 및 최근 종료된 옥션)
        console.log('\n📋 2. 옥션 정보');
        
        // 현재 옥션
        if (territory.current_auction_id) {
            const currentAuctionResult = await client.query(
                `SELECT 
                    id,
                    territory_id,
                    status,
                    start_time,
                    end_time,
                    ended_at,
                    min_bid,
                    current_bid,
                    current_bidder_id,
                    created_at,
                    updated_at
                FROM auctions 
                WHERE id = $1`,
                [territory.current_auction_id]
            );
            
            if (currentAuctionResult.rows.length > 0) {
                const auction = currentAuctionResult.rows[0];
                console.log('\n현재 옥션:');
                console.log(`  - 옥션 ID: ${auction.id}`);
                console.log(`  - 상태: ${auction.status}`);
                console.log(`  - 시작 시간: ${auction.start_time}`);
                console.log(`  - 종료 시간: ${auction.end_time}`);
                console.log(`  - 실제 종료 시간: ${auction.ended_at || 'NULL (아직 종료 안됨)'}`);
                console.log(`  - 최소 입찰가: ${auction.min_bid}`);
                console.log(`  - 현재 입찰가: ${auction.current_bid}`);
                console.log(`  - 현재 입찰자 ID: ${auction.current_bidder_id || 'NULL'}`);
                console.log(`  - 생성 시간: ${auction.created_at}`);
                console.log(`  - 업데이트 시간: ${auction.updated_at}`);
                
                // 입찰자 정보 조회
                if (auction.current_bidder_id) {
                    const bidderResult = await client.query(
                        `SELECT id, nickname, email, firebase_uid 
                         FROM users 
                         WHERE id = $1`,
                        [auction.current_bidder_id]
                    );
                    
                    if (bidderResult.rows.length > 0) {
                        const bidder = bidderResult.rows[0];
                        console.log(`\n  입찰자 정보:`);
                        console.log(`    - 사용자 ID: ${bidder.id}`);
                        console.log(`    - 닉네임: ${bidder.nickname || 'N/A'}`);
                        console.log(`    - 이메일: ${bidder.email || 'N/A'}`);
                        console.log(`    - Firebase UID: ${bidder.firebase_uid || 'N/A'}`);
                    }
                }
                
                // 입찰 기록 조회
                const bidsResult = await client.query(
                    `SELECT 
                        id,
                        user_id,
                        amount,
                        created_at
                    FROM bids 
                    WHERE auction_id = $1
                    ORDER BY amount DESC, created_at ASC
                    LIMIT 5`,
                    [auction.id]
                );
                
                console.log(`\n  입찰 기록 (최대 5개):`);
                if (bidsResult.rows.length === 0) {
                    console.log(`    - 입찰 기록 없음`);
                } else {
                    bidsResult.rows.forEach((bid, index) => {
                        console.log(`    ${index + 1}. ${bid.amount}pt - 사용자 ID: ${bid.user_id} - ${bid.created_at}`);
                    });
                }
            }
        }
        
        // 최근 종료된 옥션 조회
        const endedAuctionsResult = await client.query(
            `SELECT 
                id,
                territory_id,
                status,
                start_time,
                end_time,
                ended_at,
                min_bid,
                current_bid,
                current_bidder_id,
                created_at,
                updated_at
            FROM auctions 
            WHERE territory_id = $1 
                AND status = 'ended'
            ORDER BY ended_at DESC
            LIMIT 3`,
            [territoryId]
        );
        
        if (endedAuctionsResult.rows.length > 0) {
            console.log('\n최근 종료된 옥션:');
            endedAuctionsResult.rows.forEach((auction, index) => {
                console.log(`\n  옥션 ${index + 1}:`);
                console.log(`    - 옥션 ID: ${auction.id}`);
                console.log(`    - 상태: ${auction.status}`);
                console.log(`    - 종료 시간: ${auction.end_time}`);
                console.log(`    - 실제 종료 시간: ${auction.ended_at || 'NULL'}`);
                console.log(`    - 최종 입찰가: ${auction.current_bid}`);
                console.log(`    - 최종 입찰자 ID: ${auction.current_bidder_id || 'NULL'}`);
                
                // 입찰자 정보 조회
                if (auction.current_bidder_id) {
                    const bidderResult = await client.query(
                        `SELECT id, nickname, email, firebase_uid 
                         FROM users 
                         WHERE id = $1`,
                        [auction.current_bidder_id]
                    );
                    
                    if (bidderResult.rows.length > 0) {
                        const bidder = bidderResult.rows[0];
                        console.log(`    - 입찰자 닉네임: ${bidder.nickname || 'N/A'}`);
                        console.log(`    - 입찰자 Firebase UID: ${bidder.firebase_uid || 'N/A'}`);
                    }
                }
            });
        } else {
            console.log('\n최근 종료된 옥션: 없음');
        }
        
        // 3. 소유권 이력 조회
        console.log('\n📋 3. 소유권 이력');
        const ownershipResult = await client.query(
            `SELECT 
                o.id,
                o.territory_id,
                o.user_id,
                o.acquired_at,
                o.price,
                u.nickname,
                u.firebase_uid
            FROM ownerships o
            LEFT JOIN users u ON o.user_id = u.id
            WHERE o.territory_id = $1
            ORDER BY o.acquired_at DESC
            LIMIT 5`,
            [territoryId]
        );
        
        if (ownershipResult.rows.length === 0) {
            console.log('소유권 이력: 없음');
        } else {
            console.log('소유권 이력 (최대 5개):');
            ownershipResult.rows.forEach((ownership, index) => {
                console.log(`  ${index + 1}. ${ownership.nickname || 'N/A'} (${ownership.firebase_uid || 'N/A'}) - ${ownership.price}pt - ${ownership.acquired_at}`);
            });
        }
        
        // 4. 상태 분석 및 문제 진단
        console.log('\n📋 4. 상태 분석');
        console.log('='.repeat(80));
        
        const issues = [];
        const warnings = [];
        
        // 옥션이 종료되었는데 소유권이 이전되지 않은 경우
        if (territory.current_auction_id) {
            const auctionCheck = await client.query(
                `SELECT status, end_time, ended_at, current_bidder_id, current_bid
                 FROM auctions 
                 WHERE id = $1`,
                [territory.current_auction_id]
            );
            
            if (auctionCheck.rows.length > 0) {
                const auction = auctionCheck.rows[0];
                const now = new Date();
                const endTime = new Date(auction.end_time);
                
                // 종료 시간이 지났는데 아직 active 상태
                if (auction.status === 'active' && endTime < now) {
                    issues.push(`⚠️ 옥션이 종료 시간이 지났는데 아직 'active' 상태입니다. 종료 처리가 필요합니다.`);
                }
                
                // 종료되었는데 소유권이 이전되지 않은 경우
                if (auction.status === 'ended' && auction.current_bidder_id) {
                    if (!territory.ruler_id || territory.ruler_id !== auction.current_bidder_id) {
                        issues.push(`❌ 옥션이 종료되었는데 소유권이 이전되지 않았습니다.`);
                        issues.push(`   - 옥션 입찰자 ID: ${auction.current_bidder_id}`);
                        issues.push(`   - 영토 소유자 ID: ${territory.ruler_id || 'NULL'}`);
                    }
                }
                
                // 종료되었는데 입찰자가 없는 경우 (유찰)
                if (auction.status === 'ended' && !auction.current_bidder_id) {
                    if (territory.current_auction_id) {
                        warnings.push(`⚠️ 옥션이 유찰되었는데 current_auction_id가 여전히 설정되어 있습니다.`);
                    }
                }
            }
        }
        
        // 최근 종료된 옥션이 있는데 소유권이 이전되지 않은 경우
        if (endedAuctionsResult.rows.length > 0) {
            const latestEndedAuction = endedAuctionsResult.rows[0];
            if (latestEndedAuction.current_bidder_id) {
                if (!territory.ruler_id || territory.ruler_id !== latestEndedAuction.current_bidder_id) {
                    issues.push(`❌ 최근 종료된 옥션의 입찰자에게 소유권이 이전되지 않았습니다.`);
                    issues.push(`   - 옥션 ID: ${latestEndedAuction.id}`);
                    issues.push(`   - 옥션 입찰자 ID: ${latestEndedAuction.current_bidder_id}`);
                    issues.push(`   - 영토 소유자 ID: ${territory.ruler_id || 'NULL'}`);
                }
            }
        }
        
        // 결과 출력
        if (issues.length === 0 && warnings.length === 0) {
            console.log('✅ 문제 없음: 모든 상태가 정상입니다.');
        } else {
            if (issues.length > 0) {
                console.log('\n❌ 발견된 문제:');
                issues.forEach(issue => console.log(`  ${issue}`));
            }
            
            if (warnings.length > 0) {
                console.log('\n⚠️ 경고:');
                warnings.forEach(warning => console.log(`  ${warning}`));
            }
        }
        
        // 5. 수동 종료 제안
        if (issues.length > 0) {
            console.log('\n📋 5. 해결 방법');
            console.log('='.repeat(80));
            console.log('옥션을 수동으로 종료하려면:');
            console.log(`  curl -X POST http://localhost:3000/api/auctions/{auctionId}/end \\`);
            console.log(`    -H "Authorization: Bearer {adminToken}"`);
            console.log('\n또는 관리자 대시보드에서 옥션을 수동으로 종료할 수 있습니다.');
        }
        
        console.log('\n' + '='.repeat(80) + '\n');
        
    } catch (error) {
        console.error('❌ 에러 발생:', error);
        console.error('스택 트레이스:', error.stack);
    } finally {
        client.release();
    }
}

// 스크립트 실행
const territoryId = process.argv[2];

if (!territoryId) {
    console.error('사용법: node check-auction-ownership-transfer.js <territoryId>');
    console.error('예: node check-auction-ownership-transfer.js tamanghasset');
    process.exit(1);
}

checkAuctionOwnershipTransfer(territoryId)
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('스크립트 실행 실패:', error);
        process.exit(1);
    });

