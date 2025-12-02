/**
 * RecommendationPanel - 추천 패널 UI
 * 오늘의 지역, 초보자 추천, 활성 옥션 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { recommendationSystem, RECOMMENDATION_TYPE } from '../features/RecommendationSystem.js';

class RecommendationPanel {
    constructor() {
        this.container = null;
        this.isExpanded = true;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.createPanel();
        this.render();
        this.setupEventListeners();
        
        log.info('RecommendationPanel initialized');
    }
    
    /**
     * 패널 생성
     */
    createPanel() {
        // 기존 패널 제거
        const existing = document.getElementById('recommendation-panel');
        if (existing) existing.remove();
        
        this.container = document.createElement('aside');
        this.container.id = 'recommendation-panel';
        this.container.className = 'recommendation-panel';
        
        document.getElementById('map-container').appendChild(this.container);
    }
    
    /**
     * 렌더링
     */
    render() {
        const todaysPick = recommendationSystem.getTodaysPick();
        const beginnerRecs = recommendationSystem.getBeginnerRecommendations();
        const activeRecs = recommendationSystem.getActiveRecommendations();
        
        this.container.innerHTML = `
            <div class="rec-header">
                <h3>🎯 Discover</h3>
                <button class="rec-toggle" id="rec-toggle">${this.isExpanded ? '−' : '+'}</button>
            </div>
            
            <div class="rec-content ${this.isExpanded ? '' : 'collapsed'}">
                <!-- 오늘의 지역 -->
                ${todaysPick ? `
                    <div class="rec-section today-pick">
                        <div class="rec-section-header">
                            <span class="rec-badge hot">🔥 Today's Pick</span>
                        </div>
                        <div class="today-pick-card" data-country="${todaysPick.code}">
                            <div class="pick-flag">${todaysPick.country.flag}</div>
                            <div class="pick-info">
                                <div class="pick-name">${todaysPick.country.name}</div>
                                <div class="pick-reason">${todaysPick.reason}</div>
                            </div>
                            <button class="pick-go-btn">Go →</button>
                        </div>
                    </div>
                ` : ''}
                
                <!-- 초보자 추천 -->
                <div class="rec-section">
                    <div class="rec-section-header">
                        <span class="rec-badge starter">🌱 For Beginners</span>
                    </div>
                    <div class="rec-list">
                        ${beginnerRecs.slice(0, 4).map(rec => `
                            <div class="rec-item" data-country="${rec.code}">
                                <span class="rec-flag">${rec.country.flag}</span>
                                <span class="rec-name">${rec.country.name}</span>
                                <span class="rec-type">${rec.badge}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <!-- 활성 옥션 -->
                ${activeRecs.length > 0 ? `
                    <div class="rec-section">
                        <div class="rec-section-header">
                            <span class="rec-badge live">⚡ Live Auctions</span>
                        </div>
                        <div class="rec-list">
                            ${activeRecs.slice(0, 3).map(rec => `
                                <div class="rec-item auction" data-territory="${rec.territoryId}">
                                    <span class="rec-icon">${rec.badge}</span>
                                    <span class="rec-name">${rec.territoryId}</span>
                                    <span class="rec-reason">${rec.reason}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                
                <!-- 퀵 필터 -->
                <div class="rec-section">
                    <div class="rec-section-header">
                        <span class="rec-badge filter">🔍 Quick Filter</span>
                    </div>
                    <div class="rec-filters">
                        <button class="filter-btn" data-filter="small">🌱 Small</button>
                        <button class="filter-btn" data-filter="affordable">💰 Budget</button>
                        <button class="filter-btn" data-filter="popular">🔥 Popular</button>
                    </div>
                </div>
            </div>
        `;
        
        this.bindEvents();
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 토글
        this.container.querySelector('#rec-toggle')?.addEventListener('click', () => {
            this.toggle();
        });
        
        // 오늘의 지역 클릭
        this.container.querySelector('.today-pick-card')?.addEventListener('click', (e) => {
            const country = e.currentTarget.dataset.country;
            if (country) {
                eventBus.emit('load-country', { country });
            }
        });
        
        // 추천 아이템 클릭
        this.container.querySelectorAll('.rec-item[data-country]').forEach(item => {
            item.addEventListener('click', () => {
                const country = item.dataset.country;
                if (country) {
                    eventBus.emit('load-country', { country });
                }
            });
        });
        
        // 필터 버튼
        this.container.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter;
                this.applyFilter(filter);
            });
        });
    }
    
    /**
     * 필터 적용
     */
    applyFilter(filterType) {
        // 필터 버튼 토글
        this.container.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filterType);
        });
        
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'info',
            message: `Filter applied: ${filterType}`
        });
        
        // 필터에 따른 지역 표시
        eventBus.emit('filter-territories', { filter: filterType });
    }
    
    /**
     * 토글
     */
    toggle() {
        this.isExpanded = !this.isExpanded;
        this.render();
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 추천 업데이트 시 다시 렌더링
        eventBus.on('recommendations-updated', () => {
            this.render();
        });
    }
}

// 싱글톤
export const recommendationPanel = new RecommendationPanel();
export default recommendationPanel;

