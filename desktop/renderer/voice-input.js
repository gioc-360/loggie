export function attachVoiceInput({ button, input, status, start, stop, subscribe }) {
  let active = false;
  let prefix = '', suffix = '';
  const display = message => { status.hidden = false; status.textContent = message; };
  const reset = () => { active = false; button.disabled = input.disabled; button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Dictate a request'); button.title = 'Dictate a request with Mac Dictation'; };
  subscribe(update => {
    if (typeof update.text === 'string') { input.value = prefix + update.text + suffix; input.dispatchEvent(new Event('input', { bubbles: true })); }
    if (update.error) { display(update.error); reset(); }
    else if (update.status === 'listening') { display('Listening… Click the mic again to finish. Review the text before sending.'); }
    else if (update.status === 'stopped' && active) { display('Voice input finished. Review your request, then press Send.'); reset(); }
  });
  button.addEventListener('click', async () => {
    if (input.disabled) return;
    if (active) { await stop(); return; }
    input.focus();
    prefix = input.value.slice(0, input.selectionStart); suffix = input.value.slice(input.selectionEnd);
    active = true; button.setAttribute('aria-pressed', 'true'); button.setAttribute('aria-label', 'Stop voice input'); button.title = 'Stop voice input';
    display('Requesting Microphone and Speech Recognition access…');
    try { const result = await start(); if (!result?.ok) throw new Error(result?.error || 'Voice input could not start.'); }
    catch (error) { display(error.message); reset(); }
  });
  new MutationObserver(() => { button.disabled = input.disabled; }).observe(input, { attributes: true, attributeFilter: ['disabled'] });
}
