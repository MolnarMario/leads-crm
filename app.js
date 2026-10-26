"use strict";
/* The cold-call CRM, hosted. Same interface as the offline dashboard_template.html,
   but the leads and the call notes live in Supabase behind a sign-in.
   This file is public: it holds no data and no secret. The publishable key below
   is meant to ship in pages; without a signed-in account listed in app_users,
   the database returns nothing (see supabase/schema.sql). */
const SUPABASE_URL = "https://otzhzgxlivdotqpofdpx.supabase.co";
const SUPABASE_KEY = "sb_publishable_NlmY9d0s61Dj0dDxDm6cww_9ibbBPBy";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let LEADS = [];

const STATUSES = [
  ["new",            "🆕", "New"],
  ["no_answer",      "📵", "No answer"],
  ["callback",       "⏰", "Callback"],
  ["interested",     "👍", "Interested"],
  ["meeting",        "📅", "Meeting set"],
  ["won",            "🏆", "Won"],
  ["not_interested", "👎", "Not interested"],
  ["lost",           "✖", "Lost"],
];
const ST = Object.fromEntries(STATUSES.map(([k, i, l]) => [k, { icon: i, label: l }]));
/* what the Google listing shows in its website slot */
const LV = {
  none:   { icon: "✔", label: "No website",           rank: 0 },
  social: { icon: "📱", label: "Facebook / directory", rank: 1 },
  maybe:  { icon: "❓", label: "Possible site",        rank: 2 },
};
const leadVerdict = l => l.possibleSite ? "maybe" : l.websiteStatus === "SOCIAL_ONLY" ? "social" : "none";
/* find_sites.py's web search for a site the Maps listing doesn't show */
const WEB_CHECK = {
  NOTHING:       "Searched the web: no site of theirs found",
  MAYBE:         "Searched the web: possible site, phone not on it",
  SEARCH_FAILED: "Web search failed, not checked yet",
  "":            "Not web-checked yet",
};

/* ---------- persistence ---------- */
/* store.byId mirrors the crm table, keyed by Google place id. Entries for leads
   nobody has touched exist only in memory and are never written. */
let store = { byId: {} };

function stateOf(lead) {
  let s = store.byId[lead.id];
  if (!s) {
    s = { status: "new", notes: "", callback: "", log: [], name: lead.name };
    store.byId[lead.id] = s;
  }
  return s;
}
const touched = s => s.status !== "new" || s.notes || s.callback || s.log?.length;

/* Writes for one lead go out in order, each carrying the state at the moment it
   was made. A failed write stays listed under the "not saved" button until a
   retry gets through. */
const queue = {}, unsaved = new Set();
let inflight = 0;
function save(id) {
  const s = store.byId[id];
  const row = { id, state: { status: s.status, notes: s.notes, callback: s.callback,
                             log: s.log, name: s.name },
                updated_at: new Date().toISOString() };
  inflight++;
  queue[id] = (queue[id] || Promise.resolve()).then(async () => {
    const { error } = await sb.from("crm").upsert(row);
    if (error) {
      console.error("save failed", id, error);
      unsaved.add(id);
      toast(`Not saved: ${error.message}`);
    } else {
      unsaved.delete(id);
    }
  }).finally(() => { inflight--; showUnsaved(); });
}
function showUnsaved() {
  const b = document.getElementById("unsaved");
  b.hidden = unsaved.size === 0;
  b.textContent = `⚠ ${unsaved.size} not saved, retry`;
}
document.getElementById("unsaved").onclick = () => [...unsaved].forEach(save);
window.addEventListener("beforeunload", e => {
  flushNotes();
  if (inflight || unsaved.size) e.preventDefault();
});

