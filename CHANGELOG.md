# 更新日志

本文件记录 HaneHana 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.2.4] - 2026-10-21

### 新增

- **回归脚本**：`regression:stats`（统计页柱状图 SVG/KPI 卡/双图表区/海报导出 5/5）、`regression:gamesites`（游戏站 webview 挂载/搜索框/三站聚合入口 4/4）。

## [0.2.3] - 2026-10-21

### 新增

- **最近续读条**：打开游戏库不用滚就能看到「上次玩到哪」——hero 下方横向条显示最近玩过的 4 款（小封面 + 标题 + 今天/昨天/日期时间），点击选中进详情。对标 gal-launcher aurora 的 queue-card 续读列表。回归：`verify_recent_strip` 5/5。
- **回归脚本**：`regression:dlview`（下载页任务列表/筛选/操作组/进度条/状态 chip 5/5）。

## [0.2.2] - 2026-10-21

### 新增

- **刮削候选卡显示"汉化"标记**：YMGal 的 `haveChinese` 折成「汉化」tag 高亮（success 绿），用户在刮削对话框选候选一眼看到哪个有汉化版，不用展开简介猜。回归：`verify_scrape_dialog_ui`（新增汉化 tag 断言，8/8）。
- **README 界面预览截图墙**：仓库首页加入 5 张真实 UI 截图（星海封面墙/影院/极光/全屏剧照/空库引导），对标 gal-launcher 的 README 首图留人方式。
- **回归脚本**：`regression:scancover`（扫描导入→本地封面回填→封面非空 4/4）、`regression:coveraspect`（竖版封面比例防压扁 6/6）、`regression:coverrender`（封面墙 hh:// 协议真实渲染 9/9）、`regression:detailpanel`（详情面板 8/8）、`regression:batchscrape`（批量刮削 6/6）。

### 修复

- **smoke 打包验收误报「起不来」**：`smoke_packaged.mjs` spawn 前清 `ELECTRON_RUN_AS_NODE` 残留变量——本机其他工具常设它，Electron 会按 Node 模式启动（不建窗口/不开 CDP/秒退），打包版 smoke 误报。实测设残留变量后 smoke 仍全绿，确认发布版 v0.2.x 实际一直正常（窗口真实存在）。

## [0.2.1] - 2026-10-21

### 新增

- **批量刮削端到端验证**：`regression:batchscrape`（中文名「妹相随」+ 英文名「CLANNAD」两款走真实 App 批量刮削 → 断言搜索出结果 + 落库 6/6）——批量路径彻底证明可用。
- **封面卡 hover 抬升**：封面卡 hover 从"只变边框"升级为微抬升（translateY -3px）+ 封面浮起 + 阴影加深（0 6px 20px → 0 12px 28px）——暗色墙上看得出层次与手感。验证脚本 `verify_cover_hover.mjs`（CDP 真实鼠标 hover 2/2）。

### 变更

- **hero 氛围横带放大到 340px**：封面轨 142→170、左封面 76×104→96×132、缩略图 72→80——默认视图第一眼更剧照，窄窗 226px 折叠保持。
- **布局留白调大**：三栏 padding 0 12px→0 20px、gap 12→16、content 内 gap 10→12——界面更呼吸感（对标 gal-launcher 的留白尺度）。
- **深色主题底色提亮**：5 套深色主题 night/nightPanel/float/input 同比例提亮（保持色相），从近纯黑（lum~0.03）提到深蓝灰（lum~0.10），侧栏/面板/浮层从死黑变为有层次（canvas 像素数据定位：深色截图 avgLum 0.20 vs gal-launcher cinema 0.51）。
- **大标题换衬线族**：hero/空库/剧照舞台标题用 Instrument Serif + Noto Serif SC 衬线族，字号 30-52px——对标 gal-launcher 各主题的 serif display 字体。
- **刮削对话框接入 YMGal**（0.2.0 后补记）：`runSearch` 从两源扩到三源并行，中文游戏名在对话框/批量界面可搜（实测妹相随 → 8 条带汉化标记）；ScrapeDialog 补 ymgal 绿色徽章、候选封面圆角/阴影/hover 缩放。验证 `verify_scrape_dialog_ui.mjs` 7 断言。

## [0.2.0] - 2026-10-21

### 新增

