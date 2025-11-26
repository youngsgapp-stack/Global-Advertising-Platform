const FIRESTORE_SDK = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
const AUTH_SDK = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

class AdminDashboard {
    constructor() {
        this.refreshIntervalMs = 60 * 1000;
        this.refreshTimer = null;
        this.firestoreModulePromise = import(FIRESTORE_SDK);
        this.sessionExpiry = null;
        this.currentUser = null;
        this.ADMIN_SESSION_KEY = 'worldad.adminSession';
        this.sessionSyncInitialized = false;
        this.sessionResumeInFlight = false;
        this.state = {
            summary: {
                totalRegions: 0,
                occupiedRegions: 0,
                occupancyRate: 0,
                availableRegions: 0,
                totalRevenue: 0,
                activeAuctions: 0,
                recentBidCount: 0,
                communityReward: 0,
                freePixelPool: 0,
                pendingReports: 0
            },
            topRegions: [],
            regionsForExport: [],
            activeAuctions: [],
            recentPurchases: [],
            pendingReports: [],
            systemLogs: [],
            auditLogs: []
        };
        this.toastTimer = null;
        // 실시간 리스너 구독 해제 함수들
        this.regionUnsubscribe = null;
        this.auctionUnsubscribe = null;
        this.purchaseUnsubscribe = null;
        this.reportUnsubscribe = null;
        this.poolUnsubscribe = null;
        this.logUnsubscribe = null;
        this.auditUnsubscribe = null;

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.refreshAll();
            }
        });

        if (typeof window !== 'undefined') {
            this.setupAdminSessionSync();
        }

        this.init();
    }

    async init() {
        try {
            await this.initializeFirebase();
            this.setupEventListeners();

            // localStorage 세션 확인 및 Firebase Auth 로그인 시도
            const storedSession = this.getStoredAdminSession();
            let initialResumeAttempted = false;
            if (storedSession && !this.isAdminSessionExpired(storedSession)) {
                console.log('[ADMIN] localStorage 세션 확인됨, Firebase Auth 로그인 시도');
                initialResumeAttempted = true;
                const resumed = await this.tryResumeAdminSession(storedSession);
                if (!resumed && storedSession.signature) {
                    // signature가 있는 경우에만 tryResumeAdminSession을 호출했지만 실패한 경우
                    console.warn('[ADMIN] Firebase Auth 로그인 실패, 하지만 세션이 유효하므로 계속 진행');
                } else if (!resumed && !storedSession.signature) {
                    // signature가 없는 세션은 script.js에서 생성한 세션
                    // Firestore 규칙에 의존하여 권한 확인
                    console.log('[ADMIN] signature가 없는 세션 확인됨, Firestore 규칙에 의존하여 진행');
                }
            }

            // onAuthStateChanged가 즉시 실행되는 것을 방지하기 위한 플래그
            let authStateChangeHandled = false;
            let sessionResumeInProgress = false;

            this.firebaseAuth.onAuthStateChanged(async (user) => {
                // 중복 실행 방지
                if (authStateChangeHandled && !user) {
                    return;
                }

                // 세션 재개가 진행 중이면 대기
                if (sessionResumeInProgress) {
                    console.log('[ADMIN] 세션 재개 진행 중, 대기...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                if (!user) {
                    const storedSession = this.getStoredAdminSession();
                    if (storedSession && !this.isAdminSessionExpired(storedSession)) {
                        // localStorage 세션이 있으면 Firebase Auth 로그인 시도
                        console.log('[ADMIN] localStorage 세션 확인됨, Firebase Auth 로그인 시도');
                        sessionResumeInProgress = true;
                        const resumed = await this.tryResumeAdminSession(storedSession);
                        sessionResumeInProgress = false;
                        if (resumed) {
                            // 로그인 성공하면 아래 코드에서 처리됨
                            authStateChangeHandled = false; // 재시도 허용
                            return;
                        }
                        // signature가 없는 세션인 경우 Firestore 규칙에 의존
                        if (!storedSession.signature) {
                            console.log('[ADMIN] signature가 없는 세션, Firestore 규칙에 의존하여 진행');
                            // Firestore 접근 시도하여 권한 확인
                            try {
                                const { collection, getDocs, limit, query } = await this.firestoreModulePromise;
                                const testRef = collection(this.firestore, 'regions');
                                await getDocs(query(testRef, limit(1)));
                                // 성공하면 권한이 있는 것으로 간주
                                console.log('[ADMIN] Firestore 접근 성공, 관리자 권한 확인됨');
                                authStateChangeHandled = true;
                                // 실시간 리스너 설정
                                this.setupRealtimeListeners();
                                await this.refreshAll(true);
                                this.startAutoRefresh();
                                return;
                            } catch (testError) {
                                console.error('[ADMIN] Firestore 접근 실패, 권한 없음', testError);
                                if (testError.code === 'permission-denied') {
                                    this.redirectToMap('관리자 권한이 필요합니다.');
                                    return;
                                }
                            }
                        }
                        // 로그인 실패하면 리다이렉트
                        this.redirectToMap('관리자 로그인이 필요합니다.');
                        return;
                    }
                    // 초기 세션 재개 시도가 있었으면 리다이렉트 지연
                    if (initialResumeAttempted) {
                        console.log('[ADMIN] 초기 세션 재개 시도 후 사용자 없음, 잠시 대기 후 재확인');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        if (!this.firebaseAuth.currentUser) {
                            this.redirectToMap('관리자 로그인이 필요합니다.');
                        }
                        return;
                    }
                    this.redirectToMap('관리자 로그인이 필요합니다.');
                    return;
                }

                try {
                    const tokenResult = await user.getIdTokenResult(true);
                    if (tokenResult?.claims?.role !== 'admin') {
                        // Firebase Auth에 admin 권한이 없으면 localStorage 세션 확인
                        const storedSession = this.getStoredAdminSession();
                        if (storedSession && !this.isAdminSessionExpired(storedSession)) {
                            console.log('[ADMIN] localStorage 세션 확인됨, Firebase Auth 로그인 재시도');
                            sessionResumeInProgress = true;
                            const resumed = await this.tryResumeAdminSession(storedSession);
                            sessionResumeInProgress = false;
                            if (resumed) {
                                authStateChangeHandled = false; // 재시도 허용
                                return;
                            }
                            // signature가 없는 세션인 경우 Firestore 규칙에 의존
                            if (!storedSession.signature) {
                                console.log('[ADMIN] signature가 없는 세션, Firestore 규칙에 의존하여 진행');
                                try {
                                    const { collection, getDocs, limit, query } = await this.firestoreModulePromise;
                                    const testRef = collection(this.firestore, 'regions');
                                    await getDocs(query(testRef, limit(1)));
                                    console.log('[ADMIN] Firestore 접근 성공, 관리자 권한 확인됨');
                                    authStateChangeHandled = true;
                                    this.setupRealtimeListeners();
                                    await this.refreshAll(true);
                                    this.startAutoRefresh();
                                    return;
                                } catch (testError) {
                                    if (testError.code === 'permission-denied') {
                                        this.redirectToMap('관리자 권한이 필요합니다.');
                                        return;
                                    }
                                }
                            }
                        }
                        this.redirectToMap('관리자 권한이 필요합니다.');
                        return;
                    }

                    this.currentUser = user;
                    this.sessionExpiry = tokenResult.expirationTime ? new Date(tokenResult.expirationTime) : null;
                    this.updateSessionMeta();
                    authStateChangeHandled = true;

                    // 실시간 리스너 설정
                    this.setupRealtimeListeners();
                    
                    await this.refreshAll(true);
                    this.startAutoRefresh();
                } catch (error) {
                    console.error('[ADMIN] 토큰 확인 실패', error);
                    // 에러 발생 시에도 localStorage 세션 확인
                    const storedSession = this.getStoredAdminSession();
                    if (storedSession && !this.isAdminSessionExpired(storedSession)) {
                        console.log('[ADMIN] localStorage 세션 확인됨, Firebase Auth 로그인 재시도');
                        sessionResumeInProgress = true;
                        const resumed = await this.tryResumeAdminSession(storedSession);
                        sessionResumeInProgress = false;
                        if (resumed) {
                            authStateChangeHandled = false; // 재시도 허용
                            return;
                        }
                        // signature가 없는 세션인 경우 Firestore 규칙에 의존
                        if (!storedSession.signature) {
                            console.log('[ADMIN] signature가 없는 세션, Firestore 규칙에 의존하여 진행');
                            try {
                                const { collection, getDocs, limit, query } = await this.firestoreModulePromise;
                                const testRef = collection(this.firestore, 'regions');
                                await getDocs(query(testRef, limit(1)));
                                console.log('[ADMIN] Firestore 접근 성공, 관리자 권한 확인됨');
                                authStateChangeHandled = true;
                                this.setupRealtimeListeners();
                                await this.refreshAll(true);
                                this.startAutoRefresh();
                                return;
                            } catch (testError) {
                                if (testError.code === 'permission-denied') {
                                    this.redirectToMap('관리자 권한 확인에 실패했습니다.');
                                    return;
                                }
                            }
                        }
                    }
                    this.redirectToMap('관리자 권한 확인에 실패했습니다.');
                }
            });
            
            // 초기 세션 재개 시도
            if (!this.firebaseAuth.currentUser) {
                await this.tryResumeAdminSession();
            }
        } catch (error) {
            console.error('[ADMIN] Firebase 초기화 실패', error);
            this.showToast('Firebase 초기화에 실패했습니다.', 'error');
        }
    }

    updateSessionMeta() {
        const expiryEl = document.getElementById('admin-session-expiry');
        if (!expiryEl || !this.sessionExpiry) return;
        expiryEl.textContent = this.sessionExpiry.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    }

    redirectToMap(message) {
        if (message) {
            this.showToast(message, 'info');
        }
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 600);
    }

    setupEventListeners() {
        document.getElementById('admin-refresh-btn')?.addEventListener('click', () => {
            this.refreshAll(true);
        });

        document.getElementById('admin-logout-btn')?.addEventListener('click', () => {
            this.signOutAdmin();
        });

        document.getElementById('return-to-map-btn')?.addEventListener('click', () => {
            window.location.href = 'index.html';
        });

        document.getElementById('open-map-moderation-btn')?.addEventListener('click', () => {
            sessionStorage.setItem('worldad.adminDeepLink', JSON.stringify({ panel: 'moderation' }));
            window.location.href = 'index.html';
        });

        document.getElementById('copy-log-btn')?.addEventListener('click', () => {
            this.copyLogsToClipboard();
        });

        document.getElementById('download-region-csv-btn')?.addEventListener('click', () => {
            this.downloadRegionCSV();
        });
    }

    getStoredAdminSession() {
        if (typeof window === 'undefined' || !window.localStorage) {
            return null;
        }
        try {
            const raw = window.localStorage.getItem(this.ADMIN_SESSION_KEY);
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            // script.js에서 생성한 세션은 sessionId만 있고 signature가 없을 수 있음
            // Firebase Functions에서 생성한 세션은 sessionId와 signature가 모두 있음
            if (!parsed?.sessionId) {
                return null;
            }
            // signature가 없어도 sessionId가 있으면 유효한 세션으로 인식
            return parsed;
        } catch (error) {
            console.warn('[ADMIN] 세션 정보를 불러오지 못했습니다.', error);
            return null;
        }
    }

    isAdminSessionExpired(session) {
        if (!session) return true;
        const expiresAt = Number(session.expiresAt);
        if (!Number.isFinite(expiresAt)) {
            return true;
        }
        return expiresAt <= Date.now();
    }

    persistAdminSession(session) {
        if (typeof window === 'undefined' || !window.localStorage) {
            return;
        }
        if (!session?.sessionId) {
            return;
        }
        try {
            const payload = {
                sessionId: session.sessionId,
                issuedAt: session.issuedAt,
                expiresAt: session.expiresAt,
                signature: session.signature
            };
            window.localStorage.setItem(this.ADMIN_SESSION_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn('[ADMIN] 세션 정보를 저장하지 못했습니다.', error);
        }
    }

    clearPersistedAdminSession() {
        if (typeof window === 'undefined' || !window.localStorage) {
            return;
        }
        try {
            window.localStorage.removeItem(this.ADMIN_SESSION_KEY);
        } catch (error) {
            console.warn('[ADMIN] 세션 정보를 삭제하지 못했습니다.', error);
        }
    }

    setupAdminSessionSync() {
        if (this.sessionSyncInitialized || typeof window === 'undefined') {
            return;
        }
        this.sessionSyncInitialized = true;
        window.addEventListener('storage', (event) => {
            if (event.key !== this.ADMIN_SESSION_KEY) {
                return;
            }
            if (!event.newValue) {
                this.handleExternalAdminLogout();
                return;
            }
            try {
                const parsed = JSON.parse(event.newValue);
                if (this.isAdminSessionExpired(parsed)) {
                    return;
                }
                if (!this.firebaseAuth || !this.isFirebaseInitialized) {
                    return;
                }
                if (this.firebaseAuth.currentUser) {
                    return;
                }
                this.tryResumeAdminSession(parsed);
            } catch (error) {
                console.warn('[ADMIN] 세션 동기화 실패', error);
            }
        });
    }

    async handleExternalAdminLogout() {
        this.clearPersistedAdminSession();
        if (!this.firebaseAuth || !this.isFirebaseInitialized) {
            this.redirectToMap();
            return;
        }
        if (!this.firebaseAuth.currentUser) {
            this.redirectToMap();
            return;
        }
        try {
            const { signOut } = await import(AUTH_SDK);
            await signOut(this.firebaseAuth);
        } catch (error) {
            console.warn('[ADMIN] 외부 세션 종료 실패', error);
        } finally {
            this.redirectToMap();
        }
    }

    async tryResumeAdminSession(sessionOverride = null) {
        if (!this.isFirebaseInitialized || !this.firebaseApp || !this.firebaseAuth) {
            console.warn('[ADMIN] Firebase가 초기화되지 않았습니다.');
            return false;
        }
        if (this.sessionResumeInFlight) {
            console.log('[ADMIN] 세션 재개가 이미 진행 중입니다.');
            return false;
        }
        if (this.firebaseAuth.currentUser) {
            console.log('[ADMIN] 이미 로그인된 사용자가 있습니다.');
            return true;
        }
        const session = sessionOverride || this.getStoredAdminSession();
        if (!session) {
            console.log('[ADMIN] 저장된 세션이 없습니다.');
            return false;
        }
        if (this.isAdminSessionExpired(session)) {
            console.warn('[ADMIN] 세션이 만료되었습니다.');
            this.clearPersistedAdminSession();
            return false;
        }

        // signature가 없는 세션은 script.js에서 생성한 세션일 수 있음
        // 이 경우 Firebase Functions를 호출할 수 없으므로 false 반환
        if (!session.signature) {
            console.log('[ADMIN] signature가 없는 세션 (script.js에서 생성), Firebase Functions 호출 불가');
            console.warn('[ADMIN] 권한 문제가 발생할 수 있습니다. Firebase Functions를 통해 생성된 세션을 사용하세요.');
            return false;
        }

        this.sessionResumeInFlight = true;
        try {
            const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
            const { signInWithCustomToken } = await import(AUTH_SDK);
            const functions = getFunctions(this.firebaseApp, 'asia-northeast3');
            const resumeAdminSession = httpsCallable(functions, 'resumeAdminSession');
            console.log('[ADMIN] Firebase Functions 호출: resumeAdminSession');
            const response = await resumeAdminSession({
                sessionId: session.sessionId,
                expiresAt: session.expiresAt,
                signature: session.signature
            });
            const { token, session: refreshedSession } = response?.data || {};
            if (!token) {
                throw new Error('관리자 세션 토큰을 가져오지 못했습니다.');
            }
            console.log('[ADMIN] Firebase Auth 로그인 시도');
            await signInWithCustomToken(this.firebaseAuth, token);
            await this.firebaseAuth.currentUser?.getIdToken(true);
            console.log('[ADMIN] Firebase Auth 로그인 성공');
            if (refreshedSession) {
                this.persistAdminSession(refreshedSession);
            }
            return true;
        } catch (error) {
            console.error('[ADMIN] 세션 재개 실패', error);
            console.error('[ADMIN] 에러 상세:', {
                message: error.message,
                code: error.code,
                details: error.details
            });
            return false;
        } finally {
            this.sessionResumeInFlight = false;
        }
    }

    async initializeFirebase() {
        const modules = window.firebaseModules;
        if (!modules) {
            throw new Error('Firebase 모듈이 로드되지 않았습니다.');
        }

        const { initializeApp, getAuth, getFirestore, firebaseConfig } = modules;
        this.firebaseApp = initializeApp(firebaseConfig);
        this.firebaseAuth = getAuth(this.firebaseApp);
        this.firestore = getFirestore(this.firebaseApp);
        this.isFirebaseInitialized = true;
    }

    async signOutAdmin() {
        if (!this.firebaseAuth) return;
        try {
            // 실시간 리스너 정리
            this.cleanupRealtimeListeners();
            this.stopAutoRefresh();
            
            this.clearPersistedAdminSession();
            const { signOut } = await import(AUTH_SDK);
            await signOut(this.firebaseAuth);
            this.showToast('로그아웃되었습니다.', 'info');
            this.redirectToMap();
        } catch (error) {
            console.error('[ADMIN] 로그아웃 실패', error);
            this.showToast('로그아웃에 실패했습니다.', 'error');
        }
    }

    startAutoRefresh() {
        this.stopAutoRefresh();
        // 실시간 리스너가 있으면 자동 갱신 간격을 늘림 (백업용)
        this.refreshTimer = setInterval(() => this.refreshAll(), this.refreshIntervalMs * 2);
    }

    stopAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    async setupRealtimeListeners() {
        if (!this.isFirebaseInitialized || !this.firestore) {
            console.warn('[ADMIN] Firebase가 초기화되지 않아 실시간 리스너를 설정할 수 없습니다.');
            return;
        }

        // 기존 리스너 정리
        this.cleanupRealtimeListeners();

        try {
            const { collection, onSnapshot, query, where, orderBy, limit, doc } = await this.firestoreModulePromise;

            // Regions 실시간 리스너
            const regionsRef = collection(this.firestore, 'regions');
            this.regionUnsubscribe = onSnapshot(regionsRef, 
                (snapshot) => {
                    console.log('[ADMIN] Regions 업데이트됨');
                    this.fetchRegionMetrics().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Regions 리스너 오류', error);
                    if (error.code !== 'permission-denied') {
                        this.showToast('지역 데이터 실시간 업데이트 실패', 'error');
                    }
                }
            );

            // Auctions 실시간 리스너
            const auctionsRef = collection(this.firestore, 'auctions');
            let auctionsQuery;
            try {
                auctionsQuery = query(auctionsRef, where('status', '==', 'active'), orderBy('endTime', 'asc'));
            } catch {
                auctionsQuery = query(auctionsRef, where('status', '==', 'active'));
            }
            this.auctionUnsubscribe = onSnapshot(auctionsQuery,
                (snapshot) => {
                    console.log('[ADMIN] Auctions 업데이트됨');
                    this.fetchAuctions().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Auctions 리스너 오류', error);
                    if (error.code !== 'permission-denied') {
                        this.showToast('옥션 데이터 실시간 업데이트 실패', 'error');
                    }
                }
            );

            // Purchases 실시간 리스너
            const purchasesRef = collection(this.firestore, 'purchases');
            let purchasesQuery;
            try {
                purchasesQuery = query(purchasesRef, orderBy('purchaseDate', 'desc'), limit(20));
            } catch {
                purchasesQuery = query(purchasesRef, limit(20));
            }
            this.purchaseUnsubscribe = onSnapshot(purchasesQuery,
                (snapshot) => {
                    console.log('[ADMIN] Purchases 업데이트됨');
                    this.fetchPurchases().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Purchases 리스너 오류', error);
                    if (error.code !== 'permission-denied') {
                        this.showToast('결제 데이터 실시간 업데이트 실패', 'error');
                    }
                }
            );

            // Reports 실시간 리스너
            const reportsRef = collection(this.firestore, 'reports');
            let reportsQuery;
            try {
                reportsQuery = query(reportsRef, where('status', '==', 'pending'), orderBy('createdAt', 'desc'), limit(6));
            } catch {
                reportsQuery = query(reportsRef, where('status', '==', 'pending'), limit(6));
            }
            this.reportUnsubscribe = onSnapshot(reportsQuery,
                (snapshot) => {
                    console.log('[ADMIN] Reports 업데이트됨');
                    this.fetchReports().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Reports 리스너 오류', error);
                    if (error.code !== 'permission-denied') {
                        this.showToast('신고 데이터 실시간 업데이트 실패', 'error');
                    }
                }
            );

            // Community Pool 실시간 리스너
            const poolRef = doc(this.firestore, 'communityPools', 'global');
            this.poolUnsubscribe = onSnapshot(poolRef,
                (snapshot) => {
                    console.log('[ADMIN] Community Pool 업데이트됨');
                    this.fetchCommunityPool().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Community Pool 리스너 오류', error);
                }
            );

            // System Logs 실시간 리스너
            const logsRef = collection(this.firestore, 'event_logs');
            let logsQuery;
            try {
                logsQuery = query(logsRef, orderBy('timestamp', 'desc'), limit(12));
            } catch {
                logsQuery = query(logsRef, limit(12));
            }
            this.logUnsubscribe = onSnapshot(logsQuery,
                (snapshot) => {
                    console.log('[ADMIN] System Logs 업데이트됨');
                    this.fetchSystemLogs().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] System Logs 리스너 오류', error);
                }
            );

            // Audit Logs 실시간 리스너
            const auditRef = collection(this.firestore, 'admin_audit');
            let auditQuery;
            try {
                auditQuery = query(auditRef, orderBy('createdAt', 'desc'), limit(12));
            } catch {
                auditQuery = query(auditRef, limit(12));
            }
            this.auditUnsubscribe = onSnapshot(auditQuery,
                (snapshot) => {
                    console.log('[ADMIN] Audit Logs 업데이트됨');
                    this.fetchAuditLogs().then(() => this.render());
                },
                (error) => {
                    console.error('[ADMIN] Audit Logs 리스너 오류', error);
                }
            );

            console.log('[ADMIN] 실시간 리스너 설정 완료');
        } catch (error) {
            console.error('[ADMIN] 실시간 리스너 설정 실패', error);
        }
    }

    cleanupRealtimeListeners() {
        if (this.regionUnsubscribe) {
            this.regionUnsubscribe();
            this.regionUnsubscribe = null;
        }
        if (this.auctionUnsubscribe) {
            this.auctionUnsubscribe();
            this.auctionUnsubscribe = null;
        }
        if (this.purchaseUnsubscribe) {
            this.purchaseUnsubscribe();
            this.purchaseUnsubscribe = null;
        }
        if (this.reportUnsubscribe) {
            this.reportUnsubscribe();
            this.reportUnsubscribe = null;
        }
        if (this.poolUnsubscribe) {
            this.poolUnsubscribe();
            this.poolUnsubscribe = null;
        }
        if (this.logUnsubscribe) {
            this.logUnsubscribe();
            this.logUnsubscribe = null;
        }
        if (this.auditUnsubscribe) {
            this.auditUnsubscribe();
            this.auditUnsubscribe = null;
        }
    }

    async refreshAll(notify = false) {
        if (!this.isFirebaseInitialized) return;

        this.setRefreshing(true);

        try {
            await Promise.all([
                this.fetchRegionMetrics(),
                this.fetchCommunityPool(),
                this.fetchAuctions(),
                this.fetchPurchases(),
                this.fetchReports(),
                this.fetchSystemLogs(),
                this.fetchAuditLogs()
            ]);

            this.render();

            const lastRefreshEl = document.getElementById('last-refresh-at');
            if (lastRefreshEl) {
                lastRefreshEl.textContent = `갱신: ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
            }

            if (notify) {
                this.showToast('대시보드가 업데이트되었습니다.', 'success');
            }
        } catch (error) {
            console.error('[ADMIN] 데이터 갱신 실패', error);
            console.error('[ADMIN] 에러 상세:', {
                message: error.message,
                code: error.code,
                details: error.details,
                stack: error.stack
            });
            
            // 권한 오류인 경우 특별 처리
            if (error.code === 'permission-denied' || error.message?.includes('permission')) {
                this.showToast('권한이 없습니다. 관리자 권한을 확인해주세요.', 'error');
                console.error('[ADMIN] 권한 오류 - 현재 사용자:', this.currentUser);
                console.error('[ADMIN] Firebase Auth 상태:', this.firebaseAuth?.currentUser);
            } else {
                this.showToast('데이터를 불러오지 못했습니다.', 'error');
            }
        } finally {
            this.setRefreshing(false);
        }
    }

    setRefreshing(isRefreshing) {
        const btn = document.getElementById('admin-refresh-btn');
        if (btn) {
            btn.disabled = isRefreshing;
            btn.textContent = isRefreshing ? '불러오는 중...' : '데이터 새로고침';
        }
    }

    async fetchRegionMetrics() {
        try {
            const { collection, getDocs } = await this.firestoreModulePromise;
            const regionsRef = collection(this.firestore, 'regions');
            const snapshot = await getDocs(regionsRef);

        const regions = [];
        let occupied = 0;
        snapshot.forEach(doc => {
            const data = doc.data() || {};
            const status = (data.ad_status || data.status || '').toLowerCase();
            if (status === 'occupied') occupied += 1;
            const updatedAt = data.updatedAt?.toDate?.() || (data.updatedAt ? new Date(data.updatedAt) : null);
            regions.push({
                id: doc.id,
                name: data.name_ko || data.name_en || data.regionName || doc.id,
                country: data.country || '-',
                price: Number(data.ad_price || data.adPrice || 0),
                status: status || 'available',
                updatedAt
            });
        });

        regions.sort((a, b) => {
            const statusScore = (value) => value === 'occupied' ? 0 : 1;
            const statusDiff = statusScore(a.status) - statusScore(b.status);
            if (statusDiff !== 0) return statusDiff;
            return b.price - a.price;
        });

        const totalRegions = regions.length;
        const availableRegions = Math.max(totalRegions - occupied, 0);
        const occupancyRate = totalRegions ? Math.round((occupied / totalRegions) * 100) : 0;

            this.state.summary.totalRegions = totalRegions;
            this.state.summary.occupiedRegions = occupied;
            this.state.summary.availableRegions = availableRegions;
            this.state.summary.occupancyRate = occupancyRate;
            this.state.topRegions = regions.slice(0, 12);
            this.state.regionsForExport = regions;
        } catch (error) {
            console.error('[ADMIN] fetchRegionMetrics 실패', error);
            throw error;
        }
    }

    async fetchCommunityPool() {
        try {
            const { doc, getDoc } = await this.firestoreModulePromise;
            const poolRef = doc(this.firestore, 'communityPools', 'global');
            const snapshot = await getDoc(poolRef);

            if (snapshot.exists()) {
                const data = snapshot.data();
                this.state.summary.communityReward = Number(data.rewardFund || 0);
                this.state.summary.freePixelPool = Number(data.freePixelPool || 0);
            } else {
                this.state.summary.communityReward = 0;
                this.state.summary.freePixelPool = 0;
            }
        } catch (error) {
            console.error('[ADMIN] fetchCommunityPool 실패', error);
            throw error;
        }
    }

    async fetchAuctions() {
        try {
            const { collection, query, where, getDocs, orderBy } = await this.firestoreModulePromise;
            const auctionsRef = collection(this.firestore, 'auctions');
            let auctionsQuery;
            try {
                auctionsQuery = query(
                    auctionsRef,
                    where('status', '==', 'active'),
                    orderBy('endTime', 'asc')
                );
            } catch {
                auctionsQuery = query(
                    auctionsRef,
                    where('status', '==', 'active')
                );
            }

            const snapshot = await getDocs(auctionsQuery);
        const auctions = [];
        let bidCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            bidCount += (data.bidHistory?.length || 0);
            const endTime = data.endTime?.toDate?.() || null;
            auctions.push({
                id: doc.id,
                regionName: data.regionName || data.regionNameEn || doc.id,
                country: data.country || '-',
                currentBid: Number(data.currentBid || data.startPrice || 1),
                highestBidder: data.highestBidderEmail || data.highestBidder || '-',
                endTime,
                status: data.status || 'active'
            });
        });

        auctions.sort((a, b) => {
            if (!a.endTime || !b.endTime) return 0;
            return a.endTime - b.endTime;
        });

            this.state.activeAuctions = auctions;
            this.state.summary.activeAuctions = auctions.length;
            this.state.summary.recentBidCount = bidCount;
        } catch (error) {
            console.error('[ADMIN] fetchAuctions 실패', error);
            throw error;
        }
    }

    async fetchPurchases() {
        try {
            const { collection, getDocs } = await this.firestoreModulePromise;
            const purchasesRef = collection(this.firestore, 'purchases');
            const snapshot = await getDocs(purchasesRef);

        const purchases = [];
        let totalRevenue = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            const amount = Number(data.amount || 0);
            totalRevenue += amount;

            purchases.push({
                id: doc.id,
                regionName: data.regionName || data.regionId || '-',
                buyer: data.buyerEmail || '익명',
                amount,
                status: data.status || 'completed',
                date: data.purchaseDate?.toDate?.() || null
            });
        });

            purchases.sort((a, b) => {
                const aTime = a.date?.getTime?.() || 0;
                const bTime = b.date?.getTime?.() || 0;
                return bTime - aTime;
            });

            this.state.recentPurchases = purchases.slice(0, 6);
            this.state.summary.totalRevenue = totalRevenue;
        } catch (error) {
            console.error('[ADMIN] fetchPurchases 실패', error);
            throw error;
        }
    }

    async fetchReports() {
        try {
            const { collection, query, where, orderBy, limit, getDocs } = await this.firestoreModulePromise;
            const reportsRef = collection(this.firestore, 'reports');
            let reportsQuery;
            try {
                reportsQuery = query(
                    reportsRef,
                    where('status', '==', 'pending'),
                    orderBy('createdAt', 'desc'),
                    limit(6)
                );
            } catch {
                reportsQuery = query(
                    reportsRef,
                    where('status', '==', 'pending'),
                    limit(6)
                );
            }
            const snapshot = await getDocs(reportsQuery);

        const reports = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            reports.push({
                id: doc.id,
                regionId: data.regionId || '-',
                reason: data.reason || 'other',
                details: data.details || '',
                reporter: data.reporterEmail || '익명',
                createdAt: data.createdAt?.toDate?.() || null
            });
        });

            this.state.pendingReports = reports;
            this.state.summary.pendingReports = reports.length;
        } catch (error) {
            console.error('[ADMIN] fetchReports 실패', error);
            throw error;
        }
    }

    async fetchSystemLogs() {
        try {
            const { collection, query, orderBy, limit, getDocs } = await this.firestoreModulePromise;
            const logsRef = collection(this.firestore, 'event_logs');
            let logsQuery;
            try {
                logsQuery = query(logsRef, orderBy('timestamp', 'desc'), limit(12));
            } catch {
                logsQuery = query(logsRef, limit(12));
            }

            const snapshot = await getDocs(logsQuery);
        const logs = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                timestamp: data.timestamp?.toDate?.() || new Date(data.timestamp || Date.now()),
                type: data.type || 'event',
                payload: data.data || data.payload || {}
            });
        });

            logs.sort((a, b) => b.timestamp - a.timestamp);
            this.state.systemLogs = logs;
        } catch (error) {
            console.error('[ADMIN] fetchSystemLogs 실패', error);
            throw error;
        }
    }

    async fetchAuditLogs() {
        try {
            const { collection, query, orderBy, limit, getDocs } = await this.firestoreModulePromise;
            const auditRef = collection(this.firestore, 'admin_audit');
            let auditQuery;
            try {
                auditQuery = query(auditRef, orderBy('createdAt', 'desc'), limit(12));
            } catch {
                auditQuery = query(auditRef, limit(12));
            }

            const snapshot = await getDocs(auditQuery);
        const audits = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            audits.push({
                id: doc.id,
                action: data.action || 'unknown',
                actor: data.actor || {},
                details: data.details || {},
                context: data.context || {},
                createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now())
            });
        });

            this.state.auditLogs = audits;
        } catch (error) {
            console.error('[ADMIN] fetchAuditLogs 실패', error);
            throw error;
        }
    }

    render() {
        this.renderSummary();
        this.renderRegions();
        this.renderAuctions();
        this.renderPurchases();
        this.renderReportsSection();
        this.renderLogs();
        this.renderAuditLogs();
        this.updateAuctionHealth();
    }

    renderSummary() {
        const map = {
            'total-regions': this.formatNumber(this.state.summary.totalRegions),
            'occupied-regions': this.formatNumber(this.state.summary.occupiedRegions),
            'active-auctions': this.formatNumber(this.state.summary.activeAuctions),
            'pending-reports': this.formatNumber(this.state.summary.pendingReports),
            'total-revenue': this.formatCurrency(this.state.summary.totalRevenue),
            'community-reward': this.formatCurrency(this.state.summary.communityReward)
        };

        Object.entries(map).forEach(([key, value]) => {
            const el = document.querySelector(`[data-stat="${key}"]`);
            if (el) el.textContent = value;
        });

        const occupancyEl = document.querySelector('[data-stat="occupancy-rate"]');
        if (occupancyEl) {
            occupancyEl.textContent = `점유율 ${this.state.summary.occupancyRate}%`;
        }

        const availableEl = document.querySelector('[data-stat="available-regions"]');
        if (availableEl) {
            availableEl.textContent = `가용 지역 ${this.formatNumber(this.state.summary.availableRegions)}`;
        }

        const freePixelEl = document.querySelector('[data-stat="free-pixels"]');
        if (freePixelEl) {
            freePixelEl.textContent = `무료 픽셀 풀 ${this.formatNumber(this.state.summary.freePixelPool)} px`;
        }

        const pendingBidEl = document.querySelector('[data-stat="pending-bids"]');
        if (pendingBidEl) {
            pendingBidEl.textContent = `최근 입찰 ${this.formatNumber(this.state.summary.recentBidCount)}건`;
        }
    }

    renderRegions() {
        const tbody = document.getElementById('region-table-body');
        if (!tbody) return;

        tbody.innerHTML = '';
        if (!this.state.topRegions.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.textContent = '표시할 지역 데이터가 없습니다.';
            row.appendChild(cell);
            tbody.appendChild(row);
            return;
        }

        this.state.topRegions.forEach(region => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${this.escape(region.name)}</td>
                <td>${this.escape(region.country)}</td>
                <td>${this.formatCurrency(region.price)}</td>
                <td><span class="status-badge status-${region.status}">${region.status}</span></td>
                <td>${region.updatedAt ? region.updatedAt.toLocaleDateString() : '-'}</td>
            `;
            tbody.appendChild(row);
        });
    }

    renderAuctions() {
        const list = document.getElementById('auction-list');
        if (!list) return;

        list.innerHTML = '';
        if (!this.state.activeAuctions.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = '진행 중인 옥션이 없습니다.';
            list.appendChild(li);
            return;
        }

        this.state.activeAuctions.forEach(auction => {
            const li = document.createElement('li');
            const remaining = auction.endTime ? this.formatRelativeTime(auction.endTime) : '종료 시간 없음';
            li.innerHTML = `
                <div class="auction-title">
                    <span>${this.escape(auction.regionName)}</span>
                    <strong>${this.formatCurrency(auction.currentBid)}</strong>
                </div>
                <div class="auction-meta">
                    <span>${this.escape(auction.country)}</span>
                    <span>${remaining}</span>
                </div>
            `;
            list.appendChild(li);
        });
    }

    renderPurchases() {
        const list = document.getElementById('purchase-list');
        if (!list) return;

        list.innerHTML = '';
        if (!this.state.recentPurchases.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = '결제 기록이 없습니다.';
            list.appendChild(li);
            return;
        }

        this.state.recentPurchases.forEach(purchase => {
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${this.escape(purchase.regionName)}</strong>
                <div>${this.formatCurrency(purchase.amount)} • ${this.escape(purchase.buyer)}</div>
                <small>${purchase.date ? purchase.date.toLocaleString('ko-KR') : '-'}</small>
            `;
            list.appendChild(li);
        });
    }

    renderReportsSection() {
        const list = document.getElementById('report-list');
        if (!list) return;

        list.innerHTML = '';
        if (!this.state.pendingReports.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = '처리할 신고가 없습니다.';
            list.appendChild(li);
            return;
        }

        this.state.pendingReports.forEach(report => {
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${this.escape(report.regionId)}</strong>
                <div>사유: ${this.getReasonLabel(report.reason)}</div>
                <div>신고자: ${this.escape(report.reporter)}</div>
                <small>${report.createdAt ? this.formatRelativeTime(report.createdAt) : '-'}</small>
            `;
            list.appendChild(li);
        });
    }

    renderLogs() {
        const list = document.getElementById('log-list');
        if (!list) return;

        list.innerHTML = '';
        if (!this.state.systemLogs.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = '최근 로그가 없습니다.';
            list.appendChild(li);
            return;
        }

        this.state.systemLogs.forEach(log => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span class="log-timestamp">${log.timestamp.toLocaleTimeString()}</span>
                <span class="log-type">${log.type}</span>
                <span>${this.formatPayload(log.payload)}</span>
            `;
            list.appendChild(li);
        });
    }

    renderAuditLogs() {
        const list = document.getElementById('audit-log-list');
        if (!list) return;

        list.innerHTML = '';
        if (!this.state.auditLogs.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = '감사 로그가 없습니다.';
            list.appendChild(li);
            return;
        }

        this.state.auditLogs.forEach(log => {
            const li = document.createElement('li');
            const actorLabel = log.actor?.email || log.actor?.uid || 'unknown';
            const detailSource = (log.details && Object.keys(log.details).length)
                ? log.details
                : log.context;
            const detailText = this.formatPayload(detailSource);

            li.innerHTML = `
                <div>
                    <span class="log-timestamp">${log.createdAt.toLocaleTimeString()}</span>
                    <span class="log-type">${this.escape(log.action)}</span>
                    <span>${this.escape(actorLabel)}</span>
                </div>
                <span class="log-detail">${this.escape(detailText || '-')}</span>
            `;
            list.appendChild(li);
        });
    }

    updateAuctionHealth() {
        const chip = document.getElementById('auction-health-chip');
        if (!chip) return;

        if (this.state.activeAuctions.length === 0) {
            chip.textContent = 'Idle';
            chip.style.color = fallbackColor('#9ba4d0');
            return;
        }

        const count = this.state.activeAuctions.length;
        if (count < 5) {
            chip.textContent = 'Stable';
            chip.style.color = '#36d399';
        } else if (count < 10) {
            chip.textContent = 'Busy';
            chip.style.color = '#f6c94c';
        } else {
            chip.textContent = 'Hot';
            chip.style.color = '#ff6b6b';
        }
    }

    copyLogsToClipboard() {
        if (!navigator.clipboard) {
            this.showToast('클립보드를 지원하지 않는 브라우저입니다.', 'error');
            return;
        }

        const systemText = this.state.systemLogs
            .map(log => `[${log.timestamp.toISOString()}] ${log.type} ${JSON.stringify(log.payload)}`)
            .join('\n');

        const auditText = this.state.auditLogs
            .map(log => `[${log.createdAt.toISOString()}] ${log.action} ${log.actor?.email || log.actor?.uid || 'unknown'} ${JSON.stringify(log.details || log.context || {})}`)
            .join('\n');

        const text = [
            '[SYSTEM LOGS]',
            systemText || '없음',
            '',
            '[ADMIN AUDIT]',
            auditText || '없음'
        ].join('\n');

        navigator.clipboard.writeText(text || '로그 없음').then(() => {
            this.showToast('로그를 복사했습니다.', 'success');
        }).catch(() => {
            this.showToast('로그 복사에 실패했습니다.', 'error');
        });
    }

    downloadRegionCSV() {
        if (!this.state.regionsForExport.length) {
            this.showToast('내보낼 지역 데이터가 없습니다.', 'info');
            return;
        }

        const headers = ['regionId', 'name', 'country', 'price', 'status'];
        const rows = this.state.regionsForExport.map(region => [
            `"${region.id}"`,
            `"${region.name.replace(/"/g, '""')}"`,
            `"${region.country.replace(/"/g, '""')}"`,
            region.price,
            region.status
        ].join(','));

        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `world-ad-regions-${Date.now()}.csv`;
        link.click();
        URL.revokeObjectURL(url);

        this.showToast('CSV를 다운로드했습니다.', 'success');
    }

    formatPayload(payload) {
        if (!payload || typeof payload !== 'object') return '-';
        const entries = Object.entries(payload);
        if (!entries.length) return '-';
        const summary = entries.slice(0, 3).map(([key, value]) => `${key}: ${value}`);
        return summary.join(' • ');
    }

    formatRelativeTime(date) {
        const target = date instanceof Date ? date : new Date(date);
        const diff = target - Date.now();
        const minutes = Math.round(diff / 60000);

        if (!Number.isFinite(minutes)) return '-';
        if (minutes > 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 남음`;
        if (minutes > 0) return `${minutes}분 남음`;
        if (minutes > -60) return `${Math.abs(minutes)}분 경과`;
        return target.toLocaleString('ko-KR');
    }

    formatCurrency(value) {
        const formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0
        });
        return formatter.format(Math.max(0, Number(value) || 0));
    }

    formatNumber(value) {
        return new Intl.NumberFormat('en-US').format(Number(value) || 0);
    }

    escape(value) {
        if (value === null || value === undefined) return '';
        return value.toString().replace(/[&<>"']/g, (char) => {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            return map[char];
        });
    }

    getReasonLabel(reason) {
        const labels = {
            inappropriate: '부적절한 콘텐츠',
            spam: '스팸/광고',
            copyright: '저작권 침해',
            harassment: '혐오/괴롭힘',
            other: '기타'
        };
        return labels[reason] || reason;
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('admin-toast');
        if (!toast) return;

        toast.textContent = message;
        toast.className = `toast show ${type}`;

        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
}

function fallbackColor(defaultColor) {
    return defaultColor || '#9ba4d0';
}

document.addEventListener('DOMContentLoaded', () => {
    new AdminDashboard();
});

