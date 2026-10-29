"use strict";
/* The cold-call CRM, hosted. Same interface as the offline dashboard_template.html,
   but the leads and the call notes live in Supabase behind a sign-in.
   This file is public: it holds no data and no secret. The publishable key below
   is meant to ship in pages; without a signed-in account listed in app_users,
   the database returns nothing (see supabase/schema.sql). */
/* GitHub Pages enforces https and answers http with a 301 before this script loads.
   This is a fallback in case that setting is ever turned off. The sign-in belongs on https */
if (location.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  location.replace("https:" + location.href.slice(5));

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
  ["has_builder",    "🔨", "Has another builder"],
  ["lost",          "✖", "Lost"],
];
const ST = Object.fromEntries(STATUSES.map(([k, i, l]) => [k, { icon: i, label: l }]));
/* Steps after the call, ticked in the detail panel. Each one stores the time it
   was ticked in state.stages; the furthest one ticked is the lead's stage. Sales
   and project steps happen in this order. Launch steps come after the project is
   done, in whatever order the client gets to them. */
const STAGES = [
  ["demo_requested",  "Demo requested",          "Sales"],
  ["demo_sent",       "Demo sent",               "Sales"],
  ["offer_sent",      "Offer sent",              "Sales"],
  ["followup_1",      "Follow-up sent",          "Sales"],
  ["followup_2",      "2nd follow-up sent",      "Sales"],
  ["agreed",          "Said yes",                "Sales"],
  ["deposit_asked",   "Asked for 50% upfront",   "Project"],
  ["deposit_paid",    "50% upfront paid",        "Project"],
  ["in_progress",     "Project started",         "Project"],
  ["completed",       "Project completed",       "Project"],
  ["final_asked",     "Asked for the other 50%", "Launch"],
  ["domain",          "Domain ready",            "Launch"],
  ["hosting",         "Hosting ready",           "Launch"],
  ["published",       "Published",               "Launch"],
  ["paid_full",       "Paid in full",            "Launch"],
  ["closed_inactive", "Closed, no reply",        ""],
];
const STG = Object.fromEntries(STAGES.map(([k, l, p], i) => [k, { label: l, phase: p, rank: i + 1 }]));
const lastStage = s => STAGES.reduce((last, [k]) => s.stages?.[k] ? k : last, "");
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

const blank = name => ({ status: "new", notes: "", callback: "", log: [], stages: {}, name });
function stateOf(lead) {
  let s = store.byId[lead.id];
  if (!s) {
    s = blank(lead.name);
    store.byId[lead.id] = s;
  }
  return s;
}
const touched = s => s.status !== "new" || s.notes || s.callback || s.phone || s.log?.length ||
  Object.keys(s.stages || {}).length;
/* a number typed into the detail panel wins over the one from Google Maps. It
   lives in crm, not leads, so push_leads.py can't overwrite it */
const phoneOf = l => stateOf(l).phone || l.phone || "";
/* rows saved before stages existed have none */
const normState = s => ({ ...s, stages: s.stages && typeof s.stages === "object" ? s.stages : {} });

/* Writes for one lead go out in order, each carrying the lead's state when it
   goes out. A failed write stays listed under the "not saved" button until a
   retry gets through. */
const queue = {}, unsaved = new Set(), writing = {};
/* editSeq counts saves; editedAt holds the count at each lead's last save, so a
   refresh can tell which leads were edited after its fetch began */
const editedAt = {};
let inflight = 0, editSeq = 0;
/* base[id] is the lead's state as this tab last read or wrote it, ver[id] that
   row's updated_at. A write only lands if the row still has ver[id]. If another
   device saved the lead in between, the write misses: the tab fetches the newer
   row, lays the fields it changed since base over it, and writes again. Without
   this, a device that hadn't polled yet wrote back its old copy of the fields
   it didn't touch. */
