/**
 * HD 사진 지도 표시: 화면에 보이는 영토의 사진만 불러와 픽셀 그림과 같은 자리(Mercator 정사각형)에 부드럽게 표시
 */

import { log } from '../config.js';
import { apiService } from '../services/ApiService.js';
import { getPixelGridBounds } from './PixelGridProjection.js';

const WORLD_SOURCE = 'world-territories';
const MAX_VISIBLE = 60;
const LIST_REFRESH_MS = 2 * 60 * 1000;

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

class HdImageLayer {
    constructor() {
        this.map = null;
        this.images = new Map();   // territoryId → { url, updatedAt }
        this.shown = new Map();    // territoryId → url
        this.boundsCache = new Map();
        this.refreshTimer = null;
    }
    
    async initialize(map) {
        if (!map || this.map) return;
        this.map = map;
        const schedule = () => {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => this.updateVisible(), 250);
        };
        map.on('moveend', schedule);
        map.on('idle', () => {
            if (this.shown.size === 0 && this.images.size > 0) schedule();
            this.keepAbovePixelArt();
        });
        map.on('styledata', () => {
            if (this.shown.size > 0 && ![...this.shown.keys()].every(id => map.getSource(`hd-${id}`))) {
                this.shown.clear();
                schedule();
            }
        });
        await this.reload();
        setInterval(() => this.reload(), LIST_REFRESH_MS);
    }
    
    async reload() {
        try {
            const list = await apiService.get('/hd/images');
            this.images = new Map((list || []).map(item => [item.territoryId, item]));
            this.updateVisible();
        } catch (error) {
            log.debug('[HdImageLayer] HD image list unavailable:', error.message);
        }
    }
    
    /** 업로드/삭제 직후 즉시 반영 */
    setImage(territoryId, url) {
        if (url) {
            this.images.set(territoryId, { territoryId, url });
        } else {
            this.images.delete(territoryId);
        }
        this.remove(territoryId);
        this.updateVisible();
    }
    
    findFeature(territoryId) {
        const data = this.map.getSource(WORLD_SOURCE)?._data;
        return data?.features?.find(f => f.properties?.id === territoryId) || null;
    }
    
    gridBounds(territoryId) {
        if (!this.boundsCache.has(territoryId)) {
            const feature = this.findFeature(territoryId);
            if (!feature?.geometry) return null;
            this.boundsCache.set(territoryId, { bounds: getPixelGridBounds(geometryBounds(feature.geometry)), featureId: feature.id });
        }
        return this.boundsCache.get(territoryId);
    }
    
    updateVisible() {
        if (!this.map || !this.map.getSource(WORLD_SOURCE) || this.images.size === 0) return;
        const view = this.map.getBounds();
        const visible = [];
        for (const [territoryId, item] of this.images) {
            const info = this.gridBounds(territoryId);
            if (!info) continue;
            const b = info.bounds;
            const onScreen = b.maxLng >= view.getWest() && b.minLng <= view.getEast() &&
                b.maxLat >= view.getSouth() && b.minLat <= view.getNorth();
            if (onScreen) visible.push({ territoryId, item, info });
        }
        const keep = new Set(visible.slice(0, MAX_VISIBLE).map(v => v.territoryId));
        for (const territoryId of [...this.shown.keys()]) {
            if (!keep.has(territoryId)) this.remove(territoryId);
        }
        for (const { territoryId, item, info } of visible.slice(0, MAX_VISIBLE)) {
            if (this.shown.get(territoryId) !== item.url) this.add(territoryId, item.url, info);
        }
    }
    
    add(territoryId, url, { bounds, featureId }) {
        this.remove(territoryId);
        const sourceId = `hd-${territoryId}`;
        const { minLng, maxLng, minLat, maxLat } = bounds;
        try {
            this.map.addSource(sourceId, {
                type: 'image',
                url,
                coordinates: [[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat]]
            });
            const beforeLayer = this.hdBeforeLayer();
            this.map.addLayer({
                id: sourceId,
                type: 'raster',
                source: sourceId,
                paint: { 'raster-opacity': 1, 'raster-fade-duration': 150, 'raster-resampling': 'linear' }
            }, beforeLayer);
            if (featureId !== undefined && featureId !== null) {
                this.map.setFeatureState({ source: WORLD_SOURCE, id: featureId }, { hasPixelArt: true });
            }
            this.shown.set(territoryId, url);
        } catch (error) {
            log.warn(`[HdImageLayer] Failed to show HD image for ${territoryId}:`, error.message);
        }
    }
    
    /** 픽셀 그림처럼 영토 색 위·경계선 아래에 둠 (keepAbovePixelArt가 픽셀 그림보다 위로 다시 맞춤) */
    hdBeforeLayer() {
        if (this.map.getLayer(`${WORLD_SOURCE}-line`)) return `${WORLD_SOURCE}-line`;
        return this.map.getLayer(`${WORLD_SOURCE}-fill`) ? `${WORLD_SOURCE}-fill` : undefined;
    }
    
    /** 픽셀 그림 레이어가 나중에 다시 그려져도 HD 사진이 그 위에 오도록 (순서가 틀렸을 때만 옮김) */
    keepAbovePixelArt() {
        if (!this.map || this.shown.size === 0) return;
        const order = this.map.getStyle()?.layers?.map(layer => layer.id) || [];
        const lastPixelIndex = order.reduce((max, id, index) => (id.startsWith('pixel-overlay-') ? index : max), -1);
        const beforeLayer = this.hdBeforeLayer();
        for (const territoryId of this.shown.keys()) {
            const layerId = `hd-${territoryId}`;
            if (order.indexOf(layerId) !== -1 && order.indexOf(layerId) < lastPixelIndex) {
                this.map.moveLayer(layerId, beforeLayer);
            }
        }
    }
    
    remove(territoryId) {
        const sourceId = `hd-${territoryId}`;
        try {
            if (this.map?.getLayer(sourceId)) this.map.removeLayer(sourceId);
            if (this.map?.getSource(sourceId)) this.map.removeSource(sourceId);
        } catch (error) {
            // 이미 지워진 경우
        }
        this.shown.delete(territoryId);
    }
}

export const hdImageLayer = new HdImageLayer();
export default hdImageLayer;
