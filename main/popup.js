/**
 * MyBooks Browser Extension – Popup Script
 *
 * Supports: Chrome / Edge (Manifest V3)
 * APIs used:
 *   GET  /api/user/info        – fetch server info & login status
 *   POST /api/user/sign_in     – login (URL-encoded form data)
 *   POST /api/book/upload      – upload a book file (multipart)
 */

'use strict';

const ALLOWED_EXT = new Set(['epub', 'azw3', 'mobi', 'pdf', 'docx']);
const FETCH_TIMEOUT_MS = 12000;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const serverTitleEl   = document.getElementById('serverTitle');
const statusBadgeEl   = document.getElementById('statusBadge');
const refreshBtn      = document.getElementById('refreshBtn');
const configToggle    = document.getElementById('configToggle');
const configBody      = document.getElementById('configBody');
const toggleIcon      = document.getElementById('toggleIcon');
const serverHostInput = document.getElementById('serverHost');
const usernameInput   = document.getElementById('username');
const passwordInput   = document.getElementById('password');
const loginBtn        = document.getElementById('loginBtn');
const loginMsgEl      = document.getElementById('loginMsg');
const dropZone        = document.getElementById('dropZone');
const dropContent     = document.getElementById('dropContent');
const uploadProgress  = document.getElementById('uploadProgress');
const uploadMsgEl     = document.getElementById('uploadMsg');
const fileInput       = document.getElementById('fileInput');

// ── Config state ──────────────────────────────────────────────────────────────

let cfg = { serverHost: '', username: '', password: '' };

function loadConfig() {
  chrome.storage.local.get(['serverHost', 'username', 'password'], (stored) => {
    cfg.serverHost = stored.serverHost || '';
    cfg.username   = stored.username   || '';
    cfg.password   = stored.password   || '';

    serverHostInput.value = cfg.serverHost;
    usernameInput.value   = cfg.username;
    passwordInput.value   = cfg.password;

    if (cfg.serverHost) {
      expandConfig(false);   // already configured → collapse by default
      refreshStatus();
    } else {
      setStatus('unconfigured', '未配置');
      expandConfig(true);    // not yet configured → expand so user can fill in
    }
  });
}

function saveConfig() {
  cfg.serverHost = serverHostInput.value.trim().replace(/\/+$/, '');
  cfg.username   = usernameInput.value.trim();
  cfg.password   = passwordInput.value;

  // Sync back trimmed value to input
  serverHostInput.value = cfg.serverHost;

  chrome.storage.local.set({
    serverHost: cfg.serverHost,
    username:   cfg.username,
    password:   cfg.password,
  });
}

// ── Status helpers ────────────────────────────────────────────────────────────

function setStatus(type, text) {
  statusBadgeEl.className = `badge badge-${type}`;
  statusBadgeEl.textContent = text;
}

// ── Refresh server status ─────────────────────────────────────────────────────

async function refreshStatus() {
  if (!cfg.serverHost) {
    setStatus('unconfigured', '未配置');
    return;
  }

  setStatus('loading', '连接中…');
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');

  try {
    const res = await fetchWithTimeout(`${cfg.serverHost}/api/user/info`);
    if (!res.ok) {
      setStatus('error', '连接失败');
      serverTitleEl.textContent = 'MyBooks';
      return;
    }

    const data = await res.json();
    if (data.err === 'ok' && data.sys) {
      const title   = data.sys.title   || 'MyBooks';
      const version = data.sys.version || '';
      serverTitleEl.textContent = title;
      setStatus('ok', version || '已连接');
    } else {
      setStatus('error', '连接失败');
    }
  } catch {
    setStatus('error', '连接失败');
    serverTitleEl.textContent = 'MyBooks';
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login() {
  saveConfig();

  if (!cfg.serverHost) {
    showMsg(loginMsgEl, 'error', '请先填写服务器地址');
    return;
  }

  loginBtn.disabled = true;
  showMsg(loginMsgEl, '', '');

  try {
    const body = new URLSearchParams();
    body.append('username', cfg.username);
    body.append('password', cfg.password);

    const res = await fetchWithTimeout(`${cfg.serverHost}/api/user/sign_in`, {
      method:      'POST',
      body,
      credentials: 'include',
    });

    const data = await res.json();
    if (data.err === 'ok') {
      showMsg(loginMsgEl, 'success', '登录成功');
      expandConfig(false);   // login succeeded → collapse config panel
      refreshStatus();
    } else {
      showMsg(loginMsgEl, 'error', data.msg || '登录失败');
    }
  } catch (err) {
    showMsg(loginMsgEl, 'error', `登录失败：${err.message}`);
  } finally {
    loginBtn.disabled = false;
  }
}

// ── File upload ───────────────────────────────────────────────────────────────

async function uploadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    showMsg(uploadMsgEl, 'error', `不支持 .${ext} 格式，仅支持 epub / azw3 / mobi / pdf / docx`);
    return;
  }

  if (!cfg.serverHost) {
    showMsg(uploadMsgEl, 'error', '请先配置服务器地址并登录');
    return;
  }

  dropContent.classList.add('hidden');
  uploadProgress.classList.remove('hidden');
  showMsg(uploadMsgEl, '', '');

  try {
    const form = new FormData();
    form.append('ebook', file);

    // Upload without timeout so large files aren't aborted
    const res = await fetch(`${cfg.serverHost}/api/book/upload`, {
      method:      'POST',
      body:        form,
      credentials: 'include',
    });

    const data = await res.json();
    if (data.err === 'ok') {
      const bookUrl = `${cfg.serverHost}/book/${data.book_id}`;
      showMsg(uploadMsgEl, 'success', '');
      uploadMsgEl.innerHTML =
        `上传成功！<a href="${bookUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">书籍 #${data.book_id}</a>`;
    } else {
      showMsg(uploadMsgEl, 'error', data.msg || '上传失败');
    }
  } catch (err) {
    showMsg(uploadMsgEl, 'error', `上传失败：${err.message}`);
  } finally {
    dropContent.classList.remove('hidden');
    uploadProgress.classList.add('hidden');
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function showMsg(el, type, text) {
  el.className = type ? `${el.id === 'loginMsg' ? 'inline-msg' : 'upload-msg'} ${type}` :
                        (el.id === 'loginMsg' ? 'inline-msg' : 'upload-msg');
  el.textContent = text;
}

// ── Config panel toggle ───────────────────────────────────────────────────────

function expandConfig(open) {
  if (open) {
    configBody.classList.remove('hidden');
    configToggle.classList.remove('collapsed');
  } else {
    configBody.classList.add('hidden');
    configToggle.classList.add('collapsed');
  }
}

configToggle.addEventListener('click', () => {
  const isOpen = !configBody.classList.contains('hidden');
  expandConfig(!isOpen);
});

// ── Event listeners ───────────────────────────────────────────────────────────

// Save config when user moves focus away from an input
[serverHostInput, usernameInput, passwordInput].forEach((el) => {
  el.addEventListener('blur', saveConfig);
});

refreshBtn.addEventListener('click', () => {
  saveConfig();
  refreshStatus();
});

loginBtn.addEventListener('click', login);

// Enter key in password field triggers login
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

// ── Drag & drop ───────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  // Only remove class when actually leaving the drop zone (not child elements)
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    uploadFile(files[0]);
  }
});

// Click to open native file picker
dropZone.addEventListener('click', () => {
  fileInput.click();
});

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    uploadFile(fileInput.files[0]);
    // Reset so the same file can be re-selected
    fileInput.value = '';
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadConfig();