const base = {}, ver = {};
const clone = s => JSON.parse(JSON.stringify(s));
const rowState = s => ({ status: s.status, notes: s.notes, callback: s.callback,
                         log: s.log, stages: s.stages, name: s.name, phone: s.phone });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mergeInto(local, from, remote) {
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (k === "log") {
      const seen = new Set(), all = [...(local.log || []), ...(remote.log || [])];
      local.log = all.filter(e => !seen.has(e.t + e.m) && seen.add(e.t + e.m))
        .sort((a, b) => b.t.localeCompare(a.t)).slice(0, 60);
    } else if (k === "stages") {
      const st = { ...remote.stages }, mine = local.stages || {}, was = from.stages || {};
      for (const s of new Set([...Object.keys(mine), ...Object.keys(was)]))
        if (!same(mine[s], was[s])) { if (mine[s]) st[s] = mine[s]; else delete st[s]; }
      local.stages = st;
    } else if (same(local[k], from[k])) {
      if (remote[k] === undefined) delete local[k]; else local[k] = remote[k];
    }
  }
}
async function write(id) {
  for (let tries = 0; tries < 5; tries++) {
    const state = clone(rowState(store.byId[id])), updated_at = new Date().toISOString();
    const { data, error } = ver[id]
      ? await sb.from("crm").update({ state, updated_at }).eq("id", id).eq("updated_at", ver[id]).select("updated_at")
      : await sb.from("crm").insert({ id, state, updated_at }).select("updated_at");
    // 23505: another device created the row first
    if (error && error.code !== "23505") return error;
    if (!error && data.length) { base[id] = state; ver[id] = data[0].updated_at; return null; }
    const got = await sb.from("crm").select("state, updated_at").eq("id", id);
    if (got.error) return got.error;
    if (!got.data.length) { delete ver[id]; continue; }
    const remote = normState(got.data[0].state);
    // a lead this tab has never seen saved started out blank, so only changes from blank are its own
    mergeInto(store.byId[id], base[id] || blank(store.byId[id].name), remote);
    base[id] = remote; ver[id] = got.data[0].updated_at;
    if (openLead?.id === id) refreshDrawer();
    render();
  }
  return { message: "another device kept saving this lead, try again" };
}
function save(id) {
  editedAt[id] = ++editSeq;
  inflight++;
  writing[id] = (writing[id] || 0) + 1;
  queue[id] = (queue[id] || Promise.resolve()).then(async () => {
    const error = await write(id);
    if (error) {
      console.error("save failed", id, error);
      unsaved.add(id);
      toast(`Not saved: ${error.message}`);
    } else {
      unsaved.delete(id);
    }
  }).finally(() => {
    inflight--;
    if (!--writing[id]) delete writing[id];
    showUnsaved();
  });
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
  !["won", "lost", "not_interested", "has_builder"].includes(s.status) && !s.stages?.closed_inactive;

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
  const startSeq = editSeq;
  const rows = await fetchAll("crm", "id, state, updated_at", "id");
  // same rule as refreshCrm: a lead with a save still out, failed, or made during the fetch keeps its local copy
  const prev = store.byId, mine = id => prev[id] &&
    (writing[id] || unsaved.has(id) || (editedAt[id] || 0) > startSeq);
  store = { byId: Object.fromEntries(rows.map(r => [r.id, normState(r.state)])) };
  for (const r of rows)
    if (mine(r.id)) store.byId[r.id] = prev[r.id];
    else { base[r.id] = normState(clone(r.state)); ver[r.id] = r.updated_at; }
  for (const id of Object.keys(prev)) if (!store.byId[id] && mine(id)) store.byId[id] = prev[id];
}

/* Pull what other devices saved. A lead with a write of this tab's still on its
   way, failed, or notes typed and not yet sent keeps the local copy, so the
   refresh never undoes an edit made here. So does a lead saved after the fetch
   began, even if that save already finished: the fetched row predates it.
   Returns the ids that changed. */
let refreshing = false;
async function refreshCrm() {
  if (refreshing || !LEADS.length) return [];
  refreshing = true;
  try {
    const startSeq = editSeq;
    const rows = await fetchAll("crm", "id, state, updated_at", "id");
    const changed = [];
    for (const r of rows) {
      if (writing[r.id] || unsaved.has(r.id) || pendingNotes?.lead.id === r.id) continue;
      if ((editedAt[r.id] || 0) > startSeq) continue;
      const remote = normState(r.state), local = store.byId[r.id];
      base[r.id] = normState(clone(r.state)); ver[r.id] = r.updated_at;
      if (local && JSON.stringify(local) === JSON.stringify(remote)) continue;
      store.byId[r.id] = remote;
      changed.push(r.id);
    }
    return changed;
  } finally {
    refreshing = false;
  }
}
async function syncNow() {
  let changed;
  try { changed = await refreshCrm(); } catch (err) { return console.error(err); }
  if (!changed.length) return;
  if (openLead && changed.includes(openLead.id)) refreshDrawer();
  render();
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
  leadById = new Map(LEADS.map(l => [l.id, l]));
  gate.box.hidden = true;
  document.getElementById("app").hidden = false;
  fillCities();
  setView(view);
}

/* Other devices' changes show up within SYNC_MS while the tab is open, and at
   once when you come back to it, so this tab doesn't write over them with what
   it had in memory. */
