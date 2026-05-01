// Admin UI de drivers — listado + import Excel + edit individual + discrepancias.

(async function init() {
  let me;
  try {
    const r = await window.BOTDOT.api('/api/auth/me');
    me = r.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (!['admin', 'compliance'].includes(me.role)) {
    document.querySelector('main').innerHTML =
      '<div class="card text-center text-slate-300">Esta vista esta restringida a admin o compliance.</div>';
    return;
  }
  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  bindTabs();
  bindToolbar();
  bindImportModal();
  bindDriverEditModal();

  await loadDrivers();
  await loadDiscrepancies();
})();

let allDrivers = [];

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-drivers').classList.toggle('hidden', tab !== 'drivers');
      document.getElementById('tab-discrepancies').classList.toggle('hidden', tab !== 'discrepancies');
    });
  });
}

function bindToolbar() {
  document.getElementById('importBtn').addEventListener('click', () => {
    showImportStep(1);
    document.getElementById('importModal').classList.remove('hidden');
  });
  document.getElementById('showAll').addEventListener('change', () => loadDrivers());
  document.getElementById('driversSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return renderDrivers(allDrivers);
    const filtered = allDrivers.filter(d =>
      (d.full_name || '').toLowerCase().includes(q) ||
      (d.cdl_number || '').toLowerCase().includes(q) ||
      (d.location || '').toLowerCase().includes(q) ||
      (d.company || '').toLowerCase().includes(q)
    );
    renderDrivers(filtered);
  });

  document.querySelectorAll('.disc-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.disc-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadDiscrepancies(btn.dataset.source);
    });
  });

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', closeModals);
  });
  ['importModal', 'driverEditModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) closeModals(); });
  });
}

function closeModals() {
  document.getElementById('importModal').classList.add('hidden');
  document.getElementById('driverEditModal').classList.add('hidden');
}

async function loadDrivers() {
  const showAll = document.getElementById('showAll').checked;
  const data = await window.BOTDOT.api('/api/admin/drivers' + (showAll ? '?show=all' : ''));
  allDrivers = data.drivers || [];
  renderDrivers(allDrivers);
  document.getElementById('driversCount').textContent =
    `${allDrivers.length} drivers ${showAll ? '(activos + inactivos)' : '(solo activos)'}`;
}

