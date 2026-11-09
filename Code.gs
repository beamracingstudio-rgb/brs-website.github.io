/**
 * BRS backend — Google Apps Script Web App
 * ---------------------------------------------------------------
 * Paste into the Apps Script editor of your league spreadsheet
 * (Extensions → Apps Script), set GOOGLE_CLIENT_ID below, run setup()
 * once, then Deploy → New deployment → Web app
 *   Execute as: Me      Who has access: Anyone
 *
 * It NEVER writes to your existing tabs (Racer Registration, Races,
 * Leaderboard, Points, SL Calc, Extra Notes). It only reads them.
 * Everything the website adds lives in tabs starting with "Site ".
 */

const GOOGLE_CLIENT_ID = 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com';
const SPREADSHEET_ID = '1p5yfjN6FO53IICf05Pax8nZMdirhEbZMvuzUYj5_RpQ';

// Existing tabs (read only)
const DRIVER_TAB = 'Racer Registration';
const LEADERBOARD_TAB = 'Leaderboard'; // can be overridden in "Site Config" (leaderboardTab)

// Tabs created and managed by the website
const T = {
  users:   { name: 'Site Users',   cols: ['email','driverName','discord','number','team','picture','createdAt','updatedAt'] },
  events:  { name: 'Site Events',  cols: ['id','title','date','time','track','className','description','fee','currency','paymentUrl','capacity','status','image','createdAt'] },
  signups: { name: 'Site Signups', cols: ['id','eventId','eventTitle','email','driverName','discord','status','fee','currency','paymentRef','createdAt','updatedAt'] },
  media:   { name: 'Site Media',   cols: ['id','type','title','url','category','createdAt'] },
  admins:  { name: 'Site Admins',  cols: ['email','addedAt'] },
  config:  { name: 'Site Config',  cols: ['key','value'] }
};

const SIGNUP_STATUS = ['Confirmed','Pending payment','Payment submitted','Paid','Cancelled','Refunded'];
const DEFAULT_CONFIG = {
  paymentLinkTemplate: '',      // e.g. https://paypal.me/YourName/{amount}{currency}
  paymentInstructions: 'Pay the entry fee with the button, then enter your payment reference so an admin can confirm it.',
  currency: 'USD',
  leaderboardTab: '',
  leaderboardNameColumn: '',
  leaderboardPointsColumn: '',
  leaderboardTeamColumn: ''
};

/* ------------------------------ entry points ------------------------------ */

function doGet(e) {
  try {
    const a = (e && e.parameter && e.parameter.action) || 'public';
    if (a !== 'public') return out_({ ok: false, error: 'Use POST for this action.', code: 'bad_request' });
    return out_({ ok: true, data: publicData_() });
  } catch (err) { return fail_(err); }
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[req.action];
    if (!handler) throw httpErr_('Unknown action.', 'bad_request');
    const needsAuth = req.action !== 'public';
    const user = needsAuth ? verifyToken_(req.token) : null;
    const isAdmin = !!user && isAdmin_(user.email);
    if (handler.admin && !isAdmin) throw httpErr_('Admin access required.', 'forbidden');
    const run = () => handler.fn(req, user, isAdmin);
    const result = handler.write ? withLock_(run) : run();
    return out_({ ok: true, data: result });
  } catch (err) { return fail_(err); }
}

const ACTIONS = {
  public:        { fn: () => publicData_() },
  me:            { fn: (r, u, adm) => me_(u, adm) },
  saveProfile:   { fn: (r, u) => saveProfile_(r, u), write: true },
  signup:        { fn: (r, u) => signup_(r, u), write: true },
  cancelSignup:  { fn: (r, u) => cancelSignup_(r, u), write: true },
  submitPayment: { fn: (r, u) => submitPayment_(r, u), write: true },

  adminData:       { fn: () => adminData_(), admin: true },
  saveEvent:       { fn: (r) => saveEvent_(r), admin: true, write: true },
  deleteEvent:     { fn: (r) => deleteById_(T.events, r.id), admin: true, write: true },
  saveMedia:       { fn: (r) => saveMedia_(r), admin: true, write: true },
  deleteMedia:     { fn: (r) => deleteById_(T.media, r.id), admin: true, write: true },
  uploadImage:     { fn: (r) => uploadImage_(r), admin: true },
  setSignupStatus: { fn: (r) => setSignupStatus_(r), admin: true, write: true },
  adminSignup:     { fn: (r) => adminSignup_(r), admin: true, write: true },
  saveConfig:      { fn: (r) => saveConfig_(r), admin: true, write: true },
  addAdmin:        { fn: (r) => addAdmin_(r), admin: true, write: true },
  removeAdmin:     { fn: (r, u) => removeAdmin_(r, u), admin: true, write: true }
};

