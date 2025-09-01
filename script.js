// script.js (clean rebuild)

// Ensure Leaflet default marker assets resolve correctly (prevent 404s)
if (typeof L !== 'undefined' && L.Icon && L.Icon.Default) {
  L.Icon.Default.mergeOptions({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
  });
}

// ---------- DOM helpers ----------

// --- Replace URLs with a 🔗 icon link ---
function linkifyToIcon(text){
  if (!text) return "";
  // remove accidental leading slashes or spaces before http(s)
  text = String(text).replace(/\s*\/+(https?:\/\/)/g, '$1');
  // Regex to find URLs
  const urlRe = /(https?:\/\/[^\s)\]}>"']+)/g;
  return text.replace(urlRe, (m)=>{
    const safe = m.replace(/["'<>&]/g, '');
    return `<a class="link-icon" href="${safe}" target="_blank" rel="noopener" title="פתח קישור">🔗</a>`;
  });
}
const el = (id) => document.getElementById(id);
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

// ---------- Global state ----------
const COUNTRY_CCY = {
  "IL":"ILS","US":"USD","GB":"GBP","DE":"EUR","FR":"EUR","ES":"EUR","IT":"EUR","PT":"EUR","NL":"EUR","BE":"EUR",
  "AT":"EUR","IE":"EUR","FI":"EUR","GR":"EUR","PL":"PLN","CZ":"CZK","SK":"EUR","HU":"HUF","RO":"RON","BG":"BGN",
  "HR":"EUR","SI":"EUR","SE":"SEK","NO":"NOK","DN":"DKK","DK":"DKK","CH":"CHF","TR":"TRY","IS":"ISK","CA":"CAD",
  "AU":"AUD","NZ":"NZD","JP":"JPY","CN":"CNY","HK":"HKD","SG":"SGD","TH":"THB","AE":"AED","SA":"SAR","EG":"EGP",
  "JO":"JOD","MA":"MAD","ZA":"ZAR","BR":"BRL","AR":"ARS","MX":"MXN"
}


// helper to extract just the city name from a place string
function extractCityName(placeName){
  if (!placeName) return "—";
  const parts = placeName.split(",").map(p=>p.trim()).filter(Boolean);
  return parts[0] || placeName;
}
// --- Helpers: destination → currency options ---
async function detectCountryCodeFromDestination(dest){
  if (!dest) return null;
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(dest)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "he" } });
    const data = await res.json();
    const cc = data?.[0]?.address?.country_code?.toUpperCase();
    return cc || null;
  }catch(e){
    console.warn("country detect failed", e);
    return null;
  }
}

async function getAllowedCurrenciesForTrip(trip){
  const base = new Set(["USD","EUR","ILS"]);
  let detected = null;
  if (trip?.destination){
    detected = await detectCountryCodeFromDestination(trip.destination);
  }
  const stored = trip?.countryCode || null;
  const cc = detected || stored || null;
  const ccy = COUNTRY_CCY[cc];
  if (cc && cc !== stored){
    try { await Store.updateTrip(trip.id, { countryCode: cc, localCurrency: ccy || undefined }); } catch(_){}
  }
  if (ccy) base.add(ccy);
  return Array.from(base);
}

function renderCurrencyOptions(selectEl, allowed, ensureExtra){
  if (!selectEl) return;
  selectEl.innerHTML = "";
  allowed.forEach(code=>{
    const opt = document.createElement("option");
    opt.value = code; opt.textContent = code;
    selectEl.appendChild(opt);
  });
  if (ensureExtra && !allowed.includes(ensureExtra)){
    const opt = document.createElement("option");
    opt.value = ensureExtra; opt.textContent = ensureExtra;
    selectEl.appendChild(opt);
  }
}
;

const state = {
  trips: [],
  currentTripId: null,
  rates: { USD:1, EUR:0.9, ILS:3.6 },
  localCurrency: "USD",
  theme: localStorage.getItem("theme") || "dark",
  maps: { mini:null, main:null, location:null, expense:null, journal: null },
  locationPick: { lat:null, lng:null, forType:null, tempId:null },
  lastStatusTimer: null,
  sortAsc: false,
  journalSortAsc: false
};

// Map for translating trip types to Hebrew
const TRIP_TYPE_HEBREW = {
  "beach": "בטן-גב",
  "ski": "סקי",
  "trek": "טרקים",
  "other": "אחר"
};

// Store last used category and currency in local storage
const lastUsed = {
  category: localStorage.getItem("lastCategory") || "אחר",
  currency: localStorage.getItem("lastCurrency") || "USD",
};

function addCurrencyToState(code){
  if (!code) return;
  if (!(code in state.rates)) state.rates[code] = null;
}

// ---------- Store (Firebase or Local) ----------
const Store = (()=>{
  const mode = window.AppDataLayer?.mode || "local";
  const db = window.AppDataLayer?.db;
  let currentUid = null;

  const LS_KEY = "travel_journal_data_v2";
  function loadLS(){
    try{ return JSON.parse(localStorage.getItem(LS_KEY)) || { trips: {} }; }
    catch{ return { trips: {} }; }
  }
  function saveLS(data){ localStorage.setItem(LS_KEY, JSON.stringify(data)); }

  async function ensureAuthIfNeeded(){
    if (mode === "firebase"){
      await window.AppDataLayer.ensureAuth?.();
      currentUid = firebase.auth().currentUser?.uid || null;
    }
    return currentUid;
  }

  async function listTrips(){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] listTrips blocked until sign-in");
    return [];
  }

    if (mode === "firebase"){
      const uid = await ensureAuthIfNeeded();
      const snap = await db.collection("trips").where("ownerUid","==", uid).get();
      // Sort from newest to oldest
      return snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
    } else {
      const data = loadLS();
      // Sort from newest to oldest
      return Object.entries(data.trips).map(([id, t]) => ({ id, ...t })).sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0));
    }
  }

  async function createTrip(meta){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] createTrip blocked until sign-in");
    return null;
  }

    const nowTs = Date.now();
    const trip = {
      ...meta,
      createdAt: nowTs, updatedAt: nowTs,
      budget: { USD: Number(meta.budgetUSD||0) },
      budgetLocked: !!meta.budgetLocked,
      share: { enabled:false, scope:"full" }
    };
    if (mode === "firebase"){
      const uid = await ensureAuthIfNeeded();
      const docData = { ...trip, ownerUid: uid, expenses: {}, journal: {} };
      const ref = await db.collection("trips").add(docData);
      return { id: ref.id, ...docData };
    } else {
      const data = loadLS();
      const id = "t_"+ (crypto.randomUUID ? crypto.randomUUID() : String(nowTs));
      data.trips[id] = { ...trip, expenses: {}, journal: {} };
      saveLS(data);
      return { id, ...data.trips[id] };
    }
  }

  async function getTrip(id){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] getTrip blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      await ensureAuthIfNeeded();
      const doc = await db.collection("trips").doc(id).get();
      if (!doc.exists) return null;
      const trip = { id: doc.id, ...doc.data() };
      // ensure fields
      trip.expenses = trip.expenses || {};
      trip.journal = trip.journal || {};
      return trip;
    } else {
      const data = loadLS();
      const t = data.trips[id];
      if (!t) return null;
      return { id, ...t };
    }
  }

  async function updateTrip(id, updates){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] updateTrip blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      updates.updatedAt = Date.now();
      await db.collection("trips").doc(id).set(updates, { merge:true });
    } else {
      const data = loadLS();
      data.trips[id] = { ...(data.trips[id]||{}), ...updates, updatedAt: Date.now() };
      saveLS(data);
    }
  }

  async function deleteTrip(id){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] deleteTrip blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      await db.collection("trips").doc(id).delete();
    } else {
      const data = loadLS();
      delete data.trips[id];
      saveLS(data);
    }
  }

  // Expenses
  async function listExpenses(tripId){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] listExpenses blocked until sign-in");
    return [];
  }

    const trip = await getTrip(tripId);
    const exp = trip?.expenses || {};
    return Object.entries(exp).map(([id, v])=>({ id, ...v }));
  }
  async function addExpense(tripId, entry){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] addExpense blocked until sign-in");
    return null;
  }

    entry.createdAt = Date.now();
    if (mode === "firebase"){
      const trip = await getTrip(tripId);
      const id = "e_"+ (crypto.randomUUID ? crypto.randomUUID() : String(entry.createdAt));
      const expenses = { ...(trip.expenses||{}), [id]: entry };
      await updateTrip(tripId, { expenses });
    } else {
      const data = loadLS();
      const id = "e_"+ (crypto.randomUUID ? crypto.randomUUID() : String(entry.createdAt));
      data.trips[tripId].expenses ||= {};
      data.trips[tripId].expenses[id] = entry;
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }
  async function updateExpense(tripId, expId, updates){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] updateExpense blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      const trip = await getTrip(tripId);
      const expenses = { ...(trip.expenses||{}) };
      expenses[expId] = { ...(expenses[expId]||{}), ...updates };
      await updateTrip(tripId, { expenses });
    } else {
      const data = loadLS();
      Object.assign(data.trips[tripId].expenses[expId], updates);
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }
  async function removeExpense(tripId, expId){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] removeExpense blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      // Properly delete a nested map key in Firestore
      const del = firebase.firestore.FieldValue.delete();
      await db.collection("trips").doc(tripId).update({ [`expenses.${expId}`]: del, updatedAt: Date.now() });
    } else {
      const data = loadLS();
      if (data.trips[tripId]?.expenses){ delete data.trips[tripId].expenses[expId]; }
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }

  // Journal
  async function listJournal(tripId){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] listJournal blocked until sign-in");
    return [];
  }

    const trip = await getTrip(tripId);
    const j = trip?.journal || {};
    return Object.entries(j).map(([id, v])=>({ id, ...v }));
  }
  async function addJournal(tripId, entry){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] addJournal blocked until sign-in");
    return null;
  }

    entry.createdAt = Date.now();
    if (mode === "firebase"){
      const trip = await getTrip(tripId);
      const id = "j_"+ (crypto.randomUUID ? crypto.randomUUID() : String(entry.createdAt));
      const journal = { ...(trip.journal||{}), [id]: entry };
      await updateTrip(tripId, { journal });
    } else {
      const data = loadLS();
      const id = "j_"+ (crypto.randomUUID ? crypto.randomUUID() : String(entry.createdAt));
      data.trips[tripId].journal ||= {};
      data.trips[tripId].journal[id] = entry;
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }
  async function updateJournal(tripId, jId, updates){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] updateJournal blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      const trip = await getTrip(tripId);
      const journal = { ...(trip.journal||{}) };
      journal[jId] = { ...(journal[jId]||{}), ...updates };
      await updateTrip(tripId, { journal });
    } else {
      const data = loadLS();
      Object.assign(data.trips[tripId].journal[jId], updates);
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }
  async function removeJournal(tripId, jId){
  if (mode === "firebase" && !firebase.auth().currentUser) {
    console.warn("[guard] removeJournal blocked until sign-in");
    return null;
  }

    if (mode === "firebase"){
      const trip = await getTrip(tripId);
      const journal = { ...(trip.journal||{}) };
      delete journal[jId];
      await updateTrip(tripId, { journal });
    } else {
      const data = loadLS();
      delete data.trips[tripId].journal[jId];
      data.trips[tripId].updatedAt = Date.now();
      saveLS(data);
    }
  }

  return {
    listTrips, createTrip, getTrip, updateTrip, deleteTrip,
    listExpenses, addExpense, updateExpense, removeExpense,
    listJournal, addJournal, updateJournal, removeJournal,
    mode
  };
})();