function renderDrivers(list) {
  const tbody = document.getElementById('driversTableBody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Sin drivers.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(d => {
    const cdlTone = expirationTone(d.cdl_days);
    const medTone = expirationTone(d.medical_days);
    const sourceBadge = sourceBadgeHtml(d.data_source);
    const matchBadge = matchConfidenceBadge(d.match_confidence);
    return `
      <tr class="${d.active ? '' : 'opacity-50'}">
        <td>
          <div class="font-medium text-slate-100">${escapeHtml(d.full_name || '—')} ${matchBadge}</div>
          ${d.samsara_id ? `<div class="text-[10px] text-slate-500">samsara: ${escapeHtml(d.samsara_id)}</div>` : ''}
        </td>
        <td class="font-mono text-xs">${escapeHtml(d.cdl_number || '—')}</td>
        <td class="text-xs">${escapeHtml(d.cdl_state || '—')}</td>
        <td class="${cdlTone.text} text-xs whitespace-nowrap">
          ${formatDate(d.cdl_expiration)}
          ${d.cdl_days != null ? `<div class="${cdlTone.subtext}">${daysLabel(d.cdl_days)}</div>` : ''}
        </td>
        <td class="${medTone.text} text-xs whitespace-nowrap">
          ${formatDate(d.medical_card_expiration)}
          ${d.medical_days != null ? `<div class="${medTone.subtext}">${daysLabel(d.medical_days)}</div>` : ''}
        </td>
        <td class="text-xs">${escapeHtml(d.location || '—')}</td>
        <td>${sourceBadge}</td>
        <td class="text-right">
          <button data-action="edit" data-id="${d.id}"
            class="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded">Editar</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('button[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = allDrivers.find(x => x.id === parseInt(btn.dataset.id, 10));
      if (d) openEditDriverModal(d);
    });
  });
}

function expirationTone(days) {
  if (days == null) return { text: 'text-slate-300', subtext: 'text-slate-500' };
  if (days < 0)   return { text: 'text-red-300',     subtext: 'text-red-400 font-semibold' };
  if (days <= 7)  return { text: 'text-red-300',     subtext: 'text-red-400 font-semibold' };
  if (days <= 14) return { text: 'text-orange-300',  subtext: 'text-orange-400' };
  if (days <= 30) return { text: 'text-amber-300',   subtext: 'text-amber-400' };
  if (days <= 60) return { text: 'text-blue-300',    subtext: 'text-blue-400' };
  return { text: 'text-slate-300', subtext: 'text-slate-500' };
}

function daysLabel(days) {
  if (days < 0)  return `vencido ${Math.abs(days)}d`;
  if (days === 0) return 'vence HOY';
  if (days === 1) return 'vence mañana';
  return `${days}d`;
}

function sourceBadgeHtml(src) {
  const map = {
    samsara:           { label: 'Samsara',  cls: 'bg-cyan-950/50 text-cyan-200 border-cyan-900/60' },
    excel:             { label: 'Excel',    cls: 'bg-emerald-950/50 text-emerald-200 border-emerald-900/60' },
    'samsara+excel':   { label: 'Sam+Xls',  cls: 'bg-violet-950/50 text-violet-200 border-violet-900/60' },
    manual:            { label: 'Manual',   cls: 'bg-amber-950/50 text-amber-200 border-amber-900/60' },
  };
  const t = map[src] || { label: src || '—', cls: 'bg-slate-800 text-slate-300 border-slate-700' };
  return `<span class="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border ${t.cls}">${t.label}</span>`;
}

// Badge de confianza del match Excel↔Samsara. Solo aparece cuando confidence
// es 'low' (fuzzy match — compliance debe revisar). 'high' (CDL exacto) y
// 'manual' (admin confirmo) no muestran nada porque ya son confiables.
function matchConfidenceBadge(conf) {
  if (conf !== 'low') return '';
  return `<span class="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-950/60 text-amber-200 border-amber-700/60 ml-1" title="Match Excel↔Samsara por nombre fuzzy. Editar para confirmar.">⚠ revisar</span>`;
}

// ─── Discrepancias ──────────────────────────────────────────────

async function loadDiscrepancies(source = '') {
  const url = '/api/admin/drivers/discrepancies' + (source ? `?source=${source}` : '');
  const data = await window.BOTDOT.api(url);
  const list = data.discrepancies || [];
  document.getElementById('discCount').textContent = list.length;

  const tbody = document.getElementById('discrepanciesTableBody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-6">Sin discrepancias.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(d => {
    const sourceBadge = d.source === 'excel_only'
      ? '<span class="text-[10px] font-bold bg-emerald-900/50 text-emerald-200 px-1.5 py-0.5 rounded">EN EXCEL</span>'
      : '<span class="text-[10px] font-bold bg-cyan-900/50 text-cyan-200 px-1.5 py-0.5 rounded">EN SAMSARA</span>';
    return `
      <tr>
        <td>${sourceBadge}</td>
        <td class="text-sm">${escapeHtml(d.full_name || '—')}</td>
        <td class="font-mono text-xs">${escapeHtml(d.cdl_number || '—')}</td>
        <td class="text-xs text-slate-400">${escapeHtml(d.reason || '—')}</td>
        <td class="text-xs text-slate-500 whitespace-nowrap">${new Date(d.detected_at).toLocaleString('es-MX')}</td>
        <td class="text-right">
          <button data-disc-id="${d.id}"
            class="text-xs bg-emerald-900/40 hover:bg-emerald-800/60 border border-emerald-700/60 text-emerald-100 px-2 py-1 rounded">
            Resolver
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('button[data-disc-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const note = prompt('Nota de resolucion (opcional):');
      if (note === null) return;
      try {
        await window.BOTDOT.api(`/api/admin/drivers/discrepancies/${btn.dataset.discId}/resolve`, {
          method: 'POST',
          body: { note },
        });
        await loadDiscrepancies(document.querySelector('.disc-filter.active').dataset.source);
      } catch (e) { alert('Error: ' + e.message); }
    });
  });
}

// ─── Import modal ───────────────────────────────────────────────

