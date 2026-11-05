// Google sign-in for the shared Realtime Database of Timer, GREMSON and Radio.
// Load it with a plain <script> before the page's own code. Reads and writes keep using fetch and
// EventSource as before: calls to the database get the signed-in user's token added here, so the
// pages themselves don't change. Access is decided by the database rules (database.rules.json):
// only emails under /allowed may read or write. Everyone else keeps working on this device only.
// All three sites share one origin, so signing in on one signs in on the others.
(function () {
  const DB = "https://timer-4672a-default-rtdb.europe-west1.firebasedatabase.app";
  const CONFIG = { apiKey: "AIzaSyAa1lpGrxTfuubEAftXf_gr_0aOBy6Xb24", authDomain: "timer-4672a.firebaseapp.com", projectId: "timer-4672a" };
  const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  // Web client ID of the Google provider (Firebase console > Authentication > Sign-in method > Google > Web SDK configuration).
  // When set, sign-in uses Google's own popup, which also works in home-screen shortcuts; when empty, Firebase's popup is used.
  // https://gavishori.github.io must be listed as an authorized JavaScript origin of this client in Google Cloud Console.
  const GIS_CLIENT_ID = "";  // OFF: an access-token sign-in leaves emailVerified false, and the database rules require true
  const DISMISS_KEY = "gavish-auth-dismissed";
  const bottom = document.currentScript?.dataset.bottom || "12";

  const NativeFetch = window.fetch.bind(window), NativeES = window.EventSource;
  let auth = null, api = null, user = null, denied = false;
  const streams = new Set();

  let markReady;
  const ready = new Promise((r) => (markReady = r));
  const token = async () => {
    await ready;
    try { return user ? await user.getIdToken() : null; } catch { return null; }
  };
  const withToken = (url, t) => url + (url.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(t);

  // ---- fetch: add the token to database calls, leave everything else alone
  window.fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith(DB)) return NativeFetch(input, init);
    const t = await token();
    const res = await NativeFetch(t ? withToken(input, t) : input, init);
    if (res.status === 401 && t) setDenied(true);
    return res;
  };

  // ---- EventSource: same interface, but it opens only with a token and reopens with a fresh one
  // (tokens last an hour; the database then sends auth_revoked and closes the stream).
  class AuthedStream {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.onerror = null;
      this.closed = false;
      this.native = null;
      this.retry = null;
      streams.add(this);
      this.open();
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    fail() { if (this.onerror) this.onerror(new Event("error")); }
    async open() {
      clearTimeout(this.retry);
      if (this.native) { this.native.close(); this.native = null; }
      const t = await token();
      if (this.closed) return;
      if (!t) return this.fail();  // signed out: the page says it's working on this device
      const es = new NativeES(withToken(this.url, t));
      this.native = es;
      ["put", "patch", "keep-alive"].forEach((type) => es.addEventListener(type, (e) => {
        if (type !== "keep-alive") setDenied(false);
        (this.listeners[type] || []).forEach((fn) => fn(e));
      }));
      es.addEventListener("auth_revoked", () => this.open());
      es.addEventListener("cancel", () => { setDenied(true); this.fail(); });
      es.onerror = () => {
        this.fail();
        if (es.readyState !== NativeES.CLOSED || this.closed) return;
        // A closed stream is either a refused account (stay quiet) or the network (try again).
        NativeFetch(withToken(this.url + "?shallow=true", t)).then((r) => {
          if (r.status === 401) setDenied(true);
          else this.retry = setTimeout(() => this.open(), 15000);
        }).catch(() => { this.retry = setTimeout(() => this.open(), 15000); });
      };
    }
    close() {
      this.closed = true;
      clearTimeout(this.retry);
      streams.delete(this);
      if (this.native) this.native.close();
    }
  }
  window.EventSource = function (url, opts) {
    return String(url).startsWith(DB) ? new AuthedStream(String(url)) : new NativeES(url, opts);
  };
  Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });

  // ---- the small sign-in box, isolated from each page's CSS
  // A home-screen web app on iPhone has its own storage and cannot finish Google's popup, so there the box offers
  // email + password instead. The password is set once from a normal browser tab, right after a Google sign-in.
  const PW_KEY = "gavish-auth-pw-dismissed";
  const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches));
  let mode = "";  // "login" = email + password form, "setpw" = ask for a password to link to the signed-in account
  let showingPw = false;
  let box = null, msgEl = null, btnEl = null, formEl = null, emEl = null, paEl = null, goEl = null;
  function ui() {
    if (box) return;
    box = document.createElement("div");
    box.id = "gavish-auth";
    box.style.cssText = `position:fixed!important;left:12px!important;bottom:${bottom}px!important;z-index:2147483000!important;`;
    const root = box.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .w{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:max-content;max-width:min(300px,calc(100vw - 24px));padding:6px 8px;box-sizing:border-box;direction:rtl;font:13px/1.4 system-ui,sans-serif;color:#fff;
        background:rgba(15,31,61,.92);border:1px solid rgba(255,255,255,.32);border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.3)}
      button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:2px 4px}
      #in{font-weight:700;white-space:nowrap}
      #msg:empty{display:none}
      form{display:flex;flex-direction:column;gap:6px;flex-basis:100%}
      form[hidden],input[hidden]{display:none}
      input{font:16px system-ui,sans-serif;padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.95);color:#111;direction:ltr;text-align:left;min-width:0}
      #go{font-weight:700;background:#2b6de0;border-radius:8px;padding:7px}
      #gg{font-size:12px;text-decoration:underline}
    </style><div class="w"><button id="in" type="button">☁️ כניסה עם Google לסנכרון</button><span id="msg"></span><button id="x" type="button" aria-label="סגירה">✕</button>
      <form id="pw" hidden><input id="em" type="email" autocomplete="username" placeholder="אימייל" autocapitalize="off"><input id="pa" type="password" autocomplete="current-password" placeholder="סיסמה"><button id="go" type="submit">כניסה</button><button id="gg" type="button">כניסה עם Google</button></form></div>`;
    btnEl = root.getElementById("in");
    msgEl = root.getElementById("msg");
    formEl = root.getElementById("pw");
    emEl = root.getElementById("em");
    paEl = root.getElementById("pa");
    goEl = root.getElementById("go");
    btnEl.onclick = signIn;
    root.getElementById("gg").onclick = () => { mode = ""; draw(); googleSignIn(); };
    formEl.onsubmit = (e) => { e.preventDefault(); submitPassword(); };
    root.getElementById("x").onclick = () => {
      try { sessionStorage.setItem(showingPw ? PW_KEY : DISMISS_KEY, "1"); } catch {}
      mode = "";
      draw();
    };
    (document.body || document.documentElement).appendChild(box);
  }
  // The X hides the box only until the tab is closed; it always comes back on the next visit.
  const dismissed = () => { try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } };
  const pwDismissed = () => { try { return sessionStorage.getItem(PW_KEY) === "1"; } catch { return false; } };
  const hasPassword = () => !!user && user.providerData.some((p) => p.providerId === "password");
  function draw(msg = "") {
    if (!document.body) return document.addEventListener("DOMContentLoaded", () => draw(msg), { once: true });
    const need = !user || denied;
    const setpw = !!user && !denied && !hasPassword() && (mode === "setpw" || (!standalone && !pwDismissed()));
    const login = need && mode === "login";
    if (!msg && !login && !setpw && (!need || dismissed())) { if (box) box.style.setProperty("display", "none", "important"); return; }
    ui();
    box.style.setProperty("display", "block", "important");
    showingPw = setpw;
    formEl.hidden = !(login || setpw);
    emEl.hidden = setpw;
    paEl.autocomplete = setpw ? "new-password" : "current-password";
    goEl.textContent = setpw ? "שמירת סיסמה" : "כניסה";
    btnEl.hidden = (!!user && !denied) || login;
    btnEl.textContent = user ? "🔄 כניסה מחדש עם Google" : standalone ? "☁️ כניסה לסנכרון" : "☁️ כניסה עם Google לסנכרון";
    msgEl.textContent = msg || (setpw ? "הגדרת סיסמה (פעם אחת) תאפשר להיכנס גם מאפליקציה במסך הבית:"
      : denied && user ? `לחשבון ${user.email} אין גישה לסנכרון. עובד רק במכשיר הזה.` : "");
  }

  async function submitPassword() {
    if (!api) return draw("הכניסה לא נטענה. בדקו את החיבור ונסו שוב.");
    const pass = paEl.value;
    if (pass.length < 6) return draw("הסיסמה חייבת להכיל לפחות 6 תווים.");
    goEl.disabled = true;
    try {
      if (showingPw) {
        try {
          await api.linkWithCredential(user, api.EmailAuthProvider.credential(user.email, pass));
        } catch (e) {
          if (e.code !== "auth/provider-already-linked") throw e;
          await api.updatePassword(user, pass);
        }
        paEl.value = "";
        mode = "";
        draw("הסיסמה נשמרה. באפליקציה במסך הבית היכנסו עם האימייל והסיסמה האלה.");
        setTimeout(() => draw(), 6000);
      } else {
        await api.signInWithEmailAndPassword(auth, emEl.value.trim(), pass);
        paEl.value = "";
        mode = "";
        draw();
      }
    } catch (e) {
      const c = e.code || "";
      draw(c === "auth/operation-not-allowed" ? "כניסה עם סיסמה עוד לא הופעלה ב-Firebase (Authentication > Sign-in method > Email/Password)."
        : c === "auth/requires-recent-login" ? "יש להיכנס שוב עם Google ואז לנסות להגדיר סיסמה."
        : /invalid|wrong|user-not-found/.test(c) ? "אימייל או סיסמה שגויים. אם עוד לא הוגדרה סיסמה - הגדירו אותה מדפדפן רגיל אחרי כניסה עם Google."
        : `הכניסה נכשלה (${c || e.message}).`);
    } finally { goEl.disabled = false; }
  }
  function setDenied(v) {
    if (denied === v) return;
    denied = v;
    draw();
  }

  // Google Identity Services: loaded up front so the popup can open straight from the tap.
  let tokenClient = null;
  if (GIS_CLIENT_ID) {
    const gis = document.createElement("script");
    gis.src = "https://accounts.google.com/gsi/client";
    gis.async = true;
    gis.onload = () => {
      try {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GIS_CLIENT_ID,
          scope: "openid email profile",
          callback: async (resp) => {
            if (resp.error || !resp.access_token) return draw(resp.error === "access_denied" ? "" : `הכניסה נכשלה (${resp.error || "no token"}).`);
            try {
              await api.signInWithCredential(auth, api.GoogleAuthProvider.credential(null, resp.access_token));
            } catch (e) { draw(`הכניסה נכשלה (${e.code || e.message}).`); }
          },
          error_callback: (err) => { if (err && err.type !== "popup_closed") draw("הדפדפן חסם את חלון הכניסה. פתחו את הקישור בכרום או בספארי."); },
        });
      } catch (e) { console.warn("Google sign-in did not load:", e); }
    };
    document.head.appendChild(gis);
  }

  // In a home-screen web app Google's popup cannot report back, so the box offers email + password there.
  function signIn() {
    if (standalone) { mode = "login"; draw(); return; }
    return googleSignIn();
  }

  async function googleSignIn() {
    if (!api) return draw("הכניסה לא נטענה. בדקו את החיבור ונסו שוב.");
    if (tokenClient) return tokenClient.requestAccessToken({ prompt: "select_account" });
    try {
      // Popup also on phones: redirect loses its result on a domain other than the auth domain.
      await api.signInWithPopup(auth, new api.GoogleAuthProvider());
    } catch (e) {
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return draw();
      draw(e.code === "auth/popup-blocked" ? "הדפדפן חסם את חלון הכניסה. פתחו את הקישור בכרום או בספארי." : `הכניסה נכשלה (${e.code || e.message}).`);
    }
  }

  // Pages can start the sign-in themselves (e.g. a tap on their own "not connected" status).
  window.gavishAuth = { signIn: () => { try { localStorage.removeItem(DISMISS_KEY); sessionStorage.removeItem(DISMISS_KEY); } catch {} return signIn(); }, get signedIn() { return !!user && !denied; }, setPassword: () => { mode = "setpw"; draw(); } };

  // If Firebase Auth never answers (blocked script, locked storage in a home-screen shortcut), stop waiting
  // after a few seconds so the page shows "not connected" with a working sign-in instead of "connecting" forever.
  // A late answer still works: onAuthStateChanged reopens the streams with the user's token.
  setTimeout(() => { markReady(); draw(); }, 5000);

  // ---- load Firebase Auth; until it answers, database calls wait
  (async () => {
    try {
      const [{ initializeApp }, a] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js")]);
      api = a;
      auth = a.getAuth(initializeApp(CONFIG, "gavish-auth"));
      a.onAuthStateChanged(auth, (u) => {
        const changed = (u && u.uid) !== (user && user.uid);
        user = u;
        denied = false;
        markReady();
        draw();
        if (changed) streams.forEach((s) => s.open());
      });
    } catch (e) {
      console.warn("Sign-in did not load:", e);
      markReady();
      draw();
    }
  })();
})();
