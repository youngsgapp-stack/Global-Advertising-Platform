/**
 * TerritoryListPanel - 영토 목록 패널
 * 상태별로 영토를 필터링하여 리스트로 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import territoryManager, { SOVEREIGNTY } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';

class TerritoryListPanel {
    constructor() {
        this.container = null;
        this.contentContainer = null;
        this.currentFilter = 'all';
        this.searchQuery = '';
        this.territories = [];
        this.isOpen = false;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.container = document.getElementById('territory-list-panel');
        this.contentContainer = document.getElementById('territory-list-content');
        
        if (!this.container) {
            log.warn('TerritoryListPanel: Container not found');
            return;
        }
        
        this.setupEventListeners();
        this.setupSideMenuButtons();
        
        // 영토 데이터 변경 시 업데이트
        eventBus.on(EVENTS.TERRITORY_UPDATE, () => this.updateList());
        eventBus.on(EVENTS.TERRITORY_CONQUERED, () => this.updateList());
        eventBus.on(EVENTS.AUCTION_START, () => this.updateList());
        eventBus.on(EVENTS.AUCTION_END, () => this.updateList());
        
        log.info('TerritoryListPanel initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 닫기 버튼
        const closeBtn = document.getElementById('close-territory-list');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }
        
        // 필터 탭
        const filterTabs = this.container.querySelectorAll('.filter-tab');
        filterTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                filterTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.currentFilter = tab.dataset.filter;
                this.renderList();
            });
        });
        
        // 검색 입력
        const searchInput = document.getElementById('territory-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.renderList();
            });
        }
    }
    
    /**
     * 사이드 메뉴 버튼 설정
     */
    setupSideMenuButtons() {
        const availableBtn = document.getElementById('side-available-btn');
        const auctionBtn = document.getElementById('side-auction-btn');
        const ownedBtn = document.getElementById('side-owned-btn');
        
        if (availableBtn) {
            availableBtn.addEventListener('click', () => this.openWithFilter('available'));
        }
        if (auctionBtn) {
            auctionBtn.addEventListener('click', () => this.openWithFilter('auction'));
        }
        if (ownedBtn) {
            ownedBtn.addEventListener('click', () => this.openWithFilter('owned'));
        }
    }
    
    /**
     * 특정 필터로 패널 열기
     */
    openWithFilter(filter) {
        this.currentFilter = filter;
        
        // 필터 탭 업데이트
        const filterTabs = this.container.querySelectorAll('.filter-tab');
        filterTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.filter === filter);
        });
        
        // 타이틀 업데이트
        const titleMap = {
            'all': '🗺️ All Territories',
            'available': '🏴 Available Territories',
            'auction': '🔥 Territories in Auction',
            'owned': '🏰 Owned Territories'
        };
        
        const titleEl = document.getElementById('territory-list-title');
        if (titleEl) {
            titleEl.textContent = titleMap[filter] || titleMap['all'];
        }
        
        this.open();
    }
    
    /**
     * 패널 열기
     */
    open() {
        if (!this.container) return;
        
        this.updateList();
        this.container.classList.remove('hidden');
        this.isOpen = true;
        
        // 사이드 메뉴 닫기
        const sideMenu = document.getElementById('side-menu');
        if (sideMenu) {
            sideMenu.classList.add('hidden');
        }
    }
    
    /**
     * 패널 닫기
     */
    close() {
        if (!this.container) return;
        
        this.container.classList.add('hidden');
        this.isOpen = false;
    }
    
    /**
     * 토글
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }
    
    /**
     * 영토 목록 업데이트
     */
    updateList() {
        // 모든 영토 가져오기
        this.territories = Array.from(territoryManager.territories.values());
        
        // 사이드 메뉴 카운트 업데이트
        this.updateCounts();
        
        // 열려있으면 리스트 렌더링
        if (this.isOpen) {
            this.renderList();
        }
    }
    
    /**
     * 카운트 업데이트
     */
    updateCounts() {
        const counts = {
            available: 0,
            auction: 0,
            owned: 0
        };
        
        this.territories.forEach(t => {
            if (t.sovereignty === SOVEREIGNTY.CONTESTED || t.currentAuction) {
                counts.auction++;
            } else if (t.sovereignty === SOVEREIGNTY.RULED || t.sovereignty === SOVEREIGNTY.PROTECTED) {
                counts.owned++;
            } else {
                counts.available++;
            }
        });
        
        // DOM 업데이트
        const availableCount = document.getElementById('count-available');
        const auctionCount = document.getElementById('count-auction');
        const ownedCount = document.getElementById('count-owned');
        
        if (availableCount) availableCount.textContent = counts.available;
        if (auctionCount) auctionCount.textContent = counts.auction;
        if (ownedCount) ownedCount.textContent = counts.owned;
    }
    
    /**
     * 리스트 렌더링
     */
    renderList() {
        if (!this.contentContainer) return;
        
        let filtered = this.filterTerritories();
        
        // 검색 필터
        if (this.searchQuery) {
            filtered = filtered.filter(t => {
                const name = this.extractName(t.name) || t.id;
                return name.toLowerCase().includes(this.searchQuery);
            });
        }
        
        // 정렬: 가격 순
        filtered.sort((a, b) => (b.tribute || 0) - (a.tribute || 0));
        
        // 카운트 업데이트
        const countEl = document.getElementById('territory-list-count');
        if (countEl) {
            countEl.textContent = `${filtered.length} territories`;
        }
        
        // 빈 상태
        if (filtered.length === 0) {
            this.contentContainer.innerHTML = `
                <div class="territory-list-empty">
                    <div class="empty-icon">🏜️</div>
                    <p>No territories found</p>
                </div>
            `;
            return;
        }
        
        // 리스트 렌더링
        this.contentContainer.innerHTML = filtered.map(t => this.renderItem(t)).join('');
        
        // 클릭 이벤트 바인딩
        this.contentContainer.querySelectorAll('.territory-list-item').forEach(item => {
            item.addEventListener('click', () => {
                const territoryId = item.dataset.id;
                this.handleItemClick(territoryId);
            });
        });
    }
    
    /**
     * 필터링
     */
    filterTerritories() {
        switch (this.currentFilter) {
            case 'available':
                return this.territories.filter(t => 
                    t.sovereignty === SOVEREIGNTY.UNCONQUERED && !t.currentAuction
                );
            case 'auction':
                return this.territories.filter(t => 
                    t.sovereignty === SOVEREIGNTY.CONTESTED || t.currentAuction
                );
            case 'owned':
                return this.territories.filter(t => 
                    t.sovereignty === SOVEREIGNTY.RULED || t.sovereignty === SOVEREIGNTY.PROTECTED
                );
            default:
                return this.territories;
        }
    }
    
    /**
     * 아이템 렌더링
     */
    renderItem(territory) {
        const name = this.extractName(territory.name) || territory.id;
        const status = this.getStatus(territory);
        const price = this.formatPrice(territory.tribute || CONFIG.TERRITORY.DEFAULT_TRIBUTE);
        
        let icon = '🏴';
        let statusClass = 'available';
        let meta = 'Available';
        let priceClass = '';
        
        if (territory.currentAuction || territory.sovereignty === SOVEREIGNTY.CONTESTED) {
            icon = '🔥';
            statusClass = 'auction';
            meta = 'In Auction';
            priceClass = 'auction';
        } else if (territory.sovereignty === SOVEREIGNTY.RULED || territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            icon = '🏰';
            statusClass = 'owned';
            meta = `Owner: ${territory.rulerName || 'Unknown'}`;
        }
        
        return `
            <div class="territory-list-item ${statusClass}" data-id="${territory.id}">
                <div class="territory-item-icon">${icon}</div>
                <div class="territory-item-info">
                    <div class="territory-item-name">${name}</div>
                    <div class="territory-item-meta">
                        <span>${meta}</span>
                    </div>
                </div>
                <div class="territory-item-price ${priceClass}">${price}</div>
            </div>
        `;
    }
    
    /**
     * 아이템 클릭 처리
     */
    handleItemClick(territoryId) {
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) return;
        
        // 해당 영토로 이동
        if (territory.center) {
            mapController.flyTo(territory.center, 8);
        }
        
        // 영토 선택 이벤트 발생
        eventBus.emit(EVENTS.TERRITORY_SELECT, { territory });
        
        // 패널 닫기
        this.close();
    }
    
    /**
     * 이름 추출
     */
    extractName(name) {
        if (!name) return null;
        if (typeof name === 'string') return name;
        if (typeof name === 'object') {
            return name.en || name.local || name.ko || Object.values(name)[0];
        }
        return String(name);
    }
    
    /**
     * 상태 가져오기
     */
    getStatus(territory) {
        if (territory.currentAuction || territory.sovereignty === SOVEREIGNTY.CONTESTED) {
            return 'auction';
        }
        if (territory.sovereignty === SOVEREIGNTY.RULED || territory.sovereignty === SOVEREIGNTY.PROTECTED) {
            return 'owned';
        }
        return 'available';
    }
    
    /**
     * 가격 포맷
     */
    formatPrice(price) {
        if (price >= 1000000) {
            return `$${(price / 1000000).toFixed(1)}M`;
        }
        if (price >= 1000) {
            return `$${(price / 1000).toFixed(0)}K`;
        }
        return `$${price}`;
    }
}

// 싱글톤 인스턴스
export const territoryListPanel = new TerritoryListPanel();
export default territoryListPanel;

