/**
 * OnboardingGuide - 첫 방문자를 위한 튜토리얼 가이드
 * 사이트 소개 및 사용 방법 안내
 */

import { log } from '../config.js';
import { eventBus, EVENTS } from '../services/EventBus.js';

const STORAGE_KEY = 'billionaire_map_onboarding_completed';

class OnboardingGuide {
    constructor() {
        this.modal = null;
        this.slides = null;
        this.dots = null;
        this.currentSlide = 0;
        this.totalSlides = 5;
        this.isOpen = false;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.modal = document.getElementById('onboarding-modal');
        this.slides = document.getElementById('onboarding-slides');
        this.dots = document.getElementById('onboarding-dots');
        
        if (!this.modal) {
            log.warn('OnboardingGuide: Modal not found');
            return;
        }
        
        this.setupEventListeners();
        
        // 첫 방문자인지 확인
        if (this.isFirstVisit()) {
            // 약간의 딜레이 후 표시 (지도 로딩 후)
            setTimeout(() => this.show(), 1500);
        }
        
        log.info('OnboardingGuide initialized');
    }
    
    /**
     * 이벤트 리스너 설정
     */
    setupEventListeners() {
        // Skip 버튼
        const skipBtn = document.getElementById('onboarding-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => this.complete());
        }
        
        // 이전/다음 버튼
        const prevBtn = document.getElementById('onboarding-prev');
        const nextBtn = document.getElementById('onboarding-next');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.prevSlide());
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.nextSlide());
        }
        
        // 도트 클릭
        if (this.dots) {
            this.dots.querySelectorAll('.dot').forEach(dot => {
                dot.addEventListener('click', () => {
                    const slideIndex = parseInt(dot.dataset.slide);
                    this.goToSlide(slideIndex);
                });
            });
        }
        
        // 마지막 슬라이드 버튼들
        const loginBtn = document.getElementById('onboarding-login');
        const exploreBtn = document.getElementById('onboarding-explore');
        
        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                this.complete();
                // 로그인 모달 열기
                eventBus.emit(EVENTS.UI_MODAL_OPEN, { type: 'login' });
            });
        }
        
        if (exploreBtn) {
            exploreBtn.addEventListener('click', () => {
                this.complete();
            });
        }
        
        // 사이드 메뉴 튜토리얼 버튼
        const tutorialBtn = document.getElementById('side-tutorial-btn');
        if (tutorialBtn) {
            tutorialBtn.addEventListener('click', () => {
                // 사이드 메뉴 닫기
                const sideMenu = document.getElementById('side-menu');
                if (sideMenu) {
                    sideMenu.classList.add('hidden');
                }
                this.show(true); // 강제로 표시
            });
        }
        
        // 키보드 네비게이션
        document.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;
            
            if (e.key === 'ArrowRight') {
                this.nextSlide();
            } else if (e.key === 'ArrowLeft') {
                this.prevSlide();
            } else if (e.key === 'Escape') {
                this.complete();
            }
        });
        
        // 오버레이 클릭
        const overlay = this.modal.querySelector('.onboarding-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    // 오버레이 클릭 시 닫기 (옵션)
                    // this.complete();
                }
            });
        }
    }
    
    /**
     * 첫 방문 여부 확인
     */
    isFirstVisit() {
        try {
            return !localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return true;
        }
    }
    
    /**
     * 방문 완료 표시
     */
    markAsCompleted() {
        try {
            localStorage.setItem(STORAGE_KEY, Date.now().toString());
        } catch (e) {
            log.warn('Failed to save onboarding state');
        }
    }
    
    /**
     * 온보딩 표시
     */
    show(force = false) {
        if (!this.modal) return;
        
        // 이미 완료했고 강제가 아니면 표시하지 않음
        if (!force && !this.isFirstVisit()) return;
        
        this.currentSlide = 0;
        this.updateSlide();
        this.modal.classList.remove('hidden');
        this.isOpen = true;
        
        // body 스크롤 방지
        document.body.style.overflow = 'hidden';
    }
    
    /**
     * 온보딩 숨기기
     */
    hide() {
        if (!this.modal) return;
        
        this.modal.classList.add('hidden');
        this.isOpen = false;
        
        // body 스크롤 복원
        document.body.style.overflow = '';
    }
    
    /**
     * 온보딩 완료
     */
    complete() {
        this.markAsCompleted();
        this.hide();
        
        // 완료 이벤트 발행
        eventBus.emit('onboarding:complete');
    }
    
    /**
     * 다음 슬라이드
     */
    nextSlide() {
        if (this.currentSlide < this.totalSlides - 1) {
            this.goToSlide(this.currentSlide + 1);
        } else {
            // 마지막 슬라이드에서 다음 누르면 완료
            this.complete();
        }
    }
    
    /**
     * 이전 슬라이드
     */
    prevSlide() {
        if (this.currentSlide > 0) {
            this.goToSlide(this.currentSlide - 1);
        }
    }
    
    /**
     * 특정 슬라이드로 이동
     */
    goToSlide(index) {
        if (index < 0 || index >= this.totalSlides) return;
        
        const prevIndex = this.currentSlide;
        this.currentSlide = index;
        
        this.updateSlide(prevIndex < index ? 'next' : 'prev');
    }
    
    /**
     * 슬라이드 업데이트
     */
    updateSlide(direction = 'next') {
        if (!this.slides) return;
        
        // 모든 슬라이드 업데이트
        const allSlides = this.slides.querySelectorAll('.onboarding-slide');
        allSlides.forEach((slide, index) => {
            slide.classList.remove('active', 'prev');
            
            if (index === this.currentSlide) {
                slide.classList.add('active');
            } else if (index < this.currentSlide) {
                slide.classList.add('prev');
            }
        });
        
        // 도트 업데이트
        if (this.dots) {
            this.dots.querySelectorAll('.dot').forEach((dot, index) => {
                dot.classList.toggle('active', index === this.currentSlide);
            });
        }
        
        // 버튼 상태 업데이트
        const prevBtn = document.getElementById('onboarding-prev');
        const nextBtn = document.getElementById('onboarding-next');
        
        if (prevBtn) {
            prevBtn.disabled = this.currentSlide === 0;
        }
        
        if (nextBtn) {
            if (this.currentSlide === this.totalSlides - 1) {
                nextBtn.textContent = '시작하기 →';
            } else {
                nextBtn.textContent = '다음 →';
            }
        }
    }
    
    /**
     * 온보딩 리셋 (개발용)
     */
    reset() {
        try {
            localStorage.removeItem(STORAGE_KEY);
            log.info('Onboarding state reset');
        } catch (e) {
            log.warn('Failed to reset onboarding state');
        }
    }
}

// 싱글톤 인스턴스
export const onboardingGuide = new OnboardingGuide();
export default onboardingGuide;

