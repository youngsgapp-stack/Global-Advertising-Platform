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
    
    // 1. 먼저 캐시에서 찾기 (캐시 우선 조회)
    const cache = caches.default;
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // 캐시 히트 - 즉시 반환 (Firestore 호출 없음)
      // 전문가 조언: "트래픽 90% 이상은 캐시 히트"
      const cachedData = await cachedResponse.json();
      return new Response(JSON.stringify(cachedData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
          'X-Cache-Status': 'HIT'
        }
      });
    }
    
    // 2. 캐시 미스 - Firestore에서 가져오기
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/territories/${id}?key=${apiKey}`;
    
    // 타임아웃 설정 (10초)
    const timeout = 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(firestoreUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
    
      if (!response.ok) {
        // 429 오류 처리 (전문가 조언: "graceful fallback")
        if (response.status === 429) {
          // 전문가 조언: "429 + 캐시 없음이면 placeholder Territory 반환"
          // 사용자가 뭔가라도 보게 하기 위한 응급처방
          
          // Territory ID에서 국가 코드 추출 (간단한 매핑)
          // 예: "texas" → "usa", "california" → "usa", "tokyo" → "jpn"
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
            status: 'temporarily_unavailable',
            message: 'Data is temporarily unavailable. Please try again in a moment.',
            retryInSeconds: 30,
            ownership: 'unknown',
            sovereignty: 'unknown',
            // 기본 정보만 포함 (UI가 완전히 깨지지 않도록)
            country: getCountryFromId(id),
            adminLevel: 'Region'
          };
          
          // Placeholder 응답도 캐시에 저장 (중요: 429 오류가 반복되지 않도록)
          const placeholderResponse = new Response(JSON.stringify(placeholderTerritory), {
            status: 200, // 200으로 반환하여 UI가 깨지지 않게
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=30, s-maxage=60', // 짧은 캐시 (30초)
              'X-Cache-Status': 'MISS',
              'X-Rate-Limited': 'true',
              'X-Placeholder': 'true'
            }
          });
          
          // 캐시에 저장 (비동기, 응답 지연 없음)
          context.waitUntil(cache.put(request, placeholderResponse.clone()));
          
          return placeholderResponse;
        }
        
        if (response.status === 404) {
          return new Response(JSON.stringify({ error: 'Territory not found' }), {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300, s-maxage=600'
            }
          });
        }
        
        const errorText = await response.text();
        throw new Error(`Firestore API error: ${response.status} - ${errorText}`);
      }
    
      const firestoreData = await response.json();
      
      // Firestore REST API 응답을 일반 객체로 변환
      const territory = convertFirestoreToObject(firestoreData);
      territory.id = id;
      
      // 3. 응답 생성 및 캐시 저장
      const responseData = JSON.stringify(territory);
      const responseToCache = new Response(responseData, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${cacheTTL}, s-maxage=${cacheTTL}`,
          'X-Cache-Status': 'MISS'
        }
      });
      
      // 캐시에 저장 (비동기, 응답 지연 없음)
      context.waitUntil(cache.put(request, responseToCache.clone()));
      
      return responseToCache;
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      // 타임아웃 오류 처리
      if (error.name === 'AbortError') {
        return new Response(JSON.stringify({ 
          error: 'Request timeout',
          message: 'The request took too long. Please try again later.' 
        }), {
          status: 504,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache-Status': 'MISS'
          }
        });
      }
      
      console.error('Error fetching territory:', error);
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Cache-Status': 'MISS'
        }
      });
    }
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