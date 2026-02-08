
var supabase;
// JAVI_BUILD: 2026-02-07-team-cards-v1
/**
 * Javi (Online-first) — Supabase-backed static app
 * - Requires you to fill config.js with SUPABASE_URL + SUPABASE_ANON_KEY
 * - Auth: email/password (Supabase Auth)
 * - Data: Postgres tables (see supabase_setup.sql)
 * - One shared workspace: any authenticated user can read/write all rows
 */
let __renderRunning = false;
let __renderAgain = false;
const CATEGORIES = ["Camera","Lens","Audio","Tripod","Light","Grip","Power","Media","Accessories","Other"];

// --- Multiples helpers (UI groups copies like "SD Card #2" into one line item) ---
function baseName(name){
  return String(name||"").replace(/\s+#\d+\s*$/,"").trim();
}
function copyNumber(name){
  const m = String(name||"").match(/\s+#(\d+)\s*$/);
  return m ? parseInt(m[1],10) : 1;
}
function gearGroupKey(g){
  return (g.category||"") + "||" + baseName(g.name);
}
function buildGearGroups(gearRaw){
  const map = new Map();
  for(const g of gearRaw){
    const key = gearGroupKey(g);
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(g);
  }
  const groups = [];
  for(const [key, items] of map.entries()){
    items.sort((a,b)=>copyNumber(a.name)-copyNumber(b.name));
    const primary = items[0];
    groups.push({
      key,
      category: primary.category,
      name: baseName(primary.name),
      primary,
      items,
      qty: items.length
    });
  }
  groups.sort((a,b)=> (a.category+a.name).localeCompare(b.category+b.name));
  return groups;
}
async function gearItemInUse(gearItemId){
  // Any non-canceled reservation, or present in an OPEN checkout
  try{
    const resv = await sbGetAll("reservations");
    for(const r of resv){
      if(r.gear_item_id !== gearItemId) continue;
      const st = String(r.status||"").toUpperCase();
      if(["CANCELED","CANCELLED","RETURNED","CLOSED"].includes(st)) continue;
      return true;
    }

    const cos = await sbGetAll("checkouts");
    for(const c of cos){
      const st = String(c.status||"").toUpperCase();
      if(["CANCELED","CANCELLED","RETURNED","CLOSED"].includes(st)) continue;

      // checkouts.items can be array of ids or objects; also tolerate JSON-string
      const items = (typeof parseJsonArray === "function")
        ? parseJsonArray(c.items)
        : (Array.isArray(c.items) ? c.items : []);
      for(const it of items){
        if(it === gearItemId) return true;
        if(it && typeof it === "object"){
          if(it.gear_item_id === gearItemId) return true;
          if(it.id === gearItemId) return true;
        }
      }
    }
  }catch(e){
    // ignore
  }
  return false;
}


async function openQrScannerModal({ title="Scan QR", onDetect }){
  const hasBarcodeDetector = typeof window.BarcodeDetector !== "undefined";
  if(!hasBarcodeDetector || !navigator.mediaDevices?.getUserMedia){
    const fallback = prompt("QR scan not available on this device/browser. Paste scanned code:");
    if(fallback && typeof onDetect === "function") onDetect(fallback);
    return;
  }

  const detector = new BarcodeDetector({ formats:["qr_code"] });
  const video = el("video",{autoplay:"autoplay", playsinline:"playsinline", style:"width:100%; border-radius:10px; border:1px solid var(--border); background:#000"});
  const hint = el("div",{class:"small muted", style:"margin-top:8px"},["Point camera at a gear QR code."]);
  let rafId = null;
  let active = true;
  let stream = null;

  const stop = ()=>{
    active = false;
    if(rafId) cancelAnimationFrame(rafId);
    if(stream) stream.getTracks().forEach(t=>t.stop());
  };

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[title]),
      el("span",{class:"badge"},["Camera"])
    ]),
    el("hr",{class:"sep"}),
    video,
    hint,
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      el("button",{class:"btn secondary", onClick:(e)=>{ e.preventDefault(); stop(); m.close(); }},["Cancel"])
    ])
  ]));

  const prevClose = m.close;
  m.close = ()=>{ stop(); prevClose(); };

  const tick = async ()=>{
    if(!active) return;
    try{
      const codes = await detector.detect(video);
      if(codes?.length){
        const val = codes[0].rawValue || "";
        if(val && typeof onDetect === "function") onDetect(val);
        m.close();
        return;
      }
    }catch(_){ }
    rafId = requestAnimationFrame(tick);
  };

  navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:"environment" } }, audio:false })
    .then(s=>{
      stream = s;
      video.srcObject = s;
      video.play().catch(()=>{});
      rafId = requestAnimationFrame(tick);
    })
    .catch(err=>{
      stop();
      m.close();
      toast(err?.message || "Camera access failed.");
    });
}

function $(sel){ return document.querySelector(sel); }
function el(tag, attrs={}, children=[]){
  const e=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==="class") e.className=v;
    else if(k==="html") e.innerHTML=v;
    else if(k.startsWith("on") && typeof v==="function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }

  const append = (child)=>{
    if(child==null || child===false) return;
    if(Array.isArray(child)){
      child.forEach(append);
      return;
    }
    if(child instanceof Node){
      e.appendChild(child);
      return;
    }
    e.appendChild(document.createTextNode(String(child)));
  };

  append(children);
  return e;
}


// Parse a JSON array stored either as an array, JSON string, or null.
// Returns [] on any failure.
function parseJsonArray(v){
  try{
    if(v == null) return [];
    if(Array.isArray(v)) return v;
    if(typeof v === "string"){
      const s = v.trim();
      if(!s) return [];
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    }
    // tolerate PostgREST returning object for jsonb in some edge cases
    return Array.isArray(v) ? v : [];
  }catch(_e){
    return [];
  }
}

/* ===== Location autocomplete (free / no API key) =====
   Uses OpenStreetMap Nominatim public endpoint for address suggestions.
   - Debounced
   - Minimum 3 chars
   - Limited to 5 results
*/
const __locAutoCache = new Map();
let __locAutoLastReqAt = 0;
let __locAutoAbort = null;

function ensureLocationAutocompleteStyles(){
  if(document.querySelector("#javiLocationAutoStyles")) return;
  const st = document.createElement("style");
  st.id = "javiLocationAutoStyles";
  st.textContent = `
    .locAutoWrap{ position:relative; }
    .locSuggestList{
      position:absolute;
      left:0; right:0;
      top: calc(100% + 6px);
      z-index: 9999;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 92%, #0000);
      backdrop-filter: blur(10px);
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.22);
      overflow:hidden;
      max-height: 240px;
      display:none;
    }
    .locSuggestItem{
      display:block;
      width:100%;
      padding: 10px 12px;
      text-align:left;
      background:transparent;
      border:0;
      color: var(--text);
      font-size: 13px;
      cursor:pointer;
    }
    .locSuggestItem:hover{ background: color-mix(in srgb, var(--card) 72%, var(--bg)); }
    .locSuggestMeta{ display:block; opacity:.68; font-size:12px; margin-top:2px; }

.locPreview{
  margin-top:10px;
  border:1px solid var(--border);
  border-radius:14px;
  overflow:hidden;
  background: color-mix(in srgb, var(--bg) 92%, #0000);
}
.locPreview img{ display:block; width:100%; height:auto; }
.locPreviewBar{
  display:flex;
  gap:10px;
  align-items:center;
  justify-content:flex-end;
  padding:10px;
}
.locOpenBtn{
  border:1px solid var(--border);
  background: color-mix(in srgb, var(--card) 92%, #0000);
  color: var(--text);
  border-radius:12px;
  padding:8px 12px;
  font-weight:800;
  text-decoration:none;
}
.locOpenBtn:hover{ filter:brightness(1.03); }
  `;
  document.head.appendChild(st);
}

function debounce(fn, ms){
  let t=null;
  return (...args)=>{
    clearTimeout(t);
    t=setTimeout(()=>fn(...args), ms);
  };
}

async function nominatimSearch(q){
  const query = String(q||"").trim();
  if(query.length < 3) return [];
  if(__locAutoCache.has(query)) return __locAutoCache.get(query);

  // Lightweight rate-limit (nominatim policy is strict; don't spam)
  const now = Date.now();
  const wait = Math.max(0, 900 - (now - __locAutoLastReqAt));
  if(wait) await new Promise(r=>setTimeout(r, wait));
  __locAutoLastReqAt = Date.now();

  try{
    if(__locAutoAbort) __locAutoAbort.abort();
    __locAutoAbort = new AbortController();

    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&accept-language=en&dedupe=1&q=" + encodeURIComponent(query);
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: __locAutoAbort.signal
    });
    if(!res.ok) return [];
    const json = await res.json();
    const out = Array.isArray(json) ? json.map(r=>({
      label: r.display_name,
      address: r.address || null,
      lat: (r.lat!=null ? parseFloat(r.lat) : null),
      lng: (r.lon!=null ? parseFloat(r.lon) : null),
      osm_type: r.osm_type || null,
      osm_id: r.osm_id || null
    })) : [];
    __locAutoCache.set(query, out);
    return out;
  }catch(e){
    return [];
  }


// --- Maps helpers (address-only) ---
function mapsSearchUrl(address){
  const a = String(address||"").trim();
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(a);
}

// (coords-based static map removed)
function osmStaticMapUrl(lat,lng){
  const center = encodeURIComponent(lat + "," + lng);
  return "https://staticmap.openstreetmap.de/staticmap.php?center=" + center +
         "&zoom=15&size=680x320&maptype=mapnik&markers=" + center + ",red-pushpin";
}

}

function attachLocationAutocomplete(inputEl){
  if(!inputEl) return;

  // If modal content is constructed before it’s mounted into the DOM,
  // parentElement will be null. Retry a few times.
  inputEl.__locAutoTries = (inputEl.__locAutoTries||0) + 1;
  if(inputEl.__locAutoAttached) return;

  ensureLocationAutocompleteStyles();

  const wrap = inputEl.parentElement;
  if(!wrap){
    if(inputEl.__locAutoTries <= 6){
      setTimeout(()=>attachLocationAutocomplete(inputEl), 50);
    }
    return;
  }

  inputEl.__locAutoAttached = true;
  wrap.classList.add("locAutoWrap");

const list = el("div", { class:"locSuggestList" });
wrap.appendChild(list);

// Map preview (best-effort, no key)
const preview = el("div",{class:"locPreview", style:"display:none;"},[]);
const previewImg = el("img",{alt:"Map preview"});
const previewBar = el("div",{class:"locPreviewBar"},[]);
const openBtn = el("a",{class:"locOpenBtn", target:"_blank", rel:"noopener noreferrer"},["Open in Maps"]);
previewBar.appendChild(openBtn);
preview.appendChild(previewImg);
preview.appendChild(previewBar);
wrap.appendChild(preview);

const setPreview = (lat,lng,label)=>{
  if(lat==null || lng==null || isNaN(lat) || isNaN(lng)){
    preview.style.display="none";
    return;
  }
  previewImg.src = osmStaticMapUrl(lat,lng);
  openBtn.href = mapsSearchUrl({lat,lng,address:label||inputEl.value});
  preview.style.display="block";
};


  const closeList = ()=>{ list.style.display="none"; list.innerHTML=""; };
  const openList = ()=>{ if(list.innerHTML.trim()) list.style.display="block"; };

  const renderList = (items)=>{
    list.innerHTML = "";
    if(!items || !items.length){ closeList(); return; }
    for(const it of items){
      const main = it.label;
      const btn = el("button", { class:"locSuggestItem", type:"button" }, [
        main,
      ]);
      btn.addEventListener("click", ()=>{
        inputEl.value = main;
        inputEl.__locLat = (it.lat!=null ? +it.lat : null);
        inputEl.__locLng = (it.lng!=null ? +it.lng : null);
        setPreview(inputEl.__locLat, inputEl.__locLng, main);
        closeList();
        inputEl.dispatchEvent(new Event("input", { bubbles:true }));
        inputEl.focus();
      });
      list.appendChild(btn);
    }
    list.style.display="block";
  };

  const doSearch = debounce(async ()=>{
    const q = inputEl.value;
    const items = await nominatimSearch(q);
    renderList(items);
  }, 220);

  inputEl.addEventListener("input", ()=>{
    // manual typing clears previously selected coords
    inputEl.__locLat = null;
    inputEl.__locLng = null;
    setPreview(null,null,null);

    const q = String(inputEl.value||"").trim();
    if(q.length < 3){ closeList(); return; }
    doSearch();
  });

  inputEl.addEventListener("focus", ()=>{
    const q = String(inputEl.value||"").trim();
    if(inputEl.__locLat!=null && inputEl.__locLng!=null){
      setPreview(inputEl.__locLat, inputEl.__locLng, q);
    }
    if(q.length >= 3) doSearch();
    else openList();
  });

  // blur -> hide after click chance
  inputEl.addEventListener("blur", ()=> setTimeout(closeList, 150));
}



// --- Empty-state "ghost" card (onboarding) ---
function ghostCreateCard({ title, subtitle, ctaLabel, onClick, href }){
  const clickable = typeof onClick === "function" || !!href;

  const cardAttrs = {
    class: "card ghostCard" + (clickable ? " isClickable" : "")
  };

  if(clickable){
    cardAttrs.onClick = (e)=>{
      // If the CTA button is clicked, let it handle navigation.
      if(e?.target?.closest && e.target.closest("button,a")) return;
      if(typeof onClick === "function") onClick();
      else if(href) location.hash = href;
    };
  }

  const card = el("div", cardAttrs, []);
  const plus = el("div",{class:"ghostPlus"},["+"]);
  const t = el("div",{class:"ghostTitle"},[title || "Create"]);
  const s = subtitle ? el("div",{class:"muted small ghostSubtitle"},[subtitle]) : null;

  const cta = (ctaLabel && clickable) ? el("div",{class:"ghostCta"},[
    href
      ? el("a",{class:"btn", href},[ctaLabel])
      : el("button",{class:"btn", type:"button", onClick:(e)=>{ e.preventDefault(); e.stopPropagation(); onClick?.(); }},[ctaLabel])
  ]) : null;

  card.appendChild(el("div",{class:"stack ghostBody"},[plus,t,s,cta].filter(Boolean)));
  return card;
}


