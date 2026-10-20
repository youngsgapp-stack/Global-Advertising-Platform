/**
 * HD 사진 올리기: 사진을 영토 모양으로 잘라(영토 밖은 투명) 1024px WebP/PNG로 만들어 서버에 저장
 * 픽셀 그림과 같은 영역(PixelGridProjection의 Mercator 정사각형)에 맞춰 지도에 그대로 겹쳐짐
 */

import { getPixelGridBounds, lngLatToGrid } from '../core/PixelGridProjection.js';
import { apiService } from '../services/ApiService.js';
import { escapeHtml } from './ConfirmDialog.js';

const OUTPUT_SIZE = 1024;
const FALLBACK_SIZE = 768;
const MAX_UPLOAD_BYTES = 1.4 * 1024 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function geometryBounds(geometry) {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const walk = (coords) => {
        if (typeof coords[0] === 'number') {
            minLng = Math.min(minLng, coords[0]);
            maxLng = Math.max(maxLng, coords[0]);
            minLat = Math.min(minLat, coords[1]);
            maxLat = Math.max(maxLat, coords[1]);
        } else {
            coords.forEach(walk);
        }
    };
    walk(geometry.coordinates);
    return { minLng, maxLng, minLat, maxLat };
}

function polygonsOf(geometry) {
    return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

/**
 * 사진을 영토 모양으로 잘라 그림
 * @param {object} view - { fit: 'cover' | 'contain', zoom: number, offsetX: number, offsetY: number } (offset은 영토 영역 크기 대비 비율)
 */
export function renderMaskedPhoto(image, geometry, view, size = OUTPUT_SIZE) {
    const bounds = getPixelGridBounds(geometryBounds(geometry));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ctx.beginPath();
    for (const polygon of polygonsOf(geometry)) {
        for (const ring of polygon) {
            ring.forEach(([lng, lat], i) => {
                const { x, y } = lngLatToGrid(lng, lat, bounds, size, size);
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.closePath();
        }
    }
    ctx.save();
    ctx.clip('evenodd');
    
    const areaW = maxX - minX;
    const areaH = maxY - minY;
    const scaleFit = view.fit === 'contain'
        ? Math.min(areaW / image.width, areaH / image.height)
        : Math.max(areaW / image.width, areaH / image.height);
    const scale = scaleFit * view.zoom;
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const cx = minX + areaW / 2 + view.offsetX * areaW;
    const cy = minY + areaH / 2 + view.offsetY * areaH;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();
    return canvas;
}

function canvasToBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/** WebP 우선, 브라우저가 WebP를 못 만들면 PNG. 너무 크면 768px로 줄여 다시 */
async function encodeForUpload(image, geometry, view) {
    for (const size of [OUTPUT_SIZE, FALLBACK_SIZE]) {
        const canvas = renderMaskedPhoto(image, geometry, view, size);
        let blob = await canvasToBlob(canvas, 'image/webp', 0.86);
        if (!blob || blob.type !== 'image/webp') {
            blob = await canvasToBlob(canvas, 'image/png');
        }
        if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new Error('The photo is too detailed to save. Try a simpler image or zoom in a little.');
}

function pickFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.onchange = () => resolve(input.files?.[0] || null);
        input.click();
    });
}

async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

/**
 * @returns {Promise<{ url: string }|null>} 올린 사진 주소 (취소하면 null)
 */
export async function openHdPhotoUploader({ territoryId, territoryName, geometry }) {
    if (!geometry) throw new Error('The shape of this spot is not loaded yet. Please try again in a moment.');
    const file = await pickFile();
    if (!file) return null;
    if (file.size > MAX_FILE_BYTES) throw new Error('Please choose a photo smaller than 15 MB.');
    const image = await loadImage(file);
    
    return new Promise((resolve, reject) => {
        const view = { fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0 };
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;';
        overlay.innerHTML = `
            <div style="background:#1a2332;color:#e8eef5;border:1px solid rgba(78,205,196,0.4);border-radius:12px;width:min(440px,100%);padding:18px;font-family:inherit;">
                <h3 style="margin:0 0 6px;color:#4ecdc4;font-size:18px;">🖼️ HD photo for ${escapeHtml(territoryName || territoryId)}</h3>
                <p style="margin:0 0 10px;font-size:13px;opacity:0.8;">Drag to move. The photo is cut to the shape of your spot and shown sharp on the map.</p>
                <canvas data-preview width="360" height="360" style="width:100%;aspect-ratio:1;border-radius:8px;cursor:grab;touch-action:none;background:repeating-conic-gradient(#2a3546 0% 25%, #222c3b 0% 50%) 50%/20px 20px;"></canvas>
                <div style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;">
                    <label><input type="radio" name="hd-fit" value="cover" checked> Fill</label>
                    <label><input type="radio" name="hd-fit" value="contain"> Fit</label>
                    <span style="margin-left:auto;">Zoom</span>
                    <input data-zoom type="range" min="1" max="4" step="0.05" value="1" style="width:120px;">
                </div>
                <p data-status style="min-height:18px;margin:8px 0 0;font-size:12px;opacity:0.8;"></p>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
                    <button data-cancel style="background:transparent;color:#cfd8e3;border:1px solid rgba(255,255,255,0.25);border-radius:8px;padding:10px 16px;cursor:pointer;">Cancel</button>
                    <button data-save style="background:#4ecdc4;color:#0a0a1a;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;">Upload HD photo</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const preview = overlay.querySelector('[data-preview]');
        const status = overlay.querySelector('[data-status]');
        const saveButton = overlay.querySelector('[data-save]');
        const draw = () => {
            const rendered = renderMaskedPhoto(image, geometry, view, 512);
            const ctx = preview.getContext('2d');
            ctx.clearRect(0, 0, preview.width, preview.height);
            ctx.drawImage(rendered, 0, 0, preview.width, preview.height);
        };
        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        
        overlay.querySelectorAll('input[name="hd-fit"]').forEach(radio => radio.addEventListener('change', () => {
            view.fit = radio.value;
            draw();
        }));
        overlay.querySelector('[data-zoom]').addEventListener('input', (e) => {
            view.zoom = Number(e.target.value);
            draw();
        });
        let drag = null;
        preview.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
            preview.setPointerCapture(e.pointerId);
            preview.style.cursor = 'grabbing';
        });
        preview.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const rect = preview.getBoundingClientRect();
            view.offsetX = drag.ox + (e.clientX - drag.x) / rect.width;
            view.offsetY = drag.oy + (e.clientY - drag.y) / rect.height;
            draw();
        });
        const endDrag = () => {
            drag = null;
            preview.style.cursor = 'grab';
        };
        preview.addEventListener('pointerup', endDrag);
        preview.addEventListener('pointercancel', endDrag);
        overlay.querySelector('[data-cancel]').addEventListener('click', () => close(null));
        
        saveButton.addEventListener('click', async () => {
            saveButton.disabled = true;
            status.textContent = 'Uploading…';
            try {
                const blob = await encodeForUpload(image, geometry, view);
                const token = await apiService.getAuthToken();
                const response = await fetch(`${apiService.baseUrl}/hd/territories/${encodeURIComponent(territoryId)}/image`, {
                    method: 'PUT',
                    headers: { 'Content-Type': blob.type, Authorization: `Bearer ${token}` },
                    body: blob
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
                close({ url: data.url });
            } catch (error) {
                status.textContent = `❌ ${error.message}`;
                saveButton.disabled = false;
            }
        });
        
        try {
            draw();
        } catch (error) {
            overlay.remove();
            reject(error);
        }
    });
}
