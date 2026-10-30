/**
 * HD 사진: 사진을 영토 모양으로 잘라(영토 밖은 투명) 1024px WebP/PNG로 만들어 서버에 저장
 * 픽셀 그림과 같은 영역(PixelGridProjection의 Mercator 정사각형)에 맞춰 지도에 그대로 겹쳐짐
 * 화면은 픽셀 에디터의 사진 창(pixel-editor/PhotoDialog.js)에서 담당
 */

import { getPixelGridBounds, lngLatToGrid } from '../core/PixelGridProjection.js';
import { apiService } from '../services/ApiService.js';

const OUTPUT_SIZE = 1024;
const FALLBACK_SIZE = 768;
const MAX_UPLOAD_BYTES = 1.4 * 1024 * 1024;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

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
 * @param {boolean} clip - false면 자르지 않고 같은 위치에 그대로 그림 (위치 맞출 때 바깥을 흐리게 보여 주는 용도)
 */
export function renderMaskedPhoto(image, geometry, view, size = OUTPUT_SIZE, clip = true) {
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
    if (clip) ctx.clip('evenodd');
    
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
export async function encodeForUpload(image, geometry, view) {
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

export async function loadImage(file) {
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
 * @returns {Promise<string>} 지도에 올라간 사진 주소
 */
export async function uploadHdPhoto(territoryId, blob) {
    const token = await apiService.getAuthToken();
    const response = await fetch(`${apiService.baseUrl}/hd/territories/${encodeURIComponent(territoryId)}/image`, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type, Authorization: `Bearer ${token}` },
        body: blob
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Upload failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return data.url;
}
