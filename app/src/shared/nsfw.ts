/**
 * NSFW 游戏判断（ReinaManager 类竞品的遮盖功能）。
 *
 * 依据：刮削写入的 tags（VNDB 的内容标签如 "Sexual Content"）——这些标签
 * 是 VNDB 官方内容分级的一部分，比关键词猜测可靠。中文源（YMGal/Bangumi）
 * 若无 VNDB tag，用「成人/18禁/成人向」类关键词兜底。
 *
 * 纯函数、零依赖，放 shared 供主进程/渲染层复用。当前实现只做「是否遮盖」，
 * 不写设置开关（默认遮盖命中的游戏）；后续要开关时再加 Settings 字段。
 */

/** VNDB 成人内容标签（官方 tag，出现在刮削写入的 tags 里）。 */
const NSFW_VNDB_TAGS = [
  'sexual content',
  'nudity',
  'erotica',
  'adult',
  'hentai',
  'pornographic',
  'lolicon',
  'shotacon',
  'incest',
  'nukige',
  'sex',
] as const

/** 中文兜底关键词（YMGal/Bangumi 无 VNDB tag 时用）。 */
const NSFW_ZH_KEYWORDS = ['成人', '18禁', '18禁', 'r18', '成人向', '18+', 'r-18', '拔作'] as const

/** 某款游戏是否判定为 NSFW（命中任一标签/关键词即遮盖）。 */
export function isNsfwGame(tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return false
  const lower = tags.map((t) => t.toLowerCase())
  if (lower.some((t) => (NSFW_VNDB_TAGS as readonly string[]).some((k) => t === k || t.includes(k)))) return true
  return lower.some((t) => (NSFW_ZH_KEYWORDS as readonly string[]).some((k) => t.includes(k)))
}
