/**
 * AuctionSystem - 옥션 시스템
 * 영토 입찰, 전략 버프 적용, 옥션 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager, SOVEREIGNTY } from '../core/TerritoryManager.js';
import { territoryDataService } from '../services/TerritoryDataService.js';

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
            // 로그인하지 않은 상태에서도 읽기는 가능하도록 try-catch로 감싸기
            let auctions = [];
            try {
                auctions = await firebaseService.queryCollection('auctions', [
                    { field: 'status', op: '==', value: AUCTION_STATUS.ACTIVE }
                ]);
            } catch (error) {
                // 권한 오류인 경우 빈 배열 반환 (로그인하지 않은 상태에서 읽기 시도)
                if (error.message && error.message.includes('permissions')) {
                    log.debug('Cannot load auctions: user not authenticated (this is normal for logged-out users)');
                    this.activeAuctions.clear();
                    return;
                }
                throw error; // 다른 오류는 다시 throw
            }
            
            for (const auction of auctions) {
                // 경매 종료 시간 확인 및 자동 종료 처리
                const endTime = auction.endTime;
                let isExpired = false;
                
                if (endTime) {
                    let endDate;
                    // Firestore Timestamp 처리
                    if (endTime && typeof endTime === 'object') {
                        if (endTime.toDate && typeof endTime.toDate === 'function') {
                            endDate = endTime.toDate();
                        } else if (endTime.seconds) {
                            endDate = new Date(endTime.seconds * 1000);
                        } else if (endTime instanceof Date) {
                            endDate = endTime;
                        } else {
                            endDate = new Date(endTime);
                        }
                    } else {
                        endDate = new Date(endTime);
                    }
                    
                    // 종료 시간이 지났는지 확인
                    if (endDate && !isNaN(endDate.getTime())) {
                        const now = new Date();
                        if (endDate.getTime() <= now.getTime()) {
                            isExpired = true;
                            log.info(`Auction ${auction.id} has expired, auto-ending...`);
                            // 자동 종료 처리 (로그인한 사용자만 가능)
                            if (firebaseService.isAuthenticated()) {
                                try {
                                    await this.endAuction(auction.id);
                                } catch (error) {
                                    log.warn(`Failed to auto-end auction ${auction.id} (auth required):`, error.message);
                                }
                            } else {
                                log.debug(`Skipping auto-end for auction ${auction.id} (user not authenticated)`);
                            }
                            continue; // 종료된 경매는 activeAuctions에 추가하지 않음
                        }
                    }
                }
                
                // 경매가 아직 활성 상태인 경우에만 처리
                // 영토 정보 가져와서 실제 가격 계산
                const territory = territoryManager.getTerritory(auction.territoryId);
                let correctStartingBid = auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE;
                
                if (territory) {
                    // 영토의 실제 가격 계산
                    const countryCode = territory.country || 
                                      territory.properties?.country || 
                                      territory.properties?.adm0_a3?.toLowerCase() || 
                                      'unknown';
                    const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
                    
                    if (realPrice && realPrice > 0) {
                        // 경매 시작가는 즉시 구매가의 60%로 설정 (입찰자가 없는 경우에만 업데이트)
                        // 입찰자가 있으면 이미 진행 중인 경매이므로 시작가는 변경하지 않음
                        if (!auction.highestBidder) {
                            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
                            correctStartingBid = Math.max(Math.floor(realPrice * auctionRatio), 10); // 최소 10pt
                        } else {
                            // 입찰자가 있는 경우는 실제 가격 사용 (기존 로직 유지)
                            correctStartingBid = realPrice;
                        }
                    }
                }
                
                let needsUpdate = false;
                
                // 입찰자가 없는 경우: currentBid는 startingBid와 같아야 함
                if (!auction.highestBidder) {
                    // currentBid가 startingBid와 다르거나, startingBid가 실제 가격과 다르면 수정
                    if (auction.currentBid !== correctStartingBid || auction.startingBid !== correctStartingBid) {
                        log.warn(`Auction ${auction.id} has mismatched currentBid (${auction.currentBid}) or startingBid (${auction.startingBid}), fixing to correct price (${correctStartingBid})`);
                        auction.currentBid = correctStartingBid;
                        auction.startingBid = correctStartingBid;
                        needsUpdate = true;
                    }
                } 
                // 입찰자가 있는 경우: currentBid가 startingBid보다 크거나 같아야 함
                else {
                    if (!auction.currentBid || auction.currentBid < correctStartingBid) {
                        log.warn(`Auction ${auction.id} has invalid currentBid (${auction.currentBid}), fixing to startingBid (${correctStartingBid})`);
                        auction.currentBid = correctStartingBid;
                        needsUpdate = true;
                    }
                    
                    // startingBid가 실제 가격과 다르면 수정 (입찰자는 유지)
                    if (auction.startingBid !== correctStartingBid) {
                        auction.startingBid = correctStartingBid;
                        needsUpdate = true;
                    }
                }
                
                // Firestore 업데이트 (로그인한 사용자만 가능)
                if (needsUpdate) {
                    // 로그인 상태 확인
                    if (firebaseService.isAuthenticated()) {
                        try {
                            await firebaseService.updateDocument('auctions', auction.id, {
                                currentBid: auction.currentBid,
                                startingBid: auction.startingBid,
                                highestBidder: auction.highestBidder || null,
                                highestBidderName: auction.highestBidderName || null
                            });
                        } catch (error) {
                            log.warn(`Failed to update auction ${auction.id} (auth required):`, error.message);
                        }
                    } else {
                        log.debug(`Skipping auction update for ${auction.id} (user not authenticated)`);
                    }
                }
                
                // 영토 상태 확인 및 수정
                // 경매가 있는데 영토 상태가 CONTESTED가 아니면 수정 (미점유 영토인 경우만)
                if (territory && !territory.ruler) {
                    if (territory.sovereignty !== SOVEREIGNTY.CONTESTED) {
                        // 미점유 영토에서 경매가 시작되었는데 상태가 CONTESTED가 아니면 수정
                        territory.sovereignty = SOVEREIGNTY.CONTESTED;
                        territory.currentAuction = auction.id;
                        
                        const Timestamp = firebaseService.getTimestamp();
                        await firebaseService.updateDocument('territories', auction.territoryId, {
                            sovereignty: SOVEREIGNTY.CONTESTED,
                            currentAuction: auction.id,
                            updatedAt: Timestamp ? Timestamp.now() : new Date()
                        });
                    }
                }
                
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
        
        // Firestore Timestamp 가져오기
        const Timestamp = firebaseService.getTimestamp();
        if (!Timestamp) {
            throw new Error('Firestore Timestamp not available');
        }
        
        // 경매 종료 시간 결정
        let auctionEndTime;
        const protectionRemaining = territoryManager.getProtectionRemaining(territoryId);
        
        if (protectionRemaining && protectionRemaining.totalMs > 0) {
            // 보호 기간 중인 영토: 보호 기간 종료 시점에 경매 종료
            const endDate = new Date(Date.now() + protectionRemaining.totalMs);
            auctionEndTime = Timestamp.fromDate(endDate);
        } else if (territory.sovereignty === SOVEREIGNTY.RULED || 
                   territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            // 이미 소유된 영토: 7일 경매
            const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            auctionEndTime = Timestamp.fromDate(endDate);
        } else {
            // 미점유 영토: 24시간 경매
            const endDate = options.endTime ? new Date(options.endTime) : new Date(Date.now() + 24 * 60 * 60 * 1000);
            auctionEndTime = Timestamp.fromDate(endDate);
        }
        
        // 시작 입찰가 결정 (영토 실제 가격 계산)
        const countryCode = territory.country || 
                          territory.properties?.country || 
                          territory.properties?.adm0_a3?.toLowerCase() || 
                          'unknown';
        const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        
        // 경매 시작가는 즉시 구매가보다 낮게 설정 (기본 60%)
        // 사용자가 직접 지정한 경우는 그대로 사용, 아니면 즉시 구매가의 비율로 계산
        const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
        const calculatedStartingBid = realPrice 
            ? Math.max(Math.floor(realPrice * auctionRatio), 10) // 최소 10pt
            : (territory.tribute || CONFIG.TERRITORY.DEFAULT_TRIBUTE);
        
        const startingBid = options.startingBid || calculatedStartingBid;
        
        // 최소 증가액 결정 (시작가의 10% 또는 최소 10pt)
        const defaultMinIncrement = Math.max(
            Math.floor(startingBid * 0.1), // 시작가의 10%
            10 // 최소 10pt
        );
        const minIncrement = options.minIncrement || defaultMinIncrement;
        
        const auction = {
            id: `auction_${territoryId}_${Date.now()}`,
            territoryId,
            territoryName: territory.name,
            
            type: options.type || AUCTION_TYPE.STANDARD,
            status: AUCTION_STATUS.ACTIVE,
            
            startingBid: startingBid,
            currentBid: startingBid, // 시작가와 동일하게 설정
            minIncrement: minIncrement,
            
            highestBidder: null,
            highestBidderName: null,
            
            bids: [],
            
            startTime: Timestamp.now(),
            endTime: auctionEndTime,
            
            // 보호 기간 중 경매 여부
            isProtectedAuction: !!(protectionRemaining && protectionRemaining.totalMs > 0),
            currentOwnerId: territory.ruler || null,
            currentOwnerName: territory.rulerName || null,
            
            createdBy: user.uid,
            createdAt: Timestamp.now()
        };
        
        // Firestore 저장
        await firebaseService.setDocument('auctions', auction.id, auction);
        
        // 영토 상태 업데이트
        // 미점유 영토에서 경매 시작 시에만 CONTESTED로 변경
        // 이미 소유된 영토는 sovereignty 유지 (RULED 또는 PROTECTED)
        let newSovereignty = territory.sovereignty;
        
        if (!protectionRemaining && territory.sovereignty === SOVEREIGNTY.UNCONQUERED) {
            // 미점유 영토에서 경매 시작: CONTESTED로 변경
            newSovereignty = SOVEREIGNTY.CONTESTED;
        }
        // 보호 기간 중이거나 이미 소유된 영토: sovereignty 유지
        
        // Firestore에 저장할 때는 배열 필드 제외 (중첩 배열 오류 방지)
        const territoryUpdate = {
            sovereignty: newSovereignty,
            currentAuction: auction.id,
            updatedAt: Timestamp.now()
        };
        
        await firebaseService.updateDocument('territories', territoryId, territoryUpdate);
        
        // 로컬 캐시 업데이트
        territory.sovereignty = newSovereignty;
        territory.currentAuction = auction.id;
        
        // 로컬 캐시 업데이트
        this.activeAuctions.set(auction.id, auction);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_START, { auction });
        
        const daysRemaining = Math.ceil((auctionEndTime - new Date()) / (24 * 60 * 60 * 1000));
        log.info(`Auction created for territory ${territoryId}, ends in ${daysRemaining} days`);
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
        
        // currentBid가 startingBid보다 작거나 없으면 startingBid 사용 (기존 데이터 호환성)
        const effectiveCurrentBid = auction.currentBid && auction.currentBid >= (auction.startingBid || 0) 
            ? auction.currentBid 
            : (auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE);
        
        // minIncrement가 없거나 너무 크면 시작가의 10% 또는 최소 10pt로 설정
        const effectiveMinIncrement = auction.minIncrement || Math.max(
            Math.floor(effectiveCurrentBid * 0.1),
            10
        );
        
        // 입찰 금액 검증
        const minBid = effectiveCurrentBid + effectiveMinIncrement;
        if (bidAmount < minBid) {
            throw new Error(`Minimum bid is ${minBid} pt`);
        }
        
        // currentBid 업데이트 (기존 데이터 수정)
        if (auction.currentBid !== effectiveCurrentBid) {
            auction.currentBid = effectiveCurrentBid;
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
        
        log.info(`Bid placed: ${bidAmount} pt (buffed: ${buffedBid} pt) by ${userName}`);
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
                
                // Firestore 업데이트 (배열 필드 제외)
                const Timestamp = firebaseService.getTimestamp();
                await firebaseService.updateDocument('territories', auction.territoryId, {
                    sovereignty: SOVEREIGNTY.UNCONQUERED,
                    currentAuction: null,
                    updatedAt: Timestamp.now()
                });
            }
        }
        
        // Firestore 업데이트
        const Timestamp = firebaseService.getTimestamp();
        await firebaseService.updateDocument('auctions', auction.id, {
            status: AUCTION_STATUS.ENDED,
            endedAt: Timestamp ? Timestamp.now() : new Date(),
            updatedAt: Timestamp ? Timestamp.now() : new Date()
        });
        
        // 영토 상태 업데이트 (낙찰자가 없는 경우에만 - 있으면 위에서 이미 처리됨)
        if (!auction.highestBidder) {
            const territory = territoryManager.getTerritory(auction.territoryId);
            if (territory) {
                // 경매 시작 전 상태로 복구
                // 원래 소유자가 있었으면 (currentOwnerId) 그 상태로 복구
                // 없으면 UNCONQUERED로 복구
                if (auction.currentOwnerId) {
                    // 원래 소유자가 있었던 경우: RULED로 복구 (보호 기간은 이미 지났을 것)
                    territory.sovereignty = SOVEREIGNTY.RULED;
                    territory.ruler = auction.currentOwnerId;
                    territory.rulerName = auction.currentOwnerName;
                } else {
                    // 원래 소유자가 없었던 경우: UNCONQUERED로 복구
                    territory.sovereignty = SOVEREIGNTY.UNCONQUERED;
                    territory.ruler = null;
                    territory.rulerName = null;
                }
                territory.currentAuction = null;
                
                // Firestore 업데이트
                const Timestamp = firebaseService.getTimestamp();
                await firebaseService.updateDocument('territories', auction.territoryId, {
                    sovereignty: territory.sovereignty,
                    ruler: territory.ruler || null,
                    rulerName: territory.rulerName || null,
                    currentAuction: null,
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                });
            }
        }
        
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

