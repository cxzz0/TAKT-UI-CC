'use strict';
(() => {
  const button = document.getElementById('btnSshSession');
  const dialog = document.getElementById('sshSessionDialog');
  const keyFile = document.getElementById('sshKeyFile');
  const passphrase = document.getElementById('sshKeyPassphrase');
  const error = document.getElementById('sshSessionError');
  const unlock = document.getElementById('sshSessionUnlock');
  let state;
  function render() {
    button.hidden = !state.enabled;
    button.textContent = state.unlocked ? 'SSH 已解锁' : 'SSH 已锁定';
    button.title = state.unlocked ? '本次运行已解锁；点击可添加其他私钥' : '解锁本次运行的 SSH 私钥';
    document.getElementById('sshSessionKeys').textContent = (state.keys || []).map(key => key.name + ' · ' + key.fingerprint).join('\n');
    if (!keyFile.value) keyFile.value = state.defaultKey || '';
  }
  function open() {
    error.textContent = '';
    passphrase.value = '';
    dialog.showModal();
    (keyFile.value ? passphrase : keyFile).focus();
  }
  button.addEventListener('click', open);
  dialog.addEventListener('close', () => { passphrase.value = ''; });
  window.addEventListener('pagehide', () => { passphrase.value = ''; });
  document.getElementById('sshSessionCancel').addEventListener('click', () => dialog.close());
  document.getElementById('sshSessionForm').addEventListener('submit', async event => {
    event.preventDefault();
    unlock.disabled = true;
    error.textContent = '';
    const body = JSON.stringify({ keyFile: keyFile.value.trim(), passphrase: passphrase.value });
    passphrase.value = '';
    try {
      const response = await fetch('/api/ssh-session/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Takt-SSH-Session': state.csrfToken }, body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '解锁失败，请重试');
      state = { ...state, ...result };
      render();
      dialog.close();
    } catch (e) {
      error.textContent = e.message;
      passphrase.focus();
    } finally { unlock.disabled = false; }
  });
  fetch('/api/ssh-session', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('无法读取 SSH 解锁状态');
    state = await response.json();
    render();
    if (state.enabled && !state.unlocked) open();
  }).catch(() => { button.hidden = false; button.textContent = 'SSH 状态不可用'; button.disabled = true; });
})();
