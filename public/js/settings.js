// Settings: tabs Mi cuenta + Usuarios. La tab Usuarios solo se muestra
// si el rol es admin. Routing por hash (#account, #users) para deep-link.

(async function init() {
  let me;
  try {
    const r = await window.BOTDOT.api('/api/auth/me');
    me = r.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (me.must_change_password) {
    location.href = '/change-password.html';
    return;
  }
  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  // Mi cuenta — info read-only
  document.getElementById('accEmail').textContent = me.email;
  document.getElementById('accName').textContent = me.name;
  document.getElementById('accRole').textContent = (me.role || '').toUpperCase();
  // last_login_at no esta en /me — queda como placeholder. Si lo querés
  // exponer, hay que ampliar /me en el backend.

  // Tab Usuarios solo para admin
  if (me.role === 'admin') {
    document.getElementById('tabUsuarios').classList.remove('hidden');
  }
  // Tab Sistema para admin / compliance / manager
  const isManagement = ['admin', 'compliance', 'manager'].includes(me.role);
  if (isManagement) {
    document.getElementById('tabSistema').classList.remove('hidden');
  }

  bindTabs(me);
  bindPasswordChange();
  if (me.role === 'admin') {
    bindUsersToolbar();
    await loadUsers();
  }
  if (isManagement) {
    await loadSistema(me);
  }

  // Routing por hash al boot
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
})();

function bindTabs(me) {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'users' && me.role !== 'admin') return;
      if (tab === 'sistema' && !['admin','compliance','manager'].includes(me.role)) return;
      location.hash = tab;
    });
  });
}

function routeFromHash() {
  const hash = (location.hash || '#account').replace('#', '');
  const tab = ['account', 'users', 'sistema'].includes(hash) ? hash : 'account';
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('pane-account').classList.toggle('hidden', tab !== 'account');
  document.getElementById('pane-users').classList.toggle('hidden', tab !== 'users');
  document.getElementById('pane-sistema').classList.toggle('hidden', tab !== 'sistema');
}

// ─── Tab: Mi cuenta — cambiar contraseña ────────────────────────

function bindPasswordChange() {
  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = document.getElementById('pwCurrent').value;
    const n1 = document.getElementById('pwNew').value;
    const n2 = document.getElementById('pwConfirm').value;
    const errBox = document.getElementById('pwError');
    const okBox = document.getElementById('pwSuccess');
    errBox.classList.add('hidden');
    okBox.classList.add('hidden');

    if (n1 !== n2) {
      errBox.textContent = 'Las dos contraseñas nuevas no coinciden.';
      errBox.classList.remove('hidden');
      return;
    }
    if (n1.length < 8) {
      errBox.textContent = 'La nueva contraseña debe tener al menos 8 caracteres.';
      errBox.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('pwSubmit');
    btn.disabled = true;
    btn.textContent = 'Guardando...';
    try {
      await window.BOTDOT.api('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: cur, new_password: n1 },
      });
      okBox.textContent = 'Contraseña cambiada con éxito.';
      okBox.classList.remove('hidden');
      document.getElementById('pwForm').reset();
    } catch (e) {
      errBox.textContent = e.message || 'Error cambiando contraseña';
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cambiar contraseña';
    }
  });
}

// ─── Tab: Sistema — estado del CFR auto-update ──────────────────

async function loadSistema(me) {
  const data = await window.BOTDOT.api('/api/admin/cfr/runs');
  document.getElementById('cfrSectionsCount').textContent = data.sections_current || 0;
  const last = data.last_run || {};
  document.getElementById('cfrLastRun').textContent = last.last_started
    ? new Date(last.last_started).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  document.getElementById('cfrLastIssue').textContent = last.last_issue_date
    ? String(last.last_issue_date).slice(0, 10)
    : '—';

  renderCfrRuns(data.runs || []);

  // Boton de forzar update solo para admin
  if (me.role === 'admin') {
    const btn = document.getElementById('forceCfrBtn');
    btn.classList.remove('hidden');
    btn.addEventListener('click', forceCfrUpdate);
  }
}

function renderCfrRuns(runs) {
  const tbody = document.getElementById('cfrRunsTableBody');
  if (!runs.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-slate-500 py-6">Sin runs todavia.</td></tr>';
    return;
  }
  tbody.innerHTML = runs.map(r => {
    const statusBadge = cfrStatusBadge(r.status);
    const triggerBadge = `<span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">${escapeHtml(r.trigger_source)}</span>`;
    const emailCell = r.email_sent_at
      ? '<span class="text-emerald-400 text-xs">✓</span>'
      : (r.sections_changed > 0 || r.sections_added > 0
          ? '<span class="text-amber-400 text-xs">pendiente</span>'
          : '<span class="text-slate-500 text-xs">no aplica</span>');
    return `
      <tr>
        <td class="text-xs text-slate-400 whitespace-nowrap">${new Date(r.started_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${triggerBadge}</td>
        <td class="text-xs">${r.issue_date ? String(r.issue_date).slice(0, 10) : '—'}</td>
        <td>${statusBadge}</td>
        <td class="text-xs">${r.sections_total ?? '—'}</td>
        <td class="text-xs ${r.sections_added > 0 ? 'text-emerald-300 font-semibold' : 'text-slate-500'}">${r.sections_added ?? 0}</td>
        <td class="text-xs ${r.sections_changed > 0 ? 'text-amber-300 font-semibold' : 'text-slate-500'}">${r.sections_changed ?? 0}</td>
        <td class="text-xs text-slate-500">${r.sections_unchanged ?? 0}</td>
        <td class="text-xs text-slate-400">${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
        <td>${emailCell}</td>
      </tr>
    `;
  }).join('');
}

