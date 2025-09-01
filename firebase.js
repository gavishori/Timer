// --- iOS-safe Firebase Auth + Data Layer bootstrap ---

window.firebaseConfig = {
  apiKey: "AIzaSyArvkyWzgOmPjYYXUIOdilmtfrWt7WxK-0",
  authDomain: "travel-416ff.firebaseapp.com",
  projectId: "travel-416ff",
  storageBucket: "travel-416ff.appspot.com",
  messagingSenderId: "1075073511694",
  appId: "1:1075073511694:web:7876f492d18a702b09e75f",
  measurementId: "G-FT56H33X5J"
};

(function initFirebase(){
  const hasConfig = window.firebaseConfig && window.firebaseConfig.apiKey;
  if (!hasConfig){
    console.info("Firebase config missing → running in local mode (localStorage).");
    window.AppDataLayer = { mode: "local" };
    return;
  }

  try{
    firebase.initializeApp(window.firebaseConfig);
    const db = firebase.firestore();
    window.AppDataLayer = { mode: "firebase", db };
    console.info("Firebase initialized.");
  }catch(err){
    console.error("Firebase init error → fallback to local mode", err);
    window.AppDataLayer = { mode: "local" };
  }
})();

(function bootstrapAuth(){
  // Platform detection – prefer redirect on iOS
  var isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.userAgent.includes('Mac') && 'ontouchend' in document);

  try {
    // compat scripts are loaded in index.html
    window.auth = firebase.auth();
    window.googleProvider = new firebase.auth.GoogleAuthProvider();

    // Persistence is important on iOS
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(e){
      console.warn('[auth] setPersistence failed', e && e.code, e && e.message);
    });
  } catch(e){
    console.warn('[auth] init early failed', e);
  }

  var FLAG = 'authRedirectPending';

  // Handle pending redirect ASAP and always clear the flag
  try{
    auth.getRedirectResult().then(function(result){
      sessionStorage.removeItem(FLAG);
      if (result && result.user){
        console.log('[auth] redirect result ok:', result.user.uid);
      }
    }).catch(function(err){
      sessionStorage.removeItem(FLAG);
      console.warn('[auth] redirect error', err && err.code, err && err.message);
    });
  }catch(e){
    sessionStorage.removeItem(FLAG);
    console.warn('[auth] redirect init failed', e);
  }

  // Safe global sign-in helper
  window.__attemptSignIn = async function(){
    try{
      if (!window.auth) {
        console.warn('[auth] not ready yet');
        return;
      }
      if (sessionStorage.getItem(FLAG)) {
        console.log('[auth] redirect already pending, skip');
        return;
      }

      if (isiOS) {
        sessionStorage.setItem(FLAG, '1');
        await auth.signInWithRedirect(googleProvider);
        return;
      }

      try{
        await auth.signInWithPopup(googleProvider);
      }catch(err){
        var code = err && err.code || '';
        var fallback = [
          'auth/popup-blocked',
          'auth/popup-closed-by-user',
          'auth/cancelled-popup-request',
          'auth/operation-not-supported-in-this-environment'
        ].indexOf(code) !== -1;
        if (fallback){
          sessionStorage.setItem(FLAG, '1');
          await auth.signInWithRedirect(googleProvider);
        } else {
          console.error('[auth] sign-in failed', code, err && err.message);
          if (typeof logLine === 'function') logLine('error '+code+' '+(err && err.message || ''), 'auth');
        }
      }
    }catch(e){
      sessionStorage.removeItem(FLAG);
      console.error('[auth] __attemptSignIn fatal', e);
    }
  };
})();