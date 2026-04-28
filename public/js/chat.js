// Chat: envio de mensajes al agente, render de respuestas, atajos.

(function() {
  let conversationId = null;
  const chatLog = document.getElementById('chatLog');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');

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

  // Atajos
  document.querySelectorAll('.quick-prompt[data-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.prompt;
      input.focus();
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 128) + 'px';
      // Cerrar sidebar en mobile
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
    if (!text) return;

    appendMessage('user', text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    const typingNode = appendTyping();

    try {
      const data = await window.BOTDOT.api('/api/chat/send', {
        method: 'POST',
        body: { conversation_id: conversationId, message: text },
      });
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
