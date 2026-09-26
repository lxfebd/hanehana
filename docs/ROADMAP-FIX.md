# HaneHana 整改路线图（评审后调研 · 草案待审）

- 版本：v0.1 草案（2026-10-08）
- 状态：**等用户审核**；审完再按批次落地
- 范围：J:\xiangm_transfer\hanehana（Electron + Vue3 + ant-design-vue + Rust 下载引擎）
- 硬约束（全程有效）：不改 IPC 通道名；games.json 只增字段；**禁新增依赖**（除「依赖决策清单」中用户点头项）；颜色/圆角/阴影/动效/字号/间距只准来自 `tokens.ts`；图标只用 lucide-vue-next；每批 `npm run typecheck` 0 错 + `npm run build` 绿 + 对应验收脚本过才提交；中文 commit、**不 push**
- 验收端口规约：9230–9288 已被历史批次占用，**新批次从 9272 起**

## §0 三路调研来源

| 路 | 内容 | 状态 |
|---|---|---|
| 评审 | 三层子代理 + 截图交叉验证（视觉 8 / 架构 8.5 / 旅程 6.5 / 完成度 7 / 差异化 8） | 已完成 |
| 代码锚点 | 12 项问题的精确 file:line + 建议改法（explore） | 已完成 |
| 网络对标 | Motrix / aria2 / Playnite、stylelint 禁裸值、Fluent Mica、Electron 拆分与单测（webfetch 实抓） | 已完成 |

与既有文档分工：

- `docs/IMPROVEMENT-SPEC.md` —— 上一轮「交付面 / 可靠性 / 安全」规格。其中 CI、LICENSE、engine-rs 六模块拆分、`sanitizeGamePatch` 白名单、游戏库虚拟化**已在本仓库落地**，不重复。
- 本文档 —— 本次评审暴露的**用户旅程闭环、设计系统执行、结构与 i18n**，P0/P1/P2 分级 + 分批落地计划。

对标核心结论（网络调研）：

1. **下载完成 ≠ 终态**：Motrix/Playnite 都把「文件就位」当入口事件，由 `afterComplete → 扫描/识别 → 入库` 事件链接手；HaneHana 缺的正是这座桥。
2. **批量刮削范式**：Playnite `MetadataRequestOptions.IsBackgroundDownload` 区分「后台批量（仅冲突才确认）」vs「手动单刮」，可直接复刻。
3. **禁裸值两条路**：`stylelint-declaration-strict-value`（regex + ignoreValues + autofix，需新依赖）或 stylelint 内置 allowed-list（stylelint 本体也是新依赖）；零依赖替代 = 验收脚本 grep 断言。
4. **antd 切主题**：`ConfigProvider.theme` 不可传 `undefined`（会 re-mount），用 `{}` 或 algorithm 数组。
5. **Mica 要点**：base layer 打底 + 低透叠层，内容层须透明才透出；Electron 原生接入成本高，列为可选项。

## §1 P0（伤害最大 · 优先做）

### P0-1 on-accent 可读性事故（输入文字发虚）

- **改哪些文件**
  - `app/src/renderer/components/ScanDialog.vue:84`（`.path-input` 底 `surface-soft` 却用 on-accent）
  - `app/src/renderer/components/AddGameDialog.vue:91`（同款同病）
  - `app/src/renderer/components/ScrapeDialog.vue:122`（同款同病）
  - `app/src/renderer/components/CoverGrid.vue:422`（`.cover-running` 底 `success`）、`CoverGrid.vue:506`（`.list-running` 同病）
- **改法**：三处 path-input 改 `var(--hh-color-text-strong)`；running 两处改 success 反白（底 success 上用白字，或直接 `var(--hh-color-text)`）
- **不动**：底为 `accent-grad`/`accent` 的按钮类（`ScanDialog.vue:93`、`AddGameDialog.vue:100`、`ScrapeDialog.vue:130/182`、`CoverGrid.vue:335/441/519` 等）——那里 on-accent 是正确用法
- **验收**：typecheck + build；截图确认路径输入可读；grep 复查非主色底上的 on-accent 归零
- **新依赖**：无

