/**
 * Ownership Engine - v2 Architecture
 * 책임: 경제 시스템 (소유권, 경매, 결제, 통계)
 */
class OwnershipEngine {
    constructor(firestore, auth) {
        this.firestore = firestore;
        this.auth = auth;
        this.eventBus = window.EventBus;
        
        // 데이터 저장소
        this.ownerships = new Map(); // regionId -> ownership data
        this.auctions = new Map(); // regionId -> auction data
        this.wallets = new Map(); // userId -> wallet data
        
        // Firestore 리스너
        this.firestoreListeners = new Map(); // regionId -> unsubscribe function
        
        // 현재 사용자
        this.currentUser = null;
        
        // 색상 매핑
        this.colorMap = new Map(); // regionId -> color
    }

    /**
     * 초기화
     */
    async initialize() {
        try {
            // 현재 사용자 확인
            this.currentUser = this.auth.currentUser;
            
            // 인증 상태 변경 리스너
            this.auth.onAuthStateChanged((user) => {
                this.currentUser = user;
                if (user) {
                    this.loadUserWallet(user.uid);
                }
            });

            // Event Bus 구독
            this.subscribeToEvents();

            // Event Bus 요청 핸들러 등록
            this.registerRequestHandlers();

            console.log('[OwnershipEngine] 초기화 완료');
        } catch (error) {
            console.error('[OwnershipEngine] 초기화 실패:', error);
            throw error;
        }
    }

    /**
     * Event Bus 구독
     */
    subscribeToEvents() {
        // 화면 영역 변경 시 선택된 region만 구독
        this.eventBus.on('viewport:changed', (data) => {
            this.subscribeToVisibleRegions(data.visible);
        });

        // Region 클릭 시 경매 데이터 로딩
        this.eventBus.on('region:clicked', (data) => {
            this.loadAuctionData(data.regionId);
        });
    }

    /**
     * Event Bus 요청 핸들러 등록
     */
    registerRequestHandlers() {
        // 소유권 조회
        this.eventBus.registerRequestHandler('ownership:get', async (data) => {
            return await this.getOwnership(data.regionId);
        });

        // 소유권 검증
        this.eventBus.registerRequestHandler('ownership:verify', async (data) => {
            return await this.verifyOwnership(data.regionId, data.userId || this.currentUser?.uid);
        });

        // 경매 조회
        this.eventBus.registerRequestHandler('auction:get', async (data) => {
            return await this.getAuction(data.regionId);
        });

        // 지갑 조회
        this.eventBus.registerRequestHandler('wallet:get', async (data) => {
            return await this.getWallet(data.userId || this.currentUser?.uid);
        });
    }

    /**
     * 화면에 보이는 Region만 Firestore 구독
     * @param {Array<string>} regionIds - Region ID 배열
     */
    subscribeToVisibleRegions(regionIds) {
        // 기존 리스너 해제 (더 이상 보이지 않는 region)
        this.firestoreListeners.forEach((unsubscribe, regionId) => {
            if (!regionIds.includes(regionId)) {
                unsubscribe();
                this.firestoreListeners.delete(regionId);
            }
        });

        // 새로 보이는 region 구독
        regionIds.forEach(regionId => {
            if (!this.firestoreListeners.has(regionId)) {
                this.subscribeToOwnership(regionId);
            }
        });
    }

    /**
     * 특정 Region의 소유권 구독
     * @param {string} regionId - Region ID
     */
    subscribeToOwnership(regionId) {
        const ownershipRef = this.firestore.collection('ownerships').doc(regionId);
        
        const unsubscribe = ownershipRef.onSnapshot(
            (doc) => {
                if (doc.exists) {
                    const ownership = { id: doc.id, ...doc.data() };
                    this.ownerships.set(regionId, ownership);
                    this.updateOwnershipColor(regionId, ownership);
                    this.notifyMapEngine(regionId, ownership);
                } else {
                    // 소유권이 없으면 기본값
                    this.ownerships.delete(regionId);
                    this.updateOwnershipColor(regionId, null);
                    this.notifyMapEngine(regionId, null);
                }
            },
            (error) => {
                console.error(`[OwnershipEngine] 소유권 구독 실패 (${regionId}):`, error);
            }
        );

        this.firestoreListeners.set(regionId, unsubscribe);
    }

    /**
     * 소유권 조회
     * @param {string} regionId - Region ID
     * @returns {Promise<Object|null>}
     */
    async getOwnership(regionId) {
        // 캐시에서 먼저 확인
        if (this.ownerships.has(regionId)) {
            return this.ownerships.get(regionId);
        }

        // Firestore에서 조회
        try {
            const doc = await this.firestore.collection('ownerships').doc(regionId).get();
            if (doc.exists) {
                const ownership = { id: doc.id, ...doc.data() };
                this.ownerships.set(regionId, ownership);
                return ownership;
            }
            return null;
        } catch (error) {
            console.error(`[OwnershipEngine] 소유권 조회 실패 (${regionId}):`, error);
            return null;
        }
    }

