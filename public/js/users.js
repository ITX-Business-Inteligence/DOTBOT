// Admin UI: ABM de usuarios. Solo accesible si role=admin.
// Backend: /api/admin/users (gateado a admin via requireRole).

(async function init() {
  // Verificar sesion + rol
  let me;
  try {
    const r = await window.BOTDOT.api('/api/auth/me');
    me = r.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (me.role !== 'admin') {
    document.querySelector('main').innerHTML =
      '<div class="card text-center text-slate-300">Esta vista esta restringida al rol admin.</div>';
    return;
  }

  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  await loadUsers();
  bindToolbar();
})();

const ROLE_LABEL = {
  dispatcher: 'Dispatcher',
  supervisor: 'Supervisor',
  compliance: 'Compliance',
  manager: 'Manager',
  admin: 'Admin',
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
  // Necesitamos saber quienes somos para deshabilitar acciones sobre uno mismo
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
      if (action === 'edit') openEditModal(u);
      if (action === 'reset') confirmResetPassword(u);
      if (action === 'unlock') confirmUnlock(u);
    });
  });
}

async function confirmUnlock(user) {
  if (!confirm(`Desbloquear cuenta de ${user.email}?\n\nLa cuenta volvera a poder iniciar sesion con su password actual.`)) return;
  try {
    await window.BOTDOT.api(`/api/admin/users/${user.id}/unlock`, { method: 'POST', body: {} });
    await loadUsers();
  } catch (e) {
    alert('Error desbloqueando: ' + e.message);
  }
}

function bindToolbar() {
  document.getElementById('newUserBtn').addEventListener('click', openCreateModal);

  document.getElementById('searchInput').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return renderUsers(allUsers);
    const filtered = allUsers.filter(u =>
      u.email.toLowerCase().includes(q) ||
      u.full_name.toLowerCase().includes(q) ||
      u.role.includes(q)
    );
    renderUsers(filtered);
  });

  // Cerrar modales con X o "Cancelar"
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', closeModals);
  });
  // Cerrar haciendo click en el backdrop
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
  document.getElementById('passwordRow').classList.add('hidden'); // password se cambia con reset, no en edit
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
  if (!confirm(`Resetear password de ${user.email}? Se generara una nueva y se mostrara una sola vez.`)) return;
  try {
    const data = await window.BOTDOT.api(`/api/admin/users/${user.id}/reset-password`, {
      method: 'POST',
      body: {},
    });
    document.getElementById('resetUserEmail').textContent = user.email;
    document.getElementById('resetPassword').textContent = data.password;
    document.getElementById('passwordModal').classList.remove('hidden');
  } catch (e) {
    alert('Error reseteando password: ' + e.message);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
