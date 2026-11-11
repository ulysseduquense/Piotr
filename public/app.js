// Piotr — interface (vanilla JS). Toute la logique métier passe par /api/*.
// Tous les textes visibles passent par t() (dictionnaires public/i18n/*.js) ou par data-i18n dans index.html.
// Un compte est une personne ; son rôle (prestataire ou client) dépend de l'activité ouverte (voir setActivity).
const $ = s => document.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Langue ----------
const LANGS = ['fr', 'pl'];
const LOCALE = { fr: 'fr-BE', pl: 'pl-PL' };
const LANG_KEY = 'piotr.lang';
const I18N = window.I18N || {};
function detectLang() {
  try { const s = localStorage.getItem(LANG_KEY); if (LANGS.includes(s)) return s; } catch { /* stockage indisponible */ }
  for (const l of navigator.languages || [navigator.language]) {
    const base = String(l || '').toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'fr';
}
let lang = detectLang();
const loc = () => LOCALE[lang] || LOCALE.fr;
const has = k => (I18N[lang] && I18N[lang][k] != null) || (I18N.fr && I18N.fr[k] != null);
const missingKeys = new Set();
const pluralRules = {};
// t('clé', { name: 'x' }) ; avec { count } : essaie clé.<forme Intl.PluralRules>, puis clé.other, puis clé.
function t(key, params) {
  if (params && typeof params.count === 'number') {
    const cat = (pluralRules[lang] ||= new Intl.PluralRules(loc())).select(params.count);
    key = [key + '.' + cat, key + '.other'].find(has) || key;
  }
  let s = I18N[lang]?.[key];
  if (s == null) {
    if (!missingKeys.has(key)) { missingKeys.add(key); console.warn(`i18n: clé « ${key} » absente du dictionnaire « ${lang} »`); }
    s = I18N.fr?.[key] ?? key;
  }
  return params ? s.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m)) : s;
}
const setI18n = (el, key) => { el.dataset.i18n = key; el.textContent = t(key); };
// Textes statiques d'index.html : data-i18n="clé" (contenu) et data-i18n-attr="attr:clé,attr2:clé2" (attributs).
function translateStatic() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-attr]').forEach(el => el.dataset.i18nAttr.split(',').forEach(pair => {
    const i = pair.indexOf(':');
    el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
  }));
}
function renderLangSwitch(el) {
  el.setAttribute('aria-label', t('lang.label'));
  el.innerHTML = LANGS.map((l, i) => `${i ? '<i aria-hidden="true"></i>' : ''}<button type="button" data-lang="${l}" aria-pressed="${l === lang}"
    aria-label="${esc(t('lang.' + l))}" title="${esc(t('lang.' + l))}">${l.toUpperCase()}</button>`).join('');
  $$('button', el).forEach(b => b.onclick = () => setLang(b.dataset.lang));
}
function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* stockage indisponible */ }
  applyLang();
}
// Langue changée dans un autre onglet : on suit (y compris un dialogue ouvert, inerte derrière son voile).
addEventListener('storage', e => { if (e.key === LANG_KEY && LANGS.includes(e.newValue)) setLang(e.newValue); });
// (Re)traduit tout ce qui est affiché, sans recharger la page.
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('app.title');
  translateStatic();
  $$('.lang').forEach(renderLangSwitch);
  if (me) {
    renderSwitcher();
    if (calendar) {
      calendar.setOption('locale', lang);
      calendar.getEvents().forEach(ev => ev.setProp('title', eventTitle(ev.extendedProps)));
      $('#calTitle').textContent = calendar.view.title;
    }
    if (!$('#bookings').hidden) drawBookings();
    if (!$('#admin').hidden) { drawAdmin(); drawMembers(); }
    if (!$('#onboarding').hidden) drawOnboarding();
    if (!$('#activities').hidden) drawActivities();
    if (dlg.open && dlgRender) rerenderDialog();
    if (lb.open && lbState) renderLightbox();
  }
  if (!$('#join').hidden) drawJoin();
  retoast();
}

// ---------- Formats (Intl, selon la langue) ----------
const eur = n => (n || 0).toLocaleString(loc(), { style: 'currency', currency: 'EUR' });
const fmtH = h => Number(h || 0).toLocaleString(loc(), { maximumFractionDigits: 2 });
const fmt = d => new Date(d).toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = d => new Date(d).toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = d => new Date(d).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtRange = (s, e) => sameDay(s, e)
  ? t('date.same_day', { day: fmtDay(s), from: fmtTime(s), to: fmtTime(e) })
  : t('date.span', { from: fmt(s), to: fmt(e) });
// date d'une prestation (YYYY-MM-DD) → « 10 nov. 2026 »
const fmtDate = d => { const x = new Date(d + 'T00:00'); return isNaN(x) ? esc(d) : x.toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' }); };
// horodatage SQLite (« 2026-11-10 16:20:33 », en UTC, sans indicateur de fuseau) → Date
const sqlDate = s => { s = String(s || ''); return new Date(s.includes('T') ? s : s.replace(' ', 'T') + (/(Z|[+-]\d\d:?\d\d)$/.test(s) ? '' : 'Z')); };
const fmtSqlDay = s => { const x = sqlDate(s); return isNaN(x) ? '' : x.toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' }); };
const STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled', 'done'];
const statusLabel = s => STATUSES.includes(s) ? t('status.' + s) : esc(s);
const pill = s => `<span class="pill ${esc(s)}">${statusLabel(s)}</span>`;
// valeur pour <input type="datetime-local"> en heure locale
const localInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const mobileMQ = matchMedia('(max-width: 699px)');
const isMobile = () => mobileMQ.matches;
const firstName = n => String(n || '').trim().split(/\s+/)[0];

// ---------- État ----------
// me : compte connecté ; activities : ses activités (/api/me) ; act : activité ouverte (null : aucune / sélecteur).
const ACT_KEY = 'piotr.activity';
let me = null, activities = [], act = null, calendar = null;
const isOwner = () => act?.role === 'owner';
// Suffixe des clés de texte qui dépendent du rôle (nav.bookings.admin / .client, cal.hint.admin…).
const roleKey = () => (isOwner() ? 'admin' : 'client');
const actById = id => activities.find(a => a.id === Number(id)) || null;
// Rôle de l'utilisateur dans l'activité d'une intervention (celle ouverte, sauf cas limite d'une fiche d'une autre activité).
const ownerOf = b => (b && actById(b.activity_id) || act)?.role === 'owner';
const ownerName = b => (b && actById(b.activity_id) || act)?.owner_name || '';
const apiAct = (path = '') => `/api/activities/${act.id}${path}`;
const inviteURL = code => `${location.origin}/join/${code}`;
// Code d'un lien d'invitation collé tel quel (« https://…/join/abc… ») ou saisi seul.
const parseInviteCode = v => { const s = String(v || '').trim(); const m = s.match(/\/join\/([A-Za-z0-9]+)/); return (m ? m[1] : s.replace(/\/+$/, '')).toLowerCase(); };
const roleTag = role => `<span class="tag ${esc(role)}">${t('role.' + role)}</span>`;

// ---------- API et erreurs ----------
class ApiError extends Error {
  constructor(data = {}, status = 0) { super(String(data.error || '')); this.code = data.code; this.status = status; }
}
// Corps JSON par défaut ; un FormData (envoi de fichiers) part tel quel, sans en-tête Content-Type (le navigateur met le sien).
async function api(url, opts = {}) {
  let res;
  const form = opts.body instanceof FormData;
  try {
    res = await fetch(url, { ...opts, headers: form ? opts.headers : { 'Content-Type': 'application/json', ...opts.headers },
      body: form ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined) });
  } catch { throw new ApiError({ code: 'OFFLINE' }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data, res.status);
  return data;
}
// Clé de dictionnaire d'une erreur : err.<code> si le code est connu, err.UNKNOWN si le serveur n'a rien dit, sinon ''.
const errKey = err => { const k = err?.code ? 'err.' + err.code : ''; return k && has(k) ? k : (err?.message ? '' : 'err.UNKNOWN'); };
const errText = err => errKey(err) ? t(errKey(err)) : err.message;
function showError(sel, err) {
  const el = typeof sel === 'string' ? $(sel) : sel; if (!el) return;
  const k = errKey(err);
  if (k) el.dataset.i18n = k; else delete el.dataset.i18n; // retraduit au changement de langue
  el.textContent = errText(err);
}
function clearError(sel) { const el = typeof sel === 'string' ? $(sel) : sel; if (!el) return; delete el.dataset.i18n; el.textContent = ''; }

// ---------- Toast ----------
let toastTimer, toastHideTimer, toastLast = null;
// Le toast est un popover (« top layer ») : un simple z-index resterait caché derrière un dialogue modal
// (fiche d'intervention, visionneuse), surtout sur téléphone où la fiche couvre tout le bas de l'écran.
// Il est rouvert à chaque affichage pour repasser au-dessus d'un dialogue ouvert entre-temps.
function showToast(text) {
  const el = $('#toast');
  clearTimeout(toastTimer); clearTimeout(toastHideTimer);
  try {
    if (el.showPopover) { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); el.getBoundingClientRect(); /* style calculé avant .show : le fondu joue */ }
  } catch { /* navigateur sans Popover API : le toast reste un élément fixe classique */ }
  el.textContent = text; el.classList.add('show');
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    toastHideTimer = setTimeout(() => { try { if (el.matches(':popover-open')) el.hidePopover(); } catch { /* idem */ } }, 220);
  }, 3400);
}
// toastLast recalcule le texte au changement de langue (retoast) tant que la notification est visible.
const toastFn = fn => { toastLast = fn; showToast(fn()); };
const toast = (key, params) => toastFn(() => t(key, params));
const toastErr = err => toastFn(() => errText(err));
const retoast = () => { if (toastLast && $('#toast').classList.contains('show')) $('#toast').textContent = toastLast(); };

