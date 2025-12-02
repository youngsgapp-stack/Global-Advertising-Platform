/**
 * RecommendationSystem - 추천 시스템
 * 오늘의 지역, 신규 입찰, 소형 지역 추천
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { territoryManager } from '../core/TerritoryManager.js';
import { auctionSystem } from './AuctionSystem.js';

// 추천 타입
export const RECOMMENDATION_TYPE = {
    TODAY: 'today',           // 오늘의 지역
    NEW_AUCTION: 'new',       // 신규 입찰
    SMALL: 'small',           // 소형 지역
    AFFORDABLE: 'affordable', // 저렴한 지역
    HOT: 'hot',               // 인기 지역
    ENDING_SOON: 'ending'     // 곧 종료
};

class RecommendationSystem {
    constructor() {
        this.todaysPick = null;
        this.recommendations = new Map();
        this.lastUpdate = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 오늘의 지역 선정
            this.selectTodaysPick();
            
            // 추천 목록 생성
            await this.generateRecommendations();
            
            // 자정마다 오늘의 지역 갱신
            this.scheduleDaily();
            
            log.info('RecommendationSystem initialized');
            
        } catch (error) {
            log.error('RecommendationSystem init failed:', error);
        }
    }
    
    /**
     * 오늘의 지역 선정
     */
    selectTodaysPick() {
        // 날짜 기반 시드로 일관된 "오늘의 지역" 선택
        const today = new Date();
        const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
        
        // 국가 목록에서 선택
        const countries = Object.keys(CONFIG.COUNTRIES);
        const countryIndex = seed % countries.length;
        const selectedCountry = countries[countryIndex];
        
        this.todaysPick = {
            type: 'country',
            code: selectedCountry,
            country: CONFIG.COUNTRIES[selectedCountry],
            date: today.toISOString().split('T')[0],
            reason: this.getPickReason(seed)
        };
        
        log.info(`Today's Pick: ${selectedCountry}`, this.todaysPick);
        
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'info',
            message: `🎯 Today's Pick: ${this.todaysPick.country.flag} ${this.todaysPick.country.name}`
        });
        
        return this.todaysPick;
    }
    
    /**
     * 선정 이유 생성
     */
    getPickReason(seed) {
        const reasons = [
            '🔥 Trending today!',
            '💎 Hidden gem discovered!',
            '🌟 Rising star region!',
            '🎯 Editor\'s choice!',
            '🚀 Hot opportunity!',
            '✨ Spotlight region!',
            '🏆 Featured territory!'
        ];
        return reasons[seed % reasons.length];
    }
    
    /**
     * 추천 목록 생성
     */
    async generateRecommendations() {
        const recommendations = [];
        
        // 1. 소형 지역 추천 (초보자용)
        const smallRegions = this.getSmallRegions();
        recommendations.push(...smallRegions.map(r => ({
            ...r,
            type: RECOMMENDATION_TYPE.SMALL,
            badge: '🌱 Starter',
            reason: 'Perfect for beginners!'
        })));
        
        // 2. 저렴한 지역
        const affordable = this.getAffordableRegions();
        recommendations.push(...affordable.map(r => ({
            ...r,
            type: RECOMMENDATION_TYPE.AFFORDABLE,
            badge: '💰 Budget',
            reason: 'Great value!'
        })));
        
        // 3. 활성 옥션
        const activeAuctions = auctionSystem.getActiveAuctions?.() || [];
        recommendations.push(...activeAuctions.slice(0, 3).map(a => ({
            territoryId: a.territoryId,
            type: RECOMMENDATION_TYPE.NEW_AUCTION,
            badge: '🔥 Live',
            reason: `Current bid: ${a.currentBid} pt`,
            auction: a
        })));
        
        // 4. 곧 종료되는 옥션
        const endingSoon = activeAuctions
            .filter(a => a.endsAt - Date.now() < 3600000) // 1시간 이내
            .slice(0, 3);
        recommendations.push(...endingSoon.map(a => ({
            territoryId: a.territoryId,
            type: RECOMMENDATION_TYPE.ENDING_SOON,
            badge: '⏰ Ending',
            reason: 'Hurry! Ending soon!',
            auction: a
        })));
        
        this.recommendations.set('all', recommendations);
        this.lastUpdate = Date.now();
        
        return recommendations;
    }
    
    /**
     * 소형 지역 목록
     */
    getSmallRegions() {
        // 작은 국가들 (싱가포르, 룩셈부르크, 몰타 등)
        const smallCountries = ['singapore', 'luxembourg', 'malta', 'bahrain', 'brunei', 'maldives'];
        
        return smallCountries
            .filter(code => CONFIG.COUNTRIES[code])
            .map(code => ({
                code,
                country: CONFIG.COUNTRIES[code],
                size: 'small'
            }));
    }
    
    /**
     * 저렴한 지역 목록
     */
    getAffordableRegions() {
        // 비교적 덜 인기있는 저렴한 지역들
        const affordableCountries = ['mongolia', 'laos', 'cambodia', 'nepal', 'bolivia', 'paraguay'];
        
        return affordableCountries
            .filter(code => CONFIG.COUNTRIES[code])
            .map(code => ({
                code,
                country: CONFIG.COUNTRIES[code],
                priceRange: 'low'
            }));
    }
    
    /**
     * 오늘의 지역 가져오기
     */
    getTodaysPick() {
        // 날짜가 바뀌었으면 새로 선정
        const today = new Date().toISOString().split('T')[0];
        if (!this.todaysPick || this.todaysPick.date !== today) {
            this.selectTodaysPick();
        }
        return this.todaysPick;
    }
    
    /**
     * 타입별 추천 가져오기
     */
    getRecommendationsByType(type) {
        const all = this.recommendations.get('all') || [];
        return all.filter(r => r.type === type);
    }
    
    /**
     * 초보자용 추천
     */
    getBeginnerRecommendations() {
        const all = this.recommendations.get('all') || [];
        return all.filter(r => 
            r.type === RECOMMENDATION_TYPE.SMALL || 
            r.type === RECOMMENDATION_TYPE.AFFORDABLE
        ).slice(0, 6);
    }
    
    /**
     * 활성 추천 (옥션)
     */
    getActiveRecommendations() {
        const all = this.recommendations.get('all') || [];
        return all.filter(r => 
            r.type === RECOMMENDATION_TYPE.NEW_AUCTION || 
            r.type === RECOMMENDATION_TYPE.ENDING_SOON
        );
    }
    
    /**
     * 자정 스케줄
     */
    scheduleDaily() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const msUntilMidnight = tomorrow - now;
        
        setTimeout(() => {
            this.selectTodaysPick();
            this.generateRecommendations();
            this.scheduleDaily(); // 다음 날도 스케줄
        }, msUntilMidnight);
    }
}

// 싱글톤
export const recommendationSystem = new RecommendationSystem();
export default recommendationSystem;