### P0-2 antd 主题种子不随 preset 切换

- **改哪些文件**：`app/src/renderer/design/antdTheme.ts:70-72,83`
- **现状**：`bodyBg/bodyText/border` 仅按 dark/light 写死 hex（`#0E0B16` / `#FFFFFF`），不读 `themePresets`（sakura / starnight / mint）；`colorState.accent` 跟 preset 走但 seed 不跟
- **改法**：seed 从 `tokens.ts` 的 `makeTheme`/`themePresets` 同源派生；`ConfigProvider.theme` 切换时传对象不传 `undefined`（antd 官方主题文档）
- **验收**：3 preset × 2 明暗共 6 态截图，antd 控件背景/边框/主色随动；typecheck + build
- **新依赖**：无

### P0-3 错误 advice 不上前台任务行

- **改哪些文件**
  - `app/src/shared/errors.ts:195-201` —— `errorLine()` 只 `return e.title`，advice 被丢弃
  - `app/src/renderer/components/TaskRow.vue:94,98` —— 副标题只用 `errorLine`
- **改法**：`errorLine` 改为「title + 分隔 + advice（截断）」或新增 `errorLineFull`；详情卡继续用 `explainError` 全量。**不改** `main/index.ts` 前台 mute 语义（那是防打扰设计，`notifyTerminal` 的 frontmost 判断保持原样）
- **验收**：模拟 404/429 类失败，任务行副标题可见「下一步」句；typecheck + build
- **新依赖**：无

### P0-4 编辑框支持改主 exePath（路径失效自救）

- **改哪些文件**
  - `app/src/renderer/components/EditDialog.vue`（patch 组装约 L101-122；全文无主 `exePath` 字段，仅变体 exe 在 L194）
  - `app/src/main/gameStore.ts:135-161`（`PATCHABLE` 白名单）、`:170+`（`sanitizeGamePatch`）
  - `app/src/main/index.ts:457-462`（`GameAddOne` 已有存在性/长度/控制字符校验，可复用标准）
- **改法**：
  1. `PATCHABLE` 增加 `'exePath'`；
  2. `sanitizeGamePatch` 新增 `case 'exePath'`：string + trim + `existsSync` + `resolve` + 长度 ≤4000 + 控制字符过滤（与 GameAddOne 同标准）；`dir` 由 `dirname(exePath)` 同步推导；
  3. EditDialog 增「启动路径」一行 + 浏览按钮（复用现有选文件 IPC）
- **安全依据**：`gameStore.ts:122` 注释担心「改 exePath = 执行任意程序」，但 `variants.exePath`（L200-216）已先例用同等 `existsSync` 校验开放；渲染层能投递的始终只是「磁盘上真实存在的 exe」，**攻击面不扩大**。不做这步则「启动报文件不存在但改不了」闭环永远断。
- **验收**：改路径 → 保存 → 启动走新路径；填不存在路径被拒且有提示；typecheck + build + 相关 accept 批次
- **新依赖**：无

### P0-5 下载完成 → 导入库（打通闭环断点）

- **改哪些文件**
  - `app/src/renderer/components/TaskRow.vue`（done 态 L108/190 仅有「打开所在文件夹」，无「导入游戏库」）
  - `app/src/main/index.ts:299-306`（done 通知只有文案，无动作）
- **改法**：
  1. TaskRow done 态若产物是 exe（或位于可扫描目录）→ 增「导入库」按钮，复用已有 `Ipc.GameAddOne` / `preload.addGameOne`；
  2. 系统通知点击已有「聚焦任务」路径（`TaskFocus`），在任务详情/完成卡补同一入口；
  3. zip 等压缩包本期**不做自动解压**，提示「解压后用扫描入库」
- **对标**：Motrix `afterComplete` 钩子 / Playnite 导入 service——先做事件消费按钮，完整事件链列 P2 可选
- **验收**：新 accept 批次（端口 **9272**）：下载 exe 完成 → 点导入 → 游戏库出现该作；typecheck + build
- **新依赖**：无

