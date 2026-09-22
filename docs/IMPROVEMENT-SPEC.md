# HaneHana 改进规格书（审计 → 对标 → 路线图）

- 版本：v1.0（2026-09-23）
- 角色：强模型产出设计，弱模型照 §5 执行；本文档不含实现代码
- 范围：J:\xiangm_transfer\hanehana（Electron 44 + Vue3 + ant-design-vue 4 + Rust 下载引擎）
- 硬约束（全程有效）：不 push（push/建远端须用户明确同意）；中文 commit；不新增本规格书之外依赖；不改 IPC channel 名称与 Rust stdio 协议字段名；games.json 只增字段；每 Phase 结束 typecheck 0 错 + build 绿 + 对应验收命令通过

## §0 审计方法与证据

三路只读审计 + 真实截图 + git 事实交叉验证：

1. 主进程 / Rust 引擎 / IPC / 持久化审计（逐条 file:line）
2. 渲染层 UI/UX/a11y/设计系统审计（逐条 file:line）
3. 测试 / CI / 打包 / 发布 / 仓库卫生审计（命令输出为证）
4. 五张真实界面截图（游戏库网格/详情/列表/下载/设置），确认四处肉眼可见缺陷
5. git 事实：`git ls-files` 46 个文件 vs 工作树 13 个核心源文件零历史；`git remote -v` 为空

结论可信度：所有 P0/P1 条目均有 file:line 或命令输出证据，无推测项。

## §1 现状总评

**保留的优点（不要动）**：进程边界（渲染→contextBridge→主进程→每任务一个 Rust 子进程）；engine-rs 本体质量高（206 探测、Range 错位保护、未知长度单流、令牌桶限速、13 个单测）；engine.ts 子进程生命周期处理成熟（死活判定/EPIPE 兜底/旧 close 防误清）；tokens 单源意图正确；游戏库已虚拟化；e2e 覆盖 md5 校验与重启持久化。

**四类系统性问题**：

- A 交付面几乎为零：13 个核心源文件 + engine-rs + docs + e2e 脚本未入库（clone 即废）；无 remote、无 CI、无测试框架、无 LICENSE、无 lint；README 宣称与实现脱节。
- B 宣称与实现落差：electron-updater 装了零 import；extension/ 不存在但 fastdrop-host.exe 打进包且按 FastDrop 路径工作（必失败）；auto_update_check 是死契约。
- C 状态机边界未建模：并发上限在 preparing 窗口失效；暂停在 preparing 与 in-flight 两个窗口失效；stop 与 kill 竞态；掉电可静默交付坏文件（.part 无 fsync + sidecar 高频 sync + 凭长度信任续传）。
- D 设计系统执行脱节 + a11y 不可用：166 处颜色字面量 vs 6 处 token；roving tabindex 无 focus()、焦点环被 scoped 样式杀死、侧栏 div 导航不可键盘达；错误呈现四套标准。

## §2 缺陷清单（选录，证据见审计报告原文）

### P0 交付面
- D01 13 个源文件零历史却被 import：main/{games,manager,store,netConfig,scanner,coverColor,trayIcon,engine}.ts、shared/{errors,format,proxy,sites}.ts、renderer/status.ts（index.ts:21-33、TaskRow.vue:27-29 等断链）
- D02 无 git remote，10 个 commit 只在本机
- D03 无 .github/、无 CI；engine-rs 13 个 #[test] 从未被自动化跑过
- D04 engine-rs/ 未入库而 electron-builder.yml:20-28 硬依赖其产物 → dist 必失败
- D05 自动更新纯声明：package.json:33 有依赖、src 零 import、README:34 宣称已有
- D06 发布通道自相矛盾：builder publish=github vs dist 脚本 --publish never vs 无 remote
- D07 扩展通道不存在但 host 二进制无条件进包；host.rs 按 FastDrop 路径/端口/exe 工作，100% 失败
- D08 37MB 测试残留（.e2e-data 等 8 个目录）未进 .gitignore，已在待提交门口

### P0 可靠性 / 安全
- D09 启动 .lnk 无 proc.on('error') → uncaughtException 崩主进程（games.ts:71-89 + scanner.ts:64）
- D10 max_concurrent 不生效：running() 只算 downloading，preparing 不占槽（manager.ts:573-590）
- D11 掉电数据空洞：.part 从不 fsync、sidecar 每 100ms sync_all、ensure_part 凭长度==total 信任续传（main.rs:448-516,1790）
- D12 GameUpdate/ScrapeApply 入参 `as never` 直通合并 → 渲染层可改任意字段；coverPath 可被改成任意路径经 hh:// 回读（index.ts:303,318、thumbs.ts:39-44）
- D13 applyScrape 直接 fetch 渲染层给的 coverUrl → SSRF（scraper.ts:137-177）
- D14 HANEHANA_DEBUG_PORT 打包版同样开 CDP 口（index.ts:44-46）
- D15 pause 语义两处失效：confirmRun 不挡 paused（engine.ts:282）；引擎 pause 不打断进行中分段且 paused 后永不定稿（main.rs:1062-1125,1758）
- D16 retry 的 stop 未 ack 即 kill → .part/sidecar 残留，"重新下载"变续传，可能混合损坏（engine.ts:346-354、main.rs:433-435）
- D17 同步递归扫描阻塞主进程事件循环（games.ts:22-31、scanner.ts:48-82）

