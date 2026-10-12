/**
 * 错误文案的用户侧翻译层。
 *
 * 引擎（engine-rs）报上来的是「稳定码 + 参数 + 英文原文」，主进程自己判定的失败
 * 只有一句中文原文。两者对用户都不够：用户需要知道的是**下一步该做什么**——
 * 是该等、该重试，还是该回站点重新点一次下载。
 *
 * 所以这里把每条错误拆成两句话：
 *   title  —— 发生了什么（放在任务行副标题里，必须短）
 *   advice —— 用户下一步做什么（放在详情卡和系统通知里）
 *
 * 查表顺序是「码优先、原文兜底」：
 *   1. 有码就查 codeRules（契约，引擎改文案不影响界面）；
 *   2. 没码（主进程自产的失败）或码不认识，才拿原文去过 rules 正则；
 *   3. 都不中才回落 unknownTitle，并且永远保留原文——翻译是为了让人看懂，
 *      不是为了把信息藏起来。排查问题时还是要能看到引擎原话。
 */

import type { ErrorParams } from './types'

export interface ErrorExplanation {
  /** 一句话说明发生了什么，不含技术黑话 */
  title: string
  /** 用户下一步该做什么。空串表示无需额外提示 */
  advice: string
  /** 引擎/主进程的原始文案 */
  raw: string
}

const UNKNOWN_TITLE = '下载中断'
const UNKNOWN_ADVICE = '点「重试」再下一次；一直失败请把下面这行原文发给开发者。'

