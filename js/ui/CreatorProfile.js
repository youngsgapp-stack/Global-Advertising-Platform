/**
 * CreatorProfile - 크리에이터 프로필 페이지
 * 사용자의 작품 목록, 통계, 랭킹 등을 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';

class CreatorProfile {
    constructor() {
        this.panel = null;
        this.currentUserId = null;
        this.isOpen = false;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.panel = document.getElementById('creator-profile-panel');
        if (!this.panel) {
            this.createPanel();
        }
        
        this.setupEventListeners();
        log.info('CreatorProfile initialized');
    }
    
    /**
     * 패널 생성
     */
    createPanel() {
        const panel = document.createElement('div');
        panel.id = 'creator-profile-panel';
        panel.className = 'side-panel creator-profile-panel hidden';
        panel.innerHTML = `
            <div class="panel-header">
                <h2>👨‍🎨 크리에이터 프로필</h2>
                <button class="close-btn" id="creator-profile-close">&times;</button>
            </div>
            <div class="panel-body">
                <div class="creator-header" id="creator-header">
                    <div class="creator-avatar">👤</div>
                    <div class="creator-info">
                        <h3 id="creator-name">Loading...</h3>
                        <p id="creator-stats">통계 로딩 중...</p>
                    </div>
                </div>
                <div class="creator-tabs">
                    <button class="tab-btn active" data-tab="artworks">🎨 작품</button>
                    <button class="tab-btn" data-tab="stats">📊 통계</button>
                    <button class="tab-btn" data-tab="ranking">🏆 랭킹</button>
                </div>
                <div class="creator-content" id="creator-content">
                    <div class="loading">로딩 중...</div>
                </div>
            </div>
        `;
        
        document.body.appendChild(panel);
        this.panel = panel;
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 닫기 버튼
        document.getElementById('creator-profile-close')?.addEventListener('click', () => {
            this.close();
        });
        
        // 탭 버튼
        this.panel?.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchTab(tab);
            });
        });
        
        // ESC 키로 닫기
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }
    
    /**
     * 프로필 열기
     */
    async open(userId = null) {
        if (!this.panel) {
            this.createPanel();
        }
        
        // 사용자 ID 설정 (없으면 현재 로그인한 사용자)
        if (!userId) {
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'warning',
                    message: '로그인이 필요합니다.'
                });
                return;
            }
            userId = currentUser.uid;
        }
        
        this.currentUserId = userId;
        this.panel.classList.remove('hidden');
        this.isOpen = true;
        
        // 프로필 데이터 로드
        await this.loadProfile();
        
        log.info(`CreatorProfile opened for user: ${userId}`);
    }
    
    /**
     * 프로필 데이터 로드
     */
    async loadProfile() {
        try {
            // 사용자 정보 로드
            const user = await apiService.getCurrentUser();
            const userName = user?.displayName || user?.email || 'Unknown';
            
            // 통계 로드
            const stats = await this.loadStats();
            
            // 헤더 업데이트
            const header = document.getElementById('creator-header');
            if (header) {
                header.querySelector('#creator-name').textContent = userName;
                header.querySelector('#creator-stats').innerHTML = `
                    <span>🎨 ${stats.artworkCount}개 작품</span> | 
                    <span>❤️ ${stats.totalLikes} 좋아요</span> | 
                    <span>💬 ${stats.totalComments} 댓글</span>
                `;
            }
            
            // 기본 탭: 작품 목록
            await this.switchTab('artworks');
            
        } catch (error) {
            log.error('[CreatorProfile] Failed to load profile:', error);
        }
    }
    
    /**
     * 통계 로드
     */
    async loadStats() {
        // 사용자의 작품 목록
        // TODO: 작품 API 엔드포인트가 있으면 사용
        // 현재는 영토 목록으로 대체
        const artworks = await apiService.getTerritories({
            limit: 100
        });
        
        const artworkCount = artworks?.length || 0;
        const totalLikes = artworks?.reduce((sum, a) => sum + (a.likeCount || 0), 0) || 0;
        const totalComments = artworks?.reduce((sum, a) => sum + (a.commentCount || 0), 0) || 0;
        
        return {
            artworkCount,
            totalLikes,
            totalComments
        };
    }
    
    /**
     * 탭 전환
     */
    async switchTab(tab) {
        // 탭 버튼 활성화 상태 업데이트
        this.panel?.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        
        const content = document.getElementById('creator-content');
        if (!content) return;
        
        content.innerHTML = '<div class="loading">로딩 중...</div>';
        
        if (tab === 'artworks') {
            await this.renderArtworks();
        } else if (tab === 'stats') {
            await this.renderStats();
        } else if (tab === 'ranking') {
            await this.renderRanking();
        }
    }
    
    /**
     * 작품 목록 렌더링
     */
    async renderArtworks() {
        const content = document.getElementById('creator-content');
        if (!content) return;
        
        try {
            // 픽셀 데이터가 있는 영토 목록 조회 후, 소유자 필터링
            const territoriesWithPixels = await apiService.getTerritoriesWithPixels();
            const artworks = [];
            
            for (const territoryId of territoriesWithPixels.slice(0, 50)) {
                try {
                    const pixelData = await apiService.getPixelData(territoryId);
                    const territory = await apiService.getTerritory(territoryId);
                    
                    // 소유자 확인 (pixelData의 ownerId와 currentUserId 비교)
                    // TODO: API에서 ownerId를 Firebase UID로 반환하도록 확인 필요
                    if (pixelData && pixelData.ownerId) {
                        // 현재는 모든 픽셀 데이터를 표시 (ownerId 매칭은 백엔드에서 처리 필요)
                        artworks.push({
                            territoryId,
                            id: territoryId,
                            ownerId: pixelData.ownerId,
                            lastUpdated: pixelData.lastUpdated,
                            filledPixels: pixelData.filledPixels || 0,
                            pixels: pixelData.pixels || []
                        });
                    }
                } catch (error) {
                    log.warn(`[CreatorProfile] Failed to load artwork for ${territoryId}:`, error);
                }
            }
            
            // 최신순 정렬
            artworks.sort((a, b) => {
                const aTime = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
                const bTime = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
                return bTime - aTime;
            });
            
            if (!artworks || artworks.length === 0) {
                content.innerHTML = '<div class="empty">작품이 없습니다.</div>';
                return;
            }
            
            // 영토 정보와 함께 렌더링
            const html = await Promise.all(
                artworks.map(async (artwork) => {
                    const territory = await apiService.getTerritory(artwork.territoryId || artwork.id);
                    const territoryName = territory?.name || territory?.territoryName || artwork.territoryId;
                    
                    return `
                        <div class="creator-artwork-item" data-territory-id="${artwork.territoryId}">
                            <div class="artwork-preview">
                                <canvas class="pixel-preview-small" data-territory-id="${artwork.territoryId}" width="50" height="50"></canvas>
                            </div>
                            <div class="artwork-info">
                                <h4>${territoryName}</h4>
                                <div class="artwork-stats">
                                    <span>❤️ ${artwork.likeCount || 0}</span>
                                    <span>💬 ${artwork.commentCount || 0}</span>
                                    <span>🎨 ${artwork.filledPixels || 0}px</span>
                                </div>
                            </div>
                        </div>
                    `;
                })
            );
            
            content.innerHTML = `
                <div class="creator-artworks-list">
                    ${html.join('')}
                </div>
            `;
            
            // 작품 클릭 이벤트
            content.querySelectorAll('.creator-artwork-item').forEach(item => {
                item.addEventListener('click', () => {
                    const territoryId = item.dataset.territoryId;
                    eventBus.emit(EVENTS.TERRITORY_SELECTED, { territoryId });
                    this.close();
                });
            });
            
        } catch (error) {
            log.error('[CreatorProfile] Failed to render artworks:', error);
            content.innerHTML = '<div class="error">작품을 불러올 수 없습니다.</div>';
        }
    }
    
    /**
     * 통계 렌더링
     */
    async renderStats() {
        const content = document.getElementById('creator-content');
        if (!content) return;
        
        try {
            const stats = await this.loadStats();
            
            // 랭킹 정보도 로드
            const ranking = await apiService.getUserRanking(this.currentUserId);
            
            content.innerHTML = `
                <div class="creator-stats-grid">
                    <div class="stat-card">
                        <h3>🎨 작품 수</h3>
                        <p class="stat-value">${stats.artworkCount}</p>
                    </div>
                    <div class="stat-card">
                        <h3>❤️ 총 좋아요</h3>
                        <p class="stat-value">${stats.totalLikes}</p>
                    </div>
                    <div class="stat-card">
                        <h3>💬 총 댓글</h3>
                        <p class="stat-value">${stats.totalComments}</p>
                    </div>
                    <div class="stat-card">
                        <h3>🏆 랭킹</h3>
                        <p class="stat-value">${ranking?.rank || 'N/A'}</p>
                    </div>
                </div>
            `;
            
        } catch (error) {
            log.error('[CreatorProfile] Failed to render stats:', error);
            content.innerHTML = '<div class="error">통계를 불러올 수 없습니다.</div>';
        }
    }
    
    /**
     * 랭킹 렌더링
     */
    async renderRanking() {
        const content = document.getElementById('creator-content');
        if (!content) return;
        
        try {
            const ranking = await apiService.getUserRanking(this.currentUserId);
            
            if (!ranking) {
                content.innerHTML = '<div class="empty">랭킹 정보가 없습니다.</div>';
                return;
            }
            
            content.innerHTML = `
                <div class="creator-ranking">
                    <div class="ranking-item">
                        <span class="ranking-label">영토 랭킹</span>
                        <span class="ranking-value">${ranking.territoryRank || 'N/A'}</span>
                    </div>
                    <div class="ranking-item">
                        <span class="ranking-label">픽셀 랭킹</span>
                        <span class="ranking-value">${ranking.pixelRank || 'N/A'}</span>
                    </div>
                    <div class="ranking-item">
                        <span class="ranking-label">가치 랭킹</span>
                        <span class="ranking-value">${ranking.valueRank || 'N/A'}</span>
                    </div>
                    <div class="ranking-item">
                        <span class="ranking-label">종합 랭킹</span>
                        <span class="ranking-value">${ranking.rank || 'N/A'}</span>
                    </div>
                </div>
            `;
            
        } catch (error) {
            log.error('[CreatorProfile] Failed to render ranking:', error);
            content.innerHTML = '<div class="error">랭킹을 불러올 수 없습니다.</div>';
        }
    }
    
    /**
     * 프로필 닫기
     */
    close() {
        if (this.panel) {
            this.panel.classList.add('hidden');
        }
        this.isOpen = false;
        this.currentUserId = null;
    }
}

// 싱글톤 인스턴스
export const creatorProfile = new CreatorProfile();
export default creatorProfile;

