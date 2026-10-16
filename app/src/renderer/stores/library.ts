/**
 * 游戏库领域 store。
 *
 * 持有游戏列表 + 当前选中 + 搜索/分类/视图 + 刮削/扫描对话框状态 + 运行中集合。
 * 所有对主进程的游戏库调用都经过这里，组件不直接碰 window.hh。
 */
import { reactive, computed, ref, shallowRef, watch } from 'vue'
import type { Game, ScrapeCandidate } from '../../shared/types'

export const library = reactive({
  games: [] as Game[],
  loading: false,
  error: '',
  selectedId: '',
  keyword: '',
  categoryFilter: '',
  /** 只看收藏 */
  favOnly: false,
  /** 智能列表（预设动态筛选），'' = 不启用 */
  smartList: '' as SmartListId,
  /** 元数据聚合筛选（G12）：点开系列/开发商后只看同系列/同开发商，'' = 关闭 */
  metaKey: '' as 'series' | 'developer' | '',
  metaValue: '',
  /** 批量选择集合（进入多选模式后收集） */
  selection: [] as string[],
  /** 多选模式开关 */
  selectMode: false,
  view: 'grid' as 'grid' | 'list',
  scrapeOpen: false,
  scrapeResults: [] as ScrapeCandidate[],
  scrapeWarnings: [] as string[],
  scrapeLoading: false,
  scrapeTargetId: '',
  scrapeQuery: '',
  scanOpen: false,
  scanRunning: false,
  /** 手动编辑弹窗（单个游戏信息编辑） */
  editOpen: false,
  editTargetId: '',
  /** 存档备份弹窗（G1）：对当前选中游戏 */
  backupOpen: false,
  /** 搜索正则模式（G19）：true 时搜索词按正则编译匹配 */
  searchRegex: false,
  runningIds: new Set<string>(),
})

// ---------------------------------------------------------------- 智能列表预设
// 静态分类要人维护，智能列表是动态规则集（Playnite 式 smart filter）：规则随
// 库状态实时求值，用户零维护。「收藏」单独放在 favOnly（侧栏一键切）。
export type SmartListId = '' | 'recentPlayed' | 'recent30' | 'played10h' | 'unrated' | 'unplayed'

export interface SmartListDef {
  id: SmartListId
  label: string
  test: (g: Game) => boolean
}

const DAY = 86400000

export const SMART_LISTS: SmartListDef[] = [
  { id: '', label: '全部游戏', test: () => true },
  // 最近游玩放第一位：日常最高频的入口是「昨天玩到哪」，不是「全部」。
  // 只收 30 天内玩过的，避免列表里混着一年前的单次记录。
  { id: 'recentPlayed', label: '最近玩过', test: (g) => !!g.lastPlayed && Date.now() - g.lastPlayed <= 30 * DAY },
  { id: 'recent30', label: '近 30 天入库', test: (g) => Date.now() - g.addedAt <= 30 * DAY },
  { id: 'played10h', label: '攻略中（>10h）', test: (g) => g.playMs > 10 * 3600000 },
  { id: 'unrated', label: '未评分', test: (g) => !g.rating },
  { id: 'unplayed', label: '还没玩过', test: (g) => g.playMs <= 0 },
]

export function smartListTest(id: SmartListId, g: Game): boolean {
  const def = SMART_LISTS.find((d) => d.id === id)
  return def ? def.test(g) : true
}

// ---------------------------------------------------------------- 搜索防抖 + 索引
// 10k 游戏规模下每键入一次就全量 filter 会掉帧；索引在 refreshGames 时一次性
// 构建（title/rawTitle/titleNative/tags 全小写），过滤只跑一次 includes 判断。
// 输入侧再加 120ms 防抖：手感几乎无感，能把 300ms 内的连击合成一次过滤。

/** 搜索输入生效值（防抖后的）；组件绑 keyword，这里读 debouncedKeyword。 */
export const debouncedKeyword = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => library.keyword,
  (kw) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      debouncedKeyword.value = kw
    }, 120)
  },
)

/**
 * 索引随 games 数组更新；只在 refreshGames/applyScrapeResult 之后重算一次。
 * 去除首尾空白以便精确匹配；字段分开存，按字段搜索（G19）直接查对应项。
 */
const searchIndex = shallowRef<
  { title: string; raw: string; native: string; tags: string; extra: string; dev: string; series: string }[]
>([])

