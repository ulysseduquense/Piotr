const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (n || 0).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
const fmt = d => new Date(d).toLocaleString('fr-BE', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = { pending: 'En attente', confirmed: 'Confirmé', rejected: 'Refusé', cancelled: 'Annulé', done: 'Terminé' };
// valeur pour <input type="datetime-local"> en heure locale
const localInput = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

let me = null, defaultRate = 25, calendar = null;

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

// ---------- Navigation ----------
function show(view) {
  for (const s of ['auth', 'calendar', 'bookings', 'admin']) $('#' + s).hidden = s !== view;
  document.querySelectorAll('nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'calendar') initCalendar();
  if (view === 'bookings') renderBookings();
  if (view === 'admin') renderAdmin();
}
document.querySelectorAll('nav button[data-view]').forEach(b => b.onclick = () => show(b.dataset.view));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

// ---------- Auth ----------
let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $('#authTitle').textContent = reg ? 'Créer un compte' : 'Connexion';
  $('#authSubmit').textContent = reg ? 'Créer mon compte' : 'Se connecter';
  $('#authToggle').textContent = reg ? 'Déjà un compte ? Se connecter' : 'Pas encore de compte ? Créer un compte';
  document.querySelectorAll('.reg').forEach(l => { l.hidden = !reg; l.querySelector('input').required = reg && l.textContent.includes('Nom'); });
}
$('#authToggle').onclick = e => { e.preventDefault(); setAuthMode(!registering); };
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try { await api(registering ? '/api/register' : '/api/login', { method: 'POST', body }); boot(); }
  catch (err) { $('#authError').textContent = err.message; }
};

async function boot() {
  const r = await api('/api/me');
  me = r.user; defaultRate = r.defaultRate;
  if (!me) { $('#nav').hidden = true; setAuthMode(false); return show('auth'); }
  $('#nav').hidden = false;
  document.body.classList.toggle('is-admin', me.role === 'admin');
  $('#who').textContent = me.name + (me.role === 'admin' ? ' (admin)' : '');
  $('nav button[data-view="bookings"]').textContent = me.role === 'admin' ? 'Interventions' : 'Mes demandes';
  $('#calHint').textContent = me.role === 'admin'
    ? 'Sélectionnez une plage pour la bloquer (indisponible) ou réserver pour un client. Cliquez sur un événement pour le gérer.'
    : 'Sélectionnez un créneau libre dans le calendrier pour faire une demande. Les zones grises sont déjà prises.';
  show('calendar');
}

// ---------- Calendrier ----------
const COLORS = { unavailable: '#9aa3ad', busy: '#c9ced6', pending: '#f0a020', confirmed: '#2e9e5b', done: '#5a6fd6' };
function initCalendar() {
  if (calendar) return calendar.refetchEvents();
  calendar = new FullCalendar.Calendar($('#cal'), {
    locale: 'fr', initialView: window.innerWidth < 700 ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay,dayGridMonth,listWeek' },
    slotMinTime: '07:00:00', slotMaxTime: '21:00:00', allDaySlot: false, nowIndicator: true,
    selectable: true, selectMirror: true, height: 'auto', firstDay: 1,
    selectAllow: info => me.role === 'admin' || info.start > new Date(),
    events: (_i, ok, ko) => api('/api/calendar').then(evs => ok(evs.map(e => ({
      ...e, color: COLORS[e.kind === 'booking' ? e.status : e.kind],
      textColor: e.kind === 'busy' ? '#333' : '#fff' }))), ko),
    select: info => { calendar.unselect(); openNewDialog(info.start, info.end); },
    eventClick: info => {
      const e = info.event.extendedProps;
      if (e.kind === 'booking') openBooking(e.bookingId);
      else if (e.kind === 'unavailable' && me.role === 'admin') openUnavailable(info.event);
    },
  });
  calendar.render();
}
const refresh = () => { calendar?.refetchEvents(); if (!$('#bookings').hidden) renderBookings(); };

// ---------- Dialogues ----------
const dlg = $('#dlg');
function openDialog(html, bind) { $('#dlgBody').innerHTML = html; bind?.(); dlg.showModal(); }
const closeBtn = '<button type="button" class="secondary" onclick="dlg.close()">Fermer</button>';

