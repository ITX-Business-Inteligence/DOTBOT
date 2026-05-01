// Registro del Service Worker + manejo de updates.
// Se incluye en todos los HTML. Es seguro: si el browser no soporta SW,
// hace nada y sale.

(function () {
  if (!('serviceWorker' in navigator)) return;

  // Service workers funcionan en https o en localhost / 127.0.0.1.
  // En http puro (LAN sin TLS) los browsers los rechazan.
  const isSecure = location.protocol === 'https:' ||
                   location.hostname === 'localhost' ||
                   location.hostname === '127.0.0.1';
  if (!isSecure) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        // Cuando el browser detecta una nueva version del SW, reg.installing
        // se activa. Esperamos a que llegue a 'installed' con un controller
        // existente — eso significa que hay un SW viejo activo y un nuevo
        // listo para tomar el control.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(reg);
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[pwa] SW register failed:', err);
      });

    // Cuando el SW activo cambia, recarga para que la pagina use la version nueva.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });

  function showUpdateToast(reg) {
    // Si ya hay un toast, no duplicar.
    if (document.getElementById('pwa-update-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'pwa-update-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9999',
      'background:#1e293b', 'color:#f1f5f9',
      'border:1px solid #334155', 'border-radius:8px',
      'padding:12px 16px', 'box-shadow:0 10px 25px rgba(0,0,0,.4)',
      'font-family:system-ui,sans-serif', 'font-size:14px',
      'max-width:320px', 'display:flex', 'gap:12px', 'align-items:center',
    ].join(';');
    toast.innerHTML = `
      <span style="flex:1">Hay una version nueva de BOTDOT lista.</span>
      <button id="pwa-update-btn" style="background:#0ea5e9;color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600">Actualizar</button>
      <button id="pwa-dismiss-btn" style="background:transparent;color:#94a3b8;border:0;cursor:pointer;font-size:18px;line-height:1">&times;</button>
    `;
    document.body.appendChild(toast);
    document.getElementById('pwa-update-btn').addEventListener('click', () => {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      toast.remove();
    });
    document.getElementById('pwa-dismiss-btn').addEventListener('click', () => {
      toast.remove();
    });
  }
})();
