/**
 * 픽셀 그리드(128×128) ↔ 위경도 변환
 *
 * 지도(Mapbox)는 Web Mercator로 그리고, image source도 네 꼭짓점 사이를 Mercator 공간에서
 * 선형으로 늘린다. 그래서 그리드도 Mercator 기준으로 나눠야 에디터의 셀이 지도 위 같은 자리에 놓인다.
 * 또 그리드 영역을 Mercator 기준 정사각형으로 맞춰야 에디터의 정사각형 셀이 지도에서도 정사각형이 되어
 * 그린 그림(사진/로고)이 늘어나지 않고 그대로 보인다.
 *
 * bounds.projection === 'mercator' 인 경우만 이 방식이며, 표시가 없는 bounds는 예전 저장 데이터
 * (위경도 선형, 영토 경계 사각형 그대로)로 취급한다.
 */

export const GRID_PROJECTION = 'mercator';

const MAX_LAT = 85.05112878;
const DEG = Math.PI / 180;

function clampLat(lat) {
    return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function latToMercatorY(lat) {
    return Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * DEG) / 2));
}

export function mercatorYToLat(y) {
    return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/**
 * 영토 경계 사각형 → 픽셀 그리드 영역 (Mercator 기준 정사각형, 영토가 가운데)
 * @param {{minLng:number, maxLng:number, minLat:number, maxLat:number}} territoryBounds
 */
export function getPixelGridBounds(territoryBounds) {
    const { minLng, maxLng, minLat, maxLat } = territoryBounds;
    const x0 = minLng * DEG;
    const x1 = maxLng * DEG;
    const y0 = latToMercatorY(minLat);
    const y1 = latToMercatorY(maxLat);
    
    const size = Math.max(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    
    return {
        minLng: (cx - size / 2) / DEG,
        maxLng: (cx + size / 2) / DEG,
        minLat: mercatorYToLat(cy - size / 2),
        maxLat: mercatorYToLat(cy + size / 2),
        projection: GRID_PROJECTION
    };
}

/**
 * 위경도 → 그리드 좌표 (셀 단위, 소수 포함)
 */
export function lngLatToGrid(lng, lat, bounds, width, height) {
    const { minLng, maxLng, minLat, maxLat } = bounds;
    const x = ((lng - minLng) / (maxLng - minLng)) * width;
    if (bounds.projection === GRID_PROJECTION) {
        const top = latToMercatorY(maxLat);
        const bottom = latToMercatorY(minLat);
        return { x, y: ((top - latToMercatorY(lat)) / (top - bottom)) * height };
    }
    return { x, y: ((maxLat - lat) / (maxLat - minLat)) * height };
}

/**
 * 그리드 좌표(셀 단위, 소수 포함) → 위경도
 */
export function gridToLngLat(gx, gy, bounds, width, height) {
    const { minLng, maxLng, minLat, maxLat } = bounds;
    const lng = minLng + (gx / width) * (maxLng - minLng);
    if (bounds.projection === GRID_PROJECTION) {
        const top = latToMercatorY(maxLat);
        const bottom = latToMercatorY(minLat);
        return { lng, lat: mercatorYToLat(top - (gy / height) * (top - bottom)) };
    }
    return { lng, lat: maxLat - (gy / height) * (maxLat - minLat) };
}