function logIt(s, msg) {
  s.log.unshift({ t: new Date().toISOString(), m: msg });
  if (s.log.length > 60) s.log.length = 60;
}
const fmtT = iso => iso ? new Date(iso).toLocaleString(undefined,
  { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
/* local calendar date, matching what <input type="date"> stores (toISOString would be UTC) */
const today = () => new Date().toLocaleDateString("sv-SE");
const dueNow = s => s.callback && s.callback <= today() &&
  !["won", "lost", "not_interested"].includes(s.status);

/* ---------- loading ---------- */
/* Supabase returns at most 1000 rows per request */
async function fetchAll(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function loadCrm() {
  const rows = await fetchAll("crm", "id, state", "id");
  store = { byId: Object.fromEntries(rows.map(r => [r.id, r.state])) };
}

/* ---------- sign-in ---------- */
const gate = {
  box: document.getElementById("gate"), msg: document.getElementById("gateMsg"),
  fields: document.getElementById("loginFields"), err: document.getElementById("loginErr"),
  email: document.getElementById("email"), password: document.getElementById("password"),
  btn: document.getElementById("loginBtn"),
};
function showGate(msg, withFields = true) {
  document.getElementById("app").hidden = true;
  gate.box.hidden = false;
  gate.msg.textContent = msg;
  gate.fields.hidden = !withFields;
  gate.err.textContent = "";
}
try { gate.email.value = localStorage.getItem("ro-leads-email") || ""; } catch (e) {}

document.getElementById("loginForm").onsubmit = async e => {
  e.preventDefault();
  gate.btn.disabled = true; gate.err.textContent = "";
  const { error } = await sb.auth.signInWithPassword({
    email: gate.email.value.trim(), password: gate.password.value });
  gate.btn.disabled = false;
  if (error) { gate.err.textContent = error.message; return; }
  try { localStorage.setItem("ro-leads-email", gate.email.value.trim()); } catch (e) {}
  gate.password.value = "";
  openApp();
};
document.getElementById("signOut").onclick = async () => {
  flushNotes();
  await Promise.all(Object.values(queue));
  if (unsaved.size && !confirm(`${unsaved.size} change(s) are not saved. Sign out anyway?`)) return;
  await sb.auth.signOut();
  LEADS = []; store = { byId: {} };
  showGate("Signed out.");
};

async function openApp() {
  showGate("Loading leads…", false);
  try {
    const [rows] = await Promise.all([fetchAll("leads", "data", "rank"), loadCrm()]);
    LEADS = rows.map((r, i) => ({ ...r.data, _rank: i }));
  } catch (err) {
    console.error(err);
    return showGate(`Could not load the data: ${err.message}`);
  }
  if (!LEADS.length) {
    return showGate("Signed in, but the database showed no leads. Either push_leads.py " +
      "hasn't run yet, or this account isn't in app_users (see supabase/schema.sql).");
  }
  gate.box.hidden = true;
  document.getElementById("app").hidden = false;
  fillCities();
  render();
}

/* Back on the tab after using another device: pull the latest notes first, so
   this tab doesn't write over them with what it had in memory. */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !LEADS.length) return;
  flushNotes();
  await Promise.all(Object.values(queue));
  if (unsaved.size) return;   // keep the local edits that haven't reached the database
  try { await loadCrm(); } catch (err) { return console.error(err); }
  if (openLead && document.activeElement !== D.dNotes) openDrawer(openLead.id);
  else render();
});

/* ---------- helpers ---------- */
const strip = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* links from the data only open as http(s), never javascript: */
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : "";
function mapsLink(l) {
  if (safeUrl(l.mapsUrl)) return l.mapsUrl;   // direct place page (Google-sourced rows)
  const q = [l.name, l.address, l.city].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
const pinLink = l => (l.lat && l.lon)
  ? `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}` : "";
const searchLink = l => `https://www.google.com/search?q=${encodeURIComponent(`"${l.name}" ${l.city}`)}`;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1600);
}
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

/* ---------- filters & sorting ---------- */
const els = Object.fromEntries(["q","fCity","fCat","fLead","fSort","fStatus","count","kpis",
  "thead","tbody","empty","datasub"].map(id => [id, document.getElementById(id)]));
let sortKey = "_rank", sortDir = 1, selectedId = null, kpiFilter = null;

/* keys match CATEGORIES in config.py */
const CAT_INFO = {
  dentist:     { icon: "🦷", label: "Dentist" },
  aesthetic:   { icon: "💉", label: "Aesthetic / derma" },
  renovation:  { icon: "🏗️", label: "Renovation / build" },
  event_venue: { icon: "🎉", label: "Event venue" },
  furniture:   { icon: "🪑", label: "Custom furniture" },
  roofing:     { icon: "🏠", label: "Roofing" },
  hvac_solar:  { icon: "❄️", label: "HVAC / solar" },
  windows:     { icon: "🪟", label: "Windows / doors" },
  clinic:      { icon: "🩺", label: "Private clinic" },
  veterinary:  { icon: "🐾", label: "Vet" },
  auto:        { icon: "🚗", label: "Auto repair / body" },
  physio:      { icon: "🏃", label: "Physio / rehab" },
  lawyer:      { icon: "⚖️", label: "Lawyer" },
};
function catChip(cat) {
  const normCat = (cat || "").toLowerCase().trim();
  const info = CAT_INFO[normCat] || { icon: "🏢", label: cat };
  const cls = "chip-" + normCat.replace(/[^a-z0-9]+/g, "-");
  return `<span class="chip ${cls}">${info.icon} ${esc(info.label)}</span>`;
}