### P1 体验 / 视觉 / a11y（截图确认 4 处 + 审计确认）
- D18 卡片副行被裁一半：.cover-titlezone 32px 装不下 18+16+4（CoverGrid.vue:315-331）【截图 01】
- D19 弹窗标题重复两次：Modal title + 内部 .dlg-head（App.vue:183,198 + NewDownloadDialog.vue:57-59、SettingsDialog.vue:58-60）【截图 05】
- D20 无封面横幅空洞：fallback 仅单色渐变（DetailPanel.vue:37-40,74-90）【截图 02】
- D21 下载页两行工具栏失衡：row2 仅右对齐左半空（DownloadView.vue:131-154,265-271）【截图 04】
- D22 roving tabindex 无 .focus()，方向键导航卡死（CoverGrid.vue:94-106）
- D23 焦点环被组件 outline:none 杀死（CoverGrid.vue:267,343 vs global.css:118-122）
- D24 网格上下键不按列走（CoverGrid.vue:96-101）
- D25 侧栏 nav-item 是纯 div，键盘/读屏不可达（App.vue:91-110）
- D26 扫描失败显示为成功绿（ScanDialog.vue:20-23,46,91）
- D27 刮削弹窗打开即双重搜索竞态（library.ts:74-81 + ScrapeDialog.vue:18-25）
- D28 library.loading 从未赋值 → 启动闪"库是空的"（library.ts:12,51-53）
- D29 过滤无结果误报"库是空的"（CoverGrid.vue:112-117）
- D30 initTasks 的 setInterval 未清理（downloads.ts:134-141）
- D31 每次 toggle 分类全量重拉库（DetailPanel.vue:45-61）
- D32 TaskRow 状态图标配色死 CSS（TaskRow.vue:243-246 vs 130-135）
- D33 TaskRow 操作按钮 hover 才现形，键盘不可见（TaskRow.vue:346-357）
- D34 设计系统铁律失守：166 处字面量 vs 6 处 token（tokens.ts:4）
- D35 错误呈现四套标准 + 原始异常直呈用户（downloads.ts:41-56、ScanDialog.vue:23、App.vue:69）
- D36 测试不可 CI：12 脚本硬编码 Windows electron 路径、端口三处撞车、40+ 固定 sleep、6 个需外部预启动、3 个恒退出 0、cdp_verify 对生产窗口静默成功
- D37 打包无图标（app/build 空）、无签名说明、files 排除全部 node_modules 是地雷（builder.yml:15-18）
- D38 README 与代码脱节：引擎"规划中"、路线图全未勾、宣称扩展/自动更新（README.md:27,34,56,64-68）

### P2 选录
低对比小字（0.35-0.48 透明度）；错误红四个版本；主按钮渐变两套；星色两套；.glass-card 定义零使用；off-scale 字号/圆角/时长/间距；点击目标 26-28px；搜索无防抖 O(n)；10Hz 推送全表 find；下载列表未虚拟化；img 无 @error 兜底；Settings 无脏数据守卫；Form 全局 enter 提交；详情面板不可折叠；host.rs/main.rs 101KB 单文件；enginePath 缺失延迟到点下载才报错；gameStore/store 双数据目录真值源。

## §3 业界对标

| 维度 | 标杆做法 | HaneHana 现状 | 差距结论 |
|---|---|---|---|
| 库管理 | Playnite：插件化元数据、平台/系列/来源多维数据库、全屏模式 | 单表 games.json + 双源刮削 | 模型够用，缺批量编辑与多维筛选 |
| 下载 | Motrix（aria2 前端）：任务列表+限速+续传+清晰状态机；IDM：分段多连接+站点捕获 | 自研 Rust 引擎能力≥aria2，但状态机边界与暂停语义有洞 | 引擎强、语义弱 |
| 元数据 | VNDB API v2（kana）结构化字段、Bangumi 双源 | 已接双源 | 达标 |
| 交付 | 标杆项目 clone→build→test→release 全链路自动化 | 交付面为零 | 最大短板 |
| 视觉 | Motrix/IDM：克制工程风、状态色单一真值 | 设计系统意图对、执行脱节 | 需治理而非重设计 |