function bindImportModal() {
  const fileInput = document.getElementById('importFile');
  const previewBtn = document.getElementById('previewBtn');
  const commitBtn = document.getElementById('commitBtn');
  let lastFile = null;

  previewBtn.addEventListener('click', async () => {
    if (!fileInput.files.length) {
      alert('Selecciona un archivo .xlsx');
      return;
    }
    lastFile = fileInput.files[0];
    previewBtn.disabled = true;
    previewBtn.textContent = 'Analizando...';
    try {
      const fd = new FormData();
      fd.append('file', lastFile);
      const res = await fetch('/api/admin/drivers/import', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderPreview(data);
      showImportStep(2);
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Generar preview';
    }
  });

  commitBtn.addEventListener('click', async () => {
    if (!lastFile) return;
    commitBtn.disabled = true;
    commitBtn.textContent = 'Importando...';
    document.getElementById('importError').classList.add('hidden');
    try {
      const fd = new FormData();
      fd.append('file', lastFile);
      const res = await fetch('/api/admin/drivers/import?commit=1', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      document.getElementById('commitSummary').textContent =
        `${data.matches_count} drivers actualizados. ${data.excel_only_count + data.samsara_only_count} discrepancias detectadas. Batch: ${data.summary.batch_id}.`;
      showImportStep(3);
      // Reload main views
      await loadDrivers();
      await loadDiscrepancies();
    } catch (e) {
      const errBox = document.getElementById('importError');
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
    } finally {
      commitBtn.disabled = false;
      commitBtn.textContent = 'Confirmar import';
    }
  });
}

function showImportStep(n) {
  for (const i of [1, 2, 3]) {
    document.getElementById(`importStep${i}`).classList.toggle('hidden', i !== n);
  }
}

function renderPreview(data) {
  const s = data.summary;
  const target = document.getElementById('previewSummary');
  target.innerHTML = `
    <div class="grid grid-cols-2 gap-1.5">
      <div class="text-slate-400">Excel Active:</div><div class="text-slate-100">${s.excel_active}</div>
      <div class="text-slate-400">Excel Terminated:</div><div class="text-slate-100">${s.excel_terminated}</div>
      <div class="text-slate-400">Drivers en Samsara:</div><div class="text-slate-100">${s.samsara_total}</div>
      <div class="text-slate-400 border-t border-slate-700 pt-1">Match (en ambos):</div>
      <div class="text-emerald-300 font-semibold border-t border-slate-700 pt-1">${s.matched}</div>
      <div class="text-slate-500 pl-3">por CDL #:</div><div class="text-slate-300">${s.by_cdl}</div>
      <div class="text-slate-500 pl-3">por nombre fuzzy:</div><div class="text-slate-300">${s.by_name_fuzzy}</div>
      <div class="text-slate-400">Solo en Excel:</div><div class="text-amber-300">${s.excel_only}</div>
      <div class="text-slate-400">Solo en Samsara:</div><div class="text-cyan-300">${s.samsara_only}</div>
    </div>
    <p class="text-xs text-slate-500 mt-2">
      "Confirmar import" va a actualizar los ${s.matched} matchedos y registrar todas las discrepancias para revision.
    </p>
  `;
}

// ─── Driver edit modal ──────────────────────────────────────────

function bindDriverEditModal() {
  document.getElementById('driverEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('driverId').value;
    const body = {
      cdl_number: document.getElementById('dCdlNumber').value.trim() || null,
      cdl_state: document.getElementById('dCdlState').value.trim() || null,
      cdl_expiration: document.getElementById('dCdlExp').value || null,
      medical_card_expiration: document.getElementById('dMedExp').value || null,
      endorsements: document.getElementById('dEndorsements').value.trim() || null,
      phone: document.getElementById('dPhone').value.trim() || null,
      company: document.getElementById('dCompany').value.trim() || null,
      location: document.getElementById('dLocation').value.trim() || null,
      division: document.getElementById('dDivision').value.trim() || null,
      notes: document.getElementById('dNotes').value.trim() || null,
      active: document.getElementById('dActive').checked,
    };
    const errBox = document.getElementById('driverEditError');
    errBox.classList.add('hidden');
    try {
      await window.BOTDOT.api(`/api/admin/drivers/${id}`, { method: 'PATCH', body });
      closeModals();
      await loadDrivers();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
    }
  });
}

function openEditDriverModal(d) {
  document.getElementById('driverEditTitle').textContent = `Editar: ${d.full_name}`;
  document.getElementById('driverId').value = d.id;
  document.getElementById('dCdlNumber').value = d.cdl_number || '';
  document.getElementById('dCdlState').value = d.cdl_state || '';
  document.getElementById('dCdlExp').value = d.cdl_expiration ? String(d.cdl_expiration).slice(0, 10) : '';
  document.getElementById('dMedExp').value = d.medical_card_expiration ? String(d.medical_card_expiration).slice(0, 10) : '';
  document.getElementById('dEndorsements').value = d.endorsements || '';
  document.getElementById('dPhone').value = d.phone || '';
  document.getElementById('dCompany').value = d.company || '';
  document.getElementById('dLocation').value = d.location || '';
  document.getElementById('dDivision').value = d.division || '';
  document.getElementById('dNotes').value = d.notes || '';
  document.getElementById('dActive').checked = !!d.active;
  document.getElementById('driverEditError').classList.add('hidden');
  document.getElementById('driverEditModal').classList.remove('hidden');
}

// ─── helpers ────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d.slice(0, 10) + 'T00:00:00') : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