function setupHeaderUX(){
  // Force a sane viewport in Android WebView/Capacitor so mobile breakpoints work
  let vp = document.querySelector('meta[name="viewport"]');
  if(!vp){
    vp = document.createElement("meta");
    vp.name = "viewport";
    document.head.appendChild(vp);
  }
  vp.content = "width=device-width, initial-scale=1, viewport-fit=cover";

  // Reorder nav links if present
  const nav = document.querySelector("#nav");
  if(nav){
    const order = ["dashboard","events","gear","kits","team"];
    const links = Array.from(nav.querySelectorAll("a[data-route]"));
    const byRoute = Object.fromEntries(links.map(a=>[a.dataset.route,a]));
    order.forEach(r=>{ if(byRoute[r]) nav.appendChild(byRoute[r]); });
  }

  // Create hamburger + menu (append to BODY so it always exists, regardless of header markup)
  if(!document.querySelector("#hamburgerBtn")){
    const btn = document.createElement("button");
    btn.id = "hamburgerBtn";
    btn.type = "button";
    btn.className = "btn secondary";
    btn.textContent = "☰";

    const menu = document.createElement("div");
    menu.id = "hamburgerMenu";
    menu.className = "card";
    menu.innerHTML = `
      <div class="stack" style="gap:10px">
        <button class="btn secondary" id="menuThemeBtn" type="button">Toggle theme</button>
        <button class="btn secondary" id="menuWorkspaceBtn" type="button">Workspace</button>
        <button class="btn secondary" id="menuLogoutBtn" type="button">Sign out</button>
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(menu);

    const settingsThemeBtn = document.querySelector("#settingsThemeBtn");
    const logoutBtn = document.querySelector("#logoutBtn");
    if(!settingsThemeBtn) menu.querySelector("#menuThemeBtn").style.display="none";
    if(!logoutBtn) menu.querySelector("#menuLogoutBtn").style.display="none";

    const close = ()=> menu.classList.remove("open");
    btn.addEventListener("click",(e)=>{ e.preventDefault(); menu.classList.toggle("open"); });

    menu.querySelector("#menuThemeBtn")?.addEventListener("click",()=>{ close(); settingsThemeBtn?.click(); });

    // Workspace shortcut
    menu.querySelector("#menuWorkspaceBtn")?.addEventListener("click",()=>{ close(); location.hash = "#workspace"; });
    menu.querySelector("#menuLogoutBtn")?.addEventListener("click",()=>{ close(); logoutBtn?.click(); });

    document.addEventListener("click",(e)=>{
      if(!menu.classList.contains("open")) return;
      if(e.target===btn || menu.contains(e.target)) return;
      close();
    });
  }

  // Inject CSS once
  if(!document.querySelector("#javiHeaderUXStyles")){
    const st = document.createElement("style");
    st.id="javiHeaderUXStyles";
    st.textContent = `
      #hamburgerBtn{ display:none; }
      #hamburgerBtn{
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) + 10px);
        right: max(12px, env(safe-area-inset-right));
        z-index: 9999;
      }
      #hamburgerMenu{
        position: fixed;
        right: max(12px, env(safe-area-inset-right));
        top: calc(52px + env(safe-area-inset-top, 0px));
        width: min(92vw, 320px);
        z-index: 9998;
        display:none;
      }
      #hamburgerMenu.open{ display:block; }

      /* Keep any header clear of system UI */
      header{
        padding-top: calc(env(safe-area-inset-top, 0px) + 12px);
      }

      @media (max-width: 900px){
        header{ padding-top: calc(env(safe-area-inset-top, 0px) + 20px) !important; }
        #settingsWrap{ display:none !important; }
        #hamburgerBtn{ display:inline-flex !important; }
      }
    
      /* ===== Gear tiles (grid) ===== */
      .gearGrid{
        display:grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap:12px;
      }
      .gearTile{
        display:flex;
        flex-direction:column;
        text-align:left;
        padding:0;
        border:1px solid var(--border);
        border-radius:16px;
        background: color-mix(in srgb, var(--panel) 92%, transparent);
        box-shadow: 0 10px 28px rgba(0,0,0,.06);
        overflow:hidden;
        cursor:pointer;
        color: var(--text);
      }
      .gearTile:hover{ transform: translateY(-1px); }
      .gearTile:active{ transform: translateY(0px); }
      .gearTileMedia{ height:110px; background: color-mix(in srgb, var(--bg) 90%, transparent); display:flex; align-items:center; justify-content:center; }
      .gearTileImg{
        width:100%;
        height:110px;
        object-fit:cover;
        display:block;
      }
      .gearTileImgPlaceholder{
        width:56px;
        height:56px;
        border-radius:14px;
        border:1px dashed var(--border);
        background: color-mix(in srgb, var(--panel) 90%, transparent);
      }
      .gearTileBody{ padding:12px; display:flex; flex-direction:column; gap:6px; min-height:92px; }
      .gearTileTitle{ font-weight:800; line-height:1.15; 
        color: var(--text);
      }
      .gearTileBadge{
        display:inline-flex;
        align-self:flex-start;
        padding:4px 8px;
        border-radius:999px;
        font-size:12px;
        border:1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 92%, transparent);
      }
      .gearTileMeta{ font-size:12px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

`;
    document.head.appendChild(st);
  }


  // Event date hero styles (Google Calendar-like)
  if(!document.querySelector("#javiEventDateHeroStyles")){
    const st2 = document.createElement("style");
    st2.id="javiEventDateHeroStyles";
    st2.textContent = `
      .eventDateHero{
        display:flex;
        gap:12px;
        align-items:flex-start;
        padding:14px 14px;
        border:1px solid var(--border);
        border-radius:16px;
        background: color-mix(in srgb, var(--card) 96%, transparent);
        box-shadow: var(--shadowSoft, 0 10px 26px rgba(0,0,0,.08));
        margin-top:10px;
      }
      .eventDateHeroIcon{
        font-size:20px;
        line-height:1;
        margin-top:2px;
      }
      .eventDateHeroDate{
        font-size:18px;
        font-weight:800;
        letter-spacing:-0.01em;
      }
      .eventDateHeroTime{
        font-size:14px;
        margin-top:4px;
      }
      .eventDateHeroLoc{
        font-size:13px;
        margin-top:4px;
        color: var(--muted);
      }
      @media (max-width: 520px){
        .eventDateHero{ padding:12px 12px; }
        .eventDateHeroDate{ font-size:17px; }
      }
    
.locOpenBtn{
  border:1px solid var(--border);
  background: color-mix(in srgb, var(--card) 92%, #0000);
  color: var(--text);
  border-radius:12px;
  padding:8px 12px;
  font-weight:800;
  text-decoration:none;
}
.locOpenBtn:hover{ filter:brightness(1.03); }
`;
    document.head.appendChild(st2);
  }
  // Also force-show on small screens via JS (in case CSS/media query is weird)
  try{
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = ()=>{
      const hb = document.querySelector("#hamburgerBtn");
      if(!hb) return;
      hb.style.display = mq.matches ? "inline-flex" : "none";
    };
    apply();
    mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
  }catch(_){}
}

function toast(msg){
  const t=$("#toast");
  t.textContent=msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 2600);
}
function toInputDateTimeLocal(d){
  const pad=n=>String(n).padStart(2,"0");
  const yyyy=d.getFullYear(), mm=pad(d.getMonth()+1), dd=pad(d.getDate());
  const hh=pad(d.getHours()), mi=pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function fmt(dt){
  const d = (dt instanceof Date) ? dt : new Date(dt);
  return new Intl.DateTimeFormat(undefined, {dateStyle:"medium", timeStyle:"short"}).format(d);
}

function fmtDateLong(dt){
  const d = (dt instanceof Date) ? dt : new Date(dt);
  return new Intl.DateTimeFormat(undefined, {weekday:"short", month:"short", day:"numeric", year:"numeric"}).format(d);
}
function fmtTime(dt){
  const d = (dt instanceof Date) ? dt : new Date(dt);
  return new Intl.DateTimeFormat(undefined, {timeStyle:"short"}).format(d);
}
function renderEventDateHero(evt){
  const start = evt?.start_at ? new Date(evt.start_at) : null;
  const end = evt?.end_at ? new Date(evt.end_at) : null;
  const dateText = start ? fmtDateLong(start) : "Date TBD";
  let timeText = "";
  if(start && end){
    const sameDay = start.toDateString() === end.toDateString();
    if(sameDay){
      timeText = `${fmtTime(start)} → ${fmtTime(end)}`;
    } else {
      timeText = `${fmt(start)} → ${fmt(end)}`;
    }
  } else if(start){
    timeText = fmtTime(start);
  }
  const wrap = el("div",{class:"eventDateHero"});
  wrap.appendChild(el("div",{class:"eventDateHeroIcon", "aria-hidden":"true"},["📅"]));
  const body = el("div",{style:"flex:1"});
  body.appendChild(el("div",{class:"eventDateHeroDate"},[dateText]));
  if(timeText) body.appendChild(el("div",{class:"eventDateHeroTime"},[timeText]));

const ll = (evt && (evt.location_lat!=null || evt.location_lng!=null)) ? {lat:+evt.location_lat, lng:+evt.location_lng} : null;
if(evt?.location){
  const row = el("div",{class:"eventDateHeroLoc"},[evt.location]);
  // One-tap maps
  const a = el("a",{class:"locOpenBtn", href: mapsSearchUrl({lat: ll?.lat, lng: ll?.lng, address: evt.location}), target:"_blank", rel:"noopener noreferrer", style:"margin-top:8px; display:inline-block;"},["Open in Maps"]);
  body.appendChild(row);
  body.appendChild(a);
  // Map preview (if we have coords)
  if(ll && ll.lat!=null && ll.lng!=null && !isNaN(ll.lat) && !isNaN(ll.lng)){
    const img = el("img",{src: osmStaticMapUrl(ll.lat,ll.lng), alt:"Map preview", style:"margin-top:10px; border-radius:14px; border:1px solid var(--border); width:100%; height:auto;"});
    body.appendChild(img);
  }
}

  wrap.appendChild(body);
  return wrap;
}


/* ===== Dashboard Calendar (Day / Week / Month) ===== */
const CAL_LS_VIEW_KEY = "javi_dash_cal_view";
const CAL_LS_COLOR_KEY = "javi_event_colors_v1";

function calGetView(){
  return localStorage.getItem(CAL_LS_VIEW_KEY) || "month";
}
function calSetView(v){
  localStorage.setItem(CAL_LS_VIEW_KEY, v);
}
function calLoadColorMap(){
  try{ return JSON.parse(localStorage.getItem(CAL_LS_COLOR_KEY) || "{}") || {}; }
  catch(e){ return {}; }
}
function calSaveColorMap(m){
  localStorage.setItem(CAL_LS_COLOR_KEY, JSON.stringify(m||{}));
}
function calGetEventColor(e){
  if(e && e.color) return e.color;
  const m = calLoadColorMap();
  return m[String(e.id)] || "#2563eb"; // default blue-ish
}
async function calSetEventColor(eventId, color){
  const m = calLoadColorMap();
  m[String(eventId)] = color;
  calSaveColorMap(m);
  // Try to persist to Supabase if the column exists; if it doesn't, silently fall back to local storage.
  try{ await sbUpdate("events", eventId, {color}); }catch(_e){}
}
function calDayKey(d){
  const x = (d instanceof Date) ? d : new Date(d);
  const y=x.getFullYear(), m=x.getMonth()+1, dd=x.getDate();
  return `${y}-${String(m).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}
function calStartOfDay(d){
  const x = new Date(d); x.setHours(0,0,0,0); return x;
}
function calEndOfDay(d){
  const x = new Date(d); x.setHours(23,59,59,999); return x;
}
function calStartOfWeek(d){
  const x = calStartOfDay(d);
  const day = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - day);
  return x;
}
function calAddDays(d, n){
  const x = new Date(d); x.setDate(x.getDate()+n); return x;
}
function calSameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function calFmtShort(d){
  return new Intl.DateTimeFormat(undefined,{month:"short", day:"numeric"}).format(d);
}
function calFmtTime(d){
  return new Intl.DateTimeFormat(undefined,{hour:"numeric", minute:"2-digit"}).format(d);
}
function calFmtMonthTitle(d){
  return new Intl.DateTimeFormat(undefined,{month:"long", year:"numeric"}).format(d);
}
function calEventsInRange(events, start, end){
  const s=+start, e=+end;
  return (events||[]).filter(ev=>{
    const a=+new Date(ev.start_at), b=+new Date(ev.end_at);
    return b>=s && a<=e && ev.status!=="CANCELED";
  }).sort((x,y)=>new Date(x.start_at)-new Date(y.start_at));
}

function renderDashboardCalendarCard(events){
  const now = new Date();
  let anchor = new Date(now);
  let viewMode = calGetView(); // "day" | "week" | "month"

  const card = el("div",{class:"card", style:"margin-top:12px"});
  const header = el("div",{class:"gcalToolbar"},[]);
  const left = el("div",{class:"row", style:"gap:8px; flex-wrap:wrap"},[]);
  const right = el("div",{class:"row", style:"gap:8px; flex-wrap:wrap"},[]);
  const title = el("div",{class:"gcalTitle"},["Calendar"]);
  const period = el("div",{class:"gcalPeriod"},[""]);
  const btnPrev = el("button",{class:"btn secondary", onClick:()=>{ shift(-1); }},["◀"]);
  const btnNext = el("button",{class:"btn secondary", onClick:()=>{ shift(1); }},["▶"]);
  const btnToday = el("button",{class:"btn secondary", onClick:()=>{ anchor=new Date(); repaint(); }},["Today"]);

  // segmented view toggle
  const seg = el("div",{class:"seg"},[
    el("button",{class:`segBtn ${viewMode==="day"?"active":""}`, onClick:()=>{viewMode="day"; calSetView("day"); repaint();}},["Day"]),
    el("button",{class:`segBtn ${viewMode==="week"?"active":""}`, onClick:()=>{viewMode="week"; calSetView("week"); repaint();}},["Week"]),
    el("button",{class:`segBtn ${viewMode==="month"?"active":""}`, onClick:()=>{viewMode="month"; calSetView("month"); repaint();}},["Month"])
  ]);

  left.appendChild(title);
  left.appendChild(btnPrev);
  left.appendChild(btnToday);
  left.appendChild(btnNext);
  left.appendChild(period);

  right.appendChild(seg);

  header.appendChild(left);
  header.appendChild(right);

  const body = el("div",{class:"gcalBody"},[]);
  card.appendChild(header);
  card.appendChild(body);

  function shift(dir){
    if(viewMode==="day"){
      anchor = calAddDays(anchor, dir);
    } else if(viewMode==="week"){
      anchor = calAddDays(anchor, dir*7);
    } else {
      const x = new Date(anchor);
      x.setDate(1);
      x.setMonth(x.getMonth()+dir);
      anchor = x;
    }
    repaint();
  }

  function openEventModal(ev){
    const color = calGetEventColor(ev);
    const box = el("div",{},[
      el("div",{class:"row", style:"justify-content:space-between; align-items:flex-start"},[
        el("div",{class:"stack"},[
          el("div",{style:"font-weight:800; font-size:16px"},[ev.title]),
          el("div",{class:"kv"},[`${fmt(ev.start_at)} → ${fmt(ev.end_at)}`]),
          el("div",{class:"kv"},[ev.location || "No location"])
        ]),
        el("span",{class:"badge"},[ev.status||"DRAFT"])
      ]),
      el("hr",{class:"sep"}),
      el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
        el("div",{class:"stack"},[
          el("div",{style:"font-weight:700"},["Event color"]),
          el("div",{class:"muted small"},["Shows on the calendar."])
        ]),
        el("input",{type:"color", value:color, onInput:async (e)=>{
          await calSetEventColor(ev.id, e.target.value);
          repaint();
        }})
      ]),
      el("hr",{class:"sep"}),
      el("div",{class:"row", style:"justify-content:flex-end"},[
        el("a",{href:`#events/${ev.id}`, class:"btn"},["Open event"])
      ])
    ]);
    modal(box);
  }

  function paintDayAgenda(day){
    body.innerHTML="";
    const d0 = calStartOfDay(day);
    const d1 = calEndOfDay(day);
    period.textContent = calFmtShort(d0);

    const list = calEventsInRange(events, d0, d1);
    body.appendChild(el("div",{class:"gcalAgenda"},[
      el("div",{class:"gcalAgendaHeader"},[
        el("div",{style:"font-weight:800"},["Day view"]),
        el("div",{class:"muted small"},[new Intl.DateTimeFormat(undefined,{weekday:"long", month:"long", day:"numeric", year:"numeric"}).format(d0)])
      ])
    ]));

    if(!list.length){
      body.appendChild(el("div",{class:"muted"},["No events this day."]));
      return;
    }

    for(const ev of list){
      const c = calGetEventColor(ev);
      const a = new Date(ev.start_at), b = new Date(ev.end_at);
      const time = `${calFmtTime(a)} – ${calFmtTime(b)}`;
      body.appendChild(el("div",{class:"gcalAgendaItem", onClick:()=>openEventModal(ev)},[
        el("div",{class:"gcalDot", style:`background:${c}`}),
        el("div",{class:"stack", style:"min-width:0"},[
          el("div",{style:"font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis"},[ev.title]),
          el("div",{class:"kv"},[time]),
          el("div",{class:"kv"},[ev.location || "No location"])
        ])
      ]));
    }
  }

  function paintWeek(){
    body.innerHTML="";
    const ws = calStartOfWeek(anchor);
    const we = calAddDays(ws, 6);
    period.textContent = `${calFmtShort(ws)} – ${calFmtShort(we)}`;

    const wrap = el("div",{class:"gcalWeekWrap"},[]);
    const headerRow = el("div",{class:"gcalWeekHeader"},[]);
    const grid = el("div",{class:"gcalWeekGrid"},[]);

    const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    for(let i=0;i<7;i++){
      const day = calAddDays(ws, i);
      headerRow.appendChild(el("div",{class:"gcalWeekColHead"},[
        el("div",{class:"small muted"},[dows[i]]),
        el("div",{class:`gcalWeekDayNum ${calSameDay(day,new Date())?"today":""}`},[String(day.getDate())])
      ]));

      // events for that day
      const dayStart = calStartOfDay(day);
      const dayEnd = calEndOfDay(day);
      const list = calEventsInRange(events, dayStart, dayEnd);

      const col = el("div",{class:"gcalWeekCol", onClick:()=>{ anchor=day; viewMode="day"; calSetView("day"); repaint(); }},[]);
      for(const ev of list.slice(0,6)){
        const c = calGetEventColor(ev);
        col.appendChild(el("div",{class:"gcalChip", style:`border-left-color:${c}`, onClick:(e)=>{e.stopPropagation(); openEventModal(ev);} },[
          el("div",{class:"gcalChipTitle"},[ev.title])
        ]));
      }
      if(list.length>6){
        col.appendChild(el("div",{class:"gcalMore"},[`+${list.length-6} more`]));
      }
      grid.appendChild(col);
    }

    wrap.appendChild(headerRow);
    wrap.appendChild(grid);
    body.appendChild(wrap);
  }

  function paintMonth(){
    body.innerHTML="";
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth()+1, 0);
    period.textContent = calFmtMonthTitle(first);

    // grid start at sunday before first
    const gridStart = calStartOfWeek(first);
    const days = [];
    for(let i=0;i<42;i++) days.push(calAddDays(gridStart, i));

    const wrap = el("div",{class:"gcalMonthWrap"},[]);
    const dow = el("div",{class:"gcalMonthDow"},[]);
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(x=>dow.appendChild(el("div",{class:"gcalDowCell"},[x])));
    const grid = el("div",{class:"gcalMonthGrid"},[]);

    for(const day of days){
      const dayStart = calStartOfDay(day);
      const dayEnd = calEndOfDay(day);
      const list = calEventsInRange(events, dayStart, dayEnd);

      const isOther = day.getMonth()!==first.getMonth();
      const cell = el("div",{class:`gcalDayCell ${isOther?"other":""} ${calSameDay(day,new Date())?"today":""}`, onClick:()=>{
        anchor=day; viewMode="day"; calSetView("day"); repaint();
      }},[
        el("div",{class:"gcalDayTop"},[
          el("div",{class:"gcalDayNum"},[String(day.getDate())]),
          list.length? el("div",{class:"gcalDayDots"}, list.slice(0,4).map(ev=>{
            const c = calGetEventColor(ev);
            return el("span",{class:"gcalDotSm", style:`background:${c}`});
          })) : el("span",{})
        ])
      ]);

      // desktop: show chips
      const chips = el("div",{class:"gcalMonthChips"},[]);
      for(const ev of list.slice(0,2)){
        const c = calGetEventColor(ev);
        chips.appendChild(el("div",{class:"gcalChip month", style:`background:${c}`, onClick:(e)=>{e.stopPropagation(); openEventModal(ev);} },[
          el("span",{class:"gcalChipTitle"},[ev.title])
        ]));
      }
      if(list.length>2){
        chips.appendChild(el("div",{class:"gcalMore"},[`+${list.length-2} more`]));
      }
      cell.appendChild(chips);
      grid.appendChild(cell);
    }

    wrap.appendChild(dow);
    wrap.appendChild(grid);
    body.appendChild(wrap);
  }

  function repaint(){
    // refresh segmented active styles
    seg.querySelectorAll(".segBtn").forEach(btn=>btn.classList.remove("active"));
    if(viewMode==="day") seg.children[0].classList.add("active");
    if(viewMode==="week") seg.children[1].classList.add("active");
    if(viewMode==="month") seg.children[2].classList.add("active");

    if(viewMode==="day") paintDayAgenda(anchor);
    else if(viewMode==="week") paintWeek();
    else paintMonth();
  }

  repaint();
  return card;
}

function overlaps(aStart,aEnd,bStart,bEnd){
  return (aStart < bEnd) && (aEnd > bStart);
}

function requireConfig(){
  const cfg = window.JAVI_CONFIG || {};
  if(!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
     cfg.SUPABASE_URL.includes("PASTE_") || cfg.SUPABASE_ANON_KEY.includes("PASTE_")){
    return null;
  }
  return cfg;
}


const state = {
  route: "dashboard",
  theme: localStorage.getItem("javi_theme") || "dark",
  user: null,
  displayName: localStorage.getItem("javi_display_name") || "",
  workspaceMode: "auto", // "multi" when workspace tables are available, otherwise "legacy"

  // Multi-tenant workspace context (Option B)
  workspaceId: localStorage.getItem("javi_workspace_id") || null,
  workspaceName: localStorage.getItem("javi_workspace_name") || null,
  workspaceRole: localStorage.getItem("javi_workspace_role") || null,

  eventsTab: localStorage.getItem("javi_events_tab") || "upcoming",
  inviteJoinError: null,
  teamTableNoWorkspaceColumn: false,
};


/* ===== Workspace/RLS error helpers ===== */
function _errMsg(e){ return (e && (e.message || e.error_description || e.details)) ? String(e.message || e.error_description || e.details) : String(e||""); }
function isMissingTableErr(e){
  const msg=_errMsg(e).toLowerCase();
  return (e && e.code==="42P01") || msg.includes("relation") && msg.includes("does not exist");
}
function isMissingColumnErr(e){
  const msg=_errMsg(e).toLowerCase();
  return (e && e.code==="42703") || msg.includes("column") && msg.includes("does not exist");
}
function isSchemaCacheErr(e){
  const msg=_errMsg(e).toLowerCase();
  return msg.includes("schema cache") || msg.includes("could not find the function");
}
function isRlsDeniedErr(e){
  const msg=_errMsg(e).toLowerCase();
  // PostgREST commonly returns 401/403-ish messages; supabase-js surfaces as code or message
  return msg.includes("row level security") || msg.includes("rls") || msg.includes("permission denied") || msg.includes("not allowed");
}

function isMissingWorkspaceIdColumnErr(e){
  const msg=_errMsg(e).toLowerCase();
  return isMissingColumnErr(e) && msg.includes("workspace_id");
}
function stripWorkspaceId(obj){
  if(!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const o = {...obj};
  delete o.workspace_id;
  return o;
}

async function getTeamMembersSafe({allowMissing=false}={}){
  try{
    return await sbGetAll("team_members", "name");
  }catch(err){
    const missing = isMissingTableErr(err) || isSchemaCacheErr(err);
    if(allowMissing && missing) return null;
    throw err;
  }
}

function pickDisplayName(user){
  const md = user?.user_metadata || {};
  const raw = md.display_name || md.name || md.full_name || localStorage.getItem("javi_display_name") || "";
  return String(raw || "").trim();
}

async function upsertMyDisplayName(displayName){
  const nm = String(displayName || "").trim();
  if(!nm || !state.user?.id) return;

  state.displayName = nm;
  localStorage.setItem("javi_display_name", nm);

  // Update auth user_metadata (best-effort)
  try{ await supabase.auth.updateUser({ data:{ display_name:nm, name:nm, full_name:nm } }); }catch(_){ }

  // Update profiles table (best-effort)
  try{
    const {error} = await supabase
      .from("profiles")
      .upsert({ id: state.user.id, display_name: nm, updated_at: new Date().toISOString() }, { onConflict:"id" });
    if(error) throw error;
  }catch(_){ }

  // ALSO persist onto workspace_members so teammates can see it even if profiles is locked down by RLS.
  if(state.workspaceId){
    try{
      await supabase
        .from("workspace_members")
        .update({ display_name: nm })
        .eq("workspace_id", state.workspaceId)
        .eq("user_id", state.user.id);
    }catch(_){ }
  }
}

async function fetchDisplayNamesForUserIds(userIds){
  const out = {};
  const ids = Array.from(new Set((userIds||[]).filter(Boolean)));
  if(!ids.length) return out;
  try{
    const {data, error} = await supabase
      .from("profiles")
      .select("id,display_name")
      .in("id", ids);
    if(error) throw error;
    for(const row of (data||[])){
      const nm = String(row.display_name || "").trim();
      if(nm) out[row.id] = nm;
    }
  }catch(_){ }
  return out;
}

function setTheme(theme){
  state.theme=theme;
  document.documentElement.setAttribute("data-theme", theme);
  const settingsThemeBtn = $("#settingsThemeBtn");
  if(settingsThemeBtn){
    settingsThemeBtn.textContent = theme === "dark" ? "Theme: Dark" : "Theme: Light";
  }
  const menuThemeBtn = $("#menuThemeBtn");
  if(menuThemeBtn){
    menuThemeBtn.textContent = theme === "dark" ? "Theme: Dark" : "Theme: Light";
  }
  localStorage.setItem("javi_theme", theme);
}

async function ensureServiceWorker(){
  // Disable SW caching for now: stale cached JS was causing users to see old behavior.
  if(!("serviceWorker" in navigator)) return;
  try{
    const regs = await navigator.serviceWorker.getRegistrations();
    for(const reg of regs){
      try{ await reg.unregister(); }catch(_){ }
    }
    if(window.caches){
      const keys = await caches.keys();
      for(const k of keys){
        if(/^javi-supabase-/i.test(k)){
          try{ await caches.delete(k); }catch(_){ }
        }
      }
    }
  }catch(_){ }
}

/** ---------- Supabase data helpers ---------- **/
async function sbGetAll(table, orderBy=null){
  let q = supabase.from(table).select("*");
  if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy"){
    q = applyWorkspaceScope(q, false);
  }
  if(orderBy) q = q.order(orderBy, {ascending:true});
  const {data, error} = await q;
  if(error){
    // If a tenant table hasn't been migrated (no workspace_id column yet), fall back gracefully.
    if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy" && isMissingWorkspaceIdColumnErr(error)){
      if(table === "team_members"){
        state.teamTableNoWorkspaceColumn = true;
        let q2 = supabase.from(table).select("*");
        if(orderBy) q2 = q2.order(orderBy, {ascending:true});
        const {data: d2, error: e2} = await q2;
        if(e2) throw e2;
        return d2 || [];
      }
    }
    throw error;
  }
  return data || [];
}