/** 顺序敏感：更具体的模式必须排在前面（先 "on every attempt" 再裸 "ignored Range"）。 */
const rules: { test: RegExp; title: string; advice: string }[] = [
  // ---- 链接本身的凭据/有效期问题（galgame 站最常见的失败） ----
  {
    test: /\bhttp (401|403)\b/,
    title: '服务器拒绝访问（需要登录或链接已过期）',
    advice: '回到游戏站重新点一次下载，别用复制的旧链接。',
  },
  { test: /\bhttp 404\b/, title: '链接指向的文件不存在了', advice: '这个直链已经失效，回站点换一个镜像重新下载。' },
  { test: /\bhttp 410\b/, title: '资源已被站点删除', advice: '换一个下载源。' },
  {
    test: /\bhttp 429\b/,
    title: '被站点限速了（短时间请求太多）',
    advice: '等几分钟再点重试，或者先把并发任务数调低。',
  },
  { test: /\bhttp 416\b/, title: '服务器兑现不了它声明的字节区间', advice: '这条链接不稳定，换一个镜像重试。' },
  {
    test: /\bhttp 4[0-9]{2}\b/,
    title: '站点拒绝了这次请求',
    advice: '回游戏站重新点一次下载；持续如此说明这个镜像不可用。',
  },
  { test: /\bhttp 5[0-9]{2}\b/, title: '站点服务器出错', advice: '多半是对方临时故障，过一会儿点重试。' },

  // ---- Range / 分段能力协商（引擎侧自愈，但仍要让人看懂） ----
  {
    test: /range request on every attempt/i,
    title: '这台服务器不支持分段下载',
    advice: '把线程数调到 1 再重试即可正常下载。',
  },
  { test: /ignored range/i, title: '服务器无视了分段请求', advice: '引擎会自动退回单线程续传，稍等即可。' },
  {
    test: /range not starting at/i,
    title: '服务器返回的数据段和请求对不上',
    advice: '为防止写坏文件已中止，点重试会重新校验。',
  },

  // ---- 传输中断 ----
  {
    test: /truncated.*every attempt|server truncated/i,
    title: '服务器每次都少发数据，链接不可靠',
    advice: '换一台镜像重新下载，这里重试通常没用。',
  },
  { test: /truncated/i, title: '传到一半被掐断了', advice: '网络或站点不稳定，会自动重连续传。' },
  { test: /did not reply within/i, title: '服务器迟迟不响应', advice: '对方过载或你已断网，检查网络后点重试。' },
  { test: /read timeout/i, title: '连接长时间没有数据', advice: '站点速度慢或掉线，会自动重试。' },

  // ---- 内容完整性（字节都到齐了，但不是那份文件） ----
  {
    test: /checksum mismatch/i,
    title: '文件内容和站点给的校验和对不上',
    advice:
      '下下来的不是服务器那一份：常见于代理/加速节点改了内容，或站点自己换了文件。请用「重新下载」换一个镜像，别用「继续」——继续只会把同一份错的东西接着下完。已下载的文件保留在原处。',
  },
  {
    test: /unsupported checksum|unknown checksum/i,
    title: '这个校验和算法引擎认不出来',
    advice: '目前支持 MD5 / SHA-1 / SHA-256。把任务里的校验和改成其中一种（或直接贴十六进制串）再重试。',
  },

  // ---- 解析 / 目标文件 ----
  {
    test: /no file size/i,
    title: '服务器不肯告诉文件多大',
    advice: '这种链接会按单线程整份下载，进度条只显示已下大小、没有百分比，属正常现象。',
  },
  {
    test: /os error 112|not enough space|no space left|磁盘空间不足/i,
    title: '磁盘空间不足',
    advice: '清理磁盘或把下载目录换到空间更大的盘，再点「继续下载」——已下好的部分会接着用，不会重下。',
  },
  {
    test: /os error 5\b|permission denied|access denied/i,
    title: '没有权限写入目标位置（或文件正被占用）',
    advice: '关掉正在使用该文件的程序，或把下载目录换到一个可写的位置。',
  },
  {
    test: /os error 36|name too long/i,
    title: '文件路径太长，系统放不下',
    advice: '把下载目录改到更浅的路径，例如 D:\\games。',
  },
  {
    test: /os error 123|invalid (argument|data)|filename/i,
    title: '文件名或路径不合法',
    advice: '新建任务时手动改一下保存的文件名。',
  },
  {
    test: /rename failed/i,
    title: '下完了但没能改成正式文件名',
    advice: '目标文件正被占用（比如杀毒软件在扫），关掉它再点重试。',
  },
  { test: /seek failed/i, title: '断点位置写不进文件', advice: '删掉本任务的半截文件后重新下载。' },
  { test: /open part/i, title: '打不开临时下载文件', advice: '检查下载目录是否可写、磁盘是否满了。' },

  // ---- 网络与地址 ----
  // 代理相关的两种来源都要认：引擎报 `invalid proxy url`（填的串 reqwest 解析不了），
  // 主进程报「代理配置没能生效」（系统代理解析失败）。都不该被兜底成「下载中断」。
  {
    test: /invalid proxy url|代理配置没能生效|proxy url/i,
    title: '代理设置没能生效',
    advice: '打开设置 → 网络，检查代理地址（例：http://127.0.0.1:7890）。清空则跟随系统代理。',
  },
  {
    test: /dns|failed to lookup|name (does not|resolution)/i,
    title: '域名解析不了（地址写错或 DNS 故障）',
    advice: '确认链接是否完整；换了网络就重试。',
  },
  {
    test: /connection refused|tcp connect error|connect failure|client::connect|TcpStream::connect/i,
    title: '连不上服务器（或代理没开）',
    advice: '换镜像或稍后重试；如果设置里填了代理，先确认代理进程真的在跑。',
  },
  {
    test: /certificate|invalid peer|i\/o error.*tls|ssl/i,
    title: 'HTTPS 证书校验没过',
    advice: '站点证书有问题或被网关劫持，确认网络环境后重试。',
  },
  {
    test: /too many redirects|redirect|302\b/i,
    title: '链接反复跳转，取不到文件',
    advice: '这种地址需要登录态，请在浏览器里登录该站后重新点下载。',
  },
  {
    test: /\bhttp 3\d{2}\b/,
    title: '链接反复跳转，取不到文件',
    advice: '这种地址通常需要登录态，请在浏览器里登录后重新下载。',
  },
  {
    test: /error sending request|error decoding response body|connection closed|connection reset|broken pipe|connection reset by peer|io error/i,
    title: '网络传输中断',
    advice: '会自动重连续传；持续失败就换个网络再试。',
  },

  // ---- 引擎自身（几乎只可能是打包/进程问题） ----
  {
    test: /bad json|unknown cmd|stdin read error/i,
    title: '下载引擎通信异常',
    advice: '重启 HaneHana。如果每次都是这样，请把日志 ~/.hanehana/.engine-stderr.log 发给开发者。',
  },
  {
    test: /engine .* not found|未找到.*引擎|没找到下载引擎|安装包里没带下载引擎/i,
    title: '没有安装下载引擎',
    advice: '这份安装包缺 fastdrop-engine.exe，请重新安装完整版本。',
  },
]

const RETRY_MIRROR = '换一个镜像重新下载；这条链接本身有问题，原地重试通常没用。'

