// Chat: envio de mensajes al agente, adjuntos (paste/drag/picker), render
// de respuestas, atajos.

(function() {
  let conversationId = null;
  let pendingAttachments = []; // [{ file, previewUrl }]

  // Limites alineados con src/utils/attachments.js. Validacion final en
  // el backend; esto es solo UX.
  const MAX_FILES = 5;
  const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
  const MAX_BYTES_TOTAL = 20 * 1024 * 1024;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  const chatLog = document.getElementById('chatLog');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachBtn = document.getElementById('attachBtn');
  const fileInput = document.getElementById('fileInput');
  const previews = document.getElementById('attachmentPreviews');
  const composerWrap = document.getElementById('composerWrap');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  });

  // Submit con Enter (Shift+Enter = nueva linea)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Paste de imagen: Ctrl+V con imagen en clipboard
  input.addEventListener('paste', (e) => {
    const items = (e.clipboardData || {}).items || [];
    const imgs = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      addAttachments(imgs);
    }
  });

  // File picker
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addAttachments(Array.from(fileInput.files || []));
    fileInput.value = ''; // reset para que se pueda re-elegir el mismo
  });

  // Drag & drop sobre todo el composer
  ['dragenter', 'dragover'].forEach(ev => {
    composerWrap.addEventListener(ev, (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      composerWrap.classList.add('ring-2', 'ring-blue-500');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    composerWrap.addEventListener(ev, (e) => {
      composerWrap.classList.remove('ring-2', 'ring-blue-500');
    });
  });
  composerWrap.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addAttachments(Array.from(e.dataTransfer.files));
  });

  function addAttachments(files) {
    const errors = [];
    for (const f of files) {
      if (pendingAttachments.length >= MAX_FILES) {
        errors.push(`Maximo ${MAX_FILES} imagenes por mensaje.`);
        break;
      }
      if (!ALLOWED.includes(f.type)) {
        errors.push(`"${f.name || 'sin-nombre'}" no es JPEG/PNG/WEBP/GIF.`);
        continue;
      }
      if (f.size > MAX_BYTES_PER_FILE) {
        errors.push(`"${f.name || 'sin-nombre'}" pesa ${Math.round(f.size/1024)}KB (max ${MAX_BYTES_PER_FILE/1024/1024}MB).`);
        continue;
      }
      const total = pendingAttachments.reduce((s, a) => s + a.file.size, 0) + f.size;
      if (total > MAX_BYTES_TOTAL) {
        errors.push(`Suma total excede ${MAX_BYTES_TOTAL/1024/1024}MB.`);
        break;
      }
      const previewUrl = URL.createObjectURL(f);
      pendingAttachments.push({ file: f, previewUrl });
    }
    if (errors.length) appendToolNote('⚠ ' + errors.join(' '));
    renderPreviews();
  }

  function removeAttachment(idx) {
    const [removed] = pendingAttachments.splice(idx, 1);
    if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    renderPreviews();
  }

  function renderPreviews() {
    if (!pendingAttachments.length) {
      previews.classList.add('hidden');
      previews.innerHTML = '';
      return;
    }
    previews.classList.remove('hidden');
    previews.innerHTML = pendingAttachments.map((a, i) => `
      <div class="relative group">
        <img src="${a.previewUrl}" alt="" class="w-16 h-16 object-cover rounded-lg border border-slate-700">
        <button type="button" data-idx="${i}"
          class="att-remove absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 hover:bg-red-500 text-white text-xs flex items-center justify-center shadow"
          title="Quitar">✕</button>
        <div class="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-slate-100 px-1 py-0.5 rounded-b-lg truncate">
          ${Math.round(a.file.size/1024)}KB
        </div>
      </div>
    `).join('');
    previews.querySelectorAll('.att-remove').forEach(btn => {
      btn.addEventListener('click', () => removeAttachment(parseInt(btn.dataset.idx, 10)));
    });
  }

  function clearAttachments() {
    for (const a of pendingAttachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    pendingAttachments = [];
    renderPreviews();
  }

  // Atajos del sidebar
  document.querySelectorAll('.quick-prompt[data-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.prompt;
      input.focus();
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 128) + 'px';
      const sidebar = document.getElementById('sidebar');
      if (window.innerWidth < 1024 && sidebar) {
        sidebar.classList.add('-translate-x-full');
        sidebar.classList.remove('translate-x-0');
        document.getElementById('backdrop').classList.add('hidden');
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !pendingAttachments.length) return;

    // Render del user turn (texto + thumbs) en el chat log
    appendUserMessage(text, pendingAttachments.map(a => a.previewUrl));

    // Snapshot de attachments antes de limpiar (para upload)
    const filesToUpload = pendingAttachments.map(a => a.file);
    // Capturamos previewUrls para no revokearlas hasta que el chat
    // las haya renderizado; la siguiente linea reemplaza pendingAttachments
    // sin liberar las URLs ya consumidas.
    pendingAttachments = [];
    renderPreviews();

    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    const typingNode = appendTyping();

    try {
      const fd = new FormData();
      if (conversationId) fd.append('conversation_id', conversationId);
      fd.append('message', text);
      for (const f of filesToUpload) fd.append('files', f, f.name || 'screenshot.png');

      const res = await fetch('/api/chat/send', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      });
      if (res.status === 401) { location.href = '/index.html'; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      conversationId = data.conversation_id;
      typingNode.remove();
      if (data.tool_calls && data.tool_calls.length) {
        const toolsNote = data.tool_calls.map(t => t.name).join(', ');
        appendToolNote(`Consultó: ${toolsNote}`);
      }
      appendMessage('assistant', data.reply || '(respuesta vacia)');
    } catch (err) {
      typingNode.remove();
      appendMessage('assistant', `❌ Error: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });

  function appendUserMessage(text, previewUrls) {
    const wrap = document.createElement('div');
    wrap.className = 'max-w-3xl mx-auto flex justify-end';
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-user flex flex-col gap-2 items-end';
    if (previewUrls && previewUrls.length) {
      const grid = document.createElement('div');
      grid.className = 'flex flex-wrap gap-1.5 justify-end';
      grid.innerHTML = previewUrls.map(u => `
        <img src="${u}" alt="" class="w-24 h-24 object-cover rounded-lg border border-blue-300/30">
      `).join('');
      bubble.appendChild(grid);
    }
    if (text) {
      const t = document.createElement('div');
      t.innerHTML = formatMessage(text);
      bubble.appendChild(t);
    }
    wrap.appendChild(bubble);
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = 'max-w-3xl mx-auto flex ' + (role === 'user' ? 'justify-end' : 'justify-start');
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-assistant');
    bubble.innerHTML = formatMessage(text);
    wrap.appendChild(bubble);
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendToolNote(text) {
    const note = document.createElement('div');
    note.className = 'max-w-3xl mx-auto msg-tool';
    note.innerHTML = `🔧 ${escapeHtml(text)}`;
    chatLog.appendChild(note);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'max-w-3xl mx-auto flex justify-start';
    wrap.innerHTML = `
      <div class="msg msg-assistant">
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>`;
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
    return wrap;
  }

  // Markdown muy simple (negritas, codigo inline, saltos de linea)
  function formatMessage(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
