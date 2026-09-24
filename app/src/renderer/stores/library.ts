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

/** 索引随 games 数组更新；只在 refreshGames/applyScrapeResult 之后重算一次。 */
const searchIndex = shallowRef<{ title: string; raw: string; native: string; tags: string }[]>([])

function rebuildIndex(): void {
  searchIndex.value = library.games.map((g) => ({
    title: g.title.toLowerCase(),
    raw: g.rawTitle.toLowerCase(),
    native: (g.titleNative ?? '').toLowerCase(),
    tags: g.tags.join(' ').toLowerCase(),
  }))
}

export const filteredGames = computed(() => {
  const idx = searchIndex.value
  const kw = debouncedKeyword.value.trim().toLowerCase()
  const cat = library.categoryFilter
  const fav = library.favOnly
  const smart = library.smartList
  return library.games.filter((g, i) => {
    if (cat && !g.categories.includes(cat)) return false
    if (fav && !g.favorite) return false
    if (smart && !smartListTest(smart, g)) return false
    if (!kw) return true
    const s = idx[i]
    if (!s) return false
    return s.title.includes(kw) || s.raw.includes(kw) || s.native.includes(kw) || s.tags.includes(kw)
  })
})

export const selectedGame = computed(() => library.games.find((g) => g.id === library.selectedId))

export const categories = computed(() => {
  const set = new Set<string>()
  for (const g of library.games) for (const c of g.categories) set.add(c)
  return [...set]
})

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
  const fresh = await window.hh.updateGame(id, { favorite: next })
  if (!fresh) {
    g.favorite = !next
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

/** 批量更新：每款游戏携带自己的 patch，乐观更新 + 失败回滚 */
export async function batchUpdate(patches: { id: string; patch: Partial<Game> }[]): Promise<void> {
  if (!patches.length) return
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
  }
}

export async function batchRemove(ids: string[]): Promise<void> {
  library.games = library.games.filter((g) => !ids.includes(g.id))
  if (library.selection.length) library.selection = library.selection.filter((id) => !ids.includes(id))
  const r = await window.hh.batchRemoveGames(ids)
  if (!r.ok) {
    library.error = r.error ?? '批量移除失败'
    void refreshGames()
  }
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
  if (idx >= 0) library.games[idx] = fresh
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