const SYNC_MS = 15000;
setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, SYNC_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncNow();
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
const els = Object.fromEntries(["q","qMore","fCity","fCat","fLead","fSort","fStatus","fStage","count","kpis",
  "thead","tbody","empty","datasub"].map(id => [id, document.getElementById(id)]));
let sortKey = "_rank", sortDir = 1, selectedId = null, kpiFilter = null;

/* One search box serves both views. Every word typed has to appear in the name
   or address, in any order, ignoring accents and punctuation: "smile dental"
   finds "Dental-Smile S.R.L.". A query of digits and phone punctuation also
   checks the phone numbers digit by digit, reading +40 and 0040 as the leading 0,
   so "+40 744 123 456", "0744-123-456" and "744 123" all find "0744 123 456".
   Returns null when there is nothing to search for. */
const compact = s => strip(s).replace(/[^a-z0-9]/g, "");
const dialDigits = p => String(p || "").replace(/^\s*(\+|00)\s*40/, "0").replace(/\D/g, "")
  .replace(/^40(?=\d{9}$)/, "0");
function searcher(raw) {
  const q = raw.trim();
  const words = strip(q).split(/\s+/).map(compact).filter(Boolean);
  if (!words.length) return null;
  const dial = /^[+\d\s().\/-]+$/.test(q) ? dialDigits(q) : "";
  return (name, address, ...phones) => {
    if (dial && phones.some(p => dialDigits(p).includes(dial))) return true;
    // street numbers would turn up for every phone fragment, so a number only checks the name
    const hay = compact(name) + " " + (dial ? "" : compact(address));
    return words.every(w => hay.includes(w));
  };
}
/* both numbers count: the one typed into the detail panel and the one on Maps */
const leadHit = (find, l) => find(l.name, l.address, stateOf(l).phone, l.phone);
/* the city and the other filters can hide the business you're looking for */
function showAllMatches() {
  els.fCity.value = ""; lsSet("ro-leads-city", "");
  [els.fCat, els.fLead, els.fStatus, els.fStage].forEach(el => el.value = "");
  kpiFilter = null;
  setView("list");
}
els.qMore.onclick = showAllMatches;
/* Escape empties the search box before it closes the detail panel */
els.q.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !els.q.value) return;
  e.preventDefault(); e.stopPropagation();
  els.q.value = ""; render();
});

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
els.fStage.innerHTML = `<option value="">Pipeline: all</option><option value="-">Pipeline: nothing ticked</option>` +
  STAGES.map(([k, l]) => `<option value="${k}">At: ${l}</option>`).join("");

els.fSort.onchange = () => {
  sortKey = els.fSort.value;
  sortDir = NUMERIC.includes(sortKey) ? -1 : 1;
  render();
};

