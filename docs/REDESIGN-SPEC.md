# HaneHana 重设计规格书（架构 + UI）

> 状态：待执行。本文件是唯一执行依据，由强模型调研产出（2026-09-22），交给执行模型逐任务落地。
> 执行规则：按 T1→T13 顺序做；每个任务结束必须跑「验收」里列的命令并全绿；不允许跳过铁律；不允许顺手改本文件没提到的行为。
> 仓库：J:\xiangm_transfer\hanehana（app/ 为 Electron 应用）。所有路径相对 `app/`。

---

## 0. 全局铁律（违反即返工）

1. **禁 emoji / 文本符号当图标**。`🌸 🌼 ★ ▶ ▦ ☰  ×` 一律删除。应用层图标唯一来源 `lucide-vue-next`（新增依赖，仅这一个）。antd 组件内部自带图标不管。
2. **backdrop-filter 只允许出现在**：窗口级固定面板（侧栏）、浮层（Modal/下拉/Popconfirm）。**任何 `overflow:auto/scroll` 容器内部禁止**（封面卡、评分徽标、任务行都不行）。现有违规点见 §1。
3. **antd seed token 只喂实色 hex**。半透明玻璃只存在于两个地方：CSS 变量层（自定义组件）与 antd component tokens 的定点覆盖。给 `darkAlgorithm` 喂 rgba 会破坏派生色链（antd 官方结论）。
4. **颜色/圆角/阴影/时长/字号只准来自 `src/renderer/design/tokens.ts`**。组件里写颜色字面量 = 违规（scrim 渐变用 tokens 里的 scrim 变量拼）。
5. **间距走 4pt 网格**：4/8/12/16/24/32。**圆角阶梯**：6/8/10/12/16/20。**字号阶梯**：12/13/14/16/20/28，行高见 tokens。字重只用 400/600/700，同屏 ≤3 档。
6. **动效**：hover/press 83–167ms；弹窗 167–250ms；页面切换 250–333ms。入场 easing `cubic-bezier(0,0,0,1)`，位移 `cubic-bezier(0.55,0.55,0,1)`，纯淡入淡出 83ms linear。必须写 `@media (prefers-reduced-motion: reduce)` 降级（去位移/缩放，玻璃降纯色）。
7. **文字不直接压原图**：封面/横幅上的文字必须过 scrim 渐变或实色容器（WCAG：半透明层对比度按合成后算，压原图不可控）。
8. **数字列（速度/大小/百分比/时长）一律 `font-variant-numeric: tabular-nums`** + 等宽字体栈。
9. 每任务完成 = `npm run typecheck` 零错误 + `npm run build` 成功 + 该任务验收命令通过 + **本地 commit（中文 message），禁止 push**。
10. 不新增本文件未列出的依赖；不改 Rust 引擎、不改 IPC 频道名、games.json 只允许**加字段**不允许改/删旧字段。

---

## 1. 现状诊断（证据 → 任务映射）

| # | 症状 | 证据 | 根因 | 任务 |
|---|------|------|------|------|
| 1 | emoji/符号当图标 | `components/CoverGrid.vue:57,76,105`、`components/DetailPanel.vue:60,81`、`App.vue:141,146`、`components/ScrapeDialog.vue:67`、侧栏「＋ 扫描导入」 | 无图标系统 | T2 |
| 2 | 两套视觉打架：antd 默认灰板弹窗/Select/Tabs/Checkbox 与手写玻璃并存 | `SettingsDialog.vue`（Tabs/Checkbox/Switch/Form 直出）、`DownloadView.vue:120`（Select）、`StatusTag.vue`（Tag）、截图可见 Modal 为纯灰板 | antd 未主题化 + rgba 喂 seed | T3 |
| 3 | rgba 喂进 antd seed | `theme.ts:40-41` colorBgContainer/Elevated 为 rgba | 误解 antd token 派生链 | T3 |
| 4 | 封面全尺寸原图直接进网格 | `CoverGrid.vue` coverSrc() = `file://` + coverPath 原图 | 无缩略图管线 | T5 |
| 5 | 依赖里有 vue-virtual-scroller 但零使用；网格无窗口化 | `package.json:34`；全仓 grep 无 import | 半途而废 | T6 |
| 6 | backdrop-filter 进滚动容器 | `CoverGrid.vue:187`（.cover-rating，在 .cover-wall 滚动区里）、`App.vue:278`（search-input 无必要） | 违反自家铁律 | T1 |
| 7 | god store：游戏+下载+UI 全在一个 reactive | `store.ts` 全文件 | 无领域拆分 | T4 |
| 8 | 信息架构混乱：下载页里套第二个侧栏 | `DownloadView.vue` `.dl-side` | 导航层级重复 | T9 |
| 9 | 详情面板 320px 太窄；banner 16:9 与 2:3 封面裁切冲突 | `App.vue:299`、`DetailPanel.vue` banner | 规格缺失 | T8 |
| 10 | 库里有空标题脏数据（rawTitle/title 均 ''） | `%APPDATA%/hanehana/games.json` 现存条目 | 扫描/入库无回落 + 无迁移 | T11 |
| 11 | 标题栏裸文字+版本 chip，无品牌、无控件区留白 | `App.vue:82-86` | shell 未设计 | T11 |
| 12 | 无 focus-visible、无键盘导航、无 reduced-motion | 全仓 grep 无 | a11y 缺失 | T11 |
| 13 | 动效无规范，transition 值散落随手写 | 各组件 style 块 | 无 motion token | T1 |

