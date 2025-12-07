/**
 * AuctionSystem - 옥션 시스템
 * 영토 입찰, 전략 버프 적용, 옥션 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager, SOVEREIGNTY } from '../core/TerritoryManager.js';
import { territoryDataService } from '../services/TerritoryDataService.js';
import mapController from '../core/MapController.js';

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
        this.endCheckInterval = null; // 옥션 종료 체크 인터벌
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
            
            // 옥션 종료 시간 주기적 체크 시작
            this.startAuctionEndCheckInterval();
            
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
                
                // 영토 정보 가져오기 (startingBid 검증을 위해 필요)
                let territory = territoryManager.getTerritory(auction.territoryId);
                
                // startingBid 검증 및 수정 (잘못된 값이 저장되어 있을 수 있음)
                let needsUpdate = false;
                let correctedStartingBid = auction.startingBid;
                
                // 영토가 없어도 강제로 검증 (territoryId에서 국가 코드 추출 시도)
                let realPrice = null;
                let countryCode = null;
                
                if (territory) {
                    // 영토의 실제 가격 계산
                    countryCode = territory.country || 'unknown';
                    realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
                } else {
                    // territory가 없으면 territoryId에서 국가 코드 추출 시도 (예: "singapore-0" -> "singapore")
                    const territoryIdParts = auction.territoryId.split('-');
                    if (territoryIdParts.length > 1) {
                        const possibleCountryCode = territoryIdParts[0];
                        if (CONFIG.COUNTRIES[possibleCountryCode]) {
                            countryCode = possibleCountryCode;
                            try {
                                // 임시 territory 객체 생성하여 가격 계산 시도
                                const tempTerritory = { 
                                    id: auction.territoryId,
                                    country: possibleCountryCode,
                                    properties: {}
                                };
                                realPrice = territoryDataService.calculateTerritoryPrice(tempTerritory, possibleCountryCode);
                            } catch (error) {
                                log.warn(`[AuctionSystem] Could not calculate price for ${auction.territoryId}:`, error);
                            }
                        }
                    }
                    
                    // territoryId에서 국가 코드를 추출할 수 없으면, auction의 territoryName이나 다른 정보로부터 추출 시도
                    // "south-east" 같은 경우는 auction이 생성될 때 territory 정보가 있었을 것이므로
                    // 맵에서 feature를 찾아서 country 정보를 가져오기 시도
                    if (!realPrice && !countryCode) {
                        // 맵에서 feature 찾기 시도
                        const map = mapController.map;
                        if (map) {
                            try {
                                const allSources = Object.keys(map.getStyle().sources || {});
                                for (const sourceId of allSources) {
                                    const source = map.getSource(sourceId);
                                    if (source && source.type === 'geojson' && source._data) {
                                        const features = source._data.features || [];
                                        const matchingFeature = features.find(f => {
                                            const propsId = f.properties?.id || f.properties?.territoryId;
                                            const featureId = f.id;
                                            const featureName = f.properties?.name || f.properties?.name_en || '';
                                            
                                            // 여러 방법으로 매칭
                                            if (String(propsId) === String(auction.territoryId) ||
                                                String(featureId) === String(auction.territoryId)) {
                                                return true;
                                            }
                                            
                                            // 이름 기반 매칭
                                            if (featureName) {
                                                const normalizedName = featureName.toLowerCase()
                                                    .trim()
                                                    .replace(/[^\w\s-]/g, '')
                                                    .replace(/\s+/g, '-')
                                                    .replace(/-+/g, '-')
                                                    .replace(/^-|-$/g, '');
                                                const normalizedTerritoryId = String(auction.territoryId).toLowerCase();
                                                if (normalizedName === normalizedTerritoryId) {
                                                    return true;
                                                }
                                            }
                                            
                                            return false;
                                        });
                                        
                                        if (matchingFeature) {
                                            // feature에서 country 정보 추출
                                            const featureCountryIso = matchingFeature.properties?.adm0_a3;
                                            if (featureCountryIso) {
                                                const isoToSlugMap = territoryManager.createIsoToSlugMap();
                                                countryCode = isoToSlugMap[featureCountryIso.toUpperCase()];
                                                if (countryCode) {
                                                    // 임시 territory 객체 생성
                                                    territory = {
                                                        id: auction.territoryId,
                                                        country: countryCode,
                                                        properties: matchingFeature.properties,
                                                        geometry: matchingFeature.geometry
                                                    };
                                                    realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
                                                    log.debug(`[AuctionSystem] Found territory ${auction.territoryId} in map, country: ${countryCode}, realPrice: ${realPrice}`);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            } catch (error) {
                                log.debug(`[AuctionSystem] Could not find territory in map:`, error);
                            }
                        }
                    }
                }
                
                // ⚠️ 중요: country 정보를 auction 객체에 저장 (TerritoryListPanel에서 사용)
                if (countryCode && !auction.country) {
                    auction.country = countryCode;
                    needsUpdate = true;
                    log.debug(`[AuctionSystem] Added country to auction ${auction.id}: ${countryCode}`);
                }
                
                // 올바른 시작가 계산 (실제 가격의 60%, 최소 10pt)
                const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
                let correctStartingBid = realPrice 
                    ? Math.max(Math.floor(realPrice * auctionRatio), 10)
                    : 10;
                
                // realPrice를 계산하지 못했지만 startingBid가 50pt 이상이면 강제로 10pt로 수정
                // (일반적으로 startingBid는 10-30pt 범위이므로 50pt 이상은 명백히 잘못된 값)
                if (!realPrice && auction.startingBid >= 50) {
                    log.warn(`[AuctionSystem] ⚠️ Cannot calculate realPrice but startingBid ${auction.startingBid} is suspiciously high, forcing to 10pt`);
                    correctStartingBid = 10;
                    correctedStartingBid = 10;
                    auction.startingBid = 10;
                    needsUpdate = true;
                }
                
                // startingBid가 잘못되었으면 무조건 수정 (60pt 같은 잘못된 값 강제 수정)
                if (auction.startingBid !== correctStartingBid) {
                    log.warn(`[AuctionSystem] ⚠️ Invalid startingBid for ${auction.territoryId}: ${auction.startingBid}, correcting to ${correctStartingBid} (realPrice: ${realPrice || 'unknown'})`);
                    correctedStartingBid = correctStartingBid;
                    auction.startingBid = correctStartingBid;
                    needsUpdate = true;
                }
                
                // 추가 검증: startingBid가 50pt 이상이면 의심스러움 (일반적으로 10-30pt 범위)
                // realPrice가 있어도 startingBid가 50pt 이상이면 강제 수정
                if (auction.startingBid >= 50) {
                    if (realPrice && realPrice < 100) {
                        log.warn(`[AuctionSystem] ⚠️ Suspicious startingBid ${auction.startingBid} for ${auction.territoryId} (realPrice: ${realPrice}), forcing correction to ${correctStartingBid}`);
                    } else {
                        log.warn(`[AuctionSystem] ⚠️ Suspicious startingBid ${auction.startingBid} for ${auction.territoryId}, forcing correction to 10pt`);
                        correctStartingBid = 10;
                    }
                    correctedStartingBid = correctStartingBid;
                    auction.startingBid = correctStartingBid;
                    needsUpdate = true;
                }
                
                // 입찰자가 없는 경우: currentBid를 startingBid로 수정
                if (!auction.highestBidder) {
                    if (auction.currentBid !== correctedStartingBid) {
                        log.warn(`[AuctionSystem] ⚠️ Mismatched currentBid for ${auction.territoryId}: ${auction.currentBid}, fixing to startingBid (${correctedStartingBid})`);
                        auction.currentBid = correctedStartingBid;
                        needsUpdate = true;
                    }
                } 
                // 입찰자가 있는 경우: currentBid가 startingBid보다 크거나 같아야 함
                // 하지만 currentBid가 50pt 이상이고 startingBid가 10pt로 수정되었다면, currentBid도 재검증 필요
                else {
                    // startingBid가 수정되었고, currentBid가 잘못된 startingBid와 같거나 비슷하면 수정
                    if (auction.currentBid >= 50 && correctedStartingBid < 50) {
                        // currentBid가 잘못된 startingBid(60pt)와 같거나 비슷하면, 입찰 기록을 확인하여 올바른 값으로 수정
                        // 입찰 기록이 있으면 가장 높은 입찰가를 사용, 없으면 startingBid 사용
                        if (auction.bids && auction.bids.length > 0) {
                            const highestBid = Math.max(...auction.bids.map(b => b.amount || b.buffedAmount || 0));
                            if (highestBid > 0 && highestBid < 50) {
                                log.warn(`[AuctionSystem] ⚠️ Invalid currentBid ${auction.currentBid} for ${auction.territoryId}, fixing to highest bid (${highestBid})`);
                                auction.currentBid = highestBid;
                                needsUpdate = true;
                            } else {
                                log.warn(`[AuctionSystem] ⚠️ Invalid currentBid ${auction.currentBid} for ${auction.territoryId}, fixing to startingBid (${correctedStartingBid})`);
                                auction.currentBid = correctedStartingBid;
                                needsUpdate = true;
                            }
                        } else {
                            log.warn(`[AuctionSystem] ⚠️ Invalid currentBid ${auction.currentBid} for ${auction.territoryId}, fixing to startingBid (${correctedStartingBid})`);
                            auction.currentBid = correctedStartingBid;
                            needsUpdate = true;
                        }
                    } else if (!auction.currentBid || auction.currentBid < correctedStartingBid) {
                        log.warn(`[AuctionSystem] ⚠️ Invalid currentBid for ${auction.territoryId}: ${auction.currentBid}, fixing to startingBid (${correctedStartingBid})`);
                        auction.currentBid = correctedStartingBid;
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
                                highestBidderName: auction.highestBidderName || null,
                                updatedAt: firebaseService.getTimestamp()
                            });
                            log.info(`[AuctionSystem] ✅ Successfully updated auction ${auction.id}: startingBid=${auction.startingBid}, currentBid=${auction.currentBid}`);
                        } catch (error) {
                            log.warn(`[AuctionSystem] Failed to update auction ${auction.id} (auth required):`, error.message);
                        }
                    } else {
                        log.debug(`[AuctionSystem] Skipping auction update for ${auction.id} (user not authenticated)`);
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
                
                // bids 배열이 없으면 초기화
                if (!auction.bids || !Array.isArray(auction.bids)) {
                    auction.bids = [];
                }
                
                // activeAuctions에 저장
                this.activeAuctions.set(auction.id, auction);
                
                // 경매가 로드되었으므로 AUCTION_START 이벤트 발생 (애니메이션 시작)
                eventBus.emit(EVENTS.AUCTION_START, { auction });
                log.debug(`[AuctionSystem] Emitted AUCTION_START for loaded auction ${auction.id}`);
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
        
        // ⚠️ 중요: Territory ID 필수 검증
        // 새로운 Territory ID 형식("COUNTRY_ISO3::ADMIN_CODE") 또는 legacy ID가 있어야 함
        if (!territoryId || typeof territoryId !== 'string' || territoryId.trim() === '') {
            throw new Error('Territory ID is required and must be a non-empty string');
        }
        
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            throw new Error('Territory not found');
        }
        
        // ⚠️ 중요: 새로운 Territory ID 형식 검증 및 추출
        // territory.properties.territoryId가 있으면 (새로운 형식: "SGP::ADM1_003") 우선 사용
        let finalTerritoryId = territoryId;
        let countryIso = null;
        
        const newTerritoryId = territory.properties?.territoryId || territory.territoryId;
        if (newTerritoryId && newTerritoryId.includes('::')) {
            // 새로운 Territory ID 형식 사용
            finalTerritoryId = newTerritoryId;
            
            // Territory ID에서 countryIso 추출
            const parts = newTerritoryId.split('::');
            if (parts.length === 2 && parts[0].length === 3) {
                countryIso = parts[0].toUpperCase();
            }
            
            log.info(`[AuctionSystem] Using new Territory ID format: ${finalTerritoryId} (countryIso: ${countryIso})`);
        } else {
            // Legacy 형식: country 정보를 territory에서 추출
            countryIso = territory.properties?.adm0_a3 || territory.countryIso;
            if (countryIso && countryIso.length === 3) {
                countryIso = countryIso.toUpperCase();
            } else {
                // countryIso를 countryCode에서 변환 시도
                const countryCode = territory.country || territory.properties?.country;
                if (countryCode) {
                    // ISO to slug 매핑에서 역변환 시도
                    const isoToSlugMap = territoryManager.createIsoToSlugMap();
                    for (const [iso, slug] of Object.entries(isoToSlugMap)) {
                        if (slug === countryCode) {
                            countryIso = iso;
                            break;
                        }
                    }
                }
            }
            
            log.warn(`[AuctionSystem] ⚠️ Using legacy Territory ID format: ${finalTerritoryId} (countryIso: ${countryIso || 'UNKNOWN'}). Consider migrating to new format.`);
        }
        
        // ⚠️ 중요: countryIso 필수 검증
        // countryIso가 없으면 Auction을 생성할 수 없음 (동일 이름 행정구역 구분 불가)
        if (!countryIso || countryIso.length !== 3) {
            throw new Error(`Cannot create auction: countryIso is required for territory ${finalTerritoryId}. Got: ${countryIso || 'null'}. Territory must have valid country information.`);
        }
        
        // 이미 진행 중인 옥션 확인 (로컬 캐시)
        if (territory.currentAuction) {
            throw new Error('Auction already in progress');
        }
        
        // Firestore에서도 활성 옥션 확인 (중복 생성 방지)
        try {
            const existingAuctions = await firebaseService.queryCollection('auctions', [
                { field: 'territoryId', op: '==', value: territoryId },
                { field: 'status', op: '==', value: AUCTION_STATUS.ACTIVE }
            ]);
            
            if (existingAuctions && existingAuctions.length > 0) {
                log.warn(`[AuctionSystem] ⚠️ Active auction already exists for ${territoryId} in Firestore (${existingAuctions.length} found), preventing duplicate creation`);
                throw new Error(`Auction already exists for this territory (${existingAuctions.length} active auction(s) found)`);
            }
        } catch (error) {
            // 권한 오류나 다른 오류인 경우, 에러 메시지에 따라 처리
            if (error.message && error.message.includes('already exists')) {
                throw error; // 중복 옥션 에러는 그대로 전달
            }
            // 다른 오류는 로그만 남기고 계속 진행 (권한 문제일 수 있음)
            log.debug(`[AuctionSystem] Could not check for existing auctions (may require auth):`, error.message);
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
        
        // 영토 이름 추출 (TerritoryPanel의 extractName 로직과 동일하게 처리)
        const extractName = (name) => {
            if (!name) return null;
            if (typeof name === 'string' && name.trim() !== '') return name.trim();
            if (typeof name === 'object') {
                // 객체인 경우: en, ko, local 순서로 확인
                const nameStr = name.en || name.ko || name.local;
                if (nameStr && typeof nameStr === 'string' && nameStr.trim() !== '') {
                    return nameStr.trim();
                }
                // 객체의 다른 값들 중 문자열 찾기
                const found = Object.values(name).find(v => v && typeof v === 'string' && v.trim() !== '');
                if (found) return found.trim();
            }
            return null;
        };
        
        // 여러 소스에서 이름 추출 시도
        let territoryName = null;
        
        // 1. territory.name에서 추출
        if (territory.name) {
            territoryName = extractName(territory.name);
        }
        
        // 2. territory.properties.name에서 추출
        if (!territoryName && territory.properties?.name) {
            territoryName = extractName(territory.properties.name);
        }
        
        // 3. territory.properties.name_en에서 추출
        if (!territoryName && territory.properties?.name_en) {
            territoryName = extractName(territory.properties.name_en);
        }
        
        // 4. 모든 시도가 실패하면 territoryId 사용
        if (!territoryName) {
            territoryName = String(territoryId);
            log.warn(`[AuctionSystem] Could not extract territoryName for ${territoryId}, using territoryId`);
        } else {
            // 확실히 문자열로 변환
            territoryName = String(territoryName).trim();
        }
        
        // 최종 검증: territoryName이 유효한 문자열인지 확인
        if (!territoryName || 
            typeof territoryName !== 'string' ||
            territoryName === '' ||
            territoryName === 'undefined' || 
            territoryName === 'null') {
            log.warn(`[AuctionSystem] territoryName validation failed for ${finalTerritoryId}, using finalTerritoryId`);
            territoryName = String(finalTerritoryId);
        }
        
        // 영토 소유자 이름 추출 (null이 아닌 문자열로)
        const currentOwnerName = territory.rulerName || null;
        
        // 디버깅 로그
        log.debug(`[AuctionSystem] Creating auction for ${finalTerritoryId}, territoryName: "${territoryName}" (type: ${typeof territoryName}, length: ${territoryName.length})`);
        
        // auction 객체 생성 전 최종 검증 (절대 undefined가 되지 않도록)
        const finalTerritoryName = (territoryName && 
                                    typeof territoryName === 'string' && 
                                    territoryName.trim() !== '' &&
                                    territoryName !== 'undefined' &&
                                    territoryName !== 'null') 
                                    ? String(territoryName).trim() 
                                    : String(finalTerritoryId);
        
        log.debug(`[AuctionSystem] Final territoryName for auction: "${finalTerritoryName}" (original: "${territoryName}")`);
        
        // 국가 정보 추출 및 저장 (행정구역 이름 중복 구분을 위해 필수)
        // countryIso는 이미 위에서 검증 및 설정됨
        // countryCode는 slug 형식으로 변환 (ISO to slug 매핑 사용)
        let countryCodeSlug = null;
        if (countryIso) {
            const isoToSlugMap = territoryManager.createIsoToSlugMap();
            countryCodeSlug = isoToSlugMap[countryIso] || countryCode; // ISO 매핑이 없으면 기존 countryCode 사용
        }
        
        const auction = {
            id: `auction_${finalTerritoryId.replace(/::/g, '_')}_${Date.now()}`, // Territory ID의 ::를 _로 변환하여 auction ID 생성
            territoryId: finalTerritoryId,  // 새로운 Territory ID 형식 또는 legacy ID
            territoryName: finalTerritoryName, // 확실히 문자열로 변환된 이름
            country: countryCodeSlug || countryCode, // 국가 코드 (slug 형식, 예: 'singapore', 'botswana')
            countryIso: countryIso, // ISO 코드 (예: 'SGP', 'BWA') - 필수
            
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
            currentOwnerName: currentOwnerName, // null이 아닌 문자열 또는 null
            
            createdBy: user.uid,
            createdAt: Timestamp.now()
        };
        
        // Firestore 저장 전에 auction 객체 검증 및 정리
        // territoryName이 절대 undefined가 되지 않도록 보장
        if (!auction.territoryName || 
            auction.territoryName === undefined || 
            typeof auction.territoryName !== 'string') {
            log.error(`[AuctionSystem] CRITICAL: auction.territoryName is invalid before Firestore save! Setting to territoryId.`);
            auction.territoryName = String(territoryId);
        }
        
        // auctionForFirestore 생성 (territoryName은 이미 검증됨)
        const auctionForFirestore = { ...auction };
        
        // territoryName 최종 검증 및 정리
        auctionForFirestore.territoryName = String(auctionForFirestore.territoryName || territoryId).trim();
        if (auctionForFirestore.territoryName === '' || 
            auctionForFirestore.territoryName === 'undefined' || 
            auctionForFirestore.territoryName === 'null') {
            log.error(`[AuctionSystem] CRITICAL: territoryName is invalid after copy! Setting to territoryId.`);
            auctionForFirestore.territoryName = String(territoryId);
        }
        
        // undefined 필드 제거 (territoryName은 제외)
        Object.keys(auctionForFirestore).forEach(key => {
            if (auctionForFirestore[key] === undefined) {
                if (key === 'territoryName') {
                    // territoryName이 undefined면 절대 안 됨 - 강제로 설정
                    log.error(`[AuctionSystem] CRITICAL: territoryName is undefined! Setting to territoryId.`);
                    auctionForFirestore.territoryName = String(territoryId);
                } else {
                    delete auctionForFirestore[key];
                    log.warn(`[AuctionSystem] Removed undefined field: ${key} from auction ${auction.id}`);
                }
            }
        });
        
        // 최종 검증: territoryName이 여전히 없으면 territoryId 사용 (절대 발생하면 안 됨)
        if (!auctionForFirestore.territoryName || 
            auctionForFirestore.territoryName === undefined || 
            typeof auctionForFirestore.territoryName !== 'string' ||
            auctionForFirestore.territoryName.trim() === '') {
            log.error(`[AuctionSystem] CRITICAL: Final validation failed for territoryName! Setting to territoryId.`);
            auctionForFirestore.territoryName = String(territoryId);
        }
        
        // 최종 디버깅 로그
        log.debug(`[AuctionSystem] Saving auction ${auction.id} with territoryName: "${auctionForFirestore.territoryName}" (type: ${typeof auctionForFirestore.territoryName})`);
        
        // Firestore 저장
        await firebaseService.setDocument('auctions', auction.id, auctionForFirestore);
        
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
        
        // 입찰자가 없는 경우 startingBid를 기준으로, 있는 경우 currentBid를 기준으로 계산
        const hasBids = !!auction.highestBidder;
        
        // 입찰자가 없으면 startingBid를 사용, 있으면 currentBid 사용
        let effectiveCurrentBid;
        if (!hasBids) {
            // 입찰자가 없으면 startingBid를 기준으로 계산
            effectiveCurrentBid = auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE;
        } else {
            // 입찰자가 있으면 currentBid 사용 (최소 startingBid 이상이어야 함)
            effectiveCurrentBid = auction.currentBid && auction.currentBid >= (auction.startingBid || 0)
                ? auction.currentBid
                : (auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE);
        }
        
        // minIncrement 계산
        // 입찰자가 있든 없든 항상 1pt 증가액 사용 (1pt 단위 입찰)
        const effectiveMinIncrement = 1;
        
        // 입찰 금액 검증
        const minBid = effectiveCurrentBid + effectiveMinIncrement;
        if (bidAmount < minBid) {
            throw new Error(`Minimum bid is ${minBid} pt`);
        }
        
        // startingBid 검증 및 수정 (입찰 전에 한 번 더 확인)
        const territory = territoryManager.getTerritory(auction.territoryId);
        if (territory) {
            const countryCode = territory.country || 'unknown';
            const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
            const correctStartingBid = realPrice 
                ? Math.max(Math.floor(realPrice * auctionRatio), 10)
                : 10;
            
            if (auction.startingBid !== correctStartingBid) {
                log.warn(`[AuctionSystem] ⚠️ Invalid startingBid ${auction.startingBid} detected in handleBid, correcting to ${correctStartingBid} (realPrice: ${realPrice}, country: ${countryCode})`);
                auction.startingBid = correctStartingBid;
            }
        }
        
        // currentBid 업데이트 (기존 데이터 수정)
        if (auction.currentBid !== effectiveCurrentBid) {
            auction.currentBid = effectiveCurrentBid;
        }
        
        // 전략 버프 적용
        const buffedBid = this.applyStrategyBuffs(bidAmount, userId, auction.territoryId);
        
        // 입찰 기록
        const Timestamp = firebaseService.getTimestamp();
        const bid = {
            userId,
            userName,
            amount: bidAmount,
            buffedAmount: buffedBid,
            timestamp: Timestamp ? Timestamp.now() : new Date()
        };
        
        // bids 배열 초기화 (없으면)
        if (!auction.bids || !Array.isArray(auction.bids)) {
            auction.bids = [];
        }
        
        auction.bids.push(bid);
        auction.currentBid = bidAmount;
        auction.highestBidder = userId;
        auction.highestBidderName = userName;
        
        // activeAuctions Map 업데이트 (메모리 캐시 동기화)
        this.activeAuctions.set(auctionId, auction);
        
        // ✅ 관리자 모드 확인
        const isAdmin = data.isAdmin || 
                       (userId && userId.startsWith('admin_')) ||
                       (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
        
        // 옥션에 관리자 플래그 저장
        auction.purchasedByAdmin = isAdmin;
        
        // Firestore 업데이트 (필요한 필드만 업데이트)
        try {
            // bids 배열을 Firestore에 저장 가능한 형태로 변환
            const bidsForFirestore = auction.bids.map(b => ({
                userId: b.userId,
                userName: b.userName,
                amount: b.amount,
                buffedAmount: b.buffedAmount,
                timestamp: b.timestamp instanceof Date 
                    ? (Timestamp ? Timestamp.fromDate(b.timestamp) : b.timestamp)
                    : b.timestamp
            }));
            
            await firebaseService.updateDocument('auctions', auctionId, {
                currentBid: auction.currentBid,
                startingBid: auction.startingBid, // startingBid도 함께 업데이트
                highestBidder: auction.highestBidder,
                highestBidderName: auction.highestBidderName,
                purchasedByAdmin: isAdmin,  // ✅ 관리자 플래그 추가
                bids: bidsForFirestore, // 입찰 기록 배열 저장
                updatedAt: Timestamp ? Timestamp.now() : new Date()
            });
            log.info(`[AuctionSystem] Bid saved to Firestore: ${bidAmount} pt by ${userName} (${auction.bids.length} total bids)${isAdmin ? ' [Admin]' : ''}`);
        } catch (error) {
            log.error(`[AuctionSystem] Failed to save bid to Firestore:`, error);
            // 에러가 발생해도 로컬 캐시는 업데이트되었으므로 계속 진행
            throw error; // 상위로 에러 전달
        }
        
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
        // activeAuctions Map에서 먼저 확인
        let auction = this.activeAuctions.get(auctionId);
        
        // Map에 없으면 Firestore에서 가져오기
        if (!auction) {
            log.warn(`[AuctionSystem] Auction ${auctionId} not in activeAuctions, loading from Firestore...`);
            try {
                const auctionData = await firebaseService.getDocument('auctions', auctionId);
                if (auctionData) {
                    auction = auctionData;
                    auction.id = auctionId;
                    log.info(`[AuctionSystem] Loaded auction ${auctionId} from Firestore`);
                } else {
                    throw new Error(`Auction ${auctionId} not found in Firestore`);
                }
            } catch (error) {
                log.error(`[AuctionSystem] Failed to load auction ${auctionId} from Firestore:`, error);
                throw new Error(`Auction not found: ${auctionId}`);
            }
        }
        
        auction.status = AUCTION_STATUS.ENDED;
        
        // 낙찰자가 있으면 영토 정복 처리
        if (auction.highestBidder) {
            // 관리자 모드 확인
            const isAdmin = auction.purchasedByAdmin || 
                           (auction.highestBidder && auction.highestBidder.startsWith('admin_')) ||
                           (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
            
            log.info(`[AuctionSystem] Auction ${auctionId} ended. Winner: ${auction.highestBidderName} (${auction.highestBidder}), Bid: ${auction.currentBid} pt${isAdmin ? ' [Admin]' : ''}`);
            
            // TERRITORY_CONQUERED 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                territoryId: auction.territoryId,
                userId: auction.highestBidder,
                userName: auction.highestBidderName,
                tribute: auction.currentBid,
                isAdmin: isAdmin  // ✅ isAdmin 플래그 추가
            });
            
            // 이벤트 발행 후 약간의 지연을 두어 처리 시간 확보
            await new Promise(resolve => setTimeout(resolve, 100));
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
        
        // 옥션 종료 체크 인터벌 정리
        if (this.endCheckInterval) {
            clearInterval(this.endCheckInterval);
            this.endCheckInterval = null;
        }
    }
    
    /**
     * 옥션 종료 시간 주기적 체크
     */
    startAuctionEndCheckInterval() {
        // 이미 실행 중이면 스킵
        if (this.endCheckInterval) {
            return;
        }
        
        log.info('[AuctionSystem] Starting auction end check interval (every 5 seconds)');
        
        this.endCheckInterval = setInterval(async () => {
            const now = new Date();
            let expiredCount = 0;
            
            for (const [auctionId, auction] of this.activeAuctions) {
                if (auction.status !== AUCTION_STATUS.ACTIVE) continue;
                
                const endTime = auction.endTime;
                if (!endTime) continue;
                
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
                
                if (endDate && !isNaN(endDate.getTime()) && endDate.getTime() <= now.getTime()) {
                    expiredCount++;
                    log.info(`[AuctionSystem] Auction ${auctionId} expired, ending...`);
                    try {
                        await this.endAuction(auctionId);
                        log.info(`[AuctionSystem] ✅ Auction ${auctionId} ended successfully`);
                    } catch (error) {
                        log.error(`[AuctionSystem] ❌ Failed to end auction ${auctionId}:`, error);
                    }
                }
            }
            
            if (expiredCount > 0) {
                log.info(`[AuctionSystem] Processed ${expiredCount} expired auction(s)`);
            }
        }, 5000); // 5초마다 체크
    }
}

// 싱글톤 인스턴스
export const auctionSystem = new AuctionSystem();
export default auctionSystem;

