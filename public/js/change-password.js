// Flujo de cambio de password. Externalizado de change-password.html
// para que la CSP pueda quitar 'unsafe-inline' de scriptSrc.

(async function init() {
  // Verificar sesion. Si must_change_password=true mostramos la nota.
  let me;
  try {
    const r = await window.BOTDOT.api('/api/auth/me');
    me = r.user;
  } catch (e) {
    location.href = '/index.html';
    return;
  }
  if (me.must_change_password) {
    document.getElementById('forcedNote').classList.remove('hidden');
    document.getElementById('backLink').classList.add('hidden');
  }
})();

document.getElementById('changeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = document.getElementById('currentPass').value;
  const n1 = document.getElementById('newPass').value;
  const n2 = document.getElementById('newPass2').value;
  const errBox = document.getElementById('errorBox');
  const okBox = document.getElementById('successBox');
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
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await window.BOTDOT.api('/api/auth/change-password', {
      method: 'POST',
      body: { current_password: cur, new_password: n1 },
    });
    okBox.textContent = 'Contraseña cambiada. Redirigiendo al chat...';
    okBox.classList.remove('hidden');
    setTimeout(() => location.href = '/app.html', 1200);
  } catch (e) {
    errBox.textContent = e.message || 'Error cambiando password';
    errBox.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Cambiar contraseña';
  }
});
