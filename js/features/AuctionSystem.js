/**
 * AuctionSystem - 옥션 시스템
 * 영토 입찰, 전략 버프 적용, 옥션 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager, SOVEREIGNTY } from '../core/TerritoryManager.js';

// 옥션 타입
export const AUCTION_TYPE = {
    STANDARD: 'standard',   // 표준 입찰 (최고가 낙찰)
    DUTCH: 'dutch',         // 역경매 (가격 하락)
    SEALED: 'sealed'        // 봉인 입찰
};

// 옥션 상태
export const AUCTION_STATUS = {
    PENDING: 'pending',     // 대기 중
    ACTIVE: 'active',       // 진행 중
    ENDED: 'ended',         // 종료
    CANCELLED: 'cancelled'  // 취소
};

class AuctionSystem {
    constructor() {
        this.activeAuctions = new Map();
        this.unsubscribers = [];
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 활성 옥션 로드
            await this.loadActiveAuctions();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('AuctionSystem initialized');
            return true;
            
        } catch (error) {
            log.error('AuctionSystem initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 입찰 이벤트
        eventBus.on(EVENTS.AUCTION_BID, (data) => {
            this.handleBid(data);
        });
    }
    
    /**
     * 활성 옥션 로드
     */
    async loadActiveAuctions() {
        try {
            const auctions = await firebaseService.queryCollection('auctions', [
                { field: 'status', op: '==', value: AUCTION_STATUS.ACTIVE }
            ]);
            
            for (const auction of auctions) {
                this.activeAuctions.set(auction.id, auction);
            }
            
            log.info(`Loaded ${auctions.length} active auctions`);
            
        } catch (error) {
            log.warn('Failed to load auctions:', error);
        }
    }
    
    /**
     * 새 옥션 생성
     */
    async createAuction(territoryId, options = {}) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            throw new Error('Territory not found');
        }
        
        // 이미 진행 중인 옥션 확인
        if (territory.currentAuction) {
            throw new Error('Auction already in progress');
        }
        
        const auction = {
            id: `auction_${territoryId}_${Date.now()}`,
            territoryId,
            territoryName: territory.name,
            
            type: options.type || AUCTION_TYPE.STANDARD,
            status: AUCTION_STATUS.ACTIVE,
            
            startingBid: options.startingBid || territory.tribute,
            currentBid: options.startingBid || territory.tribute,
            minIncrement: options.minIncrement || 100,
            
            highestBidder: null,
            highestBidderName: null,
            
            bids: [],
            
            startTime: new Date(),
            endTime: options.endTime || new Date(Date.now() + 24 * 60 * 60 * 1000), // 기본 24시간
            
            createdBy: user.uid,
            createdAt: new Date()
        };
        
        // Firestore 저장
        await firebaseService.setDocument('auctions', auction.id, auction);
        
        // 영토 상태 업데이트
        territory.sovereignty = SOVEREIGNTY.CONTESTED;
        territory.currentAuction = auction.id;
        await firebaseService.setDocument('territories', territoryId, territory);
        
        // 로컬 캐시 업데이트
        this.activeAuctions.set(auction.id, auction);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_START, { auction });
        
        log.info(`Auction created for territory ${territoryId}`);
        return auction;
    }
    
    /**
     * 입찰 처리
     */
    async handleBid(data) {
        const { auctionId, bidAmount, userId, userName } = data;
        
        const auction = this.activeAuctions.get(auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        
        if (auction.status !== AUCTION_STATUS.ACTIVE) {
            throw new Error('Auction is not active');
        }
        
        // 입찰 금액 검증
        const minBid = auction.currentBid + auction.minIncrement;
        if (bidAmount < minBid) {
            throw new Error(`Minimum bid is $${minBid}`);
        }
        
        // 전략 버프 적용
        const buffedBid = this.applyStrategyBuffs(bidAmount, userId, auction.territoryId);
        
        // 입찰 기록
        const bid = {
            userId,
            userName,
            amount: bidAmount,
            buffedAmount: buffedBid,
            timestamp: new Date()
        };
        
        auction.bids.push(bid);
        auction.currentBid = bidAmount;
        auction.highestBidder = userId;
        auction.highestBidderName = userName;
        
        // Firestore 업데이트
        await firebaseService.setDocument('auctions', auctionId, auction);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_UPDATE, { auction, newBid: bid });
        
        log.info(`Bid placed: $${bidAmount} (buffed: $${buffedBid}) by ${userName}`);
        return bid;
    }
    
    /**
     * 전략 버프 적용
     */
    applyStrategyBuffs(bidAmount, userId, territoryId) {
        let buffedAmount = bidAmount;
        const appliedBuffs = [];
        
        // 1. 인접 영토 보너스
        const adjacentBonus = this.calculateAdjacentBonus(userId, territoryId);
        if (adjacentBonus > 0) {
            buffedAmount *= (1 + adjacentBonus);
            appliedBuffs.push({
                type: 'adjacent',
                bonus: adjacentBonus,
                description: `인접 영토 보너스 +${Math.round(adjacentBonus * 100)}%`
            });
        }
        
        // 2. 국가 보너스
        const countryBonus = this.calculateCountryBonus(userId, territoryId);
        if (countryBonus > 0) {
            buffedAmount *= (1 + countryBonus);
            appliedBuffs.push({
                type: 'country',
                bonus: countryBonus,
                description: `국가 지배 보너스 +${Math.round(countryBonus * 100)}%`
            });
        }
        
        // 3. 시즌 보너스
        const seasonBonus = this.getSeasonBonus();
        if (seasonBonus > 0) {
            buffedAmount *= (1 + seasonBonus);
            appliedBuffs.push({
                type: 'season',
                bonus: seasonBonus,
                description: `시즌 보너스 +${Math.round(seasonBonus * 100)}%`
            });
        }
        
        // 버프 적용 이벤트
        if (appliedBuffs.length > 0) {
            eventBus.emit(EVENTS.BUFF_APPLIED, {
                userId,
                territoryId,
                buffs: appliedBuffs,
                originalAmount: bidAmount,
                buffedAmount
            });
        }
        
        return Math.round(buffedAmount);
    }
    
    /**
     * 인접 영토 보너스 계산
     */
    calculateAdjacentBonus(userId, territoryId) {
        const adjacentTerritories = territoryManager.getAdjacentTerritories(territoryId);
        const ownedAdjacent = adjacentTerritories.filter(t => t.ruler === userId);
        
        return ownedAdjacent.length * CONFIG.BUFFS.ADJACENT_BONUS;
    }
    
    /**
     * 국가 보너스 계산
     */
    calculateCountryBonus(userId, territoryId) {
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) return 0;
        
        const countryOccupation = territoryManager.getCountryOccupation(territory.countryCode, userId);
        
        if (countryOccupation.owned >= CONFIG.BUFFS.COUNTRY_THRESHOLD) {
            return CONFIG.BUFFS.COUNTRY_BONUS;
        }
        
        return 0;
    }
    
    /**
     * 시즌 보너스 가져오기
     */
    getSeasonBonus() {
        // TODO: 시즌 시스템 구현
        // 현재는 0 반환
        return 0;
    }
    
    /**
     * 옥션 종료
     */
    async endAuction(auctionId) {
        const auction = this.activeAuctions.get(auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        
        auction.status = AUCTION_STATUS.ENDED;
        
        // 낙찰자가 있으면 영토 정복 처리
        if (auction.highestBidder) {
            eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                territoryId: auction.territoryId,
                userId: auction.highestBidder,
                userName: auction.highestBidderName,
                tribute: auction.currentBid
            });
        } else {
            // 낙찰자 없으면 영토 상태 복구
            const territory = territoryManager.getTerritory(auction.territoryId);
            if (territory) {
                territory.sovereignty = SOVEREIGNTY.UNCONQUERED;
                territory.currentAuction = null;
                await firebaseService.setDocument('territories', auction.territoryId, territory);
            }
        }
        
        // Firestore 업데이트
        await firebaseService.setDocument('auctions', auctionId, auction);
        
        // 로컬 캐시 제거
        this.activeAuctions.delete(auctionId);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_END, { auction });
        
        log.info(`Auction ended: ${auctionId}`);
        return auction;
    }
    
    /**
     * 즉시 구매 (옥션 없이)
     */
    async instantConquest(territoryId, userId, userName) {
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            throw new Error('Territory not found');
        }
        
        if (territory.sovereignty === SOVEREIGNTY.RULED) {
            throw new Error('Territory is already ruled');
        }
        
        if (territory.sovereignty === SOVEREIGNTY.CONTESTED) {
            throw new Error('Auction in progress');
        }
        
        // 정복 이벤트 발행
        eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
            territoryId,
            userId,
            userName,
            tribute: territory.tribute
        });
        
        return territory;
    }
    
    /**
     * 활성 옥션 가져오기
     */
    getActiveAuction(auctionId) {
        return this.activeAuctions.get(auctionId);
    }
    
    /**
     * 영토의 활성 옥션 가져오기
     */
    getAuctionByTerritory(territoryId) {
        for (const [id, auction] of this.activeAuctions) {
            if (auction.territoryId === territoryId && auction.status === AUCTION_STATUS.ACTIVE) {
                return auction;
            }
        }
        return null;
    }
    
    /**
     * 모든 활성 옥션 목록
     */
    getAllActiveAuctions() {
        return Array.from(this.activeAuctions.values());
    }
    
    /**
     * 사용자 입찰 히스토리
     */
    async getUserBidHistory(userId) {
        try {
            return await firebaseService.queryCollection('auctions', [
                { field: 'bids', op: 'array-contains-any', value: [{ userId }] }
            ]);
        } catch (error) {
            log.error('Failed to get bid history:', error);
            return [];
        }
    }
    
    /**
     * 정리
     */
    cleanup() {
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        this.activeAuctions.clear();
    }
}

// 싱글톤 인스턴스
export const auctionSystem = new AuctionSystem();
export default auctionSystem;

