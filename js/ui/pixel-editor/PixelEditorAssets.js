/**
 * 픽셀 에디터 리소스: 아이콘(SVG), 팔레트, 스티커, 픽셀 글자 변환, 지도 밑그림 주소
 */

import { CONFIG } from '../../config.js';

const svg = (paths, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const ICONS = {
    brush: svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
    eraser: svg('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
    fill: svg('<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>'),
    picker: svg('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>'),
    line: svg('<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.5" fill="currentColor"/><circle cx="19" cy="5" r="1.5" fill="currentColor"/>'),
    rect: svg('<rect width="16" height="16" x="4" y="4" rx="1.5"/>'),
    ellipse: svg('<circle cx="12" cy="12" r="8.5"/>'),
    text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'),
    sticker: svg('<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M8.5 12.5h.01"/><path d="M15.5 12.5h.01"/><path d="M9.5 16s1 1.2 2.5 1.2 2.5-1.2 2.5-1.2"/>'),
    image: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
    pan: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
    undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
    redo: svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>'),
    zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
    zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/>'),
    fit: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    grid: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
    layers: svg('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
    mirror: svg('<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>'),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
    more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    keyboard: svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>'),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
    map: svg('<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>'),
    fillShape: svg('<rect width="16" height="16" x="4" y="4" rx="1.5" fill="currentColor"/>')
};

export const PALETTES = [
    {
        id: 'brand', name: 'Brand',
        colors: ['#000000', '#ffffff', '#e63946', '#f77f00', '#fcbf49', '#2a9d8f', '#06d6a0', '#118ab2',
            '#073b4c', '#3a86ff', '#8338ec', '#ff006e', '#fb5607', '#ffbe0b', '#6c757d', '#adb5bd']
    },
    {
        id: 'sweetie', name: 'Sweetie 16',
        colors: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
            '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57']
    },
    {
        id: 'pico8', name: 'PICO-8',
        colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
            '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa']
    },
    {
        id: 'pastel', name: 'Pastel',
        colors: ['#ffffff', '#f8e1e7', '#fbc4c4', '#f7a6a6', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff',
            '#a0c4ff', '#bdb2ff', '#ffc6ff', '#e2ece9', '#cddafd', '#dfe7fd', '#f0efeb', '#2b2d42']
    },
    {
        id: 'mono', name: 'Mono',
        colors: ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777',
            '#888888', '#999999', '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#ffffff']
    }
];

// 'C' = 지금 고른 색, '.' = 투명, 나머지 글자 = 고정 색
const STICKER_COLORS = {
    K: '#1a1a1a', W: '#ffffff', R: '#e63946', O: '#f77f00', Y: '#ffcd3c', G: '#2a9d8f', B: '#3a86ff', P: '#ff77a8'
};

