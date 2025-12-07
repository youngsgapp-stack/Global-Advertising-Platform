/**
 * Admin Dashboard - 관리자 대시보드
 * 사용자, 영토, 옥션 관리 및 분석
 */

import { CONFIG } from './config.js';
import { territoryDataService } from './services/TerritoryDataService.js';

// Firebase 설정
const firebaseConfig = CONFIG.FIREBASE;

// 관리자 이메일 목록 (Firebase Auth 사용 시)
const ADMIN_EMAILS = [
    'admin@billionairemap.com',
    'young91@naver.com',
    'q886654@naver.com',  // Firebase Auth 등록 계정
    'etgbajy@gmail.com',  // Firebase Auth 등록 계정
];

// 로컬 관리자 계정 (P키 5번 연타 로그인용)
const LOCAL_ADMIN_CREDENTIALS = {
    'admin': 'billionaire2024!',
    'young91': 'admin1234!',
    'q886654': 'znznektm1@'  // Firebase 계정과 동일하게 설정
};

// 세션 인증 유효 시간 (1시간)
const SESSION_VALID_DURATION = 60 * 60 * 1000;

class AdminDashboard {
    constructor() {
        this.firebase = null;
        this.auth = null;
        this.db = null;
        this.currentUser = null;
        this.currentSection = 'overview';
        this.isUserMode = false;
        this.pixelCountCache = new Map(); // 픽셀 수 계산 결과 캐시
    }
    
    /**
     * 초기화
     */
    async init() {
        try {
            // Firebase 앱 초기화 (중복 초기화 방지)
            if (!firebase.apps.length) {
                this.firebase = firebase.initializeApp(firebaseConfig);
            } else {
                this.firebase = firebase.app();
            }
            this.db = firebase.firestore();
            this.auth = firebase.auth();
            
            // 1. 먼저 세션 인증 확인 (P키 5번 로그인)
            const sessionAuth = this.checkSessionAuth();
            if (sessionAuth) {
                console.log('Session auth valid:', sessionAuth.id);
                this.currentUser = { email: sessionAuth.id, uid: 'local-' + sessionAuth.id };
                this.isLocalAuth = true;
                
                // Firebase 익명 로그인으로 Firestore 접근 권한 획득
                await this.signInAnonymouslyForFirestore();
                
                this.showDashboard();
                this.loadDashboardData();
                this.setupEventListeners();
                return;
            }
            
            // 2. Firebase Auth 상태 감시 (세션 인증이 없는 경우만)
            this.isLocalAuth = false;
            this.auth.onAuthStateChanged((user) => {
                this.handleAuthChange(user);
            });
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            console.log('Admin Dashboard initialized');
            
        } catch (error) {
            console.error('Admin init failed:', error);
            this.showError('Failed to initialize admin dashboard');
        }
    }
    
    /**
     * Firestore 접근을 위한 익명 로그인
     */
    async signInAnonymouslyForFirestore() {
        try {
            // 이미 로그인된 경우 스킵
            if (this.auth.currentUser) {
                console.log('Already signed in to Firebase');
                return;
            }
            
            // 익명 로그인 시도
            await this.auth.signInAnonymously();
            console.log('Signed in anonymously for Firestore access');
        } catch (error) {
            console.warn('Anonymous sign-in failed:', error);
            // 실패해도 계속 진행 (읽기는 가능할 수 있음)
        }
    }
    
    /**
     * Firebase Auth 사용자 목록에서 사용자 정보 가져오기 (대체 방법)
     * 주의: Firebase Admin SDK가 없으면 직접 가져올 수 없음
     * 대신 users 컬렉션에서 가져오거나 territories에서 추출
     */
    async loadUsersFromAuth() {
        // Firebase Admin SDK가 없으면 직접 가져올 수 없음
        // 대신 users 컬렉션이나 territories에서 사용자 정보 추출
        console.warn('[AdminDashboard] Cannot load users directly from Firebase Auth (Admin SDK required)');
        return [];
    }
    
    /**
     * 세션 인증 확인 (P키 5번 로그인)
     */
    checkSessionAuth() {
        try {
            const authData = sessionStorage.getItem('adminAuth');
            if (!authData) return null;
            
            const parsed = JSON.parse(authData);
            const now = Date.now();
            
            // 세션 유효 시간 확인
            if (now - parsed.timestamp > SESSION_VALID_DURATION) {
                sessionStorage.removeItem('adminAuth');
                return null;
            }
            
            // 유효한 관리자 ID인지 확인
            if (!LOCAL_ADMIN_CREDENTIALS[parsed.id]) {
                sessionStorage.removeItem('adminAuth');
                return null;
            }
            
            return parsed;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * 인증 상태 변경 핸들러
     */
    handleAuthChange(user) {
        // 로컬 세션 인증이 이미 완료된 경우 무시
        if (this.isLocalAuth) {
            return;
        }
        
        if (user) {
            // 관리자 확인
            if (this.isAdmin(user.email)) {
                this.currentUser = user;
                this.showDashboard();
                this.loadDashboardData();
            } else {
                this.showError('Access denied. You are not an administrator.');
                this.auth.signOut();
            }
        } else {
            // 세션 인증도 없고 Firebase 인증도 없으면 로그인 화면
            const sessionAuth = this.checkSessionAuth();
            if (!sessionAuth) {
                this.showLoginScreen();
            }
        }
    }
    
    /**
     * 관리자 확인
     */
    isAdmin(email) {
        return ADMIN_EMAILS.includes(email.toLowerCase());
    }
    
    /**
     * 로그인 화면 표시
     */
    showLoginScreen() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('admin-dashboard').classList.add('hidden');
    }
    
    /**
     * 대시보드 표시
     */
    showDashboard() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('admin-dashboard').classList.remove('hidden');
        
        // 관리자 이름 표시
        document.getElementById('admin-name').textContent = 
            this.currentUser.displayName || this.currentUser.email.split('@')[0];
        
        // 마지막 업데이트 시간
        this.updateLastUpdateTime();
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        try {
            // 로그인 폼
            document.getElementById('admin-login-form')?.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleLogin();
            });
            
            // 로그아웃
            document.getElementById('admin-logout-btn')?.addEventListener('click', () => {
                // 세션 인증 삭제
                sessionStorage.removeItem('adminAuth');
                
                // Firebase 로그아웃 (Firebase Auth 사용 시)
                if (this.auth && !this.isLocalAuth) {
                    this.auth.signOut();
                } else {
                    // 로컬 로그아웃
                    window.location.href = 'index.html';
                }
            });
            
            // 새로고침
            document.getElementById('refresh-btn')?.addEventListener('click', () => {
                this.loadDashboardData();
            });
            
            // 네비게이션
            document.querySelectorAll('.nav-item').forEach(item => {
                item.addEventListener('click', () => {
                    const section = item.dataset.section;
                    this.switchSection(section);
                });
            });
            
            // 사용자 모드 전환
            document.getElementById('user-mode-btn')?.addEventListener('click', () => {
                this.toggleUserMode();
            });
            
            document.getElementById('exit-user-mode')?.addEventListener('click', () => {
                this.toggleUserMode();
            });
            