### P0-6 保存语言不即时生效

- **改哪些文件**
  - `app/src/renderer/components/SettingsDialog.vue:234`（`language` 已进 save payload，但没人调 `setLanguage`）
  - `app/src/renderer/App.vue:123-148`（saveSettings 回调）与 `App.vue:165`（目前仅 onMounted 调一次 `setLanguage`）
- **改法**：saveSettings 成功回调里 `setLanguage(form.language)`；`i18n/index.ts:98` 的 ref 已是响应式，无需架构改动
- **验收**：切 en → 保存 → 无需重启即生效；typecheck + build
- **新依赖**：无（**不接 i18next**——见 §4）

## §2 P1（体验与结构明显短板）

### P1-1 批量刮削

- **锚点**：`stores/library.ts:370-374` 仅 `scrapeTargetId` 单 id；`DetailPanel.vue:199` 单游戏入口；`BatchEditOverlay.vue` 已有多选基础与批量 patch 通道（`library.ts:258`）
- **改法**：BatchEditOverlay 增「批量刮削」→ 队列串行调现有刮削管线，**后台执行 + 进度条 + 可取消**；多候选冲突默认跳过并汇总「N 款待确认」，复刻 Playnite `IsBackgroundDownload` 分界（批量不逐个弹窗）
- **验收**：多选 ≥5 款批量刮削 → 完成计数正确、冲突列表可二次确认；typecheck + build + accept（新端口）
- **新依赖**：无

### P1-2 BackupDialog 收敛原生弹窗

- **锚点**：`BackupDialog.vue:84,106` 为 `window.confirm`；`BackupDialog.vue:93,133` 为 `window.alert`
- **改法**：`Modal.confirm` + `message.success/error`（与全库其余弹层一致）
- **验收**：恢复/删除流程走 antd；`grep -E "window\.(confirm|alert)" src` 归零
- **新依赖**：无

### P1-3 全屏墙接虚拟滚动

- **锚点**：`FullscreenView.vue:224-247` 全量 `v-for` + CSS grid；对照 `CoverGrid.vue:22` 已有 `RecycleScroller` 成熟先例
- **改法**：接 `vue-virtual-scroller`（已在依赖里，非新增），itemSize 按网格列宽计算；保留现有键盘导航语义
- **验收**：10k seed 进全屏墙，DOM 节点数 <80（t6 同款断言思路）；typecheck + build
- **新依赖**：无（复用已有）

### P1-4 侧栏 9 项动作收纳

- **锚点**：`App.vue` nav-item 共 9 项（约 L225/235/245/254/264/268/272/276/280：库/下载/游戏站/统计/全屏/扫描/添加/Steam/设置）
- **改法**：主导航收敛为 **库 / 下载 / 扫描 / 设置**；游戏站、统计、全屏、添加、Steam 导入 收进「更多」菜单（或工具栏溢出区）——**只收纳不删功能**，符合 REDESIGN 规格 §5.2
- **验收**：截图比对层级清晰；所有收纳项仍一键可达；typecheck + build + cdp_ui 类冒烟
- **新依赖**：无

### P1-5 IPC handler 错误形状统一

- **锚点**：`main/index.ts:452` `GameScan` 用 `throw new Error(...)`（同文件兄弟用 `err()`）；`main/index.ts:520-523` `BackupDelete` 回 boolean，与兄弟 `{ok:false,error}` 不一致
- **改法**：统一 `err()` / `{ok:false,error}` 形状；**通道名一字不动**
- **验收**：typecheck + build；扫描/备份删除路径 e2e 抽测
- **新依赖**：无

### P1-6 下载完成通知动作（可并入 P0-5）

- **锚点**：`main/index.ts:299-306` 通知正文无动作
- **改法**：与 P0-5 同批——通知文案附「打开文件夹 / 去导入」指引，点击沿用现有聚焦路径
- **验收**：随 P0-5 批次一并验
- **新依赖**：无

## §3 P2（治理与长期结构）