// ---------- Navigation ----------
const VIEWS = ['auth', 'join', 'onboarding', 'activities', 'calendar', 'bookings', 'admin'];
function show(view) {
  for (const v of VIEWS) $('#' + v).hidden = v !== view;
  $$('#nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  closeMenu();
  if (view === 'calendar') initCalendar();
  if (view === 'bookings') renderBookings();
  if (view === 'admin') renderAdmin();
  if (view === 'onboarding') drawOnboarding();
  if (view === 'activities') drawActivities();
  if (!['auth', 'join'].includes(view)) scrollTo(0, 0);
}
$$('#nav button[data-view]').forEach(b => b.onclick = () => show(b.dataset.view));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; };

// ---------- Auth ----------
let registering = false;
function setAuthMode(reg) {
  registering = reg;
  const m = reg ? 'register' : 'login';
  setI18n($('#authTitle'), `auth.${m}.title`);
  setI18n($('#authSubmit'), `auth.${m}.submit`);
  setI18n($('#authQuestion'), `auth.${m}.question`);
  setI18n($('#authToggle'), `auth.${m}.switch`);
  $('#authForm [name=password]').autocomplete = reg ? 'new-password' : 'current-password';
  clearError('#authError');
  $$('#authForm .reg').forEach(l => { l.hidden = !reg; l.querySelector('input').required = reg && l.querySelector('input').name === 'name'; });
}
$('#authToggle').onclick = () => setAuthMode(!registering);
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#authSubmit').disabled = true;
  try { await api(registering ? '/api/register' : '/api/login', { method: 'POST', body }); await boot(); }
  catch (err) { showError('#authError', err); }
  finally { $('#authSubmit').disabled = false; }
};

// Point d'entrée : /join/<code> → page d'invitation ; sinon l'application (connexion, premier écran, sélecteur ou calendrier).
// opts.aid : activité à ouvrir (après création / adhésion) ; opts.view : vue à afficher.
async function boot(opts = {}) {
  let r;
  try { r = await api('/api/me'); } catch (err) { return toastErr(err); }
  me = r.user; activities = r.activities || [];
  const join = location.pathname.match(/^\/join\/([A-Za-z0-9]+)\/?$/);
  if (join) return openJoin(join[1].toLowerCase());
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  if (!me) { $('#topbar').hidden = true; setAuthMode(false); return show('auth'); }
  $('#topbar').hidden = false;
  $('#who').textContent = firstName(me.name);
  $('#who').title = me.name;
  let a = actById(opts.aid ?? storedActivity());
  if (!a && activities.length === 1) a = activities[0];
  setActivity(a);
  if (!activities.length) return show('onboarding');
  if (!a) return show('activities'); // plusieurs activités, aucune préférence valable : sélecteur
  show(opts.view || 'calendar');
}
function storedActivity() { try { return localStorage.getItem(ACT_KEY); } catch { return null; } }
// Ouvre une activité (ou aucune) : rôle, libellés dépendant du rôle, onglets, sélecteur, caches.
function setActivity(a) {
  const changed = (act?.id ?? null) !== (a?.id ?? null);
  act = a;
  if (a) { try { localStorage.setItem(ACT_KEY, String(a.id)); } catch { /* stockage indisponible */ } }
  document.body.classList.toggle('is-owner', isOwner());
  $('#nav').hidden = !a;
  $('#nav [data-view=admin]').hidden = !isOwner();
  const rk = roleKey();
  setI18n($('#navBookings'), 'nav.bookings.' + rk);
  setI18n($('#bookingsTitle'), 'booking.list.title.' + rk);
  setI18n($('#bookingsHint'), 'booking.list.hint.' + rk);
  setI18n($('#calHint'), 'cal.hint.' + rk);
  setI18n($('#newBtn'), 'cal.new.' + rk);
  renderSwitcher();
  if (changed) { bookingsCache = null; membersCache = null; if (dlg.open) dlg.close(); } // le calendrier se recharge à l’affichage (initCalendar)
}
// Après une création ou une adhésion : recharge /api/me et ouvre l'activité.
const reloadTo = (aid, view = 'calendar') => boot({ aid, view });

