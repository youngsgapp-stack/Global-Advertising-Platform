/**
 * Cloudflare Pages Functions - Territory API
 */

async function getFirestoreInstance(env) {
  const { initializeApp } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  
  const firebaseConfig = {
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID
  };
  
  const app = initializeApp(firebaseConfig);
  return getFirestore(app);
}

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
    const firestore = await getFirestoreInstance(env);
    const { doc, getDoc } = await import('firebase/firestore');
    
    const territoryRef = doc(firestore, 'territories', id);
    const territorySnap = await getDoc(territoryRef);
    
    if (!territorySnap.exists()) {
      return new Response(JSON.stringify({ error: 'Territory not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    const territory = {
      id: territorySnap.id,
      ...territorySnap.data()
    };
    
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

