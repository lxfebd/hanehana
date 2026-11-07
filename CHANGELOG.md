# 更新日志

本文件记录 HaneHana 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

### 新增

- **浏览器扩展投递下载链接**（native messaging 全链路）：`app/extension/` 新增 MV3 扩展——右键菜单（链接 / 页面）+ 弹窗手动投递直链，经 Chrome 的 native messaging 通道交给桌面端建下载任务。链路是三段：扩展 service worker →（4 字节小端长度 + UTF-8 JSON 帧）→ Chrome 拉起的**宿主模式进程**（`main/nmHost.ts`：认 argv 里的扩展 origin，不占单实例锁、不开窗口、stdout 只走协议帧、日志一律 stderr）→ 本机桥（`main/nmBridge.ts`：127.0.0.1 随机端口 + 每次启动换新的随机 token，桥上再校验一次 origin）→ 主应用（`main/nmService.ts`：Manager 建任务 + `Ipc.NmLink` 推给下载页）。应用没开着时链接先排队（`nm-pending.jsonl`），应用下次启动自动接手并补发推送。设置页新增「浏览器扩展」页签（`renderer/components/nm/BrowserExtensionPanel.vue`）：逐浏览器注册 / 注销宿主（写注册表 32/64 位双视图 + 宿主清单）、扩展 ID 一键复制、扩展目录打开、桥状态与排队数。协议契约唯一真值在 `shared/nmProtocol.ts`（字段名、长度上限、校验规则），扩展侧同名常量必须与它对齐。
- **下载引擎支持自定义请求头**（`engine-rs`）：`Cmd` 新增 `headers`（字符串→字符串），`probe` / `run` 都带，扩展带来的 `Referer` / `Cookie` / `User-Agent` 因此能真正发到下载源（解决「离开浏览器就下不动」）。引擎侧有黑名单：`host` / `content-length` / `transfer-encoding` / `connection` / `accept-encoding` / `range` / `upgrade` / `te` / `trailer` / `proxy-authorization` / `proxy-connection` 一律丢弃（能改写分段区间或连接分帧）；非法头名/头值跳过而不是让整个客户端建不起来；头值不进任何错误文案、日志与快照。
- **游戏站左栏「最近访问」**（`renderer/components/GameSites.vue`）：内嵌 webview 每次主框架导航（`did-navigate` / `did-navigate-in-page`）记一笔 URL，去重、最新在前、上限 8 条，存 `localStorage`（key `hh:gs-recent`，重启不丢）；左栏闲置态（未搜索时）渲染该列表（`History` 图标 + 域名，点击回跳 `nav(url)`），此前闲置时左栏整片空白。新增 i18n `gs_recent`（中/英）。CDP 实证：切站点 + 导航后左栏出现「最近访问 | example.org | example.com | www.gamer520.com」，localStorage 同步落盘，截图 `app/.shots/proof/games-recent.png`。
- **新增资源站 TouchGAL**（`touchgal.ink/galgame`，`main/sites/touchgal.ts` + `registry.ts` 注册）：侧栏第四个站点按钮，内嵌 webview 直接加载其 Galgame 列表（真 Chromium 过 Cloudflare）。其 10 个镜像域（.ink/.com/.co/.io/.me/.moe/.net/.one/.org/.us）与资源 CDN `touchgaloss.com` 全部归入 `hosts`，内嵌浏览器里点任意镜像域的下载都会被 `siteIdForUrl` 认回 touchgal 走捕获桥。适配器 `search` 走已验证的 SSR 列表页卡片（`a[href="/<8hex>"]`）做标题过滤——官方 API（`developer.touchgal.com/api/v1/games/search`）业务接口需 token、站内 `/search` 为客户端渲染，均不匿名可用，故不猜接口；`mirrors` 诚实提示资源链接在站内客户端加载、请在内嵌浏览器里点（自动捕获）。`gs_hint` 文案由「三个站点」改为「各站点」。实测：4 站按钮齐显、webview 成功渲染 TouchGal 列表（截图 `app/.shots/proof/tg-webview.png`）、`sitesSearch('touchgal','夏')` 返回 2 条真实结果、空关键词返回全部 23 条、无匹配给出明确提示。

### 变更

- **扩展 ID 钉死**（`shared/nmProtocol.ts` + `app/extension/manifest.json` + 宿主清单 `allowed_origins`）：扩展 manifest 的 `key` 写死公钥，ID 恒为 `jjoapnhpnedocdkfffpiccdehollooab`。不钉死的话每台机器「加载已解压的扩展程序」生成的 ID 都不同，宿主清单得按机器生成，那就不叫一键安装了。改 ID 必须三处同步改。扩展弹窗带运行时 ID 自检，不一致会直接报红。
- **宿主改由独立中继 exe 承接**（`engine-rs/src/bin/nm_host.rs`，产物 `fastdrop-nm-host`）：Chrome 宿主清单的 `path` 现在指向这个纯 Rust 小程序，它把 Chrome 给的 origin 转成环境变量再拉起桌面端，并把桌面端的应答按 native messaging 协议重新封帧转发。原因是端到端实测挖出的两个硬坑：① Electron 在 Windows 启动时会往 stdout 写一个 `"\r\n"`（原生代码，JS 拦不掉），而 Chrome 把 stdout **首 4 字节**当长度头，多 2 个字节整条链路就错位，扩展侧表现为「通信错误 / 一直转圈」；② Chrome 只把 origin 作为命令行第一个参数追加给宿主，而 Electron 会把第一个位置参数当成「要加载的应用路径」，直接拉起根本起不来。中继的 stdout 没有任何 Electron 噪音，天然干净。桌面端与中继之间用私有帧（`HHNM` + 4 字节小端长度 + JSON）传应答，中继剥掉魔数后按 Chrome 协议转发。

### 已知限制

- 扩展传来的 `Cookie` / `Referer` **只在内存里**，不写进 `tasks.json`（凭据不该明文躺在存档里）；代价是重启后续传会缺登录态，引擎照常报 403。
- 开发态注册宿主需要两个产物就位：`engine-rs` 跑 `cargo build --release --locked`（生成 `fastdrop-nm-host`）与 `npm run dist:dir`（生成桌面端未安装版）；缺任何一个时安装动作会明确报错而不是写半截清单。
- 「加载已解压的扩展程序」这一步仍需用户在浏览器里手动做（浏览器安全限制），界面只做引导。

### 修复