function rebuildIndex(): void {
  searchIndex.value = library.games.map((g) => ({
    title: g.title.toLowerCase(),
    raw: g.rawTitle.toLowerCase(),
    native: (g.titleNative ?? '').toLowerCase(),
    tags: g.tags.join(' ').toLowerCase(),
    extra: [...(g.aliases ?? []), ...(g.series ?? [])].filter(Boolean).join(' ').toLowerCase(),
    dev: (g.developer ?? '').toLowerCase(),
    series: (g.series ?? []).join(' ').toLowerCase(),
  }))
}

/** 字段前缀 → 索引字段名。搜索式 `tag:汉化`、`dev:柚子`、`dev:` 等。 */
const FIELD_PREFIXES: Record<string, keyof typeof fieldKeys> = {
  tag: 'tags',
  dev: 'dev',
  dev_: 'dev',
  series: 'series',
  ser: 'series',
  name: 'title',
  title: 'title',
  orig: 'native',
  native: 'native',
}
const fieldKeys = {
  title: 0,
  raw: 1,
  native: 2,
  tags: 3,
  extra: 4,
  dev: 5,
  series: 6,
} as const

/**
 * G19 搜索匹配。支持：
 *  - 普通模式：空格分词，词序无关（每词命中任一字段即算）；`tag:`/`dev:`/`series:`/`name:`/`orig:` 字段前缀限定字段
 *  - 正则模式：整条输入当作正则编译，匹配任一字段；语法错误返回 false（UI 已提示）
 */
function matchSearch(
  s: { title: string; raw: string; native: string; tags: string; extra: string; dev: string; series: string },
  kw: string,
): boolean {
  const fields = [s.title, s.raw, s.native, s.tags, s.extra, s.dev, s.series]
  // 正则模式：不加任何前缀包裹，直接编译
  if (library.searchRegex) {
    try {
      const re = new RegExp(kw, 'i')
      return fields.some((f) => re.test(f))
    } catch {
      return false
    }
  }
  // 字段前缀：`tag:xxx` → 只在 tags 里找
  const fm = /^(tag|dev|dev_|series|ser|name|title|orig|native):(.*)$/.exec(kw)
  if (fm) {
    const key = FIELD_PREFIXES[fm[1]]
    const needle = fm[2].trim()
    return needle ? s[key].includes(needle) : true
  }
  // 普通模式：空格分词，词序无关（「万华镜 汉化」也能搜到「汉化 万华镜」类条目）
  const terms = kw.split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  return terms.every((t) => fields.some((f) => f.includes(t)))
}

export const filteredGames = computed(() => {
  const idx = searchIndex.value
  const kw = debouncedKeyword.value.trim().toLowerCase()
  const cat = library.categoryFilter
  const fav = library.favOnly
  const smart = library.smartList
  const meta = library.metaKey
  const metaV = library.metaValue
  const out = library.games.filter((g, i) => {
    if (cat && !g.categories.includes(cat)) return false
    if (fav && !g.favorite) return false
    if (smart && !smartListTest(smart, g)) return false
    if (meta) {
      if (meta === 'series' && !(g.series ?? []).includes(metaV)) return false
      if (meta === 'developer' && g.developer !== metaV) return false
    }
    if (!kw) return true
    const s = idx[i]
    if (!s) return false
    return matchSearch(s, kw)
  })
  // 「最近玩过」必须按 lastPlayed 倒序——智能列表默认只过滤不排序，
  // 而「最近」的语义全在顺序上（混在入库顺序里等于没有这个列表）。
  if (smart === 'recentPlayed') {
    out.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
  }
  return out
})

export const selectedGame = computed(() => library.games.find((g) => g.id === library.selectedId))

export const categories = computed(() => {
  const set = new Set<string>()
  for (const g of library.games) for (const c of g.categories) set.add(c)
  return [...set]
})

/** 点系列/开发商 chip：切到聚合视图 */
export function filterByMeta(key: 'series' | 'developer', value: string): void {
  library.metaKey = key
  library.metaValue = value
}

/** 本地镜像变更后让搜索索引跟上：games 数组与 searchIndex 按下标对齐，任一侧改数组都必须重算。 */
export function syncIndexToGames(): void {
  rebuildIndex()
}

export async function refreshGames(): Promise<void> {
  library.loading = true
  try {
    library.games = await window.hh.listGames()
    rebuildIndex()
  } finally {
    library.loading = false
  }
}

export function selectGame(id: string): void {
  library.selectedId = id
}

// ---------------------------------------------------------------- 收藏与多选

