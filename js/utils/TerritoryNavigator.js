/**
 * 영토 ID로 지도 이동 + 영토 패널 열기 (공유 링크, 로그인/충전 후 이어가기에서 사용)
 */

import { territoryManager } from '../core/TerritoryManager.js';
import mapController from '../core/MapController.js';
import { eventBus, EVENTS } from '../core/EventBus.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function geometryBounds(geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (coords) => {
        if (typeof coords[0] === 'number') {
            minX = Math.min(minX, coords[0]);
            maxX = Math.max(maxX, coords[0]);
            minY = Math.min(minY, coords[1]);
            maxY = Math.max(maxY, coords[1]);
        } else {
            coords.forEach(walk);
        }
    };
    if (geometry?.coordinates) walk(geometry.coordinates);
    return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

/**
 * 지도 데이터(세계 지도)가 준비될 때까지 기다린 뒤 영토를 선택
 * @returns {Promise<boolean>} 영토를 찾아 열었으면 true
 */
export async function openTerritoryById(territoryId, { waitMs = 20000 } = {}) {
    if (!territoryId) return false;
    
    const startedAt = Date.now();
    let territory = territoryManager.getTerritory(territoryId);
    while ((!territory || !territory.sourceId || !mapController.map) && Date.now() - startedAt < waitMs) {
        await sleep(300);
        territory = territoryManager.getTerritory(territoryId);
    }
    if (!territory) return false;
    
    const map = mapController.map;
    const source = territory.sourceId && map?.getSource(territory.sourceId);
    const feature = source?._data?.features?.find(f =>
        String(f.id) === String(territory.featureId) ||
        String(f.properties?.id) === String(territoryId)
    );
    
    const bounds = geometryBounds(feature?.geometry || territory.geometry);
    if (map && bounds) {
        map.fitBounds(bounds, { padding: 80, maxZoom: 7, duration: 1200 });
    }
    
    if (feature) {
        mapController.selectTerritory(territory.sourceId, feature);
    } else {
        eventBus.emit(EVENTS.TERRITORY_CLICKED, {
            territory,
            territoryId,
            sourceId: territory.sourceId,
            featureId: territory.featureId,
            properties: territory.properties,
            geometry: territory.geometry,
            country: territory.country
        });
    }
    return true;
}

/**
 * 영토 패널이 해당 영토로 열릴 때까지 대기
 */
export async function waitForPanelTerritory(territoryPanel, territoryId, waitMs = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
        if (territoryPanel.isOpen !== false && territoryPanel.currentTerritory?.id === territoryId) {
            return true;
        }
        await sleep(200);
    }
    return false;
}
