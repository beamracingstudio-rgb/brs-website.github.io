/* Beam Racing Studio — front end
   Talks to the Apps Script backend (Code.gs) configured in config.js. */
(() => {
  "use strict";
  const cfg = window.BRS_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? String(u) : "");
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }
  };

  /* ---------------------------------- state --------------------------------- */
  let data = { drivers: [], teams: [], events: [], media: [] };
  let me = null;                 // result of the "me" action
  let token = store.get("brs_token") || "";
  let pendingEntry = null;       // event id the visitor wanted to join before logging in
  let admin = null;              // admin data cache
  let eventFilter = "all", mediaFilter = "all", standTab = "drivers";

  /* --------------------------------- helpers -------------------------------- */
  const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", minimumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch { return `${n} ${cur || ""}`; } };
  const fmtDate = (d) => { if (!d) return "Date TBA"; const x = new Date(d + "T12:00:00"); return isNaN(x) ? esc(d) : x.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }); };
  const num = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));
  const jwt = (t) => { try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; } };
  const tokenOk = () => { const p = token && jwt(token); return !!p && p.exp * 1000 > Date.now() + 60000; };
  let toastTimer;
  function toast(msg, bad) { const t = $("toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), 4200); }
  const setMsg = (id, msg, bad) => { const el = $(id); el.textContent = msg || ""; el.className = "msg" + (bad ? " bad" : msg ? " ok" : ""); };
  function openDlg(id) { const d = $(id); if (!d.open) d.showModal(); }
  function closeDlg(id) { const d = $(id); if (d.open) d.close(); }
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });
  function busy(btn, on, label) { if (!btn) return; if (on) { btn.dataset.l = btn.innerHTML; btn.disabled = true; btn.textContent = label || "Working…"; } else { btn.disabled = false; if (btn.dataset.l) btn.innerHTML = btn.dataset.l; } }

  /* ----------------------------------- API ---------------------------------- */
  class ApiError extends Error { constructor(m, code) { super(m); this.code = code; } }
  async function call(action, payload = {}, opts = {}) {
    if (!cfg.apiUrl) throw new ApiError("The league backend isn't connected yet.", "setup");
    if (opts.auth !== false) await ensureToken();
    const body = JSON.stringify({ action, token: opts.auth === false ? undefined : token, ...payload });
    let res;
    try { res = await fetch(cfg.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body }); }
    catch { throw new ApiError("Could not reach the league server. Check your connection and try again.", "network"); }
    let json; try { json = await res.json(); } catch { throw new ApiError("Unexpected response from the league server.", "server"); }
    if (!json.ok) {
      if (json.code === "auth") { signOut(true); }
      throw new ApiError(json.error || "Something went wrong.", json.code);
    }
    return json.data;
  }
  async function loadPublic() {
    if (!cfg.apiUrl) return;
    const res = await fetch(cfg.apiUrl + (cfg.apiUrl.includes("?") ? "&" : "?") + "action=public");
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    data = json.data;
  }

  /* ---------------------------------- auth ---------------------------------- */
  let gsiReady = false, tokenWaiter = null;
  function initGoogle() {
    if (gsiReady || !cfg.googleClientId || !(window.google && google.accounts && google.accounts.id)) return false;
    google.accounts.id.initialize({
      client_id: cfg.googleClientId, callback: onCredential, auto_select: !!store.get("brs_was_in"),
      cancel_on_tap_outside: false, use_fedcm_for_prompt: true
    });
    gsiReady = true; return true;
  }
  function waitForGoogle(cb) { let n = 0; const t = setInterval(() => { if (initGoogle() || ++n > 80) { clearInterval(t); cb(gsiReady); } }, 150); }

  async function onCredential(resp) {
    token = resp.credential; store.set("brs_token", token); store.set("brs_was_in", "1");
    if (tokenWaiter) { tokenWaiter(token); tokenWaiter = null; }
    try { await refreshMe(); } catch (e) { setMsg("authMsg", e.message, true); return; }
    closeDlg("authDlg");
    renderAuth();
    if (!me.profile) { showAccount("profile", "Welcome! Add your driver details to finish creating your account."); return; }
    toast("Signed in as " + me.profile.driverName);
    if (pendingEntry) { const id = pendingEntry; pendingEntry = null; startEntry(id); }
  }
  async function ensureToken() {
    if (tokenOk()) return;
    if (gsiReady && store.get("brs_was_in")) {
      const t = await new Promise((resolve) => {
        tokenWaiter = resolve; setTimeout(() => { if (tokenWaiter === resolve) { tokenWaiter = null; resolve(null); } }, 8000);
        google.accounts.id.prompt((n) => { if (n.isNotDisplayed && (n.isNotDisplayed() || n.isSkippedMoment())) { if (tokenWaiter === resolve) { tokenWaiter = null; resolve(null); } } });
      });
      if (t) return;
    }
    signOut(true);
    throw new ApiError("Your session expired. Please log in again.", "auth");
  }
  async function refreshMe() { me = await call("me"); return me; }
  function signOut(expired) {
    token = ""; me = null; admin = null; store.set("brs_token", null);
    if (!expired) { store.set("brs_was_in", null); if (gsiReady) google.accounts.id.disableAutoSelect(); }
    closeDlg("accountDlg"); closeDlg("adminDlg"); renderAuth(); renderEvents(); if (expired) toast("Please log in again.", true);
  }
  function showAuth(mode) {
    $("authTitle").textContent = mode === "up" ? "CREATE YOUR ACCOUNT" : "LOG IN";
    setMsg("authMsg", "");
    openDlg("authDlg");
    if (!cfg.googleClientId || !cfg.apiUrl) { setMsg("authMsg", "Sign-in isn't switched on yet. The site owner needs to finish setup (see README).", true); $("gsiButton").innerHTML = ""; return; }
    waitForGoogle((ok) => {
      if (!ok) { setMsg("authMsg", "Couldn't load Google sign-in. Disable tracking blockers for this page and reload.", true); return; }
      $("gsiButton").innerHTML = "";
      google.accounts.id.renderButton($("gsiButton"), { theme: "filled_black", size: "large", text: mode === "up" ? "signup_with" : "signin_with", shape: "rectangular", width: 300 });
    });
  }
  function renderAuth() {
    const slot = $("authSlot");
    if (!me) { slot.innerHTML = '<button class="btn btn-ghost" id="signInBtn" type="button">Log in</button><button class="btn btn-primary" id="signUpBtn" type="button">Sign up</button>'; $("signInBtn").onclick = () => showAuth("in"); $("signUpBtn").onclick = () => showAuth("up"); return; }
    const label = me.profile ? me.profile.driverName : me.name || "Account";
    slot.innerHTML = (me.isAdmin ? '<button class="btn btn-outline" id="adminBtn" type="button">Admin</button>' : "") +
      `<button class="btn btn-ghost user-btn" id="accountBtn" type="button">${safeUrl(me.picture) ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : ""}<span>${esc(label)}</span></button>`;
    $("accountBtn").onclick = () => showAccount("profile");
    if (me.isAdmin) $("adminBtn").onclick = openAdmin;
  }

  /* ------------------------------- account dialog ------------------------------ */
  function showAccount(pane, msg) {
    if (!me) return showAuth("in");
    $("pfDriver").value = me.profile?.driverName || ""; $("pfDiscord").value = me.profile?.discord || "";
    $("pfNumber").value = me.profile?.number || ""; $("pfTeam").value = me.profile?.team || "";
    setMsg("profileMsg", msg || "");
    renderMyStats(); renderEntries(); switchPane("accTabs", pane || "profile");
    openDlg("accountDlg");
  }
  function switchPane(tabsId, pane) {
    document.querySelectorAll(`#${tabsId} button`).forEach((b) => b.classList.toggle("on", b.dataset.pane === pane));
    const map = tabsId === "accTabs" ? { profile: "paneProfile", entries: "paneEntries" } : null;
    if (map) Object.entries(map).forEach(([k, id]) => ($(id).hidden = k !== pane));
  }
  $("accTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) switchPane("accTabs", b.dataset.pane); });
  function renderMyStats() {
    const box = $("myStats"); const name = me?.profile?.driverName?.toLowerCase();
    const d = name && data.drivers.find((x) => x.name.toLowerCase() === name);
    if (!d) { box.hidden = !me?.profile; box.innerHTML = me?.profile ? "<small>Your name isn't in the league standings yet. Stats appear once you're on the Racer Registration sheet with this exact driver name.</small>" : ""; return; }
    box.hidden = false;
    box.innerHTML = `<div><b>${num(d.racePoints)}</b><span>RACE POINTS</span></div><div><b>${num(d.licensePoints)}</b><span>LICENSE PTS</span></div><div><b>${esc(d.level || "—")}</b><span>CLASS</span></div><div><b>${num(d.wins)}</b><span>WINS</span></div><div><b>${num(d.dnf)}</b><span>DNF</span></div>`;
  }
  $("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = e.submitter; busy(btn, true, "Saving…");
    try {
      me = await call("saveProfile", { driverName: $("pfDriver").value, discord: $("pfDiscord").value, number: $("pfNumber").value, team: $("pfTeam").value });
      setMsg("profileMsg", "Profile saved."); renderAuth(); renderMyStats();
      if (pendingEntry) { const id = pendingEntry; pendingEntry = null; closeDlg("accountDlg"); startEntry(id); }
    } catch (err) { setMsg("profileMsg", err.message, true); } finally { busy(btn, false); }
  });
  $("signOutBtn").onclick = () => { signOut(false); toast("Signed out."); };
  document.addEventListener("click", (e) => { const o = e.target.closest("[data-open='account']"); if (o) { e.preventDefault(); me ? showAccount("entries") : showAuth("in"); } });

  /* --------------------------------- race entries -------------------------------- */
  const BADGE = { Confirmed: "ok", Paid: "ok", "Pending payment": "warn", "Payment submitted": "info", Cancelled: "off", Refunded: "off" };
  const badge = (s) => `<span class="badge ${BADGE[s] || ""}">${esc(s)}</span>`;
  const myEntry = (eventId) => me?.signups.find((s) => s.eventId === eventId && s.status !== "Cancelled" && s.status !== "Refunded");

  function renderEntries() {
    const list = $("entriesList"); const rows = (me?.signups || []).slice().reverse();
    if (!rows.length) { list.innerHTML = '<div class="empty">You haven\'t entered any races yet.</div>'; return; }
    list.innerHTML = rows.map((s) => {
      const active = s.status !== "Cancelled" && s.status !== "Refunded";
      const payable = s.status === "Pending payment" || s.status === "Payment submitted";
      return `<div class="entry" data-id="${esc(s.id)}"><div class="entry-top"><strong>${esc(s.eventTitle)}</strong>${badge(s.status)}</div>
        ${Number(s.fee) > 0 ? `<small>Entry fee ${esc(money(Number(s.fee), s.currency))}${s.paymentRef ? " · ref " + esc(s.paymentRef) : ""}</small>` : ""}
        ${payable ? payBlock(s) : ""}
        ${active && s.status !== "Paid" ? '<button class="link-btn" data-cancel>Cancel entry</button>' : ""}</div>`;
    }).join("");
  }
  function payBlock(s) {
    const url = safeUrl(s.payUrl);
    return `<div class="pay-box">${url ? `<a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noreferrer noopener">PAY ${esc(money(Number(s.fee), s.currency))} ↗</a>` : '<small>Ask a steward in Discord how to pay.</small>'}
      <small>${esc(me.paymentInstructions || "")}</small>
      <form class="ref-form"><input name="ref" placeholder="Payment reference / transaction ID" maxlength="80" required value="${esc(s.paymentRef || "")}"><button class="btn btn-outline" type="submit">${s.status === "Payment submitted" ? "UPDATE" : "SUBMIT"}</button></form></div>`;
  }
  $("entriesList").addEventListener("click", async (e) => {
    const id = e.target.closest(".entry")?.dataset.id;
    if (e.target.matches("[data-cancel]") && id && confirm("Cancel this entry?")) {
      try { await call("cancelSignup", { id }); await refreshMe(); renderEntries(); await refresh(); toast("Entry cancelled."); } catch (err) { toast(err.message, true); }
    }
  });
  $("entriesList").addEventListener("submit", async (e) => {
    e.preventDefault(); const id = e.target.closest(".entry").dataset.id;
    try { await call("submitPayment", { id, paymentRef: e.target.ref.value }); await refreshMe(); renderEntries(); toast("Payment reference sent. A steward will confirm it."); } catch (err) { toast(err.message, true); }
  });

  let entryEventId = "";
  function startEntry(eventId) {
    const ev = data.events.find((x) => x.id === eventId); if (!ev) return;
    entryEventId = eventId;
    if (!me) { pendingEntry = eventId; showAuth("up"); return; }
    if (!me.profile) { pendingEntry = eventId; showAccount("profile", "Add your driver details to register for races."); return; }
    $("entryTitle").textContent = ev.title.toUpperCase();
    const mine = myEntry(eventId);
    $("entryBody").innerHTML = `<dl class="facts"><div><dt>DATE</dt><dd>${fmtDate(ev.date)} ${esc(ev.time || "")}</dd></div><div><dt>TRACK</dt><dd>${esc(ev.track || "TBA")}</dd></div><div><dt>CLASS</dt><dd>${esc(ev.className || "Open")}</dd></div><div><dt>ENTRY</dt><dd>${ev.paid ? esc(money(ev.fee, ev.currency)) : "Free"}</dd></div></dl>
      ${ev.description ? `<p class="lead">${esc(ev.description)}</p>` : ""}
      ${mine ? `<div class="entry"><div class="entry-top"><strong>You're entered</strong>${badge(mine.status)}</div>${mine.status === "Pending payment" || mine.status === "Payment submitted" ? payBlock(mine) : ""}</div>`
      : `<p class="lead">Entering as <b>${esc(me.profile.driverName)}</b> (${esc(me.profile.discord)}).</p>
         <label class="agree"><input type="checkbox" id="entryAgree"><span>I've read the event details and agree to follow league regulations.</span></label>
         <button class="btn btn-primary full" id="entryGo" type="button">${ev.paid ? `REGISTER · ${esc(money(ev.fee, ev.currency))}` : "CONFIRM ENTRY"} <b>→</b></button>`}
      <p class="msg" id="entryMsg" role="alert"></p>`;
    openDlg("entryDlg");
  }
  $("entryBody").addEventListener("click", async (e) => {
    if (e.target.closest("#entryGo")) {
      const btn = $("entryGo");
      if (!$("entryAgree").checked) return setMsg("entryMsg", "Please tick the box to agree to the regulations.", true);
      const id = entryEventId; busy(btn, true, "Registering…");
      try { await call("signup", { eventId: id }); await refreshMe(); await refresh(); startEntry(id); toast("You're registered!"); }
      catch (err) { setMsg("entryMsg", err.message, true); if (err.code === "profile") showAccount("profile"); busy(btn, false); }
    }
  });
  $("entryBody").addEventListener("submit", async (e) => {
    e.preventDefault(); const id = myEntry(entryEventId)?.id;
    try { await call("submitPayment", { id, paymentRef: e.target.ref.value }); await refreshMe(); toast("Payment reference sent. A steward will confirm it."); closeDlg("entryDlg"); } catch (err) { setMsg("entryMsg", err.message, true); }
  });

  /* ------------------------------------ races ------------------------------------ */
  const today = () => new Date().toISOString().slice(0, 10);
  function renderEvents() {
    const box = $("eventCards");
    let list = data.events.filter((e) => !e.date || e.date >= today()).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    $("statRaces").textContent = list.length;
    if (eventFilter !== "all") list = list.filter((e) => (eventFilter === "paid") === !!e.paid);
    if (!list.length) { box.innerHTML = `<div class="empty wide-empty">${cfg.apiUrl ? "No races listed right now — check back soon, or join the Discord for announcements." : "Race listings will appear here once the backend is connected."}</div>`; return; }
    box.innerHTML = list.map((e, i) => {
      const mine = myEntry(e.id), full = e.capacity > 0 && e.entries >= e.capacity, closed = e.status !== "Open";
      const img = safeUrl(e.image);
      let action;
      if (mine) action = `<button class="race-cta in" data-ev="${esc(e.id)}">${esc(mine.status.toUpperCase())} · VIEW <b>→</b></button>`;
      else if (closed) action = '<span class="race-cta off">REGISTRATION CLOSED</span>';
      else if (full) action = '<span class="race-cta off">RACE FULL</span>';
      else action = `<button class="race-cta" data-ev="${esc(e.id)}">${me ? "REGISTER" : "LOG IN TO REGISTER"} <b>→</b></button>`;
      return `<article class="race-card"><div class="race-art ${["", "art-b", "art-c"][i % 3]}" ${img ? `style="background-image:url('${esc(img)}')"` : ""}><span>${e.paid ? "PAID EVENT" : "FREE ENTRY"}</span><b>${String(i + 1).padStart(2, "0")}</b>${e.paid ? `<em class="price">${esc(money(e.fee, e.currency))}</em>` : ""}</div>
      <div class="race-copy"><div class="meta"><span>${esc(e.className || "OPEN CLASS")}</span><span>${fmtDate(e.date)}${e.time ? " · " + esc(e.time) : ""}</span></div><h3>${esc(e.title)}</h3>
      <p>${esc(e.description || "")}</p><div class="race-foot"><small>📍 ${esc(e.track || "Track TBA")}</small><small>${e.capacity ? `${e.entries}/${e.capacity} entered` : `${e.entries} entered`}</small></div>${action}</div></article>`;
    }).join("");
  }
  $("eventCards").addEventListener("click", (e) => { const b = e.target.closest("[data-ev]"); if (b) startEntry(b.dataset.ev); });
  $("eventFilter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; eventFilter = b.dataset.f; document.querySelectorAll("#eventFilter button").forEach((x) => x.classList.toggle("on", x === b)); renderEvents(); });

  /* ---------------------------------- standings ---------------------------------- */
  function renderStandings() {
    const head = $("standHead"), body = $("standBody");
    const hasPts = data.drivers.some((d) => d.racePoints !== null && d.racePoints !== undefined);
    $("statDrivers").textContent = data.drivers.length; $("statTeams").textContent = data.teams.length;
    $("heroStats").hidden = !cfg.apiUrl || !data.drivers.length;
    if (standTab === "teams") {
      head.innerHTML = "<tr><th>POS</th><th>TEAM</th><th>DRIVERS</th><th>WINS</th><th>TEAM POINTS</th></tr>";
      body.innerHTML = data.teams.length ? data.teams.map((t) => `<tr><td>${t.rank}</td><td><strong>${esc(t.name)}</strong></td><td class="dim">${esc(t.drivers)}</td><td>${num(t.wins)}</td><td class="pts">${esc(t.points)}</td></tr>`).join("") : '<tr><td colspan="5" class="empty-cell">No teams yet. Teams come from the Team column on the Racer Registration sheet.</td></tr>';
    } else {
      head.innerHTML = "<tr><th>POS</th><th>DRIVER</th><th>TEAM</th><th>CLASS</th><th>WINS</th><th>DNF</th><th>LICENSE PTS</th><th>RACE POINTS</th></tr>";
      body.innerHTML = data.drivers.length ? data.drivers.map((d) => `<tr><td>${d.rank ?? "—"}</td><td><strong>${esc(d.name)}</strong></td><td class="dim">${esc(d.team || "—")}</td><td>${esc(d.level || "—")}</td><td>${num(d.wins)}</td><td>${num(d.dnf)}</td><td>${num(d.licensePoints)}</td><td class="pts">${hasPts ? num(d.racePoints) : "—"}</td></tr>`).join("") : `<tr><td colspan="8" class="empty-cell">${cfg.apiUrl ? "No drivers found on the sheet yet." : "Standings will appear once the backend is connected."}</td></tr>`;
    }
  }
  $("standTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; standTab = b.dataset.t; document.querySelectorAll("#standTabs button").forEach((x) => x.classList.toggle("on", x === b)); renderStandings(); });

  function searchDrivers() {
    const q = $("driverSearch").value.trim().toLowerCase(), out = $("driverResult");
    $("driverCount").textContent = data.drivers.length ? data.drivers.length + " DRIVERS" : "LEAGUE DATA";
    if (!q) { out.textContent = "Search for a driver to view their statistics."; return; }
    const found = data.drivers.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 6);
    out.innerHTML = found.length ? found.map((d) => `<div class="driver-result"><strong>${esc(d.name)}</strong>${d.number ? ` <span class="num">#${esc(d.number)}</span>` : ""}<div class="chips"><span>${esc(d.level || "Unclassified")}</span><span>Race pts ${num(d.racePoints)}</span><span>License pts ${num(d.licensePoints)}</span><span>Wins ${num(d.wins)}</span><span>DNF ${num(d.dnf)}</span><span>${esc(d.team || "Independent")}</span></div></div>`).join("") : "No matching driver found.";
  }
  $("driverSearch").addEventListener("input", searchDrivers); $("searchDriver").addEventListener("click", searchDrivers);

  /* ------------------------------------- media ------------------------------------ */
  function embedUrl(u) {
    let m;
    if ((m = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/.exec(u))) return `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1`;
    if ((m = /vimeo\.com\/(\d+)/.exec(u))) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`;
    return "";
  }
  const ytThumb = (u) => { const m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(u); return m && /youtu/.test(u) ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : ""; };
  function renderMedia() {
    const box = $("mediaGrid"); const list = data.media.filter((m) => mediaFilter === "all" || m.type === mediaFilter).slice().reverse();
    if (!list.length) { box.innerHTML = `<div class="empty wide-empty">${cfg.apiUrl ? "No media yet. Videos and pictures added by league staff will show up here." : "Media will appear once the backend is connected."}</div>`; return; }
    box.innerHTML = list.map((m) => {
      const u = safeUrl(m.url), thumb = m.type === "picture" ? u : ytThumb(u);
      return `<button class="media-card ${m.type}" data-id="${esc(m.id)}" ${thumb ? `style="background-image:linear-gradient(0deg,#000c,#0003),url('${esc(thumb)}')"` : ""}>${m.type === "video" ? "<span>▶</span>" : ""}<b>${esc(m.title)}</b><small>${esc(m.category || (m.type === "video" ? "Video" : "Photo"))}</small></button>`;
    }).join("");
  }
  $("mediaGrid").addEventListener("click", (e) => {
    const b = e.target.closest(".media-card[data-id]"); if (!b) return; const m = data.media.find((x) => x.id === b.dataset.id); if (!m) return;
    const u = safeUrl(m.url); if (!u) return;
    const emb = m.type === "video" ? embedUrl(u) : "";
    if (m.type === "video" && !emb) { window.open(u, "_blank", "noopener"); return; }
    $("mediaView").innerHTML = (emb ? `<iframe src="${esc(emb)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(m.title)}"></iframe>` : `<img src="${esc(u)}" alt="${esc(m.title)}">`) + `<p>${esc(m.title)}</p>`;
    openDlg("mediaDlg");
  });
  $("mediaDlg").addEventListener("close", () => ($("mediaView").innerHTML = ""));
  $("mediaFilter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; mediaFilter = b.dataset.f; document.querySelectorAll("#mediaFilter button").forEach((x) => x.classList.toggle("on", x === b)); renderMedia(); });

  /* -------------------------------------- admin ------------------------------------- */
  let aTab = "aRaces";
  async function openAdmin() { openDlg("adminDlg"); await loadAdmin(); }
  async function loadAdmin() {
    setMsg("adminMsg", "Loading…");
    try { admin = await call("adminData"); setMsg("adminMsg", ""); renderAdmin(); } catch (e) { setMsg("adminMsg", e.message, true); }
  }
  $("adminTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; aTab = b.dataset.pane; document.querySelectorAll("#adminTabs button").forEach((x) => x.classList.toggle("on", x === b)); renderAdmin(); });
  const adminDo = async (action, payload, okMsg) => {
    try { const r = await call(action, payload); await loadAdmin(); await refresh(); toast(okMsg || "Saved."); return r; } catch (e) { setMsg("adminMsg", e.message, true); toast(e.message, true); }
  };
  const field = (label, html) => `<div class="fld"><label>${label}</label>${html}</div>`;
  const input = (name, v = "", extra = "") => `<input name="${name}" value="${esc(v)}" ${extra}>`;

  function renderAdmin() {
    if (!admin) return;
    const body = $("adminBody");
    ({ aRaces: adminRaces, aSignups: adminSignups, aMedia: adminMedia, aPay: adminPay, aAdmins: adminAdmins, aData: adminData }[aTab] || adminRaces)(body);
  }

  /* --- races, with price + payment link --- */
  function adminRaces(body, editing) {
    const ev = editing || {};
    const rows = admin.events.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    body.innerHTML = `<div class="split"><div><h4>${ev.id ? "EDIT RACE" : "ADD A RACE"}</h4>
      <form id="evForm" class="form">
        <input type="hidden" name="id" value="${esc(ev.id || "")}">
        ${field("TITLE", input("title", ev.title, "required maxlength=80"))}
        <div class="two">${field("DATE", input("date", ev.date, 'type="date"'))}${field("TIME", input("time", ev.time, 'placeholder="8:00 PM EST"'))}</div>
        <div class="two">${field("TRACK", input("track", ev.track))}${field("CLASS", input("className", ev.className, 'placeholder="Open / Pro / Novice"'))}</div>
        ${field("DESCRIPTION", `<textarea name="description" rows="3" maxlength="600">${esc(ev.description || "")}</textarea>`)}
        <div class="price-box"><div class="two three">${field("ENTRY PRICE (0 = FREE)", input("fee", ev.fee ?? 0, 'type="number" min="0" step="0.01"'))}${field("CURRENCY", input("currency", ev.currency || admin.config.currency, 'maxlength="5"'))}${field("MAX ENTRIES (0 = NO LIMIT)", input("capacity", ev.capacity ?? 0, 'type="number" min="0" step="1"'))}</div>
          ${field("PAYMENT LINK OVERRIDE (OPTIONAL)", input("paymentUrl", ev.paymentUrl, 'placeholder="https://… leave blank to use the default from the Payments tab"'))}
          <small id="payPreview" class="hint"></small></div>
        <div class="two">${field("STATUS", `<select name="status">${["Open", "Closed", "Draft"].map((s) => `<option ${((ev.status || "Open") === s) ? "selected" : ""}>${s}</option>`).join("")}</select>`)}${field("IMAGE (URL)", input("image", ev.image, 'placeholder="https://…"'))}</div>
        <label class="file-btn">Upload a race image <input type="file" accept="image/*" data-upload="image" hidden></label>
        <div class="row"><button class="btn btn-primary" type="submit">${ev.id ? "SAVE CHANGES" : "ADD RACE"}</button>${ev.id ? '<button class="btn btn-ghost" type="button" id="evCancel">Cancel</button>' : ""}</div>
      </form></div>
      <div><h4>ALL RACES (${rows.length})</h4><div class="alist">${rows.map((e) => `<div class="arow"><div><strong>${esc(e.title)}</strong><small>${esc(e.date || "No date")} · ${esc(e.className || "Open")} · ${Number(e.fee) > 0 ? esc(money(Number(e.fee), e.currency)) : "Free"} · ${esc(e.status)}</small></div><div class="row"><button class="link-btn" data-edit="${esc(e.id)}">Edit</button><button class="link-btn danger" data-del="${esc(e.id)}">Delete</button></div></div>`).join("") || '<div class="empty">No races yet.</div>'}</div></div></div>`;
    const form = $("evForm"), prev = $("payPreview");
    const updatePreview = () => {
      const fee = Number(form.fee.value) || 0, cur = form.currency.value || admin.config.currency;
      if (!fee) { prev.textContent = "Free race — no payment step is shown to drivers."; return; }
      const tpl = form.paymentUrl.value || admin.config.paymentLinkTemplate;
      prev.textContent = tpl ? "Drivers will pay: " + tpl.replace(/\{amount\}/g, fee).replace(/\{currency\}/g, cur).replace(/\{event\}/g, encodeURIComponent(form.title.value)).replace(/\{id\}/g, "…") : "No payment link yet — set a default in the Payments tab or paste one above. Without it, drivers are told to ask a steward.";
    };
    form.addEventListener("input", updatePreview); updatePreview();
    form.addEventListener("submit", async (e) => { e.preventDefault(); const btn = e.submitter; busy(btn, true, "Saving…"); const p = Object.fromEntries(new FormData(form)); await adminDo("saveEvent", p, ev.id ? "Race updated." : "Race added."); });
    $("evCancel")?.addEventListener("click", () => adminRaces(body));
    body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { adminRaces(body, admin.events.find((x) => x.id === b.dataset.edit)); body.scrollTop = 0; }));
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => confirm("Delete this race? Existing sign-ups stay in the sheet.") && adminDo("deleteEvent", { id: b.dataset.del }, "Race deleted.")));
    wireUploads(body);
  }

  /* --- sign-ups --- */
  function adminSignups(body) {
    const opts = admin.events.map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join("");
    body.innerHTML = `<div class="toolbar"><select id="suEvent"><option value="">All races</option>${opts}</select><span class="hint" id="suCount"></span></div>
      <div class="table-scroll"><table class="small"><thead><tr><th>DRIVER</th><th>DISCORD</th><th>RACE</th><th>FEE</th><th>STATUS</th><th>REF</th></tr></thead><tbody id="suRows"></tbody></table></div>
      <h4>ADD A DRIVER BY HAND</h4>
      <form id="suAdd" class="form inline"><select name="eventId" required><option value="">Race…</option>${opts}</select><input name="driverName" placeholder="Driver name" required><input name="discord" placeholder="Discord (if not registered)"><select name="status"><option value="">Auto (Paid / Confirmed)</option>${admin.statuses.map((s) => `<option>${s}</option>`).join("")}</select><button class="btn btn-primary">ADD</button></form>`;
    const draw = () => {
      const f = $("suEvent").value, rows = admin.signups.filter((s) => !f || s.eventId === f);
      $("suCount").textContent = rows.length + " entries · " + rows.filter((s) => s.status === "Payment submitted").length + " awaiting payment check";
      $("suRows").innerHTML = rows.map((s) => `<tr><td><strong>${esc(s.driverName)}</strong><small class="dim block">${esc(s.email)}</small></td><td>${esc(s.discord)}</td><td>${esc(s.eventTitle)}</td><td>${Number(s.fee) > 0 ? esc(money(Number(s.fee), s.currency)) : "Free"}</td><td><select data-su="${esc(s.id)}">${admin.statuses.map((x) => `<option ${x === s.status ? "selected" : ""}>${x}</option>`).join("")}</select></td><td class="dim">${esc(s.paymentRef)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty-cell">No sign-ups.</td></tr>';
    };
    draw(); $("suEvent").onchange = draw;
    $("suRows").onchange = (e) => { const id = e.target.dataset.su; if (id) adminDo("setSignupStatus", { id, status: e.target.value }, "Status updated."); };
    $("suAdd").onsubmit = (e) => { e.preventDefault(); adminDo("adminSignup", Object.fromEntries(new FormData(e.target)), "Driver added."); };
  }

  /* --- videos & pictures --- */
  function adminMedia(body) {
    body.innerHTML = `<div class="split"><div><h4>ADD A VIDEO OR PICTURE</h4>
      <form id="mdForm" class="form">
        ${field("TYPE", '<select name="type"><option value="video">Video (YouTube, Vimeo, Twitch…)</option><option value="picture">Picture</option></select>')}
        ${field("TITLE", input("title", "", "required maxlength=80"))}
        ${field("LINK (https://…)", input("url", "", 'required placeholder="Paste a YouTube link, or upload a picture below"'))}
        <label class="file-btn">Upload a picture instead <input type="file" accept="image/*" data-upload="url" hidden></label>
        ${field("CATEGORY (OPTIONAL)", input("category", "", 'placeholder="Highlights, Replay, Feature…"'))}
        <button class="btn btn-primary" type="submit">ADD TO MEDIA</button></form></div>
      <div><h4>MEDIA LIBRARY (${admin.media.length})</h4><div class="alist">${admin.media.slice().reverse().map((m) => `<div class="arow"><div><strong>${m.type === "video" ? "▶" : "🖼"} ${esc(m.title)}</strong><small>${esc(m.category || "")} ${esc(m.url).slice(0, 60)}</small></div><button class="link-btn danger" data-del="${esc(m.id)}">Delete</button></div>`).join("") || '<div class="empty">Nothing yet.</div>'}</div></div></div>`;
    $("mdForm").onsubmit = (e) => { e.preventDefault(); adminDo("saveMedia", Object.fromEntries(new FormData(e.target)), "Added to media."); };
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => confirm("Remove this item?") && adminDo("deleteMedia", { id: b.dataset.del }, "Removed.")));
    wireUploads(body);
  }

  /* --- payments settings --- */
  function adminPay(body) {
    const c = admin.config;
    body.innerHTML = `<div class="split"><div><h4>DEFAULT PAYMENT SETTINGS</h4>
      <form id="payForm" class="form">
        ${field("PAYMENT LINK TEMPLATE", input("paymentLinkTemplate", c.paymentLinkTemplate, 'placeholder="https://paypal.me/YourName/{amount}{currency}"'))}
        <small class="hint">Placeholders: <code>{amount}</code> <code>{currency}</code> <code>{event}</code> <code>{id}</code>. When you change a race's price, every driver's pay button updates automatically.</small>
        ${field("DEFAULT CURRENCY", input("currency", c.currency, "maxlength=5"))}
        ${field("MESSAGE SHOWN TO DRIVERS", `<textarea name="paymentInstructions" rows="3" maxlength="300">${esc(c.paymentInstructions)}</textarea>`)}
        <button class="btn btn-primary" type="submit">SAVE PAYMENT SETTINGS</button></form></div>
      <div><h4>HOW PAYING WORKS</h4><ul class="plain"><li><b>Set a price</b> on any race in the Races tab (0 makes it free).</li><li>Drivers register, press <b>Pay</b>, then enter their payment reference.</li><li>You see them as <b>Payment submitted</b> in Sign-ups. Check your payment account, then set the entry to <b>Paid</b>.</li><li>Payments are confirmed by hand because the site never touches card details. For a fixed link per race (e.g. a Stripe Payment Link) paste it in the race's override field.</li></ul></div></div>`;
    $("payForm").onsubmit = (e) => { e.preventDefault(); adminDo("saveConfig", Object.fromEntries(new FormData(e.target)), "Payment settings saved."); };
  }

  /* --- admins --- */
  function adminAdmins(body) {
    body.innerHTML = `<h4>ADMINS</h4><div class="alist">${admin.admins.map((a) => `<div class="arow"><div><strong>${esc(a.email)}</strong></div>${a.email === me.email ? '<small class="dim">you</small>' : `<button class="link-btn danger" data-rm="${esc(a.email)}">Remove</button>`}</div>`).join("")}</div>
      <form id="adForm" class="form inline"><input name="email" type="email" placeholder="Google account email" required><button class="btn btn-primary">ADD ADMIN</button></form>
      <small class="hint">Admins must sign in with this exact Google account. You can also edit the "Site Admins" tab in the spreadsheet.</small>`;
    $("adForm").onsubmit = (e) => { e.preventDefault(); adminDo("addAdmin", { email: e.target.email.value }, "Admin added."); };
    body.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => confirm("Remove " + b.dataset.rm + "?") && adminDo("removeAdmin", { email: b.dataset.rm }, "Admin removed.")));
  }

  /* --- data connection --- */
  function adminData(body) {
    const c = admin.connection, lb = c.leaderboard || {}, cf = admin.config;
    body.innerHTML = `<div class="split"><div><h4>WHAT THE SITE IS READING</h4><ul class="plain check">
      <li class="${c.registrationTab ? "y" : "n"}"><b>Racer Registration</b> tab — ${c.registrationTab ? c.drivers + " drivers found" : "not found"}</li>
      <li class="${lb.found ? "y" : "n"}"><b>${esc(lb.tab || "Leaderboard")}</b> tab — ${lb.found ? "found" : "not found"}</li>
      <li class="${lb.pointsCol ? "y" : "n"}">Personal points column — ${lb.pointsCol ? "<b>" + esc(lb.pointsCol) + "</b> (names from <b>" + esc(lb.nameCol) + "</b>, " + lb.rows + " rows)" : "not detected"}</li>
      <li class="${c.teams ? "y" : "n"}">Team points — ${c.teams} teams (sum of members' points)</li></ul>
      <small class="hint">Tabs in your spreadsheet: ${c.tabs.map(esc).join(", ")}</small></div>
      <div><h4>IF POINTS LOOK WRONG</h4><form id="dcForm" class="form">
        ${field("LEADERBOARD TAB NAME", input("leaderboardTab", cf.leaderboardTab, 'placeholder="Leaderboard"'))}
        ${field("NAME COLUMN HEADER", input("leaderboardNameColumn", cf.leaderboardNameColumn, 'placeholder="auto"'))}
        ${field("POINTS COLUMN HEADER", input("leaderboardPointsColumn", cf.leaderboardPointsColumn, 'placeholder="auto"'))}
        ${field("TEAM COLUMN HEADER (OPTIONAL)", input("leaderboardTeamColumn", cf.leaderboardTeamColumn, 'placeholder="auto (falls back to Racer Registration)"'))}
        <button class="btn btn-primary" type="submit">SAVE &amp; RELOAD</button></form>
        <small class="hint">Type the header text exactly as it appears in row 1 of that tab. Data refreshes every minute.</small></div></div>`;
    $("dcForm").onsubmit = (e) => { e.preventDefault(); adminDo("saveConfig", Object.fromEntries(new FormData(e.target)), "Saved. Reloading data…"); };
  }

  /* --- image upload: resize in browser, send to Drive via backend --- */
  function wireUploads(scope) {
    scope.querySelectorAll("[data-upload]").forEach((inp) => {
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return; setMsg("adminMsg", "Uploading image…");
        try {
          const dataUrl = await resize(f, 1600);
          const r = await call("uploadImage", { dataUrl });
          scope.querySelector(`[name="${inp.dataset.upload}"]`).value = r.url;
          scope.querySelector(`[name="${inp.dataset.upload}"]`).dispatchEvent(new Event("input", { bubbles: true }));
          setMsg("adminMsg", "Image uploaded — now save the form.");
        } catch (e) { setMsg("adminMsg", e.message, true); }
        inp.value = "";
      };
    });
  }
  function resize(file, max) {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.86));
      };
      img.onerror = () => rej(new Error("That file isn't a readable image.")); img.src = url;
    });
  }

  /* ------------------------------------ boot ------------------------------------ */
  async function refresh() { try { await loadPublic(); } catch (e) { console.warn("League data unavailable", e); } renderAll(); }
  function renderAll() { renderEvents(); renderStandings(); renderMedia(); searchDrivers(); }

  $("year").textContent = new Date().getFullYear();
  $("discordJoin").href = cfg.discordInviteUrl || "#"; $("rulesLink").href = cfg.rulesUrl || cfg.discordInviteUrl || "#";
  $("navToggle").addEventListener("click", () => { const o = $("nav").classList.toggle("open"); $("navToggle").setAttribute("aria-expanded", o); });
  document.querySelectorAll("#nav a").forEach((a) => a.addEventListener("click", () => $("nav").classList.remove("open")));

  (async function boot() {
    renderAuth(); renderAll();
    if (!cfg.apiUrl || !cfg.googleClientId) {
      const n = $("setupNotice"); n.hidden = false;
      n.innerHTML = "<b>Setup needed:</b> add your Apps Script <code>apiUrl</code>" + (cfg.googleClientId ? "" : " and Google <code>googleClientId</code>") + " in <code>config.js</code> to switch on live points, logins and sign-ups.";
    }
    waitForGoogle(() => {});
    await refresh();
    if (tokenOk() && cfg.apiUrl) { try { await refreshMe(); renderAuth(); renderEvents(); } catch { /* signed out */ } }
    else if (store.get("brs_was_in") && cfg.apiUrl) { waitForGoogle((ok) => { if (ok) google.accounts.id.prompt(); }); }
    setInterval(refresh, 120000);
  })();
})();