---

## 2. 调研结论数值表（执行时直接抄，出处见括号）

### 2.1 业界 UI 模式
- 封面墙主比例 **2:3 竖版**（Steam library capsule 600×900；PotatoVN/ReinaManager/GreenResourcesManager 同）；列宽 180–240px；间距 16–24px；**评分不放卡片上，放详情与列表行**（Steam/GOG 惯例）。(partner.steamgames.com/doc/store/assets/libraryassets；各仓库 README 截图)
- 详情：hero 图**放大模糊+暗渐变融入底色**做背景（Steam library hero 做法），1 个品牌色主按钮 + ghost 次按钮；元数据「标签:值」两栏 + chip 标签。(store.steampowered.com/libraryupdate)
- 侧栏单级：库/下载/设置三段，**设置=底部齿轮**；计数用徽章，进行中用主色徽章。(Motrix README；Playnite 主题文档)
- 下载行（Motrix TaskItem.vue 源码证实）：名称单行截断 + 副标题速度/剩余 + **进度条贯穿行底** + 操作图标按钮 hover 浮现于行右上、无边框；状态过滤不做页内 tab；空态=图标+一句话+单一主 CTA。
- 廉价感清单（全部产品共同避免）：emoji 图标、组件库默认直出、原生灰板弹窗、浅色底、边框套边框、表格线外露。

### 2.2 材质 / 视觉数值（Fluent 官方 + 社区交叉）
| 项 | 值 | 出处 |
|---|---|---|
| Mica | 窗口底、不透明、采样一次壁纸；非 Win11/省电/失焦回退纯色 `#202020` | learn.microsoft.com Mica |
| Acrylic | 仅浮层；禁止并排/叠放多块、禁止进滚动内容 | learn.microsoft.com Acrylic |
| 深色 acrylic tint | `#2C2C2C` @ **0.15**（官方资源源码） | microsoft-ui-xaml AcrylicBrush themeresources |
| content 层 / card 层 | `#3A3A3A`≈40% / `#2C2C2C` 10–40%（社区实测收敛） | 社区交叉 |
| 玻璃底（深色） | `rgba(255,255,255,0.04–0.10)`，勿超 12% | css-tricks / Josh Comeau / glassmorphism.com |
| blur | 浮层 16–30px；固定面板 16px；blur ≥ radius 才自然 | 同上 |
| 1px 内高光 | `inset 0 1px 0 rgba(255,255,255,0.08–0.15)` | 同上 |
| 玻璃边框 | `1px solid rgba(255,255,255,0.08–0.18)` | 同上 |
| 圆角 | Fluent Control 4 / Card 8；玻璃卡 8–12；弹窗 16 | Fluent |
| 阴影栈·浮层 | `0 2px 4px rgba(0,0,0,.4), 0 8px 16px rgba(0,0,0,.32), 0 32px 64px rgba(0,0,0,.28)` | Fluent elevation |
| 阴影栈·卡片 | `0 2px 8px rgba(0,0,0,.35)`；hover `0 8px 24px rgba(0,0,0,.45)` | Fluent |
| 文字三级（玻璃上） | `rgba(255,255,255,.90) / .68 / .48` | Material dark + 社区补偿 |
| 动效时长 | 83 / 167 / 250 / 333 ms | Fluent motion |
| easing | 入场 `(0,0,0,1)`；位移 `(0.55,0.55,0,1)`；M3 emphasized `(0.2,0,0,1)` | Fluent / M3 |
| 字号 ramp | Caption 12/16；Body 14/20；桌面密度惯例 base 13（VS Code） | Fluent typography / 社区 |
| 间距 | 4pt 基准、8pt 主网格 | Material spacing / Fluent |
| 滚动条 | 命中区 12px；滑块静息≈4px、hover≈7px；全圆角轨道透明；`border:4px solid transparent + background-clip:padding-box` 实现 | Win11 实测社区 |
| focus-visible | `outline:2px solid accent; outline-offset:2px`，仅 `:focus-visible`；玻璃上外加 1px 暗环 | MDN / WCAG 2.4.11 / WinUI |
| 对比度 | 正文 4.5:1、大字/UI 3:1，按合成后颜色算 | WCAG 1.4.3 |

