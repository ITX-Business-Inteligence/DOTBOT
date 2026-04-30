// Dashboard de notifications: tabla + filtros + dismiss action.

(async function init() {
  let me;
  try {
    const r = await window.BOTDOT.api('/api/auth/me');
    me = r.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (!['admin', 'compliance', 'manager'].includes(me.role)) {
    document.querySelector('main').innerHTML =
      '<div class="card text-center text-slate-300">Esta vista esta restringida a admin, compliance o manager.</div>';
    return;
  }
  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  // Forzar scan manual — solo admin
  if (me.role === 'admin') {
    const btn = document.getElementById('runJobBtn');
    btn.classList.remove('hidden');
    btn.addEventListener('click', forceScan);
  }

  bindFilters();
  await loadAll();
})();

let filters = { status: 'active', kind: '' };

function bindFilters() {
  document.querySelectorAll('.status-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.status-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters.status = btn.dataset.status;
      loadAll();
    });
  });
  document.querySelectorAll('.kind-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.kind-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters.kind = btn.dataset.kind;
      loadAll();
    });
  });
}

async function loadAll() {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  const data = await window.BOTDOT.api('/api/notifications?' + params.toString());
  render(data.notifications || []);
}

function render(list) {
  const tbody = document.getElementById('notifTableBody');
  document.getElementById('notifCount').textContent = `${list.length} notificaciones`;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Sin notificaciones para este filtro.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(n => {
    const exp = n.kind.startsWith('cdl_') ? n.cdl_expiration : n.medical_card_expiration;
    const kindLabel = n.kind === 'cdl_expired' ? 'CDL vencido'
                    : n.kind === 'medical_expired' ? 'Medical vencido'
                    : n.kind === 'cdl_expiring' ? 'CDL por vencer'
                    : 'Medical por vencer';
    const thresholdLabel = n.threshold < 0 ? 'vencido' : n.threshold === 0 ? 'HOY' : `≤ ${n.threshold}d`;
    const emailCell = n.email_sent_at
      ? '<span class="text-emerald-400 text-xs">✓ enviado</span>'
      : (n.email_error ? `<span class="text-red-400 text-xs" title="${escapeHtml(n.email_error)}">fallo</span>`
         : (n.urgency === 'critical' || n.urgency === 'high')
            ? '<span class="text-amber-400 text-xs">pendiente</span>'
            : '<span class="text-slate-500 text-xs">no aplica</span>');
    return `
      <tr class="${n.status !== 'active' ? 'opacity-50' : ''}">
        <td>${urgencyBadge(n.urgency)}</td>
        <td>
          <div class="font-medium text-sm">${escapeHtml(n.driver_name || '—')}</div>
          ${n.cdl_number ? `<div class="text-[10px] text-slate-500">CDL ${escapeHtml(n.cdl_number)} ${escapeHtml(n.cdl_state || '')}</div>` : ''}
        </td>
        <td class="text-xs">${kindLabel}</td>
        <td class="text-xs">${exp ? formatDate(exp) : '—'}</td>
        <td class="text-xs"><span class="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded">${thresholdLabel}</span></td>
        <td>${emailCell}</td>
        <td class="text-xs text-slate-400 whitespace-nowrap">${new Date(n.created_at).toLocaleString('es-MX')}</td>
        <td class="text-right">
          ${n.status === 'active'
            ? `<button data-id="${n.id}" class="dismiss-btn text-xs bg-emerald-900/40 hover:bg-emerald-800/60 border border-emerald-700/60 text-emerald-100 px-2 py-1 rounded">Atender</button>`
            : `<span class="text-xs text-slate-500">${n.dismissed_by_name ? 'por ' + escapeHtml(n.dismissed_by_name) : escapeHtml(n.status)}</span>`}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => dismissOne(parseInt(btn.dataset.id, 10)));
  });
}

function urgencyBadge(u) {
  const map = {
    critical: { label: 'CRITICAL', cls: 'bg-red-700 text-white' },
    high:     { label: 'HIGH',     cls: 'bg-orange-700 text-white' },
    medium:   { label: 'MEDIUM',   cls: 'bg-amber-700 text-white' },
    low:      { label: 'LOW',      cls: 'bg-slate-600 text-white' },
  };
  const t = map[u] || map.low;
  return `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${t.cls}">${t.label}</span>`;
}

async function dismissOne(id) {
  const note = prompt('Nota de la accion (ej: "Driver renovo CDL", "asignado a coaching", "ya no trabaja con nosotros"):');
  if (note === null) return;
  try {
    await window.BOTDOT.api(`/api/notifications/${id}/dismiss`, {
      method: 'POST',
      body: { note },
    });
    await loadAll();
  } catch (e) { alert('Error: ' + e.message); }
}

async function forceScan() {
  const btn = document.getElementById('runJobBtn');
  btn.disabled = true;
  btn.textContent = 'Scaneando...';
  try {
    const r = await window.BOTDOT.api('/api/notifications/run-job', { method: 'POST', body: {} });
    alert(`Scan completado: ${r.scanned} drivers escaneados, ${r.inserted} notificaciones nuevas (${r.elapsed_ms}ms)`);
    await loadAll();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Forzar scan';
  }
}

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
