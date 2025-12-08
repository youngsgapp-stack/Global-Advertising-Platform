/**
 * RateLimiter - Rate Limiting 서비스
 * 픽셀 편집, API 호출 등에 대한 Rate Limiting 적용
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

// Rate Limit 타입
export const RATE_LIMIT_TYPE = {
    PIXEL_EDIT: 'pixel_edit',      // 픽셀 편집
    TERRITORY_PURCHASE: 'territory_purchase',  // 영토 구매
    AUCTION_BID: 'auction_bid',    // 경매 입찰
    API_REQUEST: 'api_request'     // API 요청
};

// Rate Limit 설정
const RATE_LIMIT_CONFIG = {
    [RATE_LIMIT_TYPE.PIXEL_EDIT]: {
        perSecond: 5,      // 초당 5픽셀
        perMinute: 100,    // 분당 100픽셀
        perHour: 5000,    // 시간당 5000픽셀
        burst: 0           // 버스트 허용량 (0 = 버스트 없음, 엄격한 제한)
    },
    [RATE_LIMIT_TYPE.TERRITORY_PURCHASE]: {
        perSecond: 1,     // 초당 1회
        perMinute: 5,     // 분당 5회
        perHour: 20,      // 시간당 20회
        burst: 2
    },
    [RATE_LIMIT_TYPE.AUCTION_BID]: {
        perSecond: 2,     // 초당 2회
        perMinute: 10,    // 분당 10회
        perHour: 50,      // 시간당 50회
        burst: 3
    },
    [RATE_LIMIT_TYPE.API_REQUEST]: {
        perSecond: 10,    // 초당 10회
        perMinute: 100,   // 분당 100회
        perHour: 1000,    // 시간당 1000회
        burst: 20
    }
};

class RateLimiter {
    constructor() {
        this.records = new Map(); // userId -> { type -> { timestamps: [], counts: {} } }
        this.suspiciousPatterns = new Map(); // userId -> { pattern: 'bot', score: 0 }
        this.cleanupInterval = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        // 1시간마다 오래된 레코드 정리
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 3600000); // 1시간
        
        log.info('[RateLimiter] Initialized');
    }
    
    /**
     * 신규 계정 여부 확인 (비동기)
     * @param {string} userId - 사용자 ID
     * @returns {Promise<boolean>} 신규 계정 여부 (1시간 이내 생성)
     */
    async isNewAccount(userId) {
        try {
            const { firebaseService } = await import('./FirebaseService.js');
            
            // wallet 생성 시점 확인 (가장 정확)
            const wallet = await firebaseService.getDocument('wallets', userId);
            if (wallet && wallet.createdAt) {
                const createdAt = wallet.createdAt.toMillis ? wallet.createdAt.toMillis() : new Date(wallet.createdAt).getTime();
                const oneHourAgo = Date.now() - 60 * 60 * 1000;
                return createdAt > oneHourAgo;
            }
            
            // users 컬렉션 확인
            const user = await firebaseService.getDocument('users', userId);
            if (user && user.createdAt) {
                const createdAt = user.createdAt.toMillis ? user.createdAt.toMillis() : new Date(user.createdAt).getTime();
                const oneHourAgo = Date.now() - 60 * 60 * 1000;
                return createdAt > oneHourAgo;
            }
            
            return false;
        } catch (error) {
            log.warn(`[RateLimiter] Failed to check new account status:`, error);
            return false; // 확인 실패 시 일반 계정으로 간주
        }
    }
    
    /**
     * Rate Limit 체크 (비동기 지원)
     * @param {string} userId - 사용자 ID
     * @param {string} type - Rate Limit 타입
     * @param {number} amount - 요청량 (픽셀 편집의 경우 픽셀 수)
     * @returns {Promise<Object>} { allowed: boolean, reason: string, retryAfter: number }
     */
    async checkLimit(userId, type, amount = 1) {
        if (!userId) {
            return { allowed: false, reason: 'User not authenticated' };
        }
        
        const config = RATE_LIMIT_CONFIG[type];
        if (!config) {
            log.warn(`[RateLimiter] Unknown rate limit type: ${type}`);
            return { allowed: true }; // 알 수 없는 타입은 허용
        }
        
        // 신규 계정 보호 규칙: 1시간 이내 계정은 50% 제한
        const isNew = await this.isNewAccount(userId);
        if (isNew) {
            // 신규 계정은 제한을 50%로 줄임
            const adjustedConfig = {
                perSecond: Math.max(1, Math.floor(config.perSecond * 0.5)),
                perMinute: Math.max(1, Math.floor(config.perMinute * 0.5)),
                perHour: Math.max(1, Math.floor(config.perHour * 0.5)),
                burst: Math.max(0, Math.floor(config.burst * 0.5))
            };
            return this._checkLimitInternal(userId, type, amount, adjustedConfig);
        }
        
        return this._checkLimitInternal(userId, type, amount, config);
    }
    
    /**
     * Rate Limit 체크 내부 로직
     */
    _checkLimitInternal(userId, type, amount, config) {
        
        // 레코드 가져오기 또는 생성
        if (!this.records.has(userId)) {
            this.records.set(userId, new Map());
        }
        const userRecords = this.records.get(userId);
        
        if (!userRecords.has(type)) {
            userRecords.set(type, {
                timestamps: [],
                counts: {
                    second: 0,
                    minute: 0,
                    hour: 0
                }
            });
        }
        
        const record = userRecords.get(type);
        const now = Date.now();
        
        // 오래된 타임스탬프 제거 및 카운트 업데이트
        this.updateCounts(record, now);
        
        // Rate Limit 체크
        const checks = [
            { period: 'second', limit: config.perSecond, window: 1000 },
            { period: 'minute', limit: config.perMinute, window: 60000 },
            { period: 'hour', limit: config.perHour, window: 3600000 }
        ];
        
        for (const check of checks) {
            const currentCount = record.counts[check.period];
            const newCount = currentCount + amount;
            
            // 제한 초과 체크
            if (newCount > check.limit) {
                // 버스트 허용량 확인
                const burstLimit = check.limit + config.burst;
                
                if (newCount > burstLimit) {
                    // 버스트 허용량도 초과하면 차단
                    // 의심스러운 패턴 감지
                    this.detectSuspiciousPattern(userId, type);
                    
                    const retryAfter = this.calculateRetryAfter(record, check.period, check.window);
                    return {
                        allowed: false,
                        reason: `Rate limit exceeded: ${check.period} limit (${check.limit})`,
                        retryAfter,
                        period: check.period
                    };
                }
                // 버스트 허용량 내이면 허용 (일시적인 트래픽 증가 허용)
                // 하지만 버스트가 0이면 여기 도달하지 않음
            }
        }
        
        // 허용: 타임스탬프 추가
        record.timestamps.push(now);
        
        // 타임스탬프 추가 후 카운트 재계산 (정확한 카운트 유지)
        const oneSecondAgo = now - 1000;
        const oneMinuteAgo = now - 60000;
        const oneHourAgo = now - 3600000;
        
        record.counts.second = record.timestamps.filter(ts => ts > oneSecondAgo).length;
        record.counts.minute = record.timestamps.filter(ts => ts > oneMinuteAgo).length;
        record.counts.hour = record.timestamps.filter(ts => ts > oneHourAgo).length;
        
        return { allowed: true };
    }
    
    /**
     * 동기 버전 (하위 호환성)
     * @deprecated Use async checkLimit() instead
     */
    checkLimitSync(userId, type, amount = 1) {
        if (!userId) {
            return { allowed: false, reason: 'User not authenticated' };
        }
        
        const config = RATE_LIMIT_CONFIG[type];
        if (!config) {
            log.warn(`[RateLimiter] Unknown rate limit type: ${type}`);
            return { allowed: true };
        }
        
        return this._checkLimitInternal(userId, type, amount, config);
    }
    
    /**
     * 카운트 업데이트
     */
    updateCounts(record, now) {
        // 1시간 이전 타임스탬프는 완전히 제거 (메모리 절약)
        const oneHourAgo = now - 3600000;
        record.timestamps = record.timestamps.filter(ts => ts > oneHourAgo);
        
        // 각 기간별 카운트 계산 (이미 필터링된 timestamps 배열 사용)
        const oneSecondAgo = now - 1000;
        const oneMinuteAgo = now - 60000;
        
        // 필터링된 타임스탬프 배열을 재사용하여 카운트 계산
        record.counts.second = record.timestamps.filter(ts => ts > oneSecondAgo).length;
        record.counts.minute = record.timestamps.filter(ts => ts > oneMinuteAgo).length;
        record.counts.hour = record.timestamps.length; // 1시간 이전은 이미 제거됨
    }
    
    /**
     * 재시도 대기 시간 계산
     */
    calculateRetryAfter(record, period, window) {
        if (record.timestamps.length === 0) return 0;
        
        const oldest = Math.min(...record.timestamps);
        const now = Date.now();
        const elapsed = now - oldest;
        const remaining = Math.max(0, window - elapsed);
        
        return Math.ceil(remaining / 1000); // 초 단위로 반환
    }
    
    /**
     * 의심스러운 패턴 감지
     */
    detectSuspiciousPattern(userId, type) {
        if (!this.suspiciousPatterns.has(userId)) {
            this.suspiciousPatterns.set(userId, { score: 0, patterns: [] });
        }
        
        const suspicious = this.suspiciousPatterns.get(userId);
        suspicious.score += 1;
        
        // 일정하게 초당 5픽셀, 24시간 무한 작업 → 봇 패턴
        if (type === RATE_LIMIT_TYPE.PIXEL_EDIT) {
            const record = this.records.get(userId)?.get(type);
            if (record && record.timestamps.length > 100) {
                // 타임스탬프 간격이 너무 일정하면 봇 패턴
                const intervals = [];
                for (let i = 1; i < record.timestamps.length; i++) {
                    intervals.push(record.timestamps[i] - record.timestamps[i - 1]);
                }
                
                const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const variance = intervals.reduce((sum, interval) => {
                    return sum + Math.pow(interval - avgInterval, 2);
                }, 0) / intervals.length;
                
                // 분산이 작으면 일정한 패턴 (봇 가능성)
                if (variance < 10000) { // 10초 이내 분산
                    suspicious.patterns.push('bot_pattern');
                    suspicious.score += 5;
                }
            }
        }
        
        // 점수가 임계값을 넘으면 경고
        if (suspicious.score > 10) {
            log.warn(`[RateLimiter] Suspicious pattern detected for user ${userId}: score=${suspicious.score}`);
            eventBus.emit(EVENTS.SUSPICIOUS_ACTIVITY, {
                userId,
                type,
                score: suspicious.score,
                patterns: suspicious.patterns
            });
        }
    }
    
    /**
     * 사용자 제한 해제 (관리자용)
     */
    resetLimit(userId, type = null) {
        if (type) {
            const userRecords = this.records.get(userId);
            if (userRecords) {
                userRecords.delete(type);
            }
        } else {
            this.records.delete(userId);
            this.suspiciousPatterns.delete(userId);
        }
        
        log.info(`[RateLimiter] Reset limit for user ${userId}, type: ${type || 'all'}`);
    }
    
    /**
     * 오래된 레코드 정리
     */
    cleanup() {
        const oneHourAgo = Date.now() - 3600000;
        let cleaned = 0;
        
        for (const [userId, userRecords] of this.records.entries()) {
            for (const [type, record] of userRecords.entries()) {
                if (record.timestamps.length === 0 || 
                    Math.max(...record.timestamps) < oneHourAgo) {
                    userRecords.delete(type);
                    cleaned++;
                }
            }
            
            if (userRecords.size === 0) {
                this.records.delete(userId);
            }
        }
        
        if (cleaned > 0) {
            log.debug(`[RateLimiter] Cleaned up ${cleaned} old records`);
        }
    }
    
    /**
     * 현재 상태 가져오기
     */
    getStatus(userId, type) {
        if (!this.records.has(userId)) {
            return { counts: { second: 0, minute: 0, hour: 0 }, limits: RATE_LIMIT_CONFIG[type] };
        }
        
        const userRecords = this.records.get(userId);
        if (!userRecords.has(type)) {
            return { counts: { second: 0, minute: 0, hour: 0 }, limits: RATE_LIMIT_CONFIG[type] };
        }
        
        const record = userRecords.get(type);
        this.updateCounts(record, Date.now());
        
        return {
            counts: { ...record.counts },
            limits: RATE_LIMIT_CONFIG[type],
            suspicious: this.suspiciousPatterns.get(userId) || null
        };
    }
}

// 싱글톤 인스턴스
export const rateLimiter = new RateLimiter();
export default rateLimiter;

