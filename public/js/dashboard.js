// Dashboard widgets: KPIs y BASICs status.

window.BOTDOT = window.BOTDOT || {};

window.BOTDOT.loadDashboard = async function() {
  // KPIs
  try {
    const k = await window.BOTDOT.api('/api/dashboard/kpis');
    setText('kpi-basics', k.basics_in_alert ?? '—');
    setText('kpi-dataqs', k.dataqs_candidates ?? '—');
    setText('kpi-crashes', k.crashes_24m ?? '—');
    setText('kpi-overrides', k.overrides_30d ?? '—');
  } catch (e) { console.warn('kpis:', e.message); }

  // BASICs
  try {
    const b = await window.BOTDOT.api('/api/dashboard/basics');
    renderBasics(b.basics);
  } catch (e) {
    document.getElementById('basicsList').innerHTML =
      `<div class="text-sm text-amber-700 bg-amber-50 p-2 rounded">Sin datos. Ejecutar npm run ingest-sms.</div>`;
  }

  // Audit (lazy)
  const auditBtn = document.getElementById('loadAuditBtn');
  if (auditBtn) auditBtn.addEventListener('click', () => loadAudit());
};

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderBasics(basics) {
  const list = document.getElementById('basicsList');
  if (!basics || !basics.length) {
    list.innerHTML = `<div class="text-sm text-slate-400">Sin snapshots cargados</div>`;
    return;
  }
  list.innerHTML = basics.map(b => `
    <div class="basic-row ${b.alert ? 'alert' : ''}">
      <div class="basic-name truncate" title="${escapeHtml(b.basic_name)}">${escapeHtml(b.basic_name)}</div>
      <div class="flex items-baseline">
        <div class="basic-score">${b.score_pct ?? '—'}</div>
        <div class="basic-threshold">/ ${b.threshold_pct ?? '—'}</div>
      </div>
    </div>
  `).join('');
}

async function loadAudit() {
  try {
    const a = await window.BOTDOT.api('/api/dashboard/audit?limit=50');
    showAuditModal(a.entries);
  } catch (e) { alert('No autorizado o sin datos.'); }
}

function showAuditModal(entries) {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
      <div class="px-4 py-3 border-b flex items-center justify-between">
        <h3 class="font-bold text-slate-900">Audit Log - Ultimas 50 decisiones</h3>
        <button id="closeAudit" class="text-slate-500 hover:text-slate-900">✕</button>
      </div>
      <div class="overflow-y-auto p-4">
        <table class="audit-table">
          <thead>
            <tr><th>Fecha</th><th>Usuario</th><th>Accion</th><th>Decision</th><th>Razon</th></tr>
          </thead>
          <tbody>
            ${entries.map(e => `
              <tr>
                <td class="whitespace-nowrap text-xs">${new Date(e.created_at).toLocaleString('es-MX')}</td>
                <td class="text-xs">${escapeHtml(e.user_name)}<br><span class="text-slate-400">${e.user_role}</span></td>
                <td class="text-xs">${escapeHtml(e.action_type)}</td>
                <td><span class="audit-decision ${e.decision || ''}">${e.decision || '—'}</span></td>
                <td class="text-xs">${escapeHtml(e.reasoning || '').slice(0, 200)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#closeAudit').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
