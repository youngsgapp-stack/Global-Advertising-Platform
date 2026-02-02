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
        this._lastLoadTime = null; // ⚡ 캐시: 마지막 로드 시간 (가이드 권장)
        this.CACHE_TTL = 5 * 60 * 1000; // ⚡ 5분 캐시 (가이드 권장)
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
        // 로그인하지 않은 경우 조용히 스킵 (공개 데이터가 아니므로)
        const currentUser = firebaseService.getCurrentUser();
        if (!currentUser) {
            log.debug('[AuctionSystem] User not authenticated, skipping auction load');
            this.activeAuctions.clear();
            return [];
        }
        
        // ⚡ 캐시 확인: 5분 이내면 캐시된 데이터 사용 (가이드 권장)
        const now = Date.now();
        if (this._lastLoadTime && (now - this._lastLoadTime) < this.CACHE_TTL) {
            log.debug(`[AuctionSystem] Using cached auctions (${Math.floor((now - this._lastLoadTime) / 1000)}s ago)`);
            return Array.from(this.activeAuctions.values());
        }
        
            try {
                // 새 백엔드 API에서 활성 경매 조회
                let auctions = [];
                try {
                    const { apiService } = await import('../services/ApiService.js');
                    const response = await apiService.get('/auctions?status=active');
                    auctions = response.auctions || [];
                    
                    // ⚡ 캐시 업데이트: 로드 시간 기록
                    this._lastLoadTime = now;
                } catch (error) {
                    // 인증 오류는 조용히 처리 (로그인 전에는 정상)
                    if (error.message === 'User not authenticated') {
                        log.debug('[AuctionSystem] User not authenticated, skipping auction load');
                        this.activeAuctions.clear();
                        return [];
                    }
                    log.error('Failed to load auctions from API:', error);
                    this.activeAuctions.clear();
                    return [];
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
                
                // ✅ 백엔드 API 업데이트 (로그인한 사용자만 가능)
                if (needsUpdate) {
                    // 로그인 상태 확인
                    if (firebaseService.isAuthenticated()) {
                        try {
                            const { apiService } = await import('../services/ApiService.js');
                            await apiService.updateAuction(auction.id, {
                                currentBid: auction.currentBid,
                                startingBid: auction.startingBid,
                                minBid: auction.startingBid
                            });
                            log.info(`[AuctionSystem] ✅ Successfully updated auction ${auction.id} via API: startingBid=${auction.startingBid}, currentBid=${auction.currentBid}`);
                        } catch (error) {
                            log.warn(`[AuctionSystem] Failed to update auction ${auction.id} via API (auth required):`, error.message);
                        }
                    } else {
                        log.debug(`[AuctionSystem] Skipping auction update for ${auction.id} (user not authenticated)`);
                    }
                }
                
                // ✅ 영토 상태 확인 및 수정 (백엔드 API 사용)
                // 경매가 있는데 영토 상태가 CONTESTED가 아니면 수정 (미점유 영토인 경우만)
                if (territory && !territory.ruler) {
                    if (territory.sovereignty !== SOVEREIGNTY.CONTESTED) {
                        // 미점유 영토에서 경매가 시작되었는데 상태가 CONTESTED가 아니면 수정
                        territory.sovereignty = SOVEREIGNTY.CONTESTED;
                        territory.currentAuction = auction.id;
                        
                        try {
                            const { apiService } = await import('../services/ApiService.js');
                            await apiService.updateTerritory(auction.territoryId, {
                                sovereignty: 'contested',
                                status: 'contested'
                            });
                            log.info(`[AuctionSystem] ✅ Updated territory ${auction.territoryId} status to contested via API`);
                        } catch (error) {
                            // 409 Conflict는 이미 소유된 영토이므로 정상적인 상황 (조용히 무시)
                            const errorMessage = error.message || error.error || '';
                            if (errorMessage.includes('already owned') || errorMessage.includes('Conflict')) {
                                log.debug(`[AuctionSystem] Territory ${auction.territoryId} already owned or in conflict, skipping status update`);
                            } else {
                                log.warn(`[AuctionSystem] Failed to update territory ${auction.territoryId} status via API:`, errorMessage);
                            }
                        }
                    }
                }
                
                // bids 배열이 없으면 초기화
                if (!auction.bids || !Array.isArray(auction.bids)) {
                    auction.bids = [];
                }
                
                // ⚠️ 재발 방지: normalize를 통한 일관된 형식 보장
                const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
                const normalizedAuction = normalizeAuctionDTO(auction);
                
                // activeAuctions에 저장
                this.activeAuctions.set(normalizedAuction.id, normalizedAuction);
                
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
        
        // ⚠️ 디버깅: territory 객체 구조 로깅 (API 응답 확인)
        log.info(`[AuctionSystem] 🔍 Territory data for ${territoryId}:`, {
            id: territory.id,
            country: territory.country,
            countryIso: territory.countryIso, // ⚠️ 중요: API 응답에서 직접 온 값
            country_iso: territory.country_iso, // DB 컬럼명 (혹시 있을 수 있음)
            properties: {
                adm0_a3: territory.properties?.adm0_a3,
                country: territory.properties?.country,
                country_code: territory.properties?.country_code,
                sov_a3: territory.properties?.sov_a3,
                admin: territory.properties?.admin,
                geonunit: territory.properties?.geonunit,
                territoryId: territory.properties?.territoryId
            },
            // 전체 territory 객체 확인 (API 응답 구조 확인용)
            fullTerritory: territory
        });
        
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
            // ⚠️ 중요: API 응답에서 직접 countryIso 사용 (백엔드에서 보장)
            countryIso = territory.countryIso || territory.country_iso;
            if (countryIso && countryIso.length === 3) {
                countryIso = countryIso.toUpperCase();
                log.info(`[AuctionSystem] ✅ Using countryIso from API response: ${countryIso}`);
            } else {
                log.warn(`[AuctionSystem] ⚠️ countryIso not found in territory object. territory.countryIso=${territory.countryIso}, territory.country_iso=${territory.country_iso}`);
                // Fallback: properties.adm0_a3 (이미 ISO 3자리 코드)
                countryIso = territory.properties?.adm0_a3;
                if (countryIso && countryIso.length === 3) {
                    countryIso = countryIso.toUpperCase();
                    log.info(`[AuctionSystem] ✅ Using countryIso from properties.adm0_a3: ${countryIso}`);
                } else {
                    // 우선순위 2: countryCode를 ISO로 변환 시도
                    const countryCode = territory.country || territory.properties?.country || 
                                       territory.properties?.country_code || 
                                       territory.properties?.sov_a3;
                    
                    if (countryCode) {
                        // TerritoryDataService의 convertToISOCode 사용 (더 정확한 변환)
                        const convertedIso = territoryDataService.convertToISOCode(countryCode);
                        if (convertedIso && convertedIso.length === 3) {
                            countryIso = convertedIso.toUpperCase();
                        } else {
                            // ISO to slug 매핑에서 역변환 시도 (fallback)
                            const isoToSlugMap = territoryManager.createIsoToSlugMap();
                            for (const [iso, slug] of Object.entries(isoToSlugMap)) {
                                if (slug === countryCode || slug === countryCode.toLowerCase()) {
                                    countryIso = iso;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // 우선순위 3: MapController에서 feature properties 확인 (GeoJSON 데이터에서)
                    if (!countryIso || countryIso.length !== 3) {
                        try {
                            const territoryFeature = mapController.getTerritoryFeature(territoryId);
                            if (territoryFeature && territoryFeature.feature && territoryFeature.feature.properties) {
                                const featureProps = territoryFeature.feature.properties;
                                if (featureProps.adm0_a3 && featureProps.adm0_a3.length === 3) {
                                    countryIso = featureProps.adm0_a3.toUpperCase();
                                    log.info(`[AuctionSystem] Found countryIso from MapController feature: ${countryIso}`);
                                } else if (featureProps.country) {
                                    const convertedIso = territoryDataService.convertToISOCode(featureProps.country);
                                    if (convertedIso && convertedIso.length === 3) {
                                        countryIso = convertedIso.toUpperCase();
                                        log.info(`[AuctionSystem] Converted countryIso from MapController feature.country: ${countryIso}`);
                                    }
                                }
                            }
                        } catch (error) {
                            log.debug(`[AuctionSystem] Could not get territory feature from MapController:`, error.message);
                        }
                    }
                    
                    // 우선순위 4: territoryId에서 국가 코드 추출 시도 (예: "algeria-0" -> "algeria")
                    if (!countryIso || countryIso.length !== 3) {
                        const territoryIdParts = finalTerritoryId?.split('-');
                        if (territoryIdParts && territoryIdParts.length > 0) {
                            const possibleCountrySlug = territoryIdParts[0];
                            const convertedIso = territoryDataService.convertToISOCode(possibleCountrySlug);
                            if (convertedIso && convertedIso.length === 3) {
                                countryIso = convertedIso.toUpperCase();
                                log.info(`[AuctionSystem] Converted countryIso from territoryId prefix: ${countryIso}`);
                            }
                        }
                    }
                    
                    // 우선순위 5: properties.admin 또는 properties.geonunit에서 국가명 추출 시도
                    if (!countryIso || countryIso.length !== 3) {
                        const countryName = territory.properties?.admin || territory.properties?.geonunit;
                        if (countryName) {
                            // 국가명을 정규화하여 슬러그로 변환 시도
                            const normalizedName = countryName.toLowerCase()
                                .replace(/^(s\.|s)\s*sudan$/i, 'south sudan')
                                .replace(/^(u\.s\.a\.?|united states)$/i, 'united states')
                                .replace(/\s+/g, '-');
                            
                            const convertedIso = territoryDataService.convertToISOCode(normalizedName);
                            if (convertedIso && convertedIso.length === 3) {
                                countryIso = convertedIso.toUpperCase();
                                log.info(`[AuctionSystem] Converted countryIso from country name: ${countryIso}`);
                            }
                        }
                    }
                    
                    // 우선순위 6: API에서 territory를 다시 로드하여 properties 확인
                    if (!countryIso || countryIso.length !== 3) {
                        try {
                            const { apiService } = await import('../services/ApiService.js');
                            // ⚠️ 중요: 캐시 우회하여 최신 데이터 가져오기 (countryIso 포함)
                            const apiTerritory = await apiService.getTerritory(territoryId, { skipCache: true });
                            if (apiTerritory) {
                                // ⚠️ 중요: API 응답에서 countryIso 직접 확인
                                if (apiTerritory.countryIso && apiTerritory.countryIso.length === 3) {
                                    countryIso = apiTerritory.countryIso.toUpperCase();
                                    log.info(`[AuctionSystem] ✅ Found countryIso from API response: ${countryIso}`);
                                } else {
                                    // Fallback: properties에서 추출
                                    log.info(`[AuctionSystem] 🔍 API territory data for ${territoryId}:`, {
                                        country: apiTerritory.country,
                                        countryIso: apiTerritory.countryIso,
                                        properties: apiTerritory.properties
                                    });
                                    
                                    // API 데이터에서 country 정보 추출 (모든 가능한 필드 확인)
                                    if (apiTerritory.properties?.adm0_a3 && apiTerritory.properties.adm0_a3.length === 3) {
                                        countryIso = apiTerritory.properties.adm0_a3.toUpperCase();
                                        log.info(`[AuctionSystem] Found countryIso from API territory properties.adm0_a3: ${countryIso}`);
                                    } else if (apiTerritory.properties?.country_code && apiTerritory.properties.country_code.length === 3) {
                                        countryIso = apiTerritory.properties.country_code.toUpperCase();
                                        log.info(`[AuctionSystem] Found countryIso from API territory properties.country_code: ${countryIso}`);
                                    } else if (apiTerritory.properties?.sov_a3 && apiTerritory.properties.sov_a3.length === 3) {
                                        countryIso = apiTerritory.properties.sov_a3.toUpperCase();
                                        log.info(`[AuctionSystem] Found countryIso from API territory properties.sov_a3: ${countryIso}`);
                                    } else if (apiTerritory.country) {
                                        const convertedIso = territoryDataService.convertToISOCode(apiTerritory.country);
                                        if (convertedIso && convertedIso.length === 3) {
                                            countryIso = convertedIso.toUpperCase();
                                            log.info(`[AuctionSystem] Converted countryIso from API territory.country: ${countryIso}`);
                                        }
                                    }
                                }
                                
                                // API에서 가져온 정보를 territory 객체에도 저장 (다음번을 위해)
                                if (countryIso && countryIso.length === 3) {
                                    if (!territory.properties) {
                                        territory.properties = {};
                                    }
                                    territory.properties.adm0_a3 = countryIso;
                                    territory.countryIso = countryIso; // ⚠️ 중요: countryIso도 직접 저장
                                    log.info(`[AuctionSystem] Saved countryIso (${countryIso}) to territory object for future use`);
                                }
                            }
                        } catch (error) {
                            log.debug(`[AuctionSystem] Could not load territory from API:`, error.message);
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
        
        // ⚠️ 중요: Protected 상태에서도 경매 시작 가능
        // 보호 기간은 소유권 보호용이며, 경매는 보호 기간 중에도 누구나 시작 가능
        // 소유자는 보호 기간 중에도 다른 사람이 경매를 시작할 수 있으므로, 입찰로 방어 가능
        
        // ⚠️ 중요: 영토 상태 확인 - ruled, protected, 또는 unconquered 상태에서 경매 시작 가능
        // contested 상태는 이미 경매가 진행 중이므로 불가
        if (territory.sovereignty === SOVEREIGNTY.CONTESTED) {
            throw new Error('Auction already in progress');
        }
        
        if (territory.sovereignty !== SOVEREIGNTY.RULED && 
            territory.sovereignty !== SOVEREIGNTY.PROTECTED && 
            territory.sovereignty !== SOVEREIGNTY.UNCONQUERED) {
            throw new Error(`Territory must be in ruled, protected, or unconquered status to start auction. Current status: ${territory.sovereignty}`);
        }
        
        // 이미 진행 중인 옥션 확인 (로컬 캐시)
        if (territory.currentAuction) {
            throw new Error('Auction already in progress');
        }
        
        // API에서도 활성 옥션 확인 (중복 생성 방지)
        try {
            const { apiService } = await import('../services/ApiService.js');
            const existingAuctions = await apiService.getActiveAuctions({ 
                territoryId: territoryId,
                status: AUCTION_STATUS.ACTIVE 
            });
            
            // API 응답이 배열이 아니면 배열로 변환
            const auctions = Array.isArray(existingAuctions) ? existingAuctions : (existingAuctions?.auctions || []);
            
            // territoryId 필터링 (API가 필터링하지 않는 경우)
            const filteredAuctions = auctions.filter(auction => 
                (auction.territory_id === territoryId || auction.territoryId === territoryId) &&
                auction.status === AUCTION_STATUS.ACTIVE
            );
            
            if (filteredAuctions && filteredAuctions.length > 0) {
                log.warn(`[AuctionSystem] ⚠️ Active auction already exists for ${territoryId} in API (${filteredAuctions.length} found), preventing duplicate creation`);
                throw new Error(`Auction already exists for this territory (${filteredAuctions.length} active auction(s) found)`);
            }
        } catch (error) {
            // 권한 오류나 다른 오류인 경우, 에러 메시지에 따라 처리
            if (error.message && error.message.includes('already exists')) {
                throw error; // 중복 옥션 에러는 그대로 전달
            }
            // 다른 오류는 로그만 남기고 계속 진행 (권한 문제일 수 있음)
            log.debug(`[AuctionSystem] Could not check for existing auctions (may require auth):`, error.message);
        }
        
        // 경매 종료 시간 결정 (ISO 문자열로 변환)
        let auctionEndTime;
        const protectionRemaining = territoryManager.getProtectionRemaining(territoryId);
        
        if (protectionRemaining && protectionRemaining.totalMs > 0) {
            // 보호 기간 중인 영토: 보호 기간 종료 시점에 경매 종료
            const endDate = new Date(Date.now() + protectionRemaining.totalMs);
            auctionEndTime = endDate.toISOString();
        } else if (territory.sovereignty === SOVEREIGNTY.RULED || 
                   territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            // 이미 소유된 영토: 7일 경매
            const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            auctionEndTime = endDate.toISOString();
        } else {
            // 미점유 영토: 24시간 경매
            const endDate = options.endTime ? new Date(options.endTime) : new Date(Date.now() + 24 * 60 * 60 * 1000);
            auctionEndTime = endDate.toISOString();
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
            
            // 문자열인 경우 JSON 형식인지 확인
            if (typeof name === 'string') {
                const trimmed = name.trim();
                if (trimmed === '') return null;
                
                // Check if it's a JSON format string (e.g. '{"ko":"Texas","en":"Texas"}')
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (typeof parsed === 'object' && parsed !== null) {
                            // 언어 우선순위: en > ko > local > 첫 번째 값
                            const nameStr = parsed.en || parsed.ko || parsed.local || Object.values(parsed)[0];
                            if (nameStr && typeof nameStr === 'string' && nameStr.trim() !== '') {
                                return nameStr.trim();
                            }
                        }
                    } catch (e) {
                        // JSON 파싱 실패 시 원본 문자열 반환
                        return trimmed;
                    }
                }
                return trimmed;
            }
            
            // 객체인 경우
            if (typeof name === 'object' && name !== null) {
                // 언어 우선순위: en > ko > local > 첫 번째 값
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
            
            startTime: new Date(),
            endTime: auctionEndTime,
            
            // 보호 기간 옵션 (소유권 획득 경매용)
            protectionDays: protectionDays, // 7, 30, 365, 또는 null (lifetime)
            
            // 보호 기간 중 경매 여부
            isProtectedAuction: !!(protectionRemaining && protectionRemaining.totalMs > 0),
            currentOwnerId: territory.ruler || null,
            currentOwnerName: currentOwnerName, // null이 아닌 문자열 또는 null
            
            createdBy: user.uid,
            createdAt: new Date()
        };
        
        // ✅ 백엔드 API 사용
        const { apiService } = await import('../services/ApiService.js');
        
        // API에 전송할 데이터 준비
        const auctionApiData = {
            territoryId: finalTerritoryId,
            startingBid: startingBid,
            minBid: minIncrement,
            endTime: auctionEndTime, // 이미 ISO 문자열
            protectionDays: protectionDays,
            type: options.type || 'standard'
        };
        
        log.debug(`[AuctionSystem] Creating auction via API for territory: "${finalTerritoryId}"`);
        
        try {
            const result = await apiService.createAuction(auctionApiData);
            
            // API 응답에서 경매 정보 추출
            const createdAuction = result.auction || result;
            
            // 로컬 auction 객체 업데이트 (API 응답과 병합)
            auction.id = createdAuction.id;
            auction.territoryId = createdAuction.territoryId || finalTerritoryId;
            auction.status = createdAuction.status || AUCTION_STATUS.ACTIVE;
            auction.startTime = createdAuction.startTime || new Date();
            auction.endTime = createdAuction.endTime || auctionEndTime;
            auction.startingBid = createdAuction.startingBid || startingBid;
            auction.currentBid = createdAuction.currentBid || startingBid;
            
            // ⚠️ 재발 방지: normalize를 통한 일관된 형식 보장
            const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
            const normalizedAuction = normalizeAuctionDTO(auction);
            
            // 로컬 캐시 업데이트
            this.activeAuctions.set(normalizedAuction.id, normalizedAuction);
            
            // 영토 상태 업데이트 (로컬 캐시)
            if (!protectionRemaining && territory.sovereignty === SOVEREIGNTY.UNCONQUERED) {
                territory.sovereignty = SOVEREIGNTY.CONTESTED;
            }
            territory.currentAuction = auction.id;
            
            // 이벤트 발행
            eventBus.emit(EVENTS.AUCTION_START, { auction });
            
            const endDate = new Date(auction.endTime);
            const daysRemaining = Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
            log.info(`[AuctionSystem] ✅ Auction created via API for territory ${territoryId}, ends in ${daysRemaining} days`);
            
            return auction;
        } catch (error) {
            log.error(`[AuctionSystem] ❌ Failed to create auction via API:`, error);
            throw new Error(`Failed to create auction: ${error.message || error.error || 'Unknown error'}`);
        }
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
        
        // 이미 같은 보호 기간 경매가 있는지 확인 (API 사용)
        try {
            const { apiService } = await import('../services/ApiService.js');
            const existingAuctions = await apiService.getActiveAuctions({ 
                territoryId: territoryId,
                status: AUCTION_STATUS.ACTIVE 
            });
            
            // API 응답이 배열이 아니면 배열로 변환
            const auctions = Array.isArray(existingAuctions) ? existingAuctions : (existingAuctions?.auctions || []);
            
            // territoryId, type, protectionDays 필터링
            const filteredAuctions = auctions.filter(auction => 
                (auction.territory_id === territoryId || auction.territoryId === territoryId) &&
                auction.status === AUCTION_STATUS.ACTIVE &&
                (auction.type === AUCTION_TYPE.PROTECTION_EXTENSION || auction.auction_type === AUCTION_TYPE.PROTECTION_EXTENSION) &&
                (auction.protectionDays === protectionDays || auction.protection_days === protectionDays)
            );
            
            if (filteredAuctions && filteredAuctions.length > 0) {
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
        
        // ✅ 백엔드 API 사용
        try {
            const { apiService } = await import('../services/ApiService.js');
            const auctionApiData = {
                territoryId: finalTerritoryId,
                startingBid: startingBid,
                minBid: minIncrement,
                endTime: auctionEndTime,
                protectionDays: protectionDays,
                type: 'protection_extension'
            };
            
            const result = await apiService.createAuction(auctionApiData);
            const createdAuction = result.auction || result;
            
            // 로컬 auction 객체 업데이트
            auction.id = createdAuction.id;
            auction.territoryId = createdAuction.territoryId || finalTerritoryId;
            auction.status = createdAuction.status || AUCTION_STATUS.ACTIVE;
            
            log.info(`[AuctionSystem] ✅ Protection extension auction created via API: ${auction.id} for ${protectionDays === null ? 'lifetime' : protectionDays + ' days'}`);
        } catch (error) {
            log.error(`[AuctionSystem] Failed to create protection extension auction via API:`, error);
            throw error;
        }
        
        // ⚠️ 재발 방지: normalize를 통한 일관된 형식 보장
        const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
        const normalizedAuction = normalizeAuctionDTO(auction);
        
        // 로컬 캐시 업데이트
        this.activeAuctions.set(normalizedAuction.id, normalizedAuction);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_START, { auction });
        
        return auction;
    }
    
    /**
     * 입찰 처리
     */
    /**
     * 입찰 처리
     * ⚠️ 전문가 조언 반영: 복잡한 계산 로직 제거, API 호출만 수행
     * - 최소 입찰가 계산은 서버가 권위 (minNextBid)
     * - 프론트는 API 호출 후 서버 응답으로만 캐시 업데이트
     */
    async handleBid(data) {
        const { auctionId, bidAmount, userId, userName } = data;
        
        // ⚠️ 디버깅: 받은 bidAmount 확인 (변형 없이 그대로 전달해야 함)
        console.log('[AuctionSystem.handleBid] Received', {
            auctionId,
            bidAmount,
            bidAmountType: typeof bidAmount,
            dataKeys: Object.keys(data)
        });
        
        const auction = this.activeAuctions.get(auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        
        if (auction.status !== AUCTION_STATUS.ACTIVE) {
            throw new Error('Auction is not active');
        }
        
        // ⚠️ 전문가 조언 반영: API를 사용하여 입찰 처리 (서버가 검증)
        // ⚠️ 중요: bidAmount를 절대 변형하지 않고 그대로 전달
        const { apiService } = await import('../services/ApiService.js');
        
        try {
            // ⚠️ 디버깅: placeBid 호출 직전 확인
            console.log('[AuctionSystem.handleBid] Calling placeBid', {
                auctionId,
                bidAmount,
                willSend: bidAmount // 실제 전송될 값
            });
            
            const bidResult = await apiService.placeBid(auctionId, bidAmount);
            
            log.info(`[AuctionSystem] ✅ Bid saved via API: ${bidAmount} pt by ${userName}`);
            
            // API 응답으로 경매 상태 업데이트
            if (bidResult && bidResult.auction) {
                const updatedAuction = bidResult.auction;
                // ⚠️ 중요: 기존 auction 객체와 병합하여 필드 누락 방지 (특히 territoryId)
                this.activeAuctions.set(auctionId, {
                    ...auction,
                    currentBid: updatedAuction.currentBid,
                    highestBidder: updatedAuction.currentBidderId ? String(updatedAuction.currentBidderId) : auction.highestBidder,
                    highestBidderName: auction.highestBidderName, // 기존 값 유지
                    minNextBid: updatedAuction.minNextBid, // 서버가 계산한 최소 입찰가
                    increment: updatedAuction.increment, // 서버가 정의한 증가액
                    updatedAt: updatedAuction.updatedAt || new Date().toISOString(),
                    // ⚠️ 전문가 조언 반영: 서버에서 계산한 예상 보호기간 정보 포함
                    expectedProtectionDays: bidResult.expectedProtectionDays || updatedAuction.expectedProtectionDays,
                    expectedProtectionEndsAt: bidResult.expectedProtectionEndsAt || updatedAuction.expectedProtectionEndsAt,
                    // ⚠️ 중요: territoryId 보장 (getAuctionByTerritory가 작동하도록)
                    territoryId: updatedAuction.territoryId || auction.territoryId,
                    status: updatedAuction.status || auction.status, // status 보장
                    id: auctionId // ID 명시적으로 보장
                });
                
                log.debug(`[AuctionSystem] Updated local cache from bidResult:`, {
                    auctionId,
                    territoryId: updatedAuction.territoryId || auction.territoryId,
                    status: updatedAuction.status || auction.status,
                    currentBid: updatedAuction.currentBid,
                    minNextBid: updatedAuction.minNextBid
                });
                
                log.debug(`[AuctionSystem] Updated local cache from API response:`, {
                    auctionId,
                    currentBid: updatedAuction.currentBid,
                    minNextBid: updatedAuction.minNextBid
                });
            } else {
                // API 응답이 없으면 서버에서 다시 조회
                const latestAuction = await apiService.getAuction(auctionId);
                if (latestAuction) {
                    // ⚠️ 중요: 기존 auction 객체와 병합하여 필드 누락 방지
                    this.activeAuctions.set(auctionId, {
                        ...auction,
                        ...latestAuction,
                        id: auctionId, // ID 명시적으로 보장
                        territoryId: latestAuction.territoryId || auction.territoryId, // territoryId 보장
                        // ⚠️ 전문가 조언 반영: 서버에서 계산한 예상 보호기간 정보 포함
                        expectedProtectionDays: latestAuction.expectedProtectionDays,
                        expectedProtectionEndsAt: latestAuction.expectedProtectionEndsAt
                    });
                    log.debug(`[AuctionSystem] Updated local cache from getAuction API:`, {
                        auctionId,
                        territoryId: latestAuction.territoryId || auction.territoryId,
                        status: latestAuction.status
                    });
                }
            }
            
        } catch (error) {
            log.error(`[AuctionSystem] Failed to save bid via API:`, error);
            
            // 실패 시 서버에서 최신 상태 조회하여 롤백
            try {
                const latestAuction = await apiService.getAuction(auctionId);
                if (latestAuction) {
                    // ⚠️ 재발 방지: normalize를 통한 일관된 형식 보장
                    const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
                    const normalizedAuction = normalizeAuctionDTO(latestAuction);
                    // 기존 auction 객체와 병합하여 필드 누락 방지
                    this.activeAuctions.set(auctionId, {
                        ...auction,
                        ...normalizedAuction,
                        id: auctionId, // ID 명시적으로 보장
                        territoryId: normalizedAuction.territoryId || auction.territoryId // territoryId 보장
                    });
                    log.info(`[AuctionSystem] Rolled back local cache, reloaded from API (normalized)`);
                }
            } catch (rollbackError) {
                log.error(`[AuctionSystem] Failed to rollback local cache after bid failure:`, rollbackError);
            }
            throw error;
        }
        
        // ⚠️ 이벤트 발행: AUCTION_BID_PLACED는 트리거만 (auctionId/territoryId만 전달)
        // 실제 auction 객체는 AUCTION_UPDATE에서 전달
        eventBus.emit(EVENTS.AUCTION_BID_PLACED, {
            auctionId,
            territoryId: auction.territoryId, // ⚠️ 이벤트 스코프 매칭을 위해 territoryId 포함
            bidAmount,
            userId,
            userName
        });
    }
    
    /**
     * 옥션 종료
     * ⚠️ 전문가 조언 반영: Firestore runTransaction 대신 API 사용
     */
    async endAuction(auctionId) {
        // activeAuctions Map에서 먼저 확인
        let auction = this.activeAuctions.get(auctionId);
        
        // Map에 없으면 API에서 가져오기
        if (!auction) {
            log.warn(`[AuctionSystem] Auction ${auctionId} not in activeAuctions, loading from API...`);
            try {
                const { apiService } = await import('../services/ApiService.js');
                const auctionData = await apiService.getAuction(auctionId);
                if (auctionData) {
                    auction = auctionData;
                    auction.id = auctionId;
                    log.info(`[AuctionSystem] Loaded auction ${auctionId} from API`);
                } else {
                    throw new Error(`Auction ${auctionId} not found`);
                }
            } catch (error) {
                log.error(`[AuctionSystem] Failed to load auction ${auctionId} from API:`, error);
                throw new Error(`Auction not found: ${auctionId}`);
            }
        }
        
        // ⚠️ 전문가 조언 반영: API를 사용하여 경매 종료 처리
        const { apiService } = await import('../services/ApiService.js');
        
        try {
            const result = await apiService.endAuction(auctionId);
            
            log.info(`[AuctionSystem] ✅ Auction ${auctionId} ended successfully via API`);
            
            // API 응답으로 경매 상태 업데이트
            if (result && result.auction) {
                // ⚠️ 재발 방지: normalize를 통한 일관된 형식 보장
                const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
                const normalizedResult = normalizeAuctionDTO(result.auction);
                auction.status = normalizedResult.status || AUCTION_STATUS.ENDED;
                this.activeAuctions.set(auctionId, {
                    ...auction,
                    ...normalizedResult
                });
            } else {
                // 응답이 없으면 로컬 캐시만 업데이트
                auction.status = AUCTION_STATUS.ENDED;
                const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
                const normalizedAuction = normalizeAuctionDTO(auction);
                this.activeAuctions.set(auctionId, normalizedAuction);
            }
            
            // 낙찰자가 있으면 영토 정복 이벤트 발행
            if (result && result.auction && result.auction.winner) {
                const winner = result.auction.winner;
                log.info(`[AuctionSystem] Auction ${auctionId} ended. Winner: ${winner.userName} (${winner.userId}), Bid: ${winner.bid} pt`);
                
                // TERRITORY_CONQUERED 이벤트 발행
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: auction.territoryId,
                    userId: winner.userId,
                    userName: winner.userName,
                    tribute: winner.bid,
                    isAdmin: winner.userId?.startsWith('admin_') || false
                });
            } else if (auction.highestBidder) {
                // API 응답에 winner가 없지만 로컬 캐시에 highestBidder가 있는 경우
                log.info(`[AuctionSystem] Auction ${auctionId} ended. Winner: ${auction.highestBidderName} (${auction.highestBidder}), Bid: ${auction.currentBid} pt`);
                
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: auction.territoryId,
                    userId: auction.highestBidder,
                    userName: auction.highestBidderName,
                    tribute: auction.currentBid,
                    isAdmin: auction.purchasedByAdmin || false
                });
            } else {
                // 낙찰자 없으면 영토 상태 복구 이벤트
                log.info(`[AuctionSystem] Auction ${auctionId} ended with no winner`);
            }
            
        } catch (error) {
            log.error(`[AuctionSystem] Failed to end auction ${auctionId} via API:`, error);
            
            // 실패 시 서버에서 최신 상태 조회
            try {
                const { apiService } = await import('../services/ApiService.js');
                const { normalizeAuctionDTO } = await import('../utils/auction-normalizer.js');
                const latestAuction = await apiService.getAuction(auctionId);
                if (latestAuction) {
                    const normalizedAuction = normalizeAuctionDTO(latestAuction);
                    this.activeAuctions.set(auctionId, normalizedAuction);
                    log.info(`[AuctionSystem] Reloaded auction ${auctionId} from API after end failure (normalized)`);
                }
            } catch (reloadError) {
                log.error(`[AuctionSystem] Failed to reload auction ${auctionId} after end failure:`, reloadError);
            }
            
            throw error;
        }
        
        // 기존 Firestore 코드는 완전히 제거됨 (API 사용으로 대체)
        
        // 로컬 캐시 제거
        this.activeAuctions.delete(auctionId);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.AUCTION_END, { auction });
        
        log.info(`Auction ended: ${auctionId}`);
        return auction;
    }
    
    /**
     * 기존 Firestore 코드 제거됨
     * 모든 경매 종료 로직은 이제 백엔드 API (POST /api/auctions/:id/end)에서 처리
     */
    
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
                // ⚠️ 재발 방지: fallback 로직 - legacy 객체 보정
                const auctionTerritoryId = auction.territoryId || auction.territory_id;
                
                // 정확히 일치하면 반환
                if (auctionTerritoryId === territoryId) {
                    return auction;
                }
                
                // ID 형식 매칭 시도 (legacy/new 형식 모두 지원)
                if (matchTerritoryIds(auctionTerritoryId, territoryId)) {
                    return auction;
                }
            }
        }
        
        // 메모리 캐시에 없으면 API에서 조회 시도
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
            // TODO: API에 사용자 입찰 히스토리 엔드포인트가 있으면 사용
            // 현재는 활성 경매만 조회 (나중에 `/api/users/me/bids` 같은 엔드포인트 추가 가능)
            const { apiService } = await import('../services/ApiService.js');
            const auctions = await apiService.getActiveAuctions();
            // bids 배열에서 userId가 포함된 경매 필터링
            const userBids = auctions.filter(auction => 
                auction.bids && auction.bids.some(bid => bid.userId === userId || bid.user_id === userId)
            );
            return userBids;
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
     * ⚠️ 응급 조치: 폴링 비활성화 (Firestore 읽기 폭발 방지)
     * TODO: Cloud Functions Cron으로 이동 필요
     */
    startAuctionEndCheckInterval() {
        // ⚠️ 응급 조치: 폴링 비활성화
        log.warn('[AuctionSystem] ⚠️ Auction end check interval DISABLED to prevent Firestore read explosion');
        log.warn('[AuctionSystem] TODO: Move to Cloud Functions Cron job');
        return;
        
        // 아래 코드는 나중에 Cloud Functions로 이동 예정
        /*
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
        */
    }
}

// 싱글톤 인스턴스
export const auctionSystem = new AuctionSystem();
export default auctionSystem;

