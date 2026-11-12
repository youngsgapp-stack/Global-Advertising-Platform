/**
 * 쇼케이스 채우기 (관리자 전용): 운영자가 유명한 땅에 미리 그림을 넣어 지도를 살아 있게 보이게 함
 * 열기: 관리자로 로그인한 상태에서 /?showcase=1
 * 적용하면 땅 주인을 'World Ad Map'(30일)으로 지정하고 픽셀 아트를 저장 (30일 뒤에는 손님이 예약·경매로 가져갈 수 있음)
 */

import { apiService } from '../services/ApiService.js';
import { firebaseService } from '../services/FirebaseService.js';
import { territoryManager } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';
import { photoToPixels } from '../ui/pixel-editor/PhotoDialog.js';

const GRID = 128;
const TILE = 16;
const PROTECTION_DAYS = 30;

const stripes = (colors, vertical = true) => ({ stripes: colors, vertical });

const SHOWCASE_ITEMS = [
    // ① 국민 논쟁
    { id: 'napoli', group: 'Debate', bg: stripes(['#009246', '#ffffff', '#ce2b37']), emoji: '🍍', ban: true, lines: ['NO PINEAPPLE', 'ON PIZZA'] },
    { id: 'ontario', group: 'Debate', bg: '#d52b1e', emoji: '🍍🍕', lines: ['HAWAIIAN PIZZA', 'WAS BORN HERE'] },
    { id: 'brussels', group: 'Debate', bg: stripes(['#111111', '#fdda24', '#ef3340']), emoji: '🍟', lines: ['BELGIAN', 'FRIES'] },
    { id: 'paris', group: 'Debate', bg: stripes(['#0055a4', '#ffffff', '#ef4135']), emoji: '🍟', lines: ['FRENCH', 'FRIES?'] },
    { id: 'westminster', group: 'Debate', bg: '#012169', emoji: '🫖', lines: ['TEA', '> COFFEE'] },
    { id: 'washington', group: 'Debate', bg: '#3b2416', emoji: '☕', lines: ['COFFEE', '> TEA'] },
    // ② 라이벌 대결
    { id: 'buenos-aires', group: 'Rivals', bg: stripes(['#74acdf', '#ffffff', '#74acdf'], false), emoji: '🐐', lines: ['10', 'MESSI'], dark: true },
    { id: 'madeira', group: 'Rivals', bg: stripes(['#046a38', '#da291c']), emoji: '🐐', lines: ['CR7', 'GOAT'] },
    { id: 'madrid', group: 'Rivals', bg: '#ffffff', emoji: '👑', lines: ['HALA', 'MADRID'], dark: true },
    { id: 'barcelona', group: 'Rivals', bg: stripes(['#a50044', '#004d98', '#a50044', '#004d98']), emoji: '⚽', lines: ['VISCA', 'BARÇA'] },
    { id: 'new-york', group: 'Rivals', bg: '#0c2340', emoji: '⚾', lines: ['YANKEES', 'COUNTRY'] },
    { id: 'massachusetts', group: 'Rivals', bg: '#bd3039', emoji: '⚾', lines: ['RED SOX', 'NATION'] },
    // ③ 미스터리·밈
    { id: 'nevada', group: 'Memes', bg: '#0b2a12', emoji: '👽', lines: ["WE'RE", 'ALREADY HERE'] },
    { id: 'highland', group: 'Memes', bg: '#123d5c', emoji: '🦕', lines: ['NESSIE', 'LIVES'] },
    { id: 'antarctica', group: 'Memes', bg: '#e8f4ff', emoji: '🐧', lines: ['PENGUINS', 'ONLY'], dark: true },
    { id: 'vatican', group: 'Memes', bg: '#ffe000', emoji: '😇', lines: ['TINY', 'HEAVEN'], dark: true },
    { id: 'monaco', group: 'Memes', bg: stripes(['#ce1126', '#ffffff'], false), emoji: '💎', lines: ['OWN', 'MONACO'], dark: true },
    // ④ 빈자리 도발
    { id: 'texas', group: 'Bait', bg: '#002868', emoji: '🤠', lines: ['YOUR LOGO', 'HERE'] },
    { id: 'seoul', group: 'Bait', bg: '#cd2e3a', emoji: '📢', lines: ['YOUR AD', 'HERE'] }
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 그림 한 장(정사각형)을 그림: 배경 → 큰 이모지 → 굵은 글씨 두 줄 */
function drawArt(item, size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    if (typeof item.bg === 'string') {
        ctx.fillStyle = item.bg;
        ctx.fillRect(0, 0, size, size);
    } else {
        const { stripes: colors, vertical } = item.bg;
        const band = size / colors.length;
        colors.forEach((color, i) => {
            ctx.fillStyle = color;
            if (vertical) ctx.fillRect(i * band, 0, Math.ceil(band), size);
            else ctx.fillRect(0, i * band, size, Math.ceil(band));
        });
    }
    
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(size * 0.36)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.fillText(item.emoji, size / 2, size * 0.34);
    if (item.ban) {
        ctx.strokeStyle = '#e00000';
        ctx.lineWidth = size * 0.05;
        ctx.beginPath();
        ctx.arc(size / 2, size * 0.34, size * 0.2, 0, Math.PI * 2);
        ctx.moveTo(size / 2 - size * 0.14, size * 0.34 - size * 0.14);
        ctx.lineTo(size / 2 + size * 0.14, size * 0.34 + size * 0.14);
        ctx.stroke();
    }
    
    const fill = item.dark ? '#111111' : '#ffffff';
    const outline = item.dark ? '#ffffff' : '#000000';
    item.lines.forEach((line, i) => {
        let fontSize = size * 0.15;
        ctx.font = `900 ${fontSize}px "Arial Black","Segoe UI",Arial,sans-serif`;
        while (ctx.measureText(line).width > size * 0.92 && fontSize > 12) {
            fontSize -= 2;
            ctx.font = `900 ${fontSize}px "Arial Black","Segoe UI",Arial,sans-serif`;
        }
        const y = size * (0.66 + i * 0.17);
        ctx.lineJoin = 'round';
        ctx.lineWidth = fontSize * 0.18;
        ctx.strokeStyle = outline;
        ctx.strokeText(line, size / 2, y);
        ctx.fillStyle = fill;
        ctx.fillText(line, size / 2, y);
    });
    return canvas;
}

async function findGeometry(territoryId, waitMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
        const territory = territoryManager.getTerritory(territoryId);
        const map = mapController.map;
        if (territory && territory.sourceId && map) {
            const source = map.getSource(territory.sourceId);
            const feature = source?._data?.features?.find(f =>
                String(f.id) === String(territory.featureId) || String(f.properties?.id) === String(territoryId));
            const geometry = feature?.geometry || territory.geometry;
            if (geometry) return { geometry, territory };
        }
        await sleep(300);
    }
    return null;
}