export const STICKERS = [
    { id: 'heart', name: 'Heart', rows: ['.CC...CC.', 'CCCC.CCCC', 'CCCCCCCCC', 'CCCCCCCCC', '.CCCCCCC.', '..CCCCC..', '...CCC...', '....C....'] },
    { id: 'star', name: 'Star', rows: ['....C....', '....C....', '...CCC...', 'CCCCCCCCC', '.CCCCCCC.', '..CCCCC..', '..CC.CC..', '.CC...CC.', '.C.....C.'] },
    { id: 'sparkle', name: 'Sparkle', rows: ['...C...', '...C...', '..CCC..', 'CCCCCCC', '..CCC..', '...C...', '...C...'] },
    { id: 'pin', name: 'Map pin', rows: ['..CCCCC..', '.CCCCCCC.', 'CCC...CCC', 'CCC...CCC', 'CCC...CCC', '.CCCCCCC.', '..CCCCC..', '...CCC...', '....C....'] },
    { id: 'arrow', name: 'Arrow', rows: ['.....C...', '.....CC..', 'CCCCCCCC.', 'CCCCCCCCC', 'CCCCCCCC.', '.....CC..', '.....C...'] },
    { id: 'check', name: 'Check', rows: ['........C', '.......CC', 'C.....CC.', 'CC...CC..', '.CC.CC...', '..CCC....', '...C.....'] },
    { id: 'bolt', name: 'Lightning', rows: ['...CCC', '..CCC.', '.CCC..', 'CCCCCC', '..CCC.', '.CCC..', '.CC...', 'CC....', 'C.....'] },
    { id: 'crown', name: 'Crown', rows: ['C....C....C', 'CC..CCC..CC', 'CCC.CCC.CCC', 'CCCCCCCCCCC', 'CCCCCCCCCCC', 'CCCCCCCCCCC'] },
    { id: 'smile', name: 'Smiley', rows: ['..YYYYY..', '.YYYYYYY.', 'YYKYYYKYY', 'YYKYYYKYY', 'YYYYYYYYY', 'YKYYYYYKY', 'YYKKKKKYY', '.YYYYYYY.', '..YYYYY..'] },
    { id: 'fire', name: 'Fire', rows: ['...R....', '...RR...', '..RRR.R.', '..RORRR.', '.RROORR.', '.ROOYORR', 'RROYYORR', 'RROYYYOR', '.RROYORR', '..RRRRR.'] },
    { id: 'cloud', name: 'Cloud', rows: ['...CCC....', '..CCCCC...', '.CCCCCCCC.', 'CCCCCCCCCC', 'CCCCCCCCCC', '.CCCCCCCC.'] },
    { id: 'gift', name: 'Gift', rows: ['..R...R..', '...R.R...', 'RRRRRRRRR', 'RRRRYRRRR', 'RRRRYRRRR', '.RRRYRRR.', '.RRRYRRR.', '.RRRYRRR.'] }
];

/**
 * 스티커 → 도장 데이터 (scale: 정수 배율, color: 'C' 칸에 쓸 색, recolorAll: 고정 색도 내 색으로)
 */
export function stickerToStamp(sticker, { scale = 1, color, recolorAll = false } = {}) {
    const cells = [];
    const h = sticker.rows.length;
    const w = Math.max(...sticker.rows.map(r => r.length));
    sticker.rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (ch === '.' || ch === ' ') return;
            const c = ch === 'C' || recolorAll ? color : STICKER_COLORS[ch];
            if (!c) return;
            for (let sy = 0; sy < scale; sy++) {
                for (let sx = 0; sx < scale; sx++) {
                    cells.push({ dx: x * scale + sx, dy: y * scale + sy, color: c });
                }
            }
        });
    });
    return { w: w * scale, h: h * scale, cells };
}

/** 스티커 미리보기 그림 (작은 data URL) */
export function stickerPreviewURL(sticker, color) {
    const stamp = stickerToStamp(sticker, { color });
    const cell = 4;
    const canvas = document.createElement('canvas');
    canvas.width = stamp.w * cell;
    canvas.height = stamp.h * cell;
    const ctx = canvas.getContext('2d');
    for (const c of stamp.cells) {
        ctx.fillStyle = c.color;
        ctx.fillRect(c.dx * cell, c.dy * cell, cell, cell);
    }
    return canvas.toDataURL();
}

const GALMURI_CSS = 'https://cdn.jsdelivr.net/npm/galmuri@2.40.3/dist/galmuri.css';

// 픽셀 글꼴은 정해진 크기에서만 또렷하게 찍힘 (Galmuri: 한글·영어·일본어 지원)
export const TEXT_FONTS = [
    { id: 'pixel', name: 'Pixel', css: '12px Galmuri11', lineHeight: 13, pixel: true },
    { id: 'pixel-bold', name: 'Pixel Bold', css: 'bold 12px Galmuri11', lineHeight: 13, pixel: true },
    { id: 'pixel-small', name: 'Pixel Small', css: '10px Galmuri9', lineHeight: 11, pixel: true },
    { id: 'pixel-tiny', name: 'Pixel Tiny', css: '8px Galmuri7', lineHeight: 9, pixel: true },
    { id: 'smooth', name: 'Smooth (large)', css: 'bold 20px Pretendard, "Apple SD Gothic Neo", "Segoe UI", sans-serif', lineHeight: 22, pixel: false }
];

