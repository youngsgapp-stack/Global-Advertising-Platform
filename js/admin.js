/**
 * Admin Dashboard - 관리자 대시보드
 * 사용자, 영토, 옥션 관리 및 분석
 */

import { CONFIG } from './config.js';
import { territoryDataService } from './services/TerritoryDataService.js';
import { apiService } from './services/ApiService.js';
import { firebaseService } from './services/FirebaseService.js';

// Firebase 설정
const firebaseConfig = CONFIG.FIREBASE;

/**
 * 관리자 이메일 목록 (Firebase Auth 사용 시)
 * 
 * 현재 등록된 관리자 계정:
 * 1. admin@billionairemap.com - 최고 관리자 (모든 권한)
 * 2. young91@naver.com - 일반 관리자
 * 3. q886654@naver.com - 일반 관리자 (Firebase Auth 등록 계정)
 * 4. etgbajy@gmail.com - 일반 관리자 (Firebase Auth 등록 계정)
 * 
 * 관리자 추가/삭제 방법:
 * - 이 배열에 이메일을 추가/제거하면 관리자 권한이 부여/제거됩니다
 * - 변경 후 페이지를 새로고침해야 적용됩니다
 * - Firebase Auth에 해당 이메일이 등록되어 있어야 로그인이 가능합니다
 */
const ADMIN_EMAILS = [
    'admin@billionairemap.com',  // 최고 관리자
    'young91@naver.com',         // 일반 관리자
    'q886654@naver.com',         // 일반 관리자 (Firebase Auth 등록 계정)
    'etgbajy@gmail.com',         // 일반 관리자 (Firebase Auth 등록 계정)
];

/**
 * 서버 데이터의 문자열을 HTML 이스케이프
 * 관리자 화면은 닉네임/이메일 등 사용자 입력을 innerHTML 템플릿으로 그리므로, 조회 결과를 미리 이스케이프해 저장형 XSS를 막음
 */
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeDeep(data) {
    if (typeof data === 'string') return escapeHtml(data);
    if (Array.isArray(data)) return data.map(escapeDeep);
    if (data && typeof data === 'object' && !(data instanceof Date)) {
        const out = {};
        for (const [key, value] of Object.entries(data)) {
            out[key] = escapeDeep(value);
        }
        return out;
    }
    return data;
}