- **native messaging 宿主读不到 stdin**（`main/nmHost.ts`）：Electron 主进程的 `process.stdin` 是空壳（`fd` 为 `undefined`，连接会立刻 `end`），照常规 Node 写法监听它的 `data`，宿主会在 Chrome 还没递消息之前就退掉，扩展侧只看到「宿主已退出」。改为按 fd 0 自己开流（`createReadStream('', { fd: 0 })`），异步读取不卡事件循环；同时应答写完等写回调再退出，避免 `app.exit()` 截断半截帧。
- **宿主拉起图形界面时会把自己也带进宿主模式**（`main/nmHost.ts`）：origin 经环境变量传入，排队路径拉起 GUI 时若原样继承，界面进程会以为自己是宿主而不开窗口、转头去读 stdin。拉起前清掉 `HANEHANA_NM_ORIGIN` 与 `ELECTRON_RUN_AS_NODE`。
- **每次投递都漏一整套宿主进程**（`main/nmHost.ts` + `engine-rs/src/bin/nm_host.rs`）：应答发出去后宿主退不掉，进程树（Electron 主进程 + GPU + utility）常驻。根因是 Electron 宿主模式（不开窗口、不等 `app.whenReady`）的退场方式选错了：`app.exit()` 会把 Electron 的消息循环**停掉**，进程既不退（fd 0 的读流还挂着，libuv 认为还有活干）又不再跑任何回调（连后面的代码都执行不到，于是 `process.exit()` 根本没机会跑）。改为：应答写完且写回调落地后直接 `process.exit(0)`（数据已交给内核管道，先退不丢数据），读流用默认的 `autoClose` 以便 `destroy()` 真正关掉 fd 0、释放句柄。中继侧配套加固：桌面端 stdin 由中继用管道接管（应答转出后**等写线程真的结束**再关管子——中继自己先退会把线程一起带走，管子来不及关，桌面端永远等不到 EOF），桌面端 stdout 改由独立线程读、主线程用带超时的收包，桌面端卡住时中继能在 5 秒内强杀它而不是跟着卡死。

- **标题栏右侧给原生窗口按钮让位**（`design/global.css`）：自绘标题栏的右内边距原先是固定值，设置钮压在 Windows 原生 titleBarOverlay（最小化/最大化/关闭，宽 138px）上。改成 `calc(var(--hh-layout-overlay-right) + var(--hh-space-x3))`，让位宽度跟着 overlay 走，设置钮与关闭钮不再重叠。
- **删侧栏他人署名**（`NavSidebar.vue`）：移除侧栏底部的「© huoshen80」署名与配套样式——那是从基准图抄来的他人署名，不该出现在本项目 UI 里。
- **KPI 值底部对齐**（`HomeView.vue`）：`.hk-val` 补 `margin-top: auto`，把四格 KPI 的数值压到等高 cell 底部，数字基线对齐（末格标签比其余高一截时尤其明显）。
- **Continue 封面左缘渐变融底**（`LibraryHero.vue`）：hero 封面去掉垫底色与投影，图片左缘 24% 渐隐到透明，直接融进后面的模糊底，不再像「贴了一张硬矩形」；无封面时的大字占位仍保留面板底色与描边。渐隐色标走新增的 `--hh-mask-opaque` token（真值在 `design/tokens.ts`）——组件内裸 hex 是硬闸，`#000` 字面量会让 `regression:static` 变红。
- **按钮弹窗被下面的游戏卡片覆盖**（层叠根因，已修 + 立闸）：`.toolbar` 的 `backdrop-filter` 会自建 stacking context，把内部 `.export-menu` 的 `z-index: 30` 关在工具栏内；而工具栏在 `.layout` 层叠上下文里 z-index 为 auto、先于后绘制的 `.cover-wrap`（封面墙）绘制，于是导出下拉被封面卡片盖住、点不到。修复：`.toolbar` 自身抬到正 z（`var(--hh-layer-popover)`），整条工具栏（含下拉）压过封面墙。同步把所有**页级** z-index 收敛到 `design/tokens.ts` 新增的 `layer` 真值组（发射为 `--hh-layer-*`，antd 侧 `zIndexPopupBase` 接到 `LAYER.modal`），页级浮层组件内不再裸写数字（卡片内部 1/2/3 装饰层属局部上下文，不动）。新增真机命中闸 `regression:layers`（`app/scripts/verify_ui_layers.mjs`）：起真实渲染进程（CDP），逐个打开右键菜单 / 导出下拉 / 更多菜单 / 设置对话框 / 快捷键帮助 / 详情整页展开 / 批量浮条，对每个浮层在其内部网格 + 与 `.cover-card` 相交处采样 `document.elementFromPoint`，断言最顶层元素属于该浮层（否则记下盖住它的元素 class 并 FAIL），截图留痕到 `app/.shots/uilayer/`；已接入 `scripts/reg_all.mjs`（`--no-layers` 可跳过）。修复前此闸在 export-menu 上复现红（5/17 采样点被 `.cover-card` 盖住），修复后 10/10 绿。
- **库页未选中时右栏空白**（`App.vue`）：注释 B4 明确「右栏永远有内容」，但 `ActivityFeed` 的 `v-else-if` 只写了 `page === 'home'`，导致库页未选中游戏时右栏落到 `.aside-blank` 死空白——窗口越大这条 400px 空栏越刺眼（2560×1440 / 3840×2160 实截可证）。改为 `v-else-if="!ui.detailCollapsed && (page === 'home' || !selectedGame)"`，库页未选中也显示动态流；≤1100px 时仍由 useBoot 有意收起为 28px 栏。闸门新增「库页右栏非空白」断言（展开态须有 `.activity-feed`/`.detail-panel`，收起态允许）。
- **游戏站内嵌浏览器一点链接就被甩到系统默认浏览器**（`main/index.ts` 全局 `setWindowOpenHandler`）：原规则把所有 WebContents（含游戏站 webview guest）的 http(s) `window.open`/`target=_blank` 一律 `shell.openExternal`，站点里详情/下载页几乎都用新开窗口，导致内嵌页只能停在首页、成了摆设。改为：弹窗一律 `deny`（不产生不受控 Electron 窗口）；其中「嵌入在主窗口里的游戏站 webview」的新开窗口通过新增推送 `Ipc.GsLoadUrl` 让嵌入端（`GameSites.vue` 订阅 `onGsLoadUrl`）在当前 webview 内 `loadURL`，站内浏览不离开内嵌页；主窗口等其余 contents 仍甩系统浏览器；非 http(s)（javascript:/file:/自定义协议）一律拒绝。真机验证（本地两页 + CDP）：guest 内 `window.open` 与 `target=_blank` 链接均留在内嵌 webview 导航到目标页且地址栏同步、`javascript:` 被拒、无弹窗冒出，6/6 PASS。
- **窄窗口缩小内容被裁掉消失、右上角设置钮空间不足**：窗口最小尺寸 960×600 → 800×520；内容列 `.content` 由 `overflow:hidden` 改为 `overflow-x:auto`（窄窗下溢出内容改为横向滚动可达，不再直接消失）；≤700px 收起标题栏应用名/BETA 芯片，保证右上角设置钮与原生 overlay 关闭按钮始终有空间；游戏站工具条 `flex-wrap:wrap` 允许换行；≤560px 首页 hero 改单列纵排。CDP 窄窗实测 800/720/600/520：设置钮全部 visible（right=宽-150）、文档无横向溢出、各页内容均可达，截图留证。
- **传输不稳定兜底补强：过程性故障自动续跑、来源端致命错误不空转**（`shared/types.ts` + `main/manager.ts` + `main/engine.ts`）：新增 `ENGINE_TRANSIENT_ERROR_CODES`（`engine_exited` / `engine_hang` / `engine_spawn_failed`）——引擎进程自身崩溃/卡死/起不来这类「过程性」错误，下载源和 `.part`+sidecar 断点都还在，重启后理应自动续传。`isAutoResumable(state, errorCode?)` 现在对 `error` 态按码区分：只有过程性错误码才自动续跑，来源端致命错误（403 / 磁盘满 / 校验不过 / 无视 Range / 截断…）保持 error 交给用户手动重试，避免每轮启动都自动重试一遍又失败的空转。会话内引擎子进程意外退出时不再直接落 error 等人点，而是自动重拉（`run(true)` 重 spawn，probe 读回 sidecar 从断点续传），上限 3 次、退避 2s/5s/10s，跑起来后计数清零；用户暂停/取消/重下会取消待重拉的定时器。实证（CDP + taskkill，截图 `app/.shots/proof/autoretry-proof.png`）：预置 `engine_exited` 的任务启动后被自动拉起（error_code 变为 `request_failed` 说明引擎已重跑）、`http_403` 任务不动；运行中 `taskkill` 杀掉 `fastdrop-engine.exe` 后进程数 1→0→1，新引擎被自动拉起。闸门：build 0、typecheck 0、test 130/130、reg_all ALL PASS（含 layers 35/0）、gamesites 4/4。
- **Esc 关不了快捷键帮助面板，且弹层打开时页面级快捷键仍在背后生效**（`composables/useGlobalShortcuts.ts` + `DialogShell.vue` + `GameContextMenu.vue` + `ShortcutHelp.vue`）：自绘浮层（`.ds-mask` / `.ctx-menu` / `.sc-mask`）根节点没有 `data-dialog` 标记，`anyDialogOpen()`（只认 `.ant-modal-root` / `[data-dialog="open"]`）一概认不出——于是 ① 帮助面板开着时按 `1/2/3`、Space 仍会在背后切页/启动游戏；② 全局 Esc 分支在 `anyDialogOpen()` 早退之后才执行，而帮助面板自身没有任何 keydown 监听（旧注释谎称由 watch 注册），Esc 永远关不掉它，只能点 ✕ 或点遮罩关闭。修复：三类自绘浮层根节点统一加 `data-dialog="open"`；全局按键处理把 Escape 分支提到早退之前——优先关帮助面板（preventDefault + stopPropagation），其次 `anyDialogOpen()` 交给弹层自身（DialogShell / 右键菜单各自有 capture keydown），再清搜索词 / 退多选；非 Esc 键在任一弹层打开时一律不抢。CDP 实证（`app/scripts/out/esc-fix-verify.mjs` 8/8 PASS，截图 `app/.shots/audit/40-help-open.png`）：F1 打开帮助面板 → 按 `2` 不切页 → Esc 关闭面板；设置弹窗打开时按 `2` 不切页、Esc 正常关闭；封面右键菜单 Esc 关闭。闸门：electron-vite build ✓、typecheck ✓、test 130/130、reg_all ALL PASS（layers 35/0，含 sc-panel 的 elementFromPoint 命中）。

