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
    ADMIN: 'admin',            // 관리자 조정
    STARTER_BONUS: 'starter_bonus'  // 스타터 보너스 (회원가입 시 지급)
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
            log.info('[WalletService] Already initialized');
            return true;
        }
        
        try {
            log.info('[WalletService] 🔄 Initializing...');
            
            // ⚠️ 전문가 조언: 인증 상태 변경 감시 (로그 추가)
            eventBus.on(EVENTS.AUTH_STATE_CHANGED, ({ user }) => {
                log.info(`[WalletService] 🔐 AUTH_STATE_CHANGED event received: user=${user ? user.uid : 'null'}`);
                if (user) {
                    log.info(`[WalletService] 👤 Loading wallet for user: ${user.uid}`);
                    this.loadUserWallet(user.uid);
                } else {
                    log.info('[WalletService] 👋 User logged out, clearing wallet');
                    this.clearWallet();
                }
            });
            
            // 현재 로그인된 사용자가 있으면 지갑 로드
            // ⚠️ 새로고침 시 인증 상태 복원을 기다리기 위해 약간의 지연 추가
            const checkUser = async () => {
                const currentUser = firebaseService.getCurrentUser();
                if (currentUser) {
                    log.info(`[WalletService] 👤 Current user found: ${currentUser.uid}, loading wallet...`);
                    await this.loadUserWallet(currentUser.uid);
                } else {
                    log.info('[WalletService] ℹ️ No current user, waiting for login...');
                    // 인증 상태 복원을 기다림 (최대 3초)
                    let retryCount = 0;
                    const maxRetries = 6; // 500ms * 6 = 3초
                    const checkInterval = setInterval(() => {
                        retryCount++;
                        const delayedUser = firebaseService.getCurrentUser();
                        if (delayedUser) {
                            log.info(`[WalletService] 👤 User found after ${retryCount * 500}ms: ${delayedUser.uid}, loading wallet...`);
                            clearInterval(checkInterval);
                            this.loadUserWallet(delayedUser.uid).catch(err => {
                                log.error('[WalletService] Failed to load wallet after retry:', err);
                            });
                        } else if (retryCount >= maxRetries) {
                            log.info('[WalletService] ℹ️ No user found after waiting, will load when user logs in');
                            clearInterval(checkInterval);
                        }
                    }, 500);
                }
            };
            
            // 약간의 지연 후 사용자 확인 (Firebase 인증 상태 복원 대기)
            setTimeout(checkUser, 100);
            
            this.initialized = true;
            log.info('[WalletService] ✅ Initialized successfully');
            return true;
            
        } catch (error) {
            log.error('[WalletService] ❌ Initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 사용자 지갑 로드
     */
    async loadUserWallet(userId) {
        try {
            log.info(`[WalletService] 🔄 loadUserWallet called for userId: ${userId}`);
            
            // 기존 구독 해제
            if (this.unsubscriber) {
                log.info('[WalletService] 🔄 Unsubscribing from previous wallet listener');
                this.unsubscriber();
            }
            
            // ⚠️ 전문가 조언: Firestore에서 지갑 데이터 가져오기 (로그 추가)
            log.info(`[WalletService] 📡 Fetching wallet from Firestore: wallets/${userId}`);
            let wallet = await firebaseService.getDocument('wallets', userId);
            
            if (!wallet) {
                log.info(`[WalletService] 💼 Wallet not found, creating new wallet for user: ${userId}`);
                // 새 지갑 생성 + 스타터 포인트 지급
                const STARTER_POINTS = 400; // 4달러 상당 (전문가 제안: 3~5달러 상당)
                
                wallet = {
                    userId,
                    balance: STARTER_POINTS,
                    totalCharged: 0,
                    totalSpent: 0,
                    starterBonusGiven: true,
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                await firebaseService.setDocument('wallets', userId, wallet, false); // merge=false로 새 문서 생성
                
                // 스타터 보너스 거래 내역 저장
                const transaction = {
                    type: TRANSACTION_TYPE.STARTER_BONUS,
                    amount: STARTER_POINTS,
                    balanceAfter: STARTER_POINTS,
                    description: 'Welcome Bonus - 스타터 포인트',
                    metadata: {
                        reason: 'new_user_registration',
                        message: '회원가입을 환영합니다! 첫 영토 구매에 사용할 수 있는 포인트를 드립니다.'
                    },
                    createdAt: new Date()
                };
                
                await firebaseService.setDocument(
                    `wallets/${userId}/transactions`,
                    `txn_starter_${Date.now()}`,
                    transaction
                );
                
                // 스타터 보너스 이벤트 발행
                log.info(`[WalletService] 🎉 Emitting BALANCE_UPDATED event: balance=${STARTER_POINTS}`);
                eventBus.emit(WALLET_EVENTS.TRANSACTION_ADDED, { transaction });
                eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, { balance: STARTER_POINTS });
                
                log.info(`[WalletService] ✅ New wallet created for user ${userId} with ${STARTER_POINTS} starter points`);
            } else {
                // 기존 지갑 데이터 검증 및 수정
                if (typeof wallet.balance !== 'number' || isNaN(wallet.balance)) {
                    log.warn(`[WalletService] Invalid balance for user ${userId}, resetting to 0. Current value:`, wallet.balance);
                    wallet.balance = 0;
                    await firebaseService.updateDocument('wallets', userId, {
                        balance: 0,
                        updatedAt: new Date()
                    });
                }
            }
            
            // balance가 명시적으로 설정되어 있는지 확인
            this.currentBalance = (typeof wallet.balance === 'number' && !isNaN(wallet.balance)) ? wallet.balance : 0;
            
            log.info(`[WalletService] ✅ Wallet loaded for user ${userId}: balance=${this.currentBalance} pt`);
            
            // ⚠️ 전문가 조언: 실시간 구독 설정 (로그 추가)
            log.info(`[WalletService] 📡 Setting up real-time listener for wallets/${userId}`);
            this.unsubscriber = firebaseService.subscribeToDocument('wallets', userId, (data) => {
                if (data) {
                    const newBalance = data.balance || 0;
                    log.info(`[WalletService] 🔔 Real-time update received: balance=${newBalance} pt`);
                    this.currentBalance = newBalance;
                    log.info(`[WalletService] 🎉 Emitting BALANCE_UPDATED event: balance=${newBalance}`);
                    eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, {
                        balance: this.currentBalance
                    });
                } else {
                    log.warn('[WalletService] ⚠️ Real-time update received but data is null');
                }
            });
            
            // 최근 거래 내역 로드
            await this.loadTransactions(userId);
            
            // ⚠️ 전문가 조언: 잔액 업데이트 이벤트 발행 (로그 추가)
            log.info(`[WalletService] 🎉 Emitting initial BALANCE_UPDATED event: balance=${this.currentBalance}`);
            eventBus.emit(WALLET_EVENTS.BALANCE_UPDATED, {
                balance: this.currentBalance
            });
            
            log.info(`[WalletService] ✅ Wallet fully loaded: ${this.currentBalance} pt`);
            
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
     * 잔액 새로고침 (서버에서 업데이트된 경우)
     */
    async refreshBalance() {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            log.warn('[WalletService] Cannot refresh balance: user not authenticated');
            return;
        }
        
        try {
            await this.loadUserWallet(user.uid);
            log.info('[WalletService] Balance refreshed');
        } catch (error) {
            log.error('[WalletService] Failed to refresh balance:', error);
        }
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
            
            // updateDocument를 사용하여 기존 필드 유지하면서 업데이트
            await firebaseService.updateDocument('wallets', userId, {
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
            
            // updateDocument를 사용하여 기존 필드 유지하면서 업데이트
            await firebaseService.updateDocument('wallets', userId, {
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

