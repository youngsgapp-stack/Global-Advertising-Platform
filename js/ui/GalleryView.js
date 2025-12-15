/**
 * GalleryView - 작품 갤러리 뷰
 * 인기 작품, 크리에이터 작품, 최신 작품 등을 표시
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { apiService } from '../services/ApiService.js';

class GalleryView {
    constructor() {
        this.panel = null;
        this.currentFilter = 'popular'; // popular, recent, creators
        this.artworks = [];
        this.isOpen = false;
    }
    
    /**
     * 초기화
     */
    initialize() {
        this.panel = document.getElementById('gallery-panel');
        if (!this.panel) {
            this.createPanel();
        }
        
        this.setupEventListeners();
        log.info('GalleryView initialized');
    }
    
    /**
     * 패널 생성
     */
    createPanel() {
        const panel = document.createElement('div');
        panel.id = 'gallery-panel';
        panel.className = 'side-panel gallery-panel hidden';
        panel.innerHTML = `
            <div class="panel-header">
                <h2>🎨 작품 갤러리</h2>
                <button class="close-btn" id="gallery-close">&times;</button>
            </div>
            <div class="panel-body">
                <div class="gallery-filters">
                    <button class="filter-btn active" data-filter="popular">🔥 인기</button>
                    <button class="filter-btn" data-filter="recent">🆕 최신</button>
                    <button class="filter-btn" data-filter="creators">👨‍🎨 크리에이터</button>
                </div>
                <div class="gallery-grid" id="gallery-grid">
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
        document.getElementById('gallery-close')?.addEventListener('click', () => {
            this.close();
        });
        
        // 필터 버튼
        this.panel?.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filter = e.target.dataset.filter;
                this.setFilter(filter);
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
     * 필터 설정
     */
    async setFilter(filter) {
        this.currentFilter = filter;
        
        // 필터 버튼 활성화 상태 업데이트
        this.panel?.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filter);
        });
        
        // 작품 로드
        await this.loadArtworks();
    }
    
    /**
     * 작품 목록 로드
     */
    async loadArtworks() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        
        grid.innerHTML = '<div class="loading">로딩 중...</div>';
        
        try {
            // 픽셀 데이터가 있는 영토 목록 조회
            const territoriesWithPixels = await apiService.getTerritoriesWithPixels();
            
            if (!territoriesWithPixels || territoriesWithPixels.length === 0) {
                this.artworks = [];
                this.renderArtworks();
                return;
            }
            
            // 영토 상세 정보 조회 (병렬 처리)
            const artworks = await Promise.all(
                territoriesWithPixels.slice(0, 100).map(async (territoryId) => {
                    try {
                        const territory = await apiService.getTerritory(territoryId);
                        const pixelData = await apiService.getPixelData(territoryId);
                        
                        return {
                            territoryId,
                            name: territory?.name || territory?.name_en || territoryId,
                            pixelCount: pixelData?.pixels?.length || 0,
                            filledPixels: pixelData?.filledPixels || 0,
                            lastUpdated: pixelData?.lastUpdated,
                            likeCount: 0, // TODO: 좋아요 기능 추가 시 API에서 가져오기
                            commentCount: 0, // TODO: 댓글 기능 추가 시 API에서 가져오기
                            pixels: pixelData?.pixels || []
                        };
                    } catch (error) {
                        log.warn(`[GalleryView] Failed to load artwork for ${territoryId}:`, error);
                        return null;
                    }
                })
            );
            
            // null 필터링 및 정렬
            let filtered = artworks.filter(a => a !== null);
            
            if (this.currentFilter === 'popular') {
                // 인기 작품: 픽셀 수 기준 (임시)
                filtered.sort((a, b) => (b.filledPixels || 0) - (a.filledPixels || 0));
            } else if (this.currentFilter === 'recent') {
                // 최신 작품: 업데이트 시간 기준
                filtered.sort((a, b) => {
                    const aTime = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
                    const bTime = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
                    return bTime - aTime;
                });
            } else {
                // 크리에이터 작품: 픽셀 수 기준 (임시)
                filtered.sort((a, b) => (b.filledPixels || 0) - (a.filledPixels || 0));
            }
            
            this.artworks = filtered.slice(0, 20);
            this.renderArtworks();
            
        } catch (error) {
            log.error('[GalleryView] Failed to load artworks:', error);
            grid.innerHTML = '<div class="error">작품을 불러올 수 없습니다.</div>';
        }
    }
    
    /**
     * 작품 렌더링
     */
    async renderArtworks() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        
        if (this.artworks.length === 0) {
            grid.innerHTML = '<div class="empty">작품이 없습니다.</div>';
            return;
        }
        
        // 영토 정보와 함께 렌더링
        const html = await Promise.all(
            this.artworks.map(async (artwork) => {
                const territory = await apiService.getTerritory(artwork.territoryId);
                const territoryName = territory?.name || territory?.territoryName || artwork.territoryId;
                
                return `
                    <div class="gallery-item" data-territory-id="${artwork.territoryId}">
                        <div class="gallery-item-image">
                            <canvas class="pixel-preview" data-territory-id="${artwork.territoryId}" width="100" height="100"></canvas>
                        </div>
                        <div class="gallery-item-info">
                            <h3>${territoryName}</h3>
                            <div class="gallery-item-stats">
                                <span>❤️ ${artwork.likeCount || 0}</span>
                                <span>💬 ${artwork.commentCount || 0}</span>
                                <span>🎨 ${artwork.filledPixels || 0}px</span>
                            </div>
                        </div>
                    </div>
                `;
            })
        );
        
        grid.innerHTML = html.join('');
        
        // 작품 클릭 이벤트
        grid.querySelectorAll('.gallery-item').forEach(item => {
            item.addEventListener('click', () => {
                const territoryId = item.dataset.territoryId;
                eventBus.emit(EVENTS.TERRITORY_SELECTED, { territoryId });
                this.close();
            });
        });
        
        // 픽셀 미리보기 렌더링
        this.renderPreviews();
    }
    
    /**
     * 픽셀 미리보기 렌더링
     */
    async renderPreviews() {
        const canvases = this.panel?.querySelectorAll('.pixel-preview');
        if (!canvases) return;
        
        for (const canvas of canvases) {
            const territoryId = canvas.dataset.territoryId;
            const artwork = this.artworks.find(a => a.territoryId === territoryId);
            
            if (artwork && artwork.pixels) {
                const ctx = canvas.getContext('2d');
                const imageData = ctx.createImageData(100, 100);
                
                // 픽셀 데이터를 이미지로 변환
                artwork.pixels.forEach(pixel => {
                    const x = pixel.x;
                    const y = pixel.y;
                    const color = pixel.c || '#000000';
                    
                    // 색상 파싱
                    const rgb = this.hexToRgb(color);
                    if (rgb) {
                        const index = (y * 100 + x) * 4;
                        imageData.data[index] = rgb.r;
                        imageData.data[index + 1] = rgb.g;
                        imageData.data[index + 2] = rgb.b;
                        imageData.data[index + 3] = 255;
                    }
                });
                
                ctx.putImageData(imageData, 0, 0);
            }
        }
    }
    
    /**
     * HEX 색상을 RGB로 변환
     */
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }
    
    /**
     * 갤러리 열기
     */
    async open() {
        if (!this.panel) {
            this.createPanel();
        }
        
        this.panel.classList.remove('hidden');
        this.isOpen = true;
        
        // 작품 로드
        await this.loadArtworks();
        
        log.info('GalleryView opened');
    }
    
    /**
     * 갤러리 닫기
     */
    close() {
        if (this.panel) {
            this.panel.classList.add('hidden');
        }
        this.isOpen = false;
    }
}

// 싱글톤 인스턴스
export const galleryView = new GalleryView();
export default galleryView;

