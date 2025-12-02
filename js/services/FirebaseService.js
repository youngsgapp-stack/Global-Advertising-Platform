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
            const { getAuth, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword, GoogleAuthProvider, signOut } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
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
                signInWithPopup, signInWithEmailAndPassword, GoogleAuthProvider, signOut, onAuthStateChanged
            };
            
            // 인증 상태 감시
            onAuthStateChanged(this.auth, (user) => {
                this.currentUser = user;
                eventBus.emit(EVENTS.AUTH_STATE_CHANGED, { user });
                
                if (user) {
                    log.info('User logged in:', user.email);
                    eventBus.emit(EVENTS.AUTH_LOGIN, { user });
                } else {
                    log.info('User logged out');
                    eventBus.emit(EVENTS.AUTH_LOGOUT, {});
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
     * Google 로그인
     */
    async signInWithGoogle() {
        if (!this.initialized) {
            throw new Error('Firebase not initialized');
        }
        
        try {
            const provider = new this._auth.GoogleAuthProvider();
            const result = await this._auth.signInWithPopup(this.auth, provider);
            return result.user;
        } catch (error) {
            log.error('Google sign-in failed:', error);
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
            const docRef = this._firestore.doc(this.db, collectionName, docId);
            await this._firestore.setDoc(docRef, {
                ...data,
                updatedAt: this._firestore.Timestamp.now()
            }, { merge });
            
            log.debug(`Document saved: ${collectionName}/${docId}`);
            return true;
        } catch (error) {
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
}

// 싱글톤 인스턴스
export const firebaseService = new FirebaseService();
export default firebaseService;