    /**
     * 소유권 검증
     * @param {string} regionId - Region ID
     * @param {string} userId - 사용자 ID
     * @returns {Promise<boolean>}
     */
    async verifyOwnership(regionId, userId) {
        const ownership = await this.getOwnership(regionId);
        return ownership?.ownerId === userId && ownership?.status === 'owned';
    }

    /**
     * 소유권 색상 업데이트
     * @param {string} regionId - Region ID
     * @param {Object|null} ownership - 소유권 데이터
     */
    updateOwnershipColor(regionId, ownership) {
        let color = '#cccccc'; // 기본 색상 (소유권 없음)

        if (ownership) {
            if (ownership.status === 'owned') {
                // 소유 중: 소유자별 색상 (해시 기반)
                color = this.generateOwnerColor(ownership.ownerId);
            } else if (ownership.status === 'auction') {
                // 경매 중: 파란색
                color = '#3b82f6';
            } else if (ownership.status === 'available') {
                // 구매 가능: 주황색
                color = '#f97316';
            }
        }

        this.colorMap.set(regionId, color);
    }

    /**
     * 소유자별 색상 생성 (해시 기반)
     * @param {string} ownerId - 소유자 ID
     * @returns {string} - Hex 색상
     */
    generateOwnerColor(ownerId) {
        // 간단한 해시 함수
        let hash = 0;
        for (let i = 0; i < ownerId.length; i++) {
            hash = ownerId.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        // 색상 생성 (밝은 색상)
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, 70%, 50%)`;
    }

    /**
     * Map Engine에 소유권 정보 전달
     * @param {string} regionId - Region ID
     * @param {Object|null} ownership - 소유권 데이터
     */
    notifyMapEngine(regionId, ownership) {
        const color = this.colorMap.get(regionId) || '#cccccc';
        this.eventBus.emit('ownership:updated', {
            regionId,
            color,
            ownership
        });
    }

    /**
     * 경매 데이터 로딩
     * @param {string} regionId - Region ID
     */
    async loadAuctionData(regionId) {
        // 이미 로딩된 경우 스킵
        if (this.auctions.has(regionId)) {
            return;
        }

        try {
            const querySnapshot = await this.firestore.collection('auctions')
                .where('regionId', '==', regionId)
                .where('status', '==', 'active')
                .limit(1)
                .get();

            if (!querySnapshot.empty) {
                const doc = querySnapshot.docs[0];
                const auction = { id: doc.id, ...doc.data() };
                this.auctions.set(regionId, auction);
                
                // Event Bus에 알림
                this.eventBus.emit('auction:loaded', {
                    regionId,
                    auction
                });
            }
        } catch (error) {
            console.error(`[OwnershipEngine] 경매 데이터 로딩 실패 (${regionId}):`, error);
        }
    }

    /**
     * 경매 조회
     * @param {string} regionId - Region ID
     * @returns {Promise<Object|null>}
     */
    async getAuction(regionId) {
        // 캐시에서 먼저 확인
        if (this.auctions.has(regionId)) {
            return this.auctions.get(regionId);
        }

        // Firestore에서 조회
        await this.loadAuctionData(regionId);
        return this.auctions.get(regionId) || null;
    }

    /**
     * 경매 생성
     * @param {Object} auctionData - 경매 데이터
     * @returns {Promise<string>} - 경매 ID
     */
    async createAuction(auctionData) {
        try {
            const docRef = await this.firestore.collection('auctions').add({
                ...auctionData,
                status: 'active',
                createdAt: this.firestore.FieldValue.serverTimestamp(),
                updatedAt: this.firestore.FieldValue.serverTimestamp()
            });

            const auction = { id: docRef.id, ...auctionData };
            this.auctions.set(auctionData.regionId, auction);

            // Event Bus에 알림
            this.eventBus.emit('auction:created', {
                regionId: auctionData.regionId,
                auction
            });

            return docRef.id;
        } catch (error) {
            console.error('[OwnershipEngine] 경매 생성 실패:', error);
            throw error;
        }
    }

    /**
     * 입찰
     * @param {string} auctionId - 경매 ID
     * @param {number} bidAmount - 입찰 금액
     * @returns {Promise<boolean>}
     */
    async placeBid(auctionId, bidAmount) {
        if (!this.currentUser) {
            throw new Error('로그인이 필요합니다.');
        }

        try {
            const auctionRef = this.firestore.collection('auctions').doc(auctionId);
            const auctionDoc = await auctionRef.get();

            if (!auctionDoc.exists) {
                throw new Error('경매를 찾을 수 없습니다.');
            }

            const auction = auctionDoc.data();
            
            // 입찰 금액 검증
            if (bidAmount <= (auction.currentBid || auction.startingPrice)) {
                throw new Error('현재 입찰가보다 높은 금액을 입력해주세요.');
            }

            // 지갑 잔액 확인
            const wallet = await this.getWallet(this.currentUser.uid);
            if (wallet.balance < bidAmount) {
                throw new Error('잔액이 부족합니다.');
            }

            // 입찰 처리
            await auctionRef.update({
                currentBid: bidAmount,
                currentBidder: this.currentUser.uid,
                bidCount: (auction.bidCount || 0) + 1,
                updatedAt: this.firestore.FieldValue.serverTimestamp()
            });

            // Event Bus에 알림
            this.eventBus.emit('auction:bidPlaced', {
                auctionId,
                regionId: auction.regionId,
                bidAmount,
                bidder: this.currentUser.uid
            });

            return true;
        } catch (error) {
            console.error('[OwnershipEngine] 입찰 실패:', error);
            throw error;
        }
    }

    /**
     * 지갑 조회
     * @param {string} userId - 사용자 ID
     * @returns {Promise<Object>}
     */
    async getWallet(userId) {
        // 캐시에서 먼저 확인
        if (this.wallets.has(userId)) {
            return this.wallets.get(userId);
        }

        // Firestore에서 조회
        try {
            const doc = await this.firestore.collection('wallets').doc(userId).get();
            if (doc.exists) {
                const wallet = { id: doc.id, ...doc.data() };
                this.wallets.set(userId, wallet);
                return wallet;
            } else {
                // 지갑이 없으면 생성
                const wallet = {
                    id: userId,
                    balance: 0,
                    transactions: []
                };
                await this.firestore.collection('wallets').doc(userId).set(wallet);
                this.wallets.set(userId, wallet);
                return wallet;
            }
        } catch (error) {
            console.error(`[OwnershipEngine] 지갑 조회 실패 (${userId}):`, error);
            throw error;
        }
    }

    /**
     * 사용자 지갑 로딩
     * @param {string} userId - 사용자 ID
     */
    async loadUserWallet(userId) {
        const walletRef = this.firestore.collection('wallets').doc(userId);
        
        walletRef.onSnapshot(
            (doc) => {
                if (doc.exists) {
                    const wallet = { id: doc.id, ...doc.data() };
                    this.wallets.set(userId, wallet);
                    
                    // Event Bus에 알림
                    this.eventBus.emit('wallet:updated', {
                        userId,
                        wallet
                    });
                }
            },
            (error) => {
                console.error(`[OwnershipEngine] 지갑 구독 실패 (${userId}):`, error);
            }
        );
    }

    /**
     * 포인트 충전
     * @param {string} userId - 사용자 ID
     * @param {number} amount - 충전 금액
     * @returns {Promise<boolean>}
     */
    async chargePoints(userId, amount) {
        try {
            const walletRef = this.firestore.collection('wallets').doc(userId);
            await walletRef.update({
                balance: this.firestore.FieldValue.increment(amount),
                updatedAt: this.firestore.FieldValue.serverTimestamp()
            });

            // 거래 내역 추가
            await this.addTransaction(userId, {
                type: 'charge',
                amount,
                timestamp: this.firestore.FieldValue.serverTimestamp()
            });

            return true;
        } catch (error) {
            console.error('[OwnershipEngine] 포인트 충전 실패:', error);
            throw error;
        }
    }

    /**
     * 거래 내역 추가
     * @param {string} userId - 사용자 ID
     * @param {Object} transaction - 거래 데이터
     */
    async addTransaction(userId, transaction) {
        try {
            await this.firestore.collection('wallets').doc(userId)
                .collection('transactions').add({
                    ...transaction,
                    createdAt: this.firestore.FieldValue.serverTimestamp()
                });
        } catch (error) {
            console.error('[OwnershipEngine] 거래 내역 추가 실패:', error);
        }
    }

    /**
     * 모든 리스너 해제
     */
    unsubscribeAll() {
        this.firestoreListeners.forEach((unsubscribe) => {
            unsubscribe();
        });
        this.firestoreListeners.clear();
    }

    /**
     * 정리 및 리소스 해제
     */
    destroy() {
        this.unsubscribeAll();
        this.ownerships.clear();
        this.auctions.clear();
        this.wallets.clear();
        this.colorMap.clear();
    }
}

// 전역으로 내보내기
window.OwnershipEngine = OwnershipEngine;

