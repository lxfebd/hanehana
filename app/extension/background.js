/**
 * HaneHana 浏览器扩展 —— service worker。
 *
 * 职责只有三件：
 *   1. 建右键菜单，把链接/页面交给统一投递函数；
 *   2. 统一投递函数：组装消息 → native messaging → 把响应/错误翻成给 UI 的结果；
 *   3. 记最近 10 条投递记录，给弹窗显示。
 *
 * 协议契约（唯一真值）：app/src/shared/nmProtocol.ts
 *   - 宿主名 com.lxfebd.hanehana
 *   - 请求 { v: 1, action: 'deliver', url, filename?, referer?, cookie?, userAgent?, pageUrl?, title? }
 *   - 响应 { ok: true, mode: 'engine' | 'queued', taskId?, dest?, message? } | { ok: false, error: string }
 *
 * 这个文件不碰 DOM，只跟 chrome.* API 打交道。
 */

/* strings.js 与本文件在同一个 service worker 全局作用域里。 */
importScripts('strings.js')

;(function () {
  'use strict'

  const S = globalThis.HN_STRINGS

  /* ---------- 契约常量（改这里等于改协议，务必与 nmProtocol.ts 对齐） ---------- */
  const HOST_NAME = 'com.lxfebd.hanehana'
  const PROTOCOL_VERSION = 1
  const ACTION = 'deliver'

  /* ---------- 内部常量 ---------- */
  const MENU_LINK = 'hanehana-link'
  const MENU_PAGE = 'hanehana-page'
  const KEY_HISTORY = 'hn.history'
  const KEY_COLLECTED = 'hn.collected'
  const KEY_SETTINGS = 'hn.settings'
  const MAX_HISTORY = 10
  const MAX_COLLECTED_TABS = 20
  const MAX_COLLECTED_LINKS = 100

  /* 契约里的长度上限（app/src/shared/nmProtocol.ts 的 NM_MAX_*） */
  const MAX_URL = 4096
  const MAX_FILENAME = 255
  const MAX_REFERER = 8192
  const MAX_COOKIE = 8192
  const MAX_UA = 512
  const MAX_PAGE_URL = 4096
  const MAX_TITLE = 512

  /* ================= 存储 ================= */

  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(keys, function (items) {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new Error(err.message))
          return
        }
        resolve(items || {})
      })
    })
  }

  function storageSet(items) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(items, function () {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new Error(err.message))
          return
        }
        resolve()
      })
    })
  }

  /* ================= 小工具 ================= */

  function clampText(value, max) {
    if (typeof value !== 'string') return ''
    const text = value.trim()
    if (!text) return ''
    return text.length > max ? text.slice(0, max) : text
  }

  /**
   * 超长 URL 的特判：**不静默截断**。
   *
   * clampText 对 url 一刀切会让一个 5000 字符的链接变成 4096 字符发出去，
   * 主机侧的长度校验永远不触发，用户拿到的是一个形态完好、指向错误资源的
   * 下载任务——而不是「下载链接过长」（S.errorUrlTooLong 此前是死字符串，
   * 没有任何地方引用它）。url 是任务的根，错一位整个任务就废了，必须明确拒绝。
   */
  function clampUrlOrError(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text && text.length > MAX_URL) {
      return { error: S.errorUrlTooLong }
    }
    return { url: clampText(text, MAX_URL) }
  }

  function isHttpUrl(value) {
    try {
      const u = new URL(String(value))
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch (e) {
      return false
    }
  }

  function originOf(value) {
    try {
      const u = new URL(String(value))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
      return u.origin
    } catch (e) {
      return ''
    }
  }

  function sameOrigin(a, b) {
    const oa = originOf(a)
    const ob = originOf(b)
    return !!oa && !!ob && oa === ob
  }

  function originPattern(value) {
    const origin = originOf(value)
    return origin ? origin + '/*' : ''
  }

  /** 从 URL 猜文件名：取最后一段路径，去掉查询串，解码失败就原样用。 */
  function filenameFromUrl(value) {
    try {
      const u = new URL(String(value))
      const parts = u.pathname.split('/').filter(Boolean)
      const last = parts.length ? parts[parts.length - 1] : ''
      let name = last
      try {
        name = decodeURIComponent(last)
      } catch (e) {
        name = last
      }
      name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
      return name.slice(0, MAX_FILENAME)
    } catch (e) {
      return ''
    }
  }

  /* ================= Cookie ================= */

  function hasPermission(permission) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.contains(permission, function (granted) {
          void chrome.runtime.lastError
          resolve(!!granted)
        })
      } catch (e) {
        resolve(false)
      }
    })
  }

  function getCookies(url) {
    return new Promise(function (resolve) {
      try {
        chrome.cookies.getAll({ url: url }, function (cookies) {
          void chrome.runtime.lastError
          resolve(Array.isArray(cookies) ? cookies : [])
        })
      } catch (e) {
        resolve([])
      }
    })
  }

  function cookieHeader(cookies) {
    return cookies
      .map(function (c) {
        return c.name + '=' + c.value
      })
      .join('; ')
  }

  /**
   * 取当前站点的 Cookie 串。
   *
   * 只在目标链接与来源页同源时才取：把 A 站的 Cookie 发给 B 站等于泄露凭据，
   * 而且跨站时我们也没有 B 站的读取权限（用户只授权了 A 站）。
   */
  async function collectCookie(targetUrl, pageUrl) {
    const notes = []
    if (!sameOrigin(targetUrl, pageUrl)) {
      notes.push(S.cookieCrossOrigin)
      return { cookie: '', notes: notes }
    }
    const granted = await hasPermission({
      permissions: ['cookies'],
      origins: [originPattern(targetUrl)],
    })
    if (!granted) {
      notes.push(S.cookieHintDenied)
      return { cookie: '', notes: notes }
    }
    const cookies = await getCookies(targetUrl)
    const raw = cookieHeader(cookies)
    if (!raw) return { cookie: '', notes: notes }
    if (raw.length > MAX_COOKIE) {
      notes.push(S.format(S.cookieTruncated, { limit: MAX_COOKIE }))
      return { cookie: raw.slice(0, MAX_COOKIE), notes: notes }
    }
    return { cookie: raw, notes: notes }
  }

  /* ================= native messaging ================= */

  function sendNativeMessage(message) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendNativeMessage(HOST_NAME, message, function (response) {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new Error(err.message || 'native messaging failed'))
          return
        }
        resolve(response)
      })
    })
  }

  /** chrome.runtime.lastError 的英文原文翻成人话。 */
  function mapNativeError(raw) {
    const text = String(raw || '')
    const lower = text.toLowerCase()
    if (lower.indexOf('forbidden') >= 0) return S.errorHostForbidden
    if (lower.indexOf('not found') >= 0 || lower.indexOf('no native application') >= 0) {
      return S.errorHostNotFound
    }
    if (lower.indexOf('exited') >= 0) return S.errorHostExited
    if (
      lower.indexOf('communicat') >= 0 ||
      lower.indexOf('broken pipe') >= 0 ||
      lower.indexOf('epipe') >= 0
    ) {
      return S.errorHostFailed
    }
    return S.format(S.errorUnknown, { error: text })
  }

  /* ================= 统一投递 ================= */

  /**
   * 投递一条下载链接。
   *
   * @param {{url:string, filename?:string, referer?:string, pageUrl?:string,
   *          title?:string, withCookie?:boolean}} payload
   * @returns {Promise<{ok:boolean,status:'engine'|'queued'|'error',message:string,notes:string[],url?:string,filename?:string,taskId?:string,dest?:string}>}
   */
  async function deliver(payload) {
    const input = payload || {}
    const notes = []

    const urlCheck = clampUrlOrError(input.url)
    if (urlCheck.error) {
      return { ok: false, status: 'error', message: urlCheck.error, notes: notes }
    }
    const url = urlCheck.url
    if (!url) {
      return { ok: false, status: 'error', message: S.errorEmptyUrl, notes: notes }
    }
    if (!isHttpUrl(url)) {
      return { ok: false, status: 'error', message: S.errorInvalidUrl, notes: notes }
    }

    let filename = clampText(input.filename, MAX_FILENAME)
    if (!filename) filename = filenameFromUrl(url)
    const pageUrl = clampText(input.pageUrl, MAX_PAGE_URL)
    const referer = clampText(input.referer || pageUrl, MAX_REFERER)
    const title = clampText(input.title, MAX_TITLE)
    const userAgent = clampText(input.userAgent || defaultUserAgent(), MAX_UA)

    let cookie = ''
    if (input.withCookie) {
      const collected = await collectCookie(url, pageUrl)
      cookie = collected.cookie
      for (const note of collected.notes) notes.push(note)
    }

    /* 只带契约里有的字段，空值不塞——协议里 optional 字段缺省就是不传。 */
    const message = { v: PROTOCOL_VERSION, action: ACTION, url: url }
    if (filename) message.filename = filename
    if (referer) message.referer = referer
    if (cookie) message.cookie = cookie
    if (userAgent) message.userAgent = userAgent
    if (pageUrl) message.pageUrl = pageUrl
    if (title) message.title = title

    let response
    try {
      response = await sendNativeMessage(message)
    } catch (err) {
      const failed = {
        ok: false,
        status: 'error',
        message: mapNativeError(err && err.message),
        notes: notes,
        url: url,
        filename: filename,
      }
      await pushHistory(failed)
      return failed
    }

    let result
    if (!response || typeof response !== 'object') {
      result = {
        ok: false,
        status: 'error',
        message: S.errorBadResponse,
        notes: notes,
        url: url,
        filename: filename,
      }
    } else if (response.ok === true) {
      const mode = response.mode === 'queued' ? 'queued' : 'engine'
      if (mode === 'queued') notes.push(S.queuedNote)
      result = {
        ok: true,
        status: mode,
        message: response.message || (mode === 'queued' ? S.statusQueued : S.statusEngine),
        taskId: typeof response.taskId === 'string' ? response.taskId : undefined,
        dest: typeof response.dest === 'string' ? response.dest : undefined,
        notes: notes,
        url: url,
        filename: filename,
      }
    } else {
      const reason =
        typeof response.error === 'string' && response.error ? response.error : S.errorBadResponse
      result = {
        ok: false,
        status: 'error',
        message: S.format(S.errorRejected, { error: reason }),
        notes: notes,
        url: url,
        filename: filename,
      }
    }

    await pushHistory(result)
    return result
  }

  function defaultUserAgent() {
    try {
      return String(navigator.userAgent || '')
    } catch (e) {
      return ''
    }
  }

  /* ================= 最近投递记录 ================= */

  async function pushHistory(result) {
    const entry = {
      time: Date.now(),
      filename: result.filename || S.unknownFilename,
      url: result.url || '',
      ok: !!result.ok,
      status: result.status || 'error',
      message: result.message || '',
    }
    try {
      const items = await storageGet(KEY_HISTORY)
      const list = Array.isArray(items[KEY_HISTORY]) ? items[KEY_HISTORY] : []
      list.unshift(entry)
      await storageSet({ [KEY_HISTORY]: list.slice(0, MAX_HISTORY) })
    } catch (e) {
      /* 记录失败不影响投递本身 */
    }
  }

  async function readHistory() {
    try {
      const items = await storageGet(KEY_HISTORY)
      const list = items[KEY_HISTORY]
      return Array.isArray(list) ? list.slice(0, MAX_HISTORY) : []
    } catch (e) {
      return []
    }
  }

  /* ================= 内容脚本收集到的链接 ================= */

  function sanitizeLink(link) {
    const item = link && typeof link === 'object' ? link : {}
    const url = clampText(item.url, MAX_URL)
    if (!url || !isHttpUrl(url)) return null
    return {
      url: url,
      filename: clampText(item.filename, MAX_FILENAME) || filenameFromUrl(url),
      title: clampText(item.title, MAX_TITLE),
    }
  }

  async function writeCollected(tabId, data) {
    if (!tabId) return
    try {
      const items = await storageGet(KEY_COLLECTED)
      const raw = items[KEY_COLLECTED]
      const map = raw && typeof raw === 'object' ? Object.assign({}, raw) : {}
      const input = Array.isArray(data.links) ? data.links : []
      const links = []
      for (const item of input.slice(0, MAX_COLLECTED_LINKS)) {
        const clean = sanitizeLink(item)
        if (clean) links.push(clean)
      }
      map[String(tabId)] = {
        pageUrl: clampText(data.pageUrl, MAX_PAGE_URL),
        title: clampText(data.title, MAX_TITLE),
        updatedAt: Date.now(),
        links: links,
      }
      const keys = Object.keys(map)
      if (keys.length > MAX_COLLECTED_TABS) {
        keys.sort(function (a, b) {
          return (map[b].updatedAt || 0) - (map[a].updatedAt || 0)
        })
        for (const key of keys.slice(MAX_COLLECTED_TABS)) delete map[key]
      }
      await storageSet({ [KEY_COLLECTED]: map })
    } catch (e) {
      /* 存不下就算了，不影响别的功能 */
    }
  }

  async function readCollected(tabId) {
    try {
      const items = await storageGet(KEY_COLLECTED)
      const map = items[KEY_COLLECTED]
      if (!map || typeof map !== 'object') return { links: [], pageUrl: '', title: '' }
      const entry = map[String(tabId)]
      if (!entry || typeof entry !== 'object') return { links: [], pageUrl: '', title: '' }
      return {
        links: Array.isArray(entry.links) ? entry.links : [],
        pageUrl: entry.pageUrl || '',
        title: entry.title || '',
      }
    } catch (e) {
      return { links: [], pageUrl: '', title: '' }
    }
  }

  async function clearCollected(tabId) {
    try {
      const items = await storageGet(KEY_COLLECTED)
      const raw = items[KEY_COLLECTED]
      const map = raw && typeof raw === 'object' ? Object.assign({}, raw) : {}
      delete map[String(tabId)]
      await storageSet({ [KEY_COLLECTED]: map })
      return true
    } catch (e) {
      return false
    }
  }

  /* ================= 右键菜单 ================= */

  function setupMenus() {
    try {
      chrome.contextMenus.removeAll(function () {
        try {
          chrome.contextMenus.create({
            id: MENU_LINK,
            title: S.contextMenuLink,
            contexts: ['link'],
          })
          chrome.contextMenus.create({
            id: MENU_PAGE,
            title: S.contextMenuPage,
            contexts: ['page'],
          })
        } catch (e) {
          /* 菜单已存在等情况，忽略 */
        }
      })
    } catch (e) {
      /* 忽略 */
    }
  }

  chrome.runtime.onInstalled.addListener(setupMenus)
  chrome.runtime.onStartup.addListener(setupMenus)

  function sendTabMessage(tabId, message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          const err = chrome.runtime.lastError
          if (err) {
            reject(new Error(err.message))
            return
          }
          resolve(response)
        })
      } catch (e) {
        reject(e)
      }
    })
  }

  async function deliverPageContext(tab, info) {
    const pageUrl = (tab && tab.url) || (info && info.pageUrl) || ''
    let picked = null
    if (tab && typeof tab.id === 'number') {
      try {
        const response = await sendTabMessage(tab.id, { type: 'hn.getCandidates' })
        if (response && response.ok && Array.isArray(response.links) && response.links.length) {
          picked = response.links[0]
        }
      } catch (e) {
        picked = null
      }
    }
    const url = picked ? picked.url : pageUrl
    if (!url) return
    const result = await deliver({
      url: url,
      filename: picked ? picked.filename : '',
      referer: pageUrl,
      pageUrl: pageUrl,
      title: picked ? picked.title : (tab && tab.title) || '',
      withCookie: false,
    })
    flashBadge(result.ok, result.message)
  }

  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (!info) return
    if (info.menuItemId === MENU_LINK) {
      const url = info.linkUrl || ''
      if (!url) return
      const pageUrl = info.pageUrl || (tab && tab.url) || ''
      deliver({
        url: url,
        filename: filenameFromUrl(url),
        referer: pageUrl,
        pageUrl: pageUrl,
        title: (info.selectionText || '').trim(),
        withCookie: false,
      }).then(function (result) {
        flashBadge(result.ok, result.message)
      })
    } else if (info.menuItemId === MENU_PAGE) {
      deliverPageContext(tab, info)
    }
  })

  /* ================= 角标反馈 ================= */

  function flashBadge(ok, message) {
    try {
      chrome.action.setBadgeText({ text: ok ? 'OK' : '!' })
      chrome.action.setBadgeBackgroundColor({ color: ok ? '#3f4751' : '#a13232' })
      chrome.action.setTitle({ title: message || '' })
      setTimeout(function () {
        chrome.action.setBadgeText({ text: '' })
      }, 4000)
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ================= 弹窗 / 内容脚本的消息接口 ================= */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false

    if (message.type === 'hn.deliver') {
      deliver(message.payload || {})
        .then(function (result) {
          sendResponse(result)
        })
        .catch(function (err) {
          sendResponse({
            ok: false,
            status: 'error',
            message: mapNativeError(err && err.message),
            notes: [],
          })
        })
      return true
    }

    if (message.type === 'hn.getHistory') {
      readHistory().then(function (history) {
        sendResponse({ ok: true, history: history })
      })
      return true
    }

    if (message.type === 'hn.getCollected') {
      const tabId = message.tabId
      readCollected(tabId).then(function (data) {
        sendResponse({ ok: true, links: data.links, pageUrl: data.pageUrl, title: data.title })
      })
      return true
    }

    if (message.type === 'hn.clearCollected') {
      clearCollected(message.tabId).then(function () {
        sendResponse({ ok: true })
      })
      return true
    }

    if (message.type === 'hn.getSettings') {
      storageGet(KEY_SETTINGS)
        .then(function (items) {
          const settings = items[KEY_SETTINGS] || {}
          sendResponse({
            ok: true,
            cookieEnabled: !!(settings && settings.cookieEnabled),
          })
        })
        .catch(function () {
          sendResponse({ ok: true, cookieEnabled: false })
        })
      return true
    }

    if (message.type === 'hn.setSettings') {
      storageSet({ [KEY_SETTINGS]: message.settings || {} })
        .then(function () {
          sendResponse({ ok: true })
        })
        .catch(function () {
          sendResponse({ ok: false })
        })
      return true
    }

    /* 内容脚本上报它收集到的链接 */
    if (message.type === 'hn.collect') {
      const tabId = sender && sender.tab ? sender.tab.id : null
      writeCollected(tabId, message.data || {}).then(function () {
        sendResponse({ ok: true })
      })
      return true
    }

    return false
  })
})()
