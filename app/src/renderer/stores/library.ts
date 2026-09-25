/**
 * 游戏库领域 store（REDESIGN-SPEC §3.2）。
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
export type SmartListId = '' | 'recent30' | 'played10h' | 'unrated' | 'unplayed'

export interface SmartListDef {
  id: SmartListId
  label: string
  test: (g: Game) => boolean
}

const DAY = 86400000

export const SMART_LISTS: SmartListDef[] = [
  { id: '', label: '全部游戏', test: () => true },
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
const searchIndex = shallowRef<{ title: string; raw: string; native: string; tags: string; extra: string; dev: string; series: string }[]>([])

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
function matchSearch(s: { title: string; raw: string; native: string; tags: string; extra: string; dev: string; series: string }, kw: string): boolean {
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
  return library.games.filter((g, i) => {
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
  const fresh = await window.hh.updateGame(id, { favorite: next })
  if (!fresh) {
    g.favorite = !next
    syncIndexToGames()
    void refreshGames()
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
}

export async function batchRemove(ids: string[]): Promise<boolean> {
  library.games = library.games.filter((g) => !ids.includes(g.id))
  syncIndexToGames()
  if (library.selection.length) library.selection = library.selection.filter((id) => !ids.includes(id))
  const r = await window.hh.batchRemoveGames(ids)
  if (!r.ok) {
    library.error = r.error ?? '批量移除失败'
    void refreshGames()
    return false
  }
  return true
}

// ---------------------------------------------------------------- 手动编辑

export function openEdit(id: string): void {
  library.editTargetId = id
  library.editOpen = true
}

export async function saveManualEdit(id: string, patch: Partial<Game>): Promise<boolean> {
  const fresh = await window.hh.updateGame(id, { ...patch, manualEdit: true })
  if (!fresh) {
    library.error = '保存失败'
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
  const r = await window.hh.launchGame(id)
  if (r && r.ok) {
    library.runningIds.add(id)
  } else if (r && r.error) {
    library.error = r.error
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

export async function runSearch(query: string): Promise<void> {
  library.scrapeLoading = true
  try {
    const r = await window.hh.scrapeSearch(query)
    library.scrapeResults = r.results
    library.scrapeWarnings = r.warnings
  } catch (e) {
    library.scrapeWarnings = [e instanceof Error ? e.message : String(e)]
  } finally {
    library.scrapeLoading = false
  }
}

export async function applyScrapeResult(result: ScrapeCandidate): Promise<void> {
  const r = await window.hh.scrapeApply(library.scrapeTargetId, result)
  if (!r.ok) {
    library.error = r.error ?? '刮削失败'
  }
  await refreshGames()
}

/** 渲染层缩略图 URL：有 thumbPath 才走 hh:// 协议，否则空（组件走占位色）。 */
export function thumbUrl(g: Game): string {
  return g.thumbPath ? `hh://thumb/${g.id}` : ''
}
