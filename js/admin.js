/**
 * Admin Dashboard - 관리자 대시보드
 * 사용자, 영토, 옥션 관리 및 분석
 */

import { CONFIG } from './config.js';

// Firebase 설정
const firebaseConfig = CONFIG.FIREBASE;

// 관리자 이메일 목록 (Firebase Auth 사용 시)
const ADMIN_EMAILS = [
    'admin@billionairemap.com',
    'young91@naver.com',
];

// 로컬 관리자 계정 (P키 5번 연타 로그인용)
const LOCAL_ADMIN_CREDENTIALS = {
    'admin': 'billionaire2024!',
    'young91': 'admin1234!'
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
    }
    
    /**
     * 초기화
     */
    async init() {
        try {
            // 1. 먼저 세션 인증 확인 (P키 5번 로그인)
            const sessionAuth = this.checkSessionAuth();
            if (sessionAuth) {
                console.log('Session auth valid:', sessionAuth.id);
                this.currentUser = { email: sessionAuth.id, uid: 'local-' + sessionAuth.id };
                this.isLocalAuth = true;
                
                // Firebase 초기화 (Firestore 사용을 위해)
                this.firebase = firebase.initializeApp(firebaseConfig);
                this.db = firebase.firestore();
                
                this.showDashboard();
                this.loadDashboardData();
                this.setupEventListeners();
                return;
            }
            
            // 2. Firebase 초기화 및 Auth
            this.firebase = firebase.initializeApp(firebaseConfig);
            this.auth = firebase.auth();
            this.db = firebase.firestore();
            
            // 인증 상태 감시
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
            this.showLoginScreen();
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
     * 에러 메시지 변환
     */
    getErrorMessage(code) {
        const messages = {
            'auth/user-not-found': 'User not found',
            'auth/wrong-password': 'Incorrect password',
            'auth/invalid-email': 'Invalid email address',
            'auth/too-many-requests': 'Too many attempts. Try again later.',
            'auth/invalid-credential': 'Invalid credentials'
        };
        return messages[code] || 'Login failed. Please try again.';
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
        
        // 제목 업데이트
        const titles = {
            'overview': 'Overview',
            'users': 'User Management',
            'territories': 'Territory Management',
            'auctions': 'Auction Management',
            'analytics': 'Analytics',
            'logs': 'Admin Logs',
            'settings': 'Settings'
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
            
            // 영토 수
            const territoriesSnapshot = await this.db.collection('territories')
                .where('sovereignty', '==', 'ruled').get();
            document.getElementById('stat-territories').textContent = territoriesSnapshot.size;
            
            // 총 수익 (예시)
            let totalRevenue = 0;
            territoriesSnapshot.forEach(doc => {
                totalRevenue += doc.data().price || 0;
            });
            document.getElementById('stat-revenue').textContent = '$' + totalRevenue.toLocaleString();
            
            // 활성 옥션
            const auctionsSnapshot = await this.db.collection('auctions')
                .where('status', '==', 'active').get();
            document.getElementById('stat-active').textContent = auctionsSnapshot.size;
            
        } catch (error) {
            console.error('Failed to load stats:', error);
            // 기본값 표시
            document.getElementById('stat-users').textContent = '0';
            document.getElementById('stat-territories').textContent = '0';
            document.getElementById('stat-revenue').textContent = '$0';
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
                container.innerHTML = '<div class="empty">No recent activity</div>';
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
            container.innerHTML = '<div class="empty">Failed to load activity</div>';
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
                container.innerHTML = '<div class="empty">No users yet</div>';
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
            container.innerHTML = '<div class="empty">Failed to load users</div>';
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
        }
    }
    
    /**
     * 사용자 테이블 로드
     */
    async loadUsersTable() {
        const tbody = document.querySelector('#users-table tbody');
        
        try {
            const snapshot = await this.db.collection('users').limit(50).get();
            
            if (snapshot.empty) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No users</td></tr>';
                return;
            }
            
            tbody.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                const joined = data.createdAt?.toDate()?.toLocaleDateString() || 'N/A';
                const status = data.banned ? 'Banned' : 'Active';
                const statusClass = data.banned ? 'status-banned' : 'status-active';
                
                return `
                    <tr>
                        <td>${data.displayName || 'Anonymous'}</td>
                        <td>${data.email || doc.id}</td>
                        <td>${data.territoryCount || 0}</td>
                        <td>${joined}</td>
                        <td><span class="status ${statusClass}">${status}</span></td>
                        <td>
                            <button class="btn btn-sm" onclick="adminDashboard.viewUser('${doc.id}')">View</button>
                            <button class="btn btn-sm btn-danger" onclick="adminDashboard.banUser('${doc.id}')">Ban</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load users:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="error">Failed to load users</td></tr>';
        }
    }
    
    /**
     * 영토 테이블 로드
     */
    async loadTerritoriesTable() {
        const tbody = document.querySelector('#territories-table tbody');
        
        try {
            const snapshot = await this.db.collection('territories').limit(50).get();
            
            if (snapshot.empty) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No territories</td></tr>';
                return;
            }
            
            tbody.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                
                return `
                    <tr>
                        <td>${data.name || doc.id}</td>
                        <td>${data.country || 'N/A'}</td>
                        <td>${data.rulerName || 'Unclaimed'}</td>
                        <td>$${(data.price || 0).toLocaleString()}</td>
                        <td>${(data.pixelCount || 0).toLocaleString()}</td>
                        <td>
                            <button class="btn btn-sm" onclick="adminDashboard.viewTerritory('${doc.id}')">View</button>
                            <button class="btn btn-sm" onclick="adminDashboard.editTerritory('${doc.id}')">Edit</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load territories:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="error">Failed to load territories</td></tr>';
        }
    }
    
    /**
     * 옥션 테이블 로드
     */
    async loadAuctionsTable() {
        const tbody = document.querySelector('#auctions-table tbody');
        
        try {
            const snapshot = await this.db.collection('auctions').limit(50).get();
            
            if (snapshot.empty) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No auctions</td></tr>';
                return;
            }
            
            tbody.innerHTML = snapshot.docs.map(doc => {
                const data = doc.data();
                const endsAt = data.endsAt?.toDate()?.toLocaleString() || 'N/A';
                const statusClass = data.status === 'active' ? 'status-active' : 'status-ended';
                
                return `
                    <tr>
                        <td>${data.territoryId || doc.id}</td>
                        <td>$${(data.currentBid || data.startingPrice || 0).toLocaleString()}</td>
                        <td>${data.bidCount || 0}</td>
                        <td>${endsAt}</td>
                        <td><span class="status ${statusClass}">${data.status}</span></td>
                        <td>
                            <button class="btn btn-sm" onclick="adminDashboard.viewAuction('${doc.id}')">View</button>
                            ${data.status === 'active' ? 
                                `<button class="btn btn-sm btn-danger" onclick="adminDashboard.endAuction('${doc.id}')">End</button>` 
                                : ''
                            }
                        </td>
                    </tr>
                `;
            }).join('');
            
        } catch (error) {
            console.error('Failed to load auctions:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="error">Failed to load auctions</td></tr>';
        }
    }
    
    /**
     * 사용자 모드 토글
     */
    toggleUserMode() {
        this.isUserMode = !this.isUserMode;
        
        if (this.isUserMode) {
            // 사용자 모드로 전환 - 메인 페이지로 이동
            window.open('index.html', '_blank');
            document.getElementById('user-mode-banner').classList.remove('hidden');
        } else {
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
    
    viewUser(userId) {
        console.log('View user:', userId);
        this.logAdminAction('VIEW_USER', { userId });
    }
    
    async banUser(userId) {
        if (confirm('Are you sure you want to ban this user?')) {
            try {
                await this.db.collection('users').doc(userId).update({
                    banned: true,
                    bannedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    bannedBy: this.currentUser.email
                });
                this.logAdminAction('BAN_USER', { userId });
                this.loadUsersTable(); // Refresh
                alert('User has been banned.');
            } catch (error) {
                console.error('Failed to ban user:', error);
                alert('Failed to ban user.');
            }
        }
    }
    
    viewTerritory(territoryId) {
        console.log('View territory:', territoryId);
        this.logAdminAction('VIEW_TERRITORY', { territoryId });
    }
    
    async editTerritory(territoryId) {
        const newPrice = prompt('Enter new price (leave empty to cancel):');
        if (newPrice !== null && newPrice !== '') {
            try {
                await this.db.collection('territories').doc(territoryId).update({
                    price: parseFloat(newPrice),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedBy: this.currentUser.email
                });
                this.logAdminAction('EDIT_TERRITORY', { territoryId, newPrice });
                this.loadTerritoriesTable(); // Refresh
                alert('Territory updated.');
            } catch (error) {
                console.error('Failed to edit territory:', error);
                alert('Failed to update territory.');
            }
        }
    }
    
    viewAuction(auctionId) {
        console.log('View auction:', auctionId);
        this.logAdminAction('VIEW_AUCTION', { auctionId });
    }
    
    async endAuction(auctionId) {
        if (confirm('Are you sure you want to end this auction?')) {
            try {
                await this.db.collection('auctions').doc(auctionId).update({
                    status: 'ended',
                    endedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    endedBy: this.currentUser.email,
                    reason: 'Manually ended by admin'
                });
                this.logAdminAction('END_AUCTION', { auctionId });
                this.loadAuctionsTable(); // Refresh
                alert('Auction has been ended.');
            } catch (error) {
                console.error('Failed to end auction:', error);
                alert('Failed to end auction.');
            }
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
                container.innerHTML = '<div class="empty">No admin logs</div>';
                return;
            }
            
            container.innerHTML = `
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Admin</th>
                            <th>Action</th>
                            <th>Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${snapshot.docs.map(doc => {
                            const data = doc.data();
                            const time = data.timestamp?.toDate()?.toLocaleString() || 'N/A';
                            return `
                                <tr>
                                    <td>${time}</td>
                                    <td>${data.adminEmail || 'Unknown'}</td>
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
            container.innerHTML = '<div class="error">Failed to load logs</div>';
        }
    }
    
    // === 데이터 백업 ===
    
    /**
     * 데이터 백업 (JSON 다운로드)
     */
    async backupData() {
        if (!confirm('Download a backup of all data?')) return;
        
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
            alert('Backup downloaded successfully!');
            
        } catch (error) {
            console.error('Failed to backup data:', error);
            alert('Failed to backup data. Check console for details.');
        }
    }
    
    /**
     * 데이터 복원 (JSON 업로드)
     */
    async restoreData() {
        if (!confirm('WARNING: This will overwrite existing data. Are you sure?')) return;
        
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
                    throw new Error('Invalid backup file format');
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
                
                alert('Data restored successfully! Refreshing...');
                location.reload();
                
            } catch (error) {
                console.error('Failed to restore data:', error);
                alert('Failed to restore data: ' + error.message);
            }
        };
        
        input.click();
    }
}

// 전역 인스턴스
const adminDashboard = new AdminDashboard();
window.adminDashboard = adminDashboard;

// DOM 로드 후 초기화
document.addEventListener('DOMContentLoaded', () => {
    adminDashboard.init();
});

export default adminDashboard;