const COLS = [
  ["name", "Business"], ["category", "Business Type"], ["phone", "Phone"],
  ["score", "Score"], ["lead", "Website"], ["rating", "Rating"], ["reviews", "Reviews"],
  ["status", "Call status"], ["stage", "Pipeline"], ["callback", "Callback"], ["updated", "Last activity"],
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
  const stage = lastStage(s);
  return { ...l, phone: phoneOf(l), lead: leadVerdict(l), status: s.status, notes: s.notes,
           callback: s.callback, updated: s.log[0]?.t || "", due: dueNow(s),
           stage, stageAt: stage ? s.stages[stage] : "" };
}
/* skipCat leaves out the business type filter, so the dropdown can count each type */
function filtered(skipCat) {
  const find = searcher(els.q.value);
  return cityLeads().filter(l => !find || leadHit(find, l)).map(enrich).filter(l => {
    if (!skipCat && els.fCat.value && l.category !== els.fCat.value) return false;
    if (els.fLead.value && l.lead !== els.fLead.value) return false;
    if (els.fStatus.value && l.status !== els.fStatus.value) return false;
    if (els.fStage.value && l.stage !== (els.fStage.value === "-" ? "" : els.fStage.value)) return false;
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
    if (sortKey === "stage")   // furthest along first on the first click
      return ((STG[y]?.rank || 0) - (STG[x]?.rank || 0)) * dir || a._rank - b._rank;
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
  if (view === "funnel") return renderFunnel();
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
      <td>${l.stage ? `<span class="badge stg-${l.stage}" title="${esc(fmtT(l.stageAt))}">${esc(STG[l.stage].label)}</span>` : ""}</td>
      <td class="num">${l.callback ? (l.due ? "⚠ " : "") + esc(l.callback) : ""}</td>
      <td class="num">${fmtT(l.updated)}</td>
      <td><div class="notesprev">${esc(l.notes)}</div></td>
    </tr>`).join("");
  els.empty.hidden = rows.length > 0;
  els.count.textContent = (rows.length > ROW_CAP ? `showing ${ROW_CAP} of ` : "") +
    `${rows.length} / ${cityLeads().length} leads`;
  const find = searcher(els.q.value);
  const elsewhere = find ? LEADS.filter(l => leadHit(find, l)).length - rows.length : 0;
  els.qMore.hidden = !elsewhere;
  els.qMore.textContent = `Show ${elsewhere} more outside the filters`;
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

/* ---------- funnel ---------- */
/* The whole pipeline on one screen, across all cities: how many leads reached
   each step, what got done lately, and who is waiting on a next move from you. */
let view = lsGet("ro-leads-view") === "funnel" ? "funnel" : "list";
const LINEAR = STAGES.filter(([, , p]) => p === "Sales" || p === "Project").map(([k]) => k);
const LAUNCH = STAGES.filter(([, , p]) => p === "Launch").map(([k]) => k);
/* how far along the sales and project steps a lead is, 0 = nothing ticked.
   Any launch step ticked means the project is done. */
function progress(s) {
  if (LAUNCH.some(k => s.stages[k])) return LINEAR.length;
  return LINEAR.reduce((r, k, i) => s.stages[k] ? i + 1 : r, 0);
}
const reached = (s, k) => progress(s) >= LINEAR.indexOf(k) + 1;
const latest = (s, ...ks) => ks.map(k => s.stages[k]).filter(Boolean).sort().pop() || "";
const dead = s => !!s.stages.closed_inactive || ["lost", "not_interested", "has_builder"].includes(s.status);
const atStep = (s, ...ks) => ks.includes(LINEAR[progress(s) - 1]);

/* Each list says what to do next. `since` returns when the lead landed there
   (null keeps it out); after `late` days it's flagged overdue. */
const TODO = [
  { phase: "Sales", title: "Call back", late: 0, hint: "Callback date is today or earlier.",
    since: s => dueNow(s) ? s.callback : null },
  { phase: "Sales", title: "Interested, offer a demo", late: 2,
    hint: "Marked interested or meeting set, no step ticked yet.",
    since: s => ["interested", "meeting"].includes(s.status) && !progress(s) && !dead(s)
      ? s.log[0]?.t || "" : null },
  { phase: "Sales", title: "Make and send the demo", late: 2, hint: "They asked for a demo.",
    since: s => atStep(s, "demo_requested") ? s.stages.demo_requested : null },
  { phase: "Sales", title: "Ask what they think of the demo", late: 3, hint: "Demo sent, no offer yet.",
    since: s => atStep(s, "demo_sent") ? s.stages.demo_sent : null },
  { phase: "Sales", title: "Follow up on the offer", late: 4, hint: "Offer sent, no yes yet.",
    since: s => atStep(s, "offer_sent", "followup_1", "followup_2")
      ? latest(s, "offer_sent", "followup_1", "followup_2") : null,
    note: s => s.stages.followup_2 ? "2 follow-ups sent" : s.stages.followup_1 ? "1 follow-up sent" : "" },
  { phase: "Sales", title: "Ask for 50% upfront", late: 1, hint: "They said yes.",
    since: s => atStep(s, "agreed") ? s.stages.agreed : null },
  { phase: "Project", title: "Waiting for 50% upfront", late: 5, hint: "Asked, not paid yet.",
    since: s => atStep(s, "deposit_asked") ? s.stages.deposit_asked : null },
  { phase: "Project", title: "Build the site", late: 14, hint: "Deposit paid, project not completed.",
    since: s => atStep(s, "deposit_paid", "in_progress") ? s.stages.deposit_paid || s.stages.in_progress : null,
    note: s => s.stages.in_progress ? "started" : "not started" },
  { phase: "Launch", title: "Ask for the other 50%", late: 1, hint: "Project completed, final payment not asked for.",
    since: s => progress(s) === LINEAR.length && !s.stages.final_asked && !s.stages.paid_full
      ? s.stages.completed || "" : null },
  { phase: "Launch", title: "Waiting for the other 50%", late: 5, hint: "Asked, not paid in full yet.",
    since: s => s.stages.final_asked && !s.stages.paid_full ? s.stages.final_asked : null },
  { phase: "Launch", title: "Waiting for the domain", late: 5, hint: "Project completed, domain not ready.",
    since: s => progress(s) === LINEAR.length && !s.stages.domain ? s.stages.completed || "" : null },
  { phase: "Launch", title: "Waiting for hosting", late: 5, hint: "Project completed, hosting not ready.",
    since: s => progress(s) === LINEAR.length && !s.stages.hosting ? s.stages.completed || "" : null },
  { phase: "Launch", title: "Publish the site", late: 1, hint: "Domain and hosting ready, not published.",
    since: s => s.stages.domain && s.stages.hosting && !s.stages.published ? latest(s, "domain", "hosting") : null },
  { phase: "Done", title: "Published and paid in full", late: Infinity, hint: "Finished. Newest first.",
    since: s => s.stages.published && s.stages.paid_full ? latest(s, "published", "paid_full") : null },
];

/* when the lead landed on list b, null if it isn't on it. Closed, lost and
   not-interested leads need nothing more from you */
const sinceIn = (b, s) => b.phase === "Done" || !dead(s) ? b.since(s) : null;

/* cumulative: a lead counts for every step up to the furthest one it reached.
   Published and paid in full happen in either order, so both compare to completed. */
const FUNNEL = [
  ["Called",            s => s.status !== "new" || progress(s) > 0],
  ["Interested",        s => ["interested", "meeting", "won"].includes(s.status) || progress(s) > 0],
  ["Demo requested",    s => reached(s, "demo_requested")],
  ["Demo sent",         s => reached(s, "demo_sent")],
  ["Offer sent",        s => reached(s, "offer_sent")],
  ["Said yes",          s => reached(s, "agreed")],
  ["50% upfront paid",  s => reached(s, "deposit_paid")],
  ["Project completed", s => reached(s, "completed")],
  ["Published",         s => !!s.stages.published, "Project completed"],
  ["Paid in full",      s => !!s.stages.paid_full, "Project completed"],
];

/* what got done today, this week, this month. Calls are status changes in the log. */
const ACTIVITY = [
  ["Calls logged",     s => s.log.filter(e => e.m.startsWith("Status →") && !e.m.endsWith("New")).map(e => e.t)],
  ["Demos sent",       s => [s.stages.demo_sent]],
  ["Offers sent",      s => [s.stages.offer_sent]],
  ["Follow-ups sent",  s => [s.stages.followup_1, s.stages.followup_2]],
  ["Said yes",         s => [s.stages.agreed]],
  ["50% upfront paid", s => [s.stages.deposit_paid]],
  ["Published",        s => [s.stages.published]],
  ["Paid in full",     s => [s.stages.paid_full]],
];

/* whole days since an ISO time or a yyyy-mm-dd date, by the local calendar */
function daysSince(t) {
  if (!t) return null;
  const d = new Date(t.length === 10 ? t + "T00:00" : t);
  return Math.round((new Date(today() + "T00:00") - new Date(d.toLocaleDateString("sv-SE") + "T00:00")) / 864e5);
}

let leadById = new Map();
const F = document.getElementById("funnel");
function renderFunnel() {
  els.datasub.textContent = `pipeline across all cities · ${LEADS.length} leads on the list`;
  // leads that dropped off the list still have their notes in crm, so count them too
  const find = searcher(els.q.value);
  const people = Object.entries(store.byId).filter(([, s]) => touched(s)).map(([id, s]) => {
    const l = leadById.get(id), name = l?.name || s.name || id;
    return { id, s, name, city: l?.city || "", phone: s.phone || l?.phone || "", gone: !l,
             hit: !!find && find(name, l?.address, s.phone, l?.phone) };
  });

  const counts = FUNNEL.map(([label, test, base], i) =>
    [label, people.filter(p => test(p.s)).length, base || FUNNEL[i - 1]?.[0]]);
  const top = Math.max(counts[0][1], 1);
  const bars = counts.map(([label, n, base]) => {
    const prev = base ? counts.find(c => c[0] === base)[1] : LEADS.length;
    const pct = prev ? Math.round(n / prev * 100) : 0;
    const of = base ? `of ${base.toLowerCase()}` : "of the leads on the list";
    return `<div class="fbar" title="${n} ${label.toLowerCase()}, ${pct}% ${of}">
      <span class="lbl">${label}</span>
      <span class="track"><span class="fill" data-w="${n / top * 100}"></span></span>
      <span class="val">${n}<small>${pct}%</small></span></div>`;
  }).join("");

  const windows = [["Today", 1], ["7 days", 7], ["30 days", 30]];
  const cutoff = days => { const d = new Date(today() + "T00:00"); d.setDate(d.getDate() - days + 1); return d; };
  const act = ACTIVITY.map(([label, times]) => {
    const all = people.flatMap(p => times(p.s)).filter(Boolean).map(t => new Date(t));
    return `<tr><td>${label}</td>` + windows.map(([, days]) => {
      const n = all.filter(t => t >= cutoff(days)).length;
      return `<td class="num ${n ? "" : "zero"}">${n}</td>`;
    }).join("") + "</tr>";
  }).join("");

  const bucket = b => {
    const rows = people.map(p => ({ ...p, since: sinceIn(b, p.s) })).filter(p => p.since != null)
      .map(p => ({ ...p, days: daysSince(p.since) }))
      .sort((x, y) => b.late === Infinity ? (y.since > x.since ? 1 : -1) : (y.days ?? -1) - (x.days ?? -1));
    const over = rows.filter(r => r.days > b.late).length;
    return `<section class="bucket ${rows.length ? "" : "none"}">
      <div class="bh"><b>${b.title}</b><span class="n">${rows.length}</span>
        ${over ? `<span class="over">⚠ ${over} overdue</span>` : ""}</div>
      <p class="hint">${b.hint}${isFinite(b.late) && b.late ? ` Overdue after ${b.late} day${b.late > 1 ? "s" : ""}.` : ""}</p>
      ${rows.length ? `<ul>${rows.map(r => `
        <li data-id="${esc(r.id)}" class="${r.days > b.late ? "late" : ""} ${r.id === selectedId ? "sel" : ""}">
          <span class="nm">${esc(r.name)}${r.gone ? ` <small>(off the list)</small>` : ""}</span>
          <span class="age">${ageText(r.days, b)}</span>
          <span class="ct">${[esc(r.city), r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : "",
            esc(b.note?.(r.s) || "")].filter(Boolean).join(" · ")}</span>
        </li>`).join("")}</ul>` : ""}
    </section>`;
  };
  const lists = [...new Set(TODO.map(b => b.phase))].map(ph =>
    `<h3 class="fphase">${ph}</h3><div class="buckets">${TODO.filter(b => b.phase === ph).map(bucket).join("")}</div>`
  ).join("");

  /* a search lists every client in the pipeline it matches, with what they're
     waiting on. Plenty of them sit on no list below, a no-answer call for one */
  let found = "";
  if (find) {
    const hits = people.filter(p => p.hit).sort((x, y) => (y.s.log[0]?.t || "").localeCompare(x.s.log[0]?.t || ""));
    const fresh = LEADS.filter(l => !touched(stateOf(l)) && leadHit(find, l)).length;
    const li = r => {
      const stage = lastStage(r.s);
      const next = TODO.filter(b => b.phase !== "Done" && sinceIn(b, r.s) != null).map(b => b.title);
      return `<li data-id="${esc(r.id)}" class="${r.id === selectedId ? "sel" : ""}">
          <span class="nm">${esc(r.name)}${r.gone ? ` <small>(off the list)</small>` : ""}</span>
          <span class="age">${badge("st-" + esc(r.s.status), stOf(r.s.status).icon, stOf(r.s.status).label)}</span>
          <span class="ct">${[esc(r.city), r.phone ? `<a href="tel:${esc(r.phone.replace(/\s/g, ""))}">${esc(r.phone)}</a>` : "",
            stage ? esc(STG[stage].label) : "", next.length ? `Next: ${esc(next.join(", "))}` : ""].filter(Boolean).join(" · ")}</span>
        </li>`;
    };
    found = `<section class="bucket found">
      <div class="bh"><b>Search results</b><span class="n">${hits.length}</span></div>
      <p class="hint">${hits.length ? "Clients in the pipeline that match, latest activity first." : "Nobody in the pipeline matches."}
        ${fresh ? `${fresh} untouched ${fresh > 1 ? "leads on the list match" : "lead on the list matches"}.
          <button id="qLeads">Show in Leads</button>` : ""}</p>
      ${hits.length ? `<ul>${hits.map(li).join("")}</ul>` : ""}
    </section>`;
  }

  F.innerHTML = found + `<div class="fgrid">
      <section class="fcard"><h3>Funnel</h3>
        <p class="hint">Leads that reached each step, and the share of the step before it. Hover a bar for details.</p>${bars}</section>
      <section class="fcard"><h3>Done lately</h3>
        <table class="act"><thead><tr><th></th>${windows.map(([l]) => `<th class="num">${l}</th>`).join("")}</tr></thead>
        <tbody>${act}</tbody></table></section>
    </div>${lists}`;
  // the page's CSP blocks style="" attributes, so widths go through the DOM
  F.querySelectorAll(".fill").forEach(el => el.style.width = el.dataset.w + "%");
}
function ageText(days, b) {
  if (days == null) return "";
  if (b.late === 0) return days > 0 ? `${days}d late` : "today";
  return days ? `${days}d` : "today";
}
F.addEventListener("click", e => {
  if (e.target.closest("#qLeads")) return showAllMatches();
  if (e.target.closest("a")) return;
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  if (!leadById.has(li.dataset.id)) return toast("This lead is no longer on the list");
  openDrawer(li.dataset.id);
});

function setView(v) {
  view = v; lsSet("ro-leads-view", v);
  document.body.classList.toggle("view-funnel", v === "funnel");
  document.getElementById("vList").classList.toggle("on", v === "list");
  document.getElementById("vFunnel").classList.toggle("on", v === "funnel");
  F.hidden = v !== "funnel";
  render();
}
document.getElementById("vList").onclick = () => setView("list");
document.getElementById("vFunnel").onclick = () => setView("funnel");

/* ---------- drawer ---------- */
const D = Object.fromEntries(["drawer","dName","dMeta","dActions","dPhone","dStatus","dStages","dCallback",
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
  D.dPhone.value = phoneOf(l);
  D.dCallback.value = s.callback || "";
  D.dNotes.value = s.notes || "";
  renderActions(l); renderInfo(l);
  renderStatusGrid(s); renderStages(s); renderLog(s);
  D.dEmpty.hidden = true; D.dContent.hidden = false;
  D.drawer.classList.add("open");
  render();
}
function renderActions(l) {
  const phone = phoneOf(l);
  D.dActions.innerHTML =
    (phone ? `<a class="call" href="tel:${esc(phone.replace(/\s/g, ""))}">📞 Call ${esc(phone)}</a>` : "") +
    `<a href="${esc(mapsLink(l))}" target="_blank" rel="noopener">🗺 Maps</a>` +
    (pinLink(l) ? `<a href="${esc(pinLink(l))}" target="_blank" rel="noopener" title="Exact location pin, in case the name search finds the wrong place">📍 Pin</a>` : "") +
    `<a href="${esc(searchLink(l))}" target="_blank" rel="noopener">🔎 Google them</a>` +
    (safeUrl(l.website) ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">📱 Listed link</a>` : "") +
    (safeUrl(l.possibleSite) ? `<a href="${esc(l.possibleSite)}" target="_blank" rel="noopener">❓ Possible site</a>` : "");
}
function renderInfo(l) {
  const lv = leadVerdict(l), mine = stateOf(l).phone;
  D.dInfo.innerHTML = [
    ["Website", `${LV[lv].icon} ${LV[lv].label}` + (l.website ? ` (${l.website})` : "")],
    ["Web check", WEB_CHECK[l.webCheck || ""] || l.webCheck],
    ["Rating", l.rating ? `${l.rating} ★ (${l.reviews} reviews)` : "n/a"],
    ["Close score", l.score != null ? `${l.score} / 100` : "n/a"],
    ["Google type", l.primaryType || "n/a"],
    ["Phone", mine ? `${mine} (added by you; Google Maps has ${l.phone || "none"})` : l.phone || "n/a"],
    ["First seen", l.firstSeen || "n/a"],
    ["Last seen in a search", l.lastSeen || "n/a"],
  ].map(([k, v]) => `<div><b>${k}</b> ${esc(v)}</div>`).join("") +
    (l.why?.length ? `<div><b>Why this score</b><ul class="why">` +
      l.why.map(w => `<li>${esc(w)}</li>`).join("") + `</ul></div>` : "");
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
function renderStages(s) {
  D.dStages.innerHTML = STAGES.map(([k, label, phase], i) =>
    (phase !== STAGES[i - 1]?.[2] ? `<div class="phase">${phase || "Or"}</div>` : "") +
    `<label class="${s.stages[k] ? "on" : ""}"><input type="checkbox" data-stage="${k}" ${s.stages[k] ? "checked" : ""}>` +
    `<span>${label}</span><time>${fmtT(s.stages[k])}</time></label>`).join("");
  D.dStages.querySelectorAll("input").forEach(box => box.onchange = () => {
    const k = box.dataset.stage, label = STG[k].label;
    if (box.checked) { s.stages[k] = new Date().toISOString(); logIt(s, `✔ ${label}`); }
    else { delete s.stages[k]; logIt(s, `Unticked: ${label}`); }
    save(openLead.id);
    renderStages(s); renderLog(s); render();
    toast(box.checked ? `✔ ${label}` : `Unticked: ${label}`);
  });
}
/* another device changed the open lead: show its version, but leave the notes
   box alone while you're typing in it */
function refreshDrawer() {
  const s = stateOf(openLead);
  renderStatusGrid(s); renderStages(s); renderLog(s);
  renderActions(openLead); renderInfo(openLead);
  if (document.activeElement !== D.dPhone) D.dPhone.value = phoneOf(openLead);
  D.dCallback.value = s.callback || "";
  if (document.activeElement !== D.dNotes) D.dNotes.value = s.notes || "";
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
/* clearing the box goes back to the Maps number */
D.dPhone.onchange = () => {
  const l = openLead, s = stateOf(l), v = D.dPhone.value.trim();
  const next = v && v !== l.phone ? v : undefined;
  if (next === s.phone) return void (D.dPhone.value = phoneOf(l));
  if (next) s.phone = next; else delete s.phone;
  const msg = next ? `Phone set to ${next}` : l.phone ? "Phone back to the Maps number" : "Phone removed";
  logIt(s, msg); save(l.id);
  D.dPhone.value = phoneOf(l);
  renderActions(l); renderInfo(l); renderLog(s); render(); toast(msg);
};
D.dPhone.onkeydown = e => { if (e.key === "Enter") D.dPhone.blur(); };
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
[els.q, els.fCat, els.fLead, els.fSort, els.fStatus, els.fStage].forEach(el => el.addEventListener("input", render));
document.getElementById("clear").onclick = () => {
  els.q.value = "";
  [els.fCat, els.fLead, els.fStatus, els.fStage].forEach(el => el.value = "");
  els.fSort.value = "_rank";
  sortKey = "_rank"; sortDir = 1;
  kpiFilter = null; render();
};
document.getElementById("exportCsv").onclick = () => {
  const rows = sorted(filtered()).map(r => {
    const st = stateOf(r).stages;
    return { ...r, stage: STG[r.stage]?.label || "",
             ...Object.fromEntries(STAGES.map(([k]) => [k, (st[k] || "").slice(0, 10)])) };
  });
  const cols = ["name","city","county","category","phone","address","lead","website",
                "rating","reviews","score","why","status","stage",...STAGES.map(([k]) => k),
                "callback","notes","mapsUrl"];
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => {
    let v = Array.isArray(r[c]) ? r[c].join("; ") : String(r[c] ?? "");
    // a leading ' keeps a spreadsheet from running a cell as a formula; phone numbers pass as they are
    if (/^[=@\t\r\n]/.test(v) || /^[+-]/.test(v) && !/^[+\-\d\s().\/]+$/.test(v)) v = "'" + v;
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))).join("\r\n");
  download(new Blob(["﻿" + csv], { type: "text/csv" }), `ro-leads-${today()}.csv`);
  toast("CSV exported");
};
/* same { byId } format as the offline dashboard's backup, so files work both ways */
document.getElementById("exportJson").onclick = () => {
  flushNotes();   // a note typed in the last 800 ms isn't in store yet
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
  /* a lead saved after the backup was made keeps what it has. The backup is as
     old as the file, or as its newest activity if a copy left the file newer */
  flushNotes();
  await Promise.all(Object.values(queue));
  // loadCrm below replaces what this tab holds, a change that failed to save included
  if (unsaved.size) return toast(`${unsaved.size} change(s) not saved yet. Retry them, then restore`);
  await loadCrm();
  const lastAt = s => Math.max(f.lastModified || 0, ...[...(Array.isArray(s.log) ? s.log : []).map(e => e?.t),
    ...Object.values(s.stages && typeof s.stages === "object" ? s.stages : {})].map(t => Date.parse(t) || 0));
  let kept = entries.length;
  entries = entries.filter(([id, s]) => !(ver[id] && Date.parse(ver[id]) > lastAt(s)));
  kept -= entries.length;
  const now = new Date().toISOString();
  const rows = entries.map(([id, s]) => ({ id, updated_at: now, state: {
    status: ST[s.status] ? s.status : "new", notes: s.notes || "", callback: s.callback || "",
    log: Array.isArray(s.log) ? s.log : [], name: s.name || "",
    ...(s.phone ? { phone: String(s.phone) } : {}),
    stages: s.stages && typeof s.stages === "object"
      ? Object.fromEntries(Object.entries(s.stages).filter(([k]) => STG[k])) : {} } }));
  /* the same conditional write as save(), so a lead another device saves while
     this runs misses here and keeps what it has */
  let done = 0, failed = null;
  for (let i = 0; i < rows.length && !failed; i += 10) {
    const res = await Promise.all(rows.slice(i, i + 10).map(r => ver[r.id]
      ? sb.from("crm").update({ state: r.state, updated_at: r.updated_at })
          .eq("id", r.id).eq("updated_at", ver[r.id]).select("updated_at")
      : sb.from("crm").insert(r).select("updated_at")));
    for (const { data, error } of res) {
      if (error && error.code !== "23505") failed = error;
      else if (!error && data.length) done++;
      else kept++;
    }
  }
  await loadCrm();
  if (openLead) openDrawer(openLead.id); else render();
  if (failed) return toast(`Restore stopped after ${done} entries: ${failed.message}`);
  toast(`Restored ${done} leads' notes` +
        (kept ? `; kept ${kept} that changed after this backup` : ""));
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