            // 필터 버튼들
            document.querySelectorAll('.filter-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const parent = e.target.closest('.filter-buttons');
                    parent.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    // 필터 적용 로직
                });
            });
            
            // 관리자 추가 버튼은 전역 이벤트 위임으로 처리 (나중에 바인딩)
            // setupEventListeners에서는 바인딩하지 않음
            
        } catch (error) {
            // setupEventListeners에서 발생하는 오류를 조용히 처리
            // (브라우저 캐시 문제로 인한 오류일 수 있음)
            console.warn('[AdminDashboard] setupEventListeners error (non-critical):', error);
        }
    }
    
    /**
     * 로그인 처리
     */
    async handleLogin() {
        const email = document.getElementById('admin-email').value;
        const password = document.getElementById('admin-password').value;
        const errorEl = document.getElementById('login-error');
        
        try {
            errorEl.classList.add('hidden');
            await this.auth.signInWithEmailAndPassword(email, password);
        } catch (error) {
            errorEl.textContent = this.getErrorMessage(error.code);
            errorEl.classList.remove('hidden');
        }
    }
    
    /**
     * 에러 메시지 변환 (한글)
     */
    getErrorMessage(code) {
        const messages = {
            'auth/user-not-found': '사용자를 찾을 수 없습니다',
            'auth/wrong-password': '비밀번호가 틀렸습니다',
            'auth/invalid-email': '유효하지 않은 이메일 주소입니다',
            'auth/too-many-requests': '시도 횟수가 너무 많습니다. 나중에 다시 시도해주세요.',
            'auth/invalid-credential': '인증 정보가 유효하지 않습니다'
        };
        return messages[code] || '로그인에 실패했습니다. 다시 시도해주세요.';
    }
    
    /**
     * 섹션 전환
     */
    switchSection(sectionName) {
        this.currentSection = sectionName;
        
        // 네비게이션 업데이트
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        
        // 섹션 표시
        document.querySelectorAll('.admin-section').forEach(section => {
            section.classList.toggle('active', section.id === `section-${sectionName}`);
        });
        
        // 제목 업데이트 (한글)
        const titles = {
            'overview': '대시보드',
            'users': '사용자 관리',
            'territories': '영토 관리',
            'auctions': '옥션 관리',
            'analytics': '분석',
            'logs': '관리자 로그',
            'settings': '설정'
        };
        document.getElementById('section-title').textContent = titles[sectionName] || sectionName;
        
        // 해당 섹션 데이터 로드
        this.loadSectionData(sectionName);
    }
    
    /**
     * 대시보드 데이터 로드
     */
    async loadDashboardData() {
        try {
            // 통계 로드
            await this.loadStats();
            
            // 최근 활동 로드
            await this.loadRecentActivity();
            
            // 상위 사용자 로드
            await this.loadTopUsers();
            
            this.updateLastUpdateTime();
            
        } catch (error) {
            console.error('Failed to load dashboard data:', error);
        }
    }
    
    /**
     * 통계 로드
     */
    async loadStats() {
        try {
            // 사용자 수
            const usersSnapshot = await this.db.collection('users').get();
            document.getElementById('stat-users').textContent = usersSnapshot.size;
            
            // 영토 수 (ruled + protected) - 모든 영토를 가져와서 필터링 (더 정확함)
            const allTerritoriesSnapshot = await this.db.collection('territories').get();
            let ruledCount = 0;
            let protectedCount = 0;
            let totalRevenue = 0;
            
            allTerritoriesSnapshot.forEach(doc => {
                const data = doc.data();
                const sovereignty = data.sovereignty;
                
                // sovereignty 필드 확인 (대소문자 구분 없이)
                if (sovereignty === 'ruled' || sovereignty === 'RULED') {
                    ruledCount++;
                    totalRevenue += data.price || 0;
                } else if (sovereignty === 'protected' || sovereignty === 'PROTECTED') {
                    protectedCount++;
                    totalRevenue += data.price || 0;
                }
            });
            
            const totalTerritories = ruledCount + protectedCount;
            document.getElementById('stat-territories').textContent = totalTerritories;
            document.getElementById('stat-revenue').textContent = totalRevenue.toLocaleString() + ' pt';
            
            // 디버깅 로그
            if (totalTerritories > 0) {
                console.log(`[AdminDashboard] Loaded stats: ${ruledCount} ruled, ${protectedCount} protected, total: ${totalTerritories}`);
            }
            
            // 활성 옥션
            const auctionsSnapshot = await this.db.collection('auctions')
                .where('status', '==', 'active').get();
            document.getElementById('stat-active').textContent = auctionsSnapshot.size;
            
        } catch (error) {
            console.error('Failed to load stats:', error);
            // 기본값 표시
            document.getElementById('stat-users').textContent = '0';
            document.getElementById('stat-territories').textContent = '0';
            document.getElementById('stat-revenue').textContent = '0 pt';
            document.getElementById('stat-active').textContent = '0';
        }
    }
    
    /**
     * 최근 활동 로드
     */
    async loadRecentActivity() {
        const container = document.getElementById('recent-activity');
        
        try {
            const snapshot = await this.db.collection('history')
                .orderBy('timestamp', 'desc')
                .limit(10)
                .get();
            
            if (snapshot.empty) {
                container.innerHTML = '<div class="empty">최근 활동이 없습니다</div>';
                return;
            }
            
            container.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                const time = this.formatTime(data.timestamp?.toDate());
                return `
                    <div class="activity-item">
                        <span class="activity-icon">${this.getActivityIcon(data.type)}</span>
                        <span class="activity-text">${data.narrative || data.type}</span>
                        <span class="activity-time">${time}</span>
                    </div>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load activity:', error);
            container.innerHTML = '<div class="empty">활동 로딩 실패</div>';
        }
    }
    
    /**
     * 상위 사용자 로드
     */
    async loadTopUsers() {
        const container = document.getElementById('top-users');
        
        try {
            const snapshot = await this.db.collection('rankings')
                .orderBy('hegemonyScore', 'desc')
                .limit(5)
                .get();
            
            if (snapshot.empty) {
                container.innerHTML = '<div class="empty">아직 사용자가 없습니다</div>';
                return;
            }
            
            container.innerHTML = snapshot.docs.map((doc, index) => {
                const data = doc.data();
                const rank = index + 1;
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
                return `
                    <div class="user-item">
                        <span class="user-rank">${medal}</span>
                        <span class="user-name">${data.userName || doc.id}</span>
                        <span class="user-score">${data.hegemonyScore?.toLocaleString() || 0}</span>
                    </div>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load top users:', error);
            container.innerHTML = '<div class="empty">사용자 로딩 실패</div>';
        }
    }
    
    /**
     * 섹션별 데이터 로드
     */
    async loadSectionData(section) {
        switch (section) {
            case 'users':
                await this.loadUsersTable();
                break;
            case 'territories':
                await this.loadTerritoriesTable();
                break;
            case 'auctions':
                await this.loadAuctionsTable();
                break;
            case 'logs':
                await this.loadAdminLogs();
                break;
            case 'settings':
                // 설정 섹션 로드 시 관리자 목록 업데이트
                if (typeof this.loadAdminList === 'function') {
                    await this.loadAdminList();
                }
                break;
        }
    }
    
    /**
     * 사용자 테이블 로드
     */
    async loadUsersTable() {
        const tbody = document.querySelector('#users-table tbody');
        
        if (!tbody) {
            console.error('[AdminDashboard] Users table tbody not found');
            return;
        }
        
        try {
            // 로딩 표시
            tbody.innerHTML = '<tr><td colspan="6" class="loading">사용자 데이터 로딩 중...</td></tr>';
            
            // Firestore에서 사용자 데이터 가져오기 (권한 문제 해결을 위해 여러 방법 시도)
            let snapshot;
            try {
                // 방법 1: 일반 쿼리
                console.log('[AdminDashboard] Attempting to load users from Firestore...');
                snapshot = await this.db.collection('users').limit(100).get();
                console.log(`[AdminDashboard] ✅ Method 1 succeeded: ${snapshot.size} users loaded`);
            } catch (error1) {
                console.warn('[AdminDashboard] Method 1 failed, trying method 2:', error1);
                console.warn('[AdminDashboard] Error details:', {
                    code: error1.code,
                    message: error1.message
                });
                try {
                    // 방법 2: 익명 인증 후 시도
                    if (!this.auth.currentUser) {
                        console.log('[AdminDashboard] No current user, signing in anonymously...');
                        await this.auth.signInAnonymously();
                        console.log('[AdminDashboard] ✅ Signed in anonymously');
                    }
                    snapshot = await this.db.collection('users').limit(100).get();
                    console.log(`[AdminDashboard] ✅ Method 2 succeeded: ${snapshot.size} users loaded`);
                } catch (error2) {
                    console.error('[AdminDashboard] Method 2 also failed:', error2);
                    console.error('[AdminDashboard] Error details:', {
                        code: error2.code,
                        message: error2.message,
                        stack: error2.stack
                    });
                    throw error2;
                }
            }
            
            console.log(`[AdminDashboard] Total users loaded: ${snapshot.size}`);
            
            if (snapshot.empty) {
                console.log('[AdminDashboard] No users found in Firestore users collection, trying to extract from territories...');
                
                // users 컬렉션이 비어있으면 territories에서 사용자 정보 추출
                try {
                    const territoriesSnapshot = await this.db.collection('territories')
                        .where('sovereignty', 'in', ['ruled', 'protected'])
                        .get();
                    
                    const userMap = new Map();
                    
                    territoriesSnapshot.docs.forEach(doc => {
                        const data = doc.data();
                        const ruler = data.ruler;
                        const rulerName = data.rulerName;
                        
                        if (ruler && !userMap.has(ruler)) {
                            // email 추출 시도 (rulerName에서 또는 다른 필드에서)
                            let email = rulerName;
                            if (rulerName && rulerName.includes('@')) {
                                email = rulerName;
                            } else {
                                // ruler가 email 형식인지 확인
                                email = ruler.includes('@') ? ruler : `${ruler}@unknown.com`;
                            }
                            
                            userMap.set(ruler, {
                                uid: ruler,
                                email: email,
                                displayName: rulerName || email.split('@')[0],
                                territoryCount: 1,
                                createdAt: data.purchasedAt || data.updatedAt || new Date()
                            });
                        } else if (ruler && userMap.has(ruler)) {
                            // 이미 존재하는 사용자면 territoryCount 증가
                            const user = userMap.get(ruler);
                            user.territoryCount++;
                        }
                    });
                    
                    if (userMap.size > 0) {
                        console.log(`[AdminDashboard] Extracted ${userMap.size} users from territories`);
                        
                        const users = Array.from(userMap.values());
                        tbody.innerHTML = users.map((user, index) => {
                            let joined = '-';
                            if (user.createdAt) {
                                if (user.createdAt.toDate && typeof user.createdAt.toDate === 'function') {
                                    joined = user.createdAt.toDate().toLocaleDateString('ko-KR');
                                } else if (user.createdAt.seconds) {
                                    joined = new Date(user.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
                                } else if (user.createdAt instanceof Date) {
                                    joined = user.createdAt.toLocaleDateString('ko-KR');
                                } else if (typeof user.createdAt === 'number') {
                                    joined = new Date(user.createdAt).toLocaleDateString('ko-KR');
                                }
                            }
                            
                            const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());
                            const adminBadge = isAdmin ? '<span class="badge badge-warning" style="margin-left: 5px;">관리자</span>' : '';
                            
                            return `
                                <tr>
                                    <td>${user.displayName}${adminBadge}</td>
                                    <td>${user.email}</td>
                                    <td>${user.territoryCount}</td>
                                    <td>${joined}</td>
                                    <td><span class="status status-active">활성</span></td>
                                    <td>
                                        <button class="btn btn-sm" onclick="adminDashboard.viewUser('${user.uid}')">보기</button>
                                        <button class="btn btn-sm btn-primary" onclick="adminDashboard.addPoints('${user.uid}')" style="margin-left: 4px;">💰 포인트</button>
                                        <button class="btn btn-sm btn-danger" onclick="adminDashboard.showBanModal('${user.uid}')" style="margin-left: 4px;">차단</button>
                                    </td>
                                </tr>
                            `;
                        }).join('');
                        
                        return;
                    }
                } catch (extractError) {
                    console.error('[AdminDashboard] Failed to extract users from territories:', extractError);
                }
                
                tbody.innerHTML = '<tr><td colspan="6" class="empty">사용자 없음 (users 컬렉션이 비어있고 territories에서도 추출할 수 없음)</td></tr>';
                return;
            }
            
            // 사용자 데이터 디버깅
            snapshot.docs.forEach((doc, index) => {
                const data = doc.data();
                console.log(`[AdminDashboard] User ${index + 1}:`, {
                    id: doc.id,
                    displayName: data.displayName,
                    email: data.email,
                    territoryCount: data.territoryCount,
                    createdAt: data.createdAt,
                    fullData: data
                });
            });
            
            tbody.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                
                // createdAt 처리 (여러 형식 지원)
                let joined = '-';
                if (data.createdAt) {
                    if (data.createdAt.toDate && typeof data.createdAt.toDate === 'function') {
                        joined = data.createdAt.toDate().toLocaleDateString('ko-KR');
                    } else if (data.createdAt.seconds) {
                        joined = new Date(data.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
                    } else if (data.createdAt instanceof Date) {
                        joined = data.createdAt.toLocaleDateString('ko-KR');
                    } else if (typeof data.createdAt === 'number') {
                        joined = new Date(data.createdAt).toLocaleDateString('ko-KR');
                    }
                }
                
                const status = data.banned ? '차단됨' : '활성';
                const statusClass = data.banned ? 'status-banned' : 'status-active';
                
                // displayName이 없으면 email에서 추출하거나 doc.id 사용
                let displayName = data.displayName;
                if (!displayName || displayName === 'undefined' || displayName === '[object Object]' || displayName === 'null') {
                    if (data.email) {
                        displayName = data.email.split('@')[0];
                    } else {
                        displayName = doc.id.substring(0, 20); // doc.id의 처음 20자만
                    }
                }
                
                // email 정리
                let email = data.email || doc.id;
                if (email === 'undefined' || email === '[object Object]' || email === 'null') {
                    email = doc.id;
                }
                
                // territoryCount 계산 (없으면 영토에서 계산)
                let territoryCount = data.territoryCount || 0;
                
                // 관리자 여부 확인
                const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
                const adminBadge = isAdmin ? '<span class="badge badge-warning" style="margin-left: 5px;">관리자</span>' : '';
                
                return `
                    <tr>
                        <td>${displayName}${adminBadge}</td>
                        <td>${email}</td>
                        <td>${territoryCount}</td>
                        <td>${joined}</td>
                        <td><span class="status ${statusClass}">${status}</span></td>
                        <td>
                            <button class="btn btn-sm" onclick="adminDashboard.viewUser('${doc.id}')">보기</button>
                            <button class="btn btn-sm btn-primary" onclick="adminDashboard.addPoints('${doc.id}')" style="margin-left: 4px;">💰 포인트</button>
                            <button class="btn btn-sm btn-danger" onclick="adminDashboard.showBanModal('${doc.id}')" style="margin-left: 4px;">차단</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            console.log(`[AdminDashboard] Successfully rendered ${snapshot.size} users in table`);
            
        } catch (error) {
            console.error('[AdminDashboard] Failed to load users:', error);
            console.error('[AdminDashboard] Error details:', {
                code: error.code,
                message: error.message,
                stack: error.stack
            });
            
            // 상세한 에러 메시지
            let errorMessage = '사용자 로딩 실패';
            if (error.code === 'permission-denied') {
                errorMessage = '권한이 없습니다. Firebase Auth로 로그인하거나 Firestore 규칙을 확인하세요.';
            } else if (error.message) {
                errorMessage = `사용자 로딩 실패: ${error.message}`;
            }
            
            tbody.innerHTML = `<tr><td colspan="6" class="error">${errorMessage}</td></tr>`;
        }
    }
    
    /**
     * 영토 테이블 로드
     * 점유된 영토(sovereignty == 'ruled' 또는 'protected')만 표시
     */
    async loadTerritoriesTable() {
        const tbody = document.querySelector('#territories-table tbody');
        
        try {
            // 점유된 영토만 필터링 (ruled 또는 protected)
            const ruledSnapshot = await this.db.collection('territories')
                .where('sovereignty', '==', 'ruled')
                .limit(50)
                .get();
            
            const protectedSnapshot = await this.db.collection('territories')
                .where('sovereignty', '==', 'protected')
                .limit(50)
                .get();
            
            // 두 결과 합치기
            const allDocs = [...ruledSnapshot.docs, ...protectedSnapshot.docs];
            
            if (allDocs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">점유된 영토 없음</td></tr>';
                return;
            }
            
            // 헬퍼 함수: 이름 추출
            const extractName = (name) => {
                if (!name) return null;
                if (typeof name === 'string') {
                    // 이상한 문자열 필터링
                    if (name === '[object Object]' || name === 'undefined' || name === 'null') {
                        return null;
                    }
                    return name;
                }
                if (typeof name === 'object') {
                    return name.en || name.ko || name.local || Object.values(name)[0] || null;
                }
                return String(name);
            };
            
            // 헬퍼 함수: 값 정리
            const cleanValue = (value, defaultValue = '-') => {
                if (!value) return defaultValue;
                if (value === '[object Object]' || value === 'undefined' || value === 'null') {
                    return defaultValue;
                }
                return value;
            };
            
            // Promise.all 결과를 문자열로 합치기
            tbody.innerHTML = (await Promise.all(allDocs.map(async (doc) => {
                const data = doc.data();
                const sovereigntyBadge = data.sovereignty === 'protected' 
                    ? '<span class="badge badge-info">보호됨</span>' 
                    : '<span class="badge badge-success">점유됨</span>';
                
                // 영토 이름 추출
                let territoryName = extractName(data.name) || 
                                  extractName(data.properties?.name) ||
                                  extractName(data.properties?.name_en) ||
                                  doc.id;
                
                // 국가명 정리
                let countryName = cleanValue(data.country, '-');
                
                // 소유자명 정리
                let rulerName = cleanValue(data.rulerName, '미점유');
                
                // 관리자 구매 여부 표시
                const adminBadge = data.purchasedByAdmin ? '<span class="badge badge-warning" title="관리자가 구매한 영토">관리자</span>' : '';
                
                // 가격 계산 (낙찰가 우선, 없으면 Firestore 저장값, 없으면 TerritoryDataService로 계산)
                // 디버깅: 원본 데이터 확인
                console.log(`[AdminDashboard] Territory ${doc.id} data:`, {
                    purchasedPrice: data.purchasedPrice,
                    tribute: data.tribute,
                    price: data.price,
                    pixelCount: data.pixelCount,
                    ruler: data.ruler,
                    rulerName: data.rulerName,
                    currentAuction: data.currentAuction
                });
                
                // 낙찰가 우선 확인 (0이 아닌 값만)
                let price = 0;
                let purchasedPrice = data.purchasedPrice && data.purchasedPrice > 0 ? parseFloat(data.purchasedPrice) : null;
                let tribute = data.tribute && data.tribute > 0 ? parseFloat(data.tribute) : null;
                const storedPrice = data.price && data.price > 0 ? parseFloat(data.price) : null;
                
                // 옥션 데이터에서 낙찰가 찾기 (가장 정확한 데이터)
                // purchasedPrice가 없거나, tribute가 있지만 옥션 데이터를 확인해야 하는 경우
                if (data.ruler && (!purchasedPrice || (tribute && !purchasedPrice))) {
                    try {
                        // territoryId만으로 쿼리 (인덱스 필요 없음)
                        const auctionSnapshot = await this.db.collection('auctions')
                            .where('territoryId', '==', doc.id)
                            .get();
                        
                        // 클라이언트 측에서 필터링
                        const matchingAuctions = auctionSnapshot.docs
                            .map(doc => ({ id: doc.id, ...doc.data() }))
                            .filter(auction => 
                                auction.status === 'ended' && 
                                (auction.highestBidder === data.ruler || auction.highestBidderName === data.rulerName)
                            )
                            .sort((a, b) => {
                                const aTime = a.endedAt?.toMillis?.() || a.endedAt?.seconds || 0;
                                const bTime = b.endedAt?.toMillis?.() || b.endedAt?.seconds || 0;
                                return bTime - aTime;
                            });
                        
                        if (matchingAuctions.length > 0) {
                            const auctionData = matchingAuctions[0];
                            // bids 배열에서 최고 입찰가 찾기 (가장 정확)
                            if (auctionData.bids && Array.isArray(auctionData.bids) && auctionData.bids.length > 0) {
                                const highestBid = Math.max(...auctionData.bids.map(b => b.amount || b.buffedAmount || 0));
                                if (highestBid > 0) {
                                    purchasedPrice = highestBid;
                                    console.log(`[AdminDashboard] Found auction price for ${doc.id} from auction bids: ${purchasedPrice}`);
                                }
                            } else if (auctionData.currentBid && auctionData.currentBid > 0) {
                                purchasedPrice = auctionData.currentBid;
                                console.log(`[AdminDashboard] Found auction price for ${doc.id} from auction currentBid: ${purchasedPrice}`);
                            }
                            // 옥션에서 찾은 가격이 있으면 tribute보다 우선 사용
                            if (purchasedPrice && tribute && purchasedPrice !== tribute) {
                                console.log(`[AdminDashboard] Overriding tribute ${tribute} with auction price ${purchasedPrice} for ${doc.id}`);
                                tribute = null; // 옥션 가격이 더 정확하므로 tribute 무시
                            }
                        }
                    } catch (error) {
                        console.warn(`[AdminDashboard] Failed to fetch auction data for ${doc.id}:`, error);
                    }
                }
                
                // 낙찰가 우선 사용
                if (purchasedPrice) {
                    price = purchasedPrice;
                    console.log(`[AdminDashboard] Using purchasedPrice for ${doc.id}: ${price}`);
                } else if (tribute) {
                    price = tribute;
                    console.log(`[AdminDashboard] Using tribute for ${doc.id}: ${price}`);
                } else if (storedPrice) {
                    price = storedPrice;
                    console.log(`[AdminDashboard] Using stored price for ${doc.id}: ${price}`);
                }
                
                // 픽셀 수 계산 (Firestore 저장값 우선, 없으면 계산)
                // 동일한 계산을 보장하기 위해 territoryName과 countryCode를 정규화
                let pixelCount = data.pixelCount && data.pixelCount > 0 ? parseFloat(data.pixelCount) : 0;
                
                // 픽셀 수 계산 (없거나 0이면) - viewTerritory와 동일한 로직 사용
                if (!pixelCount || pixelCount === 0) {
                    const countryCode = data.country || 'unknown';
                    // territoryName 정규화 (소문자로 통일) - viewTerritory와 동일
                    const normalizedName = territoryName ? String(territoryName).toLowerCase().trim() : doc.id.toLowerCase();
                    // 캐시 키 생성 (viewTerritory와 동일한 형식)
                    const cacheKey = `${doc.id}_${normalizedName}_${countryCode}`;
                    
                    if (this.pixelCountCache.has(cacheKey)) {
                        pixelCount = this.pixelCountCache.get(cacheKey);
                        console.log(`[AdminDashboard] Using cached pixel count for ${doc.id}: ${pixelCount}`);
                    } else {
                        try {
                            // properties 객체를 깊은 복사하여 일관성 보장
                            const properties = data.properties ? JSON.parse(JSON.stringify(data.properties)) : {};
                            const territory = {
                                id: doc.id,
                                name: normalizedName,
                                country: countryCode,
                                properties: properties
                            };
                            pixelCount = territoryDataService.calculatePixelCount(territory, countryCode);
                            // 캐시에 저장
                            this.pixelCountCache.set(cacheKey, pixelCount);
                            console.log(`[AdminDashboard] Calculated pixel count for ${doc.id}: ${pixelCount} (name: ${normalizedName}, country: ${countryCode})`);
                        } catch (error) {
                            console.warn(`[AdminDashboard] Failed to calculate pixel count for ${doc.id}:`, error);
                            pixelCount = 0;
                        }
                    }
                } else {
                    console.log(`[AdminDashboard] Using stored pixel count for ${doc.id}: ${pixelCount}`);
                }
                
                // 가격 계산 (낙찰가가 없을 때만)
                if (!price || price === 0) {
                    const countryCode = data.country || 'unknown';
                    try {
                        const territory = {
                            id: doc.id,
                            name: territoryName,
                            country: countryCode,
                            properties: data.properties || {}
                        };
                        price = territoryDataService.calculateTerritoryPrice(territory, countryCode);
                        console.log(`[AdminDashboard] Calculated price for ${doc.id}: ${price}`);
                    } catch (error) {
                        console.warn(`[AdminDashboard] Failed to calculate price for ${doc.id}:`, error);
                        price = 0;
                    }
                }
                
                // 숫자 타입 보장
                price = typeof price === 'number' && !isNaN(price) ? price : 0;
                pixelCount = typeof pixelCount === 'number' && !isNaN(pixelCount) ? pixelCount : 0;
                
                return `
                    <tr>
                        <td>${territoryName} ${sovereigntyBadge} ${adminBadge}</td>
                        <td>${countryName}</td>
                        <td>${rulerName}</td>
                        <td>${price.toLocaleString()} pt</td>
                        <td>${pixelCount.toLocaleString()}</td>
                        <td>
                            <button class="btn btn-sm" onclick="adminDashboard.viewTerritory('${doc.id}')">보기</button>
                            <button class="btn btn-sm" onclick="adminDashboard.editTerritory('${doc.id}')">수정</button>
                        </td>
                    </tr>
                `;
            }))).join('');
            
        } catch (error) {
            console.error('Failed to load territories:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="error">영토 로딩 실패</td></tr>';
        }
    }
    
    /**
     * 옥션 테이블 로드
     */
    async loadAuctionsTable() {
        const tbody = document.querySelector('#auctions-table tbody');
        
        try {
            const snapshot = await this.db.collection('auctions').orderBy('createdAt', 'desc').limit(100).get();
            
            if (snapshot.empty) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty">옥션 없음</td></tr>';
                return;
            }
            
            // territoryId별로 그룹화하여 중복 확인
            const territoryGroups = {};
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const territoryId = data.territoryId || doc.id;
                if (!territoryGroups[territoryId]) {
                    territoryGroups[territoryId] = [];
                }
                territoryGroups[territoryId].push({ doc, data });
            });
            
            // 만료된 옥션 자동 종료 처리
            const now = new Date();
            const expiredAuctions = [];
            
            for (const doc of snapshot.docs) {
                const data = doc.data();
                const status = (data.status || '').toLowerCase();
                
                // active 상태인 옥션만 만료 시간 확인
                if (status === 'active') {
                    const endTime = data.endTime || data.endsAt;
                    if (endTime) {
                        let endDate;
                        if (endTime.toDate && typeof endTime.toDate === 'function') {
                            endDate = endTime.toDate();
                        } else if (endTime.seconds) {
                            endDate = new Date(endTime.seconds * 1000);
                        } else if (endTime instanceof Date) {
                            endDate = endTime;
                        } else {
                            endDate = new Date(endTime);
                        }
                        
                        if (endDate && !isNaN(endDate.getTime()) && endDate.getTime() <= now.getTime()) {
                            expiredAuctions.push({ id: doc.id, data });
                        }
                    }
                }
            }
            
            // 만료된 옥션 자동 종료 처리 (비동기, 확인 없이)
            if (expiredAuctions.length > 0) {
                console.log(`[AdminDashboard] Found ${expiredAuctions.length} expired auction(s), auto-ending...`);
                expiredAuctions.forEach(({ id }) => {
                    this.endAuction(id, true).catch(err => {
                        console.error(`[AdminDashboard] Failed to auto-end auction ${id}:`, err);
                    });
                });
            }
            
            tbody.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                const territoryId = data.territoryId || doc.id;
                const endsAt = data.endTime?.toDate()?.toLocaleString('ko-KR') || data.endsAt?.toDate()?.toLocaleString('ko-KR') || '-';
                
                // 상태 확인 (대소문자 구분 없이)
                const status = data.status || '';
                let isActive = status.toLowerCase() === 'active';
                
                // 만료 시간 확인 (status가 active여도 만료되었으면 종료로 표시)
                if (isActive) {
                    const endTime = data.endTime || data.endsAt;
                    if (endTime) {
                        let endDate;
                        if (endTime.toDate && typeof endTime.toDate === 'function') {
                            endDate = endTime.toDate();
                        } else if (endTime.seconds) {
                            endDate = new Date(endTime.seconds * 1000);
                        } else if (endTime instanceof Date) {
                            endDate = endTime;
                        } else {
                            endDate = new Date(endTime);
                        }
                        
                        if (endDate && !isNaN(endDate.getTime()) && endDate.getTime() <= now.getTime()) {
                            isActive = false; // 만료되었으면 종료로 표시
                            console.log(`[AdminDashboard] Auction ${doc.id} is expired but status is active, marking as ended`);
                        }
                    }
                }
                
                const statusText = isActive ? '진행중' : '종료됨';
                const statusClass = isActive ? 'status-active' : 'status-ended';
                
                // 중복 옥션 확인
                const duplicates = territoryGroups[territoryId] || [];
                const activeDuplicates = duplicates.filter(d => {
                    const s = d.data.status || '';
                    return s.toLowerCase() === 'active';
                });
                const isDuplicate = activeDuplicates.length > 1 && isActive;
                const duplicateBadge = isDuplicate ? `<span class="badge badge-warning" title="중복 옥션: ${activeDuplicates.length}개">중복</span>` : '';
                
                // 디버깅: 활성 옥션 확인
                if (isActive) {
                    console.log(`[AdminDashboard] Active auction found: ${doc.id}, status: ${status}, territoryId: ${territoryId}`);
                }
                
                return `
                    <tr ${isDuplicate ? 'style="background-color: rgba(255, 193, 7, 0.1);"' : ''}>
                        <td>${territoryId} ${duplicateBadge}</td>
                        ${(() => {
                            // 입찰가 계산: bids 배열의 최고 입찰가 또는 currentBid 사용
                            let displayBid = data.currentBid || data.startingBid || data.startingPrice || 0;
                            
                            // bids 배열이 있으면 최고 입찰가 확인
                            if (data.bids && Array.isArray(data.bids) && data.bids.length > 0) {
                                const highestBid = Math.max(...data.bids.map(b => b.amount || b.buffedAmount || 0));
                                if (highestBid > 0 && highestBid >= displayBid) {
                                    displayBid = highestBid;
                                }
                            }
                            
                            return `<td>${displayBid.toLocaleString()} pt</td>`;
                        })()}
                        <td>${(data.bids && Array.isArray(data.bids) ? data.bids.length : 0) || data.bidCount || 0}</td>
                        <td>${endsAt}</td>
                        <td><span class="status ${statusClass}">${statusText}</span></td>
                        <td>${data.createdAt?.toDate ? data.createdAt.toDate().toLocaleString('ko-KR') : '-'}</td>
                        <td style="white-space: nowrap; min-width: 250px;">
                            <button class="btn btn-sm" onclick="adminDashboard.viewAuction('${doc.id}')">보기</button>
                            ${isActive ? 
                                `<button class="btn btn-sm btn-secondary" onclick="adminDashboard.editAuctionTime('${doc.id}')" title="종료 시간 수정" style="margin-left: 4px; display: inline-block;">⏰ 시간 수정</button>
                                <button class="btn btn-sm btn-danger" onclick="adminDashboard.endAuction('${doc.id}')" style="margin-left: 4px; display: inline-block;">종료</button>` 
                                : ''
                            }
                            ${!isActive && data.highestBidder ? 
                                `<button class="btn btn-sm btn-primary" onclick="adminDashboard.processAuctionOwnership('${doc.id}')" title="소유권 이전 처리" style="margin-left: 4px; display: inline-block;">✅ 소유권 이전</button>` 
                                : ''
                            }
                            <button class="btn btn-sm btn-warning" onclick="adminDashboard.deleteAuction('${doc.id}')" title="옥션 삭제" style="margin-left: 4px; display: inline-block;">🗑️ 삭제</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            // 중복 옥션 요약 정보 표시
            const duplicateCount = Object.values(territoryGroups).filter(group => {
                const active = group.filter(d => d.data.status === 'active');
                return active.length > 1;
            }).length;
            
            if (duplicateCount > 0) {
                const summary = document.createElement('div');
                summary.className = 'alert alert-warning';
                summary.style.marginTop = '10px';
                summary.innerHTML = `
                    <strong>⚠️ 중복 옥션 감지:</strong> ${duplicateCount}개 영토에 대해 중복된 활성 옥션이 있습니다. 
                    <button class="btn btn-sm btn-warning" onclick="adminDashboard.cleanupDuplicateAuctions()">중복 옥션 정리</button>
                `;
                const tableWrapper = document.querySelector('.data-table-wrapper');
                if (tableWrapper && !tableWrapper.querySelector('.alert-warning')) {
                    tableWrapper.appendChild(summary);
                }
            }
            
        } catch (error) {
            console.error('Failed to load auctions:', error);
            tbody.innerHTML = '<tr><td colspan="7" class="error">옥션 로딩 실패</td></tr>';
        }
    }
    
    /**
     * 사용자 모드 토글
     */
    toggleUserMode() {
        this.isUserMode = !this.isUserMode;
        
        if (this.isUserMode) {
            // 사용자 모드로 전환 - 관리자 세션 유지하면서 메인 페이지로 이동
            // 세션 스토리지에 관리자 모드 표시 저장
            sessionStorage.setItem('adminUserMode', 'true');
            
            // 현재 로그인한 관리자의 실제 ID를 사용하여 adminAuth 저장/업데이트
            let adminId = 'admin';
            let adminEmail = null;
            
            // 1. Firebase Auth로 로그인한 경우 (우선순위)
            if (this.currentUser && this.currentUser.email) {
                adminEmail = this.currentUser.email;
                adminId = this.currentUser.email.split('@')[0];
                console.log(`[AdminDashboard] Using Firebase Auth user: ${adminEmail}, adminId: ${adminId}`);
            } 
            // 2. 세션 인증이 있는 경우
            else {
                const sessionAuth = this.checkSessionAuth();
                if (sessionAuth && sessionAuth.id) {
                    adminId = sessionAuth.id;
                    // 이메일이 있으면 사용
                    if (sessionAuth.email) {
                        adminEmail = sessionAuth.email;
                    } else {
                        // 이메일이 없으면 adminId 기반으로 생성
                        adminEmail = `${adminId}@admin.local`;
                    }
                    console.log(`[AdminDashboard] Using session auth: ${adminId}, email: ${adminEmail}`);
                }
            }
            
            // adminAuth 저장/업데이트 (항상 현재 관리자 정보로 업데이트)
            const adminAuthData = {
                id: adminId,
                email: adminEmail || `${adminId}@admin.local`,
                timestamp: Date.now()
            };
            sessionStorage.setItem('adminAuth', JSON.stringify(adminAuthData));
            console.log(`[AdminDashboard] Saved adminAuth:`, adminAuthData);
            
            // 메인 페이지로 이동 (새 탭 대신 현재 창)
            window.location.href = 'index.html';
        } else {
            sessionStorage.removeItem('adminUserMode');
            document.getElementById('user-mode-banner').classList.add('hidden');
        }
    }
    
    /**
     * 시간 포맷
     */
    formatTime(date) {
        if (!date) return 'N/A';
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return date.toLocaleDateString();
    }
    
    /**
     * 마지막 업데이트 시간
     */
    updateLastUpdateTime() {
        document.getElementById('last-update-time').textContent = new Date().toLocaleTimeString();
    }
    
    /**
     * 활동 아이콘
     */
    getActivityIcon(type) {
        const icons = {
            'CONQUERED': '⚔️',
            'AUCTION_START': '🏷️',
            'AUCTION_BID': '💰',
            'AUCTION_END': '🏆',
            'PIXEL_MILESTONE': '🎨',
            'COLLAB_JOINED': '👥'
        };
        return icons[type] || '📝';
    }
    
    /**
     * 에러 표시
     */
    showError(message) {
        alert(message);
    }
    
    // === 관리 액션 ===
    
    async viewUser(userId) {
        try {
            // 사용자 정보 가져오기
            const userDoc = await this.db.collection('users').doc(userId).get();
            if (!userDoc.exists) {
                alert('사용자를 찾을 수 없습니다.');
                return;
            }
            
            const userData = userDoc.data();
            
            // 지갑 정보 가져오기
            let walletData = null;
            try {
                const walletDoc = await this.db.collection('wallets').doc(userId).get();
                if (walletDoc.exists) {
                    walletData = walletDoc.data();
                }
            } catch (walletError) {
                console.warn('Failed to load wallet:', walletError);
            }
            
            // 영토 개수 계산
            let territoryCount = userData.territoryCount || 0;
            try {
                const territoriesSnapshot = await this.db.collection('territories')
                    .where('ruler', '==', userId)
                    .get();
                territoryCount = territoriesSnapshot.size;
            } catch (error) {
                console.warn('Failed to count territories:', error);
            }
            
            // 날짜 포맷팅
            const formatDate = (date) => {
                if (!date) return '-';
                if (date.toDate && typeof date.toDate === 'function') {
                    return date.toDate().toLocaleString('ko-KR');
                } else if (date.seconds) {
                    return new Date(date.seconds * 1000).toLocaleString('ko-KR');
                } else if (date instanceof Date) {
                    return date.toLocaleString('ko-KR');
                } else if (typeof date === 'number') {
                    return new Date(date).toLocaleString('ko-KR');
                }
                return '-';
            };
            
            const displayName = userData.displayName || userData.email?.split('@')[0] || userId.substring(0, 20);
            const email = userData.email || userId;
            const photoURL = userData.photoURL || '';
            const emailVerified = userData.emailVerified ? '예' : '아니오';
            const banned = userData.banned ? '차단됨' : '활성';
            const bannedClass = userData.banned ? 'status-banned' : 'status-active';
            const createdAt = formatDate(userData.createdAt);
            const lastLoginAt = formatDate(userData.lastLoginAt);
            const bannedAt = formatDate(userData.bannedAt);
            const bannedBy = userData.bannedBy || '-';
            const balance = walletData?.balance || 0;
            const totalCharged = walletData?.totalCharged || 0;
            const totalSpent = walletData?.totalSpent || 0;
            const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
            
            const modalHtml = `
                <div class="modal-overlay" id="user-modal-overlay" onclick="adminDashboard.closeUserModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 700px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">👤 사용자 상세 정보</h2>
                            <button class="modal-close" onclick="adminDashboard.closeUserModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 사용자 기본 정보 -->
                            <div style="background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #667eea;">
                                <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px;">
                                    ${photoURL ? `<img src="${photoURL}" alt="${displayName}" style="width: 60px; height: 60px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">` : ''}
                                    <div>
                                        <h3 style="margin: 0; color: #333; font-size: 20px;">${displayName} ${isAdmin ? '<span class="badge badge-warning">관리자</span>' : ''}</h3>
                                        <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">${email}</p>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- 정보 그리드 -->
                            <div class="info-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">사용자 ID</label>
                                    <span style="color: #333; font-size: 14px; word-break: break-all;">${userId}</span>
                                </div>
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">이메일 인증</label>
                                    <span style="color: #333; font-size: 14px;">${emailVerified}</span>
                                </div>
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">상태</label>
                                    <span class="status ${bannedClass}" style="display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold;">${banned}</span>
                                </div>
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">보유 영토</label>
                                    <span style="color: #333; font-size: 14px; font-weight: bold;">${territoryCount}개</span>
                                </div>
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">가입일</label>
                                    <span style="color: #333; font-size: 14px;">${createdAt}</span>
                                </div>
                                <div class="info-item" style="background: white; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0;">
                                    <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">마지막 로그인</label>
                                    <span style="color: #333; font-size: 14px;">${lastLoginAt}</span>
                                </div>
                            </div>
                            
                            <!-- 지갑 정보 -->
                            <div style="background: linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%); padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #f39c12;">
                                <h3 style="margin-top: 0; margin-bottom: 15px; color: #333; font-size: 18px;">💰 지갑 정보</h3>
                                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                                    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center;">
                                        <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">현재 잔액</label>
                                        <span style="color: #2d3436; font-size: 20px; font-weight: bold;">${balance.toLocaleString()} pt</span>
                                    </div>
                                    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center;">
                                        <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">총 충전액</label>
                                        <span style="color: #2d3436; font-size: 18px; font-weight: bold;">${totalCharged.toLocaleString()} pt</span>
                                    </div>
                                    <div style="background: white; padding: 15px; border-radius: 8px; text-align: center;">
                                        <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">총 사용액</label>
                                        <span style="color: #2d3436; font-size: 18px; font-weight: bold;">${totalSpent.toLocaleString()} pt</span>
                                    </div>
                                </div>
                            </div>
                            
                            ${userData.banned ? `
                            <!-- 차단 정보 -->
                            <div style="background: #fee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e74c3c;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #c0392b; font-size: 16px;">🚫 차단 정보</h3>
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                    <div>
                                        <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">차단 일시</label>
                                        <span style="color: #333; font-size: 14px;">${bannedAt}</span>
                                    </div>
                                    <div>
                                        <label style="display: block; font-weight: bold; color: #666; margin-bottom: 5px; font-size: 12px;">차단한 관리자</label>
                                        <span style="color: #333; font-size: 14px;">${bannedBy}</span>
                                    </div>
                                </div>
                            </div>
                            ` : ''}
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeUserModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">닫기</button>
                            <button class="btn btn-primary" onclick="adminDashboard.addPoints('${userId}'); adminDashboard.closeUserModal();" style="padding: 10px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">💰 포인트 지급</button>
                            ${!userData.banned ? `<button class="btn btn-danger" onclick="adminDashboard.showBanModal('${userId}'); adminDashboard.closeUserModal();" style="padding: 10px 20px; background: #e74c3c; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">🚫 차단</button>` : ''}
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('user-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            this.logAdminAction('VIEW_USER', { userId });
            
        } catch (error) {
            console.error('Failed to load user:', error);
            alert(`사용자 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closeUserModal() {
        const modal = document.getElementById('user-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 차단 설명 모달 표시
     */
    showBanModal(userId) {
        // 사용자 정보 가져오기
        this.db.collection('users').doc(userId).get().then(doc => {
            if (!doc.exists) {
                alert('사용자를 찾을 수 없습니다.');
                return;
            }
            
            const userData = doc.data();
            const displayName = userData.displayName || userData.email?.split('@')[0] || userId.substring(0, 20);
            const email = userData.email || userId;
            
            const modalHtml = `
                <div class="modal-overlay" id="ban-modal-overlay" onclick="adminDashboard.closeBanModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 600px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">🚫 사용자 차단</h2>
                            <button class="modal-close" onclick="adminDashboard.closeBanModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 사용자 정보 -->
                            <div style="background: #fee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e74c3c;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #c0392b; font-size: 16px;">차단 대상</h3>
                                <p style="margin: 0; color: #333; font-size: 14px;"><strong>${displayName}</strong> (${email})</p>
                            </div>
                            
                            <!-- 차단 기능 설명 -->
                            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
                                <h3 style="margin-top: 0; margin-bottom: 15px; color: #856404; font-size: 16px;">⚠️ 차단 기능 안내</h3>
                                <ul style="margin: 0; padding-left: 20px; color: #856404; line-height: 1.8;">
                                    <li>차단된 사용자는 <strong>로그인 및 모든 서비스 이용이 제한</strong>됩니다.</li>
                                    <li>차단된 사용자의 <strong>보유 영토는 자동으로 해제</strong>됩니다.</li>
                                    <li>차단은 <strong>관리자에 의해서만 해제</strong>할 수 있습니다.</li>
                                    <li>차단 사유는 로그에 기록되며, <strong>되돌릴 수 없습니다</strong>.</li>
                                </ul>
                            </div>
                            
                            <!-- 차단 사유 입력 -->
                            <div style="margin-bottom: 20px;">
                                <label style="display: block; font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px;">차단 사유 (선택사항)</label>
                                <textarea id="ban-reason-input" placeholder="차단 사유를 입력하세요..." style="width: 100%; min-height: 100px; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; resize: vertical;"></textarea>
                            </div>
                            
                            <!-- 경고 메시지 -->
                            <div style="background: #f8d7da; padding: 15px; border-radius: 8px; border: 1px solid #f5c6cb; margin-bottom: 20px;">
                                <p style="margin: 0; color: #721c24; font-size: 14px; font-weight: bold;">⚠️ 이 작업은 되돌릴 수 없습니다. 신중하게 결정하세요.</p>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeBanModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                            <button class="btn btn-danger" onclick="adminDashboard.confirmBanUser('${userId}')" style="padding: 10px 30px; background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">🚫 차단 확인</button>
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('ban-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
        }).catch(error => {
            console.error('Failed to load user for ban:', error);
            alert(`사용자 정보를 불러오는데 실패했습니다: ${error.message}`);
        });
    }
    
    closeBanModal() {
        const modal = document.getElementById('ban-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 사용자 차단 확인 및 실행
     */
    async confirmBanUser(userId) {
        const reasonInput = document.getElementById('ban-reason-input');
        const reason = reasonInput ? reasonInput.value.trim() : '';
        
        try {
            await this.db.collection('users').doc(userId).update({
                banned: true,
                bannedAt: firebase.firestore.FieldValue.serverTimestamp(),
                bannedBy: this.currentUser?.email || 'admin',
                banReason: reason || '관리자에 의해 차단됨'
            });
            
            this.logAdminAction('BAN_USER', { userId, reason });
            this.closeBanModal();
            this.loadUsersTable(); // Refresh
            alert('✅ 사용자가 차단되었습니다.');
        } catch (error) {
            console.error('Failed to ban user:', error);
            this.handleFirestoreError(error, '사용자 차단');
        }
    }
    
    /**
     * 포인트 지급 모달 표시
     */
    async addPoints(userId) {
        try {
            // 사용자 정보 가져오기
            const userDoc = await this.db.collection('users').doc(userId).get();
            if (!userDoc.exists) {
                alert('사용자를 찾을 수 없습니다.');
                return;
            }
            
            const userData = userDoc.data();
            const displayName = userData.displayName || userData.email?.split('@')[0] || userId.substring(0, 20);
            const email = userData.email || userId;
            
            // 지갑 정보 가져오기
            let walletData = null;
            let currentBalance = 0;
            try {
                const walletDoc = await this.db.collection('wallets').doc(userId).get();
                if (walletDoc.exists) {
                    walletData = walletDoc.data();
                    currentBalance = walletData.balance || 0;
                }
            } catch (walletError) {
                console.warn('Failed to load wallet:', walletError);
            }
            
            const modalHtml = `
                <div class="modal-overlay" id="points-modal-overlay" onclick="adminDashboard.closePointsModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 600px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #00b894 0%, #00a085 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">💰 포인트 지급</h2>
                            <button class="modal-close" onclick="adminDashboard.closePointsModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 사용자 정보 -->
                            <div style="background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%); padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #00b894;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #2e7d32; font-size: 16px;">👤 지급 대상</h3>
                                <p style="margin: 0; color: #333; font-size: 14px;"><strong>${displayName}</strong> (${email})</p>
                                <p style="margin: 5px 0 0 0; color: #666; font-size: 13px;">현재 잔액: <strong>${currentBalance.toLocaleString()} pt</strong></p>
                            </div>
                            
                            <!-- 포인트 지급 양식 -->
                            <div style="margin-bottom: 20px;">
                                <label style="display: block; font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px;">지급할 포인트 (pt)</label>
                                <input type="number" id="points-amount-input" min="1" step="1" placeholder="지급할 포인트를 입력하세요" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 16px; font-weight: bold; text-align: center;" autofocus>
                                <p style="margin: 8px 0 0 0; color: #666; font-size: 12px;">※ 최소 1 pt 이상 입력해주세요.</p>
                            </div>
                            
                            <!-- 빠른 선택 버튼 -->
                            <div style="margin-bottom: 20px;">
                                <label style="display: block; font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px;">빠른 선택</label>
                                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
                                    <button type="button" onclick="document.getElementById('points-amount-input').value = '100'" style="padding: 10px; background: #e3f2fd; color: #1976d2; border: 1px solid #90caf9; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px;">100 pt</button>
                                    <button type="button" onclick="document.getElementById('points-amount-input').value = '500'" style="padding: 10px; background: #e3f2fd; color: #1976d2; border: 1px solid #90caf9; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px;">500 pt</button>
                                    <button type="button" onclick="document.getElementById('points-amount-input').value = '1000'" style="padding: 10px; background: #e3f2fd; color: #1976d2; border: 1px solid #90caf9; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px;">1,000 pt</button>
                                    <button type="button" onclick="document.getElementById('points-amount-input').value = '5000'" style="padding: 10px; background: #e3f2fd; color: #1976d2; border: 1px solid #90caf9; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px;">5,000 pt</button>
                                </div>
                            </div>
                            
                            <!-- 사유 입력 -->
                            <div style="margin-bottom: 20px;">
                                <label style="display: block; font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px;">지급 사유 (선택사항)</label>
                                <textarea id="points-reason-input" placeholder="포인트 지급 사유를 입력하세요..." style="width: 100%; min-height: 80px; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; resize: vertical;"></textarea>
                            </div>
                            
                            <!-- 예상 잔액 표시 -->
                            <div id="points-preview" style="background: #f0f0f0; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: none;">
                                <p style="margin: 0; color: #333; font-size: 14px;">
                                    현재 잔액: <strong>${currentBalance.toLocaleString()} pt</strong><br>
                                    지급 후 예상 잔액: <strong id="points-preview-amount" style="color: #00b894; font-size: 18px;">-</strong>
                                </p>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closePointsModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                            <button class="btn btn-primary" onclick="adminDashboard.confirmAddPoints('${userId}')" style="padding: 10px 30px; background: linear-gradient(135deg, #00b894 0%, #00a085 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">💰 지급 확인</button>
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('points-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // 포인트 입력 시 예상 잔액 업데이트
            const amountInput = document.getElementById('points-amount-input');
            const previewDiv = document.getElementById('points-preview');
            const previewAmount = document.getElementById('points-preview-amount');
            
            if (amountInput && previewDiv && previewAmount) {
                amountInput.addEventListener('input', (e) => {
                    const amount = parseInt(e.target.value) || 0;
                    if (amount > 0) {
                        const newBalance = currentBalance + amount;
                        previewAmount.textContent = newBalance.toLocaleString() + ' pt';
                        previewDiv.style.display = 'block';
                    } else {
                        previewDiv.style.display = 'none';
                    }
                });
            }
            
        } catch (error) {
            console.error('Failed to load user for points:', error);
            alert(`사용자 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closePointsModal() {
        const modal = document.getElementById('points-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 포인트 지급 확인 및 실행
     */
    async confirmAddPoints(userId) {
        const amountInput = document.getElementById('points-amount-input');
        const reasonInput = document.getElementById('points-reason-input');
        
        if (!amountInput) {
            alert('포인트 입력 필드를 찾을 수 없습니다.');
            return;
        }
        
        const amount = parseInt(amountInput.value);
        const reason = reasonInput ? reasonInput.value.trim() : '';
        
        if (isNaN(amount) || amount <= 0) {
            alert('올바른 포인트를 입력해주세요. (1 pt 이상)');
            amountInput.focus();
            return;
        }
        
        try {
            // 지갑 문서 가져오기 또는 생성
            const walletRef = this.db.collection('wallets').doc(userId);
            const walletDoc = await walletRef.get();
            
            const Timestamp = firebase.firestore.FieldValue.serverTimestamp();
            const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;
            const newBalance = currentBalance + amount;
            const totalCharged = walletDoc.exists ? (walletDoc.data().totalCharged || 0) : 0;
            const newTotalCharged = totalCharged + amount;
            
            if (walletDoc.exists) {
                // 기존 지갑 업데이트
                await walletRef.update({
                    balance: newBalance,
                    totalCharged: newTotalCharged,
                    updatedAt: Timestamp
                });
            } else {
                // 새 지갑 생성
                await walletRef.set({
                    userId: userId,
                    balance: newBalance,
                    totalCharged: newTotalCharged,
                    totalSpent: 0,
                    createdAt: Timestamp,
                    updatedAt: Timestamp
                });
            }
            
            // 거래 내역 추가
            const transactionRef = this.db.collection('wallets').doc(userId).collection('transactions').doc();
            await transactionRef.set({
                type: 'admin_grant',
                amount: amount,
                balance: newBalance,
                reason: reason || '관리자에 의해 지급됨',
                createdBy: this.currentUser?.email || 'admin',
                createdAt: Timestamp
            });
            
            this.logAdminAction('ADD_POINTS', { userId, amount, reason });
            this.closePointsModal();
            this.loadUsersTable(); // Refresh
            alert(`✅ 포인트가 지급되었습니다.\n\n지급액: ${amount.toLocaleString()} pt\n새 잔액: ${newBalance.toLocaleString()} pt`);
        } catch (error) {
            console.error('Failed to add points:', error);
            this.handleFirestoreError(error, '포인트 지급');
        }
    }
    
    async viewTerritory(territoryId) {
        try {
            const doc = await this.db.collection('territories').doc(territoryId).get();
            if (!doc.exists) {
                alert('영토를 찾을 수 없습니다.');
                return;
            }
            
            const data = doc.data();
            
            // 이름 추출 (loadTerritoriesTable과 동일한 로직 사용)
            const extractName = (name) => {
                if (!name) return null;
                if (typeof name === 'string') {
                    if (name === '[object Object]' || name === 'undefined' || name === 'null') {
                        return null;
                    }
                    return name;
                }
                if (typeof name === 'object') {
                    return name.en || name.ko || name.local || Object.values(name)[0] || null;
                }
                return String(name);
            };
            
            // loadTerritoriesTable과 동일한 추출 방식
            const territoryName = extractName(data.name) || 
                                  extractName(data.properties?.name) ||
                                  extractName(data.properties?.name_en) ||
                                  territoryId;
            const countryName = data.country || '-';
            const rulerName = data.rulerName || '미점유';
            const sovereignty = data.sovereignty || 'unconquered';
            const sovereigntyText = sovereignty === 'ruled' ? '점유됨' : sovereignty === 'protected' ? '보호됨' : '미점유';
            
            // 가격 계산: 낙찰가 우선, 없으면 저장된 가격, 없으면 계산
            // 디버깅: 원본 데이터 확인
            console.log(`[AdminDashboard] viewTerritory ${territoryId} data:`, {
                purchasedPrice: data.purchasedPrice,
                tribute: data.tribute,
                price: data.price,
                pixelCount: data.pixelCount,
                ruler: data.ruler,
                rulerName: data.rulerName
            });
            
            // 낙찰가 우선 확인 (0이 아닌 값만)
            let price = 0;
            let purchasedPrice = data.purchasedPrice && data.purchasedPrice > 0 ? parseFloat(data.purchasedPrice) : null;
            let tribute = data.tribute && data.tribute > 0 ? parseFloat(data.tribute) : null;
            const storedPrice = data.price && data.price > 0 ? parseFloat(data.price) : null;
            
            // 옥션 데이터에서 낙찰가 찾기 (가장 정확한 데이터)
            // purchasedPrice가 없거나, tribute가 있지만 옥션 데이터를 확인해야 하는 경우
            if (data.ruler && (!purchasedPrice || (tribute && !purchasedPrice))) {
                try {
                    // territoryId만으로 쿼리 (인덱스 필요 없음)
                    const auctionSnapshot = await this.db.collection('auctions')
                        .where('territoryId', '==', territoryId)
                        .get();
                    
                    // 클라이언트 측에서 필터링
                    const matchingAuctions = auctionSnapshot.docs
                        .map(doc => ({ id: doc.id, ...doc.data() }))
                        .filter(auction => 
                            auction.status === 'ended' && 
                            (auction.highestBidder === data.ruler || auction.highestBidderName === data.rulerName)
                        )
                        .sort((a, b) => {
                            const aTime = a.endedAt?.toMillis?.() || a.endedAt?.seconds || 0;
                            const bTime = b.endedAt?.toMillis?.() || b.endedAt?.seconds || 0;
                            return bTime - aTime;
                        });
                    
                    if (matchingAuctions.length > 0) {
                        const auctionData = matchingAuctions[0];
                        // bids 배열에서 최고 입찰가 찾기 (가장 정확)
                        if (auctionData.bids && Array.isArray(auctionData.bids) && auctionData.bids.length > 0) {
                            const highestBid = Math.max(...auctionData.bids.map(b => b.amount || b.buffedAmount || 0));
                            if (highestBid > 0) {
                                purchasedPrice = highestBid;
                                console.log(`[AdminDashboard] viewTerritory: Found auction price from auction bids: ${purchasedPrice}`);
                            }
                        } else if (auctionData.currentBid && auctionData.currentBid > 0) {
                            purchasedPrice = auctionData.currentBid;
                            console.log(`[AdminDashboard] viewTerritory: Found auction price from auction currentBid: ${purchasedPrice}`);
                        }
                        // 옥션에서 찾은 가격이 있으면 tribute보다 우선 사용
                        if (purchasedPrice && tribute && purchasedPrice !== tribute) {
                            console.log(`[AdminDashboard] viewTerritory: Overriding tribute ${tribute} with auction price ${purchasedPrice}`);
                            tribute = null; // 옥션 가격이 더 정확하므로 tribute 무시
                        }
                    }
                } catch (error) {
                    console.warn(`[AdminDashboard] Failed to fetch auction data for ${territoryId}:`, error);
                }
            }
            
            // 낙찰가 우선 사용
            if (purchasedPrice) {
                price = purchasedPrice;
                console.log(`[AdminDashboard] viewTerritory: Using purchasedPrice: ${price}`);
            } else if (tribute) {
                price = tribute;
                console.log(`[AdminDashboard] viewTerritory: Using tribute: ${price}`);
            } else if (storedPrice) {
                price = storedPrice;
                console.log(`[AdminDashboard] viewTerritory: Using stored price: ${price}`);
            }
            
            // 픽셀 수 계산 (Firestore 저장값 우선, 없으면 계산)
            // loadTerritoriesTable과 동일한 계산을 보장하기 위해 territoryName과 countryCode를 정규화
            let pixelCount = data.pixelCount && data.pixelCount > 0 ? parseFloat(data.pixelCount) : 0;
            
            // 가격이 없거나 0이면 TerritoryDataService로 계산
            if (!price || price === 0) {
                try {
                    const countryCode = data.country || 'unknown';
                    // territoryName 정규화 (소문자로 통일)
                    const normalizedName = territoryName ? String(territoryName).toLowerCase().trim() : territoryId.toLowerCase();
                    const territory = {
                        id: territoryId,
                        name: normalizedName,
                        country: countryCode,
                        properties: data.properties || {}
                    };
                    price = territoryDataService.calculateTerritoryPrice(territory, countryCode);
                    console.log(`[AdminDashboard] viewTerritory: Calculated price: ${price}`);
                } catch (error) {
                    console.warn(`[AdminDashboard] Failed to calculate price for ${territoryId}:`, error);
                    price = 0;
                }
            }
            
            // 픽셀 수가 없거나 0이면 TerritoryDataService로 계산 - loadTerritoriesTable과 동일한 로직
            if (!pixelCount || pixelCount === 0) {
                const countryCode = data.country || 'unknown';
                // territoryName 정규화 (소문자로 통일) - loadTerritoriesTable과 동일
                const normalizedName = territoryName ? String(territoryName).toLowerCase().trim() : territoryId.toLowerCase();
                // 캐시 키 생성 (loadTerritoriesTable과 동일한 형식)
                const cacheKey = `${territoryId}_${normalizedName}_${countryCode}`;
                
                if (this.pixelCountCache.has(cacheKey)) {
                    pixelCount = this.pixelCountCache.get(cacheKey);
                    console.log(`[AdminDashboard] viewTerritory: Using cached pixel count: ${pixelCount}`);
                } else {
                    try {
                        // properties 객체를 깊은 복사하여 일관성 보장 (loadTerritoriesTable과 동일)
                        const properties = data.properties ? JSON.parse(JSON.stringify(data.properties)) : {};
                        const territory = {
                            id: territoryId,
                            name: normalizedName,
                            country: countryCode,
                            properties: properties
                        };
                        pixelCount = territoryDataService.calculatePixelCount(territory, countryCode);
                        // 캐시에 저장
                        this.pixelCountCache.set(cacheKey, pixelCount);
                        console.log(`[AdminDashboard] viewTerritory: Calculated pixel count: ${pixelCount} (name: ${normalizedName}, country: ${countryCode})`);
                    } catch (error) {
                        console.warn(`[AdminDashboard] Failed to calculate pixel count for ${territoryId}:`, error);
                        pixelCount = 0;
                    }
                }
            } else {
                console.log(`[AdminDashboard] viewTerritory: Using stored pixel count: ${pixelCount}`);
            }
            
            // 숫자 타입 보장
            price = typeof price === 'number' && !isNaN(price) ? price : 0;
            pixelCount = typeof pixelCount === 'number' && !isNaN(pixelCount) ? pixelCount : 0;
            
            const priceDisplay = price.toLocaleString();
            const pixelCountDisplay = pixelCount.toLocaleString();
            const purchasedByAdmin = data.purchasedByAdmin ? '예' : '아니오';
            const createdAt = data.createdAt?.toDate()?.toLocaleString('ko-KR') || '-';
            const updatedAt = data.updatedAt?.toDate()?.toLocaleString('ko-KR') || '-';
            
            const modalHtml = `
                <div class="modal-overlay" id="territory-modal-overlay" onclick="adminDashboard.closeTerritoryModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 600px;">
                        <div class="modal-header">
                            <h2>🗺️ 영토 상세 정보</h2>
                            <button class="modal-close" onclick="adminDashboard.closeTerritoryModal()">×</button>
                        </div>
                        <div class="modal-body">
                            <div class="info-grid">
                                <div class="info-item">
                                    <label>영토 ID</label>
                                    <span>${territoryId}</span>
                                </div>
                                <div class="info-item">
                                    <label>영토명</label>
                                    <span>${territoryName}</span>
                                </div>
                                <div class="info-item">
                                    <label>국가</label>
                                    <span>${countryName}</span>
                                </div>
                                <div class="info-item">
                                    <label>소유권 상태</label>
                                    <span class="status ${sovereignty === 'ruled' ? 'status-active' : sovereignty === 'protected' ? 'status-info' : 'status-inactive'}">${sovereigntyText}</span>
                                </div>
                                <div class="info-item">
                                    <label>소유자</label>
                                    <span>${rulerName}</span>
                                </div>
                                <div class="info-item">
                                    <label>관리자 구매</label>
                                    <span>${purchasedByAdmin}</span>
                                </div>
                                <div class="info-item">
                                    <label>가격</label>
                                    <span><strong>${priceDisplay} pt</strong></span>
                                </div>
                                <div class="info-item">
                                    <label>픽셀 수</label>
                                    <span>${pixelCountDisplay}</span>
                                </div>
                                ${data.purchasedPrice || data.tribute ? `
                                <div class="info-item">
                                    <label>낙찰가</label>
                                    <span><strong style="color: #4CAF50;">${(data.purchasedPrice || data.tribute).toLocaleString()} pt</strong></span>
                                </div>
                                ` : ''}
                                <div class="info-item">
                                    <label>생성 시간</label>
                                    <span>${createdAt}</span>
                                </div>
                                <div class="info-item">
                                    <label>수정 시간</label>
                                    <span>${updatedAt}</span>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeTerritoryModal()">닫기</button>
                            <button class="btn btn-primary" onclick="adminDashboard.editTerritory('${territoryId}'); adminDashboard.closeTerritoryModal();">가격 수정</button>
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('territory-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            this.logAdminAction('VIEW_TERRITORY', { territoryId });
            
        } catch (error) {
            console.error('Failed to load territory:', error);
            alert(`영토 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closeTerritoryModal() {
        const modal = document.getElementById('territory-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    async editTerritory(territoryId) {
        try {
            // 현재 영토 정보 가져오기
            const doc = await this.db.collection('territories').doc(territoryId).get();
            if (!doc.exists) {
                alert('영토를 찾을 수 없습니다.');
                return;
            }
            
            const data = doc.data();
            const currentPrice = data.price || 0;
            
            const newPriceInput = prompt(
                `영토 가격을 수정하세요.\n\n현재 가격: ${currentPrice.toLocaleString()} pt\n\n새 가격을 입력하세요 (취소하려면 빈칸):`,
                currentPrice.toString()
            );
            
            if (newPriceInput === null || newPriceInput.trim() === '') {
                return; // 취소
            }
            
            const newPrice = parseFloat(newPriceInput);
            if (isNaN(newPrice) || newPrice < 0) {
                alert('올바른 가격을 입력해주세요.');
                return;
            }
            
            // 업데이트
            await this.db.collection('territories').doc(territoryId).update({
                price: newPrice,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedBy: this.currentUser?.email || 'admin'
            });
            
            this.logAdminAction('EDIT_TERRITORY', { territoryId, oldPrice: currentPrice, newPrice });
            
            // 테이블 새로고침
            if (this.currentSection === 'territories') {
                await this.loadTerritoriesTable();
            }
            
            // 통계도 새로고침
            await this.loadStats();
            
            alert(`✅ 영토 가격이 수정되었습니다.\n\n이전: ${currentPrice.toLocaleString()} pt\n변경: ${newPrice.toLocaleString()} pt`);
            
        } catch (error) {
            console.error('Failed to edit territory:', error);
            this.handleFirestoreError(error, '영토 수정');
        }
    }
    
    async viewAuction(auctionId) {
        try {
            const doc = await this.db.collection('auctions').doc(auctionId).get();
            if (!doc.exists) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const data = doc.data();
            const startTime = data.startTime?.toDate()?.toLocaleString('ko-KR') || data.createdAt?.toDate()?.toLocaleString('ko-KR') || '-';
            const endTime = data.endTime?.toDate()?.toLocaleString('ko-KR') || data.endsAt?.toDate()?.toLocaleString('ko-KR') || '-';
            const bids = data.bids || [];
            const bidCount = bids.length || data.bidCount || 0;
            
            // 소유권 이전이 완료된 경우 영토 정보 가져오기
            let territoryInfo = null;
            if (data.territoryId && data.status === 'ended' && data.highestBidder) {
                try {
                    const territoryDoc = await this.db.collection('territories').doc(data.territoryId).get();
                    if (territoryDoc.exists) {
                        const territoryData = territoryDoc.data();
                        // 소유자가 있고 낙찰자와 일치하는 경우
                        if (territoryData.ruler && (territoryData.ruler === data.highestBidder || territoryData.rulerName === data.highestBidderName)) {
                            // 낙찰가 계산: 영토 데이터의 purchasedPrice/tribute 우선, 없으면 옥션의 최고 입찰가
                            let purchasedPrice = territoryData.purchasedPrice || territoryData.tribute;
                            if (!purchasedPrice || purchasedPrice === 0) {
                                // 옥션 데이터에서 최고 입찰가 가져오기
                                if (data.bids && Array.isArray(data.bids) && data.bids.length > 0) {
                                    purchasedPrice = Math.max(...data.bids.map(b => b.amount || b.buffedAmount || 0));
                                } else {
                                    purchasedPrice = data.currentBid || data.startingBid || null;
                                }
                            }
                            
                            // 숫자 타입 보장
                            if (purchasedPrice !== null && purchasedPrice !== undefined) {
                                purchasedPrice = typeof purchasedPrice === 'number' ? purchasedPrice : parseFloat(purchasedPrice) || null;
                            }
                            
                            territoryInfo = {
                                ruler: territoryData.ruler,
                                rulerName: territoryData.rulerName,
                                sovereignty: territoryData.sovereignty,
                                purchasedByAdmin: territoryData.purchasedByAdmin || false,
                                purchasedPrice: purchasedPrice,
                                rulerSince: territoryData.rulerSince?.toDate()?.toLocaleString('ko-KR') || '-',
                                protectionEndsAt: territoryData.protectionEndsAt?.toDate()?.toLocaleString('ko-KR') || '-'
                            };
                        }
                    }
                } catch (error) {
                    console.warn('Failed to load territory info for auction:', error);
                }
            }
            
            // 입찰 기록 포맷팅
            let bidsHtml = '<p class="text-muted">입찰 기록이 없습니다.</p>';
            if (bids.length > 0) {
                bidsHtml = '<table class="bids-table"><thead><tr><th>입찰자</th><th>입찰가</th><th>시간</th></tr></thead><tbody>';
                bids.slice(-10).reverse().forEach(bid => {
                    const bidTime = bid.timestamp?.toDate?.()?.toLocaleString('ko-KR') || bid.time || '-';
                    const bidAmount = bid.amount || bid.buffedAmount || 0;
                    bidsHtml += `<tr>
                        <td>${bid.bidderName || bid.userName || bid.userId || 'Unknown'}</td>
                        <td>${bidAmount.toLocaleString()} pt</td>
                        <td>${bidTime}</td>
                    </tr>`;
                });
                bidsHtml += '</tbody></table>';
            }
            
            const modalHtml = `
                <div class="modal-overlay" id="auction-modal-overlay" onclick="adminDashboard.closeAuctionModal()">
                    <div class="modal-content" onclick="event.stopPropagation()">
                        <div class="modal-header">
                            <h2>💰 옥션 상세 정보</h2>
                            <button class="modal-close" onclick="adminDashboard.closeAuctionModal()">×</button>
                        </div>
                        <div class="modal-body">
                            <div class="info-grid">
                                <div class="info-item">
                                    <label>옥션 ID</label>
                                    <span>${auctionId}</span>
                                </div>
                                <div class="info-item">
                                    <label>영토 ID</label>
                                    <span>${data.territoryId || '-'}</span>
                                </div>
                                <div class="info-item">
                                    <label>영토 이름</label>
                                    <span>${data.territoryName || data.territoryId || '-'}</span>
                                </div>
                                <div class="info-item">
                                    <label>상태</label>
                                    <span class="status ${data.status === 'active' ? 'status-active' : 'status-ended'}">${data.status === 'active' ? '진행중' : '종료됨'}</span>
                                </div>
                                <div class="info-item">
                                    <label>시작 입찰가</label>
                                    <span>${(data.startingBid || data.startingPrice || 0).toLocaleString()} pt</span>
                                </div>
                                <div class="info-item">
                                    <label>현재 입찰가</label>
                                    ${(() => {
                                        // 입찰가 계산: bids 배열의 최고 입찰가 또는 currentBid 사용
                                        let displayBid = data.currentBid || data.startingBid || 0;
                                        
                                        // bids 배열이 있으면 최고 입찰가 확인
                                        if (data.bids && Array.isArray(data.bids) && data.bids.length > 0) {
                                            const highestBid = Math.max(...data.bids.map(b => b.amount || b.buffedAmount || 0));
                                            if (highestBid > 0 && highestBid >= displayBid) {
                                                displayBid = highestBid;
                                            }
                                        }
                                        
                                        return `<span><strong>${displayBid.toLocaleString()} pt</strong></span>`;
                                    })()}
                                </div>
                                <div class="info-item">
                                    <label>최고 입찰자</label>
                                    <span>${data.highestBidderName || data.highestBidder || '없음'}</span>
                                </div>
                                <div class="info-item">
                                    <label>입찰자 수</label>
                                    <span>${bidCount}명</span>
                                </div>
                                <div class="info-item">
                                    <label>시작 시간</label>
                                    <span>${startTime}</span>
                                </div>
                                <div class="info-item">
                                    <label>종료 시간</label>
                                    <span>${endTime}</span>
                                </div>
                                <div class="info-item">
                                    <label>생성자</label>
                                    <span>${data.createdBy || data.createdByEmail || '-'}</span>
                                </div>
                                <div class="info-item">
                                    <label>생성 시간</label>
                                    <span>${data.createdAt?.toDate()?.toLocaleString('ko-KR') || '-'}</span>
                                </div>
                            </div>
                            ${territoryInfo ? `
                            <div class="info-section" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
                                <h3>✅ 소유권 이전 완료</h3>
                                <div class="info-grid">
                                    <div class="info-item">
                                        <label>소유자</label>
                                        <span><strong>${territoryInfo.rulerName || territoryInfo.ruler || '-'}</strong></span>
                                    </div>
                                    <div class="info-item">
                                        <label>소유권 상태</label>
                                        <span class="status ${territoryInfo.sovereignty === 'protected' ? 'status-active' : 'status-ended'}">${territoryInfo.sovereignty === 'protected' ? '보호됨' : territoryInfo.sovereignty === 'ruled' ? '점유됨' : '-'}</span>
                                    </div>
                                    <div class="info-item">
                                        <label>낙찰가</label>
                                        <span><strong>${territoryInfo.purchasedPrice && typeof territoryInfo.purchasedPrice === 'number' ? territoryInfo.purchasedPrice.toLocaleString() + ' pt' : (territoryInfo.purchasedPrice ? String(territoryInfo.purchasedPrice) + ' pt' : '-')}</strong></span>
                                    </div>
                                    <div class="info-item">
                                        <label>관리자 구매</label>
                                        <span>${territoryInfo.purchasedByAdmin ? '예' : '아니오'}</span>
                                    </div>
                                    <div class="info-item">
                                        <label>소유 시작</label>
                                        <span>${territoryInfo.rulerSince}</span>
                                    </div>
                                    <div class="info-item">
                                        <label>보호 종료</label>
                                        <span>${territoryInfo.protectionEndsAt}</span>
                                    </div>
                                </div>
                            </div>
                            ` : ''}
                            <div class="info-section">
                                <h3>입찰 기록 (최근 10개)</h3>
                                ${bidsHtml}
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeAuctionModal()">닫기</button>
                            ${data.status === 'active' ? 
                                `<button class="btn btn-danger" onclick="adminDashboard.endAuction('${auctionId}'); adminDashboard.closeAuctionModal();">옥션 종료</button>` 
                                : ''
                            }
                            ${data.status === 'ended' && data.highestBidder ? 
                                `<button class="btn btn-primary" onclick="adminDashboard.processAuctionOwnership('${auctionId}'); adminDashboard.closeAuctionModal();">✅ 소유권 이전 처리</button>` 
                                : ''
                            }
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('auction-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            this.logAdminAction('VIEW_AUCTION', { auctionId });
            
        } catch (error) {
            console.error('Failed to load auction:', error);
            alert(`옥션 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closeAuctionModal() {
        const modal = document.getElementById('auction-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    async endAuction(auctionId, skipConfirm = false) {
        // 자동 종료인 경우 확인 없이 진행
        if (!skipConfirm && !confirm('정말 이 옥션을 종료하시겠습니까?')) {
            return;
        }
        
        try {
            const reason = skipConfirm ? '만료 시간 초과로 자동 종료됨' : '관리자에 의해 수동 종료됨';
            
            await this.db.collection('auctions').doc(auctionId).update({
                status: 'ended',
                endedAt: firebase.firestore.FieldValue.serverTimestamp(),
                endedBy: this.currentUser?.email || 'admin',
                reason: reason
            });
            
            this.logAdminAction('END_AUCTION', { auctionId, reason });
            
            // 자동 종료인 경우 알림 없이 테이블만 새로고침
            if (skipConfirm) {
                console.log(`[AdminDashboard] Auto-ended auction ${auctionId}`);
            } else {
                alert('옥션이 종료되었습니다.');
            }
            
            // 테이블 새로고침
            await this.loadAuctionsTable();
        } catch (error) {
            console.error('Failed to end auction:', error);
            if (!skipConfirm) {
                this.handleFirestoreError(error, '옥션 종료');
            }
        }
    }
    
    /**
     * 옥션 종료 시간 수정 (고급 모달)
     */
    async editAuctionTime(auctionId) {
        try {
            const doc = await this.db.collection('auctions').doc(auctionId).get();
            if (!doc.exists) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const data = doc.data();
            const currentEndTime = data.endTime?.toDate() || data.endsAt?.toDate();
            
            if (!currentEndTime) {
                alert('현재 종료 시간 정보가 없습니다.');
                return;
            }
            
            // 현재 시간과 남은 시간 계산
            const now = new Date();
            const remainingMs = currentEndTime.getTime() - now.getTime();
            const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
            const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
            const remainingSeconds = Math.floor((remainingMs % (1000 * 60)) / 1000);
            
            // 새 종료 시간을 위한 기본값 (현재 종료 시간)
            const defaultDateTime = currentEndTime.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm 형식
            
            // 옥션 추가 정보 가져오기
            const territoryId = data.territoryId || auctionId;
            const currentBid = (data.currentBid || data.startingBid || 0).toLocaleString();
            const bidCount = (data.bids && Array.isArray(data.bids) ? data.bids.length : 0) || data.bidCount || 0;
            const highestBidder = data.highestBidderName || data.highestBidder || '없음';
            
            const modalHtml = `
                <div class="modal-overlay" id="auction-time-modal-overlay" onclick="adminDashboard.closeAuctionTimeModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 700px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">⏰ 옥션 종료 시간 수정</h2>
                            <button class="modal-close" onclick="adminDashboard.closeAuctionTimeModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 옥션 정보 카드 -->
                            <div style="background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #667eea;">
                                <h3 style="margin-top: 0; margin-bottom: 12px; color: #333;">📋 옥션 정보</h3>
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                    <div>
                                        <strong>영토 ID:</strong> ${territoryId}
                                    </div>
                                    <div>
                                        <strong>현재 입찰가:</strong> ${currentBid} pt
                                    </div>
                                    <div>
                                        <strong>입찰자 수:</strong> ${bidCount}명
                                    </div>
                                    <div>
                                        <strong>최고 입찰자:</strong> ${highestBidder}
                                    </div>
                                </div>
                            </div>
                            
                            <!-- 현재 시간 정보 -->
                            <div class="time-info-section" style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 2px solid #e9ecef;">
                                <h3 style="margin-top: 0; margin-bottom: 12px; color: #495057;">📊 현재 시간 정보</h3>
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                                    <div style="padding: 10px; background: white; border-radius: 6px;">
                                        <div style="font-size: 12px; color: #6c757d; margin-bottom: 5px;">현재 종료 시간</div>
                                        <div style="font-size: 16px; font-weight: bold; color: #212529;">${currentEndTime.toLocaleString('ko-KR')}</div>
                                    </div>
                                    <div style="padding: 10px; background: white; border-radius: 6px;">
                                        <div style="font-size: 12px; color: #6c757d; margin-bottom: 5px;">남은 시간</div>
                                        <div style="font-size: 16px; font-weight: bold; color: ${remainingMs > 0 ? '#28a745' : '#dc3545'};">
                                            ${remainingMs > 0 ? 
                                                `${remainingHours}시간 ${remainingMinutes}분` : 
                                                '<span style="color: #dc3545;">종료됨</span>'
                                            }
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- 시간 수정 섹션 -->
                            <div class="time-edit-section" style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #dee2e6;">
                                <h3 style="margin-top: 0; margin-bottom: 15px; color: #495057;">✏️ 시간 수정 방법 선택</h3>
                                
                                <div class="time-edit-tabs" style="display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 2px solid #dee2e6;">
                                    <button class="time-tab-btn active" data-tab="relative" onclick="adminDashboard.switchTimeEditTab('relative')" style="padding: 12px 24px; border: none; background: #667eea; color: white; cursor: pointer; border-radius: 6px 6px 0 0; font-weight: bold; transition: all 0.3s;">
                                        ⏱️ 상대 시간
                                    </button>
                                    <button class="time-tab-btn" data-tab="absolute" onclick="adminDashboard.switchTimeEditTab('absolute')" style="padding: 12px 24px; border: none; background: #e9ecef; color: #6c757d; cursor: pointer; border-radius: 6px 6px 0 0; font-weight: bold; transition: all 0.3s;">
                                        📅 절대 시간
                                    </button>
                                    <button class="time-tab-btn" data-tab="preset" onclick="adminDashboard.switchTimeEditTab('preset')" style="padding: 12px 24px; border: none; background: #e9ecef; color: #6c757d; cursor: pointer; border-radius: 6px 6px 0 0; font-weight: bold; transition: all 0.3s;">
                                        ⚡ 프리셋
                                    </button>
                                </div>
                                
                                <!-- 상대 시간 모드 -->
                                <div id="time-edit-relative" class="time-edit-content" style="display: block;">
                                    <div class="form-group" style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #495057;">시간 조정</label>
                                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(-168)" style="padding: 10px 15px; background: #dc3545; color: white; border: none; border-radius: 6px; cursor: pointer;">-7일</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(-24)" style="padding: 10px 15px; background: #ffc107; color: #212529; border: none; border-radius: 6px; cursor: pointer;">-24시간</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(-1)" style="padding: 10px 15px; background: #17a2b8; color: white; border: none; border-radius: 6px; cursor: pointer;">-1시간</button>
                                            <input type="number" id="time-adjust-input" value="0" step="0.5" min="-168" max="168" style="width: 120px; padding: 10px; text-align: center; border: 2px solid #dee2e6; border-radius: 6px; font-size: 16px; font-weight: bold;" placeholder="시간">
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(1)" style="padding: 10px 15px; background: #17a2b8; color: white; border: none; border-radius: 6px; cursor: pointer;">+1시간</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(24)" style="padding: 10px 15px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer;">+24시간</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.adjustTime(168)" style="padding: 10px 15px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer;">+7일</button>
                                        </div>
                                        <small style="color: #6c757d; display: block; margin-top: 8px;">양수는 시간 추가, 음수는 시간 감소 (최대 ±7일)</small>
                                    </div>
                                    <div id="preview-relative-time" style="padding: 15px; background: linear-gradient(135deg, #e7f3ff 0%, #c8e6f5 100%); border-radius: 6px; margin-top: 15px; border-left: 4px solid #007bff;">
                                        <div style="font-size: 14px; color: #6c757d; margin-bottom: 5px;">새 종료 시간</div>
                                        <div style="font-size: 18px; font-weight: bold; color: #007bff;" id="preview-relative-text">${currentEndTime.toLocaleString('ko-KR')}</div>
                                        <div style="font-size: 12px; color: #6c757d; margin-top: 5px;" id="preview-relative-diff"></div>
                                    </div>
                                </div>
                                
                                <!-- 절대 시간 모드 -->
                                <div id="time-edit-absolute" class="time-edit-content" style="display: none;">
                                    <div class="form-group" style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #495057;">종료 날짜 및 시간</label>
                                        <input type="datetime-local" id="absolute-time-input" value="${defaultDateTime}" style="width: 100%; padding: 12px; border: 2px solid #dee2e6; border-radius: 6px; font-size: 14px; transition: border-color 0.3s;" onfocus="this.style.borderColor='#667eea'" onblur="this.style.borderColor='#dee2e6'">
                                    </div>
                                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                                        <button class="btn btn-sm" onclick="adminDashboard.setAbsoluteTime('now')" style="padding: 8px 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">지금 종료</button>
                                        <button class="btn btn-sm" onclick="adminDashboard.setAbsoluteTime('tomorrow')" style="padding: 8px 12px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">내일 이 시간</button>
                                    </div>
                                    <div id="preview-absolute-time" style="padding: 15px; background: linear-gradient(135deg, #e7f3ff 0%, #c8e6f5 100%); border-radius: 6px; margin-top: 15px; border-left: 4px solid #007bff;">
                                        <div style="font-size: 14px; color: #6c757d; margin-bottom: 5px;">새 종료 시간</div>
                                        <div style="font-size: 18px; font-weight: bold; color: #007bff;" id="preview-absolute-text">${currentEndTime.toLocaleString('ko-KR')}</div>
                                        <div style="font-size: 12px; color: #6c757d; margin-top: 5px;" id="preview-absolute-diff"></div>
                                    </div>
                                </div>
                                
                                <!-- 프리셋 모드 -->
                                <div id="time-edit-preset" class="time-edit-content" style="display: none;">
                                    <div class="form-group" style="margin-bottom: 15px;">
                                        <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #495057;">빠른 설정</label>
                                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('5min')" style="padding: 12px; background: #dc3545; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">5분 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('15min')" style="padding: 12px; background: #fd7e14; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">15분 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('30min')" style="padding: 12px; background: #ffc107; color: #212529; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">30분 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('1hour')" style="padding: 12px; background: #17a2b8; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">1시간 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('3hours')" style="padding: 12px; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">3시간 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('6hours')" style="padding: 12px; background: #20c997; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">6시간 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('12hours')" style="padding: 12px; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">12시간 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('24hours')" style="padding: 12px; background: #6f42c1; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">24시간 후</button>
                                            <button class="btn btn-sm" onclick="adminDashboard.applyPreset('48hours')" style="padding: 12px; background: #e83e8c; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">48시간 후</button>
                                        </div>
                                    </div>
                                    <div id="preview-preset-time" style="padding: 15px; background: linear-gradient(135deg, #e7f3ff 0%, #c8e6f5 100%); border-radius: 6px; margin-top: 15px; border-left: 4px solid #007bff;">
                                        <div style="font-size: 14px; color: #6c757d; margin-bottom: 5px;">새 종료 시간</div>
                                        <div style="font-size: 18px; font-weight: bold; color: #007bff;" id="preview-preset-text">${currentEndTime.toLocaleString('ko-KR')}</div>
                                        <div style="font-size: 12px; color: #6c757d; margin-top: 5px;" id="preview-preset-diff"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeAuctionTimeModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                            <button class="btn btn-primary" onclick="adminDashboard.saveAuctionTime('${auctionId}')" style="padding: 10px 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">💾 저장</button>
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('auction-time-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // 이벤트 리스너 설정
            const relativeInput = document.getElementById('time-adjust-input');
            const absoluteInput = document.getElementById('absolute-time-input');
            
            if (relativeInput) {
                relativeInput.addEventListener('input', () => {
                    const hours = parseFloat(relativeInput.value) || 0;
                    const newTime = new Date(currentEndTime.getTime() + (hours * 60 * 60 * 1000));
                    const diff = newTime.getTime() - currentEndTime.getTime();
                    const diffHours = Math.floor(diff / (1000 * 60 * 60));
                    const diffMinutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    
                    document.getElementById('preview-relative-text').textContent = newTime.toLocaleString('ko-KR');
                    const diffText = diffHours !== 0 || diffMinutes !== 0 
                        ? `${diffHours > 0 ? '+' : ''}${diffHours}시간 ${diffMinutes > 0 ? diffMinutes + '분' : ''}`
                        : '변경 없음';
                    document.getElementById('preview-relative-diff').textContent = `(${diffText})`;
                });
            }
            
            if (absoluteInput) {
                absoluteInput.addEventListener('change', () => {
                    const newTime = new Date(absoluteInput.value);
                    const diff = newTime.getTime() - currentEndTime.getTime();
                    const diffHours = Math.floor(diff / (1000 * 60 * 60));
                    const diffMinutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    
                    document.getElementById('preview-absolute-text').textContent = newTime.toLocaleString('ko-KR');
                    const diffText = diffHours !== 0 || diffMinutes !== 0 
                        ? `${diffHours > 0 ? '+' : ''}${diffHours}시간 ${diffMinutes > 0 ? diffMinutes + '분' : ''}`
                        : '변경 없음';
                    document.getElementById('preview-absolute-diff').textContent = `(${diffText})`;
                });
            }
            
            // 전역 변수에 현재 종료 시간 저장 (다른 함수에서 사용)
            window._currentAuctionEndTime = currentEndTime;
            window._currentAuctionId = auctionId;
            
        } catch (error) {
            console.error('Failed to load auction time edit modal:', error);
            alert(`옥션 시간 수정 모달을 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    switchTimeEditTab(tab) {
        document.querySelectorAll('.time-tab-btn').forEach(btn => {
            btn.classList.remove('active');
            btn.style.background = '#e9ecef';
            btn.style.color = '#6c757d';
        });
        document.querySelectorAll('.time-edit-content').forEach(content => {
            content.style.display = 'none';
        });
        
        const activeBtn = document.querySelector(`[data-tab="${tab}"]`);
        const activeContent = document.getElementById(`time-edit-${tab}`);
        
        if (activeBtn) {
            activeBtn.classList.add('active');
            activeBtn.style.background = '#667eea';
            activeBtn.style.color = 'white';
        }
        if (activeContent) {
            activeContent.style.display = 'block';
        }
    }
    
    setAbsoluteTime(preset) {
        const input = document.getElementById('absolute-time-input');
        if (!input) return;
        
        const now = new Date();
        let newTime;
        
        switch (preset) {
            case 'now':
                newTime = now;
                break;
            case 'tomorrow':
                newTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                break;
            default:
                return;
        }
        
        // datetime-local 형식으로 변환 (YYYY-MM-DDTHH:mm)
        const year = newTime.getFullYear();
        const month = String(newTime.getMonth() + 1).padStart(2, '0');
        const day = String(newTime.getDate()).padStart(2, '0');
        const hours = String(newTime.getHours()).padStart(2, '0');
        const minutes = String(newTime.getMinutes()).padStart(2, '0');
        const datetimeValue = `${year}-${month}-${day}T${hours}:${minutes}`;
        
        input.value = datetimeValue;
        input.dispatchEvent(new Event('change'));
    }
    
    applyPreset(preset) {
        const currentEndTime = window._currentAuctionEndTime;
        if (!currentEndTime) return;
        
        const now = new Date();
        let newTime;
        let presetName;
        
        switch (preset) {
            case '5min':
                newTime = new Date(now.getTime() + 5 * 60 * 1000);
                presetName = '5분 후';
                break;
            case '15min':
                newTime = new Date(now.getTime() + 15 * 60 * 1000);
                presetName = '15분 후';
                break;
            case '30min':
                newTime = new Date(now.getTime() + 30 * 60 * 1000);
                presetName = '30분 후';
                break;
            case '1hour':
                newTime = new Date(now.getTime() + 60 * 60 * 1000);
                presetName = '1시간 후';
                break;
            case '3hours':
                newTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
                presetName = '3시간 후';
                break;
            case '6hours':
                newTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
                presetName = '6시간 후';
                break;
            case '12hours':
                newTime = new Date(now.getTime() + 12 * 60 * 60 * 1000);
                presetName = '12시간 후';
                break;
            case '24hours':
                newTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                presetName = '24시간 후';
                break;
            case '48hours':
                newTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);
                presetName = '48시간 후';
                break;
            default:
                return;
        }
        
        // 프리셋 모드로 전환
        this.switchTimeEditTab('preset');
        
        // 미리보기 업데이트
        const diff = newTime.getTime() - currentEndTime.getTime();
        const diffHours = Math.floor(diff / (1000 * 60 * 60));
        const diffMinutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        
        document.getElementById('preview-preset-text').textContent = newTime.toLocaleString('ko-KR');
        const diffText = `${diffHours > 0 ? '+' : ''}${diffHours}시간 ${diffMinutes > 0 ? diffMinutes + '분' : ''}`;
        document.getElementById('preview-preset-diff').textContent = `${presetName} (${diffText})`;
        
        // 전역 변수에 저장 (저장 시 사용)
        window._presetNewTime = newTime;
    }
    
    adjustTime(hours) {
        const input = document.getElementById('time-adjust-input');
        if (input) {
            const currentValue = parseFloat(input.value) || 0;
            const newValue = currentValue + hours;
            // -168 ~ +168 범위 제한
            input.value = Math.max(-168, Math.min(168, newValue));
            input.dispatchEvent(new Event('input'));
        }
    }
    
    async saveAuctionTime(auctionId) {
        try {
            const currentEndTime = window._currentAuctionEndTime;
            if (!currentEndTime) {
                alert('오류: 현재 종료 시간 정보를 찾을 수 없습니다.');
                return;
            }
            
            // 활성 탭 확인
            const relativeTab = document.getElementById('time-edit-relative');
            const absoluteTab = document.getElementById('time-edit-absolute');
            const presetTab = document.getElementById('time-edit-preset');
            
            let newEndTime;
            
            if (presetTab && presetTab.style.display !== 'none' && window._presetNewTime) {
                // 프리셋 모드
                newEndTime = window._presetNewTime;
            } else if (relativeTab && relativeTab.style.display !== 'none') {
                // 상대 시간 모드
                const hoursInput = document.getElementById('time-adjust-input');
                const hours = parseFloat(hoursInput?.value) || 0;
                newEndTime = new Date(currentEndTime.getTime() + (hours * 60 * 60 * 1000));
            } else if (absoluteTab && absoluteTab.style.display !== 'none') {
                // 절대 시간 모드
                const absoluteInput = document.getElementById('absolute-time-input');
                if (!absoluteInput || !absoluteInput.value) {
                    alert('날짜와 시간을 입력해주세요.');
                    return;
                }
                newEndTime = new Date(absoluteInput.value);
            } else {
                alert('시간 수정 방법을 선택해주세요.');
                return;
            }
            
            // 유효성 검사
            if (isNaN(newEndTime.getTime())) {
                alert('올바른 날짜/시간을 입력해주세요.');
                return;
            }
            
            const now = new Date();
            if (newEndTime.getTime() <= now.getTime()) {
                if (!confirm('⚠️ 경고: 설정한 시간이 현재 시간보다 이전입니다.\n계속하시겠습니까?')) {
                    return;
                }
            }
            
            // Firestore Timestamp로 변환
            const Timestamp = firebase.firestore.Timestamp;
            const newEndTimestamp = Timestamp.fromDate(newEndTime);
            
            // 업데이트
            await this.db.collection('auctions').doc(auctionId).update({
                endTime: newEndTimestamp,
                endsAt: newEndTimestamp,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedBy: this.currentUser?.email || 'admin',
                timeModifiedBy: 'admin',
                timeModifiedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            this.logAdminAction('EDIT_AUCTION_TIME', { 
                auctionId, 
                oldEndTime: currentEndTime.toISOString(),
                newEndTime: newEndTime.toISOString()
            });
            
            this.closeAuctionTimeModal();
            this.loadAuctionsTable(); // Refresh
            alert(`✅ 옥션 종료 시간이 수정되었습니다.\n\n새 종료 시간: ${newEndTime.toLocaleString('ko-KR')}`);
            
        } catch (error) {
            console.error('Failed to save auction time:', error);
            this.handleFirestoreError(error, '옥션 시간 수정');
        }
    }
    
    closeAuctionTimeModal() {
        const modal = document.getElementById('auction-time-modal-overlay');
        if (modal) {
            modal.remove();
        }
        window._currentAuctionEndTime = null;
        window._currentAuctionId = null;
        window._presetNewTime = null;
    }
    
    /**
     * 종료된 옥션의 소유권 이전 처리
     */
    async processAuctionOwnership(auctionId) {
        try {
            // 옥션 데이터 가져오기
            const auctionDoc = await this.db.collection('auctions').doc(auctionId).get();
            if (!auctionDoc.exists) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const auctionData = auctionDoc.data();
            
            // 이미 종료된 옥션이 아니면 경고
            if (auctionData.status !== 'ended' && auctionData.status !== 'ENDED') {
                alert('이 옥션은 아직 종료되지 않았습니다.');
                return;
            }
            
            // 낙찰자가 없으면 경고
            if (!auctionData.highestBidder) {
                alert('이 옥션에는 낙찰자가 없습니다.');
                return;
            }
            
            const territoryId = auctionData.territoryId;
            const userId = auctionData.highestBidder;
            const userName = auctionData.highestBidderName || userId;
            
            // 입찰가 계산: bids 배열의 최고 입찰가 또는 currentBid 사용
            let tribute = auctionData.currentBid || auctionData.startingBid || 0;
            
            // bids 배열이 있으면 최고 입찰가 확인
            if (auctionData.bids && Array.isArray(auctionData.bids) && auctionData.bids.length > 0) {
                const highestBid = Math.max(...auctionData.bids.map(b => b.amount || b.buffedAmount || 0));
                if (highestBid > 0 && highestBid >= tribute) {
                    tribute = highestBid;
                }
            }
            
            console.log(`[AdminDashboard] Processing ownership for auction ${auctionId}:`, {
                currentBid: auctionData.currentBid,
                startingBid: auctionData.startingBid,
                bidsCount: auctionData.bids?.length || 0,
                highestBidFromArray: auctionData.bids && Array.isArray(auctionData.bids) && auctionData.bids.length > 0
                    ? Math.max(...auctionData.bids.map(b => b.amount || b.buffedAmount || 0))
                    : 0,
                finalTribute: tribute
            });
            
            // 확인
            if (!confirm(`소유권을 이전하시겠습니까?\n\n영토: ${territoryId}\n낙찰자: ${userName}\n입찰가: ${tribute.toLocaleString()} pt`)) {
                return;
            }
            
            // 관리자 모드 확인
            const isAdmin = auctionData.purchasedByAdmin || 
                           (userId && userId.startsWith('admin_')) ||
                           (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
            
            // 영토 데이터 가져오기
            const territoryDoc = await this.db.collection('territories').doc(territoryId).get();
            if (!territoryDoc.exists) {
                alert('영토를 찾을 수 없습니다.');
                return;
            }
            
            const territoryData = territoryDoc.data();
            const Timestamp = firebase.firestore.Timestamp;
            const now = new Date();
            const protectionEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7일 보호
            
            // 영토 상태 업데이트
            await this.db.collection('territories').doc(territoryId).update({
                sovereignty: 'protected', // 구매 직후 보호 상태
                ruler: userId,
                rulerName: userName,
                rulerSince: firebase.firestore.FieldValue.serverTimestamp(),
                protectionEndsAt: Timestamp.fromDate(protectionEndsAt),
                purchasedByAdmin: isAdmin,
                purchasedPrice: tribute, // 낙찰가 저장
                tribute: tribute, // 낙찰가 저장 (호환성)
                currentAuction: null,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            this.logAdminAction('PROCESS_AUCTION_OWNERSHIP', { 
                auctionId, 
                territoryId, 
                userId, 
                userName, 
                tribute 
            });
            
            alert(`✅ 소유권 이전이 완료되었습니다.\n\n영토: ${territoryId}\n소유자: ${userName}\n입찰가: ${tribute.toLocaleString()} pt`);
            
            // 테이블 새로고침
            if (this.currentSection === 'auctions') {
                await this.loadAuctionsTable();
            }
            if (this.currentSection === 'territories') {
                await this.loadTerritoriesTable();
            }
            
        } catch (error) {
            console.error('Failed to process auction ownership:', error);
            alert(`소유권 이전 처리 실패: ${error.message}`);
        }
    }
    
    /**
     * 모든 종료된 옥션의 소유권 이전 자동 처리
     */
    async processAllEndedAuctions() {
        try {
            // 종료된 옥션 중 낙찰자가 있는 것만 가져오기
            const endedAuctionsSnapshot = await this.db.collection('auctions')
                .where('status', '==', 'ended')
                .where('highestBidder', '!=', null)
                .limit(100)
                .get();
            
            if (endedAuctionsSnapshot.empty) {
                alert('처리할 종료된 옥션이 없습니다.');
                return;
            }
            
            const count = endedAuctionsSnapshot.size;
            if (!confirm(`총 ${count}개의 종료된 옥션에 대해 소유권 이전을 처리하시겠습니까?`)) {
                return;
            }
            
            let successCount = 0;
            let failCount = 0;
            const errors = [];
            
            for (const doc of endedAuctionsSnapshot.docs) {
                try {
                    const auctionData = doc.data();
                    const territoryId = auctionData.territoryId;
                    const userId = auctionData.highestBidder;
                    const userName = auctionData.highestBidderName || userId;
                    
                    // 입찰가 계산: bids 배열의 최고 입찰가 또는 currentBid 사용
                    let tribute = auctionData.currentBid || auctionData.startingBid || 0;
                    
                    // bids 배열이 있으면 최고 입찰가 확인
                    if (auctionData.bids && Array.isArray(auctionData.bids) && auctionData.bids.length > 0) {
                        const highestBid = Math.max(...auctionData.bids.map(b => b.amount || b.buffedAmount || 0));
                        if (highestBid > 0 && highestBid >= tribute) {
                            tribute = highestBid;
                        }
                    }
                    
                    // 영토 데이터 확인
                    const territoryDoc = await this.db.collection('territories').doc(territoryId).get();
                    if (!territoryDoc.exists) {
                        errors.push(`${territoryId}: 영토를 찾을 수 없음`);
                        failCount++;
                        continue;
                    }
                    
                    const territoryData = territoryDoc.data();
                    
                    // 이미 소유자가 있고 현재 소유자가 낙찰자와 같으면 스킵
                    if (territoryData.ruler === userId && 
                        (territoryData.sovereignty === 'protected' || territoryData.sovereignty === 'ruled')) {
                        console.log(`[AdminDashboard] Territory ${territoryId} already owned by ${userName}, skipping...`);
                        continue;
                    }
                    
                    // 관리자 모드 확인
                    const isAdmin = auctionData.purchasedByAdmin || 
                                   (userId && userId.startsWith('admin_')) ||
                                   (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminAuth') !== null);
                    
                    const Timestamp = firebase.firestore.Timestamp;
                    const now = new Date();
                    const protectionEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                    
                    // 영토 상태 업데이트
                    await this.db.collection('territories').doc(territoryId).update({
                        sovereignty: 'protected',
                        ruler: userId,
                        rulerName: userName,
                        rulerSince: firebase.firestore.FieldValue.serverTimestamp(),
                        protectionEndsAt: Timestamp.fromDate(protectionEndsAt),
                        purchasedByAdmin: isAdmin,
                        purchasedPrice: tribute, // 낙찰가 저장
                        tribute: tribute, // 낙찰가 저장 (호환성)
                        currentAuction: null,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    
                    successCount++;
                    console.log(`[AdminDashboard] ✅ Processed ownership for ${territoryId} → ${userName}`);
                    
                } catch (error) {
                    const auctionData = doc.data();
                    errors.push(`${auctionData.territoryId || doc.id}: ${error.message}`);
                    failCount++;
                    console.error(`[AdminDashboard] Failed to process auction ${doc.id}:`, error);
                }
            }
            
            // 결과 표시
            let message = `처리 완료!\n\n성공: ${successCount}개\n실패: ${failCount}개`;
            if (errors.length > 0 && errors.length <= 10) {
                message += `\n\n실패 목록:\n${errors.join('\n')}`;
            } else if (errors.length > 10) {
                message += `\n\n실패 목록 (최근 10개):\n${errors.slice(0, 10).join('\n')}\n...외 ${errors.length - 10}개`;
            }
            
            alert(message);
            
            // 테이블 새로고침
            if (this.currentSection === 'auctions') {
                await this.loadAuctionsTable();
            }
            if (this.currentSection === 'territories') {
                await this.loadTerritoriesTable();
            }
            
        } catch (error) {
            console.error('Failed to process all ended auctions:', error);
            alert(`일괄 처리 실패: ${error.message}`);
        }
    }
    
    /**
     * 옥션 삭제
     */
    async deleteAuction(auctionId) {
        try {
            // 옥션 데이터 가져오기
            const auctionDoc = await this.db.collection('auctions').doc(auctionId).get();
            if (!auctionDoc.exists) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const auctionData = auctionDoc.data();
            const territoryId = auctionData.territoryId || auctionId;
            const status = auctionData.status || 'unknown';
            const highestBidder = auctionData.highestBidderName || auctionData.highestBidder || '없음';
            const currentBid = auctionData.currentBid || auctionData.startingBid || 0;
            
            // 삭제 확인 모달 표시
            const modalHtml = `
                <div class="modal-overlay" id="delete-auction-modal-overlay" onclick="adminDashboard.closeDeleteAuctionModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 500px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">🗑️ 옥션 삭제</h2>
                            <button class="modal-close" onclick="adminDashboard.closeDeleteAuctionModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 옥션 정보 -->
                            <div style="background: #fee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e74c3c;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #c0392b; font-size: 16px;">삭제 대상 옥션</h3>
                                <div style="color: #333; font-size: 14px; line-height: 1.8;">
                                    <p style="margin: 5px 0;"><strong>영토:</strong> ${territoryId}</p>
                                    <p style="margin: 5px 0;"><strong>상태:</strong> ${status === 'active' ? '진행중' : status === 'ended' ? '종료됨' : status}</p>
                                    <p style="margin: 5px 0;"><strong>최고 입찰자:</strong> ${highestBidder}</p>
                                    <p style="margin: 5px 0;"><strong>현재 입찰가:</strong> ${currentBid.toLocaleString()} pt</p>
                                </div>
                            </div>
                            
                            <!-- 경고 메시지 -->
                            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #856404; font-size: 16px;">⚠️ 삭제 주의사항</h3>
                                <ul style="margin: 0; padding-left: 20px; color: #856404; line-height: 1.8; font-size: 14px;">
                                    <li>옥션 삭제 시 <strong>모든 입찰 기록이 삭제</strong>됩니다.</li>
                                    ${status === 'active' ? '<li><strong>진행 중인 옥션을 삭제하면 영토가 미점유 상태로 복구</strong>됩니다.</li>' : ''}
                                    ${status === 'ended' && highestBidder !== '없음' ? '<li><strong>종료된 옥션을 삭제해도 영토 소유권은 유지</strong>됩니다.</li>' : ''}
                                    <li>이 작업은 <strong>되돌릴 수 없습니다</strong>.</li>
                                </ul>
                            </div>
                            
                            <!-- 최종 경고 -->
                            <div style="background: #f8d7da; padding: 15px; border-radius: 8px; border: 1px solid #f5c6cb; margin-bottom: 20px;">
                                <p style="margin: 0; color: #721c24; font-size: 14px; font-weight: bold;">⚠️ 정말로 이 옥션을 삭제하시겠습니까?</p>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeDeleteAuctionModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                            <button class="btn btn-danger" onclick="adminDashboard.confirmDeleteAuction('${auctionId}')" style="padding: 10px 30px; background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">🗑️ 삭제 확인</button>
                        </div>
                    </div>
                </div>
            `;
            
            // 기존 모달 제거
            const existingModal = document.getElementById('delete-auction-modal-overlay');
            if (existingModal) {
                existingModal.remove();
            }
            
            // 모달 추가
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
        } catch (error) {
            console.error('Failed to load auction for deletion:', error);
            alert(`옥션 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closeDeleteAuctionModal() {
        const modal = document.getElementById('delete-auction-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 옥션 삭제 확인 및 실행
     */
    async confirmDeleteAuction(auctionId) {
        try {
            // 옥션 데이터 가져오기
            const auctionDoc = await this.db.collection('auctions').doc(auctionId).get();
            if (!auctionDoc.exists) {
                alert('옥션을 찾을 수 없습니다.');
                this.closeDeleteAuctionModal();
                return;
            }
            
            const auctionData = auctionDoc.data();
            const territoryId = auctionData.territoryId;
            const status = auctionData.status;
            
            // 진행 중인 옥션을 삭제하는 경우 영토 상태 복구
            if (status === 'active' && territoryId) {
                try {
                    const territoryDoc = await this.db.collection('territories').doc(territoryId).get();
                    if (territoryDoc.exists) {
                        const territoryData = territoryDoc.data();
                        // 옥션이 있던 영토의 currentAuction을 null로 설정
                        await this.db.collection('territories').doc(territoryId).update({
                            currentAuction: null,
                            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`[AdminDashboard] Cleared currentAuction for territory ${territoryId}`);
                    }
                } catch (territoryError) {
                    console.warn(`[AdminDashboard] Failed to update territory ${territoryId}:`, territoryError);
                    // 영토 업데이트 실패해도 옥션 삭제는 계속 진행
                }
            }
            
            // 옥션 삭제
            await this.db.collection('auctions').doc(auctionId).delete();
            
            this.logAdminAction('DELETE_AUCTION', { 
                auctionId, 
                territoryId, 
                status,
                highestBidder: auctionData.highestBidder,
                currentBid: auctionData.currentBid
            });
            
            this.closeDeleteAuctionModal();
            this.loadAuctionsTable(); // Refresh
            alert('✅ 옥션이 삭제되었습니다.');
            
        } catch (error) {
            console.error('Failed to delete auction:', error);
            this.handleFirestoreError(error, '옥션 삭제');
        }
    }
    
    /**
     * 중복 옥션 자동 정리
     */
    async cleanupDuplicateAuctions() {
        if (!confirm('중복된 활성 옥션을 자동으로 정리하시겠습니까?\n\n각 영토에 대해 가장 최근 옥션만 남기고 나머지는 종료 처리됩니다.')) {
            return;
        }
        
        try {
            const snapshot = await this.db.collection('auctions')
                .where('status', '==', 'active')
                .get();
            
            if (snapshot.empty) {
                alert('정리할 중복 옥션이 없습니다.');
                return;
            }
            
            // territoryId별로 그룹화
            const territoryGroups = {};
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const territoryId = data.territoryId || doc.id;
                if (!territoryGroups[territoryId]) {
                    territoryGroups[territoryId] = [];
                }
                territoryGroups[territoryId].push({ doc, data });
            });
            
            let cleanedCount = 0;
            const batch = this.db.batch();
            const maxBatchSize = 500;
            let batchCount = 0;
            
            for (const [territoryId, auctions] of Object.entries(territoryGroups)) {
                if (auctions.length > 1) {
                    // 생성 시간 기준으로 정렬 (가장 최근 것만 남김)
                    auctions.sort((a, b) => {
                        const aTime = a.data.createdAt?.toDate?.() || new Date(0);
                        const bTime = b.data.createdAt?.toDate?.() || new Date(0);
                        return bTime - aTime; // 내림차순 (최신이 먼저)
                    });
                    
                    // 가장 최근 옥션은 유지, 나머지는 종료 처리
                    for (let i = 1; i < auctions.length; i++) {
                        const auctionRef = auctions[i].doc.ref;
                        batch.update(auctionRef, {
                            status: 'ended',
                            endedAt: firebase.firestore.FieldValue.serverTimestamp(),
                            endedBy: this.currentUser?.email || 'admin',
                            reason: '중복 옥션 자동 정리'
                        });
                        cleanedCount++;
                        batchCount++;
                        
                        // Firestore 배치 제한 (500개) 체크
                        if (batchCount >= maxBatchSize) {
                            await batch.commit();
                            batchCount = 0;
                        }
                    }
                }
            }
            
            // 남은 배치 커밋
            if (batchCount > 0) {
                await batch.commit();
            }
            
            this.logAdminAction('CLEANUP_DUPLICATE_AUCTIONS', { cleanedCount });
            this.loadAuctionsTable(); // Refresh
            alert(`✅ 중복 옥션 정리 완료!\n\n${cleanedCount}개의 중복 옥션이 종료 처리되었습니다.`);
            
        } catch (error) {
            console.error('Failed to cleanup duplicate auctions:', error);
            this.handleFirestoreError(error, '중복 옥션 정리');
        }
    }
    
    /**
     * Firestore 에러 처리
     */
    handleFirestoreError(error, action) {
        if (error.code === 'permission-denied') {
            alert(`⚠️ ${action}에 실패했습니다.\n\nFirestore 권한이 부족합니다.\n\n해결 방법:\n1. Firebase 콘솔에서 Firestore 보안 규칙 수정\n2. 또는 Firebase Auth로 관리자 계정 로그인\n\n(현재: 로컬 세션 인증 사용 중)`);
        } else {
            alert(`${action}에 실패했습니다: ${error.message}`);
        }
    }
    
    // === 로그 & 감사 추적 ===
    
    /**
     * 관리자 활동 로그 기록
     */
    async logAdminAction(action, details = {}) {
        try {
            await this.db.collection('admin_logs').add({
                action,
                details,
                adminEmail: this.currentUser.email,
                adminUid: this.currentUser.uid,
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                userAgent: navigator.userAgent,
                ip: 'client-side' // 서버에서 기록하는 것이 더 좋음
            });
            console.log('Admin action logged:', action);
        } catch (error) {
            console.error('Failed to log admin action:', error);
        }
    }
    
    /**
     * 관리자 로그 조회
     */
    async loadAdminLogs() {
        const container = document.getElementById('admin-logs');
        if (!container) return;
        
        try {
            const snapshot = await this.db.collection('admin_logs')
                .orderBy('timestamp', 'desc')
                .limit(50)
                .get();
            
            if (snapshot.empty) {
                container.innerHTML = '<div class="empty">관리자 로그가 없습니다</div>';
                return;
            }
            
            container.innerHTML = `
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>시간</th>
                            <th>관리자</th>
                            <th>작업</th>
                            <th>상세</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${snapshot.docs.map(doc => {
                            const data = doc.data();
                            const time = data.timestamp?.toDate()?.toLocaleString('ko-KR') || '-';
                            return `
                                <tr>
                                    <td>${time}</td>
                                    <td>${data.adminEmail || '알 수 없음'}</td>
                                    <td><span class="log-action">${data.action}</span></td>
                                    <td><code>${JSON.stringify(data.details)}</code></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        } catch (error) {
            console.error('Failed to load admin logs:', error);
            container.innerHTML = '<div class="error">로그 로딩 실패</div>';
        }
    }
    
    // === 데이터 백업 ===
    
    /**
     * 데이터 백업 (JSON 다운로드)
     */
    async backupData() {
        if (!confirm('모든 데이터의 백업을 다운로드하시겠습니까?')) return;
        
        try {
            const backup = {
                exportedAt: new Date().toISOString(),
                exportedBy: this.currentUser.email,
                data: {}
            };
            
            // 주요 컬렉션 백업
            const collections = ['users', 'territories', 'auctions', 'rankings', 'history'];
            
            for (const collName of collections) {
                const snapshot = await this.db.collection(collName).get();
                backup.data[collName] = {};
                snapshot.forEach(doc => {
                    backup.data[collName][doc.id] = doc.data();
                });
            }
            
            // JSON 파일 다운로드
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `billionaire-map-backup-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            this.logAdminAction('BACKUP_DATA', { collections });
            alert('백업이 성공적으로 다운로드되었습니다!');
            
        } catch (error) {
            console.error('Failed to backup data:', error);
            alert('백업 실패. 콘솔에서 상세 정보를 확인하세요.');
        }
    }
    
    /**
     * 데이터 복원 (JSON 업로드)
     */
    async restoreData() {
        if (!confirm('⚠️ 경고: 기존 데이터가 덮어쓰기 됩니다. 계속하시겠습니까?')) return;
        
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const text = await file.text();
                const backup = JSON.parse(text);
                
                if (!backup.data) {
                    throw new Error('유효하지 않은 백업 파일 형식');
                }
                
                // 각 컬렉션 복원
                for (const [collName, documents] of Object.entries(backup.data)) {
                    const batch = this.db.batch();
                    let count = 0;
                    
                    for (const [docId, docData] of Object.entries(documents)) {
                        batch.set(this.db.collection(collName).doc(docId), docData);
                        count++;
                        
                        // Firestore batch 제한 (500)
                        if (count >= 450) {
                            await batch.commit();
                            count = 0;
                        }
                    }
                    
                    if (count > 0) {
                        await batch.commit();
                    }
                }
                
                this.logAdminAction('RESTORE_DATA', { 
                    originalExport: backup.exportedAt,
                    collections: Object.keys(backup.data)
                });
                
                alert('데이터가 성공적으로 복원되었습니다! 새로고침 중...');
                location.reload();
                
            } catch (error) {
                console.error('Failed to restore data:', error);
                alert('데이터 복원 실패: ' + error.message);
            }
        };
        
        input.click();
    }
    
    /**
     * 관리자 목록 로드
     */
    async loadAdminList() {
        const adminListContainer = document.getElementById('admin-list');
        if (!adminListContainer) return;
        
        try {
            // 실제 사용자 목록에서 관리자 확인
            const actualUsers = new Set();
            try {
                // users 컬렉션에서 사용자 이메일 수집
                const usersSnapshot = await this.db.collection('users').limit(100).get();
                usersSnapshot.docs.forEach(doc => {
                    const data = doc.data();
                    if (data.email) {
                        actualUsers.add(data.email.toLowerCase());
                    }
                });
                
                // territories에서도 사용자 이메일 수집
                const territoriesSnapshot = await this.db.collection('territories')
                    .where('sovereignty', 'in', ['ruled', 'protected'])
                    .limit(100)
                    .get();
                
                territoriesSnapshot.docs.forEach(doc => {
                    const data = doc.data();
                    if (data.rulerName && data.rulerName.includes('@')) {
                        actualUsers.add(data.rulerName.toLowerCase());
                    }
                });
            } catch (error) {
                console.warn('[AdminDashboard] Failed to load actual users for admin list:', error);
            }
            
            // 관리자 목록 표시 (실제 사용자인지 확인)
            const adminList = ADMIN_EMAILS.map(email => {
                const isSuperAdmin = email === 'admin@billionairemap.com';
                const isActualUser = actualUsers.has(email.toLowerCase());
                const userStatus = isActualUser 
                    ? '<span style="color: #28a745; font-size: 11px; margin-left: 5px;">(등록된 사용자)</span>'
                    : '<span style="color: #6c757d; font-size: 11px; margin-left: 5px;">(미등록)</span>';
                
                return `
                    <div class="admin-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; margin-bottom: 8px; background: #f8f9fa; border-radius: 6px;">
                        <div>
                            <span>${email}</span>
                            ${userStatus}
                        </div>
                        <span class="badge ${isSuperAdmin ? 'badge-primary' : 'badge-secondary'}" style="padding: 4px 8px; border-radius: 4px; font-size: 12px;">
                            ${isSuperAdmin ? '최고 관리자' : '관리자'}
                        </span>
                    </div>
                `;
            }).join('');
            
            adminListContainer.innerHTML = adminList || '<div class="empty">관리자 없음</div>';
        } catch (error) {
            console.error('Failed to load admin list:', error);
            adminListContainer.innerHTML = '<div class="error">관리자 목록 로딩 실패</div>';
        }
    }
    
    /**
     * 관리자 추가 모달 표시
     */
    showAddAdminModal() {
        const modalHtml = `
            <div class="modal-overlay" id="add-admin-modal-overlay" onclick="adminDashboard.closeAddAdminModal()">
                <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 500px;">
                    <div class="modal-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                        <h2 style="margin: 0; color: white;">➕ 관리자 추가</h2>
                        <button class="modal-close" onclick="adminDashboard.closeAddAdminModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #495057;">이메일 주소</label>
                            <input type="email" id="new-admin-email" placeholder="admin@example.com" style="width: 100%; padding: 12px; border: 2px solid #dee2e6; border-radius: 6px; font-size: 14px;" required>
                            <small style="color: #6c757d; display: block; margin-top: 5px;">추가할 관리자의 이메일 주소를 입력하세요</small>
                        </div>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #495057;">관리자 ID (선택사항)</label>
                            <input type="text" id="new-admin-id" placeholder="admin_id (이메일 @ 앞부분 자동 추출)" style="width: 100%; padding: 12px; border: 2px solid #dee2e6; border-radius: 6px; font-size: 14px;">
                            <small style="color: #6c757d; display: block; margin-top: 5px;">P키 5번 연타 로그인용 ID (비워두면 이메일에서 자동 추출)</small>
                        </div>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #495057;">비밀번호 (선택사항)</label>
                            <input type="password" id="new-admin-password" placeholder="비밀번호 (P키 로그인용)" style="width: 100%; padding: 12px; border: 2px solid #dee2e6; border-radius: 6px; font-size: 14px;">
                            <small style="color: #6c757d; display: block; margin-top: 5px;">P키 5번 연타 로그인용 비밀번호 (선택사항)</small>
                        </div>
                        <div style="background: #fff3cd; padding: 12px; border-radius: 6px; border-left: 4px solid #ffc107; margin-bottom: 15px;">
                            <strong style="color: #856404;">⚠️ 주의사항</strong>
                            <ul style="margin: 8px 0 0 20px; color: #856404; font-size: 13px;">
                                <li>이메일은 Firebase Auth에 등록되어 있어야 합니다</li>
                                <li>관리자 ID와 비밀번호는 P키 5번 연타 로그인에 사용됩니다</li>
                                <li>추가 후 페이지를 새로고침해야 적용됩니다</li>
                            </ul>
                        </div>
                    </div>
                    <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                        <button class="btn btn-secondary" onclick="adminDashboard.closeAddAdminModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                        <button class="btn btn-primary" onclick="adminDashboard.addAdmin()" style="padding: 10px 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">추가</button>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달 제거
        const existingModal = document.getElementById('add-admin-modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // 이메일 입력 시 ID 자동 추출
        const emailInput = document.getElementById('new-admin-email');
        const idInput = document.getElementById('new-admin-id');
        if (emailInput && idInput) {
            emailInput.addEventListener('input', () => {
                const email = emailInput.value;
                if (email && email.includes('@') && !idInput.value) {
                    idInput.value = email.split('@')[0];
                }
            });
        }
    }
    
    closeAddAdminModal() {
        const modal = document.getElementById('add-admin-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 관리자 추가
     */
    async addAdmin() {
        const emailInput = document.getElementById('new-admin-email');
        const idInput = document.getElementById('new-admin-id');
        const passwordInput = document.getElementById('new-admin-password');
        
        if (!emailInput || !emailInput.value) {
            alert('이메일 주소를 입력해주세요.');
            return;
        }
        
        const email = emailInput.value.trim().toLowerCase();
        const adminId = idInput?.value.trim() || email.split('@')[0];
        const password = passwordInput?.value.trim() || '';
        
        // 이메일 형식 검증
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            alert('올바른 이메일 형식을 입력해주세요.');
            return;
        }
        
        // 이미 관리자인지 확인
        if (ADMIN_EMAILS.includes(email)) {
            alert('이미 등록된 관리자입니다.');
            return;
        }
        
        if (!confirm(`다음 관리자를 추가하시겠습니까?\n\n이메일: ${email}\n관리자 ID: ${adminId}${password ? '\n비밀번호: 설정됨' : ''}\n\n⚠️ 주의: 코드 수정이 필요하며, 페이지 새로고침 후 적용됩니다.`)) {
            return;
        }
        
        try {
            // 관리자 목록에 추가 (실제로는 코드 수정이 필요하지만, 사용자에게 안내)
            alert(`✅ 관리자 추가 정보:\n\n이메일: ${email}\n관리자 ID: ${adminId}${password ? '\n비밀번호: ' + password : ''}\n\n⚠️ 실제 적용을 위해서는:\n1. js/admin.js 파일의 ADMIN_EMAILS 배열에 "${email}" 추가\n2. LOCAL_ADMIN_CREDENTIALS 객체에 "${adminId}": "${password || '비밀번호를_설정하세요'}" 추가\n3. 페이지 새로고침\n\n현재는 임시로 세션에 저장됩니다.`);
            
            // 임시로 세션에 저장 (실제 코드 수정 전까지 사용)
            const tempAdmins = JSON.parse(sessionStorage.getItem('tempAdmins') || '[]');
            tempAdmins.push({
                email: email,
                id: adminId,
                password: password,
                addedAt: new Date().toISOString()
            });
            sessionStorage.setItem('tempAdmins', JSON.stringify(tempAdmins));
            
            this.logAdminAction('ADD_ADMIN', { email, adminId });
            this.closeAddAdminModal();
            this.loadAdminList(); // 목록 새로고침
            
        } catch (error) {
            console.error('Failed to add admin:', error);
            alert(`관리자 추가 실패: ${error.message}`);
        }
    }
}

// 전역 인스턴스
const adminDashboard = new AdminDashboard();
window.adminDashboard = adminDashboard;

// 전역 이벤트 위임: 관리자 추가 버튼 클릭 처리
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-card button.btn-secondary');
    if (btn && btn.textContent.includes('관리자 추가')) {
        e.preventDefault();
        e.stopPropagation();
        // 함수가 존재하는지 확인 후 호출
        if (adminDashboard && adminDashboard.showAddAdminModal && typeof adminDashboard.showAddAdminModal === 'function') {
            adminDashboard.showAddAdminModal();
        } else {
            console.warn('[AdminDashboard] showAddAdminModal function not available');
        }
    }
});

// DOM 로드 후 초기화
document.addEventListener('DOMContentLoaded', () => {
    adminDashboard.init();
});

export default adminDashboard;

