/**
 * HistoryLogger - 영토 역사/스토리 시스템
 * 이벤트 기록, 내러티브 생성, 타임라인 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';

// 이벤트 타입
export const HISTORY_EVENT_TYPE = {
    // 정복/소유권 이벤트
    TERRITORY_CREATED: 'territory_created',
    CONQUERED: 'conquered',
    DEFENDED: 'defended',
    RECLAIMED: 'reclaimed',
    ABANDONED: 'abandoned',
    
    // 옥션 이벤트
    AUCTION_STARTED: 'auction_started',
    AUCTION_BID: 'auction_bid',
    AUCTION_WON: 'auction_won',
    AUCTION_ENDED: 'auction_ended',
    
    // 픽셀/가치 이벤트
    PIXEL_MILESTONE: 'pixel_milestone',
    VALUE_INCREASED: 'value_increased',
    ARTWORK_COMPLETED: 'artwork_completed',
    
    // 협업 이벤트
    COLLAB_OPENED: 'collab_opened',
    COLLAB_JOINED: 'collab_joined',
    COLLAB_COMPLETED: 'collab_completed',
    CONTRIBUTION_MILESTONE: 'contribution_milestone',
    
    // 랭킹 이벤트
    RANK_UP: 'rank_up',
    RANK_DOWN: 'rank_down',
    TOP_10_ENTERED: 'top_10_entered',
    COUNTRY_DOMINATED: 'country_dominated',
    
    // 버프 이벤트
    BUFF_UNLOCKED: 'buff_unlocked',
    BUFF_EXPIRED: 'buff_expired',
    
    // 특별 이벤트
    FIRST_CONQUEST: 'first_conquest',
    ANNIVERSARY: 'anniversary',
    SPECIAL_ACHIEVEMENT: 'special_achievement'
};

// 이벤트 아이콘 매핑
const EVENT_ICONS = {
    [HISTORY_EVENT_TYPE.TERRITORY_CREATED]: '🏴',
    [HISTORY_EVENT_TYPE.CONQUERED]: '⚔️',
    [HISTORY_EVENT_TYPE.DEFENDED]: '🛡️',
    [HISTORY_EVENT_TYPE.RECLAIMED]: '🔄',
    [HISTORY_EVENT_TYPE.ABANDONED]: '🏚️',
    [HISTORY_EVENT_TYPE.AUCTION_STARTED]: '🏷️',
    [HISTORY_EVENT_TYPE.AUCTION_BID]: '💰',
    [HISTORY_EVENT_TYPE.AUCTION_WON]: '🎉',
    [HISTORY_EVENT_TYPE.AUCTION_ENDED]: '🔔',
    [HISTORY_EVENT_TYPE.PIXEL_MILESTONE]: '🎨',
    [HISTORY_EVENT_TYPE.VALUE_INCREASED]: '📈',
    [HISTORY_EVENT_TYPE.ARTWORK_COMPLETED]: '🖼️',
    [HISTORY_EVENT_TYPE.COLLAB_OPENED]: '🤝',
    [HISTORY_EVENT_TYPE.COLLAB_JOINED]: '👋',
    [HISTORY_EVENT_TYPE.COLLAB_COMPLETED]: '✅',
    [HISTORY_EVENT_TYPE.CONTRIBUTION_MILESTONE]: '⭐',
    [HISTORY_EVENT_TYPE.RANK_UP]: '🚀',
    [HISTORY_EVENT_TYPE.RANK_DOWN]: '📉',
    [HISTORY_EVENT_TYPE.TOP_10_ENTERED]: '🏆',
    [HISTORY_EVENT_TYPE.COUNTRY_DOMINATED]: '👑',
    [HISTORY_EVENT_TYPE.BUFF_UNLOCKED]: '⚡',
    [HISTORY_EVENT_TYPE.BUFF_EXPIRED]: '💨',
    [HISTORY_EVENT_TYPE.FIRST_CONQUEST]: '🌟',
    [HISTORY_EVENT_TYPE.ANNIVERSARY]: '🎂',
    [HISTORY_EVENT_TYPE.SPECIAL_ACHIEVEMENT]: '💎'
};

class HistoryLogger {
    constructor() {
        this.territoryHistories = new Map();  // territoryId -> events[]
        this.globalTimeline = [];
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('HistoryLogger initialized');
            return true;
            
        } catch (error) {
            log.error('HistoryLogger initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 영토 정복
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.logEvent(data.territoryId, HISTORY_EVENT_TYPE.CONQUERED, {
                newRuler: data.userName,
                newRulerId: data.userId,
                previousRuler: data.previousRuler || null,
                tribute: data.tribute
            });
        });
        
        // 옥션 시작
        eventBus.on(EVENTS.AUCTION_START, (data) => {
            this.logEvent(data.auction.territoryId, HISTORY_EVENT_TYPE.AUCTION_STARTED, {
                auctionId: data.auction.id,
                startingBid: data.auction.startingBid
            });
        });
        
        // 옥션 입찰
        eventBus.on(EVENTS.AUCTION_BID, (data) => {
            this.logEvent(data.auction?.territoryId, HISTORY_EVENT_TYPE.AUCTION_BID, {
                bidder: data.userName,
                amount: data.bidAmount
            });
        });
        
        // 픽셀 가치 변경
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, (data) => {
            this.checkPixelMilestones(data.territoryId, data.filledPixels);
        });
        
        // 협업 참여
        eventBus.on(EVENTS.COLLAB_JOIN, (data) => {
            this.logEvent(data.territoryId, HISTORY_EVENT_TYPE.COLLAB_JOINED, {
                user: data.userName,
                userId: data.userId
            });
        });
        
        // 버프 적용
        eventBus.on(EVENTS.BUFF_APPLIED, (data) => {
            for (const buff of data.buffs) {
                this.logEvent(data.territoryId, HISTORY_EVENT_TYPE.BUFF_UNLOCKED, {
                    buffId: buff.id,
                    buffName: buff.name
                });
            }
        });
    }
    
    /**
     * 이벤트 기록
     */
    async logEvent(territoryId, eventType, data = {}) {
        if (!territoryId) return;
        
        const event = {
            id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: eventType,
            timestamp: Date.now(),
            data,
            narrative: this.generateNarrative(eventType, data),
            icon: EVENT_ICONS[eventType] || '📝'
        };
        
        // 로컬 캐시에 추가
        if (!this.territoryHistories.has(territoryId)) {
            this.territoryHistories.set(territoryId, []);
        }
        this.territoryHistories.get(territoryId).push(event);
        
        // 글로벌 타임라인에도 추가
        this.globalTimeline.unshift({
            ...event,
            territoryId
        });
        
        // 최대 1000개 유지
        if (this.globalTimeline.length > 1000) {
            this.globalTimeline = this.globalTimeline.slice(0, 1000);
        }
        
        // Firestore에 저장
        try {
            await this.saveEventToFirestore(territoryId, event);
        } catch (error) {
            log.warn('Failed to save history event:', error);
        }
        
        log.debug(`History event logged: ${eventType} for ${territoryId}`);
        
        return event;
    }
    
    /**
     * 내러티브 생성
     */
    generateNarrative(eventType, data) {
        const narratives = {
            [HISTORY_EVENT_TYPE.TERRITORY_CREATED]: () => 
                `새로운 영토가 발견되었습니다.`,
            
            [HISTORY_EVENT_TYPE.CONQUERED]: () => {
                if (data.previousRuler) {
                    return `${data.newRuler}이(가) ${data.previousRuler}로부터 영토를 정복했습니다! 💰 ${data.tribute} pt`;
                }
                return `${data.newRuler}이(가) 미정복 영토를 최초로 정복했습니다! 🌟`;
            },
            
            [HISTORY_EVENT_TYPE.DEFENDED]: () => 
                `${data.defender}이(가) ${data.attacker}의 도전을 물리쳤습니다!`,
            
            [HISTORY_EVENT_TYPE.RECLAIMED]: () => 
                `${data.newRuler}이(가) 영토를 탈환했습니다!`,
            
            [HISTORY_EVENT_TYPE.AUCTION_STARTED]: () => 
                `옥션이 시작되었습니다. 시작가: ${data.startingBid} pt`,
            
            [HISTORY_EVENT_TYPE.AUCTION_BID]: () => 
                `${data.bidder}이(가) ${data.amount} pt에 입찰했습니다.`,
            
            [HISTORY_EVENT_TYPE.AUCTION_WON]: () => 
                `${data.winner}이(가) ${data.amount} pt에 낙찰받았습니다! 🎉`,
            
            [HISTORY_EVENT_TYPE.PIXEL_MILESTONE]: () => 
                `${data.milestone} 픽셀 마일스톤 달성! 🎨`,
            
            [HISTORY_EVENT_TYPE.VALUE_INCREASED]: () => 
                `영토 가치가 ${data.increase}% 상승했습니다. 📈`,
            
            [HISTORY_EVENT_TYPE.ARTWORK_COMPLETED]: () => 
                `아트워크 "${data.artworkName}"이(가) 완성되었습니다! 🖼️`,
            
            [HISTORY_EVENT_TYPE.COLLAB_OPENED]: () => 
                `협업이 시작되었습니다. 참여자를 모집 중입니다.`,
            
            [HISTORY_EVENT_TYPE.COLLAB_JOINED]: () => 
                `${data.user}이(가) 협업에 참여했습니다! 👋`,
            
            [HISTORY_EVENT_TYPE.COLLAB_COMPLETED]: () => 
                `협업이 완료되었습니다! 총 ${data.totalContributors}명이 참여했습니다. ✅`,
            
            [HISTORY_EVENT_TYPE.CONTRIBUTION_MILESTONE]: () => 
                `${data.user}이(가) ${data.milestone} 픽셀 기여를 달성했습니다! ⭐`,
            
            [HISTORY_EVENT_TYPE.RANK_UP]: () => 
                `영토 랭킹이 ${data.previousRank}위 → ${data.newRank}위로 상승했습니다! 🚀`,
            
            [HISTORY_EVENT_TYPE.TOP_10_ENTERED]: () => 
                `세계 패권 Top 10에 진입했습니다! 🏆`,
            
            [HISTORY_EVENT_TYPE.COUNTRY_DOMINATED]: () => 
                `${data.country} 전체를 지배하게 되었습니다! 👑`,
            
            [HISTORY_EVENT_TYPE.BUFF_UNLOCKED]: () => 
                `"${data.buffName}" 버프가 활성화되었습니다! ⚡`,
            
            [HISTORY_EVENT_TYPE.FIRST_CONQUEST]: () => 
                `역사적인 첫 정복! ${data.newRuler}이(가) 영토의 첫 통치자가 되었습니다. 🌟`,
            
            [HISTORY_EVENT_TYPE.ANNIVERSARY]: () => 
                `영토 정복 ${data.years}주년! 🎂`,
            
            [HISTORY_EVENT_TYPE.SPECIAL_ACHIEVEMENT]: () => 
                `특별 업적 달성: ${data.achievement} 💎`
        };
        
        const generator = narratives[eventType];
        return generator ? generator() : '이벤트가 발생했습니다.';
    }
    
    /**
     * 픽셀 마일스톤 체크
     */
    checkPixelMilestones(territoryId, filledPixels) {
        const milestones = [100, 500, 1000, 2500, 5000, 7500, 10000];
        
        for (const milestone of milestones) {
            // 마일스톤 도달 시 (약간의 오차 허용)
            if (filledPixels >= milestone && filledPixels < milestone + 10) {
                const history = this.territoryHistories.get(territoryId) || [];
                const alreadyLogged = history.some(e => 
                    e.type === HISTORY_EVENT_TYPE.PIXEL_MILESTONE && 
                    e.data.milestone === milestone
                );
                
                if (!alreadyLogged) {
                    this.logEvent(territoryId, HISTORY_EVENT_TYPE.PIXEL_MILESTONE, {
                        milestone
                    });
                }
            }
        }
    }
    
    /**
     * Firestore에 이벤트 저장
     */
    async saveEventToFirestore(territoryId, event) {
        try {
            const historyDoc = await firebaseService.getDocument('territoryHistories', territoryId);
            const events = historyDoc?.events || [];
            
            events.push(event);
            
            // 최대 500개 이벤트 유지
            const trimmedEvents = events.slice(-500);
            
            await firebaseService.setDocument('territoryHistories', territoryId, {
                territoryId,
                events: trimmedEvents,
                lastUpdated: Date.now()
            });
        } catch (error) {
            // 권한 오류나 기타 오류는 조용히 처리 (로그인하지 않은 사용자 등)
            if (error.code === 'permission-denied' || error.message?.includes('permissions')) {
                log.debug(`[HistoryLogger] Permission denied for territoryHistories/${territoryId} (user not logged in)`);
            } else {
                log.warn(`[HistoryLogger] Failed to save history event:`, error);
            }
        }
    }
    
    /**
     * 영토 타임라인 가져오기
     */
    async getTerritoryTimeline(territoryId, limit = 50) {
        // 로컬 캐시 확인
        if (this.territoryHistories.has(territoryId)) {
            const events = this.territoryHistories.get(territoryId);
            return events.slice(-limit).reverse();
        }
        
        // Firestore에서 로드
        try {
            const data = await firebaseService.getDocument('territoryHistories', territoryId);
            if (data?.events) {
                this.territoryHistories.set(territoryId, data.events);
                return data.events.slice(-limit).reverse();
            }
        } catch (error) {
            // 권한 오류는 조용히 처리 (로그인하지 않은 사용자 등)
            if (error.code === 'permission-denied' || error.message?.includes('permissions')) {
                log.debug(`[HistoryLogger] Permission denied for territoryHistories/${territoryId} (user not logged in)`);
            } else {
                log.warn('Failed to load territory timeline:', error);
            }
        }
        
        return [];
    }
    
    /**
     * 글로벌 타임라인 가져오기
     */
    getGlobalTimeline(limit = 100) {
        return this.globalTimeline.slice(0, limit);
    }
    
    /**
     * 사용자 활동 기록 가져오기
     */
    async getUserActivityLog(userId, limit = 50) {
        const allEvents = [];
        
        for (const [territoryId, events] of this.territoryHistories) {
            const userEvents = events.filter(e => 
                e.data.userId === userId || 
                e.data.newRulerId === userId ||
                e.data.bidder === userId
            );
            
            allEvents.push(...userEvents.map(e => ({
                ...e,
                territoryId
            })));
        }
        
        return allEvents
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }
    
    /**
     * 이벤트 타입별 필터링
     */
    filterByType(territoryId, eventTypes) {
        const events = this.territoryHistories.get(territoryId) || [];
        return events.filter(e => eventTypes.includes(e.type));
    }
    
    /**
     * 날짜 범위별 필터링
     */
    filterByDateRange(territoryId, startDate, endDate) {
        const events = this.territoryHistories.get(territoryId) || [];
        const startTs = startDate.getTime();
        const endTs = endDate.getTime();
        
        return events.filter(e => e.timestamp >= startTs && e.timestamp <= endTs);
    }
    
    /**
     * 통계 요약
     */
    getSummary(territoryId) {
        const events = this.territoryHistories.get(territoryId) || [];
        
        const summary = {
            totalEvents: events.length,
            conquests: 0,
            auctions: 0,
            pixelMilestones: 0,
            collaborations: 0,
            firstEvent: events[0]?.timestamp || null,
            lastEvent: events[events.length - 1]?.timestamp || null
        };
        
        for (const event of events) {
            if (event.type === HISTORY_EVENT_TYPE.CONQUERED) summary.conquests++;
            if (event.type.startsWith('auction_')) summary.auctions++;
            if (event.type === HISTORY_EVENT_TYPE.PIXEL_MILESTONE) summary.pixelMilestones++;
            if (event.type.startsWith('collab_')) summary.collaborations++;
        }
        
        return summary;
    }
    
    /**
     * 이벤트 포맷팅 (UI용)
     */
    formatEventForUI(event, lang = 'ko') {
        const timeAgo = this.getTimeAgo(event.timestamp, lang);
        
        return {
            id: event.id,
            icon: event.icon,
            narrative: event.narrative,
            timeAgo,
            timestamp: new Date(event.timestamp).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US'),
            type: event.type,
            data: event.data
        };
    }
    
    /**
     * 상대 시간 계산
     */
    getTimeAgo(timestamp, lang = 'ko') {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        
        const intervals = [
            { seconds: 31536000, ko: '년', en: 'year' },
            { seconds: 2592000, ko: '개월', en: 'month' },
            { seconds: 86400, ko: '일', en: 'day' },
            { seconds: 3600, ko: '시간', en: 'hour' },
            { seconds: 60, ko: '분', en: 'minute' },
            { seconds: 1, ko: '초', en: 'second' }
        ];
        
        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                const unit = lang === 'ko' ? interval.ko : interval.en;
                const suffix = lang === 'ko' ? ' 전' : (count === 1 ? ' ago' : 's ago');
                return `${count}${unit}${suffix}`;
            }
        }
        
        return lang === 'ko' ? '방금 전' : 'just now';
    }
}

// 싱글톤 인스턴스
export const historyLogger = new HistoryLogger();
export default historyLogger;

