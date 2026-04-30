// Inicializacion principal del SPA: auth, header, sidebar mobile, logout.

(async function init() {
  // Cargar /js/auth.js helpers (en caso de que este js cargue primero)
  if (!window.BOTDOT) {
    await new Promise((r) => {
      const s = document.createElement('script');
      s.src = '/js/auth.js'; s.onload = r; document.head.appendChild(s);
    });
  }

  // Verificar sesion
  let user;
  try {
    const me = await window.BOTDOT.api('/api/auth/me');
    user = me.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  // Si admin reseteo la pass, no dejarlo entrar a la app hasta que cambie.
  if (user.must_change_password) {
    location.href = '/change-password.html';
    return;
  }

  document.getElementById('userName').textContent = user.name;
  document.getElementById('userRole').textContent = roleLabel(user.role);
  window.BOTDOT.user = user;

  // KPIs ejecutivos / BASICs scores se movieron a /analytics.html.
  // En la sidebar quedan: Drivers en riesgo (todos los roles), Atajos
  // (todos los roles), Auditoria (solo management).
  const isManagement = ['compliance', 'manager', 'admin'].includes(user.role);
  if (isManagement) {
    const audit = document.getElementById('auditSection');
    if (audit) audit.classList.remove('hidden');
    const aLink = document.getElementById('analyticsLink');
    if (aLink) aLink.classList.remove('hidden');
  }

  // Settings (siempre visible — todos los roles tienen Mi cuenta).
  // La tab Usuarios dentro de Settings se gatea sola al ver el rol.

  // Gestion de drivers — admin o compliance
  if (['admin', 'compliance'].includes(user.role)) {
    const dLink = document.getElementById('driversLink');
    if (dLink) dLink.classList.remove('hidden');
  }

  // Escalaciones — compliance / manager / admin
  if (['admin', 'compliance', 'manager'].includes(user.role)) {
    const eLink = document.getElementById('escalationsLink');
    if (eLink) {
      eLink.classList.remove('hidden');
      pollEscalationsBadge();
      setInterval(pollEscalationsBadge, 30000);
    }
    const nLink = document.getElementById('notificationsLink');
    if (nLink) {
      nLink.classList.remove('hidden');
      pollNotificationsBadge();
      setInterval(pollNotificationsBadge, 30000);
    }
  }

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', () => window.BOTDOT.logout());

  // Sidebar mobile toggle
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('backdrop');
  document.getElementById('menuBtn').addEventListener('click', () => {
    sidebar.classList.toggle('-translate-x-full');
    sidebar.classList.toggle('translate-x-0');
    backdrop.classList.toggle('hidden');
  });
  backdrop.addEventListener('click', () => {
    sidebar.classList.add('-translate-x-full');
    sidebar.classList.remove('translate-x-0');
    backdrop.classList.add('hidden');
  });

  // Cargar widgets de la sidebar (drivers en riesgo, etc.) — todos los
  // roles. El handler de loadDashboard se encarga de gating interno si
  // alguno de sus widgets es solo-management.
  if (window.BOTDOT.loadDashboard) window.BOTDOT.loadDashboard();
})();

async function pollEscalationsBadge() {
  try {
    const data = await window.BOTDOT.api('/api/escalations/badge-count');
    const badge = document.getElementById('escalationsBadge');
    if (!badge) return;
    if (data.count > 0) {
      badge.textContent = data.count > 99 ? '99+' : data.count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) { /* silencio en error transient */ }
}

async function pollNotificationsBadge() {
  try {
    const data = await window.BOTDOT.api('/api/notifications/badge-count');
    const badge = document.getElementById('notificationsBadge');
    if (!badge) return;
    if (data.count > 0) {
      badge.textContent = data.count > 99 ? '99+' : data.count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) { /* silencio */ }
}

function roleLabel(role) {
  const map = {
    dispatcher: 'Dispatcher',
    supervisor: 'Supervisor',
    compliance: 'Compliance',
    manager: 'Manager',
    admin: 'Admin',
  };
  return map[role] || role;
}
