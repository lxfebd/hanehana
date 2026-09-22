/**
 * 游戏库领域 store（REDESIGN-SPEC §3.2）。
 *
 * 持有游戏列表 + 当前选中 + 搜索/分类/视图 + 刮削/扫描对话框状态 + 运行中集合。
 * 所有对主进程的游戏库调用都经过这里，组件不直接碰 window.hh。
 */
import { reactive, computed } from 'vue'
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

export const filteredGames = computed(() => {
  const kw = library.keyword.trim().toLowerCase()
  return library.games.filter((g) => {
    if (library.categoryFilter && !g.categories.includes(library.categoryFilter)) return false
    if (!kw) return true
    return (
      g.title.toLowerCase().includes(kw) ||
      g.rawTitle.toLowerCase().includes(kw) ||
      g.titleNative?.toLowerCase().includes(kw) ||
      g.tags.some((t) => t.toLowerCase().includes(kw))
    )
  })
})

export const selectedGame = computed(() => library.games.find((g) => g.id === library.selectedId))

export const categories = computed(() => {
  const set = new Set<string>()
  for (const g of library.games) for (const c of g.categories) set.add(c)
  return [...set]
})

export async function refreshGames(): Promise<void> {
  library.games = await window.hh.listGames()
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
  void runSearch(query)
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
