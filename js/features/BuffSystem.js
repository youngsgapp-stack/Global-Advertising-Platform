/**
 * BuffSystem - 버프 시스템
 * 전략 버프 관리, 적용, 만료 처리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { territoryManager } from '../core/TerritoryManager.js';

// 버프 타입 정의
export const BUFF_TYPES = {
    // 영토 연결 버프
    ADJACENT_POWER: {
        id: 'adjacent_power',
        name: {
            ko: '영토 연결 파워',
            en: 'Adjacent Power'
        },
        description: {
            ko: '인접 영토 소유 시 입찰력 +5%',
            en: '+5% bid power per adjacent territory'
        },
        icon: '🔗',
        color: '#4ecdc4',
        stackable: true,
        maxStacks: 8,
        calculate: (count) => count * CONFIG.BUFFS.ADJACENT_BONUS
    },
    
    // 국가 지배 버프
    COUNTRY_DOMINATION: {
        id: 'country_domination',
        name: {
            ko: '국가 지배력',
            en: 'Country Domination'
        },
        description: {
            ko: '같은 국가 영토 3개 이상 시 가치 +10%',
            en: '+10% value with 3+ territories in same country'
        },
        icon: '🏛️',
        color: '#ff6b6b',
        threshold: CONFIG.BUFFS.COUNTRY_THRESHOLD,
        bonus: CONFIG.BUFFS.COUNTRY_BONUS
    },
    
    // 대륙 지배 버프
    CONTINENT_CONTROL: {
        id: 'continent_control',
        name: {
            ko: '대륙 지배력',
            en: 'Continent Control'
        },
        description: {
            ko: '대륙 내 5개 이상 영토 시 +20% 보너스',
            en: '+20% bonus with 5+ territories in a continent'
        },
        icon: '🌍',
        color: '#feca57',
        threshold: 5,
        bonus: CONFIG.BUFFS.CONTINENT_BONUS
    },
    
    // 시즌 버프
    SEASON_SPECIAL: {
        id: 'season_special',
        name: {
            ko: '시즌 특별 버프',
            en: 'Season Special'
        },
        description: {
            ko: '현재 시즌 특별 보너스 적용',
            en: 'Current season special bonus'
        },
        icon: '🎄',
        color: '#a29bfe',
        seasonal: true
    },
    
    // 팬덤 파워 버프
    FANDOM_POWER: {
        id: 'fandom_power',
        name: {
            ko: '팬덤 파워',
            en: 'Fandom Power'
        },
        description: {
            ko: '협력자 수에 따른 보너스',
            en: 'Bonus based on collaborator count'
        },
        icon: '👥',
        color: '#fd79a8',
        calculate: (collaborators) => Math.min(collaborators * 0.02, 0.20) // 최대 20%
    },
    
    // 연속 정복 버프
    CONQUEST_STREAK: {
        id: 'conquest_streak',
        name: {
            ko: '연속 정복',
            en: 'Conquest Streak'
        },
        description: {
            ko: '연속 정복 시 보너스 증가',
            en: 'Bonus increases with consecutive conquests'
        },
        icon: '🔥',
        color: '#e17055',
        stackable: true,
        maxStacks: 5,
        calculate: (streak) => Math.min(streak * 0.03, 0.15) // 최대 15%
    },
    
    // 첫 정복자 버프
    FIRST_CONQUEROR: {
        id: 'first_conqueror',
        name: {
            ko: '첫 정복자',
            en: 'First Conqueror'
        },
        description: {
            ko: '미정복 영토 첫 정복 시 +25% 가치',
            en: '+25% value for first conquest of unconquered territory'
        },
        icon: '⚔️',
        color: '#00b894',
        oneTime: true,
        bonus: 0.25
    }
};

class BuffSystem {
    constructor() {
        this.activeBuffs = new Map(); // userId -> [buffs]
        this.seasonalBuffs = [];
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 현재 시즌 버프 로드
            this.loadSeasonalBuffs();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('BuffSystem initialized');
            return true;
            
        } catch (error) {
            log.error('BuffSystem initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 영토 정복 시 버프 계산
        eventBus.on(EVENTS.TERRITORY_CONQUERED, (data) => {
            this.recalculateUserBuffs(data.userId);
        });
    }
    
    /**
     * 시즌 버프 로드
     */
    loadSeasonalBuffs() {
        const now = new Date();
        const month = now.getMonth();
        
        // 월별 시즌 버프 (예시)
        if (month === 11) { // 12월
            this.seasonalBuffs.push({
                ...BUFF_TYPES.SEASON_SPECIAL,
                bonus: 0.15,
                expiresAt: new Date(now.getFullYear(), 11, 31)
            });
        }
    }
    
    /**
     * 사용자 버프 재계산
     */
    async recalculateUserBuffs(userId) {
        const buffs = [];
        const userTerritories = territoryManager.getTerritoriesByUser(userId);
        
        if (userTerritories.length === 0) {
            this.activeBuffs.set(userId, []);
            return [];
        }
        
        // 1. 인접 영토 버프 계산
        let totalAdjacentBonus = 0;
        for (const territory of userTerritories) {
            const adjacent = territoryManager.getAdjacentTerritories(territory.id);
            const ownedAdjacent = adjacent.filter(t => t.ruler === userId);
            totalAdjacentBonus += ownedAdjacent.length;
        }
        
        if (totalAdjacentBonus > 0) {
            buffs.push({
                ...BUFF_TYPES.ADJACENT_POWER,
                stacks: Math.min(totalAdjacentBonus, BUFF_TYPES.ADJACENT_POWER.maxStacks),
                bonus: BUFF_TYPES.ADJACENT_POWER.calculate(
                    Math.min(totalAdjacentBonus, BUFF_TYPES.ADJACENT_POWER.maxStacks)
                )
            });
        }
        
        // 2. 국가 지배 버프 계산
        const countryCounts = new Map();
        for (const territory of userTerritories) {
            const count = countryCounts.get(territory.countryCode) || 0;
            countryCounts.set(territory.countryCode, count + 1);
        }
        
        for (const [countryCode, count] of countryCounts) {
            if (count >= BUFF_TYPES.COUNTRY_DOMINATION.threshold) {
                buffs.push({
                    ...BUFF_TYPES.COUNTRY_DOMINATION,
                    countryCode,
                    bonus: BUFF_TYPES.COUNTRY_DOMINATION.bonus
                });
            }
        }
        
        // 3. 대륙 지배 버프 계산
        const continentCounts = new Map();
        for (const territory of userTerritories) {
            const continent = this.getContinent(territory.countryCode);
            if (continent) {
                const count = continentCounts.get(continent) || 0;
                continentCounts.set(continent, count + 1);
            }
        }
        
        for (const [continent, count] of continentCounts) {
            if (count >= BUFF_TYPES.CONTINENT_CONTROL.threshold) {
                buffs.push({
                    ...BUFF_TYPES.CONTINENT_CONTROL,
                    continent,
                    bonus: BUFF_TYPES.CONTINENT_CONTROL.bonus
                });
            }
        }
        
        // 4. 시즌 버프 추가
        for (const seasonBuff of this.seasonalBuffs) {
            if (!seasonBuff.expiresAt || seasonBuff.expiresAt > new Date()) {
                buffs.push(seasonBuff);
            }
        }
        
        // 버프 저장
        this.activeBuffs.set(userId, buffs);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.BUFF_APPLIED, {
            userId,
            buffs
        });
        
        return buffs;
    }
    
    /**
     * 대륙 결정 (RankingSystem과 동일)
     */
    getContinent(countryCode) {
        const continentMap = {
            'US': 'north_america', 'CA': 'north_america', 'MX': 'north_america',
            'BR': 'south_america', 'AR': 'south_america',
            'DE': 'europe', 'FR': 'europe', 'GB': 'europe', 'IT': 'europe',
            'ES': 'europe', 'NL': 'europe', 'PL': 'europe',
            'CN': 'asia', 'JP': 'asia', 'KR': 'asia', 'IN': 'asia',
            'ID': 'asia', 'SA': 'asia', 'TR': 'asia', 'RU': 'asia',
            'AU': 'oceania',
            'ZA': 'africa'
        };
        return continentMap[countryCode] || null;
    }
    
    /**
     * 사용자 버프 가져오기
     */
    getUserBuffs(userId) {
        return this.activeBuffs.get(userId) || [];
    }
    
    /**
     * 총 버프 보너스 계산
     */
    getTotalBonus(userId) {
        const buffs = this.getUserBuffs(userId);
        return buffs.reduce((total, buff) => total + (buff.bonus || 0), 0);
    }
    
    /**
     * 특정 타입 버프 확인
     */
    hasBuffType(userId, buffTypeId) {
        const buffs = this.getUserBuffs(userId);
        return buffs.some(b => b.id === buffTypeId);
    }
    
    /**
     * 버프 정보 포맷팅 (UI용)
     */
    formatBuffsForUI(userId, lang = 'ko') {
        const buffs = this.getUserBuffs(userId);
        
        return buffs.map(buff => ({
            id: buff.id,
            name: buff.name[lang] || buff.name.en,
            description: buff.description[lang] || buff.description.en,
            icon: buff.icon,
            color: buff.color,
            bonusText: `+${Math.round(buff.bonus * 100)}%`,
            stacks: buff.stacks
        }));
    }
    
    /**
     * 모든 버프 타입 가져오기
     */
    getAllBuffTypes() {
        return Object.values(BUFF_TYPES);
    }
}

// 싱글톤 인스턴스
export const buffSystem = new BuffSystem();
export default buffSystem;

