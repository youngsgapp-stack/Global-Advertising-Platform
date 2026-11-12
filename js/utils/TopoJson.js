/**
 * TopoJSON → GeoJSON (세계 행정구역 데이터용 작은 해석기: Polygon / MultiPolygon)
 * scripts/build-world-topojson.mjs 가 만든 파일을 읽음. properties._bb(원래 경계 상자)는 geometry.bbox 로 옮김
 */

function decodeArcs(topology) {
    const { scale, translate } = topology.transform || { scale: [1, 1], translate: [0, 0] };
    const quantized = !!topology.transform;
    return topology.arcs.map(arc => {
        let x = 0;
        let y = 0;
        return arc.map(([dx, dy]) => {
            if (!quantized) return [dx, dy];
            x += dx;
            y += dy;
            return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
        });
    });
}

function buildRing(indexes, arcs) {
    const ring = [];
    indexes.forEach((index, i) => {
        const points = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
        // 이어지는 호의 첫 점은 앞 호의 끝점과 같으므로 한 번만 넣음
        points.forEach((point, j) => {
            if (i > 0 && j === 0) return;
            ring.push(point);
        });
    });
    return ring;
}

function toGeometry(object, arcs) {
    if (object.type === 'Polygon') {
        return { type: 'Polygon', coordinates: object.arcs.map(r => buildRing(r, arcs)) };
    }
    if (object.type === 'MultiPolygon') {
        return { type: 'MultiPolygon', coordinates: object.arcs.map(p => p.map(r => buildRing(r, arcs))) };
    }
    return null;
}

/**
 * @param {object} topology - TopoJSON Topology
 * @param {string} [objectName]
 * @returns {{type: 'FeatureCollection', features: object[]}}
 */
export function topologyToGeoJSON(topology, objectName) {
    const name = objectName || Object.keys(topology.objects)[0];
    const arcs = decodeArcs(topology);
    const collection = topology.objects[name];
    const features = (collection.geometries || []).map(object => {
        const properties = { ...(object.properties || {}) };
        const geometry = toGeometry(object, arcs);
        if (geometry && Array.isArray(properties._bb)) {
            geometry.bbox = properties._bb;
        }
        delete properties._bb;
        return { type: 'Feature', properties, geometry };
    });
    return { type: 'FeatureCollection', features };
}

/** 원래 경계 상자 (파일에 있으면 그 값, 없으면 null) */
export function exactBounds(geometry) {
    const bb = geometry?.bbox;
    if (!Array.isArray(bb) || bb.length < 4 || !bb.slice(0, 4).every(Number.isFinite)) return null;
    return { minLng: bb[0], minLat: bb[1], maxLng: bb[2], maxLat: bb[3] };
}