### 验证

- typecheck 0；lint 0 problem；build OK；npm test 130 pass / 0 fail（`nmProtocol` 契约单测 17 例，含新增的「中继私有帧剥掉魔数即 Chrome 帧」；`nmBridge` 回环单测 7 例：令牌不匹配拒、origin 不匹配拒、正常请求通、排队队列读写、关闭后清桥信息文件）；regression:static 8+32+23 PASS（`REG_STATIC OK`）。
- 层叠 + 布局回归闸 `regression:layers`：默认视口 1440×900 下 35/35 PASS；`regression:layers:all`（`--all`）全量多视口扫描 **350/350 PASS**——10 个视口（960×600 窗口下限、1024×768、1100×800、1280×800、1366×768、1440×900、1600×900、1920×1080、2560×1440、3840×2160 4K，含 1100/1600 断点边界），每个视口重载后先切到 首页/库页/收藏夹/下载任务/统计/游戏站 6 页，每页断言 无横向溢出（`scrollWidth<=clientWidth`） + 主列（`.sidebar`/`.content`/`.aside`）两两不重叠 + 右栏非空白（展开态，≤1100px 收起态允许） + 库页封面卡片两两不重叠；再回到库页断言 7 个浮层 `elementFromPoint` 命中不被盖；截图留痕 `app/.shots/uilayer/*.png`。修复前同一闸在 export-menu 复现 FAIL（被 `.cover-card` 盖住 5/17 采样点）。
- 游戏站「最近访问」本轮闸门：build 0、typecheck 0、`npm test` 130 pass / 0 fail、`reg_all --no-download` ALL PASS、`regression:layers:all` 350/350 PASS（其中 1366×768 四条「切换」断言首跑为 waitMarker 时序抖动，重跑 350/350 全绿）、`regression:gamesites` 4/4 PASS。
- 加入 TouchGAL 后复跑：build 0、typecheck 0、`npm test` 130 pass / 0 fail、`reg_all --no-download` ALL PASS、`regression:layers:all` 350/350 PASS、`regression:gamesites` 4/4 PASS（1366×768 四条「切换」断言偶发 waitMarker 时序抖动，重跑即 350/350）。扫描中确认：≤1100px 时 `useBoot` 的 `matchMedia('(max-width:1100px)')` 会自动收起右栏（有意窄屏策略），闸门已据此先点展开钮再断言详情面板。`node scripts/reg_all.mjs --no-download` 整链路绿：typecheck 0、lint 0、regression:static 23 PASS、regression:layers 35 PASS；`npm test` 130 pass / 0 fail。
- Rust：`cargo test --locked` 36 passed / 0 failed（原有 29 例 + 宿主中继新增 7 例：正常帧、杂字节前缀、分片到达、魔数跨片、超长帧丢弃、坏 JSON 不转发、Chrome 帧格式）；`cargo build --release --locked` OK（中继产物 394,752 字节）。`cargo fmt --check` 在本仓库**基线**上即为红（`src/checksum.rs:83` 等既有行不合 rustfmt，本项目 house style 是紧凑单行写法），本次新增代码单独过 rustfmt 干净，故未执行全量 `cargo fmt`（会重排无关代码）。
- **真机端到端**（打包产物实跑，脚本不入库）：自扮一次浏览器——用扩展 origin 当 argv 拉起 `resources/fastdrop-nm-host.exe`，按 Chrome 线协议喂一帧（4 字节小端长度 + JSON），起假桥回应答：**14 项全过**。其中最关键的一条是「stdout 首字节即帧头（无 Electron 启动噪音）」——改造前这里多出 2 个字节 `0d0a`，Chrome 会把长度头读错，整条链路直接错位；改造后 stdout 只有合规帧。桥侧同时验到 origin、token 与 Cookie 透传，非法动作与陌生扩展都在进桥前被拒。本次补上的两条是「应答送达后中继自己退了（不靠 Chrome 关管道）」与「桌面端宿主没有残留进程」。
- **真 Chrome 全链路**（Chrome 156.0.8078.74，隔离 profile + `--remote-debugging-port`，经 CDP `Extensions.loadUnpacked` 装扩展，`loadUnpacked` 返回的 ID 与钉死的 `jjoapnhpnedocdkfffpiccdehollooab` 一致）：从扩展弹窗页触发 `chrome.runtime.sendMessage({type:'hn.deliver'})` 真投递，扩展侧收到 `{"ok":true,"status":"engine",...}`，链路走完「扩展 → Chrome → 中继 exe → 桌面端宿主 → 本机桥 → 主应用建任务」全程。投递后 6 秒的进程快照只剩验收用的桌面端自身，**中继与宿主进程树零残留**。另外确证 Chrome 156 已不认 `--load-extension`（加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效），装扩展只能走 CDP `Extensions.loadUnpacked`。