function openNewDialog(start, end) {
  const isAdmin = me.role === 'admin';
  openDialog(`
    <h2>${isAdmin ? 'Nouvelle plage' : 'Demander ce créneau'}</h2>
    <form id="newForm">
      ${isAdmin ? `<label>Type <select name="type"><option value="unav">Je suis indisponible</option>
        <option value="booking">Réserver (pour moi / un client sans compte)</option></select></label>` : ''}
      <label>Début <input type="datetime-local" name="start" value="${localInput(start)}" required></label>
      <label>Fin <input type="datetime-local" name="end" value="${localInput(end)}" required></label>
      <label>${isAdmin ? 'Note / description' : 'Description des travaux'} <textarea name="description" rows="3"></textarea></label>
      ${isAdmin ? '' : '<label>Adresse <input name="address"></label>'}
      <p class="error" id="newErr"></p>
      <div class="row"><button>Valider</button>${closeBtn}</div>
    </form>`, () => {
    $('#newForm').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const s = new Date(f.start).toISOString(), en = new Date(f.end).toISOString();
      try {
        if (f.type === 'unav') await api('/api/unavailabilities', { method: 'POST', body: { start: s, end: en, note: f.description } });
        else await api('/api/bookings', { method: 'POST', body: { start: s, end: en, description: f.description, address: f.address || '' } });
        dlg.close(); refresh();
        if (!isAdmin) alert('Votre demande a été envoyée. Elle apparaît « En attente » jusqu’à validation.');
      } catch (err) { $('#newErr').textContent = err.message; }
    };
  });
}

function openUnavailable(ev) {
  openDialog(`<h2>${esc(ev.title)}</h2><p>${fmt(ev.start)} → ${fmt(ev.end)}</p>
    <div class="row"><button class="danger" id="delUnav">Supprimer cette indisponibilité</button>${closeBtn}</div>`, () => {
    $('#delUnav').onclick = async () => { await api('/api/unavailabilities/' + ev.id.slice(1), { method: 'DELETE' }); dlg.close(); refresh(); };
  });
}

