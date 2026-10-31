/**
 * 刮削候选打分（纯逻辑，零 vue 依赖，可被 node --test 直接单测）。
 *
 * 2026-10-31 实测根因：封面牛头不对马嘴不是下载链路的问题，是「选候选」选错——
 * pickAuto 只认标题完全相等且唯一最高分，不校验开发商/年份，也不要求跨源确认；
 * YMGal 外传 chineseName 撞本体、VNDB 同名作、清洗梯裁词撞车都会误触发自动应用。
 * 这里把打分/互验收紧：
 *  - 矛盾淘汰：候选年份与已有相差 >1 年、或双方开发商都非空且归一化不等 → 0 分；
 *  - 清洗梯放宽词命中的候选（queryStep>0）封顶 75，永远到不了自动档（>=80）；
 *  - pickAuto 自动应用还要求「跨源互验」：同 主标题+开发商 的 key 出现在 >=2 个源。
 */
import type { Game, ScrapeCandidate } from './types.js'

/**
 * 标题归一：小写 + 去空白/标点，保留 Unicode 字母数字。
 * 不能用 \W：JS 默认 \W=[^A-Za-z0-9_]，会把中文/日文标题整个剥成空串。
 */
export function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 从 yyyy-mm-dd 之类的日期串里抠 4 位年份；没有返回 null。 */
function yearOf(s: string | undefined): number | null {
  if (!s) return null
  const m = /(\d{4})/.exec(s)
  return m ? Number(m[1]) : null
}

/**
 * 候选与游戏已有元数据是否矛盾。只在「双方都有值」时校验——
 * 已有字段为空说明还没刮过/没填过，拿空值去否定候选会把正确答案一并杀掉。
 */
export function contradicts(g: Game, c: ScrapeCandidate): boolean {
  const gy = yearOf(g.releaseDate)
  const cy = yearOf(c.releaseDate)
  if (gy != null && cy != null && Math.abs(gy - cy) > 1) return true
  const gd = g.developer ? normTitle(g.developer) : ''
  const cd = c.developer ? normTitle(c.developer) : ''
  if (gd && cd && gd !== cd) return true
  return false
}

/** 单候选对游戏标题的置信分（0–100）。>=80 才可能进自动应用档。 */
export function scoreCandidate(g: Game, c: ScrapeCandidate): number {
  if (contradicts(g, c)) return 0
  const gt = normTitle(g.rawTitle || g.title)
  if (!gt) return 0
  const forms = [c.title, c.titleNative, ...(c.aliases ?? [])].filter((x): x is string => !!x).map(normTitle)
  if (!forms.length) return 10
  let s: number
  if (forms.some((f) => f === gt)) s = 100
  else if (forms.some((f) => f.includes(gt) || gt.includes(f))) s = 75
  else {
    // 公共前缀 >= 半长：目录名常带章节号，仍可对齐
    const hit = forms.some((f) => {
      const n = Math.min(f.length, gt.length, Math.ceil(gt.length / 2))
      return n >= 3 && f.slice(0, n) === gt.slice(0, n)
    })
    s = hit ? 55 : 10
  }
  // 一致性微调：开发商一致 +3、发行年一致 +3，封顶 100——只调排序，不升档
  const gd = g.developer ? normTitle(g.developer) : ''
  const cd = c.developer ? normTitle(c.developer) : ''
  if (gd && cd && gd === cd) s = Math.min(100, s + 3)
  const gy = yearOf(g.releaseDate)
  const cy = yearOf(c.releaseDate)
  if (gy != null && cy != null && gy === cy) s = Math.min(100, s + 3)
  // 清洗梯放宽词命中的候选封顶 75：裁词撞同名作风险高，不给自动档
  if ((c.queryStep ?? 0) > 0) s = Math.min(s, 75)
  return s
}

/** 跨源互验 key：主标题归一 + 开发商归一。同名不同社的作品 key 不同，不会互相壮胆。 */
export function crossKey(c: ScrapeCandidate): string {
  return normTitle(c.title) + '|' + (c.developer ? normTitle(c.developer) : '')
}

/**
 * 从搜索结果选自动应用项；null = 进待确认列表。
 * 自动应用需要同时满足：最高分 >=80、第二名不同分、跨源互验（同 key 出现 >=2 个源）。
 * 单源唯一 100 也只进待确认——实测单源 100 误判率不可接受（eden/YMGal 撞车案例）。
 */
export function pickAuto(g: Game, results: ScrapeCandidate[]): ScrapeCandidate | null {
  if (!results.length) return null
  const scored = results.map((c) => ({ c, s: scoreCandidate(g, c) })).sort((a, b) => b.s - a.s)
  const best = scored[0] as { c: ScrapeCandidate; s: number }
  if (best.s < 80) return null
  // 同分处理：同分者若 crossKey 不同（两个不同游戏都 100）→ 真冲突不猜；
  // 同 key 同分正是「同一游戏在多源同现」，交给下面的跨源互验放行。
  const top = scored.filter((x) => x.s === best.s)
  const key = crossKey(best.c)
  if (top.some((x) => crossKey(x.c) !== key)) return null
  // 跨源互验：同 主标题+开发商 的 key 出现在 >=2 个源才自动应用；单源 100 进待确认
  const sources = new Set(results.filter((r) => crossKey(r) === key).map((r) => r.provider))
  if (sources.size < 2) return null
  return best.c
}

/** 给 UI 用：结果列表里的最高分候选 key（provider::id），用于置顶高亮。分最高者若有多个同分，返回空串不误导。 */
export function bestCandidateKey(g: Game, results: ScrapeCandidate[]): string {
  if (!results.length) return ''
  let best: ScrapeCandidate | null = null
  let bs = -1
  let tie = false
  for (const r of results) {
    const s = scoreCandidate(g, r)
    if (s > bs) { bs = s; best = r; tie = false }
    else if (s === bs && best) tie = true
  }
  if (!best || tie || bs < 55) return ''
  return best.provider + '::' + best.id
}