/* city dropdown: scanned cities, largest population first */
let cityCounts = {};
function fillCities() {
  cityCounts = {};
  const cityPop = {};
  LEADS.forEach(l => { cityCounts[l.city] = (cityCounts[l.city] || 0) + 1; cityPop[l.city] = l.cityPop || 0; });
  const cityNames = Object.keys(cityCounts).sort((a, b) => (cityPop[b] - cityPop[a]) || a.localeCompare(b, "ro"));
  els.fCity.innerHTML = `<option value="">All cities (${LEADS.length})</option>` +
    cityNames.map(c => `<option value="${esc(c)}">${esc(c)} (${cityCounts[c]})</option>`).join("");
  els.fCity.value = lsGet("ro-leads-city") ?? (cityNames[0] || "");
  if (els.fCity.value && !cityCounts[els.fCity.value]) els.fCity.value = "";
}
els.fCity.onchange = () => { lsSet("ro-leads-city", els.fCity.value); render(); };
const cityLeads = () => els.fCity.value ? LEADS.filter(l => l.city === els.fCity.value) : LEADS;

/* business type dropdown. Order is fixed by the city-wide count so it doesn't jump around;
   the number shown is how many leads of that type pass every other filter. */
let catHtml = "";
function fillCats() {
  const total = {};
  cityLeads().forEach(l => total[l.category] = (total[l.category] || 0) + 1);
  const shown = {};
  filtered(true).forEach(l => shown[l.category] = (shown[l.category] || 0) + 1);
  const cats = Object.keys(total).sort((a, b) => (total[b] - total[a]) || a.localeCompare(b, "ro"));
  const html = `<option value="">Business Type: all</option>` +
    cats.map(c => {
      const info = CAT_INFO[c.toLowerCase().trim()] || { icon: "🏢", label: c };
      return `<option value="${esc(c)}">${info.icon} ${esc(info.label)} (${shown[c] || 0})</option>`;
    }).join("");
  if (html !== catHtml) {
    const keep = els.fCat.value;
    els.fCat.innerHTML = catHtml = html;
    els.fCat.value = total[keep] ? keep : "";   // a type this city doesn't have resets to all
  }
}
els.fStatus.innerHTML = `<option value="">Status: all</option>` +
  STATUSES.map(([k,, l]) => `<option value="${k}">${l}</option>`).join("");

els.fSort.onchange = () => {
  sortKey = els.fSort.value;
  sortDir = NUMERIC.includes(sortKey) ? -1 : 1;
  render();
};

const COLS = [
  ["name", "Business"], ["category", "Business Type"], ["phone", "Phone"],
  ["score", "Score"], ["lead", "Website"], ["rating", "Rating"], ["reviews", "Reviews"],
  ["status", "Call status"], ["callback", "Callback"], ["updated", "Last activity"],
  ["notes", "Notes"],
];
const NUMERIC = ["reviews", "rating", "score"];
els.thead.innerHTML = "<tr>" + COLS.map(([k, l]) =>
  `<th data-k="${k}">${l} <span class="dir"></span></th>`).join("") + "</tr>";
els.thead.querySelectorAll("th").forEach(th => th.onclick = () => {
  const k = th.dataset.k;
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
  if (Array.from(els.fSort.options).some(o => o.value === k)) els.fSort.value = k;
  render();
});

