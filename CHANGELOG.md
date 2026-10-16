# 更新日志

本文件记录 HaneHana 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.1.1] - 2026-10-17

### 修复

- **刮削「应用选中」静默失败**（用户报「刮削根本用不了」的真病根）：候选卡片取自 Vue `reactive` 的 `scrapeResults`，是深层响应式 Proxy，直接进 `ipcRenderer.invoke` 会被 Electron 的结构化克隆拒绝，抛 `An object could not be cloned` —— 搜索结果能正常显示，点「应用选中」却永远写不进库。现在过 IPC 前先 JSON 往返拍平成纯数据。回归钉：`tests/scrapeApplyClone.test.ts`（同时钉住 `structuredClone` 对 Proxy 同样抛 `DataCloneError`，防止将来被"优化"回去）。
- **同一款游戏重复入库**（用户截图实测：F 盘与 G 盘各放一份，封面墙上同一个游戏出现 N 份）：原有去重只按 `exePath` 精确比对，路径不同就双双入库。新增 `src/main/dupKey.ts`，用 `cleanTitle` 归一化标题做第二层判重键（`妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（彩色/黑白）` 都归一成「妹相随」），扫描与 Steam 导入共用这道闸。回归钉：`tests/dupScan.test.ts`。
- **同款多版本不再被偷偷吞掉**：判重跳过的同款不同安装目录，现在以 `dupes` 明细回给扫描结果浮层，列出「同一款游戏的其它安装位置（未入库）」并逐条给「也加进来」按钮——要不要都留着由用户决定，走手动添加通道入库（`handleAddOne` 不过标题判重闸）。
- **批量编辑浮层文字溢出框外**（用户截图实测）：`.batch-panel` 是 flex 容器却没有 `flex-wrap` / `max-width`，按钮默认可被压缩，窄窗口下「批量刮削」等文字被压成竖排并顶出面板。现补 `flex-wrap: wrap` + `max-width: min(720px, 92vw)`，按钮自身 `flex: none` + `white-space: nowrap`——窄窗口整只按钮换行，永不被压扁。
- **刮削单源失败提示是一串英文通道名**：主进程 handler 抛错时 Electron 会重新包一层 `Error invoking remote method '<通道名>': Error:`，原样进 UI 就是 `Error invoking remote method 'hanehana:scrape:search-source'…`。现由渲染层 `sourceWarn()` 剥掉外壳并冠上源名，显示「Bangumi：网络不可达」。
- **批量刮削把「没找到」报成「失败」**：搜过但各源都没命中（标题太生僻 / 目录名太杂）与真正的网络错误混为一谈，用户永远不知道为什么批量刮削没动静。现在分开统计，提示语为「{n} 款没找到（标题可能太生僻或目录名太杂，试试详情页手动刮削）」。
- **批量刮削冲突项无路可走**：多候选不确定的应用哪一条时，现在汇入「待确认」列表，点击即打开该游戏的单刮对话框，不再默默跳过。
- **设置保存后立即新建下载会竞态**：`saveSettings` 与 `addTask` 共用 400ms 合并写，连续操作会互相覆盖。新增 `flushSettings()` 强制落盘。
- **更新终态可能丢失**：自动更新到终态（已是最新 / 出错 / 下载完成）时若推送尚未建立，状态不会送达渲染层，界面卡在中间态。新增 outcome 兜底保证。
- **智能列表下拉首项样式与其余项不一致**：原生 `<select>` 未关 `appearance`，导致首项「全部游戏」字重/颜色与其余项有差。补 `-webkit-appearance: none` + `appearance: none` 统一口径。
- **详情面板简介长英文描述底部被截断**：`.desc` 缺断词规则，长单词溢出。补 `overflow-wrap` / `word-wrap: break-word` 与容器 `flex-shrink: 0`。

### 新增

- **刮削搜索词清洗梯**（`src/main/scrapeQuery.ts`）：VNDB 的 `search` 是**精确标题匹配**，galgame 目录名带的 `【汉化组】` / `[DL版]` / `（中文版）` / 版本尾缀一律 0 命中——这正是「批量刮削什么都没发生」的主因。策略：原词先搜（干净标题一发命中，不多花请求），只有 0 结果才逐级放宽（剥括号 → 剥版本尾缀 → 截主标题 → 逐词裁剪），第一个非空即返回。网络错误立即抛出并计熔断，不拿已挂的源反复重试。回归钉：`tests/scrapeQuery.test.ts`（9 条，全部用实测真实标题做锚点）。
- **单源失败不再拖累另一源**：双源并行搜索改为各自 `then/catch` 先回先上屏，快源结果秒上屏；慢源（Bangumi 本机不通时固定 10s 超时）只补充一条警告，不再把快源结果压到 10s 后才显示。
- **验收脚本 `npm run regression:ui`**（`scripts/ui_scrape_walkthrough.mjs`）：起真实 App、像用户一样点封面 → 点刮削 → 点应用选中，读真实 DOM 与截屏。上面第 1 条（Proxy 致 apply 静默失败）就是这条走查抓到的——它专测「自动化单测测不到的那一层」。
- **验收脚本 `npm run regression:dupe`**（`scripts/e2e_dupe_ui.mjs`）：造两份同款不同盘目录，扫两次，断言第二次零自动入库、`dupes` 明细正确回传、「也加进来」真能入库。

### 变更

- **扫描去重多一层标题判重**：`ScanResult` 新增 `dupes` 字段（`{ dir, exePath, rawTitle, kept }[]`），preload 的 `scanDir` 类型同步扩展。
- **批量刮削返回值新增 `notfound`**：`startBatchScrape` 现返回 `{ applied, failed, notfound, pending, cancelled }`，浮层按「已刮削 / 待确认 / 没找到 / 失败」四类分别提示。
- **测试数据隔离增强**：设 `HANEHANA_DATA_DIR` 时 Chromium 的 userData 一并挪进隔离目录。此前只挪了数据文件，单实例锁仍按默认 `%APPDATA%\hanehana` 加锁——验收脚本拉起的实例会撞上用户正开着的安装版实例而秒退（症状：CDP 永远连不上）。打包正常运行不设该变量，行为不变。

## [0.1.0] - 2025-10-16

首个版本：Mica 毛玻璃窗口 + 自定义标题栏 + 三栏布局；封面墙游戏库（扫描 / 手动 / Steam 导入，VNDB·Bangumi 刮削，LE / Magpie 启动集成，进程监控计时）；Rust 分段并发下载引擎（任务列表、校验和、限速、代理、断点续传）；内嵌游戏站浏览器 + 多站聚合搜索 + 镜像解析 + 下载捕获；统计页与海报导出、新作追踪、存档备份与 WebDAV 同步；中英双语、三套配色、托盘通知、应用内自动更新。

[0.1.1]: https://github.com/lxfebd/hanehana/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lxfebd/hanehana/releases/tag/v0.1.0