// --- Helper: reverse geocode → city name (Nominatim) ---
async function reverseGeocodeCity(lat, lng){
  try{
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { "Accept-Language": "he" } });
    const data = await res.json();
    const city = data?.address?.city || data?.address?.town || data?.address?.village || data?.address?.county || null;
    return city || null;
  }catch(e){
    console.warn("reverseGeocodeCity failed", e);
    return null;
  }
}

// --- Unsaved changes guard ---
let hasUnsavedChanges = false;
document.addEventListener("input", e=>{
  if (e.target.closest("#tripForm, #expenseDialog, #journalDialog")) {
    hasUnsavedChanges = true;
  }
});
document.addEventListener("change", e=>{
  if (e.target.closest("#tripMetaForm, #tripForm, #expenseForm, #expenseDialog, #journalForm, #journalDialog")) {
    hasUnsavedChanges = true;
  }
});

// --- Unsaved changes modal ---
function ensureUnsavedDialog(){
  if (el("unsavedDialog")) return el("unsavedDialog");
  const d = document.createElement("dialog");
  d.id = "unsavedDialog";
  d.innerHTML = `
    <form method="dialog" class="unsaved-modal">
      <h3>יש נתונים שלא נשמרו</h3>
      <p>האם לשמור את הנתונים לפני היציאה?</p>
      <menu>
        <button value="save" class="btn primary">שמור</button>
        <button value="discard" class="btn danger">צא בלי לשמור</button>
        <button value="cancel" class="btn ghost">בטל</button>
      </menu>
    </form>`;
  document.body.appendChild(d);
  return d;
}
async function askToSave(){
  const d = ensureUnsavedDialog();
  return new Promise((resolve)=>{
    d.onclose = ()=> resolve(d.returnValue||"cancel");
    d.showModal();
  });
}
async function saveCurrentContext(){
  // Try expense dialog first
  if (el("expenseDialog")?.open){
    el("saveExpenseBtn")?.click();
    await new Promise(r=> setTimeout(r, 100)); // allow handlers to run
    return;
  }
  // Then try journal dialog
  if (el("journalDialog")?.open){
    el("saveJournalBtn")?.click();
    await new Promise(r=> setTimeout(r, 100)); // allow handlers to run
    return;
  }
  // Else try trip meta form
  if (el("tab-meta")?.classList.contains("active")){
    el("tripMetaForm")?.requestSubmit();
    await new Promise(r=> setTimeout(r, 150));
    return;
  }
}
window.addEventListener("beforeunload", (e)=>{
  if (hasUnsavedChanges){
    e.preventDefault();
    e.returnValue = "";
  }
});
// Wrapper for navigation to confirm unsaved changes
async function guardedNavigate(tabName){
  if (hasUnsavedChanges){
    const action = await askToSave();
    if (action === "cancel") return;
    if (action === "save") { await saveCurrentContext(); }
    hasUnsavedChanges = false;
  }
  openTab(tabName);
}
// ---------- Utilities ----------
function setStatus(msg, timeout=1800){
  const s = el("statusLine");
  if (!s) return;
  s.textContent = msg;
  if (state.lastStatusTimer) clearTimeout(state.lastStatusTimer);
  state.lastStatusTimer = setTimeout(()=> s.textContent = "מוכן.", timeout);
}
// Updated to show no decimal places for currency fields
function formatMoney(n){ return Number(n||0).toLocaleString('he-IL', {minimumFractionDigits:0, maximumFractionDigits:0}); }

function parseNumber(v){ return Number(String(v||"").replace(/[^\d.-]/g,""))||0; }
function unformatMoney(str){ return String(str||"").replace(/[,\s]/g,""); }
function formatInputEl(elm){ if (!elm) return; elm.value = formatMoney(parseNumber(elm.value)); }


function applyTheme(){
  if (state.theme === "light"){ document.documentElement.classList.add("light"); }
  else { document.documentElement.classList.remove("light"); }
  localStorage.setItem("theme", state.theme);
}
function toggleTheme(){
  state.theme = (state.theme === "light") ? "dark" : "light";
  applyTheme();
}

// Currency rates
async function fetchRates(base="USD"){
  try{
    const res = await fetch(`https://api.exchangerate.host/latest?base=${base}`);
    const data = await res.json();
    const wanted = new Set(["USD","EUR","ILS", "THB"]);
    Object.keys(state.rates||{}).forEach(k=> wanted.add(k));
    const rates = {};
    wanted.forEach(k=> rates[k] = (k===base?1:(data.rates?.[k] || state.rates[k] || 1)));
    state.rates = rates;
    const eur = rates.EUR, ils = rates.ILS;
    const extra = (state.localCurrency && !["USD","EUR","ILS"].includes(state.localCurrency) && rates[state.localCurrency])
      ? ` • ${formatMoney(rates[state.localCurrency])}` : "";
    if (el("liveRates")) el("liveRates").textContent = `שערים חיים: 1 USD = ${formatMoney(eur)} EUR • ${formatMoney(ils)} ₪${extra}`;
  }catch(e){
    console.warn("Rate fetch failed, using fallback.", e);
    if (el("liveRates")) el("liveRates").textContent = "שערים (גיבוי): USD→EUR≈0.90 • USD→ILS≈3.60";
  }
}