/* ----------------------------- one-time setup ----------------------------- */

/** Run once from the editor. Creates the "Site …" tabs and makes you the first admin. */
function setup() {
  Object.keys(T).forEach(k => table_(T[k]));
  const me = Session.getEffectiveUser().getEmail();
  if (me && !readAll_(T.admins).some(a => lc_(a.email) === lc_(me))) {
    append_(T.admins, { email: lc_(me), addedAt: now_() });
  }
  Logger.log('Setup done. First admin: ' + me);
}

/* --------------------------------- auth ---------------------------------- */

function verifyToken_(token) {
  if (!token) throw httpErr_('Please sign in.', 'auth');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw httpErr_('Your sign-in expired. Please sign in again.', 'auth');
  const p = JSON.parse(res.getContentText());
  if (p.aud !== GOOGLE_CLIENT_ID) throw httpErr_('Sign-in was issued for a different app.', 'auth');
  if (String(p.email_verified) !== 'true') throw httpErr_('Your Google email is not verified.', 'auth');
  const ttl = Math.min(300, Number(p.exp) - Math.floor(Date.now() / 1000));
  if (ttl <= 0) throw httpErr_('Your sign-in expired. Please sign in again.', 'auth');
  const user = { email: lc_(p.email), name: p.name || '', picture: p.picture || '' };
  cache.put(key, JSON.stringify(user), ttl);
  return user;
}

function isAdmin_(email) {
  return readAll_(T.admins).some(a => lc_(a.email) === lc_(email));
}

/* ------------------------------ public data ------------------------------- */

function publicData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('public_v1');
  if (hit) return JSON.parse(hit);
  const data = buildPublic_();
  try { cache.put('public_v1', JSON.stringify(data), 60); } catch (e) { /* too large: skip caching */ }
  return data;
}
function bustCache_() { CacheService.getScriptCache().remove('public_v1'); }

function buildPublic_() {
  const pts = readPoints_();
  const cfg = getConfig_();
  const signups = readAll_(T.signups).filter(s => s.status !== 'Cancelled' && s.status !== 'Refunded');
  const count = {};
  signups.forEach(s => count[s.eventId] = (count[s.eventId] || 0) + 1);

  const events = readAll_(T.events).filter(e => e.status !== 'Draft').map(e => {
    const fee = num_(e.fee);
    const cap = num_(e.capacity);
    return {
      id: e.id, title: e.title, date: e.date, time: e.time, track: e.track, className: e.className,
      description: e.description, image: e.image, status: e.status || 'Open',
      fee: fee, currency: e.currency || cfg.currency, paid: fee > 0,
      capacity: cap || 0, entries: count[e.id] || 0
    };
  });
  const media = readAll_(T.media).map(m => ({ id: m.id, type: m.type, title: m.title, url: m.url, category: m.category }));
  return { drivers: pts.drivers, teams: pts.teams, events: events, media: media, updatedAt: now_() };
}

/* ------------- reading your existing spreadsheet (points & teams) ---------- */

