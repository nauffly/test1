diff --git a/app.js b/app.js
index 5cf523a946c3aa2cdd3832bd93fd98869725ea45..fea628fb38e69dbb761a56d48e8445a686ff7813 100644
--- a/app.js
+++ b/app.js
@@ -59,50 +59,133 @@ async function gearItemInUse(gearItemId){
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
 
+function normalizeScanText(v){
+  return String(v || "").trim().toLowerCase();
+}
+
+function findGearByScan(gearItems, rawValue){
+  const normalized = normalizeScanText(rawValue);
+  if(!normalized) return null;
+
+  return (gearItems || []).find(g=>{
+    const base = normalizeScanText(baseName(g.name));
+    const full = normalizeScanText(g.name);
+    const id = normalizeScanText(g.id);
+    const tag = normalizeScanText(g.asset_tag);
+    const serial = normalizeScanText(g.serial);
+    return normalized===id || normalized===tag || normalized===serial || normalized===full || normalized===base;
+  }) || null;
+}
+
+function openQrScannerModal({ title="Scan QR", onDetect }){
+  const hasBarcodeDetector = typeof window.BarcodeDetector !== "undefined";
+  if(!hasBarcodeDetector || !navigator.mediaDevices?.getUserMedia){
+    const fallback = prompt("QR scan not available on this device/browser. Paste scanned code:");
+    if(fallback && typeof onDetect === "function") onDetect(fallback);
+    return;
+  }
+
+  const detector = new BarcodeDetector({ formats:["qr_code"] });
+  const video = el("video",{autoplay:"autoplay", playsinline:"playsinline", style:"width:100%; border-radius:10px; border:1px solid var(--border); background:#000"});
+  const hint = el("div",{class:"small muted", style:"margin-top:8px"},["Point camera at a gear QR code."]);
+  let rafId = null;
+  let active = true;
+  let stream = null;
+
+  const stop = ()=>{
+    active = false;
+    if(rafId) cancelAnimationFrame(rafId);
+    if(stream) stream.getTracks().forEach(t=>t.stop());
+  };
+
+  const m = modal(el("div",{},[
+    el("div",{class:"row", style:"justify-content:space-between; align-items:center"},[
+      el("h2",{},[title]),
+      el("span",{class:"badge"},["Camera"])
+    ]),
+    el("hr",{class:"sep"}),
+    video,
+    hint,
+    el("div",{class:"row", style:"justify-content:flex-end; margin-top:10px"},[
+      el("button",{class:"btn secondary", onClick:(e)=>{ e.preventDefault(); stop(); m.close(); }},["Cancel"])
+    ])
+  ]));
+
+  const prevClose = m.close;
+  m.close = ()=>{ stop(); prevClose(); };
+
+  const tick = async ()=>{
+    if(!active) return;
+    try{
+      const codes = await detector.detect(video);
+      if(codes?.length){
+        const val = codes[0].rawValue || "";
+        if(val && typeof onDetect === "function") onDetect(val);
+        m.close();
+        return;
+      }
+    }catch(_){ }
+    rafId = requestAnimationFrame(tick);
+  };
+
+  navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:"environment" } }, audio:false })
+    .then(s=>{
+      stream = s;
+      video.srcObject = s;
+      video.play().catch(()=>{});
+      rafId = requestAnimationFrame(tick);
+    })
+    .catch(err=>{
+      stop();
+      m.close();
+      toast(err?.message || "Camera access failed.");
+    });
+}
+
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
@@ -987,51 +1070,51 @@ async function renderGear(view){
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
-      const hay = (gr.name + " " + (g.description||"") + " " + (g.asset_tag||"") + " " + (g.serial||"")).toLowerCase();
+      const hay = (gr.name + " " + (g.description||"") + " " + (g.asset_tag||"") + " " + (g.serial||"") + " " + (g.qr_code||"")).toLowerCase();
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
@@ -1082,174 +1165,179 @@ async function renderGear(view){
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
+  const qrCode=el("input",{class:"input", placeholder:"QR code value (optional)", value: existing?.qr_code || ""});
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
+        el("label",{class:"small muted"},["QR code value"]), qrCode,
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
+          qr_code: qrCode.value.trim() || "",
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
+                  qr_code: "",
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
+                qr_code: "",
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
@@ -1654,95 +1742,127 @@ async function renderEventDetail(view, evt){
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
 
+
+  async function reserveFromScannedGear(rawValue){
+    const found = findGearByScan(gear, rawValue);
+    if(!found){
+      toast("No matching gear found for that QR code.");
+      return;
+    }
+    if(existingReservedIds.has(found.id)){
+      toast("That item is already reserved on this event.");
+      return;
+    }
+    if(blockedIds.has(found.id)){
+      toast("That item is booked in this event window.");
+      return;
+    }
+
+    await sbInsert("reservations", {
+      event_id: evt.id,
+      gear_item_id: found.id,
+      start_at: evt.start_at,
+      end_at: evt.end_at,
+      status:"ACTIVE"
+    });
+    await sbUpdate("events", evt.id, { status:"RESERVED", updated_at: new Date().toISOString() });
+    toast(`Reserved ${found.name}.`);
+    render();
+  }
+
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
+  left.appendChild(el("button",{class:"btn secondary", style:"margin-top:8px", onClick:()=>openQrScannerModal({
+    title:"Scan gear to reserve",
+    onDetect:(value)=>reserveFromScannedGear(value)
+  })},["Scan QR to reserve"]));
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
@@ -1763,50 +1883,67 @@ async function renderEventDetail(view, evt){
     await reserveFromGroup(grp, v);
 
     // Reset quantity selection (keep the gear selected so user can add more if desired)
     qtyPick.value = "";
   });
 
 
   const right=el("div",{class:"card"});
   right.appendChild(el("h2",{},["Checked out"]));
   right.appendChild(el("div",{class:"small muted", style:"margin-top:6px"},[
     "Automatic: reserved gear is considered checked out only while the event is ongoing."
   ]));
   right.appendChild(el("hr",{class:"sep"}));
 
   const now = new Date();
   const ongoing = (new Date(evt.start_at) <= now) && (new Date(evt.end_at) >= now) && evt.status!=="CANCELED";
 
   if(!ongoing){
     right.appendChild(el("div",{class:"muted"},["This event is not currently ongoing."]));
     right.appendChild(el("div",{class:"small muted", style:"margin-top:8px"},[
       "Upcoming reservations remain reserved (and will show as checked out automatically once the event starts)."
     ]));
   } else if(!reservations.length){
     right.appendChild(el("div",{class:"muted"},["No reserved items are currently checked out for this event."]));
   } else {
+    const returnReservationByScan = async (rawValue)=>{
+      const found = findGearByScan(gear, rawValue);
+      if(!found){ toast("No matching gear found for that QR code."); return; }
+      const resv = reservations.find(r=>r.gear_item_id===found.id);
+      if(!resv){ toast("That gear is not currently checked out on this event."); return; }
+      await sbUpdate("reservations", resv.id, { status:"RETURNED" });
+      toast(`Returned ${found.name}.`);
+      render();
+    };
+
+    right.appendChild(el("div",{class:"row", style:"justify-content:flex-end; margin-bottom:8px"},[
+      el("button",{class:"btn secondary", onClick:()=>openQrScannerModal({
+        title:"Scan gear to return",
+        onDetect:(value)=>returnReservationByScan(value)
+      })},["Scan QR to return item"])
+    ]));
+
     right.appendChild(el("div",{class:"listItem"},[
       el("div",{class:"stack"},[
         el("div",{style:"font-weight:700"},[`${reservations.length} item(s) checked out now`]),
         el("div",{class:"kv"},[`Ongoing • ends ${fmt(evt.end_at)}`])
       ]),
       el("button",{class:"btn secondary", onClick: async ()=>{
         if(!confirm(`Return all ${reservations.length} item(s) from this event now?`)) return;
 
         const nowIso = new Date().toISOString();
 
         // Mark this event's ACTIVE reservations returned (so they are available again)
         const {error: rErr} = await supabase
           .from("reservations")
           .update({ status:"RETURNED" })
           .eq("event_id", evt.id)
           .eq("status","ACTIVE");
         if(rErr) throw rErr;
 
         // Best-effort: close any legacy OPEN checkout rows tied to this event
         try{
           await supabase
             .from("checkouts")
             .update({ status:"RETURNED", returned_at: nowIso })
             .eq("event_id", evt.id)
             .eq("status","OPEN");