## [0.2.21] - 2026-10-31

> 已打 `v0.2.21` tag 并推送到 origin，GitHub Actions 按 tag 构建安装包。

### 新增

- **本地 exe 图标提取**（`main/localIcon.ts` + `Game.iconPath`）：Windows 下用 Electron `app.getFileIcon()` 读 exe 内嵌图标，转 PNG 存到 `userData/covers/{id}.png` 并写回 `Game.iconPath`；扫描入库 / 手动添加 / 启动后自动回填（`backfillLocalIcons`，setImmediate 起步不挡首帧）。渲染层走新的 `hh://icon/{id}` 协议（`thumbs.handleHhProtocol` 闸住非图片缓存路径），封面墙没有刮削封面时用本地图标兜底。exe 无内嵌图标或非 Windows 平台静默跳过，UI 退回占位字母。
- **VNDB 刮削三增强**（`main/scraper.ts`）：① `searchVndb` 加 `sort=searchrank`，命中排序贴合 VNDB 搜索排名；② `image.dims / image.sexual / image.violence / image.votecount` 接入候选软信号——露骨封面 −15 分、高评票 +min(6, log10) 分，只调排序不越自动档；③ 已知开发商时先查 `/kana/producer` 拿稳定的 producer id（`pickProducerId` 纯函数 + 进程内缓存），再套嵌套 `developer` 过滤器滤掉同厂不同作。

### 修复

- **选候选加矛盾淘汰 / 梯级降权 / 跨源互验**（`shared/scrapeScore.ts`）：「封面牛头不对马嘴」的根因是选候选选错，不是下载链路——旧 `pickAuto` 只认标题完全相等且唯一最高分，不校验开发商与年份，也不要求跨源确认。现在：候选与已有元数据矛盾（年份相差 >1 年，或双方开发商都非空且归一化不等）直接 0 分淘汰；清洗梯放宽词命中的候选（`queryStep>0`）封顶 75，永远够不到自动应用档（≥80）；自动应用还要求同「主标题 + 开发商」key 在 ≥2 个源出现（跨源互验），同名不同社不互相壮胆。开发商 / 年份一致只作 +3 微调，不升档。纯逻辑零 vue 依赖，可被 node --test 直接单测。
- **nekogal 分卷帖子不再只下 part1**（`main/sites/nekogal.ts`）：详情页改为收集全部下载按钮而不是只取第一个，分卷作品能拿到全部卷。

### 验证

- scrapeScore 单测 15 例（新增 `pickProducerId` 纯函数 3 例）。

## [0.2.20] - 2026-10-31

> 0.2.20 只在 `package.json` 存在过版本号，**未单独打 tag 发版**，其内容随 0.2.21 一并发布。

### 变更

- **`DetailPanel.vue` 拆分为 1 外壳 + 5 子组件**：1885 行单文件按区块拆开，外壳只留双形态切换 / 上下部翻页 / 快捷键 / 开目录 / 复制信息；`DetailBanner.vue`（横幅 hero + 收藏 chip）、`DetailMetaRow.vue`（元数据行，开发商点选 emit `filter` 交父面板调 `filterByMeta`）、`DetailTags.vue`（标签区，搜索与展开状态内聚，切游戏自行复位）、`DetailTabs.vue`（游玩数据 / 简介 / 编辑 / 存档四个 pane）、`DetailSimilar.vue`（相似游戏推荐）、`detailShared.ts`（`fmtPlay` / `fmtDate` / `lengthTextOf` 共用工具）。整页态穿透子组件的样式由 `scoped` 改 `:deep()`，视觉与行为语义不变。

### 新增

- **nightly 视觉 / 交互回归闸**（`.github/workflows/visual.yml`）：CDP 起真实 Electron 窗口跑各 `verify_*` / `ui_walkthrough_*`，每天 UTC 18:00（北京时间 02:00）定时 + 手动兜底。不进 PR 主链路——每条闸都要 build + 起真实窗口（分钟级、吃 CPU），runner 上偶发抖动（前台窗口被抢、端口占用、字体度量差异）会误伤合入；红 = 视觉 / 交互回归，人工判读，不阻断合入。

### 验证

- typecheck / lint / test（88 例）全绿。

## [0.2.19] - 2026-10-25

### 变更

- **文档对齐现状（README）**：默认主题口径由「深色优先」改为「**默认浅色**、五套主题各配深浅两套调色」；界面预览首图换成本轮浅色首页截图（`docs/assets/screenshots/home-light.png`）；特性一览补「详情：右栏抽屉 ⇄ 整页双形态 + 相似推荐 8 项（时长加权）+ 整页态 ←/→ 翻页」；快捷键表补 `Ctrl`/`⌘`+`E`、`←`/`→`，`Esc` 退层链补「收详情整页」；质量闸门表补 `regression:reina` / `:hero` / `:accent` / `:process` 四条并修正 `regression` 串联说明（实串 typecheck + 静态闸 + 下载链路）。
- **仓库卫生**：`.gitignore` 新增 `不要上传*/`（用户指定的临时脚本/基准图/取证夹，明确永不入库）；清理 app 根 36 个可再生成的探针数据目录（`.*-data/`、`.test-build`、空 `.ref-ui`，约 110MB，脚本跑时自动重建）；`.reina*.log`、`scripts/hero2-run.log` 与 `.shots` 顶层 120 个散落分析文件归档进不上传夹（`_cleanup-2026-10-25.md` 留清单），`.shots` 只保留 8 个证据子目录（reina/motion/hero-themes/accent/fs-stage/hero2/manual/final-review）。