- **库顶氛围横带（hero）**：打开游戏库的第一眼不再是空白网格——顶部一条电影感氛围横带，背景用「最近在玩/收藏精选」的封面大图模糊铺满 + 双层遮罩压对比，顶部封面轨可滚轮/拖拽/方向键切换（选中放大 + 白描边），叙事眉标「继续上次的故事 / 从这里开始 / 下一段故事」+ 进度计数，主按钮白底黑字三态。空库或无封面时不渲染。
- **全屏剧照舞台（客厅模式）**：全屏模式从「深色大网格」升级为电影剧照舞台——中央选中封面竖版大图（min(46vh,380px)）+ 左右 ghost 封面旋转 ±5° 压暗 + 主色双光斑径向光晕 + 衬线大标题 + 发光胶囊启动键；封面墙缩为底部一条封面轨。方向键/手柄切换时标题跟随，舞台整体 300ms scale-in。
- **影院 / 极光两套主题**：主题套件从 3 套扩到 5 套。影院=纯黑舞台 + 暖金演职员表（`#D8B36A`）；极光=深蓝紫夜 + 雾蓝柔粉光晕（`#8FB7E8`），深浅色各一份种子。设置页主题卡升级为 46px 氛围渐变预览（夜色底 + accent 光晕），文案改为「每套主题不只是配色，是整套氛围与气质」。
- **封面书架板（P1）**：封面卡底部加暗色书架板（渐变层板 + 投影），hover 时板面泛起 accent 色——封面从"网格里贴图"变成"立上书架"。RecycleScroller 虚拟化度量同步重算。
- **回归脚本**：`regression:hero`（hero/主题/持久化/窄窗 4 阶段真实 UI 走查）、`regression:fsstage`（全屏剧照舞台 17 项断言，自包含 seed）、`scripts/verify_scrape_live.mjs`（三源搜索真实网络验证）、`scripts/verify_scrape_apply.mjs`（刮削落库全链路：标题/来源/开发商/封面/缩略图/主色/汉化标签）。

### 修复

- **刮削「图不行」的真病根：YMGal（月幕）封面是 WebP VP8X，Electron 的 `nativeImage` 只支持 jpg/png**（[官方 issue #29619](https://github.com/electron/electron/issues/29619)），封面永远下不了。`downloadCover` 改为：webp/avif 存原始字节（渲染层 Chromium 原生支持显示）+ 魔数/字节粗验；jpg/png 走 Chromium 解码转 JPEG 统一落盘。
- **刮削主色提取对 webp 失败**：`coverColorOf` 改 `createFromBuffer`（Chromium 解码器）优先、createFromPath 兜底；`ensureThumb` 改从刚生成的 JPEG 缩略图取主色（一定可解）→ webp 封面也有主色。
- **刮削只有两源且中文必备源（Bangumi）固定超时**：新增 YMGal（月幕）国产源——OAuth token 缓存 + `/open/archive/search-game`，中文名/汉化版/开发商全覆盖（实测「妹相随」从 0 结果 → 8 条命中，附「汉化」标签）；三源并行 + 单源 6s 硬超时裁剪（快源先回，体感从"卡 12 秒"变"秒出"），IPC 按源搜索白名单同步扩到三源。
- **主题卡色板被一条单色条带敷衍**：`preset-preview` 改为夜色底 + accent 光晕的氛围渐变。
- **刮削对话框搜中文名仍 0 结果**：`runSearch` 只调 VNDB/Bangumi 两源，用户在对话框/批量刮削界面搜中文游戏名 VNDB 精确匹配 0 命中。接入 YMGal 并行源（先回先上屏），实测「妹相随」在界面内搜出 8 条带汉化标记的候选项；ScrapeDialog 补 ymgal 绿色徽章、候选封面圆角/阴影/hover 缩放。回归脚本 `verify_scrape_dialog_ui.mjs`（7 断言）。
- **深色主题"死黑"（数据对比定位）**：canvas 像素分析显示深色主题截图 avgLum 0.20（74 格全暗）vs gal-launcher cinema 0.51——深色界面缺乏通透层次。5 套深色主题（樱夜/星海/薄荷/影院/极光）的 night/nightPanel/float/input 种子同比例提亮（保持色相），从近纯黑（lum~0.03）提到深蓝灰（lum~0.10），面板/侧栏/浮层从死黑变为有层次的深色。实测 CSS 变量：aurora night `#0a0c18→#1e2448`。

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

[0.2.0]: https://github.com/lxfebd/hanehana/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/lxfebd/hanehana/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lxfebd/hanehana/releases/tag/v0.1.0