function toUSD(amount, from="USD"){
  if (!amount) return 0;
  if (from === "USD") return Number(amount);
  if (from === "EUR") return Number(amount) / (state.rates.EUR||0.9);
  if (from === "ILS") return Number(amount) / (state.rates.ILS||3.6);
  if (from === "THB") return Number(amount) / (state.rates.THB||36);
  const r = state.rates[from]; if (r) return Number(amount)/r;
  return Number(amount);
}

// ---------- Rendering ----------
async function renderHome(){
  $("#homeView")?.classList.add("active");
  $("#tripView")?.classList.remove("active");

  const trips = await Store.listTrips();
  state.trips = trips;

  const q = (el("tripSearch")?.value||"").trim().toLowerCase();
  const list = el("tripList"); if (!list) return;
  list.innerHTML = "";
  for (const t of trips.filter(x => (x.destination||"").toLowerCase().includes(q))){
    const li = document.createElement("li");
    const days = (t.start && t.end) ? (dayjs(t.end).diff(dayjs(t.start), "day")+1) : 0;
    
    // Translate trip types to Hebrew
    const translatedTripTypes = (t.tripType || []).map(type => TRIP_TYPE_HEBREW[type] || type).join(", ");

    li.innerHTML = `
      <div>
        <div class="trip-title">${t.destination||"—"}</div>
        <div class="muted">${t.start?dayjs(t.start).format("DD/MM/YY"):""}–${t.end?dayjs(t.end).format("DD/MM/YY"):""} • ${days||"?"} ימים</div>
        <div class="row" style="justify-content: flex-start; margin-top: 10px;">
          <span class="badge">${translatedTripTypes||"—"}</span>
        </div>
      </div>
      <div class="row bottom-row">
        <button class="btn edit edit-btn">ערוך</button>
        <button class="btn view">פתח</button>
        <button class="btn danger delete">מחק</button>
      </div>
    `;
    const viewButton = $(".view", li);
    if (viewButton) {
      viewButton.onclick = ()=> openTrip(t.id);
    }
    const editButton = $(".edit", li);
    if (editButton) {
      editButton.onclick = async ()=>{
        await openTrip(t.id);
        // Removed the code that switches to the 'meta' tab
        // Now it will stay on the default tab, which is 'overview'
      };
    }
    const deleteButton = $(".del", li);
    if (deleteButton) {
      deleteButton.onclick = ()=> confirmDeleteTrip(t.id, t.destination);
    }
    list.appendChild(li);
  }
}

function activateTabs(){
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", ()=>{
      const tab = btn.dataset.tab;
      if (hasUnsavedChanges){
        (async ()=>{
          const action = await askToSave();
          if (action === "cancel") return;
          if (action === "save") { await saveCurrentContext(); }
          hasUnsavedChanges = false;
          $$(".tab").forEach(b=> b.classList.remove("active"));
          btn.classList.add("active");
          $$(".panel").forEach(p=> p.classList.remove("active"));
          el("tab-"+tab)?.classList.add("active");
          if (tab === "map") refreshMainMap();
        })();
        return;
      }
      $$(".tab").forEach(b=> b.classList.remove("active"));
      btn.classList.add("active");
      $$(".panel").forEach(p=> p.classList.remove("active"));
      el("tab-"+tab)?.classList.add("active");
      if (tab === "map") refreshMainMap();
    });
  });
}


async function openTrip(id){
  state.currentTripId = id;
  const trip = await Store.getTrip(id);
  if (!trip){ alert("נסיעה לא נמצאה"); return; }

  el("tripTitle").textContent = trip.destination || "נסיעה";
  // The share controls are now in the export tab, so we don't need to get them here
  
  $("#homeView")?.classList.remove("active");
  $("#tripView")?.classList.add("active");

  el("tripDestination").value = trip.destination || "";
  el("tripParticipants").value = trip.participants || "";
  // multi select
  // Removed the line that was causing the error
  // [...el("tripType").options].forEach(opt => opt.selected = Array.isArray(trip.tripType) && trip.tripType.includes(opt.value));
  el("tripStart").value = trip.start || "";
  el("tripEnd").value = trip.end || "";
  // el("tripBudgetUSD").value = trip.budget?.USD || ""; // Removed old budget field
// Render the checkboxes for trip types
  const tripTypeCheckboxes = el("tripTypeCheckboxes");
  if(tripTypeCheckboxes) {
    const tripTypes = trip.tripType || [];
    Array.from(tripTypeCheckboxes.querySelectorAll('input[type="checkbox"]')).forEach(checkbox => {
      checkbox.checked = tripTypes.includes(checkbox.value);
    });
  }

  // Update budget fields
  const budgetUSD = Number(trip.budget?.USD || 0);
  // Make sure elements exist before trying to set their values
  if (el("tripBudgetUSD")) el("tripBudgetUSD").value = formatMoney(Math.round(budgetUSD));
  if (el("tripBudgetEUR")) el("tripBudgetEUR").value = formatMoney(Math.round(budgetUSD * (state.rates?.EUR || 0.9)));
  if (el("tripBudgetILS")) el("tripBudgetILS").value = formatMoney(Math.round(budgetUSD * (state.rates?.ILS || 3.6)));
  // Add formatting focus/blur handlers
  [el("tripBudgetUSD"), el("tripBudgetEUR"), el("tripBudgetILS")].forEach(input=>{
    if(!input) return;
    input.onfocus = ()=>{ input.value = unformatMoney(input.value); };
    input.onblur  = ()=>{ formatInputEl(input); };
  });

  
  await renderBudget();
  await renderOverviewExpenses();
  await renderOverviewJournal();
  await renderJournal();
  await renderOverviewMiniMap();

  // Add event listeners for new budget fields
  if (el("tripBudgetUSD")) el("tripBudgetUSD").oninput = (e) => updateBudgetConversion(e.target.value, 'USD');
  if (el("tripBudgetEUR")) el("tripBudgetEUR").oninput = (e) => updateBudgetConversion(e.target.value, 'EUR');
  if (el("tripBudgetILS")) el("tripBudgetILS").oninput = (e) => updateBudgetConversion(e.target.value, 'ILS');


  // New logic to handle share controls now that they are in the export tab
  const shareToggle = el("shareToggle");
  if (shareToggle) {
    shareToggle.checked = !!trip.share?.enabled;
  }
  const shareScope = el("shareScope");
  if (shareScope) {
    shareScope.value = trip.share?.scope || "full";
  }

  if (shareToggle){
    shareToggle.onchange = async ()=>{
      await Store.updateTrip(id, { share: { enabled: shareToggle.checked, scope: el("shareScope").value } });
      setStatus(shareToggle.checked ? "שיתוף הופעל" : "שיתוף בוטל");
    };
  }
  if (el("shareScope")){
    el("shareScope").onchange = async ()=>{
      await Store.updateTrip(id, { share: { enabled: el("shareToggle").checked, scope: el("shareScope").value } });
      setStatus("היקף שיתוף עודכן");
    };
  }
  setupBudgetLock(trip);
}

function setupBudgetLock(trip) {
  const btn = el("toggleBudgetLock");
  const usd = el("tripBudgetUSD");
  const eur = el("tripBudgetEUR");
  const ils = el("tripBudgetILS");

  if (!btn || !usd || !eur || !ils) return;

  function applyLockUI(locked) {
    usd.disabled = eur.disabled = ils.disabled = locked;
    btn.textContent = locked ? "ערוך תקציב" : "קבע תקציב";
  }

  applyLockUI(!!trip.budgetLocked);

  btn.onclick = async () => {
    const newLocked = !trip.budgetLocked;
    trip.budgetLocked = newLocked;
    applyLockUI(newLocked);
    await Store.updateTrip(trip.id, { budgetLocked: newLocked });
    setStatus(newLocked ? "התקציב ננעל" : "התקציב פתוח לעריכה");
  };
}


// Function to handle budget conversion
function updateBudgetConversion(value, fromCurrency) {
    const rates = state.rates || {};
    const num = parseNumber(value);
    let usdValue = 0;

    switch (fromCurrency) {
      case 'USD':
        usdValue = num; break;
      case 'EUR':
        usdValue = num / (rates.EUR || 0.9); break;
      case 'ILS':
        usdValue = num / (rates.ILS || 3.6); break;
      default:
        usdValue = num;
    }

    if (el("tripBudgetUSD")) el("tripBudgetUSD").value = formatMoney(Math.round(usdValue));
    if (el("tripBudgetEUR")) el("tripBudgetEUR").value = formatMoney(Math.round(usdValue * (state.rates?.EUR || 0.9)));
    if (el("tripBudgetILS")) el("tripBudgetILS").value = formatMoney(Math.round(usdValue * (state.rates?.ILS || 3.6)));
}



