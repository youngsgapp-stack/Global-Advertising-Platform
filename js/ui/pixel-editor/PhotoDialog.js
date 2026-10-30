/**
 * 픽셀 에디터의 "사진 올리기" 창
 * 사진 하나를 영토 모양에 맞춰 놓고 → 픽셀 아트로 넣거나(무료, 붓으로 고칠 수 있음) HD 사진으로 올림(지도에 선명하게)
 */

import { apiService } from '../../services/ApiService.js';
import { renderMaskedPhoto, encodeForUpload, uploadHdPhoto, loadImage, MAX_FILE_BYTES } from '../HdPhotoUploader.js';
import { ICONS } from './PixelEditorAssets.js';

const PREVIEW_SIZE = 512;
const ACCEPT = 'image/png,image/jpeg,image/webp';
const FREE_REASONS = {
    lifetime: 'Included with lifetime ownership',
    month_or_longer: 'Included with your 1-month+ plan',
    billboard: 'Included with your billboard week'
};

const formatPt = (n) => `${Number(n || 0).toLocaleString('en-US')} pt`;
const formatUsd = (n) => `$${(Number(n || 0) / 10).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * 사진을 128×128 픽셀 그리드 색으로 바꿈 (알파 50% 미만 칸은 비움)
 */
function photoToPixels(image, geometry, view, gridSize, quality = 8) {
    const masked = renderMaskedPhoto(image, geometry, view, gridSize * quality);
    const small = document.createElement('canvas');
    small.width = small.height = gridSize;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(masked, 0, 0, gridSize, gridSize);
    const { data } = ctx.getImageData(0, 0, gridSize, gridSize);
    const pixels = [];
    const hex = (v) => v.toString(16).padStart(2, '0');
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const i = (y * gridSize + x) * 4;
            if (data[i + 3] < 128) continue;
            pixels.push([x, y, `#${hex(data[i])}${hex(data[i + 1])}${hex(data[i + 2])}`]);
        }
    }
    return pixels;
}

