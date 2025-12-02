/**
 * WalletService - 포인트/지갑 관리 서비스
 * 포인트 충전, 차감, 잔액 조회, 거래 내역 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from './FirebaseService.js';

// 거래 유형
export const TRANSACTION_TYPE = {
    CHARGE: 'charge',           // 충전
    PURCHASE: 'purchase',       // 구매 (영토)
    BID: 'bid',                 // 입찰
    BID_REFUND: 'bid_refund',   // 입찰 환불 (낙찰 실패)
    REWARD: 'reward',           // 보상
    ADMIN: 'admin'              // 관리자 조정
};

// 지갑 이벤트
export const WALLET_EVENTS = {
    BALANCE_UPDATED: 'wallet:balanceUpdated',
    CHARGE_SUCCESS: 'wallet:chargeSuccess',
    CHARGE_FAILED: 'wallet:chargeFailed',
    INSUFFICIENT_BALANCE: 'wallet:insufficientBalance',
    TRANSACTION_ADDED: 'wallet:transactionAdded'
};

class WalletService {
    constructor() {
        this.initialized = false;
        this.currentBalance = 0;
        this.transactions = [];
        this.unsubscriber = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        if (this.initialized) {
            log.info('WalletService already initialized');
            return true;
        }
        
        try {
            // 인증 상태 변경 감시
            eventBus.on(EVENTS.AUTH_STATE_CHANGED, ({ user }) => {
                if (user) {
                    this.loadUserWallet(user.uid);
                } else {
                    this.clearWallet();
                }
            });
            
            // 현재 로그인된 사용자가 있으면 지갑 로드
            const currentUser = firebaseService.getCurrentUser();
            if (currentUser) {
                await this.loadUserWallet(currentUser.uid);
            }
            
            this.initialized = true;
            log.info('WalletService initialized');
            return true;
            
        } catch (error) {
            log.error('WalletService initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 사용자 지갑 로드
     */
    async loadUserWallet(userId) {
        try {
            // 기존 구독 해제
            if (this.unsubscriber) {
                this.unsubscriber();
            }
            
            // 지갑 데이터 가져오기 (없으면 생성)
            let wallet = await firebaseService.getDocument('wallets', userId);
            
            if (!wallet) {
                // 새 지갑 생성
                wallet = {
                    userId,
                    balance: 0,
                    totalCharged: 0,
                    totalSpent: 0,
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                await firebaseService.setDocument('wallets', userId, wallet);
                log.info('New wallet created for user:', userId);
            }
            
            this.currentBalance = wallet.balance || 0;
            
            // 실시간 구독 설정
            this.unsubscriber = firebaseService.subscribeToDocument('wallets', userId, (data) => {
                if (data) {
                    this.currentBalance = data.balance || 0;
                    eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, {
                        balance: this.currentBalance
                    });
                }
            });
            
            // 최근 거래 내역 로드
            await this.loadTransactions(userId);
            
            // 잔액 업데이트 이벤트 발행
            eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, {
                balance: this.currentBalance
            });
            
            log.info(`Wallet loaded: ${this.currentBalance} pt`);
            
        } catch (error) {
            log.error('Failed to load wallet:', error);
        }
    }
    
    /**
     * 거래 내역 로드
     */
    async loadTransactions(userId) {
        try {
            this.transactions = await firebaseService.queryCollection(
                `wallets/${userId}/transactions`,
                [],
                { field: 'createdAt', direction: 'desc' },
                50 // 최근 50건
            );
        } catch (error) {
            log.warn('Failed to load transactions:', error);
            this.transactions = [];
        }
    }
    
    /**
     * 지갑 초기화 (로그아웃 시)
     */
    clearWallet() {
        if (this.unsubscriber) {
            this.unsubscriber();
            this.unsubscriber = null;
        }
        this.currentBalance = 0;
        this.transactions = [];
        
        eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, { balance: 0 });
    }
    
    /**
     * 잔액 조회
     */
    getBalance() {
        return this.currentBalance;
    }
    
    /**
     * 잔액 충분 여부 확인
     */
    hasBalance(amount) {
        return this.currentBalance >= amount;
    }
    
    /**
     * 포인트 충전
     */
    async addPoints(amount, description = 'Point charge', transactionType = TRANSACTION_TYPE.CHARGE, metadata = {}) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        if (amount <= 0) {
            throw new Error('Invalid amount');
        }
        
        try {
            const userId = user.uid;
            
            // 지갑 업데이트
            const wallet = await firebaseService.getDocument('wallets', userId);
            const newBalance = (wallet?.balance || 0) + amount;
            
            await firebaseService.setDocument('wallets', userId, {
                balance: newBalance,
                totalCharged: (wallet?.totalCharged || 0) + amount,
                updatedAt: new Date()
            });
            
            // 거래 내역 저장
            const transaction = {
                type: transactionType,
                amount: amount,
                balanceAfter: newBalance,
                description,
                metadata,
                createdAt: new Date()
            };
            
            await firebaseService.setDocument(
                `wallets/${userId}/transactions`,
                `txn_${Date.now()}`,
                transaction
            );
            
            this.currentBalance = newBalance;
            
            // 이벤트 발행
            eventBus.emit(WALLET_EVENTS.CHARGE_SUCCESS, {
                amount,
                newBalance
            });
            
            eventBus.emit(WALLET_EVENTS.TRANSACTION_ADDED, { transaction });
            
            log.info(`Points added: +${amount} pt, new balance: ${newBalance} pt`);
            return { success: true, newBalance };
            
        } catch (error) {
            log.error('Failed to add points:', error);
            eventBus.emit(WALLET_EVENTS.CHARGE_FAILED, { error });
            throw error;
        }
    }
    
    /**
     * 포인트 차감
     */
    async deductPoints(amount, description = 'Purchase', transactionType = TRANSACTION_TYPE.PURCHASE, metadata = {}) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        if (amount <= 0) {
            throw new Error('Invalid amount');
        }
        
        // 잔액 체크
        if (!this.hasBalance(amount)) {
            eventBus.emit(WALLET_EVENTS.INSUFFICIENT_BALANCE, {
                required: amount,
                current: this.currentBalance
            });
            throw new Error(`Insufficient balance. Required: ${amount} pt, Current: ${this.currentBalance} pt`);
        }
        
        try {
            const userId = user.uid;
            
            // 지갑 업데이트
            const wallet = await firebaseService.getDocument('wallets', userId);
            const newBalance = (wallet?.balance || 0) - amount;
            
            if (newBalance < 0) {
                throw new Error('Insufficient balance');
            }
            
            await firebaseService.setDocument('wallets', userId, {
                balance: newBalance,
                totalSpent: (wallet?.totalSpent || 0) + amount,
                updatedAt: new Date()
            });
            
            // 거래 내역 저장
            const transaction = {
                type: transactionType,
                amount: -amount,
                balanceAfter: newBalance,
                description,
                metadata,
                createdAt: new Date()
            };
            
            await firebaseService.setDocument(
                `wallets/${userId}/transactions`,
                `txn_${Date.now()}`,
                transaction
            );
            
            this.currentBalance = newBalance;
            
            // 이벤트 발행
            eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, { balance: newBalance });
            eventBus.emit(WALLET_EVENTS.TRANSACTION_ADDED, { transaction });
            
            log.info(`Points deducted: -${amount} pt, new balance: ${newBalance} pt`);
            return { success: true, newBalance };
            
        } catch (error) {
            log.error('Failed to deduct points:', error);
            throw error;
        }
    }
    
    /**
     * 거래 내역 가져오기
     */
    getTransactions() {
        return this.transactions;
    }
    
    /**
     * 관리자: 사용자 잔액 조회
     */
    async getWalletByUserId(userId) {
        try {
            return await firebaseService.getDocument('wallets', userId);
        } catch (error) {
            log.error('Failed to get wallet:', error);
            return null;
        }
    }
    
    /**
     * 관리자: 포인트 조정
     */
    async adminAdjustPoints(userId, amount, description = 'Admin adjustment') {
        const currentUser = firebaseService.getCurrentUser();
        if (!currentUser) {
            throw new Error('Authentication required');
        }
        
        // TODO: 관리자 권한 체크
        
        try {
            const wallet = await firebaseService.getDocument('wallets', userId);
            const currentBalance = wallet?.balance || 0;
            const newBalance = currentBalance + amount;
            
            if (newBalance < 0) {
                throw new Error('Balance cannot be negative');
            }
            
            await firebaseService.setDocument('wallets', userId, {
                balance: newBalance,
                updatedAt: new Date()
            });
            
            // 거래 내역 저장
            await firebaseService.setDocument(
                `wallets/${userId}/transactions`,
                `txn_admin_${Date.now()}`,
                {
                    type: TRANSACTION_TYPE.ADMIN,
                    amount,
                    balanceAfter: newBalance,
                    description,
                    adminId: currentUser.uid,
                    createdAt: new Date()
                }
            );
            
            log.info(`Admin adjusted points for ${userId}: ${amount > 0 ? '+' : ''}${amount} pt`);
            return { success: true, newBalance };
            
        } catch (error) {
            log.error('Admin adjust failed:', error);
            throw error;
        }
    }
    
    /**
     * 포맷된 잔액 문자열
     */
    getFormattedBalance() {
        return `${this.currentBalance.toLocaleString()} pt`;
    }
    
    /**
     * 정리
     */
    cleanup() {
        if (this.unsubscriber) {
            this.unsubscriber();
        }
        this.currentBalance = 0;
        this.transactions = [];
        this.initialized = false;
    }
}

// 싱글톤 인스턴스
export const walletService = new WalletService();
export default walletService;