function readPoints_() {
  const ss = ss_();
  const cfg = getConfig_();
  const drivers = {};   // key: lowercase name

  // 1) Racer Registration: name (col A, header blank), Team, Number, License Points, Class, ...
  const reg = ss.getSheetByName(DRIVER_TAB);
  if (reg) {
    const grid = reg.getDataRange().getValues();
    const hi = findHeaderRow_(grid, ['team', 'license points']);
    if (hi >= 0) {
      const h = grid[hi].map(norm_);
      const c = {
        name: firstCol_(h, ['name', 'driver', 'racer', 'driver name']),
        team: firstCol_(h, ['team']),
        number: firstCol_(h, ['number', 'no', '#']),
        lp: firstCol_(h, ['license points']),
        cls: firstCol_(h, ['class']),
        next: firstCol_(h, ['to next class']),
        sl: firstCol_(h, ['super license']),
        wins: firstCol_(h, ['wins']),
        dnf: firstCol_(h, ['dnf'])
      };
      if (c.name < 0) c.name = 0; // the sheet leaves the name header blank in column A
      for (let r = hi + 1; r < grid.length; r++) {
        const row = grid[r];
        const name = String(row[c.name] || '').trim();
        if (!name) continue;
        drivers[name.toLowerCase()] = {
          name: name, team: str_(row[c.team]), number: str_(row[c.number]),
          licensePoints: numOrNull_(row[c.lp]), level: str_(row[c.cls]),
          toNextClass: numOrNull_(row[c.next]), superLicense: numOrNull_(row[c.sl]),
          wins: numOrNull_(row[c.wins]), dnf: numOrNull_(row[c.dnf]), racePoints: null
        };
      }
    }
  }

  // 2) Leaderboard: personal (race) points. Columns found automatically, or set in Site Config.
  const lbName = cfg.leaderboardTab || LEADERBOARD_TAB;
  const lb = ss.getSheetByName(lbName);
  const lbInfo = { tab: lbName, found: !!lb, nameCol: null, pointsCol: null, teamCol: null, rows: 0 };
  if (lb) {
    const grid = lb.getDataRange().getValues();
    const nameAliases = cfg.leaderboardNameColumn ? [norm_(cfg.leaderboardNameColumn)] : ['name', 'driver', 'racer', 'driver name', 'player'];
    const ptsAliases = cfg.leaderboardPointsColumn ? [norm_(cfg.leaderboardPointsColumn)]
      : ['points', 'total points', 'total', 'race points', 'championship points', 'pts'];
    const hi = findHeaderRow_(grid, nameAliases, ptsAliases);
    if (hi >= 0) {
      const h = grid[hi].map(norm_);
      const cn = firstCol_(h, nameAliases), cp = firstCol_(h, ptsAliases);
      const ct = firstCol_(h, cfg.leaderboardTeamColumn ? [norm_(cfg.leaderboardTeamColumn)] : ['team']);
      lbInfo.nameCol = String(grid[hi][cn]); lbInfo.pointsCol = String(grid[hi][cp]);
      lbInfo.teamCol = ct >= 0 ? String(grid[hi][ct]) : null;
      for (let r = hi + 1; r < grid.length; r++) {
        const name = String(grid[r][cn] || '').trim();
        if (!name) continue;
        const pts = numOrNull_(grid[r][cp]);
        if (pts === null) continue;
        lbInfo.rows++;
        const k = name.toLowerCase();
        if (!drivers[k]) drivers[k] = { name: name, team: '', number: '', licensePoints: null, level: '', toNextClass: null, superLicense: null, wins: null, dnf: null };
        drivers[k].racePoints = pts;
        if (ct >= 0 && !drivers[k].team) drivers[k].team = str_(grid[r][ct]);
      }
    }
  }
  readPoints_.lastInfo = lbInfo;

  const list = Object.keys(drivers).map(k => drivers[k]);
  list.sort((a, b) => (b.racePoints === null ? -1e9 : b.racePoints) - (a.racePoints === null ? -1e9 : a.racePoints) || a.name.localeCompare(b.name));
  list.forEach((d, i) => { d.rank = d.racePoints === null ? null : i + 1; });

  // 3) Team points = sum of members' race points
  const teams = {};
  list.forEach(d => {
    if (!d.team) return;
    const k = d.team.toLowerCase();
    const t = teams[k] || (teams[k] = { name: d.team, points: 0, drivers: [], wins: 0 });
    t.points += d.racePoints || 0;
    t.wins += d.wins || 0;
    t.drivers.push(d.name);
  });
  const teamList = Object.keys(teams).map(k => teams[k]).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  teamList.forEach((t, i) => { t.rank = i + 1; t.drivers = t.drivers.join(', '); });
  return { drivers: list, teams: teamList };
}