function cfrStatusBadge(s) {
  const map = {
    success:  { label: 'SUCCESS', cls: 'bg-emerald-950/60 text-emerald-200 border-emerald-900/60' },
    noop:     { label: 'NO CHANGES', cls: 'bg-slate-800 text-slate-300 border-slate-700' },
    error:    { label: 'ERROR', cls: 'bg-red-950/60 text-red-200 border-red-900/60' },
    running:  { label: 'RUNNING', cls: 'bg-blue-950/60 text-blue-200 border-blue-900/60' },
  };
  const t = map[s] || { label: s, cls: 'bg-slate-800 text-slate-300 border-slate-700' };
  return `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded border ${t.cls}">${t.label}</span>`;
}

async function forceCfrUpdate() {
  if (!confirm('Forzar un update del CFR ahora? Va a bajar 18 Parts de eCFR.gov, puede tardar 1-2 minutos.')) return;
  const btn = document.getElementById('forceCfrBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Bajando...';
  try {
    const r = await window.BOTDOT.api('/api/admin/cfr/run', { method: 'POST', body: {} });
    alert(`Update completado:\n${r.sections_total} secciones\n${r.sections_added} nuevas, ${r.sections_changed} cambiadas\nDuración: ${(r.duration_ms / 1000).toFixed(1)}s`);
    await loadSistema({ role: 'admin' });
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Forzar update ahora';
  }
}

// ─── Tab: Usuarios (admin) — migrado de users.js ────────────────

const ROLE_LABEL = {
  dispatcher: 'Dispatcher', supervisor: 'Supervisor',
  compliance: 'Compliance', manager: 'Manager', admin: 'Admin',
};
const ROLE_BADGE = {
  dispatcher: 'bg-slate-800 text-slate-200 border-slate-700',
  supervisor: 'bg-cyan-950/50 text-cyan-200 border-cyan-900/60',
  compliance: 'bg-violet-950/50 text-violet-200 border-violet-900/60',
  manager:    'bg-amber-950/50 text-amber-200 border-amber-900/60',
  admin:      'bg-red-950/50 text-red-200 border-red-900/60',
};

let allUsers = [];
let currentMe = null;

async function loadUsers() {
  const me = await window.BOTDOT.api('/api/auth/me');
  currentMe = me.user;
  const data = await window.BOTDOT.api('/api/admin/users');
  allUsers = data.users || [];
  renderUsers(allUsers);
}

function renderUsers(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-6">Sin usuarios.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const isMe = u.id === currentMe.id;
    const roleBadge = ROLE_BADGE[u.role] || ROLE_BADGE.dispatcher;
    const lastLogin = u.last_login_at
      ? new Date(u.last_login_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    const statusCell = u.locked_at
      ? `<span class="text-xs font-semibold text-red-400">🔒 BLOQUEADO</span>
         <div class="text-[10px] text-slate-500">${u.failed_login_count} fallos</div>`
      : (u.active
          ? '<span class="text-xs font-semibold text-emerald-400">● Activo</span>'
          : '<span class="text-xs font-semibold text-slate-500">○ Inactivo</span>');
    const mustChangeBadge = u.must_change_password
      ? '<span class="ml-1 text-[10px] font-semibold text-amber-300 bg-amber-950/50 border border-amber-900/60 px-1 py-0.5 rounded">debe cambiar pass</span>'
      : '';
    const actionButtons = u.locked_at
      ? `<button data-action="unlock" data-id="${u.id}"
            class="text-xs bg-red-900/40 hover:bg-red-800/60 border border-red-700/60 text-red-100 px-2 py-1 rounded">Desbloquear</button>
         <button data-action="reset" data-id="${u.id}"
            class="text-xs bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-100 px-2 py-1 rounded ml-1">Reset pass</button>`
      : `<button data-action="edit" data-id="${u.id}"
            class="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2 py-1 rounded">Editar</button>
         <button data-action="reset" data-id="${u.id}"
            class="text-xs bg-amber-900/40 hover:bg-amber-800/60 border border-amber-700/60 text-amber-100 px-2 py-1 rounded ml-1">Reset pass</button>`;

    return `
      <tr class="${u.active ? '' : 'opacity-50'}">
        <td>
          ${escapeHtml(u.email)}
          ${isMe ? '<span class="ml-1 text-xs text-blue-300">(tú)</span>' : ''}
          ${mustChangeBadge}
        </td>
        <td class="text-slate-300">${escapeHtml(u.full_name)}</td>
        <td><span class="px-2 py-0.5 text-xs font-semibold rounded border ${roleBadge}">${escapeHtml(ROLE_LABEL[u.role] || u.role)}</span></td>
        <td>${statusCell}</td>
        <td class="text-xs text-slate-400 whitespace-nowrap">${lastLogin}</td>
        <td class="text-right whitespace-nowrap">${actionButtons}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    const id = parseInt(btn.dataset.id, 10);
    const action = btn.dataset.action;
    btn.addEventListener('click', () => {
      const u = allUsers.find(x => x.id === id);
      if (!u) return;
      if (action === 'edit')   openEditModal(u);
      if (action === 'reset')  confirmResetPassword(u);
      if (action === 'unlock') confirmUnlock(u);
    });
  });
}

function bindUsersToolbar() {
  document.getElementById('newUserBtn').addEventListener('click', openCreateModal);
  document.getElementById('usersSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return renderUsers(allUsers);
    const filtered = allUsers.filter(u =>
      u.email.toLowerCase().includes(q) ||
      u.full_name.toLowerCase().includes(q) ||
      u.role.includes(q)
    );
    renderUsers(filtered);
  });

  document.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', closeModals));
  ['userModal', 'passwordModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) closeModals(); });
  });

  document.getElementById('userForm').addEventListener('submit', handleSubmit);

  document.getElementById('copyPasswordBtn').addEventListener('click', () => {
    const code = document.getElementById('resetPassword').textContent;
    navigator.clipboard.writeText(code).then(() => {
      const btn = document.getElementById('copyPasswordBtn');
      const orig = btn.textContent;
      btn.textContent = 'Copiado';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });
}

function openCreateModal() {
  document.getElementById('userModalTitle').textContent = 'Nuevo usuario';
  document.getElementById('userId').value = '';
  document.getElementById('emailField').value = '';
  document.getElementById('nameField').value = '';
  document.getElementById('roleField').value = 'dispatcher';
  document.getElementById('passwordField').value = '';
  document.getElementById('passwordRow').classList.remove('hidden');
  document.getElementById('activeRow').classList.add('hidden');
  document.getElementById('userFormError').classList.add('hidden');
  document.getElementById('userModal').classList.remove('hidden');
  document.getElementById('emailField').focus();
}

function openEditModal(user) {
  document.getElementById('userModalTitle').textContent = `Editar: ${user.email}`;
  document.getElementById('userId').value = user.id;
  document.getElementById('emailField').value = user.email;
  document.getElementById('nameField').value = user.full_name;
  document.getElementById('roleField').value = user.role;
  document.getElementById('passwordField').value = '';
  document.getElementById('passwordRow').classList.add('hidden');
  document.getElementById('activeRow').classList.remove('hidden');
  document.getElementById('activeField').checked = !!user.active;
  document.getElementById('userFormError').classList.add('hidden');
  document.getElementById('userModal').classList.remove('hidden');
}

function closeModals() {
  document.getElementById('userModal').classList.add('hidden');
  document.getElementById('passwordModal').classList.add('hidden');
}

async function handleSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('userId').value;
  const isEdit = !!id;
  const submitBtn = document.getElementById('userFormSubmit');
  const errBox = document.getElementById('userFormError');
  errBox.classList.add('hidden');

  const body = {
    email: document.getElementById('emailField').value.trim(),
    full_name: document.getElementById('nameField').value.trim(),
    role: document.getElementById('roleField').value,
  };
  if (isEdit) {
    body.active = document.getElementById('activeField').checked;
  } else {
    body.password = document.getElementById('passwordField').value;
  }

  submitBtn.disabled = true;
  const origText = submitBtn.textContent;
  submitBtn.textContent = 'Guardando...';
  try {
    if (isEdit) {
      await window.BOTDOT.api(`/api/admin/users/${id}`, { method: 'PATCH', body });
    } else {
      await window.BOTDOT.api('/api/admin/users', { method: 'POST', body });
    }
    closeModals();
    await loadUsers();
  } catch (e) {
    errBox.textContent = e.message || 'Error guardando';
    errBox.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = origText;
  }
}

async function confirmResetPassword(user) {
  if (!confirm(`Resetear password de ${user.email}?\n\nSe genera una nueva, se muestra una sola vez, y el usuario tendrá que cambiarla en su primer login.`)) return;
  try {
    const data = await window.BOTDOT.api(`/api/admin/users/${user.id}/reset-password`, {
      method: 'POST', body: {},
    });
    document.getElementById('resetUserEmail').textContent = user.email;
    document.getElementById('resetPassword').textContent = data.password;
    document.getElementById('passwordModal').classList.remove('hidden');
    await loadUsers();
  } catch (e) {
    alert('Error reseteando password: ' + e.message);
  }
}

async function confirmUnlock(user) {
  if (!confirm(`Desbloquear cuenta de ${user.email}?\n\nLa cuenta volverá a poder iniciar sesión con su password actual.`)) return;
  try {
    await window.BOTDOT.api(`/api/admin/users/${user.id}/unlock`, { method: 'POST', body: {} });
    await loadUsers();
  } catch (e) {
    alert('Error desbloqueando: ' + e.message);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