/**
 * 引擎稳定码 → 文案。码是跨语言契约（engine-rs 里 `FetchErr::code`），
 * 原文只是排查凭据：引擎换个措辞，用户看到的话不该跟着变。
 *
 * `http_status` 不在表里——它的文案取决于具体状态码，见 explainByCode。
 */
const codeRules: Record<string, { title: string; advice: string }> = {
  // ---- 网络与地址 ----
  proxy_invalid: {
    title: '代理设置没能生效',
    advice: '打开设置 → 网络，检查代理地址（例：http://127.0.0.1:7890）。清空则跟随系统代理。',
  },
  client_build_failed: { title: '下载引擎建不起网络连接', advice: '重启 HaneHana；仍然如此说明安装不完整，请重装。' },
  dns: { title: '域名解析不了（地址写错或 DNS 故障）', advice: '确认链接是否完整；换了网络就重试。' },
  tls: { title: 'HTTPS 证书校验没过', advice: '站点证书有问题或被网关劫持，确认网络环境后重试。' },
  connect_refused: {
    title: '连不上服务器（或代理没开）',
    advice: '换镜像或稍后重试；如果设置里填了代理，先确认代理进程真的在跑。',
  },
  redirect_loop: {
    title: '链接反复跳转，取不到文件',
    advice: '这种地址通常需要登录态，请在浏览器里登录该站后重新点下载。',
  },
  request_failed: { title: '网络传输中断', advice: '会自动重连续传；持续失败就换个网络再试。' },
  no_reply: { title: '服务器迟迟不响应', advice: '对方过载或你已断网，检查网络后点重试。' },
  read_timeout: { title: '连接长时间没有数据', advice: '站点速度慢或掉线，会自动重试。' },

  // ---- Range / 分段协商 ----
  unexpected_206: { title: '服务器对整份请求回了区间应答', advice: RETRY_MIRROR },
  range_ignored: { title: '服务器无视了分段请求', advice: '引擎会自动退回单线程续传，稍等即可。' },
  range_ignored_every_attempt: { title: '这台服务器不支持分段下载', advice: '把线程数调到 1 再重试即可正常下载。' },
  range_mismatch: { title: '服务器返回的数据段和请求对不上', advice: '为防止写坏文件已中止，点重试会重新校验。' },

  // ---- 传输中断 ----
  truncated: { title: '传到一半被掐断了', advice: '网络或站点不稳定，会自动重连续传。' },
  truncated_every_attempt: { title: '服务器每次都少发数据，链接不可靠', advice: RETRY_MIRROR },

  // ---- 磁盘与文件 ----
  no_space: {
    title: '磁盘空间不足',
    advice: '清理磁盘或把下载目录换到空间更大的盘，再点「继续下载」——已下好的部分会接着用，不会重下。',
  },
  permission_denied: {
    title: '没有权限写入目标位置（或文件正被占用）',
    advice: '关掉正在使用该文件的程序，或把下载目录换到一个可写的位置。',
  },
  name_too_long: { title: '文件路径太长，系统放不下', advice: '把下载目录改到更浅的路径，例如 D:\\games。' },
  invalid_filename: { title: '文件名或路径不合法', advice: '新建任务时手动改一下保存的文件名。' },
  part_io: {
    title: '读写临时下载文件失败',
    advice: '检查下载目录是否可写、磁盘是否满了；仍不行就删掉本任务的半截文件重新下载。',
  },
  rename_failed: {
    title: '下完了但没能改成正式文件名',
    advice: '目标文件正被占用（比如杀毒软件在扫），关掉它再点重试——已下载的部分不会白费。',
  },

  // ---- 内容完整性 ----
  checksum_mismatch: {
    title: '文件内容和站点给的校验和对不上',
    advice:
      '下下来的不是服务器那一份：常见于代理/加速节点改了内容，或站点自己换了文件。请用「重新下载」换一个镜像，别用「继续」——继续只会把同一份错的东西接着下完。已下载的文件保留在原处。',
  },
  checksum_verify_failed: {
    title: '校验和没能算完（文件读不出来）',
    advice: '文件可能已被移动、删除或被其他程序占用。确认后点重试。',
  },
  unsupported_checksum: {
    title: '这个校验和算法引擎认不出来',
    advice: '目前支持 MD5 / SHA-1 / SHA-256。把任务里的校验和改成其中一种（或直接贴十六进制串）再重试。',
  },

  // ---- 引擎协议（几乎只可能是打包/进程问题） ----
  unknown_cmd: {
    title: '下载引擎通信异常',
    advice: '重启 HaneHana。如果每次都是这样，请把日志 ~/.hanehana/.engine-stderr.log 发给开发者。',
  },
  bad_json: {
    title: '下载引擎通信异常',
    advice: '重启 HaneHana。如果每次都是这样，请把日志 ~/.hanehana/.engine-stderr.log 发给开发者。',
  },
  stdin_read_error: {
    title: '下载引擎通信异常',
    advice: '重启 HaneHana。如果每次都是这样，请把日志 ~/.hanehana/.engine-stderr.log 发给开发者。',
  },

  // ---- 主进程自产的失败（引擎压根没参与） ----
  // advice 取自 params.hint：开发态是「去 cargo build」，安装态是「重装」，
  // 一句固定文案盖不住两种情况。
  engine_missing: { title: '下载引擎不可用', advice: '' },
  engine_spawn_failed: {
    title: '下载引擎没能启动',
    advice: '重启 HaneHana；反复出现请把日志 ~/.hanehana/.engine-stderr.log 发给开发者。',
  },
  engine_unavailable: {
    title: '下载引擎进程不可用',
    advice: '这个任务的引擎进程已经退出。点「重试」会重新拉起它，断点保留。',
  },
  engine_hang: {
    title: '下载引擎没有响应',
    advice: '引擎进程在准备阶段卡住了，已自动停止。点「继续下载」会重新拉起它，断点保留。',
  },
  proxy_resolve_failed: {
    title: '代理设置没能生效',
    advice: '打开设置 → 网络，检查代理地址（例：http://127.0.0.1:7890）。清空则跟随系统代理。',
  },
}