async function sbGetById(table, id){
  // Enforce tenant isolation for workspace-scoped tables.
  let q = supabase.from(table).select("*").eq("id", id);
  if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy"){
    if(!state.workspaceId) throw new Error("No workspace selected.");
    // After migration we should NOT have NULL workspace_id rows; keep strict scoping.
    q = q.eq("workspace_id", state.workspaceId);
  }
  const {data, error} = await q.maybeSingle();
  if(error) throw error;
  return data || null;
}
async function sbInsert(table, row){
  // Auto-attach workspace_id for tenant tables.
  if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy"){
    if(!state.workspaceId) throw new Error("No workspace selected.");
    if(row && typeof row === "object" && !Array.isArray(row)){
      if(row.workspace_id == null) row = {...row, workspace_id: state.workspaceId};
    }
  }
  try{
    const {data, error} = await supabase.from(table).insert(row).select("*").single();
    if(error) throw error;
    return data;
  }catch(err){
    // team_members might not have workspace_id yet (partial migration). Retry without workspace_id.
    if(table === "team_members" && state.workspaceMode !== "legacy" && isMissingWorkspaceIdColumnErr(err)){
      state.teamTableNoWorkspaceColumn = true;
      const {data, error} = await supabase.from(table).insert(stripWorkspaceId(row)).select("*").single();
      if(error) throw error;
      return data;
    }
    throw err;
  }
}

async function sbUpdate(table, id, patch){
  // Enforce tenant isolation for workspace-scoped tables.
  let q = supabase.from(table).update(patch).eq("id", id);
  if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy"){
    if(!state.workspaceId) throw new Error("No workspace selected.");
    q = q.eq("workspace_id", state.workspaceId);
  }
  try{
    const {data, error} = await q.select("*").single();
    if(error) throw error;
    return data;
  }catch(err){
    // team_members might not have workspace_id yet (partial migration). Retry by id only.
    if(table === "team_members" && state.workspaceMode !== "legacy" && isMissingWorkspaceIdColumnErr(err)){
      state.teamTableNoWorkspaceColumn = true;
      const {data, error} = await supabase.from(table).update(stripWorkspaceId(patch)).eq("id", id).select("*").single();
      if(error) throw error;
      return data;
    }
    throw err;
  }
}

async function sbDelete(table, id){
  // Keep tenant isolation while still supporting legacy rows with NULL workspace_id.
  let q = supabase.from(table).delete().eq("id", id);
  if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy"){
    if(!state.workspaceId) throw new Error("No workspace selected.");
    q = q.or(`workspace_id.eq.${state.workspaceId},workspace_id.is.null`);
  }
  try{
    const {data, error} = await q;
    if(error) throw error;

    // Some legacy rows may have NULL/missing workspace_id after migration.
    // If scoped delete removed nothing, retry by id only.
    if(TENANT_TABLES.has(table) && state.workspaceMode !== "legacy" && (data || []).length === 0){
      const {error: retryErr} = await supabase.from(table).delete().eq("id", id);
      if(retryErr) throw retryErr;
    }
  }catch(err){
    // team_members might not have workspace_id yet (partial migration). Retry by id only.
    if(table === "team_members" && state.workspaceMode !== "legacy" && isMissingWorkspaceIdColumnErr(err)){
      state.teamTableNoWorkspaceColumn = true;
      const {error: retryErr} = await supabase.from(table).delete().eq("id", id);
      if(retryErr) throw retryErr;
      return;
    }
    throw err;
  }
}


// --- Audit / attribution helpers (best-effort; falls back if columns don't exist) ---
const AUDIT_KEYS = new Set([
  "created_by","created_by_email",
  "reserved_by","reserved_by_email",
  "returned_by","returned_by_email","returned_at",
  "closed_by","closed_by_email"
]);

function _isMissingColumnErr(err){
  const msg = String(err?.message || err || "");
  return /column .* does not exist/i.test(msg) || /Could not find the/i.test(msg);
}

function _errMsg(err){ return String(err?.message || err || ""); }
function isMissingColumnNamed(err, col){
  const msg = _errMsg(err);
  return _isMissingColumnErr(err) && new RegExp(`\b${col}\b`, "i").test(msg);
}
function isMissingProductionDocsColumnErr(err){ return isMissingColumnNamed(err, "production_docs"); }
function isProductionDocsTypeErr(err){
  const msg = _errMsg(err);
  return /invalid input syntax/i.test(msg) || /JSON/i.test(msg) || /cannot cast/i.test(msg);
}
function isMissingLocationLatLngColumnsErr(err){
  return isMissingColumnNamed(err, "location_lat") || isMissingColumnNamed(err, "location_lng");
}
function _stripAudit(obj){
  const o = {...obj};
  for(const k of Object.keys(o)){
    if(AUDIT_KEYS.has(k)) delete o[k];
  }
  return o;
}
function _currentUser(){
  return state?.user || null;
}
async function sbInsertAudit(table, row){
  try{
    return await sbInsert(table, row);
  }catch(err){
    if(_isMissingColumnErr(err)){
      return await sbInsert(table, _stripAudit(row));
    }
    throw err;
  }
}
async function sbUpdateAudit(table, id, patch){
  try{
    return await sbUpdate(table, id, patch);
  }catch(err){
    if(_isMissingColumnErr(err)){
      return await sbUpdate(table, id, _stripAudit(patch));
    }
    throw err;
  }
}
async function sbBulkUpdateAudit(table, matchFn, patch){
  // matchFn: (q)=>q (apply filters). patch may include audit fields.
  try{
    const {error} = await matchFn(supabase.from(table).update(patch));
    if(error) throw error;
    return;
  }catch(err){
    if(_isMissingColumnErr(err)){
      const {error} = await matchFn(supabase.from(table).update(_stripAudit(patch)));
      if(error) throw error;
      return;
    }
    throw err;
  }
}



/** ---------- Workspace (multi-tenant) helpers ---------- **/
async function renameCurrentWorkspace(newName) {
  if (!state.workspaceId) {
    throw new Error("No workspace selected.");
  }

  // Only owners should rename
  if (!canManageWorkspace()) {
    throw new Error("Only the workspace owner can rename the workspace.");
  }

  const { data, error } = await supabase
    .from("workspaces")
    .update({ name: newName })
    .eq("id", state.workspaceId)
    .select("name")
    .single();

  if (error) throw error;

  // Update local state + storage
  state.workspaceName = data.name;
  localStorage.setItem("javi_workspace_name", data.name);

  return data.name;
}
const TENANT_TABLES = new Set(["gear_items","events","kits","reservations","checkouts","team_members"]);

function applyWorkspaceScope(q, includeLegacyNull=false){
  if(state.workspaceMode === "legacy") return q;
  if(!state.workspaceId) throw new Error("No workspace selected.");
  if(includeLegacyNull){
    return q.or(`workspace_id.eq.${state.workspaceId},workspace_id.is.null`);
  }
  return q.eq("workspace_id", state.workspaceId);
}

function syncWorkspaceNavigation(){
  const legacy = state.workspaceMode === "legacy";
  document.querySelectorAll('#nav a[data-route="workspace"]').forEach(a=>{
    a.style.display = legacy ? "none" : "";
  });
  const menuWorkspaceBtn = document.querySelector("#menuWorkspaceBtn");
  if(menuWorkspaceBtn){
    menuWorkspaceBtn.style.display = legacy ? "none" : "";
  }
  const settingsWorkspaceBtn = document.querySelector("#settingsWorkspaceBtn");
  if(settingsWorkspaceBtn){
    settingsWorkspaceBtn.style.display = legacy ? "none" : "";
  }
}

function persistWorkspaceToLocalStorage(){
  if(state.workspaceId) localStorage.setItem("javi_workspace_id", state.workspaceId);
  if(state.workspaceName) localStorage.setItem("javi_workspace_name", state.workspaceName);
  if(state.workspaceRole) localStorage.setItem("javi_workspace_role", state.workspaceRole);
}

function clearWorkspaceLocalStorage(){
  localStorage.removeItem("javi_workspace_id");
  localStorage.removeItem("javi_workspace_name");
  localStorage.removeItem("javi_workspace_role");
  state.workspaceId = null;
  state.workspaceName = null;
  state.workspaceRole = null;
}

// Back-compat alias (older handlers referenced this)
function clearWorkspaceSelection(){
  clearWorkspaceLocalStorage();
}

// Workspace switcher modal (works even if hamburger menu isn't present)
async function openWorkspaceSwitcher(){
  try{
    const workspaces = await fetchMyWorkspaces();
    if(!workspaces.length){
      toast("No workspaces found.");
      return;
    }
    const items = workspaces.map(w=>{
      const active = w.id===state.workspaceId;
      return el("button",{
        class: active ? "btn" : "btn secondary",
        style:"width:100%; justify-content:flex-start",
        onClick:()=>{
          state.workspaceId = w.id;
          state.workspaceName = w.name;
          state.workspaceRole = w.role;
          persistWorkspaceToLocalStorage();
          toast(`Switched to ${w.name}`);
          render();
        }
      },[active ? `✓ ${w.name}` : w.name]);
    });

    modal(el("div",{},[
      el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
        el("h2",{},["Switch workspace"]),
        el("span",{class:"badge"},[state.workspaceRole || "member"])
      ]),
      el("div",{class:"muted small", style:"margin-top:6px"},[
        "Choose which workspace to use for data in the app."
      ]),
      el("hr",{class:"sep"}),
      el("div",{class:"stack", style:"gap:10px"}, items),
    ]));
  }catch(e){
    toast(e?.message || String(e));
  }
}


async function sbRpc(fn, args){
  const {data, error} = await supabase.rpc(fn, args || {});
  if(error) throw error;
  return data;
}

function isMissingWorkspaceSchemaError(err){
  const code = String(err?.code || "").toUpperCase();
  const msg = String(err?.message || err || "").toLowerCase();
  if(code === "42P01" || code === "42703") return true; // undefined table / column
  return (
    msg.includes('workspace_members') && (msg.includes('does not exist') || msg.includes('could not find'))
  ) || (
    msg.includes('workspaces') && (msg.includes('does not exist') || msg.includes('could not find'))
  );
}

async function fetchMyWorkspaces(){
  // Returns [{id, role, name}]
  // NOTE: this function will attempt a one-time self-heal if a user owns workspaces but has no membership rows.
  const {data: memberships0, error: membersErr} = await supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", state.user.id);

  if(membersErr) throw membersErr;

  let rows = memberships0 || [];

  // Self-heal: if user created workspaces but has no membership rows, insert owner memberships.
  if(!rows.length){
    const {data: owned, error: ownedErr} = await supabase
      .from("workspaces")
      .select("id")
      .eq("created_by", state.user.id);

    if(!ownedErr && owned && owned.length){
      // Best effort inserts; ignore duplicate-key errors.
      for(const w of owned){
        await supabase.from("workspace_members").insert([{
          workspace_id: w.id,
          user_id: state.user.id,
          role: "owner",
          display_name: state.displayName || null
        }]);
      }

      const {data: memberships1, error: membersErr2} = await supabase
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", state.user.id);

      if(membersErr2) throw membersErr2;
      rows = memberships1 || [];
    }
  }

  const ids = rows.map(r=>r.workspace_id).filter(Boolean);
  const namesById = {};

  if(ids.length){
    const {data: wsRows, error: wsErr} = await supabase
      .from("workspaces")
      .select("id,name")
      .in("id", ids);

    if(wsErr && !isMissingColumnErr(wsErr)) throw wsErr;

    for(const w of (wsRows || [])){
      namesById[w.id] = w.name;
    }
  }

  const list = rows.map(r=>({
    id: r.workspace_id,
    role: r.role,
    name: namesById[r.workspace_id] || "Workspace"
  }));

  list.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  return list;
}



async function canCreateAnotherWorkspace(){
  // Hard limit: 1 owned workspace per user.
  // Different DB versions used different owner columns; try a few.
  const ownerCols = ["owner_id", "created_by", "user_id"];

  for(const col of ownerCols){
    try{
      const {data, error} = await supabase
        .from("workspaces")
        .select(`id,${col}`)
        .eq(col, state.user.id)
        .limit(1);

      if(error){
        if(isMissingColumnErr(error)) continue;
        // Any other error (incl. RLS), fall through to next strategy
        continue;
      }
      if(Array.isArray(data) && data.length > 0) return false;
    }catch(_){ /* try next */ }
  }

  // Fallback: infer ownership via workspace_members role (covers older schemas).
  try{
    const workspaces = await fetchMyWorkspaces();
    const owned = workspaces.filter(w=>{
      const r = String(w.role||"").toLowerCase();
      return r === "owner" || r === "admin";
    });
    return owned.length < 1;
  }catch(_){
    // If we can't verify, default to NOT allowing another workspace.
    return false;
  }
}



async function createWorkspaceByName(wsNameRaw){
  const canCreate = await canCreateAnotherWorkspace();
  if(!canCreate){
    throw new Error("You can only create 1 workspace for now.");
  }

  const wsName = (wsNameRaw || "").trim() || "My Workspace";
  const newId = await sbRpc("javi_bootstrap_workspace", { workspace_name: wsName });
  const wss = await fetchMyWorkspaces();
  const created = wss.find(w=>w.id===newId) || wss[0];
  if(!created) throw new Error("Workspace was created but could not be loaded.");

  state.workspaceId = created.id;
  state.workspaceName = created.name;
  state.workspaceRole = created.role;
  persistWorkspaceToLocalStorage();
  return created;
}

async function ensureWorkspaceSelected(view){
  // Returns true if workspace is ready; otherwise renders setup UI and returns false.
  if(!state.user) return false;

  let workspaces = [];
  try{
    workspaces = await fetchMyWorkspaces();
    state.workspaceMode = "multi";
  }catch(e){
    // Only fall back to legacy if the workspace schema truly is not installed.
    if(isMissingTableErr(e) || isSchemaCacheErr(e)){
      state.workspaceMode = "legacy";
      state.workspaceId = "legacy";
      state.workspaceName = "Default Workspace";
      state.workspaceRole = "owner";
      return true;
    }

    // Otherwise, keep multi-workspace mode and show a helpful error.
    state.workspaceMode = "multi";
    renderWorkspaceAccessBlocked(view, e);
    return false;
  }

  if(!workspaces.length){
    // If user arrived via an invite link, do NOT show create-workspace UI.
    // Show a dedicated screen so the user isn't dropped onto a blank page
    // if invite acceptance fails.
    if(hasInviteInUrl()){
      renderJoinWorkspaceFromInvite(view);
      return false;
    }
    renderCreateWorkspace(view);
    return false;
  }

  // Keep localStorage-selected workspace if still valid
  const preferred = state.workspaceId && workspaces.find(w=>w.id===state.workspaceId);
  const selected = preferred || workspaces[0];

  state.workspaceId = selected.id;
  state.workspaceName = selected.name;
  state.workspaceRole = selected.role;
  persistWorkspaceToLocalStorage();

  // Optional: expose a quick switcher in the hamburger menu (if present)
  try{ wireWorkspaceMenu(workspaces); }catch(_){}

  return true;
}


