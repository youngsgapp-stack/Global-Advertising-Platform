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
    // Firebase REST API 사용 (API Key 필요)
    const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const apiKey = env.NEXT_PUBLIC_FIREBASE_API_KEY;
    
    if (!projectId || !apiKey) {
      throw new Error('Firebase configuration missing');
    }
    
    // Firestore REST API는 API Key를 쿼리 파라미터로 전달
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/territories/${id}?key=${apiKey}`;
    
    const response = await fetch(firestoreUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return new Response(JSON.stringify({ error: 'Territory not found' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      throw new Error(`Firestore API error: ${response.status}`);
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
        'Cache-Control': 'public, max-age=60, s-maxage=300'
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