let fontLinkAdded = false;
export async function ensurePixelFonts() {
    if (!fontLinkAdded) {
        fontLinkAdded = true;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = GALMURI_CSS;
        document.head.appendChild(link);
    }
    try {
        await Promise.all(TEXT_FONTS.filter(f => f.pixel).map(f => document.fonts.load(f.css, '가A')));
    } catch {
        // 글꼴을 못 불러오면 기본 글꼴로 그려짐
    }
}

/**
 * 글자 → 도장 데이터. 알파 50% 이상인 칸만 픽셀로 바꾸고, 배율·외곽선을 적용
 */
export function rasterizeText(text, { fontId = 'pixel', scale = 1, color = '#000000', outlineColor = null } = {}) {
    const font = TEXT_FONTS.find(f => f.id === fontId) || TEXT_FONTS[0];
    const lines = String(text || '').split('\n').slice(0, 6);
    if (!lines.some(l => l.trim())) return null;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = font.css;
    const width = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width))) + 4;
    const height = lines.length * font.lineHeight + 6;
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    ctx.font = font.css;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    lines.forEach((line, i) => ctx.fillText(line, 1, 1 + i * font.lineHeight));

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const on = new Set();
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            if (data[(y * canvas.width + x) * 4 + 3] >= 128) {
                on.add(`${x},${y}`);
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;

    const pad = outlineColor ? 1 : 0;
    const fill = new Map();
    for (const key of on) {
        const [x, y] = key.split(',').map(Number);
        for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
                fill.set(`${(x - minX) * scale + sx + pad},${(y - minY) * scale + sy + pad}`, color);
            }
        }
    }
    const cells = [];
    if (outlineColor) {
        const outline = new Set();
        for (const key of fill.keys()) {
            const [x, y] = key.split(',').map(Number);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const k = `${x + dx},${y + dy}`;
                    if (!fill.has(k)) outline.add(k);
                }
            }
        }
        for (const key of outline) {
            const [x, y] = key.split(',').map(Number);
            cells.push({ dx: x, dy: y, color: outlineColor });
        }
    }
    for (const [key, c] of fill) {
        const [x, y] = key.split(',').map(Number);
        cells.push({ dx: x, dy: y, color: c });
    }
    return {
        w: (maxX - minX + 1) * scale + pad * 2,
        h: (maxY - minY + 1) * scale + pad * 2,
        cells
    };
}

export const UNDERLAY_STYLES = [
    { id: 'satellite', name: 'Satellite', style: 'mapbox/satellite-streets-v12' },
    { id: 'streets', name: 'Map', style: 'mapbox/streets-v12' },
    { id: 'off', name: 'Off', style: null }
];

/**
 * 픽셀 그리드 영역(Mercator 정사각형)과 똑같이 맞는 Mapbox 정적 지도 주소
 * 지도 범위를 벗어나는 아주 큰 영토는 정확히 맞출 수 없어 null
 */
export function underlayURL(bounds, styleId, size = 1024) {
    const style = UNDERLAY_STYLES.find(s => s.id === styleId)?.style;
    const token = CONFIG.MAPBOX?.ACCESS_TOKEN;
    if (!style || !token || !bounds) return null;
    const { minLng, minLat, maxLng, maxLat } = bounds;
    if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
    if (minLng < -180 || maxLng > 180 || minLat < -85.05 || maxLat > 85.05) return null;
    const bbox = [minLng, minLat, maxLng, maxLat].map(v => v.toFixed(6)).join(',');
    return `https://api.mapbox.com/styles/v1/${style}/static/[${bbox}]/${size}x${size}?padding=0&logo=false&attribution=false&access_token=${encodeURIComponent(token)}`;
}

const underlayCache = new Map();
export function loadUnderlayImage(url) {
    if (!url) return Promise.resolve(null);
    if (underlayCache.has(url)) return underlayCache.get(url);
    const promise = new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => {
            underlayCache.delete(url);
            resolve(null);
        };
        img.src = url;
    });
    underlayCache.set(url, promise);
    return promise;
}
