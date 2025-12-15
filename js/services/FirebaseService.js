/**
 * FirebaseService - Firebase 통합 서비스
 * 인증, Firestore, Storage 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

// 모니터링 서비스는 전역에서 접근 (순환 참조 방지)
let monitoringService = null;
const getMonitoringService = () => {
    if (!monitoringService && typeof window !== 'undefined' && window.monitoringService) {
        monitoringService = window.monitoringService;
    }
    return monitoringService;
};

class FirebaseService {
    constructor() {
        this.app = null;
        this.auth = null;
        this.db = null;
        this.storage = null;
        this.initialized = false;
        this.currentUser = null;
        // ⚠️ 응급 조치: 실시간 리스너 추적 시스템
        this.activeListeners = new Map(); // key -> unsubscribe 함수
        this.listenerCount = 0; // 총 리스너 개수 추적
        // ⚠️ 응급 조치: 전역 캐시 시스템
        this.documentCache = new Map(); // `${collection}/${docId}` -> { data, timestamp, staleAt }
        this.queryCache = new Map(); // `${collection}_${conditionsKey}` -> { data, timestamp, staleAt }
        // ⚠️ Step 5-2: Stale-While-Revalidate를 위한 백그라운드 업데이트 추적
        this.backgroundUpdates = new Map(); // key -> Promise
        // ⚠️ Step 5-2: TTL 계층화 (변동성에 따라)
        this.cacheTTL = {
            // 거의 변하지 않는 데이터: 세션 동안 불변
            territory: 60 * 60 * 1000,      // 1시간 (거의 변하지 않음)
            territories: 60 * 60 * 1000,    // 1시간 (전체 영토 목록)
            pixelCanvases: 30 * 60 * 1000,  // 30분 (픽셀 데이터)
            
            // 중간 변동성: 적절한 TTL
            auction: 30 * 1000,             // 30초 (경매는 빠르게 변함)
            auctions: 30 * 1000,            // 30초 (활성 경매 목록)
            ranking: 5 * 60 * 1000,        // 5분 (랭킹은 자주 변하지 않음)
            
            // 자주 변하는 데이터: 짧은 TTL
            wallet: 10 * 1000,             // 10초 (잔액은 자주 변함)
            user: 60 * 1000,               // 1분 (사용자 프로필)
            collaboration: 60 * 1000,      // 1분 (협업 데이터)
            
            // 세션 내 재조회 금지 (강제 invalidation만 사용)
            userProfile: Infinity,         // 세션 동안 불변
            settings: Infinity,            // 세션 동안 불변
            
            default: 30 * 1000            // 30초 (기본값)
        };
        // ⚠️ 응급 조치: 디바운스 시스템
        this.debounceTimers = new Map(); // key -> timeout ID
        this.debounceDelay = 100; // 100ms
        // ⚠️ Step 5-1: 탭 포커스 상태 추적
        this.isPageVisible = !document.hidden;
        this.isPageFocused = document.hasFocus();
        this.suspendedListeners = new Map(); // key -> { unsubscribe, context }
        this.setupVisibilityHandlers();
    }
    
    /**
     * ⚠️ Step 5-1: 페이지 가시성 및 포커스 핸들러 설정
     * 탭이 백그라운드로 가면 고비용 리스너 일시 중지
     */
    setupVisibilityHandlers() {
        // 페이지 가시성 변경 감지
        document.addEventListener('visibilitychange', () => {
            const wasVisible = this.isPageVisible;
            this.isPageVisible = !document.hidden;
            
            if (wasVisible && !this.isPageVisible) {
                // 탭이 백그라운드로 감 → 리스너 일시 중지
                log.info('[FirebaseService] 📴 Page hidden, suspending expensive listeners');
                this.suspendExpensiveListeners();
            } else if (!wasVisible && this.isPageVisible) {
                // 탭이 다시 보임 → 리스너 재개
                log.info('[FirebaseService] 📱 Page visible, resuming listeners');
                this.resumeSuspendedListeners();
            }
        });
        
        // 페이지 포커스 변경 감지
        window.addEventListener('focus', () => {
            this.isPageFocused = true;
            if (this.isPageVisible) {
                log.debug('[FirebaseService] 🎯 Page focused');
            }
        });
        
        window.addEventListener('blur', () => {
            this.isPageFocused = false;
            log.debug('[FirebaseService] ⚠️ Page blurred');
        });
        
        // 페이지 언로드 시 모든 리스너 정리
        window.addEventListener('beforeunload', () => {
            log.info('[FirebaseService] 🧹 Page unloading, cleaning up all listeners');
            this.cleanupAllListeners();
        });
    }
    
    /**
     * ⚠️ Step 5-1: 고비용 리스너 일시 중지
     * 백그라운드로 갈 때 불필요한 실시간 리스너 중지
     */
    suspendExpensiveListeners() {
        // 지갑 리스너는 유지 (중요한 데이터)
        // 영토/경매 리스너는 일시 중지
        for (const [key, unsubscribe] of this.activeListeners.entries()) {
            // 지갑은 제외
            if (key.startsWith('wallets/')) {
                continue;
            }
            
            // 나머지는 일시 중지
            this.suspendedListeners.set(key, {
                unsubscribe,
                context: { suspendedAt: Date.now() }
            });
            unsubscribe();
            this.activeListeners.delete(key);
            this.listenerCount--;
            log.debug(`[FirebaseService] ⏸️ Suspended listener: ${key}`);
        }
    }
    
    /**
     * ⚠️ Step 5-1: 일시 중지된 리스너 재개
     * 탭이 다시 포커스될 때 필요한 리스너만 재개
     */
    resumeSuspendedListeners() {
        // 현재는 재개하지 않음 (필요 시에만 재구독)
        // 패널이 열려있을 때만 재구독하도록 호출자가 처리
        log.info(`[FirebaseService] ▶️ ${this.suspendedListeners.size} listeners available for resume (will resume on demand)`);
    }
    
    /**
     * Firebase 초기화
     */
    async initialize() {
        if (this.initialized) {
            log.info('Firebase already initialized');
            return true;
        }
        
        try {
            // 전문가 조언: Firebase compat 버전 사용 (정적 script 태그로 로드됨)
            // window.firebaseCompat는 index.html에서 설정됨
            if (!window.firebaseCompat || typeof window.firebaseCompat === 'undefined') {
                // Firebase SDK가 로드되지 않음
                log.warn('[FirebaseService] ⚠️ Firebase SDK not loaded. App will continue in offline mode.');
                this.initialized = false;
                eventBus.emit(EVENTS.APP_ERROR, { 
                    error: 'Firebase initialization failed', 
                    message: 'Firebase SDK could not be loaded. Some features may be unavailable.' 
                });
                return false;
            }
            
            const firebase = window.firebaseCompat;
            
            // Firebase 앱 초기화 (compat 버전)
            if (firebase.apps.length === 0) {
                this.app = firebase.initializeApp(CONFIG.FIREBASE);
            } else {
                this.app = firebase.app();
            }
            
            this.auth = firebase.auth();
            // ⚠️ 마이그레이션 완료: Firestore 비활성화 (PostgreSQL + Redis 사용)
            // this.db = firebase.firestore();
            this.db = null; // Firestore 비활성화
            
            // Firestore 헬퍼 저장 (compat 버전은 직접 사용)
            this._firestore = {
                collection: (db, collectionPath) => db.collection(collectionPath),
                doc: (db, collectionPath, docPath) => db.collection(collectionPath).doc(docPath),
                getDoc: (docRef) => docRef.get(),
                getDocs: (collectionRef) => collectionRef.get(),
                setDoc: (docRef, data, options) => docRef.set(data, options),
                updateDoc: (docRef, data) => docRef.update(data),
                deleteDoc: (docRef) => docRef.delete(),
                query: (collectionRef, ...queryConstraints) => {
                    let q = collectionRef;
                    for (const constraint of queryConstraints) {
                        if (constraint.type === 'where') {
                            q = q.where(constraint.field, constraint.op, constraint.value);
                        } else if (constraint.type === 'orderBy') {
                            q = q.orderBy(constraint.field, constraint.direction);
                        } else if (constraint.type === 'limit') {
                            q = q.limit(constraint.limit);
                        }
                    }
                    return q;
                },
                where: (field, op, value) => ({ type: 'where', field, op, value }),
                orderBy: (field, direction) => ({ type: 'orderBy', field, direction }),
                limit: (limit) => ({ type: 'limit', limit }),
                onSnapshot: (queryOrDocRef, callback, errorCallback) => {
                    return queryOrDocRef.onSnapshot(callback, errorCallback);
                },
                Timestamp: {
                    now: () => firebase.firestore.Timestamp.now(),
                    fromDate: (date) => firebase.firestore.Timestamp.fromDate(date),
                    fromMillis: (millis) => firebase.firestore.Timestamp.fromMillis(millis)
                },
                deleteField: () => firebase.firestore.FieldValue.delete(),
                increment: (n) => firebase.firestore.FieldValue.increment(n),
                serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp()
            };
            
            // Auth 헬퍼 저장 (compat 버전은 직접 사용)
            this._auth = {
                signInWithPopup: (auth, provider) => auth.signInWithPopup(provider),
                signInWithRedirect: (auth, provider) => auth.signInWithRedirect(provider),
                getRedirectResult: (auth) => auth.getRedirectResult(),
                signInWithEmailAndPassword: (auth, email, password) => auth.signInWithEmailAndPassword(email, password),
                GoogleAuthProvider: firebase.auth.GoogleAuthProvider,
                signOut: (auth) => auth.signOut(),
                onAuthStateChanged: (auth, callback) => auth.onAuthStateChanged(callback),
                setPersistence: (auth, persistence) => auth.setPersistence(persistence),
                browserLocalPersistence: firebase.auth.Auth.Persistence.LOCAL,
                browserSessionPersistence: firebase.auth.Auth.Persistence.SESSION
            };
            
            // Firebase Auth persistence 설정 (리다이렉트 인증을 위해 필수)
            // localStorage를 사용하여 리다이렉트 후에도 인증 상태가 유지되도록 함
            try {
                // this._auth 객체에서 setPersistence와 browserLocalPersistence 사용
                if (this._auth.setPersistence && this._auth.browserLocalPersistence) {
                    await this._auth.setPersistence(this.auth, this._auth.browserLocalPersistence);
                    log.info('[FirebaseService] ✅ Auth persistence set to localStorage');
                } else {
                    // setPersistence가 없으면 기본 동작에 의존 (compat 버전은 기본적으로 LOCAL 사용)
                    log.info('[FirebaseService] ℹ️ Using default auth persistence (localStorage)');
                }
            } catch (persistenceError) {
                log.warn('[FirebaseService] ⚠️ Failed to set persistence:', persistenceError);
                // persistence 설정 실패해도 계속 진행
            }
            
            // 세션 스토리지에서 리다이렉트 플래그 확인 (초기화 시)
            const redirectStarted = sessionStorage.getItem('firebase_redirect_started');
            if (redirectStarted === 'true') {
                log.info('[FirebaseService] 🔗 Redirect was started before page load, will check result...');
            }
            
            // 리다이렉트 결과 확인을 먼저 수행 (onAuthStateChanged 설정 전)
            // getRedirectResult는 한 번만 호출 가능하므로 가장 먼저 호출해야 함
            const redirectCheckPromise = this.checkRedirectResult().catch(error => {
                // 리다이렉트가 아닌 경우 오류는 정상
                if (error.code !== 'auth/operation-not-allowed') {
                    log.debug('[FirebaseService] Redirect result check (normal if no redirect):', error.message);
                }
                return null;
            });
            
            // 인증 상태 감시 (리다이렉트 결과 확인 후 설정)
            this._auth.onAuthStateChanged(this.auth, (user) => {
                log.info('[FirebaseService] 🔐 Auth state changed:', user ? `Logged in as ${user.email}` : 'Logged out');
                log.info('[FirebaseService] 🔐 User UID:', user ? user.uid : 'null');
                log.info('[FirebaseService] 🔐 User email:', user ? user.email : 'null');
                
                // 이전 상태와 비교하여 실제로 변경된 경우에만 처리
                const previousUser = this.currentUser;
                const userChanged = !previousUser && user || previousUser && !user || 
                                   (previousUser && user && previousUser.uid !== user.uid);
                
                log.info('[FirebaseService] 🔐 User changed:', userChanged);
                log.info('[FirebaseService] 🔐 Previous user:', previousUser ? previousUser.email : 'null');
                
                this.currentUser = user;
                
                if (userChanged || user) {
                    // 상태가 변경되었거나 사용자가 있는 경우에만 이벤트 발행
                    log.info('[FirebaseService] 📢 Emitting AUTH_STATE_CHANGED event');
                    eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user });
                    
                    if (user) {
                        log.info('[FirebaseService] ✅ User logged in:', user.email);
                        eventBus.emit(EVENTS.AUTH_LOGIN, { user });
                        
                        // 사용자 문서 생성/업데이트 (비동기, 에러 무시)
                        this.ensureUserDocument(user).catch(err => {
                            log.warn('[FirebaseService] Failed to create/update user document:', err);
                        });
                    } else {
                        log.info('[FirebaseService] 👋 User logged out');
                        // ⚠️ 응급 조치: 로그아웃 시 모든 리스너 정리
                        this.cleanupAllListeners();
                        eventBus.emit(EVENTS.AUTH_LOGOUT, {});
                    }
                } else {
                    log.info('[FirebaseService] ⏭️ Skipping event emission (no change)');
                }
            });
            
            // 리다이렉트 결과 확인 완료 후 처리
            redirectCheckPromise.then(user => {
                if (user) {
                    log.info('[FirebaseService] ✅ Redirect sign-in completed, user:', user.email);
                } else {
                    log.info('[FirebaseService] ℹ️ No redirect result (normal if not redirected)');
                    
                    // 세션 스토리지에서 리다이렉트 플래그 재확인
                    const stillRedirecting = sessionStorage.getItem('firebase_redirect_started');
                    if (stillRedirecting === 'true') {
                        log.info('[FirebaseService] 🔗 Redirect flag still present, waiting for auth state...');
                        // 리다이렉트 플래그가 있으면 onAuthStateChanged를 기다림
                        // 이미 설정되어 있으므로 자동으로 트리거될 것임
                    }
                    
                    // 초기 인증 상태 확인
                    const initialUser = this.auth.currentUser;
                    if (initialUser && !this.currentUser) {
                        log.info('[FirebaseService] 🔍 Initial user found after redirect check:', initialUser.email);
                        this.currentUser = initialUser;
                        // 약간의 지연 후 이벤트 발행 (다른 초기화가 완료된 후)
                        setTimeout(() => {
                            eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: initialUser });
                        }, 500);
                    }
                    
                    // 리다이렉트 결과가 없어도 현재 인증 상태를 다시 확인 (지연 후)
                    // 리다이렉트 후 onAuthStateChanged가 트리거되기 전일 수 있음
                    // 리다이렉트 플래그가 있으면 더 오래 기다림
                    const delayTime = stillRedirecting === 'true' ? 5000 : 2000;
                    setTimeout(() => {
                        const delayedUser = this.auth.currentUser;
                        if (delayedUser && !this.currentUser) {
                            log.info('[FirebaseService] 🔄 Found user after delay:', delayedUser.email);
                            this.currentUser = delayedUser;
                            eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: delayedUser });
                        } else if (stillRedirecting === 'true' && !delayedUser) {
                            log.warn('[FirebaseService] ⚠️ Redirect flag present but no user found after', delayTime, 'ms');
                            // 플래그 제거 (타임아웃)
                            sessionStorage.removeItem('firebase_redirect_started');
                            sessionStorage.removeItem('firebase_redirect_timestamp');
                        }
                    }, delayTime);
                }
            });
            
            this.initialized = true;
            log.info('Firebase initialized successfully');
            return true;
            
        } catch (error) {
            log.error('Firebase initialization failed:', error);
            eventBus.emit(EVENTS.APP_ERROR, { type: 'firebase', error });
            return false;
        }
    }
    
    /**
     * 리다이렉트 결과 확인 (페이지 로드 시)
     */
    async checkRedirectResult() {
        try {
            log.info('[FirebaseService] 🔍 Checking redirect result...');
            
            // 세션 스토리지에서 리다이렉트 시작 플래그 확인
            const redirectStarted = sessionStorage.getItem('firebase_redirect_started');
            const redirectTimestamp = sessionStorage.getItem('firebase_redirect_timestamp');
            
            if (redirectStarted === 'true') {
                log.info('[FirebaseService] 🔗 Redirect was started (timestamp:', redirectTimestamp, ')');
            }
            
            // URL에 리다이렉트 관련 파라미터가 있는지 확인
            const urlParams = new URLSearchParams(window.location.search);
            const hash = window.location.hash;
            const hasAuthParams = urlParams.has('__firebase_request_key') || 
                                 hash.includes('access_token') ||
                                 hash.includes('id_token') ||
                                 hash.includes('authUser') ||
                                 hash.includes('apiKey');
            
            log.info('[FirebaseService] 📍 Current URL:', window.location.href.substring(0, 150));
            log.info('[FirebaseService] 📍 URL params:', Array.from(urlParams.keys()).join(', ') || 'none');
            log.info('[FirebaseService] 📍 Hash:', hash.substring(0, 150) || 'none');
            
            if (hasAuthParams) {
                log.info('[FirebaseService] 🔗 Auth parameters found in URL, processing redirect...');
            }
            
            // getRedirectResult는 리다이렉트 후 한 번만 호출 가능
            // 호출하면 리다이렉트 결과를 소비하므로, 반드시 먼저 호출해야 함
            log.info('[FirebaseService] 🔄 Calling getRedirectResult...');
            
            // Firebase Auth 인스턴스 확인
            log.info('[FirebaseService] 🔍 Auth instance check:', {
                authExists: !!this.auth,
                authAppName: this.auth?.app?.name,
                authAppId: this.auth?.app?.options?.appId,
                authConfig: {
                    apiKey: this.auth?.app?.options?.apiKey?.substring(0, 10) + '...',
                    authDomain: this.auth?.app?.options?.authDomain
                }
            });
            
            // Local Storage에 Firebase 키가 있는지 확인
            const firebaseKeys = Object.keys(localStorage).filter(key => key.startsWith('firebase:'));
            log.info('[FirebaseService] 🔍 Firebase keys in localStorage:', firebaseKeys.length);
            if (firebaseKeys.length > 0) {
                log.info('[FirebaseService] 🔍 Firebase keys:', firebaseKeys);
                // 각 키의 값 일부 확인 (민감한 정보는 제외)
                firebaseKeys.forEach(key => {
                    try {
                        const value = localStorage.getItem(key);
                        const preview = value ? value.substring(0, 100) + '...' : 'empty';
                        log.info(`[FirebaseService] 🔍 Key "${key}":`, preview);
                    } catch (e) {
                        log.warn(`[FirebaseService] ⚠️ Cannot read key "${key}":`, e);
                    }
                });
            } else {
                log.warn('[FirebaseService] ⚠️ No Firebase keys found in localStorage!');
                log.warn('[FirebaseService] ⚠️ This might be why getRedirectResult returns null');
            }
            
            // 리다이렉트 플래그가 있으면 잠시 대기 (Firebase 내부 처리 시간)
            if (redirectStarted === 'true') {
                log.info('[FirebaseService] ⏳ Waiting 500ms for Firebase internal processing...');
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            let result;
            try {
                result = await this._auth.getRedirectResult(this.auth);
            } catch (redirectError) {
                log.error('[FirebaseService] ❌ getRedirectResult error:', redirectError.code, redirectError.message);
                log.error('[FirebaseService] ❌ Error stack:', redirectError.stack);
                throw redirectError;
            }
            
            log.info('[FirebaseService] Redirect result:', result ? `Found (user: ${result.user?.email})` : 'None');
            if (result && result.credential) {
                log.info('[FirebaseService] ✅ Credential found in redirect result');
            }
            if (result && result.operationType) {
                log.info('[FirebaseService] ✅ Operation type:', result.operationType);
            }
            
            // 리다이렉트 결과를 확인했으므로 플래그 제거 (결과가 있을 때만)
            if (redirectStarted === 'true' && result && result.user) {
                sessionStorage.removeItem('firebase_redirect_started');
                sessionStorage.removeItem('firebase_redirect_timestamp');
                log.info('[FirebaseService] 🧹 Cleared redirect flags (success)');
            } else if (redirectStarted === 'true' && !result) {
                log.warn('[FirebaseService] ⚠️ Redirect flag exists but no result - keeping flag for retry');
                // 플래그를 유지하여 나중에 재시도할 수 있도록 함
            }
            
            if (result && result.user) {
                log.info('[FirebaseService] ✅ Sign-in via redirect successful:', result.user.email);
                
                // currentUser 업데이트
                this.currentUser = result.user;
                
                // onAuthStateChanged가 자동으로 트리거되지만, 명시적으로도 이벤트 발행
                // 약간의 지연을 두어 onAuthStateChanged가 먼저 실행되도록 함
                setTimeout(async () => {
                    log.info('[FirebaseService] 📢 Emitting AUTH_STATE_CHANGED event for redirect user');
                    eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: result.user });
                    eventBus.emit(EVENTS.AUTH_LOGIN, { user: result.user });
                    
                    // 사용자 문서 생성/업데이트 (비동기, 에러 무시)
                    this.ensureUserDocument(result.user).catch(err => {
                        log.warn('[FirebaseService] Failed to create/update user document:', err);
                    });
                    
                    // 성공 알림
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'success',
                        message: `✅ 로그인 성공! ${result.user.email || result.user.displayName}님 환영합니다.`,
                        duration: 3000
                    });
                }, 300);
                
                return result.user;
            } else {
                // 리다이렉트 결과가 없으면 현재 인증 상태 확인
                const currentUser = this.auth.currentUser;
                log.info('[FirebaseService] Current auth user:', currentUser ? currentUser.email : 'None');
                
                if (currentUser) {
                    log.info('[FirebaseService] ℹ️ No redirect result, but user is already logged in:', currentUser.email);
                    this.currentUser = currentUser;
                    // 인증 상태 이벤트 발행
                    setTimeout(() => {
                        log.info('[FirebaseService] 📢 Emitting AUTH_STATE_CHANGED event for existing user');
                        eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: currentUser });
                    }, 300);
                    return currentUser;
                } else {
                    log.info('[FirebaseService] ℹ️ No redirect result and no user (normal if not redirected)');
                    
                    // 세션 스토리지에서 리다이렉트 시작 플래그 확인 (이미 위에서 확인했지만 다시 확인)
                    const redirectStartedCheck = sessionStorage.getItem('firebase_redirect_started');
                    const redirectTimestampCheck = sessionStorage.getItem('firebase_redirect_timestamp');
                    
                    log.info('[FirebaseService] 🔍 Re-checking redirect flag:', redirectStartedCheck);
                    
                    // URL에 인증 관련 파라미터가 있는지 확인
                    const urlParams = new URLSearchParams(window.location.search);
                    const hash = window.location.hash;
                    const hasAuthParams = urlParams.has('__firebase_request_key') || 
                                         hash.includes('access_token') ||
                                         hash.includes('id_token') ||
                                         hash.includes('authUser') ||
                                         hash.includes('apiKey');
                    
                    // 리다이렉트가 시작되었거나 인증 파라미터가 있으면 대기
                    if (redirectStartedCheck === 'true' || hasAuthParams) {
                        log.info('[FirebaseService] 🔗 Redirect detected (flag or params), waiting for onAuthStateChanged...');
                        log.info('[FirebaseService] 🔗 Redirect started:', redirectStarted);
                        log.info('[FirebaseService] 🔗 Has auth params:', hasAuthParams);
                        log.info('[FirebaseService] 🔗 Current auth state:', this.auth.currentUser ? this.auth.currentUser.email : 'null');
                        
                        // onAuthStateChanged가 트리거될 때까지 대기 (최대 10초)
                        return new Promise((resolve) => {
                            let resolved = false;
                            let checkCount = 0;
                            const maxChecks = 20; // 10초 (500ms * 20)
                            
                            // 즉시 한 번 확인
                            const immediateUser = this.auth.currentUser;
                            if (immediateUser) {
                                log.info('[FirebaseService] ✅ Found user immediately:', immediateUser.email);
                                this.currentUser = immediateUser;
                                eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: immediateUser });
                                resolve(immediateUser);
                                return;
                            }
                            
                            // 주기적으로 현재 사용자 확인
                            const checkInterval = setInterval(() => {
                                checkCount++;
                                const currentUser = this.auth.currentUser;
                                
                                log.info('[FirebaseService] 🔄 Periodic check', checkCount, '/', maxChecks, ':', currentUser ? currentUser.email : 'null');
                                
                                if (currentUser && !resolved) {
                                    resolved = true;
                                    clearInterval(checkInterval);
                                    clearTimeout(timeout);
                                    log.info('[FirebaseService] ✅ Found user via periodic check:', currentUser.email);
                                    this.currentUser = currentUser;
                                    eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: currentUser });
                                    resolve(currentUser);
                                } else if (checkCount >= maxChecks && !resolved) {
                                    resolved = true;
                                    clearInterval(checkInterval);
                                    clearTimeout(timeout);
                                    log.warn('[FirebaseService] ⚠️ No user found after', checkCount * 500, 'ms');
                                    // 플래그 제거
                                    if (redirectStarted === 'true') {
                                        sessionStorage.removeItem('firebase_redirect_started');
                                        sessionStorage.removeItem('firebase_redirect_timestamp');
                                    }
                                    resolve(null);
                                }
                            }, 500);
                            
                            const timeout = setTimeout(() => {
                                if (!resolved) {
                                    resolved = true;
                                    clearInterval(checkInterval);
                                    const delayedUser = this.auth.currentUser;
                                    if (delayedUser) {
                                        log.info('[FirebaseService] ✅ Found user after timeout:', delayedUser.email);
                                        this.currentUser = delayedUser;
                                        eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: delayedUser });
                                        resolve(delayedUser);
                                    } else {
                                        log.warn('[FirebaseService] ⚠️ Auth params found but no user after timeout');
                                        // 플래그 제거
                                        if (redirectStarted === 'true') {
                                            sessionStorage.removeItem('firebase_redirect_started');
                                            sessionStorage.removeItem('firebase_redirect_timestamp');
                                        }
                                        resolve(null);
                                    }
                                }
                            }, 10000);
                            
                            // onAuthStateChanged가 트리거되면 즉시 해결
                            // 이미 설정되어 있으므로 별도로 설정할 필요 없음
                            // 하지만 추가 리스너를 설정하여 더 빠르게 감지
                            const unsubscribe = this._auth.onAuthStateChanged(this.auth, (user) => {
                                if (user && !resolved) {
                                    resolved = true;
                                    clearInterval(checkInterval);
                                    clearTimeout(timeout);
                                    unsubscribe();
                                    log.info('[FirebaseService] ✅ User found via additional onAuthStateChanged listener:', user.email);
                                    this.currentUser = user;
                                    eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user });
                                    resolve(user);
                                }
                            });
                        });
                    }
                }
            }
        } catch (error) {
            log.error('[FirebaseService] ❌ Redirect result check error:', error.code, error.message);
            
            // 리다이렉트 오류 처리
            if (error.code === 'auth/operation-not-allowed') {
                log.warn('[FirebaseService] ⚠️ Redirect operation not allowed');
            } else if (error.code === 'auth/account-exists-with-different-credential') {
                log.error('[FirebaseService] ❌ Account exists with different credential');
                eventBus.emit(EVENTS.AUTH_ERROR, { error });
            } else {
                // 다른 오류는 로그만 남기고 무시 (리다이렉트가 아닌 경우 정상)
                log.debug('[FirebaseService] ℹ️ Redirect result check error (normal if no redirect):', error.code, error.message);
            }
            
            // 오류가 발생해도 현재 인증 상태 확인
            const currentUser = this.auth.currentUser;
            if (currentUser) {
                log.info('[FirebaseService] ✅ Error occurred but user is logged in:', currentUser.email);
                this.currentUser = currentUser;
                setTimeout(() => {
                    log.info('[FirebaseService] 📢 Emitting AUTH_STATE_CHANGED event after error');
                    eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user: currentUser });
                }, 200);
                return currentUser;
            }
        }
        return null;
    }
    
    /**
     * Google 로그인 (팝업 또는 리다이렉트)
     * 로컬 네트워크 IP에서는 리다이렉트 방식 사용
     */
    async signInWithGoogle(useRedirect = false) {
        log.info('[FirebaseService] 🚀 signInWithGoogle called, useRedirect:', useRedirect);
        
        if (!this.initialized) {
            log.error('[FirebaseService] ❌ Firebase not initialized');
            throw new Error('Firebase not initialized');
        }
        
        try {
            const provider = new this._auth.GoogleAuthProvider();
            
            // 로컬 네트워크 IP 감지
            const currentDomain = window.location.hostname;
            const isLocalNetworkIP = /^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(currentDomain);
            const isLocalhost = currentDomain === 'localhost' || currentDomain === '127.0.0.1';
            
            log.info('[FirebaseService] 📍 Current domain:', currentDomain);
            log.info('[FirebaseService] 📍 Is local network IP:', isLocalNetworkIP);
            log.info('[FirebaseService] 📍 Is localhost:', isLocalhost);
            log.info('[FirebaseService] 📍 Use redirect param:', useRedirect);
            
            // localhost에서는 팝업 방식 사용 (프로덕션과 동일하게)
            // 리다이렉트는 localhost에서 제대로 작동하지 않음
            // 로컬 네트워크 IP(192.168.x.x 등)에서만 리다이렉트 사용
            if (useRedirect || (isLocalNetworkIP && !isLocalhost)) {
                log.info('[FirebaseService] 🔄 Using redirect method for sign-in (local network IP, not localhost)');
                
                // 리다이렉트 시작 플래그를 세션 스토리지에 저장
                sessionStorage.setItem('firebase_redirect_started', 'true');
                sessionStorage.setItem('firebase_redirect_timestamp', Date.now().toString());
                
                // 사용자에게 안내
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'info',
                    message: '로그인 페이지로 이동합니다...',
                    duration: 2000
                });
                
                try {
                    // 리다이렉트 URL 명시적으로 설정 (localhost에서 리다이렉트 인증이 작동하도록)
                    const redirectUrl = window.location.origin + window.location.pathname;
                    log.info('[FirebaseService] 📍 Setting redirect URL:', redirectUrl);
                    
                    // 리다이렉트 방식 사용
                    log.info('[FirebaseService] 🚀 Calling signInWithRedirect...');
                    log.info('[FirebaseService] 📍 Current origin:', window.location.origin);
                    log.info('[FirebaseService] 📍 Current pathname:', window.location.pathname);
                    log.info('[FirebaseService] 📍 Full URL:', window.location.href);
                    
                    await this._auth.signInWithRedirect(this.auth, provider);
                    log.info('[FirebaseService] ✅ Redirect initiated, user will be redirected to Google sign-in');
                    // 리다이렉트는 페이지를 이동시키므로 여기서는 반환하지 않음
                    // 실제로는 이 코드가 실행되지 않을 수 있음 (페이지 이동)
                    return null;
                } catch (redirectError) {
                    log.error('[FirebaseService] ❌ Redirect failed:', redirectError.code, redirectError.message);
                    log.error('[FirebaseService] ❌ Redirect error details:', redirectError);
                    // 리다이렉트 실패 시 플래그 제거
                    sessionStorage.removeItem('firebase_redirect_started');
                    sessionStorage.removeItem('firebase_redirect_timestamp');
                    eventBus.emit(EVENTS.AUTH_ERROR, { error: redirectError });
                    throw redirectError;
                }
            }
            
            // 팝업 방식 시도 (일반 도메인 또는 localhost)
            // localhost에서는 리다이렉트가 작동하지 않으므로 팝업 방식 사용
            if (isLocalhost) {
                log.info('[FirebaseService] 🏠 Using popup method for localhost (redirect doesn\'t work on localhost)');
            }
            
            try {
                log.info('[FirebaseService] 🪟 Attempting popup sign-in...');
                const result = await this._auth.signInWithPopup(this.auth, provider);
                log.info('[FirebaseService] ✅ Popup sign-in successful:', result.user.email);
                
                // 사용자 문서 생성/업데이트 (비동기, 에러 무시)
                this.ensureUserDocument(result.user).catch(err => {
                    log.warn('[FirebaseService] Failed to create/update user document:', err);
                });
                
                return result.user;
            } catch (popupError) {
                log.warn('[FirebaseService] ⚠️ Popup sign-in failed:', popupError.code, popupError.message);
                
                // 도메인 미등록 오류 처리
                if (popupError.code === 'auth/unauthorized-domain') {
                    const domain = window.location.hostname;
                    log.error('[FirebaseService] ❌ Unauthorized domain:', domain);
                    
                    const errorMessage = `현재 도메인(${domain})이 Firebase에 등록되지 않았습니다.\n\n` +
                        `Firebase 콘솔에서 다음 도메인을 추가해주세요:\n` +
                        `- ${domain}\n` +
                        `- ${window.location.origin}\n\n` +
                        `Firebase 콘솔: https://console.firebase.google.com/project/${CONFIG.FIREBASE.projectId}/authentication/settings`;
                    
                    eventBus.emit(EVENTS.AUTH_ERROR, { 
                        error: {
                            ...popupError,
                            domain: domain,
                            message: errorMessage,
                            consoleLink: `https://console.firebase.google.com/project/${CONFIG.FIREBASE.projectId}/authentication/settings`
                        }
                    });
                    
                    // 리다이렉트 방식으로 재시도 (도메인 등록 후 작동할 수 있음)
                    log.info('[FirebaseService] 🔄 Retrying with redirect method...');
                    try {
                        sessionStorage.setItem('firebase_redirect_started', 'true');
                        sessionStorage.setItem('firebase_redirect_timestamp', Date.now().toString());
                        await this._auth.signInWithRedirect(this.auth, provider);
                        return null;
                    } catch (redirectError) {
                        log.error('[FirebaseService] ❌ Redirect also failed:', redirectError);
                        throw popupError; // 원래 오류를 던짐
                    }
                }
                
                // 팝업이 차단되었거나 실패한 경우 리다이렉트 방식으로 전환
                const shouldUseRedirect = 
                    popupError.code === 'auth/popup-blocked' || 
                    popupError.code === 'auth/popup-closed-by-user' ||
                    popupError.code === 'auth/cancelled-popup-request' ||
                    popupError.message?.includes('Cross-Origin-Opener-Policy') ||
                    popupError.message?.includes('COOP');
                
                if (shouldUseRedirect) {
                    log.info('[FirebaseService] 🔄 Popup blocked or failed, using redirect method');
                    
                    // 사용자에게 안내
                    eventBus.emit(EVENTS.UI_NOTIFICATION, {
                        type: 'info',
                        message: '팝업이 차단되었습니다. 리다이렉트 방식으로 로그인합니다...',
                        duration: 2000
                    });
                    
                    // 리다이렉트 방식으로 전환
                    sessionStorage.setItem('firebase_redirect_started', 'true');
                    sessionStorage.setItem('firebase_redirect_timestamp', Date.now().toString());
                    await this._auth.signInWithRedirect(this.auth, provider);
                    
                    // 리다이렉트는 페이지를 이동시키므로 여기서는 반환하지 않음
                    return null;
                }
                
                // 다른 오류는 그대로 throw
                log.error('[FirebaseService] ❌ Popup error not handled:', popupError.code);
                eventBus.emit(EVENTS.AUTH_ERROR, { error: popupError });
                throw popupError;
            }
        } catch (error) {
            log.error('Google sign-in failed:', error);
            
            // unauthorized-domain 오류 처리
            if (error.code === 'auth/unauthorized-domain') {
                const currentDomain = window.location.hostname;
                const currentUrl = window.location.origin;
                const isLocalNetwork = /^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(currentDomain);
                
                let helpMessage = '';
                if (isLocalNetwork) {
                    helpMessage = `로컬 네트워크 IP(${currentDomain})가 Firebase에 등록되지 않았습니다.\n\n해결 방법:\n1. Firebase 콘솔 접속: https://console.firebase.google.com/project/worldad-8be07/authentication/settings\n2. "Authorized domains" 섹션으로 이동\n3. "Add domain" 버튼 클릭\n4. "${currentDomain}" 입력 후 저장\n5. 페이지 새로고침 후 다시 시도\n\n또는 localhost를 사용하세요: http://localhost:8000`;
                } else {
                    helpMessage = `현재 도메인(${currentDomain})이 Firebase에 등록되지 않았습니다.\n\n해결 방법:\n1. Firebase 콘솔: https://console.firebase.google.com/project/worldad-8be07/authentication/settings\n2. "Authorized domains" → "Add domain"\n3. "${currentDomain}" 추가`;
                }
                
                const friendlyError = {
                    code: error.code,
                    message: helpMessage,
                    domain: currentDomain,
                    consoleLink: `https://console.firebase.google.com/project/worldad-8be07/authentication/settings`,
                    originalError: error
                };
                eventBus.emit(EVENTS.AUTH_ERROR, { error: friendlyError });
                throw friendlyError;
            }
            
            eventBus.emit(EVENTS.AUTH_ERROR, { error });
            throw error;
        }
    }
    
    /**
     * 이메일/비밀번호 로그인
     */
    async signInWithEmail(email, password) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            const result = await this._auth.signInWithEmailAndPassword(this.auth, email, password);
            log.info('Email sign-in successful:', email);
            return result;
        } catch (error) {
            log.error('Email sign-in failed:', error);
            eventBus.emit(EVENTS.AUTH_ERROR, { error });
            throw error;
        }
    }
    
    /**
     * 로그아웃
     */
    async signOut() {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            await this._auth.signOut(this.auth);
            this.currentUser = null;
        } catch (error) {
            log.error('Sign-out failed:', error);
            throw error;
        }
    }
    
    /**
     * 가상 사용자 설정 (관리자 모드용)
     */
    setVirtualUser(virtualUser) {
        this.currentUser = virtualUser;
        log.info('[FirebaseService] 가상 사용자 설정:', virtualUser.email);
    }
    
    /**
     * 현재 사용자 가져오기
     */
    getCurrentUser() {
        return this.currentUser;
    }
    
    /**
     * 실제 Firebase Auth 사용자 가져오기
     * ✅ 단일 인스턴스 사용: 항상 this.auth.currentUser 반환
     */
    getRealAuthUser() {
        return this.auth?.currentUser || null;
    }
    
    /**
     * 인증 여부 확인
     */
    isAuthenticated() {
        return !!this.currentUser;
    }
    
    // ==================== Firestore Operations ====================
    
    /**
     * 문서 가져오기
     * ⚠️ 응급 조치: 캐시 및 디바운스 적용
     */
    async getDocument(collectionName, docId, options = {}) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화, API 사용 권장
        log.warn(`[FirebaseService] getDocument()는 더 이상 사용되지 않습니다. API를 사용하세요. Collection: ${collectionName}/${docId}`);
        return null;
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            log.warn(`[FirebaseService] getDocument called but Firebase not initialized. Collection: ${collectionName}/${docId}`);
            return null;
        }
        
        const cacheKey = `${collectionName}/${docId}`;
        const ttl = options.ttl || this.cacheTTL[collectionName] || this.cacheTTL.default;
        const useCache = options.useCache !== false; // 기본값: true
        const useDebounce = options.useDebounce !== false; // 기본값: true
        const useStaleWhileRevalidate = options.staleWhileRevalidate !== false; // 기본값: true
        const staleAt = ttl * 2; // staleAt = TTL * 2 (예: TTL 30초면 60초까지 stale 허용)
        
        // ⚠️ Step 5-2: Stale-While-Revalidate 패턴 적용
        if (useCache) {
            const cached = this.documentCache.get(cacheKey);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                
                if (age < ttl) {
                    // 캐시가 유효함
                    log.debug(`[FirebaseService] ✅ Cache HIT (fresh) for ${cacheKey} (age: ${Math.floor(age / 1000)}s)`);
                    return cached.data;
                } else if (age < staleAt && useStaleWhileRevalidate) {
                    // 캐시가 약간 오래되었지만 사용 가능 (Stale-While-Revalidate)
                    log.debug(`[FirebaseService] ⚠️ Cache HIT (stale) for ${cacheKey} (age: ${Math.floor(age / 1000)}s), revalidating in background`);
                    
                    // 백그라운드에서 최신 데이터 가져오기 (이미 진행 중이 아니면)
                    if (!this.backgroundUpdates.has(cacheKey)) {
                        this._revalidateInBackground(collectionName, docId, cacheKey, ttl).catch(err => {
                            log.warn(`[FirebaseService] Background revalidation failed for ${cacheKey}:`, err);
                        });
                    }
                    
                    // 오래된 캐시라도 즉시 반환
                    return cached.data;
                }
            }
        }
        
        // ⚠️ 응급 조치: 디바운스 적용 (같은 요청이 100ms 내에 여러 번 오면 마지막 것만 실행)
        if (useDebounce) {
            return new Promise((resolve, reject) => {
                // 기존 타이머가 있으면 취소
                if (this.debounceTimers.has(cacheKey)) {
                    clearTimeout(this.debounceTimers.get(cacheKey));
                }
                
                // 새 타이머 설정
                const timerId = setTimeout(async () => {
                    this.debounceTimers.delete(cacheKey);
                    try {
                        const result = await this._getDocumentInternal(collectionName, docId, cacheKey, ttl);
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                }, this.debounceDelay);
                
                this.debounceTimers.set(cacheKey, timerId);
            });
        }
        
        // 디바운스 없이 즉시 실행
        return await this._getDocumentInternal(collectionName, docId, cacheKey, ttl);
        */
    }
    
    /**
     * 문서 가져오기 내부 구현
     * ⚠️ 마이그레이션 완료: 비활성화됨
     */
    async _getDocumentInternal(collectionName, docId, cacheKey, ttl) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화
        log.warn(`[FirebaseService] _getDocumentInternal()는 더 이상 사용되지 않습니다. API를 사용하세요.`);
        return null;
        
        /* 원래 코드 (비활성화됨)
        try {
            // ⚠️ Step 5-3: 모니터링: Firestore 읽기 기록 (컨텍스트 포함)
            const monitoring = getMonitoringService();
            if (monitoring) {
                monitoring.recordFirestoreRead(1, {
                    collection: collectionName,
                    operation: 'getDocument',
                    docId: docId
                });
            }
            
            // compat 버전: 직접 사용
            const docRef = this.db.collection(collectionName).doc(docId);
            const docSnap = await docRef.get();
            
            let result = null;
            if (docSnap.exists) {
                result = { id: docSnap.id, ...docSnap.data() };
                
                // ⚠️ 응급 조치: 캐시 저장
                this.documentCache.set(cacheKey, {
                    data: result,
                    timestamp: Date.now(),
                    staleAt: ttl * 2 // ⚠️ Step 5-2: Stale-While-Revalidate를 위한 staleAt
                });
                
                log.debug(`[FirebaseService] 📡 Cache MISS for ${cacheKey}, fetched from Firestore`);
            }
            
            return result;
        } catch (error) {
            // 오프라인 에러나 존재하지 않는 문서는 조용히 처리 (에러 로그 제거)
            // pixelCanvases 컬렉션은 존재하지 않는 문서가 많을 수 있으므로 에러를 조용히 처리
            if (collectionName === 'pixelCanvases') {
                // pixelCanvases는 존재하지 않는 문서가 정상이므로 null 반환 (에러 로그 없음)
                return null;
            }
            
            // 권한 오류는 조용히 처리 (로그인하지 않은 사용자 등)
            if (error.code === 'permission-denied' || error.message?.includes('permissions') || error.message?.includes('Missing or insufficient permissions')) {
                log.debug(`[FirebaseService] Permission denied for ${collectionName}/${docId} (user not logged in)`);
                return null; // null 반환하여 호출자가 처리할 수 있도록
            }
            
            // 오프라인 에러는 null 반환 (존재하지 않는 문서로 간주)
            if (error.code === 'unavailable' || error.code === 'failed-precondition' || error.message?.includes('offline')) {
                return null;
            }
            
            // 다른 에러만 로그 출력
            log.error(`Failed to get document ${collectionName}/${docId}:`, error);
            throw error;
        }
        */
    }
    
    /**
     * 컬렉션 쿼리 내부 구현
     * ⚠️ 마이그레이션 완료: 비활성화됨
     */
    async _queryCollectionInternal(collectionName, conditions, orderByField, limitCount, cacheKey, ttl) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화
        log.warn(`[FirebaseService] _queryCollectionInternal()는 더 이상 사용되지 않습니다. API를 사용하세요.`);
        return [];
    }
    
    /**
     * 문서 저장/업데이트
     */
    async setDocument(collectionName, docId, data, merge = true) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화, API 사용 권장
        log.warn(`[FirebaseService] setDocument()는 더 이상 사용되지 않습니다. API를 사용하세요. Collection: ${collectionName}/${docId}`);
        return false;
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            log.warn(`[FirebaseService] setDocument called but Firebase not initialized. Collection: ${collectionName}/${docId}`);
            // false 반환하여 호출자가 처리할 수 있도록
            return false;
        }
        
        try {
            // undefined 필드 제거 (재귀적으로 처리)
            const cleanData = this._removeUndefinedFields(data);
            
            // 모니터링: Firestore 쓰기 기록
            const monitoring = getMonitoringService();
            if (monitoring) {
                monitoring.recordFirestoreWrite(1);
            }
            
            // compat 버전: 직접 사용
            const docRef = this.db.collection(collectionName).doc(docId);
            await docRef.set({
                ...cleanData,
                updatedAt: this._firestore.Timestamp.now()
            }, { merge });
            
            // ⚠️ 응급 조치: 캐시 무효화 (쓰기 후 캐시 삭제)
            this.invalidateCache(collectionName, docId);
            
            log.debug(`Document saved: ${collectionName}/${docId}`);
            return true;
        } catch (error) {
            // 권한 오류는 조용히 처리 (로그인하지 않은 사용자 등)
            if (error.code === 'permission-denied' || error.message?.includes('permissions') || error.message?.includes('Missing or insufficient permissions')) {
                log.debug(`[FirebaseService] Permission denied for ${collectionName}/${docId} (user not logged in)`);
                return false; // false 반환하여 호출자가 처리할 수 있도록
            }
            
            // 다른 에러만 로그 출력
            log.error(`Failed to save document ${collectionName}/${docId}:`, error);
            throw error;
        }
        */
    }
    
    /**
     * undefined 필드를 재귀적으로 제거하는 헬퍼 함수
     */
    _removeUndefinedFields(obj) {
        if (obj === null || obj === undefined) {
            return null;
        }
        
        if (Array.isArray(obj)) {
            return obj
                .map(item => this._removeUndefinedFields(item))
                .filter(item => item !== undefined);
        }
        
        if (typeof obj === 'object' && obj.constructor === Object) {
            const cleaned = {};
            for (const [key, value] of Object.entries(obj)) {
                if (value !== undefined) {
                    const cleanedValue = this._removeUndefinedFields(value);
                    if (cleanedValue !== undefined) {
                        cleaned[key] = cleanedValue;
                    }
                }
            }
            return cleaned;
        }
        
        return obj;
    }
    
    /**
     * 문서 필드 업데이트 (특정 필드만 업데이트)
     * 문서가 없으면 생성 (안전한 업데이트)
     */
    async updateDocument(collectionName, docId, data) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화, API 사용 권장
        log.warn(`[FirebaseService] updateDocument()는 더 이상 사용되지 않습니다. API를 사용하세요. Collection: ${collectionName}/${docId}`);
        return false;
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            log.warn(`[FirebaseService] updateDocument called but Firebase not initialized. Collection: ${collectionName}/${docId}`);
            // 조용히 실패 (앱이 계속 작동하도록)
            return false;
        }
        
        try {
            // compat 버전: 직접 사용
            const docRef = this.db.collection(collectionName).doc(docId);
            const docSnap = await docRef.get();
            
            // undefined 필드 제거 (재귀적으로 처리)
            const cleanData = this._removeUndefinedFields(data);
            
            if (docSnap.exists) {
                // 문서가 존재하면 업데이트
                await docRef.update({
                    ...cleanData,
                    updatedAt: this._firestore.Timestamp.now()
                });
                log.debug(`Document updated: ${collectionName}/${docId}`);
            } else {
                // 문서가 없으면 생성 (merge=true로 안전하게)
                await docRef.set({
                    ...cleanData,
                    updatedAt: this._firestore.Timestamp.now()
                }, { merge: true });
                log.debug(`Document created: ${collectionName}/${docId}`);
            }
            
            // ⚠️ 응급 조치: 캐시 무효화 (업데이트 후 캐시 삭제)
            this.invalidateCache(collectionName, docId);
            
            return true;
        } catch (error) {
            log.error(`Failed to update document ${collectionName}/${docId}:`, error);
            throw error;
        }
        */
    }
    
    /**
     * 컬렉션 쿼리
     * ⚠️ 응급 조치: 캐시 및 디바운스 적용
     */
    async queryCollection(collectionName, conditions = [], orderByField = null, limitCount = null, options = {}) {
        // ⚠️ 마이그레이션 완료: Firestore 비활성화, API 사용 권장
        log.warn(`[FirebaseService] queryCollection()는 더 이상 사용되지 않습니다. API를 사용하세요. Collection: ${collectionName}`);
        return [];
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            log.warn(`[FirebaseService] queryCollection called but Firebase not initialized. Collection: ${collectionName}`);
            return [];
        }
        
        // ⚠️ 응급 조치: 캐시 키 생성 (조건 포함)
        const conditionsKey = conditions.map(c => `${c.field}${c.op || c.operator}${c.value}`).join('_');
        const orderKey = orderByField ? `_order_${orderByField}` : '';
        const limitKey = limitCount ? `_limit_${limitCount}` : '';
        const cacheKey = `${collectionName}_${conditionsKey}${orderKey}${limitKey}`;
        const ttl = options.ttl || this.cacheTTL[collectionName] || this.cacheTTL.default;
        const useCache = options.useCache !== false; // 기본값: true
        const useDebounce = options.useDebounce !== false; // 기본값: true
        
        // ⚠️ Step 5-2: Stale-While-Revalidate 패턴 적용 (쿼리)
        const useStaleWhileRevalidate = options.staleWhileRevalidate !== false; // 기본값: true
        const staleAt = ttl * 2; // staleAt = TTL * 2
        
        if (useCache) {
            const cached = this.queryCache.get(cacheKey);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                
                if (age < ttl) {
                    // 캐시가 유효함
                    log.debug(`[FirebaseService] ✅ Cache HIT (fresh) for query ${cacheKey} (age: ${Math.floor(age / 1000)}s)`);
                    return cached.data;
                } else if (age < staleAt && useStaleWhileRevalidate) {
                    // 캐시가 약간 오래되었지만 사용 가능 (Stale-While-Revalidate)
                    log.debug(`[FirebaseService] ⚠️ Cache HIT (stale) for query ${cacheKey} (age: ${Math.floor(age / 1000)}s), revalidating in background`);
                    
                    // 백그라운드에서 최신 데이터 가져오기 (이미 진행 중이 아니면)
                    if (!this.backgroundUpdates.has(cacheKey)) {
                        this._revalidateQueryInBackground(collectionName, conditions, orderByField, limitCount, cacheKey, ttl).catch(err => {
                            log.warn(`[FirebaseService] Background revalidation failed for query ${cacheKey}:`, err);
                        });
                    }
                    
                    // 오래된 캐시라도 즉시 반환
                    return cached.data;
                }
            }
        }
        
        // ⚠️ 응급 조치: 디바운스 적용
        if (useDebounce) {
            return new Promise((resolve, reject) => {
                // 기존 타이머가 있으면 취소
                if (this.debounceTimers.has(cacheKey)) {
                    clearTimeout(this.debounceTimers.get(cacheKey));
                }
                
                // 새 타이머 설정
                const timerId = setTimeout(async () => {
                    this.debounceTimers.delete(cacheKey);
                    try {
                        const result = await this._queryCollectionInternal(collectionName, conditions, orderByField, limitCount, cacheKey, ttl);
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                }, this.debounceDelay);
                
                this.debounceTimers.set(cacheKey, timerId);
            });
        }
        
        // 디바운스 없이 즉시 실행
        return await this._queryCollectionInternal(collectionName, conditions, orderByField, limitCount, cacheKey, ttl);
        */
    }
    
    /**
     * 컬렉션 쿼리 내부 구현 (중복 - 비활성화됨)
     * ⚠️ 마이그레이션 완료: 비활성화됨
     */
    /* 원래 코드 (비활성화됨)
    async _queryCollectionInternal(collectionName, conditions, orderByField, limitCount, cacheKey, ttl) {
        try {
            // compat 버전: 직접 체이닝 방식 사용
            let q = this.db.collection(collectionName);
            
            // 조건 추가
            for (const condition of conditions) {
                // op와 operator 둘 다 지원
                const operator = condition.op || condition.operator;
                
                // 필드명, 연산자, 값 검증
                if (!condition.field) {
                    log.warn(`[FirebaseService] Skipping condition with missing field:`, condition);
                    continue;
                }
                
                if (!operator) {
                    log.warn(`[FirebaseService] Skipping condition with missing operator:`, condition);
                    continue;
                }
                
                // undefined 값 검증
                if (condition.value === undefined) {
                    log.warn(`[FirebaseService] Skipping condition with undefined value for field ${condition.field}`);
                    continue;
                }
                
                q = q.where(condition.field, operator, condition.value);
            }
            
            // 정렬 추가
            if (orderByField) {
                if (!orderByField.field) {
                    log.warn(`[FirebaseService] Skipping orderBy with missing field:`, orderByField);
                } else {
                    q = q.orderBy(orderByField.field, orderByField.direction || 'asc');
                }
            }
            
            // 제한 추가
            if (limitCount) {
                q = q.limit(limitCount);
            }
            
            const querySnapshot = await q.get();
            
            // ⚠️ Step 5-3: 모니터링: Firestore 읽기 기록 (쿼리 결과 수만큼)
            const monitoring = getMonitoringService();
            if (monitoring) {
                monitoring.recordFirestoreRead(querySnapshot.size, {
                    collection: collectionName,
                    operation: 'queryCollection',
                    conditions: conditions.length,
                    resultCount: querySnapshot.size
                });
            }
            
            const results = [];
            querySnapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            
            // ⚠️ 응급 조치: 캐시 저장
            this.queryCache.set(cacheKey, {
                data: results,
                timestamp: Date.now(),
                staleAt: ttl * 2 // ⚠️ Step 5-2: Stale-While-Revalidate를 위한 staleAt
            });
            
            log.debug(`[FirebaseService] 📡 Cache MISS for query ${cacheKey}, fetched from Firestore (${results.length} results)`);
            
            return results;
        } catch (error) {
            log.error(`Failed to query collection ${collectionName}:`, error);
            throw error;
        }
    }
    */
    
    /**
     * 캐시 무효화
     * ⚠️ 응급 조치: 특정 문서/컬렉션 캐시 삭제
     */
    invalidateCache(collectionName, docId = null) {
        if (docId) {
            // 특정 문서 캐시 삭제
            const cacheKey = `${collectionName}/${docId}`;
            this.documentCache.delete(cacheKey);
            log.debug(`[FirebaseService] 🗑️ Invalidated cache for ${cacheKey}`);
        } else {
            // 컬렉션 전체 캐시 삭제
            const prefix = `${collectionName}/`;
            const queryPrefix = `${collectionName}_`;
            
            for (const key of this.documentCache.keys()) {
                if (key.startsWith(prefix)) {
                    this.documentCache.delete(key);
                }
            }
            
            for (const key of this.queryCache.keys()) {
                if (key.startsWith(queryPrefix)) {
                    this.queryCache.delete(key);
                }
            }
            
            log.debug(`[FirebaseService] 🗑️ Invalidated all cache for collection ${collectionName}`);
        }
    }
    
    /**
     * 실시간 문서 구독
     * ⚠️ 응급 조치: 리스너 추적 시스템 추가
     * ⚠️ Step 5-1: 상황 한정 리스너 (탭 포커스 확인)
     */
    subscribeToDocument(collectionName, docId, callback, options = {}) {
        // ⚠️ 마이그레이션 완료: Firestore 실시간 리스너 비활성화, WebSocket 사용
        log.warn(`[FirebaseService] subscribeToDocument()는 더 이상 사용되지 않습니다. WebSocket을 사용하세요. Collection: ${collectionName}/${docId}`);
        return () => {}; // 빈 unsubscribe 함수 반환
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        // ⚠️ Step 5-1: 탭이 백그라운드에 있으면 중요 리스너만 허용
        const isImportant = options.important || false; // 지갑 등 중요 데이터
        if (!this.isPageVisible && !isImportant) {
            log.debug(`[FirebaseService] ⏸️ Skipping non-important listener ${collectionName}/${docId} (page hidden)`);
            // 일시 중지된 리스너로 등록 (나중에 재개 가능)
            const listenerKey = `${collectionName}/${docId}`;
            this.suspendedListeners.set(listenerKey, {
                unsubscribe: null, // 아직 구독 안 함
                context: { suspendedAt: Date.now(), callback, options }
            });
            return () => {
                this.suspendedListeners.delete(listenerKey);
            };
        }
        
        // ⚠️ 응급 조치: 기존 리스너가 있으면 해제
        const listenerKey = `${collectionName}/${docId}`;
        if (this.activeListeners.has(listenerKey)) {
            log.warn(`[FirebaseService] ⚠️ Unsubscribing existing listener for ${listenerKey}`);
            this.activeListeners.get(listenerKey)();
            this.listenerCount--;
        }
        
        // compat 버전: 직접 사용
        const docRef = this.db.collection(collectionName).doc(docId);
        const unsubscribe = docRef.onSnapshot((doc) => {
            if (doc.exists) {
                callback({ id: doc.id, ...doc.data() });
            } else {
                callback(null);
            }
        });
        
        // ⚠️ 응급 조치: 리스너 추적
        this.activeListeners.set(listenerKey, unsubscribe);
        this.listenerCount++;
        log.debug(`[FirebaseService] 📡 Subscribed to document ${listenerKey} (total listeners: ${this.listenerCount})`);
        
        // unsubscribe 함수 래핑하여 추적 유지
        const wrappedUnsubscribe = () => {
            if (this.activeListeners.has(listenerKey)) {
                this.activeListeners.delete(listenerKey);
                this.listenerCount--;
                log.debug(`[FirebaseService] 🔌 Unsubscribed from document ${listenerKey} (remaining listeners: ${this.listenerCount})`);
            }
            unsubscribe();
        };
        
        // ⚠️ Step 5-1: 페이지 가시성 변경 시 자동 해제 (중요하지 않은 리스너)
        if (!isImportant) {
            const visibilityHandler = () => {
                if (document.hidden && this.activeListeners.has(listenerKey)) {
                    log.debug(`[FirebaseService] ⏸️ Auto-suspending listener ${listenerKey} (page hidden)`);
                    this.suspendedListeners.set(listenerKey, {
                        unsubscribe: wrappedUnsubscribe,
                        context: { suspendedAt: Date.now(), callback, options }
                    });
                    wrappedUnsubscribe();
                }
            };
            document.addEventListener('visibilitychange', visibilityHandler);
        }
        
        return wrappedUnsubscribe;
        */
    }
    
    /**
     * 실시간 컬렉션 구독
     * ⚠️ 응급 조치: 리스너 추적 시스템 추가
     */
    subscribeToCollection(collectionName, callback, conditions = []) {
        // ⚠️ 마이그레이션 완료: Firestore 실시간 리스너 비활성화, WebSocket 사용
        log.warn(`[FirebaseService] subscribeToCollection()는 더 이상 사용되지 않습니다. WebSocket을 사용하세요. Collection: ${collectionName}`);
        return () => {}; // 빈 unsubscribe 함수 반환
        
        /* 원래 코드 (비활성화됨)
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        // ⚠️ 응급 조치: 리스너 키 생성 (조건 포함)
        const conditionsKey = conditions.map(c => `${c.field}${c.op}${c.value}`).join('_');
        const listenerKey = `${collectionName}/${conditionsKey || 'all'}`;
        
        // ⚠️ 응급 조치: 기존 리스너가 있으면 해제
        if (this.activeListeners.has(listenerKey)) {
            log.warn(`[FirebaseService] ⚠️ Unsubscribing existing listener for collection ${listenerKey}`);
            this.activeListeners.get(listenerKey)();
            this.listenerCount--;
        }
        
        // compat 버전: 직접 체이닝
        let q = this.db.collection(collectionName);
        
        if (conditions.length > 0) {
            for (const c of conditions) {
                q = q.where(c.field, c.op, c.value);
            }
        }
        
        const unsubscribe = q.onSnapshot((snapshot) => {
            const results = [];
            snapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            callback(results);
        });
        
        // ⚠️ 응급 조치: 리스너 추적
        this.activeListeners.set(listenerKey, unsubscribe);
        this.listenerCount++;
        log.debug(`[FirebaseService] 📡 Subscribed to collection ${listenerKey} (total listeners: ${this.listenerCount})`);
        
        // unsubscribe 함수 래핑하여 추적 유지
        return () => {
            if (this.activeListeners.has(listenerKey)) {
                this.activeListeners.delete(listenerKey);
                this.listenerCount--;
                log.debug(`[FirebaseService] 🔌 Unsubscribed from collection ${listenerKey} (remaining listeners: ${this.listenerCount})`);
            }
            unsubscribe();
        };
        */
    }
    
    /**
     * 모든 활성 리스너 해제
     * ⚠️ 응급 조치: 리스너 누수 방지
     */
    cleanupAllListeners() {
        log.info(`[FirebaseService] 🧹 Cleaning up ${this.activeListeners.size} active listeners`);
        for (const [key, unsubscribe] of this.activeListeners.entries()) {
            try {
                unsubscribe();
                log.debug(`[FirebaseService] 🔌 Unsubscribed from ${key}`);
            } catch (error) {
                log.error(`[FirebaseService] ❌ Failed to unsubscribe from ${key}:`, error);
            }
        }
        this.activeListeners.clear();
        this.listenerCount = 0;
        log.info(`[FirebaseService] ✅ All listeners cleaned up`);
    }
    
    /**
     * 활성 리스너 상태 조회
     */
    getListenerStatus() {
        return {
            count: this.listenerCount,
            listeners: Array.from(this.activeListeners.keys())
        };
    }
    
    /**
     * ⚠️ Step 5-2: 백그라운드에서 캐시 재검증 (Stale-While-Revalidate) - 문서
     */
    async _revalidateInBackground(collectionName, docId, cacheKey, ttl) {
        // 이미 진행 중인 업데이트가 있으면 기다림
        if (this.backgroundUpdates.has(cacheKey)) {
            return await this.backgroundUpdates.get(cacheKey);
        }
        
        // 백그라운드 업데이트 시작
        const updatePromise = this._getDocumentInternal(collectionName, docId, cacheKey, ttl).finally(() => {
            this.backgroundUpdates.delete(cacheKey);
        });
        
        this.backgroundUpdates.set(cacheKey, updatePromise);
        return await updatePromise;
    }
    
    /**
     * ⚠️ Step 5-2: 백그라운드에서 캐시 재검증 (Stale-While-Revalidate) - 쿼리
     */
    async _revalidateQueryInBackground(collectionName, conditions, orderByField, limitCount, cacheKey, ttl) {
        // 이미 진행 중인 업데이트가 있으면 기다림
        if (this.backgroundUpdates.has(cacheKey)) {
            return await this.backgroundUpdates.get(cacheKey);
        }
        
        // 백그라운드 업데이트 시작
        const updatePromise = this._queryCollectionInternal(collectionName, conditions, orderByField, limitCount, cacheKey, ttl).finally(() => {
            this.backgroundUpdates.delete(cacheKey);
        });
        
        this.backgroundUpdates.set(cacheKey, updatePromise);
        return await updatePromise;
    }
    
    /**
     * Timestamp 생성
     */
    createTimestamp() {
        return this._firestore.Timestamp.now();
    }
    
    /**
     * Firestore Timestamp 클래스 반환
     */
    getTimestamp() {
        return this._firestore.Timestamp;
    }
    
    /**
     * Firestore Transaction 실행 (동시성 보호)
     * @param {Function} updateFunction - Transaction 내에서 실행할 함수 (transaction 객체를 받음)
     * @returns {Promise<any>} Transaction 결과
     */
    async runTransaction(updateFunction) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            // compat 버전: db.runTransaction 사용
            // ⚠️ 주의: compat 버전에서는 maxAttempts 옵션이 지원되지 않을 수 있음
            // 대신 에러를 즉시 감지하고 재시도를 중단하도록 에러 처리에서 처리
            return await this.db.runTransaction(async (transaction) => {
                // transaction 객체를 래핑하여 호환성 제공
                const transactionWrapper = {
                    get: (collectionName, docId) => {
                        const docRef = this.db.collection(collectionName).doc(docId);
                        return transaction.get(docRef).then(doc => {
                            if (doc.exists) {
                                return { id: doc.id, ...doc.data() };
                            }
                            return null;
                        }).catch(error => {
                            // ⚠️ 할당량 초과 에러를 즉시 감지하여 재시도 방지
                            if (error.code === 'resource-exhausted' || error.code === 'quota-exceeded' || 
                                error.message?.includes('Quota exceeded') || error.message?.includes('resource-exhausted')) {
                                log.error('[FirebaseService] Quota exceeded in transaction.get, stopping retry:', error);
                                // 할당량 초과 에러는 즉시 전달 (재시도 방지)
                                throw error;
                            }
                            throw error;
                        });
                    },
                    set: (collectionName, docId, data, options = {}) => {
                        const docRef = this.db.collection(collectionName).doc(docId);
                        transaction.set(docRef, data, options);
                    },
                    update: (collectionName, docId, data) => {
                        const docRef = this.db.collection(collectionName).doc(docId);
                        transaction.update(docRef, data);
                    },
                    delete: (collectionName, docId) => {
                        const docRef = this.db.collection(collectionName).doc(docId);
                        transaction.delete(docRef);
                    }
                };
                
                return await updateFunction(transactionWrapper);
            });
        } catch (error) {
            // ⚠️ 할당량 초과 에러는 재시도하지 않음
            if (error.code === 'resource-exhausted' || error.code === 'quota-exceeded' || 
                error.message?.includes('Quota exceeded') || error.message?.includes('resource-exhausted')) {
                log.error('[FirebaseService] Transaction failed due to quota exceeded (no retry):', error);
                // 할당량 초과 에러는 그대로 전달 (재시도 방지)
                throw error;
            }
            
            log.error('[FirebaseService] Transaction failed:', error);
            throw error;
        }
    }
    
    /**
     * 사용자 프로필 가져오기
     * @param {string} userId - 사용자 ID
     * @returns {Promise<Object|null>} 사용자 프로필 데이터
     */
    async getUserProfile(userId) {
        if (!userId) return null;
        
        try {
            const userDoc = await this.getDocument('users', userId);
            if (userDoc) {
                return {
                    userId,
                    userName: userDoc.userName || userDoc.displayName || null,
                    email: userDoc.email || null,
                    photoURL: userDoc.photoURL || null,
                    ...userDoc
                };
            }
            return null;
        } catch (error) {
            log.warn(`[FirebaseService] Failed to get user profile for ${userId}:`, error);
            return null;
        }
    }
    
    /**
     * 여러 사용자 프로필 일괄 가져오기 (배치)
     * @param {string[]} userIds - 사용자 ID 배열
     * @returns {Promise<Map<string, Object>>} userId -> 프로필 매핑
     */
    async getUserProfilesBatch(userIds) {
        if (!userIds || userIds.length === 0) return new Map();
        
        const profiles = new Map();
        const promises = userIds.map(async (userId) => {
            const profile = await this.getUserProfile(userId);
            if (profile) {
                profiles.set(userId, profile);
            }
        });
        
        await Promise.all(promises);
        return profiles;
    }
    
    /**
     * 사용자 문서 생성/업데이트
     * Firebase Auth로 로그인한 사용자의 정보를 Firestore users 컬렉션에 저장
     */
    async ensureUserDocument(user) {
        if (!user || !user.uid) {
            log.warn('[FirebaseService] Cannot create user document: invalid user');
            return;
        }
        
        try {
            // ✅ 백엔드 API 사용: /api/users/me 엔드포인트가 사용자를 자동으로 생성/업데이트
            const { apiService } = await import('./ApiService.js');
            
            // API 호출 (사용자가 없으면 자동 생성, 있으면 조회)
            await apiService.getCurrentUser();
            
            log.info(`[FirebaseService] ✅ User document ensured via API: ${user.email}`);
        } catch (error) {
            log.error('[FirebaseService] Failed to ensure user document via API:', error);
            // 에러를 throw하지 않고 로그만 남김 (사용자 인증은 계속 진행)
        }
    }
}

// 싱글톤 인스턴스
export const firebaseService = new FirebaseService();
export default firebaseService;