const adminApi = {
    get: async (endpoint, params = null) => {
        const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
        const query = entries.length ? `${endpoint.includes('?') ? '&' : '?'}${new URLSearchParams(entries)}` : '';
        return escapeDeep(await apiService.get(endpoint + query));
    }
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
            // ✅ 단일 Firebase 인스턴스 사용: firebaseService.auth 사용
            // 별도 Firebase 인스턴스 초기화 제거 (조언에 따라 단일 인스턴스로 통일)
            await firebaseService.initialize();
            this.auth = firebaseService.auth;
            this.firebase = firebaseService.app;
            // ⚠️ 마이그레이션 완료: Firestore 비활성화 (PostgreSQL + Redis 사용)
            this.db = null; // Firestore 비활성화
            console.warn('[AdminDashboard] ⚠️ Firestore가 비활성화되었습니다. 백엔드 API를 사용하세요.');
            console.log('[AdminDashboard] ✅ Using single Firebase instance from firebaseService');
            
            // ✅ 전역 firebase 변수 설정 (기존 코드 호환성을 위해)
            // admin.js에서 firebase.firestore를 직접 사용하는 부분이 있으므로 전역 변수로 설정
            if (typeof window !== 'undefined' && window.firebaseCompat) {
                // window.firebaseCompat를 전역 firebase 변수로 사용
                // admin.js 내에서 firebase 변수를 사용할 수 있도록 설정
                const firebase = window.firebaseCompat;
                // this.firebase를 통해 접근 가능하도록 설정
                if (!this.firebase) {
                    this.firebase = firebase;
                }
            }
            
            // 관리자 인증은 Firebase Auth(관리자 이메일)로만 처리
            // ✅ 단일 인스턴스 사용: firebaseService.auth.onAuthStateChanged는 이미 설정되어 있음
            // 하지만 관리자 대시보드 전용 로직을 위해 추가 리스너 설정
            this.isLocalAuth = false;
            
            // ✅ Firebase SDK가 로드되지 않은 경우 처리
            if (!this.auth) {
                console.warn('[AdminDashboard] ⚠️ Firebase Auth not available. Showing login screen.');
                this.showLoginScreen();
                this.setupEventListeners();
                console.log('Admin Dashboard initialized (offline mode)');
                return;
            }
            
            // Firebase Auth 상태 감시 설정
            this.auth.onAuthStateChanged((user) => {
                this.handleAuthChange(user);
            });
            
            // 초기 인증 상태 확인 (onAuthStateChanged가 즉시 트리거되지 않을 수 있음)
            const currentUser = this.auth.currentUser;
            if (currentUser) {
                // 이미 로그인된 사용자가 있으면 즉시 처리
                this.handleAuthChange(currentUser);
            } else {
                // 로그인되지 않은 경우 로그인 화면 표시
                this.showLoginScreen();
            }
            
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
     * ⚠️ Firestore 비활성화로 인해 더 이상 사용되지 않음
     */
    async signInAnonymouslyForFirestore() {
        try {
            // 이미 로그인된 경우 스킵
            if (this.auth && this.auth.currentUser) {
                console.log('Already signed in to Firebase');
                return;
            }
            
            // 익명 로그인 시도 (Firestore 비활성화로 인해 실제로는 사용되지 않음)
            if (this.auth) {
                await this.auth.signInAnonymously();
                console.log('Signed in anonymously for Firestore access');
            }
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
     * 사용자 모드 전환용 세션 정보 확인 (인증 수단 아님, 실제 권한은 Firebase 토큰으로 서버가 검증)
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
            
            if (!parsed.email || !ADMIN_EMAILS.includes(parsed.email)) {
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
                // ✅ 단일 Firebase 인스턴스 사용: firebaseService.currentUser는 이미 동기화됨
                // firebaseService.auth.onAuthStateChanged가 이미 설정되어 있으므로
                // 별도 동기화 불필요 (단일 인스턴스이므로 자동으로 동기화됨)
                console.log('[AdminDashboard] ✅ Admin user authenticated:', user.email);
                this.showDashboard();
                
                // ✅ 토큰이 준비될 시간을 주기 위해 약간의 지연 후 데이터 로드
                // getIdToken()이 비동기로 실행되므로 약간의 지연이 필요할 수 있음
                setTimeout(async () => {
                    try {
                        // 토큰이 준비되었는지 확인
                        if (firebaseService.auth && firebaseService.auth.currentUser) {
                            const token = await firebaseService.auth.currentUser.getIdToken(false);
                            console.log('[AdminDashboard] ✅ Token ready, loading dashboard data...', {
                                tokenLength: token.length,
                                userEmail: user.email
                            });
                            await this.loadDashboardData();
                        } else {
                            console.warn('[AdminDashboard] ⚠️ User not available after delay, retrying...');
                            // 재시도
                            setTimeout(() => this.loadDashboardData(), 500);
                        }
                    } catch (error) {
                        console.error('[AdminDashboard] ❌ Failed to get token for dashboard load:', error);
                        // 토큰 가져오기 실패해도 데이터 로드 시도 (토큰은 API 호출 시 다시 가져옴)
                        await this.loadDashboardData();
                    }
                }, 300);
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
            
            // 옥션 / 결제 필터 버튼
            document.querySelectorAll('#section-auctions .filter-btn, #section-payments .filter-btn, #section-reports .filter-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const parent = e.target.closest('.filter-buttons');
                    if (!parent) return;
                    
                    parent.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    
                    const filter = e.target.getAttribute('data-filter');
                    if (e.target.closest('#section-payments')) {
                        this.loadPaymentsTable();
                    } else if (e.target.closest('#section-reports')) {
                        this.loadReportsTable();
                    } else if (filter) {
                        this.loadAuctionsTable(filter);
                    }
                });
            });
            
            // 사용자 / 결제 검색 (입력 멈춘 뒤 0.4초 후 조회)
            const debounce = (fn) => {
                let timer = null;
                return () => {
                    clearTimeout(timer);
                    timer = setTimeout(fn, 400);
                };
            };
            document.getElementById('user-search')?.addEventListener('input', debounce(() => this.loadUsersTable()));
            document.getElementById('payment-search')?.addEventListener('input', debounce(() => this.loadPaymentsTable()));
            
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
            
            // ✅ Firebase Auth가 없는 경우 처리
            if (!this.auth) {
                errorEl.textContent = 'Firebase SDK가 로드되지 않았습니다. 페이지를 새로고침해주세요.';
                errorEl.classList.remove('hidden');
                return;
            }
            
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
            'payments': '결제 내역',
            'reports': '신고 처리',
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
            
            this.loadRevenueSummary();
            
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
     * 매출 요약 (KPI + 일별 차트)
     */
    async loadRevenueSummary() {
        const kpiEl = document.getElementById('revenue-kpis');
        const canvas = document.getElementById('revenue-daily-chart');
        if (!kpiEl || !canvas) return;
        const days = parseInt(document.getElementById('revenue-days')?.value, 10) || 30;
        
        try {
            const data = await adminApi.get('/admin/revenue-summary', { days });
            const t = data.totals || {};
            const pct = (v) => `${((v || 0) * 100).toFixed(1)}%`;
            const kpis = [
                { label: `최근 ${days}일 결제액`, value: `$${(t.periodUsd || 0).toLocaleString()}` },
                { label: `최근 ${days}일 신규 가입`, value: (t.newUsers || 0).toLocaleString() },
                { label: '가입 → 첫 충전', value: pct(t.payConversion), sub: `${t.payingUsers}/${t.users}명` },
                { label: '가입 → 첫 땅 구매', value: pct(t.buyConversion), sub: `${t.buyers}/${t.users}명` },
                { label: '주인 있는 땅', value: (t.ownedTerritories || 0).toLocaleString() },
                { label: '누적 충전 포인트', value: `${(t.chargedPtTotal || 0).toLocaleString()} pt` }
            ];
            const s = data.storage;
            if (s) {
                const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
                const usedPct = s.dbLimitBytes ? Math.round((s.dbBytes / s.dbLimitBytes) * 100) : 0;
                const warn = usedPct >= 70 ? ' ⚠️' : '';
                kpis.push(
                    { label: `HD 사진 (${s.hdStorage === 'firebase' ? 'Firebase' : 'DB'} 저장)`, value: `${s.hdCount.toLocaleString()}장`, sub: s.hdStorage === 'firebase' ? 'Firebase 사용 중' : `${mb(s.hdDbBytes)}MB` },
                    { label: 'DB 사용량 (무료 한도 기준)', value: `${usedPct}%${warn}`, sub: `${mb(s.dbBytes)} / ${mb(s.dbLimitBytes)}MB` }
                );
            }
            kpiEl.innerHTML = kpis.map(k => `
                <div class="stat-card"><div class="stat-info">
                    <span class="stat-value">${k.value}</span>
                    <span class="stat-label">${k.label}${k.sub ? ` <small style="opacity:0.7">(${k.sub})</small>` : ''}</span>
                </div></div>
            `).join('') + (data.paymentsAvailable ? '' : '<p style="grid-column:1/-1;color:#888;font-size:12px;margin:0;">결제액($)은 결제 기록 기능 배포 이후부터 집계됩니다.</p>');
            
            if (typeof Chart === 'undefined') return;
            const daily = data.daily || [];
            this.revenueDailyChart?.destroy();
            this.revenueDailyChart = new Chart(canvas.getContext('2d'), {
                data: {
                    labels: daily.map(d => d.day.slice(5)),
                    datasets: [
                        { type: 'bar', label: '결제액 ($)', data: daily.map(d => d.usd), backgroundColor: 'rgba(78, 205, 196, 0.6)', yAxisID: 'usd' },
                        { type: 'line', label: '사용 포인트 (pt)', data: daily.map(d => d.spentPt), borderColor: '#f39c12', tension: 0.2, yAxisID: 'pt' },
                        { type: 'line', label: '신규 가입', data: daily.map(d => d.signups), borderColor: '#9b59b6', tension: 0.2, yAxisID: 'count' }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        usd: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: '$' } },
                        pt: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'pt' } },
                        count: { type: 'linear', display: false, beginAtZero: true }
                    }
                }
            });
        } catch (error) {
            console.error('[AdminDashboard] Failed to load revenue summary:', error);
            kpiEl.innerHTML = `<div class="error">매출 요약을 불러오지 못했습니다: ${escapeHtml(error.message || '')}</div>`;
        }
    }
    
    /**
     * 통계 로드
     */
    async loadStats() {
        try {
            // ✅ 마이그레이션 완료: 백엔드 API 사용
            const stats = await adminApi.get('/admin/stats');
            
            if (stats) {
                // 요소가 존재하는지 확인한 후에만 업데이트
                const setStatValue = (id, value) => {
                    const element = document.getElementById(id);
                    if (element) {
                        element.textContent = value;
                    } else {
                        console.warn(`[AdminDashboard] Stat element not found: ${id}`);
                    }
                };
                
                setStatValue('stat-users', stats.users || 0);
                setStatValue('stat-territories', stats.territories || 0);
                setStatValue('stat-ruled', stats.ruled || 0);
                setStatValue('stat-protected', stats.protected || 0);
                setStatValue('stat-revenue', (stats.revenue || 0).toLocaleString() + ' pt');
                setStatValue('stat-active', stats.activeAuctions || 0);
                
                console.log('[AdminDashboard] ✅ Stats loaded from API:', stats);
            } else {
                throw new Error('Stats data is null');
            }
            
            /* 원래 코드 (비활성화됨)
            // 사용자 수
            const usersSnapshot = await this.db.collection('users').get();
            document.getElementById('stat-users').textContent = usersSnapshot.size;
            
            // ⚡ 최적화: 영토 수를 쿼리로 직접 가져오기 (모든 문서 로드 불필요)
            // ruled와 protected 영토를 각각 쿼리
            const [ruledSnapshot, protectedSnapshot] = await Promise.all([
                this.db.collection('territories').where('sovereignty', '==', 'ruled').get(),
                this.db.collection('territories').where('sovereignty', '==', 'protected').get()
            ]);
            
            // ⚡ 최적화: 이미 쿼리 결과에서 개수를 알 수 있음
            const ruledCount = ruledSnapshot.size;
            const protectedCount = protectedSnapshot.size;
            const totalTerritories = ruledCount + protectedCount;
            
            // ⚡ 최적화: 수익 계산은 샘플링된 데이터로 대략 계산 (정확한 수익은 별도 집계 필요)
            let totalRevenue = 0;
            // 샘플로 최대 100개만 확인 (성능 최적화)
            const sampleDocs = [...ruledSnapshot.docs.slice(0, 50), ...protectedSnapshot.docs.slice(0, 50)];
            sampleDocs.forEach(doc => {
                const data = doc.data();
                totalRevenue += data.purchasedPrice || data.tribute || data.price || 0;
            });
            // 샘플링된 평균으로 전체 수익 추정 (대략치)
            if (sampleDocs.length > 0 && totalTerritories > sampleDocs.length) {
                const avgRevenue = totalRevenue / sampleDocs.length;
                totalRevenue = Math.round(avgRevenue * totalTerritories);
            }
            document.getElementById('stat-territories').textContent = totalTerritories;
            document.getElementById('stat-revenue').textContent = totalRevenue.toLocaleString() + ' pt';
            
            // 디버깅 로그
            if (totalTerritories > 0) {
                console.log(`[AdminDashboard] Loaded stats: ${ruledCount} ruled, ${protectedCount} protected, total: ${totalTerritories}`);
            }
            
            /* 원래 코드 (비활성화됨)
            // 활성 옥션
            const auctionsSnapshot = await this.db.collection('auctions')
                .where('status', '==', 'active').get();
            document.getElementById('stat-active').textContent = auctionsSnapshot.size;
            */
            
        } catch (error) {
            console.error('Failed to load stats:', error);
            // 기본값 표시 (요소가 존재하는지 확인)
            const setStatValue = (id, value) => {
                const element = document.getElementById(id);
                if (element) {
                    element.textContent = value;
                }
            };
            
            setStatValue('stat-users', '0');
            setStatValue('stat-territories', '0');
            setStatValue('stat-ruled', '0');
            setStatValue('stat-protected', '0');
            setStatValue('stat-revenue', '0 pt');
            setStatValue('stat-active', '0');
        }
    }
    
    /**
     * 최근 활동 로드
     */
    async loadRecentActivity() {
        const container = document.getElementById('recent-activity');
        if (!container) return;
        
        try {
            // ✅ 백엔드 API 사용
            const activities = await adminApi.get('/admin/activity?limit=20');
            
            if (!activities || activities.length === 0) {
                container.innerHTML = '<div class="empty">최근 활동이 없습니다</div>';
                return;
            }
            
            container.innerHTML = activities.map(activity => {
                const time = activity.timestamp ? new Date(activity.timestamp).toLocaleString('ko-KR') : '-';
                const timeAgo = activity.timestamp ? this.getTimeAgo(new Date(activity.timestamp)) : '-';
                
                return `
                    <div class="activity-item" style="display: flex; align-items: flex-start; gap: 12px; padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                        <div style="font-size: 24px; flex-shrink: 0;">${activity.icon || '📌'}</div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-weight: 600; color: ${activity.color || '#fff'}; margin-bottom: 4px; font-size: 14px;">
                                ${activity.title || '활동'}
                            </div>
                            <div style="color: rgba(255,255,255,0.7); font-size: 13px; margin-bottom: 4px; line-height: 1.4;">
                                ${activity.description || ''}
                            </div>
                            <div style="color: rgba(255,255,255,0.5); font-size: 11px;">
                                ${timeAgo}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load activity:', error);
            container.innerHTML = '<div class="empty">활동 로딩 실패</div>';
        }
    }
    
    /**
     * 시간 경과 표시 (예: "5분 전", "2시간 전")
     */
    getTimeAgo(date) {
        const now = new Date();
        const diff = now - date;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days}일 전`;
        } else if (hours > 0) {
            return `${hours}시간 전`;
        } else if (minutes > 0) {
            return `${minutes}분 전`;
        } else {
            return '방금 전';
        }
    }
    
    /**
     * 상위 사용자 로드
     */
    async loadTopUsers() {
        const container = document.getElementById('top-users');
        
        try {
            // ✅ 마이그레이션 완료: 백엔드 API 사용
            const response = await adminApi.get('/rankings?limit=5');
            
            // 백엔드 API는 { type, rankings } 형태로 반환
            const rankings = response.rankings || response || [];
            
            if (!rankings || rankings.length === 0) {
                container.innerHTML = '<div class="empty">랭킹 데이터가 없습니다</div>';
                return;
            }
            
            container.innerHTML = rankings.map((user, index) => {
                const rank = index + 1;
                const score = user.territory_count || 0;
                return `
                    <div class="activity-item">
                        <span class="activity-icon">${rank === 1 ? '👑' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏆'}</span>
                        <span class="activity-text">${user.nickname || user.email || 'Unknown'} - ${score}개 영토</span>
                        <span class="activity-time">${rank}위</span>
                    </div>
                `;
            }).join('');
            
            /* 원래 Firestore 코드 (비활성화됨)
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
            */
            
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
            case 'payments':
                await this.loadPaymentsTable();
                break;
            case 'reports':
                await this.loadReportsTable();
                break;
            case 'territories':
                this.loadBillboards();
                await this.loadTerritoriesTable();
                break;
            case 'auctions':
                await this.loadAuctionsTable();
                break;
            case 'analytics':
                await this.loadAnalytics();
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
    async loadUsersTable({ append = false } = {}) {
        const tbody = document.querySelector('#users-table tbody');
        const moreBtn = document.getElementById('users-load-more');
        if (!tbody) return;
        
        const pageSize = 50;
        if (!append) {
            this.usersOffset = 0;
            tbody.innerHTML = '<tr><td colspan="6" class="loading">사용자 데이터 로딩 중...</td></tr>';
        }
        const search = document.getElementById('user-search')?.value.trim() || '';
        const requestId = (this.usersRequestId = (this.usersRequestId || 0) + 1);
        
        try {
            const users = await adminApi.get('/admin/users', { limit: pageSize, offset: this.usersOffset, search });
            if (requestId !== this.usersRequestId) return;
            const userList = Array.isArray(users) ? users : [];
            
            if (!append && userList.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="empty">${search ? '검색 결과가 없습니다' : '사용자가 없습니다'}</td></tr>`;
                if (moreBtn) moreBtn.style.display = 'none';
                return;
            }
            
            const rows = userList.map(user => {
                const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleDateString('ko-KR') : '-';
                const isAdmin = ADMIN_EMAILS.includes((user.email || '').toLowerCase());
                const adminBadge = isAdmin ? '<span class="badge badge-warning" style="margin-left: 5px;">관리자</span>' : '';
                return `
                    <tr>
                        <td>${user.nickname || '-'}${adminBadge}</td>
                        <td>${user.email || '-'}</td>
                        <td>${user.territoryCount || 0}</td>
                        <td>${(user.balance || 0).toLocaleString()} pt</td>
                        <td>${createdAt}</td>
                        <td style="white-space: nowrap;">
                            <button class="btn btn-sm" onclick="adminDashboard.viewUser('${user.id}')">보기</button>
                            <button class="btn btn-sm btn-primary" onclick="adminDashboard.addPoints('${user.id}')" style="margin-left: 4px;">💰 포인트</button>
                            <button class="btn btn-sm btn-danger" onclick="adminDashboard.showBanModal('${user.id}')" style="margin-left: 4px;">삭제</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            if (append) {
                tbody.insertAdjacentHTML('beforeend', rows);
            } else {
                tbody.innerHTML = rows;
            }
            this.usersOffset += userList.length;
            if (moreBtn) moreBtn.style.display = userList.length === pageSize ? 'inline-block' : 'none';
        } catch (error) {
            console.error('[AdminDashboard] Failed to load users:', error);
            tbody.innerHTML = `<tr><td colspan="6" class="error">사용자 로딩 실패: ${escapeHtml(error.message || '')}</td></tr>`;
        }
    }
    
    /**
     * 결제 내역 (PayPal) 로드
     */
    async loadPaymentsTable() {
        const tbody = document.querySelector('#payments-table tbody');
        const summaryEl = document.getElementById('payments-summary');
        if (!tbody) return;
        
        const status = document.querySelector('#section-payments .filter-btn.active')?.dataset.filter || '';
        const search = document.getElementById('payment-search')?.value.trim() || '';
        const requestId = (this.paymentsRequestId = (this.paymentsRequestId || 0) + 1);
        tbody.innerHTML = '<tr><td colspan="7" class="loading">결제 내역 로딩 중...</td></tr>';
        
        try {
            const data = await adminApi.get('/admin/payments', { limit: 100, status: status === 'all' ? '' : status, search });
            if (requestId !== this.paymentsRequestId) return;
            const payments = data?.payments || [];
            const s = data?.summary || {};
            
            if (summaryEl) {
                summaryEl.innerHTML = `
                    <div class="stat-card"><div class="stat-info"><span class="stat-value">$${(s.revenueUsd || 0).toLocaleString()}</span><span class="stat-label">결제 완료 금액</span></div></div>
                    <div class="stat-card"><div class="stat-info"><span class="stat-value">${s.credited || 0}</span><span class="stat-label">충전 완료</span></div></div>
                    <div class="stat-card"><div class="stat-info"><span class="stat-value" style="color:#e74c3c">${s.creditFailed || 0}</span><span class="stat-label">결제됐는데 포인트 미지급</span></div></div>
                    <div class="stat-card"><div class="stat-info"><span class="stat-value">${s.failed || 0}</span><span class="stat-label">결제 실패/거절</span></div></div>
                `;
            }
            
            if (payments.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty">결제 내역이 없습니다</td></tr>';
                return;
            }
            
            const statusLabels = {
                credited: '<span class="badge badge-success">충전 완료</span>',
                credit_failed: '<span class="badge badge-danger">포인트 미지급</span>',
                failed: '<span class="badge badge-secondary">결제 실패</span>',
                rejected: '<span class="badge badge-warning">금액/통화 거절</span>',
                refunded: '<span class="badge badge-warning">PayPal 환불됨</span>',
                reversed: '<span class="badge badge-danger">지불 거절(차지백)</span>'
            };
            
            tbody.innerHTML = payments.map(p => {
                const time = p.createdAt ? new Date(p.createdAt).toLocaleString('ko-KR') : '-';
                const amount = p.amountUsd !== null && p.amountUsd !== undefined ? `$${p.amountUsd.toLocaleString()}` : '-';
                let action = p.userId ? `<button class="btn btn-sm" onclick="adminDashboard.viewUser('${p.userId}')">사용자</button>` : '';
                if (p.status === 'credit_failed' && p.userId) {
                    action = `<button class="btn btn-sm btn-primary" onclick="adminDashboard.addPoints('${p.userId}', ${p.points || 0}, 'PayPal ${p.orderId} 미지급분 수동 지급')">포인트 지급</button>`;
                } else if ((p.status === 'refunded' || p.status === 'reversed') && p.userId) {
                    action = `<button class="btn btn-sm btn-danger" onclick="adminDashboard.addPoints('${p.userId}', ${p.points || 0}, 'PayPal ${p.orderId} 환불분 회수 (차감 선택)')">포인트 회수</button>`;
                }
                return `
                    <tr>
                        <td>${time}</td>
                        <td>${p.nickname || p.email || '-'}<br><small style="color:#888">${p.email || ''}</small></td>
                        <td>${amount}</td>
                        <td>${p.points ? p.points.toLocaleString() + ' pt' : '-'}</td>
                        <td>${statusLabels[p.status] || p.status}</td>
                        <td><code style="font-size:11px">${p.orderId}</code>${p.error ? `<br><small style="color:#c0392b">${p.error}</small>` : ''}</td>
                        <td>${action}</td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error('[AdminDashboard] Failed to load payments:', error);
            tbody.innerHTML = `<tr><td colspan="7" class="error">결제 내역 로딩 실패: ${escapeHtml(error.message || '')}</td></tr>`;
        }
    }
    
    /**
     * 광고판 목록 / 지정·해제
     */
    async loadBillboards() {
        const el = document.getElementById('billboard-list');
        if (!el) return;
        try {
            const list = await adminApi.get('/admin/billboards');
            el.innerHTML = !Array.isArray(list) || list.length === 0
                ? '<p style="color:#888;font-size:13px;margin:0;">지정된 광고판이 없습니다.</p>'
                : `<table class="data-table" style="font-size:13px;"><thead><tr><th>영토</th><th>주당 가격</th><th>이번 주</th><th>남은 예약</th><th>누적 예약 매출</th></tr></thead><tbody>
                    ${list.map(b => `<tr>
                        <td>${b.name || b.id}<br><small style="color:#888">${b.id}</small></td>
                        <td>${b.weeklyPrice.toLocaleString()} pt</td>
                        <td>${b.currentBooker || '-'}</td>
                        <td>${b.upcomingWeeks}주</td>
                        <td>${b.revenuePt.toLocaleString()} pt</td>
                    </tr>`).join('')}
                  </tbody></table>`;
        } catch (error) {
            el.innerHTML = `<p class="error">광고판 목록 로딩 실패: ${escapeHtml(error.message || '')}</p>`;
        }
    }
    
    async setBillboard(enabled) {
        const input = document.getElementById('billboard-territory-id');
        const territoryId = input?.value.trim().toLowerCase();
        if (!territoryId) {
            alert('영토 ID를 입력해주세요.');
            return;
        }
        if (!confirm(`${territoryId}을(를) 광고판${enabled ? '으로 지정' : '에서 해제'}하시겠습니까?`)) return;
        try {
            await apiService.post(`/admin/territories/${encodeURIComponent(territoryId)}/billboard`, { enabled });
            alert(`✅ ${territoryId} 광고판 ${enabled ? '지정' : '해제'} 완료`);
            if (input) input.value = '';
            this.loadBillboards();
        } catch (error) {
            alert(`❌ ${error.message || '실패'}`);
        }
    }
    
    /**
     * 가격 일괄 조정 모달
     */
    showBulkPriceModal() {
        document.getElementById('bulk-price-modal-overlay')?.remove();
        const input = 'width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;';
        document.body.insertAdjacentHTML('beforeend', `
            <div class="modal-overlay" id="bulk-price-modal-overlay" onclick="if (event.target === this) this.remove()">
                <div class="modal-content" style="max-width: 560px;">
                    <div class="modal-header" style="background: linear-gradient(135deg, #0984e3 0%, #6c5ce7 100%); color: white; padding: 18px 20px; border-radius: 8px 8px 0 0;">
                        <h2 style="margin: 0; color: white;">💲 가격 일괄 조정 (주당 기준가)</h2>
                    </div>
                    <div class="modal-body" style="padding: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <label>국가 코드 (예: KOR, 비우면 전체)<input id="bulk-country" maxlength="3" placeholder="KOR" style="${input}"></label>
                        <label>대상<select id="bulk-owned" style="${input}"><option value="unowned">주인 없는 땅만</option><option value="all">주인 있는 땅 포함</option></select></label>
                        <label>현재 가격 이상 (pt)<input id="bulk-min" type="number" placeholder="예: 500 (S급)" style="${input}"></label>
                        <label>현재 가격 이하 (pt)<input id="bulk-max" type="number" placeholder="비우면 제한 없음" style="${input}"></label>
                        <label>방식<select id="bulk-mode" style="${input}"><option value="percent">비율로 올리기/내리기 (%)</option><option value="set">특정 가격으로 맞추기 (pt)</option></select></label>
                        <label>값<input id="bulk-value" type="number" placeholder="예: 10 또는 -20" style="${input}"></label>
                        <div id="bulk-preview" style="grid-column: 1 / -1; background: #f5f6fa; color: #333; padding: 12px; border-radius: 8px; font-size: 13px;">조건을 정하고 [미리보기]를 누르세요. 가격은 10pt 단위로 반올림되고 최소 50pt입니다.</div>
                    </div>
                    <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; padding: 16px 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                        <button class="btn btn-secondary" onclick="document.getElementById('bulk-price-modal-overlay').remove()">닫기</button>
                        <button class="btn" onclick="adminDashboard.runBulkPrice(false)">미리보기</button>
                        <button class="btn btn-primary" id="bulk-apply-btn" disabled onclick="adminDashboard.runBulkPrice(true)">적용</button>
                    </div>
                </div>
            </div>
        `);
        document.querySelectorAll('#bulk-price-modal-overlay input, #bulk-price-modal-overlay select').forEach(el => {
            el.addEventListener('input', () => {
                document.getElementById('bulk-apply-btn').disabled = true;
            });
        });
    }
    
    async runBulkPrice(apply) {
        const val = (id) => document.getElementById(id)?.value.trim() || '';
        const payload = {
            countryIso: val('bulk-country') || undefined,
            minPrice: val('bulk-min') || undefined,
            maxPrice: val('bulk-max') || undefined,
            onlyUnowned: val('bulk-owned') !== 'all',
            mode: val('bulk-mode'),
            value: Number(val('bulk-value')),
            apply
        };
        const preview = document.getElementById('bulk-preview');
        const applyBtn = document.getElementById('bulk-apply-btn');
        if (!val('bulk-value')) {
            preview.textContent = '값을 입력해주세요.';
            return;
        }
        if (apply && !confirm(`${this.lastBulkPreviewCount ?? '?'}개 땅의 가격을 바꿉니다. 계속할까요?`)) return;
        try {
            const result = await apiService.post('/admin/prices/bulk', payload);
            const samples = (result.samples || []).map(s =>
                `${escapeHtml(s.name || s.id)} (${escapeHtml(s.countryIso || '-')}): ${s.before.toLocaleString()} → <strong>${s.after.toLocaleString()}</strong> pt`
            ).join('<br>');
            preview.innerHTML = `
                ${result.applied ? `<strong style="color:#27ae60">✅ ${result.updated.toLocaleString()}개 적용 완료</strong><br>` : ''}
                대상 <strong>${result.count.toLocaleString()}</strong>개 · 평균 ${result.avgBefore.toLocaleString()} → <strong>${result.avgAfter.toLocaleString()}</strong> pt
                (범위 ${result.minAfter.toLocaleString()}~${result.maxAfter.toLocaleString()} pt)
                ${samples ? `<div style="margin-top:8px;">${samples}</div>` : ''}
            `;
            this.lastBulkPreviewCount = result.count;
            applyBtn.disabled = result.applied || result.count === 0;
            if (result.applied && this.currentSection === 'territories') this.loadTerritoriesTable();
        } catch (error) {
            preview.textContent = `❌ ${error.message || '실패'}`;
        }
    }
    
    /**
     * 신고 목록 로드
     */
    async loadReportsTable() {
        const tbody = document.querySelector('#reports-table tbody');
        if (!tbody) return;
        const status = document.querySelector('#section-reports .filter-btn.active')?.dataset.filter || 'open';
        tbody.innerHTML = '<tr><td colspan="6" class="loading">신고 로딩 중...</td></tr>';
        
        try {
            const reports = await adminApi.get('/admin/reports', { status });
            if (!Array.isArray(reports) || reports.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">신고가 없습니다</td></tr>';
                return;
            }
            const reasonLabels = { art: '부적절한 그림', link: '유해/사기 링크', spam: '스팸', other: '기타' };
            const actionLabels = { dismiss: '문제 없음', remove_art: '그림 삭제', remove_link: '링크 삭제', block_link: '링크 차단', remove_all: '그림+링크 삭제' };
            
            tbody.innerHTML = reports.map(r => {
                const time = r.createdAt ? new Date(r.createdAt).toLocaleString('ko-KR') : '-';
                const link = r.adUrl
                    ? `<a href="${r.adUrl}" target="_blank" rel="noopener noreferrer nofollow">${r.adTitle || r.adUrl}</a>`
                    : (r.adHidden ? '<span class="badge badge-warning">차단됨</span>' : '-');
                const actions = r.status === 'open' ? `
                    <select id="report-action-${r.id}" style="padding:4px;">
                        <option value="dismiss">문제 없음</option>
                        <option value="remove_art">그림 삭제</option>
                        <option value="remove_link">링크 삭제</option>
                        <option value="block_link">링크 차단</option>
                        <option value="remove_all">그림+링크 삭제</option>
                    </select>
                    <button class="btn btn-sm btn-primary" onclick="adminDashboard.resolveReport(${r.id})">처리</button>
                ` : `${actionLabels[r.action] || r.status}<br><small style="color:#888">${r.resolvedBy || ''}</small>`;
                return `
                    <tr>
                        <td style="white-space:nowrap">${time}</td>
                        <td>
                            <a href="index.html?territory=${encodeURIComponent(r.territoryId)}" target="_blank" rel="noopener">${r.territoryName || r.territoryId}</a>
                            <br><small style="color:#888">주인: ${r.owner || '-'}${r.territoryReportCount > 1 ? ` · 신고 ${r.territoryReportCount}건` : ''}</small>
                        </td>
                        <td>${reasonLabels[r.reason] || r.reason}${r.details ? `<br><small style="color:#aaa">${r.details}</small>` : ''}</td>
                        <td>${r.reporter || '-'}</td>
                        <td style="max-width:220px;word-break:break-all;">${link}</td>
                        <td style="white-space:nowrap">${actions}</td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error('[AdminDashboard] Failed to load reports:', error);
            tbody.innerHTML = `<tr><td colspan="6" class="error">신고 로딩 실패: ${escapeHtml(error.message || '')}</td></tr>`;
        }
    }
    
    async resolveReport(reportId) {
        const action = document.getElementById(`report-action-${reportId}`)?.value || 'dismiss';
        const labels = { dismiss: '문제 없음으로 처리', remove_art: '그림을 삭제', remove_link: '링크를 삭제', block_link: '링크를 삭제하고 차단', remove_all: '그림과 링크를 모두 삭제' };
        if (!confirm(`이 영토를 "${labels[action]}"하시겠습니까?${action === 'dismiss' ? '' : '\n\n삭제는 되돌릴 수 없습니다.'}`)) return;
        try {
            const result = await apiService.post(`/admin/reports/${reportId}/resolve`, { action });
            alert(`✅ 처리 완료 (신고 ${result.resolvedCount}건 정리)`);
            this.loadReportsTable();
        } catch (error) {
            alert(`❌ 처리 실패: ${error.message || '알 수 없는 오류'}`);
        }
    }
    
    /**
     * 영토 테이블 로드
     * 점유된 영토(sovereignty == 'ruled' 또는 'protected')만 표시
     */
    async loadTerritoriesTable() {
        const tbody = document.querySelector('#territories-table tbody');
        
        if (!tbody) {
            console.error('[AdminDashboard] Territories table tbody not found');
            return;
        }
        
        try {
            // 로딩 표시
            tbody.innerHTML = '<tr><td colspan="6" class="loading">영토 데이터 로딩 중...</td></tr>';
            
            // ✅ 마이그레이션 완료: 백엔드 API 사용
            const territories = await adminApi.get('/admin/territories?limit=100');
            
            if (!territories || territories.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">점유된 영토가 없습니다</td></tr>';
                return;
            }
            
            // 영토 테이블 렌더링
            tbody.innerHTML = territories.map(territory => {
                const sovereigntyBadge = territory.sovereignty === 'ruled' 
                    ? '<span class="badge badge-success">Ruled</span>' 
                    : '<span class="badge badge-warning">Protected</span>';
                const price = parseFloat(territory.purchasedPrice || territory.price || 0);
                
                return `
                    <tr>
                        <td>${territory.name || territory.code} ${sovereigntyBadge}</td>
                        <td>${territory.country || '-'}</td>
                        <td>${territory.rulerNickname || territory.rulerEmail || '-'}</td>
                        <td>${price.toLocaleString()} pt</td>
                        <td>-</td>
                        <td>
                            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                                <button class="btn btn-sm" onclick="adminDashboard.viewTerritory('${territory.id}')">보기</button>
                                <button class="btn btn-sm" onclick="adminDashboard.editTerritory('${territory.id}')">수정</button>
                                <button class="btn btn-sm btn-danger" onclick="adminDashboard.showResetTerritoryModal('${territory.id}')" title="오너 삭제 및 초기화">삭제</button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
            
            console.log(`[AdminDashboard] ✅ Loaded ${territories.length} territories from API`);
            
            /* 원래 Firestore 코드 (비활성화됨)
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
                    // JSON 형식의 문자열인지 확인 (예: '{"ko":"텍사스","en":"Texas"}')
                    if (name.trim().startsWith('{') && name.trim().endsWith('}')) {
                        try {
                            const parsed = JSON.parse(name);
                            if (typeof parsed === 'object' && parsed !== null) {
                                // 언어 우선순위: en > ko > local > 첫 번째 값
                                return parsed.en || parsed.ko || parsed.local || Object.values(parsed)[0] || name;
                            }
                        } catch (e) {
                            // JSON 파싱 실패 시 원본 문자열 반환
                            return name;
                        }
                    }
                    return name;
                }
                if (typeof name === 'object' && name !== null) {
                    // 언어 우선순위: en > ko > local > 첫 번째 값
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
            
            // ⚡ 최적화: 모든 옥션을 한 번에 가져와서 메모리에서 필터링 (N+1 쿼리 문제 해결)
            let allAuctionsMap = new Map(); // territoryId -> auction[]
            try {
                const territoryIds = allDocs.map(doc => doc.id);
                // ended 상태의 옥션만 가져오기 (최근 1000개 제한)
                const allEndedAuctions = await this.db.collection('auctions')
                    .where('status', '==', 'ended')
                    .orderBy('endedAt', 'desc')
                    .limit(1000)
                    .get();
                
                // territoryId별로 그룹화
                allEndedAuctions.docs.forEach(auctionDoc => {
                    const auctionData = auctionDoc.data();
                    const tid = auctionData.territoryId;
                    if (tid && territoryIds.includes(tid)) {
                        if (!allAuctionsMap.has(tid)) {
                            allAuctionsMap.set(tid, []);
                        }
                        allAuctionsMap.get(tid).push({ id: auctionDoc.id, ...auctionData });
                    }
                });
                
                console.log(`[AdminDashboard] Loaded ${allEndedAuctions.size} ended auctions, ${allAuctionsMap.size} territories have auctions`);
            } catch (error) {
                console.warn('[AdminDashboard] Failed to load auctions in batch:', error);
            }
            
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
                
                // ⚡ 최적화: 메모리에서 옥션 데이터 찾기 (개별 쿼리 제거)
                if (data.ruler && (!purchasedPrice || (tribute && !purchasedPrice))) {
                    const territoryAuctions = allAuctionsMap.get(doc.id) || [];
                    const matchingAuctions = territoryAuctions
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
                            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                                <button class="btn btn-sm" onclick="adminDashboard.viewTerritory('${doc.id}')">보기</button>
                                <button class="btn btn-sm" onclick="adminDashboard.editTerritory('${doc.id}')">수정</button>
                                <button class="btn btn-sm btn-danger" onclick="adminDashboard.showResetTerritoryModal('${doc.id}')" title="오너 삭제 및 초기화">삭제</button>
                                <button class="btn btn-sm btn-secondary" onclick="adminDashboard.showSetOwnerModal('${doc.id}')" title="오너 설정">오너 설정</button>
                            </div>
                        </td>
                    </tr>
                `;
            }))).join('');
            */
            
        } catch (error) {
            console.error('Failed to load territories:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="error">영토 로딩 실패</td></tr>';
        }
    }
    
    /**
     * 옥션 테이블 로드
     */
    async loadAuctionsTable(statusFilter = null) {
        const tbody = document.querySelector('#auctions-table tbody');
        
        if (!tbody) {
            console.error('[AdminDashboard] Auctions table tbody not found');
            return;
        }
        
        try {
            // 로딩 표시
            tbody.innerHTML = '<tr><td colspan="8" class="loading">경매 데이터 로딩 중...</td></tr>';
            
            // ✅ 마이그레이션 완료: 백엔드 API 사용
            // 필터가 지정되지 않은 경우 활성 필터 버튼에서 가져오기
            if (!statusFilter) {
                const activeFilterBtn = document.querySelector('#section-auctions .filter-btn.active[data-filter]');
                if (activeFilterBtn) {
                    statusFilter = activeFilterBtn.getAttribute('data-filter');
                }
            }
            
            // 'all' 필터는 status 파라미터를 보내지 않음
            const params = { limit: 100 };
            if (statusFilter && statusFilter !== 'all') {
                params.status = statusFilter;
            }
            
            const auctions = await adminApi.get('/admin/auctions', params);
            
            if (!auctions || auctions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty">경매가 없습니다</td></tr>';
                return;
            }
            
            // 디버깅: API 응답 확인
            console.log('[AdminDashboard] Auctions API response:', auctions);
            if (auctions.length > 0) {
                console.log('[AdminDashboard] First auction data:', {
                    id: auctions[0].id,
                    currentBid: auctions[0].currentBid,
                    startingBid: auctions[0].startingBid,
                    endTime: auctions[0].endTime
                });
            }
            
            // 경매 테이블 렌더링
            tbody.innerHTML = auctions.map(auction => {
                const createdAt = auction.createdAt ? new Date(auction.createdAt).toLocaleDateString('ko-KR') : '-';
                const endTime = auction.endTime ? new Date(auction.endTime).toLocaleDateString('ko-KR') : '-';
                const statusBadge = auction.status === 'active' 
                    ? '<span class="badge badge-success">활성</span>' 
                    : '<span class="badge badge-secondary">종료</span>';
                
                const isActive = auction.status === 'active';
                
                return `
                    <tr>
                        <td>${auction.territoryName || auction.territoryCode || '-'}</td>
                        <td>${statusBadge}</td>
                        <td>${(auction.startingBid || 0).toLocaleString()} pt</td>
                        <td>${(auction.currentBid || 0).toLocaleString()} pt</td>
                        <td>${auction.bidderNickname || auction.bidderEmail || '-'}</td>
                        <td>${endTime}</td>
                        <td>${createdAt}</td>
                        <td style="white-space: nowrap; min-width: 250px;">
                            <button class="btn btn-sm" onclick="adminDashboard.viewAuction('${auction.id}')">보기</button>
                            ${isActive ? 
                                `<button class="btn btn-sm btn-secondary" onclick="adminDashboard.editAuctionTime('${auction.id}')" title="종료 시간 수정" style="margin-left: 4px; display: inline-block;">⏰ 시간 수정</button>
                                <button class="btn btn-sm btn-danger" onclick="adminDashboard.endAuction('${auction.id}')" style="margin-left: 4px; display: inline-block;">종료</button>` 
                                : ''
                            }
                            <button class="btn btn-sm btn-warning" onclick="adminDashboard.deleteAuction('${auction.id}')" title="옥션 삭제" style="margin-left: 4px; display: inline-block;">🗑️ 삭제</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            console.log(`[AdminDashboard] ✅ Loaded ${auctions.length} auctions from API`);
            
            /* 원래 Firestore 코드 (비활성화됨)
            const snapshot = await this.db.collection('auctions').orderBy('createdAt', 'desc').limit(100).get();
            
            if (snapshot.empty) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty">옥션 없음</td></tr>';
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
            */
            
        } catch (error) {
            console.error('Failed to load auctions:', error);
            tbody.innerHTML = '<tr><td colspan="8" class="error">옥션 로딩 실패</td></tr>';
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
            const userData = await adminApi.get(`/admin/users/${userId}`);
            if (!userData) {
                alert('사용자를 찾을 수 없습니다.');
                return;
            }
            
            const email = userData.email || '-';
            const displayName = userData.nickname || email.split('@')[0];
            const balance = userData.balance || 0;
            const territories = userData.territories || [];
            const transactions = userData.transactions || [];
            const isAdmin = ADMIN_EMAILS.includes(String(email).toLowerCase());
            const createdAt = userData.createdAt ? new Date(userData.createdAt).toLocaleString('ko-KR') : '-';
            const totalCharged = transactions.filter(t => t.type === 'charge').reduce((sum, t) => sum + t.amount, 0);
            const totalSpent = transactions.filter(t => t.amount < 0 && t.type !== 'bid_hold').reduce((sum, t) => sum - t.amount, 0);
            
            const typeLabels = {
                charge: '충전', purchase: '구매', admin_grant: '관리자 지급', admin_deduct: '관리자 차감',
                bid_hold: '입찰 예치', bid_release: '입찰 환불', signup_bonus: '가입 보너스', reward: '보상', refund: '환불'
            };
            
            const territoriesHtml = territories.length === 0
                ? '<p style="color:#888; margin:0;">보유 영토 없음</p>'
                : `<table class="data-table" style="font-size:13px;"><thead><tr><th>영토</th><th>상태</th><th>구매가</th><th>구매일</th></tr></thead><tbody>
                    ${territories.map(t => `<tr>
                        <td>${t.name || t.id}<br><small style="color:#888">${t.id}</small></td>
                        <td>${t.sovereignty}</td>
                        <td>${(t.purchasedPrice || 0).toLocaleString()} pt</td>
                        <td>${t.purchasedAt ? new Date(t.purchasedAt).toLocaleDateString('ko-KR') : '-'}</td>
                    </tr>`).join('')}
                  </tbody></table>`;
            
            const transactionsHtml = transactions.length === 0
                ? '<p style="color:#888; margin:0;">거래 내역 없음</p>'
                : `<table class="data-table" style="font-size:13px;"><thead><tr><th>일시</th><th>종류</th><th>금액</th><th>내용</th></tr></thead><tbody>
                    ${transactions.map(t => `<tr>
                        <td style="white-space:nowrap">${t.createdAt ? new Date(t.createdAt).toLocaleString('ko-KR') : '-'}</td>
                        <td>${typeLabels[t.type] || t.type}</td>
                        <td style="color:${t.amount < 0 ? '#c0392b' : '#27ae60'}; font-weight:bold; white-space:nowrap">${t.amount > 0 ? '+' : ''}${t.amount.toLocaleString()} pt</td>
                        <td>${t.description || ''}</td>
                    </tr>`).join('')}
                  </tbody></table>`;
            
            const modalHtml = `
                <div class="modal-overlay" id="user-modal-overlay" onclick="adminDashboard.closeUserModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 820px; max-height: 90vh; overflow-y: auto;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">👤 ${displayName} ${isAdmin ? '<span class="badge badge-warning">관리자</span>' : ''}</h2>
                            <button class="modal-close" onclick="adminDashboard.closeUserModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <p style="margin: 0 0 15px 0; color: #666;">${email} · 가입 ${createdAt}<br><small>ID: ${userData.id}</small></p>
                            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px;">
                                <div class="stat-card"><div class="stat-info"><span class="stat-value">${balance.toLocaleString()}</span><span class="stat-label">현재 잔액 (pt)</span></div></div>
                                <div class="stat-card"><div class="stat-info"><span class="stat-value">${totalCharged.toLocaleString()}</span><span class="stat-label">충전 (최근 50건 중)</span></div></div>
                                <div class="stat-card"><div class="stat-info"><span class="stat-value">${totalSpent.toLocaleString()}</span><span class="stat-label">사용 (최근 50건 중)</span></div></div>
                                <div class="stat-card"><div class="stat-info"><span class="stat-value">${territories.length}</span><span class="stat-label">보유 영토</span></div></div>
                            </div>
                            <h3 style="margin: 0 0 8px 0;">🗺️ 보유 영토</h3>
                            <div style="margin-bottom: 20px;">${territoriesHtml}</div>
                            <h3 style="margin: 0 0 8px 0;">💳 포인트 거래 내역 (최근 50건)</h3>
                            <div>${transactionsHtml}</div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeUserModal()">닫기</button>
                            <button class="btn btn-primary" onclick="adminDashboard.closeUserModal(); adminDashboard.addPoints('${userData.id}');">💰 포인트 지급/차감</button>
                            <button class="btn btn-danger" onclick="adminDashboard.closeUserModal(); adminDashboard.showBanModal('${userData.id}');">🗑️ 삭제</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('user-modal-overlay')?.remove();
            document.body.insertAdjacentHTML('beforeend', modalHtml);
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
     * 사용자 삭제 모달 표시
     */
    async showBanModal(userId) {
        try {
            // ✅ 백엔드 API 사용
            const userData = await adminApi.get(`/admin/users/${userId}`);
            const displayName = userData.nickname || userData.email?.split('@')[0] || userId.substring(0, 20);
            const email = userData.email || userId;
            
            const modalHtml = `
                <div class="modal-overlay" id="ban-modal-overlay" onclick="adminDashboard.closeBanModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 600px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">🗑️ 사용자 삭제</h2>
                            <button class="modal-close" onclick="adminDashboard.closeBanModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <!-- 사용자 정보 -->
                            <div style="background: #fee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e74c3c;">
                                <h3 style="margin-top: 0; margin-bottom: 10px; color: #c0392b; font-size: 16px;">삭제 대상</h3>
                                <p style="margin: 0; color: #333; font-size: 14px;"><strong>${displayName}</strong> (${email})</p>
                            </div>
                            
                            <!-- 삭제 기능 설명 -->
                            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
                                <h3 style="margin-top: 0; margin-bottom: 15px; color: #856404; font-size: 16px;">⚠️ 삭제 기능 안내</h3>
                                <ul style="margin: 0; padding-left: 20px; color: #856404; line-height: 1.8;">
                                    <li>사용자의 <strong>모든 데이터가 삭제</strong>됩니다 (계정, 지갑, 영토 소유권 등).</li>
                                    <li>보유 중인 <strong>영토는 자동으로 해제</strong>됩니다.</li>
                                    <li>삭제된 사용자는 <strong>재가입이 가능</strong>합니다.</li>
                                    <li>삭제 사유는 로그에 기록되며, <strong>되돌릴 수 없습니다</strong>.</li>
                                </ul>
                            </div>
                            
                            <!-- 삭제 사유 입력 -->
                            <div style="margin-bottom: 20px;">
                                <label style="display: block; font-weight: bold; color: #333; margin-bottom: 8px; font-size: 14px;">삭제 사유 (선택사항)</label>
                                <textarea id="ban-reason-input" placeholder="삭제 사유를 입력하세요..." style="width: 100%; min-height: 100px; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: inherit; resize: vertical;"></textarea>
                            </div>
                            
                            <!-- 경고 메시지 -->
                            <div style="background: #f8d7da; padding: 15px; border-radius: 8px; border: 1px solid #f5c6cb; margin-bottom: 20px;">
                                <p style="margin: 0; color: #721c24; font-size: 14px; font-weight: bold;">⚠️ 이 작업은 되돌릴 수 없습니다. 신중하게 결정하세요.</p>
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeBanModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                            <button class="btn btn-danger" onclick="adminDashboard.confirmBanUser('${userId}')" style="padding: 10px 30px; background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">🗑️ 삭제 확인</button>
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
            
        } catch (error) {
            console.error('Failed to load user for delete:', error);
            alert(`사용자 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closeBanModal() {
        const modal = document.getElementById('ban-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 사용자 삭제 확인 및 실행
     */
    async confirmBanUser(userId) {
        const reasonInput = document.getElementById('ban-reason-input');
        const reason = reasonInput ? reasonInput.value.trim() : '';
        
        try {
            // ✅ 백엔드 API 사용 - 사용자 데이터 삭제
            await apiService.delete(`/admin/users/${userId}`, {
                reason: reason || '관리자에 의해 삭제됨'
            });
            
            // 로그 기록
            await this.logAdminAction('DELETE_USER', { userId, reason });
            
            this.closeBanModal();
            
            // ✅ 즉시 테이블 새로고침 (실시간 반영)
            await this.loadUsersTable();
            
            // 통계 새로고침
            await this.loadStats();
            
            alert('✅ 사용자가 삭제되었습니다.\n\n사용자는 재가입이 가능합니다.');
        } catch (error) {
            console.error('Failed to delete user:', error);
            alert(`❌ 사용자 삭제에 실패했습니다: ${error.message || error.error || '알 수 없는 오류'}`);
        }
    }
    
    /**
     * 포인트 지급 모달 표시
     */
    async addPoints(userId, presetAmount = null, presetReason = '') {
        try {
            const userData = await adminApi.get(`/admin/users/${userId}`);
            if (!userData) {
                alert('사용자를 찾을 수 없습니다.');
                return;
            }
            
            const displayName = userData.nickname || userData.email?.split('@')[0] || userId;
            const currentBalance = userData.balance || 0;
            const quick = [100, 500, 1000, 5000].map(v =>
                `<button type="button" class="btn btn-sm" onclick="document.getElementById('points-amount-input').value='${v}'; document.getElementById('points-amount-input').dispatchEvent(new Event('input'))">${v.toLocaleString()} pt</button>`
            ).join('');
            
            const modalHtml = `
                <div class="modal-overlay" id="points-modal-overlay" onclick="adminDashboard.closePointsModal()">
                    <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 560px;">
                        <div class="modal-header" style="background: linear-gradient(135deg, #00b894 0%, #00a085 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h2 style="margin: 0; color: white;">💰 포인트 지급 / 차감</h2>
                            <button class="modal-close" onclick="adminDashboard.closePointsModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <p style="margin: 0 0 15px 0;"><strong>${displayName}</strong> (${userData.email || '-'})<br>현재 잔액: <strong>${currentBalance.toLocaleString()} pt</strong></p>
                            <div style="display: flex; gap: 16px; margin-bottom: 12px;">
                                <label><input type="radio" name="points-mode" value="grant" checked> ➕ 지급</label>
                                <label><input type="radio" name="points-mode" value="deduct"> ➖ 차감 (환불·회수)</label>
                            </div>
                            <input type="number" id="points-amount-input" min="1" step="1" placeholder="포인트 (pt)" value="${presetAmount || ''}" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 16px; font-weight: bold; text-align: center;">
                            <div style="display: flex; gap: 6px; margin: 10px 0 15px 0;">${quick}</div>
                            <label style="display: block; font-weight: bold; margin-bottom: 6px;">사유 <span id="points-reason-required" style="color:#c0392b; display:none;">(차감 시 필수)</span></label>
                            <textarea id="points-reason-input" placeholder="예: PayPal 환불 처리, 이벤트 보상" style="width: 100%; min-height: 70px; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-family: inherit;">${presetReason}</textarea>
                            <p id="points-preview" style="margin: 12px 0 0 0; color: #333;"></p>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                            <button class="btn btn-secondary" onclick="adminDashboard.closePointsModal()">취소</button>
                            <button class="btn btn-primary" id="points-confirm-btn" onclick="adminDashboard.confirmAddPoints('${userData.id}', ${currentBalance})">확인</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('points-modal-overlay')?.remove();
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            const amountInput = document.getElementById('points-amount-input');
            const preview = document.getElementById('points-preview');
            const requiredHint = document.getElementById('points-reason-required');
            const update = () => {
                const isDeduct = document.querySelector('input[name="points-mode"]:checked')?.value === 'deduct';
                const amount = parseInt(amountInput.value, 10) || 0;
                requiredHint.style.display = isDeduct ? 'inline' : 'none';
                if (amount <= 0) {
                    preview.textContent = '';
                    return;
                }
                const next = currentBalance + (isDeduct ? -amount : amount);
                preview.innerHTML = next < 0
                    ? '<span style="color:#c0392b">⚠️ 현재 잔액보다 많이 차감할 수 없습니다</span>'
                    : `처리 후 잔액: <strong>${next.toLocaleString()} pt</strong>`;
            };
            amountInput.addEventListener('input', update);
            document.querySelectorAll('input[name="points-mode"]').forEach(r => r.addEventListener('change', update));
            update();
            amountInput.focus();
        } catch (error) {
            console.error('Failed to load user for points:', error);
            alert(`사용자 정보를 불러오는데 실패했습니다: ${error.message}`);
        }
    }
    
    closePointsModal() {
        document.getElementById('points-modal-overlay')?.remove();
    }
    
    /**
     * 포인트 지급/차감 실행
     */
    async confirmAddPoints(userId, currentBalance = 0) {
        const amountInput = document.getElementById('points-amount-input');
        const reason = document.getElementById('points-reason-input')?.value.trim() || '';
        const isDeduct = document.querySelector('input[name="points-mode"]:checked')?.value === 'deduct';
        const amount = parseInt(amountInput?.value, 10);
        
        if (!Number.isFinite(amount) || amount <= 0) {
            alert('1 pt 이상의 포인트를 입력해주세요.');
            amountInput?.focus();
            return;
        }
        if (isDeduct && !reason) {
            alert('차감할 때는 사유를 입력해주세요.');
            return;
        }
        if (isDeduct && amount > currentBalance) {
            alert(`현재 잔액(${currentBalance.toLocaleString()} pt)보다 많이 차감할 수 없습니다.`);
            return;
        }
        const label = isDeduct ? '차감' : '지급';
        if (!confirm(`${amount.toLocaleString()} pt를 ${label}하시겠습니까?`)) return;
        
        const button = document.getElementById('points-confirm-btn');
        if (button) button.disabled = true;
        try {
            const result = await apiService.post(`/admin/users/${userId}/points`, {
                amount: isDeduct ? -amount : amount,
                reason: reason || null
            });
            if (!result?.success) {
                throw new Error(result?.error || `포인트 ${label}에 실패했습니다.`);
            }
            this.closePointsModal();
            if (this.currentSection === 'users') this.loadUsersTable();
            if (this.currentSection === 'payments') this.loadPaymentsTable();
            alert(`✅ ${amount.toLocaleString()} pt ${label} 완료\n새 잔액: ${result.newBalance.toLocaleString()} pt`);
        } catch (error) {
            console.error('Failed to adjust points:', error);
            alert(`❌ 포인트 ${label} 실패: ${error.message || '알 수 없는 오류'}`);
            if (button) button.disabled = false;
        }
    }
    
    async viewTerritory(territoryId) {
        try {
            // ✅ 백엔드 API 사용 (관리자용 엔드포인트)
            const data = await adminApi.get(`/admin/territories/${territoryId}`);
            if (!data) {
                alert('영토를 찾을 수 없습니다.');
                return;
            }
            
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
            const rulerName = data.rulerNickname || data.rulerName || '미점유';
            const sovereignty = data.sovereignty || 'unconquered';
            const sovereigntyText = sovereignty === 'ruled' ? '점유됨' : sovereignty === 'protected' ? '보호됨' : '미점유';
            
            // 가격 계산: 낙찰가 우선, 없으면 저장된 가격, 없으면 계산
            // 디버깅: 원본 데이터 확인
            console.log(`[AdminDashboard] viewTerritory ${territoryId} data:`, {
                purchasedPrice: data.purchasedPrice,
                price: data.price,
                basePrice: data.basePrice,
                marketBasePrice: data.marketBasePrice,
                rulerId: data.rulerId,
                rulerNickname: data.rulerNickname
            });
            
            // 낙찰가 우선 확인 (0이 아닌 값만)
            let price = 0;
            let purchasedPrice = data.purchasedPrice && data.purchasedPrice > 0 ? parseFloat(data.purchasedPrice) : null;
            const storedPrice = data.price && data.price > 0 ? parseFloat(data.price) : null;
            const basePrice = data.basePrice && data.basePrice > 0 ? parseFloat(data.basePrice) : null;
            
            // 옥션 데이터에서 낙찰가 찾기 (가장 정확한 데이터)
            // purchasedPrice가 없으면 옥션 데이터를 확인
            if (data.rulerId && !purchasedPrice) {
                try {
                    // ✅ 백엔드 API 사용: 옥션 정보는 이미 territory 조회 시 포함됨
                    // auctionId가 있으면 해당 옥션 조회
                    if (data.auctionId) {
                        const auction = await adminApi.get(`/auctions/${data.auctionId}`);
                        if (auction && auction.status === 'ended' && auction.currentBid > 0) {
                            purchasedPrice = auction.currentBid;
                            console.log(`[AdminDashboard] viewTerritory: Found auction price from auction currentBid: ${purchasedPrice}`);
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
            } else if (storedPrice) {
                price = storedPrice;
                console.log(`[AdminDashboard] viewTerritory: Using stored price: ${price}`);
            } else if (basePrice) {
                price = basePrice;
                console.log(`[AdminDashboard] viewTerritory: Using basePrice: ${price}`);
            }
            
            // 픽셀 수 계산 (저장값 우선, 없으면 계산)
            // loadTerritoriesTable과 동일한 계산을 보장하기 위해 territoryName과 countryCode를 정규화
            // API 응답에는 pixelCount가 직접 포함되지 않을 수 있으므로 계산 필요
            let pixelCount = 0;
            
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
            
            // 픽셀 수 계산 - loadTerritoriesTable과 동일한 로직
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
                    // properties 객체는 API 응답에 없을 수 있으므로 빈 객체 사용
                    const territory = {
                        id: territoryId,
                        name: normalizedName,
                        country: countryCode,
                        properties: {}
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
            
            // 숫자 타입 보장
            price = typeof price === 'number' && !isNaN(price) ? price : 0;
            pixelCount = typeof pixelCount === 'number' && !isNaN(pixelCount) ? pixelCount : 0;
            
            const priceDisplay = price.toLocaleString();
            const pixelCountDisplay = pixelCount.toLocaleString();
            const purchasedByAdmin = data.purchasedByAdmin ? '예' : '아니오';
            const createdAt = data.createdAt ? (new Date(data.createdAt).toLocaleString('ko-KR')) : '-';
            const updatedAt = data.updatedAt ? (new Date(data.updatedAt).toLocaleString('ko-KR')) : '-';
            
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
                                ${data.purchasedPrice ? `
                                <div class="info-item">
                                    <label>낙찰가</label>
                                    <span><strong style="color: #4CAF50;">${data.purchasedPrice.toLocaleString()} pt</strong></span>
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
            // ✅ 백엔드 API 사용: 현재 영토 정보 가져오기
            const data = await adminApi.get(`/admin/territories/${territoryId}`);
            if (!data) {
                alert('영토를 찾을 수 없습니다.');
                return;
            }
            
            const currentPrice = data.price || data.basePrice || 0;
            
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
            
            // ✅ 백엔드 API 사용: 업데이트
            await apiService.put(`/admin/territories/${territoryId}`, {
                price: newPrice
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
            alert(`영토 수정에 실패했습니다: ${error.message || '알 수 없는 오류'}`);
        }
    }
    
    /**
     * 영토 오너 삭제 및 초기화 모달 표시
     */
    showResetTerritoryModal(territoryId) {
        const modalHtml = `
            <div class="modal-overlay premium-modal-overlay" id="reset-territory-modal-overlay" onclick="adminDashboard.closeResetTerritoryModal()">
                <div class="modal-content premium-modal-content" onclick="event.stopPropagation()">
                    <div class="modal-header premium-modal-header">
                        <div class="modal-icon-wrapper">
                            <span class="modal-icon">🗑️</span>
                        </div>
                        <h2>영토 초기화</h2>
                        <button class="modal-close premium-modal-close" onclick="adminDashboard.closeResetTerritoryModal()">×</button>
                    </div>
                    <div class="modal-body premium-modal-body">
                        <div class="warning-box">
                            <div class="warning-icon">⚠️</div>
                            <div class="warning-content">
                                <h3>경고</h3>
                                <p>이 작업은 <strong>되돌릴 수 없습니다</strong>.</p>
                                <ul>
                                    <li>영토의 소유자(ruler)가 삭제됩니다</li>
                                    <li>영토 상태가 'unconquered'로 변경됩니다</li>
                                    <li>보호 기간이 제거됩니다</li>
                                    <li>옥션 정보가 초기화됩니다</li>
                                </ul>
                            </div>
                        </div>
                        <div class="territory-info-box">
                            <p><strong>영토 ID:</strong> <code>${territoryId}</code></p>
                        </div>
                    </div>
                    <div class="modal-footer premium-modal-footer">
                        <button class="btn btn-secondary" onclick="adminDashboard.closeResetTerritoryModal()">취소</button>
                        <button class="btn btn-danger" onclick="adminDashboard.resetTerritory('${territoryId}')">초기화 실행</button>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달 제거
        const existingModal = document.getElementById('reset-territory-modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }
    
    closeResetTerritoryModal() {
        const modal = document.getElementById('reset-territory-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 영토 오너 삭제 및 초기화 실행
     */
    async resetTerritory(territoryId) {
        try {
            // 영토 정보 확인
            const territory = await adminApi.get(`/territories/${territoryId}`);
            if (!territory) {
                alert('영토를 찾을 수 없습니다.');
                this.closeResetTerritoryModal();
                return;
            }
            
            const previousRulerName = territory.ruler?.name || territory.rulerName || '없음';
            
            // 확인 대화상자
            if (!confirm(`정말로 이 영토를 초기화하시겠습니까?\n\n영토 ID: ${territoryId}\n현재 소유자: ${previousRulerName}\n\n이 작업은 되돌릴 수 없습니다.`)) {
                return;
            }
            
            // ✅ 백엔드 API 사용
            await apiService.put(`/admin/territories/${territoryId}/reset`);
            
            // ⚠️ 중요: IndexedDB 캐시에서도 해당 영토의 픽셀 데이터 삭제
            try {
                const dbName = 'pixelCanvasCache';
                const storeName = 'pixelCanvases';
                
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open(dbName, 2);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                
                const transaction = db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                
                await new Promise((resolve, reject) => {
                    const request = store.delete(territoryId);
                    request.onsuccess = () => {
                        console.log(`[AdminDashboard] Deleted pixelCanvas cache for territory ${territoryId}`);
                        resolve();
                    };
                    request.onerror = () => reject(request.error);
                });
                
                db.close();
            } catch (error) {
                console.warn(`[AdminDashboard] Failed to delete IndexedDB cache for territory ${territoryId}:`, error);
            }
            
            // 모달 닫기
            this.closeResetTerritoryModal();
            
            // ✅ 즉시 테이블 새로고침 (실시간 반영)
            await this.loadTerritoriesTable();
            
            // 통계 새로고침
            await this.loadStats();
            
            alert(`✅ 영토가 초기화되었습니다.\n\n영토 ID: ${territoryId}\n이전 소유자: ${previousRulerName}`);
            
        } catch (error) {
            console.error('Failed to reset territory:', error);
            alert(`❌ 영토 초기화에 실패했습니다: ${error.message || error.error || '알 수 없는 오류'}`);
        }
    }
    
    /**
     * 영토 오너 설정 모달 표시
     */
    async showSetOwnerModal(territoryId) {
        try {
            const data = await adminApi.get(`/admin/territories/${territoryId}`);
            const territory = data || {};
            const territoryName = territory.name || territoryId;
            const currentOwner = territory.rulerNickname || territory.rulerName || territory.rulerEmail || '없음';
            
            const modalHtml = `
                <div class="modal-overlay premium-modal-overlay" id="set-owner-modal-overlay" onclick="adminDashboard.closeSetOwnerModal()">
                    <div class="modal-content premium-modal-content" onclick="event.stopPropagation()" style="max-width: 560px;">
                        <div class="modal-header premium-modal-header">
                            <div class="modal-icon-wrapper"><span class="modal-icon">👑</span></div>
                            <h2>영토 오너 설정</h2>
                            <button class="modal-close premium-modal-close" onclick="adminDashboard.closeSetOwnerModal()">×</button>
                        </div>
                        <div class="modal-body premium-modal-body">
                            <div class="territory-info-box">
                                <p><strong>영토:</strong> ${territoryName} (<code>${territoryId}</code>)</p>
                                <p><strong>현재 소유자:</strong> ${currentOwner}</p>
                            </div>
                            <div class="form-group premium-form-group">
                                <label>새 소유자 (이메일 또는 사용자 ID)</label>
                                <input type="text" id="set-owner-user-input" class="premium-input" placeholder="user@example.com">
                            </div>
                            <div class="form-group premium-form-group">
                                <label>보호 기간</label>
                                <select id="set-owner-days" class="premium-input">
                                    <option value="7">1주</option>
                                    <option value="30">1개월</option>
                                    <option value="365">1년</option>
                                    <option value="lifetime">평생</option>
                                </select>
                            </div>
                            <label style="display:block; margin-top:8px;"><input type="checkbox" id="set-owner-clear-pixels" checked> 소유자가 바뀌면 기존 픽셀 아트 삭제</label>
                            <div class="info-box" style="margin-top:12px;">
                                <ul>
                                    <li>결제 없이 소유권만 지정됩니다 (관리자 지정으로 기록)</li>
                                    <li>진행 중인 경매는 취소되고 입찰금은 환불됩니다</li>
                                </ul>
                            </div>
                        </div>
                        <div class="modal-footer premium-modal-footer">
                            <button class="btn btn-secondary" onclick="adminDashboard.closeSetOwnerModal()">취소</button>
                            <button class="btn btn-primary" id="set-owner-confirm-btn" onclick="adminDashboard.setTerritoryOwner('${territoryId}')">설정</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('set-owner-modal-overlay')?.remove();
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            document.getElementById('set-owner-user-input')?.focus();
        } catch (error) {
            console.error('Failed to show set owner modal:', error);
            alert(`영토 정보를 불러오지 못했습니다: ${error.message}`);
        }
    }
    
    closeSetOwnerModal() {
        document.getElementById('set-owner-modal-overlay')?.remove();
    }
    
    /**
     * 영토 오너 설정 실행
     */
    async setTerritoryOwner(territoryId) {
        const user = document.getElementById('set-owner-user-input')?.value.trim();
        const daysValue = document.getElementById('set-owner-days')?.value || '7';
        const clearPixels = document.getElementById('set-owner-clear-pixels')?.checked !== false;
        if (!user) {
            alert('새 소유자의 이메일 또는 사용자 ID를 입력해주세요.');
            return;
        }
        if (!confirm(`${territoryId}의 소유자를 ${user}(으)로 지정하시겠습니까?`)) return;
        
        const button = document.getElementById('set-owner-confirm-btn');
        if (button) button.disabled = true;
        try {
            await apiService.post(`/admin/territories/${territoryId}/owner`, {
                user,
                protectionDays: daysValue === 'lifetime' ? null : parseInt(daysValue, 10),
                clearPixels
            });
            this.closeSetOwnerModal();
            if (this.currentSection === 'territories') await this.loadTerritoriesTable();
            await this.loadStats();
            alert(`✅ 소유자가 지정되었습니다.\n영토: ${territoryId}\n소유자: ${user}`);
        } catch (error) {
            console.error('Failed to set territory owner:', error);
            alert(`❌ 오너 설정 실패: ${error.message || '알 수 없는 오류'}`);
            if (button) button.disabled = false;
        }
    }
    
    async viewAuction(auctionId) {
        try {
            // ✅ 백엔드 API 사용
            const data = await adminApi.get(`/admin/auctions/${auctionId}`);
            
            if (!data) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const startTime = data.createdAt ? new Date(data.createdAt).toLocaleString('ko-KR') : '-';
            const endTime = data.endTime ? new Date(data.endTime).toLocaleString('ko-KR') : '-';
            const bids = []; // API에서는 입찰 기록을 별도로 제공하지 않을 수 있음
            const bidCount = 0; // 입찰자 수는 별도 API 호출 필요
            
            // 소유권 이전이 완료된 경우 영토 정보 가져오기
            let territoryInfo = null;
            if (data.territoryId && data.status === 'ended' && data.currentBidderId) {
                try {
                    const territory = await adminApi.get(`/territories/${data.territoryId}`);
                    if (territory && territory.rulerId === data.currentBidderId) {
                        territoryInfo = {
                            ruler: territory.rulerId,
                            rulerName: territory.rulerNickname || territory.rulerEmail,
                            sovereignty: territory.sovereignty,
                            purchasedByAdmin: territory.purchasedByAdmin || false,
                            purchasedPrice: territory.purchasedPrice || data.currentBid || null,
                            rulerSince: territory.purchasedAt ? new Date(territory.purchasedAt).toLocaleString('ko-KR') : '-',
                            protectionEndsAt: territory.protectionEndsAt ? new Date(territory.protectionEndsAt).toLocaleString('ko-KR') : '-'
                        };
                    }
                } catch (error) {
                    console.warn('Failed to load territory info for auction:', error);
                }
            }
            
            // 입찰 기록 포맷팅 (API에서 입찰 기록을 제공하지 않을 수 있음)
            let bidsHtml = '<p class="text-muted">입찰 기록이 없습니다.</p>';
            if (bids.length > 0) {
                bidsHtml = '<table class="bids-table"><thead><tr><th>입찰자</th><th>입찰가</th><th>시간</th></tr></thead><tbody>';
                bids.slice(-10).reverse().forEach(bid => {
                    const bidTime = bid.timestamp ? new Date(bid.timestamp).toLocaleString('ko-KR') : bid.time || '-';
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
                                    <span><strong>${(data.currentBid || data.startingBid || 0).toLocaleString()} pt</strong></span>
                                </div>
                                <div class="info-item">
                                    <label>최고 입찰자</label>
                                    <span>${data.bidderNickname || data.bidderEmail || '없음'}</span>
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
                                    <span>-</span>
                                </div>
                                <div class="info-item">
                                    <label>생성 시간</label>
                                    <span>${data.createdAt ? new Date(data.createdAt).toLocaleString('ko-KR') : '-'}</span>
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
            
            // ✅ 백엔드 API 사용
            await apiService.put(`/admin/auctions/${auctionId}/end`, { reason });
            
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
                alert(`❌ 옥션 종료에 실패했습니다: ${error.message || error.error || '알 수 없는 오류'}`);
            }
        }
    }
    
    /**
     * 옥션 종료 시간 수정 (고급 모달)
     */
    async editAuctionTime(auctionId) {
        try {
            // ✅ 백엔드 API 사용
            const auction = await adminApi.get(`/admin/auctions/${auctionId}`);
            
            // 디버깅: API 응답 확인
            console.log('[AdminDashboard] Auction detail API response:', auction);
            
            if (!auction) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            // ✅ endTime 파싱 (ISO 문자열 또는 Date 객체 처리)
            // null이어도 기본값 설정하여 모달을 열 수 있도록 수정
            let currentEndTime = null;
            let isDefaultEndTime = false;
            
            if (auction.endTime) {
                try {
                    currentEndTime = new Date(auction.endTime);
                    // 유효한 날짜인지 확인
                    if (isNaN(currentEndTime.getTime())) {
                        console.warn('[AdminDashboard] Invalid endTime:', auction.endTime);
                        currentEndTime = null;
                    }
                } catch (error) {
                    console.error('[AdminDashboard] Failed to parse endTime:', error);
                    currentEndTime = null;
                }
            }
            
            // ✅ endTime이 null이면 기본값 설정 (startTime 기반 duration 우선, 없으면 기본 duration)
            if (!currentEndTime) {
                const now = new Date();
                const DEFAULT_AUCTION_DURATION_MS = 24 * 60 * 60 * 1000; // 24시간 (시스템 기본값)
                
                // startTime이 있으면 startTime 기반으로 duration 적용
                if (auction.createdAt) {
                    try {
                        const startTime = new Date(auction.createdAt);
                        if (!isNaN(startTime.getTime())) {
                            currentEndTime = new Date(startTime.getTime() + DEFAULT_AUCTION_DURATION_MS);
                            console.warn('[AdminDashboard] endTime이 없어서 기본값 사용 (startTime + 24시간):', currentEndTime);
                        } else {
                            // startTime 파싱 실패 시 현재 시간 기준
                            currentEndTime = new Date(now.getTime() + DEFAULT_AUCTION_DURATION_MS);
                            console.warn('[AdminDashboard] endTime이 없고 startTime 파싱 실패, 기본값 사용 (현재 시간 + 24시간):', currentEndTime);
                        }
                    } catch (error) {
                        currentEndTime = new Date(now.getTime() + DEFAULT_AUCTION_DURATION_MS);
                        console.warn('[AdminDashboard] endTime이 없고 startTime 처리 실패, 기본값 사용 (현재 시간 + 24시간):', currentEndTime);
                    }
                } else {
                    // startTime도 없으면 현재 시간 기준
                    currentEndTime = new Date(now.getTime() + DEFAULT_AUCTION_DURATION_MS);
                    console.warn('[AdminDashboard] endTime이 없어서 기본값 사용 (현재 시간 + 24시간):', currentEndTime);
                }
                isDefaultEndTime = true;
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
            const territoryId = auction.territoryId || auctionId;
            const currentBid = (auction.currentBid || auction.startingBid || 0).toLocaleString();
            const bidCount = 0; // 입찰자 수는 API에서 제공되지 않을 수 있음
            const highestBidder = auction.bidderNickname || auction.bidderEmail || '없음';
            
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
                                ${isDefaultEndTime ? `
                                <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 6px; margin-bottom: 15px;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                        <strong style="color: #856404; font-size: 14px;">⚠️ 기본값 사용 중</strong>
                                    </div>
                                    <div style="color: #856404; font-size: 12px; line-height: 1.5;">
                                        이 옥션에는 종료 시간이 설정되어 있지 않습니다. 아래 시간은 기본값입니다.
                                        <br>
                                        ${auction.createdAt ? '시작 시간 기준 + 24시간' : '현재 시간 기준 + 24시간'}
                                    </div>
                                </div>
                                ` : ''}
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
            
            // ✅ 백엔드 API 사용
            await apiService.put(`/admin/auctions/${auctionId}/time`, {
                endTime: newEndTime.toISOString()
            });
            
            // 관리자 액션 로그 기록 (선택사항)
            try {
                await apiService.post('/admin/logs', {
                    action: 'EDIT_AUCTION_TIME',
                    details: {
                        auctionId,
                        oldEndTime: currentEndTime.toISOString(),
                        newEndTime: newEndTime.toISOString()
                    }
                });
            } catch (logError) {
                console.warn('Failed to log admin action:', logError);
                // 로그 실패해도 계속 진행
            }
            
            this.closeAuctionTimeModal();
            this.loadAuctionsTable(); // Refresh
            alert(`✅ 옥션 종료 시간이 수정되었습니다.\n\n새 종료 시간: ${newEndTime.toLocaleString('ko-KR')}`);
            
        } catch (error) {
            console.error('Failed to save auction time:', error);
            alert(`옥션 시간 수정에 실패했습니다: ${error.message || '알 수 없는 오류'}`);
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
        if (!confirm('이 옥션의 낙찰 결과(소유권 이전)를 다시 처리하시겠습니까?')) return;
        try {
            const result = await apiService.put(`/admin/auctions/${auctionId}/end`, { reason: '관리자 소유권 이전 재처리' });
            alert(`✅ 처리 완료\n${result?.message || ''}`);
            if (this.currentSection === 'auctions') await this.loadAuctionsTable();
            if (this.currentSection === 'territories') await this.loadTerritoriesTable();
        } catch (error) {
            console.error('Failed to process auction ownership:', error);
            alert(`소유권 이전 처리 실패: ${error.message}`);
        }
    }
    
    /**
     * 옥션 삭제
     */
    async deleteAuction(auctionId) {
        try {
            // ✅ 백엔드 API 사용
            const auction = await adminApi.get(`/auctions/${auctionId}`);
            if (!auction) {
                alert('옥션을 찾을 수 없습니다.');
                return;
            }
            
            const territoryId = auction.territoryId || auctionId;
            const status = auction.status || 'unknown';
            const highestBidder = auction.bidderNickname || auction.bidderEmail || '없음';
            const currentBid = auction.currentBid || auction.startingBid || 0;
            
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
            // ✅ 백엔드 API 사용
            await apiService.delete(`/admin/auctions/${auctionId}`);
            
            this.closeDeleteAuctionModal();
            
            // ✅ 즉시 테이블 새로고침 (실시간 반영)
            await this.loadAuctionsTable();
            
            // 통계 새로고침
            await this.loadStats();
            
            alert('✅ 옥션이 삭제되었습니다.');
            
        } catch (error) {
            console.error('Failed to delete auction:', error);
            alert(`❌ 옥션 삭제에 실패했습니다: ${error.message || error.error || '알 수 없는 오류'}`);
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
            // ✅ 백엔드 API 사용
            await apiService.post('/admin/logs', {
                action,
                details
            });
            console.log('Admin action logged:', action);
        } catch (error) {
            console.error('Failed to log admin action:', error);
        }
    }
    
    /**
     * 분석 데이터 로드 및 차트 렌더링
     */
    async loadAnalytics() {
        try {
            // ✅ 백엔드 API 사용
            const analytics = await adminApi.get('/admin/analytics?period=30d');
            
            // 사용자 성장 차트
            this.renderUserGrowthChart(analytics.userGrowth || []);
            
            // 수익 추이 차트
            this.renderRevenueChart(analytics.revenue || []);
            
            // 영토 분포 차트
            this.renderTerritoryDistributionChart(analytics.territoryDistribution || []);
            
            // 옥션 통계 표시
            this.renderAuctionStats(analytics.auctionStats || []);
            
        } catch (error) {
            console.error('Failed to load analytics:', error);
            const container = document.querySelector('#section-analytics .analytics-grid');
            if (container) {
                container.innerHTML = '<div class="error">분석 데이터를 불러올 수 없습니다.</div>';
            }
        }
    }
    
    /**
     * 사용자 성장 차트 렌더링
     */
    renderUserGrowthChart(data) {
        const card = document.querySelector('#section-analytics .analytics-card:nth-child(3) .chart-placeholder');
        if (!card) return;
        
        card.innerHTML = '<canvas id="user-growth-chart"></canvas>';
        const ctx = document.getElementById('user-growth-chart').getContext('2d');
        
        // 기존 차트가 있으면 제거
        if (this.userGrowthChart) {
            this.userGrowthChart.destroy();
        }
        
        this.userGrowthChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => new Date(d.date).toLocaleDateString('ko-KR')),
                datasets: [{
                    label: '신규 가입자',
                    data: data.map(d => parseInt(d.count, 10)),
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    tension: 0.1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '사용자 성장 추이'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }
    
    /**
     * 수익 추이 차트 렌더링
     */
    renderRevenueChart(data) {
        const card = document.querySelector('#section-analytics .analytics-card:nth-child(1) .chart-placeholder');
        if (!card) return;
        
        card.innerHTML = '<canvas id="revenue-chart"></canvas>';
        const ctx = document.getElementById('revenue-chart').getContext('2d');
        
        if (this.revenueChart) {
            this.revenueChart.destroy();
        }
        
        this.revenueChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(d => new Date(d.date).toLocaleDateString('ko-KR')),
                datasets: [{
                    label: '수익 (pt)',
                    data: data.map(d => parseFloat(d.total || 0)),
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '수익 추이'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }
    
    /**
     * 영토 분포 차트 렌더링
     */
    renderTerritoryDistributionChart(data) {
        const card = document.querySelector('#section-analytics .analytics-card:nth-child(2) .chart-placeholder');
        if (!card) return;
        
        card.innerHTML = '<canvas id="territory-distribution-chart"></canvas>';
        const ctx = document.getElementById('territory-distribution-chart').getContext('2d');
        
        if (this.territoryDistributionChart) {
            this.territoryDistributionChart.destroy();
        }
        
        this.territoryDistributionChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: data.map(d => d.country || 'Unknown'),
                datasets: [{
                    label: '영토 수',
                    data: data.map(d => parseInt(d.count, 10)),
                    backgroundColor: [
                        'rgba(255, 99, 132, 0.5)',
                        'rgba(54, 162, 235, 0.5)',
                        'rgba(255, 206, 86, 0.5)',
                        'rgba(75, 192, 192, 0.5)',
                        'rgba(153, 102, 255, 0.5)',
                        'rgba(255, 159, 64, 0.5)'
                    ],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: '영토 분포'
                    },
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }
    
    /**
     * 옥션 통계 표시
     */
    renderAuctionStats(data) {
        const container = document.querySelector('#section-analytics .analytics-card:nth-child(4) .chart-placeholder');
        if (!container) return;
        
        if (data.length === 0) {
            container.innerHTML = '<p>옥션 통계 데이터가 없습니다.</p>';
            return;
        }
        
        const statsHtml = data.map(stat => {
            const avgBid = parseFloat(stat.avg_bid || 0).toLocaleString('ko-KR');
            const totalValue = parseFloat(stat.total_value || 0).toLocaleString('ko-KR');
            return `
                <div style="margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 6px;">
                    <strong>${stat.status}</strong>
                    <ul style="margin: 5px 0 0 0; padding-left: 20px; font-size: 14px;">
                        <li>개수: ${parseInt(stat.count, 10)}개</li>
                        <li>평균 입찰가: ${avgBid} pt</li>
                        <li>총 거래액: ${totalValue} pt</li>
                    </ul>
                </div>
            `;
        }).join('');
        
        container.innerHTML = `<div style="padding: 10px;">${statsHtml}</div>`;
    }
    
    /**
     * 관리자 로그 조회
     */
    async loadAdminLogs() {
        const container = document.getElementById('admin-logs');
        if (!container) return;
        
        try {
            // ✅ 백엔드 API 사용
            const logs = await adminApi.get('/admin/logs?limit=50');
            
            if (!logs || logs.length === 0) {
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
                        ${logs.map(log => {
                            const time = log.timestamp ? new Date(log.timestamp).toLocaleString('ko-KR') : '-';
                            const details = typeof log.details === 'string' ? log.details : JSON.stringify(log.details || {});
                            return `
                                <tr>
                                    <td>${time}</td>
                                    <td>${log.adminEmail || '알 수 없음'}</td>
                                    <td><span class="log-action">${log.action}</span></td>
                                    <td><code style="font-size: 11px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">${details}</code></td>
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
    
    /**
     * 관리자 목록 로드
     */
    async loadAdminList() {
        const adminListContainer = document.getElementById('admin-list');
        if (!adminListContainer) return;
        
        try {
            // ✅ 백엔드 API에서 실제 사용자 정보 확인
            let actualUsers = new Set();
            try {
                const users = await adminApi.get('/admin/users?limit=100');
                if (Array.isArray(users)) {
                    users.forEach(user => {
                        if (user.email) {
                            actualUsers.add(user.email.toLowerCase());
                        }
                    });
                }
            } catch (error) {
                console.warn('[AdminDashboard] Failed to load actual users for admin list:', error);
            }
            
            // 관리자 목록 표시
            const adminList = ADMIN_EMAILS.map((email, index) => {
                const isSuperAdmin = email === 'admin@billionairemap.com';
                const isActualUser = actualUsers.has(email.toLowerCase());
                const userStatus = isActualUser 
                    ? '<span style="color: #28a745; font-size: 11px; margin-left: 8px; font-weight: 500;">✓ 등록됨</span>'
                    : '<span style="color: #dc3545; font-size: 11px; margin-left: 8px; font-weight: 500;">✗ 미등록</span>';
                
                // 현재 로그인한 관리자인지 확인
                const isCurrentUser = this.currentUser && this.currentUser.email && 
                                     this.currentUser.email.toLowerCase() === email.toLowerCase();
                const currentUserBadge = isCurrentUser 
                    ? '<span style="color: #0066cc; font-size: 11px; margin-left: 8px; font-weight: 600;">(현재 로그인)</span>'
                    : '';
                
                return `
                    <div class="admin-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; margin-bottom: 10px; background: ${isCurrentUser ? '#e6f3ff' : '#ffffff'}; border: 1px solid ${isCurrentUser ? '#0066cc' : '#dee2e6'}; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; margin-bottom: 4px;">
                                <span style="color: #212529; font-weight: 500; font-size: 14px;">${email}</span>
                                ${currentUserBadge}
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                ${userStatus}
                                <span class="badge ${isSuperAdmin ? 'badge-primary' : 'badge-secondary'}" style="padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: ${isSuperAdmin ? '#0066cc' : '#6c757d'}; color: white;">
                                    ${isSuperAdmin ? '👑 최고 관리자' : '👤 관리자'}
                                </span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            
            // 관리자 수 업데이트
            const adminCountEl = document.getElementById('admin-count');
            if (adminCountEl) {
                adminCountEl.textContent = ADMIN_EMAILS.length;
            }
            
            adminListContainer.innerHTML = adminList || '<div class="empty">관리자 없음</div>';
        } catch (error) {
            console.error('Failed to load admin list:', error);
            adminListContainer.innerHTML = '<div class="error">관리자 목록 로딩 실패</div>';
        }
    }
    
    /**
     * 관리자 삭제 모달 표시
     */
    showRemoveAdminModal(email) {
        if (!email) {
            alert('삭제할 관리자 이메일이 필요합니다.');
            return;
        }
        
        const isSuperAdmin = email === 'admin@billionairemap.com';
        if (isSuperAdmin) {
            alert('최고 관리자는 삭제할 수 없습니다.');
            return;
        }
        
        const isCurrentUser = this.currentUser && this.currentUser.email && 
                             this.currentUser.email.toLowerCase() === email.toLowerCase();
        if (isCurrentUser) {
            alert('현재 로그인한 관리자는 삭제할 수 없습니다.');
            return;
        }
        
        const modalHtml = `
            <div class="modal-overlay" id="remove-admin-modal-overlay" onclick="adminDashboard.closeRemoveAdminModal()">
                <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 500px;">
                    <div class="modal-header" style="background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                        <h2 style="margin: 0; color: white;">➖ 관리자 삭제</h2>
                        <button class="modal-close" onclick="adminDashboard.closeRemoveAdminModal()" style="color: white; background: rgba(255,255,255,0.2); border: none; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 20px;">×</button>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <div style="background: #fee; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #dc3545;">
                            <h3 style="margin-top: 0; margin-bottom: 10px; color: #c82333; font-size: 16px;">삭제 대상</h3>
                            <p style="margin: 0; color: #333; font-size: 14px;"><strong>${email}</strong></p>
                        </div>
                        
                        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ffc107;">
                            <h3 style="margin-top: 0; margin-bottom: 10px; color: #856404; font-size: 16px;">⚠️ 주의사항</h3>
                            <ul style="margin: 0; padding-left: 20px; color: #856404; line-height: 1.8; font-size: 13px;">
                                <li>관리자 삭제는 <strong>코드 수정</strong>이 필요합니다</li>
                                <li><code>js/admin.js</code> 파일의 <code>ADMIN_EMAILS</code> 배열에서 해당 이메일을 제거해야 합니다</li>
                                <li>삭제 후 <strong>페이지를 새로고침</strong>해야 적용됩니다</li>
                                <li>삭제된 관리자는 더 이상 관리자 대시보드에 접근할 수 없습니다</li>
                            </ul>
                        </div>
                        
                        <div style="background: #f8d7da; padding: 15px; border-radius: 8px; border: 1px solid #f5c6cb; margin-bottom: 20px;">
                            <p style="margin: 0; color: #721c24; font-size: 14px; font-weight: bold;">⚠️ 이 작업은 되돌릴 수 없습니다. 신중하게 결정하세요.</p>
                        </div>
                    </div>
                    <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding: 20px; background: #f8f9fa; border-radius: 0 0 8px 8px;">
                        <button class="btn btn-secondary" onclick="adminDashboard.closeRemoveAdminModal()" style="padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">취소</button>
                        <button class="btn btn-danger" onclick="adminDashboard.confirmRemoveAdmin('${email}')" style="padding: 10px 30px; background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">🗑️ 삭제 확인</button>
                    </div>
                </div>
            </div>
        `;
        
        // 기존 모달 제거
        const existingModal = document.getElementById('remove-admin-modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }
        
        // 모달 추가
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }
    
    closeRemoveAdminModal() {
        const modal = document.getElementById('remove-admin-modal-overlay');
        if (modal) {
            modal.remove();
        }
    }
    
    /**
     * 관리자 삭제 확인
     */
    confirmRemoveAdmin(email) {
        if (!email) {
            alert('삭제할 관리자 이메일이 필요합니다.');
            return;
        }
        
        const isSuperAdmin = email === 'admin@billionairemap.com';
        if (isSuperAdmin) {
            alert('최고 관리자는 삭제할 수 없습니다.');
            this.closeRemoveAdminModal();
            return;
        }
        
        // 코드 수정 안내
        alert(`✅ 관리자 삭제 안내:\n\n삭제할 이메일: ${email}\n\n⚠️ 실제 적용을 위해서는:\n1. js/admin.js 파일을 열어주세요\n2. ADMIN_EMAILS 배열에서 "${email}" 항목을 찾아 제거하세요\n3. 페이지를 새로고침하세요\n\n현재는 임시로 표시만 제거됩니다.`);
        
        // 로그 기록
        this.logAdminAction('REMOVE_ADMIN', { email });
        
        this.closeRemoveAdminModal();
        
        // 목록 새로고침
        this.loadAdminList();
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
                        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; border-left: 4px solid #ffc107; margin-bottom: 15px;">
                            <h3 style="margin-top: 0; margin-bottom: 10px; color: #856404; font-size: 16px;">⚠️ 주의사항</h3>
                            <ul style="margin: 0; padding-left: 20px; color: #856404; line-height: 1.8; font-size: 13px;">
                                <li>이메일은 <strong>Firebase Auth에 등록</strong>되어 있어야 합니다</li>
                                <li>관리자 ID와 비밀번호는 <strong>P키 5번 연타 로그인</strong>에 사용됩니다</li>
                                <li>추가 후 <strong>코드 수정</strong>이 필요하며, <strong>페이지 새로고침</strong> 후 적용됩니다</li>
                                <li><code>js/admin.js</code> 파일의 <code>ADMIN_EMAILS</code> 배열에 이메일을 추가해야 합니다</li>
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
            alert(`✅ 관리자 추가 정보:\n\n이메일: ${email}\n\n⚠️ 실제 적용을 위해서는:\n1. Firebase Authentication에 ${email} 계정을 만들어주세요 (비밀번호는 Firebase에서만 관리)\n2. 백엔드(Railway) 환경변수 ADMIN_EMAILS에 쉼표로 구분해 "${email}" 추가\n3. js/admin.js의 ADMIN_EMAILS 배열에도 "${email}" 추가 (대시보드 화면 표시용)\n4. 백엔드 재시작 후 페이지 새로고침`);
            
            // 임시로 세션에 저장 (실제 설정 전까지 목록 표시용)
            const tempAdmins = JSON.parse(sessionStorage.getItem('tempAdmins') || '[]');
            tempAdmins.push({
                email: email,
                id: adminId,
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