export async function toggleFavorite(id: string): Promise<void> {
  const g = library.games.find((it) => it.id === id)
  if (!g) return
  const next = !g.favorite
  // 乐观更新：先改本地镜像，服务端失败再回滚重拉
  g.favorite = next
  syncIndexToGames()
  try {
    const fresh = await window.hh.updateGame(id, { favorite: next })
    if (!fresh) {
      g.favorite = !next
      syncIndexToGames()
      void refreshGames()
    }
  } catch (e) {
    // IPC 本身被拒（主进程未响应）：回滚并提示，不能留着一个没落盘的乐观状态
    g.favorite = !next
    syncIndexToGames()
    library.error = e instanceof Error ? e.message : String(e ?? '')
  }
}

/** 进入/退出多选模式（进入时清空旧选择） */
export function enterSelectMode(on: boolean): void {
  library.selectMode = on
  if (!on) library.selection = []
  else if (!library.selection.includes(library.selectedId) && library.selectedId) {
    library.selection = [library.selectedId]
  }
}

export function toggleSelect(id: string): void {
  const i = library.selection.indexOf(id)
  if (i >= 0) library.selection.splice(i, 1)
  else library.selection.push(id)
}

export function selectAll(): void {
  library.selection = filteredGames.value.map((g) => g.id)
}

export function clearSelection(): void {
  library.selection = []
}

/** 批量更新：每款游戏携带自己的 patch，乐观更新 + 失败回滚。返回是否全部成功。 */
export async function batchUpdate(patches: { id: string; patch: Partial<Game> }[]): Promise<boolean> {
  if (!patches.length) return true
  const before = new Map(library.games.map((g) => [g.id, { ...g }]))
  for (const { id, patch } of patches) {
    const g = library.games.find((it) => it.id === id)
    if (!g) continue
    for (const key of Object.keys(patch) as (keyof Game)[]) {
      const v = patch[key]
      if (v === undefined) continue
      if (key === 'tags' || key === 'categories') {
        ;(g as Record<string, unknown>)[key] = [...(v as string[])]
      } else {
        ;(g as Record<string, unknown>)[key] = v
      }
    }
  }
  try {
    const r = await window.hh.batchUpdateGames(patches)
    if (!r.ok) {
      for (const g of library.games) {
        const old = before.get(g.id)
        if (old) Object.assign(g, old)
      }
      library.error = r.error ?? '批量更新失败'
      syncIndexToGames()
      return false
    }
    syncIndexToGames()
    return true
  } catch (e) {
    for (const g of library.games) {
      const old = before.get(g.id)
      if (old) Object.assign(g, old)
    }
    library.error = e instanceof Error ? e.message : String(e ?? '批量更新失败')
    syncIndexToGames()
    return false
  }
}

export async function batchRemove(ids: string[]): Promise<boolean> {
  library.games = library.games.filter((g) => !ids.includes(g.id))
  syncIndexToGames()
  if (library.selection.length) library.selection = library.selection.filter((id) => !ids.includes(id))
  try {
    const r = await window.hh.batchRemoveGames(ids)
    if (!r.ok) {
      library.error = r.error ?? '批量移除失败'
      void refreshGames()
      return false
    }
    return true
  } catch (e) {
    library.error = e instanceof Error ? e.message : String(e ?? '批量移除失败')
    void refreshGames()
    return false
  }
}

// ---------------------------------------------------------------- 手动编辑

export function openEdit(id: string): void {
  library.editTargetId = id
  library.editOpen = true
}

export async function saveManualEdit(id: string, patch: Partial<Game>): Promise<boolean> {
  let fresh: Game | null = null
  try {
    fresh = await window.hh.updateGame(id, { ...patch, manualEdit: true })
  } catch (e) {
    library.error = e instanceof Error ? e.message : String(e ?? '保存失败')
    return false
  }
  // 主进程错误形状 {ok:false,error} 是真值，不能当 Game 直接入库（会把错误对象写进列表）
  if (!fresh || (fresh as { ok?: boolean }).ok === false) {
    const msg = (fresh as { error?: string } | null)?.error
    library.error = msg || '保存失败'
    return false
  }
  const idx = library.games.findIndex((it) => it.id === id)
  if (idx >= 0) {
    library.games[idx] = fresh
    syncIndexToGames()
  }
  return true
}