### P2-1 设计 token 全量替换 + 禁裸值闸

- **锚点（样例各 10 行）**：
  - `App.vue:492,494,520,524,525,546,549,565,618,623`
  - `DetailPanel.vue:322,326,345,349,384,394,406,414,420,423`
  - `CoverGrid.vue:316,326,327,332,336,339,369,373,399,403`
  - `SettingsDialog.vue:575,595,599,608,628,632,645,649,654,660`（L632 已是 `--hh-motion-*`，多数仍裸）
- **改法**：批量替换为 `var(--hh-radius-*)` / `var(--hh-font-*)` / `var(--hh-motion-*)`（tokens 已有：`tokens.ts:27` radius 等）
- **闸门分两步**：
  1. **零依赖先行**：验收脚本加 grep 断言（组件内裸 hex / 裸 px 圆角 = 0）——IMPROVEMENT-SPEC §5 已有同款命令；
  2. **stylelint 完整版**（需点头，见 §4）：`scale-unlimited/declaration-strict-value`（regex 匹配 `color`/`font-size`，`ignoreValues` 放行 `inherit/currentColor/0`）或内置 `declaration-property-value-allowed-list`
- **验收**：typecheck + build + grep 断言进 accept
- **新依赖**：grep 版无；stylelint 版 **需点头**

### P2-2 8 个 Dialog 体系统一

- **现状**：`AddGameDialog / EditDialog / ScanDialog / SettingsDialog / BackupDialog / SteamImportDialog / ScrapeDialog / NewDownloadDialog` 共 8 个；评审确认 4 个走 BackdropDialog、4 个裸 Modal，体系分裂
- **改法**：抽 `DialogShell`（backdrop + title + footer 插槽，token 化圆角），8 个渐进迁移；顺手清「双标题」类历史问题
- **验收**：裸 Modal 引用归零；6 态截图比对无回退
- **新依赖**：无

### P2-3 i18n 第二阶段（扩词条，不换库）

- **现状**：`i18n/index.ts` zh/en 各 37 键（L12-88）；即时生效已由 P0-6 打通
- **改法**：补主要交互词条（详情/下载/设置/错误 advice 高频句）；**保持手写词典**
- **验收**：en 切换后关键页抽查无 key 裸奔
- **新依赖**：无（**不接 i18next**：Motrix 用它，但硬约束禁新增，37→60 词条手写成本远低于引库）

### P2-4 `main/index.ts` 拆分（上帝文件）

- **现状（实测）**：**818 行、44 个 `ipcMain.handle`** 全在单文件；`src/main` 共 17 个文件
- **改法**：按域拆 `registerGamesHandlers / registerTasksHandlers / registerSettingsHandlers / registerBackupHandlers / registerSteamHandlers / registerScanHandlers / registerScrapeHandlers / registerStatsHandlers / registerNetHandlers / registerWinHandlers`，入口只组装；**纯移动零行为变化，通道名不改**
- **对标**：Electron 官方 IPC 教程「channel 命名空间 + 按域注册」
- **验收**：typecheck + build + 既有 e2e/accept 全量抽测通过
- **新依赖**：无

### P2-5 Electron 侧单测

- **现状**：无 vitest、无 `*.test.ts`（已核实 glob 为空）；engine-rs 有 Rust 单测且 CI 已在跑
- **改法**：先抽纯函数测试位（`errors` 规则表、`sanitizeGamePatch`、`format`、`proxy`）；壳层 e2e 走 Playwright `_electron.launch`（官方推荐路径，评估是否已在现有 cdp 脚本覆盖）
- **验收**：**待 §4 点头后** `vitest run` 全绿并进 CI
- **新依赖**：**vitest 需点头**（IMPROVEMENT-SPEC §6 原「待决策」项继续挂起）

### P2-6 Fluent / Mica 视觉增强（可选）

- **改法**：低成本近似已具备（窗口背景随 `bodyBg`）；原生 Mica 需 titlebar 与内容层透明化改造，**本期不做**，仅在本路线图挂号
- **验收**：若做，另批评估
- **新依赖**：无

