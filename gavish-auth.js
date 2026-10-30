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

  // ---- the small sign-in button, isolated from each page's CSS
  let box = null, msgEl = null, btnEl = null;
  function ui() {
    if (box) return;
    box = document.createElement("div");
    box.id = "gavish-auth";
    box.style.cssText = `position:fixed!important;left:12px!important;bottom:${bottom}px!important;z-index:2147483000!important;`;
    const root = box.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .w{display:flex;align-items:center;gap:6px;max-width:min(300px,calc(100vw - 24px));padding:6px 8px;box-sizing:border-box;direction:rtl;font:13px/1.4 system-ui,sans-serif;color:#fff;
        background:rgba(15,31,61,.92);border:1px solid rgba(255,255,255,.32);border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.3)}
      button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:2px 4px}
      #in{font-weight:700;white-space:nowrap}
      #msg:empty{display:none}
    </style><div class="w"><button id="in" type="button">☁️ כניסה עם Google לסנכרון</button><span id="msg"></span><button id="x" type="button" aria-label="סגירה">✕</button></div>`;
    btnEl = root.getElementById("in");
    msgEl = root.getElementById("msg");
    btnEl.onclick = signIn;
    root.getElementById("x").onclick = () => {
      try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
      draw();
    };
    (document.body || document.documentElement).appendChild(box);
  }
  const dismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } };
  function draw(msg = "") {
    if (!document.body) return document.addEventListener("DOMContentLoaded", () => draw(msg), { once: true });
    const need = !user || denied;
    if (!need || (dismissed() && !msg)) { if (box) box.style.setProperty("display", "none", "important"); return; }
    ui();
    box.style.setProperty("display", "block", "important");
    btnEl.hidden = !!user;
    msgEl.textContent = msg || (denied && user ? `לחשבון ${user.email} אין גישה לסנכרון. עובד רק במכשיר הזה.` : "");
  }
  function setDenied(v) {
    if (denied === v) return;
    denied = v;
    draw();
  }

  async function signIn() {
    if (!api) return draw("הכניסה לא נטענה. בדקו את החיבור ונסו שוב.");
    try {
      // Popup also on phones: redirect loses its result on a domain other than the auth domain.
      await api.signInWithPopup(auth, new api.GoogleAuthProvider());
    } catch (e) {
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return draw();
      draw(e.code === "auth/popup-blocked" ? "הדפדפן חסם את חלון הכניסה. פתחו את הקישור בכרום או בספארי." : `הכניסה נכשלה (${e.code || e.message}).`);
    }
  }

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