### 2.3 架构结论
- **antd 主题化**：seed 只给实色；半透明用 component tokens 定点覆盖（Modal.contentBg/headerBg、Select.selectorBg、Tabs、Input、Switch、Checkbox 均有独立 token）；弹层保持实色/高不透明（浮于内容上，透明露底可读性差）。(ant.design customize-theme；antdv.com docs)
- **状态管理**：此规模（~50 源文件、单窗口）Pinia 非必需；**价值在领域拆分**。决策：不引 Pinia，拆 `stores/{library,downloads,ui}.ts` 三个 reactive 模块。(pinia.vuejs.org cookbook；社区共识)
- **虚拟列表**：RecycleScroller 原生支持网格（`grid-items` + `item-secondary-size`），**要求 item 尺寸固定**；DynamicScroller 只适合不定高单列。窗口化只解决 DOM 数，**缩略图是前置条件**（全尺寸原图解码打爆 GPU 内存）。(vue-virtual-scroller 文档；Akryum/vue-virtual-scroller#46)
- **Electron 图片管线**：`nativeImage.createThumbnailFromPath(path, {width})` Win/mac 可用（Win 按 width 等比）；`registerFileProtocol` 已废弃，Electron 25+ 用 `protocol.handle` + `registerSchemesAsPrivileged`（自定义 scheme 安全边界优于 file://）；缩略图缓存 `userData/thumbs/`；主色提取自研 `nativeImage.resize(16x16)+toBitmap()` 零依赖最轻（node-vibrant 已归档）；提取放主进程后台、结果缓存进 games.json。(electronjs.org docs native-image / protocol)
- **IPC**：单一契约文件（已有 shared/ipc.ts，保持）；动作类统一结果信封（已有）；推送订阅必须返回 unsubscribe 且组件 onUnmounted 清理。(electron IPC tutorial；electron#33691)
- **图标**：emoji 跨平台字形/色深/基线全不可控；深色玻璃配细线性图标最协调；**lucide-vue-next**（24px 网格、1.5–2px 描边、tree-shakable、shadcn-vue 默认）。(lucide.dev)
- **a11y**：网格键盘导航用 roving tabindex（W3C APG grid pattern）；`:focus-visible` 只键盘显示；文字不压原图。(W3C APG)

---

## 3. 目标架构

### 3.1 进程边界（不变）
渲染层 → IPC（shared/ipc.ts 单一来源）→ 主进程 → stdio JSON-lines → Rust 引擎。本规格不动这条链。

### 3.2 渲染层目标结构
```
src/renderer/
  design/tokens.ts          # 唯一视觉真源（TS 常量），启动时注入 CSS 变量
  design/antdTheme.ts       # 由 tokens 构建 antd ThemeConfig（seed 实色 + component tokens）
  design/global.css         # 原 glass.css 重写：CSS 变量消费、滚动条、focus、reduced-motion、scrim 工具类
  stores/library.ts         # games/selectedId/keyword/categoryFilter/view/scrape*/scan*/runningIds + actions
  stores/downloads.ts       # rows/taskFilter/taskQuery/taskSort/addDialogOpen/totalSpeed + 任务 actions + wireTaskPushes
  stores/ui.ts              # page/settingsOpen/settings/error(dark 固定 true 保留字段)
  stores/index.ts           # 删除（所有 import 改指向三个领域 store）
  components/...            # 见 §5 逐屏规格
```
- `theme.ts` 删除，职责拆进 `design/tokens.ts` + `design/antdTheme.ts`。
- `status.ts`、`shared/*`、`preload`、`main` 除 T5 外不动。

### 3.3 tokens.ts 全量定义（直接抄）
```ts
export const tokens = {
  color: {
    // 三层：窗口底(Mica/回退) → 固定面板玻璃 → 卡片 → 浮层(实色高不透明)
    windowFallback: '#202020',
    panelGlass: 'rgba(255,255,255,0.05)',
    panelGlassBorder: 'rgba(255,255,255,0.10)',
    panelGlassHighlight: 'rgba(255,255,255,0.12)',
    card: 'rgba(255,255,255,0.04)',
    cardBorder: 'rgba(255,255,255,0.08)',
    cardHover: 'rgba(255,255,255,0.07)',
    float: '#26262b',            // Modal/下拉/Popconfirm 实色
    floatBorder: 'rgba(255,255,255,0.14)',
    input: '#232329',            // antd Input/Select 实色底
    text: 'rgba(255,255,255,0.90)',
    textSecondary: 'rgba(255,255,255,0.68)',
    textTertiary: 'rgba(255,255,255,0.48)',
    accent: '#4da3ff',
    accentHover: '#7ec3ff',
    accentBg: 'rgba(77,163,255,0.16)',
    success: '#5ec269',
    warning: '#e8b450',
    error: '#e05555',
    scrim: 'linear-gradient(to top, rgba(12,12,16,0.85), rgba(12,12,16,0))',
    scrimSoft: 'linear-gradient(to top, rgba(12,12,16,0.65), rgba(12,12,16,0))',
  },
  glass: { blurPanel: '16px', blurFloat: '24px', saturate: '1.5' },
  radius: { xs: 6, sm: 8, md: 10, lg: 12, panel: 16, modal: 16, pill: 999 },
  space: { x1: 4, x2: 8, x3: 12, x4: 16, x6: 24, x8: 32 },
  shadow: {
    card: '0 2px 8px rgba(0,0,0,0.35)',
    cardHover: '0 8px 24px rgba(0,0,0,0.45)',
    float: '0 2px 4px rgba(0,0,0,0.4), 0 8px 16px rgba(0,0,0,0.32), 0 32px 64px rgba(0,0,0,0.28)',
  },
  motion: {
    fast: '83ms', med: '167ms', slow: '250ms', page: '333ms',
    easeEnter: 'cubic-bezier(0,0,0,1)', easeMove: 'cubic-bezier(0.55,0.55,0,1)', easeFade: 'linear',
  },
  type: {
    caption: '12px/16px', body: '13px/18px', bodyLg: '14px/20px',
    subtitle: '16px/22px', title: '20px/28px', display: '28px/36px',
    family: `'Segoe UI Variable','Segoe UI','PingFang SC','Microsoft YaHei UI','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif`,
    mono: `ui-monospace,'Cascadia Code',Consolas,monospace`,
  },
  layout: {
    titlebarH: 40, sidebarW: 208, detailW: 360,
    cardW: 184, cardGap: 16, coverRatio: 3 / 2, titleZone: 32, // 网格固定度量，T6 用
    rowH: 72, taskRowH: 64, overlayRight: 138, // 标题栏原生控件区留白
  },
} as const

