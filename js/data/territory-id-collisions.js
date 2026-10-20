/**
 * 국가가 다른데 이름 기반 territory ID가 같은 행정구역 목록 (Natural Earth admin-1 기준)
 *
 * 값은 기존 ID(예: 'amazonas')를 그대로 쓰는 국가(ISO3). 나머지 국가는 '{id}-{iso3 소문자}'
 * (예: 'amazonas-ven')를 사용한다. 기존 DB 행/소유권/픽셀을 바꾸지 않기 위해, 기존 행이
 * 가리키던 국가를 유지 국가로 정했다.
 */
export const TERRITORY_ID_COLLISIONS = {
    'adrar': 'DZA',
    'al-jawf': 'SAU',
    'amazonas': 'BRA',
    'ash-sharqiyah': 'SAU',
    'bari': 'SOM',
    'bolvar': 'VEN',
    'central': 'BWA',
    'centre': 'HTI',
    'choiseul': 'LCA',
    'coln': 'PAN',
    'crdoba': 'COL',
    'distrito-federal': 'BRA',
    'eastern': 'ZMB',
    'florida': 'USA',
    'granada': 'ESP',
    'grandanse': 'HTI',
    'jura': 'CHE',
    'la-libertad': 'PER',
    'la-paz': 'BOL',
    'la-rioja': 'ARG',
    'len': 'NIC',
    'limburg': 'NLD',
    'littoral': 'CMR',
    'luxembourg': 'BEL',
    'manchester': 'JAM',
    'manus': 'PNG',
    'maryland': 'LBR',
    'misiones': 'ARG',
    'montana': 'BGR',
    'mwanza': 'MWI',
    'nord': 'FRA',
    'nord-ouest': 'CMR',
    'north-east': 'BWA',
    'north-west': 'BWA',
    'northern': 'SLE',
    'ouest': 'HTI',
    'pembroke': 'BMU',
    'plateau': 'BEN',
    'plateaux': 'COG',
    'punjab': 'PAK',
    'ro-negro': 'ARG',
    'saint-andrew': 'GRD',
    'saint-david': 'GRD',
    'saint-george': 'GRD',
    'saint-georges': 'MSR',
    'saint-james': 'BRB',
    'saint-john': 'GRD',
    'saint-joseph': 'BRB',
    'saint-louis': 'SEN',
    'saint-mark': 'GRD',
    'saint-mary': 'ATG',
    'saint-patrick': 'GRD',
    'saint-paul': 'DMA',
    'saint-peter': 'BRB',
    'saint-philip': 'BRB',
    'saint-thomas': 'VIR',
    'san-jos': 'URY',
    'san-juan': 'ARG',
    'san-salvador': 'BHS',
    'santa-catarina': 'BRA',
    'santa-cruz': 'BOL',
    'santiago': 'DOM',
    'savanes': 'TGO',
    'sofia': 'BGR',
    'south-east': 'BWA',
    'southampton': 'GBR',
    'southern': 'SLE',
    'sucre': 'COL',
    'sud': 'CMR',
    'toledo': 'BLZ',
    'victoria': 'AUS',
    'west-coast': 'GMB',
    'western': 'RWA',
};

/**
 * 이름 기반 ID에 국가 접미사가 필요하면 붙여서 반환
 * @param {string} baseId - 이름 기반 ID (예: 'amazonas')
 * @param {string} countryIso - 해당 feature의 adm0_a3 (예: 'VEN')
 */
export function resolveCollidingTerritoryId(baseId, countryIso) {
    const keeper = TERRITORY_ID_COLLISIONS[baseId];
    if (!keeper || !countryIso) {
        return baseId;
    }
    const iso = String(countryIso).toUpperCase();
    return iso === keeper ? baseId : `${baseId}-${iso.toLowerCase()}`;
}