/* -------------------------------- user API -------------------------------- */

function me_(user, isAdmin) {
  const profile = findOne_(T.users, 'email', user.email);
  const cfg = getConfig_();
  const signups = readAll_(T.signups).filter(s => lc_(s.email) === user.email)
    .map(s => withPay_(s, cfg, eventById_(s.eventId)));
  return {
    email: user.email, name: user.name, picture: user.picture, isAdmin: isAdmin,
    profile: profile ? pick_(profile, ['driverName','discord','number','team']) : null,
    signups: signups, paymentInstructions: cfg.paymentInstructions
  };
}

function saveProfile_(r, user) {
  const driverName = clean_(r.driverName, 40), discord = clean_(r.discord, 40);
  if (!driverName) throw httpErr_('Enter your in-game driver name.', 'bad_request');
  if (!discord) throw httpErr_('Enter your Discord username.', 'bad_request');
  const clash = readAll_(T.users).find(u => lc_(u.driverName) === lc_(driverName) && lc_(u.email) !== user.email);
  if (clash) throw httpErr_('That driver name is already taken by another account.', 'conflict');
  const rec = { email: user.email, driverName: driverName, discord: discord,
    number: clean_(r.number, 6), team: clean_(r.team, 40), picture: user.picture, updatedAt: now_() };
  const existing = findOne_(T.users, 'email', user.email);
  if (existing) updateRow_(T.users, existing._row, rec);
  else { rec.createdAt = now_(); append_(T.users, rec); }
  return me_(user, isAdmin_(user.email));
}

function signup_(r, user) {
  const profile = findOne_(T.users, 'email', user.email);
  if (!profile || !profile.driverName) throw httpErr_('Complete your driver profile first.', 'profile');
  const ev = eventById_(r.eventId);
  if (!ev || ev.status === 'Draft') throw httpErr_('Race not found.', 'not_found');
  if ((ev.status || 'Open') !== 'Open') throw httpErr_('Registration for this race is closed.', 'closed');

  const all = readAll_(T.signups);
  const mine = all.find(s => s.eventId === ev.id && lc_(s.email) === user.email);
  if (mine && mine.status !== 'Cancelled' && mine.status !== 'Refunded') throw httpErr_('You are already registered for this race.', 'conflict');
  const active = all.filter(s => s.eventId === ev.id && s.status !== 'Cancelled' && s.status !== 'Refunded').length;
  if (num_(ev.capacity) > 0 && active >= num_(ev.capacity)) throw httpErr_('This race is full.', 'full');

  const cfg = getConfig_();
  const fee = num_(ev.fee);
  const rec = {
    eventId: ev.id, eventTitle: ev.title, email: user.email, driverName: profile.driverName, discord: profile.discord,
    status: fee > 0 ? 'Pending payment' : 'Confirmed', fee: fee, currency: ev.currency || cfg.currency,
    paymentRef: '', updatedAt: now_()
  };
  let row;
  if (mine) { updateRow_(T.signups, mine._row, rec); row = Object.assign({}, mine, rec); }
  else { rec.id = uid_(); rec.createdAt = now_(); append_(T.signups, rec); row = rec; }
  bustCache_();
  return withPay_(row, cfg, ev);
}

function cancelSignup_(r, user) {
  const s = findOne_(T.signups, 'id', r.id);
  if (!s || lc_(s.email) !== user.email) throw httpErr_('Entry not found.', 'not_found');
  if (s.status === 'Paid') throw httpErr_('Paid entries must be cancelled by an admin so your refund can be handled.', 'forbidden');
  updateRow_(T.signups, s._row, { status: 'Cancelled', updatedAt: now_() });
  bustCache_();
  return { id: s.id, status: 'Cancelled' };
}

