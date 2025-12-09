/**
 * TerritoryOwnershipService - 영토 소유권 변경 서비스
 * 트랜잭션 보호 및 이중 판매 방지
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { rateLimiter, RATE_LIMIT_TYPE } from './RateLimiter.js';

class TerritoryOwnershipService {
    constructor() {
        this.pendingTransactions = new Map(); // territoryId -> transactionId
        this.transactionTimeout = 30000; // 30초 타임아웃
    }
    
    /**
     * 영토 소유권 변경 (트랜잭션 보호)
     * @param {string} territoryId - 영토 ID
     * @param {string} userId - 사용자 ID
     * @param {string} userName - 사용자 이름
     * @param {number} price - 구매 가격
     * @param {string} paymentId - 결제 ID (선택)
     * @returns {Promise<Object>} { success: boolean, error?: string }
     */
    async transferOwnership(territoryId, userId, userName, price, paymentId = null, auctionId = null, reason = 'direct_purchase') {
        // Rate Limit 체크
        const rateLimitCheck = await rateLimiter.checkLimit(userId, RATE_LIMIT_TYPE.TERRITORY_PURCHASE);
        if (!rateLimitCheck.allowed) {
            log.warn(`[TerritoryOwnershipService] Rate limit exceeded for user ${userId}`);
            return {
                success: false,
                error: rateLimitCheck.reason,
                retryAfter: rateLimitCheck.retryAfter
            };
        }
        
        // 서버 사이드 검증 API 호출
        try {
            const requestId = `req_${territoryId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const apiUrl = '/api/territory/change-ownership';
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    territoryId,
                    userId,
                    userName,
                    price,
                    paymentId,
                    auctionId,
                    reason,
                    requestId
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to transfer ownership');
            }
            
            const result = await response.json();
            
            if (!result.success) {
                return {
                    success: false,
                    error: result.error || 'Failed to transfer ownership'
                };
            }
            
            // 성공: 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_OWNERSHIP_TRANSFERRED, {
                territoryId,
                userId,
                userName,
                price,
                transactionId: result.transactionId
            });
            
            log.info(`[TerritoryOwnershipService] ✅ Ownership transferred via server: ${territoryId} → ${userName} (${userId})`);
            
            return {
                success: true,
                transactionId: result.transactionId,
                territory: result.territory
            };
            
        } catch (error) {
            log.error(`[TerritoryOwnershipService] ❌ Server API call failed, falling back to client-side:`, error);
            
            // 서버 API 실패 시 기존 클라이언트 사이드 로직으로 fallback (하위 호환성)
            // 하지만 이건 임시 방편이고, 서버 API가 정상 작동해야 함
            return {
                success: false,
                error: `Server validation failed: ${error.message}. Please try again or contact support.`
            };
        }
    }
    
    /**
     * 영토 소유권 변경 (클라이언트 사이드 - Fallback용, 권장하지 않음)
     * @deprecated Use transferOwnership() which calls server API
     */
    async transferOwnershipClientSide(territoryId, userId, userName, price, paymentId = null) {
        // 이미 진행 중인 트랜잭션 확인
        if (this.pendingTransactions.has(territoryId)) {
            const pendingTx = this.pendingTransactions.get(territoryId);
            const elapsed = Date.now() - pendingTx.startTime;
            
            if (elapsed < this.transactionTimeout) {
                log.warn(`[TerritoryOwnershipService] Territory ${territoryId} is already being transferred`);
                return {
                    success: false,
                    error: 'Territory is already being transferred. Please try again later.',
                    retryAfter: Math.ceil((this.transactionTimeout - elapsed) / 1000)
                };
            } else {
                // 타임아웃된 트랜잭션 제거
                this.pendingTransactions.delete(territoryId);
            }
        }
        
        // 트랜잭션 ID 생성
        const transactionId = `tx_${territoryId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.pendingTransactions.set(territoryId, {
            transactionId,
            userId,
            startTime: Date.now()
        });
        
        try {
            // 1. 영토 현재 상태 확인 (원자적 읽기)
            const territory = await firebaseService.getDocument('territories', territoryId);
            
            if (!territory) {
                throw new Error('Territory not found');
            }
            
            // 2. 소유권 변경 가능 여부 확인
            if (territory.ruler && territory.ruler !== null) {
                // 이미 소유자가 있는 경우
                if (territory.ruler === userId) {
                    // 본인이 이미 소유자인 경우
                    this.pendingTransactions.delete(territoryId);
                    return {
                        success: false,
                        error: 'You already own this territory'
                    };
                } else {
                    // 다른 사람이 소유 중인 경우
                    this.pendingTransactions.delete(territoryId);
                    return {
                        success: false,
                        error: 'Territory is already owned by another user'
                    };
                }
            }
            
            // 3. 소유권 변경 (원자적 업데이트)
            const Timestamp = firebaseService.getTimestamp();
            const nowTimestamp = Timestamp ? Timestamp.now() : new Date();
            const protectionEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7일
            const protectionEndsAtTimestamp = Timestamp ? Timestamp.fromDate(protectionEndsAt) : protectionEndsAt;
            
            // 소유권 변경 로그 생성
            const ownershipLog = {
                territoryId,
                previousOwner: territory.ruler || null,
                newOwner: userId,
                newOwnerName: userName,
                price,
                paymentId,
                transactionId,
                timestamp: nowTimestamp,
                type: 'ownership_transfer'
            };
            
            // 영토 업데이트 (원자적)
            await firebaseService.updateDocument('territories', territoryId, {
                ruler: userId,
                rulerName: userName,
                rulerSince: nowTimestamp,
                sovereignty: 'protected',
                protectionEndsAt: protectionEndsAtTimestamp,
                purchasedPrice: price,
                tribute: price,
                currentAuction: null,
                updatedAt: nowTimestamp
            });
            
            // 소유권 변경 로그 저장 (서버 전용 컬렉션 - 클라이언트에서는 읽기만 가능)
            try {
                await firebaseService.setDocument('territoryOwnershipLogs', transactionId, ownershipLog);
            } catch (logError) {
                // 로그 저장 실패는 경고만 (소유권 변경은 성공)
                log.warn(`[TerritoryOwnershipService] Failed to save ownership log:`, logError);
            }
            
            // 트랜잭션 완료
            this.pendingTransactions.delete(territoryId);
            
            log.info(`[TerritoryOwnershipService] ✅ Ownership transferred: ${territoryId} → ${userName} (${userId})`);
            
            // 이벤트 발행
            eventBus.emit(EVENTS.TERRITORY_OWNERSHIP_TRANSFERRED, {
                territoryId,
                userId,
                userName,
                price,
                transactionId
            });
            
            return {
                success: true,
                transactionId,
                territory: {
                    ...territory,
                    ruler: userId,
                    rulerName: userName,
                    rulerSince: nowTimestamp
                }
            };
            
        } catch (error) {
            // 트랜잭션 실패 시 정리
            this.pendingTransactions.delete(territoryId);
            
            log.error(`[TerritoryOwnershipService] ❌ Failed to transfer ownership:`, error);
            
            return {
                success: false,
                error: error.message || 'Failed to transfer ownership'
            };
        }
    }
    
    /**
     * 영토 소유권 확인
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Object|null>} 영토 소유권 정보
     */
    async getOwnership(territoryId) {
        try {
            const territory = await firebaseService.getDocument('territories', territoryId);
            if (!territory) return null;
            
            return {
                territoryId,
                ruler: territory.ruler || null,
                rulerName: territory.rulerName || null,
                rulerSince: territory.rulerSince || null,
                sovereignty: territory.sovereignty || 'unconquered',
                protectionEndsAt: territory.protectionEndsAt || null
            };
        } catch (error) {
            log.error(`[TerritoryOwnershipService] Failed to get ownership:`, error);
            return null;
        }
    }
    
    /**
     * 소유권 변경 히스토리 조회 (서버 전용 - 클라이언트에서는 읽기 불가)
     * @param {string} territoryId - 영토 ID
     * @returns {Promise<Array>} 소유권 변경 히스토리
     */
    async getOwnershipHistory(territoryId) {
        try {
            const logs = await firebaseService.queryCollection('territoryOwnershipLogs', [
                { field: 'territoryId', op: '==', value: territoryId }
            ], { field: 'timestamp', direction: 'desc' }, 100);
            
            return logs;
        } catch (error) {
            log.warn(`[TerritoryOwnershipService] Failed to get ownership history (may require server access):`, error);
            return [];
        }
    }
    
    /**
     * 진행 중인 트랜잭션 확인
     * @param {string} territoryId - 영토 ID
     * @returns {boolean} 진행 중 여부
     */
    isTransactionPending(territoryId) {
        if (!this.pendingTransactions.has(territoryId)) {
            return false;
        }
        
        const tx = this.pendingTransactions.get(territoryId);
        const elapsed = Date.now() - tx.startTime;
        
        if (elapsed >= this.transactionTimeout) {
            // 타임아웃된 트랜잭션 제거
            this.pendingTransactions.delete(territoryId);
            return false;
        }
        
        return true;
    }
}

// 싱글톤 인스턴스
export const territoryOwnershipService = new TerritoryOwnershipService();
export default territoryOwnershipService;

