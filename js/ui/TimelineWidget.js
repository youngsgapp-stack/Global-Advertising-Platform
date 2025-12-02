/**
 * TimelineWidget - 실시간 타임라인 위젯 UI
 * 글로벌 이벤트 실시간 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { historyLogger, HISTORY_EVENT_TYPE } from '../features/HistoryLogger.js';

class TimelineWidget {
    constructor() {
        this.container = null;
        this.contentEl = null;
        this.isCollapsed = false;
        this.maxEvents = 20;
        this.events = [];
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
        this.loadInitialEvents();
        
        log.info('TimelineWidget initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 토글 버튼
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
        
        // 새 이벤트 수신
        this.subscribeToEvents();
    }
    
    /**
     * 이벤트 구독
     */
    subscribeToEvents() {
        // Territory claimed
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.addEvent({
                type: HISTORY_EVENT_TYPE.CONQUERED,
                icon: '⚔️',
                text: `${data.userName} claimed a spot!`,
                className: 'conquered'
            });
        });
        
        // Auction bid
        eventBus.on(EVENTS.AUCTION_BID, (data) => {
            this.addEvent({
                type: HISTORY_EVENT_TYPE.AUCTION_BID,
                icon: '💰',
                text: `${data.userName} bid ${data.bidAmount} pt`,
                className: 'auction'
            });
        });
        
        // Auction start
        eventBus.on(EVENTS.AUCTION_START, (data) => {
            this.addEvent({
                type: HISTORY_EVENT_TYPE.AUCTION_STARTED,
                icon: '🏷️',
                text: `New auction started`,
                className: 'auction'
            });
        });
        
        // Pixel milestone
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, (data) => {
            const milestones = [1000, 2500, 5000, 7500, 10000];
            for (const milestone of milestones) {
                if (data.filledPixels === milestone) {
                    this.addEvent({
                        type: HISTORY_EVENT_TYPE.PIXEL_MILESTONE,
                        icon: '🎨',
                        text: `${milestone} pixel milestone reached!`,
                        className: 'pixel'
                    });
                }
            }
        });
        
        // Collaboration join
        eventBus.on(EVENTS.COLLAB_JOIN, (data) => {
            this.addEvent({
                type: HISTORY_EVENT_TYPE.COLLAB_JOINED,
                icon: '👋',
                text: `${data.userName} joined collaboration`,
                className: 'collab'
            });
        });
        
        // Ranking change
        eventBus.on(EVENTS.RANKING_UPDATE, () => {
            // Ranking changes happen too often, only show important ones
        });
    }
    
    /**
     * 초기 이벤트 로드
     */
    loadInitialEvents() {
        const timeline = historyLogger.getGlobalTimeline(10);
        
        if (timeline.length === 0) {
            this.showEmpty();
            return;
        }
        
        for (const event of timeline.reverse()) {
            this.events.push({
                ...event,
                isNew: false
            });
        }
        
        this.render();
    }
    
    /**
     * 새 이벤트 추가
     */
    addEvent(event) {
        const newEvent = {
            id: `evt_${Date.now()}`,
            icon: event.icon,
            text: event.text,
            className: event.className,
            timestamp: Date.now(),
            isNew: true
        };
        
        // 앞에 추가
        this.events.unshift(newEvent);
        
        // 최대 개수 유지
        if (this.events.length > this.maxEvents) {
            this.events.pop();
        }
        
        this.render();
        
        // 새 이벤트 애니메이션 후 플래그 제거
        setTimeout(() => {
            newEvent.isNew = false;
        }, 500);
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
        
        this.contentEl.innerHTML = this.events.map(event => `
            <div class="timeline-event ${event.className || ''} ${event.isNew ? 'new' : ''}">
                <span class="event-icon">${event.icon}</span>
                <div class="event-content">
                    <div class="event-text">${event.text}</div>
                    <div class="event-time">${this.formatTime(event.timestamp)}</div>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * 빈 상태 표시
     */
    showEmpty() {
        if (!this.contentEl) return;
        
        this.contentEl.innerHTML = `
            <div class="timeline-empty">
                No events yet.<br>
                Claim a spot to see activity here!
            </div>
        `;
    }
    
    /**
     * 시간 포맷
     */
    formatTime(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        
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
    
    /**
     * 펼치기
     */
    expand() {
        this.isCollapsed = false;
        this.container.classList.remove('collapsed');
    }
    
    /**
     * 접기
     */
    collapse() {
        this.isCollapsed = true;
        this.container.classList.add('collapsed');
    }
}

// 싱글톤 인스턴스
export const timelineWidget = new TimelineWidget();
export default timelineWidget;

