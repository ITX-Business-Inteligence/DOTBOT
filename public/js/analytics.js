// Carga y render del dashboard de analytics meta de BOTDOT.

(async function init() {
  // Verificar sesion + rol
  let user;
  try {
    const me = await window.BOTDOT.api('/api/auth/me');
    user = me.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (!['admin', 'manager', 'compliance'].includes(user.role)) {
    document.querySelector('main').innerHTML =
      '<div class="card text-center text-slate-600">Esta vista esta restringida a roles admin, manager o compliance.</div>';
    return;
  }

  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  const periodSelect = document.getElementById('periodSelect');
  periodSelect.addEventListener('change', () => loadAll(periodSelect.value));
  await loadAll(periodSelect.value);
})();

async function loadAll(period) {
  await Promise.all([
    loadOverview(period),
    loadUsage(period),
    loadByRole(period),
    loadTopUsers(period),
    loadTopTools(period),
    loadDecisions(period),
    loadHeatmap(period),
    loadTopics(period),
    loadCost(period),
    loadRefused(period),
  ]).catch(e => console.error(e));
}

async function loadOverview(period) {
  const o = await window.BOTDOT.api(`/api/analytics/overview?period=${period}`);
  setText('kpi-convs', fmt(o.conversations));
  setText('kpi-msgs', fmt(o.user_messages));
  setText('kpi-users', fmt(o.active_users));
  setText('kpi-decisions', fmt(o.decisions));
  setText('kpi-refused', fmt(o.refused_requests));
  setText('kpi-override', `${o.override_rate_pct ?? 0}%`);
  setText('kpi-latency', o.avg_latency_ms ? `${(o.avg_latency_ms / 1000).toFixed(1)}s` : '—');
}

let usageChart, roleChart, toolsChart, decisionsChart;

async function loadUsage(period) {
  const d = await window.BOTDOT.api(`/api/analytics/usage-over-time?period=${period}`);
  const labels = d.series.map(r => r.day.slice(5)); // MM-DD
  const msgs = d.series.map(r => r.messages);
  const convs = d.series.map(r => r.conversations);
  const ctx = document.getElementById('usageChart');
  if (usageChart) usageChart.destroy();
  usageChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Preguntas', data: msgs, borderColor: '#1e3a8a', backgroundColor: '#1e3a8a22', tension: 0.3, fill: true },
        { label: 'Conversaciones', data: convs, borderColor: '#0891b2', backgroundColor: 'transparent', tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });
}

async function loadByRole(period) {
  const d = await window.BOTDOT.api(`/api/analytics/by-role?period=${period}`);
  const labels = d.by_role.map(r => labelRole(r.role));
  const data = d.by_role.map(r => r.queries);
  const ctx = document.getElementById('roleChart');
  if (roleChart) roleChart.destroy();
  roleChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: ['#1e3a8a', '#0891b2', '#16a34a', '#ca8a04', '#dc2626'],
      }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });
}

async function loadTopUsers(period) {
  const d = await window.BOTDOT.api(`/api/analytics/top-users?period=${period}`);
  const html = d.users.length ? `
    <table class="audit-table w-full">
      <thead><tr><th>Usuario</th><th>Rol</th><th>Preguntas</th><th>Convs</th><th>Ultima act.</th></tr></thead>
      <tbody>
        ${d.users.map(u => `
          <tr>
            <td>${escapeHtml(u.full_name)}</td>
            <td><span class="text-xs uppercase tracking-wide text-slate-500">${escapeHtml(u.role)}</span></td>
            <td><strong>${u.queries}</strong></td>
            <td>${u.conversations}</td>
            <td class="text-xs text-slate-500">${u.last_active ? new Date(u.last_active).toLocaleDateString('es-MX') : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="text-sm text-slate-400 p-4">Sin datos en el periodo</div>';
  document.getElementById('topUsersTable').innerHTML = html;
}

async function loadTopTools(period) {
  const d = await window.BOTDOT.api(`/api/analytics/top-tools?period=${period}`);
  const labels = d.tools.slice(0, 12).map(t => t.tool_name);
  const data = d.tools.slice(0, 12).map(t => t.calls);
  const ctx = document.getElementById('toolsChart');
  if (toolsChart) toolsChart.destroy();
  toolsChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Llamadas', data, backgroundColor: '#1e3a8a' }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    },
  });
}

async function loadDecisions(period) {
  const d = await window.BOTDOT.api(`/api/analytics/decisions?period=${period}`);
  const colors = { proceed: '#16a34a', conditional: '#ca8a04', decline: '#dc2626', override: '#7c3aed', informational: '#0284c7' };
  const labels = d.decisions.map(x => x.decision);
  const data = d.decisions.map(x => x.count);
  const bg = labels.map(l => colors[l] || '#64748b');
  const ctx = document.getElementById('decisionsChart');
  if (decisionsChart) decisionsChart.destroy();
  decisionsChart = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: bg }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });
}