// ---------- Sélecteur d'activité (barre supérieure) ----------
const CHEVRON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';
function renderSwitcher() {
  const el = $('#act');
  if (!me || !activities.length) { el.innerHTML = ''; return; }
  if (activities.length < 2 && act) { // une seule activité : son nom, en texte simple (ouvre « Mes activités »)
    el.innerHTML = `<button type="button" class="act-btn single" id="actBtn" title="${esc(t('nav.activities'))}"><span class="act-name">${esc(act.name)}</span></button>`;
    $('#actBtn').onclick = () => show('activities');
    return;
  }
  el.innerHTML = `<button type="button" class="act-btn" id="actBtn" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('nav.activity_switch'))}">
      <span class="act-name">${esc(act ? act.name : t('acts.title'))}</span>${CHEVRON}</button>
    <div class="menu" id="actMenu" role="menu" hidden>
      ${activities.map(a => `<button type="button" role="menuitemradio" aria-checked="${a.id === act?.id}" data-aid="${a.id}">
        <span class="menu-main"><span class="menu-name">${esc(a.name)}</span>${roleTag(a.role)}</span>${a.id === act?.id ? CHECK : ''}</button>`).join('')}
      <button type="button" role="menuitem" class="menu-all" data-all>${t('nav.activities')}</button>
    </div>`;
  $('#actBtn').onclick = () => toggleMenu();
  $$('#actMenu [data-aid]').forEach(b => b.onclick = () => { closeMenu(); const a = actById(b.dataset.aid); setActivity(a); show('calendar'); });
  $('#actMenu [data-all]').onclick = () => { closeMenu(); show('activities'); };
}
function toggleMenu(open = $('#actMenu')?.hidden) {
  const m = $('#actMenu'), b = $('#actBtn'); if (!m) return;
  m.hidden = !open; b.setAttribute('aria-expanded', String(open));
  if (open) $('#actMenu [aria-checked=true], #actMenu button')?.focus();
}
const closeMenu = () => toggleMenu(false);
addEventListener('pointerdown', e => { if (!e.target.closest?.('#act')) closeMenu(); });
addEventListener('keydown', e => {
  const m = $('#actMenu'); if (!m || m.hidden) return;
  if (e.key === 'Escape') { closeMenu(); $('#actBtn').focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = $$('button', m), i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); e.preventDefault();
  }
});

// ---------- Formulaires partagés : créer une activité / rejoindre avec un code ----------
// Utilisés par le premier écran (onboarding) et par « Mes activités » ; `id` distingue les deux instances.
const createFormHTML = id => `
  <form id="${id}" class="form-grid">
    <label class="field">${t('activity.name')}<input name="name" required minlength="2" maxlength="60" autocomplete="off" value="${esc(me?.name || '')}" placeholder="${esc(t('activity.name_placeholder'))}"></label>
    <label class="field">${t('activity.rate')}<span class="suffix-wrap"><input name="default_rate" type="number" step="0.01" min="0" inputmode="decimal" value="25" required><span class="suffix">${t('form.per_hour_suffix')}</span></span></label>
    <p class="error" role="alert"></p>
    <div class="actions"><button class="btn primary">${t('activity.create')}</button></div>
  </form>`;
const joinFormHTML = id => `
  <form id="${id}" class="form-grid">
    <label class="field">${t('activity.join.label')}<input name="code" required autocomplete="off" spellcheck="false" placeholder="${esc(t('activity.join.placeholder'))}"></label>
    <p class="error" role="alert"></p>
    <div class="actions"><button class="btn primary">${t('activity.join')}</button></div>
  </form>`;
// Soumission commune : désactive le bouton, affiche l'erreur dans le formulaire, sinon exécute `done`.
function bindForm(form, action, done) {
  if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('button.btn'), errEl = form.querySelector('.error');
    clearError(errEl); btn.disabled = true;
    try { done(await action(Object.fromEntries(new FormData(form)))); }
    catch (err) { showError(errEl, err); btn.disabled = false; }
  };
}
const bindCreateForm = form => bindForm(form, f => api('/api/activities', { method: 'POST', body: { name: f.name, default_rate: f.default_rate } }),
  a => { toast('toast.activity_created'); reloadTo(a.id); });
const bindJoinForm = form => bindForm(form, f => joinActivity(parseInviteCode(f.code)), () => {});
// Adhésion : idempotente côté serveur ; le prestataire qui suit son propre lien retrouve simplement son activité.
async function joinActivity(code) {
  const r = await api('/api/join/' + encodeURIComponent(code), { method: 'POST' });
  const a = r.activity;
  if (a.role === 'owner') toast('toast.own_activity', { name: a.name }); else toast('toast.joined', { name: a.name });
  await reloadTo(a.id);
  return r;
}

// ---------- Premier écran (aucune activité) ----------
let obOpen = null; // carte dépliée : 'create' | 'join' | null
function drawOnboarding() {
  $('#obTitle').textContent = t('onboarding.title', { name: firstName(me.name) });
  const card = (k, formHTML) => `<article class="card ${obOpen === k ? 'open' : ''}" data-card="${k}">
      <button type="button" class="card-btn" aria-expanded="${obOpen === k}" aria-controls="ob-${k}">
        <span class="card-title">${t(`onboarding.${k}.title`)}</span><span class="card-text">${t(`onboarding.${k}.text`)}</span>
      </button>
      <div class="card-form" id="ob-${k}" ${obOpen === k ? '' : 'hidden'}>${formHTML}</div>
    </article>`;
  $('#obCards').innerHTML = card('create', createFormHTML('obCreate')) + card('join', joinFormHTML('obJoin'));
  $$('#obCards .card-btn').forEach(b => b.onclick = () => {
    const k = b.closest('.card').dataset.card;
    obOpen = obOpen === k ? null : k; drawOnboarding();
    if (obOpen) $(`#ob-${k} input`)?.focus();
  });
  bindCreateForm($('#obCreate')); bindJoinForm($('#obJoin'));
}

// ---------- Mes activités ----------
let actsOpen = null; // formulaire déplié : 'create' | 'join' | null
function drawActivities() {
  $('#actsHint').textContent = t(act ? 'acts.hint' : 'acts.pick');
  $('#actList').innerHTML = activities.length ? `<div class="list alist">${activities.map(a => `
    <button type="button" class="item" data-aid="${a.id}" aria-current="${a.id === act?.id}">
      <div class="item-main">
        <div class="item-title">${esc(a.name)}</div>
        <div class="item-sub">${a.role === 'owner' ? t('acts.owner_sub', { count: Math.max(0, (a.members_count || 1) - 1) }) : t('acts.client_sub', { name: esc(a.owner_name) })}</div>
      </div>
      <div class="item-side">${roleTag(a.role)}</div>
    </button>`).join('')}</div>` : `<p class="empty">${t('acts.empty')}</p>`;
  $$('#actList [data-aid]').forEach(b => b.onclick = () => { setActivity(actById(b.dataset.aid)); show('calendar'); });
  const tab = (k, label) => `<button type="button" class="btn ${actsOpen === k ? 'active' : ''}" data-open="${k}" aria-expanded="${actsOpen === k}">${label}</button>`;
  $('#actsMore').innerHTML = `<div class="actions">${tab('create', t('activity.create.title'))}${tab('join', t('activity.join.title'))}</div>
    ${actsOpen ? `<div class="panel acts-form">${actsOpen === 'create' ? createFormHTML('actsCreate') : joinFormHTML('actsJoin')}</div>` : ''}`;
  $$('#actsMore [data-open]').forEach(b => b.onclick = () => {
    actsOpen = actsOpen === b.dataset.open ? null : b.dataset.open; drawActivities();
    if (actsOpen) $('#actsMore .acts-form input')?.focus();
  });
  bindCreateForm($('#actsCreate')); bindJoinForm($('#actsJoin'));
}