function costTable(b) {
  const isAdmin = me.role === 'admin';
  const del = (type, id) => isAdmin ? `<button class="small danger" data-del="${type}" data-id="${id}">✕</button>` : '';
  return `
    <h3>Main-d’œuvre <small class="hint">(${eur(b.hourly_rate)} / h)</small></h3>
    <table><tr><th>Date</th><th>Détail</th><th class="num">Heures</th><th class="num">Montant</th><th></th></tr>
    ${b.work.map(w => `<tr><td>${esc(w.date)}</td><td>${esc(w.note)}</td><td class="num">${w.hours}</td>
      <td class="num">${eur(w.hours * (b.hourly_rate || 0))}</td><td>${del('work', w.id)}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="hint">Aucune heure encodée</td></tr>'}</table>
    <h3>Achats / fournitures</h3>
    <table><tr><th>Article</th><th class="num">Prix</th><th></th></tr>
    ${b.expenses.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${eur(x.amount)}</td><td>${del('expenses', x.id)}</td></tr>`).join('') ||
      '<tr><td colspan="3" class="hint">Aucun achat</td></tr>'}</table>
    <table>
      <tr><td>Main-d’œuvre (${b.totals.hours} h)</td><td class="num">${eur(b.totals.labour)}</td></tr>
      <tr><td>Achats</td><td class="num">${eur(b.totals.expenses)}</td></tr>
      <tr class="total"><td>Total</td><td class="num">${eur(b.totals.total)}</td></tr>
    </table>`;
}

async function openBooking(id) {
  const b = await api('/api/bookings/' + id);
  const isAdmin = me.role === 'admin';
  const today = new Date().toISOString().slice(0, 10);
  openDialog(`
    <div class="booking-head"><h2>${esc(b.description || 'Travaux')}</h2><span class="badge ${b.status}">${STATUS[b.status]}</span></div>
    <p>📅 ${fmt(b.start)} → ${fmt(b.end)}${b.address ? '<br>📍 ' + esc(b.address) : ''}
    ${isAdmin ? `<br>👤 ${esc(b.client_name)} – ${esc(b.client_email)} ${esc(b.client_phone)}` : ''}</p>
    ${b.admin_note && !isAdmin ? `<p><b>Message :</b> ${esc(b.admin_note)}</p>` : ''}
    ${isAdmin ? `
      <div class="row">
        ${b.status === 'pending' ? '<button data-status="confirmed">✔ Valider</button><button class="danger" data-status="rejected">✕ Refuser</button>' : ''}
        ${b.status === 'confirmed' ? '<button data-status="done">Marquer terminé</button>' : ''}
        ${['confirmed', 'done'].includes(b.status) ? '' : ''}
      </div>
      <form id="metaForm" class="row" style="margin-top:10px">
        <label style="flex:1">Tarif horaire (€) <input name="hourly_rate" type="number" step="0.01" min="0" value="${b.hourly_rate ?? ''}"></label>
        <label style="flex:3">Message au client <input name="admin_note" value="${esc(b.admin_note)}"></label>
        <button>Enregistrer</button>
      </form>` : ''}
    ${costTable(b)}
    ${isAdmin ? `
      <h3>Ajouter des heures prestées</h3>
      <form id="workForm" class="row"><input type="date" name="date" value="${today}" required>
        <input name="hours" type="number" step="0.25" min="0.25" placeholder="Heures" required>
        <input name="note" placeholder="Détail (optionnel)"><button>Ajouter</button></form>
      <h3>Ajouter un achat</h3>
      <form id="expForm" class="row"><input name="label" placeholder="ex. Râteau" required>
        <input name="amount" type="number" step="0.01" placeholder="Prix €" required><button>Ajouter</button></form>` : ''}
    <p class="error" id="bErr"></p>
    <div class="row" style="margin-top:12px">
      ${!isAdmin && ['pending', 'confirmed'].includes(b.status) ? '<button class="danger" data-status="cancelled">Annuler ma demande</button>' : ''}
      ${isAdmin && !['cancelled', 'rejected'].includes(b.status) ? '<button class="secondary" data-status="cancelled">Annuler</button>' : ''}
      ${closeBtn}
    </div>`, () => {
    const run = async fn => { try { await fn(); refresh(); openBooking(id); } catch (e) { $('#bErr').textContent = e.message; } };
    document.querySelectorAll('[data-status]').forEach(btn => btn.onclick = () => {
      if (btn.dataset.status === 'cancelled' && !confirm('Confirmer l’annulation ?')) return;
      run(() => api('/api/bookings/' + id, { method: 'PATCH', body: { status: btn.dataset.status } }));
    });
    document.querySelectorAll('[data-del]').forEach(btn => btn.onclick = () =>
      run(() => api(`/api/${btn.dataset.del}/${btn.dataset.id}`, { method: 'DELETE' })));
    const bindForm = (sel, fn) => { const f = $(sel); if (f) f.onsubmit = e => { e.preventDefault(); run(() => fn(Object.fromEntries(new FormData(f)))); }; };
    bindForm('#metaForm', body => api('/api/bookings/' + id, { method: 'PATCH', body }));
    bindForm('#workForm', body => api(`/api/bookings/${id}/work`, { method: 'POST', body }));
    bindForm('#expForm', body => api(`/api/bookings/${id}/expenses`, { method: 'POST', body }));
  });
}

// ---------- Listes ----------
async function renderBookings() {
  const list = await api('/api/bookings');
  $('#bookingList').innerHTML = list.length ? list.map(b => `
    <div class="card booking-head" style="cursor:pointer" data-id="${b.id}">
      <div><b>${esc(b.description || 'Travaux')}</b> ${me.role === 'admin' ? '– ' + esc(b.client_name) : ''}<br>
        <span class="hint">${fmt(b.start)}</span></div>
      <div style="text-align:right"><span class="badge ${b.status}">${STATUS[b.status]}</span><br><b>${eur(b.totals.total)}</b></div>
    </div>`).join('') : '<p class="hint">Aucune demande pour le moment. Choisissez un créneau dans le calendrier.</p>';
  document.querySelectorAll('#bookingList [data-id]').forEach(el => el.onclick = () => openBooking(el.dataset.id));
}

async function renderAdmin() {
  $('#rateForm [name=default_rate]').value = defaultRate;
  const clients = await api('/api/clients');
  $('#clientList').innerHTML = clients.length ? `<table><tr><th>Nom</th><th>E-mail</th><th>Téléphone</th></tr>
    ${clients.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td></tr>`).join('')}</table>`
    : '<p class="hint">Aucun client inscrit.</p>';
}
$('#rateForm').onsubmit = async e => {
  e.preventDefault();
  const v = new FormData(e.target).get('default_rate');
  await api('/api/settings', { method: 'PUT', body: { default_rate: v } });
  defaultRate = Number(v); alert('Tarif enregistré');
};

boot();