/**
 * 通用「更新单款游戏并把返回的新值同步回本地镜像」。
 *
 * 与 saveManualEdit 的区别：它只负责「更新 + 镜像同步」，不做 manualEdit
 * 标记、不在失败时静默——失败统一记 error 并触发全量重拉（服务端可能已经
 * 改了部分字段，本地镜像只能以服务端为准）。DetailPanel 的分类/变体切换
 * 用它，避免每个切换函数各自写一遍「成功替换镜像 / 失败重拉」的样板。
 *
 * 返回 true = 本地镜像已是服务端最新值；false = 已记 error 并触发重拉。
 */
export async function applyPatch(id: string, patch: Partial<Game>): Promise<boolean> {
  let fresh: Game | null = null
  try {
    fresh = await window.hh.updateGame(id, patch)
  } catch (e) {
    library.error = e instanceof Error ? e.message : String(e ?? '保存失败')
    void refreshGames()
    return false
  }
  // 主进程错误形状 {ok:false,error} 是真值，不能当 Game 直接入库（会把错误对象写进列表）
  if (!fresh || (fresh as { ok?: boolean }).ok === false) {
    const msg = (fresh as { error?: string } | null)?.error
    library.error = msg || '保存失败'
    void refreshGames()
    return false
  }
  const idx = library.games.findIndex((it) => it.id === id)
  if (idx >= 0) {
    library.games[idx] = fresh
    syncIndexToGames()
  }
  return true
}

export async function launchGame(id: string): Promise<void> {
  try {
    const r = await window.hh.launchGame(id)
    if (r && r.ok) {
      library.runningIds.add(id)
    } else if (r && r.error) {
      library.error = r.error
    }
  } catch (e) {
    library.error = e instanceof Error ? e.message : String(e ?? '启动失败')
  }
}

/**
 * 运行中状态同步：渲染层 runningIds 只有 add 没有 remove（游戏退出后 UI 永远「运行中」）。
 * 主进程 handleRunning 会清理僵尸条目，这里定时拉取对齐——启动/退出都靠它收敛。
 * 挂载点在 App.vue onMounted；组件不该自己起轮询（重复起多个）。
 */
let runningTimer: ReturnType<typeof setInterval> | null = null
export function startRunningSync(intervalMs = 5000): void {
  if (runningTimer) return
  runningTimer = setInterval(async () => {
    try {
      const list = await window.hh.runningGames()
      const next = new Set(list)
      // 只清不存在的；保留集合引用避免 v-for :key 抖动
      for (const id of library.runningIds) {
        if (!next.has(id)) library.runningIds.delete(id)
      }
      for (const id of list) {
        if (!library.runningIds.has(id)) library.runningIds.add(id)
      }
    } catch {
      // 主进程暂时不可达时静默，下轮再试
    }
  }, intervalMs)
}
export function stopRunningSync(): void {
  if (runningTimer) {
    clearInterval(runningTimer)
    runningTimer = null
  }
}

// ---------------------------------------------------------------- 工具栏动作

export function openScan(): void {
  library.scanOpen = true
}

export function openScrape(gameId: string, query: string): void {
  library.scrapeTargetId = gameId
  library.scrapeQuery = query
  library.scrapeOpen = true
  library.scrapeResults = []
  library.scrapeWarnings = []
  // 搜索只由 ScrapeDialog 的 watch(open) 触发，这里不再额外发一次，避免双重搜索竞态
}

/**
 * 单源失败的中文提示。主进程 handler 抛错时 Electron 会重新包一层
 * "Error invoking remote method '<通道名>': Error: "，原样进 UI 就是一串
 * 英文通道名（实测截图里那条「Error invoking remote method 'hanehana:scrape:
 * search-source'…」，看着像程序坏了）。剥掉外壳只留主进程给的中文原因，
 * 再冠上源名——用户看到「Bangumi：网络不可达」，明确只有这一个源挂了、
 * 另一个源的结果照常在下面。
 */
function sourceWarn(label: string, e: unknown): string {
  let m = e instanceof Error ? e.message : String(e)
  m = m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
  return `${label}：${m || '搜索失败'}`
}