function toTiles(territoryId, pixels) {
    const byTile = new Map();
    for (const [x, y, color] of pixels) {
        const tileId = `${territoryId}:${Math.floor(x / TILE)}:${Math.floor(y / TILE)}`;
        if (!byTile.has(tileId)) byTile.set(tileId, []);
        byTile.get(tileId).push({ x, y, color });
    }
    return [...byTile.entries()].map(([tileId, tilePixels]) => ({ tileId, pixels: tilePixels, revision: 0 }));
}

function drawPreview(canvas, pixels) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, GRID, GRID);
    for (const [x, y, color] of pixels) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
    }
}

export async function openShowcaseTool() {
    let user = firebaseService.getCurrentUser();
    for (let i = 0; i < 30 && !user; i++) {
        await sleep(300);
        user = firebaseService.getCurrentUser();
    }
    
    const panel = document.createElement('div');
    panel.id = 'showcase-tool';
    panel.style.cssText = 'position:fixed;top:12px;right:12px;bottom:12px;width:min(420px,calc(100vw - 24px));z-index:20000;background:rgba(13,17,23,0.97);color:#e6edf3;border:1px solid rgba(78,205,196,0.4);border-radius:14px;display:flex;flex-direction:column;font:14px/1.4 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    panel.innerHTML = `
        <div style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:8px;">
            <strong style="flex:1;font-size:16px;">🗺️ 쇼케이스 채우기 (관리자)</strong>
            <button type="button" data-close style="background:rgba(255,255,255,0.08);border:none;color:inherit;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px;">×</button>
        </div>
        <div data-intro style="padding:10px 16px;font-size:12px;opacity:0.8;">
            미리보기를 확인하고, 넣을 땅만 체크한 뒤 [적용]을 누르세요. 주인은 'World Ad Map'(${PROTECTION_DAYS}일)으로 지정되고, 그 뒤에는 손님이 예약·경매로 가져갈 수 있어요.
        </div>
        <div data-list style="flex:1;overflow-y:auto;padding:0 12px 12px;"></div>
        <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:8px;align-items:center;">
            <span data-summary style="flex:1;font-size:12px;opacity:0.8;"></span>
            <button type="button" data-apply style="background:linear-gradient(135deg,#4ecdc4,#44a08d);border:none;color:#0a0a1a;font-weight:700;padding:10px 16px;border-radius:10px;cursor:pointer;">적용</button>
        </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('[data-close]').addEventListener('click', () => panel.remove());
    
    const list = panel.querySelector('[data-list]');
    const summary = panel.querySelector('[data-summary]');
    const applyButton = panel.querySelector('[data-apply]');
    
    if (!user) {
        panel.querySelector('[data-intro]').textContent = '미리보기만 가능해요. 적용하려면 admin.html에서 관리자 계정으로 로그인한 뒤 이 페이지를 새로고침하세요.';
        applyButton.disabled = true;
        applyButton.style.opacity = '0.4';
    }
    
    const rows = [];
    for (const item of SHOWCASE_ITEMS) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-top:8px;';
        row.innerHTML = `
            <input type="checkbox" checked style="width:18px;height:18px;">
            <canvas width="${GRID}" height="${GRID}" style="width:72px;height:72px;image-rendering:pixelated;border-radius:6px;background:#0d1117;"></canvas>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:700;"></div>
                <div data-status style="font-size:12px;opacity:0.7;">준비 중...</div>
                <div style="margin-top:4px;display:flex;gap:4px;">
                    <button type="button" data-fit="cover" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(78,205,196,0.25);color:inherit;cursor:pointer;">꽉 채우기</button>
                    <button type="button" data-fit="contain" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:inherit;cursor:pointer;">전체 보이기</button>
                </div>
            </div>
        `;
        row.querySelector('div > div').textContent = `${item.id} · ${item.group} · ${item.lines.join(' ')}`;
        list.appendChild(row);
        rows.push({ item, row, checkbox: row.querySelector('input'), canvas: row.querySelector('canvas'), status: row.querySelector('[data-status]'), fit: 'cover', pixels: null, geometry: null });
    }
    
    const render = (entry) => {
        if (!entry.geometry) return;
        entry.pixels = photoToPixels(drawArt(entry.item), entry.geometry, { fit: entry.fit, zoom: 1, offsetX: 0, offsetY: 0 }, GRID);
        drawPreview(entry.canvas, entry.pixels);
        entry.status.textContent = `${entry.pixels.length.toLocaleString('en-US')} pixels`;
        entry.row.querySelectorAll('[data-fit]').forEach(b => { b.style.background = b.dataset.fit === entry.fit ? 'rgba(78,205,196,0.25)' : 'transparent'; });
    };
    const updateSummary = () => {
        summary.textContent = `${rows.filter(r => r.checkbox.checked && r.pixels?.length).length}곳 선택됨`;
    };
    
    for (const entry of rows) {
        entry.checkbox.addEventListener('change', updateSummary);
        entry.row.querySelectorAll('[data-fit]').forEach(b => b.addEventListener('click', () => { entry.fit = b.dataset.fit; render(entry); }));
        const found = await findGeometry(entry.item.id, 8000);
        if (!found) {
            entry.status.textContent = '지도에서 이 땅을 찾지 못했어요';
            entry.checkbox.checked = false;
            entry.checkbox.disabled = true;
            continue;
        }
        entry.geometry = found.geometry;
        if (found.territory.ruler && found.territory.sovereignty !== 'unconquered') {
            entry.status.textContent = '이미 주인이 있는 땅이라 건너뜀';
            entry.checkbox.checked = false;
            entry.checkbox.disabled = true;
            render(entry);
            entry.status.textContent = '이미 주인이 있는 땅이라 건너뜀';
            continue;
        }
        render(entry);
        if (!entry.pixels.length) {
            entry.status.textContent = '그림이 땅 안에 들어가지 않아요';
            entry.checkbox.checked = false;
        }
        updateSummary();
    }
    
    applyButton.addEventListener('click', async () => {
        const selected = rows.filter(r => r.checkbox.checked && r.pixels?.length);
        if (!selected.length) return;
        if (!confirm(`${selected.length}곳에 그림을 넣고 주인을 'World Ad Map'(${PROTECTION_DAYS}일)으로 지정할까요?`)) return;
        applyButton.disabled = true;
        let owner;
        try {
            owner = await apiService.post('/admin/showcase/owner', {});
        } catch (error) {
            summary.textContent = `관리자 확인 실패: ${error.message || error}`;
            applyButton.disabled = false;
            return;
        }
        let done = 0;
        for (const entry of selected) {
            entry.status.textContent = '주인 지정 중...';
            try {
                await apiService.post(`/admin/territories/${encodeURIComponent(entry.item.id)}/owner`, {
                    user: owner.id,
                    protectionDays: PROTECTION_DAYS,
                    clearPixels: true
                });
                entry.status.textContent = '그림 저장 중...';
                const response = await apiService.post(
                    `/territories/${encodeURIComponent(entry.item.id)}/pixels/tiles`,
                    { tiles: toTiles(entry.item.id, entry.pixels) },
                    { timeout: 120000 }
                );
                if (response?.conflicts?.length) throw new Error(`${response.conflicts.length} tiles conflicted`);
                entry.status.textContent = '✅ 완료';
                entry.checkbox.checked = false;
                done++;
            } catch (error) {
                entry.status.textContent = `❌ 실패: ${error.message || error}`;
            }
            summary.textContent = `${done}/${selected.length} 완료`;
        }
        summary.textContent = `${done}/${selected.length} 완료 — 새로고침하면 지도에 보여요`;
        applyButton.disabled = false;
    });
}
