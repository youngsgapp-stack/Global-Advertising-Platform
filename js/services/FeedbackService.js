/**
 * FeedbackService - 피드백 수집 서비스
 * 사용자 피드백 및 설문 조사
 */

import { CONFIG, log } from '../config.js';
import { firebaseService } from './FirebaseService.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class FeedbackService {
    constructor() {
        this.feedbackCollection = 'user_feedback';
        this.surveyCollection = 'user_surveys';
    }
    
    /**
     * 피드백 제출
     */
    async submitFeedback(feedbackData) {
        try {
            const user = firebaseService.getCurrentUser();
            const Timestamp = firebaseService.getTimestamp();
            
            const feedback = {
                userId: user?.uid || 'anonymous',
                userEmail: user?.email || null,
                type: feedbackData.type || 'general', // 'general', 'bug', 'feature', 'other'
                category: feedbackData.category || 'other',
                title: feedbackData.title || '',
                message: feedbackData.message || '',
                rating: feedbackData.rating || null,
                url: window.location.href,
                userAgent: navigator.userAgent,
                createdAt: Timestamp ? Timestamp.now() : new Date(),
                status: 'pending',
                resolved: false
            };
            
            await firebaseService.addDocument(this.feedbackCollection, feedback);
            
            log.info('[FeedbackService] Feedback submitted:', feedback);
            
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: '피드백이 제출되었습니다. 감사합니다!'
            });
            
            return true;
        } catch (error) {
            log.error('[FeedbackService] Failed to submit feedback:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: '피드백 제출에 실패했습니다. 다시 시도해주세요.'
            });
            return false;
        }
    }
    
    /**
     * 설문 조사 제출
     */
    async submitSurvey(surveyData) {
        try {
            const user = firebaseService.getCurrentUser();
            const Timestamp = firebaseService.getTimestamp();
            
            const survey = {
                userId: user?.uid || 'anonymous',
                userEmail: user?.email || null,
                surveyId: surveyData.surveyId,
                surveyVersion: surveyData.version || '1.0',
                responses: surveyData.responses || {},
                completed: surveyData.completed || false,
                timeSpent: surveyData.timeSpent || null,
                createdAt: Timestamp ? Timestamp.now() : new Date()
            };
            
            await firebaseService.addDocument(this.surveyCollection, survey);
            
            log.info('[FeedbackService] Survey submitted:', survey);
            
            return true;
        } catch (error) {
            log.error('[FeedbackService] Failed to submit survey:', error);
            return false;
        }
    }
    
    /**
     * 피드백 UI 생성
     */
    createFeedbackButton() {
        const button = document.createElement('button');
        button.id = 'feedback-button';
        button.className = 'feedback-button';
        button.innerHTML = '💬';
        button.title = '피드백 보내기';
        button.setAttribute('aria-label', '피드백 보내기');
        
        button.addEventListener('click', () => {
            this.showFeedbackModal();
        });
        
        return button;
    }
    
    /**
     * 피드백 모달 표시
     */
    showFeedbackModal() {
        const existingModal = document.querySelector('.feedback-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        const modal = document.createElement('div');
        modal.className = 'modal feedback-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-labelledby', 'feedback-modal-title');
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content feedback-modal-content">
                <button class="modal-close" id="close-feedback-modal" aria-label="닫기">&times;</button>
                <div class="modal-header">
                    <h2 id="feedback-modal-title">💬 피드백 보내기</h2>
                    <p>의견을 남겨주시면 서비스 개선에 도움이 됩니다.</p>
                </div>
                <form id="feedback-form" class="feedback-form">
                    <div class="form-group">
                        <label for="feedback-type">유형</label>
                        <select id="feedback-type" name="type" required>
                            <option value="general">일반 피드백</option>
                            <option value="bug">버그 신고</option>
                            <option value="feature">기능 제안</option>
                            <option value="other">기타</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="feedback-title">제목</label>
                        <input type="text" id="feedback-title" name="title" placeholder="간단한 제목을 입력하세요" required>
                    </div>
                    <div class="form-group">
                        <label for="feedback-message">내용</label>
                        <textarea id="feedback-message" name="message" rows="6" placeholder="자세한 내용을 입력하세요" required></textarea>
                    </div>
                    <div class="form-group">
                        <label for="feedback-rating">만족도</label>
                        <div class="rating-input">
                            ${[1, 2, 3, 4, 5].map(i => `
                                <button type="button" class="rating-star" data-rating="${i}" aria-label="${i}점">⭐</button>
                            `).join('')}
                        </div>
                        <input type="hidden" id="feedback-rating" name="rating" value="">
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-feedback">취소</button>
                        <button type="submit" class="btn-primary">제출</button>
                    </div>
                </form>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 이벤트 바인딩
        document.getElementById('close-feedback-modal')?.addEventListener('click', () => {
            modal.remove();
        });
        
        document.getElementById('cancel-feedback')?.addEventListener('click', () => {
            modal.remove();
        });
        
        modal.querySelector('.modal-overlay')?.addEventListener('click', () => {
            modal.remove();
        });
        
        // 별점 클릭
        modal.querySelectorAll('.rating-star').forEach(star => {
            star.addEventListener('click', (e) => {
                const rating = parseInt(e.currentTarget.dataset.rating);
                const hiddenInput = document.getElementById('feedback-rating');
                hiddenInput.value = rating;
                
                // 별점 업데이트
                modal.querySelectorAll('.rating-star').forEach((s, i) => {
                    if (i < rating) {
                        s.style.opacity = '1';
                    } else {
                        s.style.opacity = '0.3';
                    }
                });
            });
        });
        
        // 폼 제출
        document.getElementById('feedback-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const feedbackData = {
                type: formData.get('type'),
                title: formData.get('title'),
                message: formData.get('message'),
                rating: formData.get('rating') || null
            };
            
            const submitted = await this.submitFeedback(feedbackData);
            if (submitted) {
                modal.remove();
            }
        });
        
        // 포커스 설정
        document.getElementById('feedback-title')?.focus();
    }
}

export const feedbackService = new FeedbackService();
export default feedbackService;