差异化定位不变：galgame 垂直（库+刮削+启动+下载一体）。基本功（交付、状态机、治理）先补齐再谈特色。

## §4 目标架构设计

### 4.1 任务状态机与所有权边界
状态：queued → preparing → downloading ⇄ paused → verifying → done / error / cancelled。
规则：
- 槽位占用 = preparing + downloading + verifying（修 D10）
- pause 是命令+ack：主进程发 pause → 引擎 ack 后才置 paused；ack 超时（2s）强制 kill 进程并本地置 paused（修 D15）
- stop/retry 必须等 stop ack 或 1s 超时后再 kill；kill 后主进程负责删 .part+sidecar（修 D16）
- 引擎 in-flight 分段收到 pause 须 abort 当前 fetch future，不得下到段尾（Rust 侧）
- 谁说了算：主进程拥有状态真值；引擎只报告进度与错误码，不自行改状态

### 4.2 持久化保证
- .part 每 N MiB（默认 64）fsync 一次；sidecar 记录"已落盘水位"而非"已下载水位"，续传以水位为准（修 D11）
- 原子写 = 写临时 + fsync 临时 + rename；games/tasks/settings 损坏时保留 .bak 并提示（不再静默归零）
- games.json 读取加 Array.isArray + 逐条形状校验，坏条目隔离到 quarantine 文件

### 4.3 安全边界
- IPC 入参白名单：GameUpdate/ScrapeApply 只接受字段白名单；coverPath/thumbPath 必须落在 dataDir 的 covers/thumbs 内（修 D12）
- 刮削封面 URL 必须属于本次候选返回过的域名集合（修 D13）
- TasksAdd.dest 限定在设置目录树内；threads clamp 1-32
- HANEHANA_DEBUG_PORT 仅 !app.isPackaged 生效（修 D14）
- 引擎错误上报结构化 {code, params}，errors.ts 做映射，解除字符串耦合

### 4.4 设计系统治理
- tokens.ts 为唯一颜色/尺寸/时长真值；components 内字面量清零（批量替换）
- 铁律固化成 ESLint no-restricted-syntax / stylelint declaration-block-no-* 规则，CI 拦截
- 错误呈现单一策略：主进程 explainError → 渲染层统一 errorLine；toast 仅瞬时反馈、banner 仅全局阻断、弹窗内仅本弹窗警告
- 对话框统一 antd 组件语言（Scan/Scrape 的裸 input 换 antd Input/Button）

### 4.5 a11y 基线
roving tabindex 配 .focus()；:focus-visible 全局环不被组件覆盖；网格上下键 ±cols；侧栏改 button+aria-current；所有图标按钮 aria-label；正文级对比度 ≥4.5:1（透明度 ≥0.68）；toggle 类加 aria-pressed；点击目标 ≥32px。

### 4.6 性能基线（1 万游戏）
搜索 200ms 防抖 + 预计算小写索引；toggle 乐观更新+后台校验；主进程进度推送按帧合并（≤30Hz→16ms 帧）；下载列表虚拟化；扫描移 worker_thread；totalSpeed 增量维护。

### 4.7 交付管线
仓库补全 →（用户批准后）建 remote+push → CI（windows-latest：node20 + npm ci + typecheck + build + cargo test）→ dist:dir 解包 smoke（断言 hh.hello）→ tag 触发 release（--publish always + latest.yml/blockmap 上传）→ 应用内 autoUpdater 检查+下载+重启安装。图标 app/build/icon.ico；无签名期 README 明示放行步骤。

### 4.8 测试金字塔
- 单测 vitest：shared/{format,proxy,errors,sites}、renderer/status、host 帧编解码（抽纯函数）
- 集成：engine-rs tests/ 目录 + tempfile，覆盖分段/校验和/协议
- e2e：脚本自持生命周期（launchApp 公共模块：起-等-跑-杀），waitFor 轮询替固定 sleep，端口唯一或动态，关键节点 data-testid，失败 exit 1
- 视觉：cdp_visual.mjs 8 断言 + docs/shots/ 4 张基准图

### 4.9 engine-rs 结构
main.rs 101KB 拆 protocol/segment/checksum/http/state 五模块；host.rs 判定为死代码直接移除（扩展通道整体进路线图，不在本期重建）。

## §5 分阶段路线图（弱模型执行顺序）