// ---------- Lien d'invitation (/join/<code>) ----------
let joinState = null; // { code, info: {activity, owner} | null, error, registering }
async function openJoin(code) {
  $('#topbar').hidden = true;
  joinState = { code, info: null, error: null, registering: !me };
  show('join'); drawJoin();
  try { joinState.info = await api('/api/join/' + encodeURIComponent(code)); }
  catch (err) { joinState.error = err; }
  drawJoin();
}
function drawJoin() {
  const s = joinState, card = $('#joinCard'); if (!s) return;
  if (s.error) {
    card.innerHTML = `<h1>${t('join.invalid.title')}</h1><p class="hint">${t('join.invalid.text')}</p>
      <p class="join-actions"><a class="btn" href="/">${t('join.home')}</a></p>`;
    return;
  }
  if (!s.info) { card.innerHTML = `<p class="hint">${t('join.loading')}</p>`; return; }
  const intro = `<p class="join-intro">${t('join.intro', { owner: `<strong>${esc(s.info.owner.name)}</strong>`, activity: `<strong>${esc(s.info.activity.name)}</strong>` })}</p>`;
  if (me) {
    card.innerHTML = `${intro}
      <p class="error" id="joinErr" role="alert"></p>
      <button type="button" class="btn primary" id="joinBtn">${t('join.button')}</button>
      <p class="auth-switch">${t('join.logged_as', { name: esc(me.name) })} <button type="button" id="joinSwitch">${t('join.switch_account')}</button></p>`;
    $('#joinBtn').onclick = async () => {
      $('#joinBtn').disabled = true;
      try { const r = await api('/api/join/' + encodeURIComponent(s.code), { method: 'POST' }); finishJoin(r.activity); }
      catch (err) { showError('#joinErr', err); $('#joinBtn').disabled = false; }
    };
    $('#joinSwitch').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; activities = []; s.registering = true; drawJoin(); };
    return;
  }
  const m = s.registering ? 'register' : 'login';
  card.innerHTML = `${intro}<p class="hint join-hint">${t('join.auth_hint')}</p>
    <h1 class="join-title">${t(`auth.${m}.title`)}</h1>
    <form id="joinForm">
      ${s.registering ? `<label class="field">${t('auth.name')}<input name="name" autocomplete="name" required></label>
      <label class="field">${t('auth.phone')}<input name="phone" type="tel" autocomplete="tel"></label>` : ''}
      <label class="field">${t('auth.email')}<input name="email" type="email" autocomplete="email" required></label>
      <label class="field">${t('auth.password')}<input name="password" type="password" autocomplete="${s.registering ? 'new' : 'current'}-password" required minlength="6"></label>
      <p class="error" id="joinErr" role="alert"></p>
      <button class="btn primary" id="joinSubmit">${t(`auth.${m}.submit`)}</button>
    </form>
    <p class="auth-switch"><span>${t(`auth.${m}.question`)}</span> <button type="button" id="joinToggle">${t(`auth.${m}.switch`)}</button></p>`;
  $('#joinToggle').onclick = () => { s.registering = !s.registering; drawJoin(); };
  $('#joinForm').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    $('#joinSubmit').disabled = true;
    try {
      await api(s.registering ? '/api/register' : '/api/login', { method: 'POST', body });
      const r = await api('/api/join/' + encodeURIComponent(s.code), { method: 'POST' }); // adhésion automatique
      finishJoin(r.activity);
    } catch (err) { showError('#joinErr', err); $('#joinSubmit').disabled = false; }
  };
}
// Adhésion réussie : l'URL redevient « / » et le calendrier de l'activité s'ouvre.
function finishJoin(a) {
  history.replaceState(null, '', '/');
  joinState = null;
  if (a.role === 'owner') toast('toast.own_activity', { name: a.name }); else toast('toast.joined', { name: a.name });
  return reloadTo(a.id);
}

// ---------- Calendrier ----------
const COLORS = { unavailable: '#9a9a94', busy: '#e3e3df', pending: '#c98a1a', confirmed: '#1f6f5f', done: '#4b5563' };
const TEXT = { unavailable: '#141414', busy: '#141414', pending: '#141414', confirmed: '#ffffff', done: '#ffffff' };
// Titre d'un événement, construit ici à partir des champs bruts (kind, status, note, description, client_name) ;
// repli sur le « title » du serveur quand ces champs manquent.
function eventTitle(e) {
  const owner = isOwner();
  if (e.kind === 'busy') return t('cal.ev.busy');
  if (e.kind === 'unavailable') {
    if (!owner) return t('cal.ev.unavailable');
    if (e.note === undefined) return e.title;
    return e.note ? t('cal.ev.unavailable_note', { note: e.note }) : t('cal.ev.unavailable');
  }
  if (e.kind === 'booking' && e.description !== undefined && (!owner || e.client_name !== undefined)) {
    const description = e.description || t('booking.default_title');
    return owner ? t('cal.ev.booking_admin', { client: e.client_name, description }) : description;
  }
  return e.title;
}
function initCalendar() {
  if (calendar) { calendar.updateSize(); return calendar.refetchEvents(); }
  calendar = new FullCalendar.Calendar($('#cal'), {
    locale: lang, firstDay: 1,
    initialView: isMobile() ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: false,
    slotMinTime: '07:00:00', slotMaxTime: '21:00:00', allDaySlot: false, nowIndicator: true,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    defaultRangeSeparator: ' – ', // même tiret demi-cadratin que dans les listes (« 14:00 – 16:00 »)
    views: {
      timeGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric' } },
      timeGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' } },
      dayGridMonth: { displayEventTime: false },
    },
    selectable: true, selectMirror: true, longPressDelay: 350, height: 'auto', eventDisplay: 'block',
    navLinks: true, navLinkDayClick: 'timeGridDay', dayMaxEvents: 3,
    selectAllow: info => isOwner() || info.start > new Date(),
    // Événements de l'activité ouverte ; sans activité (sélecteur affiché), rien.
    events: (_i, ok, ko) => (act ? api(apiAct('/calendar')) : Promise.resolve([])).then(evs => ok(evs.map(e => {
      const k = e.kind === 'booking' ? e.status : e.kind;
      // les champs bruts du serveur restent dans extendedProps pour retraduire le titre au changement de langue
      return { id: e.id, start: e.start, end: e.end, title: eventTitle(e), color: COLORS[k], textColor: TEXT[k], classNames: ['ev-' + k], extendedProps: e };
    })), ko),
    select: info => { calendar.unselect(); openNewDialog(info.start, info.end); },
    eventClick: info => {
      const e = info.event.extendedProps;
      if (e.kind === 'booking') openBooking(e.bookingId);
      else if (e.kind === 'unavailable' && isOwner()) openUnavailable(info.event);
      else if (e.kind === 'busy') toast('toast.busy');
    },
    datesSet: info => {
      $('#calTitle').textContent = info.view.title;
      $$('#calViews button').forEach(b => b.classList.toggle('active', b.dataset.calView === info.view.type));
    },
  });
  calendar.render();
  $('#calPrev').onclick = () => calendar.prev();
  $('#calNext').onclick = () => calendar.next();
  $('#calToday').onclick = () => calendar.today();
  $$('#calViews button').forEach(b => b.onclick = () => calendar.changeView(b.dataset.calView));
}
mobileMQ.addEventListener('change', e => { if (calendar && e.matches && calendar.view.type === 'timeGridWeek') calendar.changeView('timeGridDay'); });
const refresh = () => { calendar?.refetchEvents(); if (!$('#bookings').hidden) renderBookings(); };

$('#newBtn').onclick = () => {
  const now = new Date();
  let start = new Date(calendar ? calendar.getDate() : now);
  start.setHours(9, 0, 0, 0);
  if (start < now && !isOwner()) { start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1); }
  openNewDialog(start, new Date(start.getTime() + 2 * 3600e3));
};

