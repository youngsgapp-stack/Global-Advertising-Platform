/**
 * Cloudflare Pages Functions - Territory API
 * Firebase REST API 사용 (Edge Runtime 호환)
 * 캐싱 계층 도입: Edge Cache → Firestore
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // URL에서 id 추출: /api/territories/texas → id = 'texas'
  const pathParts = url.pathname.split('/');
  const id = pathParts[pathParts.length - 1];
  
  if (!id || id === 'territories') {
    return new Response(JSON.stringify({ error: 'Territory ID is required' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  try {
    // Firebase REST API 사용
    const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
    
    if (!projectId || !apiKey) {
      return new Response(JSON.stringify({ 
        error: 'Configuration error',
        message: 'Firebase configuration missing' 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // 캐시 설정 (전문가 조언: 응급처방 - TTL 크게 늘리기)
    const cacheTTL = 600; // 10분 캐시 (응급처방: 10~60분)
    
    // 1. 먼저 KV에서 찾기 (KV 우선 조회)
    if (env.TERRITORY_CACHE) {
      const kvKey = `territory:${id}`;
      const kvData = await env.TERRITORY_CACHE.get(kvKey);
      
      if (kvData) {
        // KV 히트 - 즉시 반환 (Firestore 호출 없음)
        const territory = JSON.parse(kvData);
        return new Response(JSON.stringify(territory), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
            'X-Cache-Status': 'KV-HIT'
          }
        });
      }
    }
    
    // 2. KV 미스 - Edge Cache에서 찾기 (폴백)
    const cache = caches.default;
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Edge Cache 히트 - 즉시 반환 (Firestore 호출 없음)
      const cachedData = await cachedResponse.json();
      return new Response(JSON.stringify(cachedData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
          'X-Cache-Status': 'EDGE-HIT'
        }
      });
    }
    
    // 3. 모두 미스 - Placeholder 반환 (Firestore 호출 안 함)
    // Scheduled Worker가 KV에 동기화하므로 직접 호출하지 않음
    const getCountryFromId = (territoryId) => {
      const lowerId = territoryId.toLowerCase();
      // 미국 주들
      if (['texas', 'california', 'new-york', 'florida', 'illinois', 'pennsylvania', 
           'ohio', 'georgia', 'north-carolina', 'michigan'].includes(lowerId)) {
        return 'usa';
      }
      // 일본 도도부현
      if (['tokyo', 'osaka', 'kyoto', 'hokkaido'].includes(lowerId)) {
        return 'jpn';
      }
      // 한국 지역
      if (['seoul', 'busan', 'incheon', 'daegu'].includes(lowerId)) {
        return 'kor';
      }
      // 기본값: ID에 언더스코어가 있으면 첫 번째 부분을 국가로 간주
      const parts = territoryId.split('_');
      if (parts.length > 1) {
        return parts[0].toLowerCase();
      }
      return 'unknown';
    };
    
    const placeholderTerritory = {
      id: id,
      status: 'loading',
      message: 'Data is being synchronized. Please try again in a moment.',
      retryInSeconds: 30,
      ownership: 'unknown',
      sovereignty: 'unknown',
      country: getCountryFromId(id),
      adminLevel: 'Region'
    };
    
    // Placeholder 응답도 Edge Cache에 저장
    const placeholderResponse = new Response(JSON.stringify(placeholderTerritory), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, s-maxage=60',
        'X-Cache-Status': 'KV-MISS',
        'X-Placeholder': 'true'
      }
    });
    
    context.waitUntil(cache.put(request, placeholderResponse.clone()));
    
    return placeholderResponse;
  } catch (error) {
    console.error('Error in territory API:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      message: error.message 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

/**
 * Firestore REST API 응답을 일반 객체로 변환
 */
function convertFirestoreToObject(firestoreDoc) {
  if (!firestoreDoc.fields) {
    return {};
  }
  
  const result = {};
  for (const [key, value] of Object.entries(firestoreDoc.fields)) {
    result[key] = convertFirestoreValue(value);
  }
  
  return result;
}

/**
 * Firestore 값 타입 변환
 */
function convertFirestoreValue(value) {
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.integerValue !== undefined) {
    return parseInt(value.integerValue, 10);
  }
  if (value.doubleValue !== undefined) {
    return parseFloat(value.doubleValue);
  }
  if (value.booleanValue !== undefined) {
    return value.booleanValue === 'true';
  }
  if (value.timestampValue !== undefined) {
    return new Date(value.timestampValue).getTime();
  }
  if (value.nullValue !== undefined) {
    return null;
  }
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values.map(v => convertFirestoreValue(v));
  }
  if (value.mapValue !== undefined) {
    const result = {};
    if (value.mapValue.fields) {
      for (const [k, v] of Object.entries(value.mapValue.fields)) {
        result[k] = convertFirestoreValue(v);
      }
    }
    return result;
  }
  return value;
}