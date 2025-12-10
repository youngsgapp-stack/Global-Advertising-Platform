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
import { normalizeTerritoryId, matchTerritoryIds } from '../utils/TerritoryIdUtils.js';

// 옥션 타입
export const AUCTION_TYPE = {
    STANDARD: 'standard',   // 표준 입찰 (최고가 낙찰)
    DUTCH: 'dutch',         // 역경매 (가격 하락)
    SEALED: 'sealed',       // 봉인 입찰
    PROTECTION_EXTENSION: 'protection_extension'  // 보호 기간 연장 경매
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
    async loadActiveAuctions(forceRefresh = false) {
        try {
            // ⚡ 최적화: 최근에 로드한 경우 캐시 사용 (5분 이내)
            const CACHE_DURATION_MS = 5 * 60 * 1000; // 5분
            if (!forceRefresh && this._lastLoadTime && 
                (Date.now() - this._lastLoadTime) < CACHE_DURATION_MS) {
                log.debug(`[AuctionSystem] Using cached active auctions (age: ${Math.round((Date.now() - this._lastLoadTime) / 1000)}s)`);
                return; // 캐시된 데이터 사용
            }
            
            // 로그인하지 않은 상태에서도 읽기는 가능하도록 try-catch로 감싸기
            let auctions = [];
            try {
                // ⚡ 최적화: 먼저 Vercel API를 통해 시도 (CDN 캐시 활용)
                log.debug(`[AuctionSystem] 📡 Attempting to fetch auctions via API`);
                try {
                    const response = await fetch('/api/auctions/list');
                    if (response.ok) {
                        const data = await response.json();
                        auctions = data.auctions || [];
                        this._lastLoadTime = Date.now();
                        log.debug(`[AuctionSystem] ✅ Fetched from API (cached): ${auctions.length} auctions`);
                    } else {
                        throw new Error(`API returned ${response.status}`);
                    }
                } catch (apiError) {
                    // API 실패 시 기존 방식으로 폴백
                    log.warn(`[AuctionSystem] API failed, using direct Firestore: ${apiError.message}`);
                    auctions = await firebaseService.queryCollection('auctions', [
                        { field: 'status', op: '==', value: AUCTION_STATUS.ACTIVE }
                    ]);
                    this._lastLoadTime = Date.now();
                }
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
                
                // 올바른 시작가 계산 (실제 가격 + 1pt)
                let correctStartingBid = realPrice 
                    ? realPrice + 1 // 즉시 구매가 + 1pt
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
        
        // 사용자가 지정한 경매 종료 시간이 있으면 우선 사용
        if (options.endTime) {
            auctionEndTime = Timestamp.fromDate(new Date(options.endTime));
        } else if (protectionRemaining && protectionRemaining.totalMs > 0) {
            // 보호 기간 중인 영토: 보호 기간 종료 시점에 경매 종료
            const endDate = new Date(Date.now() + protectionRemaining.totalMs);
            auctionEndTime = Timestamp.fromDate(endDate);
        } else if (territory.sovereignty === SOVEREIGNTY.RULED || 
                   territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            // 이미 소유된 영토: 7일 경매 (보호 기간이 만료되었거나 없으면 7일 경매)
            const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            auctionEndTime = Timestamp.fromDate(endDate);
        } else {
            // 미점유 영토: 24시간 경매
            const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
            auctionEndTime = Timestamp.fromDate(endDate);
        }
        
        // 시작 입찰가 결정 (영토 실제 가격 계산)
        const countryCode = territory.country || 
                          territory.properties?.country || 
                          territory.properties?.adm0_a3?.toLowerCase() || 
                          'unknown';
        const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        
        // 경매 시작가는 즉시 구매가 + 1pt로 설정 (즉시 구매보다 높게 시작)
        // 사용자가 직접 지정한 경우는 그대로 사용, 아니면 즉시 구매가 + 1pt
        const calculatedStartingBid = realPrice 
            ? realPrice + 1 // 즉시 구매가 + 1pt
            : (territory.tribute || CONFIG.TERRITORY.DEFAULT_TRIBUTE) + 1;
        
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
        
        // 보호 기간 옵션 처리 (소유권 획득 경매용)
        const protectionDays = options.protectionDays !== undefined ? options.protectionDays : null;
        
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
            
            // 보호 기간 옵션 (소유권 획득 경매용)
            protectionDays: protectionDays, // 7, 30, 365, 또는 null (lifetime)
            
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
        
        // 경매 종료까지 남은 일수 계산 (디버깅용)
        let daysRemaining = 0;
        try {
            const endDate = auctionEndTime && typeof auctionEndTime.toDate === 'function' 
                ? auctionEndTime.toDate() 
                : (auctionEndTime instanceof Date ? auctionEndTime : new Date(auctionEndTime));
            if (endDate && !isNaN(endDate.getTime())) {
                daysRemaining = Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
            }
        } catch (e) {
            log.warn('[AuctionSystem] Failed to calculate days remaining:', e);
        }
        log.info(`Auction created for territory ${territoryId}, ends in ${daysRemaining} days`);
        return auction;
    }
    
    /**
     * 보호 기간 연장 경매 생성 (이미 소유한 지역)
     * @param {string} territoryId - 영토 ID
     * @param {number} protectionDays - 연장할 보호 기간 (7, 30, 365, 또는 null for lifetime)
     * @param {object} options - 추가 옵션
     */
    async createProtectionExtensionAuction(territoryId, protectionDays, options = {}) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        if (!territoryId || typeof territoryId !== 'string' || territoryId.trim() === '') {
            throw new Error('Territory ID is required');
        }
        
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            throw new Error('Territory not found');
        }
        
        // 소유자 확인
        if (!territory.ruler || territory.ruler !== user.uid) {
            throw new Error('Only territory owner can create protection extension auction');
        }
        
        // 보호 기간 옵션 검증
        const validPeriods = [7, 30, 365, null]; // null = lifetime
        if (!validPeriods.includes(protectionDays)) {
            throw new Error(`Invalid protection period. Must be 7, 30, 365, or null (lifetime)`);
        }
        
        // Territory ID 형식 정규화
        let finalTerritoryId = territoryId;
        const newTerritoryId = territory.properties?.territoryId || territory.territoryId;
        if (newTerritoryId && newTerritoryId.includes('::')) {
            finalTerritoryId = newTerritoryId;
        }
        
        // 기본 가격 계산
        const countryCode = territory.country || 
                          territory.properties?.country || 
                          'unknown';
        const realPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        
        // 보호 기간별 가격 배수 (아이디어 1: 가격 차등화)
        const priceMultipliers = {
            7: 1.0,      // 1주일: 100pt (일당 14.3pt)
            30: 4.0,     // 1개월: 400pt (일당 13.3pt)
            365: 50.0,   // 1년: 5,000pt (일당 13.7pt)
            null: 500.0  // 평생: 50,000pt
        };
        
        const multiplier = priceMultipliers[protectionDays];
        const startingBid = Math.ceil(realPrice * multiplier);
        
        // 경매 ID 생성 (보호 기간 정보 포함)
        const periodSuffix = protectionDays === null ? 'lifetime' : `${protectionDays}days`;
        const auctionId = `protection_${finalTerritoryId.replace(/::/g, '_')}_${periodSuffix}_${Date.now()}`;
        
        // 이미 같은 보호 기간 경매가 있는지 확인
        try {
            const existingAuctions = await firebaseService.queryCollection('auctions', [
                { field: 'territoryId', op: '==', value: territoryId },
                { field: 'status', op: '==', value: AUCTION_STATUS.ACTIVE },
                { field: 'type', op: '==', value: AUCTION_TYPE.PROTECTION_EXTENSION },
                { field: 'protectionDays', op: '==', value: protectionDays }
            ]);
            
            if (existingAuctions && existingAuctions.length > 0) {
                throw new Error(`Protection extension auction for ${protectionDays === null ? 'lifetime' : protectionDays + ' days'} already exists`);
            }
        } catch (error) {
            if (error.message && error.message.includes('already exists')) {
                throw error;
            }
            log.debug(`[AuctionSystem] Could not check for existing protection auctions:`, error.message);
        }
        
        const Timestamp = firebaseService.getTimestamp();
        const now = new Date();
        const auctionEndTime = new Date(now.getTime() + (24 * 60 * 60 * 1000)); // 24시간 경매
        
        // 영토 이름 추출
        const territoryName = territory.properties?.name || 
                            territory.properties?.name_en ||
                            territory.name ||
                            territoryId;
        
        // 경매 객체 생성
        const auction = {
            id: auctionId,
            territoryId: finalTerritoryId,
            territoryName: String(territoryName).trim(),
            country: countryCode,
            countryIso: territory.properties?.adm0_a3 || null,
            
            type: AUCTION_TYPE.PROTECTION_EXTENSION,
            status: AUCTION_STATUS.ACTIVE,
            protectionDays: protectionDays, // 연장할 보호 기간
            
            startingBid: startingBid,
            currentBid: startingBid,
            minIncrement: 1,
            
            highestBidder: null,
            highestBidderName: null,
            bids: [],
            
            startTime: Timestamp ? Timestamp.now() : now,
            endTime: Timestamp ? Timestamp.fromDate(auctionEndTime) : auctionEndTime,
            
            currentOwnerId: territory.ruler,
            currentOwnerName: territory.rulerName || null,
            
            createdBy: user.uid,
            createdAt: Timestamp ? Timestamp.now() : now
        };
        
        // Firestore 저장
        try {
            await firebaseService.setDocument('auctions', auctionId, auction);
            log.info(`[AuctionSystem] Protection extension auction created: ${auctionId} for ${protectionDays === null ? 'lifetime' : protectionDays + ' days'}`);
        } catch (error) {
            log.error(`[AuctionSystem] Failed to create protection extension auction:`, error);
            throw error;
        }
        
        // 로컬 캐시 업데이트
        this.activeAuctions.set(auctionId, auction);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_START, { auction });
        
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
            const correctStartingBid = realPrice 
                ? realPrice + 1 // 즉시 구매가 + 1pt
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
        
        // ✅ 관리자 모드 확인
        const isAdmin = data.isAdmin || 
                       (userId && userId.startsWith('admin_')) ||
                       (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
        
        // 옥션에 관리자 플래그 저장
        auction.purchasedByAdmin = isAdmin;
        
        // ⚠️ CRITICAL: Transaction을 사용하여 동시 입찰 보호
        try {
            await firebaseService.runTransaction(async (transaction) => {
                // Transaction 내에서 최신 경매 상태 확인
                const currentAuction = await transaction.get('auctions', auctionId);
                
                if (!currentAuction) {
                    throw new Error(`Auction ${auctionId} not found`);
                }
                
                if (currentAuction.status !== AUCTION_STATUS.ACTIVE) {
                    throw new Error(`Auction ${auctionId} is not active (status: ${currentAuction.status})`);
                }
                
                // 동시 입찰 검증: currentBid가 변경되었는지 확인
                const currentBidInDb = currentAuction.currentBid || currentAuction.startingBid || 0;
                const minBidRequired = currentBidInDb + 1;
                
                if (bidAmount < minBidRequired) {
                    throw new Error(`Minimum bid is ${minBidRequired} pt (current bid: ${currentBidInDb} pt)`);
                }
                
                // 최고 입찰자가 이미 변경되었는지 확인
                if (currentAuction.highestBidder && currentAuction.highestBidder !== userId) {
                    const currentHighestBid = currentAuction.currentBid || currentAuction.startingBid || 0;
                    if (bidAmount <= currentHighestBid) {
                        throw new Error(`Bid amount must be higher than current highest bid (${currentHighestBid} pt)`);
                    }
                }
                
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
                
                // Transaction 내에서 업데이트
                transaction.update('auctions', auctionId, {
                    currentBid: auction.currentBid,
                    startingBid: auction.startingBid,
                    highestBidder: auction.highestBidder,
                    highestBidderName: auction.highestBidderName,
                    purchasedByAdmin: isAdmin,
                    bids: bidsForFirestore,
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                });
                
                log.info(`[AuctionSystem] 🔒 Transaction: Bid saved to Firestore: ${bidAmount} pt by ${userName} (${auction.bids.length} total bids)${isAdmin ? ' [Admin]' : ''}`);
            });
            
            // Transaction 성공 후 로컬 캐시 업데이트
            this.activeAuctions.set(auctionId, auction);
            
        } catch (error) {
            log.error(`[AuctionSystem] Failed to save bid to Firestore:`, error);
            
            // Firebase 할당량 초과 에러인 경우 특별 처리
            if (error.code === 'resource-exhausted' || error.code === 'quota-exceeded' || 
                error.message?.includes('Quota exceeded') || error.message?.includes('resource-exhausted')) {
                log.warn(`[AuctionSystem] ⚠️ Firestore quota exceeded. Transaction will not be retried automatically.`);
                // 할당량 초과 시에는 로컬 캐시 롤백도 시도하지 않음 (추가 요청 방지)
                // 에러를 그대로 상위로 전달하여 UI에서 처리하도록 함
                throw error;
            }
            
            // Transaction 실패 시 로컬 변경사항 롤백
            // Firestore에서 최신 경매 데이터 다시 로드
            try {
                const latestAuction = await firebaseService.getDocument('auctions', auctionId);
                if (latestAuction) {
                    this.activeAuctions.set(auctionId, latestAuction);
                    log.info(`[AuctionSystem] Rolled back local cache, reloaded from Firestore`);
                }
            } catch (reloadError) {
                // 할당량 초과 에러인 경우 재로드도 시도하지 않음
                if (reloadError.code !== 'resource-exhausted' && reloadError.code !== 'quota-exceeded') {
                    log.error(`[AuctionSystem] Failed to reload auction after transaction failure:`, reloadError);
                }
            }
            
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
        
        // ⚠️ CRITICAL: Transaction을 사용하여 경매 종료 및 소유권 이전 보호
        const Timestamp = firebaseService.getTimestamp();
        const isAdmin = auction.purchasedByAdmin || 
                       (auction.highestBidder && auction.highestBidder.startsWith('admin_')) ||
                       (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
        
        try {
            await firebaseService.runTransaction(async (transaction) => {
                // Transaction 내에서 최신 경매 상태 확인
                const currentAuction = await transaction.get('auctions', auctionId);
                
                if (!currentAuction) {
                    throw new Error(`Auction ${auctionId} not found`);
                }
                
                // 이미 종료된 경매인지 확인
                if (currentAuction.status === AUCTION_STATUS.ENDED) {
                    log.warn(`[AuctionSystem] Auction ${auctionId} is already ended`);
                    return; // 이미 종료되었으면 중복 처리 방지
                }
                
                // 경매 상태를 ENDED로 업데이트
                transaction.update('auctions', auctionId, {
                    status: AUCTION_STATUS.ENDED,
                    endedAt: Timestamp ? Timestamp.now() : new Date(),
                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                });
                
                // 보호 기간 연장 경매인지 확인
                if (currentAuction.type === AUCTION_TYPE.PROTECTION_EXTENSION) {
                    // 보호 기간 연장 경매: 소유권 이전이 아니라 보호 기간만 연장
                    if (currentAuction.highestBidder) {
                        const territoryDoc = await transaction.get('territories', auction.territoryId);
                        
                        if (territoryDoc) {
                            // 현재 소유자가 경매 생성자인지 확인 (소유권 변경 방지)
                            if (territoryDoc.ruler !== currentAuction.currentOwnerId) {
                                log.warn(`[AuctionSystem] ⚠️ Territory ${auction.territoryId} ownership changed, skipping protection extension`);
                            } else {
                                // 보호 기간 계산
                                const now = new Date();
                                let protectionEndsAt;
                                
                                if (currentAuction.protectionDays === null) {
                                    // 평생 보호: 100년 후
                                    protectionEndsAt = new Date(now.getTime() + (100 * 365 * 24 * 60 * 60 * 1000));
                                } else {
                                    // 현재 보호 종료일에서 연장
                                    const currentProtectionEnd = territoryDoc.protectionEndsAt 
                                        ? (territoryDoc.protectionEndsAt instanceof Date 
                                            ? territoryDoc.protectionEndsAt 
                                            : territoryDoc.protectionEndsAt.toDate 
                                                ? territoryDoc.protectionEndsAt.toDate() 
                                                : new Date(territoryDoc.protectionEndsAt))
                                        : now;
                                    
                                    // 현재 종료일이 지났으면 지금부터 시작, 아니면 현재 종료일부터 연장
                                    const baseDate = currentProtectionEnd > now ? currentProtectionEnd : now;
                                    protectionEndsAt = new Date(baseDate.getTime() + (currentAuction.protectionDays * 24 * 60 * 60 * 1000));
                                }
                                
                                // 보호 기간 업데이트
                                transaction.update('territories', auction.territoryId, {
                                    protectionEndsAt: Timestamp ? Timestamp.fromDate(protectionEndsAt) : protectionEndsAt,
                                    protectionDays: currentAuction.protectionDays, // 업데이트된 보호 기간 저장
                                    sovereignty: SOVEREIGNTY.PROTECTED,
                                    currentAuction: null,
                                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                                });
                                
                                log.info(`[AuctionSystem] 🔒 Transaction: Territory ${auction.territoryId} protection extended by ${currentAuction.protectionDays === null ? 'lifetime' : currentAuction.protectionDays + ' days'}`);
                            }
                        }
                    }
                } else {
                    // 경매: 낙찰자가 있으면 영토 소유권 이전
                    if (currentAuction.highestBidder) {
                        // 영토 문서 가져오기
                        const territoryDoc = await transaction.get('territories', auction.territoryId);
                        
                        if (territoryDoc) {
                            // 소유권 이전 검증: 이미 다른 사용자가 소유하고 있지 않은지 확인
                            if (territoryDoc.ruler && territoryDoc.ruler !== currentAuction.highestBidder) {
                                log.warn(`[AuctionSystem] ⚠️ Territory ${auction.territoryId} ownership changed during auction end. Current ruler: ${territoryDoc.ruler}, Expected: ${currentAuction.highestBidder}`);
                                // 소유권이 변경되었으면 경매만 종료하고 소유권 이전은 건너뛰기
                            } else {
                                // 보호 기간 계산 (경매에 protectionDays가 있으면 사용, 없으면 기본 7일)
                                const now = new Date();
                                let protectionEndsAt;
                                let finalProtectionDays = currentAuction.protectionDays !== undefined 
                                    ? currentAuction.protectionDays 
                                    : 7; // 기본값: 7일
                                
                                if (finalProtectionDays === null) {
                                    // 평생 보호: 100년 후
                                    protectionEndsAt = new Date(now.getTime() + (100 * 365 * 24 * 60 * 60 * 1000));
                                } else {
                                    // 지정된 기간만큼 보호
                                    protectionEndsAt = new Date(now.getTime() + (finalProtectionDays * 24 * 60 * 60 * 1000));
                                }
                                
                                // 소유권 이전 및 보호 기간 설정
                                transaction.update('territories', auction.territoryId, {
                                    ruler: currentAuction.highestBidder,
                                    rulerName: currentAuction.highestBidderName,
                                    sovereignty: SOVEREIGNTY.PROTECTED, // 구매 직후 보호 상태
                                    protectionEndsAt: Timestamp ? Timestamp.fromDate(protectionEndsAt) : protectionEndsAt,
                                    protectionDays: finalProtectionDays,
                                    currentAuction: null,
                                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                                });
                                
                                log.info(`[AuctionSystem] 🔒 Transaction: Territory ${auction.territoryId} ownership transferred to ${currentAuction.highestBidderName} with ${finalProtectionDays === null ? 'lifetime' : finalProtectionDays + ' days'} protection`);
                            }
                        } else {
                            log.warn(`[AuctionSystem] ⚠️ Territory ${auction.territoryId} not found in Firestore during auction end`);
                        }
                    } else {
                        // 낙찰자 없으면 영토 상태 복구
                        const territoryDoc = await transaction.get('territories', auction.territoryId);
                        
                        if (territoryDoc) {
                            // 원래 소유자가 있었으면 그 상태로 복구, 없으면 UNCONQUERED로 복구
                            if (auction.currentOwnerId) {
                                transaction.update('territories', auction.territoryId, {
                                    sovereignty: SOVEREIGNTY.RULED,
                                    ruler: auction.currentOwnerId,
                                    rulerName: auction.currentOwnerName,
                                    currentAuction: null,
                                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                                });
                            } else {
                                transaction.update('territories', auction.territoryId, {
                                    sovereignty: SOVEREIGNTY.UNCONQUERED,
                                    ruler: null,
                                    rulerName: null,
                                    currentAuction: null,
                                    updatedAt: Timestamp ? Timestamp.now() : new Date()
                                });
                            }
                        }
                    }
                }
            });
            
            log.info(`[AuctionSystem] ✅✅✅ [Transaction 성공] Auction ${auctionId} ended successfully`);
            
            // Transaction 성공 후 로컬 상태 업데이트
            auction.status = AUCTION_STATUS.ENDED;
            
            // 낙찰자가 있으면 영토 정복 이벤트 발행
            if (auction.highestBidder) {
                log.info(`[AuctionSystem] Auction ${auctionId} ended. Winner: ${auction.highestBidderName} (${auction.highestBidder}), Bid: ${auction.currentBid} pt${isAdmin ? ' [Admin]' : ''}`);
                
                // TERRITORY_CONQUERED 이벤트 발행
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: auction.territoryId,
                    userId: auction.highestBidder,
                    userName: auction.highestBidderName,
                    tribute: auction.currentBid,
                    isAdmin: isAdmin
                });
                
                // 이벤트 발행 후 약간의 지연을 두어 처리 시간 확보
                await new Promise(resolve => setTimeout(resolve, 100));
            } else {
                // 낙찰자 없으면 영토 상태 복구 (로컬 캐시)
                const territory = territoryManager.getTerritory(auction.territoryId);
                if (territory) {
                    if (auction.currentOwnerId) {
                        territory.sovereignty = SOVEREIGNTY.RULED;
                        territory.ruler = auction.currentOwnerId;
                        territory.rulerName = auction.currentOwnerName;
                    } else {
                        territory.sovereignty = SOVEREIGNTY.UNCONQUERED;
                        territory.ruler = null;
                        territory.rulerName = null;
                    }
                    territory.currentAuction = null;
                }
            }
            
        } catch (transactionError) {
            log.error(`[AuctionSystem] ❌ Transaction failed for auction end:`, transactionError);
            
            // Transaction 실패 시 fallback: 기존 방식으로 업데이트 시도
            log.warn(`[AuctionSystem] ⚠️ Falling back to regular update after transaction failure`);
            
            auction.status = AUCTION_STATUS.ENDED;
            
            // Firestore 업데이트 (fallback)
            await firebaseService.updateDocument('auctions', auction.id, {
                status: AUCTION_STATUS.ENDED,
                endedAt: Timestamp ? Timestamp.now() : new Date(),
                updatedAt: Timestamp ? Timestamp.now() : new Date()
            });
            
            // 낙찰자가 있으면 영토 정복 이벤트 발행 (fallback)
            if (auction.highestBidder) {
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: auction.territoryId,
                    userId: auction.highestBidder,
                    userName: auction.highestBidderName,
                    tribute: auction.currentBid,
                    isAdmin: isAdmin
                });
            } else {
                // 낙찰자 없으면 영토 상태 복구 (fallback)
                const territory = territoryManager.getTerritory(auction.territoryId);
                if (territory) {
                    if (auction.currentOwnerId) {
                        territory.sovereignty = SOVEREIGNTY.RULED;
                        territory.ruler = auction.currentOwnerId;
                        territory.rulerName = auction.currentOwnerName;
                    } else {
                        territory.sovereignty = SOVEREIGNTY.UNCONQUERED;
                        territory.ruler = null;
                        territory.rulerName = null;
                    }
                    territory.currentAuction = null;
                    
                    await firebaseService.updateDocument('territories', auction.territoryId, {
                        sovereignty: territory.sovereignty,
                        ruler: territory.ruler || null,
                        rulerName: territory.rulerName || null,
                        currentAuction: null,
                        updatedAt: Timestamp ? Timestamp.now() : new Date()
                    });
                }
            }
            
            throw transactionError; // 상위로 에러 전달
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
    async instantConquest(territoryId, userId, userName, amount = null, protectionDays = null) {
        // ⚠️ 전문가 조언 반영: 정복 시작 지점 로그
        log.info(`[AuctionSystem] 🎯 [정복 시작] instantConquest called`);
        log.info(`[AuctionSystem] 📋 정복 데이터:`, {
            territoryId,
            userId,
            userName,
            amount,
            protectionDays,
            timestamp: new Date().toISOString()
        });
        
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            log.error(`[AuctionSystem] ❌ Territory ${territoryId} not found in TerritoryManager`);
            throw new Error('Territory not found');
        }
        
        log.info(`[AuctionSystem] 📋 Territory ${territoryId} current state: sovereignty=${territory.sovereignty}, ruler=${territory.ruler || 'null'}`);
        
        if (territory.sovereignty === SOVEREIGNTY.RULED) {
            log.warn(`[AuctionSystem] ⚠️ Territory ${territoryId} is already ruled by ${territory.ruler}`);
            throw new Error('Territory is already ruled');
        }
        
        if (territory.sovereignty === SOVEREIGNTY.CONTESTED) {
            log.warn(`[AuctionSystem] ⚠️ Territory ${territoryId} has auction in progress`);
            throw new Error('Auction in progress');
        }
        
        const finalPrice = amount || territory.tribute || territory.price || 100;
        
        // 정복 이벤트 발행
        log.info(`[AuctionSystem] 🎉 [정복 이벤트 발행] Emitting TERRITORY_CONQUERED event`);
        log.info(`[AuctionSystem] 🎉 이벤트 데이터:`, {
            territoryId,
            userId,
            userName,
            tribute: finalPrice,
            protectionDays
        });
        eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
            territoryId,
            userId,
            userName,
            tribute: finalPrice,
            protectionDays: protectionDays
        });
        
        log.info(`[AuctionSystem] ✅ instantConquest completed for territory: ${territoryId}`);
        return territory;
    }
    
    /**
     * 활성 옥션 가져오기
     */
    getActiveAuction(auctionId) {
        return this.activeAuctions.get(auctionId);
    }
    
    /**
     * 영토의 활성 옥션 가져오기 (legacy/new 형식 모두 지원)
     */
    getAuctionByTerritory(territoryId) {
        if (!territoryId) return null;
        
        // 정확한 ID 매칭 시도
        for (const [id, auction] of this.activeAuctions) {
            if (auction.status === AUCTION_STATUS.ACTIVE) {
                // 정확히 일치하면 반환
                if (auction.territoryId === territoryId) {
                    return auction;
                }
                
                // ID 형식 매칭 시도 (legacy/new 형식 모두 지원)
                if (matchTerritoryIds(auction.territoryId, territoryId)) {
                    return auction;
                }
            }
        }
        
        // 메모리 캐시에 없으면 Firestore에서 조회 시도
        // (비동기이므로 여기서는 null 반환, 호출자가 필요시 별도 조회)
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

