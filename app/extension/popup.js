/**
 * 弹窗脚本。
 *
 * 规矩：
 *   - 页面里凡是来自扩展/网页的字符串，一律用 textContent 写进去，不用 innerHTML；
 *   - 所有中文文案来自 strings.js，这里只负责摆位置；
 *   - 真正发 native message 的是 service worker，这里只发 chrome.runtime.sendMessage。
 */
;(function () {
  'use strict'

  const S = window.HN_STRINGS
  const MAX_SHOWN_LINKS = 8

  const state = {
    tabId: null,
    pageUrl: '',
    pageTitle: '',
    origin: '',
  }

  function $(id) {
    return document.getElementById(id)
  }

  /* ================= 与 service worker 通信 ================= */

  function sendBg(type, payload) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          Object.assign({ type: type }, payload || {}),
          function (response) {
            void chrome.runtime.lastError
            resolve(response || null)
          }
        )
      } catch (e) {
        resolve(null)
      }
    })
  }

  function sendTab(tabId, message) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          void chrome.runtime.lastError
          resolve(response || null)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  function queryActiveTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          void chrome.runtime.lastError
          resolve(tabs && tabs.length ? tabs[0] : null)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  /* ================= 权限 ================= */

  function permsContains(permission) {
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

  function permsRequest(permission) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.request(permission, function (granted) {
          void chrome.runtime.lastError
          resolve(!!granted)
        })
      } catch (e) {
        resolve(false)
      }
    })
  }

  function permsRemove(permission) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.remove(permission, function (removed) {
          void chrome.runtime.lastError
          resolve(!!removed)
        })
      } catch (e) {
        resolve(false)
      }
    })
  }

  /* ================= 渲染 ================= */

  function applyStrings() {
    document.title = S.appName
    $('app-title').textContent = S.appName
    $('app-subtitle').textContent = S.appSubtitle
    $('url-label').textContent = S.urlLabel
    $('url-input').placeholder = S.urlPlaceholder
    $('deliver-button').textContent = S.deliverButton
    $('cookie-label').textContent = S.cookieLabel
    $('links-title').textContent = S.linksTitle
    $('links-empty').textContent = S.linksEmpty
    $('history-title').textContent = S.historyTitle
    $('history-empty').textContent = S.historyEmpty
    $('id-warning-title').textContent = S.idMismatchTitle
  }

  /**
   * 自检：扩展 ID 必须和宿主清单里 allowed_origins 写死的一致，
   * 否则 Chrome 会直接拒绝 native messaging（错误是 forbidden）。
   */
  function checkExtensionId() {
    const actual = chrome.runtime.id || ''
    if (!actual || actual === S.expectedExtensionId) return
    $('id-warning').hidden = false
    $('id-warning-body').textContent = S.format(S.idMismatchBody, {
      actual: actual,
      expected: S.expectedExtensionId,
    })
  }

  function setStatus(text, kind) {
    const el = $('status')
    el.textContent = text || ''
    el.className = 'status' + (kind ? ' ' + kind : '')
  }

  function setNotes(notes) {
    const box = $('status-notes')
    box.textContent = ''
    if (!Array.isArray(notes)) return
    for (const note of notes) {
      const p = document.createElement('p')
      p.textContent = String(note)
      box.appendChild(p)
    }
  }

  function formatTime(value) {
    const date = new Date(value)
    if (isNaN(date.getTime())) return ''
    const pad = function (n) {
      return n < 10 ? '0' + n : String(n)
    }
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }

  async function renderHistory() {
    const response = await sendBg('hn.getHistory')
    const list = response && Array.isArray(response.history) ? response.history : []
    const ul = $('history-list')
    ul.textContent = ''
    $('history-empty').hidden = list.length > 0
    $('history-empty').textContent = S.historyEmpty

    for (const entry of list) {
      const li = document.createElement('li')

      const main = document.createElement('div')
      main.className = 'item-main'

      const name = document.createElement('span')
      name.className = 'item-name'
      name.textContent = entry.filename || S.unknownFilename

      const sub = document.createElement('span')
      let kind = 'err'
      if (entry.ok) kind = entry.status === 'queued' ? 'warn' : 'ok'
      sub.className = 'item-sub ' + kind
      const time = formatTime(entry.time)
      sub.textContent = (time ? time + ' · ' : '') + (entry.message || '')

      main.appendChild(name)
      main.appendChild(sub)
      li.appendChild(main)
      ul.appendChild(li)
    }
  }

  async function renderLinks() {
    const block = $('links-block')
    const ul = $('links-list')
    ul.textContent = ''
    $('links-empty').textContent = S.linksEmpty

    if (state.tabId === null) {
      block.hidden = true
      return
    }

    const response = await sendTab(state.tabId, { type: 'hn.getCandidates' })
    const links = response && Array.isArray(response.links) ? response.links : []
    const collected = response && Array.isArray(response.collected) ? response.collected : []
    const collectedUrls = new Set()
    for (const item of collected) {
      if (item && item.url) collectedUrls.add(item.url)
    }

    block.hidden = false
    $('links-empty').hidden = links.length > 0
    $('links-title').textContent = links.length
      ? S.format(S.linksFound, { count: links.length })
      : S.linksTitle

    for (const link of links.slice(0, MAX_SHOWN_LINKS)) {
      const li = document.createElement('li')

      const main = document.createElement('div')
      main.className = 'item-main'

      const name = document.createElement('span')
      name.className = 'item-name'
      name.textContent = link.filename || link.title || S.unknownFilename

      const sub = document.createElement('span')
      sub.className = 'item-sub'
      sub.textContent = link.title && link.filename ? link.title : link.url

      main.appendChild(name)
      main.appendChild(sub)
      li.appendChild(main)

      if (collectedUrls.has(link.url)) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = S.linksCollectedMark
        li.appendChild(tag)
      }

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini'
      button.textContent = S.deliverOne
      button.addEventListener('click', function () {
        $('url-input').value = link.url
        deliverCurrent()
      })
      li.appendChild(button)

      ul.appendChild(li)
    }
  }

  /* ================= 投递 ================= */

  function showResult(result) {
    if (!result) {
      setStatus(S.errorBadResponse, 'err')
      setNotes([])
      return
    }
    if (result.ok) {
      const kind = result.status === 'queued' ? 'warn' : 'ok'
      let text = result.message || (result.status === 'queued' ? S.statusQueued : S.statusEngine)
      if (result.dest) {
        text += '（' + S.format(S.destLabel, { path: result.dest }) + '）'
      }
      setStatus(text, kind)
    } else {
      setStatus(result.message || S.errorBadResponse, 'err')
    }
    setNotes(result.notes || [])
  }

  async function deliverCurrent() {
    const raw = String($('url-input').value || '').trim()
    if (!raw) {
      setStatus(S.errorEmptyUrl, 'err')
      setNotes([])
      return
    }
    if (!/^https?:\/\//i.test(raw)) {
      setStatus(S.errorInvalidUrl, 'err')
      setNotes([])
      return
    }

    const button = $('deliver-button')
    button.disabled = true
    button.textContent = S.delivering
    setStatus(S.delivering)
    setNotes([])

    try {
      const withCookie = $('cookie-check').checked && !!state.origin
      const response = await sendBg('hn.deliver', {
        payload: {
          url: raw,
          referer: state.pageUrl,
          pageUrl: state.pageUrl,
          title: state.pageTitle,
          withCookie: withCookie,
        },
      })
      showResult(response)
    } finally {
      button.disabled = false
      button.textContent = S.deliverButton
    }
    await renderHistory()
  }

  /* ================= Cookie 开关 ================= */

  async function saveCookieSetting(enabled) {
    await sendBg('hn.setSettings', { settings: { cookieEnabled: enabled } })
  }

  function onCookieToggle() {
    const check = $('cookie-check')
    if (check.checked) {
      if (!state.origin) {
        check.checked = false
        $('cookie-hint').textContent = S.cookieHintNoSite
        saveCookieSetting(false)
        return
      }
      /* 必须在用户手势里直接调 request，所以这里不 await 任何东西再请求。 */
      const requested = permsRequest({
        permissions: ['cookies'],
        origins: [state.origin + '/*'],
      })
      requested.then(function (granted) {
        if (!granted) {
          check.checked = false
          $('cookie-hint').textContent = S.cookieHintDenied
          saveCookieSetting(false)
          return
        }
        $('cookie-hint').textContent = S.cookieHintGranted
        saveCookieSetting(true)
      })
        .catch(function () {
          /* 弹窗可能在授权完成前就关了：元素已不在，忽略 */
        })
      return
    }

    /* 取消勾选：把本站的 host 访问权收回来（cookies API 权限留着，用户可随时再勾）。 */
    const removed = state.origin
      ? permsRemove({ origins: [state.origin + '/*'] })
      : Promise.resolve(false)
    removed.then(function () {
      $('cookie-hint').textContent = S.cookieHintIdle
      saveCookieSetting(false)
    })
      .catch(function () {
        /* 同上：弹窗可能已关，元素已不在，忽略 */
      })
  }

  /* ================= 初始化 ================= */

  async function init() {
    applyStrings()
    checkExtensionId()
    $('cookie-hint').textContent = S.cookieHintIdle

    const tab = await queryActiveTab()
    if (tab && typeof tab.id === 'number') state.tabId = tab.id

    if (state.tabId !== null) {
      const info = await sendTab(state.tabId, { type: 'hn.getPageInfo' })
      if (info && info.ok) {
        state.pageUrl = info.pageUrl || ''
        state.pageTitle = info.title || ''
        state.origin = info.origin || ''
      }

      const selection = await sendTab(state.tabId, { type: 'hn.getSelection' })
      if (selection && selection.ok) {
        if (!state.pageUrl) state.pageUrl = selection.pageUrl || ''
        if (!state.pageTitle) state.pageTitle = selection.title || ''
        const picked = selection.selection && selection.selection.url
        if (picked && !String($('url-input').value || '').trim()) {
          $('url-input').value = picked
        }
      }
    }

    const settings = await sendBg('hn.getSettings')
    if (settings && settings.cookieEnabled && state.origin) {
      const granted = await permsContains({
        permissions: ['cookies'],
        origins: [state.origin + '/*'],
      })
      if (granted) {
        $('cookie-check').checked = true
        $('cookie-hint').textContent = S.cookieHintGranted
      }
    }

    await renderLinks()
    await renderHistory()
  }

  /* ================= 事件绑定 ================= */

  $('deliver-button').addEventListener('click', deliverCurrent)
  $('cookie-check').addEventListener('change', onCookieToggle)
  $('url-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      deliverCurrent()
    }
  })

  init()
})()