// ---------- Dialogue ----------
const dlg = $('#dlg');
let dlgBooking = null, dlgRender = null;
function openDialog({ title, pill: p = '', body, bind, render }) {
  dlgBooking = null; dlgRender = render || null;
  $('#dlgTitle').innerHTML = title;
  $('#dlgPill').innerHTML = p;
  $('#dlgBody').innerHTML = body;
  bind?.();
  if (!dlg.open) dlg.showModal();
}
// Changement de langue pendant qu'un dialogue est ouvert : on le reconstruit en conservant la saisie,
// le message d'erreur affiché et le défilement.
async function rerenderDialog() {
  const snap = {}, key = (f, el) => f.id + '.' + el.name, errs = {};
  $$('#dlgBody form').forEach(f => { for (const el of f.elements) if (el.name) snap[key(f, el)] = el.value; });
  $$('#dlgBody .error[id]').forEach(el => { if (el.textContent) errs[el.id] = { key: el.dataset.i18n, text: el.textContent }; });
  const top = $('#dlgBody').scrollTop;
  await dlgRender();
  $$('#dlgBody form').forEach(f => { for (const el of f.elements) if (el.name && key(f, el) in snap) el.value = snap[key(f, el)]; });
  for (const [id, e] of Object.entries(errs)) { const el = document.getElementById(id); if (el) { if (e.key) setI18n(el, e.key); else el.textContent = e.text; } }
  $('#dlgBody').scrollTop = top;
}
$('#dlgClose').onclick = () => dlg.close();
let backdropDown = false;
dlg.addEventListener('pointerdown', e => { backdropDown = e.target === dlg; });
dlg.addEventListener('click', e => { if ((e.target === dlg && backdropDown) || e.target.closest('[data-close]')) dlg.close(); });

function openNewDialog(start, end) {
  const owner = isOwner();
  openDialog({
    title: t(owner ? 'form.new.title.admin' : 'form.new.title.client'),
    render: () => openNewDialog(start, end),
    body: `
    <form id="newForm" class="form-grid">
      ${owner ? `<label class="field">${t('form.type')}<select name="type">
        <option value="unav">${t('form.type.unavailable')}</option>
        <option value="booking">${t('form.type.booking')}</option></select></label>` : ''}
      <div class="form-row">
        <label class="field">${t('form.start')}<input type="datetime-local" name="start" value="${localInput(start)}" required></label>
        <label class="field">${t('form.end')}<input type="datetime-local" name="end" value="${localInput(end)}" required></label>
      </div>
      <label class="field">${t(owner ? 'form.note' : 'form.description')}
        <textarea name="description" rows="3" placeholder="${esc(t(owner ? 'form.note_placeholder' : 'form.description_placeholder'))}"></textarea></label>
      ${owner ? '' : `<label class="field">${t('form.address')}<input name="address" autocomplete="street-address" placeholder="${esc(t('form.address_placeholder'))}"></label>`}
      <p class="error" id="newErr"></p>
      <div class="actions">
        <button class="btn primary">${t(owner ? 'form.save' : 'form.send')}</button>
        <button type="button" class="btn ghost" data-close>${t('form.cancel')}</button>
      </div>
    </form>`,
    bind: () => {
      $('#newForm').onsubmit = async e => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const s = new Date(f.start).toISOString(), en = new Date(f.end).toISOString();
        try {
          if (f.type === 'unav') await api(apiAct('/unavailabilities'), { method: 'POST', body: { start: s, end: en, note: f.description } });
          else await api(apiAct('/bookings'), { method: 'POST', body: { start: s, end: en, description: f.description, address: f.address || '' } });
          dlg.close(); refresh();
          toast(owner ? 'toast.period_saved' : 'toast.request_sent');
        } catch (err) { showError('#newErr', err); }
      };
    },
  });
}

function openUnavailable(ev) {
  openDialog({
    // titre recalculé depuis les champs bruts : « ev.title » de l'objet FullCalendar reçu au clic n'est pas mis à jour
    // par le changement de langue (applyLang), le dialogue resterait dans l'ancienne langue.
    title: esc(eventTitle(ev.extendedProps)),
    render: () => openUnavailable(ev),
    body: `
      <dl class="meta"><dt>${t('booking.when')}</dt><dd>${fmtRange(ev.start, ev.end)}</dd></dl>
      <p class="error" id="unavErr"></p>
      <div class="actions footer">
        <button type="button" class="btn" id="delUnav">${t('form.delete_period')}</button>
        <button type="button" class="btn ghost" data-close>${t('form.close')}</button>
      </div>`,
    bind: () => {
      $('#delUnav').onclick = async () => {
        try { await api('/api/unavailabilities/' + ev.id.slice(1), { method: 'DELETE' }); dlg.close(); refresh(); toast('toast.period_deleted'); }
        catch (err) { showError('#unavErr', err); }
      };
    },
  });
}