function enrich(l) {
  const s = stateOf(l);
  return { ...l, lead: leadVerdict(l), status: s.status, notes: s.notes,
           callback: s.callback, updated: s.log[0]?.t || "", due: dueNow(s) };
}
/* skipCat leaves out the business type filter, so the dropdown can count each type */
function filtered(skipCat) {
  const q = strip(els.q.value.trim());
  return cityLeads().map(enrich).filter(l => {
    if (q && !(strip(l.name).includes(q) || strip(l.address).includes(q) ||
               (l.phone || "").replace(/\s/g, "").includes(q.replace(/\s/g, "")))) return false;
    if (!skipCat && els.fCat.value && l.category !== els.fCat.value) return false;
    if (els.fLead.value && l.lead !== els.fLead.value) return false;
    if (els.fStatus.value && l.status !== els.fStatus.value) return false;
    if (kpiFilter === "due" && !l.due) return false;
    if (kpiFilter === "fresh" && l.status !== "new") return false;
    if (kpiFilter === "pipeline" && !["interested", "meeting", "callback"].includes(l.status)) return false;
    if (kpiFilter === "won" && l.status !== "won") return false;
    if (kpiFilter === "none" && l.lead !== "none") return false;
    return true;
  });
}
function sorted(rows) {
  const dir = sortDir;
  return rows.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (NUMERIC.includes(sortKey)) { x = x || 0; y = y || 0; return (x - y) * dir || a._rank - b._rank; }
    if (sortKey === "lead") return (LV[x].rank - LV[y].rank) * dir || a._rank - b._rank;
    if (sortKey === "category") {
      const cmp = String(x ?? "").localeCompare(String(y ?? ""), "ro");
      if (cmp !== 0) return cmp * dir;
      return a._rank - b._rank;
    }
    if (sortKey === "status") {
      const r = Object.fromEntries(STATUSES.map(([k], i) => [k, i]));
      return (r[x] - r[y]) * dir;
    }
    x = String(x ?? ""); y = String(y ?? "");
    if (!x && y) return 1; if (x && !y) return -1;
    return x.localeCompare(y, "ro") * dir || a._rank - b._rank;
  });
}

/* ---------- render ---------- */
function badge(cls, icon, label) {
  return `<span class="badge ${cls}">${icon} ${esc(label)}</span>`;
}
const stOf = k => ST[k] || ST.new;
const ROW_CAP = 1500;
function render() {
  fillCats();
  const rows = sorted(filtered());
  const shown = rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows;
  els.thead.querySelectorAll("th").forEach(th => {
    th.querySelector(".dir").textContent =
      th.dataset.k === sortKey ? (sortDir === 1 ? "▲" : "▼") : "";
  });
  els.tbody.innerHTML = shown.map(l => `
    <tr data-id="${esc(l.id)}" class="${l.id === selectedId ? "sel" : ""} ${l.due ? "due" : ""}">
      <td><div class="name">${esc(l.name)}</div><div class="addr">${esc(l.address)}</div></td>
      <td>${catChip(l.category)}</td>
      <td>${l.phone ? `<a class="tel" href="tel:${esc(l.phone.replace(/\s/g, ""))}">${esc(l.phone)}</a>` : `<span class="addr">n/a</span>`}</td>
      <td class="num" title="${esc((l.why || []).join("\n"))}">${esc(l.score ?? "")}</td>
      <td>${badge("lv-" + l.lead, LV[l.lead].icon, LV[l.lead].label)}</td>
      <td class="num">${esc(l.rating ?? "")}</td>
      <td class="num">${esc(l.reviews ?? "")}</td>
      <td>${badge("st-" + esc(l.status), stOf(l.status).icon, stOf(l.status).label)}</td>
      <td class="num">${l.callback ? (l.due ? "⚠ " : "") + esc(l.callback) : ""}</td>
      <td class="num">${fmtT(l.updated)}</td>
      <td><div class="notesprev">${esc(l.notes)}</div></td>
    </tr>`).join("");
  els.empty.hidden = rows.length > 0;
  els.count.textContent = (rows.length > ROW_CAP ? `showing ${ROW_CAP} of ` : "") +
    `${rows.length} / ${cityLeads().length} leads`;
  els.datasub.textContent = `${els.fCity.value || "all of Romania"} · ${cityLeads().length} leads`;
  renderKpis();
}
function renderKpis() {
  const all = cityLeads().map(enrich);
  const k = {
    total:    [all.length, "Total leads", null],
    none:     [all.filter(l => l.lead === "none").length, "No website at all", "none"],
    fresh:    [all.filter(l => l.status === "new").length, "Not yet called", "fresh"],
    due:      [all.filter(l => l.due).length, "⚠ Callbacks due", "due"],
    pipeline: [all.filter(l => ["interested", "meeting", "callback"].includes(l.status)).length, "In pipeline", "pipeline"],
    won:      [all.filter(l => l.status === "won").length, "🏆 Won", "won"],
  };
  els.kpis.innerHTML = Object.values(k).map(([v, label, f]) =>
    `<div class="kpi ${kpiFilter && kpiFilter === f ? "active" : ""}" data-f="${f ?? ""}">
       <div class="v">${v}</div><div class="l">${label}</div></div>`).join("");
  els.kpis.querySelectorAll(".kpi").forEach(el => el.onclick = () => {
    kpiFilter = (el.dataset.f && kpiFilter !== el.dataset.f) ? el.dataset.f : null;
    render();
  });
}

