var supabase;
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
      if(String(c.status||"").toUpperCase() !== "OPEN") continue;
      if((c.items||[]).includes(gearItemId)) return true;
    }
  }catch(e){
    console.warn(e);
  }
  return false;
}

function dateOverlaps(aStart, aEnd, bStart, bEnd){
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  return as <= be && ae >= bs;
}

function fmtDate(d){
  try{
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString();
  }catch(_){ return d; }
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
  for(const c of children){
    if(typeof c==="string") e.appendChild(document.createTextNode(c));
    else if(c) e.appendChild(c);
  }
  return e;
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
    const order = ["dashboard","events","gear","kits"];
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
        <button class="btn secondary" id="menuLogoutBtn" type="button">Sign out</button>
      </div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(menu);

    const themeBtn = document.querySelector("#themeBtn");
    const logoutBtn = document.querySelector("#logoutBtn");
    if(!themeBtn) menu.querySelector("#menuThemeBtn").style.display="none";
    if(!logoutBtn) menu.querySelector("#menuLogoutBtn").style.display="none";

    const close = ()=> menu.classList.remove("open");
    btn.addEventListener("click",(e)=>{ e.preventDefault(); menu.classList.toggle("open"); });

    menu.querySelector("#menuThemeBtn")?.addEventListener("click",()=>{ close(); themeBtn?.click(); });
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
        #themeBtn, #logoutBtn{ display:none !important; }
        #hamburgerBtn{ display:inline-flex !important; }
      }
    `;
    document.head.appendChild(st);
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
};

function setTheme(theme){
  state.theme=theme;
  document.documentElement.setAttribute("data-theme", theme);
  $("#themeBtn").textContent = theme === "dark" ? "Dark" : "Light";
  localStorage.setItem("javi_theme", theme);
}

async function ensureServiceWorker(){
  if("serviceWorker" in navigator){
    try{ await navigator.serviceWorker.register("./sw.js"); } catch(e){}
  }
}

/** ---------- Supabase data helpers ---------- **/
async function sbGetAll(table, orderBy=null){
  let q = supabase.from(table).select("*");
  if(orderBy) q = q.order(orderBy, {ascending:true});
  const {data, error} = await q;
  if(error) throw error;
  return data || [];
}
async function sbGetById(table, id){
  const {data, error} = await supabase.from(table).select("*").eq("id", id).maybeSingle();
  if(error) throw error;
  return data || null;
}
async function sbInsert(table, row){
  const {data, error} = await supabase.from(table).insert(row).select("*").single();
  if(error) throw error;
  return data;
}
async function sbUpdate(table, id, patch){
  const {data, error} = await supabase.from(table).update(patch).eq("id", id).select("*").single();
  if(error) throw error;
  return data;
}
async function sbDelete(table, id){
  const {error} = await supabase.from(table).delete().eq("id", id);
  if(error) throw error;
}

/** Conflict: any ACTIVE reservation for same gear that overlaps, OR OPEN checkout with due_at after start */
async function gearHasConflict(gearItemId, startAtISO, endAtISO){
  const startAt = new Date(startAtISO);
  const endAt = new Date(endAtISO);

  // reservations
  const {data: resv, error: e1} = await supabase
    .from("reservations")
    .select("id,start_at,end_at,status")
    .eq("gear_item_id", gearItemId)
    .eq("status", "ACTIVE");
  if(e1) throw e1;

  for(const r of (resv||[])){
    if(overlaps(startAt, endAt, new Date(r.start_at), new Date(r.end_at))) return true;
  }

  // open checkouts
  const {data: outs, error: e2} = await supabase
    .from("checkouts")
    .select("id,due_at,status,items")
    .eq("status", "OPEN");
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
  const {data: resvAll, error: rErr} = await supabase
    .from("reservations")
    .select("gear_item_id,event_id,start_at,end_at,status")
    .eq("status","ACTIVE");
  if(rErr) throw rErr;

  for(const r of (resvAll||[])){
    if(ignoreEventId && r.event_id === ignoreEventId) continue;
    if(overlaps(startAt, endAt, new Date(r.start_at), new Date(r.end_at))){
      blocked.add(r.gear_item_id);
    }
  }

  // OPEN checkouts with due_at after window start
  const {data: outsAll, error: oErr} = await supabase
    .from("checkouts")
    .select("due_at,status,items")
    .eq("status","OPEN");
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

function renderAuth(view){
  const card = el("div",{class:"card", style:"max-width:520px; margin:24px auto"});
  card.appendChild(el("h1",{},["Sign in to Javi"]));
  card.appendChild(el("div",{class:"muted small", style:"margin-top:6px"},[
    "Online-first team workspace (shared)."
  ]));
  card.appendChild(el("hr",{class:"sep"}));

  const email = el("input",{class:"input", placeholder:"Email"});
  const pass = el("input",{class:"input", placeholder:"Password", type:"password", style:"margin-top:10px"});
  const msg = el("div",{class:"small muted", style:"margin-top:10px"},[""]);

  const row = el("div",{class:"row", style:"justify-content:flex-end; margin-top:12px"},[
    el("button",{class:"btn secondary", onClick: async ()=>{
      msg.textContent = "Creating account…";
      try{
        const {data, error} = await supabase.auth.signUp({ email: email.value.trim(), password: pass.value });
        if(error) throw error;
        msg.textContent = "Account created. If email confirmation is enabled, check your inbox; otherwise you can sign in now.";
      }catch(e){
        msg.textContent = e.message || String(e);
      }
    }},["Create account"]),
    el("button",{class:"btn", onClick: async ()=>{
      msg.textContent = "Signing in…";
      try{
        const {data, error} = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if(error) throw error;
        msg.textContent = "Signed in.";
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
  if(!cfg){
    $("#logoutBtn").style.display="none";
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
  $("#logoutBtn").style.display = state.user ? "inline-flex" : "none";
  $("#nav").style.visibility = state.user ? "visible" : "hidden";

  if(!state.user){
    renderAuth(view);
    return;
  }

  const hash=(location.hash||"#dashboard").replace("#","");
  state.route = hash.split("/")[0] || "dashboard";
  document.querySelectorAll("#nav a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route===state.route);
  });

  if(state.route==="dashboard") return renderDashboard(view);
  if(state.route==="gear") return renderGear(view);
  if(state.route==="events") return renderEvents(view);
  if(state.route==="kits") return renderKits(view);

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
  const [events, checkouts] = await Promise.all([
    sbGetAll("events"),
    sbGetAll("checkouts")
  ]);
  const now=new Date();

  const upcoming = events
    .filter(e=>new Date(e.end_at)>=now && e.status!=="CANCELED")
    .sort((a,b)=>new Date(a.start_at)-new Date(b.start_at))
    .slice(0,8);

  const open = checkouts
    .filter(c=>c.status==="OPEN")
    .sort((a,b)=>new Date(a.due_at)-new Date(b.due_at))
    .slice(0,10);

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
    el("span",{class:"badge"},[String(upcoming.length)])
  ]));
  c1.appendChild(el("hr",{class:"sep"}));
  if(!upcoming.length){
    c1.appendChild(el("div",{class:"muted"},["No upcoming events."]));
  } else {
    for(const e of upcoming){
      c1.appendChild(el("a",{href:`#events/${e.id}`, class:"listItem"},[
        el("div",{class:"stack"},[
          el("div",{style:"font-weight:700"},[e.title]),
          el("div",{class:"kv"},[`${fmt(e.start_at)} → ${fmt(e.end_at)}`]),
          el("div",{class:"kv"},[e.location || "No location"])
        ]),
        el("span",{class:"badge"},[e.status||"DRAFT"])
      ]));
    }
  }

  const c2=el("div",{class:"card"});
  c2.appendChild(el("div",{class:"row", style:"justify-content:space-between"},[
    el("h2",{},["Checked out now"]),
    el("span",{class:"badge"},[String(open.length)])
  ]));
  c2.appendChild(el("hr",{class:"sep"}));
  if(!open.length){
    c2.appendChild(el("div",{class:"muted"},["Nothing checked out."]));
  } else {
    const gearById = Object.fromEntries((await sbGetAll("gear_items")).map(g=>[g.id,g]));
    for(const c of open){
      const items=(c.items||[]).map(id=>gearById[id]).filter(Boolean);
      c2.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"stack"},[
          el("div",{},[
            el("span",{style:"font-weight:700"},[c.custody || "—"]),
            el("span",{class:"muted"},[` • due ${fmt(c.due_at)}`]),
          ]),
          el("div",{class:"kv"},[c.event_title ? `Event: ${c.event_title}` : "Ad-hoc checkout"]),
        ]),
        el("div",{},[
          el("button",{class:"btn secondary", onClick: async ()=>{
            await sbUpdate("checkouts", c.id, { status:"RETURNED", returned_at: new Date().toISOString() });
            toast("Marked returned.");
            render();
          }},["Return"])
        ])
      ]));
    }
  }

  grid.appendChild(c1);
  grid.appendChild(c2);
  view.appendChild(grid);
}

