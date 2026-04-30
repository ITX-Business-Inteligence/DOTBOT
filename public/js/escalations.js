// Dashboard de escalaciones: tabla con filtros + modal de detalle/accion.

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

  bindFilters();
  bindModal();
  await loadEscalations();
})();

let currentFilters = { status: '', urgency: '' };
let allEscalations = [];

function bindFilters() {
  document.querySelectorAll('.status-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.status-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilters.status = btn.dataset.status;
      loadEscalations();
    });
  });
  document.querySelectorAll('.urgency-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.urgency-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilters.urgency = btn.dataset.urgency;
      loadEscalations();
    });
  });
}

async function loadEscalations() {
  const params = new URLSearchParams();
  if (currentFilters.status) params.set('status', currentFilters.status);
  if (currentFilters.urgency) params.set('urgency', currentFilters.urgency);
  const data = await window.BOTDOT.api('/api/escalations?' + params.toString());
  allEscalations = data.escalations || [];
  render();
}

function render() {
  const tbody = document.getElementById('escTableBody');
  if (!allEscalations.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">Sin escalaciones para este filtro.</td></tr>';
    return;
  }
  tbody.innerHTML = allEscalations.map(e => `
    <tr class="${e.status === 'resolved' ? 'opacity-50' : ''}">
      <td class="font-mono text-xs">#${e.id}</td>
      <td>${urgencyBadge(e.urgency)}</td>
      <td>${statusBadge(e.status)}</td>
      <td class="text-xs">
        <div>${escapeHtml(e.user_name)}</div>
        <div class="text-slate-500">${escapeHtml(e.user_role)}</div>
      </td>
      <td class="text-xs"><span class="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded">${escapeHtml(e.category)}</span></td>
      <td class="text-sm max-w-xs truncate" title="${escapeHtml(e.trigger_message || '')}">${escapeHtml((e.trigger_message || '').slice(0, 80))}</td>
      <td class="text-xs">${e.assigned_name ? escapeHtml(e.assigned_name) : '<span class="text-slate-500">—</span>'}</td>
      <td class="text-xs text-slate-400 whitespace-nowrap">${new Date(e.created_at).toLocaleString('es-MX')}</td>
      <td class="text-right">
        <button data-id="${e.id}" class="open-detail text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded">Detalle</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.open-detail').forEach(btn => {
    btn.addEventListener('click', () => openModal(parseInt(btn.dataset.id, 10)));
  });
}

function urgencyBadge(u) {
  const map = {
    critical: { label: '🚨 CRITICAL', cls: 'bg-red-700 text-white' },
    high:     { label: '⚠️ HIGH',     cls: 'bg-orange-700 text-white' },
    medium:   { label: '⚡ MEDIUM',    cls: 'bg-amber-700 text-white' },
    low:      { label: '📋 LOW',      cls: 'bg-slate-600 text-white' },
  };
  const t = map[u] || map.low;
  return `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${t.cls}">${t.label}</span>`;
}

function statusBadge(s) {
  const map = {
    pending:     { label: 'PENDING',     cls: 'bg-red-950/60 text-red-200 border-red-900/60' },
    assigned:    { label: 'ASSIGNED',    cls: 'bg-amber-950/60 text-amber-200 border-amber-900/60' },
    in_progress: { label: 'IN PROGRESS', cls: 'bg-blue-950/60 text-blue-200 border-blue-900/60' },
    resolved:    { label: 'RESOLVED',    cls: 'bg-emerald-950/60 text-emerald-200 border-emerald-900/60' },
  };
  const t = map[s] || { label: s, cls: 'bg-slate-800 text-slate-300 border-slate-700' };
  return `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded border ${t.cls}">${t.label}</span>`;
}

// ─── Modal ──────────────────────────────────────────────────────

function bindModal() {
  document.querySelectorAll('.modal-close').forEach(b => b.addEventListener('click', closeModal));
  const m = document.getElementById('escModal');
  if (m) m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
}

function closeModal() {
  document.getElementById('escModal').classList.add('hidden');
}

async function openModal(id) {
  const e = allEscalations.find(x => x.id === id);
  if (!e) return;
  document.getElementById('escModalTitle').textContent = `Escalacion #${e.id}`;
  document.getElementById('escModalBody').innerHTML = `
    <div class="grid grid-cols-2 gap-2 text-sm">
      <div class="text-slate-400">Status:</div><div>${statusBadge(e.status)}</div>
      <div class="text-slate-400">Urgencia:</div><div>${urgencyBadge(e.urgency)}</div>
      <div class="text-slate-400">Categoria:</div><div class="text-slate-200">${escapeHtml(e.category)}</div>
      <div class="text-slate-400">Usuario:</div><div class="text-slate-200">${escapeHtml(e.user_name)} (${escapeHtml(e.user_role)}) &lt;${escapeHtml(e.user_email)}&gt;</div>
      <div class="text-slate-400">Asignado a:</div><div class="text-slate-200">${e.assigned_name ? escapeHtml(e.assigned_name) : '—'}</div>
      <div class="text-slate-400">Creada:</div><div class="text-slate-200">${new Date(e.created_at).toLocaleString('es-MX')}</div>
      ${e.resolved_at ? `<div class="text-slate-400">Resuelta:</div><div class="text-slate-200">${new Date(e.resolved_at).toLocaleString('es-MX')}</div>` : ''}
      <div class="text-slate-400">Conversacion:</div><div class="text-slate-200">${e.conversation_id ? '#' + e.conversation_id : '—'}</div>
      <div class="text-slate-400">Email:</div><div class="text-slate-200 text-xs">${e.email_sent_at ? '✓ enviado a ' + escapeHtml(e.email_recipients || '') : (e.email_error ? 'fallo: ' + escapeHtml(e.email_error) : 'pendiente')}</div>
    </div>

    <div>
      <h4 class="text-xs font-bold text-slate-400 uppercase mt-3 mb-1">Pregunta del usuario</h4>
      <div class="bg-slate-800 border border-slate-700 rounded p-2 text-sm text-slate-200">${escapeHtml(e.trigger_message)}</div>
    </div>

    ${e.bot_reasoning ? `
    <div>
      <h4 class="text-xs font-bold text-slate-400 uppercase mt-3 mb-1">Que le falto al bot</h4>
      <div class="bg-slate-800 border border-slate-700 rounded p-2 text-sm text-slate-200">${escapeHtml(e.bot_reasoning)}</div>
    </div>` : ''}

    ${e.resolution_notes ? `
    <div>
      <h4 class="text-xs font-bold text-emerald-400 uppercase mt-3 mb-1">Resolucion</h4>
      <div class="bg-emerald-950/30 border border-emerald-900/60 rounded p-2 text-sm text-emerald-100">${escapeHtml(e.resolution_notes)}</div>
    </div>` : ''}

    ${e.status !== 'resolved' ? `
    <div class="space-y-2 mt-3 pt-3 border-t border-slate-800">
      <h4 class="text-xs font-bold text-slate-300 uppercase">Acciones</h4>
      <div class="flex gap-2 flex-wrap">
        <button class="action-btn" data-action="assign-me">Asignarme</button>
        <button class="action-btn" data-action="in_progress">En progreso</button>
      </div>
      <div>
        <label class="block text-xs text-slate-400 mb-1">Notas de resolucion</label>
        <textarea id="resolutionNotes" rows="3" class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 text-sm" placeholder="Que se hizo, cual fue la decision, a quien se contacto..."></textarea>
        <button class="resolve-btn mt-2 w-full bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 rounded text-sm font-semibold">Marcar como resuelta</button>
      </div>
    </div>` : ''}
  `;

  document.getElementById('escModal').classList.remove('hidden');

  // wire actions
  document.querySelectorAll('#escModalBody .action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        if (btn.dataset.action === 'assign-me') {
          const me = await window.BOTDOT.api('/api/auth/me');
          await window.BOTDOT.api(`/api/escalations/${id}`, {
            method: 'PATCH',
            body: { assigned_to_user_id: me.user.id },
          });
        } else if (btn.dataset.action === 'in_progress') {
          await window.BOTDOT.api(`/api/escalations/${id}`, {
            method: 'PATCH',
            body: { status: 'in_progress' },
          });
        }
        await loadEscalations();
        const updated = allEscalations.find(x => x.id === id);
        if (updated) openModal(id);
      } catch (e) { alert('Error: ' + e.message); }
    });
  });

  const resolveBtn = document.querySelector('#escModalBody .resolve-btn');
  if (resolveBtn) {
    resolveBtn.addEventListener('click', async () => {
      const notes = document.getElementById('resolutionNotes').value.trim();
      if (!notes) { alert('Pone una nota de resolucion'); return; }
      try {
        await window.BOTDOT.api(`/api/escalations/${id}`, {
          method: 'PATCH',
          body: { status: 'resolved', resolution_notes: notes },
        });
        closeModal();
        await loadEscalations();
      } catch (e) { alert('Error: ' + e.message); }
    });
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