/* ---------- drawer ---------- */
const D = Object.fromEntries(["drawer","dName","dMeta","dActions","dStatus","dCallback",
  "dNotes","dSaved","dInfo","dLog","dClose","dEmpty","dContent"].map(id => [id, document.getElementById(id)]));
let openLead = null, notesTimer = null;

function openDrawer(id) {
  flushNotes();
  openLead = LEADS.find(l => l.id === id);
  if (!openLead) return;
  selectedId = id;
  const l = openLead, s = stateOf(l);
  D.dName.textContent = l.name;
  D.dMeta.textContent = `${(CAT_INFO[l.category] || { label: l.category }).label} · ` +
    `${l.address || "no address"} · ${l.city}` +
    (l.county && l.county !== l.city ? ` (${l.county})` : "");
  D.dActions.innerHTML =
    (l.phone ? `<a class="call" href="tel:${esc(l.phone.replace(/\s/g, ""))}">📞 Call ${esc(l.phone)}</a>` : "") +
    `<a href="${esc(mapsLink(l))}" target="_blank" rel="noopener">🗺 Maps</a>` +
    (pinLink(l) ? `<a href="${esc(pinLink(l))}" target="_blank" rel="noopener" title="Exact location pin, in case the name search finds the wrong place">📍 Pin</a>` : "") +
    `<a href="${esc(searchLink(l))}" target="_blank" rel="noopener">🔎 Google them</a>` +
    (safeUrl(l.website) ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">📱 Listed link</a>` : "") +
    (safeUrl(l.possibleSite) ? `<a href="${esc(l.possibleSite)}" target="_blank" rel="noopener">❓ Possible site</a>` : "");
  D.dCallback.value = s.callback || "";
  D.dNotes.value = s.notes || "";
  const lv = leadVerdict(l);
  D.dInfo.innerHTML = [
    ["Website", `${LV[lv].icon} ${LV[lv].label}` + (l.website ? ` (${l.website})` : "")],
    ["Web check", WEB_CHECK[l.webCheck || ""] || l.webCheck],
    ["Rating", l.rating ? `${l.rating} ★ (${l.reviews} reviews)` : "n/a"],
    ["Close score", l.score != null ? `${l.score} / 100` : "n/a"],
    ["Google type", l.primaryType || "n/a"],
    ["Phone", l.phone || "n/a"],
    ["First seen", l.firstSeen || "n/a"],
    ["Last seen in a search", l.lastSeen || "n/a"],
  ].map(([k, v]) => `<div><b>${k}</b> ${esc(v)}</div>`).join("") +
    (l.why?.length ? `<div><b>Why this score</b><ul class="why">` +
      l.why.map(w => `<li>${esc(w)}</li>`).join("") + `</ul></div>` : "");
  renderStatusGrid(s); renderLog(s);
  D.dEmpty.hidden = true; D.dContent.hidden = false;
  D.drawer.classList.add("open");
  render();
}
function renderStatusGrid(s) {
  D.dStatus.innerHTML = STATUSES.map(([k, icon, label]) =>
    `<button class="st-${k} ${s.status === k ? "on" : ""}" data-st="${k}">${icon} ${label}</button>`).join("");
  D.dStatus.querySelectorAll("button").forEach(b => b.onclick = () => {
    const k = b.dataset.st;
    if (s.status !== k) {
      s.status = k; logIt(s, `Status → ${ST[k].label}`); save(openLead.id);
      renderStatusGrid(s); renderLog(s); render(); toast(`${ST[k].icon} ${ST[k].label}`);
    }
  });
}
function renderLog(s) {
  D.dLog.innerHTML = s.log.length
    ? s.log.map(e => `<li><time>${fmtT(e.t)}</time>${esc(e.m)}</li>`).join("")
    : `<li>No activity yet.</li>`;
}
D.dClose.onclick = () => {
  flushNotes();
  D.drawer.classList.remove("open"); selectedId = null; openLead = null;
  D.dContent.hidden = true; D.dEmpty.hidden = false; render();
};
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !document.getElementById("app").hidden) D.dClose.onclick();
});
D.dCallback.onchange = () => {
  const s = stateOf(openLead);
  s.callback = D.dCallback.value;
  logIt(s, s.callback ? `Callback set for ${s.callback}` : "Callback cleared");
  save(openLead.id); renderLog(s); render();
};
/* notes save 800 ms after typing stops; the pending save is bound to the lead
   being typed on, and flushed before the drawer switches to another lead */