function modal(content){
  const overlay=el("div",{style:"position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px; z-index:50"});
  const box=el("div",{class:"card", style:"width:min(720px, 96vw); max-height:90vh; overflow:auto"});
  const close=()=>overlay.remove();
  overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(); });
  box.appendChild(content);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { close };
}

// -------- QR scanning (web) --------
// Uses https://github.com/mebjas/html5-qrcode via CDN (loaded dynamically).
let __qrLibPromise = null;

function ensureQrLibLoaded(){
  if(window.Html5Qrcode) return Promise.resolve(true);
  if(__qrLibPromise) return __qrLibPromise;
  __qrLibPromise = new Promise((resolve,reject)=>{
    const existing = document.querySelector('script[data-html5-qrcode="1"]');
    if(existing){
      existing.addEventListener("load", ()=>resolve(true), {once:true});
      existing.addEventListener("error", ()=>reject(new Error("Failed to load QR scanner library.")), {once:true});
      return;
    }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/html5-qrcode@2.3.10/html5-qrcode.min.js";
    s.async = true;
    s.dataset.html5Qrcode = "1";
    s.onload = ()=>resolve(true);
    s.onerror = ()=>reject(new Error("Failed to load QR scanner library."));
    document.head.appendChild(s);
  });
  return __qrLibPromise;
}