### 验证

README/.gitignore 纯文档与卫生改动，不动源码：typecheck 与全套回归闸不受影响（源文件零改动）。

## [0.2.18] - 2026-10-25

### 新增

- **整页态「上一部 / 下一部」翻页**（`DetailPanel.vue`）：整页阅读时按 ←/→ 连续往下看，头部多两个箭标钮（到头变淡、不吃 hover 高亮，但不隐藏——说明「这里能翻，只是到头了」）。翻页顺序取**当前筛选结果**（`filteredGames`）而不是全库顺序：从「最近玩过」或搜索结果点开的作品，下一部就该是墙上相邻那张。整页态翻页**保持整页**（`keepExpandedOnSwitch` 一次性标记让 `watch(g)` 的收卡逻辑让路），抽屉态不抢方向键（那是列表滚动）。
- **⌘/Ctrl+E 升降形态**（`DetailPanel.vue`）：键盘直接切换右栏 ⇄ 整页，与头部图标钮同一函数、同一套 View Transitions；输入框/文本域里打字时让位（`isTypingTarget` 判定 INPUT/TEXTAREA/contentEditable），不会把展开态和输入一起搅乱。

### 变更

- **相似推荐加入游玩时长权重**（`DetailPanel.vue`）：`playWeight(ms) = min(3, log10(1 + 小时))` 叠加到「共享标签 ×2 + 同开发商 ×3 + 同系列 ×2」的得分上——1h ≈ 0.9、10h ≈ 2、100h ≈ 3 分。对数压缩让时长最长的不至于霸榜，只是给「真玩过」的同类一点点优先；同分仍按时长降序取前 8。

### 验证

typecheck 0；lint 0 problem；build OK；npm test 88 pass / 0 fail；regression:static 8+32+23 PASS；regression:reina 五屏全 true（HOME kpiCells4 hero recent4 random feed；LIBRARY ph toolbar cards12；DETAIL meta6 tags6 tabs4 chart；STATS kpi6 hours24；COLLECTION groups5）；regression:hero 26 PASS 0 FAIL；regression:accent 25 PASS；regression:process 12 PASS。CDP 探针（`probe_paging.mjs`，临时脚本目录）：抽屉 btns=2 → ⌘/Ctrl+E 展开 btns=4（首个箭头 disabled）→ → 键标题「美少女万华镜」→「命运石之门」且保持整页 rect 12,48,1256×740 → ← 键回到万华镜 → 首项再按 ← 不变 → Esc 收回抽屉 rect 874,40,400×748 → Ctrl+E 再展开/再收回。

## [0.2.17] - 2026-10-25

### 新增

- **详情卡「右栏 ⇄ 整页」双形态**（`DetailPanel.vue` + `App.vue`）：头部动作区两组图标钮——展开整页 / 收回右栏（`Maximize2`/`Minimize2`，Esc 也能收回）。整页态用 View Transitions 让 banner **连续长大**（`view-transition-name: dp-banner`），不是「关一个开一个」的硬切；展开后左栏元数据 + 右栏相似推荐两栏布局，banner 260px、封面 132×198、元数据 3 列、简介 6→12 行。抽屉态用 `display:contents` 让两层新容器**不参与布局**，视觉零变化（DETAIL 回归断言不变）。
- **相似游戏推荐**（`DetailPanel.vue`）：按「共享标签 ×2 + 同开发商 ×3 + 同系列 ×2」打分，同分按游玩时长降序取前 8，点击直接换选中游戏。抽屉态 2 列、整页态 3 列，封面沿用统一比例 token，图加载失败退首字母。
- **导航选中块滑动**（`NavSidebar.vue`）：选中高亮从「每项各自变色」改成**一块会滑动的底片**——`translateY` + 高度过渡（easeSlide），左侧 2px accent 亮线；换页/展开「更多」菜单时按 `offsetTop/offsetHeight` 重新测量，窗口 resize 也跟着。`.nav-item.active` 不再画自己的背景。
- **KPI 数字滚动**（`HomeView.vue`）：首页四格 KPI 从 0 滚到目标值（500ms easeOutCubic，rAF 插值），只动数值不动单位——落点与不做动效时**逐字相同**，回归脚本读文本不受影响；`prefers-reduced-motion` 直接落位。
- **动效 token 与曲线**（`tokens.ts` / `global.css`）：新增 `--hh-motion-ease-out / -ease-in / -ease-slide` 三条曲线（16,1,0.3,1 / 0.7,0,0.84,0 / 0.22,0.61,0.36,1），全部动效改走 token，不再散落硬编码 `cubic-bezier`。

### 变更

- **页面/右栏切换动效**（`App.vue` + `global.css`）：中栏页面切换走 `<Transition name="page" mode="out-in">`（新页淡入 + 上移 6px，旧页 83ms 淡出）；右栏「详情 ⇄ 动态流」就地交接走 `<Transition name="aside">`（横向 12px 滑入，离场绝对定位避免叠帧）。`GameSites` 保持在 Transition **之外**（`v-show` 保活语义不变）。
- **右栏容器抽成 `.aside`**（`App.vue`）：宽度动画到 28px 的收起态、`.aside > .detail` 高度链、空态占位都挂在容器上，组件只负责内容。整页展开的 `position:fixed` 让位规则写在 `App.vue`——`.aside > .detail` 与组件内 `.detail-panel.is-expanded` 特异性打平（均 0,3,0）而 App 样式在产物里更靠后，不显式让位会被拽回抽屉尺寸（实测 rect 400×748 / computed position=relative）。
- **详情分页切换动效**：四个 pane（统计/简介/编辑/存档）改 `<Transition name="pane" mode="out-in">` 各带 key，切换时淡入 + 上移 4px。
- **封面墙按压反馈**（`CoverGrid.vue`）：`:active` 微缩 0.985（与 hover 浮起同一根 easeOut 曲线），三条 transition 与封面图过渡统一改用 token 曲线。

### 修复

- `.desc.clamped` 规则缺右花括号（上一轮插入整页态样式时切断），postcss 报 `Unknown word .detail-panel.is-expanded`、build 失败；已恢复原规则并把「整页态 12 行」改成独立的 `.detail-panel.is-expanded .desc.clamped`。
- lint：`startViewTransition` 类型声明里未使用的 `cb` 形参改 `_cb`（0 warning）。