async function openBooking(id) {
  let b;
  try { b = await api('/api/bookings/' + id); } catch (err) { return toastErr(err); }
  b.photos ||= [];
  const owner = ownerOf(b);
  const today = new Date().toISOString().slice(0, 10);
  const keepScroll = dlg.open && dlgBooking === String(id) ? $('#dlgBody').scrollTop : 0;
  const del = (type, rid) => `<button type="button" class="x" data-del="${type}" data-id="${rid}" aria-label="${esc(t('booking.delete_row'))}">×</button>`;
  const canCancel = owner ? !['cancelled', 'rejected'].includes(b.status) : ['pending', 'confirmed'].includes(b.status);
  const rate = b.hourly_rate || 0;
  openDialog({
    title: esc(b.description || t('booking.default_title')),
    pill: pill(b.status),
    render: () => openBooking(id),
    body: `
      <dl class="meta">
        <dt>${t('booking.when')}</dt><dd>${fmtRange(b.start, b.end)}</dd>
        ${b.address ? `<dt>${t('booking.address')}</dt><dd>${esc(b.address)}</dd>` : ''}
        ${owner ? `<dt>${t('booking.client')}</dt><dd>${esc(b.client_name)}<span class="muted"> · ${esc(b.client_email)}${b.client_phone ? ' · ' + esc(b.client_phone) : ''}</span></dd>` : ''}
        ${!owner && b.admin_note ? `<dt>${t('booking.message')}</dt><dd>${esc(b.admin_note)}</dd>` : ''}
      </dl>

      ${owner && ['pending', 'confirmed'].includes(b.status) ? `
      <section class="block"><h3>${t('booking.decision')}</h3>
        <div class="actions">${b.status === 'pending'
          ? `<button type="button" class="btn primary" data-status="confirmed">${t('booking.confirm')}</button><button type="button" class="btn" data-status="rejected">${t('booking.reject')}</button>`
          : `<button type="button" class="btn primary" data-status="done">${t('booking.done')}</button>`}
        </div>
      </section>` : ''}

      <section class="block" id="photosBlock"><h3>${t('photos.title')}${b.photos.length ? ` <span class="muted">· ${b.photos.length}</span>` : ''}</h3>
        ${b.photos.length ? `<div class="photos-grid">${b.photos.map((p, i) => {
          const x = p.expense_id ? b.expenses.find(e => e.id === p.expense_id) : null;
          return `<figure class="photo">
            <button type="button" class="photo-btn" data-photo="${p.id}"><img src="${esc(p.url)}" alt="${esc(p.caption || t('photos.alt', { n: i + 1 }))}" loading="lazy" decoding="async"></button>
            ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
            ${x ? `<span class="photo-tag">${t('photos.receipt_tag', { label: esc(x.label) })}</span>` : ''}
          </figure>`; }).join('')}</div>` : `<p class="hint">${t('photos.empty')}</p>`}
        <form id="photoForm" class="photos-add">
          <label class="field">${t('photos.caption')}<input name="caption" maxlength="200" autocomplete="off" placeholder="${esc(t('photos.caption_placeholder'))}"></label>
          <div class="actions">
            <button type="button" class="btn ghost" id="photoAdd" ${uploadState?.booking === String(id) ? 'disabled' : ''}>${PLUS_ICON}${t('photos.add')}</button>
            <span class="hint" id="photoProgress" aria-live="polite">${uploadState?.booking === String(id) ? t('photos.uploading', uploadState) : ''}</span>
          </div>
          <input type="file" id="photoFile" accept="image/*" multiple hidden>
        </form>
      </section>

      ${owner ? `
      <section class="block"><h3>${t('booking.rate_section')}</h3>
        <form id="metaForm" class="inline">
          <label class="field" style="flex:0 1 160px">${t('booking.hourly_rate')}
            <span class="suffix-wrap"><input name="hourly_rate" type="number" step="0.01" min="0" inputmode="decimal" value="${b.hourly_rate ?? ''}"><span class="suffix">${t('form.per_hour_suffix')}</span></span></label>
          <label class="field" style="flex:2 1 220px">${t('booking.admin_note')}<input name="admin_note" value="${esc(b.admin_note)}" placeholder="${esc(t('booking.admin_note_placeholder'))}"></label>
          <button class="btn">${t('booking.save')}</button>
        </form>
      </section>` : ''}

      <section class="block"><h3>${t('booking.labour')} <span class="muted">· ${t('booking.per_hour', { rate: eur(rate) })}</span></h3>
        ${b.work.length ? `<table><thead><tr><th>${t('booking.work.date')}</th><th>${t('booking.work.detail')}</th><th class="num">${t('booking.work.hours')}</th><th class="num">${t('booking.work.amount')}</th>${owner ? '<th></th>' : ''}</tr></thead><tbody>
          ${b.work.map(w => `<tr><td class="nowrap">${fmtDate(w.date)}</td><td>${esc(w.note)}</td><td class="num">${fmtH(w.hours)}</td>
            <td class="num">${eur(w.hours * rate)}</td>${owner ? `<td class="num">${del('work', w.id)}</td>` : ''}</tr>`).join('')}
        </tbody></table>` : `<p class="hint">${t('booking.work.empty')}</p>`}
        ${owner ? `
        <form id="workForm" class="inline add-form">
          <label class="field">${t('booking.work.date')}<input type="date" name="date" value="${today}" required></label>
          <label class="field">${t('booking.work.hours')}<input name="hours" type="number" step="0.25" min="0.25" inputmode="decimal" placeholder="${esc(t('booking.work.hours_placeholder'))}" required></label>
          <label class="field" style="flex:2 1 160px">${t('booking.work.detail')}<input name="note" placeholder="${esc(t('booking.work.detail_placeholder'))}"></label>
          <button class="btn">${t('booking.add')}</button>
        </form>` : ''}
      </section>

      <section class="block"><h3>${t('booking.expenses')}</h3>
        ${b.expenses.length ? `<table><thead><tr><th>${t('booking.expense.item')}</th><th class="num">${t('booking.expense.price')}</th>${owner ? '<th></th>' : ''}</tr></thead><tbody>
          ${b.expenses.map(x => {
            // justificatifs (photos liées à l'achat) : badge avec le nombre, qui ouvre la visionneuse filtrée sur cet achat
            const n = b.photos.filter(p => p.expense_id === x.id).length;
            const badge = n ? `<button type="button" class="rcount" data-receipts="${x.id}" aria-label="${esc(t('photos.receipt_count', { count: n }))}" title="${esc(t('photos.receipt_count', { count: n }))}">${CLIP_ICON}${n}</button>` : '';
            const clip = `<button type="button" class="x clip" data-receipt-add="${x.id}" aria-label="${esc(t('photos.receipt_add'))}" title="${esc(t('photos.receipt_add'))}">${CLIP_ICON}</button>`;
            return `<tr><td>${esc(x.label)}${badge}</td><td class="num">${eur(x.amount)}</td>${owner ? `<td class="num"><span class="row-actions">${clip}${del('expenses', x.id)}</span></td>` : ''}</tr>`;
          }).join('')}
        </tbody></table>` : `<p class="hint">${t('booking.expense.empty')}</p>`}
        ${owner ? `
        <form id="expForm" class="inline add-form">
          <label class="field" style="flex:2 1 160px">${t('booking.expense.item')}<input name="label" placeholder="${esc(t('booking.expense.item_placeholder'))}" required></label>
          <label class="field">${t('booking.expense.price')}<span class="suffix-wrap"><input name="amount" type="number" step="0.01" min="0" inputmode="decimal" required><span class="suffix">€</span></span></label>
          <button class="btn">${t('booking.add')}</button>
        </form>` : ''}
      </section>

      <section class="block totals">
        <div><span>${t('booking.totals.labour', { hours: t('booking.hours', { hours: fmtH(b.totals.hours) }) })}</span><span>${eur(b.totals.labour)}</span></div>
        <div><span>${t('booking.totals.expenses')}</span><span>${eur(b.totals.expenses)}</span></div>
        <div class="grand"><span>${t('booking.totals.total')}</span><span id="bTotal">${eur(b.totals.total)}</span></div>
      </section>

      <p class="error" id="bErr"></p>
      ${canCancel ? `<div class="actions footer" id="cancelZone">
        <button type="button" class="btn ghost" id="cancelBtn">${t(owner ? 'booking.cancel.admin' : 'booking.cancel.client')}</button></div>` : ''}`,
    bind: () => {
      const run = async (fn, msgKey) => {
        try { await fn(); refresh(); await openBooking(id); if (msgKey) toast(msgKey); }
        catch (err) { showError('#bErr', err); }
      };
      const MSG = { confirmed: 'toast.confirmed', rejected: 'toast.rejected', done: 'toast.done', cancelled: 'toast.cancelled' };
      $$('#dlg [data-status]').forEach(btn => btn.onclick = () =>
        run(() => api('/api/bookings/' + id, { method: 'PATCH', body: { status: btn.dataset.status } }), MSG[btn.dataset.status]));
      $$('#dlg [data-del]').forEach(btn => btn.onclick = () =>
        run(() => api(`/api/${btn.dataset.del}/${btn.dataset.id}`, { method: 'DELETE' }), 'toast.deleted'));
      const bindForm = (sel, fn, msgKey) => { const f = $(sel); if (f) f.onsubmit = e => { e.preventDefault(); run(() => fn(Object.fromEntries(new FormData(f))), msgKey); }; };
      bindForm('#metaForm', body => { if (body.hourly_rate === '') delete body.hourly_rate; return api('/api/bookings/' + id, { method: 'PATCH', body }); }, 'toast.saved');
      bindForm('#workForm', body => api(`/api/bookings/${id}/work`, { method: 'POST', body }), 'toast.work_added');
      bindForm('#expForm', body => api(`/api/bookings/${id}/expenses`, { method: 'POST', body }), 'toast.expense_added');
      const cancelBtn = $('#cancelBtn');
      if (cancelBtn) cancelBtn.onclick = () => {
        $('#cancelZone').innerHTML = `<span class="hint">${t('confirm.cancel')}</span>
          <button type="button" class="btn" id="cancelYes">${t('confirm.yes')}</button>
          <button type="button" class="btn ghost" id="cancelNo">${t('confirm.no')}</button>`;
        $('#cancelYes').onclick = () => run(() => api('/api/bookings/' + id, { method: 'PATCH', body: { status: 'cancelled' } }), MSG.cancelled);
        $('#cancelNo').onclick = () => openBooking(id);
      };
      // Photos : vignettes → visionneuse ; sélecteur de fichiers partagé entre « Ajouter des photos » et les justificatifs.
      $$('#dlg [data-photo]').forEach(btn => btn.onclick = () => openLightbox(b, b.photos, b.photos.findIndex(p => String(p.id) === btn.dataset.photo)));
      $$('#dlg [data-receipts]').forEach(btn => btn.onclick = () => openLightbox(b, b.photos.filter(p => String(p.expense_id) === btn.dataset.receipts), 0));
      const fileInput = $('#photoFile'), photoForm = $('#photoForm');
      let pendingExpense = null; // achat visé par le prochain choix de fichiers (justificatif), sinon null
      const pick = expenseId => { pendingExpense = expenseId; fileInput.value = ''; fileInput.click(); };
      $('#photoAdd').onclick = () => pick(null);
      photoForm.onsubmit = e => { e.preventDefault(); pick(null); }; // Entrée dans la légende = choisir des fichiers
      $$('#dlg [data-receipt-add]').forEach(btn => btn.onclick = () => pick(btn.dataset.receiptAdd));
      fileInput.onchange = () => {
        const files = [...fileInput.files], expenseId = pendingExpense;
        pendingExpense = null;
        if (files.length) uploadPhotos(id, files, { caption: expenseId ? '' : photoForm.elements.caption.value, expenseId });
      };
    },
  });
  dlgBooking = String(id);
  $('#dlgBody').scrollTop = keepScroll;
}

