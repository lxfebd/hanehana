/**
 * 扩展内所有面向用户的中文字符串集中在这里。
 *
 * 为什么单独一个文件：扩展里用户能看到的字散在 background / content / popup 三处，
 * 以后要改文案（比如换语气、加措辞）时一处一处翻很漏。全部收到这里之后，
 * 改这一个文件就够，js / html 都不动。
 *
 * 用法：
 *   - service worker：importScripts('strings.js') 后读 globalThis.HN_STRINGS
 *   - popup：<script src="strings.js"></script> 后读 window.HN_STRINGS
 *   - content script：content_scripts 里排在 content.js 前面，读 globalThis.HN_STRINGS
 *
 * 约定：带 {xxx} 的字符串是模板，用 HN_STRINGS.format(模板, {xxx: 值}) 填。
 */
;(function (root) {
  'use strict'

  const HN_STRINGS = {
    /* ---------- 品牌 / 标题 ---------- */
    appName: 'HaneHana 下载助手',
    appSubtitle: '把网页链接交给桌面应用下载',

    /* ---------- 右键菜单 ---------- */
    contextMenuLink: '用 HaneHana 下载',
    contextMenuPage: '把本页链接交给 HaneHana',

    /* ---------- 弹窗 ---------- */
    popupTitle: 'HaneHana 下载',
    urlLabel: '下载链接',
    urlPlaceholder: '粘贴 http/https 下载链接',
    deliverButton: '投递到 HaneHana',
    delivering: '正在投递…',
    statusIdle: '等待投递',
    statusEngine: '已交给下载引擎',
    statusQueued: 'HaneHana 未运行，链接已排队',
    statusError: '投递失败',

    /* ---------- Cookie ---------- */
    cookieLabel: '携带当前站点 Cookie',
    cookieHintIdle: '勾选后会向浏览器申请读取当前站点 Cookie 的权限；不勾选则不读取。',
    cookieHintGranted: '已获得当前站点的 Cookie 读取权限。',
    cookieHintDenied: '没有获得 Cookie 权限，已按不携带处理。',
    cookieHintNoSite: '当前页面拿不到站点地址（可能是浏览器内部页），无法申请 Cookie 权限。',
    cookieCrossOrigin: '目标链接与当前站点不同源，未附带 Cookie（避免把凭据发给别的站点）。',
    cookieTruncated: 'Cookie 太长，已截断到 {limit} 字符。',
    cookieRemoved: '已撤回当前站点的 Cookie 访问权限。',

    /* ---------- 本页链接 ---------- */
    linksTitle: '本页链接',
    linksEmpty: '本页没有发现像下载文件的链接。在链接上按住 Alt 点击，可直接收集。',
    linksFound: '本页发现 {count} 个像下载文件的链接：',
    linksCollectedMark: '已收集',
    deliverOne: '投递',

    /* ---------- 最近投递 ---------- */
    historyTitle: '最近投递',
    historyEmpty: '还没有投递记录。',
    historyItemTime: '{time}',

    /* ---------- 错误 ---------- */
    errorEmptyUrl: '请先填写下载链接',
    errorInvalidUrl: '只支持 http/https 链接',
    errorUrlTooLong: '下载链接过长',
    errorHostNotFound: '找不到 HaneHana 宿主（可能没在设置里注册）',
    errorHostForbidden: 'HaneHana 宿主拒绝了本扩展的访问（检查宿主清单的 allowed_origins 是否包含本扩展 ID）',
    errorHostExited: 'HaneHana 宿主已退出（应用可能正在关闭）',
    errorHostFailed: '无法与 HaneHana 宿主通信',
    errorRejected: 'HaneHana 拒绝了这条链接：{error}',
    errorUnknown: '投递失败：{error}',
    errorBadResponse: 'HaneHana 返回了无法识别的结果',

    /* ---------- 扩展 ID 自检 ---------- */
    expectedExtensionId: 'jjoapnhpnedocdkfffpiccdehollooab',
    hostName: 'com.lxfebd.hanehana',
    idMismatchTitle: '扩展 ID 与宿主清单不一致',
    idMismatchBody:
      '当前扩展 ID 是 {actual}，宿主清单允许的是 {expected}，native messaging 会被浏览器拒绝。请让宿主清单与实际扩展 ID 对齐。',

    /* ---------- 杂项 ---------- */
    unknownFilename: '未命名',
    queuedNote: '应用启动后会自动接手这条链接。',
    destLabel: '保存位置：{path}',
    noFilename: '文件名由 HaneHana 推断',
  }

  /**
   * 填模板：format('{a} 与 {b}', { a: 'x', b: 'y' }) → 'x 与 y'
   * 没给出的占位符原样保留，方便一眼看出漏填。
   */
  HN_STRINGS.format = function format(template, vars) {
    if (typeof template !== 'string') return ''
    return template.replace(/\{(\w+)\}/g, function (whole, key) {
      const v = vars ? vars[key] : undefined
      return v === undefined || v === null ? whole : String(v)
    })
  }

  root.HN_STRINGS = HN_STRINGS

  /* 仅供 Node 侧单测/脚本取用；浏览器里没有 module。 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HN_STRINGS
  }
})(typeof globalThis !== 'undefined' ? globalThis : self)