### 验证

typecheck 0；lint 0 problem；build OK；npm test 88 pass / 0 fail；regression:static 8+32+23 PASS；regression:reina 五屏全 true（HOME kpiCells4 hero recent4 random feed；LIBRARY ph toolbar cards12；DETAIL meta6 tags6 tabs4 chart；STATS kpi6 hours24；COLLECTION groups5）；regression:hero 26 PASS 0 FAIL；regression:accent 25 PASS；regression:process 12 PASS。CDP 探针（`probe_motion.mjs`，临时脚本目录）：nav 高亮 translateY 10px→44px、抽屉↔整页（contents→grid、8 个相似项、Esc 收回）、整页态 rect 12,48,1256×740。

## [0.2.16] - 2026-10-25

### 性能

- **首包按依赖拆块**：renderer 原来是单块 `index` 2,285.71 kB —— 改一行业务代码，整个 vendor（含 1MB antd）跟着重算/重解析。现按依赖分组（`electron.vite.config.ts` 的 `build.rollupOptions.output.manualChunks`，注释写明分组理由）：vendor-antd 1,038.22 kB / index 398.70 kB / vendor-vue 244.1 kB / vendor-k 198.1 kB / vendor-icons 36.2 kB / vendor-scroller 32.4 kB。业务改动只让 index 一块失效，vendor 六块的字节保持稳定。
- **非首屏页面按需加载**：统计 / 收藏夹 / 下载 / 游戏站改 `defineAsyncComponent`（`App.vue`）。这四个页面本来就由 `v-if` 页签控制，异步组件不改变任何行为；延迟 JS 合计 86.1 kB（下载 39.7 / 统计 20 / 游戏站 19.7 / 收藏夹 5.0）。游戏站的 webview 保活语义不变（首次进入 v-if 挂载 + 之后 v-show 保活）。
- 刻意未做（留档判断）：12 个 antd 对话框不做 `v-if` + 异步化。ScanDialog / ScrapeDialog 在 `open=false` 期间仍可能收到主进程进度推送，卸载会丢事件——损失的可靠性换不回 1MB 首包。ant-design-vue 4.2.6 的 `sideEffects` 已排除 `.js`，barrel 具备 tree-shaking 条件，这 1MB 是组件真实体积，不是打包失误。

### 修复（工具链）

- **lint warning 48 → 0**：`no-unused-vars` 换成 `@typescript-eslint/no-unused-vars`。基础规则不认识 TS 语法位置——函数类型形参（`(task: EngineTask) => void`）、constructor 参数属性（`public readonly url: string`）都被当成「定义了没用」，48 条里 45 条是这类误报。
- 余下 6 条真警告逐个修：`manager.ts`/`steam.ts`/`thumbs.ts` 三处未用 import；`ipc/shared.ts` 未用的 type import `dialog`；`games.ts` 的 `recordExit(... signal)` 形参保留位置改 `_signal`（判定只看退出码，注释写明）；搜索索引的 `fieldKeys` 只承担类型，改成 `type FieldKey`。
- 三处启动期生命周期日志（清除无效封面 / 库目录迁移 / 封面回填）显式 `eslint-disable-next-line no-console` 并写明理由——它们是排障要看的事实，不是错误，不该降级成 warn。

### 取证 / 待决

- 五屏结构度量（亮度 ASCII 图 + 行/列剖面，见临时脚本目录）结论：**列比例与竖向节奏已对齐基准**——内容/右栏 ≈ 64:36（v0.2.14 修的就是这条）、hero 高度占屏 45%（基准 43.7%）、随机卡 18%（基准 15%）。
- 唯一未对齐处是**详情形态**：基准 detail.png 是整页详情（左封面 290×400，右侧元数据铺满整页宽，下方标签/分页/曲线分区），我们是右栏 320px 抽屉浮在封面墙上。这是架构改动（要动路由与右栏），已留待用户拍板，不擅自改。

### 验证

typecheck 0；lint 0 error 0 warning；npm test 88 pass / 0 fail；regression:static 23 PASS；regression:reina 五屏全 true（HOME kpiCells4 hero recent4 random feed）；regression:hero 26 PASS 0 FAIL；regression:accent 25 PASS；regression:process 12 PASS。

## [0.2.15] - 2026-10-25

### 变更

- **库页工具栏对标基准 library.png**：批量操作从纯图标钮升级为「图标 + 文字 + 药丸开关」的 Batch Actions 控件（基准口径主操作不许纯图标；开关开启 = select 态低透明 accent 底 + accent 实色 knob，与分类 chip/多选选中态同口径）。计数文案 `N 款` → `N 款游戏`（en `N games total`，对齐基准「107 games total」措辞），并 `margin-left:auto` 靠右对齐（基准布局 = 左控件组 / 右计数）。
- **取证修正**：此前判定基准库页有「平台筛选 chips 条」是误读——逐像素裁切（x140-1100、y315-355 段）确认那些是**封面自带的平台 logo 美术**（PlayStation 2 / XBOX 360 / Xbox LIVE），基准这一带只有「Batch Actions + 开关」一行与「107 games total」；我们的工具栏（搜索/分类/智能列表/收藏/批量/导出/视图）是功能超集，无需新增筛选条。
- 闸：typecheck 0 / lint 0 err（48 既有 warning）/ regression:static 23+32 PASS / regression:reina 五屏全 true / npm test 88 pass。

## [0.2.14] - 2026-10-25

### 修复

- **首页左右分栏失衡（Activity 右栏 557px 把主列挤到 555）**：`.activity-feed` 根上的 `flex:1`（本意是闭合高度链的 flex 填充）与 App 的 `.detail{width:var(--hh-layout-detail-w)}` 冲突——flex-basis 0 + grow 直接顶掉 width，token 宽 361 实测渲染成 557，主列被压到 555（基准 home.png 主列 699 : 活动 395 ≈ 64:36，我们实测约 50:50）。修复：`.detail` 加 `flex:none` 让 token 宽度真正生效，`detailW` 361→400（对齐基准 395）。1280 窗口实测主列 712 : 活动 400 = 64:36，与基准一致。
- 闸：typecheck 0 / lint 0 err（48 既有 warning）/ regression:reina 0（HOME kpiCells4 hero recent random feed 全 true、总高 775 不溢出）/ regression:hero 26 PASS 0 FAIL（窄窗 150×160 断言过）/ regression:static 23+32 PASS。

## [0.2.13] - 2026-10-25

### 修复

