/**
 * FeedbackService - "Send Feedback" form (saved on the server, read in the admin page)
 */

import { log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

class FeedbackService {
    async submitFeedback(feedbackData) {
        try {
            const { apiService } = await import('./ApiService.js');
            await apiService.post('/feedback', {
                type: feedbackData.type || 'general',
                title: feedbackData.title || '',
                message: feedbackData.message || '',
                rating: feedbackData.rating || null,
                pageUrl: window.location.href
            });
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'success',
                message: 'Thanks! Your feedback was sent.'
            });
            return true;
        } catch (error) {
            log.error('[FeedbackService] Failed to submit feedback:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                type: 'error',
                message: error?.status === 429
                    ? 'You sent a lot of feedback just now. Please try again in a few minutes.'
                    : 'Could not send your feedback. Please try again, or email youngs.gapp@gmail.com.'
            });
            return false;
        }
    }
    
    createFeedbackButton() {
        const button = document.createElement('button');
        button.id = 'feedback-button';
        button.className = 'feedback-button';
        button.innerHTML = '💬';
        button.title = 'Send feedback';
        button.setAttribute('aria-label', 'Send feedback');
        button.addEventListener('click', () => this.showFeedbackModal());
        return button;
    }
    
    showFeedbackModal() {
        document.querySelector('.feedback-modal')?.remove();
        
        const modal = document.createElement('div');
        modal.className = 'modal feedback-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-labelledby', 'feedback-modal-title');
        modal.innerHTML = `
            <div class="modal-overlay"></div>
            <div class="modal-content feedback-modal-content">
                <button class="modal-close" id="close-feedback-modal" aria-label="Close">&times;</button>
                <div class="modal-header">
                    <h2 id="feedback-modal-title">💬 Send Feedback</h2>
                    <p>Found a bug or have an idea? Tell us — we read every message.</p>
                </div>
                <form id="feedback-form" class="feedback-form">
                    <div class="form-group">
                        <label for="feedback-type">Type</label>
                        <select id="feedback-type" name="type" required>
                            <option value="general">General</option>
                            <option value="bug">Bug report</option>
                            <option value="feature">Feature idea</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="feedback-title">Title</label>
                        <input type="text" id="feedback-title" name="title" maxlength="120" placeholder="A short summary" required>
                    </div>
                    <div class="form-group">
                        <label for="feedback-message">Message</label>
                        <textarea id="feedback-message" name="message" rows="6" maxlength="2000" placeholder="What happened, or what would you like?" required></textarea>
                    </div>
                    <div class="form-group">
                        <label>How do you like it so far?</label>
                        <div class="rating-input">
                            ${[1, 2, 3, 4, 5].map(i => `
                                <button type="button" class="rating-star" data-rating="${i}" aria-label="${i} star${i > 1 ? 's' : ''}">⭐</button>
                            `).join('')}
                        </div>
                        <input type="hidden" id="feedback-rating" name="rating" value="">
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-feedback">Cancel</button>
                        <button type="submit" class="btn-primary" id="submit-feedback">Send</button>
                    </div>
                </form>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const close = () => modal.remove();
        modal.querySelector('#close-feedback-modal')?.addEventListener('click', close);
        modal.querySelector('#cancel-feedback')?.addEventListener('click', close);
        modal.querySelector('.modal-overlay')?.addEventListener('click', close);
        
        modal.querySelectorAll('.rating-star').forEach(star => {
            star.addEventListener('click', (e) => {
                const rating = parseInt(e.currentTarget.dataset.rating, 10);
                modal.querySelector('#feedback-rating').value = rating;
                modal.querySelectorAll('.rating-star').forEach((s, i) => {
                    s.style.opacity = i < rating ? '1' : '0.3';
                });
            });
        });
        
        modal.querySelector('#feedback-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitButton = modal.querySelector('#submit-feedback');
            submitButton.disabled = true;
            const formData = new FormData(e.target);
            const sent = await this.submitFeedback({
                type: formData.get('type'),
                title: formData.get('title'),
                message: formData.get('message'),
                rating: formData.get('rating') || null
            });
            if (sent) {
                close();
            } else {
                submitButton.disabled = false;
            }
        });
        
        modal.querySelector('#feedback-title')?.focus();
    }
}

export const feedbackService = new FeedbackService();
export default feedbackService;
