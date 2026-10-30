/**
 * PixelEditor3 - 픽셀 에디터
 * 화면 전체 캔버스 + 떠 있는 도구 막대 + 지도 미리보기, 사진으로 시작하기
 */

import { CONFIG, log } from '../config.js';
import { eventBus, EVENTS } from '../core/EventBus.js';
import { pixelCanvas3, TOOLS } from '../core/PixelCanvas3.js';
import { loadBg, subscribeBg, setBg } from '../stores/BackgroundStore.js';
import { imageStampModal } from './ImageStampModal.js';
import {
    ICONS, PALETTES, STICKERS, TEXT_FONTS,
    stickerToStamp, stickerPreviewURL, rasterizeText, ensurePixelFonts
} from './pixel-editor/PixelEditorAssets.js';

const STORAGE_KEY = 'pe:settings:v1';
const MAX_RECENT = 10;
const MOBILE_QUERY = '(max-width: 720px)';

const TOOL_BUTTONS = [
    { group: 'draw', tool: TOOLS.BRUSH, icon: 'brush', label: 'Brush', key: 'B' },
    { group: 'draw', tool: TOOLS.ERASER, icon: 'eraser', label: 'Eraser', key: 'E' },
    { group: 'draw', tool: TOOLS.FILL, icon: 'fill', label: 'Fill', key: 'F' },
    { group: 'draw', tool: TOOLS.PICKER, icon: 'picker', label: 'Pick color', key: 'I' },
    { group: 'shape', tool: TOOLS.LINE, icon: 'line', label: 'Line', key: 'L' },
    { group: 'shape', tool: TOOLS.RECT, icon: 'rect', label: 'Rectangle', key: 'R' },
    { group: 'shape', tool: TOOLS.ELLIPSE, icon: 'ellipse', label: 'Circle', key: 'O' },
    { group: 'insert', action: 'text', icon: 'text', label: 'Text', key: 'T' },
    { group: 'insert', action: 'sticker', icon: 'sticker', label: 'Stickers', key: 'K' },
    { group: 'nav', tool: TOOLS.PAN, icon: 'pan', label: 'Move (hold Space)', key: 'H' }
];

const SHORTCUTS = [
    ['B', 'Brush'], ['E', 'Eraser'], ['F', 'Fill'], ['I', 'Pick color'],
    ['L', 'Line'], ['R', 'Rectangle'], ['O', 'Circle'], ['Shift + drag', 'Straight line / square / circle'],
    ['T', 'Text'], ['K', 'Stickers'], ['Space (hold) / H', 'Move the canvas'],
    ['[ / ]', 'Smaller / bigger brush'], ['G', 'Grid'], ['M', 'Mirror (left ↔ right)'],
    ['+ / − / wheel', 'Zoom'], ['0', 'Fit to screen'],
    ['Ctrl + Z / Ctrl + Y', 'Undo / Redo'], ['Ctrl + S', 'Save'], ['Esc', 'Cancel / close panel']
];

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function contrastColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#000000';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.55 ? '#000000' : '#ffffff';
}

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

class PixelEditor3 {
    constructor() {
        this.container = null;
        this.isOpen = false;
        this.currentTerritory = null;
        this.uiBound = false;
        this.openPanel = null;
        this.panModeFromSpace = false;
        this.toolBeforeSpace = null;
        this.toolBeforeStamp = TOOLS.BRUSH;
        this.stampSource = null; // 'text' | 'sticker'
        this.previewTimer = null;
        this.saveRetryCount = 0;
        this.lang = 'en';
        
        const saved = loadSettings();
        this.tool = TOOLS.BRUSH;
        this.color = saved.color || '#e63946';
        this.brushSize = saved.brushSize || 1;
        this.paletteId = saved.paletteId || 'brand';
        this.recentColors = Array.isArray(saved.recentColors) ? saved.recentColors.slice(0, MAX_RECENT) : [];
        this.showGrid = !!saved.showGrid;
        this.mirror = false;
        this.shapeFilled = !!saved.shapeFilled;
        // 휴대폰에서는 미리보기가 캔버스를 가리므로 데스크톱과 따로 기억 (기본: 데스크톱 켬, 휴대폰 끔)
        this.previewPrefs = { desktop: true, mobile: false, ...(saved.previewPrefs || {}) };
        this.textSettings = { text: '', fontId: 'pixel', scale: 1, outline: false, ...(saved.textSettings || {}) };
        this.textSettings.text = '';
        this.stickerSettings = { id: null, scale: 1, recolorAll: false, ...(saved.stickerSettings || {}) };
        
        const bgState = loadBg();
        this.backgroundMode = bgState.mode;
        this.backgroundColor = bgState.color;
        this.checkerSize = bgState.checkerSize;
        this.bgUnsubscribe = subscribeBg((state) => {
            this.backgroundMode = state.mode;
            this.backgroundColor = state.color;
            this.checkerSize = state.checkerSize;
            if (pixelCanvas3?.canvas) {
                pixelCanvas3.setBackground(state.mode, state.color, state.checkerSize);
                pixelCanvas3.render();
            }
            this.syncViewPanel();
        });
    }
    
    get showPreview() {
        return !!this.previewPrefs[window.matchMedia?.(MOBILE_QUERY).matches ? 'mobile' : 'desktop'];
    }
    
    set showPreview(value) {
        this.previewPrefs[window.matchMedia?.(MOBILE_QUERY).matches ? 'mobile' : 'desktop'] = !!value;
    }
    
    persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                color: this.color,
                brushSize: this.brushSize,
                paletteId: this.paletteId,
                recentColors: this.recentColors,
                showGrid: this.showGrid,
                shapeFilled: this.shapeFilled,
                previewPrefs: this.previewPrefs,
                textSettings: { fontId: this.textSettings.fontId, scale: this.textSettings.scale, outline: this.textSettings.outline },
                stickerSettings: { scale: this.stickerSettings.scale, recolorAll: this.stickerSettings.recolorAll }
            }));
        } catch {
            // 저장 공간이 없으면 설정만 기억 못 함
        }
    }
    
    initialize() {
        this.createModal();
        this.setupEvents();
        this.bindUI();
        imageStampModal.initialize();
        log.info('[PixelEditor3] Initialized');
    }
    
    createModal() {
        document.getElementById('pixel-editor-3')?.remove();
        this.container = document.createElement('div');
        this.container.id = 'pixel-editor-3';
        this.container.className = 'pe-root hidden';
        this.container.innerHTML = this.getHTML();
        document.body.appendChild(this.container);
    }
    
    $(selector) {
        return this.container?.querySelector(selector);
    }
    
    getHTML() {
        const toolButton = (b) => `
            <button class="pe-tool" type="button" ${b.tool ? `data-tool="${b.tool}"` : `data-action="${b.action}"`}
                title="${b.label}${b.key ? ` (${b.key})` : ''}" aria-label="${b.label}">
                ${ICONS[b.icon]}
            </button>`;
        const group = (name) => TOOL_BUTTONS.filter(b => b.group === name).map(toolButton).join('');
        
        return `
            <header class="pe-topbar">
                <div class="pe-topbar-left">
                    <button class="pe-icon-btn" id="pe-close" type="button" title="Close" aria-label="Close editor">${ICONS.close}</button>
                    <div class="pe-title">
                        <span class="pe-eyebrow">Pixel editor</span>
                        <strong id="pe-territory-name">—</strong>
                    </div>
                </div>
                <div class="pe-topbar-center">
                    <button class="pe-icon-btn" id="pe-undo" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>${ICONS.undo}</button>
                    <button class="pe-icon-btn" id="pe-redo" type="button" title="Redo (Ctrl+Y)" aria-label="Redo" disabled>${ICONS.redo}</button>
                </div>
                <div class="pe-topbar-right">
                    <button class="pe-btn-secondary" id="pe-photo" type="button" title="Turn a photo or logo into pixel art">${ICONS.image}<span class="pe-long">Add a photo</span><span class="pe-short">Photo</span></button>
                    <span class="pe-save-status saved" id="pe-save-status"><i></i><span>Saved</span></span>
                    <button class="pe-btn-primary" id="pe-save" type="button" title="Save (Ctrl+S)">${ICONS.check}<span>Save</span></button>
                    <div class="pe-menu-wrap">
                        <button class="pe-icon-btn" id="pe-more" type="button" title="More" aria-label="More options">${ICONS.more}</button>
                        <div class="pe-menu pe-popover" id="pe-more-menu" hidden>
                            <button type="button" data-menu="download">${ICONS.download}<span>Download PNG</span></button>
                            <button type="button" data-menu="shortcuts">${ICONS.keyboard}<span>Keyboard shortcuts</span></button>
                            <hr>
                            <button type="button" data-menu="clear" class="pe-danger">${ICONS.trash}<span>Clear everything</span></button>
                        </div>
                    </div>
                </div>
            </header>
            
            <main class="pe-viewport" id="pe-viewport">
                <div class="pe-stage">
                    <canvas id="pixel-canvas-3"></canvas>
                    <canvas class="pe-overlay" id="pixel-overlay-3"></canvas>
                </div>
                
                <div class="pe-float pe-float-tl">
                    <button class="pe-chip" id="pe-view-btn" type="button" title="Background and preview">
                        ${ICONS.layers}<span>View</span>${ICONS.chevronDown}
                    </button>
                    <button class="pe-chip pe-chip-icon" id="pe-grid-btn" type="button" title="Grid (G)" aria-label="Grid">${ICONS.grid}</button>
                    <button class="pe-chip pe-chip-icon" id="pe-mirror-btn" type="button" title="Mirror left ↔ right (M)" aria-label="Mirror">${ICONS.mirror}</button>
                    <div class="pe-popover pe-view-panel" id="pe-view-panel" hidden>
                        <div class="pe-field">
                            <label>Background</label>
                            <div class="pe-seg" id="pe-bg-seg">
                                <button type="button" data-bg="dark">Dark</button>
                                <button type="button" data-bg="light">Light</button>
                                <button type="button" data-bg="checker">Checker</button>
                            </div>
                        </div>
                        <label class="pe-switch"><input type="checkbox" id="pe-preview-toggle"><span>Show "on the map" preview</span></label>
                    </div>
                </div>
                
                <div class="pe-float pe-float-tr pe-zoom">
                    <button class="pe-icon-btn" id="pe-zoom-in" type="button" title="Zoom in (+)" aria-label="Zoom in">${ICONS.zoomIn}</button>
                    <span id="pe-zoom-value">100%</span>
                    <button class="pe-icon-btn" id="pe-zoom-out" type="button" title="Zoom out (−)" aria-label="Zoom out">${ICONS.zoomOut}</button>
                    <button class="pe-icon-btn" id="pe-zoom-fit" type="button" title="Fit to screen (0)" aria-label="Fit to screen">${ICONS.fit}</button>
                </div>
                
                <div class="pe-float pe-float-bl pe-info">
                    <span id="pe-coords">—</span>
                    <span id="pe-count">0 px</span>
                </div>
                
                <div class="pe-float pe-float-br pe-preview" id="pe-preview-card">
                    <div class="pe-preview-head">
                        <span>On the map</span>
                        <button class="pe-icon-btn pe-mini" id="pe-preview-close" type="button" title="Hide preview" aria-label="Hide preview">${ICONS.close}</button>
                    </div>
                    <canvas id="pe-preview-canvas" width="176" height="176"></canvas>
                </div>
                
                <div class="pe-empty" id="pe-empty" hidden>
                    <div class="pe-empty-icon">${ICONS.image}</div>
                    <strong>Start with a photo?</strong>
                    <p>Upload your logo or a photo and we'll turn it into pixel art that fits this spot. You can touch it up afterwards.</p>
                    <div class="pe-empty-actions">
                        <button class="pe-btn-primary" type="button" data-empty="photo">${ICONS.image}<span>Upload a photo</span></button>
                        <button class="pe-btn-ghost" type="button" data-empty="draw">I'll draw myself</button>
                    </div>
                </div>
                
                <div class="pe-loading" id="pixel-loading-3" style="display: none;">
                    <div class="pe-spinner"></div>
                    <p>Loading pixel art...</p>
                </div>
            </main>
            
            <div class="pe-bottom">
                <div class="pe-optbar" id="pe-optbar"></div>
                
                <div class="pe-popover pe-sheet" id="pe-color-panel" hidden>
                    <div class="pe-sheet-head">
                        <strong>Colors</strong>
                        <select id="pe-palette-select" aria-label="Palette">
                            ${PALETTES.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="pe-swatches" id="pe-palette-swatches"></div>
                    <div class="pe-recent-wrap" id="pe-recent-wrap">
                        <span class="pe-label">Recent</span>
                        <div class="pe-swatches pe-swatches-row" id="pe-recent-swatches"></div>
                    </div>
                    <div class="pe-custom-color">
                        <label class="pe-color-input" title="Pick any color">
                            <input type="color" id="pe-color-input" value="${this.color}">
                            <span>${ICONS.plus}</span>
                        </label>
                        <input type="text" id="pe-hex-input" maxlength="7" spellcheck="false" aria-label="Hex color" value="${this.color}">
                    </div>
                </div>
                
                <div class="pe-popover pe-sheet" id="pe-text-panel" hidden>
                    <div class="pe-sheet-head"><strong>Text</strong><span class="pe-hint">Then tap the canvas to place it</span></div>
                    <textarea id="pe-text-input" rows="2" maxlength="60" placeholder="Your brand name"></textarea>
                    <div class="pe-row">
                        <select id="pe-text-font" aria-label="Font">
                            ${TEXT_FONTS.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}
                        </select>
                        <div class="pe-seg" id="pe-text-scale">
                            ${[1, 2, 3, 4].map(n => `<button type="button" data-scale="${n}">×${n}</button>`).join('')}
                        </div>
                    </div>
                    <label class="pe-switch"><input type="checkbox" id="pe-text-outline"><span>Outline (easier to read on the map)</span></label>
                    <div class="pe-text-preview"><canvas id="pe-text-preview" width="1" height="1"></canvas><span id="pe-text-size"></span></div>
                </div>
                
                <div class="pe-popover pe-sheet" id="pe-sticker-panel" hidden>
                    <div class="pe-sheet-head"><strong>Stickers</strong><span class="pe-hint">Pick one, then tap to stamp</span></div>
                    <div class="pe-sticker-grid" id="pe-sticker-grid"></div>
                    <div class="pe-row">
                        <div class="pe-seg" id="pe-sticker-scale">
                            ${[1, 2, 3, 4].map(n => `<button type="button" data-scale="${n}">×${n}</button>`).join('')}
                        </div>
                        <label class="pe-switch"><input type="checkbox" id="pe-sticker-recolor"><span>All in my color</span></label>
                    </div>
                </div>
                
                <nav class="pe-dock" id="pe-dock" aria-label="Tools">
                    <button class="pe-color-btn" id="pe-color-btn" type="button" title="Colors" aria-label="Colors"><span id="pe-color-swatch"></span></button>
                    <div class="pe-quick-swatches" id="pe-quick-swatches"></div>
                    <span class="pe-sep"></span>
                    ${group('draw')}
                    <span class="pe-sep"></span>
                    ${group('shape')}
                    <span class="pe-sep"></span>
                    ${group('insert')}
                    <span class="pe-sep"></span>
                    ${group('nav')}
                </nav>
            </div>
        `;
    }
    
    /**
     * 캔버스 엔진에서 오는 이벤트 (생성 시 한 번만 등록)
     */
    setupEvents() {
        eventBus.on(EVENTS.UI_MODAL_OPEN, (data) => {
            if (data.type === 'pixelEditor') this.open(data.data);
        });
        
        eventBus.on(EVENTS.PIXEL_UPDATE, (data) => {
            if (!data) return;
            if (data.type === 'colorPicked') {
                this.setColor(data.color, { remember: true });
                this.setTool(TOOLS.BRUSH);
            } else if (data.type === 'saveStatus') {
                this.updateSaveStatus(data.status, data.error, data.message, data.saveTime);
            } else if (data.type === 'zoomChanged') {
                const el = this.$('#pe-zoom-value');
                if (el) el.textContent = `${Math.round(data.zoom * 100)}%`;
            } else if (data.type === 'historyChanged') {
                const undo = this.$('#pe-undo');
                const redo = this.$('#pe-redo');
                if (undo) undo.disabled = !data.canUndo;
                if (redo) redo.disabled = !data.canRedo;
            } else if (data.type === 'stampPlaced') {
                if (this.stampSource === 'text') {
                    this.textSettings.text = '';
                    const input = this.$('#pe-text-input');
                    if (input) input.value = '';
                    this.renderTextPreview();
                    this.setTool(this.toolBeforeStamp || TOOLS.BRUSH);
                }
            } else if (data.type === 'rendered') {
                this.schedulePreview();
            }
        });
        
        eventBus.on(EVENTS.PIXEL_DATA_SAVED, () => this.updateSaveStatus('saved'));
        
        eventBus.on(EVENTS.PIXEL_VALUE_CHANGE, (data) => {
            this.updateStats(data);
            this.schedulePreview();
            if (data?.filledPixels > 0) this.setEmptyCard(false);
        });
        
        window.addEventListener('beforeunload', (e) => {
            if (this.isOpen && pixelCanvas3?.hasUnsavedChanges()) {
                e.preventDefault();
                e.returnValue = pixelCanvas3.isSaving
                    ? 'Saving in progress. Recent changes may be lost if you leave.'
                    : 'You have unsaved changes. Are you sure you want to leave?';
                return e.returnValue;
            }
        });
        
        window.matchMedia?.(MOBILE_QUERY).addEventListener?.('change', () => {
            if (!this.isOpen) return;
            this.applyViewPadding(true);
            this.syncPreviewCard();
            this.syncViewPanel();
        });
    }
    
    async open(territory) {
        if (!territory?.id) {
            log.error('[PixelEditor3] Invalid territory');
            eventBus.emit(EVENTS.UI_NOTIFICATION, { type: 'error', message: 'Territory information not found.' });
            return;
        }
        
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        this.currentTerritory = territory;
        this.isOpen = true;
        this.container?.classList.remove('hidden');
        document.body.classList.add('pe-open');
        this.closePanels();
        this.showLoading(vocab.loadingTerritoryInfo);
        this.updateTerritoryInfo();
        this.updateSaveStatus('saved');
        
        try {
            const canvas = document.getElementById('pixel-canvas-3');
            this.applyViewPadding(false);
            this.showLoading(vocab.loadingPixelArt);
            await pixelCanvas3.initialize(territory.id, canvas, territory);
            
            pixelCanvas3.setBackground(this.backgroundMode, this.backgroundColor, this.checkerSize);
            pixelCanvas3.setBrushSize(this.brushSize);
            pixelCanvas3.setGrid(this.showGrid);
            pixelCanvas3.setMirror(this.mirror);
            pixelCanvas3.setShapeFilled(this.shapeFilled);
            pixelCanvas3.setStamp(null);
            this.setColor(this.color);
            this.setTool(TOOLS.BRUSH);
            pixelCanvas3.render();
            pixelCanvas3.emitZoomChange();
            
            this.updateStats({ filledPixels: pixelCanvas3.pixels.size });
            this.syncAll();
            // 빈 땅이면 "사진으로 시작하기"를 먼저 보여 줌 (사진 변환 기능을 모르는 사람이 많아서)
            this.setEmptyCard(pixelCanvas3.pixelsMap.size === 0);
            
            log.info(`[PixelEditor3] Opened for ${territory.id}`);
        } catch (error) {
            log.error('[PixelEditor3] Failed to open:', error);
            eventBus.emit(EVENTS.UI_NOTIFICATION, { type: 'error', message: 'Unable to open pixel editor. Please try again later.' });
            await this.close(true);
        } finally {
            this.hideLoading();
        }
    }
    
    applyViewPadding(refit) {
        const mobile = window.matchMedia?.(MOBILE_QUERY).matches;
        pixelCanvas3.viewPadding = mobile ? { x: 16, y: 210 } : { x: 120, y: 190 };
        pixelCanvas3.viewOffsetY = mobile ? -40 : -36;
        if (refit && pixelCanvas3.canvas) pixelCanvas3.fitToView();
    }
    
    setEmptyCard(show) {
        const card = this.$('#pe-empty');
        if (card) card.hidden = !show;
    }
    
    openPhotoTool() {
        this.setEmptyCard(false);
        this.closePanels();
        if (this.currentTerritory) imageStampModal.open(this.currentTerritory);
    }
    
    showLoading(message = null) {
        const el = this.$('#pixel-loading-3');
        if (!el) return;
        const p = el.querySelector('p');
        if (p && message) p.textContent = message;
        el.style.display = 'flex';
    }
    
    hideLoading() {
        const el = this.$('#pixel-loading-3');
        if (el) el.style.display = 'none';
    }
    
    async close(force = false) {
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        if (!force && pixelCanvas3?.isSaving) {
            const confirmed = confirm(`${vocab.savingInProgress}\n\n${vocab.cancelSaveAndClose}\n${vocab.confirmCancel}`);
            if (!confirmed) {
                const started = Date.now();
                const wait = setInterval(() => {
                    if (!pixelCanvas3.isSaving || Date.now() - started > 5000) {
                        clearInterval(wait);
                        pixelCanvas3.isSaving = false;
                        this.close(true);
                    }
                }, 100);
                return;
            }
            if (pixelCanvas3.saveTimeout) {
                clearTimeout(pixelCanvas3.saveTimeout);
                pixelCanvas3.saveTimeout = null;
            }
            pixelCanvas3.isSaving = false;
        }
        
        if (!force && pixelCanvas3?.hasUnsavedChanges?.()) {
            const confirmed = confirm(`${vocab.unsavedChanges}\n\n${vocab.reallyClose}\n${vocab.autoSave}`);
            if (!confirmed) return;
        }
        
        const territoryId = this.currentTerritory?.id;
        this.isOpen = false;
        this.closePanels();
        this.hideShortcutsModal();
        this.container?.classList.add('hidden');
        document.body.classList.remove('pe-open');
        pixelCanvas3?.cleanup();
        this.currentTerritory = null;
        clearTimeout(this.previewTimer);
        this.previewTimer = null;
        
        // 닫은 뒤 지도에 바로 반영되도록 캐시를 비우고 영토를 다시 그림
        if (territoryId) {
            const { pixelDataService } = await import('../services/PixelDataService.js');
            pixelDataService.clearMemoryCache(territoryId);
            try {
                const mapController = (await import('../core/MapController.js')).default;
                mapController?.pixelMapRenderer?.processedTerritories?.delete(territoryId);
            } catch (error) {
                log.warn('[PixelEditor3] Failed to access pixelMapRenderer:', error);
            }
            const refresh = () => eventBus.emit(EVENTS.TERRITORY_UPDATE, {
                territoryId,
                territory: { id: territoryId },
                forceRefresh: true
            });
            setTimeout(refresh, 100);
            setTimeout(refresh, 500);
        }
    }
    
    /**
     * 화면 요소 이벤트 (모달은 한 번만 만들어지므로 여기서도 한 번만 등록)
     */
    bindUI() {
        if (!this.container || this.uiBound) return;
        this.uiBound = true;
        const on = (sel, evt, fn) => this.$(sel)?.addEventListener(evt, fn);
        
        on('#pe-close', 'click', () => this.close());
        on('#pe-undo', 'click', () => pixelCanvas3.undo());
        on('#pe-redo', 'click', () => pixelCanvas3.redo());
        on('#pe-save', 'click', () => {
            if (!pixelCanvas3.isSaving) pixelCanvas3.save();
        });
        
        on('#pe-more', 'click', (e) => {
            e.stopPropagation();
            this.togglePanel('more');
        });
        this.container.querySelectorAll('[data-menu]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.closePanels();
                this.handleMenu(btn.dataset.menu);
            });
        });
        
        // 도구 막대
        this.container.querySelectorAll('.pe-tool').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.tool) {
                    this.closePanels();
                    this.setTool(btn.dataset.tool);
                    if (btn.dataset.tool === TOOLS.PAN) this.panModeFromSpace = false;
                } else {
                    this.handleAction(btn.dataset.action);
                }
            });
        });
        on('#pe-color-btn', 'click', (e) => {
            e.stopPropagation();
            this.togglePanel('color');
        });
        
        // 색상
        on('#pe-palette-select', 'change', (e) => {
            this.paletteId = e.target.value;
            this.persist();
            this.renderSwatches();
        });
        on('#pe-color-input', 'input', (e) => this.setColor(e.target.value));
        on('#pe-color-input', 'change', (e) => this.setColor(e.target.value, { remember: true }));
        on('#pe-hex-input', 'change', (e) => {
            let v = e.target.value.trim();
            if (!v.startsWith('#')) v = `#${v}`;
            if (/^#[0-9a-f]{6}$/i.test(v)) this.setColor(v.toLowerCase(), { remember: true });
            else e.target.value = this.color;
        });
        this.container.addEventListener('click', (e) => {
            const sw = e.target.closest('[data-color]');
            if (sw && this.container.contains(sw)) {
                this.setColor(sw.dataset.color, { remember: true });
                if (sw.closest('#pe-color-panel') && window.matchMedia?.(MOBILE_QUERY).matches) this.closePanels();
            }
        });
        
        // 보기 (지도 밑그림/배경/격자/대칭)
        on('#pe-view-btn', 'click', (e) => {
            e.stopPropagation();
            this.togglePanel('view');
        });
        on('#pe-photo', 'click', () => this.openPhotoTool());
        this.container.querySelectorAll('[data-empty]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.empty === 'photo') this.openPhotoTool();
                else this.setEmptyCard(false);
            });
        });
        this.container.querySelectorAll('[data-bg]').forEach(btn => {
            btn.addEventListener('click', () => {
                const bg = btn.dataset.bg;
                if (bg === 'checker') this.setBackground('checker', this.backgroundColor);
                else this.setBackground('solid', bg === 'light' ? '#e8e8e8' : '#1a1a1a');
            });
        });
        on('#pe-preview-toggle', 'change', (e) => {
            this.showPreview = e.target.checked;
            this.persist();
            this.syncPreviewCard();
        });
        on('#pe-preview-close', 'click', () => {
            this.showPreview = false;
            this.persist();
            this.syncPreviewCard();
            this.syncViewPanel();
        });
        on('#pe-grid-btn', 'click', () => this.toggleGrid());
        on('#pe-mirror-btn', 'click', () => this.toggleMirror());
        
        // 줌
        on('#pe-zoom-in', 'click', () => pixelCanvas3.zoomIn());
        on('#pe-zoom-out', 'click', () => pixelCanvas3.zoomOut());
        on('#pe-zoom-fit', 'click', () => pixelCanvas3.fitToView());
        
        // 옵션 막대 (브러시 크기, 도형 채우기)
        this.$('#pe-optbar')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-opt]');
            if (!btn) return;
            const opt = btn.dataset.opt;
            if (opt === 'size-dec') this.setBrushSize(this.brushSize - 1);
            else if (opt === 'size-inc') this.setBrushSize(this.brushSize + 1);
            else if (opt === 'filled') this.toggleShapeFilled();
            else if (opt === 'mirror') this.toggleMirror();
            else if (opt === 'cancel-stamp') this.setTool(this.toolBeforeStamp || TOOLS.BRUSH);
        });
        
        // 글자
        on('#pe-text-input', 'input', (e) => {
            this.textSettings.text = e.target.value;
            this.updateTextStamp();
        });
        on('#pe-text-font', 'change', (e) => {
            this.textSettings.fontId = e.target.value;
            this.persist();
            this.updateTextStamp();
        });
        this.container.querySelectorAll('#pe-text-scale [data-scale]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.textSettings.scale = Number(btn.dataset.scale);
                this.persist();
                this.syncSeg('#pe-text-scale', 'scale', this.textSettings.scale);
                this.updateTextStamp();
            });
        });
        on('#pe-text-outline', 'change', (e) => {
            this.textSettings.outline = e.target.checked;
            this.persist();
            this.updateTextStamp();
        });
        
        // 스티커
        this.renderStickerGrid();
        this.$('#pe-sticker-grid')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-sticker]');
            if (!btn) return;
            this.stickerSettings.id = btn.dataset.sticker;
            this.updateStickerStamp();
            if (window.matchMedia?.(MOBILE_QUERY).matches) this.closePanels();
        });
        this.container.querySelectorAll('#pe-sticker-scale [data-scale]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.stickerSettings.scale = Number(btn.dataset.scale);
                this.persist();
                this.syncSeg('#pe-sticker-scale', 'scale', this.stickerSettings.scale);
                if (this.stickerSettings.id && this.stampSource === 'sticker') this.updateStickerStamp();
            });
        });
        on('#pe-sticker-recolor', 'change', (e) => {
            this.stickerSettings.recolorAll = e.target.checked;
            this.persist();
            this.renderStickerGrid();
            if (this.stickerSettings.id && this.stampSource === 'sticker') this.updateStickerStamp();
        });
        
        // 좌표 표시
        on('#pixel-canvas-3', 'mousemove', (e) => {
            const pos = pixelCanvas3.getPixelPos(e);
            const el = this.$('#pe-coords');
            if (el) el.textContent = pos.x >= 0 ? `X ${pos.x} · Y ${pos.y}` : '—';
        });
        on('#pixel-canvas-3', 'mousedown', () => {
            this.closePanels(['more', 'view']);
            this.setEmptyCard(false);
        });
        on('#pixel-canvas-3', 'touchstart', () => {
            this.setEmptyCard(false);
            if (window.matchMedia?.(MOBILE_QUERY).matches) this.closePanels();
        });
        
        // 바깥을 누르면 메뉴/보기 패널 닫힘 (색상·글자·스티커 패널은 그리면서 계속 쓰도록 유지)
        document.addEventListener('mousedown', (e) => {
            if (!this.isOpen) return;
            if (!e.target.closest('#pe-more-menu, #pe-more, #pe-view-panel, #pe-view-btn')) {
                this.closePanels(['more', 'view']);
            }
        });
        
        this.bindKeyboard();
    }
    
    bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (!this.isOpen) return;
            const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            
            if (e.key === 'Escape') {
                if (this.shortcutsModalVisible) this.hideShortcutsModal();
                else if (pixelCanvas3.tool === TOOLS.STAMP) this.setTool(this.toolBeforeStamp || TOOLS.BRUSH);
                else this.closePanels();
                if (typing) e.target.blur();
                e.preventDefault();
                return;
            }
            if (mod && key === 's') {
                e.preventDefault();
                pixelCanvas3.save();
                return;
            }
            if (typing) return;
            if (mod && key === 'z' && !e.shiftKey) {
                e.preventDefault();
                pixelCanvas3.undo();
                return;
            }
            if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
                e.preventDefault();
                pixelCanvas3.redo();
                return;
            }
            if (mod || e.altKey) return;
            
            if (e.key === ' ') {
                e.preventDefault();
                if (!e.repeat && pixelCanvas3.tool !== TOOLS.PAN) {
                    this.panModeFromSpace = true;
                    this.toolBeforeSpace = pixelCanvas3.tool;
                    this.setTool(TOOLS.PAN, { keepStamp: true });
                }
                return;
            }
            
            const toolKeys = { b: TOOLS.BRUSH, e: TOOLS.ERASER, f: TOOLS.FILL, i: TOOLS.PICKER, l: TOOLS.LINE, r: TOOLS.RECT, o: TOOLS.ELLIPSE, h: TOOLS.PAN };
            if (toolKeys[key]) {
                e.preventDefault();
                this.closePanels(['text', 'sticker']);
                this.setTool(toolKeys[key]);
                return;
            }
            const actions = {
                t: () => this.handleAction('text'),
                k: () => this.handleAction('sticker'),
                g: () => this.toggleGrid(),
                m: () => this.toggleMirror(),
                '0': () => pixelCanvas3.fitToView(),
                '[': () => this.setBrushSize(this.brushSize - 1),
                ']': () => this.setBrushSize(this.brushSize + 1),
                '+': () => pixelCanvas3.zoomIn(),
                '=': () => pixelCanvas3.zoomIn(),
                '-': () => pixelCanvas3.zoomOut(),
                '_': () => pixelCanvas3.zoomOut()
            };
            const action = actions[key] || actions[e.key];
            if (action) {
                e.preventDefault();
                action();
            }
        });
        
        document.addEventListener('keyup', (e) => {
            if (!this.isOpen || e.key !== ' ' || !this.panModeFromSpace) return;
            this.panModeFromSpace = false;
            this.setTool(this.toolBeforeSpace || TOOLS.BRUSH, { keepStamp: true });
            this.toolBeforeSpace = null;
        });
    }
    
    handleAction(action) {
        if (action === 'text') {
            this.togglePanel('text', true);
            this.updateTextStamp();
            setTimeout(() => this.$('#pe-text-input')?.focus(), 30);
        } else if (action === 'sticker') {
            this.togglePanel('sticker', true);
            if (this.stickerSettings.id) this.updateStickerStamp();
        }
    }
    
    handleMenu(item) {
        const vocab = CONFIG.VOCABULARY[this.lang] || CONFIG.VOCABULARY.en;
        if (item === 'download') {
            const link = document.createElement('a');
            const name = this.currentTerritory?.name?.en || this.currentTerritory?.name?.ko || this.currentTerritory?.id || 'pixel-art';
            link.download = `${String(name).replace(/[^\w-]+/g, '_')}_pixel.png`;
            link.href = pixelCanvas3.toPixelPNG(8);
            link.click();
        } else if (item === 'shortcuts') {
            this.showShortcutsModal();
        } else if (item === 'clear') {
            if (confirm(vocab.clearAll || 'Clear all pixels?')) pixelCanvas3.clear();
        }
    }
    
    // ---------- 패널 ----------
    
    togglePanel(name, forceOpen = false) {
        const next = !forceOpen && this.openPanel === name ? null : name;
        this.closePanels();
        if (!next) return;
        const el = this.$({ more: '#pe-more-menu', view: '#pe-view-panel', color: '#pe-color-panel', text: '#pe-text-panel', sticker: '#pe-sticker-panel' }[next]);
        if (!el) return;
        el.hidden = false;
        this.openPanel = next;
        this.container.querySelector(`[data-action="${next}"]`)?.classList.add('open');
        if (next === 'color') this.$('#pe-color-btn')?.classList.add('open');
        if (next === 'view') this.syncViewPanel();
        if (next === 'text') this.syncTextPanel();
        if (next === 'sticker') this.syncStickerPanel();
    }
    
    closePanels(only = null) {
        const map = { more: '#pe-more-menu', view: '#pe-view-panel', color: '#pe-color-panel', text: '#pe-text-panel', sticker: '#pe-sticker-panel' };
        for (const [name, sel] of Object.entries(map)) {
            if (only && !only.includes(name)) continue;
            const el = this.$(sel);
            if (el) el.hidden = true;
            if (this.openPanel === name) this.openPanel = null;
        }
        this.container?.querySelectorAll('[data-action].open, #pe-color-btn.open').forEach(el => {
            const name = el.dataset.action || 'color';
            if (!only || only.includes(name)) el.classList.remove('open');
        });
    }
    
    syncSeg(selector, attr, value) {
        this.container?.querySelectorAll(`${selector} [data-${attr}]`).forEach(btn => {
            btn.classList.toggle('active', String(btn.dataset[attr]) === String(value));
        });
    }
    
    syncAll() {
        this.renderSwatches();
        this.syncViewPanel();
        this.syncPreviewCard();
        this.syncToggles();
        this.syncOptbar();
        const select = this.$('#pe-palette-select');
        if (select) select.value = this.paletteId;
    }
    
    syncViewPanel() {
        if (!this.container) return;
        const bg = this.backgroundMode === 'checker' ? 'checker' : (contrastColor(this.backgroundColor) === '#000000' ? 'light' : 'dark');
        this.syncSeg('#pe-bg-seg', 'bg', bg);
        const preview = this.$('#pe-preview-toggle');
        if (preview) preview.checked = this.showPreview;
    }
    
    syncPreviewCard() {
        const card = this.$('#pe-preview-card');
        if (card) card.hidden = !this.showPreview;
        if (this.showPreview) this.schedulePreview();
    }
    
    syncToggles() {
        this.$('#pe-grid-btn')?.classList.toggle('active', this.showGrid);
        this.$('#pe-mirror-btn')?.classList.toggle('active', this.mirror);
    }
    
    syncOptbar() {
        const bar = this.$('#pe-optbar');
        if (!bar) return;
        const tool = pixelCanvas3.tool || this.tool;
        const sizeControl = `
            <div class="pe-opt-group">
                <span class="pe-label">Size</span>
                <button type="button" class="pe-icon-btn pe-mini" data-opt="size-dec" aria-label="Smaller" ${this.brushSize <= 1 ? 'disabled' : ''}>${ICONS.minus}</button>
                <span class="pe-size-value"><i style="--s:${Math.min(this.brushSize, 10)}"></i>${this.brushSize}</span>
                <button type="button" class="pe-icon-btn pe-mini" data-opt="size-inc" aria-label="Bigger" ${this.brushSize >= 10 ? 'disabled' : ''}>${ICONS.plus}</button>
            </div>`;
        const mirror = `<button type="button" class="pe-toggle ${this.mirror ? 'active' : ''}" data-opt="mirror">${ICONS.mirror}<span>Mirror</span></button>`;
        let html = '';
        if (tool === TOOLS.BRUSH || tool === TOOLS.ERASER) {
            html = sizeControl + mirror;
        } else if (tool === TOOLS.LINE) {
            html = sizeControl + mirror + '<span class="pe-hint">Hold Shift for straight lines</span>';
        } else if (tool === TOOLS.RECT || tool === TOOLS.ELLIPSE) {
            html = sizeControl +
                `<button type="button" class="pe-toggle ${this.shapeFilled ? 'active' : ''}" data-opt="filled">${ICONS.fillShape}<span>Filled</span></button>` +
                mirror + `<span class="pe-hint">Shift: perfect ${tool === TOOLS.RECT ? 'square' : 'circle'}</span>`;
        } else if (tool === TOOLS.FILL) {
            html = '<span class="pe-hint">Click an area to fill it</span>';
        } else if (tool === TOOLS.PICKER) {
            html = '<span class="pe-hint">Click a pixel to use its color</span>';
        } else if (tool === TOOLS.PAN) {
            html = '<span class="pe-hint">Drag to move · scroll or pinch to zoom</span>';
        } else if (tool === TOOLS.STAMP) {
            html = `<span class="pe-hint">${this.stampSource === 'text' ? 'Tap or click where the text should go' : 'Tap or click to stamp · again for more'}</span>` +
                `<button type="button" class="pe-toggle" data-opt="cancel-stamp">${ICONS.close}<span>Done</span></button>`;
        }
        bar.innerHTML = html;
        bar.hidden = !html;
    }
    
    // ---------- 도구/색상 ----------
    
    setTool(tool, { keepStamp = false } = {}) {
        if (tool !== TOOLS.STAMP && !keepStamp) {
            pixelCanvas3.setStamp(null);
            this.stampSource = null;
        }
        this.tool = tool;
        pixelCanvas3.setTool(tool);
        this.container?.querySelectorAll('.pe-tool[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        this.container?.querySelectorAll('.pe-tool[data-action="text"], .pe-tool[data-action="sticker"]').forEach(btn => {
            btn.classList.toggle('active', tool === TOOLS.STAMP && btn.dataset.action === this.stampSource);
        });
        this.syncOptbar();
    }
    
    setColor(color, { remember = false } = {}) {
        if (!color) return;
        this.color = color.toLowerCase();
        pixelCanvas3.setColor(this.color);
        const swatch = this.$('#pe-color-swatch');
        if (swatch) swatch.style.background = this.color;
        const input = this.$('#pe-color-input');
        if (input && input.value !== this.color) input.value = this.color;
        const hex = this.$('#pe-hex-input');
        if (hex && document.activeElement !== hex) hex.value = this.color;
        if (remember) {
            this.recentColors = [this.color, ...this.recentColors.filter(c => c !== this.color)].slice(0, MAX_RECENT);
            this.persist();
        }
        this.renderSwatches();
        if (this.stampSource === 'text') this.updateTextStamp();
        if (this.stampSource === 'sticker') this.updateStickerStamp();
        if (this.openPanel === 'sticker') this.renderStickerGrid();
        pixelCanvas3.scheduleOverlay();
    }
    
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(10, size));
        pixelCanvas3.setBrushSize(this.brushSize);
        this.persist();
        this.syncOptbar();
        pixelCanvas3.scheduleOverlay();
    }
    
    toggleGrid() {
        this.showGrid = !this.showGrid;
        pixelCanvas3.setGrid(this.showGrid);
        this.persist();
        this.syncToggles();
    }
    
    toggleMirror() {
        this.mirror = !this.mirror;
        pixelCanvas3.setMirror(this.mirror);
        this.syncToggles();
        this.syncOptbar();
    }
    
    toggleShapeFilled() {
        this.shapeFilled = !this.shapeFilled;
        pixelCanvas3.setShapeFilled(this.shapeFilled);
        this.persist();
        this.syncOptbar();
    }
    
    setBackground(mode, color) {
        this.backgroundMode = mode;
        if (color) this.backgroundColor = color;
        setBg({ mode, color: this.backgroundColor, checkerSize: this.checkerSize });
        pixelCanvas3.setBackground(mode, this.backgroundColor, this.checkerSize);
        pixelCanvas3.render();
        this.syncViewPanel();
    }
    
    renderSwatches() {
        const palette = PALETTES.find(p => p.id === this.paletteId) || PALETTES[0];
        const swatch = (c) => `<button type="button" class="pe-swatch ${c === this.color ? 'active' : ''}" data-color="${c}" style="--c:${c}" title="${c}" aria-label="${c}"></button>`;
        const grid = this.$('#pe-palette-swatches');
        if (grid) grid.innerHTML = palette.colors.map(swatch).join('');
        const recent = this.$('#pe-recent-swatches');
        if (recent) recent.innerHTML = this.recentColors.map(swatch).join('');
        const recentWrap = this.$('#pe-recent-wrap');
        if (recentWrap) recentWrap.hidden = this.recentColors.length === 0;
        const quick = this.$('#pe-quick-swatches');
        if (quick) {
            const colors = [...new Set([...this.recentColors.slice(0, 4), ...palette.colors])].slice(0, 10);
            quick.innerHTML = colors.map(swatch).join('');
        }
        const main = this.$('#pe-color-swatch');
        if (main) main.style.background = this.color;
    }
    
    // ---------- 글자 ----------
    
    syncTextPanel() {
        const font = this.$('#pe-text-font');
        if (font) font.value = this.textSettings.fontId;
        const outline = this.$('#pe-text-outline');
        if (outline) outline.checked = this.textSettings.outline;
        const input = this.$('#pe-text-input');
        if (input && input.value !== this.textSettings.text) input.value = this.textSettings.text;
        this.syncSeg('#pe-text-scale', 'scale', this.textSettings.scale);
        ensurePixelFonts().then(() => {
            if (this.openPanel === 'text') this.updateTextStamp();
        });
    }
    
    buildTextStamp() {
        const { text, fontId, scale, outline } = this.textSettings;
        return rasterizeText(text, {
            fontId,
            scale,
            color: this.color,
            outlineColor: outline ? contrastColor(this.color) : null
        });
    }
    
    updateTextStamp() {
        const stamp = this.textSettings.text.trim() ? this.buildTextStamp() : null;
        this.renderTextPreview(stamp);
        if (stamp) {
            if (pixelCanvas3.tool !== TOOLS.STAMP) this.toolBeforeStamp = pixelCanvas3.tool === TOOLS.PAN ? TOOLS.BRUSH : pixelCanvas3.tool;
            this.stampSource = 'text';
            pixelCanvas3.setStamp(stamp);
            this.setTool(TOOLS.STAMP);
        } else if (this.stampSource === 'text') {
            this.setTool(this.toolBeforeStamp || TOOLS.BRUSH);
        }
    }
    
    renderTextPreview(stamp = null) {
        const canvas = this.$('#pe-text-preview');
        const size = this.$('#pe-text-size');
        if (!canvas) return;
        if (!stamp) {
            canvas.width = 1;
            canvas.height = 1;
            canvas.style.display = 'none';
            if (size) size.textContent = 'Type something to see it in pixels';
            return;
        }
        const cell = Math.max(2, Math.min(6, Math.floor(260 / Math.max(stamp.w, 1))));
        canvas.width = stamp.w * cell;
        canvas.height = stamp.h * cell;
        canvas.style.display = 'block';
        const ctx = canvas.getContext('2d');
        for (const c of stamp.cells) {
            ctx.fillStyle = c.color;
            ctx.fillRect(c.dx * cell, c.dy * cell, cell, cell);
        }
        if (size) size.textContent = `${stamp.w} × ${stamp.h} px${stamp.w > pixelCanvas3.width ? ' · wider than the canvas' : ''}`;
    }
    
    // ---------- 스티커 ----------
    
    renderStickerGrid() {
        const grid = this.$('#pe-sticker-grid');
        if (!grid) return;
        grid.innerHTML = STICKERS.map(s => {
            const url = stickerPreviewURL(this.stickerSettings.recolorAll ? { ...s, rows: s.rows.map(r => r.replace(/[^.C ]/g, 'C')) } : s, this.color);
            return `<button type="button" class="pe-sticker ${this.stickerSettings.id === s.id ? 'active' : ''}" data-sticker="${s.id}" title="${escapeHtml(s.name)}" aria-label="${escapeHtml(s.name)}"><img src="${url}" alt=""></button>`;
        }).join('');
    }
    
    syncStickerPanel() {
        this.syncSeg('#pe-sticker-scale', 'scale', this.stickerSettings.scale);
        const recolor = this.$('#pe-sticker-recolor');
        if (recolor) recolor.checked = this.stickerSettings.recolorAll;
        this.renderStickerGrid();
    }
    
    updateStickerStamp() {
        const sticker = STICKERS.find(s => s.id === this.stickerSettings.id);
        if (!sticker) return;
        const stamp = stickerToStamp(sticker, {
            scale: this.stickerSettings.scale,
            color: this.color,
            recolorAll: this.stickerSettings.recolorAll
        });
        if (pixelCanvas3.tool !== TOOLS.STAMP) this.toolBeforeStamp = pixelCanvas3.tool === TOOLS.PAN ? TOOLS.BRUSH : pixelCanvas3.tool;
        this.stampSource = 'sticker';
        pixelCanvas3.setStamp(stamp);
        this.setTool(TOOLS.STAMP);
        this.container?.querySelectorAll('.pe-sticker').forEach(btn => btn.classList.toggle('active', btn.dataset.sticker === sticker.id));
    }
    
    // ---------- 지도 미리보기 ----------
    
    schedulePreview() {
        if (!this.isOpen || !this.showPreview || this.previewTimer) return;
        this.previewTimer = setTimeout(() => {
            this.previewTimer = null;
            this.drawPreview();
        }, 180);
    }
    
    drawPreview() {
        const canvas = this.$('#pe-preview-canvas');
        if (!canvas || !this.showPreview) return;
        const dpr = window.devicePixelRatio || 1;
        const css = canvas.clientWidth || 176;
        if (canvas.width !== Math.round(css * dpr)) {
            canvas.width = Math.round(css * dpr);
            canvas.height = Math.round(css * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.clearRect(0, 0, css, css);
        ctx.fillStyle = '#0f131b';
        ctx.fillRect(0, 0, css, css);
        const k = css / (pixelCanvas3.width * pixelCanvas3.basePixelSize);
        if (pixelCanvas3.boundaryPath) {
            ctx.save();
            ctx.scale(k, k);
            ctx.fillStyle = '#252c3a';
            ctx.fill(pixelCanvas3.boundaryPath, 'evenodd');
            ctx.restore();
        }
        const cell = css / pixelCanvas3.width;
        for (const [key, color] of pixelCanvas3.pixelsMap.entries()) {
            const [x, y] = key.split(',').map(Number);
            ctx.fillStyle = color;
            ctx.fillRect(x * cell, y * cell, cell + 0.35, cell + 0.35);
        }
        if (pixelCanvas3.boundaryPath) {
            ctx.save();
            ctx.scale(k, k);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.lineWidth = 1 / k;
            ctx.stroke(pixelCanvas3.boundaryPath);
            ctx.restore();
        }
    }
    
    // ---------- 상태 표시 ----------
    
    updateStats(data) {
        const el = this.$('#pe-count');
        if (el) el.textContent = `${(data?.filledPixels || 0).toLocaleString()} px painted`;
    }
    
    updateSaveStatus(status, error = null, message = null, saveTime = null) {
        const el = this.$('#pe-save-status');
        if (!el) return;
        const text = el.querySelector('span');
        el.classList.remove('saving', 'saved', 'error', 'pending', 'unsaved');
        el.title = '';
        
        if (status === 'unsaved' || status === 'pending') {
            el.classList.add('unsaved');
            text.textContent = 'Unsaved';
        } else if (status === 'saving') {
            el.classList.add('saving');
            text.textContent = message || 'Saving…';
        } else if (status === 'saved') {
            this.saveRetryCount = 0;
            el.classList.add('saved');
            const time = saveTime ? new Date(saveTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null;
            text.textContent = time ? `Saved ${time}` : 'Saved';
        } else if (status === 'error') {
            el.classList.add('error');
            text.textContent = message || 'Save failed';
            el.title = error || 'An error occurred while saving. Please try again.';
            // 권한 문제 등으로 계속 실패하면 무한 반복하지 않도록 최대 3회 다시 시도
            this.saveRetryCount = (this.saveRetryCount || 0) + 1;
            if (this.saveRetryCount <= 3) {
                setTimeout(() => {
                    if (this.isOpen && !pixelCanvas3.isSaving) pixelCanvas3.save().catch(() => {});
                }, 5000);
            }
        }
        this.$('#pe-save')?.classList.toggle('attention', status === 'unsaved' || status === 'pending' || status === 'error');
    }
    
    updateTerritoryInfo() {
        const el = this.$('#pe-territory-name');
        if (el && this.currentTerritory) {
            el.textContent = this.currentTerritory.name?.en || this.currentTerritory.name?.ko ||
                (typeof this.currentTerritory.name === 'string' ? this.currentTerritory.name : '') || this.currentTerritory.id;
        }
    }
    
    showShortcutsModal() {
        if (this.shortcutsModalVisible) {
            this.hideShortcutsModal();
            return;
        }
        const modal = document.createElement('div');
        modal.className = 'pe-shortcuts';
        modal.innerHTML = `
            <div class="pe-shortcuts-card" role="dialog" aria-label="Keyboard shortcuts">
                <div class="pe-sheet-head"><strong>Keyboard shortcuts</strong>
                    <button class="pe-icon-btn pe-mini" type="button" data-close aria-label="Close">${ICONS.close}</button></div>
                <dl>${SHORTCUTS.map(([k, d]) => `<dt>${k.split(' / ').map(x => `<kbd>${escapeHtml(x)}</kbd>`).join(' / ')}</dt><dd>${escapeHtml(d)}</dd>`).join('')}</dl>
            </div>`;
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('[data-close]')) this.hideShortcutsModal();
        });
        this.container.appendChild(modal);
        this.shortcutsModalVisible = true;
    }
    
    hideShortcutsModal() {
        this.container?.querySelector('.pe-shortcuts')?.remove();
        this.shortcutsModalVisible = false;
    }
}

export const pixelEditor3 = new PixelEditor3();
export default pixelEditor3;
