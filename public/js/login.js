// Flujo de login. Externalizado de index.html para que la CSP pueda
// quitar 'unsafe-inline' de scriptSrc.

(async function checkExistingSession() {
  // Si ya hay sesion, redirigir a app.
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) location.href = '/app.html';
  } catch (e) {}
})();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const err = document.getElementById('errorBox');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Validando...';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error de autenticacion');
    // Si admin reseteo la pass, forzar el change antes de cualquier otra cosa.
    location.href = data.must_change_password ? '/change-password.html' : '/app.html';
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});
