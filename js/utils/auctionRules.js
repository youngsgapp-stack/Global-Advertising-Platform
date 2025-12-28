/**
 * Auction Rules - 경매 권한 검증 유틸리티
 * 프론트엔드와 백엔드에서 공통으로 사용하는 권한 검증 로직
 */

import { SOVEREIGNTY } from '../core/TerritoryManager.js';
import { AUCTION_STATUS } from '../features/AuctionSystem.js';

/**
 * 영토 및 경매 상태에 따른 허용 액션 계산
 * @param {Object} params - 파라미터 객체
 * @param {Object} params.territory - 영토 객체
 * @param {Object|null} params.auction - 경매 객체 (null 가능)
 * @param {string} params.userId - 현재 사용자 ID
 * @param {Function} params.isProtectedFn - isProtected 함수 (선택, territoryManager.isProtected)
 * @returns {Object} 허용 액션 객체
 */
export function getAllowedActions({ territory, auction, userId, isProtectedFn = null }) {
    const isOwner = territory.ruler === userId || territory.ruler_firebase_uid === userId;
    const sovereignty = territory.sovereignty || territory.status;
    const auctionStatus = auction?.status || 'none';
    
    // Protected 상태 확인 (함수가 제공되면 사용, 아니면 sovereignty로만 판단)
    let isProtected = false;
    if (isProtectedFn && typeof isProtectedFn === 'function') {
        try {
            isProtected = isProtectedFn(territory.id || territory.territoryId);
        } catch (e) {
            // 함수 호출 실패 시 sovereignty로만 판단
            isProtected = sovereignty === SOVEREIGNTY.PROTECTED || sovereignty === 'protected';
        }
    } else {
        isProtected = sovereignty === SOVEREIGNTY.PROTECTED || sovereignty === 'protected';
        
        // protection_ends_at으로 추가 확인
        if (!isProtected && territory.protectionEndsAt) {
            const protectionEnd = territory.protectionEndsAt instanceof Date 
                ? territory.protectionEndsAt 
                : new Date(territory.protectionEndsAt);
            const now = new Date();
            if (protectionEnd > now) {
                isProtected = true;
            }
        }
    }
    
    // Protected 상태에서도 경매 시작 및 입찰 가능
    // 보호 기간은 소유권 보호용이며, 경매는 보호 기간 중에도 누구나 시작 가능
    if (isProtected) {
        return {
            canStartAuction: auctionStatus === 'none', // 누구나 경매 시작 가능
            canBid: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active', // 누구나 입찰 가능
            canBuyNow: false, // 보호 기간 중에는 즉시 구매 불가
            canExtendProtection: isOwner, // 소유자는 보호 연장 가능
            canViewAuction: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
            canEditPixels: isOwner,
            canOpenCollaboration: isOwner,
            reason: 'Territory is protected, but auctions and bids are allowed'
        };
    }
    
    // Ruled 상태 (소유됨, 보호 기간 종료)
    if (sovereignty === SOVEREIGNTY.RULED || sovereignty === 'ruled') {
        return {
            canStartAuction: auctionStatus === 'none', // 누구나 경매 시작 가능
            canBid: false,
            canBuyNow: false,
            canExtendProtection: isOwner,
            canViewAuction: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
            canEditPixels: isOwner,
            canOpenCollaboration: isOwner,
            reason: isOwner ? 'You own this territory' : 'Territory is owned by another user'
        };
    }
    
    // Unconquered 상태 (미점유)
    if (sovereignty === SOVEREIGNTY.UNCONQUERED || sovereignty === 'unconquered') {
        return {
            canStartAuction: true, // 누구나 경매 시작 가능
            canBid: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
            canBuyNow: auctionStatus !== AUCTION_STATUS.ACTIVE && auctionStatus !== 'active',
            canExtendProtection: false,
            canViewAuction: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
            canEditPixels: isOwner,
            canOpenCollaboration: isOwner,
            reason: 'Territory is available'
        };
    }
    
    // Contested 상태 (경매 중)
    if (sovereignty === SOVEREIGNTY.CONTESTED || sovereignty === 'contested') {
        return {
            canStartAuction: false,
            canBid: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
            canBuyNow: false, // 경매 중에는 Buy Now 불가
            canExtendProtection: false,
            canViewAuction: true,
            canEditPixels: isOwner,
            canOpenCollaboration: isOwner,
            reason: 'Territory is under auction'
        };
    }
    
    // 기본값 (알 수 없는 상태)
    return {
        canStartAuction: false,
        canBid: false,
        canBuyNow: false,
        canExtendProtection: false,
        canViewAuction: auctionStatus === AUCTION_STATUS.ACTIVE || auctionStatus === 'active',
        canEditPixels: false,
        canOpenCollaboration: false,
        reason: `Unknown territory status: ${sovereignty}`
    };
}

/**
 * Protected 상태 확인 헬퍼 함수
 * @param {Object} territory - 영토 객체
 * @returns {boolean} Protected 상태 여부
 */
export function isTerritoryProtected(territory) {
    const sovereignty = territory.sovereignty || territory.status;
    
    if (sovereignty === SOVEREIGNTY.PROTECTED || sovereignty === 'protected') {
        return true;
    }
    
    // protection_ends_at 확인
    if (territory.protectionEndsAt || territory.protection_ends_at) {
        const protectionEnd = territory.protectionEndsAt instanceof Date 
            ? territory.protectionEndsAt 
            : new Date(territory.protectionEndsAt || territory.protection_ends_at);
        const now = new Date();
        return protectionEnd > now;
    }
    
    return false;
}