// ---------- Photos : envoi ----------
const MAX_PHOTO = 10 * 1024 * 1024, MAX_SIDE = 1600;
const PLUS_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
const CLIP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.5l-8 8a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.6 1.6 0 0 1-2.3-2.3l8-8"/></svg>';
let uploadState = null; // { booking, n, total } pendant un envoi (affiché « Envoi 2 / 5… », bouton désactivé)
const toBlob = (canvas, type, q) => new Promise(ok => canvas.toBlob(ok, type, q));
// Réduction côté client : côté le plus long ≤ 1600 px, JPEG à 85 % (orientation EXIF appliquée, métadonnées retirées).
// Si le navigateur ne sait pas décoder le fichier (HEIC sous Chrome, par exemple), l'original part tel quel.
async function prepareUpload(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // fond des PNG transparents
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, 'image/jpeg', 0.85);
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch { return file; } finally { bmp.close(); }
}
// Indicateur « Envoi 2 / 5… » et bouton désactivé, uniquement dans la fiche de l'intervention concernée.
function showProgress() {
  const on = !!uploadState && dlg.open && dlgBooking === uploadState.booking;
  const p = $('#photoProgress'), btn = $('#photoAdd');
  if (p) p.textContent = on ? t('photos.uploading', uploadState) : '';
  if (btn) btn.disabled = on;
}
// Envois séquentiels (un POST multipart par fichier) ; un fichier refusé n'arrête pas les suivants.
async function uploadPhotos(bookingId, files, { caption = '', expenseId = null } = {}) {
  if (uploadState) return;
  let added = 0;
  uploadState = { booking: String(bookingId), n: 0, total: files.length };
  try {
    for (const f of files) {
      uploadState.n++; showProgress();
      if (f.size > MAX_PHOTO) { toastFn(() => t('photos.file_error', { name: f.name, error: t('err.FILE_TOO_LARGE') })); continue; }
      const up = await prepareUpload(f);
      const fd = new FormData();
      fd.append('file', up, up.name);
      if (caption.trim()) fd.append('caption', caption.trim());
      if (expenseId) fd.append('expense_id', expenseId);
      try { await api(`/api/bookings/${bookingId}/photos`, { method: 'POST', body: fd }); added++; }
      catch (err) { toastFn(() => t('photos.file_error', { name: f.name, error: errText(err) })); }
    }
  } finally { uploadState = null; }
  if (dlg.open && dlgBooking === String(bookingId)) await openBooking(bookingId); else showProgress();
  if (added) toast('toast.photos_added', { count: added });
}

// ---------- Photos : visionneuse ----------
const lb = $('#lb');
let lbState = null; // { b: intervention, photos: liste parcourue (toutes, ou celles d'un achat), i: index courant }
function openLightbox(b, photos, i) {
  if (!photos.length || i < 0) return;
  lbState = { b, photos, i };
  renderLightbox();
  if (!lb.open) lb.showModal();
}
// Auteur d'une photo : vous, le client de l'intervention, sinon le prestataire de l'activité.
function uploaderLabel(p, b) {
  if (p.uploaded_by == null) return '';
  if (p.uploaded_by === me.id) return t('photos.by_you');
  if (p.uploaded_by === b.client_id) return t('photos.by', { name: b.client_name });
  return t('photos.by', { name: ownerName(b) });
}
function renderLightbox() {
  const { b, photos, i } = lbState, p = photos[i], many = photos.length > 1;
  const x = p.expense_id ? b.expenses.find(e => e.id === p.expense_id) : null;
  const img = $('#lbImg');
  if (img.getAttribute('src') !== p.url) img.src = p.url;
  img.alt = p.caption || t('photos.alt', { n: i + 1 });
  $('#lbCount').textContent = t('photos.counter', { n: i + 1, total: photos.length });
  $('#lbCaption').textContent = p.caption;
  $('#lbMeta').textContent = [fmt(sqlDate(p.created_at)), uploaderLabel(p, b), x ? t('photos.receipt_tag', { label: x.label }) : ''].filter(Boolean).join(' · ');
  $('#lbPrev').hidden = $('#lbNext').hidden = !many;
  const canDelete = ownerOf(b) || p.uploaded_by === me.id;
  $('#lbActions').innerHTML = `<a class="btn" href="${esc(p.url)}?download=1" download="${esc(p.filename)}">${t('photos.download')}</a>
    ${canDelete ? `<button type="button" class="btn ghost" id="lbDelete">${t('photos.delete')}</button>` : ''}`;
  if (canDelete) $('#lbDelete').onclick = () => {
    $('#lbActions').innerHTML = `<span class="hint">${t('confirm.delete_photo')}</span>
      <button type="button" class="btn" id="lbYes">${t('confirm.delete_yes')}</button>
      <button type="button" class="btn ghost" id="lbNo">${t('confirm.no')}</button>`;
    $('#lbNo').onclick = renderLightbox;
    $('#lbYes').onclick = async () => {
      $('#lbYes').disabled = true;
      try { await api('/api/photos/' + p.id, { method: 'DELETE' }); } catch (err) { toastErr(err); return renderLightbox(); }
      photos.splice(i, 1);
      b.photos = b.photos.filter(q => q.id !== p.id);
      toast('toast.photo_deleted');
      if (!photos.length) lb.close(); else { lbState.i = Math.min(i, photos.length - 1); renderLightbox(); }
      if (dlg.open && dlgBooking === String(b.id)) openBooking(b.id); // la grille derrière se met à jour
    };
  };
  // préchargement des voisines pour une navigation sans attente
  if (many) [photos[(i + 1) % photos.length], photos[(i - 1 + photos.length) % photos.length]].forEach(q => { new Image().src = q.url; });
}
const lbStep = d => { if (lbState && lbState.photos.length > 1) { lbState.i = (lbState.i + d + lbState.photos.length) % lbState.photos.length; renderLightbox(); } };
$('#lbPrev').onclick = () => lbStep(-1);
$('#lbNext').onclick = () => lbStep(1);
$('#lbClose').onclick = () => lb.close();
lb.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') lbStep(-1); else if (e.key === 'ArrowRight') lbStep(1); });
lb.addEventListener('close', () => { lbState = null; $('#lbImg').removeAttribute('src'); if (dlg.open && !dlg.contains(document.activeElement)) $('#dlgClose').focus(); });
// Tactile : balayage horizontal = photo suivante / précédente ; toucher à côté de l'image = fermer.
let swipeX = null;
$('#lbStage').addEventListener('pointerdown', e => { swipeX = e.clientX; });
$('#lbStage').addEventListener('pointerup', e => {
  const dx = swipeX == null ? 0 : e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 40) lbStep(dx < 0 ? 1 : -1);
  else if (e.target === e.currentTarget) lb.close();
});

