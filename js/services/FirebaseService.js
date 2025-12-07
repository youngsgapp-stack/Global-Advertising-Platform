/**
 * FirebaseService - Firebase 통합 서비스
 * 인증, Firestore, Storage 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class FirebaseService {
    constructor() {
        this.app = null;
        this.auth = null;
        this.db = null;
        this.storage = null;
        this.initialized = false;
        this.currentUser = null;
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
            // Firebase 모듈 동적 로드
            const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
            const { getAuth, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, GoogleAuthProvider, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
            const { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot, Timestamp, deleteField } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
            
            // Firebase 앱 초기화
            this.app = initializeApp(CONFIG.FIREBASE);
            this.auth = getAuth(this.app);
            this.db = getFirestore(this.app);
            
            // Firestore 헬퍼 저장
            this._firestore = {
                collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
                query, where, orderBy, limit, onSnapshot, Timestamp, deleteField
            };
            
            // Auth 헬퍼 저장
            this._auth = {
                signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, GoogleAuthProvider, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence, browserSessionPersistence
            };
            
            // Firebase Auth persistence 설정 (리다이렉트 인증을 위해 필수)
            // localStorage를 사용하여 리다이렉트 후에도 인증 상태가 유지되도록 함
            try {
                await setPersistence(this.auth, browserLocalPersistence);
                log.info('[FirebaseService] ✅ Auth persistence set to localStorage');
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
            onAuthStateChanged(this.auth, (user) => {
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
     * 인증 여부 확인
     */
    isAuthenticated() {
        return !!this.currentUser;
    }
    
    // ==================== Firestore Operations ====================
    
    /**
     * 문서 가져오기
     */
    async getDocument(collectionName, docId) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            const docRef = this._firestore.doc(this.db, collectionName, docId);
            const docSnap = await this._firestore.getDoc(docRef);
            
            if (docSnap.exists()) {
                return { id: docSnap.id, ...docSnap.data() };
            }
            return null;
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
    }
    
    /**
     * 문서 저장/업데이트
     */
    async setDocument(collectionName, docId, data, merge = true) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            // undefined 필드 제거
            const cleanData = {};
            for (const [key, value] of Object.entries(data)) {
                if (value !== undefined) {
                    cleanData[key] = value;
                } else {
                    log.warn(`[FirebaseService] Removing undefined field: ${key} from ${collectionName}/${docId}`);
                }
            }
            
            const docRef = this._firestore.doc(this.db, collectionName, docId);
            await this._firestore.setDoc(docRef, {
                ...cleanData,
                updatedAt: this._firestore.Timestamp.now()
            }, { merge });
            
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
    }
    
    /**
     * 문서 필드 업데이트 (특정 필드만 업데이트)
     * 문서가 없으면 생성 (안전한 업데이트)
     */
    async updateDocument(collectionName, docId, data) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            const docRef = this._firestore.doc(this.db, collectionName, docId);
            const docSnap = await this._firestore.getDoc(docRef);
            
            if (docSnap.exists()) {
                // 문서가 존재하면 업데이트
                await this._firestore.updateDoc(docRef, {
                    ...data,
                    updatedAt: this._firestore.Timestamp.now()
                });
                log.debug(`Document updated: ${collectionName}/${docId}`);
            } else {
                // 문서가 없으면 생성 (merge=true로 안전하게)
                await this._firestore.setDoc(docRef, {
                    ...data,
                    updatedAt: this._firestore.Timestamp.now()
                }, { merge: true });
                log.debug(`Document created: ${collectionName}/${docId}`);
            }
            
            return true;
        } catch (error) {
            log.error(`Failed to update document ${collectionName}/${docId}:`, error);
            throw error;
        }
    }
    
    /**
     * 컬렉션 쿼리
     */
    async queryCollection(collectionName, conditions = [], orderByField = null, limitCount = null) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            let q = this._firestore.collection(this.db, collectionName);
            
            // 조건 추가
            const queryConstraints = [];
            for (const condition of conditions) {
                queryConstraints.push(this._firestore.where(condition.field, condition.op, condition.value));
            }
            
            // 정렬 추가
            if (orderByField) {
                queryConstraints.push(this._firestore.orderBy(orderByField.field, orderByField.direction || 'asc'));
            }
            
            // 제한 추가
            if (limitCount) {
                queryConstraints.push(this._firestore.limit(limitCount));
            }
            
            q = this._firestore.query(q, ...queryConstraints);
            const querySnapshot = await this._firestore.getDocs(q);
            
            const results = [];
            querySnapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            
            return results;
        } catch (error) {
            log.error(`Failed to query collection ${collectionName}:`, error);
            throw error;
        }
    }
    
    /**
     * 실시간 문서 구독
     */
    subscribeToDocument(collectionName, docId, callback) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        const docRef = this._firestore.doc(this.db, collectionName, docId);
        return this._firestore.onSnapshot(docRef, (doc) => {
            if (doc.exists()) {
                callback({ id: doc.id, ...doc.data() });
            } else {
                callback(null);
            }
        });
    }
    
    /**
     * 실시간 컬렉션 구독
     */
    subscribeToCollection(collectionName, callback, conditions = []) {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        let q = this._firestore.collection(this.db, collectionName);
        
        if (conditions.length > 0) {
            const queryConstraints = conditions.map(c => 
                this._firestore.where(c.field, c.op, c.value)
            );
            q = this._firestore.query(q, ...queryConstraints);
        }
        
        return this._firestore.onSnapshot(q, (snapshot) => {
            const results = [];
            snapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            callback(results);
        });
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
     * 사용자 문서 생성/업데이트
     * Firebase Auth로 로그인한 사용자의 정보를 Firestore users 컬렉션에 저장
     */
    async ensureUserDocument(user) {
        if (!user || !user.uid) {
            log.warn('[FirebaseService] Cannot create user document: invalid user');
            return;
        }
        
        try {
            const userRef = this._firestore.doc(this.db, 'users', user.uid);
            const userDoc = await this._firestore.getDoc(userRef);
            
            const Timestamp = this._firestore.Timestamp;
            const now = Timestamp.now();
            
            const userData = {
                uid: user.uid,
                email: user.email || null,
                displayName: user.displayName || user.email?.split('@')[0] || 'User',
                photoURL: user.photoURL || null,
                emailVerified: user.emailVerified || false,
                createdAt: userDoc.exists() ? (userDoc.data().createdAt || now) : now,
                updatedAt: now,
                lastLoginAt: now,
                territoryCount: userDoc.exists() ? (userDoc.data().territoryCount || 0) : 0,
                banned: userDoc.exists() ? (userDoc.data().banned || false) : false
            };
            
            if (userDoc.exists()) {
                // 기존 문서 업데이트 (createdAt은 유지)
                await this._firestore.updateDoc(userRef, {
                    email: userData.email,
                    displayName: userData.displayName,
                    photoURL: userData.photoURL,
                    emailVerified: userData.emailVerified,
                    updatedAt: userData.updatedAt,
                    lastLoginAt: userData.lastLoginAt
                });
                log.info(`[FirebaseService] ✅ Updated user document: ${user.email}`);
            } else {
                // 새 문서 생성
                await this._firestore.setDoc(userRef, userData);
                log.info(`[FirebaseService] ✅ Created user document: ${user.email}`);
            }
        } catch (error) {
            log.error('[FirebaseService] Failed to ensure user document:', error);
            throw error;
        }
    }
}

// 싱글톤 인스턴스
export const firebaseService = new FirebaseService();
export default firebaseService;