- **首页内容溢出 800 视口（随机卡「查看详情/启动游戏」按钮掉出截图外）**：hero 卡 515 高（基准实测 343）把随机卡挤到 y684 起、按钮 y818 在视口外——走查截图（`captureBeyondViewport:false`）只拍 800px，按钮被截掉，日常窗口同样看不到。两处压缩让三块全部落回首屏（总高 937→775）：
  - **LibraryHero**：网格内距/行距 `x6/x8`（24/32）收 `x4/x6`（16/24）；右列封面定高 224px（原不设高、随源图比例漂——3:4 源图撑到 320 把行 1 顶高 96px）；最近游玩 chips padding 收 `4px 8px 4px 4px`；窄窗（≤720px）封面 150×160（h>w 仍满足 hero_themes 窄窗断言）。hero 卡 515→391。
  - **RandomCard**：封面 132→104px（封面高 176→139），卡 253→215；随机卡底 y777 < 800，按钮 y677..713 可见。
- 闸：typecheck 0 / lint 0 err（48 既有 warning）/ regression:reina 0 / regression:hero 26 PASS 0 FAIL / regression:static 23+32 PASS。

## [0.2.12] - 2026-10-24

### 变更

- **顶栏对标基准 home.png**：原「花图标 + 羽花 HaneHana + 版本号」纯文字 logo 改为基准式顶栏——返回箭头（回首页）+ 圆形头像 + 应用名 + BETA 蓝芯片 + 右侧圆形设置钮；版本号收进头像/芯片的 title 提示，不占正文（基准顶栏无版本号）。
- **侧栏加宽 108→144px（横排条目不换行）**：原宽度下「全部游戏」等中文标签被挤到图标下一行，侧栏视觉成了竖排；144px 后图标 + 文字 + 计数徽章同排显示，对齐基准横排条目形态；窄窗 ≤620px 仍收 56px 图标条。侧栏功能入口不动（扫描导入/设置仍在底部——accept_batch23、ui_walkthrough_accent 等验收脚本按文本找这两个入口，移动会打断回归）。
- **侧栏底部署名**：新增「© huoshen80」（基准 home.png 左下角）。

### 已知偏差（数据/语言层面，非布局缺陷）

- 基准 hero 封面上的「PlayStation 2」平台横条：`Game` 结构体无 platform 字段（shared/types.ts 无此字段），待扫描元数据补平台信息后再加。
- 基准 Random 卡的公司行（AKABEiSOFT3）与 4 个 tag chips：RandomCard 已按基准结构渲染（`rc-sub`/`rc-tags`/`rc-detail`），当前库内游戏无 developer/tags 数据，真实扫描入库后自然出现。
- 基准侧栏底部仅一个下载图标、标签为英文：入口保留见上；界面语言随 app 语言设置（中文）。

## [0.2.11] - 2026-10-24

### 变更

- **默认主题翻浅色（对标基准 ReinaManager）**：`DEFAULT_DARK=false`（tokens.ts）、`stores/ui.ts` `dark:false`、`DEFAULT_SETTINGS` `theme_mode:'light'` 三处同源对齐，`global.css` 的 `color-scheme` 移出 `:root` 默认值、按 `data-theme` 设置。
- **starnight 浅色种子 accent 改 `#1976D2`**（hover `#1E88E5`）——基准「Launch Game」按钮的品牌蓝实底实测色。
- **hero 深卡化（对照基准 Continue 大卡）**：`deriveLight` 里 hero 改为深卡语义——封面模糊底退成 0.10 水印，双层 scrim 用近黑藏青 `rgba(8,14,30,…)`（基准卡底实测 (8,14,30)）垫在模糊封面上，白字体系 + `heroBtnBg=s.accent` 实底主按钮（基准 Launch 按钮 #1976D2 实测）替代深色主题的白底黑字；`LibraryHero` 标题恢复两行 clamp、封面列 224→240px、最近游玩改卡底通栏一横排（chips `flex:1 1 152px` 横滚，窄窗 `flex:0 0 132px`），`.hero-bg` 透明度走 token；浅色卡片改实底（card `#FFFFFF` / cardBorder `#E1E5E9`）。
- **`App.vue` 详情面板改库页专属**：`DetailPanel` 条件收窄为 `page==='library' && !ui.detailCollapsed && selectedGame`，首页右栏常驻 ActivityFeed（基准同款）；`.app-bg` 透明度 token 化（`--hh-app-bg-op`）。
- **首页 KPI 窄窗时长缩写**：`shared/format.ts` 新增 `fmtDurMsKpi`（≥10h 只显 h、<10h 缩写 m），HomeView KPI 与统计周期格改用；周期格 `flex:1.35` 防挤压。
- **封面微调**：RandomCard 封面 104→132px（基准比例）；封面墙无封面海报字按标题长度自适应（14–30px，固定 21px 长标题糊成团）、海报配色走 `posterGrad`/`posterInk` token；标签 chips 行无条件渲染（虚拟化 itemSize 恒定高度，无标签卡不再矮一截）；PlayChart 面积透明度 0.14→0.04；详情面板宽 400→361；侧栏「更多」收纳菜单紧凑化（208→108px）。

### 修复

- **「打开目录」静默失败**（用户实测点了没反应）：`Ipc.OpenDir` 改 async + 错误串回传（`existsSync` 预检，`shell.openPath` 失败原因原样带回），`DetailPanel.openDir`、`GameContextMenu.actOpenDir` 失败弹 `dv_open_dir_fail` 提示。
- **Magpie 启动找不到 exe 才报错**：`handleLaunch` 里路径解析提前到 spawn 前，缺失即返「请到设置→工具里指定 Magpie 路径，或先安装 Magpie」。
- **回归脚本三处修复**：`ui_walkthrough_hero_themes` 预设 accent 按深浅双值取（默认翻浅色后深色写死值失效）；`ui_scrape_walkthrough` 适配默认首页（启动是 home 不是库页，先导航到库页再走刮削；页内异常不再被静默吞掉伪装成别的原因）；`ui_walkthrough_reina` 截图钉 DPR=1 绕 Windows 150% 缩放双重曝光。

## [0.2.10] - 2026-10-22


### 修复

- **`npm run dev` 在本机 harness 终端必崩**：环境自带 `ELECTRON_RUN_AS_NODE=1`（harness 自身是 Electron 应用，子进程继承），把 electron.exe 降级成纯 Node，main 加载即 SyntaxError。新增 `scripts/dev_app.mjs`（spawn 前清变量 + 直调 node_modules 里的 electron-vite CLI，绕开 Windows npx `.cmd` ENOENT），`dev`/`start` 两条 script 都改走它。