/** ---------- Workspace members + invite links ---------- **/
function parseInviteTokenFromHash(){
  const raw = (location.hash || "").replace(/^#/, "");
  // Supported:
  //   #invite=<token>
  //   #workspace?invite=<token>
  //   #workspace/invite/<token>
  if(!raw) return null;

  // #invite=...
  if(raw.toLowerCase().startsWith("invite=")) return raw.split("=").slice(1).join("=").trim() || null;

  // #workspace?invite=...
  if(raw.toLowerCase().startsWith("workspace?")){
    const qs = raw.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    return (params.get("invite") || params.get("token") || "").trim() || null;
  }

  // #workspace/invite/<token>
  const m = raw.match(/workspace\/invite\/(.+)$/i);
  if(m) return decodeURIComponent(m[1]).trim() || null;

  // Any hash containing invite=
  if(raw.toLowerCase().includes("invite=")){
    const idx = raw.toLowerCase().indexOf("invite=");
    return raw.slice(idx + "invite=".length).trim() || null;
  }

  return null;
}

function hasInviteInUrl(){
  return !!parseInviteTokenFromHash();
}

function isMissingAcceptInviteRpcError(err){
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("javi_accept_invite") && (msg.includes("could not find the function") || msg.includes("schema cache") || msg.includes("does not exist"));
}

async function acceptInviteViaTables(token){
  const tokenCols = ["invite_token", "token", "code"];
  let invite = null;
  let lastErr = null;

  for(const col of tokenCols){
    try{
      const {data, error} = await supabase
        .from("workspace_invites")
        .select("*")
        .eq(col, token)
        .maybeSingle();
      if(error) throw error;
      if(data){ invite = data; break; }
    }catch(err){
      lastErr = err;
    }
  }

  if(!invite){
    if(lastErr) throw lastErr;
    throw new Error("Invite not found.");
  }

  const workspaceId = invite.workspace_id || invite.p_workspace_id || invite.wid || invite.workspace;
  const role = String(invite.invite_role || invite.role || "member").trim() || "member";
  if(!workspaceId) throw new Error("Invite is missing workspace id.");

  const row = { workspace_id: workspaceId, user_id: state.user.id, role };
  const {error: memberErr} = await supabase
    .from("workspace_members")
    .upsert(row, { onConflict: "workspace_id,user_id" });
  if(memberErr) throw memberErr;
}

async function tryAcceptInviteIfPresent(){
  const token = parseInviteTokenFromHash();
  if(!token || !state.user) return false;

  // Do not prompt for display name here. Users set their name in Workspace → Your profile.
  try{
    // Attempt common RPC signatures
    const rpcArgs = [{ invite_token: token }, { token }, { p_token: token }];
    let rpcErr = null;
    let acceptedViaRpc = false;

    for(const args of rpcArgs){
      try{
        await sbRpc("javi_accept_invite", args);
        acceptedViaRpc = true;
        break;
      }catch(e){
        rpcErr = e;
      }
    }

    // Fallback for environments where the accept-invite RPC was not installed.
    if(!acceptedViaRpc){
      if(isMissingAcceptInviteRpcError(rpcErr)){
        await acceptInviteViaTables(token);
      }else if(rpcErr){
        throw rpcErr;
      }
    }

    toast("Invite accepted. You're in!");
    // Clear hash and force workspace refetch
    location.hash = "#dashboard";
    clearWorkspaceSelection();
    return true;
  }catch(e){
    console.warn(e);
    state.inviteJoinError = e?.message || String(e);
    toast(state.inviteJoinError || "Invite failed.");
    // Keep the hash so user can retry after fixing policies
    return false;
  }
}

function pickMemberVisibleName(row){
  const direct = [row?.display_name, row?.name, row?.full_name, row?.user_email, row?.email, row?.username, row?.handle];
  for(const v of direct){
    const nm = String(v || "").trim();
    if(nm) return nm;
  }
  return "";
}

async function fetchWorkspaceMembers(workspaceId){
  let data = null;
  let error = null;

  // Try reading display_name from workspace_members first (if column exists).
  ({data, error} = await supabase
    .from("workspace_members")
    .select("user_id, role, created_at, display_name")
    .eq("workspace_id", workspaceId)
    .order("created_at", {ascending:true}));

  if(error && _isMissingColumnErr(error)){
    ({data, error} = await supabase
      .from("workspace_members")
      .select("user_id, role, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", {ascending:true}));
  }
  if(error) throw error;

  const rows = data || [];
  const nameMap = await fetchDisplayNamesForUserIds(rows.map(r=>r.user_id));

  return rows.map(r=>({ ...r, display_name: nameMap[r.user_id] || r.display_name || "" }));
}

async function createInviteLink(workspaceId, role="member"){
  // Returns a full URL with #invite=<token> (or RPC-provided invite URL)
  let token = null;
  let directLink = null;

  // Try multiple RPC signatures so your SQL can vary slightly.
  const tries = [
    // canonical: workspace_id + optional expiry/uses
    ["javi_create_invite", { workspace_id: workspaceId, expires_hours: 168, max_uses: 25 }],
    // alternate param naming (if you created SQL with p_* args)
    ["javi_create_invite", { p_workspace_id: workspaceId, p_expires_hours: 168, p_max_uses: 25 }]
  ];

  let lastErr = null;
  for(const [fn, args] of tries){
    try{
      const out = await sbRpc(fn, args);
      const payload = Array.isArray(out) ? out[0] : out;

      if(typeof payload === "string"){
        if(/^https?:\/\//i.test(payload)){
          directLink = payload;
          break;
        }
        token = payload;
      }else if(payload && typeof payload === "object"){
        directLink = payload.invite_url || payload.invite_link || payload.url || payload.link || null;
        token = payload.token || payload.invite_token || payload.id || payload.value || payload.code || null;
        if(directLink || token) break;
      }

      if(token) break;
    }catch(e){
      lastErr = e;
    }
  }

  if(directLink) return directLink;

  if(!token){
    if(lastErr) throw lastErr;
    throw new Error("Could not create invite token.");
  }

  const base = location.href.split("#")[0];
  return `${base}#invite=${encodeURIComponent(token)}`;
}

async function deleteWorkspaceAndAllData(workspaceId){
  let lastErr = null;
  const rpcTries = [
    ["javi_delete_workspace", { workspace_id: workspaceId }],
    ["javi_delete_workspace", { p_workspace_id: workspaceId }],
    ["javi_delete_workspace", { wid: workspaceId }]
  ];
  for(const [fn,args] of rpcTries){
    try{ await sbRpc(fn,args); return; }catch(e){ lastErr = e; }
  }

  // Fallback: client-side cascade delete
  const del = async (table, col, val)=>{
    const {error} = await supabase.from(table).delete().eq(col, val);
    if(error) throw error;
  };

  try{
    await del("reservations", "workspace_id", workspaceId);
    await del("checkouts", "workspace_id", workspaceId);
    await del("kits", "workspace_id", workspaceId);
    await del("events", "workspace_id", workspaceId);
    await del("team_members", "workspace_id", workspaceId);
    await del("gear_items", "workspace_id", workspaceId);
    await del("workspace_members", "workspace_id", workspaceId);
    await del("workspaces", "id", workspaceId);
  }catch(e){
    throw lastErr || e;
  }
}

async function deleteMyAccountAndWorkspace(){
  if(!state.workspaceId || !state.user?.id) throw new Error("No workspace selected.");

  const rpcTries = [
    ["javi_delete_account_and_workspace", { workspace_id: state.workspaceId }],
    ["javi_delete_account_and_workspace", { p_workspace_id: state.workspaceId }],
    ["javi_delete_my_account", { workspace_id: state.workspaceId }],
    ["javi_delete_my_account", { p_workspace_id: state.workspaceId }],
    ["javi_delete_my_account", { uid: state.user.id, workspace_id: state.workspaceId }]
  ];

  let lastErr = null;
  for(const [fn,args] of rpcTries){
    try{
      await sbRpc(fn, args);
      return;
    }catch(e){
      lastErr = e;
    }
  }

  throw new Error(
    (lastErr?.message ? `${lastErr.message}. ` : "") +
    "Account deletion is not configured yet in Supabase. Add an RPC like javi_delete_account_and_workspace (security definer) to delete auth user + workspace, then try again."
  );
}

function canManageWorkspace(){
  return String(state.workspaceRole || "").toLowerCase() === "owner";
}


async function leaveCurrentWorkspace(){
  if(!state.workspaceId || !state.user?.id) throw new Error("No workspace selected.");
  if(canManageWorkspace()) throw new Error("Workspace owner cannot leave. Transfer ownership or delete the workspace.");

  const rpcTries = [
    ["javi_leave_workspace", { workspace_id: state.workspaceId }],
    ["javi_leave_workspace", { p_workspace_id: state.workspaceId }],
    ["javi_leave_workspace", { wid: state.workspaceId }]
  ];
  for(const [fn,args] of rpcTries){
    try{ await sbRpc(fn, args); return; }catch(_){ }
  }

  const {data, error} = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.user.id)
    .select("workspace_id");
  if(error) throw error;
  if(Array.isArray(data) && data.length>0) return;

  // If DELETE returns no rows, confirm membership is gone.
  const {data: stillMember, error: chkErr} = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.user.id)
    .maybeSingle();
  if(chkErr) throw chkErr;
  if(stillMember) throw new Error("Could not leave workspace (membership still present).");
}

async function renderWorkspace(view){
  if(state.workspaceMode === "legacy"){
    view.appendChild(el("div",{class:"card"},[
      el("h2",{},["Workspace"]),
      el("div",{class:"muted", style:"margin-top:6px"},[
        "Workspace management is unavailable until the workspace SQL migration is run."
      ]),
      el("hr",{class:"sep"}),
      el("div",{class:"small"},[
        "Your app is using legacy single-workspace mode so Gear, Events, and Kits remain available."
      ])
    ]));
    return;
  }

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Workspace"]),
      el("div",{class:"muted small", style:"margin-top:6px"},[
        state.workspaceName ? `Current: ${state.workspaceName}` : "No workspace selected"
      ])
    ]),
    el("div",{class:"row", style:"gap:8px; flex-wrap:wrap"},[
      el("button",{class:"btn secondary", onClick:()=>{ location.hash="#dashboard"; }},["Back"]),
      el("button",{class:"btn secondary", onClick:()=>{ openWorkspaceSwitcher(); }},["Switch workspace"]),
      el("button",{class:"btn secondary", onClick: async ()=>{
        try{
          if(!(await canCreateAnotherWorkspace())){
            toast("You can only create 1 workspace for now.");
            return;
          }
          const nmRaw = prompt("Workspace name:");
          if(nmRaw===null) return;
          await createWorkspaceByName(nmRaw);
          toast("Workspace created.");
          render();
        }catch(e){
          toast(e?.message || String(e));
        }
      }},["Create workspace"])
    ])
  ]));

  const meCard = el("div",{class:"card", style:"margin-bottom:12px"},[]);
  meCard.appendChild(el("h2",{},["Your profile"]));
  meCard.appendChild(el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px"},[
    el("div",{},[
      el("label",{class:"small muted"},["Email"]),
      el("input",{class:"input", value: state.user?.email || "", readonly:"readonly"})
    ]),
    (()=>{
      const nameInput = el("input",{class:"input", value: state.displayName || "", placeholder:"How teammates see you"});
      const saveBtn = el("button",{class:"btn secondary", style:"margin-top:8px", onClick:async ()=>{
        const nm = (nameInput.value || "").trim();
        if(!nm){ toast("Name is required."); return; }
        try{
          saveBtn.disabled = true;
          saveBtn.textContent = "Saving…";
          await upsertMyDisplayName(nm);
          toast("Name updated.");
          render();
        }catch(e){
          toast(e?.message || String(e));
        }finally{
          saveBtn.disabled = false;
          saveBtn.textContent = "Save name";
        }
      }},["Save name"]);
      return el("div",{},[
        el("label",{class:"small muted"},["Name shown to others"]),
        nameInput,
        saveBtn
      ]);
    })()
  ]));
  view.appendChild(meCard);

  const card = el("div",{class:"card"},[]);
  card.appendChild(el("h2",{},["Members"]));
  card.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
    "If you can't see other members here, update your Supabase RLS policy for workspace_members (see note below)."
  ]));
  card.appendChild(el("hr",{class:"sep"}));

  const listEl = el("div",{class:"stack", style:"gap:8px"},[ el("div",{class:"muted"},["Loading…"]) ]);
  card.appendChild(listEl);

  const inviteBox = el("div",{style:"margin-top:14px"},[]);
  card.appendChild(inviteBox);

  // Owner-only: invite link generator
  if(canManageWorkspace()){
    inviteBox.appendChild(el("hr",{class:"sep"}));
    inviteBox.appendChild(el("div",{style:"font-weight:800"},["Workspace settings"]));
    inviteBox.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
      "Owners can rename this workspace for everyone."
    ]));
    const renameInput = el("input",{class:"input", style:"margin-top:10px", value: state.workspaceName || "", placeholder:"Workspace name"});
    const renameBtn = el("button",{class:"btn secondary", style:"margin-top:10px", onClick: async ()=>{
      const next = String(renameInput.value || "").trim();
      if(!next){ toast("Workspace name is required."); return; }
      try{
        renameBtn.disabled = true;
        renameBtn.textContent = "Saving…";
        const updated = await renameCurrentWorkspace(next);
        renameInput.value = updated;
        toast("Workspace renamed.");
        render();
      }catch(e){
        toast(e?.message || String(e));
      }finally{
        renameBtn.disabled = false;
        renameBtn.textContent = "Save workspace name";
      }
    }},["Save workspace name"]);
    inviteBox.appendChild(renameInput);
    inviteBox.appendChild(renameBtn);

    // Danger zone: delete workspace (owner only)
    inviteBox.appendChild(el("hr",{class:"sep"}));
    inviteBox.appendChild(el("div",{style:"font-weight:800"},["Danger zone"]));
    inviteBox.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
      "Delete this workspace and all its data (events, gear, team, kits). This cannot be undone."
    ]));
    const delBtn = el("button",{class:"btn danger", style:"margin-top:10px", onClick: async ()=>{
      try{
        if(!confirm("Delete this workspace and all its data? This cannot be undone.")) return;
        const typed = prompt('Type DELETE to confirm:');
        if(typed !== "DELETE"){ toast("Cancelled."); return; }

        delBtn.disabled = true;
        delBtn.textContent = "Deleting…";
        await deleteWorkspaceAndAllData(state.workspaceId);

        // Clear selection and return user to create-workspace flow
        clearWorkspaceLocalStorage();
        state.workspaceId = null;
        state.workspaceName = null;
        state.workspaceRole = null;

        toast("Workspace deleted.");
        render();
      }catch(e){
        toast(e?.message || String(e));
      }finally{
        delBtn.disabled = false;
        delBtn.textContent = "Delete this workspace";
      }
    }},["Delete this workspace"]);
    inviteBox.appendChild(delBtn);

    inviteBox.appendChild(el("hr",{class:"sep"}));
    inviteBox.appendChild(el("div",{style:"font-weight:800"},["Invite users"]));
    inviteBox.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
      "Create a link and send it to someone. When they sign in, the app will add them to this workspace."
    ]));

    const out = el("input",{class:"input", readonly:"readonly", value:"", placeholder:"Invite link will appear here", style:"margin-top:10px"});
    const actions = el("div",{class:"row", style:"gap:10px; flex-wrap:wrap; margin-top:10px"},[]);
    const btn = el("button",{class:"btn", onClick: async ()=>{
      try{
        btn.disabled = true;
        btn.textContent = "Creating…";
        const link = await createInviteLink(state.workspaceId, "member");
        out.value = link;
        try{
          await navigator.clipboard?.writeText(link);
          toast("Invite link copied.");
        }catch(_){
          toast("Invite link created.");
        }
      }catch(e){
        toast(e?.message || String(e));
      }finally{
        btn.disabled = false;
        btn.textContent = "Create invite link";
      }
    }},["Create invite link"]);

    const copyBtn = el("button",{class:"btn secondary", onClick: async ()=>{
      try{
        await navigator.clipboard?.writeText(out.value || "");
        toast("Copied.");
      }catch(_){
        toast("Copy not available.");
      }
    }},["Copy"]);

    actions.appendChild(btn);
    actions.appendChild(copyBtn);
    inviteBox.appendChild(out);
    inviteBox.appendChild(actions);

    const danger = el("div",{style:"margin-top:14px"},[
      el("hr",{class:"sep"}),
      el("div",{style:"font-weight:800; color:var(--danger)"},["Danger zone"]),
      el("div",{class:"muted small", style:"margin-top:6px"},[
        "Delete your account. This also deletes your workspace and all associated data in Supabase (events, gear, kits, team members, reservations, checkouts, and memberships)."
      ])
    ]);
    const deleteBtn = el("button",{class:"btn danger", style:"margin-top:10px", onClick:async ()=>{
      if(!state.workspaceId || !state.user?.id) return;
      const confirmName = prompt(`Type the workspace name (${state.workspaceName || "workspace"}) to confirm account deletion:`);
      if((confirmName||"").trim() !== String(state.workspaceName||"").trim()){
        toast("Workspace name did not match. Deletion canceled.");
        return;
      }
      if(!confirm("Final confirmation: permanently delete your account and this workspace for all users?")) return;
      try{
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Deleting account…";
        await deleteMyAccountAndWorkspace();
        try{ await supabase.auth.signOut(); }catch(_){ }
        clearWorkspaceSelection();
        localStorage.removeItem("javi_display_name");
        state.displayName = "";
        toast("Account deleted.");
        location.hash = "#dashboard";
        render();
      }catch(e){
        toast(e?.message || String(e));
      }finally{
        deleteBtn.disabled = false;
        deleteBtn.textContent = "Delete account";
      }
    }},["Delete account"]);
    danger.appendChild(deleteBtn);
    inviteBox.appendChild(danger);
  } else {
    inviteBox.appendChild(el("div",{class:"muted small", style:"margin-top:10px"},[
      "Only the workspace owner can create invite links."
    ]));

    const leaveCard = el("div",{style:"margin-top:14px"},[
      el("hr",{class:"sep"}),
      el("div",{style:"font-weight:800; color:var(--danger)"},["Leave workspace"]),
      el("div",{class:"muted small", style:"margin-top:6px"},[
        "Leave this workspace and remove your membership. This does not delete workspace data."
      ])
    ]);
    const leaveBtn = el("button",{class:"btn danger", style:"margin-top:10px", onClick: async ()=>{
      if(!state.workspaceId) return;
      if(!confirm(`Leave workspace "${state.workspaceName || "Workspace"}"?`)) return;
      try{
        leaveBtn.disabled = true;
        leaveBtn.textContent = "Leaving…";
        await leaveCurrentWorkspace();
        toast("You left the workspace.");
        clearWorkspaceSelection();
        location.hash = "#dashboard";
        render();
      }catch(e){
        toast(e?.message || String(e));
      }finally{
        leaveBtn.disabled = false;
        leaveBtn.textContent = "Leave workspace";
      }
    }},["Leave workspace"]);
    leaveCard.appendChild(leaveBtn);
    inviteBox.appendChild(leaveCard);
  }

  view.appendChild(card);

  // Load members
  try{
    const members = await fetchWorkspaceMembers(state.workspaceId);
    listEl.innerHTML = "";
    if(!members.length){
      listEl.appendChild(el("div",{class:"muted"},["No members found."]));
    } else {
      for(const m of members){
        const isMe = m.user_id === state.user.id;
        listEl.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
          el("div",{class:"stack", style:"min-width:0"},[
            el("div",{style:"font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis"},[
              isMe ? `${state.displayName || state.user.email} (you)` : (m.display_name || `User ${String(m.user_id||"").slice(0,8)}`)
            ]),
            el("div",{class:"muted small"},[
              `Role: ${m.role || "member"}`
            ])
          ]),
          el("span",{class:"badge"},[isMe ? "You" : (m.role||"member")])
        ]));
      }
    }
  }catch(e){
    listEl.innerHTML = "";
    listEl.appendChild(el("div",{class:"muted"},[
      e?.message || String(e)
    ]));
  }

  // RLS note (in-app)
  const note = el("div",{class:"card", style:"margin-top:12px"},[
    el("div",{style:"font-weight:800"},["Supabase note (if members list is blank)"]),
    el("div",{class:"small muted", style:"margin-top:6px"},[
      "In Supabase, make sure workspace_members SELECT policy allows any workspace member to read rows in that workspace.",
      el("br"),
      "Example: using (public.is_workspace_member(workspace_id))"
    ])
  ]);
  view.appendChild(note);
}



async function renderWorkspaceAccessBlocked(view, err){
  const msg = _errMsg(err);
  const details = [
    "Your workspace tables exist, but this signed-in user cannot read them yet (usually due to Supabase RLS policies).",
    "Fix in Supabase:",
    "• Enable RLS on public.workspaces and public.workspace_members",
    "• Add SELECT policies so members can read workspace_members and their workspaces",
    "",
    "Error:",
    msg || "(no message)"
  ].join("\n");

  view.replaceChildren(el("div",{class:"card"},[
    el("h2",{},["Workspace access blocked"]),
    el("pre",{class:"pre"},[details]),
    el("div",{class:"row", style:"gap:10px; flex-wrap:wrap;"},[
      el("button",{class:"btn", onClick:async()=>{ await render(); }},["Retry"]),
      el("button",{class:"btn secondary", onClick:()=>{ location.hash="#dashboard"; }},["Go to dashboard"])
    ])
  ]));
}


function renderJoinWorkspaceFromInvite(view){
  const token = parseInviteTokenFromHash();
  const err = state.inviteJoinError ? String(state.inviteJoinError) : "";

  const card = el("div",{class:"card", style:"max-width:560px; margin:24px auto"});
  card.appendChild(el("h1",{},["Join shared workspace"]));
  card.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
    "You're signed in and trying to join a shared workspace.",
    el("br"),
    "If this stalls, it's usually a Supabase SQL function mismatch (javi_accept_invite) or a workspace_invites column name mismatch."
  ]));
  card.appendChild(el("hr",{class:"sep"}));

  if(token){
    card.appendChild(el("div",{class:"small muted"},["Invite token: ", el("span",{class:"badge"},[String(token).slice(0,12)+"…"])]));
  }

  if(err){
    card.appendChild(el("pre",{class:"pre", style:"margin-top:10px; white-space:pre-wrap"},["Invite error:\n" + err]));
  }else{
    card.appendChild(el("div",{class:"muted"},["Working… If nothing happens in a few seconds, tap Retry."]));
  }

  const actions = el("div",{class:"row", style:"justify-content:flex-end; gap:10px; flex-wrap:wrap; margin-top:12px"},[
    el("button",{class:"btn secondary", onClick:()=>{
      state.inviteJoinError = null;
      location.hash = "#dashboard";
      render();
    }},["Go to dashboard"]),
    el("button",{class:"btn", onClick:async ()=>{
      state.inviteJoinError = null;
      await render();
    }},["Retry join"])
  ]);

  card.appendChild(actions);
  view.appendChild(card);
}

async function renderCreateWorkspace(view){
  const card = el("div",{class:"card", style:"max-width:560px; margin:24px auto"});
  card.appendChild(el("h1",{},["Create your workspace"]));
  card.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
    "This keeps your gear, events, kits, and team private to your workspace.",
    el("br"),
    "You can create 1 workspace per user for now."
  ]));
  card.appendChild(el("hr",{class:"sep"}));

  const name = el("input",{class:"input", placeholder:"Workspace name (e.g., Javi Productions)"});
  const msg = el("div",{class:"small muted", style:"margin-top:10px"},[""]);

  const row = el("div",{class:"row", style:"justify-content:flex-end; margin-top:12px"},[
    el("button",{class:"btn", onClick: async ()=>{
      msg.textContent = "Creating workspace…";
      try{
        await createWorkspaceByName(name.value || "");
        msg.textContent = "Workspace created.";
        render();
      }catch(e){
        msg.textContent = e.message || String(e);
      }
    }},["Create workspace"])
  ]);

  card.appendChild(name);
  card.appendChild(row);
  card.appendChild(msg);

  view.appendChild(card);
}

function wireWorkspaceMenu(workspaces){
  // Adds a "Workspace" button into hamburger menu if it exists.
  const menu = document.querySelector("#hamburgerMenu .stack");
  if(!menu) return;

  if(!document.querySelector("#menuWorkspaceBtn")){
    const btn = document.createElement("button");
    btn.className = "btn secondary";
    btn.type = "button";
    btn.id = "menuWorkspaceBtn";
    btn.textContent = "Workspace";
    menu.prepend(btn);

    btn.addEventListener("click", ()=>{
      const items = (workspaces||[]).map(w=>{
        const active = w.id===state.workspaceId;
        return el("button",{
          class: active ? "btn" : "btn secondary",
          style:"width:100%; justify-content:flex-start",
          onClick:()=>{
            state.workspaceId = w.id;
            state.workspaceName = w.name;
            state.workspaceRole = w.role;
            persistWorkspaceToLocalStorage();
            toast(`Switched to ${w.name}`);
            render();
          }
        },[active ? `✓ ${w.name}` : w.name]);
      });

      modal(el("div",{},[
        el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
          el("h2",{},["Workspace"]),
          el("span",{class:"badge"},[state.workspaceRole || "member"])
        ]),
        el("div",{class:"muted small", style:"margin-top:6px"},[
          state.workspaceName ? `Current: ${state.workspaceName}` : "Select a workspace"
        ]),
        el("hr",{class:"sep"}),
        el("div",{class:"stack", style:"gap:10px"}, items),
      ]));
    });
  }
}