let pendingNotes = null;
function flushNotes() {
  clearTimeout(notesTimer);
  if (!pendingNotes) return;
  const { lead, text } = pendingNotes;
  pendingNotes = null;
  stateOf(lead).notes = text; save(lead.id); render();
  D.dSaved.style.visibility = "visible";
  setTimeout(() => D.dSaved.style.visibility = "hidden", 1200);
}
D.dNotes.oninput = () => {
  if (!openLead) return;
  clearTimeout(notesTimer);
  pendingNotes = { lead: openLead, text: D.dNotes.value };
  notesTimer = setTimeout(flushNotes, 800);
};
els.tbody.addEventListener("click", e => {
  if (e.target.closest("a")) return;   // the phone link dials, it doesn't open the row
  const tr = e.target.closest("tr");
  if (tr) openDrawer(tr.dataset.id);
});

/* ---------- header actions ---------- */
[els.q, els.fCat, els.fLead, els.fSort, els.fStatus].forEach(el => el.addEventListener("input", render));
document.getElementById("clear").onclick = () => {
  els.q.value = "";
  [els.fCat, els.fLead, els.fStatus].forEach(el => el.value = "");
  els.fSort.value = "_rank";
  sortKey = "_rank"; sortDir = 1;
  kpiFilter = null; render();
};
document.getElementById("exportCsv").onclick = () => {
  const rows = sorted(filtered());
  const cols = ["name","city","county","category","phone","address","lead","website",
                "rating","reviews","score","why","status","callback","notes","mapsUrl"];
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => {
    const v = Array.isArray(r[c]) ? r[c].join("; ") : String(r[c] ?? "");
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))).join("\r\n");
  download(new Blob(["﻿" + csv], { type: "text/csv" }), `ro-leads-${today()}.csv`);
  toast("CSV exported");
};
/* same { byId } format as the offline dashboard's backup, so files work both ways */
document.getElementById("exportJson").onclick = () => {
  const byId = Object.fromEntries(Object.entries(store.byId).filter(([, s]) => touched(s)));
  download(new Blob([JSON.stringify({ byId }, null, 1)], { type: "application/json" }),
           `ro-leads-backup-${today()}.json`);
  toast("Backup saved");
};
document.getElementById("importJson").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  e.target.value = "";
  let entries;
  try {
    const data = JSON.parse(await f.text());
    if (!data.byId) throw new Error("bad file");
    // the offline dashboard stored an empty entry for every lead it rendered
    entries = Object.entries(data.byId).filter(([, s]) => s && touched(s));
  } catch (err) { return toast("Could not read that backup file"); }
  const now = new Date().toISOString();
  const rows = entries.map(([id, s]) => ({ id, updated_at: now, state: {
    status: ST[s.status] ? s.status : "new", notes: s.notes || "", callback: s.callback || "",
    log: Array.isArray(s.log) ? s.log : [], name: s.name || "" } }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("crm").upsert(rows.slice(i, i + 500));
    if (error) return toast(`Restore stopped after ${i} entries: ${error.message}`);
  }
  await loadCrm();
  if (openLead) openDrawer(openLead.id); else render();
  toast(`Restored ${rows.length} leads' notes`);
};
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}
const themeBtn = document.getElementById("theme");
if (new URLSearchParams(location.search).get("theme") === "dark" ||
    lsGet("cluj-crm-theme") === "dark" ||
    (!lsGet("cluj-crm-theme") && matchMedia("(prefers-color-scheme: dark)").matches))
  document.documentElement.classList.add("dark");
themeBtn.onclick = () => {
  const dark = document.documentElement.classList.toggle("dark");
  lsSet("cluj-crm-theme", dark ? "dark" : "light");
};

/* signed in on this device before: skip the form */
sb.auth.getSession().then(({ data }) => data.session ? openApp() : showGate("Sign in to see the leads."));
sb.auth.onAuthStateChange(event => {
  if (event === "SIGNED_OUT" && LEADS.length) { LEADS = []; showGate("Your session ended. Sign in again."); }
});
