/**
 * 存档/WebDAV 纯规则（零依赖，可独立测试）。
 *
 * 从 saves.ts 提出：saves.ts 顶部有 dataDir() 副作用（模块加载时执行），
 * 直接 import 会拖起整条 fs/electron 依赖链，纯规则就没法单测了。
 * 这里只存「判定 + 校验」逻辑，不做任何 IO。
 */
// ---------------------------------------------------------------- 存档识别

const SAVE_EXT_RE = /^.*\.(dat|sav|save|srm|cfg|ini|xml|json|txt|bin|rom|sna|slt|sgo|sfs|qst|mem|rec)$/i
/** 游戏本体/媒体文件扩展名。collectTree 遍历时用它跳过本体（收一切非本体文件）。 */
export const bigBodyRe =
  /\.(exe|dll|pak|pck|wad|bin|iso|mp4|avi|webm|png|jpg|jpeg|bmp|ogg|wav|flac|mp3|zip|7z|rar|gz|cab)$/i

/**
 * 存档文件识别契约：名字命中存档扩展名（含 .dat）、且不是本体/媒体文件。
 * 导出给测试钉死：改漏一个扩展名 = 该类型的存档从此不进备份。
 */
export function isSaveFile(name: string): boolean {
  if (bigBodyRe.test(name)) return false
  return SAVE_EXT_RE.test(name) || name.endsWith('.dat')
}

// ---------------------------------------------------------------- WebDAV 地址校验

/**
 * 校验 WebDAV 地址协议：Basic 凭据是 base64 明文编码，走 http:// 等于把
 * 密码裸奔在网络上。只放行 https，例外仅本机回环（localhost/127.0.0.1，
 * 自建测试服场景）。返回中文错误原因，null = 通过。
 */
export function webdavUrlError(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'WebDAV 地址不是合法 URL'
  }
  if (u.protocol !== 'https:') {
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return null
    return 'WebDAV 同步要求 https（Basic 凭据明文传输，仅允许本机测试的 http）'
  }
  return null
}

// ---------------------------------------------------------------- 路径归一

/** 本地相对路径 → 远端相对路径键（Windows 反斜杠归一成正斜杠）。 */
export function relToRemote(rel: string): string {
  return rel.split('\\').join('/')
}