### P2-7 afterComplete 事件链（P0-5 的完整版，可选）

- **改法**：主进程任务终态 → `TaskTerminal` 事件总线 → 扫描/刮削/入库订阅；P0-5 的按钮是这条链的第一位订阅者
- **验收**：解压目录场景（若未来做 zip 支持）自动入库
- **新依赖**：无

## §4 依赖决策清单（需用户点头，默认全否）

| # | 依赖 | 用途 | 不点头的替代 |
|---|---|---|---|
| 1 | stylelint + declaration-strict-value | P2-1 完整闸 | 验收脚本 grep 断言 |
| 2 | vitest | P2-5 单测 | 保持 e2e/accept 体系 |
| 3 | i18next | i18n | 手写词典（已选） |
| 4 | Mica 相关窗口改造 | P2-6 | 维持现有 backgroundColor 近似 |

## §5 落地批次建议（每批 = typecheck + build + 对应验收 + 中文 commit 不 push）

| 批 | 内容 | 预估风险 |
|---|---|---|
| **R1** | P0-1 + P0-2 + P0-6（视觉止血 + 即时生效） | 低：纯渲染层/主题 |
| **R2** | P0-3 + P0-4（错误 advice 上行 + 路径自救） | 中：碰白名单，靠 existsSync 护住 |
| **R3** | P0-5 + P1-6（下载→导入闭环，端口 9272） | 中：新按钮 + 新 accept 批次 |
| **R4** | P1-1 批量刮削 | 中高：队列与冲突态 |
| **R5** | P1-2 + P1-4 + P1-5（弹窗收敛/侧栏收纳/错误形状） | 低 |
| **R6** | P1-3 全屏虚拟化 | 中：键盘导航回归 |
| **R7** | P2-1 零依赖版（token 替换 + grep 闸） | 低但量大：脚本替换 + 抽查 |
| **R8** | P2-2 + P2-4（DialogShell + index.ts 拆分） | 中：结构移动零行为 |
| **R9** | P2-3 i18n 扩词 | 低 |
| **挂起** | P2-5 / P2-6 / P2-7 | 等依赖点头或后续里程碑 |

## §6 验收总口径

```text
cd app && npm run typecheck   # 0 错
cd app && npm run build        # 绿
cd app && node scripts/accept_batchN.mjs   # 对应批次（新批从 9272 端口起）
grep -rE "[0-9a-fA-F]{6}" src/renderer/components --include="*.vue" | grep -v "hh-"   # R7 后归零
grep -rn "window\.(confirm|alert)" src    # R5 后归零
```

历史批次资产：`app/scripts/accept_batch1-14.mjs`（14 批，端口 9263–9271 段）全部保持可复跑。

## Sources

- Motrix（afterComplete / 四层架构）：https://github.com/agalwood/Motrix
- aria2 事件接口：https://github.com/aria2/aria2
- Playnite LibraryPlugin / MetadataPlugin（`IsBackgroundDownload`）：https://api.playnite.link/docs/tutorials/extensions/metadataPlugins.html 、 https://api.playnite.link/docs/tutorials/extensions/libraryPlugins.html 、 https://github.com/JosefNemec/Playnite
- stylelint-declaration-strict-value：https://cdn.jsdelivr.net/npm/stylelint-declaration-strict-value@1.10.6/README.md
- stylelint 内置规则：https://stylelint.io/user-guide/rules/list
- Fluent Mica：https://learn.microsoft.com/en-us/windows/apps/design/style/mica
- Ant Design 主题定制：https://ant.design/docs/react/customize-theme ；ant-design-vue：https://github.com/vueComponent/ant-design-vue
- Electron IPC / 自动化测试：https://www.electronjs.org/docs/latest/tutorial/ipc 、 https://www.electronjs.org/docs/latest/tutorial/automated-testing
- Vitest：https://vitest.dev/guide/

网络调研未抓到（如实）：PotatoVN（404）、LunaBox（404/超时）、GalgameManager（transport error，仅搜索页确认存在）。
