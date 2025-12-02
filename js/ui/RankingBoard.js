/**
 * RankingBoard - 랭킹 보드 UI
 * 세계 패권 보드, 국가별 점령도, 사용자 랭킹
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { rankingSystem, RANKING_TYPE } from '../features/RankingSystem.js';
import { firebaseService } from '../services/FirebaseService.js';

class RankingBoard {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTab = 'hegemony';
    }
    
    /**
     * 초기화
     */
    initialize(containerId = 'ranking-board') {
        this.container = document.getElementById(containerId);
        
        if (this.container) {
            this.render();
            this.setupEventListeners();
        }
        
        log.info('RankingBoard initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 랭킹 업데이트 이벤트
        eventBus.on(EVENTS.RANKING_UPDATE, () => {
            this.refresh();
        });
        
        // 탭 클릭 이벤트
        this.container?.querySelectorAll('.ranking-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });
    }
    
    /**
     * 렌더링
     */
    render() {
        if (!this.container) return;
        
        this.container.innerHTML = `
            <div class="ranking-header">
                <h3 class="ranking-title" id="ranking-title" style="cursor: pointer;">🏆 Global Rankings</h3>
                <button class="ranking-refresh-btn" id="ranking-refresh">🔄</button>
            </div>
            
            <div class="ranking-tabs">
                <button class="ranking-tab active" data-tab="hegemony">Score</button>
                <button class="ranking-tab" data-tab="territories">Spots</button>
                <button class="ranking-tab" data-tab="pixels">Pixels</button>
                <button class="ranking-tab" data-tab="countries">Countries</button>
            </div>
            
            <div class="ranking-content">
                <div class="ranking-list" id="ranking-list">
                    ${this.renderHegemonyRanking()}
                </div>
            </div>
            
            <div class="my-ranking" id="my-ranking">
                ${this.renderMyRanking()}
            </div>
        `;
        
        // 새로고침 버튼
        document.getElementById('ranking-refresh')?.addEventListener('click', () => {
            this.refresh();
        });
        
        // 제목 클릭 → 전체 화면 모달
        document.getElementById('ranking-title')?.addEventListener('click', () => {
            this.openFullScreen();
        });
        
        // 탭 버튼
        this.container.querySelectorAll('.ranking-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchTab(tab.dataset.tab);
            });
        });
    }
    
    /**
     * 탭 전환
     */
    switchTab(tabName) {
        this.currentTab = tabName;
        
        // 탭 활성화 상태 업데이트
        this.container.querySelectorAll('.ranking-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        
        // 콘텐츠 업데이트
        const listContainer = document.getElementById('ranking-list');
        if (!listContainer) return;
        
        switch (tabName) {
            case 'hegemony':
                listContainer.innerHTML = this.renderHegemonyRanking();
                break;
            case 'territories':
                listContainer.innerHTML = this.renderTerritoryRanking();
                break;
            case 'pixels':
                listContainer.innerHTML = this.renderPixelRanking();
                break;
            case 'countries':
                listContainer.innerHTML = this.renderCountryOccupation();
                break;
        }
    }
    
    /**
     * 패권 랭킹 렌더링
     */
    renderHegemonyRanking() {
        const hegemonyBoard = rankingSystem.getHegemonyBoard();
        
        if (hegemonyBoard.length === 0) {
            return '<div class="ranking-empty">No claimed spots yet.</div>';
        }
        
        return hegemonyBoard.map((entry, index) => `
            <div class="rank-item ${this.getRankClass(index + 1)}">
                <div class="rank-number">${this.getRankIcon(index + 1)}</div>
                <div class="rank-info">
                    <span class="rank-user">${entry.userName || entry.userId}</span>
                    <span class="rank-details">
                        ${entry.territoryCount} spots · ${entry.countryCount} countries
                    </span>
                </div>
                <div class="rank-score">${this.formatScore(entry.hegemonyScore)}</div>
            </div>
        `).join('');
    }
    
    /**
     * 영토 수 랭킹 렌더링
     */
    renderTerritoryRanking() {
        const rankings = rankingSystem.getRankingByType(RANKING_TYPE.TERRITORY_COUNT, 10);
        
        if (rankings.length === 0) {
            return '<div class="ranking-empty">No data available.</div>';
        }
        
        return rankings.map((entry, index) => `
            <div class="rank-item ${this.getRankClass(index + 1)}">
                <div class="rank-number">${this.getRankIcon(index + 1)}</div>
                <div class="rank-info">
                    <span class="rank-user">${entry.userName || entry.userId}</span>
                </div>
                <div class="rank-score">${entry.territoryCount} 🗺️</div>
            </div>
        `).join('');
    }
    
    /**
     * 픽셀 랭킹 렌더링
     */
    renderPixelRanking() {
        const rankings = rankingSystem.getRankingByType(RANKING_TYPE.PIXEL_COVERAGE, 10);
        
        if (rankings.length === 0) {
            return '<div class="ranking-empty">No data available.</div>';
        }
        
        return rankings.map((entry, index) => `
            <div class="rank-item ${this.getRankClass(index + 1)}">
                <div class="rank-number">${this.getRankIcon(index + 1)}</div>
                <div class="rank-info">
                    <span class="rank-user">${entry.userName || entry.userId}</span>
                </div>
                <div class="rank-score">${this.formatNumber(entry.totalPixels)} 🎨</div>
            </div>
        `).join('');
    }
    
    /**
     * 국가 점령도 렌더링
     */
    renderCountryOccupation() {
        const occupations = rankingSystem.getAllCountryOccupations();
        const countries = Object.entries(occupations)
            .filter(([_, data]) => data.occupied > 0)
            .sort((a, b) => b[1].percentage - a[1].percentage)
            .slice(0, 10);
        
        if (countries.length === 0) {
            return '<div class="ranking-empty">No countries claimed yet.</div>';
        }
        
        return countries.map(([code, data]) => {
            const countryInfo = CONFIG.COUNTRIES[code] || { flag: '🏳️', name: code };
            
            return `
                <div class="country-occupation-item">
                    <div class="country-info">
                        <span class="country-flag">${countryInfo.flag}</span>
                        <span class="country-name">${countryInfo.name}</span>
                    </div>
                    <div class="occupation-bar-container">
                        <div class="occupation-bar" style="width: ${data.percentage}%"></div>
                    </div>
                    <div class="occupation-stats">
                        <span class="percentage">${data.percentage}%</span>
                        <span class="count">(${data.occupied}/${data.total})</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    /**
     * 내 랭킹 렌더링
     */
    renderMyRanking() {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            return `
                <div class="my-ranking-login">
                    <span>Sign in to see your ranking</span>
                </div>
            `;
        }
        
        const myRanking = rankingSystem.getUserRanking(user.uid);
        const globalRank = rankingSystem.getUserGlobalRank(user.uid);
        
        if (!myRanking) {
            return `
                <div class="my-ranking-empty">
                    <span>No spots owned yet</span>
                    <span>Claim your first spot! 📍</span>
                </div>
            `;
        }
        
        return `
            <div class="my-ranking-card">
                <div class="my-rank-header">
                    <span class="my-rank-label">My Rank</span>
                    <span class="my-rank-number">#${globalRank || '-'}</span>
                </div>
                <div class="my-rank-stats">
                    <div class="my-stat">
                        <span class="stat-value">${myRanking.territoryCount}</span>
                        <span class="stat-label">Spots</span>
                    </div>
                    <div class="my-stat">
                        <span class="stat-value">${this.formatNumber(myRanking.totalPixels)}</span>
                        <span class="stat-label">Pixels</span>
                    </div>
                    <div class="my-stat">
                        <span class="stat-value">${this.formatScore(myRanking.hegemonyScore)}</span>
                        <span class="stat-label">Score</span>
                    </div>
                </div>
            </div>
        `;
    }
    
    /**
     * 새로고침
     */
    async refresh() {
        await rankingSystem.updateAllRankings();
        this.switchTab(this.currentTab);
        
        // 내 랭킹 업데이트
        const myRankingEl = document.getElementById('my-ranking');
        if (myRankingEl) {
            myRankingEl.innerHTML = this.renderMyRanking();
        }
    }
    
    /**
     * 랭크 클래스
     */
    getRankClass(rank) {
        if (rank === 1) return 'rank-1';
        if (rank === 2) return 'rank-2';
        if (rank === 3) return 'rank-3';
        return '';
    }
    
    /**
     * 랭크 아이콘
     */
    getRankIcon(rank) {
        const icons = { 1: '🥇', 2: '🥈', 3: '🥉' };
        return icons[rank] || rank;
    }
    
    /**
     * 점수 포맷
     */
    formatScore(score) {
        if (!score) return '0';
        if (score >= 1000000) return `${(score / 1000000).toFixed(1)}M`;
        if (score >= 1000) return `${(score / 1000).toFixed(1)}K`;
        return score.toString();
    }
    
    /**
     * 숫자 포맷
     */
    formatNumber(num) {
        if (!num) return '0';
        return num.toLocaleString();
    }
    
    /**
     * 전체 화면 모달로 열기
     */
    openFullScreen() {
        const modal = document.createElement('div');
        modal.className = 'modal ranking-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;
        
        modal.innerHTML = `
            <div class="modal-content ranking-modal-content" style="
                background: #1a1a2e;
                border-radius: 16px;
                border: 1px solid rgba(255,255,255,0.1);
                max-width: 700px;
                width: 90%;
                max-height: 85vh;
                overflow: hidden;
            ">
                <div class="modal-header" style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 20px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                    background: linear-gradient(135deg, rgba(78, 205, 196, 0.15) 0%, rgba(78, 205, 196, 0.05) 100%);
                ">
                    <h2 style="margin: 0; font-size: 1.5rem; color: white;">🏆 Global Rankings</h2>
                    <button id="close-ranking-modal" style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        border: 2px solid rgba(255, 107, 107, 0.5);
                        background: rgba(255, 107, 107, 0.3);
                        color: white;
                        font-size: 24px;
                        font-weight: bold;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">×</button>
                </div>
                <div class="modal-body" style="
                    padding: 20px;
                    max-height: calc(85vh - 80px);
                    overflow-y: auto;
                    color: white;
                ">
                    ${this.container.innerHTML}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 닫기 버튼
        document.getElementById('close-ranking-modal')?.addEventListener('click', () => {
            modal.remove();
        });
        
        // 배경 클릭으로 닫기
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        // ESC 키로 닫기
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
}

// 싱글톤 인스턴스
export const rankingBoard = new RankingBoard();
export default rankingBoard;