function parseScanPayload(txt){
  const raw = String(txt||"").trim();
  if(!raw) return {raw:null, id:null, tag:null};

  // Accept plain IDs, or prefixed payloads like "gear:<id>" or "tag:<assetTag>"
  const m = raw.match(/^(gear|id|tag)\s*:\s*(.+)$/i);
  if(m){
    const kind = m[1].toLowerCase();
    const val = String(m[2]||"").trim();
    if(kind==="tag") return {raw, id:null, tag:val};
    return {raw, id:val, tag:null};
  }

  return {raw, id:raw, tag:raw}; // fall back: try id first, then tag
}

async function markReservationScanned(resvId){
  const nowIso = new Date().toISOString();
  try{
    await sbUpdate("reservations", resvId, { scanned_at: nowIso, updated_at: nowIso });
    return true;
  }catch(e){
    const msg = (e?.message||String(e||"")).toLowerCase();
    if(msg.includes("column") && msg.includes("scanned_at")){
      alert(
        "QR scanning needs a new column in Supabase.\n\n" +
        "Run this SQL in Supabase (SQL Editor):\n\n" +
        "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS scanned_at timestamptz;\n"
      );
      return false;
    }
    throw e;
  }
}

function injectScanStyles(){
  if(document.querySelector("#javiScanStyles")) return;
  const st = document.createElement("style");
  st.id = "javiScanStyles";
  st.textContent = `
    .scanRowPending{ background: color-mix(in srgb, #facc15 20%, transparent); }
    .scanRowDone{ background: color-mix(in srgb, #22c55e 18%, transparent); }
    .scanBadge{ font-size:12px; padding:3px 8px; border-radius:999px; border:1px solid var(--border); }
  `;
  document.head.appendChild(st);
}