// ---------- Listes ----------
// Les données sont gardées en mémoire pour redessiner la liste dans l'autre langue sans nouvel appel.
let bookingsCache = null, membersCache = null;
async function renderBookings() {
  if (!act) return;
  try { bookingsCache = await api(apiAct('/bookings')); } catch (err) { return toastErr(err); }
  drawBookings();
}
function drawBookings() {
  const list = bookingsCache; if (!list) return;
  const owner = isOwner();
  $('#bookingList').innerHTML = list.length ? `<div class="list">${list.map(b => `
    <button type="button" class="item" data-id="${b.id}">
      <div class="item-main">
        <div class="item-title">${esc(b.description || t('booking.default_title'))}</div>
        <div class="item-sub">${fmtRange(b.start, b.end)}${owner ? ' · ' + esc(b.client_name) : ''}</div>
      </div>
      <div class="item-side">${pill(b.status)}<span class="item-total">${eur(b.totals.total)}</span></div>
    </button>`).join('')}</div>`
    : `<p class="empty">${t(owner ? 'booking.list.empty.admin' : 'booking.list.empty.client')}</p>`;
  $$('#bookingList [data-id]').forEach(el => el.onclick = () => openBooking(el.dataset.id));
}

// ---------- Gestion (prestataire) : activité, lien d'invitation, clients ----------
async function renderAdmin() {
  if (!isOwner()) return show('calendar');
  drawAdmin();
  try { membersCache = await api(apiAct('/members')); } catch (err) { return toastErr(err); }
  drawMembers();
}
// Formulaire de l'activité et bloc d'invitation, d'après l'activité ouverte (sans appel réseau).
function drawAdmin() {
  if (!act) return;
  const f = $('#actForm');
  if (document.activeElement?.form !== f) { f.elements.name.value = act.name; f.elements.default_rate.value = act.default_rate; }
  $('#inviteLink').value = inviteURL(act.invite_code);
  $('#shareBtn').hidden = !navigator.share;
  drawRegen();
}
// Confirmation en ligne de « Régénérer le lien » (conservée au changement de langue, retraduite).
let regenOpen = false;
function drawRegen() {
  const zone = $('#regenZone');
  if (!regenOpen) { zone.innerHTML = ''; return; }
  zone.innerHTML = `<span class="hint">${t('admin.invite.regenerate_confirm')}</span>
    <button type="button" class="btn sm" id="regenYes">${t('admin.invite.regenerate_yes')}</button>
    <button type="button" class="btn ghost sm" id="regenNo">${t('confirm.no')}</button>`;
  $('#regenNo').onclick = () => { regenOpen = false; drawRegen(); };
  $('#regenYes').onclick = async () => {
    $('#regenYes').disabled = true;
    try { const r = await api(apiAct('/invite/regenerate'), { method: 'POST' }); act.invite_code = r.invite_code; regenOpen = false; drawAdmin(); toast('toast.link_regenerated'); }
    catch (err) { toastErr(err); regenOpen = false; drawRegen(); }
  };
}
function drawMembers() {
  const clients = membersCache?.filter(m => m.role === 'client'); if (!clients) return;
  $('#clientsTitle').textContent = `${t('admin.clients.title')}${clients.length ? ' · ' + clients.length : ''}`;
  $('#clientList').innerHTML = clients.length ? `<table class="clients"><thead><tr><th>${t('admin.clients.name')}</th><th>${t('admin.clients.email')}</th><th>${t('admin.clients.phone')}</th><th>${t('admin.clients.joined')}</th><th></th></tr></thead><tbody>
    ${clients.map(c => `<tr data-uid="${c.id}"><td>${esc(c.name)}</td><td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td>
      <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '<span class="muted">—</span>'}</td>
      <td class="nowrap joined">${fmtSqlDay(c.joined_at)}</td>
      <td class="num"><button type="button" class="link remove" data-remove="${c.id}">${t('admin.clients.remove')}</button></td></tr>`).join('')}
  </tbody></table><div class="confirm-row" id="rmZone"></div>` : `<p class="hint">${t('admin.clients.empty')}</p>`;
  // « Retirer » : confirmation en ligne sous le tableau (la rangée visée est atténuée), puis DELETE ;
  // le client perd l'accès, ses demandes restent visibles du prestataire.
  $$('#clientList [data-remove]').forEach(btn => btn.onclick = () => {
    const c = clients.find(x => String(x.id) === btn.dataset.remove);
    $$('#clientList tr.removing').forEach(tr => tr.classList.remove('removing'));
    btn.closest('tr').classList.add('removing');
    $('#rmZone').innerHTML = `<span class="hint">${t('admin.clients.remove_confirm', { name: esc(c.name) })}</span>
      <button type="button" class="btn sm" id="rmYes">${t('admin.clients.remove_yes')}</button>
      <button type="button" class="btn ghost sm" id="rmNo">${t('confirm.no')}</button>`;
    $('#rmNo').onclick = drawMembers;
    $('#rmYes').onclick = async () => {
      $('#rmYes').disabled = true;
      try { await api(apiAct('/members/' + c.id), { method: 'DELETE' }); }
      catch (err) { toastErr(err); return drawMembers(); }
      membersCache = membersCache.filter(m => m.id !== c.id);
      act.members_count = Math.max(1, (act.members_count || 1) - 1);
      toast('toast.member_removed'); drawMembers();
    };
  });
}
$('#actForm').onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const a = await api(apiAct(), { method: 'PATCH', body: { name: f.name, default_rate: f.default_rate } });
    Object.assign(act, a);
    renderSwitcher(); toast('toast.activity_saved');
  } catch (err) { toastErr(err); }
};
$('#copyBtn').onclick = async () => {
  const input = $('#inviteLink');
  try { await navigator.clipboard.writeText(input.value); toast('toast.link_copied'); }
  catch {
    input.focus(); input.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* non pris en charge */ }
    toast(ok ? 'toast.link_copied' : 'toast.copy_failed');
  }
};
$('#inviteLink').onclick = e => e.target.select();
$('#shareBtn').onclick = async () => {
  try { await navigator.share({ title: t('app.title'), text: t('admin.invite.share_text', { owner: me.name, activity: act.name }), url: inviteURL(act.invite_code) }); }
  catch { /* partage annulé */ }
};
$('#regenBtn').onclick = () => { regenOpen = true; drawRegen(); $('#regenYes').focus(); };

applyLang();
boot();