/** Conflict: any ACTIVE reservation for same gear that overlaps, OR OPEN checkout with due_at after start */
async function gearHasConflict(gearItemId, startAtISO, endAtISO){
  const startAt = new Date(startAtISO);
  const endAt = new Date(endAtISO);

  // reservations
  let qResv = supabase
    .from("reservations")
    .select("id,start_at,end_at,status");
  qResv = applyWorkspaceScope(qResv, true).eq("gear_item_id", gearItemId).eq("status", "ACTIVE");
  const {data: resv, error: e1} = await qResv;
  if(e1) throw e1;

  for(const r of (resv||[])){
    if(overlaps(startAt, endAt, new Date(r.start_at), new Date(r.end_at))) return true;
  }

  // open checkouts
  let qOuts = supabase
    .from("checkouts")
    .select("id,due_at,status,items");
  qOuts = applyWorkspaceScope(qOuts, true).eq("status", "OPEN");
  const {data: outs, error: e2} = await qOuts;
  if(e2) throw e2;

  for(const c of (outs||[])){
    if((c.items||[]).includes(gearItemId)){
      if(new Date(c.due_at) > startAt) return true;
    }
  }
  return false;
}

/** Prefetch blocked gear ids for a date window. Optionally ignore one event_id (so editing an event doesn't block itself). */
async function getBlockedIdsForWindow(startAtISO, endAtISO, ignoreEventId=null){
  const startAt = new Date(startAtISO);
  const endAt = new Date(endAtISO);
  const blocked = new Set();

  // ACTIVE reservations overlapping this window
  let qBlockedResv = supabase
    .from("reservations")
    .select("gear_item_id,event_id,start_at,end_at,status");
  qBlockedResv = applyWorkspaceScope(qBlockedResv, true).eq("status","ACTIVE");
  const {data: resvAll, error: rErr} = await qBlockedResv;
  if(rErr) throw rErr;

  for(const r of (resvAll||[])){
    if(ignoreEventId && r.event_id === ignoreEventId) continue;
    if(overlaps(startAt, endAt, new Date(r.start_at), new Date(r.end_at))){
      blocked.add(r.gear_item_id);
    }
  }

  // OPEN checkouts with due_at after window start
  let qBlockedOuts = supabase
    .from("checkouts")
    .select("due_at,status,items");
  qBlockedOuts = applyWorkspaceScope(qBlockedOuts, true).eq("status","OPEN");
  const {data: outsAll, error: oErr} = await qBlockedOuts;
  if(oErr) throw oErr;

  for(const c of (outsAll||[])){
    if(new Date(c.due_at) > startAt){
      for(const id of (c.items||[])) blocked.add(id);
    }
  }
  return blocked;
}


/** ---------- Auth UI ---------- **/
function renderNeedsConfig(view){
  view.appendChild(el("div",{class:"card"},[
    el("h2",{},["Setup required"]),
    el("div",{class:"muted", style:"margin-top:6px"},[
      "You need to connect Javi to your Supabase project."
    ]),
    el("hr",{class:"sep"}),
    el("div",{class:"small"},[
      "1) Open supabase_setup.sql and run it in Supabase SQL Editor.",
      el("br"),
      "2) Open config.js and paste your SUPABASE_URL + SUPABASE_ANON_KEY."
    ])
  ]));
}

async function renderAuth(view){
  const card = el("div",{class:"card", style:"max-width:520px; margin:24px auto"});
  card.appendChild(el("h1",{},[hasInviteInUrl() ? "Join workspace" : "Sign in to Javi"]));
  card.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
    hasInviteInUrl()
      ? "You\'ve been invited. Create an account or sign in to join this workspace."
      : "Create events. Organize, schedule and track production gear."
  ]));
  card.appendChild(el("hr",{class:"sep"}));

  const email = el("input",{class:"input", placeholder:"Email"});
  const pass = el("input",{class:"input", placeholder:"Password", type:"password", style:"margin-top:10px"});
  const msg = el("div",{class:"small muted", style:"margin-top:10px"},[""]);

  const row = el("div",{class:"row", style:"justify-content:flex-end; margin-top:12px"},[
    el("button",{class:"btn secondary", onClick: async ()=>{
      msg.textContent = "Creating account…";
      try{
        const {error} = await supabase.auth.signUp({ email: email.value.trim(), password: pass.value });
        if(error) throw error;
        msg.textContent = hasInviteInUrl()
          ? "Account created. Now sign in to join the workspace."
          : "Account created. Sign in, then set your name in Workspace → Your profile.";
      }catch(e){
        msg.textContent = e.message || String(e);
      }
    }},["Create account"]),
    el("button",{class:"btn", onClick: async ()=>{
      msg.textContent = "Signing in…";
      try{
        const {data, error} = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if(error) throw error;
        state.user = data?.user || state.user;
        msg.textContent = "Signed in.";
        // Continue into the app (and accept invite if present)
        await render();
      }catch(e){
        msg.textContent = e.message || String(e);
      }
    }},["Sign in"]),
  ]);

  card.appendChild(email);
  card.appendChild(pass);
  card.appendChild(row);
  card.appendChild(msg);

  view.appendChild(card);
}

/** ---------- App views ---------- **/
async function renderOnce(){
  const view=$("#view");
  view.innerHTML="";

  const cfg = requireConfig();
  const nav = $("#nav");
  if(!cfg){
    const settingsWrap = $("#settingsWrap");
    if(settingsWrap) settingsWrap.style.display = "none";
    $("#nav").style.visibility="hidden";
    renderNeedsConfig(view);
    return;
  }
  if(!supabase){
    supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  // session check
  const {data:{session}} = await supabase.auth.getSession();
  state.user = session?.user || null;
  state.displayName = pickDisplayName(state.user);
  if(state.displayName) localStorage.setItem("javi_display_name", state.displayName);
  const settingsWrap = $("#settingsWrap");
  if(settingsWrap) settingsWrap.style.display = state.user ? "flex" : "none";
  $("#nav").style.visibility = state.user ? "visible" : "hidden";

  if(!state.user){
    renderAuth(view);
    return;
  }

  // Accept invite links (if the URL contains #invite=...)
  if(await tryAcceptInviteIfPresent()) { await render(); return; }

  // workspace gate (multi-tenant)
  const workspaceReady = await ensureWorkspaceSelected(view);
  // Always sync nav visibility after workspace mode is determined,
  // even when setup is blocked by an error card/create-workspace flow.
  syncWorkspaceNavigation();
  if(!workspaceReady) return;

  syncWorkspaceNavigation();

  const hash=(location.hash||"#dashboard").replace("#","");
  state.route = hash.split("/")[0] || "dashboard";
  if(state.workspaceMode === "legacy" && state.route === "workspace"){
    state.route = "dashboard";
    if(location.hash !== "#dashboard") location.hash = "#dashboard";
  }
  document.querySelectorAll("#nav a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route===state.route);
  });

  if(state.route==="dashboard") return renderDashboard(view);
  if(state.route==="gear") return renderGear(view);
  if(state.route==="events") return renderEvents(view);
  if(state.route==="kits") return renderKits(view);
  if(state.route==="team") return renderTeam(view);
  if(state.route==="workspace") return renderWorkspace(view);

  view.appendChild(el("div",{class:"card"},["Not found."]));
}
async function render() {
  __renderAgain = true;
  if (__renderRunning) return;

  __renderRunning = true;
  try {
    while (__renderAgain) {
      __renderAgain = false;
      await renderOnce();
    }
  } catch (e) {
    console.error(e);
    try { toast(e.message || String(e)); } catch (_) {}
  } finally {
    __renderRunning = false;
  }
}

async function renderDashboard(view){
  const [events, reservations, gear] = await Promise.all([
    sbGetAll("events"),
    sbGetAll("reservations"),
    sbGetAll("gear_items")
  ]);
  const now=new Date();
  const gearById = Object.fromEntries((gear||[]).map(g=>[g.id,g]));

  const upcomingAll = events
    .filter(e=>new Date(e.end_at)>=now && e.status!=="CANCELED")
    .sort((a,b)=>new Date(a.start_at)-new Date(b.start_at));

  // "Checked out now" is derived from ONGOING events (start_at <= now <= end_at)
  const ongoingEvents = events
    .filter(e=>new Date(e.start_at)<=now && new Date(e.end_at)>=now && e.status!=="CANCELED")
    .sort((a,b)=>new Date(a.end_at)-new Date(b.end_at))
    .slice(0,10);

  const activeResvByEvent = new Map();
  let totalActiveOut = 0;
  for(const e of ongoingEvents){
    const rs = (reservations||[]).filter(r=>r.event_id===e.id && String(r.status||"").toUpperCase()==="ACTIVE");
    if(rs.length){
      activeResvByEvent.set(e.id, rs);
      totalActiveOut += rs.length;
    }
  }

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Dashboard"]),
      el("div",{class:"muted small"},[`Signed in as ${state.user.email}`])
    ]),
    el("div",{class:"row"},[
      el("button",{class:"btn secondary", onClick:()=>{location.hash="#events";}},["New event"]),
      el("button",{class:"btn secondary", onClick:()=>{location.hash="#gear";}},["Add gear"])
    ])
  ]));

  const grid=el("div",{class:"grid two"});

  const c1=el("div",{class:"card"});
  c1.appendChild(el("div",{class:"row", style:"justify-content:space-between"},[
    el("h2",{},["Upcoming events"]),
    el("span",{class:"badge"},[String(upcomingAll.length)])
  ]));
  c1.appendChild(el("hr",{class:"sep"}));
  if(!upcomingAll.length){
    c1.appendChild(ghostCreateCard({
      title:"Create event",
      subtitle:"Your upcoming events will show here.",
      ctaLabel:"New event",
      onClick:()=>{ state.eventsTab="upcoming"; localStorage.setItem("javi_events_tab", state.eventsTab); location.hash="#events"; }
    }));
  } else {
    const PAGE=3;
    const pages=[];
    for(let i=0;i<upcomingAll.length;i+=PAGE) pages.push(upcomingAll.slice(i,i+PAGE));

    const row=el("div",{class:"dashSnapRow"});
    const dots=el("div",{class:"dashSnapDots"});
    const dotBtns=[];
    const pageEls=[];

    function setActive(i){
      for(let k=0;k<dotBtns.length;k++){
        dotBtns[k].classList.toggle("active", k===i);
        dotBtns[k].setAttribute("aria-current", k===i ? "true" : "false");
      }
    }

    pages.forEach((pg,pi)=>{
      const page=el("div",{class:"dashSnapPage"});
      for(const e of pg){
        page.appendChild(el("a",{href:`#events/${e.id}`, class:"listItem"},[
          el("div",{class:"stack"},[
            el("div",{style:"font-weight:700"},[e.title]),
            // Date/time (bigger + easier at a glance)
(()=>{
  const s = new Date(e.start_at);
  const en = new Date(e.end_at);
  const sameDay = s.toDateString() === en.toDateString();
  const fmtDay = (d)=>d.toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric", year:"numeric"});
  const fmtTime = (d)=>d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
  const dayLine = sameDay ? fmtDay(s) : `${fmtDay(s)} → ${fmtDay(en)}`;
  const timeLine = `${fmtTime(s)} → ${fmtTime(en)}`;
  return el("div",{style:"display:flex;flex-direction:column;gap:2px"},[
    el("div",{style:"font-weight:700; font-size:14px; line-height:1.2"},[dayLine]),
    el("div",{class:"kv", style:"font-size:13px"},[timeLine]),
  ]);
})(),

            el("div",{class:"kv"},[e.location || "No location"])
          ]),
          el("span",{class:"badge"},[e.status||"DRAFT"])
        ]));
      }
      row.appendChild(page);
      pageEls.push(page);

      const dot=el("button",{
        class:`dashSnapDot ${pi===0?"active":""}`,
        type:"button",
        title:`Page ${pi+1} of ${pages.length}`,
        onClick:()=>page.scrollIntoView({behavior:"smooth", inline:"start", block:"nearest"})
      },[""]);
      dots.appendChild(dot);
      dotBtns.push(dot);
    });

    let raf=0;
    row.addEventListener("scroll", ()=>{
      if(raf) cancelAnimationFrame(raf);
      raf=requestAnimationFrame(()=>{
        const w = row.clientWidth || 1;
        const i = Math.max(0, Math.min(pageEls.length-1, Math.round(row.scrollLeft / w)));
        setActive(i);
      });
    }, {passive:true});

    c1.appendChild(row);
    if(pages.length>1) c1.appendChild(dots);
  }

  const c2=el("div",{class:"card"});
  c2.appendChild(el("div",{class:"row", style:"justify-content:space-between"},[
    el("h2",{},["Checked out now"]),
    el("span",{class:"badge"},[String(totalActiveOut)])
  ]));
  c2.appendChild(el("hr",{class:"sep"}));

  if(totalActiveOut===0){
    c2.appendChild(el("div",{class:"muted"},["Nothing checked out (no ongoing events with active gear)."]));
  } else {
    // Build list of ongoing events that actually have ACTIVE gear
    const cards=[];
    for(const e of ongoingEvents){
      const rs = activeResvByEvent.get(e.id) || [];
      if(!rs.length) continue;

      const names = rs
        .map(r=>gearById[r.gear_item_id])
        .filter(Boolean)
        .map(g=>`${g.category}: ${g.name}`);

      const preview = names.slice(0,3).join(" • ");
      const more = names.length>3 ? ` • +${names.length-3} more` : "";
      cards.push({e, rs, preview: preview ? (preview + more) : `${rs.length} item(s)`});
    }

    const PAGE=3;
    const pages=[];
    for(let i=0;i<cards.length;i+=PAGE) pages.push(cards.slice(i,i+PAGE));

    const row=el("div",{class:"dashSnapRow"});
    const dots=el("div",{class:"dashSnapDots"});
    const dotBtns=[];
    const pageEls=[];

    function setActive(i){
      for(let k=0;k<dotBtns.length;k++){
        dotBtns[k].classList.toggle("active", k===i);
        dotBtns[k].setAttribute("aria-current", k===i ? "true" : "false");
      }
    }

    pages.forEach((pg,pi)=>{
      const page=el("div",{class:"dashSnapPage"});
      for(const c of pg){
        const e=c.e, rs=c.rs;
        page.appendChild(el("a",{href:`#events/${e.id}`, class:"listItem"},[
          el("div",{class:"stack"},[
            el("div",{style:"font-weight:700"},[e.title]),
            el("div",{class:"kv"},[`Ongoing • ends ${fmt(e.end_at)}`]),
            el("div",{class:"kv"},[c.preview])
          ]),
          el("span",{class:"badge"},[`${rs.length} out`])
        ]));
      }
      row.appendChild(page);
      pageEls.push(page);

      const dot=el("button",{
        class:`dashSnapDot ${pi===0?"active":""}`,
        type:"button",
        title:`Page ${pi+1} of ${pages.length}`,
        onClick:()=>page.scrollIntoView({behavior:"smooth", inline:"start", block:"nearest"})
      },[""]);
      dots.appendChild(dot);
      dotBtns.push(dot);
    });

    let raf=0;
    row.addEventListener("scroll", ()=>{
      if(raf) cancelAnimationFrame(raf);
      raf=requestAnimationFrame(()=>{
        const w = row.clientWidth || 1;
        const i = Math.max(0, Math.min(pageEls.length-1, Math.round(row.scrollLeft / w)));
        setActive(i);
      });
    }, {passive:true});

    c2.appendChild(row);
    if(pages.length>1) c2.appendChild(dots);
  }

  grid.appendChild(c1);
  grid.appendChild(c2);
  view.appendChild(grid);
  // Calendar (below Upcoming + Checked out)
  view.appendChild(renderDashboardCalendarCard(events));
}

function modal(content){
  // Ensure only one overlay exists (prevents "frozen" UI if something leaves a modal behind)
  document.querySelectorAll('[data-javi-overlay="1"]').forEach(n=>n.remove());

  const overlay = el("div", {
    "data-javi-overlay":"1",
    style:[
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,.45)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:16px",
      "z-index:9999"
    ].join(";")
  });

  const box = el("div",{
    class:"card",
    style:"width:min(720px, 96vw); max-height:90vh; overflow:auto; position:relative"
  });

  const close = ()=>{
    try{ window.removeEventListener("keydown", onKey); }catch(_){}
    overlay.remove();
  };

  const onKey = (e)=>{
    if(e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);

  // Click outside to close
  overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(); });

  // Close button
  const xBtn = el("button",{
    class:"btn ghost",
    style:"position:sticky; top:0; float:right; margin:8px; z-index:1",
    onClick:(e)=>{ e.preventDefault(); e.stopPropagation(); close(); }
  },["✕"]);

  box.appendChild(xBtn);
  box.appendChild(content);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { close };
}

function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
    r.readAsDataURL(file);
  });
}

async function renderGear(view){
  const gearRaw = (await sbGetAll("gear_items"));
  const groupsAll = buildGearGroups(gearRaw);

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Gear"]),
      el("div",{class:"muted small"},["Shared online database."])
    ]),
    el("button",{class:"btn secondary", onClick:()=>openGearModal()},["Add gear"])
  ]));


  if(!groupsAll.length){
    view.appendChild(ghostCreateCard({
      title:"Create gear",
      subtitle:"Add cameras, lenses, audio, lights, and more.",
      ctaLabel:"Add gear",
      onClick:()=>openGearModal()
    }));
    return;
  }


  const filterCard=el("div",{class:"card", style:"margin-bottom:12px"});
  const q=el("input",{class:"input", placeholder:"Search gear…"});
  const cat=el("select",{class:"select"});
  cat.appendChild(el("option",{value:""},["All categories"]));
  for(const c of CATEGORIES) cat.appendChild(el("option",{value:c},[c]));
  filterCard.appendChild(el("div",{class:"grid", style:"grid-template-columns: 1fr 220px; gap:10px"},[q, cat]));
  view.appendChild(filterCard);

  const list=el("div",{class:"gearGrid"});
  view.appendChild(list);

  function refresh(){
    const qq=q.value.trim().toLowerCase();
    const cc=cat.value;
    list.innerHTML="";
    const items = groupsAll.filter(gr => {
      const g = gr.primary;
      const hay = (gr.name + " " + (g.description||"") + " " + (g.asset_tag||"") + " " + (g.serial||"") + " " + (g.qr_code||"")).toLowerCase();
      return (!cc || gr.category===cc) && (!qq || hay.includes(qq));
    });
    if(!items.length){
      list.appendChild(el("div",{class:"card"},["No gear found."]));
      return;
    }
    for(const gr of items){
      const it = gr.primary;
      const badgeText = gr.qty > 1 ? `${gr.category} • x${gr.qty}` : it.category;
      const thumb = it.image_url
        ? el("img",{src:it.image_url, class:"gearTileImg"})
        : el("div",{class:"gearTileImgPlaceholder"},[]);

      // Square/tile card (click to edit)
      const tile = el("button",{class:"gearTile", onClick:()=>openGearModal(gr)},[
        el("div",{class:"gearTileMedia"},[thumb]),
        el("div",{class:"gearTileBody"},[
          el("div",{class:"gearTileTitle"},[gr.qty>1 ? `${gr.name}` : gr.name]),
          el("div",{class:"gearTileBadge"},[badgeText]),
          el("div",{class:"gearTileMeta"},[
            (it.location ? it.location : "—"),
            (it.asset_tag ? ` • ${it.asset_tag}` : "")
          ].join(""))
        ])
      ]);

      list.appendChild(tile);
    }
  }

  q.addEventListener("input", refresh);
  cat.addEventListener("change", refresh);
  refresh();
}

