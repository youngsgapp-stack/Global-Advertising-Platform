/**
 * TerritoryListPanel - 영토 목록 패널
 * 상태별로 영토를 필터링하여 리스트로 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import territoryManager, { SOVEREIGNTY } from '../core/TerritoryManager.js';
import { mapController } from '../core/MapController.js';
import { auctionSystem } from '../features/AuctionSystem.js';

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
        
        // 다른 패널들 닫기
        this.closeOtherPanels();
        
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
     * 다른 패널들 닫기
     */
    closeOtherPanels() {
        // TerritoryPanel 닫기
        const territoryPanel = document.getElementById('territory-panel');
        if (territoryPanel) {
            territoryPanel.classList.add('hidden');
        }
        
        // RankingBoard 닫기
        const rankingBoard = document.getElementById('ranking-board');
        if (rankingBoard) {
            rankingBoard.classList.add('hidden');
        }
        
        // RecommendationPanel 닫기
        const recommendationPanel = document.getElementById('recommendation-panel');
        if (recommendationPanel) {
            recommendationPanel.classList.add('hidden');
        }
        
        // TimelineWidget 닫기
        const timelineWidget = document.getElementById('timeline-widget');
        if (timelineWidget) {
            timelineWidget.classList.add('hidden');
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
        log.info(`[TerritoryListPanel] 🔍 handleItemClick called with territoryId: ${territoryId}`);
        
        // ⚠️ 중요: auction 정보를 최우선으로 확인 (auction에 country 정보가 저장되어 있음)
        // auction의 country 정보가 가장 정확하므로 먼저 확인
        let expectedCountry = null;
        let expectedSourceId = null;
        const auction = auctionSystem.getAuctionByTerritory(territoryId);
        
        if (auction) {
            // auction 객체에 직접 country 정보가 저장되어 있으면 사용 (최우선)
            expectedCountry = auction.country || auction.countryIso;
            
            // auction.country가 ISO 코드인 경우 slug로 변환
            if (expectedCountry && expectedCountry.length === 3 && expectedCountry === expectedCountry.toUpperCase()) {
                const isoToSlugMap = territoryManager.createIsoToSlugMap();
                expectedCountry = isoToSlugMap[expectedCountry] || expectedCountry;
            }
            
            log.info(`[TerritoryListPanel] ✅ Got country from auction: ${expectedCountry} (auctionId: ${auction.id})`);
        }
        
        // auction에 country가 없으면 TerritoryListPanel의 territory 배열에서 가져오기
        if (!expectedCountry) {
            const territoryFromList = this.territories.find(t => t.id === territoryId);
            expectedCountry = territoryFromList?.country;
            expectedSourceId = territoryFromList?.sourceId;
            if (expectedCountry) {
                log.debug(`[TerritoryListPanel] Got country from territory list: ${expectedCountry}`);
            }
        }
        
        // TerritoryManager에서도 확인 (fallback)
        if (!expectedCountry) {
            const territoryFromManager = territoryManager.getTerritory(territoryId);
            expectedCountry = territoryFromManager?.country;
            if (!expectedSourceId) {
                expectedSourceId = territoryFromManager?.sourceId;
            }
            if (expectedCountry) {
                log.debug(`[TerritoryListPanel] Got country from TerritoryManager: ${expectedCountry}`);
            }
        }
        
        // auction이 있지만 country가 없으면, auction.territoryId로 territory 찾기 시도
        if (auction && !expectedCountry) {
            const auctionTerritory = territoryManager.getTerritory(auction.territoryId);
            if (auctionTerritory?.country) {
                expectedCountry = auctionTerritory.country;
                log.debug(`[TerritoryListPanel] Got country from auction territory: ${expectedCountry}`);
            }
        }
        
        // country가 없으면 territoryId에서 추출 시도 (예: "singapore-0" -> "singapore")
        // 하지만 "south-east"는 국가 코드가 없으므로 다른 방법 필요
        if (!expectedCountry) {
            const territoryIdParts = territoryId.split('-');
            if (territoryIdParts.length > 1) {
                const possibleCountryCode = territoryIdParts[0];
                if (CONFIG.COUNTRIES[possibleCountryCode]) {
                    expectedCountry = possibleCountryCode;
                    log.debug(`[TerritoryListPanel] Extracted country from territoryId: ${expectedCountry}`);
                }
            }
        }
        
        log.info(`[TerritoryListPanel] 🔍 Final territory info: id=${territoryId}, country=${expectedCountry || 'UNKNOWN'}, sourceId=${expectedSourceId || 'N/A'}, hasAuction=${!!auction}`);
        
        // ⚠️ 중요: 맵에서 직접 feature를 찾아서 선택 (TerritoryManager를 거치지 않음)
        // TerritoryManager의 territory.id가 클릭한 territoryId와 다를 수 있음
        const map = mapController.map;
        if (!map) {
            log.error(`[TerritoryListPanel] Map not available`);
            return;
        }
        
        log.debug(`[TerritoryListPanel] Searching for territory ${territoryId} in map sources...`);
        const allSources = Object.keys(map.getStyle().sources || {});
        log.debug(`[TerritoryListPanel] Found ${allSources.length} sources: ${allSources.join(', ')}`);
        
        // expectedSourceId가 있으면 우선 검색
        const sourcePriority = expectedSourceId ? [expectedSourceId, ...allSources.filter(s => s !== expectedSourceId)] : allSources;
        
        for (const sourceId of sourcePriority) {
            try {
                const source = map.getSource(sourceId);
                if (!source || source.type !== 'geojson' || !source._data) {
                    continue;
                }
                
                const features = source._data.features || [];
                log.debug(`[TerritoryListPanel] Checking source ${sourceId} with ${features.length} features`);
                
                // 여러 방법으로 feature 찾기 (country 정보로 필터링)
                const matchingFeatures = features.filter(f => {
                    const propsId = f.properties?.id || f.properties?.territoryId;
                    const featureId = f.id;
                    const featureName = f.properties?.name || f.properties?.name_en || f.properties?.NAME_1 || '';
                    const featureCountry = f.properties?.adm0_a3 || f.properties?.country;
                    
                    // 1. 직접 매칭
                    if (String(propsId) === String(territoryId)) {
                        return true;
                    }
                    if (String(featureId) === String(territoryId)) {
                        return true;
                    }
                    
                    // 2. world- 접두사 제거 후 매칭
                    const cleanTerritoryId = String(territoryId).replace(/^world-/, '');
                    const cleanPropsId = String(propsId || '').replace(/^world-/, '');
                    if (cleanPropsId && cleanPropsId === cleanTerritoryId) {
                        return true;
                    }
                    
                    // 3. properties.name 기반 매칭 (정규화된 이름)
                    if (featureName) {
                        const normalizedName = featureName.toLowerCase()
                            .trim()
                            .replace(/[^\w\s-]/g, '')
                            .replace(/\s+/g, '-')
                            .replace(/-+/g, '-')
                            .replace(/^-|-$/g, '');
                        const normalizedTerritoryId = String(territoryId).toLowerCase();
                        if (normalizedName === normalizedTerritoryId) {
                            return true;
                        }
                    }
                    
                    return false;
                });
                
                // 여러 feature가 매칭되면 country로 필터링
                let feature = null;
                if (matchingFeatures.length === 1) {
                    feature = matchingFeatures[0];
                    log.info(`[TerritoryListPanel] ✅ Found single matching feature in ${sourceId}`);
                } else if (matchingFeatures.length > 1) {
                    log.warn(`[TerritoryListPanel] ⚠️ Found ${matchingFeatures.length} matching features for ${territoryId}, filtering by country: ${expectedCountry || 'UNKNOWN'}`);
                    
                    // expectedCountry가 반드시 있어야 함 (없으면 오류)
                    if (!expectedCountry) {
                        log.error(`[TerritoryListPanel] ❌ CRITICAL: No country info for ${territoryId} but ${matchingFeatures.length} features matched!`);
                        // country 정보가 없으면 첫 번째 매칭 사용 (하지만 경고)
                        feature = matchingFeatures[0];
                        log.warn(`[TerritoryListPanel] ⚠️ Using first match as fallback (may be wrong country!)`);
                    } else {
                        const isoToSlugMap = territoryManager.createIsoToSlugMap();
                        
                        // 각 매칭 feature의 country 정보 로그
                        matchingFeatures.forEach((f, idx) => {
                            const featureCountryIso = f.properties?.adm0_a3;
                            const featureCountrySlug = featureCountryIso ? isoToSlugMap[featureCountryIso.toUpperCase()] : null;
                            const featureName = f.properties?.name || f.properties?.name_en || 'N/A';
                            log.debug(`[TerritoryListPanel] Matching feature ${idx}: name=${featureName}, ISO=${featureCountryIso || 'N/A'}, slug=${featureCountrySlug || f.properties?.country || 'N/A'}`);
                        });
                        
                        feature = matchingFeatures.find(f => {
                            const featureCountryIso = f.properties?.adm0_a3;
                            if (featureCountryIso) {
                                const featureCountrySlug = isoToSlugMap[featureCountryIso.toUpperCase()];
                                if (featureCountrySlug === expectedCountry) {
                                    log.debug(`[TerritoryListPanel] ✅ Matched by ISO: ${featureCountryIso} -> ${featureCountrySlug} === ${expectedCountry}`);
                                    return true;
                                }
                            }
                            const featureCountrySlug = f.properties?.country;
                            if (featureCountrySlug === expectedCountry) {
                                log.debug(`[TerritoryListPanel] ✅ Matched by slug: ${featureCountrySlug} === ${expectedCountry}`);
                                return true;
                            }
                            return false;
                        });
                        
                        if (feature) {
                            const matchedCountryIso = feature.properties?.adm0_a3;
                            const matchedCountrySlug = matchedCountryIso ? isoToSlugMap[matchedCountryIso.toUpperCase()] : feature.properties?.country;
                            log.info(`[TerritoryListPanel] ✅ Filtered to correct feature by country: ${expectedCountry} (matched: ${matchedCountrySlug || matchedCountryIso || 'N/A'})`);
                        } else {
                            log.error(`[TerritoryListPanel] ❌ CRITICAL: Could not filter by country ${expectedCountry}! Available countries: ${matchingFeatures.map(f => {
                                const iso = f.properties?.adm0_a3;
                                const slug = iso ? isoToSlugMap[iso.toUpperCase()] : f.properties?.country;
                                return slug || iso || 'unknown';
                            }).join(', ')}`);
                            // country로 필터링 실패 시 첫 번째 매칭 사용 (하지만 경고)
                            feature = matchingFeatures[0];
                            log.warn(`[TerritoryListPanel] ⚠️ Using first match as fallback (may be wrong country!)`);
                        }
                    }
                }
                
                if (feature) {
                    log.info(`[TerritoryListPanel] ✅ Found feature in map for ${territoryId} in source ${sourceId}, name: ${feature.properties?.name || feature.properties?.name_en || 'N/A'}, country: ${feature.properties?.adm0_a3 || feature.properties?.country || 'N/A'}`);
                    
                    // territory 선택
                    mapController.selectTerritory(sourceId, feature);
                    
                    // 맵 이동: territory의 center 계산 후 flyTo
                    let center = null;
                    if (feature.geometry) {
                        center = this.calculateTerritoryCenter(feature);
                    }
                    
                    // center가 없으면 country center로 이동
                    if (!center) {
                        const countryCode = feature.properties?.adm0_a3 ? 
                            territoryManager.createIsoToSlugMap()[feature.properties.adm0_a3.toUpperCase()] : 
                            feature.properties?.country;
                        if (countryCode && CONFIG.COUNTRIES[countryCode]) {
                            center = CONFIG.COUNTRIES[countryCode].center;
                            log.debug(`[TerritoryListPanel] Using country center for ${countryCode}: ${center}`);
                        }
                    }
                    
                    if (center) {
                        mapController.flyTo(center, 8);
                        log.debug(`[TerritoryListPanel] Flying to territory center: ${center}`);
                    } else {
                        log.warn(`[TerritoryListPanel] Could not determine center for territory ${territoryId}`);
                    }
                    
                    this.close();
                    return;
                }
            } catch (error) {
                // 소스 접근 실패 시 무시
                log.debug(`[TerritoryListPanel] Error accessing source ${sourceId}: ${error.message}`);
            }
        }
        
        log.warn(`[TerritoryListPanel] ⚠️ Could not find feature in map for ${territoryId}, falling back to TerritoryManager`);
        
        // 맵에서 찾지 못한 경우 TerritoryManager에서 찾기 (fallback)
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory) {
            log.warn(`[TerritoryListPanel] Territory ${territoryId} not found in map or TerritoryManager`);
            return;
        }
        
        log.debug(`[TerritoryListPanel] Found territory in TerritoryManager: ${territory.id}, name: ${this.extractName(territory.name)}, country: ${territory.country}`);
        
        // sourceId와 featureId가 없으면 맵에서 찾기
        if (!territory.sourceId || !territory.featureId) {
            // 맵의 모든 source에서 territory 찾기
            const map = mapController.map;
            if (map) {
                const allSources = Object.keys(map.getStyle().sources || {});
                for (const sourceId of allSources) {
                    try {
                        const source = map.getSource(sourceId);
                        if (source && source.type === 'geojson' && source._data) {
                            const feature = source._data.features?.find(f => 
                                String(f.properties?.id) === String(territoryId) ||
                                String(f.properties?.territoryId) === String(territoryId) ||
                                String(f.id) === String(territoryId)
                            );
                            if (feature) {
                                territory.sourceId = sourceId;
                                territory.featureId = feature.id;
                                log.debug(`[TerritoryListPanel] Found sourceId and featureId for ${territoryId}: ${sourceId}, ${feature.id}`);
                                break;
                            }
                        }
                    } catch (error) {
                        // 소스 접근 실패 시 무시
                    }
                }
            }
        }
        
        // 해당 영토로 이동
        let center = territory.center;
        
        // center가 없으면 geometry에서 계산
        if (!center && territory.sourceId && territory.featureId) {
            center = this.calculateTerritoryCenter(territory);
        }
        
        // center가 여전히 없으면 territoryId에서 국가 코드 추출하여 국가 중심으로 이동
        if (!center) {
            const territoryIdParts = territoryId.split('-');
            if (territoryIdParts.length > 0) {
                const possibleCountryCode = territoryIdParts[0];
                const country = CONFIG.COUNTRIES[possibleCountryCode];
                if (country && country.center) {
                    center = country.center;
                    log.debug(`[TerritoryListPanel] Using country center for ${territoryId}: ${possibleCountryCode}`);
                }
            }
        }
        
        // center가 있으면 이동
        if (center) {
            mapController.flyTo(center, 8);
        } else {
            log.warn(`[TerritoryListPanel] Could not determine center for ${territoryId}`);
        }
        
        // 맵에서 직접 feature를 찾아서 선택 (더 정확함)
        if (territory.sourceId && territory.featureId) {
            const map = mapController.map;
            if (map) {
                try {
                    const source = map.getSource(territory.sourceId);
                    if (source && source.type === 'geojson' && source._data) {
                        const feature = source._data.features?.find(f => 
                            String(f.id) === String(territory.featureId) ||
                            String(f.properties?.id) === String(territoryId) ||
                            String(f.properties?.territoryId) === String(territoryId)
                        );
                        if (feature) {
                            log.debug(`[TerritoryListPanel] Selecting territory directly from map: ${territoryId}`);
                            mapController.selectTerritory(territory.sourceId, feature);
                            this.close();
                            return;
                        }
                    }
                } catch (error) {
                    log.warn(`[TerritoryListPanel] Failed to select territory from map: ${error.message}`);
                }
            }
        }
        
        // 맵에서 직접 선택 실패 시 이벤트로 선택
        // ⚠️ territory.id가 원래 클릭한 territoryId와 다를 수 있으므로 원본 territoryId 사용
        // ⚠️ 전문가 조언 반영: TERRITORY_CLICKED (입력) 이벤트 발행
        log.info(`[TerritoryListPanel] 🎯 [TerritoryListPanel → TERRITORY_CLICKED] Emitting TERRITORY_CLICKED event for ${territoryId}`);
        eventBus.emit(EVENTS.TERRITORY_CLICKED, { 
            territory,
            territoryId: territoryId, // 원본 territoryId 사용 (territory.id가 아닌)
            sourceId: territory.sourceId,
            featureId: territory.featureId,
            properties: territory.properties,
            geometry: territory.geometry,
            country: territory.country
        });
        
        log.debug(`[TerritoryListPanel] Emitted TERRITORY_SELECT for ${territoryId}, territory.id: ${territory.id}`);
        
        // 패널 닫기
        this.close();
    }
    
    /**
     * 영토 geometry에서 중심점 계산
     */
    calculateTerritoryCenter(territory) {
        try {
            const map = mapController.map;
            if (!map || !territory.sourceId || !territory.featureId) return null;
            
            const source = map.getSource(territory.sourceId);
            if (!source || source.type !== 'geojson') return null;
            
            const data = source._data;
            if (!data || !data.features) return null;
            
            // feature 찾기
            const feature = data.features.find(f => 
                String(f.id) === String(territory.featureId) ||
                String(f.properties?.id) === String(territory.id)
            );
            
            if (!feature || !feature.geometry) return null;
            
            // bounds 계산
            const bounds = this.calculateBounds(feature.geometry);
            if (!bounds) return null;
            
            // 중심점 계산
            const centerLng = (bounds.minLng + bounds.maxLng) / 2;
            const centerLat = (bounds.minLat + bounds.maxLat) / 2;
            
            return [centerLng, centerLat];
        } catch (error) {
            log.warn(`Failed to calculate territory center for ${territory.id}:`, error);
            return null;
        }
    }
    
    /**
     * geometry에서 bounds 계산
     */
    calculateBounds(geometry) {
        if (!geometry || !geometry.coordinates) return null;
        
        let minLng = Infinity, maxLng = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        
        const processCoordinates = (coords) => {
            if (Array.isArray(coords[0])) {
                coords.forEach(processCoordinates);
            } else if (coords.length >= 2) {
                const [lng, lat] = coords;
                minLng = Math.min(minLng, lng);
                maxLng = Math.max(maxLng, lng);
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
            }
        };
        
        try {
            if (geometry.type === 'Polygon') {
                geometry.coordinates.forEach(processCoordinates);
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates.forEach(polygon => {
                    polygon.forEach(processCoordinates);
                });
            } else if (geometry.type === 'Point') {
                const [lng, lat] = geometry.coordinates;
                return { minLng: lng, maxLng: lng, minLat: lat, maxLat: lat };
            }
            
            if (minLng === Infinity || maxLng === -Infinity || minLat === Infinity || maxLat === -Infinity) {
                return null;
            }
            
            return { minLng, maxLng, minLat, maxLat };
        } catch (error) {
            log.warn('Failed to calculate bounds:', error);
            return null;
        }
    }
    
    /**
     * 이름 추출
     */
    extractName(name) {
        if (!name) return null;
        
        // 문자열인 경우 JSON 형식인지 확인
        if (typeof name === 'string') {
            // Check if it's a JSON format string (e.g. '{"ko":"Texas","en":"Texas"}')
            if (name.trim().startsWith('{') && name.trim().endsWith('}')) {
                try {
                    const parsed = JSON.parse(name);
                    if (typeof parsed === 'object' && parsed !== null) {
                        // 언어 우선순위: 현재 언어 > en > ko > local > 첫 번째 값
                        const lang = this.lang || 'en';
                        return parsed[lang] || parsed.en || parsed.ko || parsed.local || Object.values(parsed)[0] || name;
                    }
                } catch (e) {
                    // JSON 파싱 실패 시 원본 문자열 반환
                    return name;
                }
            }
            return name;
        }
        
        // 객체인 경우
        if (typeof name === 'object' && name !== null) {
            // 언어 우선순위: 현재 언어 > en > ko > local > 첫 번째 값
            const lang = this.lang || 'en';
            return name[lang] || name.en || name.ko || name.local || Object.values(name)[0] || null;
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
            return `${(price / 1000000).toFixed(1)}M pt`;
        }
        if (price >= 1000) {
            return `${(price / 1000).toFixed(0)}K pt`;
        }
        return `${price} pt`;
    }
}

// 싱글톤 인스턴스 생성 및 export
const territoryListPanel = new TerritoryListPanel();
export { territoryListPanel };
export default territoryListPanel;