function confirmDeleteTrip(id, name){
  const dlg = el("confirmDialog");
  if (!dlg) return;
  el("confirmTitle").textContent = "מחיקת נסיעה";
  el("confirmMsg").textContent = `למחוק את "${name||"נסיעה"}"? לא ניתן לשחזור.`;
  dlg.showModal();
  el("confirmYes").onclick = async ()=>{
    await Store.deleteTrip(id);
    dlg.close();
    setStatus("נסיעה נמחקה");
    renderHome();
  };
}

async function renderOverviewExpenses() {
  const trip = await Store.getTrip(state.currentTripId);
  if (!trip) return;

  const tbody = $("#overviewExpenseTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  let expenses = await Store.listExpenses(trip.id);

  // Sort newest → oldest
  expenses.sort((a, b) => b.createdAt - a.createdAt);

  for (const e of expenses) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${linkifyToIcon(e.desc||"—")}</td>
      <td>${e.category||"—"}</td>
      <td>${e.amount ?? 0}</td>
      <td>${e.currency||"USD"}</td>
      <td>${extractCityName(e.placeName)}</td>
      <td><div class="expense-datetime">
        <span class="time">${dayjs(e.createdAt).format("HH:mm")}</span>
        <span class="date">${dayjs(e.createdAt).format("DD/MM")}</span>
      </div></td>
    `;
    tbody.appendChild(tr);
  }
}

async function renderOverviewJournal() {
  const tripId = state.currentTripId;
  const entries = await Store.listJournal(tripId);
  const tbody = $("#overviewJournalTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  // Sort newest → oldest
  entries.sort((a,b) => b.createdAt - a.createdAt);

  for (const j of entries){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${linkifyToIcon((j.text || "").replace(/\n|\r/g, " "))}</td>
      <td>${extractCityName(j.placeName)}</td>
      <td><div class="expense-datetime">
        <span class="time">${dayjs(j.createdAt).format("HH:mm")}</span>
        <span class="date">${dayjs(j.createdAt).format("DD/MM")}</span>
      </div></td>
    `;
    tbody.appendChild(tr);
  }
}

async function renderOverviewMiniMap(){
  const trip = await Store.getTrip(state.currentTripId);
  if (!trip) return;
  const points = [];
  if (trip.expenses){
    Object.values(trip.expenses).forEach(e=>{ if (e.lat && e.lng) points.push({ ...e, type:"expense" }); });
  }
  if (trip.journal){
    Object.values(trip.journal).forEach(j=>{ if (j.lat && j.lng) points.push({ ...j, type:"journal" }); });
  }

  const mapEl = el("miniMap");
  if (mapEl){
    if (!state.maps.mini){
      state.maps.mini = L.map(mapEl, { zoomControl:false, attributionControl:false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.maps.mini);
    }
    const map = state.maps.mini;
    const group = L.featureGroup();
    points.forEach(p=>{
      const marker = L.circleMarker([p.lat,p.lng], { radius:6, weight:1, color: (p.type==="expense"?"#ff6b6b":"#5b8cff") }).bindPopup(p.desc||p.text||"");
      group.addLayer(marker);
    });
    group.addTo(map);
    if (points.length){
      map.fitBounds(group.getBounds().pad(0.4));
    } else {
      map.setView([31.8, 35.2], 7);
    }
  }

  // overview meta
  const tripDays = (trip.start && trip.end) ? `${dayjs(trip.start).format("DD/MM/YY")}–${dayjs(trip.end).format("DD/MM/YY")}` : "—";
  
  // Translate trip types to Hebrew
  const translatedTripTypes = (trip.tripType || []).map(type => TRIP_TYPE_HEBREW[type] || type).join(", ");
  
  if (el("overviewMeta")){
    el("overviewMeta").innerHTML = `
      <div><strong>יעד:</strong> ${linkifyToIcon(trip.destination||"—")}</div>
      <div><strong>תאריכים:</strong> ${tripDays}</div>
      <div><strong>משתתפים:</strong> ${linkifyToIcon(trip.participants||"—")}</div>
      <div><strong>סוג:</strong> ${translatedTripTypes||"—"}</div>
    `;
  if (el("tripBudgetILSDisplay")) {
    const ilsBudget = Math.round((trip.budget?.USD || 0) * (state.rates?.ILS || 3.6));
    el("tripBudgetILSDisplay").innerHTML = `<strong>תקציב הטיול:</strong> ₪${formatMoney(ilsBudget)}`;
  }

  }

  const jList = el("recentJournal"); if (jList){ jList.innerHTML = "";
    const journal = await Store.listJournal(trip.id);
    journal.slice(0,5).forEach(j=>{
      const li = document.createElement("li");
      li.innerHTML = `<div>${j.text||"—"}</div><div class="muted">${dayjs(j.createdAt).format("DD/MM HH:mm")}</div>`;
      jList.appendChild(li);
    });
  }
}

// Budget
function updateCellWithValue(elm, value, prefix) {
  if (!elm) return;
  elm.textContent = `${prefix}${formatMoney(value)}`;
  if (value < 0) {
    elm.classList.add("negative");
  } else {
    elm.classList.remove("negative");
  }
}

async function renderBudget(){
  const trip = await Store.getTrip(state.currentTripId);
  if (!trip) return;
  if (trip.localCurrency){ state.localCurrency = trip.localCurrency; addCurrencyToState(trip.localCurrency); }

  const tbody = $("#expenseTable tbody");
  if (tbody) tbody.innerHTML = "";
  let expenses = await Store.listExpenses(trip.id);
  // Default sort expenses by date in descending order
  expenses.sort((a, b) => b.createdAt - a.createdAt);

  // Add event listener for the sort button
  const sortButton = el("sortExpensesBtn");
  if (sortButton) {
    sortButton.onclick = () => {
      state.sortAsc = !state.sortAsc; // Toggle sort direction
      expenses.sort((a, b) => {
        const aVal = a.createdAt;
        const bVal = b.createdAt;
        if (state.sortAsc) {
          return aVal - bVal;
        } else {
          return bVal - aVal;
        }
      });
      // Update the button icon
      sortButton.innerHTML = `<span>${state.sortAsc ? '&#9650;' : '&#9660;'}</span> מיין`;
      renderExpenses(expenses);
    };
  }
  
  function renderExpenses(expensesToRender) 

{
  if (!tbody) return;
  tbody.innerHTML = "";
  let totalUSD = 0;
  let totalEUR = 0;
  let totalILS = 0;

  const budgetUSD = Number(trip.budget?.USD || 0);

  for (const e of expensesToRender){
    const usdAmount = toUSD(e.amount, e.currency);
    totalUSD += usdAmount;
    totalEUR += usdAmount * (state.rates.EUR || 0.9);
    totalILS += usdAmount * (state.rates.ILS || 3.6);

    
const tr = document.createElement("tr");
tr.dataset.expid = e.id;
tr.innerHTML = `
      <td>${linkifyToIcon(e.desc||"—")}</td>
      <td>${e.category||"—"}</td>
      <td>${e.amount ?? 0}</td>
      <td>${e.currency||"USD"}</td>
      <td>${extractCityName(e.placeName)}</td>
      <td><div class="expense-datetime"><span class="time">${dayjs(e.createdAt).format("HH:mm")}</span><span class="date">${dayjs(e.createdAt).format("DD/MM")}</span></div></td>
      <td class="row-actions">
        <button class="btn ghost edit">ערוך</button>
        <button class="btn ghost danger del">מחק</button>
      </td>
    `;
// If placeName missing but lat/lng exist → fetch city and persist
(async ()=>{
  if ((!e.placeName || e.placeName==="") && typeof e.lat === "number" && typeof e.lng === "number"){
    const city = await reverseGeocodeCity(e.lat, e.lng);
    if (city){
      const td = tr.querySelectorAll("td")[4];
      if (td) td.textContent = city;
      try { await Store.updateExpense(trip.id, e.id, { placeName: city }); } catch(_){}
    }
  }
})();

    $(".edit", tr).onclick = ()=> openExpenseDialog(e);
    $(".del", tr).onclick = ()=> removeExpense(e);
    tbody.appendChild(tr);
  }

  // Update budget card UI (totals & remaining)
  if (el("budgetTotalUSD")) el("budgetTotalUSD").textContent = `$${formatMoney(budgetUSD)}`;
  if (el("budgetTotalEUR")) el("budgetTotalEUR").textContent = `€${formatMoney(budgetUSD * (state.rates.EUR || 0.9))}`;
  if (el("budgetTotalILS")) el("budgetTotalILS").textContent = `₪${formatMoney(budgetUSD * (state.rates.ILS || 3.6))}`;

  if (el("expensesActualUSD")) el("expensesActualUSD").textContent = `$${formatMoney(totalUSD)}`;
  if (el("expensesActualEUR")) el("expensesActualEUR").textContent = `€${formatMoney(totalEUR)}`;
  if (el("expensesActualILS")) el("expensesActualILS").textContent = `₪${formatMoney(totalILS)}`;

  updateCellWithValue(el("remainingUSD"), budgetUSD - totalUSD, "$");
  updateCellWithValue(el("remainingEUR"), budgetUSD * (state.rates.EUR || 0.9) - totalEUR, "€");
  updateCellWithValue(el("remainingILS"), budgetUSD * (state.rates.ILS || 3.6) - totalILS, "₪");
}



  renderExpenses(expenses);
}

// Journal
async function renderJournal(){
  const tripId = state.currentTripId;
  const entries = await Store.listJournal(tripId);
  const tbody = $("#journalTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  // Sort journal entries from newest to oldest
  entries.sort((a,b) => b.createdAt - a.createdAt);

  for (const j of entries){
    const tr = document.createElement("tr");
    tr.dataset.journalid = j.id;
    tr.innerHTML = `
      <td>${linkifyToIcon((j.text || "").replace(/[\n\r]+/g, " ").slice(0, 80))}${j.text && j.text.length > 80 ? '...' : ''}</td>
      <td>${extractCityName(j.placeName)}</td>
      <td><div class="expense-datetime"><span class="time">${dayjs(j.createdAt).format("HH:mm")}</span><span class="date">${dayjs(j.createdAt).format("DD/MM")}</span></div></td>
      <td class="row-actions">
        <button class="btn ghost edit">ערוך</button>
        <button class="btn ghost danger del">מחק</button>
      </td>
    `;
    // If placeName missing but lat/lng exist → fetch city and persist
    (async ()=>{
      if ((!j.placeName || j.placeName==="") && typeof j.lat === "number" && typeof j.lng === "number"){
        const city = await reverseGeocodeCity(j.lat, j.lng);
        if (city){
          const td = tr.querySelectorAll("td")[1];
          if (td) td.textContent = city;
          try { await Store.updateJournal(tripId, j.id, { placeName: city }); } catch(_){}
        }
      }
    })();

    $(".edit", tr).onclick = () => openJournalDialog(j);
    $(".del", tr).onclick = () => openJournalDeleteDialog(tripId, j);
    tbody.appendChild(tr);
  }

  // Add event listener for the sort button
  const sortButton = el("sortJournalBtn");
  if (sortButton) {
    sortButton.onclick = () => {
      state.journalSortAsc = !state.journalSortAsc; // Toggle sort direction
      entries.sort((a, b) => {
        const aVal = a.createdAt;
        const bVal = b.createdAt;
        if (state.journalSortAsc) {
          return aVal - bVal;
        } else {
          return bVal - aVal;
        }
      });
      // Update the button icon
      sortButton.innerHTML = `<span>${state.journalSortAsc ? '&#9650;' : '&#9660;'}</span> מיין`;
      renderJournalTable(entries);
    };
  }

  function renderJournalTable(entriesToRender) {
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const j of entriesToRender){
      const tr = document.createElement("tr");
      tr.dataset.journalid = j.id;
      tr.innerHTML = `
        <td>${linkifyToIcon((j.text || "").replace(/[\n\r]+/g, " ").slice(0, 80))}${j.text && j.text.length > 80 ? '...' : ''}</td>
        <td>${extractCityName(j.placeName)}</td>
        <td><div class="expense-datetime"><span class="time">${dayjs(j.createdAt).format("HH:mm")}</span><span class="date">${dayjs(j.createdAt).format("DD/MM")}</span></div></td>
        <td class="row-actions">
          <button class="btn ghost edit">ערוך</button>
          <button class="btn ghost danger del">מחק</button>
        </td>
      `;
      // If placeName missing but lat/lng exist → fetch city and persist
      (async ()=>{
        if ((!j.placeName || j.placeName==="") && typeof j.lat === "number" && typeof j.lng === "number"){
          const city = await reverseGeocodeCity(j.lat, j.lng);
          if (city){
            const td = tr.querySelectorAll("td")[1];
            if (td) td.textContent = city;
            try { await Store.updateJournal(tripId, j.id, { placeName: city }); } catch(_){}
          }
        }
      })();
      $(".edit", tr).onclick = () => openJournalDialog(j);
      $(".del", tr).onclick = () => openJournalDeleteDialog(tripId, j);
      tbody.appendChild(tr);
    }
  }

  renderJournalTable(entries);
}

// Maps
function refreshMainMap(){
  if (!state.currentTripId) return;
  const mapEl = el("mainMap");
  if (mapEl){
    if (!state.maps.main){
      state.maps.main = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.maps.main);
    }
    const map = state.maps.main;
    (async ()=>{
      const trip = await Store.getTrip(state.currentTripId);
      if (!trip) return;
      const group = L.featureGroup();
      function addPoint(p, color){
        const m = L.circleMarker([p.lat,p.lng], { radius:7, color, weight:2 }).bindPopup((p.desc||p.text||"") + (p.placeName?`<br>${p.placeName}`:""));
        group.addLayer(m);
      }
      group.clearLayers();
      if (trip.expenses) Object.values(trip.expenses).forEach(e=>{ if (e.lat && e.lng) addPoint(e, "#ff6b6b"); });
      if (trip.journal) Object.values(trip.journal).forEach(j=>{ if (j.lat && j.lng) addPoint(j, "#5b8cff"); });
      group.addTo(map);
      if (group.getLayers().length) map.fitBounds(group.getBounds().pad(0.3));
      else map.setView([31.8, 35.2], 7);
    })();
  }
}

