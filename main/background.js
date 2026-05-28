/**
 * MyBooks Browser Extension – Background Service Worker
 *
 * Responsibilities:
 *  - Register the "搜索书库同名图书" context menu item (on text selection)
 *  - Handle context menu clicks: fetch search results from the MyBooks API
 *    (background fetch bypasses page-level CORS restrictions)
 *  - Forward results to the active tab's content script for display
 */

'use strict';

// ── Context menu registration ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Remove any stale items before creating to avoid duplicate errors on reload
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mybooks-search',
      title: '【MyBooks】搜索书库同名图书',
      contexts: ['selection'],
    });
  });
});

// ── Context menu click handler ────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'mybooks-search') return;

  const text = (info.selectionText || '').trim().slice(0, 100);
  if (!text || !tab?.id) return;

  // Immediately tell content script to show loading overlay
  safeSend(tab.id, { type: 'mybooks-search-start', text });

  // Resolve server host from storage
  const { serverHost } = await chrome.storage.local.get(['serverHost']);
  if (!serverHost) {
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

    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    safeSend(tab.id, {
      type: 'mybooks-search-result',
      text,
      data,
      host: serverHost,
    });
  } catch (err) {
    safeSend(tab.id, {
      type: 'mybooks-search-result',
      text,
      error: `连接失败：${err.message}`,
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a message to a tab, silently swallowing errors (e.g. tab closed). */
function safeSend(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}