async function openGearModal(existingGroup=null){
  const isEdit=!!existingGroup;
  const existing = existingGroup?.primary || null;
  const existingQty = existingGroup?.qty || 1;

  const name=el("input",{class:"input", placeholder:"Name (e.g., Sony FX3)", value: existing?.name || ""});
  const qty=el("input",{class:"input", type:"number", min:"1", step:"1"});
  qty.value = String(existingQty || 1);
  const category=el("select",{class:"select"});
  for(const c of CATEGORIES) category.appendChild(el("option",{value:c},[c]));
  category.value = existing?.category || CATEGORIES[0];

  const desc=el("textarea",{class:"textarea", placeholder:"Description / notes (optional)"});
  desc.value = existing?.description || "";

  const assetTag=el("input",{class:"input", placeholder:"Asset tag (optional)", value: existing?.asset_tag || ""});
  const serial=el("input",{class:"input", placeholder:"Serial # (optional)", value: existing?.serial || ""});
  const qrCode=el("input",{class:"input", placeholder:"QR code value (optional)", value: existing?.qr_code || ""});
  const location=el("input",{class:"input", placeholder:"Location (optional)", value: existing?.location || ""});

  const imgUrl=el("input",{class:"input", placeholder:"Image URL (optional)", value: existing?.image_url || ""});
  const filePick=el("input",{type:"file", accept:"image/*", class:"input"});
  const preview=el("div",{class:"small muted"},[existing?.image_url ? "Image set." : "No image."]);

  filePick.addEventListener("change", async ()=>{
    const f=filePick.files?.[0];
    if(!f) return;
    const dataUrl = await fileToDataURL(f);
    imgUrl.value = dataUrl;
    preview.textContent="Image selected (stored as data URL).";
  });

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[isEdit?"Edit gear":"Add gear"]),
      el("span",{class:"badge"},[isEdit?"Update":"Create"])
    ]),
    el("hr",{class:"sep"}),
    el("div",{class:"grid", style:"grid-template-columns: 1fr 240px; gap:10px"},[
      el("div",{class:"stack"},[
        el("label",{class:"small muted"},["Name"]), name,
        el("label",{class:"small muted"},["Quantity"]), qty,
        el("label",{class:"small muted"},["Category"]), category,
        el("label",{class:"small muted"},["Description"]), desc,
        el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px"},[
          el("div",{},[el("label",{class:"small muted"},["Asset tag"]), assetTag]),
          el("div",{},[el("label",{class:"small muted"},["Serial #"]), serial]),
        ]),
        el("label",{class:"small muted"},["QR code value"]), qrCode,
        el("label",{class:"small muted"},["Location"]), location,
      ]),
      el("div",{class:"stack"},[
        el("label",{class:"small muted"},["Image URL or pick a file"]), imgUrl,
        filePick,
        preview
      ])
    ]),
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      (isEdit ? el("button",{class:"btn danger", style:"margin-right:auto", onClick: async (e)=>{
        e.preventDefault();
        try{
          const base = baseName(existing.name);
          const key = (existing.category||"") + "||" + base;
          const all = await sbGetAll("gear_items");
          const groupItems = all.filter(g => gearGroupKey(g) === key);

          const msg = groupItems.length > 1 ? `Delete "${base}" and its ${groupItems.length} copies?` : `Delete "${base}"?`;
          if(!confirm(msg)) return;

          // Prevent deleting gear that is currently reserved/checked out
          const ids = groupItems.map(x=>x.id);
          const { data: resv, error: resvErr } = await supabase
            .from("reservations")
            .select("id, status")
            .in("gear_item_id", ids);
          if(resvErr) throw resvErr;

          const active = (resv||[]).filter(r=>{
            const st = (r.status||"").toUpperCase();
            return !["CANCELED","CANCELLED","RETURNED","CLOSED"].includes(st);
          });
          if(active.length){
            alert(`Can't delete "${base}" because ${active.length} reservation(s) still reference it. Remove it from events first.`);
            return;
          }

          // delete all items in group
          for(const gi of groupItems){
            await sbDelete("gear_items", gi.id);
          }

          // remove from kits (array) best-effort
          const kits = await sbGetAll("kits");
          for(const k of kits){
            const next = (k.item_ids||[]).filter(x=>!ids.includes(x));
            if(next.length !== (k.item_ids||[]).length){
              await sbUpdate("kits", k.id, { item_ids: next, updated_at: new Date().toISOString() });
            }
          }

          toast("Deleted gear.");
          m.close();
          render();
        }catch(err){
          console.error(err);
          toast(err.message || "Delete failed.");
        }
      }},["Delete"]) : null),
      el("button",{class:"btn secondary", onClick:(e)=>{e.preventDefault(); m.close();}},["Cancel"]),
      el("button",{class:"btn", onClick: async (e)=>{
        e.preventDefault();
        if(!name.value.trim()){ toast("Name is required."); return; }
        const now = new Date().toISOString();
        const row = {
          name: name.value.trim(),
          category: category.value,
          description: desc.value.trim() || "",
          asset_tag: assetTag.value.trim() || "",
          serial: serial.value.trim() || "",
          qr_code: qrCode.value.trim() || "",
          location: location.value.trim() || "",
          image_url: imgUrl.value.trim() || "",
          updated_at: now
        };
        try{
          const desiredQty = Math.max(1, parseInt(qty.value||"1",10) || 1);

          if(isEdit){
            // Update the primary item first
            await sbUpdate("gear_items", existing.id, row);

            // Adjust copies to match desired quantity (UI groups by baseName + category)
            const all = await sbGetAll("gear_items");
            const oldBase = baseName(existing.name);
            const oldKey = (existing.category||row.category) + "||" + oldBase;
            const groupItems = all.filter(g => gearGroupKey(g) === oldKey).sort((a,b)=>copyNumber(a.name)-copyNumber(b.name));

            // Rename primary to new base name (no suffix)
            const newBase = baseName(row.name);
            await sbUpdate("gear_items", existing.id, { name: newBase, updated_at: now });

            // Rename existing copies to match new base name
            for(const gi of groupItems){
              if(gi.id === existing.id) continue;
              const n = copyNumber(gi.name);
              await sbUpdate("gear_items", gi.id, { name: `${newBase} #${n}`, category: row.category, description: row.description, location: row.location, image_url: row.image_url, updated_at: now });
            }

            // Ensure we have correct count after rename
            const refreshed = (await sbGetAll("gear_items")).filter(g => gearGroupKey(g) === (row.category+"||"+newBase)).sort((a,b)=>copyNumber(a.name)-copyNumber(b.name));
            let currentQty = refreshed.length;

            if(desiredQty > currentQty){
              // create missing copies
              for(let n=currentQty+1; n<=desiredQty; n++){
                const copyRow = {
                  ...row,
                  name: `${newBase} #${n}`,
                  asset_tag: "", // avoid duplicating tags/serials across copies
                  serial: "",
                  qr_code: "",
                  created_at: now,
                  updated_at: now
                };
                await sbInsert("gear_items", copyRow);
              }
            } else if(desiredQty < currentQty){
              // delete extras from highest down, only if not in use
              for(let i=refreshed.length-1; i>=0 && currentQty>desiredQty; i--){
                const gi = refreshed[i];
                if(gi.id === existing.id) continue; // never delete the primary from edit
                const inUse = await gearItemInUse(gi.id);
                if(inUse) continue;
                await sbDelete("gear_items", gi.id);
                currentQty--;
              }
              if(currentQty > desiredQty){
                toast("Could not reduce quantity fully (some copies are reserved/checked out).");
              }
            }

            toast("Updated gear.");

          } else {
            // Create primary (base) + copies (#2..#N)
            row.name = baseName(row.name);
            row.created_at = now;
            const inserted = await sbInsert("gear_items", row);

            for(let n=2; n<=desiredQty; n++){
              const copyRow = {
                ...row,
                name: `${row.name} #${n}`,
                asset_tag: "",
                serial: "",
                qr_code: "",
                created_at: now,
                updated_at: now
              };
              await sbInsert("gear_items", copyRow);
            }

            toast("Added gear.");
          }

          m.close();
          render();
        }catch(err){
          toast(err.message || String(err));
        }
      }},[isEdit?"Save":"Create"])
    ])
  ]));
}

async function renderEvents(view){
  const parts=(location.hash||"").replace("#","").split("/");
  const eventId = parts[1] || null;

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Events"]),
      el("div",{class:"muted small"},["Multi-day shoots. Reserve gear. Check out."])
    ]),
    el("button",{class:"btn secondary", onClick:()=>openEventModal()},["New event"])
  ]));

  if(eventId){
    const evt = await sbGetById("events", eventId);
    if(!evt){
      view.appendChild(el("div",{class:"card"},["Event not found."]));
      return;
    }
    return renderEventDetail(view, evt);
  }

  // ---- Tabs: Upcoming vs Past/Ended ----
  const allEvents = await sbGetAll("events");
  const teamMembers = await sbGetAll("team_members", "name");
  const teamById = Object.fromEntries(teamMembers.map(t=>[t.id,t]));
  const now = new Date();

  const upcomingEvents = allEvents
    .filter(e => new Date(e.end_at) >= now && String(e.status||"").toUpperCase() !== "CLOSED")
    .sort((a,b)=> new Date(a.start_at) - new Date(b.start_at));

  const pastEvents = allEvents
    .filter(e => new Date(e.end_at) < now || String(e.status||"").toUpperCase() === "CLOSED")
    .sort((a,b)=> new Date(b.start_at) - new Date(a.start_at));

  // Ensure state.eventsTab is valid
  if(state.eventsTab !== "upcoming" && state.eventsTab !== "past"){
    state.eventsTab = "upcoming";
    localStorage.setItem("javi_events_tab", state.eventsTab);
  }

  const tabBtn = (key, label, count)=>{
    const active = state.eventsTab === key;
    return el("button",{
      class: active ? "btn" : "btn secondary",
      type:"button",
      onClick:()=>{
        state.eventsTab = key;
        localStorage.setItem("javi_events_tab", state.eventsTab);
        render();
      }
    },[`${label} (${count})`]);
  };

  view.appendChild(el("div",{class:"row", style:"gap:8px; margin-bottom:12px; flex-wrap:wrap"},[
    tabBtn("upcoming","Upcoming", upcomingEvents.length),
    tabBtn("past","Past / Ended", pastEvents.length),
  ]));

  const list=el("div",{class:"grid"});
  view.appendChild(list);

  const eventsToShow = state.eventsTab === "past" ? pastEvents : upcomingEvents;

  if(!eventsToShow.length){
    if(!allEvents.length && state.eventsTab !== "past"){
      list.appendChild(ghostCreateCard({
        title:"Create event",
        subtitle:"Add your first shoot, production day, or rental.",
        ctaLabel:"New event",
        onClick:()=>{ state.eventsTab="upcoming"; localStorage.setItem("javi_events_tab", state.eventsTab); openEventModal(); }
      }));
      return;
    }
    list.appendChild(el("div",{class:"card"},[
      state.eventsTab === "past" ? "No past events." : "No upcoming events."
    ]));
    return;
  }

  for(const e of eventsToShow){
    const assignees = parseJsonArray(e.assigned_people)
      .map(a=>teamById[a.person_id])
      .filter(Boolean);

    const assigneeStrip = el("div",{class:"eventAssigneeStrip"},[]);
    if(assignees.length){
      for(const tm of assignees.slice(0,4)){
        const chip = el("div",{class:"eventAssigneeChip", title:tm.name || "Assigned"},[]);
        if(tm.headshot_url){
          chip.appendChild(el("img",{src:tm.headshot_url, alt:tm.name || "Headshot", style:"width:100%; height:100%; object-fit:cover"}));
        } else {
          chip.appendChild(el("div",{class:"muted eventAssigneeInitial"},[(tm.name||"?").slice(0,1).toUpperCase()]));
        }
        assigneeStrip.appendChild(chip);
      }
      if(assignees.length > 4){
        assigneeStrip.appendChild(el("span",{class:"small muted"},[`+${assignees.length-4}`]));
      }
    } else {
      assigneeStrip.appendChild(el("span",{class:"small muted"},["No people assigned"]));
    }

    list.appendChild(el("a",{href:`#events/${e.id}`, class:"listItem"},[
      el("div",{class:"stack"},[
        el("div",{style:"font-weight:700"},[e.title]),
        // Date/time (bigger + easier at a glance)
(()=>{
  const s = new Date(e.start_at);
  const en = new Date(e.end_at);
  const sameDay = s.toDateString() === en.toDateString();
  const fmtDay = (d)=>d.toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric", year:"numeric"});
  const fmtTime = (d)=>d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
  const dayLine = sameDay ? fmtDay(s) : `${fmtDay(s)} → ${fmtDay(en)}`;
  const timeLine = `${fmtTime(s)} → ${fmtTime(en)}`;
  return el("div",{style:"display:flex;flex-direction:column;gap:2px"},[
    el("div",{style:"font-weight:700; font-size:14px; line-height:1.2"},[dayLine]),
    el("div",{class:"kv", style:"font-size:13px"},[timeLine]),
  ]);
})(),

        el("div",{class:"kv"},[e.location || "No location"]),
        assigneeStrip
      ]),
      el("span",{class:"badge"},[e.status||"DRAFT"])
    ]));
  }
}

async function openEventModal(existing=null){
  const isEdit=!!existing;
  const now=new Date();
  const t=el("input",{class:"input", placeholder:"Title", value: existing?.title || ""});
  const start=el("input",{class:"input", type:"datetime-local", value: existing ? toInputDateTimeLocal(new Date(existing.start_at)) : toInputDateTimeLocal(now)});
  const end=el("input",{class:"input", type:"datetime-local", value: existing ? toInputDateTimeLocal(new Date(existing.end_at)) : toInputDateTimeLocal(new Date(now.getTime()+4*3600*1000))});
  const loc=el("input",{class:"input", placeholder:"Location (optional)", value: existing?.location || ""});
  const locWrap=el("div",{},[loc]);
  // Free address suggestions (OpenStreetMap)
  try{ setTimeout(()=>attachLocationAutocomplete(loc), 0); }catch(_e){}
  const notes=el("textarea",{class:"textarea", placeholder:"Notes (optional)"});
  notes.value = existing?.notes || "";
  const docs=el("textarea",{class:"textarea", placeholder:"Production docs (one per line: Label | URL)"});
  const existingDocs = parseJsonArray(existing?.production_docs);
  docs.value = existingDocs.map(d=>`${d.label||"Document"} | ${d.url||""}`).join("\n");

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[isEdit?"Edit event":"New event"]),
      el("span",{class:"badge"},[isEdit?"Update":"Create"])
    ]),
    el("hr",{class:"sep"}),
    el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px"},[
      el("div",{},[el("label",{class:"small muted"},["Title"]), t]),
      el("div",{},[el("label",{class:"small muted"},["Location"]), locWrap]),
      el("div",{},[el("label",{class:"small muted"},["Start"]), start]),
      el("div",{},[el("label",{class:"small muted"},["End"]), end]),
    ]),
    el("div",{style:"margin-top:10px"},[el("label",{class:"small muted"},["Notes"]), notes]),
    el("div",{style:"margin-top:10px"},[
      el("label",{class:"small muted"},["Production docs"]),
      docs,
      el("div",{class:"small muted", style:"margin-top:6px"},["Use format: Label | https://... (opens in new tab)"])
    ]),
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      (isEdit ? el("button",{class:"btn danger", style:"margin-right:auto", onClick: async (e)=>{
        e.preventDefault();
        try{
          const base = baseName(existing.name);
          const key = (existing.category||"") + "||" + base;
          const all = await sbGetAll("gear_items");
          const groupItems = all.filter(g => gearGroupKey(g) === key);

          const msg = groupItems.length > 1 ? `Delete "${base}" and its ${groupItems.length} copies?` : `Delete "${base}"?`;
          if(!confirm(msg)) return;

          // Prevent deleting gear that is currently reserved/checked out
          const ids = groupItems.map(x=>x.id);
          const { data: resv, error: resvErr } = await supabase
            .from("reservations")
            .select("id, status")
            .in("gear_item_id", ids);
          if(resvErr) throw resvErr;

          const active = (resv||[]).filter(r=>{
            const st = (r.status||"").toUpperCase();
            return !["CANCELED","CANCELLED","RETURNED","CLOSED"].includes(st);
          });
          if(active.length){
            alert(`Can't delete "${base}" because ${active.length} reservation(s) still reference it. Remove it from events first.`);
            return;
          }

          // delete all items in group
          for(const gi of groupItems){
            await sbDelete("gear_items", gi.id);
          }

          // remove from kits (array) best-effort
          const kits = await sbGetAll("kits");
          for(const k of kits){
            const next = (k.item_ids||[]).filter(x=>!ids.includes(x));
            if(next.length !== (k.item_ids||[]).length){
              await sbUpdate("kits", k.id, { item_ids: next, updated_at: new Date().toISOString() });
            }
          }

          toast("Deleted gear.");
          m.close();
          render();
        }catch(err){
          console.error(err);
          toast(err.message || "Delete failed.");
        }
      }},["Delete"]) : null),
      el("button",{class:"btn secondary", onClick:(e)=>{e.preventDefault(); m.close();}},["Cancel"]),
      el("button",{class:"btn", onClick: async (e)=>{
        e.preventDefault();
        if(!t.value.trim()){ toast("Title is required."); return; }
        const s=new Date(start.value), en=new Date(end.value);
        if(!(s<en)){ toast("End must be after start."); return; }
        const nowIso=new Date().toISOString();
        const productionDocs = (docs.value || "")
          .split(/\n+/)
          .map(line=>line.trim())
          .filter(Boolean)
          .map(line=>{
            const parts = line.split("|");
            if(parts.length === 1){
              const urlOnly = String(parts[0]||"").trim();
              if(!urlOnly) return null;
              return { label: "Document", url: urlOnly };
            }
            const label = String(parts[0]||"").trim() || "Document";
            const url = String(parts.slice(1).join("|")||"").trim();
            return url ? { label, url } : null;
          })
          .filter(Boolean);
        const row={
          title: t.value.trim(),
          start_at: s.toISOString(),
          end_at: en.toISOString(),
          location: loc.value.trim(),
          notes: notes.value.trim(),
          production_docs: productionDocs,
          updated_at: nowIso
        };
        try{
          let obj;
          if(isEdit){
            // Prevent date change if it would double-book any gear already reserved on this event
            const {data: myResv, error: myErr} = await supabase
              .from("reservations")
              .select("id,gear_item_id")
              .eq("event_id", existing.id)
              .eq("status","ACTIVE");
            if(myErr) throw myErr;

            const myIds = (myResv||[]).map(r=>r.gear_item_id);
            if(myIds.length){
              const blocked = await getBlockedIdsForWindow(row.start_at, row.end_at, existing.id);
              const conflicts = myIds.filter(id=>blocked.has(id));
              if(conflicts.length){
                toast(`Can't change dates: ${conflicts.length} reserved item(s) would be double-booked. Remove the conflicting gear first.`);
                return;
              }
            }

            try{
              obj = await sbUpdate("events", existing.id, row);
            }catch(e){
              if(isMissingLocationLatLngColumnsErr(e)){
                const rowNoLL = { ...row };
                delete rowNoLL.location_lat;
                delete rowNoLL.location_lng;
                obj = await sbUpdate("events", existing.id, rowNoLL);
              }else if(isMissingProductionDocsColumnErr(e)){
                const rowNoDocs = { ...row };
                delete rowNoDocs.production_docs;
                obj = await sbUpdate("events", existing.id, rowNoDocs);
              }else if(isProductionDocsTypeErr(e)){
                obj = await sbUpdate("events", existing.id, { ...row, production_docs: JSON.stringify(productionDocs || []) });
              }else{
                throw e;
              }
            }

            // Keep this event's ACTIVE reservations aligned to the new event window
            const {error: upErr} = await supabase
              .from("reservations")
              .update({ start_at: row.start_at, end_at: row.end_at })
              .eq("event_id", existing.id)
              .eq("status","ACTIVE");
            if(upErr) throw upErr;            toast("Updated event.");
          } else {
            row.created_at = nowIso;
            row.status = "DRAFT";
            row.created_by = _currentUser()?.id || null;
            row.created_by_email = _currentUser()?.email || null;
            try{
              obj = await sbInsertAudit("events", row);
            }catch(e){
              if(isMissingLocationLatLngColumnsErr(e)){
                const rowNoLL = { ...row };
                delete rowNoLL.location_lat;
                delete rowNoLL.location_lng;
                obj = await sbInsertAudit("events", rowNoLL);
              }else if(isMissingProductionDocsColumnErr(e)){
                const rowNoDocs = { ...row };
                delete rowNoDocs.production_docs;
                obj = await sbInsertAudit("events", rowNoDocs);
              }else if(isProductionDocsTypeErr(e)){
                obj = await sbInsertAudit("events", { ...row, production_docs: JSON.stringify(productionDocs || []) });
              }else{
                throw e;
              }
            }            toast("Created event.");
          }
          m.close();
          location.hash = `#events/${obj.id}`;
          render();
        }catch(err){
          toast(err.message || String(err));
        }
      }},[isEdit?"Save":"Create"])
    ])
  ]));
}

