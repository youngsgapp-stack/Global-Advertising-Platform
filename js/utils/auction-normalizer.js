/**
 * Auction Normalizer
 * 프론트엔드에서 auction 객체를 일관된 형식으로 정규화
 * ⚠️ 재발 방지: 캐시에 넣기 전에 항상 이 함수를 거쳐야 함
 */

import { AUCTION_STATUS } from '../features/AuctionSystem.js';
import { log } from '../config.js';

/**
 * auction 객체를 정규화 (snake_case → camelCase, 필수 필드 보장)
 * @param {Object} auction - 백엔드에서 받은 auction 객체 (형식 불일치 가능)
 * @returns {Object} 정규화된 auction 객체
 */
export function normalizeAuctionDTO(auction) {
    if (!auction) {
        return null;
    }

    // 이미 정규화된 객체인지 확인 (territoryId가 있으면 정규화됨)
    if (auction.territoryId) {
        // 필수 필드 검증만 수행
        validateAuctionDTO(auction);
        return auction;
    }

    // snake_case → camelCase 변환
    const normalized = {
        id: auction.id || auction.auction_id,
        territoryId: auction.territoryId || auction.territory_id,
        status: auction.status || AUCTION_STATUS.ACTIVE,
        startingBid: parseFloat(auction.startingBid || auction.min_bid || auction.current_bid || 0),
        currentBid: parseFloat(auction.currentBid || auction.current_bid || 0),
        highestBidder: auction.highestBidder || (auction.current_bidder_id ? String(auction.current_bidder_id) : null) || (auction.currentBidderId ? String(auction.currentBidderId) : null),
        highestBidderName: auction.highestBidderName || auction.bidder_nickname || auction.currentBidderNickname || null,
        endTime: auction.endTime || auction.end_time,
        createdAt: auction.createdAt || auction.created_at,
        updatedAt: auction.updatedAt || auction.updated_at,
        // 추가 필드
        territoryName: auction.territoryName || auction.territory_name || null,
        territoryCode: auction.territoryCode || auction.territory_code || null,
        // minNextBid와 increment는 서버에서 계산하므로 있으면 그대로 사용
        minNextBid: auction.minNextBid || null,
        increment: auction.increment || 1
    };

    // 필수 필드 검증
    validateAuctionDTO(normalized);

    return normalized;
}

/**
 * auction DTO의 필수 필드 검증 (개발 모드에서만 경고)
 * @param {Object} auction - 검증할 auction 객체
 */
function validateAuctionDTO(auction) {
    // 브라우저 환경에서만 검증 (서버 사이드에서는 생략)
    if (typeof window === 'undefined') {
        return;
    }
    
    // 프로덕션 모드 확인 (브라우저 환경에서)
    const isProduction = window.location.hostname !== 'localhost' && 
                        !window.location.hostname.includes('127.0.0.1') &&
                        !window.location.hostname.includes('192.168.');
    
    if (isProduction) {
        return; // 프로덕션에서는 검증 생략
    }

    const requiredFields = ['id', 'territoryId', 'status'];
    const missingFields = requiredFields.filter(field => !auction[field]);

    if (missingFields.length > 0) {
        console.error('[AuctionNormalizer] ⚠️ Missing required fields:', missingFields, auction);
        log.warn(`[AuctionNormalizer] Missing required fields: ${missingFields.join(', ')}`);
    }

    // territoryId가 없으면 getAuctionByTerritory가 작동하지 않음
    if (!auction.territoryId) {
        console.error('[AuctionNormalizer] ⚠️ CRITICAL: territoryId is missing! This will break getAuctionByTerritory.', auction);
        log.error(`[AuctionNormalizer] CRITICAL: territoryId is missing!`, auction);
    }
}

/**
 * 여러 auction 객체를 일괄 정규화
 * @param {Array} auctions - auction 객체 배열
 * @returns {Array} 정규화된 auction 객체 배열
 */
export function normalizeAuctionsDTO(auctions) {
    if (!auctions || !Array.isArray(auctions)) {
        return [];
    }
    return auctions.map(auction => normalizeAuctionDTO(auction));
}