export type Tokens = typeof tokens
```
注入方式（`design/tokens.ts` 导出 `applyCssVars()`，渲染入口 `main.ts` 挂载前调用）：把 color/glass/radius/space/shadow/motion/type 平铺成 `--hh-*` CSS 变量（键名 kebab-case，如 `--hh-color-accent`、`--hh-radius-lg`、`--hh-motion-med`、`--hh-shadow-float`、`--hh-type-body: 13px/18px` 拆成 `--hh-font-body-size`/`--hh-font-body-lh`）。组件 CSS 只准 `var(--hh-*)`。

### 3.4 图片管线（主进程 `main/thumbs.ts`，新增）
- `protocol.registerSchemesAsPrivileged([{ scheme: 'hh', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])` —— 必须在 `app.whenReady()` 之前。
- `protocol.handle('hh', handler)`：URL 形如 `hh://thumb/{gameId}` / `hh://cover/{gameId}`。handler 内**只认这两种 hostname**，id 必须命中 gameStore 中真实 game（`getGame(id)`），路径由 game.thumbPath / game.coverPath 决定，**禁止拼接 URL 路径**（防穿越）；未命中返回 `new Response('not found', { status: 404 })`；命中则 `net.fetch(pathToFileURL(p).toString())`。
- `ensureThumb(game)`：有 coverPath 且（无 thumbPath 或 thumbSrc !== coverPath）时：
  1. `nativeImage.createThumbnailFromPath(coverPath, { width: 320, height: 480 })`；失败回退 `createFromPath(coverPath).resize({ width: 320 })`；仍失败则 thumbPath 留空（UI 走占位）。
  2. 写 `userData/thumbs/{gameId}.jpg`（`toJPEG(82)`）。
  3. 主色 `coverColorOf(coverPath)`（现有 `main/coverColor.ts` 保留不动）。
  4. `updateGame(id, { thumbPath, thumbSrc: coverPath, color })`。
- 接线：`scraper.applyScrape` 下载封面后 `await ensureThumb(game)` 再返回；`loadGames()` 后 `setImmediate` 起**串行**回填循环（逐个 await，禁止并行炸磁盘），只处理缺 thumb/color 的条目。
- `shared/types.ts` Game 加字段：`thumbPath?: string`、`thumbSrc?: string`（color 已存在）。只加不改。
- 渲染层 URL 助手（`stores/library.ts` 或 `design/` 下 `urls.ts`）：`thumbUrl(g) = g.thumbPath ? \`hh://thumb/${g.id}\` : ''`；详情大图同 thumb（320 宽足够 96px 小图与模糊横幅）。

### 3.5 虚拟化度量（固定，T6/T7 用）
- 网格：`RecycleScroller`（vue-virtual-scroller，已在依赖）props：`:item-size="324"`（=184*1.5=276 封面 + 8 间距 + 32 标题区 + 8 行距）、`:grid-items="cols"`、`:item-secondary-size="200"`（=184+16）、`key-field="id"`、`page-mode="false"`，外层容器固定高度 flex:1 + overflow hidden（RecycleScroller 自己滚）。
- `cols = Math.max(1, Math.floor((containerWidth + 16) / 200))`，ResizeObserver 维护；左留白居中：`padding-left = (containerWidth - (cols*200 - 16)) / 2`。
- 列表视图：RecycleScroller 单列 `:item-size="72"`。
- 下载列表不窗口化（任务数百级，行重）。
- 回退预案：若 RecycleScroller 网格在验收中出现错位/空白，改用 `@tanstack/vue-virtual`（需新增依赖时在本文件补登记后再装）。

### 3.6 IPC / 状态
- 频道与信封不变。`store.ts` 按 §3.2 拆分；所有组件 import 改指向领域 store；`bridge.d.ts` 不动。
- 推送订阅（onTaskProgress/onTaskFocus）在 `downloads.ts` 的 `wireTaskPushes()` 内保存 unsubscribe，`App.vue` onUnmounted 调用清理（现状泄漏点）。

---

## 4. 设计系统细则

### 4.1 antd 主题（`design/antdTheme.ts`）
seed（**全实色**）：`colorPrimary '#4da3ff'`、`colorBgBase '#202020'`、`colorSuccess '#5ec269'`、`colorWarning '#e8b450'`、`colorError '#e05555'`、`colorText 'rgba(255,255,255,0.90)'`（colorText 系允许 rgba，它是文字不是容器底）、`borderRadius 8`、`fontSize 13`、`controlHeight 32`、`colorLink '#4da3ff'`、`algorithm: theme.darkAlgorithm`。
component tokens：
```ts
components: {
  Modal: { borderRadiusLG: 16, headerBg: '#26262b', contentBg: '#26262b', titleFontSize: 14, titleColor: 'rgba(255,255,255,0.9)' },
  Select: { selectorBg: '#232329', colorBgElevated: '#26262b', optionSelectedBg: 'rgba(77,163,255,0.16)', borderRadius: 10 },
  Input: { colorBgContainer: '#232329', borderRadius: 10, activeBorderColor: '#4da3ff', hoverBorderColor: 'rgba(77,163,255,0.6)' },
  InputNumber: { colorBgContainer: '#232329', borderRadius: 10 },
  Button: { borderRadius: 10, controlHeight: 34, primaryShadow: '0 4px 14px rgba(77,163,255,0.3)', fontWeight: 500 },
  Tabs: { itemColor: 'rgba(255,255,255,0.68)', itemSelectedColor: '#7ec3ff', inkBarColor: '#4da3ff', horizontalItemPadding: '8px 12px' },
  Switch: { colorPrimary: '#4da3ff', handleSize: 18 },
  Checkbox: { colorPrimary: '#4da3ff', borderRadiusSM: 4 },
  Tag: { borderRadiusSM: 6 },
  Popconfirm: { colorBgElevated: '#26262b' },
  Message: { colorBgElevated: '#26262b', borderRadiusLG: 10 },
}
```
全局 CSS 兜底（global.css）：`.ant-message-notice-content { background: var(--hh-color-float); box-shadow: var(--hh-shadow-float); color: var(--hh-color-text); }`。

### 4.2 图标映射表（lucide-vue-next，T2 照表替换）
| 位置 | 现状 | 换成 |
|---|---|---|
| 品牌/空态花 | 🌸 🌼 | `Flower2` |
| 侧栏 游戏库/下载/扫描/设置 | 纯文字/＋ | `LibraryBig` / `Download` / `ScanSearch` / `Settings` |
| 视图切换 ▦  | 文本符号 | `LayoutGrid` / `List` |
| 搜索框内 | 无 | `Search`（绝对定位左 10px，input padding-left 32） |
| 启动/运行中 | ▶ 文本 | `Play` / `Activity` |
| 刮削 | 文字按钮 | `Wand2`（按钮内图标+文字） |
| 打开目录 | — | `FolderOpen` |
| 评分 ★ | 文本 | `Star`（fill 变体：`:fill` warning 色） |
| 任务状态 | antd icons | 下载中 `Loader2`(spin)/准备 `Timer`/完成 `CircleCheck`/校验 `ShieldCheck`/失败 `CircleX`/暂停 `CirclePause`/排队 `CircleDot` |
| 任务操作 | antd icons | 开始 `Play`、暂停 `Pause`、重试 `RotateCw`、打开 `FolderOpen`、删除 `Trash2` |
| 工具栏全量操作 | antd icons | `Plus` `PlayCircle` `PauseCircle` `RotateCw` `Trash2` |
| 关闭/清除错误 × | 文本 | `X` |
| 新建下载浏览 | antd FolderOpen | `FolderOpen`（lucide） |
删除 `@ant-design/icons-vue` 的**应用层 import**（package.json 依赖保留，antd 内部要用）。

### 4.3 玻璃使用矩阵
| 层 | 材质 | blur | 备注 |
|---|---|---|---|
| 窗口底 | Mica（主进程已接）/回退 #202020 | — | 不变 |
| 主侧栏、详情面板外壳 | panelGlass + 1px 边 + inset 高光 | 16 | 固定面板，允许 |
| 封面卡/任务行/工具条 | card 实半透明，**无 blur** | 0 | 滚动内容内 |
| Modal/Select 下拉/Popconfirm/Message | float 实色 #26262b | 0 | 浮层不透明（调研结论） |
| 详情横幅背景 | thumb 图 `filter: blur(32px) saturate(1.2)` + scrim | 预模糊位图 | 单元素静态，允许 |

### 4.4 滚动条 / focus / reduced-motion（global.css 直接抄）
```css
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.16); border-radius: 999px;
  border: 4px solid transparent; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { border-width: 2.5px; background: rgba(255,255,255,0.28); background-clip: padding-box; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--hh-color-accent); outline-offset: 2px; border-radius: var(--hh-radius-xs); }
.glass :focus-visible { box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 0 0 3px var(--hh-color-accent); outline: none; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  .glass, .glass-float { backdrop-filter: none !important; background: var(--hh-color-float) !important; }
}
```

---

## 5. 逐屏规格

### 5.1 Shell / 标题栏（App.vue）
- 高 40px，整条 drag；`padding: 0 var(--hh-space-x3) 0 var(--hh-space-x4)`；**右侧留白 138px**（原生 overlay 控件区）。
- 左：`Flower2` 16px accent + 「HaneHana」13px/600 + 版本 caption tertiary（纯文本，去掉 chip 底色）。
- 去掉 `.tag` chip、去掉 ▦/☰ 之外的裸符号。layout gap 12→`var(--hh-space-x3)`，padding 底 12。

### 5.2 主侧栏（width 208）
- 结构：`[LibraryBig 全部游戏 +count] [Download 下载任务 +进行中count(accent 徽章)]` → spacer → `[ScanSearch 扫描导入] [Settings 设置]`。
- 分类过滤**移出侧栏**：改游戏库工具栏的 chip 行（§5.3）。
- item：高 34，radius 8，padding 0 10，icon 16 + 文字 13 + 右徽章（caption，底 rgba(255,255,255,0.08)，pill）；active = accentBg 底 + 文字 accentHover + 左 2px accent 竖条（inset）；hover = 白 6%。
- 分类 chip 数据源不变（allCategories）。

### 5.3 游戏库页
- 工具栏一行：搜索框（高 32，radius 10，card 底，**无 backdrop-filter**，内嵌 Search 图标）→ 分类 chip 行（overflow-x auto 无滚动条样式：`scrollbar-width:none`）→ 计数 caption tertiary → 视图 segmented（pill 容器 card 底，两枚 icon 按钮 28x28，active=accentBg+accent 图标）。
- 网格卡（固定度量 §3.5）：cover 184x276 radius 10 overflow hidden；img `hh://thumb/{id}` `loading="lazy"`；无 thumb 时占位 = `g.color || 哈希调色板` 底 + 标题前 2 字 24px/600 白 55% 居中。
  - 徽标：运行中=左上实色 success 90% pill（Activity 10px + 「运行中」11px）；**评分不上卡**。
  - 标题区 32px：标题 13/18 单行 ellipsis 左对齐 + 副行 caption tertiary（发行年 or 时长，tabular-nums）。
  - hover：卡 translateY(-4px) + shadow cardHover + cover `scale(1.05)`（167ms easeMove）；selected：cover 外 `box-shadow: 0 0 0 2px accent, 0 8px 24px rgba(77,163,255,0.25)`。
  - 键盘：容器 `role="grid"`，roving tabindex（方向键移动、Enter 选中），仅当前项 tabindex=0。
- 列表视图行 72：thumb 44x66 radius 6 + 标题/副两行 + 右侧三列 caption tabular-nums（发行/评分 Star fill/时长）。
- 空态：Flower2 40 tertiary + 「游戏库还是空的」subtitle + 提示 caption + 主按钮「扫描导入」（触发 scanOpen）。单 CTA。

### 5.4 详情面板（width 360）
- 横幅 180px：背景 thumb `blur(32px) saturate(1.2) scale(1.2)` opacity .55 + scrim 渐变到面板底；前景左 cover 92x138 radius 8 shadow card；右列：标题 16/22 600 两行 clamp、原名 caption、chips（发行年 chip 实半透明、评分 chip = Star fill warning + 数字）。
- 动作：主按钮满宽 40 radius 10（Play+「启动游戏」；运行中=Activity+「运行中」disabled 观感但可点=聚焦窗口？保持现状 disabled）；次行两 ghost 等宽（Wand2 刮削 / FolderOpen 打开目录）。
- 元数据：两栏行（label caption tertiary 左 / value 13 右，目录值为 link 色 accent）：时长、上次、目录、来源。
- 标签 chips（accentBg 底 accentHover 字 radius 6）；分类 toggle chips 同现状语义；简介 13/20 六行 clamp + 「展开/收起」link 按钮（本地 ref）。
- 未选中空态：Flower2 36 tertiary + 一句话 caption。

### 5.5 下载页
- **删除 `.dl-side` 第二侧栏**。顶部工具栏两行：
  - 行1：segmented 状态过滤（全部/下载中/已暂停/已完成/失败，各带 count，pill 容器同视图切换）+ 搜索框 + 排序 Select（宽 120）。
  - 行2 右对齐：总速度 caption mono accent（>0 时）+ 图标按钮组：Plus（primary 填充 32x32）/ PlayCircle / PauseCircle / RotateCw / Trash2（Popconfirm）。
- 任务行（高 64，radius 12，card 材质，margin-bottom 8）：
  - 左：状态色点 4px 竖条（同现状语义）+ 状态图标 16（§4.2 表）。
  - 中：name 13 单行 ellipsis；sub caption mono tabular-nums（速度·剩余·区间 / 错误行 / 完成信息，逻辑复用 status.ts sub 计算）。
  - 右：pct 13 mono + 状态 chip（自绘：dot+label，**替换 antd Tag/StatusTag 组件删除**）。
  - 进度条：absolute 行底 inset 12px，高 3，radius 2；下载中带流光（现状动画保留，时长改 1.2s linear infinite）。
  - hover：右上浮现 3 图标按钮（暂停或继续 / FolderOpen / Trash2 danger），167ms fade；selected 行 accentBg  tint。
- 空态：Download 40 tertiary + 文案 + 主按钮「新建下载」。

### 5.6 对话框
- 全部 antd Modal，靠 §4.1 tokens 变实色浮层；宽度：设置 680、刮削 560、扫描 480、新建下载 540。
- 设置：`Tabs tabPosition="left"`（下载/通知/网络/外观/关于）。表单行：label 140px 左对齐 13px + 控件；布尔全 Switch；**关于页**：版本、数据目录、仓库链接（caption）。删除现「外观」页里无实际作用的项则保留 dark 开关但 disabled+提示「深色为唯一主题」。
- 刮削：候选行 = thumb 44x66 + 标题/原名 + provider chip + 评分 Star；单选高亮 accent 边；warnings 用 error 色 caption 行；底部主按钮「应用选中」。
- 扫描：目录 Input + 浏览按钮 + 结果摘要（新增 N / 跳过 M）。
- 新建下载：URL Input、保存目录 Input+浏览、分片 InputNumber、校验和 Input、备注 Input；提交主按钮。

### 5.7 通知
- 渲染层 message 走 §4.1 CSS 兜底；主进程系统通知逻辑不动。

---

## 6. 执行计划（T1→T13）

> 每任务：改完跑 `npm run typecheck && npm run build`，再跑该任务验收，最后本地 commit（中文 message）。禁止 push。

**T1 tokens 单源 + 铁律清理**
- 新建 `design/tokens.ts`（§3.3 全量）+ `applyCssVars()`；`main.ts` 挂载前调用。
- 重写 `styles/glass.css` → `design/global.css`（§4.4 + 玻璃矩阵 §4.3 的 .glass/.glass-float/.glass-card 工具类，全部消费 var(--hh-*)）；更新 main.ts import。
- 删除违规 backdrop-filter：`CoverGrid.vue:187`、`App.vue:278`。
- 验收：typecheck+build 绿；grep `backdrop-filter` 在 renderer 只剩 global.css 的 panel/float 两处 + DetailPanel 横幅预模糊（T8 前允许暂缺）。commit。

**T2 图标系统**
- `npm i lucide-vue-next`（唯一新增依赖）。
- 按 §4.2 表替换全部 emoji/符号/应用层 antd icons；删除相关 `@ant-design/icons-vue` import。
- 验收：typecheck+build 绿；`grep -rn "@ant-design/icons-vue" src/renderer/components src/renderer/App.vue` 零命中；grep emoji 范围零命中。commit。

**T3 antd 主题重建**
- 新建 `design/antdTheme.ts`（§4.1）；删除 `theme.ts`；App.vue 改 import。
- global.css 加 message 兜底样式。
- 验收：typecheck+build 绿；CDP 起 preview 后 `getComputedStyle(document.querySelector('.ant-modal-content')).backgroundColor === 'rgb(38,38,43)'`（开一次设置弹窗测）。commit。

**T4 store 领域拆分**
- 按 §3.2 拆三模块；删除 store.ts；更新 App.vue/CoverGrid/DetailPanel/DownloadView/TaskRow/各 Dialog 的 import；wireTaskPushes 返回 unsubscribe 并在 App onUnmounted 清理。
- 验收：typecheck+build 绿；e2e_download 18/18；cdp_ui_download 9/9。commit。

**T5 图片管线**
- `main/thumbs.ts`（§3.4）+ types 加字段 + scraper 接线 + loadGames 回填 + protocol 注册（app ready 前）。
- 渲染层 urls 助手；CoverGrid/DetailPanel 暂仍可用 coverPath 回退（T7/T8 换 hh://）。
- 验收：typecheck+build 绿；e2e 18/18；手动：隔离 DATA_DIR 跑一次刮削（或伪造 coverPath 后启动）确认 thumbs/{id}.jpg 生成、games.json 有 thumbPath/color。commit。

**T6 虚拟化骨架**
- CoverGrid 网格/列表改 RecycleScroller（§3.5 度量 + ResizeObserver cols + 居中留白）。
- 验收：typecheck+build 绿；CDP 注入 1200 条假游戏（直接写隔离 DATA_DIR games.json 后启动）滚动网格，`document.querySelectorAll('.cover-card').length < 80`（窗口化生效）。commit。

**T7 游戏库屏重建**
- 工具栏（搜索+分类 chips+计数+segmented）、网格卡/列表行/空态按 §5.3；评分下卡、标题下置、占位色、roving tabindex。
- 验收：typecheck+build 绿；cdp_ui 9/9；CDP 断言：卡内无 backdrop-filter、img src 以 `hh://thumb/` 开头（有 thumb 时）、空态含单一 button。commit。

**T8 详情面板重建**
- §5.4 全量（横幅预模糊 thumb + scrim、动作层级、元数据、chips、简介 clamp）。
- 验收：typecheck+build 绿；CDP 断言 `.detail-panel` 宽 360、横幅存在 `.banner-blur` 且其 filter 含 blur(32px)、主按钮 backgroundImage 含 linear-gradient。commit。

**T9 下载页重建**
- 删 `.dl-side`；工具栏两行 + segmented 过滤；任务行 Motrix 化（§5.5）；删除 StatusTag.vue 与 antd Tag 用法，自绘 chip。
- 验收：typecheck+build 绿；e2e 18/18；**同步更新 `scripts/cdp_ui_download.mjs` 选择器**（.dl-side→.seg-filter 等）后 9/9。commit。

**T10 对话框重建**
- §5.6：设置左 tabs+关于页、刮削候选卡、扫描、新建下载；全部消费 tokens。
- 验收：typecheck+build 绿；cdp_ui 9/9（设置页签断言含「关于」）。commit。

**T11 shell / a11y / 数据迁移**
- §5.1 标题栏；§4.4 已在 T1 落地则补 roving tabindex（T7）之外的 Home/End；数据迁移：loadGames 内 `title/rawTitle` 空回落 `basename(dir)`，改过即 persist；侧栏分类移除后的兼容（categoryFilter 语义不变）。
- 验收：typecheck+build 绿；CDP 断言标题栏高 40、padding-right≥138、无 `.tag` chip；隔离目录放一条空标题 games.json 启动后 listGames 标题非空。commit。

**T12 视觉回归脚本**
- 新建 `scripts/cdp_visual.mjs`，断言（preview 实例上跑）：
  1. body innerText 无 emoji（正则 `/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u`，★▶▦☰ 单独列入黑名单字符集）；
  2. 遍历 `.cover-wall *` 与 `.dl-list *` computedStyle，backdropFilter 全为 'none'；
  3. 有 thumb 的卡 img src 前缀 `hh://thumb/`；
  4. body fontFamily 含 'Segoe UI Variable'；
  5. 侧栏宽 208、详情宽 360、标题栏高 40；
  6. 下载页存在 `.seg-filter` 且不存在 `.dl-side`；
  7. Tab 键聚焦首个 nav item 后 outline 宽 2px；
  8. Modal content 背景 rgb(38,38,43)。
- 跑全量：typecheck、build、e2e_download 18/18、cdp_ui_download 9/9、cdp_visual 8/8。
- 截图四张（库网格/详情/下载/设置）存 `docs/shots/` 供用户目验。commit。

**T13 收尾**
- README 增「视觉与架构」一节指向本文件；删除 `docs/shots` 之外的临时脚本；`git log` 自查每任务一个 commit；**不 push，等用户目验截图**。

---

## 7. 风险与回退
| 风险 | 回退 |
|---|---|
| createThumbnailFromPath 对个别编码失败 | 已内置 createFromPath+resize 二级回退；再失败 thumbPath 空走占位色 |
| RecycleScroller 网格错位 | §3.5 预案换 @tanstack/vue-virtual（先登记依赖） |
| hh:// 被 CSP/sandbox 拦 | webPreferences 不动；检查 registerSchemesAsPrivileged 是否在 ready 前；终极回退 thumb 走 file://（仅 thumb，cover 仍 hh://）并在 commit 说明 |
| antd 个别组件 token 不生效 | global.css 定点覆盖（最后手段，注释标明组件名） |
| 用户仍嫌玻璃不够/太够 | tokens 单点调：panelGlass alpha 与 blurPanel 两个值 |

## 8. 完成定义（DoD）
typecheck 0 错；build 成功；e2e 18/18；cdp_ui 9/9；cdp_visual 8/8；四张截图在 docs/shots/；13 个本地 commit；无 push；铁律 10 条 grep 自检全过。