- **「全部游戏」页封面墙滑不动**（用户实测）：`.cover-wall` 写 `flex:1 + min-height:0`，但其父 `.cover-wrap` 是 `display:block`（不是 flex 容器），flex 语法全部无效——高度随内容涨（12 款实测 1968px vs 视口 585px），RecycleScroller 拿到的 clientHeight 就是内容全高，没有溢出可滚。改 `position:absolute; inset:0` 填满 relative 父级。`verify_cover_render` 新增滚动链断言（填满父级 + 有溢出时 scrollTop 真变化；内容少时验高度链闭合）。
- **右栏信息流滚不动**（用户实测）：`.detail` 是 `.layout` 的 flex item，flex stretch 给的高度不是 definite height，里头 `height:100%` 的 ActivityFeed 百分比塌成 auto，`.af-body` 的 `flex:1` 抢不到剩余空间——整条动态流不滚。修 `.detail`（`align-self:stretch` + `min-height:0`）闭合高度链，ActivityFeed 改 `flex:1` 填充。`verify_recent_strip` 新增 7 条防回归断言（高度链/溢出/真滚一次）。

## [0.2.8] - 2026-10-22

### 变更

- 首页二次仿制收敛（对照 home.png 逐块比对）：hero 改基准网格（封面通贯右列全高、最近游玩进卡底通栏；1280 窗左区窄，chips 排 2x2 保单枚宽度与基准同款）；Activity 右栏补 **全部/玩过/新增页签 + 每条封面缩略图 + 事件图标环**（入库也是一等事件），条目点击跳库页选中该游戏；修 RandomCard 空库误报（库异步加载完成前就抽卡）与种子「明天」分组（会话时刻改为当日 13:00 基准，不是种子时刻+13h）。14 项运行时回归全绿（process 走查补跨页导航：库页数角标、回首页测按钮）。

## [0.2.7] - 2026-10-21

### 新增

- **ReinaManager 对标改造（B1–B7）**：整窗信息密度与结构完整度对齐基准（深色玻璃体系保留）。
  - 设计基线（B1）：字号层上一档（caption 13 / body 14，新增 pageHead 28 / kpi 26）；深色分层分离度提高（card/cardBorder/surfaceStrong/borderFaint）；封面比例统一竖版 `--hh-layout-cover-ratio`（3/4，官方封面实测比例）。
  - 共享原语（B2）：`PageHeader`（面包屑+大标题+主操作槽）、`KpiStrip`（自适应 KPI 卡，数字不截断）、`ActivityFeed`（右栏默认可见的按日游玩动态时间线）、`PlayChart`（补零日序列 SVG 时长曲线）；新 IPC `StatsSessions`（会话明细，主进程校验夹取）+ `stores/sessions.ts` 数据层。
  - 游戏库首屏（B3）：页头+KPI 条；封面卡评分+排名徽章叠封面左下（`★9.2 #2`）、开发商副行、无封面海报式占位；hero 封面轨竖版不叠字、右下统计卡并入 KpiStrip；工具栏主操作带文字。
  - 右栏（B4）：未选中 → 游玩动态（今天/昨天分组时间线+本周时长）；选中 → 详情密度：元数据行（数据源/开发商/发售日/加入时间/通关时长/评分）、标签全集+搜索+展开、四分页（游玩数据/简介/编辑/存档）、每游戏时长曲线 7D/30D/1Y/ALL、LE/Magpie 开关常驻。
  - 统计页（B5）：周/月周期切换 + 6 KPI（与主进程 computeOverview 同源口径，日均按活跃天数）+ 总趋势线（缺日补零）+ Top10 带封面缩略 + 0–23 时段分布。
  - 下载页/收藏夹（B6）：页头 + 4 KPI（进行中不含已暂停）；收藏夹独立浏览页（按开发商/系列分组卡+计数，点组复用库页筛选链路）。
  - 明确优于基准：口径一致（无「首页 1666h / 统计 538.6h」矛盾）、曲线缺日补零、简介 BBCode 清洗、单复数词典、文本 clamp 防截断。
- **启动进程状态机**（对标 KoiPage）：主进程权威 `starting/running/exited` 快照+推送，UI 启动按钮四态（启动中转 spinner），窗口聚焦补拉；取代 5s 轮询。
- **回归脚本**：`regression:process`（进程状态机走查）、`regression:accent`（主题色三轴走查）、`regression:batchedit`（批量编辑 6/6）、`regression:collection`（下载页 27 断言 + 收藏夹分组页）、`regression:reina`（四屏验收截图）。

### 修复

- 详情面板 banner 被 flex 列压缩（内容超屏时 224px hero 被压成 32px）：`.banner` 加 `flex: none`，断言 >=220 防回归。
- 主题推送丢 accent 覆盖（系统深浅切换时自定义主题色被清空）：`onThemeChanged` 推送带上 `ui.accent`。

### 变更

- 右栏详情紧凑化（验收截图复盘：曲线被固定区块推出视口）：banner 224→180、收藏并入 banner chip 行、标签区三行合一（搜索/展开并入标题行、折叠 8→6）、区间日期并入 chip 行、面板列距 12→8、ghost 按钮文字防换行。新增防回归断言「曲线默认在首屏视口内」（verify_detail_panel 27/27）。
- **首页仪表盘（B8，对标 home.png）**：用户批评库页「首页特别杂」——新增 `home` 页为默认启动页（侧栏首位）：合并式 KPI 面板（一块面板内部分格 + 周/月切换格，取主进程 computeOverview 口径）、基准式 Continue 大卡（左文本 + 右竖版封面 + 最近游玩 chips，`LibraryHero` 重构，封面轨/计数器/续读进度条退役）、`RandomCard`（随机游戏 + 换一款）。库页只留 页头 + 工具栏 + 封面墙（KPI/hero/续读条撤出，`RecentStrip` 组件退役由 hero chips 承接）；右侧栏 home 常驻 Activity、库页选中时详情。全部运行时脚本适配跨页导航（14 项全绿，hero_themes 窄窗断言按新折叠规则重写：封面列 150px 保持竖版）。

## [0.2.6] - 2026-10-21

### 新增

- **封面墙 NSFW 遮盖**（对标 ReinaManager）：刮削写入 VNDB 成人标签（Sexual Content 等）的游戏，封面默认显示遮盖层（模糊 + 图标 + 「成人内容」文案），点击临时显示——公共场合打开不会直接露图。`shared/nsfw.ts` 判断函数 + CoverGrid 遮盖层 + 回归 `verify_nsfw` 4/4。
- **回归脚本**：`regression:track`（新作追踪订阅/回读/真实 VNDB 检查/删除 5/5）。

## [0.2.5] - 2026-10-21

### 变更

- **hero 内容居中剧照化**：hero 标题从左上改为居中大字（tag/衬线标题/sub 全居中），视觉重心在中央——对标 gal-launcher aurora 的 stage-center 剧照式标题，打开第一眼更剧场感。走查验证无回归。

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