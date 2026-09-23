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
  view: 'grid' as 'grid' | 'list',
  scrapeOpen: false,
  scrapeResults: [] as ScrapeCandidate[],
  scrapeWarnings: [] as string[],
  scrapeLoading: false,
  scrapeTargetId: '',
  scrapeQuery: '',
  scanOpen: false,
  scanRunning: false,
  runningIds: new Set<string>(),
})

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
  return library.games.filter((g, i) => {
    if (cat && !g.categories.includes(cat)) return false
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
