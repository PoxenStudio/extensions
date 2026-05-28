/**
 * MyBooks Browser Extension – Content Script
 *
 * Listens for search requests from the background service worker and renders
 * a floating result overlay directly on the host page.
 *
 * All DOM IDs and class names are prefixed with "mybooks-ext-" to avoid
 * conflicts with host-page styles.
 */

'use strict';

(function () {
  // Guard against double-injection (e.g. dynamic page navigation)
  if (window.__mybooksExtInjected) return;
  window.__mybooksExtInjected = true;

  const NS = 'mybooks-ext';

  let overlayEl  = null;   // current overlay element
  let lastClientX = 20;    // last selection end X (viewport-relative)
  let lastClientY = 20;    // last selection end Y (viewport-relative)

  // ── Track where the user's selection ended ──────────────────────────────────

  document.addEventListener('mouseup', (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
  });

  // ── Message handler ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Ping: lets background.js detect whether this script is already injected
    if (msg.type === 'mybooks-ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'mybooks-search-start') {
      showOverlay(msg.text, null, '搜索中…');
    } else if (msg.type === 'mybooks-search-result') {
      if (msg.error) {
        setListContent(null, msg.error);
      } else {
        const books = ((msg.data && msg.data.books) || []).slice(0, 30);
        if (overlayEl) overlayEl.dataset.host = msg.host || '';
        setListContent(
          books.length > 0 ? books : null,
          books.length === 0 ? '未找到相关图书' : null,
          msg.host,
        );
      }
    }
  });

  // ── Overlay lifecycle ────────────────────────────────────────────────────────

  function showOverlay(text, books, statusMsg) {
    removeOverlay();

    const el = document.createElement('div');
    el.id     = `${NS}-overlay`;
    el.dataset.host = '';

    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;

    el.innerHTML = `
      <div class="${NS}-header">
        <span class="${NS}-label">MyBooks 书库搜索</span>
        <button class="${NS}-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="${NS}-query" title="${escAttr(text)}">"${escHtml(preview)}"</div>
      <div class="${NS}-list">
        ${buildListHTML(books, statusMsg, '')}
      </div>
    `;

    document.body.appendChild(el);
    overlayEl = el;

    positionOverlay(el);

    // Close button
    el.querySelector(`.${NS}-close-btn`).addEventListener('click', (e) => {
      e.stopPropagation();
      removeOverlay();
    });

    // Dismiss on outside click / Escape (deferred so current event doesn't fire)
    requestAnimationFrame(() => {
      document.addEventListener('click',   onOutsideClick, { capture: true });
      document.addEventListener('keydown', onEscKey);
    });
  }

  /** Replace the list area content (called when results arrive). */
  function setListContent(books, msg, host) {
    if (!overlayEl) return;
    const listEl = overlayEl.querySelector(`.${NS}-list`);
    if (!listEl) return;
    const effectiveHost = host || overlayEl.dataset.host || '';
    listEl.innerHTML = buildListHTML(books, msg, effectiveHost);
    // Proxy cover images through the background SW to avoid page CSP restrictions
    loadCovers(listEl);
    // Re-position now that the overlay has its final height
    positionOverlay(overlayEl);
  }

  function buildListHTML(books, msg, host) {
    if (msg) {
      return `<div class="${NS}-msg">${escHtml(msg)}</div>`;
    }
    if (!books || books.length === 0) return '';
    return books.map((b) => bookItemHTML(b, host)).join('');
  }

  function bookItemHTML(b, host) {
    const bookUrl = host ? `${host}/book/${b.id}` : '#';
    const cover   = resolveUrl(b.thumb || b.img || '', host);
    return `
      <a class="${NS}-item" href="${escAttr(bookUrl)}" target="_blank" rel="noopener noreferrer">
        <img class="${NS}-cover" src="" data-cover-src="${escAttr(cover)}" alt="" />
        <div class="${NS}-info">
          <div class="${NS}-title"  title="${escAttr(b.title)}">${escHtml(b.title)}</div>
          <div class="${NS}-author" title="${escAttr(b.author)}">${escHtml(b.author)}</div>
        </div>
      </a>`;
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    document.removeEventListener('click',   onOutsideClick, { capture: true });
    document.removeEventListener('keydown', onEscKey);
  }

  // ── Positioning ──────────────────────────────────────────────────────────────

  function positionOverlay(el) {
    // Hide while measuring so there's no flash at (0, 0)
    el.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const MARGIN = 10;
      const w  = el.offsetWidth  || 320;
      const h  = el.offsetHeight || 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Start 16 px below + slightly left of the selection point
      let top  = lastClientY + 16;
      let left = lastClientX - 20;

      // Flip upward if it would overflow the bottom
      if (top + h > vh - MARGIN) top = Math.max(MARGIN, lastClientY - h - 8);
      // Keep within horizontal bounds
      if (left + w > vw - MARGIN) left = vw - w - MARGIN;
      if (left < MARGIN) left = MARGIN;
      if (top  < MARGIN) top  = MARGIN;

      el.style.top  = `${top}px`;
      el.style.left = `${left}px`;
      el.style.visibility = 'visible';
    });
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  function onOutsideClick(e) {
    if (overlayEl && !overlayEl.contains(e.target)) {
      removeOverlay();
    }
  }

  function onEscKey(e) {
    if (e.key === 'Escape') removeOverlay();
  }

  // ── Sanitisation helpers ─────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Resolve a potentially relative cover URL against the server host.
   * The backend returns paths like "get/thumb_240_320/8626.jpg?t=..." when
   * cdn_url is empty; we must prepend the host to make them absolute.
   */
  function resolveUrl(url, host) {
    if (!url) return '';
    if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url;
    const base = (host || '').replace(/\/+$/, '');
    return `${base}/${url.replace(/^\/+/, '')}`;
  }

  /**
   * For each <img data-cover-src="..."> inside containerEl, ask the background
   * service worker to fetch the image and return a data: URL.  This sidesteps
   * any Content-Security-Policy restrictions on the host page.
   */
  function loadCovers(containerEl) {
    containerEl.querySelectorAll(`img[data-cover-src]`).forEach((img) => {
      const url = img.dataset.coverSrc;
      if (!url) return;
      chrome.runtime.sendMessage({ type: 'mybooks-fetch-image', url }, (resp) => {
        if (chrome.runtime.lastError) return; // extension context gone
        if (resp && resp.dataUrl) img.src = resp.dataUrl;
      });
    });
  }
})();