async function openEventQrScanner(opts){
  // opts: { evt, reservations, gearById }
  injectScanStyles();
  await ensureQrLibLoaded();

  const { evt, reservations, gearById } = opts;

  const active = (reservations||[]).filter(r => String(r.status||"").toUpperCase()==="ACTIVE");
  if(!active.length){
    toast("No active reserved items to scan.");
    return;
  }

  const byGearId = new Map(active.map(r=>[r.gear_item_id, r]));
  const byAssetTag = new Map();
  for(const r of active){
    const g = gearById?.[r.gear_item_id];
    const tag = String(g?.asset_tag||"").trim();
    if(tag) byAssetTag.set(tag, r);
  }

  const regionId = "qrRegion_" + Math.random().toString(36).slice(2);
  const statusLine = el("div",{class:"small muted", style:"margin-top:6px"},[
    "Point your camera at a QR code. (Allow camera permission if prompted.)"
  ]);

  let scanner = null;
  let stopped = false;

  const content = el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},["Scan gear"]),
      el("span",{class:"badge"},[`Event: ${evt.title || "—"}`])
    ]),
    el("div",{class:"muted small", style:"margin-top:6px"},[
      "Each scan marks a reserved item as scanned (green). Unscanned items remain yellow."
    ]),
    el("hr",{class:"sep"}),
    el("div",{id: regionId, style:"width:100%; max-width:520px; margin:0 auto;"} ,[]),
    statusLine,
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px; gap:10px; flex-wrap:wrap"},[
      el("button",{class:"btn secondary", type:"button", onClick: async ()=>{
        // flip camera if supported
        try{
          if(scanner){
            const cams = await Html5Qrcode.getCameras();
            if(!cams || cams.length < 2){ toast("No alternate camera found."); return; }
            const current = window.__javiCamId || cams[0].id;
            const next = cams.find(c=>c.id!==current)?.id || cams[0].id;
            window.__javiCamId = next;
            await scanner.stop();
            await scanner.start({ deviceId: { exact: next } }, { fps:10, qrbox: { width: 250, height: 250 } }, onScanSuccess, onScanFail);
            toast("Switched camera.");
          }
        }catch(_){ toast("Couldn't switch camera."); }
      }},["Flip camera"]),
      el("button",{class:"btn", type:"button", onClick: async ()=>{
        await stop();
        m.close();
      }},["Done"])
    ])
  ]);

  const m = modal(content);

  async function stop(){
    if(stopped) return;
    stopped = true;
    try{
      if(scanner){
        await scanner.stop();
        await scanner.clear();
      }
    }catch(_){}
  }

  async function onScanSuccess(decodedText){
    const parsed = parseScanPayload(decodedText);
    const idCandidate = parsed.id;
    const tagCandidate = parsed.tag;

    let match = null;
    if(idCandidate && byGearId.has(idCandidate)) match = byGearId.get(idCandidate);
    if(!match && tagCandidate && byAssetTag.has(tagCandidate)) match = byAssetTag.get(tagCandidate);

    if(!match){
      statusLine.textContent = `Not in this event: "${parsed.raw}"`;
      return;
    }

    // Already scanned?
    if(match.scanned_at){
      statusLine.textContent = "Already scanned.";
      return;
    }

    statusLine.textContent = "Marking scanned…";
    try{
      const ok = await markReservationScanned(match.id);
      if(!ok) { statusLine.textContent = "Scan disabled until DB updated."; return; }
      statusLine.textContent = "Scanned ✓";
      toast("Scanned.");
      render(); // refresh list colors
    }catch(e){
      console.error(e);
      statusLine.textContent = e.message || "Scan failed.";
    }
  }

  function onScanFail(_err){
    // ignore noisy decode failures
  }

  // Start scanner
  try{
    scanner = new Html5Qrcode(regionId);
    const cams = await Html5Qrcode.getCameras();
    let camId = window.__javiCamId || (cams?.[0]?.id || null);
    if(!camId){
      statusLine.textContent = "No camera found on this device.";
      return;
    }
    window.__javiCamId = camId;
    await scanner.start(
      { deviceId: { exact: camId } },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess,
      onScanFail
    );
  }catch(e){
    console.error(e);
    statusLine.textContent = (e?.message || String(e||"")).includes("Permission")
      ? "Camera permission denied. Allow camera access in your browser settings."
      : (e?.message || "Could not start scanner.");
  }

  // Ensure scanner stops if modal is closed by clicking overlay
  const oldClose = m.close;
  m.close = ()=>{ stop(); oldClose(); };
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

  const filterCard=el("div",{class:"card", style:"margin-bottom:12px"});
  const q=el("input",{class:"input", placeholder:"Search gear…"});
  const cat=el("select",{class:"select"});
  cat.appendChild(el("option",{value:""},["All categories"]));
  for(const c of CATEGORIES) cat.appendChild(el("option",{value:c},[c]));
  filterCard.appendChild(el("div",{class:"grid", style:"grid-template-columns: 1fr 220px; gap:10px"},[q, cat]));
  view.appendChild(filterCard);

  const list=el("div",{class:"grid"});
  view.appendChild(list);

  function refresh(){
    const qq=q.value.trim().toLowerCase();
    const cc=cat.value;
    list.innerHTML="";
    const items = groupsAll.filter(gr => {
      const g = gr.primary;
      const hay = (gr.name + " " + (g.description||"") + " " + (g.asset_tag||"") + " " + (g.serial||"")).toLowerCase();
      return (!cc || gr.category===cc) && (!qq || hay.includes(qq));
    });
    if(!items.length){
      list.appendChild(el("div",{class:"card"},["No gear found."]));
      return;
    }
    for(const gr of items){
      const it = gr.primary;
      const qtyBadge = gr.qty > 1 ? el("span",{class:"badge"},[`${gr.category} • x${gr.qty}`]) : el("span",{class:"badge"},[it.category]);
      const thumb = it.image_url ? el("img",{src:it.image_url, style:"width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid var(--border)"}) : el("div",{style:"width:44px;height:44px;border-radius:10px;border:1px solid var(--border);background:color-mix(in srgb, var(--panel) 92%, transparent)"},[]);
      list.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"row", style:"gap:10px; align-items:flex-start"},[
          thumb,
          el("div",{class:"stack"},[
            el("div",{style:"font-weight:700"},[gr.qty>1 ? `${gr.name} (x${gr.qty})` : gr.name]),
            el("div",{class:"kv"},[it.description || "—"]),
            el("div",{class:"kv"},[
              it.asset_tag ? `Tag: ${it.asset_tag}` : "No tag",
              it.serial ? ` • S/N: ${it.serial}` : "",
              it.location ? ` • Location: ${it.location}` : ""
            ].join(""))
          ])
        ]),
        el("div",{class:"stack", style:"align-items:flex-end"},[
          qtyBadge,
          el("button",{class:"btn secondary", onClick:()=>openGearModal(it, gr.qty)},["Edit"]),
                el("button",{class:"btn secondary", type:"button", onClick: async ()=>{
        try{
          await openEventQrScanner({ evt, reservations, gearById });
        }catch(e){
          console.error(e);
          toast(e.message || "Scanner error.");
        }
      }},["Scan gear"]),
      el("button",{class:"btn danger", onClick:async ()=>{
            try{
              const msg = gr.qty>1 ? `Delete "${gr.name}" and its ${gr.qty} copies?` : `Delete "${gr.name}"?`;
              if(!confirm(msg)) return;

              // Prevent deleting gear that is currently reserved/checked out
              const ids = gr.items.map(x=>x.id);
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
                alert(`Can't delete "${gr.name}" because ${active.length} reservation(s) still reference it. Remove it from events first.`);
                return;
              }

              // delete all items in group
              for(const gi of gr.items){
                await sbDelete("gear_items", gi.id);
              }

              // remove from kits (array) best-effort
              const kits = await sbGetAll("kits");
              for(const k of kits){
                const next = (k.item_ids||[]).filter(x=>!gr.items.some(gi=>gi.id===x));
                if(next.length !== (k.item_ids||[]).length){
                  await sbUpdate("kits", k.id, { item_ids: next, updated_at: new Date().toISOString() });
                }
              }

              toast("Deleted gear.");
              render();
            }catch(e){
              console.error(e);
              toast(e.message || "Delete failed.");
            }
          }},["Delete"])
        ])
      ]));
    }
  }

  q.addEventListener("input", refresh);
  cat.addEventListener("change", refresh);
  refresh();
}

