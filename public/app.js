// Piotr — interface (vanilla JS). Toute la logique métier passe par /api/*.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (n || 0).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
const fmtH = h => Number(h || 0).toLocaleString('fr-BE', { maximumFractionDigits: 2 });
const fmt = d => new Date(d).toLocaleString('fr-BE', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = d => new Date(d).toLocaleDateString('fr-BE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = d => new Date(d).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtRange = (s, e) => sameDay(s, e) ? `${fmtDay(s)} · ${fmtTime(s)} – ${fmtTime(e)}` : `${fmt(s)} → ${fmt(e)}`;
// date d'une prestation (YYYY-MM-DD) → « 10 nov. 2026 »
const fmtDate = d => { const x = new Date(d + 'T00:00'); return isNaN(x) ? esc(d) : x.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' }); };
const STATUS = { pending: 'En attente', confirmed: 'Confirmé', rejected: 'Refusé', cancelled: 'Annulé', done: 'Terminé' };
const pill = s => `<span class="pill ${esc(s)}">${STATUS[s] || esc(s)}</span>`;
// valeur pour <input type="datetime-local"> en heure locale
const localInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const mobileMQ = matchMedia('(max-width: 699px)');
const isMobile = () => mobileMQ.matches;
const firstName = n => String(n || '').trim().split(/\s+/)[0];

let me = null, defaultRate = 25, calendar = null;

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
}

// ---------- Navigation ----------
const VIEWS = ['auth', 'calendar', 'bookings', 'admin'];
function show(view) {
  for (const v of VIEWS) $('#' + v).hidden = v !== view;
  $$('#nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'calendar') initCalendar();
  if (view === 'bookings') renderBookings();
  if (view === 'admin') renderAdmin();
}
$$('#nav button[data-view]').forEach(b => b.onclick = () => show(b.dataset.view));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

// ---------- Auth ----------
let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $('#authTitle').textContent = reg ? 'Créer un compte' : 'Connexion';
  $('#authSubmit').textContent = reg ? 'Créer mon compte' : 'Se connecter';
  $('#authQuestion').textContent = reg ? 'Déjà un compte ?' : 'Pas encore de compte ?';
  $('#authToggle').textContent = reg ? 'Se connecter' : 'Créer un compte';
  $('#authForm [name=password]').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
  $$('.reg').forEach(l => { l.hidden = !reg; l.querySelector('input').required = reg && l.querySelector('input').name === 'name'; });
}
$('#authToggle').onclick = () => setAuthMode(!registering);
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#authSubmit').disabled = true;
  try { await api(registering ? '/api/register' : '/api/login', { method: 'POST', body }); await boot(); }
  catch (err) { $('#authError').textContent = err.message; }
  finally { $('#authSubmit').disabled = false; }
};

async function boot() {
  let r;
  try { r = await api('/api/me'); } catch { return toast('Serveur injoignable. Réessayez dans un instant.'); }
  me = r.user; defaultRate = r.defaultRate;
  if (!me) { $('#topbar').hidden = true; setAuthMode(false); return show('auth'); }
  const admin = me.role === 'admin';
  document.body.classList.toggle('is-admin', admin);
  $('#topbar').hidden = false;
  $('#who').textContent = firstName(me.name);
  $('#who').title = me.name + (admin ? ' (administrateur)' : '');
  $('#nav [data-view=admin]').hidden = !admin;
  $('#nav [data-view=bookings] span').textContent = admin ? 'Interventions' : 'Demandes';
  $('#bookingsTitle').textContent = admin ? 'Interventions' : 'Mes demandes';
  $('#bookingsHint').textContent = admin
    ? 'Toutes les demandes reçues, de la plus récente à la plus ancienne. Cliquez sur une ligne pour la gérer.'
    : 'Vos demandes et le décompte de chaque intervention.';
  $('#calHint').textContent = admin
    ? 'Sélectionnez une plage pour la bloquer (indisponible) ou réserver pour un client. Cliquez sur un événement pour le gérer.'
    : 'Sélectionnez un créneau libre dans le calendrier pour faire une demande. Les zones grises sont déjà prises.';
  $('#newBtn').textContent = admin ? 'Nouvelle plage' : 'Demander un créneau';
  show('calendar');
}

// ---------- Calendrier ----------
const COLORS = { unavailable: '#9a9a94', busy: '#e3e3df', pending: '#c98a1a', confirmed: '#1f6f5f', done: '#4b5563' };
const TEXT = { unavailable: '#141414', busy: '#141414', pending: '#141414', confirmed: '#ffffff', done: '#ffffff' };
function initCalendar() {
  if (calendar) { calendar.updateSize(); return calendar.refetchEvents(); }
  calendar = new FullCalendar.Calendar($('#cal'), {
    locale: 'fr', firstDay: 1,
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
    selectAllow: info => me.role === 'admin' || info.start > new Date(),
    events: (_i, ok, ko) => api('/api/calendar').then(evs => ok(evs.map(e => {
      const k = e.kind === 'booking' ? e.status : e.kind;
      return { ...e, color: COLORS[k], textColor: TEXT[k], classNames: ['ev-' + k] };
    })), ko),
    select: info => { calendar.unselect(); openNewDialog(info.start, info.end); },
    eventClick: info => {
      const e = info.event.extendedProps;
      if (e.kind === 'booking') openBooking(e.bookingId);
      else if (e.kind === 'unavailable' && me.role === 'admin') openUnavailable(info.event);
      else if (e.kind === 'busy') toast('Ce créneau est déjà pris.');
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
  if (start < now && me.role !== 'admin') { start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1); }
  openNewDialog(start, new Date(start.getTime() + 2 * 3600e3));
};

// ---------- Dialogue ----------
const dlg = $('#dlg');
let dlgBooking = null;
function openDialog({ title, pill: p = '', body, bind }) {
  dlgBooking = null;
  $('#dlgTitle').innerHTML = title;
  $('#dlgPill').innerHTML = p;
  $('#dlgBody').innerHTML = body;
  bind?.();
  if (!dlg.open) dlg.showModal();
}
$('#dlgClose').onclick = () => dlg.close();
let backdropDown = false;
dlg.addEventListener('pointerdown', e => { backdropDown = e.target === dlg; });
dlg.addEventListener('click', e => { if ((e.target === dlg && backdropDown) || e.target.closest('[data-close]')) dlg.close(); });

function openNewDialog(start, end) {
  const isAdmin = me.role === 'admin';
  openDialog({
    title: isAdmin ? 'Nouvelle plage' : 'Demander ce créneau',
    body: `
    <form id="newForm" class="form-grid">
      ${isAdmin ? `<label class="field">Type<select name="type">
        <option value="unav">Je suis indisponible</option>
        <option value="booking">Réserver (pour moi ou un client sans compte)</option></select></label>` : ''}
      <div class="form-row">
        <label class="field">Début<input type="datetime-local" name="start" value="${localInput(start)}" required></label>
        <label class="field">Fin<input type="datetime-local" name="end" value="${localInput(end)}" required></label>
      </div>
      <label class="field">${isAdmin ? 'Note' : 'Description des travaux'}
        <textarea name="description" rows="3" placeholder="${isAdmin ? 'Facultatif' : 'ex. Tonte de la pelouse et taille de la haie'}"></textarea></label>
      ${isAdmin ? '' : '<label class="field">Adresse<input name="address" autocomplete="street-address" placeholder="Rue, numéro, commune"></label>'}
      <p class="error" id="newErr"></p>
      <div class="actions">
        <button class="btn primary">${isAdmin ? 'Enregistrer' : 'Envoyer la demande'}</button>
        <button type="button" class="btn ghost" data-close>Annuler</button>
      </div>
    </form>`,
    bind: () => {
      $('#newForm').onsubmit = async e => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const s = new Date(f.start).toISOString(), en = new Date(f.end).toISOString();
        try {
          if (f.type === 'unav') await api('/api/unavailabilities', { method: 'POST', body: { start: s, end: en, note: f.description } });
          else await api('/api/bookings', { method: 'POST', body: { start: s, end: en, description: f.description, address: f.address || '' } });
          dlg.close(); refresh();
          toast(isAdmin ? 'Plage enregistrée.' : 'Demande envoyée. Elle apparaît « En attente » jusqu’à validation.');
        } catch (err) { $('#newErr').textContent = err.message; }
      };
    },
  });
}

function openUnavailable(ev) {
  openDialog({
    title: esc(ev.title),
    body: `
      <dl class="meta"><dt>Quand</dt><dd>${fmtRange(ev.start, ev.end)}</dd></dl>
      <p class="error" id="unavErr"></p>
      <div class="actions footer">
        <button type="button" class="btn" id="delUnav">Supprimer cette période</button>
        <button type="button" class="btn ghost" data-close>Fermer</button>
      </div>`,
    bind: () => {
      $('#delUnav').onclick = async () => {
        try { await api('/api/unavailabilities/' + ev.id.slice(1), { method: 'DELETE' }); dlg.close(); refresh(); toast('Période supprimée.'); }
        catch (err) { $('#unavErr').textContent = err.message; }
      };
    },
  });
}

async function openBooking(id) {
  let b;
  try { b = await api('/api/bookings/' + id); } catch (err) { return toast(err.message); }
  const isAdmin = me.role === 'admin';
  const today = new Date().toISOString().slice(0, 10);
  const keepScroll = dlg.open && dlgBooking === String(id) ? $('#dlgBody').scrollTop : 0;
  const del = (type, rid) => `<button type="button" class="x" data-del="${type}" data-id="${rid}" aria-label="Supprimer">×</button>`;
  const canCancel = isAdmin ? !['cancelled', 'rejected'].includes(b.status) : ['pending', 'confirmed'].includes(b.status);
  const rate = b.hourly_rate || 0;
  openDialog({
    title: esc(b.description || 'Travaux'),
    pill: pill(b.status),
    body: `
      <dl class="meta">
        <dt>Quand</dt><dd>${fmtRange(b.start, b.end)}</dd>
        ${b.address ? `<dt>Adresse</dt><dd>${esc(b.address)}</dd>` : ''}
        ${isAdmin ? `<dt>Client</dt><dd>${esc(b.client_name)}<span class="muted"> · ${esc(b.client_email)}${b.client_phone ? ' · ' + esc(b.client_phone) : ''}</span></dd>` : ''}
        ${!isAdmin && b.admin_note ? `<dt>Message</dt><dd>${esc(b.admin_note)}</dd>` : ''}
      </dl>

      ${isAdmin && ['pending', 'confirmed'].includes(b.status) ? `
      <section class="block"><h3>Décision</h3>
        <div class="actions">${b.status === 'pending'
          ? '<button type="button" class="btn primary" data-status="confirmed">Valider la demande</button><button type="button" class="btn" data-status="rejected">Refuser</button>'
          : '<button type="button" class="btn primary" data-status="done">Marquer comme terminé</button>'}
        </div>
      </section>` : ''}

      ${isAdmin ? `
      <section class="block"><h3>Tarif et message au client</h3>
        <form id="metaForm" class="inline">
          <label class="field" style="flex:0 1 160px">Tarif horaire
            <span class="suffix-wrap"><input name="hourly_rate" type="number" step="0.01" min="0" inputmode="decimal" value="${b.hourly_rate ?? ''}"><span class="suffix">€ / h</span></span></label>
          <label class="field" style="flex:2 1 220px">Message<input name="admin_note" value="${esc(b.admin_note)}" placeholder="Visible par le client"></label>
          <button class="btn">Enregistrer</button>
        </form>
      </section>` : ''}

      <section class="block"><h3>Main-d’œuvre <span class="muted">· ${eur(rate)} / h</span></h3>
        ${b.work.length ? `<table><thead><tr><th>Date</th><th>Détail</th><th class="num">Heures</th><th class="num">Montant</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
          ${b.work.map(w => `<tr><td class="nowrap">${fmtDate(w.date)}</td><td>${esc(w.note)}</td><td class="num">${fmtH(w.hours)}</td>
            <td class="num">${eur(w.hours * rate)}</td>${isAdmin ? `<td class="num">${del('work', w.id)}</td>` : ''}</tr>`).join('')}
        </tbody></table>` : '<p class="hint">Aucune heure encodée.</p>'}
        ${isAdmin ? `
        <form id="workForm" class="inline add-form">
          <label class="field">Date<input type="date" name="date" value="${today}" required></label>
          <label class="field">Heures<input name="hours" type="number" step="0.25" min="0.25" inputmode="decimal" placeholder="2,5" required></label>
          <label class="field" style="flex:2 1 160px">Détail<input name="note" placeholder="Facultatif"></label>
          <button class="btn">Ajouter</button>
        </form>` : ''}
      </section>

      <section class="block"><h3>Achats et fournitures</h3>
        ${b.expenses.length ? `<table><thead><tr><th>Article</th><th class="num">Prix</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
          ${b.expenses.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${eur(x.amount)}</td>${isAdmin ? `<td class="num">${del('expenses', x.id)}</td>` : ''}</tr>`).join('')}
        </tbody></table>` : '<p class="hint">Aucun achat.</p>'}
        ${isAdmin ? `
        <form id="expForm" class="inline add-form">
          <label class="field" style="flex:2 1 160px">Article<input name="label" placeholder="ex. Râteau" required></label>
          <label class="field">Prix<span class="suffix-wrap"><input name="amount" type="number" step="0.01" min="0" inputmode="decimal" required><span class="suffix">€</span></span></label>
          <button class="btn">Ajouter</button>
        </form>` : ''}
      </section>

      <section class="block totals">
        <div><span>Main-d’œuvre (${fmtH(b.totals.hours)} h)</span><span>${eur(b.totals.labour)}</span></div>
        <div><span>Achats</span><span>${eur(b.totals.expenses)}</span></div>
        <div class="grand"><span>Total</span><span id="bTotal">${eur(b.totals.total)}</span></div>
      </section>

      <p class="error" id="bErr"></p>
      ${canCancel ? `<div class="actions footer" id="cancelZone">
        <button type="button" class="btn ghost" id="cancelBtn">${isAdmin ? 'Annuler l’intervention' : 'Annuler ma demande'}</button></div>` : ''}`,
    bind: () => {
      const run = async (fn, msg) => {
        try { await fn(); refresh(); await openBooking(id); if (msg) toast(msg); }
        catch (err) { $('#bErr').textContent = err.message; }
      };
      const MSG = { confirmed: 'Demande validée.', rejected: 'Demande refusée.', done: 'Intervention terminée.', cancelled: 'Annulée.' };
      $$('#dlg [data-status]').forEach(btn => btn.onclick = () =>
        run(() => api('/api/bookings/' + id, { method: 'PATCH', body: { status: btn.dataset.status } }), MSG[btn.dataset.status]));
      $$('#dlg [data-del]').forEach(btn => btn.onclick = () =>
        run(() => api(`/api/${btn.dataset.del}/${btn.dataset.id}`, { method: 'DELETE' }), 'Supprimé.'));
      const bindForm = (sel, fn, msg) => { const f = $(sel); if (f) f.onsubmit = e => { e.preventDefault(); run(() => fn(Object.fromEntries(new FormData(f))), msg); }; };
      bindForm('#metaForm', body => { if (body.hourly_rate === '') delete body.hourly_rate; return api('/api/bookings/' + id, { method: 'PATCH', body }); }, 'Enregistré.');
      bindForm('#workForm', body => api(`/api/bookings/${id}/work`, { method: 'POST', body }), 'Heures ajoutées.');
      bindForm('#expForm', body => api(`/api/bookings/${id}/expenses`, { method: 'POST', body }), 'Achat ajouté.');
      const cancelBtn = $('#cancelBtn');
      if (cancelBtn) cancelBtn.onclick = () => {
        $('#cancelZone').innerHTML = `<span class="hint">Confirmer l’annulation ?</span>
          <button type="button" class="btn" id="cancelYes">Oui, annuler</button>
          <button type="button" class="btn ghost" id="cancelNo">Non</button>`;
        $('#cancelYes').onclick = () => run(() => api('/api/bookings/' + id, { method: 'PATCH', body: { status: 'cancelled' } }), MSG.cancelled);
        $('#cancelNo').onclick = () => openBooking(id);
      };
    },
  });
  dlgBooking = String(id);
  $('#dlgBody').scrollTop = keepScroll;
}

// ---------- Listes ----------
async function renderBookings() {
  let list;
  try { list = await api('/api/bookings'); } catch (err) { return toast(err.message); }
  const admin = me.role === 'admin';
  $('#bookingList').innerHTML = list.length ? `<div class="list">${list.map(b => `
    <button type="button" class="item" data-id="${b.id}">
      <div class="item-main">
        <div class="item-title">${esc(b.description || 'Travaux')}</div>
        <div class="item-sub">${fmtRange(b.start, b.end)}${admin ? ' · ' + esc(b.client_name) : ''}</div>
      </div>
      <div class="item-side">${pill(b.status)}<span class="item-total">${eur(b.totals.total)}</span></div>
    </button>`).join('')}</div>`
    : `<p class="empty">${admin ? 'Aucune demande reçue pour le moment.' : 'Aucune demande pour le moment. Choisissez un créneau dans le calendrier.'}</p>`;
  $$('#bookingList [data-id]').forEach(el => el.onclick = () => openBooking(el.dataset.id));
}

async function renderAdmin() {
  $('#rateForm [name=default_rate]').value = defaultRate;
  let clients;
  try { clients = await api('/api/clients'); } catch (err) { return toast(err.message); }
  $('#clientList').innerHTML = clients.length ? `<table class="clients"><thead><tr><th>Nom</th><th>E-mail</th><th>Téléphone</th></tr></thead><tbody>
    ${clients.map(c => `<tr><td>${esc(c.name)}</td><td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td>
      <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
  </tbody></table>` : '<p class="hint">Aucun client inscrit pour le moment.</p>';
}
$('#rateForm').onsubmit = async e => {
  e.preventDefault();
  const v = new FormData(e.target).get('default_rate');
  try { await api('/api/settings', { method: 'PUT', body: { default_rate: v } }); defaultRate = Number(v); toast('Tarif enregistré.'); }
  catch (err) { toast(err.message); }
};

boot();
