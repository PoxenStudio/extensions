/**
 * MyBooks Browser Extension – Background Service Worker
 *
 * Responsibilities:
 *  - Register the "搜索书库同名图书" context menu item (on text selection)
 *  - Enable/disable the menu item based on whether serverHost is configured
 *  - Handle context menu clicks: fetch search results from the MyBooks API
 *    (background fetch bypasses page-level CORS restrictions)
 *  - Forward results to the active tab's content script for display
 */

'use strict';

const LOG_PREFIX = '[MyBooks BG]';

function log(...args)  { console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }
function err(...args)  { console.error(LOG_PREFIX, ...args); }

// ── Context menu registration ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  log('onInstalled: registering context menu');
  // Remove any stale items before creating to avoid duplicate errors on reload
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mybooks-search',
      title: '[MyBooks]搜索书库同名图书',
      contexts: ['selection'],
    });
    log('Context menu item created');
  });

  // Set initial enabled state based on current config
  const { serverHost } = await chrome.storage.local.get(['serverHost']);
  updateMenuEnabled(!!serverHost);
});

// Sync enabled state whenever storage changes (e.g. user saves config in popup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('serverHost' in changes)) return;
  const configured = !!(changes.serverHost.newValue || '').trim();
  log(`serverHost changed → menu ${configured ? 'enabled' : 'disabled'}`);
  updateMenuEnabled(configured);
});

/** Enable or disable the context menu item. */
function updateMenuEnabled(enabled) {
  chrome.contextMenus.update('mybooks-search', { enabled }, () => {
    if (chrome.runtime.lastError) {
      // Item may not exist yet on very first install; safe to ignore
      warn('contextMenus.update:', chrome.runtime.lastError.message);
    }
  });
}

// ── On-demand content script injection ──────────────────────────────────────

/**
 * Ensures the content script is active in the given tab.
 * Pings first; if no response, injects content.js + content.css via scripting API.
 */
async function ensureContentScript(tabId) {
  // Try pinging the existing content script
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'mybooks-ping' });
    log('Content script already active in tab', tabId);
    return true;
  } catch {
    log('Content script not found, injecting into tab', tabId);
  }

  // Inject dynamically (handles tabs opened before the extension loaded)
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    log('Content script injected successfully into tab', tabId);
    return true;
  } catch (e) {
    err('Failed to inject content script:', e.message);
    return false;
  }
}

// ── Context menu click handler ────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'mybooks-search') return;

  const text = (info.selectionText || '').trim().slice(0, 100);
  log(`Context menu clicked, selected text: "${text}", tabId: ${tab?.id}`);

  if (!text || !tab?.id) {
    warn('Ignoring click: empty text or missing tab');
    return;
  }

  // Guarantee the content script is running before sending any message
  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    err('Cannot show results: content script could not be injected into tab', tab.id);
    return;
  }

  // Tell content script to show loading overlay
  log('Sending search-start to tab', tab.id);
  safeSend(tab.id, { type: 'mybooks-search-start', text });

  // Resolve server host from storage
  const { serverHost } = await chrome.storage.local.get(['serverHost']);
  log('Resolved serverHost:', serverHost || '(not set)');

  if (!serverHost) {
    warn('serverHost not configured, aborting search');
    safeSend(tab.id, {
      type: 'mybooks-search-result',
      text,
      error: '未配置 MyBooks 服务器，请先在扩展弹窗中配置服务器地址。',
    });
    return;
  }

  // Fetch search results from background (no CORS restrictions for host_permissions)
  try {
    const url = new URL(`${serverHost}/api/search`);
    url.searchParams.set('name', `title:${text}`);
    url.searchParams.set('size', '5');
    log('Fetching:', url.toString());

    const res = await fetch(url.toString(), { credentials: 'include' });
    log('Response status:', res.status);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    log('Search result: err=%s, total=%s', data.err, data.total);

    safeSend(tab.id, {
      type: 'mybooks-search-result',
      text,
      data,
      host: serverHost,
    });
  } catch (e) {
    err('Search fetch failed:', e);
    safeSend(tab.id, {
      type: 'mybooks-search-result',
      text,
      error: `连接失败：${e.message}`,
    });
  }
});

// ── Image proxy (for content script covers) ─────────────────────────────────────

/**
 * The content script requests cover images via this handler so that the
 * fetch runs in the background (bypassing the host page's CSP) and the
 * result is returned as a data: URL safe to assign to <img>.src.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'mybooks-fetch-image') return false;
  log('Image proxy fetch:', msg.url);
  fetch(msg.url, { credentials: 'include' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then(
      (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        }),
    )
    .then((dataUrl) => sendResponse({ dataUrl }))
    .catch((e) => {
      warn('Image proxy failed:', e.message);
      sendResponse({ error: e.message });
    });
  return true; // keep message channel open for async sendResponse
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a message to a tab, silently swallowing errors (e.g. tab closed). */
function safeSend(tabId, msg) {
  log('safeSend to tab', tabId, msg.type);
  chrome.tabs.sendMessage(tabId, msg).catch((e) => {
    warn('tabs.sendMessage failed (tab may have no content script):', e.message);
  });
}
