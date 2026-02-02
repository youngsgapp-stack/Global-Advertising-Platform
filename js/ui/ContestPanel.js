/**
 * ContestPanel - 콘테스트 패널 UI
 * 콘테스트 목록, 참여 작품, 투표 등을 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { contestSystem, CONTEST_STATUS } from '../features/ContestSystem.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';

class ContestPanel {
    constructor() {
        this.panel = null;
        this.isOpen = false;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.panel = document.getElementById('contest-panel');
        if (!this.panel) {
            this.createPanel();
        }
        
        this.setupEventListeners();
        log.info('ContestPanel initialized');
    }
    
    /**
     * 패널 생성
     */
    createPanel() {
        const panel = document.createElement('div');
        panel.id = 'contest-panel';
        panel.className = 'side-panel contest-panel hidden';
        panel.innerHTML = `
            <div class="panel-header">
                <h2>🏆 콘테스트</h2>
                <button class="close-btn" id="contest-close">&times;</button>
            </div>
            <div class="panel-body">
                <div id="contest-content">
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
        document.getElementById('contest-close')?.addEventListener('click', () => {
            this.close();
        });
        
        // ESC 키로 닫기
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }
    
    /**
     * 패널 열기
     */
    async open() {
        if (!this.panel) {
            this.createPanel();
        }
        
        this.panel.classList.remove('hidden');
        this.isOpen = true;
        
        await this.renderContests();
        
        log.info('ContestPanel opened');
    }
    
    /**
     * 패널 닫기
     */
    close() {
        if (this.panel) {
            this.panel.classList.add('hidden');
        }
        this.isOpen = false;
    }
    
    /**
     * 콘테스트 렌더링
     */
    async renderContests() {
        const content = document.getElementById('contest-content');
        if (!content) return;
        
        try {
            const currentContest = contestSystem.getCurrentContest();
            
            if (!currentContest) {
                content.innerHTML = `
                    <div class="contest-empty">
                        <p>현재 진행 중인 콘테스트가 없습니다.</p>
                        <p>곧 새로운 콘테스트가 시작될 예정입니다! 🎉</p>
                    </div>
                `;
                return;
            }
            
            // 참여 작품 목록 로드
            // TODO: 콘테스트 엔트리 조회는 API 엔드포인트가 필요
            const entries = []; // await apiService.get(`/contests/${contestId}/entries`);
            
            const entriesHtml = await Promise.all(
                (entries || []).map(async (entry, index) => {
                    const territory = await apiService.getTerritory(entry.territoryId);
                    const territoryName = territory?.name || territory?.territoryName || entry.territoryId;
                    
                    return `
                        <div class="contest-entry" data-entry-id="${entry.id}" data-territory-id="${entry.territoryId}">
                            <div class="entry-rank">#${index + 1}</div>
                            <div class="entry-info">
                                <h4>${territoryName}</h4>
                                <p>by ${entry.userName}</p>
                                <div class="entry-stats">
                                    <span>❤️ ${entry.voteCount || 0} votes</span>
                                </div>
                            </div>
                            <button class="vote-btn" data-entry-id="${entry.id}">투표</button>
                        </div>
                    `;
                })
            );
            
            content.innerHTML = `
                <div class="contest-header">
                    <h3>${currentContest.title || 'Current Contest'}</h3>
                    <p>${currentContest.description || ''}</p>
                    <div class="contest-dates">
                        <span>시작: ${new Date(currentContest.startDate).toLocaleDateString()}</span>
                        <span>종료: ${new Date(currentContest.endDate).toLocaleDateString()}</span>
                    </div>
                </div>
                <div class="contest-entries">
                    <h4>참여 작품</h4>
                    ${entriesHtml.length > 0 ? entriesHtml.join('') : '<p>아직 참여 작품이 없습니다.</p>'}
                </div>
            `;
            
            // 투표 버튼 이벤트
            content.querySelectorAll('.vote-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const entryId = e.target.dataset.entryId;
                    await this.handleVote(entryId, currentContest.id);
                });
            });
            
            // 작품 클릭 이벤트
            content.querySelectorAll('.contest-entry').forEach(entry => {
                entry.addEventListener('click', (e) => {
                    if (e.target.classList.contains('vote-btn')) return;
                    const territoryId = entry.dataset.territoryId;
                    eventBus.emit(EVENTS.TERRITORY_SELECTED, { territoryId });
                    this.close();
                });
            });
            
        } catch (error) {
            log.error('[ContestPanel] Failed to render contests:', error);
            content.innerHTML = '<div class="error">콘테스트를 불러올 수 없습니다.</div>';
        }
    }
    
    /**
     * 투표 처리
     */
    async handleVote(entryId, contestId) {
        try {
            await contestSystem.voteForEntry(entryId, contestId);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: 'Vote submitted!'
            });
            
            // 목록 새로고침
            await this.renderContests();
        } catch (error) {
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: error.message || 'Vote failed.'
            });
        }
    }
}

// 싱글톤 인스턴스
export const contestPanel = new ContestPanel();
export default contestPanel;

