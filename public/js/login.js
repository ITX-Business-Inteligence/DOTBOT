// Flujo de login. Externalizado de index.html para que la CSP pueda
// quitar 'unsafe-inline' de scriptSrc.

// ─── Boot intro animation lifecycle ────────────────────────────
// Se muestra una vez por session (sessionStorage). Skip on click. URL param
// ?nointro lo desactiva. La animacion CSS auto-fade dura ~2.5s.
(function bootIntro() {
  const intro = document.getElementById('bootIntro');
  if (!intro) return;
  const skip =
    sessionStorage.getItem('bootIntroShown') === '1' ||
    location.search.includes('nointro');
  if (skip) {
    intro.style.display = 'none';
    return;
  }
  sessionStorage.setItem('bootIntroShown', '1');
  // Click salta directo
  intro.addEventListener('click', () => {
    intro.style.transition = 'opacity 0.25s ease';
    intro.style.opacity = '0';
    setTimeout(() => { intro.style.display = 'none'; }, 250);
  }, { once: true });
  // Cleanup despues del fade auto (animation ends ~2.9s)
  setTimeout(() => { intro.style.display = 'none'; }, 3000);
})();

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
