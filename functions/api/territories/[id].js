/**
 * Cloudflare Pages Functions - Territory API
 * Firebase REST API 사용 (Edge Runtime 호환)
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
    
    // Firestore REST API - API Key를 쿼리 파라미터로 전달
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/territories/${id}?key=${apiKey}`;
    
    // 재시도 로직 (최대 3회)
    let response;
    let lastError;
    const maxRetries = 3;
    const retryDelay = 1000; // 1초
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        response = await fetch(firestoreUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        // 429 오류가 아니면 재시도 중단
        if (response.status !== 429) {
          break;
        }
        
        // 429 오류인 경우 재시도
        if (attempt < maxRetries - 1) {
          const retryAfter = response.headers.get('Retry-After') || retryDelay;
          await new Promise(resolve => setTimeout(resolve, parseInt(retryAfter) * 1000));
          continue;
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    
    if (!response || !response.ok) {
      if (response && response.status === 404) {
        return new Response(JSON.stringify({ error: 'Territory not found' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300, s-maxage=600'
          }
        });
      }
      
      // 429 오류 처리 (재시도 실패)
      if (response && response.status === 429) {
        return new Response(JSON.stringify({ 
          error: 'Rate limit exceeded',
          message: 'Too many requests. Please try again later.' 
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Retry-After': '60',
            'Cache-Control': 'public, max-age=60, s-maxage=300'
          }
        });
      }
      
      const errorText = response ? await response.text() : lastError?.message || 'Unknown error';
      throw new Error(`Firestore API error: ${response?.status || 'Network'} - ${errorText}`);
    }
    
    const firestoreData = await response.json();
    
    // Firestore REST API 응답을 일반 객체로 변환
    const territory = convertFirestoreToObject(firestoreData);
    territory.id = id;
    
    return new Response(JSON.stringify(territory), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, s-maxage=600' // 캐싱 강화 (5분)
      }
    });
    
  } catch (error) {
    console.error('Error fetching territory:', error);
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
