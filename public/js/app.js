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

  document.getElementById('userName').textContent = user.name;
  document.getElementById('userRole').textContent = roleLabel(user.role);
  window.BOTDOT.user = user;

  // Audit y Analytics visibles solo para compliance/manager/admin
  if (['compliance', 'manager', 'admin'].includes(user.role)) {
    const audit = document.getElementById('auditSection');
    if (audit) audit.classList.remove('hidden');
    const aLink = document.getElementById('analyticsLink');
    if (aLink) aLink.classList.remove('hidden');
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

  // Auto-cargar dashboard
  if (window.BOTDOT.loadDashboard) window.BOTDOT.loadDashboard();
})();

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
