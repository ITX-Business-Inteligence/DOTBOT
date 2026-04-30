// Dashboard widgets de la sidebar de app.html.
// Hoy solo el widget "Drivers en riesgo" (KPIs y BASICs scores se movieron
// a /analytics.html por decision de producto). Tambien expone el modal
// de audit log para roles management.

window.BOTDOT = window.BOTDOT || {};

window.BOTDOT.loadDashboard = async function() {
  // Drivers en riesgo (visible para todos los roles)
  try {
    const data = await window.BOTDOT.api('/api/dashboard/drivers-at-risk?limit=5');
    renderAtRisk(data);
  } catch (e) {
    console.warn('drivers-at-risk:', e.message);
    document.getElementById('atRiskList').innerHTML =
      `<div class="text-xs text-slate-500">Sin datos disponibles</div>`;
  }

  // Audit (lazy, solo se carga al click). Sigue solo para management.
  const auditBtn = document.getElementById('loadAuditBtn');
  if (auditBtn) auditBtn.addEventListener('click', () => loadAudit());
};

function renderAtRisk(data) {
  const list = document.getElementById('atRiskList');
  const count = document.getElementById('atRiskCount');
  const moreBtn = document.getElementById('atRiskMoreBtn');

  if (!data.drivers || !data.drivers.length) {
    list.innerHTML =
      `<div class="text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 rounded p-2">
         ✓ Ningun driver en riesgo en los proximos ${data.horizon_days || 60} dias
       </div>`;
    count.textContent = '';
    moreBtn.classList.add('hidden');
    return;
  }

  count.textContent = `${data.total_at_risk} total`;

  list.innerHTML = data.drivers.map(d => {
    const days = d.soonest_days;
    const kindLabel = d.soonest_kind === 'cdl' ? 'CDL' : 'Medical';
    const expDate = d.soonest_kind === 'cdl' ? d.cdl_expiration : d.medical_card_expiration;
    const tone = urgencyTone(days);
    const daysText = days < 0 ? `vencido hace ${Math.abs(days)} dias`
                  : days === 0 ? 'vence HOY'
                  : days === 1 ? 'vence mañana'
                  : `${days} dias`;
    return `
      <div class="rounded-lg p-2 ${tone.bg} border ${tone.border}">
        <div class="flex items-center justify-between gap-2">
          <div class="font-medium text-sm ${tone.text} truncate" title="${escapeHtml(d.full_name)}">
            ${escapeHtml(d.full_name)}
          </div>
          <span class="text-[10px] font-bold uppercase ${tone.badge} px-1.5 py-0.5 rounded">${kindLabel}</span>
        </div>
        <div class="text-xs ${tone.subtext} mt-0.5">
          ${daysText} · ${formatDate(expDate)}
        </div>
      </div>
    `;
  }).join('');

  if (data.has_more || data.total_at_risk > data.shown) {
    moreBtn.textContent = `Ver todos (${data.total_at_risk})`;
    moreBtn.classList.remove('hidden');
    moreBtn.onclick = () => {
      // TODO: abrir /drivers.html cuando este construida (post-import-Excel).
      // Por ahora le decimos al usuario que la vista completa esta en camino.
      alert('La vista completa de drivers se habilita cuando importes el Excel de compliance. Por ahora ves los 5 mas urgentes.');
    };
  } else {
    moreBtn.classList.add('hidden');
  }
}

// Paleta segun urgencia. Coherente con el dark mode global.
function urgencyTone(days) {
  if (days == null) return tone('slate');
  if (days < 0)    return tone('red',    'critical'); // vencido
  if (days <= 7)   return tone('red');                // <1 semana
  if (days <= 14)  return tone('orange');             // <2 semanas
  if (days <= 30)  return tone('amber');              // <1 mes
  return tone('blue');                                // <60 dias (informativo)
}

function tone(color, level) {
  const map = {
    red:    { bg: 'bg-red-950/50',     border: 'border-red-900/70',    text: 'text-red-100',    subtext: 'text-red-300',    badge: 'bg-red-700/60 text-white' },
    orange: { bg: 'bg-orange-950/50',  border: 'border-orange-900/70', text: 'text-orange-100', subtext: 'text-orange-300', badge: 'bg-orange-700/60 text-white' },
    amber:  { bg: 'bg-amber-950/50',   border: 'border-amber-900/70',  text: 'text-amber-100',  subtext: 'text-amber-300',  badge: 'bg-amber-700/60 text-white' },
    blue:   { bg: 'bg-blue-950/40',    border: 'border-blue-900/60',   text: 'text-blue-100',   subtext: 'text-blue-300',   badge: 'bg-blue-700/60 text-white' },
    slate:  { bg: 'bg-slate-800',      border: 'border-slate-700',     text: 'text-slate-200',  subtext: 'text-slate-400',  badge: 'bg-slate-600 text-white' },
  };
  return map[color] || map.slate;
}

function formatDate(d) {
  if (!d) return '—';
  // Llega como 'YYYY-MM-DD' (date col de MySQL via mysql2)
  const dt = typeof d === 'string' ? new Date(d + 'T00:00:00') : new Date(d);
  return dt.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadAudit() {
  try {
    const a = await window.BOTDOT.api('/api/dashboard/audit?limit=50');
    showAuditModal(a.entries);
  } catch (e) { alert('No autorizado o sin datos.'); }
}

function showAuditModal(entries) {
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-slate-900 border border-slate-800 rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
      <div class="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h3 class="font-bold text-slate-100">Audit Log - Ultimas 50 decisiones</h3>
        <button id="closeAudit" class="text-slate-400 hover:text-slate-100">✕</button>
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