function submitPayment_(r, user) {
  const s = findOne_(T.signups, 'id', r.id);
  if (!s || lc_(s.email) !== user.email) throw httpErr_('Entry not found.', 'not_found');
  if (s.status === 'Paid') return { id: s.id, status: 'Paid' };
  if (s.status === 'Cancelled' || s.status === 'Refunded') throw httpErr_('This entry is cancelled.', 'closed');
  const ref = clean_(r.paymentRef, 80);
  if (!ref) throw httpErr_('Enter your payment reference or transaction ID.', 'bad_request');
  updateRow_(T.signups, s._row, { status: 'Payment submitted', paymentRef: ref, updatedAt: now_() });
  return { id: s.id, status: 'Payment submitted', paymentRef: ref };
}

/* -------------------------------- admin API -------------------------------- */

function adminData_() {
  const cfg = getConfig_();
  const pts = readPoints_();
  return {
    events: readAll_(T.events).map(strip_),
    signups: readAll_(T.signups).map(strip_),
    media: readAll_(T.media).map(strip_),
    users: readAll_(T.users).map(strip_),
    admins: readAll_(T.admins).map(strip_),
    config: cfg,
    statuses: SIGNUP_STATUS,
    connection: {
      registrationTab: !!ss_().getSheetByName(DRIVER_TAB),
      leaderboard: readPoints_.lastInfo,
      drivers: pts.drivers.length, teams: pts.teams.length,
      withPoints: pts.drivers.filter(d => d.racePoints !== null).length,
      tabs: ss_().getSheets().map(s => s.getName())
    }
  };
}

function saveEvent_(r) {
  const title = clean_(r.title, 80);
  if (!title) throw httpErr_('Give the race a title.', 'bad_request');
  const fee = r.fee === '' || r.fee == null ? 0 : Number(r.fee);
  if (!isFinite(fee) || fee < 0 || fee > 10000) throw httpErr_('Price must be a number from 0 up.', 'bad_request');
  const rec = {
    title: title, date: clean_(r.date, 10), time: clean_(r.time, 20), track: clean_(r.track, 80),
    className: clean_(r.className, 40), description: clean_(r.description, 600),
    fee: fee, currency: clean_(r.currency, 5).toUpperCase() || getConfig_().currency,
    paymentUrl: url_(r.paymentUrl, true), capacity: Math.max(0, parseInt(r.capacity, 10) || 0),
    status: ['Open','Closed','Draft'].indexOf(r.status) >= 0 ? r.status : 'Open', image: url_(r.image, true)
  };
  if (r.id) {
    const ex = findOne_(T.events, 'id', r.id);
    if (!ex) throw httpErr_('Race not found.', 'not_found');
    updateRow_(T.events, ex._row, rec);
    rec.id = r.id;
    // keep signups' stored title/fee in sync while payment is still outstanding
    readAll_(T.signups).filter(s => s.eventId === r.id).forEach(s => {
      const patch = { eventTitle: title };
      if (s.status === 'Pending payment') { patch.fee = fee; patch.currency = rec.currency; }
      updateRow_(T.signups, s._row, patch);
    });
  } else { rec.id = uid_(); rec.createdAt = now_(); append_(T.events, rec); }
  bustCache_();
  return rec;
}

function saveMedia_(r) {
  const type = r.type === 'picture' ? 'picture' : 'video';
  const title = clean_(r.title, 80);
  const u = url_(r.url, false);
  if (!title) throw httpErr_('Give it a title.', 'bad_request');
  const rec = { type: type, title: title, url: u, category: clean_(r.category, 30) };
  if (r.id) {
    const ex = findOne_(T.media, 'id', r.id);
    if (!ex) throw httpErr_('Item not found.', 'not_found');
    updateRow_(T.media, ex._row, rec); rec.id = r.id;
  } else { rec.id = uid_(); rec.createdAt = now_(); append_(T.media, rec); }
  bustCache_();
  return rec;
}

function deleteById_(tbl, id) {
  const row = findOne_(tbl, 'id', id);
  if (!row) throw httpErr_('Not found.', 'not_found');
  table_(tbl).sh.deleteRow(row._row);
  bustCache_();
  return { id: id };
}