async function loadHeatmap(period) {
  const d = await window.BOTDOT.api(`/api/analytics/hour-heatmap?period=${period}`);
  // dow MySQL: 1=domingo ... 7=sabado
  const dows = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const r of d.heatmap) {
    const dow = (r.dow - 1 + 7) % 7;
    matrix[dow][r.hour] = r.count;
    if (r.count > max) max = r.count;
  }
  let html = '<div class="hm-grid">';
  html += '<div></div>';
  for (let h = 0; h < 24; h++) html += `<div class="hm-label-col">${h}</div>`;
  for (let d2 = 1; d2 < 7; d2++) {
    html += `<div class="hm-label-row">${dows[d2]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = matrix[d2][h];
      const intensity = max ? v / max : 0;
      const bg = v ? `rgba(30,58,138,${0.15 + intensity * 0.85})` : '#f1f5f9';
      html += `<div class="hm-cell" style="background:${bg}" title="${dows[d2]} ${h}:00 - ${v} preguntas"></div>`;
    }
  }
  // Domingo al final
  html += `<div class="hm-label-row">${dows[0]}</div>`;
  for (let h = 0; h < 24; h++) {
    const v = matrix[0][h];
    const intensity = max ? v / max : 0;
    const bg = v ? `rgba(30,58,138,${0.15 + intensity * 0.85})` : '#f1f5f9';
    html += `<div class="hm-cell" style="background:${bg}" title="${dows[0]} ${h}:00 - ${v} preguntas"></div>`;
  }
  html += '</div>';
  document.getElementById('heatmap').innerHTML = html;
}

async function loadTopics(period) {
  const d = await window.BOTDOT.api(`/api/analytics/topics?period=${period}`);
  const cloud = document.getElementById('wordCloud');
  if (!d.top_words.length) {
    cloud.innerHTML = '<span class="text-sm text-slate-400">Sin datos suficientes en el periodo</span>';
  } else {
    const max = d.top_words[0].count;
    cloud.innerHTML = d.top_words.map(w => {
      const size = Math.max(0.85, Math.min(1.6, 0.85 + (w.count / max) * 0.75));
      return `<span class="word-chip" style="font-size:${size}rem">${escapeHtml(w.word)}<span class="count">${w.count}</span></span>`;
    }).join('');
  }

  const repeated = document.getElementById('repeatedPrompts');
  if (!d.repeated_prompts.length) {
    repeated.innerHTML = '<div class="text-sm text-slate-400">Sin preguntas repetidas en el periodo</div>';
  } else {
    repeated.innerHTML = d.repeated_prompts.map(p => `
      <div class="flex items-center gap-2 p-2 bg-slate-50 rounded-lg">
        <span class="text-xs font-bold bg-blue-900 text-white px-2 py-0.5 rounded">×${p.count}</span>
        <span class="flex-1 truncate" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
      </div>`).join('');
  }
}

async function loadCost(period) {
  const c = await window.BOTDOT.api(`/api/analytics/cost?period=${period}`);
  setText('kpi-cost', `$${c.estimated_cost_usd}`);
  document.getElementById('kpi-cost').setAttribute('title', `Mensual proyectado: $${c.estimated_monthly_usd}`);
}

async function loadRefused(period) {
  const d = await window.BOTDOT.api(`/api/analytics/refused?period=${period}`);
  if (!d.refused.length) {
    document.getElementById('refusedTable').innerHTML =
      '<div class="text-sm text-slate-400 p-2">Sin solicitudes rechazadas en el periodo (esto es bueno).</div>';
    return;
  }
  document.getElementById('refusedTable').innerHTML = `
    <table class="audit-table w-full">
      <thead><tr><th>Fecha</th><th>Usuario</th><th>Solicitud</th><th>CFR</th><th>Razon</th></tr></thead>
      <tbody>
        ${d.refused.map(r => {
          let req = '';
          try {
            const ev = typeof r.evidence_json === 'string' ? JSON.parse(r.evidence_json) : r.evidence_json;
            req = ev?.request || '';
          } catch (e) {}
          return `
            <tr>
              <td class="text-xs whitespace-nowrap">${new Date(r.created_at).toLocaleString('es-MX')}</td>
              <td>${escapeHtml(r.full_name)}<br><span class="text-xs text-slate-400">${r.role}</span></td>
              <td class="text-xs max-w-md">${escapeHtml(req).slice(0, 200)}</td>
              <td class="text-xs">${escapeHtml(r.cfr_cited || '—')}</td>
              <td class="text-xs">${escapeHtml(r.reasoning || '').slice(0, 200)}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('es-MX');
}
function labelRole(r) {
  const map = { dispatcher: 'Dispatcher', supervisor: 'Supervisor', compliance: 'Compliance', manager: 'Manager', admin: 'Admin' };
  return map[r] || r;
}
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