async function renderEventDetail(view, evt){
  const gear = await sbGetAll("gear_items");
  const kits = await sbGetAll("kits");
  const teamMembers = await sbGetAll("team_members", "name");
  const gearById = Object.fromEntries(gear.map(g=>[g.id,g]));
  const teamById = Object.fromEntries(teamMembers.map(t=>[t.id,t]));
  const eventAssignments = parseJsonArray(evt.assigned_people);
  const productionDocs = parseJsonArray(evt.production_docs);
  const allReservations = (await sbGetAll("reservations")).filter(r=>r.event_id===evt.id);
  const reservations = allReservations.filter(r=>String(r.status||"").toUpperCase()==="ACTIVE");
  const returnedReservations = allReservations.filter(r=>String(r.status||"").toUpperCase()==="RETURNED");
  const existingReservedIds = new Set(reservations.map(r=>r.gear_item_id));

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},[evt.title]),
      renderEventDateHero(evt),
      (evt.created_by_email ? el("div",{class:"small muted"},[`Created by ${evt.created_by_email}`]) : null),
      (evt.closed_by_email ? el("div",{class:"small muted"},[`Closed by ${evt.closed_by_email}`]) : null),
    ]),
    el("div",{class:"row"},[
      el("a",{href:"#events", class:"btn secondary"},["Back"]),
      el("button",{class:"btn secondary", onClick:()=>openEventModal(evt)},["Edit"]),
      el("button",{class:"btn danger", onClick:async ()=>{
        if(!confirm("Delete this event?")) return;
        // Delete child rows first to avoid FK constraint failures (reservations reference events)
        try{
          await supabase.from("reservations").delete().eq("event_id", evt.id).eq("workspace_id", state.workspaceId);
        }catch(e){ /* ignore */ }
        await sbDelete("events", evt.id);
        toast("Event deleted.");
        location.hash="#events";
        render();
      }},["Delete"])
    ])
  ]));

  if(evt.notes){
    view.appendChild(el("div",{class:"card", style:"margin-bottom:12px"},[
      el("h2",{},["Notes"]),
      el("div",{class:"small", style:"margin-top:8px; white-space:pre-wrap"},[evt.notes])
    ]));
  }


  // Production docs (external links as buttons)
  if(productionDocs.length){
    view.appendChild(el("div",{class:"card", style:"margin-bottom:12px"},[
      el("h2",{},["Production documents"]),
      el("div",{class:"row", style:"gap:8px; flex-wrap:wrap; margin-top:10px"},
        productionDocs.map(d=>{
          const label = String(d?.label || "Document");
          const url = String(d?.url || "").trim();
          if(!url) return null;
          return el("a",{
            class:"btn secondary",
            href: url,
            target:"_blank",
            rel:"noopener noreferrer"
          },[label]);
        })
      )
    ]));
  }

  const grid=el("div",{class:"grid two"});

  const left=el("div",{class:"card"});
  left.appendChild(el("div",{class:"row", style:"justify-content:space-between"},[
    el("h2",{},["Reserved gear"]),
    el("span",{class:"badge"},[String(reservations.length)])
  ]));
  left.appendChild(el("hr",{class:"sep"}));
  // Reserved gear list with multi-select + bulk remove
  if(!reservations.length){
    left.appendChild(el("div",{class:"muted"},["Nothing reserved yet."]));
  } else {
    const selectedResvIds = new Set();
    const checkboxByResvId = new Map();

    const listBox = el("div",{class:"grid", style:"margin-top:10px"});

    const controls = el("div",{class:"row", style:"justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap"},[
      el("div",{class:"row", style:"gap:8px; flex-wrap:wrap"},[
        el("button",{class:"btn secondary", type:"button", onClick:()=>{
          selectedResvIds.clear();
          checkboxByResvId.forEach((cb, id)=>{
            selectedResvIds.add(id);
            cb.checked = true;
          });
        }},["Select all"]),
        el("button",{class:"btn secondary", type:"button", onClick:()=>{
          selectedResvIds.clear();
          checkboxByResvId.forEach((cb)=>{ cb.checked = false; });
        }},["Clear"])
      ]),
      el("button",{class:"btn danger", type:"button", onClick: async ()=>{
        if(!selectedResvIds.size){ toast("No items selected."); return; }
        if(!confirm(`Remove ${selectedResvIds.size} reservation(s) from this event?`)) return;

        for(const r of reservations){
          if(!selectedResvIds.has(r.id)) continue;
          await sbUpdate("reservations", r.id, { status:"CANCELED" });
        }
        toast("Reservations removed.");
        render();
      }},["Remove selected"])
    ]);
    left.appendChild(controls);

    for(const r of reservations){
      const it=gearById[r.gear_item_id];
      if(!it) continue;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;
      checkboxByResvId.set(r.id, cb);

      cb.addEventListener("change", ()=>{
        if(cb.checked) selectedResvIds.add(r.id); else selectedResvIds.delete(r.id);
      });

      listBox.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"row", style:"gap:10px; align-items:flex-start"},[
          cb,
          el("div",{class:"stack"},[
            el("div",{style:"font-weight:700"},[`${it.category}: ${it.name}`]),
            el("div",{class:"kv"},[`${fmt(r.start_at)} → ${fmt(r.end_at)}`]),
            (r.returned_by_email ? el("div",{class:"small muted"},[`Returned by ${r.returned_by_email}`]) : null),
            (r.reserved_by_email ? el("div",{class:"small muted"},[`Reserved by ${r.reserved_by_email}`]) : null),
          ])
        ]),
        el("button",{class:"btn secondary", onClick: async ()=>{
          await sbUpdate("reservations", r.id, { status:"CANCELED" });
          toast("Reservation removed.");
          render();
        }},["Remove"])
      ]));
    }

    left.appendChild(listBox);
  }


  // Receipt (returned gear) — keep history visible after returning
  if(returnedReservations.length){
    left.appendChild(el("div",{style:"margin-top:14px"},[
      el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
        el("div",{style:"font-weight:700"},["Receipt"]),
        el("span",{class:"badge"},[String(returnedReservations.length)])
      ]),
      el("div",{class:"muted small", style:"margin-top:6px"},["Returned items for this event (read-only)."]),
      el("div",{class:"grid", style:"margin-top:10px"}, returnedReservations.map(r=>{
        const it = gearById[r.gear_item_id];
        if(!it) return el("div",{class:"listItem"},[el("div",{class:"muted"},["(Missing gear item)"])]);
        return el("div",{class:"listItem"},[
          el("div",{class:"stack"},[
            el("div",{style:"font-weight:700"},[`${it.category}: ${it.name}`]),
            el("div",{class:"kv"},[`${fmt(r.start_at)} → ${fmt(r.end_at)}`]),
            (r.returned_by_email ? el("div",{class:"small muted"},[`Returned by ${r.returned_by_email}`]) : null)
          ])
        ]);
      }))
    ]));
  }

  left.appendChild(el("hr",{class:"sep"}));
  left.appendChild(el("div",{class:"small muted"},["Reserve gear for this event window (server-checked)."]));
  const evtGearCat=el("select",{class:"select", style:"margin-top:8px"});
  evtGearCat.appendChild(el("option",{value:""},["All categories"]));
  for(const c of CATEGORIES) evtGearCat.appendChild(el("option",{value:c},[c]));

  const evtGearSearch=el("input",{class:"input", placeholder:"Search…", style:"margin-top:8px"});

  // --- Kits quick-add (adds all gear inside a kit to this event) ---
  const evtKitPick = el("select",{class:"select", style:"width:100%; margin-top:8px"});
  evtKitPick.appendChild(el("option",{value:""},["Add kit…"]));
  for(const k of (kits||[]).sort((a,b)=>(a.name||"").localeCompare(b.name||""))){
    evtKitPick.appendChild(el("option",{value:k.id},[k.name]));
  }

  async function addKitToEvent(kitId){
    const kit = (kits||[]).find(k=>k.id===kitId);
    if(!kit){ toast("Kit not found."); return; }
    const ids = (kit.item_ids||[]).slice();
    if(!ids.length){ toast("Kit is empty."); return; }

    let added=0, conflicted=0, missing=0, already=0;
    for(const gearItemId of ids){
      if(existingReservedIds.has(gearItemId)){ already++; continue; }
      if(!gearById[gearItemId]){ missing++; continue; }

      const conflict = blockedIds.has(gearItemId);
      if(conflict){ conflicted++; continue; }

      const inserted = await tryReserveGearItem(gearItemId);
      if(inserted) added++; else conflicted++;
    }

    if(added){
      await sbUpdate("events", evt.id, { status:"RESERVED", updated_at: new Date().toISOString() });
    }

    // Summary toast
    const parts=[];
    if(added) parts.push(`Added ${added}`);
    if(already) parts.push(`${already} already reserved`);
    if(conflicted) parts.push(`${conflicted} unavailable`);
    if(missing) parts.push(`${missing} missing`);
    toast(parts.length ? parts.join(" • ") : "No items added.");
    render();
  }

  evtKitPick.addEventListener("change", async ()=>{
    const kitId = evtKitPick.value;
    if(!kitId) return;
    await addKitToEvent(kitId);
    evtKitPick.value = "";
  });


  // Group copies like "SD Card #1/#2" into one selectable line item in the event reserve UI
  const evtGearGroups = buildGearGroups(gear);
  const evtGroupByKey = Object.fromEntries(evtGearGroups.map(g=>[g.key,g]));

  // Precompute which specific gear_item_id are blocked for this event's date window
  const blockedIds = new Set();
  try{
    const blocked = await getBlockedIdsForWindow(evt.start_at, evt.end_at, evt.id);
    blocked.forEach(id=>blockedIds.add(id));
  }catch(e){
    console.warn(e);
    // If conflict prefetch fails, fall back to allowing selection (server will still enforce on insert)
  }

  const evtGearPick=el("select",{class:"select", style:"margin-top:8px"});
  const qtyWrap=el("div",{class:"row", style:"justify-content:flex-start; align-items:center; gap:10px; margin-top:10px; display:none"});
  const qtyLabel=el("div",{class:"small muted"},["Quantity"]);
  const qtyPick=el("select",{class:"select", style:"width:140px"});
  qtyWrap.appendChild(qtyLabel);
  qtyWrap.appendChild(qtyPick);

  
  async function refreshPick(){
    const qq=evtGearSearch.value.trim().toLowerCase();
    const cc=evtGearCat.value;
    evtGearPick.innerHTML="";
    evtGearPick.appendChild(el("option",{value:""},["Select gear…"]));

    const filtered = evtGearGroups.filter(grp=>{
      const nm = (grp.name||"").toLowerCase();
      return (!cc || grp.category===cc) && (!qq || nm.includes(qq));
    });

    for(const grp of filtered.slice(0,300)){
      let available = 0;
      for(const it of grp.items){
        if(existingReservedIds.has(it.id)) continue;
        const conflict = blockedIds.has(it.id);
        if(!conflict) available++;
      }
      const suffix = grp.qty>1 ? ` (x${grp.qty})` : "";
      let label = `${grp.category}: ${grp.name}${suffix}`;
      let disabled = false;
      if(available===0){
        label += " ⛔ booked";
        disabled = true;
      } else if(available < grp.qty){
        label += ` ⚠️ ${available}/${grp.qty} available`;
      }
      const optAttrs = { value: grp.key };
      if(disabled) optAttrs.disabled = "disabled";
      evtGearPick.appendChild(el("option", optAttrs, [label]));
    }
  }


  function setQtyOptions(grp){
    qtyPick.innerHTML="";
    qtyPick.appendChild(el("option",{value:""},["Select…"]));
    for(let i=1; i<=grp.qty; i++){
      qtyPick.appendChild(el("option",{value:String(i)},[String(i)]));
    }
  }

  async function tryReserveGearItem(gearItemId){
    // Re-check conflicts at write time to prevent stale UI state from causing double-booking.
    const conflictNow = await gearHasConflict(gearItemId, evt.start_at, evt.end_at);
    if(conflictNow) return false;

    const row={
      event_id: evt.id,
      gear_item_id: gearItemId,
      start_at: evt.start_at,
      end_at: evt.end_at,
      status:"ACTIVE",
      reserved_by: _currentUser()?.id || null,
      reserved_by_email: _currentUser()?.email || null
    };
    await sbInsertAudit("reservations", row);
    existingReservedIds.add(gearItemId);
    blockedIds.add(gearItemId);
    return true;
  }


  async function reserveFromScannedGear(rawValue){
    const found = findGearByScan(gear, rawValue);
    if(!found){
      toast("No matching gear found for that QR code.");
      return;
    }
    if(existingReservedIds.has(found.id)){
      toast("That item is already reserved on this event.");
      return;
    }
    if(blockedIds.has(found.id)){
      toast("That item is booked in this event window.");
      return;
    }

    const inserted = await tryReserveGearItem(found.id);
    if(!inserted){
      toast("That item became unavailable in this event window.");
      blockedIds.add(found.id);
      refreshPick();
      return;
    }
    await sbUpdate("events", evt.id, { status:"RESERVED", updated_at: new Date().toISOString() });
    toast(`Reserved ${found.name}.`);
    render();
  }

  async function reserveFromGroup(grp, qtyWanted){
    const want = Math.max(1, parseInt(qtyWanted,10)||1);

    const chosen = [];
    for(const it of grp.items){
      if(existingReservedIds.has(it.id)) continue;
      const conflict = blockedIds.has(it.id);
      if(conflict) continue;
      chosen.push(it.id);
      if(chosen.length>=want) break;
    }

    if(!chosen.length){
      toast("No available copies in that window.");
      return;
    }

    let insertedCount = 0;
    for(const id of chosen){
      const inserted = await tryReserveGearItem(id);
      if(inserted) insertedCount++;
      else blockedIds.add(id);
    }

    if(insertedCount>0){
      await sbUpdate("events", evt.id, { status:"RESERVED", updated_at: new Date().toISOString() });
    }

    if(insertedCount===want){
      toast(insertedCount===1 ? "Reserved." : `Reserved ${insertedCount}.`);
    } else if(insertedCount>0){
      toast(`Reserved ${insertedCount} (some became unavailable).`);
    } else {
      toast("No selected items were available.");
    }
    render();
  }

  evtGearSearch.addEventListener("input", ()=>refreshPick());
  evtGearCat.addEventListener("change", ()=>refreshPick());
  refreshPick();

  left.appendChild(evtGearCat);
  left.appendChild(evtGearSearch);
  left.appendChild(evtGearPick);
  left.appendChild(el("button",{class:"btn secondary", style:"margin-top:8px", onClick:()=>openQrScannerModal({
    title:"Scan gear to reserve",
    onDetect:(value)=>reserveFromScannedGear(value)
  })},["Scan QR to reserve"]));
  left.appendChild(el("div",{class:"small muted", style:"margin-top:6px"},["⛔ booked = reserved or checked out during this event window"]));
  // Kits quick-add (below Select gear)
  left.appendChild(evtKitPick);
  left.appendChild(qtyWrap);

  // Auto-add gear on selection (no Reserve button)
  evtGearPick.addEventListener("change", async ()=>{
    if(evtGearPick.selectedOptions[0]?.disabled){
      toast("Already booked in another event for this date range.");
      evtGearPick.value="";
      return;
    }
    const key = evtGearPick.value;
    qtyWrap.style.display = "none";
    qtyPick.value = "";

    if(!key) return;
    const grp = evtGroupByKey[key];
    if(!grp) return;

    if(grp.qty<=1){
      await reserveFromGroup(grp, 1);
      evtGearPick.value = "";
      return;
    }

    setQtyOptions(grp);
    qtyWrap.style.display = "flex";
  });

  // For multiples: pick quantity, auto-reserve
  qtyPick.addEventListener("change", async ()=>{
    const key = evtGearPick.value;
    const grp = evtGroupByKey[key];
    if(!grp) return;

    const v = qtyPick.value;
    if(!v) return; // placeholder

    await reserveFromGroup(grp, v);

    // Reset quantity selection (keep the gear selected so user can add more if desired)
    qtyPick.value = "";
  });


  const rightCol = el("div",{class:"stack", style:"gap:12px"});

  const peopleCard = el("div",{class:"card"});
  peopleCard.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
    el("h2",{},["Assigned people"]),
    el("span",{class:"badge"},[String(eventAssignments.length)])
  ]));
  peopleCard.appendChild(el("hr",{class:"sep"}));
  if(!eventAssignments.length){
    peopleCard.appendChild(el("div",{class:"muted"},["No people assigned yet."]));
  } else {
    const list = el("div",{class:"grid"});
    for(const a of eventAssignments){
      const tm = teamById[a.person_id];
      const callHref = tm?.phone ? `tel:${String(tm.phone).replace(/[^\d+]/g, "")}` : "";
      const headshot = el("div",{class:"eventAssignedHeadshot"},[]);
      if(tm?.headshot_url){
        headshot.appendChild(el("img",{src:tm.headshot_url, alt:tm?.name || "Headshot", style:"width:100%; height:100%; object-fit:cover"}));
      } else {
        headshot.appendChild(el("div",{class:"muted eventAssignedInitial"},[(tm?.name || "?").slice(0,1).toUpperCase()]));
      }

      list.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"row", style:"gap:10px; align-items:flex-start; min-width:0"},[
          headshot,
          el("div",{class:"stack", style:"min-width:0"},[
            el("div",{style:"font-weight:700"},[tm?.name || "Unknown person"]),
            el("div",{class:"kv"},[a.event_role || "No event role"]),
            (tm?.title ? el("div",{class:"small muted"},[tm.title]) : null),
            ((tm?.phone || tm?.email) ? el("div",{class:"small muted"},[[tm?.phone, tm?.email].filter(Boolean).join(" • ")]) : null)
          ])
        ]),
        el("div",{class:"row", style:"gap:8px; justify-content:flex-end"},[
          (tm?.phone ? el("a",{class:"btn callBtn", href:callHref},["Call"]) : null),
          el("button",{class:"btn secondary", onClick: async ()=>{
            const next = eventAssignments.filter(x=>x.person_id!==a.person_id);
            await sbUpdate("events", evt.id, { assigned_people: next, updated_at: new Date().toISOString() });
            toast("Removed assignment.");
            render();
          }},["Remove"])
        ])
      ]));
    }
    peopleCard.appendChild(list);
  }

  const assignRow = el("div",{class:"row", style:"gap:8px; margin-top:10px; flex-wrap:wrap"});
  const personPick = el("select",{class:"select", style:"flex:1; min-width:180px"});
  personPick.appendChild(el("option",{value:""},["Assign team member…"]));
  for(const tm of teamMembers){
    personPick.appendChild(el("option",{value:tm.id},[tm.name]));
  }
  const roleInput = el("input",{class:"input", placeholder:"Event role (Crew, Actor, Director…)", style:"flex:1; min-width:220px"});
  assignRow.appendChild(personPick);
  assignRow.appendChild(roleInput);
  assignRow.appendChild(el("button",{class:"btn secondary", onClick: async ()=>{
    const personId = personPick.value;
    if(!personId){ toast("Select a team member."); return; }
    const role = roleInput.value.trim();
    const next = eventAssignments.filter(x=>x.person_id!==personId);
    next.push({ person_id: personId, event_role: role || "Crew" });
    await sbUpdate("events", evt.id, { assigned_people: next, updated_at: new Date().toISOString() });
    toast("Assigned person.");
    render();
  }},["Assign"]));
  peopleCard.appendChild(assignRow);
  peopleCard.appendChild(el("div",{class:"small muted", style:"margin-top:6px"},["Tip: add people in Team first, then assign them per event here."]));
  rightCol.appendChild(peopleCard);

  const docsCard = el("div",{class:"card"});
  docsCard.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
    el("h2",{},["Production docs"]),
    el("span",{class:"badge"},[String(productionDocs.length)])
  ]));
  docsCard.appendChild(el("hr",{class:"sep"}));
  if(!productionDocs.length){
    docsCard.appendChild(el("div",{class:"muted"},["No production documents yet."]));
  } else {
    const list = el("div",{class:"grid"});
    for(const doc of productionDocs){
      list.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"stack"},[
          el("div",{style:"font-weight:700"},[doc.label || "Document"]),
          el("div",{class:"small muted"},[doc.url || ""])
        ]),
        el("a",{class:"btn secondary", href:doc.url, target:"_blank", rel:"noopener noreferrer"},["Open"])
      ]));
    }
    docsCard.appendChild(list);
  }
  rightCol.appendChild(docsCard);

  const right=el("div",{class:"card"});
  right.appendChild(el("h2",{},["Checked out"]));
  right.appendChild(el("div",{class:"small muted", style:"margin-top:6px"},[
    "Automatic: reserved gear is considered checked out only while the event is ongoing."
  ]));
  right.appendChild(el("hr",{class:"sep"}));

  const now = new Date();
  const ongoing = (new Date(evt.start_at) <= now) && (new Date(evt.end_at) >= now) && evt.status!=="CANCELED";

  const canScanReturn = ongoing && reservations.length>0;
  const returnReservationByScan = async (rawValue)=>{
    const found = findGearByScan(gear, rawValue);
    if(!found){ toast("No matching gear found for that QR code."); return; }
    const resv = reservations.find(r=>r.gear_item_id===found.id);
    if(!resv){ toast("That gear is not currently checked out on this event."); return; }
    await sbUpdateAudit("reservations", resv.id, { status:"RETURNED", returned_by: _currentUser()?.id || null, returned_by_email: _currentUser()?.email || null, returned_at: new Date().toISOString() });
    toast(`Returned ${found.name}.`);
    render();
  };

  right.appendChild(el("div",{class:"row", style:"justify-content:flex-end; margin-bottom:8px"},[
    el("button",{
      class:`btn secondary${canScanReturn ? "" : " disabled"}`,
      onClick:()=>{
        if(!canScanReturn){
          toast(ongoing ? "No checked-out items to return yet." : "Return scanning is only available while the event is ongoing.");
          return;
        }
        openQrScannerModal({
          title:"Scan gear to return",
          onDetect:(value)=>returnReservationByScan(value)
        });
      }
    },["Scan QR to return item"])
  ]));

  if(!ongoing){
    right.appendChild(el("div",{class:"muted"},["This event is not currently ongoing."]));
    right.appendChild(el("div",{class:"small muted", style:"margin-top:8px"},[
      "Upcoming reservations remain reserved (and will show as checked out automatically once the event starts)."
    ]));
  } else if(!reservations.length){
    right.appendChild(el("div",{class:"muted"},["No reserved items are currently checked out for this event."]));
  } else {
    right.appendChild(el("div",{class:"listItem"},[
      el("div",{class:"stack"},[
        el("div",{style:"font-weight:700"},[`${reservations.length} item(s) checked out now`]),
        el("div",{class:"kv"},[`Ongoing • ends ${fmt(evt.end_at)}`])
      ]),
      el("button",{class:"btn secondary", onClick: async ()=>{
        if(!confirm(`Return all ${reservations.length} item(s) from this event now?`)) return;

        const nowIso = new Date().toISOString();

        const {error: rErr} = await supabase
          .from("reservations")
          .update({ status:"RETURNED", returned_by: _currentUser()?.id || null, returned_by_email: _currentUser()?.email || null, returned_at: nowIso })
          .eq("event_id", evt.id)
          .eq("status","ACTIVE");
        if(rErr) throw rErr;

        try{
          await supabase
            .from("checkouts")
            .update({ status:"RETURNED", returned_at: nowIso })
            .eq("event_id", evt.id)
            .eq("status","OPEN");
        }catch(_){}

        await sbUpdateAudit("events", evt.id, { status:"CLOSED", end_at: nowIso, updated_at: nowIso, closed_by: _currentUser()?.id || null, closed_by_email: _currentUser()?.email || null });

        toast("Returned. Gear is available again.");
        render();
      }},["Return all"])
    ]));
  }
  rightCol.appendChild(right);

  grid.appendChild(left);
  grid.appendChild(rightCol);
  view.appendChild(grid);
}

