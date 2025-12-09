/**
 * ContestSystem - 작품 콘테스트 시스템
 * 커뮤니티 이벤트 및 콘테스트 관리
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';

// 콘테스트 상태
export const CONTEST_STATUS = {
    UPCOMING: 'upcoming',
    ACTIVE: 'active',
    VOTING: 'voting',
    ENDED: 'ended'
};

class ContestSystem {
    constructor() {
        this.contests = [];
        this.currentContest = null;
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            await this.loadContests();
            this.setupEventListeners();
            log.info('ContestSystem initialized');
            return true;
        } catch (error) {
            log.error('ContestSystem initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 픽셀 아트 저장 시 콘테스트 자동 참여 체크
        eventBus.on(EVENTS.PIXEL_DATA_SAVED, (data) => {
            // 데이터가 없거나 territoryId가 없으면 스킵
            if (!data || !data.territoryId) {
                log.debug('[ContestSystem] PIXEL_DATA_SAVED event received without territoryId, skipping');
                return;
            }
            this.checkContestEligibility(data.territoryId);
        });
    }
    
    /**
     * 콘테스트 목록 로드
     */
    async loadContests() {
        try {
            const contests = await firebaseService.queryCollection(
                'contests',
                [],
                { field: 'startDate', direction: 'desc' },
                10
            );
            
            this.contests = contests || [];
            
            // 활성 콘테스트 찾기
            const now = new Date();
            this.currentContest = this.contests.find(contest => {
                const startDate = contest.startDate?.toDate?.() || new Date(contest.startDate);
                const endDate = contest.endDate?.toDate?.() || new Date(contest.endDate);
                return now >= startDate && now <= endDate && contest.status === CONTEST_STATUS.ACTIVE;
            });
            
            log.info(`Loaded ${this.contests.length} contests`);
        } catch (error) {
            log.warn('Failed to load contests:', error);
            this.contests = [];
        }
    }
    
    /**
     * 콘테스트 자격 확인
     */
    async checkContestEligibility(territoryId) {
        if (!this.currentContest) return;
        
        try {
            const territory = await firebaseService.getDocument('territories', territoryId);
            const pixelCanvas = await firebaseService.getDocument('pixelCanvases', territoryId);
            
            if (!territory || !pixelCanvas) return;
            
            // 콘테스트 조건 확인 (예: 특정 국가, 최소 픽셀 수 등)
            const isEligible = this.isEligibleForContest(territory, pixelCanvas);
            
            if (isEligible) {
                // 자동 참여
                await this.joinContest(territoryId, this.currentContest.id);
            }
        } catch (error) {
            log.error('[ContestSystem] Failed to check eligibility:', error);
        }
    }
    
    /**
     * 콘테스트 자격 확인
     */
    isEligibleForContest(territory, pixelCanvas) {
        if (!this.currentContest) return false;
        
        // 최소 픽셀 수 확인
        if (this.currentContest.minPixels && pixelCanvas.filledPixels < this.currentContest.minPixels) {
            return false;
        }
        
        // 국가 제한 확인
        if (this.currentContest.allowedCountries && 
            !this.currentContest.allowedCountries.includes(territory.countryIso)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * 콘테스트 참여
     */
    async joinContest(territoryId, contestId) {
        try {
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) return;
            
            // 이미 참여했는지 확인
            const existingEntry = await firebaseService.queryCollection(
                'contest_entries',
                [
                    { field: 'contestId', operator: '==', value: contestId },
                    { field: 'territoryId', operator: '==', value: territoryId }
                ],
                null,
                1
            );
            
            if (existingEntry && existingEntry.length > 0) {
                return; // 이미 참여함
            }
            
            // 참여 등록
            await firebaseService.setDocument('contest_entries', `entry_${contestId}_${territoryId}`, {
                contestId,
                territoryId,
                userId: currentUser.uid,
                userName: currentUser.displayName || currentUser.email,
                joinedAt: new Date(),
                voteCount: 0
            });
            
            log.info(`[ContestSystem] Joined contest ${contestId} with territory ${territoryId}`);
        } catch (error) {
            log.error('[ContestSystem] Failed to join contest:', error);
        }
    }
    
    /**
     * 콘테스트 투표
     */
    async voteForEntry(entryId, contestId) {
        try {
            const currentUser = firebaseService.getCurrentUser();
            if (!currentUser) {
                throw new Error('Authentication required');
            }
            
            // 중복 투표 체크
            const existingVote = await firebaseService.queryCollection(
                'contest_votes',
                [
                    { field: 'contestId', operator: '==', value: contestId },
                    { field: 'userId', operator: '==', value: currentUser.uid },
                    { field: 'entryId', operator: '==', value: entryId }
                ],
                null,
                1
            );
            
            if (existingVote && existingVote.length > 0) {
                throw new Error('Already voted for this entry');
            }
            
            // 투표 저장
            await firebaseService.setDocument('contest_votes', `vote_${contestId}_${entryId}_${currentUser.uid}`, {
                contestId,
                entryId,
                userId: currentUser.uid,
                createdAt: new Date()
            });
            
            // 엔트리의 투표 수 업데이트
            const entryRef = firebaseService._firestore.doc(
                firebaseService._firestore.getFirestore(firebaseService.app),
                'contest_entries',
                entryId
            );
            await firebaseService._firestore.updateDoc(entryRef, {
                voteCount: firebaseService._firestore.FieldValue.increment(1)
            });
            
            log.info(`[ContestSystem] Voted for entry ${entryId} in contest ${contestId}`);
            return { success: true };
        } catch (error) {
            log.error('[ContestSystem] Failed to vote:', error);
            throw error;
        }
    }
    
    /**
     * 현재 활성 콘테스트 가져오기
     */
    getCurrentContest() {
        return this.currentContest;
    }
    
    /**
     * 콘테스트 목록 가져오기
     */
    getContests() {
        return this.contests;
    }
}

// 싱글톤 인스턴스
export const contestSystem = new ContestSystem();
export default contestSystem;

