/**
 * TimelineWidget - 실시간 타임라인 위젯 UI
 * 서버의 사이트 전체 최근 활동(구매/입찰/경매 시작)을 표시, 1분마다 갱신
 */

import { log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { apiService } from '../services/ApiService.js';
import mapController from '../core/MapController.js';
import { escapeHtml } from './ConfirmDialog.js';
import { openTerritoryById } from '../utils/TerritoryNavigator.js';

const POLL_INTERVAL_MS = 60000;

class TimelineWidget {
    constructor() {
        this.container = null;
        this.contentEl = null;
        this.isCollapsed = false;
        this.maxEvents = 20;
        this.events = [];
        this.seenKeys = new Set();
        this.pollTimer = null;
        this.refreshTimer = null;
        this.mapNames = null;
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'timeline-widget') {
        this.container = document.getElementById(containerId);
        this.contentEl = document.getElementById('timeline-content');
        
        if (!this.container) {
            log.warn('Timeline widget container not found');
            return;
        }
        
        this.setupEventListeners();
        this.refresh();
        this.pollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') this.refresh();
        }, POLL_INTERVAL_MS);
        
        log.info('TimelineWidget initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        const toggleBtn = document.getElementById('timeline-toggle');
        const header = this.container.querySelector('.timeline-header');
        
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggle();
            });
        }
        
        if (header) {
            header.addEventListener('click', () => this.toggle());
        }
        
        this.contentEl?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-territory-id]');
            if (item) openTerritoryById(item.dataset.territoryId);
        });
        
        // 이 브라우저에서 일어난 구매/입찰은 서버 기록 반영 후 곧바로 새로고침
        const refreshSoon = () => {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => this.refresh(), 2500);
        };
        eventBus.on(EVENTS.TERRITORY_CONQUERED, refreshSoon);
        eventBus.on(EVENTS.AUCTION_BID, refreshSoon);
        eventBus.on(EVENTS.AUCTION_START, refreshSoon);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.refresh();
        });
    }
    
    /**
     * 서버에서 최근 활동 불러오기
     */
    async refresh() {
        try {
            const events = await apiService.get(`/territories/activity/recent?limit=${this.maxEvents}`);
            if (!Array.isArray(events)) return;
            const firstLoad = this.seenKeys.size === 0;
            this.events = events.map(event => {
                const key = `${event.type}|${event.territoryId}|${event.at}`;
                const isNew = !firstLoad && !this.seenKeys.has(key);
                this.seenKeys.add(key);
                return { ...event, isNew };
            });
            this.render();
        } catch (error) {
            log.debug('[TimelineWidget] Failed to load recent activity:', error.message);
            if (this.events.length === 0) this.showEmpty();
        }
    }
    
    territoryNameOf(event) {
        if (event.territoryName && event.territoryName !== event.territoryId) return event.territoryName;
        if (!this.mapNames) {
            const features = mapController.map?.getSource?.('world-territories')?._data?.features;
            if (features) {
                this.mapNames = new Map(features.map(f => [f.properties?.id, f.properties?.name || f.properties?.name_en]));
            }
        }
        return this.mapNames?.get(event.territoryId) || event.territoryName || event.territoryId;
    }
    
    describe(event) {
        const who = escapeHtml(event.user || 'Someone');
        const where = `<strong>${escapeHtml(this.territoryNameOf(event))}</strong>`;
        const amount = event.amount ? `${Math.round(event.amount).toLocaleString()} pt` : '';
        switch (event.type) {
            case 'claim':
                return { icon: '🏴', className: 'conquered', text: `${who} claimed ${where}${amount ? ` for ${amount}` : ''}` };
            case 'bid':
                return { icon: '💰', className: 'auction', text: `${who} bid ${amount} on ${where}` };
            case 'auction_start':
                return { icon: '🏷️', className: 'auction', text: `Auction started for ${where}${amount ? ` (from ${amount})` : ''}` };
            default:
                return { icon: '✨', className: '', text: where };
        }
    }
    
    /**
     * 렌더링
     */
    render() {
        if (!this.contentEl) return;
        
        if (this.events.length === 0) {
            this.showEmpty();
            return;
        }
        
        this.contentEl.innerHTML = this.events.map(event => {
            const { icon, className, text } = this.describe(event);
            return `
                <div class="timeline-event ${className} ${event.isNew ? 'new' : ''}" data-territory-id="${escapeHtml(event.territoryId)}" style="cursor:pointer;" title="Open this spot">
                    <span class="event-icon">${icon}</span>
                    <div class="event-content">
                        <div class="event-text">${text}</div>
                        <div class="event-time">${this.formatTime(new Date(event.at).getTime())}</div>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    /**
     * 빈 상태 표시
     */
    showEmpty() {
        if (!this.contentEl) return;
        
        this.contentEl.innerHTML = `
            <div class="timeline-empty">
                No activity yet.<br>
                Be the first to claim a spot!
            </div>
        `;
    }
    
    /**
     * 시간 포맷
     */
    formatTime(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        
        if (!Number.isFinite(seconds)) return '';
        if (seconds < 60) return 'Just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }
    
    /**
     * 토글
     */
    toggle() {
        this.isCollapsed = !this.isCollapsed;
        this.container.classList.toggle('collapsed', this.isCollapsed);
    }
    
    expand() {
        this.isCollapsed = false;
        this.container.classList.remove('collapsed');
    }
    
    collapse() {
        this.isCollapsed = true;
        this.container.classList.add('collapsed');
    }
}

// 싱글톤 인스턴스
export const timelineWidget = new TimelineWidget();
export default timelineWidget;