async function renderKits(view){
  const kits = (await sbGetAll("kits")).sort((a,b)=>a.name.localeCompare(b.name));
  const gear = await sbGetAll("gear_items");
  const gearById = Object.fromEntries(gear.map(g=>[g.id,g]));

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Kits"]),
      el("div",{class:"muted small"},["Reusable buckets of gear (shared online)."])
    ]),
    el("button",{class:"btn secondary", onClick:()=>openKitModal()},["New kit"])
  ]));

  const list=el("div",{class:"grid two"});
  view.appendChild(list);

  if(!kits.length){
    list.appendChild(el("div",{class:"card"},["No kits yet."]));
    return;
  }

  for(const k of kits){
    const items=(k.item_ids||[]).map(id=>gearById[id]).filter(Boolean);
    const card=el("div",{class:"card"});
    card.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-start"},[
      el("div",{class:"stack"},[
        el("div",{style:"font-weight:800"},[k.name]),
        el("div",{class:"muted small"},[k.description || "—"])
      ]),
      el("span",{class:"badge"},[`${items.length} items`])
    ]));
    card.appendChild(el("hr",{class:"sep"}));
    const tags=el("div",{class:"row", style:"gap:6px; flex-wrap:wrap"});
    for(const it of items.slice(0,12)){
      tags.appendChild(el("span",{class:"badge"},[`${it.category}: ${it.name}`]));
    }
    if(items.length>12) tags.appendChild(el("span",{class:"badge"},[`+${items.length-12} more`]));
    card.appendChild(tags);

    card.appendChild(el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      el("button",{class:"btn secondary", onClick:()=>openKitModal(k)},["Edit"]),
      el("button",{class:"btn danger", onClick:async ()=>{
        if(!confirm(`Delete kit "${k.name}"?`)) return;
        await sbDelete("kits", k.id);
        toast("Deleted kit.");
        render();
      }},["Delete"])
    ]));
    list.appendChild(card);
  }
}


async function renderTeam(view){
  let members = null;
  try{
    members = await getTeamMembersSafe({allowMissing:true});
  }catch(err){
    console.error(err);
    toast(err?.message || String(err));
    members = [];
  }

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},["Team"]),
      el("div",{class:"muted small"},[
        "Create people (cast, crew, vendors) and assign them to events. ",
        (state.teamTableNoWorkspaceColumn ? "Note: Team table isn’t workspace-scoped yet; showing legacy rows." : "")
      ])
    ]),
    el("button",{class:"btn secondary", onClick:()=>openTeamMemberModal()},["Add person"])
  ]));

  const list = el("div",{class:"grid two teamCardsGrid"});
  view.appendChild(list);

  if(members === null){
    list.appendChild(el("div",{class:"card"},[
      el("div",{style:"font-weight:800"},["Team isn’t set up in Supabase yet."]),
      el("div",{class:"muted small", style:"margin-top:6px"},[
        "Run the latest SQL migration that creates the team_members table, then refresh."
      ])
    ]));
    return;
  }

  members = (members || []).sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  if(!members.length){
    list.appendChild(ghostCreateCard({
      title:"Create team member",
      subtitle:"Add cast, crew, vendors, and contacts.",
      ctaLabel:"Add person",
      onClick:()=>openTeamMemberModal()
    }));
    return;
  }

  for(const m of members){
    const card = el("div",{class:"card teamProfileCard"});

    const imgWrap = el("div",{class:"teamProfileHeadshot"},[]);
    if(m.headshot_url){
      imgWrap.appendChild(el("img",{src:m.headshot_url, alt:m.name||"Headshot", style:"width:100%; height:100%; object-fit:cover"}));
    } else {
      imgWrap.appendChild(el("div",{class:"muted teamProfileInitial"},[(m.name||"?").slice(0,1).toUpperCase()]));
    }

    const callHref = m.phone ? `tel:${String(m.phone).replace(/[^\d+]/g, "")}` : "";
    const mailHref = m.email ? `mailto:${String(m.email).trim()}` : "";

    const info = el("div",{class:"stack teamProfileInfo"},[
      el("div",{class:"teamProfileName"},[m.name || "Unnamed"]),
      el("div",{class:"muted small"},[(m.title || "No title") + (m.company ? " • " + m.company : "")]),
      ((m.phone || m.email) ? el("div",{class:"row teamContactRow"},[
        (m.phone ? el("a",{class:"btn secondary teamContactBtn", href:callHref},["Call"]) : null),
        (m.email ? el("a",{class:"btn secondary teamContactBtn", href:mailHref},["Email"]) : null),
      ]) : el("div",{class:"small muted"},["No contact info"]))
    ]);

    card.appendChild(imgWrap);
    card.appendChild(info);

    card.appendChild(el("div",{class:"teamProfileActions"},[
      el("button",{class:"btn secondary", onClick:()=>openTeamMemberModal(m)},["Edit"])
    ]));

    list.appendChild(card);
  }
}

async function openTeamMemberModal(existing=null){
  const isEdit = !!existing;

  const headshotUrl = el("input",{class:"input", placeholder:"Headshot URL (optional)", value: existing?.headshot_url || ""});
  const name = el("input",{class:"input", placeholder:"Name", value: existing?.name || ""});
  const title = el("input",{class:"input", placeholder:"Title (e.g., Director, Gaffer, Actor)", value: existing?.title || ""});
  const company = el("input",{class:"input", placeholder:"Company (optional)", value: existing?.company || ""});
  
  const phone = el("input",{class:"input", placeholder:"Phone", value: existing?.phone || ""});
  const email = el("input",{class:"input", placeholder:"Email", value: existing?.email || ""});
    const headshotFile = el("input",{type:"file", accept:"image/*", class:"input"});
  const headshotHint = el("div",{class:"small muted"},["Paste a URL or upload an image."]);

  const notes = el("textarea",{class:"textarea", placeholder:"Notes (rates, availability, address, etc.)"});
  notes.value = existing?.notes || "";

  const preview = el("div",{style:"width:72px; height:72px; border-radius:16px; overflow:hidden; border:1px solid var(--border); background:color-mix(in srgb, var(--bg) 86%, transparent)"},[]);
  const repaintPreview = ()=>{
    preview.innerHTML = "";
    const url = headshotUrl.value.trim();
    if(url){
      preview.appendChild(el("img",{src:url, alt:"Headshot", style:"width:100%; height:100%; object-fit:cover"}));
    } else {
      preview.appendChild(el("div",{class:"muted", style:"width:100%; height:100%; display:flex; align-items:center; justify-content:center; font-weight:800"},[(name.value.trim()||"?").slice(0,1).toUpperCase()]));
    }
  };
  headshotUrl.addEventListener("input", repaintPreview);
  headshotFile.addEventListener("change", async ()=>{
    const f = headshotFile.files?.[0];
    if(!f) return;
    try{
      headshotUrl.value = await fileToDataURL(f);
      headshotHint.textContent = "Headshot selected (stored as data URL).";
      repaintPreview();
    }catch(err){
      console.error(err);
      toast("Could not read that image file.");
    }
  });
  name.addEventListener("input", repaintPreview);
  repaintPreview();

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[isEdit?"Edit person":"Add person"]),
      el("span",{class:"badge"},[isEdit?"Update":"Create"])
    ]),
    el("hr",{class:"sep"}),

    el("div",{class:"row", style:"gap:12px; align-items:flex-start"},[
      preview,
      el("div",{class:"stack", style:"flex:1; gap:10px"},[
        el("div",{},[el("label",{class:"small muted"},["Headshot URL"]), headshotUrl]),
        el("div",{},[el("label",{class:"small muted"},["Upload headshot"]), headshotFile, headshotHint]),
        el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px"},[
          el("div",{},[el("label",{class:"small muted"},["Name"]), name]),
          el("div",{},[el("label",{class:"small muted"},["Title"]), title]),
          el("div",{},[el("label",{class:"small muted"},["Company"]), company]),
          el("div",{},[el("label",{class:"small muted"},["Phone"]), phone]),
          el("div",{},[el("label",{class:"small muted"},["Email"]), email]),
                  ])
      ])
    ]),

    el("div",{style:"margin-top:10px"},[el("label",{class:"small muted"},["Notes"]), notes]),

    el("div",{class:"row", style:"justify-content:space-between; align-items:center; margin-top:10px"},[
      (isEdit ? el("button",{class:"btn danger", onClick: async (e)=>{
        e.preventDefault();
        if(!confirm(`Delete ${existing?.name || "this person"}?`)) return;
        await sbDelete("team_members", existing.id);

        // Remove from any events that reference this person
        const events = await sbGetAll("events");
        for(const evt of events){
          const assignments = parseJsonArray(evt.assigned_people);
          const next = assignments.filter(a=>a.person_id!==existing.id);
          if(next.length !== assignments.length){
            await sbUpdate("events", evt.id, { assigned_people: next, updated_at: new Date().toISOString() });
          }
        }
        toast("Deleted team member.");
        m.close();
        render();
      }},["Delete"]) : el("div",{},[""])),
      el("div",{class:"row", style:"justify-content:flex-end; gap:10px"},[
        el("button",{class:"btn secondary", onClick:(e)=>{e.preventDefault(); m.close();}},["Cancel"]),
      el("button",{class:"btn", onClick: async (e)=>{
        e.preventDefault();
        if(!name.value.trim()){ toast("Name is required."); return; }

        const nowIso = new Date().toISOString();
        const fullRow = {
          headshot_url: headshotUrl.value.trim() || null,
          name: name.value.trim(),
          title: title.value.trim(),
          company: company.value.trim(),
                    phone: phone.value.trim(),
          email: email.value.trim(),
                    notes: notes.value.trim(),
          updated_at: nowIso
        };

        // Minimal columns fallback (in case DB isn't updated with the new fields yet)
        const minimalRow = {
          name: fullRow.name,
          title: fullRow.title,
                    phone: fullRow.phone,
          email: fullRow.email,
          notes: fullRow.notes,
          updated_at: nowIso
        };

        try{
          if(isEdit){
            await sbUpdate("team_members", existing.id, fullRow);
            toast("Updated person.");
          } else {
            fullRow.created_at = nowIso;
            await sbInsert("team_members", fullRow);
            toast("Added person.");
          }
          m.close();
          render();
        }catch(err){
          // If extra columns don't exist yet, retry with minimal columns.
          if(isMissingColumnErr(err)){
            try{
              if(isEdit){
                await sbUpdate("team_members", existing.id, minimalRow);
                toast("Updated person (some fields couldn’t be saved until your team table is updated).");
              } else {
                minimalRow.created_at = nowIso;
                await sbInsert("team_members", minimalRow);
                toast("Added person (some fields couldn’t be saved until your team table is updated).");
              }
              m.close();
              render();
              return;
            }catch(_e2){
              // fall through to original error
            }
          }
          toast(err?.message || String(err));
        }
        }},[isEdit?"Save":"Create"])
      ])
    ])
  ]));
}

async function openKitModal(existing=null){
  const isEdit=!!existing;
  const gear = await sbGetAll("gear_items");
  const selected = new Set(existing?.item_ids || []);

  const name=el("input",{class:"input", placeholder:"Kit name", value: existing?.name || ""});
  const desc=el("input",{class:"input", placeholder:"Description (optional)", value: existing?.description || ""});
  const q=el("input",{class:"input", placeholder:"Filter gear…"});
  const box=el("div",{style:"border:1px solid var(--border); border-radius:14px; overflow:auto; max-height:360px; margin-top:8px"});
  const count=el("span",{class:"badge"},[String(selected.size)]);

  const renderList=()=>{
    const qq=q.value.trim().toLowerCase();
    box.innerHTML="";
    const filtered=gear.filter(g=> !qq || `${g.category} ${g.name}`.toLowerCase().includes(qq));
    for(const g of filtered.slice(0,800)){
      const row=el("label",{class:"listItem", style:"align-items:center; cursor:pointer"},[
        el("div",{class:"stack"},[
          el("div",{style:"font-weight:700"},[`${g.category}: ${g.name}`]),
          el("div",{class:"kv"},[g.asset_tag ? `Tag ${g.asset_tag}` : ""])
        ]),
        (()=>{ 
          const cb=document.createElement("input");
          cb.type="checkbox";
          cb.checked=selected.has(g.id);
          cb.addEventListener("change", ()=>{
            if(cb.checked) selected.add(g.id); else selected.delete(g.id);
            count.textContent = String(selected.size);
          });
          return cb;
        })()
      ]);
      box.appendChild(row);
    }
  };
  q.addEventListener("input", renderList);

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[isEdit?"Edit kit":"New kit"]),
      el("span",{class:"badge"},[isEdit?"Update":"Create"])
    ]),
    el("hr",{class:"sep"}),
    el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px"},[
      el("div",{},[el("label",{class:"small muted"},["Kit name"]), name]),
      el("div",{},[el("label",{class:"small muted"},["Description"]), desc])
    ]),
    el("div",{class:"row", style:"justify-content:space-between; margin-top:10px"},[
      el("div",{class:"small muted"},["Select gear"]),
      el("div",{class:"row"},[el("span",{class:"small muted"},["Selected"]), count])
    ]),
    q,
    box,
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      (isEdit ? el("button",{class:"btn danger", style:"margin-right:auto", onClick: async (e)=>{
        e.preventDefault();
        try{
          const base = baseName(existing.name);
          const key = (existing.category||"") + "||" + base;
          const all = await sbGetAll("gear_items");
          const groupItems = all.filter(g => gearGroupKey(g) === key);

          const msg = groupItems.length > 1 ? `Delete "${base}" and its ${groupItems.length} copies?` : `Delete "${base}"?`;
          if(!confirm(msg)) return;

          // Prevent deleting gear that is currently reserved/checked out
          const ids = groupItems.map(x=>x.id);
          const { data: resv, error: resvErr } = await supabase
            .from("reservations")
            .select("id, status")
            .in("gear_item_id", ids);
          if(resvErr) throw resvErr;

          const active = (resv||[]).filter(r=>{
            const st = (r.status||"").toUpperCase();
            return !["CANCELED","CANCELLED","RETURNED","CLOSED"].includes(st);
          });
          if(active.length){
            alert(`Can't delete "${base}" because ${active.length} reservation(s) still reference it. Remove it from events first.`);
            return;
          }

          // delete all items in group
          for(const gi of groupItems){
            await sbDelete("gear_items", gi.id);
          }

          // remove from kits (array) best-effort
          const kits = await sbGetAll("kits");
          for(const k of kits){
            const next = (k.item_ids||[]).filter(x=>!ids.includes(x));
            if(next.length !== (k.item_ids||[]).length){
              await sbUpdate("kits", k.id, { item_ids: next, updated_at: new Date().toISOString() });
            }
          }

          toast("Deleted gear.");
          m.close();
          render();
        }catch(err){
          console.error(err);
          toast(err.message || "Delete failed.");
        }
      }},["Delete"]) : null),
      el("button",{class:"btn secondary", onClick:(e)=>{e.preventDefault(); m.close();}},["Cancel"]),
      el("button",{class:"btn", onClick: async (e)=>{
        e.preventDefault();
        if(!name.value.trim()){ toast("Kit name required."); return; }
        if(selected.size===0){ toast("Select at least one item."); return; }
        const nowIso=new Date().toISOString();
        const row={
          name: name.value.trim(),
          description: desc.value.trim(),
          item_ids: Array.from(selected),
          updated_at: nowIso
        };
        try{
          if(isEdit){
            await sbUpdate("kits", existing.id, row);
            toast("Updated kit.");
          } else {
            row.created_at = nowIso;
            await sbInsert("kits", row);
            toast("Created kit.");
          }
          m.close();
          render();
        }catch(err){
          toast(err.message || String(err));
        }
      }},[isEdit?"Save":"Create"])
    ])
  ]));
  renderList();
}

/** Init **/
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    // Coming back to foreground: refresh session + UI
    render();
  }
});
window.addEventListener("hashchange", render);

$("#settingsBtn")?.addEventListener("click", (e)=>{
  e.preventDefault();
  $("#settingsMenu")?.classList.toggle("open");
});

document.addEventListener("click", (e)=>{
  const wrap = $("#settingsWrap");
  const menu = $("#settingsMenu");
  if(!wrap || !menu || !menu.classList.contains("open")) return;
  if(wrap.contains(e.target)) return;
  menu.classList.remove("open");
});

$("#settingsThemeBtn")?.addEventListener("click", ()=>{
  setTheme(state.theme==="dark" ? "light" : "dark");
  $("#settingsMenu")?.classList.remove("open");
});

$("#settingsWorkspaceBtn")?.addEventListener("click", ()=>{
  location.hash = "#workspace";
  $("#settingsMenu")?.classList.remove("open");
});

$("#logoutBtn").addEventListener("click", async ()=>{
  if(!supabase) return;
  await supabase.auth.signOut();
  clearWorkspaceLocalStorage();
  localStorage.removeItem("javi_display_name");
  state.displayName = "";
  toast("Signed out.");
  $("#settingsMenu")?.classList.remove("open");
  location.hash="#dashboard";
  render();
});

(async function init(){
  setTheme(state.theme);
  setupHeaderUX();
// await ensureServiceWorker();

  const cfg = requireConfig();
  if(cfg){
    supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    supabase.auth.onAuthStateChange((_event,_session)=>render());
  }

  if(!location.hash) location.hash="#dashboard";
  render();
})();