function openLocationPicker(forType){
  state.locationPick = { lat:null, lng:null, forType };
  const dlg = el("locationDialog");
  if (!dlg) return;
  dlg.showModal();

  const mapEl = el("locationMap");
  if (!state.maps.location){
    state.maps.location = L.map(mapEl);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.maps.location);
    state.maps.location.on("click", (e)=>{
      state.locationPick.lat = e.latlng.lat;
      state.locationPick.lng = e.latlng.lng;
      setStatus(`נבחר: ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
    });
  }
  state.maps.location.setView([31.8, 35.2], 7);

  el("useCurrentLoc").onclick = ()=>{
    navigator.geolocation.getCurrentPosition(pos=>{
      const {latitude, longitude} = pos.coords;
      state.locationPick.lat = latitude; state.locationPick.lng = longitude;
      state.maps.location.setView([latitude,longitude], 13);
      setStatus("זוהה מיקום נוכחי");
    }, ()=> alert("לא ניתן לזהות מיקום"));
  };

  const searchPlaceInput = el("searchPlace");
  const searchPlaceBtn = el("searchPlaceBtn");
  searchPlaceBtn.onclick = async ()=>{
    const q = searchPlaceInput.value.trim();
    if (!q) return;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "he" } });
    const data = await res.json();
    if (data?.[0]){
      const r = data[0];
      const lat = Number(r.lat), lng = Number(r.lon);
      state.locationPick.lat = lat; state.locationPick.lng = lng;
      state.maps.location.setView([lat,lng], 14);
      L.marker([lat,lng]).addTo(state.maps.location);
      setStatus(r.display_name);
    } else {
      alert("לא נמצא מיקום מתאים");
    }
  };


  el("saveLocationBtn").onclick = ()=>{
    if (state.locationPick.lat && state.locationPick.lng){
      if (state.locationPick.forType === "expense"){
        el("expLat").value = state.locationPick.lat;
        el("expLng").value = state.locationPick.lng;
      }
      dlg.close();
    } else {
      alert("בחר מיקום ע\"י לחיצה על המפה או חיפוש.");
    }
  };
}

// Expense dialog
// Expense dialog
async function openExpenseDialog(exp){
  // prepare map + controls inside the expense dialog

  el("expenseDialogTitle").textContent = exp? "עריכת הוצאה" : "הוספת הוצאה";
  el("expDesc").value = exp?.desc || "";
  el("expCat").value = exp?.category || lastUsed.category;
  el("expAmount").value = exp?.amount || 0;

  // set date & time fields from createdAt or now
  (function(){
    const row = el("expDateTimeRow");
    if (exp){ // EDIT MODE: show row and prefill
      if (row) row.style.display = "";
      const ts = exp?.createdAt || Date.now();
      const d = new Date(ts);
      const pad = n => String(n).padStart(2,"0");
      const dateStr = d.toISOString().slice(0,10);
      const timeStr = pad(d.getHours())+":"+pad(d.getMinutes());
      if (el("expDate")) el("expDate").value = dateStr;
      if (el("expTime")) el("expTime").value = timeStr;
    } else { // ADD MODE: hide row; createdAt is set automatically on add
      if (row) row.style.display = "none";
      if (el("expDate")) el("expDate").value = "";
      if (el("expTime")) el("expTime").value = "";
    }
  })();

  const trip = await Store.getTrip(state.currentTripId);
  const allowed = await getAllowedCurrenciesForTrip(trip);
  renderCurrencyOptions(el("expCurrency"), allowed, exp?.currency);

  const destCurrency = allowed.find(c => !["USD","EUR","ILS"].includes(c));
  let defaultCcy = exp?.currency || destCurrency || lastUsed.currency || "USD";
  el("expCurrency").value = defaultCcy;

  el("expLat").value = exp?.lat || "";
  el("expLng").value = exp?.lng || "";
  el("expenseDialog").showModal();
  // initialize embedded expense map
  const mapEl = el("expenseMap");
  if (mapEl){
    if (!state.maps.expense){
      state.maps.expense = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.maps.expense);
    }
    const map = state.maps.expense;
    let marker;
    function setMarker(lat,lng){
      if (marker){ marker.setLatLng([lat,lng]); }
      else { marker = L.marker([lat,lng]).addTo(map); }
      el("expLat").value = lat;
      el("expLng").value = lng;
    }
    // default view
    const dLat = Number(el("expLat").value) || 31.8;
    const dLng = Number(el("expLng").value) || 35.2;
    map.setView([dLat, dLng], (el("expLat").value? 13 : 7));
    if (el("expLat").value && el("expLng").value){ setMarker(dLat, dLng); }

    map.off("click");
    map.on("click", e=> setMarker(e.latlng.lat, e.latlng.lng));

    const btnCur = el("useCurrentLocExp");
    if (btnCur){
      btnCur.onclick = ()=>{
        navigator.geolocation.getCurrentPosition(pos=>{
          const {latitude, longitude} = pos.coords;
          map.setView([latitude, longitude], 13);
          setMarker(latitude, longitude);
          setStatus("זוהה מיקום נוכחי");
        }, ()=> alert("לא ניתן לזהות מיקום"));
      };
    }
    const sInp = el("searchPlaceExp");
    const clearBtn = el("clearLocExp");
    if (clearBtn){
      clearBtn.onclick = ()=>{
        if (marker){ marker.remove(); marker = null; }
        el("expLat").value = ""; el("expLng").value = "";
        setStatus("המיקום נוקה");
      };
    }
    const sBtn = el("searchPlaceBtnExp");
    if (sBtn){
      sBtn.onclick = async ()=>{
        const q = (sInp?.value||'').trim();
        if (!q) return;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { "Accept-Language": "he" } });
        const data = await res.json();
        if (data?.[0]){
          const r = data[0];
          const lat = Number(r.lat), lng = Number(r.lon);
          map.setView([lat,lng], 14);
          setMarker(lat,lng);
          setStatus(r.display_name);
        } else {
          alert("לא נמצא מיקום מתאים");
        }
      };
    }
  }
  el("expenseDialog").dataset.editId = exp?.id || "";
}

function collectExpenseForm(){
  const desc = el("expDesc").value.trim();
  const category = el("expCat").value;
  const amount = Number(el("expAmount").value||0);
  const currency = el("expCurrency").value;
  const lat = parseFloat(el("expLat").value||"");
  const lng = parseFloat(el("expLng").value||"");
  const entry = { desc, category, amount, currency };
  const dStr = el("expDate")?.value || "";
  const tStr = el("expTime")?.value || "";
  if (dStr){
    const ts = new Date(dStr + "T" + (tStr||"12:00") + ":00").getTime();
    if (!isNaN(ts)) entry.createdAt = ts;
  }
  if (!isNaN(lat) && !isNaN(lng)){ entry.lat = lat; entry.lng = lng; }
  const editId = el("expenseDialog").dataset.editId;
  if (editId) entry.id = editId;
  
  // Save last used category and currency
  lastUsed.category = category;
  lastUsed.currency = currency;
  localStorage.setItem("lastCategory", lastUsed.category);
  localStorage.setItem("lastCurrency", lastUsed.currency);

  return entry;
}
async function removeExpense(exp){
  const dlg = el("confirmExpenseDialog");
  if (!dlg) return;
  el("confirmExpenseTitle").textContent = "מחיקת הוצאה";
  el("confirmExpenseMsg").textContent = `למחוק "${exp.desc||"הוצאה"}"?`;

  const yesBtn = el("confirmExpenseYes");
  yesBtn.onclick = null;

  
yesBtn.onclick = async (e) => {
  e.preventDefault();
  try {
    yesBtn.disabled = true;
    console.log("[del] trip", state.currentTripId, "exp", exp.id);
    await Store.removeExpense(state.currentTripId, exp.id);
    setStatus("הוצאה נמחקה");
    const row = document.querySelector(`tr[data-expid="${exp.id}"]`);
    if (row && row.parentElement) row.parentElement.removeChild(row);
    await renderBudget();
    refreshMainMap();
  } catch (err) {
    console.error("[del] failed", err);
    alert("מחיקה נכשלה. נסה שוב.");
  } finally {
    yesBtn.disabled = false;
    dlg.close();
  }
};
dlg.showModal();
}

// Journal dialog
async function openJournalDialog(journalEntry) {
  el("journalDialogTitle").textContent = journalEntry ? "עריכת תיעוד יומי" : "הוספת תיעוד יומי";
  el("journalTextarea").value = journalEntry?.text || "";
  
  // Set date and time fields from createdAt or now
  const ts = journalEntry?.createdAt || Date.now();
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,"0");
  const dateStr = d.toISOString().slice(0,10);
  const timeStr = pad(d.getHours())+":"+pad(d.getMinutes());
  el("journalDate").value = dateStr;
  el("journalTime").value = timeStr;

  el("journalLat").value = journalEntry?.lat || "";
  el("journalLng").value = journalEntry?.lng || "";
  el("journalDialog").showModal();
  el("journalDialog").dataset.editId = journalEntry?.id || "";

  // Initialize embedded journal map
  const mapEl = el("journalMap");
  if (mapEl){
    if (!state.maps.journal){
      state.maps.journal = L.map(mapEl);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.maps.journal);
    }
    const map = state.maps.journal;
    let marker;
    function setMarker(lat,lng){
      if (marker){ marker.setLatLng([lat,lng]); }
      else { marker = L.marker([lat,lng]).addTo(map); }
      el("journalLat").value = lat;
      el("journalLng").value = lng;
    }
    
    const dLat = Number(el("journalLat").value) || 31.8;
    const dLng = Number(el("journalLng").value) || 35.2;
    map.setView([dLat, dLng], (el("journalLat").value? 13 : 7));
    if (el("journalLat").value && el("journalLng").value){ setMarker(dLat, dLng); }

    map.off("click");
    map.on("click", e=> setMarker(e.latlng.lat, e.latlng.lng));

    const btnCur = el("useCurrentLocJournal");
    if (btnCur){
      btnCur.onclick = ()=>{
        navigator.geolocation.getCurrentPosition(pos=>{
          const {latitude, longitude} = pos.coords;
          map.setView([latitude, longitude], 13);
          setMarker(latitude, longitude);
          setStatus("זוהה מיקום נוכחי");
        }, ()=> alert("לא ניתן לזהות מיקום"));
      };
    }
    const sInp = el("searchPlaceJournal");
    const clearBtn = el("clearLocJournal");
    if (clearBtn){
      clearBtn.onclick = ()=>{
        if (marker){ marker.remove(); marker = null; }
        el("journalLat").value = ""; el("journalLng").value = "";
        setStatus("המיקום נוקה");
      };
    }
    const sBtn = el("searchPlaceBtnJournal");
    if (sBtn){
      sBtn.onclick = async ()=>{
        const q = (sInp?.value||'').trim();
        if (!q) return;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { "Accept-Language": "he" } });
        const data = await res.json();
        if (data?.[0]){
          const r = data[0];
          const lat = Number(r.lat), lng = Number(r.lon);
          map.setView([lat,lng], 14);
          setMarker(lat,lng);
          setStatus(r.display_name);
        } else {
          alert("לא נמצא מיקום מתאים");
        }
      };
    }
  }
}

function collectJournalForm(){
  const text = el("journalTextarea").value.trim();
  const lat = parseFloat(el("journalLat").value||"");
  const lng = parseFloat(el("journalLng").value||"");
  const entry = { text };
  const dStr = el("journalDate")?.value || "";
  const tStr = el("journalTime")?.value || "";
  if (dStr){
    const ts = new Date(dStr + "T" + (tStr||"12:00") + ":00").getTime();
    if (!isNaN(ts)) entry.createdAt = ts;
  }
  if (!isNaN(lat) && !isNaN(lng)){ entry.lat = lat; entry.lng = lng; }
  const editId = el("journalDialog").dataset.editId;
  if (editId) entry.id = editId;

  return entry;
}

// Exporters
async function exportCSV(){
  const trip = await Store.getTrip(state.currentTripId);
  const rows = [["type","desc","category","amount","currency","lat","lng","timestamp"]];
  if (!el("exportWithoutExpenses").checked && trip.expenses){
    for (const e of Object.values(trip.expenses)){
      rows.push(["expense", e.desc||"", e.category||"", e.amount||0, e.currency||"USD", e.lat||"", e.lng||"", e.createdAt||""]);
    }
  }
  if (trip.journal){
    for (const j of Object.values(trip.journal)){
      rows.push(["journal", (j.text||"").replace(/[\n\r]+/g," "), "", "", "", j.lat||"", j.lng||"", j.createdAt||""]);
    }
  }
  const csv = rows.map(r=> r.map(x=> `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trip_${trip.destination||"export"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("CSV נוצר");
}

async function exportGPX(){
  const trip = await Store.getTrip(state.currentTripId);
  function wpt(lat,lng,name,desc,time){
    return `<wpt lat="${lat}" lon="${lng}"><name>${name||""}</name><desc>${desc||""}</desc><time>${new Date(time||Date.now()).toISOString()}</time></wpt>`;
  }
  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TravelJournal" xmlns="http://www.topografix.com/GPX/1/1">
`;
  if (!el("exportWithoutExpenses").checked && trip.expenses){
    for (const e of Object.values(trip.expenses)){
      if (e.lat && e.lng) gpx += wpt(e.lat,e.lng, e.category||"Expense", e.desc||"", e.createdAt);
    }
  }
  if (trip.journal){
    for (const j of Object.values(trip.journal)){
      if (j.lat && j.lng) gpx += wpt(j.lat,j.lng, "Journal", j.text||"", j.createdAt);
    }
  }
  gpx += "\n</gpx>";
  const blob = new Blob([gpx], {type:"application/gpx+xml"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trip_${trip.destination||"export"}.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("GPX נוצר");
}

async function exportPDF(){
  const trip = await Store.getTrip(state.currentTripId);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", compress:true });
  const margin = 40;
  let y = margin;

  doc.setFont("helvetica","bold");
  doc.setFontSize(18);
  doc.text(`דוח נסיעה: ${trip.destination||""}`, margin, y);
  y += 22;

  doc.setFontSize(12);
  doc.setFont("helvetica","normal");
  if (trip.start && trip.end) doc.text(`תאריכים: ${dayjs(trip.start).format("DD/MM/YY")}–${dayjs(trip.end).format("DD/MM/YY")}`, margin, y);
  y+=16;
  doc.text(`משתתפים: ${trip.participants||"—"}`, margin, y); y+=16;
  doc.text(`סוג: ${(trip.tripType||[]).join(", ")||"—"}`, margin, y); y+=20;

  const expenses = await Store.listExpenses(trip.id);
  const totalUSD = expenses.reduce((s,e)=> s + toUSD(e.amount, e.currency), 0);
  doc.setFont("helvetica","bold"); doc.text("סיכום תקציב", margin, y); y+=16;
  doc.setFont("helvetica","normal");
  doc.text(`תקציב USD: $${formatMoney(trip.budget?.USD||0)}`, margin, y); y+=14;
  const rem = (trip.budget?.USD||0) - totalUSD;
  doc.text(`יתרה: $${formatMoney(rem)}`, margin, y); y+=20;

  if (!el("exportWithoutExpenses").checked && expenses.length){
    doc.setFont("helvetica","bold"); doc.text("הוצאות", margin, y); y+=8;
    doc.autoTable({
      startY: y+8, margin:{ left:margin, right:margin },
      styles:{ fontSize:10 }, head:[["תיאור","קטגוריה","סכום","מטבע","זמן"]],
      body: expenses.map(e=> [e.desc||"", e.category||"", String(e.amount||0), e.currency||"USD", dayjs(e.createdAt).format("DD/MM HH:mm")])
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  const journal = await Store.listJournal(trip.id);
  doc.setFont("helvetica","bold"); doc.text("יומן", margin, y); y+=8;
  doc.setFont("helvetica","normal");
  const lines = [];
  journal.forEach(j=>{ lines.push(`${dayjs(j.createdAt).format("DD/MM HH:mm")} – ${j.text||""}`); });
  const split = doc.splitTextToSize(lines.join("\n"), 530);
  doc.text(split, margin, y+14);

  doc.save(`trip_${trip.destination||"report"}.pdf`);
  setStatus("PDF נוצר");
}

// ---------- Init ----------
async function init(){
  applyTheme();
  if (window.AppDataLayer?.mode === "firebase") {
    await window.AppDataLayer.ensureAuth?.();
    console.log("Auth UID:", firebase.auth().currentUser?.uid);
  }

  // Buttons
  if (el("themeToggle")) el("themeToggle").onclick = toggleTheme;
  if (el("addTripFab")) el("addTripFab").onclick = ()=> el("tripDialog").showModal();
  if (el("tripSearch")) el("tripSearch").oninput = renderHome;
  if (el("createTripBtn")) el("createTripBtn").onclick = async (e)=>{
    e.preventDefault();
    const dest = el("newTripDestination").value.trim();
    const start = el("newTripStart").value;
    const end = el("newTripEnd").value;
    if (!dest || !start || !end) return;
    const t = await Store.createTrip({ destination: dest, start, end, tripType: [], participants:"" });
    el("tripDialog").close();
    setStatus("נסיעה נוצרה");
    await renderHome();
    openTrip(t.id);
  };
  if (el("backToHome")) el("backToHome").onclick = renderHome;

  activateTabs();
  if (el("goToBudget")) el("goToBudget").onclick = ()=>{
    $$(".tab").forEach(b=> b.classList.remove("active"));
    $('[data-tab="budget"]').classList.add("active");
    $$(".panel").forEach(p=> p.classList.remove("active"));
    el("tab-budget").classList.add("active");
  };
  if (el("editMetaFromOverview")) el("editMetaFromOverview").onclick = ()=>{
    $$(".tab").forEach(b=> b.classList.remove("active"));
    $('[data-tab="meta"]').classList.add("active");
    $$(".panel").forEach(p=> p.classList.remove("active"));
    el("tab-meta").classList.add("active");
  };

  if (el("tripMetaForm")) el("tripMetaForm").onsubmit = async (e)=>{
    e.preventDefault();
    const id = state.currentTripId;

    const selectedTripTypes = Array.from(el("tripTypeCheckboxes").querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);

    // Get the USD value from the input field
    const budgetUSD = parseNumber(el("tripBudgetUSD").value) || 0;

    const updates = {
      destination: el("tripDestination").value.trim(),
      participants: el("tripParticipants").value.trim(),
      tripType: selectedTripTypes,
      start: el("tripStart").value,
      end: el("tripEnd").value,
      budget: { USD: budgetUSD },
};
    await Store.updateTrip(id, updates);
    setStatus("נתוני נסיעה נשמרו ✔");
    el("tripTitle").textContent = updates.destination || "נסיעה";
    renderBudget();
    await renderOverviewMiniMap();
  };

  if (el("addExpenseBtn")) el("addExpenseBtn").onclick = ()=> openExpenseDialog(null);
  if (el("addJournalBtn")) el("addJournalBtn").onclick = () => openJournalDialog(null);
  if (el("pickLocationBtn")) el("pickLocationBtn").onclick = ()=> openLocationPicker("expense");
  if (el("saveExpenseBtn")) el("saveExpenseBtn").onclick = async (e)=>{
    e.preventDefault();
    const id = state.currentTripId;
    const entry = collectExpenseForm();
    if (!entry) return;
    if (entry.id){
      const { id:expId, ...rest } = entry;
      await Store.updateExpense(id, expId, rest);
      setStatus("הוצאה עודכנה");
    } else {
      await Store.addExpense(id, entry);
      setStatus("הוצאה נוספה");
    }
    el("expenseDialog").close();
    renderBudget(); refreshMainMap();
  };

  // SAVE JOURNAL BUTTON HANDLER
  if (el("saveJournalBtn")) el("saveJournalBtn").onclick = async (e)=>{
    e.preventDefault();
    const id = state.currentTripId;
    const entry = collectJournalForm();
    if (!entry) return;
    
    // Check if placeName is missing but lat/lng exist, then reverse geocode
    if ((!entry.placeName || entry.placeName === "") && typeof entry.lat === "number" && typeof entry.lng === "number"){
      const city = await reverseGeocodeCity(entry.lat, entry.lng);
      if (city) {
        entry.placeName = city;
      }
    }

    if (entry.id){
      const { id:jId, ...rest } = entry;
      await Store.updateJournal(id, jId, rest);
      setStatus("רישום יומן עודכן");
    } else {
      await Store.addJournal(id, entry);
      setStatus("רישום יומן נוסף");
    }
    el("journalDialog").close();
    renderJournal(); 
    refreshMainMap();
  };

  // if (el("saveAllBtn")) el("saveAllBtn").onclick = ()=> setStatus("הכל מעודכן ✔"); // This button was removed
  if (el("copyShareLink")) el("copyShareLink").onclick = async ()=>{
    const t = await Store.getTrip(state.currentTripId);
    if (!t.share?.enabled){ alert("יש להפעיל שיתוף קודם."); return; }
    const scope = el("shareScope").value || "full";
    const url = `${location.origin}${location.pathname}?tripId=${encodeURIComponent(t.id)}&view=shared&scope=${scope}`;
    await navigator.clipboard.writeText(url);
    setStatus("קישור הועתק");
  };

  if (el("exportPDF")) el("exportPDF").onclick = exportPDF;
  if (el("exportCSV")) el("exportCSV").onclick = exportCSV;
  if (el("exportGPX")) el("exportGPX").onclick = exportGPX;

  await fetchRates("USD");

  const params = new URLSearchParams(location.search);
  if (params.get("view")==="shared" && params.get("tripId")){
    // basic shared render (still requires owner auth per rules; for public sharing enable rules accordingly)
    await openTrip(params.get("tripId"));
    $$(".share-controls, .tabs .tab[data-tab='meta'], .tabs .tab[data-tab='export']").forEach(x=> x?.classList?.add?.("hidden"));
    // Hide add/edit buttons as well
    if (el("addExpenseBtn")) el("addExpenseBtn").classList.add("hidden");
    if (el("addJournalBtn")) el("addJournalBtn").classList.add("hidden");
  } else {
    await renderHome();
  }
}

// boot
window.onload = init;

function openJournalDeleteDialog(tripId, entry){
  const dlg = el("confirmJournalDialog");
  if (!dlg) return;

  el("confirmJournalTitle").textContent = "מחיקת רישום יומן";
  const preview = (entry.text || "").trim();
  el("confirmJournalMsg").textContent = preview
    ? `למחוק את הרישום: "${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}"?`
    : `למחוק רישום יומן זה?`;

  const yesBtn = el("confirmJournalYes");
  yesBtn.onclick = null;

  yesBtn.onclick = async (e) => {
    e.preventDefault();
    try {
      yesBtn.disabled = true;
      await Store.removeJournal(tripId, entry.id);
      setStatus("רישום נמחק");
      dlg.close();
      renderJournal();
      refreshMainMap();
    } catch (err) {
      console.error(err);
      alert("מחיקה נכשלה. נסה שוב.");
    } finally {
      yesBtn.disabled = false;
    }
  };

  dlg.showModal();
}



// Splash enter (fallback if user keeps manual enter button elsewhere)
(function(){
  var enter = document.getElementById('enterBtn');
  if(enter){
    enter.addEventListener('click', function(){
      document.body.classList.add('entered');
      document.body.classList.remove('splash-mode');
    });
  }
})();

// Google Auth
(function(){
  try {
    var signInBtn  = document.getElementById('googleSignInBtn');
    var signOutBtn = document.getElementById('signOutBtn');

    function enterApp(){
      document.body.classList.add('entered');
      document.body.classList.remove('splash-mode');
      var app = document.getElementById('app');
      if (app) app.style.display = 'block';
    }
    function showSplash(){
      document.body.classList.remove('entered');
      document.body.classList.add('splash-mode');
      var app = document.getElementById('app');
      if (app) app.style.display = 'none';
    }

    if (typeof auth !== 'undefined' && typeof googleProvider !== 'undefined') {
      if (signInBtn) signInBtn.addEventListener('click', async function(){
        try { await window.__attemptSignIn && window.__attemptSignIn(); }
        catch(err){ console.error(err); alert(err && err.message ? err.message : 'Sign-in failed'); }
      });
      if (signOutBtn) signOutBtn.addEventListener('click', async function(){
        try { await auth.signOut(); } catch(err){ console.error(err); alert(err && err.message ? err.message : 'Sign-out failed'); }
      });
      auth.onAuthStateChanged(function(user){
      console.log("[auth] state changed:", !!user);

        if (user){
          if (signInBtn)  signInBtn.style.display = 'none';
          if (signOutBtn) signOutBtn.style.display = 'inline-flex';
          enterApp();
        } else {
          if (signInBtn)  signInBtn.style.display = 'inline-flex';
          if (signOutBtn) signOutBtn.style.display = 'none';
          showSplash();
        }
      });
    }
  } catch(e){ console.warn('Auth init error', e); }
})();

;(() => {
  // Safe init: don't touch Firestore until auth is available
  if (typeof auth !== 'undefined'){
    // noop; onAuthStateChanged will handle entering the app
  }
})();


// --- Debug helper to verify auth + rules ---
window.debugAuth = async function(){
  try {
    console.log("[dbg] auth?", !!window.auth, "provider?", !!window.googleProvider);
    if (!auth.currentUser){
      console.log("[dbg] no user → opening popup");
      await window.__attemptSignIn && window.__attemptSignIn();
    }
    const uid = auth.currentUser && auth.currentUser.uid;
    console.log("[dbg] uid:", uid || null);
    if (!uid) return;

    const ref = AppDataLayer.db.collection("trips").doc("debug__" + uid.slice(0,6));
    await ref.set({ ownerUid: uid, createdAt: Date.now(), title: "DEBUG" });
    const snap = await ref.get();
    console.log("[dbg] read:", snap.exists, snap.data());
  } catch (e) {
    console.error("[dbg] error:", e.code || "", e.message || e);
  }
};


// Attach Google sign-in handler safely (works with or without inline onclick)
(function(){
  try{
    var btn = document.getElementById('googleSignInBtn');
    if (btn && !btn.__wired){
      btn.__wired = true;
      btn.addEventListener('click', function(e){
        if (typeof window.debugAuth === 'function') {
          return window.debugAuth();
        }
        if (window.auth && window.googleProvider) {
          window.__attemptSignIn && window.__attemptSignIn();
        }
      });
    }
  }catch(e){ console.warn('sign-in wiring failed', e); }
})();


// --- Auth-aware UI bootstrap (avoid UI actions before user exists) ---
document.addEventListener('DOMContentLoaded', function(){
  if (!firebase || !firebase.auth) return;

  var loginBtn = document.getElementById('googleSignInBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', function(){
      if (typeof window.__attemptSignIn === 'function') window.__attemptSignIn();
    });
  }

  firebase.auth().onAuthStateChanged(async function(user){
    document.body.classList.toggle('auth-ok', !!user);
    document.body.classList.toggle('auth-anon', !user);
    if (user) {
      if (typeof window.onAuthReady === 'function') {
        try { await window.onAuthReady(user); } catch(e){ console.warn('onAuthReady failed', e); }
      }
    } else {
      // not signed in – show login UI only
    }
  });
});


// --- Show current email/uid in document title ---
firebase.auth().onAuthStateChanged(function(user){
  if (user) {
    document.title = "🟢 " + (user.email || user.uid);
  } else {
    document.title = "🔴 לא מחובר";
  }
});


// --- UI: show connected account next to the title ---
(function attachUserAccountLabel(){
  try{
    if (!window.firebase || !firebase.auth) return;
    firebase.auth().onAuthStateChanged(function(user){
      var el = document.getElementById('userAccount');
      if (!el) return;
      if (user){
        var label = user.email || user.displayName || 'מחובר';
        el.textContent = '(' + label + ')';
      } else {
        el.textContent = '';
      }
    });
  }catch(e){ console.warn('[ui] userAccount label failed', e); }
})();
