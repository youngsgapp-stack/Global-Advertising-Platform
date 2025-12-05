/**
 * TerritoryPanel - 영토 정보 패널 UI
 * 영토 상세 정보, 역사, 버프, 액션 버튼 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { SOVEREIGNTY, territoryManager } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';
import { buffSystem } from '../features/BuffSystem.js';
import { auctionSystem, AUCTION_STATUS } from '../features/AuctionSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryDataService } from '../services/TerritoryDataService.js';
import { walletService } from '../services/WalletService.js';

class TerritoryPanel {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.lang = 'en';  // English default
        this.countryData = null;
    }
    
    /**
     * 관리자 모드 확인
     */
    isAdminMode() {
        const adminAuth = sessionStorage.getItem('adminAuth');
        const adminUserMode = sessionStorage.getItem('adminUserMode');
        return !!(adminAuth && adminUserMode === 'true');
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'territory-panel') {
        this.container = document.getElementById(containerId);
        
        if (!this.container) {
            // 컨테이너가 없으면 생성
            this.container = document.createElement('div');
            this.container.id = containerId;
            this.container.className = 'territory-panel hidden';
            document.body.appendChild(this.container);
        }
        
        // 이벤트 리스너 설정
        this.setupEventListeners();
        
        log.info('TerritoryPanel initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 패널 열기 이벤트
        eventBus.on(EVENTS.UI_PANEL_OPEN, (data) => {
            if (data.type === 'territory') {
                this.open(data.data);
            }
        });
        
        // 패널 닫기 이벤트
        eventBus.on(EVENTS.UI_PANEL_CLOSE, (data) => {
            if (data.type === 'territory') {
                this.close();
            }
        });
        
        // 영토 업데이트 이벤트
        eventBus.on(EVENTS.TERRITORY_UPDATE, (data) => {
            if (this.currentTerritory && this.currentTerritory.id === data.territory.id) {
                this.updateContent(data.territory);
            }
        });
    }
    
    /**
     * 패널 열기
     */
    open(territory) {
        this.currentTerritory = territory;
        this.isOpen = true;
        
        // HTML 렌더링
        this.render();
        
        // 패널 표시
        this.container.classList.remove('hidden');
        
        // 이벤트 바인딩
        this.bindActions();
    }
    
    /**
     * 패널 닫기
     */
    close() {
        this.isOpen = false;
        this.currentTerritory = null;
        this.container.classList.add('hidden');
    }
    
    /**
     * 콘텐츠 업데이트
     */
    updateContent(territory) {
        this.currentTerritory = territory;
        this.render();
        this.bindActions();
    }
    
    /**
     * 패널 렌더링
     */
    render() {
        const t = this.currentTerritory;
        if (!t) return;
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        const user = firebaseService.getCurrentUser();
        const isOwner = user && t.ruler === user.uid;
        // 로그인한 사용자만 경매 정보 표시
        const auction = user ? auctionSystem.getAuctionByTerritory(t.id) : null;
        const isAdmin = this.isAdminMode();
        
        // 보호 기간 확인
        const protectionRemaining = territoryManager.getProtectionRemaining(t.id);
        const isProtected = !!protectionRemaining;
        
        // 이름 추출 (객체일 수 있으므로 처리) - 먼저 정의 필요
        const territoryName = this.extractName(t.name) || 
                              this.extractName(t.properties?.name) || 
                              this.extractName(t.properties?.name_en) || 
                              'Unknown Territory';
        
        // 국가 코드 결정 (우선순위: territory.country > properties > fallback)
        // properties에서 사용 가능한 필드: adm0_a3 (USA), country (United States of America), countryCode (US1), sov_a3 (US1)
        let countryCode = t.country || 
                        t.properties?.country || 
                        t.properties?.country_code ||
                        t.properties?.adm0_a3?.toLowerCase() ||  // adm0_a3 우선 사용 (USA -> usa)
                        t.properties?.sov_a3?.toLowerCase() ||
                        'unknown';
        
        // 잘못된 값 필터링: "territories", "states", "regions" 등은 무시
        const invalidCodes = ['territories', 'states', 'regions', 'prefectures', 'provinces', 'unknown'];
        if (invalidCodes.includes(countryCode?.toLowerCase())) {
            countryCode = null;
        }
        
        // countryCode가 국가명인 경우 슬러그로 변환 시도 (예: "United States of America" -> "usa")
        if (countryCode && !CONFIG.COUNTRIES[countryCode]) {
            const normalized = countryCode.toLowerCase().replace(/\s+/g, '-');
            if (CONFIG.COUNTRIES[normalized]) {
                countryCode = normalized;
            } else {
                // 국가명으로 검색
                for (const [key, value] of Object.entries(CONFIG.COUNTRIES)) {
                    if (value.name === countryCode || value.nameKo === countryCode) {
                        countryCode = key;
                        break;
                    }
                }
            }
        }
        
        // countryCode가 없거나 유효하지 않은 경우, properties에서 다시 시도
        if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
            // properties에서 다른 필드 시도 (adm0_a3 우선)
            let altCode = t.properties?.adm0_a3 ||  // ISO 코드 (예: "USA")
                         t.properties?.country_code || 
                         t.properties?.sov_a3 ||
                         t.properties?.iso_a3;
            
            if (altCode) {
                altCode = altCode.toString().toLowerCase();
                
                // ISO 코드를 슬러그로 변환 시도 (예: "usa" -> "usa", "kor" -> "south-korea")
                // 대부분의 경우 소문자 변환으로 충분하지만, 일부는 매핑 필요
                const isoToSlug = {
                    'usa': 'usa', 'can': 'canada', 'mex': 'mexico', 'kor': 'south-korea',
                    'jpn': 'japan', 'chn': 'china', 'gbr': 'uk', 'deu': 'germany',
                    'fra': 'france', 'ita': 'italy', 'esp': 'spain', 'ind': 'india',
                    'bra': 'brazil', 'rus': 'russia', 'aus': 'australia'
                };
                
                const slugCode = isoToSlug[altCode] || altCode;
                
                if (!invalidCodes.includes(slugCode) && CONFIG.COUNTRIES[slugCode]) {
                    countryCode = slugCode;
                } else if (CONFIG.COUNTRIES[altCode]) {
                    countryCode = altCode;
                }
            }
            
            // 여전히 없으면 mapController의 currentCountry 사용 시도
            if (!countryCode || !CONFIG.COUNTRIES[countryCode]) {
                if (mapController && mapController.currentCountry && CONFIG.COUNTRIES[mapController.currentCountry]) {
                    countryCode = mapController.currentCountry;
                    log.debug(`[TerritoryPanel] Using mapController.currentCountry: ${countryCode} for territory: ${territoryName}`);
                } else {
                    // 여전히 없으면 'unknown'으로 설정하되, 로그 남김
                    countryCode = 'unknown';
                    log.warn(`[TerritoryPanel] Invalid country code: ${t.country}, territory: ${territoryName}, mapController.currentCountry: ${mapController?.currentCountry}, properties: ${JSON.stringify(t.properties)}`);
                }
            }
        }
        
        // Get real country data
        this.countryData = territoryDataService.getCountryStats(countryCode);
        const countryInfo = CONFIG.COUNTRIES[countryCode] || {};
        
        // 인구/면적 데이터 추출 (TerritoryDataService 사용)
        // countryCode 디버깅: 최종 결정된 countryCode 로그
        if (!countryInfo.name) {
            log.warn(`[TerritoryPanel] Country info not found for code: ${countryCode}, territory: ${territoryName}`);
        }
        
        const population = territoryDataService.extractPopulation(t, countryCode);
        const area = territoryDataService.extractArea(t, countryCode);
        
        // 디버깅: 인구/면적 데이터 확인
        if (territoryName.toLowerCase() === 'texas') {
            log.debug(`[TerritoryPanel] Texas - countryCode: ${countryCode}, isoCode: ${territoryDataService.convertToISOCode(countryCode)}, population: ${population}, area: ${area}`);
        }
        
        // 픽셀 수 계산 (면적 기반)
        const pixelCount = territoryDataService.calculatePixelCount(t, countryCode);
        
        // 가격 계산 (픽셀 수 기반)
        const realPrice = territoryDataService.calculateTerritoryPrice(t, countryCode);
        
        // 국가명: CONFIG에서 가져오거나, 없으면 countryCode를 그대로 사용 (절대 properties.admin 사용 안 함)
        const countryName = countryInfo.name || countryInfo.nameKo || countryCode || 'Unknown';
        const countryFlag = countryInfo.flag || '🏳️';
        
        // 소유권 상태 텍스트
        // 경매 중이면 "Bidding" 표시, 아니면 일반 상태 표시
        let sovereigntyText = vocab[t.sovereignty] || 'Available';
        if (t.sovereignty === 'protected' || isProtected) {
            sovereigntyText = '🛡️ Protected';
        } else if (auction && auction.status === AUCTION_STATUS.ACTIVE) {
            // 활성 경매가 있으면 "Bidding" 표시
            sovereigntyText = '⏳ Bidding';
        } else if (t.sovereignty === SOVEREIGNTY.CONTESTED && !auction) {
            // CONTESTED 상태인데 경매가 없으면 UNCONQUERED로 복구
            sovereigntyText = '✅ Available';
            // 비동기로 상태 복구
            setTimeout(async () => {
                try {
                    const Timestamp = firebaseService.getTimestamp();
                    await firebaseService.updateDocument('territories', t.id, {
                        sovereignty: SOVEREIGNTY.UNCONQUERED,
                        currentAuction: null,
                        updatedAt: Timestamp ? Timestamp.now() : new Date()
                    });
                    t.sovereignty = SOVEREIGNTY.UNCONQUERED;
                    t.currentAuction = null;
                    // 패널 다시 렌더링
                    this.render();
                    this.bindActions();
                } catch (error) {
                    log.error('Failed to fix territory state:', error);
                }
            }, 0);
        }
        
        this.container.innerHTML = `
            <div class="panel-header">
                <div class="territory-title">
                    <span class="territory-icon">${this.getTerritoryIcon(t.sovereignty)}</span>
                    <h2>${territoryName}</h2>
                </div>
                <button class="close-btn" id="close-territory-panel">&times;</button>
            </div>
            
            <div class="panel-content">
                <!-- Sovereignty Status -->
                <div class="sovereignty-section">
                    <div class="sovereignty-badge ${isProtected ? 'protected' : (t.sovereignty || 'unconquered')}">
                        <span class="sovereignty-icon">${isProtected ? '🛡️' : this.getSovereigntyIcon(t.sovereignty)}</span>
                        <span class="sovereignty-text">${sovereigntyText}</span>
                    </div>
                    ${t.ruler ? `
                        <div class="ruler-info">
                            <span class="ruler-label">👑 Owner:</span>
                            <span class="ruler-name">${t.rulerName || 'Unknown'}</span>
                            ${t.purchasedByAdmin ? '<span class="admin-badge">🔧 Admin</span>' : ''}
                        </div>
                        ${isProtected ? `
                            <div class="protection-info">
                                <span class="protection-icon">🛡️</span>
                                <span>Protected for ${protectionRemaining.days}d ${protectionRemaining.hours}h</span>
                            </div>
                        ` : ''}
                    ` : ''}
                </div>
                
                <!-- Territory Info Card -->
                <div class="territory-info-card">
                    <div class="info-row">
                        <span class="info-label">${countryFlag} Country</span>
                        <span class="info-value">${countryName}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">👥 Population</span>
                        <span class="info-value">${territoryDataService.formatNumber(population)}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">📏 Area</span>
                        <span class="info-value">${territoryDataService.formatArea(area)}</span>
                    </div>
                    <div class="info-row highlight">
                        <span class="info-label">💰 Price</span>
                        <span class="info-value price">${isAdmin ? 'FREE (Admin)' : territoryDataService.formatPrice(realPrice)}</span>
                    </div>
                </div>
                
                <!-- Pixel Info -->
                <div class="pixel-info-card">
                    <div class="pixel-header">
                        <span>🎨 Ad Space</span>
                        <span class="pixel-count">${this.formatNumber(pixelCount)} px</span>
                    </div>
                    <div class="pixel-bar">
                        <div class="pixel-bar-fill" style="width: ${Math.min(100, (pixelCount / 100))}%"></div>
                    </div>
                </div>
                
                <!-- Auction Info (if exists) -->
                ${auction ? this.renderAuction(auction) : ''}
                
                <!-- Action Buttons -->
                <div class="territory-actions">
                    ${this.renderActions(t, isOwner, auction, realPrice, auction ? this.getEffectiveAuctionBid(auction) : null)}
                </div>
            </div>
        `;
    }
    
    /**
     * 버프 섹션 렌더링
     */
    renderBuffs(territory) {
        if (!territory.ruler) return '';
        
        const buffs = buffSystem.formatBuffsForUI(territory.ruler, this.lang);
        
        if (buffs.length === 0) return '';
        
        return `
            <div class="buffs-section">
                <h3>⚡ 적용 버프</h3>
                <div class="buff-list">
                    ${buffs.map(buff => `
                        <div class="buff-item" style="border-color: ${buff.color}">
                            <span class="buff-icon">${buff.icon}</span>
                            <span class="buff-name">${buff.name}</span>
                            <span class="buff-bonus">${buff.bonusText}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    /**
     * 역사 섹션 렌더링
     */
    renderHistory(territory) {
        const history = territory.history || [];
        
        if (history.length === 0) return '';
        
        // 최근 5개만 표시
        const recentHistory = history.slice(-5).reverse();
        
        return `
            <div class="history-section">
                <h3>📜 Territory History</h3>
                <ul class="history-timeline">
                    ${recentHistory.map(event => `
                        <li class="history-item ${event.type}">
                            <span class="history-date">${this.formatDate(event.timestamp)}</span>
                            <span class="history-text">${this.getEventText(event)}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }
    
    /**
     * Auction Section Rendering
     */
    renderAuction(auction) {
        // 영토 정보 가져오기 (실제 가격 계산용)
        const territory = this.currentTerritory;
        let realTerritoryPrice = null;
        
        if (territory) {
            // 영토의 실제 가격 계산
            const countryCode = territory.country || 
                              territory.properties?.country || 
                              territory.properties?.adm0_a3?.toLowerCase() || 
                              'unknown';
            realTerritoryPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        }
        
        // 경매가 종료되었는지 확인
        if (auction.status === 'ended' || auction.status === AUCTION_STATUS.ENDED) {
            return `
                <div class="auction-section auction-ended">
                    <h3>⚔️ Auction Ended</h3>
                    <div class="auction-info">
                        <div class="auction-result">
                            ${auction.highestBidder 
                                ? `<span>Winner: ${auction.highestBidderName || 'Unknown'}</span><span>Final Bid: ${this.formatNumber(auction.currentBid)} pt</span>`
                                : '<span>No bids placed</span>'
                            }
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 경매 종료 시간 확인
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
            
            if (endDate && !isNaN(endDate.getTime())) {
                const now = new Date();
                if (endDate.getTime() <= now.getTime()) {
                    isExpired = true;
                }
            }
        }
        
        // 만료된 경매는 종료 처리
        if (isExpired) {
            // 비동기로 종료 처리 (렌더링 블로킹 방지)
            setTimeout(() => {
                auctionSystem.endAuction(auction.id).catch(err => {
                    log.error('Failed to end expired auction:', err);
                });
            }, 0);
            
            return `
                <div class="auction-section auction-ended">
                    <h3>⚔️ Auction Ended</h3>
                    <div class="auction-info">
                        <div class="auction-result">
                            ${auction.highestBidder 
                                ? `<span>Winner: ${auction.highestBidderName || 'Unknown'}</span><span>Final Bid: ${this.formatNumber(auction.currentBid)} pt</span>`
                                : '<span>No bids placed</span>'
                            }
                        </div>
                    </div>
                </div>
            `;
        }
        
        // 실제 영토 가격을 기준으로 startingBid 결정
        // 입찰자가 없으면 경매 시작가 비율 적용 (즉시 구매가의 60%)
        let correctStartingBid = realTerritoryPrice || auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE;
        
        // 입찰자가 없으면 경매 시작가 비율 적용
        if (!auction.highestBidder && realTerritoryPrice) {
            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
            correctStartingBid = Math.max(Math.floor(realTerritoryPrice * auctionRatio), 10); // 최소 10pt
        }
        
        // currentBid 검증 및 수정
        // 입찰자가 없고 currentBid가 startingBid와 다르면 startingBid로 수정
        let effectiveCurrentBid = auction.currentBid;
        
        if (!auction.highestBidder) {
            // 입찰자가 없으면 currentBid는 startingBid와 같아야 함
            if (!effectiveCurrentBid || effectiveCurrentBid !== correctStartingBid) {
                effectiveCurrentBid = correctStartingBid;
                
                // Firestore 업데이트 (비동기, 렌더링 블로킹 방지)
                setTimeout(async () => {
                    try {
                        await firebaseService.updateDocument('auctions', auction.id, {
                            currentBid: effectiveCurrentBid,
                            startingBid: correctStartingBid
                        });
                        // 로컬 캐시도 업데이트
                        auction.currentBid = effectiveCurrentBid;
                        auction.startingBid = correctStartingBid;
                        log.info(`Fixed auction ${auction.id} currentBid from ${auction.currentBid} to ${effectiveCurrentBid}`);
                    } catch (error) {
                        log.error('Failed to fix auction currentBid:', error);
                    }
                }, 0);
            }
        } else {
            // 입찰자가 있으면 currentBid가 startingBid보다 크거나 같아야 함
            if (!effectiveCurrentBid || effectiveCurrentBid < correctStartingBid) {
                effectiveCurrentBid = correctStartingBid;
            }
        }
        
        // minIncrement가 없거나 너무 크면 시작가의 10% 또는 최소 10pt로 설정
        const effectiveMinIncrement = auction.minIncrement || Math.max(
            Math.floor(effectiveCurrentBid * 0.1),
            10
        );
        
        // 입찰자가 없으면 Current Bid 표시하지 않음
        const hasBids = !!auction.highestBidder;
        
        return `
            <div class="auction-section">
                <h3>⚔️ Active Auction</h3>
                <div class="auction-info">
                    ${hasBids ? `
                        <div class="current-bid">
                            <span class="bid-label">Current Bid</span>
                            <span class="bid-amount">${this.formatNumber(effectiveCurrentBid)} pt</span>
                        </div>
                        <div class="highest-bidder">
                            <span class="bidder-label">Highest Bidder</span>
                            <span class="bidder-name">${auction.highestBidderName || 'Unknown'}</span>
                        </div>
                    ` : `
                        <div class="starting-bid">
                            <span class="bid-label">Starting Bid</span>
                            <span class="bid-amount">${this.formatNumber(effectiveCurrentBid)} pt</span>
                        </div>
                        <div class="no-bids-notice">
                            <span class="notice-icon">💡</span>
                            <span>No bids yet. Be the first to bid!</span>
                        </div>
                    `}
                    <div class="time-remaining">
                        <span class="time-label">Time Left</span>
                        <span class="time-value">${this.getTimeRemaining(auction.endTime)}</span>
                    </div>
                </div>
                <div class="bid-input-group">
                    <input type="number" id="bid-amount-input" 
                           placeholder="Bid amount" 
                           min="${effectiveCurrentBid + effectiveMinIncrement}"
                           value="${effectiveCurrentBid + effectiveMinIncrement}">
                    <button class="bid-btn" id="place-bid-btn">Place Bid</button>
                </div>
            </div>
        `;
    }
    
    /**
     * 경매의 유효한 입찰가 계산 (입찰자가 없으면 startingBid 사용)
     */
    getEffectiveAuctionBid(auction) {
        if (!auction) return null;
        
        // 영토 정보 가져오기 (실제 가격 계산용)
        const territory = this.currentTerritory;
        let realTerritoryPrice = null;
        
        if (territory) {
            const countryCode = territory.country || 
                              territory.properties?.country || 
                              territory.properties?.adm0_a3?.toLowerCase() || 
                              'unknown';
            realTerritoryPrice = territoryDataService.calculateTerritoryPrice(territory, countryCode);
        }
        
        // 실제 영토 가격을 기준으로 startingBid 결정
        let correctStartingBid = realTerritoryPrice || auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE;
        
        // 입찰자가 없으면 경매 시작가 비율 적용 (즉시 구매가의 60%)
        if (!auction.highestBidder && realTerritoryPrice) {
            const auctionRatio = CONFIG.TERRITORY.AUCTION_STARTING_BID_RATIO || 0.6;
            correctStartingBid = Math.max(Math.floor(realTerritoryPrice * auctionRatio), 10); // 최소 10pt
        }
        
        // 입찰자가 없으면 startingBid를 currentBid로 사용
        if (!auction.highestBidder) {
            return correctStartingBid;
        }
        
        // 입찰자가 있으면 currentBid 사용 (최소 startingBid 이상이어야 함)
        return Math.max(auction.currentBid || correctStartingBid, correctStartingBid);
    }
    
    /**
     * Action Buttons Rendering
     */
    renderActions(territory, isOwner, auction, realPrice = 100, effectiveAuctionBid = null) {
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        const isProtected = territoryManager.isProtected(territory.id);
        
        if (!user) {
            return `
                <button class="action-btn login-btn" id="login-to-conquer">
                    🔐 Sign in to Claim
                </button>
            `;
        }
        
        // 소유자인 경우 - 꾸미기 버튼
        if ((territory.sovereignty === SOVEREIGNTY.RULED || territory.sovereignty === SOVEREIGNTY.PROTECTED) && isOwner) {
            return `
                <button class="action-btn pixel-btn" id="open-pixel-editor">
                    🎨 Decorate Territory
                </button>
                <button class="action-btn collab-btn" id="open-collaboration">
                    👥 Open Collaboration
                </button>
            `;
        }
        
        // 경매 중인 경우에도 즉시 구매 가능하도록 "Claim Now" 버튼 표시
        if (auction && auction.status === AUCTION_STATUS.ACTIVE) {
            const user = firebaseService.getCurrentUser();
            const isUserHighestBidder = auction.highestBidder === user?.uid;
            const hasBids = !!auction.highestBidder;
            
            // 가격 비교 정보 (유효한 입찰가 사용 - 입찰자가 없으면 startingBid 사용)
            const auctionCurrentBid = effectiveAuctionBid !== null 
                ? effectiveAuctionBid 
                : this.getEffectiveAuctionBid(auction);
            const priceDifference = realPrice - auctionCurrentBid;
            const isCheaper = priceDifference < 0;
            
            if (isAdmin) {
                return `
                    <div class="action-options-header">
                        <h4>📋 Choose Your Action</h4>
                        <p class="action-hint">You can buy now or continue bidding</p>
                    </div>
                    <button class="action-btn conquest-btn admin-conquest" id="instant-conquest">
                        🔧 Buy Now (FREE) - Cancel Auction
                    </button>
                    <div class="action-divider">
                        <span>OR</span>
                    </div>
                    <div class="auction-action-hint">
                        <span class="hint-icon">💡</span>
                        <span>Place a bid above to participate in the auction</span>
                    </div>
                `;
            }
            
            return `
                <div class="action-options-header">
                    <h4>📋 Choose Your Action</h4>
                    <p class="action-hint">You have two options to acquire this territory</p>
                </div>
                
                <div class="action-option-card">
                    <div class="option-header">
                        <span class="option-icon">⚡</span>
                        <span class="option-title">Buy Now</span>
                        <span class="option-badge instant">Instant</span>
                    </div>
                    <div class="option-price">
                        <span class="price-label">Price:</span>
                        <span class="price-value">${this.formatNumber(realPrice)} pt</span>
                    </div>
                    ${isCheaper ? `
                        <div class="price-comparison save">
                            <span class="save-icon">💰</span>
                            <span>Save ${this.formatNumber(Math.abs(priceDifference))} pt vs current bid</span>
                        </div>
                    ` : priceDifference > 0 ? `
                        <div class="price-comparison note">
                            <span class="note-icon">ℹ️</span>
                            <span>${this.formatNumber(priceDifference)} pt more than current bid</span>
                        </div>
                    ` : ''}
                    ${hasBids ? `
                        <div class="auction-warning">
                            <span class="warning-icon">⚠️</span>
                            <span>This will cancel the active auction</span>
                        </div>
                    ` : ''}
                    ${isUserHighestBidder ? `
                        <div class="bidder-notice">
                            <span class="notice-icon">💬</span>
                            <span>You are the highest bidder. Your bid will be refunded if you buy now.</span>
                        </div>
                    ` : ''}
                    <button class="action-btn conquest-btn" id="instant-conquest">
                        ⚔️ Buy Now (${this.formatNumber(realPrice)} pt)
                    </button>
                </div>
                
                <div class="action-divider">
                    <span>OR</span>
                </div>
                
                <div class="action-option-card">
                    <div class="option-header">
                        <span class="option-icon">⏳</span>
                        <span class="option-title">Continue Bidding</span>
                        <span class="option-badge auction">Auction</span>
                    </div>
                    <div class="option-price">
                        <span class="price-label">${hasBids ? 'Current Bid:' : 'Starting Bid:'}</span>
                        <span class="price-value">${this.formatNumber(auctionCurrentBid)} pt</span>
                    </div>
                    ${!hasBids ? `
                        <div class="no-bids-notice">
                            <span class="notice-icon">💡</span>
                            <span>No bids yet. Be the first to bid!</span>
                        </div>
                    ` : ''}
                    <div class="auction-action-hint">
                        <span class="hint-icon">💡</span>
                        <span>Place your bid in the auction section above</span>
                    </div>
                </div>
            `;
        }
        
        // 보호 기간 중인 경우 - 경매 입찰은 가능 (7일 후 낙찰)
        if (isProtected && !isOwner) {
            const remaining = territoryManager.getProtectionRemaining(territory.id);
            return `
                <div class="protected-notice">
                    <span class="protected-icon">🛡️</span>
                    <span>Protected Territory</span>
                    <small>Auction ends in ${remaining.days}d ${remaining.hours}h</small>
                </div>
                <button class="action-btn auction-btn" id="start-auction">
                    🏷️ Start Auction (ends after protection)
                </button>
            `;
        }
        
        // 미정복 영토 - 구매 가능
        if (territory.sovereignty === SOVEREIGNTY.UNCONQUERED || (!territory.ruler && !auction)) {
            if (isAdmin) {
                // 관리자 모드: 무료 구매
                return `
                    <div class="admin-mode-notice">
                        <span>🔧 Admin Mode - Free Claim</span>
                    </div>
                    <button class="action-btn conquest-btn admin-conquest" id="instant-conquest">
                        🔧 Claim as Admin (FREE)
                    </button>
                `;
            }
            return `
                <button class="action-btn conquest-btn" id="instant-conquest">
                    ⚔️ Claim Now (${this.formatNumber(realPrice)} pt)
                </button>
                <button class="action-btn auction-btn" id="start-auction">
                    🏷️ Start Auction
                </button>
            `;
        }
        
        // 다른 사람 소유 영토 (보호 기간 아님, 경매 없음)
        if (territory.ruler && !isOwner && !auction) {
            return `
                <button class="action-btn challenge-btn" id="challenge-ruler">
                    ⚔️ Challenge Owner
                </button>
            `;
        }
        
        // 기본: 아무 버튼도 표시하지 않음
        return '';
    }
    
    /**
     * 액션 바인딩
     */
    bindActions() {
        // 닫기 버튼
        const closeBtn = document.getElementById('close-territory-panel');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }
        
        // 로그인 버튼
        const loginBtn = document.getElementById('login-to-conquer');
        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            });
        }
        
        // 즉시 정복 버튼
        const conquestBtn = document.getElementById('instant-conquest');
        if (conquestBtn) {
            conquestBtn.addEventListener('click', () => this.handleInstantConquest());
        }
        
        // 옥션 시작 버튼
        const auctionBtn = document.getElementById('start-auction');
        if (auctionBtn) {
            auctionBtn.addEventListener('click', () => this.handleStartAuction());
        }
        
        // 입찰 버튼
        const bidBtn = document.getElementById('place-bid-btn');
        if (bidBtn) {
            bidBtn.addEventListener('click', () => this.handlePlaceBid());
        }
        
        // 픽셀 에디터 버튼
        const pixelBtn = document.getElementById('open-pixel-editor');
        if (pixelBtn) {
            pixelBtn.addEventListener('click', () => {
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { 
                    type: 'pixelEditor', 
                    data: this.currentTerritory 
                });
            });
        }
    }
    
    /**
     * 즉시 정복 처리
     */
    async handleInstantConquest() {
        const user = firebaseService.getCurrentUser();
        const isAdmin = this.isAdminMode();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to claim this territory'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No territory selected'
            });
            return;
        }
        
        const territoryName = this.extractName(this.currentTerritory.name) || 
                             this.extractName(this.currentTerritory.properties?.name) ||
                             this.currentTerritory.id;
        
        // 관리자 모드: 무료 구매
        if (isAdmin) {
            try {
                // 바로 정복 처리 (포인트 차감 없이)
                eventBus.emit(EVENTS.TERRITORY_CONQUERED, {
                    territoryId: this.currentTerritory.id,
                    userId: user.uid,
                    userName: user.displayName || user.email,
                    tribute: 0,
                    isAdmin: true
                });
                
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'success',
                    message: `🔧 Admin claimed: ${territoryName}`
                });
                
                // 패널 갱신
                this.render();
                this.bindActions();
                
            } catch (error) {
                log.error('Admin conquest failed:', error);
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'error',
                    message: 'Failed to claim territory'
                });
            }
            return;
        }
        
        // 경매가 활성화되어 있는지 확인
        const activeAuction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isUserHighestBidder = activeAuction && activeAuction.highestBidder === user.uid;
        
        // 경매가 활성화되어 있고 입찰자가 있는 경우 확인 다이얼로그
        if (activeAuction && activeAuction.status === AUCTION_STATUS.ACTIVE && activeAuction.highestBidder) {
            const confirmMessage = isUserHighestBidder
                ? `This will cancel the auction and refund your bid of ${this.formatNumber(activeAuction.currentBid)} pt. Continue?`
                : `This will cancel the active auction. The current highest bidder will be refunded. Continue?`;
            
            if (!confirm(confirmMessage)) {
                return;
            }
            
            // 경매 취소 처리
            try {
                await auctionSystem.endAuction(activeAuction.id);
                log.info(`Auction ${activeAuction.id} cancelled due to instant purchase`);
            } catch (error) {
                log.warn('Failed to cancel auction, continuing with purchase:', error);
            }
        }
        
        // 일반 사용자: 결제 처리
        const countryCode = this.currentTerritory.country || 
                           this.currentTerritory.properties?.country || 
                           'unknown';
        const price = territoryDataService.calculateTerritoryPrice(this.currentTerritory, countryCode);
        
        try {
            // 결제 시작 이벤트 (PaymentService에서 처리)
            eventBus.emit(EVENTS.PAYMENT_START, {
                type: 'conquest',
                territoryId: this.currentTerritory.id,
                territoryName: territoryName,
                amount: price,
                cancelAuction: !!activeAuction
            });
            
        } catch (error) {
            log.error('Conquest failed:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'Failed to process purchase. Please try again.'
            });
        }
    }
    
    /**
     * 옥션 시작 처리
     */
    async handleStartAuction() {
        const user = firebaseService.getCurrentUser();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to start an auction'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!this.currentTerritory) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No territory selected'
            });
            return;
        }
        
        try {
            // 옥션 생성
            await auctionSystem.createAuction(this.currentTerritory.id);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '🎯 Auction started! Place your bids!'
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Auction start failed:', error);
            
            // 사용자 친화적 에러 메시지
            let errorMessage = 'Failed to start auction';
            if (error.message.includes('Authentication')) {
                errorMessage = 'Please sign in first';
            } else if (error.message.includes('not found')) {
                errorMessage = 'Territory not found';
            } else if (error.message.includes('in progress')) {
                errorMessage = 'An auction is already in progress';
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage
            });
        }
    }
    
    /**
     * 입찰 처리
     */
    async handlePlaceBid() {
        const input = document.getElementById('bid-amount-input');
        if (!input) return;
        
        const bidAmount = parseInt(input.value, 10);
        const user = firebaseService.getCurrentUser();
        const auction = auctionSystem.getAuctionByTerritory(this.currentTerritory.id);
        const isAdmin = this.isAdminMode();
        
        // 로그인 체크
        if (!user) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please sign in to place a bid'
            });
            eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            return;
        }
        
        if (!auction) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: 'No active auction found'
            });
            return;
        }
        
        // 입찰 금액 검증
        if (!bidAmount || isNaN(bidAmount) || bidAmount <= 0) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: 'Please enter a valid bid amount'
            });
            return;
        }
        
        // currentBid가 startingBid보다 작거나 없으면 startingBid 사용
        const effectiveCurrentBid = auction.currentBid && auction.currentBid >= (auction.startingBid || 0) 
            ? auction.currentBid 
            : (auction.startingBid || CONFIG.TERRITORY.DEFAULT_TRIBUTE);
        
        // minIncrement 계산
        const effectiveMinIncrement = auction.minIncrement || Math.max(
            Math.floor(effectiveCurrentBid * 0.1),
            10
        );
        
        const minBid = effectiveCurrentBid + effectiveMinIncrement;
        if (bidAmount < minBid) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'warning',
                message: `Minimum bid is ${this.formatNumber(minBid)} pt`
            });
            return;
        }
        
        // 관리자 모드가 아닌 경우에만 잔액 체크
        if (!isAdmin) {
            const currentBalance = walletService.getBalance();
            if (currentBalance < bidAmount) {
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: `Insufficient balance. You have ${this.formatNumber(currentBalance)} pt`
                });
                // PaymentService의 충전 모달 열기
                eventBus.emit(EVENTS.PAYMENT_START, {
                    type: 'bid',
                    amount: bidAmount
                });
                return;
            }
        }
        
        try {
            await auctionSystem.handleBid({
                auctionId: auction.id,
                bidAmount,
                userId: user.uid,
                userName: user.displayName || user.email
            });
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `🎯 Bid placed: ${this.formatNumber(bidAmount)} pt`
            });
            
            // 입력 필드 초기화
            input.value = '';
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Bid failed:', error);
            
            let errorMessage = 'Failed to place bid';
            if (error.message.includes('Minimum')) {
                errorMessage = error.message;
            } else if (error.message.includes('not active')) {
                errorMessage = 'Auction has ended';
            }
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: errorMessage
            });
        }
    }
    
    // ==================== 헬퍼 메서드 ====================
    
    /**
     * 이름 추출 (객체일 수 있으므로 문자열로 변환)
     */
    extractName(name) {
        if (!name) return null;
        if (typeof name === 'string') return name;
        if (typeof name === 'object') {
            return name.en || name.ko || name.local || Object.values(name)[0] || null;
        }
        return String(name);
    }
    
    getTerritoryIcon(sovereignty) {
        const icons = {
            [SOVEREIGNTY.UNCONQUERED]: '🏴',
            [SOVEREIGNTY.CONTESTED]: '⚔️',
            [SOVEREIGNTY.RULED]: '🏰'
        };
        return icons[sovereignty] || '🏴';
    }
    
    getSovereigntyIcon(sovereignty) {
        const icons = {
            [SOVEREIGNTY.UNCONQUERED]: '✅',
            [SOVEREIGNTY.CONTESTED]: '⏳',
            [SOVEREIGNTY.RULED]: '👑'
        };
        return icons[sovereignty] || '❓';
    }
    
    formatNumber(num) {
        if (!num) return '0';
        return num.toLocaleString();
    }
    
    formatDate(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        return d.toLocaleDateString(this.lang === 'ko' ? 'ko-KR' : 'en-US');
    }
    
    getPixelPercentage(territory) {
        if (!territory.pixelCanvas) return 0;
        const total = territory.pixelCanvas.width * territory.pixelCanvas.height;
        return Math.round((territory.pixelCanvas.filledPixels / total) * 100);
    }
    
    getTimeRemaining(endTime) {
        if (!endTime) return '-';
        
        let end;
        // Firestore Timestamp 객체 처리
        if (endTime && typeof endTime === 'object') {
            if (endTime.toDate && typeof endTime.toDate === 'function') {
                // Firestore Timestamp
                end = endTime.toDate();
            } else if (endTime.seconds) {
                // Timestamp 객체 (seconds 필드가 있는 경우)
                end = new Date(endTime.seconds * 1000);
            } else if (endTime instanceof Date) {
                end = endTime;
            } else {
                // 일반 객체나 다른 형태
                end = new Date(endTime);
            }
        } else {
            // 문자열이나 숫자
            end = new Date(endTime);
        }
        
        // 유효한 날짜인지 확인
        if (isNaN(end.getTime())) {
            return '시간 계산 오류';
        }
        
        const now = new Date();
        const diff = end.getTime() - now.getTime();
        
        if (diff <= 0) return '종료됨';
        
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        return `${hours}시간 ${minutes}분`;
    }
    
    getEventText(event) {
        const { type, data } = event;
        
        switch (type) {
            case 'conquered':
                return `${data.newRuler}이(가) 영토를 정복했습니다`;
            case 'pixel_milestone':
                return `${data.milestone} 픽셀 달성! 🎉`;
            case 'auction_started':
                return 'Auction started';
            default:
                return event.narrative || '알 수 없는 이벤트';
        }
    }
}

// 싱글톤 인스턴스
export const territoryPanel = new TerritoryPanel();
export default territoryPanel;


