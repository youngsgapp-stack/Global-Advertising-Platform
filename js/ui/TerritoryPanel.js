/**
 * TerritoryPanel - 영토 정보 패널 UI
 * 영토 상세 정보, 역사, 버프, 액션 버튼 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { SOVEREIGNTY } from '../core/TerritoryManager.js';
import { buffSystem } from '../features/BuffSystem.js';
import { auctionSystem } from '../features/AuctionSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryDataService } from '../services/TerritoryDataService.js';

class TerritoryPanel {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.lang = 'en';  // English default
        this.countryData = null;
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
        const auction = auctionSystem.getAuctionByTerritory(t.id);
        
        // 국가 코드 결정 (properties에서 추출)
        const countryCode = t.country || 
                           t.properties?.country || 
                           t.properties?.admin?.toLowerCase().replace(/\s+/g, '-') ||
                           t.properties?.sov_a3?.toLowerCase() ||
                           'unknown';
        
        // Get real country data
        this.countryData = territoryDataService.getCountryStats(countryCode);
        const countryInfo = CONFIG.COUNTRIES[countryCode] || {};
        
        // 인구/면적 데이터 추출 (TerritoryDataService 사용)
        const population = territoryDataService.extractPopulation(t, countryCode);
        const area = territoryDataService.extractArea(t, countryCode);
        
        // 픽셀 수 계산 (면적 기반)
        const pixelCount = territoryDataService.calculatePixelCount(t, countryCode);
        
        // 가격 계산 (픽셀 수 기반)
        const realPrice = territoryDataService.calculateTerritoryPrice(t, countryCode);
        
        const territoryName = t.name?.en || t.name || t.properties?.name || t.properties?.name_en || 'Unknown Territory';
        const countryName = countryInfo.name || t.properties?.admin || t.country || 'Unknown';
        const countryFlag = countryInfo.flag || '🏳️';
        
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
                    <div class="sovereignty-badge ${t.sovereignty || 'unconquered'}">
                        <span class="sovereignty-icon">${this.getSovereigntyIcon(t.sovereignty)}</span>
                        <span class="sovereignty-text">${vocab[t.sovereignty] || 'Available'}</span>
                    </div>
                    ${t.ruler ? `
                        <div class="ruler-info">
                            <span class="ruler-label">Owner:</span>
                            <span class="ruler-name">${t.rulerName || t.ruler}</span>
                        </div>
                    ` : ''}
                </div>
                
                <!-- Territory Stats (Real Data) -->
                <div class="territory-stats">
                    <div class="stat-item">
                        <span class="stat-icon">${countryFlag}</span>
                        <span class="stat-label">Country</span>
                        <span class="stat-value">${countryName}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-icon">👥</span>
                        <span class="stat-label">Population</span>
                        <span class="stat-value">${territoryDataService.formatNumber(population)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-icon">📏</span>
                        <span class="stat-label">Area</span>
                        <span class="stat-value">${territoryDataService.formatArea(area)}</span>
                    </div>
                    <div class="stat-item highlight">
                        <span class="stat-icon">💰</span>
                        <span class="stat-label">Price</span>
                        <span class="stat-value tribute">${territoryDataService.formatPrice(realPrice)}</span>
                    </div>
                    ${this.countryData ? `
                        <div class="stat-item">
                            <span class="stat-icon">🏙️</span>
                            <span class="stat-label">Capital</span>
                            <span class="stat-value">${this.countryData.capital || 'N/A'}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-icon">🌍</span>
                            <span class="stat-label">Region</span>
                            <span class="stat-value">${this.countryData.region || 'N/A'}</span>
                        </div>
                    ` : ''}
                </div>
                
                <!-- Pixel Value (면적 기반) -->
                <div class="pixel-value-section">
                    <h3>🎨 Ad Space (Pixels)</h3>
                    <div class="value-bar-container">
                        <div class="value-bar" style="width: ${Math.min(100, (pixelCount / 100))}%"></div>
                    </div>
                    <div class="value-text">
                        <span class="pixel-count">${this.formatNumber(pixelCount)}</span>
                        <span>available pixels</span>
                    </div>
                    <div class="price-breakdown">
                        <small>💡 Price based on area × pixels × location</small>
                    </div>
                </div>
                
                <!-- Applied Buffs -->
                ${this.renderBuffs(t)}
                
                <!-- Territory History -->
                ${this.renderHistory(t)}
                
                <!-- Auction Info (if exists) -->
                ${auction ? this.renderAuction(auction) : ''}
                
                <!-- Action Buttons -->
                <div class="territory-actions">
                    ${this.renderActions(t, isOwner, auction, realPrice)}
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
        return `
            <div class="auction-section">
                <h3>⚔️ Active Auction</h3>
                <div class="auction-info">
                    <div class="current-bid">
                        <span class="bid-label">Current Bid</span>
                        <span class="bid-amount">$${this.formatNumber(auction.currentBid)}</span>
                    </div>
                    <div class="highest-bidder">
                        <span class="bidder-label">Highest Bidder</span>
                        <span class="bidder-name">${auction.highestBidderName || 'None'}</span>
                    </div>
                    <div class="time-remaining">
                        <span class="time-label">Time Left</span>
                        <span class="time-value">${this.getTimeRemaining(auction.endTime)}</span>
                    </div>
                </div>
                <div class="bid-input-group">
                    <input type="number" id="bid-amount-input" 
                           placeholder="Bid amount" 
                           min="${auction.currentBid + auction.minIncrement}">
                    <button class="bid-btn" id="place-bid-btn">Place Bid</button>
                </div>
            </div>
        `;
    }
    
    /**
     * Action Buttons Rendering
     */
    renderActions(territory, isOwner, auction, realPrice = 100) {
        const user = firebaseService.getCurrentUser();
        
        if (!user) {
            return `
                <button class="action-btn login-btn" id="login-to-conquer">
                    🔐 Sign in to Claim
                </button>
            `;
        }
        
        if (territory.sovereignty === SOVEREIGNTY.RULED && isOwner) {
            return `
                <button class="action-btn pixel-btn" id="open-pixel-editor">
                    🎨 Decorate Territory
                </button>
                <button class="action-btn collab-btn" id="open-collaboration">
                    👥 Open Collaboration
                </button>
            `;
        }
        
        if (territory.sovereignty === SOVEREIGNTY.CONTESTED && auction) {
            return `
                <span class="auction-notice">Auction in progress - Place your bid above</span>
            `;
        }
        
        if (territory.sovereignty === SOVEREIGNTY.UNCONQUERED) {
            return `
                <button class="action-btn conquest-btn" id="instant-conquest">
                    ⚔️ Claim Now ($${this.formatNumber(realPrice)})
                </button>
                <button class="action-btn auction-btn" id="start-auction">
                    🏷️ Start Auction
                </button>
            `;
        }
        
        return `
            <button class="action-btn challenge-btn" id="challenge-ruler">
                ⚔️ 통치자에게 도전
            </button>
        `;
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
        if (!user || !this.currentTerritory) return;
        
        try {
            // 결제 시작 이벤트
            eventBus.emit(EVENTS.PAYMENT_START, {
                type: 'conquest',
                territoryId: this.currentTerritory.id,
                amount: this.currentTerritory.tribute
            });
            
        } catch (error) {
            log.error('Conquest failed:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '정복에 실패했습니다.'
            });
        }
    }
    
    /**
     * 옥션 시작 처리
     */
    async handleStartAuction() {
        if (!this.currentTerritory) return;
        
        try {
            await auctionSystem.createAuction(this.currentTerritory.id);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: 'Auction has started!'
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Auction start failed:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: error.message
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
        
        if (!user || !auction) return;
        
        try {
            await auctionSystem.handleBid({
                auctionId: auction.id,
                bidAmount,
                userId: user.uid,
                userName: user.displayName || user.email
            });
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: `$${this.formatNumber(bidAmount)} 입찰 완료!`
            });
            
            // 패널 갱신
            this.render();
            this.bindActions();
            
        } catch (error) {
            log.error('Bid failed:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: error.message
            });
        }
    }
    
    // ==================== 헬퍼 메서드 ====================
    
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
        const end = endTime instanceof Date ? endTime : new Date(endTime);
        const now = new Date();
        const diff = end - now;
        
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