async function openGearModal(existing=null, existingQty=null){
  const isEdit=!!existing;

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
        el("label",{class:"small muted"},["Location"]), location,
      ]),
      el("div",{class:"stack"},[
        el("label",{class:"small muted"},["Image URL or pick a file"]), imgUrl,
        filePick,
        preview
      ])
    ]),
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
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

  const events = (await sbGetAll("events")).sort((a,b)=> new Date(b.start_at)-new Date(a.start_at));
  const list=el("div",{class:"grid"});
  view.appendChild(list);

  if(!events.length){
    list.appendChild(el("div",{class:"card"},["No events yet."]));
    return;
  }
  for(const e of events){
    // count reserved via query? keep light: show status only
    list.appendChild(el("a",{href:`#events/${e.id}`, class:"listItem"},[
      el("div",{class:"stack"},[
        el("div",{style:"font-weight:700"},[e.title]),
        el("div",{class:"kv"},[`${fmt(e.start_at)} → ${fmt(e.end_at)}`]),
        el("div",{class:"kv"},[e.location || "No location"])
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
  const notes=el("textarea",{class:"textarea", placeholder:"Notes (optional)"});
  notes.value = existing?.notes || "";

  const m = modal(el("div",{},[
    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
      el("h2",{},[isEdit?"Edit event":"New event"]),
      el("span",{class:"badge"},[isEdit?"Update":"Create"])
    ]),
    el("hr",{class:"sep"}),
    el("div",{class:"grid", style:"grid-template-columns: 1fr 1fr; gap:10px"},[
      el("div",{},[el("label",{class:"small muted"},["Title"]), t]),
      el("div",{},[el("label",{class:"small muted"},["Location"]), loc]),
      el("div",{},[el("label",{class:"small muted"},["Start"]), start]),
      el("div",{},[el("label",{class:"small muted"},["End"]), end]),
    ]),
    el("div",{style:"margin-top:10px"},[el("label",{class:"small muted"},["Notes"]), notes]),
    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      el("button",{class:"btn secondary", onClick:(e)=>{e.preventDefault(); m.close();}},["Cancel"]),
      el("button",{class:"btn", onClick: async (e)=>{
        e.preventDefault();
        if(!t.value.trim()){ toast("Title is required."); return; }
        const s=new Date(start.value), en=new Date(end.value);
        if(!(s<en)){ toast("End must be after start."); return; }
        const nowIso=new Date().toISOString();
        const row={
          title: t.value.trim(),
          start_at: s.toISOString(),
          end_at: en.toISOString(),
          location: loc.value.trim(),
          notes: notes.value.trim(),
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

            obj = await sbUpdate("events", existing.id, row);

            // Keep this event's ACTIVE reservations aligned to the new event window
            const {error: upErr} = await supabase
              .from("reservations")
              .update({ start_at: row.start_at, end_at: row.end_at })
              .eq("event_id", existing.id)
              .eq("status","ACTIVE");
            if(upErr) throw upErr;

            toast("Updated event.");
          } else {
            row.created_at = nowIso;
            row.status = "DRAFT";
            obj = await sbInsert("events", row);
            toast("Created event.");
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
  const gearById = Object.fromEntries(gear.map(g=>[g.id,g]));
  const reservations = (await sbGetAll("reservations")).filter(r=>r.event_id===evt.id && r.status==="ACTIVE");
  const existingReservedIds = new Set(reservations.map(r=>r.gear_item_id));
  const checkouts = (await sbGetAll("checkouts")).filter(c=>c.event_id===evt.id).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const openCheckout = checkouts.find(c=>c.status==="OPEN") || null;

  view.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:flex-end; margin-bottom:12px"},[
    el("div",{},[
      el("h1",{},[evt.title]),
      el("div",{class:"muted small"},[`${fmt(evt.start_at)} → ${fmt(evt.end_at)} • ${evt.location || "No location"}`]),
    ]),
    el("div",{class:"row"},[
      el("a",{href:"#events", class:"btn secondary"},["Back"]),
      el("button",{class:"btn secondary", onClick:()=>openEventModal(evt)},["Edit"]),
      el("button",{class:"btn danger", onClick:async ()=>{
        if(!confirm("Delete this event?")) return;
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

      listBox.appendChild(el("div",{class:"listItem " + (r.scanned_at ? "scanRowDone" : "scanRowPending")},[
        el("div",{class:"row", style:"gap:10px; align-items:flex-start"},[
          cb,
          el("div",{class:"stack"},[
            el("div",{class:"row", style:"justify-content:space-between; align-items:center; gap:10px"},[
              el("div",{style:"font-weight:700"},[`${it.category}: ${it.name}`]),
              el("span",{class:"scanBadge"},[r.scanned_at ? "Scanned" : "Not scanned"])
            ]),
            el("div",{class:"kv"},[`${fmt(r.start_at)} → ${fmt(r.end_at)}`]),
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

      const row={
        event_id: evt.id,
        gear_item_id: gearItemId,
        start_at: evt.start_at,
        end_at: evt.end_at,
        status:"ACTIVE"
      };
      await sbInsert("reservations", row);
      existingReservedIds.add(gearItemId);
      added++;
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

    for(const id of chosen){
      const row={
        event_id: evt.id,
        gear_item_id: id,
        start_at: evt.start_at,
        end_at: evt.end_at,
        status:"ACTIVE"
      };
      await sbInsert("reservations", row);
    }

    await sbUpdate("events", evt.id, { status:"RESERVED", updated_at: new Date().toISOString() });

    if(chosen.length===want){
      toast(chosen.length===1 ? "Reserved." : `Reserved ${chosen.length}.`);
    } else {
      toast(`Reserved ${chosen.length} (only ${chosen.length} available).`);
    }
    render();
  }

  evtGearSearch.addEventListener("input", ()=>refreshPick());
  evtGearCat.addEventListener("change", ()=>refreshPick());
  refreshPick();

  left.appendChild(evtGearCat);
  left.appendChild(evtGearSearch);
  left.appendChild(evtGearPick);
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


  const right=el("div",{class:"card"});
  right.appendChild(el("h2",{},["Checkout"]));
  right.appendChild(el("div",{class:"small muted", style:"margin-top:6px"},["Direct checkout. Checks out all currently reserved items."]));
  right.appendChild(el("hr",{class:"sep"}));

  if(openCheckout){
    right.appendChild(el("div",{class:"listItem"},[
      el("div",{class:"stack"},[
        el("div",{},[
          el("span",{style:"font-weight:700"},["OPEN"]),
          el("span",{class:"muted"},[` • custody: ${openCheckout.custody || "—"}`])
        ]),
        el("div",{class:"kv"},[`Due ${fmt(openCheckout.due_at)} • ${(openCheckout.items||[]).length} items`])
      ]),
      el("button",{class:"btn secondary", onClick: async ()=>{
        await sbUpdate("checkouts", openCheckout.id, { status:"RETURNED", returned_at: new Date().toISOString() });
        await sbUpdate("events", evt.id, { status: reservations.length ? "RESERVED" : "DRAFT", updated_at: new Date().toISOString() });
        toast("Marked returned.");
        render();
      }},["Mark returned"])
    ]));
  } else {
    const custody=el("input",{class:"input", placeholder:"Custody (who has the gear) e.g., Brent"});
    const due=el("input",{class:"input", type:"datetime-local", value: toInputDateTimeLocal(new Date(evt.end_at))});
    const notes=el("input",{class:"input", placeholder:"Notes (optional)"});

    right.appendChild(el("label",{class:"small muted"},["Custody"]));
    right.appendChild(custody);
    right.appendChild(el("label",{class:"small muted", style:"margin-top:8px"},["Due back"]));
    right.appendChild(due);
    right.appendChild(el("label",{class:"small muted", style:"margin-top:8px"},["Notes"]));
    right.appendChild(notes);

    right.appendChild(el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
      el("button",{class:"btn", onClick: async ()=>{
        if(!reservations.length){ toast("No reserved items to check out."); return; }
        const items = reservations.map(r=>r.gear_item_id);
        const row={
          event_id: evt.id,
          event_title: evt.title,
          custody: custody.value.trim(),
          due_at: new Date(due.value).toISOString(),
          notes: notes.value.trim(),
          status:"OPEN",
          items
        };
        await sbInsert("checkouts", row);
        await sbUpdate("events", evt.id, { status:"CHECKED_OUT", updated_at: new Date().toISOString() });
        toast("Checked out reserved gear.");
        render();
      }},["Check out reserved gear"])
    ]));
  }

  right.appendChild(el("hr",{class:"sep"}));
  right.appendChild(el("div",{class:"small", style:"font-weight:700"},["Checkout history"]));
  if(!checkouts.length){
    right.appendChild(el("div",{class:"muted", style:"margin-top:8px"},["None."]));
  } else {
    const box=el("div",{class:"grid", style:"margin-top:8px"});
    for(const c of checkouts.slice(0,8)){
      box.appendChild(el("div",{class:"listItem"},[
        el("div",{class:"stack"},[
          el("div",{},[
            el("span",{style:"font-weight:700"},[c.status]),
            el("span",{class:"muted"},[` • custody ${c.custody || "—"}`])
          ]),
          el("div",{class:"kv"},[`${fmt(c.checked_out_at)} → ${c.returned_at ? fmt(c.returned_at) : "—"}`]),
          el("div",{class:"kv"},[c.notes || ""])
        ]),
        el("div",{},[])
      ]));
    }
    right.appendChild(box);
  }

  grid.appendChild(left);
  grid.appendChild(right);
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

$("#themeBtn").addEventListener("click", ()=> setTheme(state.theme==="dark" ? "light" : "dark"));
$("#logoutBtn").addEventListener("click", async ()=>{
  if(!supabase) return;
  await supabase.auth.signOut();
  toast("Signed out.");
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