/** Admin uploads a picture (already resized in the browser) → saved to a Drive folder, shareable link returned. */
function uploadImage_(r) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(r.dataUrl || ''));
  if (!m) throw httpErr_('Upload a JPG, PNG, WebP or GIF image.', 'bad_request');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 6 * 1024 * 1024) throw httpErr_('Image is too large (max about 6 MB).', 'bad_request');
  const folders = DriveApp.getFoldersByName('BRS Website Uploads');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('BRS Website Uploads');
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
  const file = folder.createFile(Utilities.newBlob(bytes, m[1], 'brs-' + uid_() + '.' + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: 'https://lh3.googleusercontent.com/d/' + file.getId() };
}

function setSignupStatus_(r) {
  if (SIGNUP_STATUS.indexOf(r.status) < 0) throw httpErr_('Unknown status.', 'bad_request');
  const s = findOne_(T.signups, 'id', r.id);
  if (!s) throw httpErr_('Entry not found.', 'not_found');
  updateRow_(T.signups, s._row, { status: r.status, updatedAt: now_() });
  bustCache_();
  return { id: s.id, status: r.status };
}

/** Admin registers a driver for a race by hand (e.g. someone who paid in Discord). */
function adminSignup_(r) {
  const ev = eventById_(r.eventId);
  if (!ev) throw httpErr_('Race not found.', 'not_found');
  const driverName = clean_(r.driverName, 40);
  if (!driverName) throw httpErr_('Enter a driver name.', 'bad_request');
  const user = readAll_(T.users).find(u => lc_(u.driverName) === lc_(driverName));
  const status = SIGNUP_STATUS.indexOf(r.status) >= 0 ? r.status : (num_(ev.fee) > 0 ? 'Paid' : 'Confirmed');
  const rec = { id: uid_(), eventId: ev.id, eventTitle: ev.title, email: user ? lc_(user.email) : '',
    driverName: user ? user.driverName : driverName, discord: user ? user.discord : clean_(r.discord, 40),
    status: status, fee: num_(ev.fee), currency: ev.currency || getConfig_().currency, paymentRef: 'added by admin',
    createdAt: now_(), updatedAt: now_() };
  append_(T.signups, rec);
  bustCache_();
  return rec;
}

function saveConfig_(r) {
  Object.keys(DEFAULT_CONFIG).forEach(k => {
    if (r[k] === undefined) return;
    let v = String(r[k]).trim().slice(0, 300);
    if (k === 'paymentLinkTemplate' && v) v = url_(v.replace(/\{[a-z]+\}/g, 'x'), false) && v;
    setConfig_(k, v);
  });
  bustCache_();
  return getConfig_();
}

