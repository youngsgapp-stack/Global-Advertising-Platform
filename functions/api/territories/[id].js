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
    
    // 캐시 설정 (전문가 조언: 30~120초)
    const cacheTTL = 60; // 60초 캐시
    
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
        // 429 오류 처리 (전문가 조언: "재시도보다는 캐시/스테일에 의지")
        if (response.status === 429) {
          // 전문가 조언: "429가 뜰 땐 Firestore를 잠시 잊고 캐시/스테일에 의지"
          // 캐시에 저장된 데이터가 있으면 (만료 여부와 상관없이) 반환 시도
          // Note: Cloudflare Cache API는 만료된 캐시를 자동 반환하지 않으므로
          // 여기서는 429 오류를 반환하고, 향후 KV 도입 시 스테일 캐시 활용
          return new Response(JSON.stringify({ 
            error: 'Rate limit exceeded',
            message: 'Too many requests. Please try again later.' 
          }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Retry-After': '60',
              'X-Cache-Status': 'MISS'
            }
          });
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
