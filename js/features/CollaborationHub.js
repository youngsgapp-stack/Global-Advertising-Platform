/**
 * CollaborationHub - 공동작업/팬덤 시스템
 * 영토 협업, 기여도 추적, 보상 시스템
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { firebaseService } from '../services/FirebaseService.js';
import { apiService } from '../services/ApiService.js';
import { territoryManager } from '../core/TerritoryManager.js';

// 협업 상태
export const COLLAB_STATUS = {
    CLOSED: 'closed',       // 협업 비활성화
    OPEN: 'open',           // 협업 모집 중
    ACTIVE: 'active',       // 협업 진행 중
    COMPLETED: 'completed'  // 협업 완료
};

// 협업자 역할
export const COLLAB_ROLE = {
    OWNER: 'owner',         // 영토 소유자
    ADMIN: 'admin',         // 관리자 (부관리자)
    CONTRIBUTOR: 'contributor',  // 기여자
    VIEWER: 'viewer'        // 관람자
};

// 보상 타입
export const REWARD_TYPE = {
    BADGE: 'badge',         // 배지
    TITLE: 'title',         // 칭호
    POINTS: 'points',       // 포인트
    SPECIAL: 'special'      // 특별 보상
};

class CollaborationHub {
    constructor() {
        this.activeCollabs = new Map();  // territoryId -> collab data
        this.userContributions = new Map();  // userId -> contributions
        this.unsubscribers = [];
    }
    
    /**
     * 초기화
     */
    async initialize() {
        try {
            // 활성 협업 로드
            await this.loadActiveCollaborations();
            
            // 이벤트 리스너 설정
            this.setupEventListeners();
            
            log.info('CollaborationHub initialized');
            return true;
            
        } catch (error) {
            log.error('CollaborationHub initialization failed:', error);
            return false;
        }
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // 픽셀 그리기 이벤트 → 기여도 추적
        eventBus.on(EVENTS.PIXEL_DRAW, (data) => {
            this.trackContribution(data);
        });
        
        // 협업 참여 이벤트
        eventBus.on(EVENTS.COLLAB_JOIN, (data) => {
            this.handleJoin(data);
        });
    }
    
    /**
     * 활성 협업 로드
     */
    async loadActiveCollaborations() {
        try {
            // TODO: 협업 API 엔드포인트가 있으면 사용
            // const collabs = await apiService.get('/collaborations', {
            //     filters: [
            //         { field: 'status', op: 'in', value: [COLLAB_STATUS.OPEN, COLLAB_STATUS.ACTIVE] }
            //     ]
            // });
            const collabs = [];
            
            for (const collab of collabs) {
                this.activeCollabs.set(collab.territoryId, collab);
            }
            
            log.info(`Loaded ${collabs.length} active collaborations`);
            
        } catch (error) {
            log.warn('Failed to load collaborations:', error);
        }
    }
    
    /**
     * 협업 시작 (영토 소유자)
     */
    async openCollaboration(territoryId, settings = {}) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        const territory = territoryManager.getTerritory(territoryId);
        if (!territory || territory.ruler !== user.uid) {
            throw new Error('Only territory owner can open collaboration');
        }
        
        const collab = {
            id: `collab_${territoryId}_${Date.now()}`,
            territoryId,
            territoryName: territory.name,
            
            status: COLLAB_STATUS.OPEN,
            
            owner: user.uid,
            ownerName: user.displayName || user.email,
            
            settings: {
                maxCollaborators: settings.maxCollaborators || 50,
                deadline: settings.deadline || null,
                theme: settings.theme || null,
                description: settings.description || '',
                allowAnonymous: settings.allowAnonymous || false
            },
            
            collaborators: [{
                userId: user.uid,
                userName: user.displayName || user.email,
                role: COLLAB_ROLE.OWNER,
                joinedAt: Date.now(),
                pixelCount: 0
            }],
            
            stats: {
                totalPixels: 0,
                totalContributors: 1,
                startedAt: Date.now(),
                lastActivity: Date.now()
            },
            
            rewards: settings.rewards || [],
            
            createdAt: Date.now()
        };
        
        // ⚠️ TODO: 백엔드에 협업 API 구현 필요
        // 현재는 로컬 캐시만 사용 (백엔드 API 구현 후 마이그레이션 필요)
        // await apiService.post('/collaborations', collab);
        
        // 영토에 협업 ID 연결 (백엔드 API 사용)
        try {
            await apiService.updateTerritory(territoryId, {
                activeCollaboration: collab.id
            });
        } catch (error) {
            log.warn(`[CollaborationHub] Failed to update territory with collaboration:`, error);
        }
        
        // 로컬 캐시 업데이트
        this.activeCollabs.set(territoryId, collab);
        
        log.info(`Collaboration opened for territory: ${territoryId}`);
        
        return collab;
    }
    
    /**
     * 협업 참여
     */
    async joinCollaboration(territoryId) {
        const user = firebaseService.getCurrentUser();
        if (!user) {
            throw new Error('Authentication required');
        }
        
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) {
            throw new Error('No active collaboration for this territory');
        }
        
        if (collab.status !== COLLAB_STATUS.OPEN && collab.status !== COLLAB_STATUS.ACTIVE) {
            throw new Error('Collaboration is not accepting new members');
        }
        
        // 이미 참여 중인지 확인
        const existing = collab.collaborators.find(c => c.userId === user.uid);
        if (existing) {
            throw new Error('Already a collaborator');
        }
        
        // 최대 인원 확인
        if (collab.collaborators.length >= collab.settings.maxCollaborators) {
            throw new Error('Collaboration is full');
        }
        
        // 새 협업자 추가
        const newCollaborator = {
            userId: user.uid,
            userName: user.displayName || user.email,
            role: COLLAB_ROLE.CONTRIBUTOR,
            joinedAt: Date.now(),
            pixelCount: 0
        };
        
        collab.collaborators.push(newCollaborator);
        collab.stats.totalContributors++;
        collab.status = COLLAB_STATUS.ACTIVE;
        
        // ⚠️ TODO: 백엔드에 협업 API 구현 필요
        // 현재는 로컬 캐시만 사용 (백엔드 API 구현 후 마이그레이션 필요)
        // await apiService.put(`/collaborations/${collab.id}`, collab);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.COLLAB_JOIN, {
            territoryId,
            userId: user.uid,
            userName: newCollaborator.userName
        });
        
        eventBus.emit(EVENTS.UI_NOTIFICATION, {
            type: 'success',
            message: `${collab.territoryName.ko || collab.territoryName} 협업에 참여했습니다!`
        });
        
        return collab;
    }
    
    /**
     * 협업 나가기
     */
    async leaveCollaboration(territoryId) {
        const user = firebaseService.getCurrentUser();
        if (!user) return;
        
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) return;
        
        // 소유자는 나갈 수 없음
        const collaborator = collab.collaborators.find(c => c.userId === user.uid);
        if (!collaborator || collaborator.role === COLLAB_ROLE.OWNER) {
            throw new Error('Owner cannot leave. Close the collaboration instead.');
        }
        
        // 협업자 제거
        collab.collaborators = collab.collaborators.filter(c => c.userId !== user.uid);
        collab.stats.totalContributors--;
        
        // ⚠️ TODO: 백엔드에 협업 API 구현 필요
        // 현재는 로컬 캐시만 사용 (백엔드 API 구현 후 마이그레이션 필요)
        // await apiService.put(`/collaborations/${collab.id}`, collab);
        
        // 이벤트 발행
        eventBus.emit(EVENTS.COLLAB_LEAVE, {
            territoryId,
            userId: user.uid
        });
    }
    
    /**
     * 협업 종료 (소유자)
     */
    async closeCollaboration(territoryId) {
        const user = firebaseService.getCurrentUser();
        if (!user) return;
        
        const collab = this.activeCollabs.get(territoryId);
        if (!collab || collab.owner !== user.uid) {
            throw new Error('Only owner can close collaboration');
        }
        
        collab.status = COLLAB_STATUS.COMPLETED;
        collab.stats.completedAt = Date.now();
        
        // 보상 분배
        await this.distributeRewards(collab);
        
        // ⚠️ TODO: 백엔드에 협업 API 구현 필요
        // 현재는 로컬 캐시만 사용 (백엔드 API 구현 후 마이그레이션 필요)
        // await apiService.put(`/collaborations/${collab.id}`, collab);
        
        // 영토에서 협업 제거 (백엔드 API 사용)
        try {
            await apiService.updateTerritory(territoryId, {
                activeCollaboration: null
            });
        } catch (error) {
            log.warn(`[CollaborationHub] Failed to remove collaboration from territory:`, error);
        }
        
        // 로컬 캐시 제거
        this.activeCollabs.delete(territoryId);
        
        log.info(`Collaboration completed for territory: ${territoryId}`);
    }
    
    /**
     * 기여도 추적
     */
    trackContribution(data) {
        const { territoryId, userId, x, y, color } = data;
        
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) return;
        
        // 협업자 찾기
        const collaborator = collab.collaborators.find(c => c.userId === userId);
        if (!collaborator) return;
        
        // 기여도 증가
        collaborator.pixelCount++;
        collab.stats.totalPixels++;
        collab.stats.lastActivity = Date.now();
        
        // 마일스톤 체크
        this.checkMilestones(collab, collaborator);
    }
    
    /**
     * 마일스톤 체크
     */
    checkMilestones(collab, collaborator) {
        const milestones = [10, 50, 100, 500, 1000, 5000];
        
        for (const milestone of milestones) {
            if (collaborator.pixelCount === milestone) {
                eventBus.emit(EVENTS.UI_NOTIFICATION, {
                    type: 'success',
                    message: `🎉 ${collaborator.userName}님이 ${milestone} 픽셀 달성!`
                });
                
                // 마일스톤 보상
                this.grantMilestoneReward(collaborator.userId, milestone, collab.territoryId);
            }
        }
    }
    
    /**
     * 마일스톤 보상 지급
     */
    async grantMilestoneReward(userId, milestone, territoryId) {
        const reward = {
            type: REWARD_TYPE.BADGE,
            name: `${milestone} 픽셀 장인`,
            description: `${territoryId}에서 ${milestone} 픽셀 기여`,
            icon: this.getMilestoneIcon(milestone),
            grantedAt: Date.now()
        };
        
        // API를 통해 보상 부여 (백엔드 API 엔드포인트 필요)
        try {
            await apiService.post(`/api/users/${userId}/rewards`, { reward });
        } catch (error) {
            log.warn('Failed to grant reward:', error);
        }
    }
    
    /**
     * 마일스톤 아이콘
     */
    getMilestoneIcon(milestone) {
        const icons = {
            10: '🌱',
            50: '🌿',
            100: '🌳',
            500: '🏆',
            1000: '👑',
            5000: '💎'
        };
        return icons[milestone] || '⭐';
    }
    
    /**
     * 보상 분배 (협업 종료 시)
     */
    async distributeRewards(collab) {
        const totalPixels = collab.stats.totalPixels;
        
        for (const collaborator of collab.collaborators) {
            if (collaborator.role === COLLAB_ROLE.OWNER) continue;
            if (collaborator.pixelCount === 0) continue;
            
            const contribution = collaborator.pixelCount / totalPixels;
            
            // 기여도 배지 지급
            let badgeName, badgeIcon;
            
            if (contribution >= 0.3) {
                badgeName = '핵심 기여자';
                badgeIcon = '🌟';
            } else if (contribution >= 0.1) {
                badgeName = '주요 기여자';
                badgeIcon = '⭐';
            } else {
                badgeName = '참여자';
                badgeIcon = '✨';
            }
            
            const reward = {
                type: REWARD_TYPE.BADGE,
                name: badgeName,
                description: `${collab.territoryName.ko || collab.territoryName} 협업 참여`,
                icon: badgeIcon,
                contribution: Math.round(contribution * 100),
                territoryId: collab.territoryId,
                grantedAt: Date.now()
            };
            
            try {
                await apiService.post(`/api/users/${collaborator.userId}/rewards`, { reward });
            } catch (error) {
                log.warn(`Failed to grant reward to ${collaborator.userId}:`, error);
            }
        }
    }
    
    /**
     * 협업 리더보드
     */
    getLeaderboard(territoryId) {
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) return [];
        
        return [...collab.collaborators]
            .filter(c => c.pixelCount > 0)
            .sort((a, b) => b.pixelCount - a.pixelCount)
            .map((c, index) => ({
                rank: index + 1,
                userId: c.userId,
                userName: c.userName,
                pixelCount: c.pixelCount,
                percentage: Math.round((c.pixelCount / collab.stats.totalPixels) * 100),
                role: c.role
            }));
    }
    
    /**
     * 협업 정보 가져오기
     */
    getCollaboration(territoryId) {
        return this.activeCollabs.get(territoryId);
    }
    
    /**
     * 사용자가 협업자인지 확인
     */
    isCollaborator(territoryId, userId) {
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) return false;
        return collab.collaborators.some(c => c.userId === userId);
    }
    
    /**
     * 사용자 역할 가져오기
     */
    getUserRole(territoryId, userId) {
        const collab = this.activeCollabs.get(territoryId);
        if (!collab) return null;
        
        const collaborator = collab.collaborators.find(c => c.userId === userId);
        return collaborator?.role || null;
    }
    
    /**
     * 모든 활성 협업
     */
    getAllActiveCollaborations() {
        return Array.from(this.activeCollabs.values());
    }
    
    /**
     * 사용자 보상 가져오기
     */
    async getUserRewards(userId) {
        try {
            const data = await apiService.get(`/api/users/${userId}/rewards`);
            return data?.rewards || [];
        } catch (error) {
            log.warn('Failed to get user rewards:', error);
            return [];
        }
    }
    
    /**
     * 정리
     */
    cleanup() {
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
        this.unsubscribers = [];
        this.activeCollabs.clear();
    }
}

// 싱글톤 인스턴스
export const collaborationHub = new CollaborationHub();
export default collaborationHub;

