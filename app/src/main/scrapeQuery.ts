/**
 * 刮削搜索词清洗（零依赖、可独立测试）。
 *
 * 为什么需要它（实测 2026-10-16，直接打 VNDB v2 的 search 过滤器）：
 * VNDB 的 ['search','=',q] 是「精确标题匹配」，对污染目录名一律 0 命中——
 *   【Key】Clannad [EX](完全版)      → 0    清洗成 Clannad      → 命中 CLANNAD
 *   サノバウィッチ -Sunna-【DL版】    → 0    清洗成 サノバウィッチ  → 命中 Sanoba Witch
 *   ATRI -My Dear Moments-（中文版）  → 0    剥括号              → 精确命中
 * galgame 的「目录名」几乎都是这种带汉化组 / 版本 / DL版 / 中文版的脏串，
 * 拿它原样去搜＝必然空手而归，批量刮削就「什么都没发生」。
 *
 * 策略：把原词展开成一条「由具体到宽泛」的候选梯，逐个搜，第一个非空即返回。
 * 干净标题第一发就命中（不多花请求）；只有原来那发空了才逐级放宽。
 * 大小写不敏感、中文标题可命中（实测 缘之空 → Yosuga no Sora），无需自己转写。
 */

/** 成对括号：汉化组、DL版、完全版、平台标记都塞在里面。 */
const BRACKET_PAIRS: [string, string][] = [
  ['[', ']'],
  ['【', '】'],
  ['(', ')'],
  ['（', '）'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['<', '>'],
]

/** 版本 / 汉化 / 发行标记尾缀：清洗时整体剥掉（实测这些词 VNDB 标题里没有）。
 * 拉丁词必须带 \b——无界定时 'Demongirls'.replace(/demo/g) 会烂成 'ngirls'，
 * 产生一个必然搜不到、还可能撞噪音的候选词。 */
const SUFFIX_WORDS =
  /(全年龄版|全年龄|成人版|DL版|下载版|中文版|汉化版|汉化|移植版|重置版|重制版|复刻版|完整版|加强版|限定版|初回版|通常版|同人|\bfan disc\b|\bdemo\b|体験版|\bver\.?\b|\bv\d+(?:\.\d+)*\b)/gi

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 反复剥掉成对括号里的内容（含嵌套外层的多种括号）。 */
export function stripBrackets(s: string): string {
  let out = s
  for (let guard = 0; guard < 12; guard++) {
    let changed = false
    for (const [l, r] of BRACKET_PAIRS) {
      const re = new RegExp(`${escapeRe(l)}[^${escapeRe(r)}]*${escapeRe(r)}`, 'g')
      if (re.test(out)) {
        out = out.replace(re, ' ')
        changed = true
      }
    }
    if (!changed) break
  }
  return out
}

/** 按第一个分隔符截主标题（副标题常在 -/~/: 之后；Muv-Luv 这类连字符靠梯级顺序兜底）。 */
function firstSegment(s: string): string {
  const idx = s.search(/[-–—~〜:：]/)
  return idx > 0 ? s.slice(0, idx) : ''
}

/** 逐词从尾部裁剪：每次砍掉最后一个空白分隔的词，最多 maxCuts 次。
 * 裁剪出的候选至少 3 字符——实测「VR Japanese → VR」命中 8 条全部无关，
 * 两字母碎词的命中基本都是噪音，宁可如实报「没找到」。 */
function tailTruncations(s: string, maxCuts: number): string[] {
  const words = s.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 1; i <= maxCuts && words.length - i >= 1; i++) {
    const cut = words.slice(0, words.length - i).join(' ')
    if (cut.length >= 3) out.push(cut)
  }
  return out
}

/** 规整空白、去首尾标点尾巴。 */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[.\-_~～・、,，。]+$/u, '').trim()
}

/**
 * 搜索词候选梯：去重、限长（最多 maxVariants 条），保持「原词→剥括号→剥尾缀
 * →截主标题→逐词裁剪」的具体→宽泛顺序。干净标题的首条就能命中，宽的只兜底。
 */
export function queryLadder(title: string, maxVariants = 5): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string): void => {
    const t = tidy(raw)
    // 单字符/空串没有检索意义，且容易命中一堆无关条目，直接不收
    if (t.length < 2) return
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }

  push(title)
  const stripped = stripBrackets(title)
  push(stripped)
  const noSuffix = stripped.replace(SUFFIX_WORDS, ' ')
  push(noSuffix)
  for (const base of [noSuffix, stripped, title]) {
    const seg = firstSegment(base)
    if (seg) push(seg)
  }
  // 逐词裁剪兜底（对 Rewrite 10th anniversary+ 这种，末级裁到 Rewrite 才命中）
  for (const base of [noSuffix, stripped]) {
    for (const cut of tailTruncations(base, 3)) push(cut)
  }
  return out.slice(0, maxVariants)
}
