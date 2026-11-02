/**
 * 内容脚本：在网页上认出「像下载文件的链接」，并支持按住 Alt 点击收集。
 *
 * 刻意不做的事：
 *   - 不拦截普通点击、不改写链接、不碰页面自己的下载逻辑（劫持下载很烦，用户会恨它）；
 *   - 不常驻扫描 DOM（只在需要时扫一次，且有上限）；
 *   - 不往页面里塞常驻 UI（只有 Alt+点击过的链接才会被高亮）。
 *
 * 它只负责「发现 + 收集」，真正的投递在 service worker 里做
 * （content script 不能直接调 native messaging）。
 */
;(function () {
  'use strict'

  const S = globalThis.HN_STRINGS || {}

  const HL_CLASS = 'hanehana-alt-download'
  const STYLE_ID = 'hanehana-alt-download-style'

  /** 常见下载文件扩展名。命中其一就当「像下载文件的链接」。 */
  const FILE_EXT_RE =
    /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|exe|msi|bat|cmd|scr|dmg|iso|img|deb|rpm|apk|ipa|jar|war|bin|cab|msu|pkg|ova|ovf|vmdk|qcow2|pdf|epub|mobi|azw3|ps1|sh)(?:$|\/)/i

  /** 路径里带这些片段的，多半也是下载入口。 */
  const PATH_HINT_RE = /\/(download|downloads|dl|attachment|attachments|files|file)(\/|$|\?)/i

  const MAX_CANDIDATES = 100
  const MAX_SCAN_ANCHORS = 3000

  /** url -> 收集到的条目 */
  const collected = new Map()
  /** 最近一次「选中的是哪个链接」，弹窗用它预填 */
  let lastSelection = null
  /** 最近一次右键点到的链接（比 selection 更贴近用户意图） */
  let lastContextLink = null

  /* ================= 判定 ================= */

  function isHttpUrl(value) {
    try {
      const u = new URL(String(value))
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch (e) {
      return false
    }
  }

  function pathOf(href) {
    try {
      const u = new URL(href, location.href)
      return u.pathname
    } catch (e) {
      return ''
    }
  }

  /** 这个 <a> 是不是「像下载文件的链接」。 */
  function looksLikeDownload(anchor) {
    if (!anchor || !anchor.getAttribute) return false
    const raw = anchor.getAttribute('href') || ''
    if (!raw) return false
    if (/^\s*javascript:/i.test(raw)) return false
    const absolute = anchor.href || raw
    if (!isHttpUrl(absolute)) return false
    if (anchor.hasAttribute('download')) return true
    const path = pathOf(absolute)
    if (FILE_EXT_RE.test(path)) return true
    if (PATH_HINT_RE.test(path)) return true
    return false
  }

  function filenameFromAnchor(anchor) {
    if (!anchor) return ''
    const attr = anchor.getAttribute('download')
    if (attr && attr.trim()) return attr.trim()
    try {
      const u = new URL(anchor.href, location.href)
      const parts = u.pathname.split('/').filter(Boolean)
      const last = parts.length ? parts[parts.length - 1] : ''
      if (!last) return ''
      let name = last
      try {
        name = decodeURIComponent(last)
      } catch (e) {
        name = last
      }
      return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 255)
    } catch (e) {
      return ''
    }
  }

  function anchorFrom(node) {
    let el = node
    if (el && el.nodeType === 3) el = el.parentElement
    if (!el || !el.closest) return null
    return el.closest('a[href]')
  }

  /* ================= 扫描 ================= */

  function scanCandidates(limit) {
    const max = typeof limit === 'number' ? Math.min(limit, MAX_CANDIDATES) : MAX_CANDIDATES
    const anchors = document.querySelectorAll('a[href]')
    const out = []
    for (let i = 0; i < anchors.length && out.length < max; i += 1) {
      if (i >= MAX_SCAN_ANCHORS) break
      const anchor = anchors[i]
      if (!looksLikeDownload(anchor)) continue
      out.push({
        url: anchor.href,
        filename: filenameFromAnchor(anchor),
        title: (anchor.textContent || '').trim().slice(0, 200),
      })
    }
    return out
  }

  /* ================= 高亮 ================= */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent =
      '.' +
      HL_CLASS +
      '{outline:2px solid #3f4751 !important;outline-offset:1px;background:rgba(63,71,81,.14) !important;}'
    const parent = document.head || document.documentElement
    if (parent) parent.appendChild(style)
  }

  function highlight(anchor) {
    try {
      ensureStyle()
      anchor.classList.add(HL_CLASS)
    } catch (e) {
      /* 页面脚本可能锁住 classList，忽略 */
    }
  }

  /* ================= 收集 ================= */

  function collect(anchor) {
    const url = anchor.href
    if (!url || !isHttpUrl(url)) return
    const entry = {
      url: url,
      filename: filenameFromAnchor(anchor),
      title: (anchor.textContent || '').trim().slice(0, 200),
    }
    collected.set(url, entry)
    highlight(anchor)
    notifyBackground()
  }

  function notifyBackground() {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'hn.collect',
          data: {
            pageUrl: location.href,
            title: document.title,
            links: Array.from(collected.values()),
          },
        },
        function () {
          void chrome.runtime.lastError
        }
      )
    } catch (e) {
      /* 扩展被更新/卸载时忽略 */
    }
  }

  /* ================= 事件 ================= */

  // Alt+点击：收集并高亮；顺手 preventDefault，免得浏览器直接开始下载（用户明明想交给 HaneHana）。
  document.addEventListener(
    'click',
    function (event) {
      if (!event.altKey) return
      const anchor = anchorFrom(event.target)
      if (!anchor) return
      if (!looksLikeDownload(anchor)) return
      event.preventDefault()
      collect(anchor)
    },
    true
  )

  // 右键：记住被点的链接，弹窗预填时更准。
  document.addEventListener(
    'contextmenu',
    function (event) {
      const anchor = anchorFrom(event.target)
      if (!anchor) return
      if (!isHttpUrl(anchor.href)) return
      lastContextLink = {
        url: anchor.href,
        filename: filenameFromAnchor(anchor),
        title: (anchor.textContent || '').trim().slice(0, 200),
      }
    },
    true
  )

  // 选中文本：选中的正好是链接文字或一段 URL 时，记下来给弹窗预填。
  let selectionTimer = null
  document.addEventListener('selectionchange', function () {
    if (selectionTimer) clearTimeout(selectionTimer)
    selectionTimer = setTimeout(captureSelection, 200)
  })

  function captureSelection() {
    try {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
      const text = String(selection.toString() || '').trim()
      const node = selection.anchorNode
      let element = node && node.nodeType === 1 ? node : node && node.parentElement
      const anchor = element && element.closest ? element.closest('a[href]') : null
      if (anchor && isHttpUrl(anchor.href)) {
        lastSelection = {
          url: anchor.href,
          filename: filenameFromAnchor(anchor),
          title: (anchor.textContent || '').trim().slice(0, 200),
        }
        return
      }
      if (/^https?:\/\/\S+$/i.test(text)) {
        lastSelection = { url: text, filename: '', title: '' }
        return
      }
      lastSelection = null
    } catch (e) {
      /* 某些页面会抛，忽略 */
    }
  }

  /* ================= 消息接口 ================= */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false

    if (message.type === 'hn.getPageInfo') {
      sendResponse({
        ok: true,
        pageUrl: location.href,
        title: document.title,
        origin: location.origin,
      })
      return false
    }

    if (message.type === 'hn.getSelection') {
      const picked = lastSelection || lastContextLink
      sendResponse({
        ok: true,
        selection: picked,
        pageUrl: location.href,
        title: document.title,
      })
      return false
    }

    if (message.type === 'hn.getCandidates') {
      sendResponse({
        ok: true,
        links: scanCandidates(MAX_CANDIDATES),
        collected: Array.from(collected.values()),
        pageUrl: location.href,
        title: document.title,
      })
      return false
    }

    return false
  })
})()