export class PhotoDialog {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.host - 창을 붙일 곳 (에디터 루트, 디자인 변수를 물려받음)
     * @param {object} opts.territory
     * @param {object} opts.geometry - 영토 GeoJSON geometry
     * @param {number} opts.gridSize
     * @param {(pixels: Array<[number, number, string]>) => void} opts.onPixels
     * @param {(url: string) => void} opts.onHdUploaded
     * @param {(message: string, type?: string) => void} opts.notify
     * @param {() => void} opts.onNeedPoints
     */
    constructor(opts) {
        this.opts = opts;
        this.image = null;
        this.view = { fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
        this.mode = 'pixel';
        this.hd = null;
        this.busy = false;
        this.el = null;
        this.drawFrame = null;
        this.onPaste = (e) => this.handlePaste(e);
        this.onKey = (e) => {
            if (e.key === 'Escape' && !this.busy) {
                e.stopPropagation();
                this.close();
            }
        };
    }
    
    open() {
        this.el = document.createElement('div');
        this.el.className = 'pe-modal';
        this.el.innerHTML = this.html();
        this.opts.host.appendChild(this.el);
        this.bind();
        this.showStep('pick');
        document.addEventListener('paste', this.onPaste);
        document.addEventListener('keydown', this.onKey, true);
        this.loadHdStatus();
    }
    
    close() {
        document.removeEventListener('paste', this.onPaste);
        document.removeEventListener('keydown', this.onKey, true);
        if (this.drawFrame) cancelAnimationFrame(this.drawFrame);
        this.el?.remove();
        this.el = null;
    }
    
    $(sel) {
        return this.el?.querySelector(sel);
    }
    
    html() {
        return `
            <div class="pe-modal-card" role="dialog" aria-label="Add a photo">
                <div class="pe-modal-head">
                    <div>
                        <strong>Add a photo</strong>
                        <span class="pe-hint">Logo, product shot, anything you like</span>
                    </div>
                    <button class="pe-icon-btn" type="button" data-close aria-label="Close">${ICONS.close}</button>
                </div>
                
                <div class="pe-photo-pick" data-step="pick">
                    <label class="pe-dropzone" data-drop>
                        <input type="file" accept="${ACCEPT}" data-file hidden>
                        <span class="pe-dropzone-icon">${ICONS.image}</span>
                        <strong>Choose a photo</strong>
                        <span>or drag it here · or paste with Ctrl+V</span>
                        <small>PNG, JPG or WebP · up to 15 MB</small>
                    </label>
                </div>
                
                <div class="pe-photo-edit" data-step="edit" hidden>
                    <div class="pe-photo-stage">
                        <canvas data-preview width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}"></canvas>
                        <span class="pe-photo-tip">Drag to move</span>
                    </div>
                    <div class="pe-photo-side">
                        <div class="pe-row">
                            <div class="pe-seg" data-fit-seg>
                                <button type="button" data-fit="cover">Fill the spot</button>
                                <button type="button" data-fit="contain">Show all</button>
                            </div>
                        </div>
                        <div class="pe-field">
                            <label>Size</label>
                            <input type="range" min="0.3" max="4" step="0.05" value="1" data-zoom>
                        </div>
                        <button type="button" class="pe-link-btn" data-change>Use a different photo</button>
                        
                        <div class="pe-mode-list">
                            <button type="button" class="pe-mode" data-mode="pixel">
                                <span class="pe-mode-icon">${ICONS.grid}</span>
                                <span class="pe-mode-text">
                                    <strong>Pixel art</strong>
                                    <span>Turns into pixels you can touch up with the brush.</span>
                                    <em class="pe-mode-tag free">Free</em>
                                </span>
                            </button>
                            <button type="button" class="pe-mode" data-mode="hd">
                                <span class="pe-mode-icon">${ICONS.image}</span>
                                <span class="pe-mode-text">
                                    <strong>HD photo</strong>
                                    <span>Shows the photo sharp on the map, cut to your spot's shape.</span>
                                    <em class="pe-mode-tag" data-hd-tag>Checking…</em>
                                </span>
                            </button>
                        </div>
                        <p class="pe-note" data-hd-note hidden></p>
                    </div>
                </div>
                
                <div class="pe-modal-foot">
                    <p class="pe-status" data-status></p>
                    <button class="pe-btn-ghost" type="button" data-close>Cancel</button>
                    <button class="pe-btn-primary" type="button" data-apply disabled>${ICONS.check}<span data-apply-label>Add as pixel art</span></button>
                </div>
            </div>
        `;
    }
    
    bind() {
        this.el.addEventListener('click', (e) => {
            if (e.target === this.el || e.target.closest('[data-close]')) {
                if (!this.busy) this.close();
            }
        });
        const fileInput = this.$('[data-file]');
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (file) this.useFile(file);
        });
        const drop = this.$('[data-drop]');
        ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, (e) => {
            e.preventDefault();
            drop.classList.add('over');
        }));
        ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('over')));
        drop.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
            if (file) this.useFile(file);
        });
        this.$('[data-change]').addEventListener('click', () => fileInput.click());
        
        this.el.querySelectorAll('[data-fit]').forEach(btn => btn.addEventListener('click', () => {
            this.view.fit = btn.dataset.fit;
            this.view.zoom = 1;
            this.view.offsetX = 0;
            this.view.offsetY = 0;
            this.$('[data-zoom]').value = 1;
            this.sync();
        }));
        this.$('[data-zoom]').addEventListener('input', (e) => {
            this.view.zoom = Number(e.target.value);
            this.scheduleDraw();
        });
        this.el.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
            this.mode = btn.dataset.mode;
            this.sync();
        }));
        this.$('[data-apply]').addEventListener('click', () => this.apply());
        
        // 미리보기를 끌어서 사진 위치 옮기기 (마우스/터치 공통)
        const preview = this.$('[data-preview]');
        let drag = null;
        preview.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY, ox: this.view.offsetX, oy: this.view.offsetY };
            preview.setPointerCapture(e.pointerId);
            preview.classList.add('dragging');
        });
        preview.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const rect = preview.getBoundingClientRect();
            this.view.offsetX = drag.ox + (e.clientX - drag.x) / rect.width;
            this.view.offsetY = drag.oy + (e.clientY - drag.y) / rect.height;
            this.scheduleDraw();
        });
        const end = () => {
            drag = null;
            preview.classList.remove('dragging');
        };
        preview.addEventListener('pointerup', end);
        preview.addEventListener('pointercancel', end);
        preview.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.view.zoom = Math.max(0.3, Math.min(4, this.view.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
            this.$('[data-zoom]').value = this.view.zoom;
            this.scheduleDraw();
        }, { passive: false });
    }
    
    handlePaste(e) {
        const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        const file = item.getAsFile();
        if (file) this.useFile(file);
    }
    
    async useFile(file) {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
            this.setStatus('Please use a PNG, JPG or WebP image.', 'error');
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            this.setStatus('Please choose a photo smaller than 15 MB.', 'error');
            return;
        }
        try {
            this.setStatus('Loading photo…');
            this.image = await loadImage(file);
            this.view = { fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
            this.$('[data-zoom]').value = 1;
            this.setStatus('');
            this.showStep('edit');
            this.sync();
        } catch {
            this.setStatus("That file couldn't be opened as an image.", 'error');
        }
    }
    
    showStep(step) {
        this.el.querySelectorAll('[data-step]').forEach(s => { s.hidden = s.dataset.step !== step; });
        this.$('.pe-modal-card').classList.toggle('wide', step === 'edit');
        this.$('[data-apply]').disabled = step !== 'edit';
    }
    
    async loadHdStatus() {
        try {
            this.hd = await apiService.get(`/hd/territories/${encodeURIComponent(this.opts.territory.id)}`);
        } catch {
            this.hd = { unavailable: true };
        }
        if (this.el) this.sync();
    }
    
    sync() {
        if (!this.el) return;
        this.el.querySelectorAll('[data-fit]').forEach(b => b.classList.toggle('active', b.dataset.fit === this.view.fit));
        this.el.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === this.mode));
        
        const tag = this.$('[data-hd-tag]');
        const note = this.$('[data-hd-note]');
        const hd = this.hd;
        let label = 'Add as pixel art';
        note.hidden = true;
        if (!hd) {
            tag.textContent = 'Checking…';
            tag.className = 'pe-mode-tag';
        } else if (hd.unavailable || hd.isOwner === false) {
            tag.textContent = 'Not available';
            tag.className = 'pe-mode-tag';
        } else if (hd.entitled) {
            tag.textContent = hd.freeReason ? FREE_REASONS[hd.freeReason] || 'Included' : 'Unlocked';
            tag.className = 'pe-mode-tag free';
        } else {
            tag.textContent = `Unlock ${formatPt(hd.unlockPrice)} (${formatUsd(hd.unlockPrice)})`;
            tag.className = 'pe-mode-tag paid';
        }
        
        if (this.mode === 'hd') {
            if (!hd) label = 'Checking…';
            else if (hd.unavailable || hd.isOwner === false) label = 'HD photo unavailable';
            else if (hd.entitled) label = hd.hasImage ? 'Replace HD photo' : 'Upload HD photo';
            else label = `Unlock for ${formatPt(hd.unlockPrice)} & upload`;
            note.hidden = false;
            note.textContent = hd?.hasImage
                ? 'This replaces your current HD photo. It goes live on the map right away.'
                : 'It goes live on the map right away and is shown instead of your pixel art. You can remove it later.';
        }
        this.$('[data-apply-label]').textContent = label;
        const disabled = !this.image || this.busy || (this.mode === 'hd' && (!hd || hd.unavailable || hd.isOwner === false));
        this.$('[data-apply]').disabled = disabled;
        this.scheduleDraw();
    }
    
    scheduleDraw() {
        if (!this.image || this.drawFrame) return;
        this.drawFrame = requestAnimationFrame(() => {
            this.drawFrame = null;
            this.draw();
        });
    }
    
    draw() {
        const canvas = this.$('[data-preview]');
        if (!canvas || !this.image) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const { geometry, gridSize } = this.opts;
        
        // 영토 밖으로 나간 부분도 흐리게 보여 줘서 위치를 맞추기 쉽게
        ctx.globalAlpha = 0.22;
        ctx.drawImage(renderMaskedPhoto(this.image, geometry, this.view, PREVIEW_SIZE, false), 0, 0);
        ctx.globalAlpha = 1;
        
        if (this.mode === 'pixel') {
            const pixels = photoToPixels(this.image, geometry, this.view, gridSize, 4);
            const cell = canvas.width / gridSize;
            for (const [x, y, color] of pixels) {
                ctx.fillStyle = color;
                ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
            }
        } else {
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(renderMaskedPhoto(this.image, geometry, this.view, PREVIEW_SIZE), 0, 0);
        }
        this.strokeOutline(ctx, canvas.width);
    }
    
    strokeOutline(ctx, size) {
        const path = this.opts.outlinePath;
        if (!path) return;
        const k = size / this.opts.outlineSize;
        ctx.save();
        ctx.scale(k, k);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.5 / k;
        ctx.stroke(path);
        ctx.restore();
    }
    
    setStatus(text, type = '') {
        const el = this.$('[data-status]');
        if (!el) return;
        el.textContent = text;
        el.className = `pe-status ${type}`;
    }
    
    async apply() {
        if (!this.image || this.busy) return;
        const { territory, geometry, gridSize } = this.opts;
        
        if (this.mode === 'pixel') {
            this.opts.onPixels(photoToPixels(this.image, geometry, this.view, gridSize));
            this.close();
            return;
        }
        
        this.busy = true;
        this.sync();
        try {
            if (!this.hd.entitled) {
                this.setStatus(`Unlocking for ${formatPt(this.hd.unlockPrice)}…`);
                await apiService.post(`/hd/territories/${encodeURIComponent(territory.id)}/unlock`, {});
                this.hd = { ...this.hd, entitled: true, unlocked: true };
            }
            this.setStatus('Uploading HD photo…');
            const blob = await encodeForUpload(this.image, geometry, this.view);
            const url = await uploadHdPhoto(territory.id, blob);
            this.opts.onHdUploaded(url);
            this.close();
        } catch (error) {
            this.busy = false;
            if (error.status === 402) {
                this.setStatus('Not enough points to unlock HD photos.', 'error');
                this.opts.onNeedPoints?.();
            } else {
                this.setStatus(error.message || 'Upload failed. Please try again.', 'error');
            }
            this.sync();
        }
    }
}
