/**
 * RankingBoard - Top Spaces & Top Owners 디스커버리 보드
 * 광고/아트/소유 플랫폼의 큐레이션 도구
 * 게임 랭킹이 아닌 "멋있는 공간·픽셀들을 발견하게 해주는 쇼룸"
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { rankingSystem, RANKING_TYPE } from '../features/RankingSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager } from '../core/TerritoryManager.js';
import { pixelDataService } from '../services/PixelDataService.js';

class RankingBoard {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTab = 'global_coverage'; // 기본 탭 변경
        this.userProfilesCache = new Map(); // 사용자 프로필 캐시
        this.thumbnailCache = new Map(); // 썸네일 캐시 (userId -> thumbnail URL)
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'ranking-board') {
        this.container = document.getElementById(containerId);
        
        if (this.container) {
            this.render();
            this.setupEventListeners();
        }
        
        log.info('RankingBoard initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 랭킹 업데이트 이벤트 (무한 루프 방지)
        this.isRefreshing = false;
        eventBus.on(EVENTS.RANKING_UPDATE, () => {
            if (!this.isRefreshing) {
                this.updateUI();
            }
        });
    }
    
    /**
     * 탭 버튼 이벤트 리스너 설정
     */
    setupTabListeners() {
        // 컨테이너 내의 모든 탭 버튼에 이벤트 리스너 추가
        const tabs = this.container?.querySelectorAll('.ranking-tab') || [];
        tabs.forEach(tab => {
            // 기존 리스너가 있으면 제거 (중복 방지)
            const existingHandler = tab._tabClickHandler;
            if (existingHandler) {
                tab.removeEventListener('click', existingHandler);
            }
            
            // 새 핸들러 생성 및 저장
            const handler = async () => {
                const tabName = tab.dataset.tab;
                if (tabName) {
                    await this.switchTab(tabName);
                }
            };
            tab._tabClickHandler = handler;
            tab.addEventListener('click', handler);
        });
    }
    
    /**
     * 렌더링
     */
    render() {
        if (!this.container) return;
        
        this.container.innerHTML = `
            <div class="ranking-header">
                <h3 class="ranking-title" id="ranking-title" style="cursor: pointer;">🌟 Top Spaces</h3>
                <div class="ranking-header-buttons">
                    <button class="ranking-refresh-btn" id="ranking-refresh" title="Refresh">🔄</button>
                    <button class="ranking-close-btn" id="ranking-close" title="Close">×</button>
                </div>
            </div>
            
            <div class="ranking-tabs">
                <button class="ranking-tab active" data-tab="global_coverage">Coverage</button>
                <button class="ranking-tab" data-tab="most_viewed">Trending</button>
                <button class="ranking-tab" data-tab="collectors">Collectors</button>
                <button class="ranking-tab" data-tab="galleries">Galleries</button>
                <button class="ranking-tab" data-tab="investors">Creators</button>
            </div>
            
            <div class="ranking-content">
                <div class="ranking-list" id="ranking-list">
                    ${this.renderGlobalCoverageRanking()}
                </div>
            </div>
            
            <div class="my-ranking" id="my-ranking">
                ${this.renderMyRanking()}
            </div>
        `;
        
        // 새로고침 버튼
        document.getElementById('ranking-refresh')?.addEventListener('click', () => {
            this.refresh();
        });
        
        // 닫기 버튼
        document.getElementById('ranking-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });
        
        // 제목 클릭 → 전체 화면 모달
        document.getElementById('ranking-title')?.addEventListener('click', () => {
            this.openFullScreen();
        });
        
        // 탭 버튼 이벤트 리스너 설정
        this.setupTabListeners();
    }
    
    /**
     * 탭 전환
     */
    async switchTab(tabName) {
        this.currentTab = tabName;
        
        // 탭 활성화 상태 업데이트
        this.container.querySelectorAll('.ranking-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        
        // 콘텐츠 업데이트
        const listContainer = document.getElementById('ranking-list');
        if (!listContainer) {
            log.warn('[RankingBoard] ranking-list container not found');
            return;
        }
        
        // 로딩 상태 표시
        listContainer.innerHTML = '<div class="ranking-empty">Loading...</div>';
        
        try {
            switch (tabName) {
                case 'global_coverage':
                    listContainer.innerHTML = await this.renderGlobalCoverageRanking();
                    break;
                case 'most_viewed':
                    const mostViewedHtml = await this.renderMostViewedRanking();
                    listContainer.innerHTML = mostViewedHtml;
                    break;
                case 'collectors':
                    listContainer.innerHTML = this.renderCollectorsRanking();
                    break;
                case 'galleries':
                    listContainer.innerHTML = this.renderGalleriesRanking();
                    break;
                case 'investors':
                    listContainer.innerHTML = this.renderInvestorsRanking();
                    break;
                default:
                    listContainer.innerHTML = '<div class="ranking-empty">Unknown tab</div>';
            }
        } catch (error) {
            log.error('[RankingBoard] Failed to switch tab:', error);
            listContainer.innerHTML = '<div class="ranking-empty">Failed to load data.<br><small>Please try again.</small></div>';
        }
    }
    
    /**
     * Global Coverage Index 랭킹 렌더링 (카드 기반)
     */
    renderGlobalCoverageRanking() {
        const board = rankingSystem.getGlobalCoverageBoard();
        
        if (board.length === 0) {
            return '<div class="ranking-empty">No spaces claimed yet.</div>';
        }
        
        // 프로필 일괄 로드
        const userIds = board.map(entry => entry.userId).filter(Boolean);
        this.loadUserProfilesBatch(userIds);
        
        return board.map((entry, index) => this.renderOwnerCard(entry, index + 1, 'global_coverage')).join('');
    }
    
    /**
     * Most Viewed Spaces 랭킹 렌더링 (영토 기준)
     */
    async renderMostViewedRanking() {
        try {
            log.debug('[RankingBoard] Loading most viewed territories...');
            const territories = await rankingSystem.getMostViewedTerritories(10);
            
            log.debug('[RankingBoard] Most viewed territories loaded:', territories.length);
            
            if (!territories || territories.length === 0) {
                return '<div class="ranking-empty">No views tracked yet.<br><small>Click on territories to start tracking views!</small></div>';
            }
            
            // 사용자 프로필 일괄 로드
            const userIds = territories.map(t => t.ruler).filter(Boolean);
            if (userIds.length > 0) {
                this.loadUserProfilesBatch(userIds);
            }
            
            return territories.map((territory, index) => {
                const countryInfo = CONFIG.COUNTRIES[territory.countryCode] || { flag: '🏳️', name: territory.countryCode || 'Unknown' };
                const ownerName = territory.ruler ? this.getDisplayName(territory.ruler) : 'Available';
                
                return `
                    <div class="owner-card territory-card ${this.getRankClass(index + 1)}" data-territory-id="${territory.territoryId}">
                        <div class="owner-card-header">
                            <div class="owner-rank-badge">${this.getRankBadge(index + 1)}</div>
                            <div class="owner-info">
                                <div class="owner-name">${territory.territoryName || territory.territoryId}</div>
                                <div class="owner-tag">${countryInfo.flag} ${countryInfo.name}</div>
                            </div>
                        </div>
                        <div class="owner-card-body">
                            <div class="owner-metrics">
                                <div class="metric-item">
                                    <span class="metric-label">Views</span>
                                    <span class="metric-value">${this.formatNumber(territory.viewCount || 0)}</span>
                                </div>
                                <div class="metric-item">
                                    <span class="metric-label">Owner</span>
                                    <span class="metric-value">${ownerName}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (error) {
            log.error('[RankingBoard] Failed to render most viewed ranking:', error);
            return '<div class="ranking-empty">Failed to load trending spaces.<br><small>Please try again later.</small></div>';
        }
    }
    
    /**
     * Top Collectors 랭킹 렌더링
     */
    renderCollectorsRanking() {
        const rankings = rankingSystem.getRankingByType(RANKING_TYPE.TERRITORY_COUNT, 10);
        
        if (rankings.length === 0) {
            return '<div class="ranking-empty">No data available.</div>';
        }
        
        // 프로필 일괄 로드
        const userIds = rankings.map(entry => entry.userId).filter(Boolean);
        this.loadUserProfilesBatch(userIds);
        
        return rankings.map((entry, index) => this.renderOwnerCard(entry, index + 1, 'collectors')).join('');
    }
    
    /**
     * Largest Galleries 랭킹 렌더링
     */
    renderGalleriesRanking() {
        const rankings = rankingSystem.getRankingByType(RANKING_TYPE.PIXEL_COVERAGE, 10);
        
        if (rankings.length === 0) {
            return '<div class="ranking-empty">No data available.</div>';
        }
        
        // 프로필 일괄 로드
        const userIds = rankings.map(entry => entry.userId).filter(Boolean);
        this.loadUserProfilesBatch(userIds);
        
        return rankings.map((entry, index) => this.renderOwnerCard(entry, index + 1, 'galleries')).join('');
    }
    
    /**
     * Top Creators 랭킹 렌더링
     */
    renderInvestorsRanking() {
        const rankings = rankingSystem.getRankingByType(RANKING_TYPE.TOTAL_VALUE, 10);
        
        if (rankings.length === 0) {
            return '<div class="ranking-empty">No data available.</div>';
        }
        
        // 프로필 일괄 로드
        const userIds = rankings.map(entry => entry.userId).filter(Boolean);
        this.loadUserProfilesBatch(userIds);
        
        return rankings.map((entry, index) => this.renderOwnerCard(entry, index + 1, 'investors')).join('');
    }
    
    /**
     * 오너 카드 렌더링 (카드 기반 쇼케이스)
     */
    renderOwnerCard(entry, rank, tabType) {
        // 프로필 정보 가져오기 (캐시에서)
        const profile = this.userProfilesCache.get(entry.userId);
        const userName = profile 
            ? (profile.displayName || profile.userName || profile.email?.split('@')[0] || entry.userId)
            : this.getDisplayName(entry.userId);
        const photoURL = profile?.photoURL || null;
        
        const rankBadge = this.getRankBadge(rank);
        const tag = this.getTagForTab(tabType, rank);
        
        // 썸네일 가져오기 (캐시 확인)
        const thumbnail = this.thumbnailCache.get(entry.userId);
        
        // 국가 플래그 표시
        const countryFlags = this.getCountryFlags(entry.countries || []);
        
        // 메인 지표 (탭별로 다름)
        const mainMetric = this.getMainMetric(entry, tabType);
        
        // 썸네일 로드 (비동기)
        if (!thumbnail && entry.userId) {
            this.loadThumbnail(entry.userId).catch(() => {
                // 실패해도 무시
            });
        }
        
        return `
            <div class="owner-card ${this.getRankClass(rank)}" data-user-id="${entry.userId}">
                ${thumbnail ? `
                    <div class="owner-thumbnail">
                        <img src="${thumbnail}" alt="${userName}'s gallery" onerror="this.style.display='none'">
                    </div>
                ` : ''}
                <div class="owner-card-header">
                    <div class="owner-rank-badge">${rankBadge}</div>
                    ${photoURL ? `
                        <div class="owner-avatar">
                            <img src="${photoURL}" alt="${userName}" onerror="this.style.display='none'">
                        </div>
                    ` : ''}
                    <div class="owner-info">
                        <div class="owner-name">${userName}</div>
                        <div class="owner-tag">${tag}</div>
                    </div>
                </div>
                <div class="owner-card-body">
                    <div class="owner-metrics">
                        <div class="metric-item">
                            <span class="metric-label">Spots</span>
                            <span class="metric-value">${entry.territoryCount || 0}</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Pixels</span>
                            <span class="metric-value">${this.formatNumber(entry.totalPixels || 0)}</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">${tabType === 'investors' ? 'Total Value' : 'Coverage'}</span>
                            <span class="metric-value">${mainMetric}</span>
                        </div>
                    </div>
                    ${countryFlags ? `<div class="owner-countries">${countryFlags}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    /**
     * 사용자의 대표 픽셀 아트 썸네일 로드
     */
    async loadThumbnail(userId) {
        if (!userId || this.thumbnailCache.has(userId)) {
            return;
        }
        
        try {
            // 사용자가 소유한 영토 중 픽셀 아트가 있는 영토 찾기
            const userTerritories = territoryManager.getTerritoriesByUser(userId);
            if (!userTerritories || userTerritories.length === 0) {
                return;
            }
            
            // 픽셀 아트가 있는 영토 찾기 (가장 많은 픽셀 수를 가진 것)
            let bestTerritory = null;
            let maxPixels = 0;
            
            for (const territory of userTerritories) {
                if (territory.pixelCanvas?.filledPixels > maxPixels) {
                    maxPixels = territory.pixelCanvas.filledPixels;
                    bestTerritory = territory;
                }
            }
            
            if (!bestTerritory) {
                return;
            }
            
            // 픽셀 데이터 로드
            const pixelData = await pixelDataService.loadPixelData(bestTerritory.id);
            if (!pixelData || !pixelData.pixels || pixelData.pixels.length === 0) {
                return;
            }
            
            // 썸네일 생성 (64x64 크기로 축소)
            const thumbnail = await this.generateThumbnail(pixelData);
            if (thumbnail) {
                this.thumbnailCache.set(userId, thumbnail);
                // 썸네일 로드 후 UI 업데이트
                this.updateUI();
            }
        } catch (error) {
            log.warn(`[RankingBoard] Failed to load thumbnail for ${userId}:`, error);
        }
    }
    
    /**
     * 픽셀 데이터를 썸네일 이미지로 변환
     */
    async generateThumbnail(pixelData) {
        try {
            const width = pixelData.width || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            const height = pixelData.height || CONFIG.TERRITORY.PIXEL_GRID_SIZE;
            const thumbnailSize = 64; // 썸네일 크기
            
            // Canvas 생성
            const canvas = document.createElement('canvas');
            canvas.width = thumbnailSize;
            canvas.height = thumbnailSize;
            const ctx = canvas.getContext('2d', { alpha: true });
            
            // 픽셀 그리기 (축소)
            const scaleX = thumbnailSize / width;
            const scaleY = thumbnailSize / height;
            
            if (pixelData.pixels && Array.isArray(pixelData.pixels)) {
                for (const pixel of pixelData.pixels) {
                    const x = pixel.x;
                    const y = pixel.y;
                    const color = pixel.c || pixel.color;
                    
                    if (x >= 0 && x < width && y >= 0 && y < height && color) {
                        ctx.fillStyle = color;
                        ctx.fillRect(
                            Math.floor(x * scaleX),
                            Math.floor(y * scaleY),
                            Math.ceil(scaleX),
                            Math.ceil(scaleY)
                        );
                    }
                }
            }
            
            // 이미지로 변환
            return canvas.toDataURL('image/png');
        } catch (error) {
            log.warn('[RankingBoard] Failed to generate thumbnail:', error);
            return null;
        }
    }
    
    /**
     * 표시 이름 가져오기 (프로필 캐시 사용)
     */
    getDisplayName(userId) {
        if (!userId) return 'Anonymous';
        
        // 캐시에서 확인
        const profile = this.userProfilesCache.get(userId);
        if (profile) {
            // displayName, userName, email 순서로 확인
            if (profile.displayName) return profile.displayName;
            if (profile.userName) return profile.userName;
            if (profile.email) return profile.email.split('@')[0];
        }
        
        // 캐시에 없으면 비동기로 로드 (이번 렌더링에는 기본값 사용)
        if (!this.userProfilesCache.has(userId)) {
            this.loadUserProfile(userId).catch(() => {
                // 실패해도 무시 (다음 렌더링에서 재시도)
            });
        }
        
        // 기본값: userId를 짧게 표시
        if (userId.length > 20) {
            return userId.substring(0, 10) + '...';
        }
        return userId;
    }
    
    /**
     * 사용자 프로필 로드 (비동기)
     */
    async loadUserProfile(userId) {
        if (!userId || this.userProfilesCache.has(userId)) {
            return;
        }
        
        try {
            const profile = await firebaseService.getUserProfile(userId);
            if (profile) {
                this.userProfilesCache.set(userId, profile);
                // 프로필 로드 후 UI 업데이트
                this.updateUI();
            }
        } catch (error) {
            log.warn(`[RankingBoard] Failed to load profile for ${userId}:`, error);
        }
    }
    
    /**
     * 여러 사용자 프로필 일괄 로드
     */
    async loadUserProfilesBatch(userIds) {
        const missingIds = userIds.filter(id => id && !this.userProfilesCache.has(id));
        if (missingIds.length === 0) return;
        
        try {
            log.debug('[RankingBoard] Loading profiles for users:', missingIds);
            const profiles = await firebaseService.getUserProfilesBatch(missingIds);
            
            let updated = false;
            profiles.forEach((profile, userId) => {
                if (profile) {
                    this.userProfilesCache.set(userId, profile);
                    updated = true;
                    log.debug(`[RankingBoard] Loaded profile for ${userId}:`, profile.displayName || profile.userName || userId);
                }
            });
            
            // 프로필 로드 후 UI 업데이트 (비동기로 처리하여 무한 루프 방지)
            if (updated) {
                // 약간의 지연 후 업데이트 (렌더링 완료 후)
                setTimeout(() => {
                    this.updateUI();
                }, 100);
            }
        } catch (error) {
            log.warn('[RankingBoard] Failed to load profiles batch:', error);
        }
    }
    
    /**
     * 랭크 배지
     */
    getRankBadge(rank) {
        const icons = { 1: '🥇', 2: '🥈', 3: '🥉' };
        return icons[rank] || `#${rank}`;
    }
    
    /**
     * 탭별 태그
     */
    getTagForTab(tabType, rank) {
        const tags = {
            'global_coverage': rank <= 3 ? '🌟 Global Leader' : '🌍 Global Coverage',
            'collectors': rank <= 3 ? '🏆 Top Collector' : '📦 Collector',
            'galleries': rank <= 3 ? '🎨 Gallery Master' : '🖼️ Gallery Owner',
            'investors': rank <= 3 ? '🎨 Top Creator' : '✨ Creator'
        };
        return tags[tabType] || '';
    }
    
    /**
     * 메인 지표 (탭별)
     */
    getMainMetric(entry, tabType) {
        switch (tabType) {
            case 'global_coverage':
                return this.formatScore(entry.globalCoverageIndex || entry.hegemonyScore || 0);
            case 'most_viewed':
                return `${this.formatNumber(entry.totalViews || 0)} views`;
            case 'collectors':
                return `${entry.territoryCount || 0} spots`;
            case 'galleries':
                return `${this.formatNumber(entry.totalPixels || 0)} px²`;
            case 'investors':
                return `${this.formatNumber(entry.totalValue || 0)} pt`;
            default:
                return '-';
        }
    }
    
    /**
     * 국가 플래그 표시
     */
    getCountryFlags(countries) {
        if (!countries || countries.length === 0) return '';
        
        const flags = countries.slice(0, 5).map(code => {
            const countryInfo = CONFIG.COUNTRIES[code] || { flag: '🏳️', name: code };
            return `<span class="country-flag-badge" title="${countryInfo.name}">${countryInfo.flag}</span>`;
        }).join('');
        
        const more = countries.length > 5 ? `+${countries.length - 5}` : '';
        return `<div class="country-flags">${flags}${more ? `<span class="more-countries">${more}</span>` : ''}</div>`;
    }
    
    /**
     * 내 랭킹 렌더링 (리포트 카드 형태)
     */
    renderMyRanking() {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            return `
                <div class="my-ranking-login">
                    <span>Sign in to see your portfolio</span>
                </div>
            `;
        }
        
        const myRanking = rankingSystem.getUserRanking(user.uid);
        const globalRank = rankingSystem.getUserGlobalRank(user.uid);
        const percentile = rankingSystem.getUserRankPercentile(user.uid);
        
        if (!myRanking) {
            return `
                <div class="my-ranking-empty">
                    <span>No spaces owned yet</span>
                    <span>Claim your first spot! 📍</span>
                </div>
            `;
        }
        
        // 리포트 카드 형태
        return `
            <div class="my-ranking-card report-card">
                <div class="report-header">
                    <span class="report-title">Your Portfolio</span>
                    ${globalRank ? `<span class="report-rank">#${globalRank}</span>` : ''}
                </div>
                <div class="report-stats">
                    <div class="report-stat">
                        <span class="stat-value">${myRanking.territoryCount || 0}</span>
                        <span class="stat-label">Spots</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${this.formatNumber(myRanking.totalPixels || 0)}</span>
                        <span class="stat-label">Pixels</span>
                    </div>
                    <div class="report-stat">
                        <span class="stat-value">${this.formatNumber(myRanking.totalValue || 0)}</span>
                        <span class="stat-label">Value (pt)</span>
                    </div>
                </div>
                ${percentile ? `
                    <div class="report-percentile">
                        <span class="percentile-label">Top ${percentile}%</span>
                        <span class="percentile-desc">of all owners</span>
                    </div>
                ` : ''}
            </div>
        `;
    }
    
    /**
     * 새로고침
     */
    async refresh() {
        this.isRefreshing = true;
        await rankingSystem.updateAllRankings();
        this.isRefreshing = false;
        this.updateUI();
    }
    
    /**
     * UI만 업데이트 (이벤트 루프 방지)
     */
    async updateUI() {
        await this.switchTab(this.currentTab);
        
        // 내 랭킹 업데이트
        const myRankingEl = document.getElementById('my-ranking');
        if (myRankingEl) {
            myRankingEl.innerHTML = this.renderMyRanking();
        }
    }
    
    /**
     * 랭크 클래스
     */
    getRankClass(rank) {
        if (rank === 1) return 'rank-1';
        if (rank === 2) return 'rank-2';
        if (rank === 3) return 'rank-3';
        return '';
    }
    
    /**
     * 점수 포맷
     */
    formatScore(score) {
        if (!score) return '0';
        if (score >= 1000000) return `${(score / 1000000).toFixed(1)}M`;
        if (score >= 1000) return `${(score / 1000).toFixed(1)}K`;
        return score.toString();
    }
    
    /**
     * 숫자 포맷
     */
    formatNumber(num) {
        if (!num) return '0';
        return num.toLocaleString();
    }
    
    /**
     * 패널 닫기
     */
    close() {
        if (this.container) {
            this.container.classList.add('hidden');
            this.isOpen = false;
        }
    }
    
    /**
     * 패널 열기
     */
    open() {
        if (this.container) {
            // 다른 패널들 닫기
            this.closeOtherPanels();
            
            this.container.classList.remove('hidden');
            this.isOpen = true;
        }
    }
    
    /**
     * 다른 패널들 닫기
     */
    closeOtherPanels() {
        const territoryPanel = document.getElementById('territory-panel');
        if (territoryPanel) {
            territoryPanel.classList.add('hidden');
        }
        
        const territoryListPanel = document.getElementById('territory-list-panel');
        if (territoryListPanel) {
            territoryListPanel.classList.add('hidden');
        }
        
        const recommendationPanel = document.getElementById('recommendation-panel');
        if (recommendationPanel) {
            recommendationPanel.classList.add('hidden');
        }
        
        const timelineWidget = document.getElementById('timeline-widget');
        if (timelineWidget) {
            timelineWidget.classList.add('hidden');
        }
    }
    
    /**
     * 전체 화면 모달로 열기
     */
    openFullScreen() {
        const modal = document.createElement('div');
        modal.className = 'modal ranking-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;
        
        modal.innerHTML = `
            <div class="modal-content ranking-modal-content" style="
                background: #1a1a2e;
                border-radius: 16px;
                border: 1px solid rgba(255,255,255,0.1);
                max-width: 900px;
                width: 90%;
                max-height: 85vh;
                overflow: hidden;
            ">
                <div class="modal-header" style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 20px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                    background: linear-gradient(135deg, rgba(78, 205, 196, 0.15) 0%, rgba(78, 205, 196, 0.05) 100%);
                ">
                    <h2 style="margin: 0; font-size: 1.5rem; color: white;">🌟 Top Spaces</h2>
                    <button id="close-ranking-modal" style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        border: 2px solid rgba(255, 107, 107, 0.5);
                        background: rgba(255, 107, 107, 0.3);
                        color: white;
                        font-size: 24px;
                        font-weight: bold;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">×</button>
                </div>
                <div class="modal-body" style="
                    padding: 20px;
                    max-height: calc(85vh - 80px);
                    overflow-y: auto;
                    color: white;
                ">
                    ${this.container.innerHTML}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 모달 내부의 탭 버튼에 이벤트 리스너 설정
        const modalTabs = modal.querySelectorAll('.ranking-tab');
        modalTabs.forEach(tab => {
            tab.addEventListener('click', async () => {
                const tabName = tab.dataset.tab;
                if (tabName) {
                    // 모달 내부의 ranking-list 업데이트
                    const modalListContainer = modal.querySelector('#ranking-list');
                    if (modalListContainer) {
                        // 탭 활성화 상태 업데이트
                        modalTabs.forEach(t => {
                            t.classList.toggle('active', t.dataset.tab === tabName);
                        });
                        
                        // 콘텐츠 업데이트
                        switch (tabName) {
                            case 'global_coverage':
                                modalListContainer.innerHTML = this.renderGlobalCoverageRanking();
                                break;
                            case 'most_viewed':
                                modalListContainer.innerHTML = await this.renderMostViewedRanking();
                                break;
                            case 'collectors':
                                modalListContainer.innerHTML = this.renderCollectorsRanking();
                                break;
                            case 'galleries':
                                modalListContainer.innerHTML = this.renderGalleriesRanking();
                                break;
                            case 'investors':
                                modalListContainer.innerHTML = this.renderInvestorsRanking();
                                break;
                        }
                    }
                    
                    // 원본 컨테이너도 업데이트 (동기화)
                    this.currentTab = tabName;
                    await this.switchTab(tabName);
                }
            });
        });
        
        // 새로고침 버튼 (모달 내부)
        const modalRefreshBtn = modal.querySelector('#ranking-refresh');
        if (modalRefreshBtn) {
            modalRefreshBtn.addEventListener('click', async () => {
                await this.refresh();
                // 모달 내부도 업데이트
                const modalListContainer = modal.querySelector('#ranking-list');
                if (modalListContainer) {
                    await this.switchTab(this.currentTab);
                    modalListContainer.innerHTML = document.getElementById('ranking-list')?.innerHTML || '';
                }
            });
        }
        
        // 닫기 버튼
        document.getElementById('close-ranking-modal')?.addEventListener('click', () => {
            modal.remove();
        });
        
        // 배경 클릭으로 닫기
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        // ESC 키로 닫기
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
}

// 싱글톤 인스턴스
export const rankingBoard = new RankingBoard();
export default rankingBoard;