function addAdmin_(r) {
  const email = lc_(r.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpErr_('Enter a valid email address.', 'bad_request');
  if (!isAdmin_(email)) append_(T.admins, { email: email, addedAt: now_() });
  return readAll_(T.admins).map(strip_);
}

function removeAdmin_(r, user) {
  const email = lc_(r.email);
  const admins = readAll_(T.admins);
  if (admins.length <= 1) throw httpErr_('There must be at least one admin.', 'forbidden');
  if (email === user.email) throw httpErr_('You cannot remove yourself.', 'forbidden');
  const a = admins.find(x => lc_(x.email) === email);
  if (a) table_(T.admins).sh.deleteRow(a._row);
  return readAll_(T.admins).map(strip_);
}

/* ------------------------------ payment links ------------------------------ */

function withPay_(s, cfg, ev) {
  const o = strip_(s);
  o.payUrl = '';
  if (ev && num_(s.fee) > 0 && (s.status === 'Pending payment' || s.status === 'Payment submitted')) {
    o.payUrl = ev.paymentUrl || fillTemplate_(cfg.paymentLinkTemplate, ev, s);
  }
  return o;
}
function fillTemplate_(tpl, ev, s) {
  if (!tpl) return '';
  const amount = num_(s.fee);
  return tpl.replace(/\{amount\}/g, String(amount % 1 ? amount.toFixed(2) : amount))
    .replace(/\{currency\}/g, encodeURIComponent(s.currency || ''))
    .replace(/\{event\}/g, encodeURIComponent(ev.title || ''))
    .replace(/\{id\}/g, encodeURIComponent(s.id || ''));
}

/* -------------------------------- sheet helpers -------------------------------- */

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function table_(tbl) {
  const ss = ss_();
  let sh = ss.getSheetByName(tbl.name);
  if (!sh) {
    sh = ss.insertSheet(tbl.name);
    sh.getRange(1, 1, 1, tbl.cols.length).setValues([tbl.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), tbl.cols.length).setNumberFormat('@'); // keep everything as plain text
  }
  return { sh: sh, cols: tbl.cols };
}

function readAll_(tbl) {
  const t = table_(tbl);
  const last = t.sh.getLastRow();
  if (last < 2) return [];
  const vals = t.sh.getRange(2, 1, last - 1, t.cols.length).getValues();
  const out = [];
  vals.forEach((row, i) => {
    if (!row.some(v => v !== '')) return;
    const o = { _row: i + 2 };
    t.cols.forEach((c, j) => o[c] = row[j] instanceof Date ? row[j].toISOString() : String(row[j]));
    out.push(o);
  });
  return out;
}

function append_(tbl, obj) {
  const t = table_(tbl);
  const row = t.cols.map(c => safeCell_(obj[c]));
  t.sh.appendRow(row);
}

function updateRow_(tbl, row, patch) {
  const t = table_(tbl);
  Object.keys(patch).forEach(k => {
    const j = t.cols.indexOf(k);
    if (j >= 0) t.sh.getRange(row, j + 1).setValue(safeCell_(patch[k]));
  });
}

function findOne_(tbl, col, value) {
  return readAll_(tbl).find(r => lc_(r[col]) === lc_(value)) || null;
}
function eventById_(id) { return findOne_(T.events, 'id', id); }

function getConfig_() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  readAll_(T.config).forEach(r => { if (r.key in DEFAULT_CONFIG && r.value !== '') cfg[r.key] = r.value; });
  return cfg;
}
function setConfig_(key, value) {
  const row = findOne_(T.config, 'key', key);
  if (row) updateRow_(T.config, row._row, { value: value });
  else append_(T.config, { key: key, value: value });
}

// Header lookup helpers for the league's own tabs
function norm_(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' '); }
function firstCol_(headers, aliases) {
  for (let i = 0; i < aliases.length; i++) { const j = headers.indexOf(aliases[i]); if (j >= 0) return j; }
  return -1;
}
/** First row (within the top 15) that contains a header from each alias group. */
function findHeaderRow_() {
  const groups = Array.prototype.slice.call(arguments, 1);
  const grid = arguments[0];
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const h = grid[r].map(norm_);
    if (groups.every(g => firstCol_(h, g) >= 0)) return r;
  }
  return -1;
}

/* --------------------------------- utilities --------------------------------- */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function fail_(err) {
  if (!err.code) console.error(err && err.stack || err);
  return out_({ ok: false, error: err.code ? err.message : 'Something went wrong. Please try again.', code: err.code || 'server' });
}
function httpErr_(message, code) { const e = new Error(message); e.code = code; return e; }
function now_() { return new Date().toISOString(); }
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function lc_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function str_(v) { return v == null ? '' : String(v).trim(); }
function num_(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function numOrNull_(v) { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; }
function strip_(o) { const c = Object.assign({}, o); delete c._row; return c; }
function pick_(o, keys) { const c = {}; keys.forEach(k => c[k] = o[k]); return c; }
/** Trim, cap length, drop control characters. */
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
/** Only http(s) links are allowed anywhere a URL is stored. */
function url_(v, optional) {
  const s = String(v == null ? '' : v).trim();
  if (!s && optional) return '';
  if (!/^https:\/\/[^\s]+$/i.test(s) || s.length > 500) throw httpErr_('Enter a full https:// link.', 'bad_request');
  return s;
}
/** Stop spreadsheet formula injection from user-supplied text. */
function safeCell_(v) {
  if (typeof v !== 'string') return v == null ? '' : v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