export async function runSearch(query: string): Promise<void> {
  library.scrapeLoading = true
  try {
    // 双源并行、先回先上屏（G20）：不再等最慢源。
    // 实现必须是「每个源各自一回来就落盘」，而不是 Promise.allSettled 等两源
    // 齐回——后者在慢源超时（Bangumi 本机固定 10s）时把快源的 8 条结果压到
    // 10s 后才显示，UI 空转 9 秒多还配一条「网络不可达」警告，观感就是
    // 「刮削没用」。每个源各自 then 立即 push，快源结果秒上屏。
    // 单源失败只进 warnings，不拖累已回来的另一源。
    library.scrapeResults = []
    library.scrapeWarnings = []
    const vndbP = window.hh
      .scrapeSearchSource('vndb', query)
      .then((v) => {
        library.scrapeResults.push(...v.results)
        library.scrapeWarnings.push(...v.warnings)
      })
      .catch((e: unknown) => {
        library.scrapeWarnings.push(sourceWarn('VNDB', e))
      })
    const bgmP = window.hh
      .scrapeSearchSource('bangumi', query)
      .then((v) => {
        library.scrapeResults.push(...v.results)
        library.scrapeWarnings.push(...v.warnings)
      })
      .catch((e: unknown) => {
        library.scrapeWarnings.push(sourceWarn('Bangumi', e))
      })
    // 等两源都结束才收起 loading：期间快源结果已上屏，慢源超时只补充警告
    await Promise.all([vndbP, bgmP])
  } catch (e) {
    library.scrapeWarnings = [e instanceof Error ? e.message : String(e)]
  } finally {
    library.scrapeLoading = false
  }
}

export async function applyScrapeResult(result: ScrapeCandidate): Promise<void> {
  let r: { ok: boolean; error?: string } | null = null
  try {
    // 必须先拆掉 Vue 响应式代理再进 IPC：selected 取自 reactive 的 scrapeResults，
    // 深层 Proxy；Electron 的结构化克隆不认 Proxy，直接 invoke 抛
    // 「An object could not be cloned」——结果搜得到、点「应用选中」却永远写不进库
    // （实测 2026-10-16，正是用户「刮削用不了」的真病根）。
    // structuredClone 也不行：HTML 规范对 Proxy 直接抛 DataCloneError（实测），
    // 且深层 reactive 的嵌套数组同样是 Proxy。JSON 往返穿过取值 trap，出来纯数据
    // ——候选字段全是 JSON 安全类型，往返无损。
    const plain: ScrapeCandidate = JSON.parse(JSON.stringify(result))
    r = await window.hh.scrapeApply(library.scrapeTargetId, plain)
  } catch (e) {
    library.error = e instanceof Error ? e.message : String(e ?? '刮削失败')
    return
  }
  // TS 流分析：try 内赋值在异常路径上保持 null（尽管 catch 已 return），显式判空
  if (!r || !r.ok) {
    library.error = r?.error ?? '刮削失败'
  } else {
    // 单刮确认成功 → 从批量待确认列表摘掉
    batchScrape.pending = batchScrape.pending.filter((p) => p.id !== library.scrapeTargetId)
  }
  await refreshGames()
}

/** 渲染层缩略图 URL：有 thumbPath 才走 hh:// 协议，否则空（组件走占位色）。 */
export function thumbUrl(g: Game): string {
  return g.thumbPath ? `hh://thumb/${g.id}` : ''
}

// ---------------------------------------------------------------- 批量刮削（P1-1）

/**
 * 批量刮削进度。Playnite `IsBackgroundDownload` 分界：
 * 后台串行队列，高置信唯一命中直接 apply；多候选冲突不逐个弹窗，
 * 汇入 pending 等用户二次确认。
 */
export const batchScrape = reactive({
  running: false,
  cancel: false,
  total: 0,
  done: 0,
  applied: 0,
  failed: 0,
  /** 搜过但各源都没命中（区别于 failed：网络/应用错误）——UI 必须分开报，
   * 否则「0 命中」显示成「失败」，用户永远不知道为什么批量刮削没动静 */
  notfound: 0,
  /** 冲突/低置信：{ id, title, query } 供 overlay 逐个开 ScrapeDialog */
  pending: [] as { id: string; title: string; query: string }[],
  current: '',
})

/**
 * 标题归一：小写 + 去空白/标点，保留 Unicode 字母数字。
 * 不能用 `\W`：JS 默认 `\W`=`[^A-Za-z0-9_]`，会把中文/日文标题整个剥成空串。
 */
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 单候选对游戏标题的置信分（0–100）。≥80 视为可后台自动应用。 */
function scoreCandidate(g: Game, c: ScrapeCandidate): number {
  const gt = normTitle(g.rawTitle || g.title)
  if (!gt) return 0
  const forms = [c.title, c.titleNative, ...(c.aliases ?? [])].filter((x): x is string => !!x).map(normTitle)
  if (!forms.length) return 10
  if (forms.some((f) => f === gt)) return 100
  if (forms.some((f) => f.includes(gt) || gt.includes(f))) return 75
  // 公共前缀 ≥ 半长：目录名常带章节号，仍可对齐
  const hit = forms.some((f) => {
    const n = Math.min(f.length, gt.length, Math.ceil(gt.length / 2))
    return n >= 3 && f.slice(0, n) === gt.slice(0, n)
  })
  return hit ? 55 : 10
}