function matchRules(text: string): { title: string; advice: string } | null {
  for (const r of rules) {
    if (r.test.test(text)) return { title: r.title, advice: r.advice }
  }
  return null
}

function explainByCode(code: string, params: ErrorParams, raw: string): { title: string; advice: string } | null {
  const obj = params && typeof params === 'object' ? params : null
  if (code === 'http_status') {
    // 403 和 500 的处置完全相反，一个码配不了一句话。把 params.status 拼回
    // `http 403` 这种串去过原文规则表——那 8 条状态码分类已经写好了，不抄第二遍。
    const st = Number(obj ? obj.status : NaN)
    return matchRules(Number.isFinite(st) && st > 0 ? `http ${st}` : raw)
  }
  const rule = codeRules[code]
  if (!rule) return null
  if (code === 'engine_missing') {
    // 「怎么修」由主进程按开发态/安装态写好放在 params.hint 里，界面照抄。
    const hint = obj ? String(obj.hint ?? '') : ''
    return { title: rule.title, advice: hint || raw }
  }
  return rule
}

/**
 * 把一条错误翻译成用户看得懂的两句话。
 *
 * @param raw    原文（引擎英文原话，或主进程自己写的中文）
 * @param code   引擎给的稳定错误码；主进程自产的失败没有码，传空即可
 * @param params 码的参数，目前只有 `http_status` 真的要用（取 status）
 * @returns 没有任何错误信息时返回 null
 */
export function explainError(
  raw: string | null | undefined,
  code?: string | null,
  params?: ErrorParams,
): ErrorExplanation | null {
  const text = String(raw ?? '').trim()
  const c = String(code ?? '').trim()
  if (!text && !c) return null
  const hit = (c ? explainByCode(c, params ?? null, text) : null) ?? (text ? matchRules(text) : null)
  if (hit) return { title: hit.title, advice: hit.advice, raw: text }
  // 兜底也要有 advice：未知错误最有用的一句就是「先重试，不行再看原文」。
  return { title: UNKNOWN_TITLE, advice: UNKNOWN_ADVICE, raw: text }
}

/** 任务行副标题用的短句式：说发生了什么 + 一句「下一步」（advice 截断防撑爆行）。 */
export function errorLine(raw: string | null | undefined, code?: string | null, params?: ErrorParams): string {
  const e = explainError(raw, code, params)
  if (!e) return ''
  const tip = e.advice.trim()
  if (!tip) return e.title
  // 按码点截断：String.slice 按 UTF-16 单元切，advice 里有 emoji/生僻字
  // （代理对）时会把一个字符劈成两半，行尾出一个 U+FFFD 乱码。
  const short = [...tip].length > 40 ? [...tip].slice(0, 40).join('') + '…' : tip
  return `${e.title} · ${short}`
}