### Phase 0 止血（零功能改动）
1. 补跟踪 commit：13 源文件 + app/scripts/e2e_download.mjs + docs/REDESIGN-SPEC.md + engine-rs/{Cargo.toml,Cargo.lock,src/**}
2. .gitignore：app/.e2e-data/、app/.*-data/、app/.shots/、app/build/；删死规则 ~/.hanehana/
3. .gitattributes：* text=auto eol=lf；*.png/*.ico/*.exe/*.bin binary
4. LICENSE（MIT 全文）；package.json engines node>=20
5. CI：.github/workflows/ci.yml（windows-latest，typecheck+build+cargo test）
6. 死契约清理：删 Ipc.GameAdd+preload.addGames；builder.yml 摘 fastdrop-host.exe；删 host.rs 与 Cargo 第二 bin（扩展进路线图）
7. README 事实对齐：引擎已实现、路线图按实勾选、扩展/自动更新移路线图、补 cargo 前置
验收：typecheck+build 绿；git status 仅剩本 Phase 预期项；CI 文件语法过 actionlint 或至少 yaml 解析

### Phase 1 可靠性 P0
1. games.ts：spawn error 监听；.lnk 走 shell.openPath；退出只解跟踪不 kill 用户游戏
2. manager.ts：preparing/verifying 计入槽位
3. engine.ts：confirmRun 加 paused 闸门；stop 等 ack(1s) 再 kill 并删三文件
4. Rust：pause abort in-flight fetch；paused 定稿路径修复；.part 水位 fsync；sidecar 记水位
5. scanner/games：扫描改异步遍历（不阻塞事件循环）
6. 安全五条（§4.3）全落
7. index.ts：debug port 限 !isPackaged；enginePath 启动自检+设置页提示
验收：typecheck+build+cargo test 绿；e2e 18/18；新增用例：并发上限生效（3 任务 max_concurrent=2 时同时 downloading≤2）、pause 期间流量停、retry 后 .part 不残留

### Phase 2 交付链路
1. icon.ico 生成（程序化绘制，非 AI 图）+ builder win/nsis icon 配置
2. autoUpdater 主进程实现 + 渲染更新提示（检查/下载/重启），或经用户同意改为移除——默认实现
3. release workflow（tag 触发）；dist 脚本改 --publish always 仅 workflow 内用，本地 dist 保持 never
4. dist:dir 解包 smoke 脚本（断言 hh.hello + 引擎存在）
5. README 未签名放行说明
验收：dist:dir 产物可启动且 hello 通；smoke 脚本 exit 0；push/release 动作一律先报清单等用户同意

### Phase 3 体验 P1（截图四缺陷 + a11y 六项 + 三态）
1. D18-D21 四处视觉修复（titlezone 40/itemSize 332；删 dlg-head；横幅 fallback 加主色径向+噪点纹；下载工具栏合并单行）
2. D22-D27、D32、D33 a11y 与状态色修复
3. D28-D31 三态与泄漏修复（loading、筛选空态区分、interval 清理、乐观更新）
4. D34 token 批量替换 + lint 规则落地
5. D35 错误呈现收敛 + 人性化文案
验收：typecheck+build 绿；cdp_ui 9/9；重截 5 图人工比对四缺陷消失；grep 字面量色值 = 0（components 内）

### Phase 4 性能与规模
搜索防抖+索引；推送帧合并；下载列表虚拟化；totalSpeed 增量；1 万游戏 seed 下首屏 <1s、滚动 60fps（cdp 断言 DOM 节点 <80）
验收：t6_virtual 扩展用例过；1 万 seed 截图

### Phase 5 打磨与 DoD
P2 批量（对比度/单真值色/glass 复用/scale 清理/点击目标/img @error/Settings 守卫/enter 范围/详情折叠/死代码删）；cdp_visual.mjs 8 断言；docs/shots/ 4 张基准图入库；本规格书 DoD 改写为可执行命令清单；README 终稿
验收：e2e 18/18 + cdp_ui 9/9 + cdp_visual 8/8 + vitest 全绿 + cargo test 全绿 + CI 绿 + docs/shots 4 图 + 每 Phase 一个中文 commit + 无 push

## §6 风险与非目标
- 非目标：不新增依赖（vitest/stylelint 属测试治理例外，需用户点头）；不改 IPC channel 名；games.json 只增字段；不做多平台（Win 优先）；不重建扩展通道（进路线图）；不做 AI 插帧/超分
- 风险：Rust 暂停语义改动牵动 e2e，Phase 1 内先补用例再改；token 批量替换用脚本+人工抽查防误伤；push/发版永远先报清单

## Sources
- [Playnite - video game library manager](https://playnite.link/)
- [Motrix — A full-featured download manager](https://motrix.app/)
- [agalwood/Motrix (GitHub)](https://github.com/agalwood/motrix)
- [VNDB.org API v2 (Kana)](https://api.vndb.org/kana)
- [The Visual Novel Database](https://vndb.org/)