/** 从搜索结果选自动应用项；null = 冲突待确认。 */
function pickAuto(g: Game, results: ScrapeCandidate[]): ScrapeCandidate | null {
  if (!results.length) return null
  const scored = results.map((c) => ({ c, s: scoreCandidate(g, c) })).sort((a, b) => b.s - a.s)
  const best = scored[0]!
  if (best.s < 80) return null
  // 第二名同分 → 真冲突，不猜
  if (scored[1] && scored[1].s === best.s) return null
  return best.c
}

/**
 * 批量刮削：对 selection 串行跑 现有 scrapeSearch → scrapeApply 管线。
 * 源间加短延迟，避免 VNDB/Bangumi 被连发打限流。
 */
export async function startBatchScrape(
  ids: string[],
): Promise<{ applied: number; failed: number; notfound: number; pending: number; cancelled: boolean }> {
  const list = ids.filter((id) => library.games.some((g) => g.id === id))
  const summary = { applied: 0, failed: 0, notfound: 0, pending: 0, cancelled: false }
  if (!list.length || batchScrape.running) return summary
  batchScrape.running = true
  batchScrape.cancel = false
  batchScrape.total = list.length
  batchScrape.done = 0
  batchScrape.applied = 0
  batchScrape.failed = 0
  batchScrape.notfound = 0
  batchScrape.pending = []
  batchScrape.current = ''
  try {
    for (const id of list) {
      if (batchScrape.cancel) {
        summary.cancelled = true
        break
      }
      const g = library.games.find((it) => it.id === id)
      if (!g) {
        batchScrape.failed += 1
        batchScrape.done += 1
        continue
      }
      const query = (g.title || g.rawTitle || '').trim()
      batchScrape.current = query
      let results: ScrapeCandidate[] = []
      try {
        results = (await window.hh.scrapeSearch(query)).results
        // 精简标题搜不到时回退原名再搜一次：VNDB 常收录原始/完整版名
        if (!results.length && g.rawTitle && g.rawTitle !== g.title) {
          batchScrape.current = g.rawTitle
          results = (await window.hh.scrapeSearch(g.rawTitle)).results
        }
      } catch {
        batchScrape.failed += 1
        batchScrape.done += 1
        continue
      }
      if (!results.length) {
        // 搜过但没命中：源活着，是标题在库里没有对应条目。计 notfound，
        // 不混进 failed——UI 分开提示，用户才知道是「没找到」而非「出错」。
        batchScrape.notfound += 1
        batchScrape.done += 1
        continue
      }
      const pick = pickAuto(g, results)
      if (!pick) {
        batchScrape.pending.push({ id, title: g.title, query })
        batchScrape.done += 1
        continue
      }
      try {
        const r = await window.hh.scrapeApply(id, pick)
        if (r && r.ok) {
          batchScrape.applied += 1
        } else {
          batchScrape.failed += 1
        }
      } catch {
        batchScrape.failed += 1
      }
      batchScrape.done += 1
      await new Promise((res) => setTimeout(res, 180))
    }
    await refreshGames()
    summary.applied = batchScrape.applied
    summary.failed = batchScrape.failed
    summary.notfound = batchScrape.notfound
    summary.pending = batchScrape.pending.length
    return summary
  } finally {
    batchScrape.running = false
    batchScrape.current = ''
    batchScrape.cancel = false
  }
}

export function cancelBatchScrape(): void {
  if (batchScrape.running) {
    batchScrape.cancel = true
  }
  // 无论是否在跑都清空「待确认」：关闭浮层/退出多选时，残留的 pending
  // 不应滞留到下一次操作（overlay 的 v-if 含 pending.length，不清就是
  // 陈旧面板赖着不走的 bug 根源）。
  batchScrape.pending = []
}

/** 待确认项：打开单刮对话框（与 DetailPanel「元数据刮削」同路径）。 */
export function resolvePending(item: { id: string; query: string }): void {
  openScrape(item.id, item.query)
}
