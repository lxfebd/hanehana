<div align="center">

# 羽花 · HaneHana

**galgame 库管理器 + 下载引擎**
找到 → 下下来 → 入库 → 启动 → 记录时长，一个窗口里闭环

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-44-2b2e3a.svg)
![Vue](https://img.shields.io/badge/Vue-3.5-42b883.svg)
![Rust](https://img.shields.io/badge/Rust-tokio%20%2B%20reqwest-000000.svg)
![Platform](https://img.shields.io/badge/platform-Windows_11-0078d4.svg)

</div>

---

封面墙式的游戏库，把「管理已拥有的 galgame」和「下载新游戏」缝在同一件事里：扫描导入或手动选 exe 入库，VNDB / Bangumi 刮削封面与元数据，一键启动（LE 转区 / Magpie 缩放自动集成），进程监控自动计时；下载侧复用 Rust 多线程分段引擎与内嵌游戏站捕获，不用换窗口、不用换工具。

外壳 Electron，界面 Vue 3 + Ant Design Vue，视觉走 Windows 11 Mica 毛玻璃 + 玻璃卡片，深色优先、三套配色、跟随系统深浅实时换肤。

> 名称取自 galgame 文化意象，并避开 GitHub 上已存在的同名项目。

---

## 特性一览

### 📚 游戏库

| | |
| --- | --- |
| 导入 | 文件夹扫描（exe / bat / lnk）、手动选 exe 直接入库、Steam 库导入 |
| 展示 | 竖版封面墙（虚拟化渲染，万级不卡）、网格 / 列表双视图、评分与标签 chip |
| 元数据 | VNDB 主源 + Bangumi 备源刮削；单源失败只缺一列，不中断整体 |
| 封面 | 原图 + 320 宽缩略图本地缓存，走自定义 `hh://` 协议，不进 `file://` |
| 整理 | 分类 / 标签 / 搜索 / 收藏 / 批量编辑（多选改分类、切收藏、移除） |
| 启动 | 一键启动；LE 转区、Magpie 缩放每游戏开关；常用安装路径自动探测 |
| 记录 | 游玩时长与上次游玩（进程监控自动计时）、CSV 导出 |
| 右键 | 封面右键菜单：启动 / 收藏 / 刮削 / 编辑 / 刷新封面 / 打开目录 / 复制标题 |

### ⬇️ 下载（Rust 引擎 `fastdrop-engine`）

- **多线程分段下载**：HTTP Range 并发切片，每任务线程数可调
- **暂停 / 续传**：断点续传，任务状态机 `queued → preparing → downloading → paused → done / error / cancelled`
- **限速**：全局速率上限，避免下载打满链路
- **校验**：MD5 / SHA-1 / SHA-256，每任务可指定
- **代理**：支持 `http://` 与 `socks5://`（引擎侧 reqwest 原生 socks，配了就能用）
- **隔离**：每个任务一个引擎子进程，引擎崩溃只影响单个任务
- **任务列表**：状态过滤、搜索、排序、批量操作、总速度汇总、完成后一键打开文件

### 🌐 游戏站与新作追踪

- 内嵌游戏站浏览器 + 多站聚合搜索：**Gamer520 / NekoGAL / PlayZip**（新增站点只需加一条注册 + 一个解析器）
- 镜像解析：`pan` / `gofile` / `direct` / `cloudreve` / `torrent` / `page` 六类，直链类直接喂引擎
- 下载捕获：复用内嵌浏览器的登录态，按站点域名归属标注来源
- 新作追踪：订阅开发商 / 系列 / 关键词，定时查 VNDB，检出新作才弹系统通知

### 🎨 界面与体验

- Windows 11 Mica 毛玻璃窗口（22H2+，低版本自动降级）+ 自定义标题栏
- 设计 token 单源（`design/tokens.ts`）→ CSS 变量 + antd 主题映射，组件里写颜色字面量即违规
- 三套配色：**星海**（默认，夜蓝 + 星青）/ **樱夜**（紫调夜黑 + 樱花粉）/ **薄荷**（墨绿 + 薄荷绿），叠加跟随系统深浅
- 全屏模式：沉浸式封面浏览，`F` 只看收藏，可自定义背景图
- 统计页：日 / 周 / 月时长、近 30 天柱状、游戏排行，海报导出（800×1100 PNG）
- 存档备份：快照创建 / 列出 / 恢复 / 删除 + **WebDAV 同步**
- 中英双语界面、托盘常驻、系统通知、应用内自动更新（检查 → 静默下载 → 重启安装）

---

## ⌨️ 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl` + `F` | 聚焦搜索框（库页） |
| `Ctrl` + `A` | 库页全选（进入多选并选中当前筛选结果） |
| `Delete` | 移除选中的游戏（仅多选模式生效） |
| `Space` | 启动当前选中游戏（焦点不在输入框 / 按钮上时） |
| `1` / `2` / `3` | 切页：游戏库 / 下载 / 游戏站 |
| `F5` | 刷新游戏库 |
| `Esc` | 依次退层：清搜索词 → 关弹层 → 退多选 |
| `?` / `F1` | 快捷键帮助面板 |

防误触是硬约束：焦点在输入框内不处理单字符键，弹层打开时不处理页面级快捷键，多选模式才认 `Delete`。

---

## 🚀 快速开始

**前置依赖**：Node.js 20+ 与 npm、Rust stable（rustup）。Electron 由 npm 依赖安装。

```bash
# 1) 构建 Rust 下载引擎（打包与下载功能的必需件）
cd engine-rs && cargo build --release

# 2) 安装前端依赖
cd ../app && npm install

# 3) 开发模式（热更新）
npm run dev

# 4) 打包 NSIS 安装包
npm run dist
```

---

## 🗂 仓库结构

```
hanehana/
├── app/                    Electron 应用
│   ├── src/main/           主进程：游戏库 / 刮削 / 引擎调度 / 站点解析 / 备份 / 统计
│   │   └── ipc/            IPC 处理器（通道名集中在 shared/ipc.ts）
│   ├── src/preload/        contextBridge 暴露的 window.hh（沙箱开启）
│   ├── src/renderer/       Vue 3 界面：components / composables / stores / design / i18n
│   ├── src/shared/         主进程与渲染层共享的类型、IPC 通道名、错误与格式化
│   ├── scripts/            门禁脚本（回归闸 / 打包 smoke / 图标生成）
│   ├── tests/              node:test 单元测试
│   └── build/              图标素材（icon.ico / tray.png / 生成源图）
├── engine-rs/              Rust 下载引擎（tokio + reqwest，每任务一进程）
├── .github/workflows/      CI 守门 + tag 触发的 Release 发布
└── LICENSE                 MIT
```

---

## 🏗 架构

三层外壳 + 独立引擎。渲染进程与主进程之间只走 IPC（contextBridge，沙箱开启）；主进程与下载引擎之间走 stdio 行级 JSON。两条边界都不共享内存，引擎崩溃只影响单个任务。

```
renderer (Vue3 + antd + token CSS)
      │  IPC  ·  contextBridge，通道名单源于 shared/ipc.ts
      ▼
main (Electron)  ·  游戏库 / 刮削 / 站点解析 / 备份 / 统计 / 更新
      │  stdio  ·  行级 JSON 协议
      ▼
engine-rs (Rust)  ·  分段并发下载 + 校验，每任务一个子进程
```

封面与缩略图通过自定义 `hh://` scheme 加载，避免 `file://` 越界；CSP 与 scheme 注册在主进程一次性接线。

**数据目录**：`~/.hanehana`（`games.json` / `tasks.json` / `settings.json` / `covers/` / `thumbs/`），可用 `HANEHANA_DATA_DIR` 覆盖（测试与多开隔离用）。首启若检测到旧版 `%APPDATA%/hanehana` 游戏库会整体迁入；`HANEHANA_DATA_DIR` 指向隔离目录时不迁移，避免本机旧库渗进测试 seed。

---

## 🧪 质量闸门

| 命令 | 内容 |
| --- | --- |
| `npm run typecheck` | `vue-tsc` 双 tsconfig，零错误 |
| `npm run build` | `electron-vite` 构建产物 |
| `npm test` | `node:test` 单元测试（引擎行协议 / 错误 / 格式化 / JSON 存储 / 备份 / 刮削） |
| `npm run lint` | ESLint（0 error 闸，警告是渐进债务台账） |
| `npm run regression:static` | 静态验收闸（结构承诺固化，防改回旧风格） |
| `npm run regression:download` | 真实引擎下载链路 e2e |
| `npm run regression` | 上述串联，遇错即停 |
| `npm run dist:dir && npm run smoke` | 解包产物验收：进程可启动 + IPC 通 + 引擎存在 |

CI（`.github/workflows/ci.yml`）在 Windows runner 上跑 typecheck / build / 静态闸 / lint / 单测 / `cargo test` / `cargo build --release`，任一项红即阻断合入。

---

## 📦 打包与发版

```bash
cd app && npm run icon        # 由 build/ 的源图生成 icon.ico + tray.png
cd app && npm run dist:dir    # 解包产物（release/win-unpacked），供 smoke 验证
cd app && npm run smoke       # 解包验收：进程可启动 + IPC 通 + 引擎存在
cd app && npm run dist        # NSIS 安装包（--publish never，仅本地产物）
```

推送 `v*` tag 触发 GitHub Actions（`.github/workflows/release.yml`）：在 runner 上构建并发布 NSIS 安装包 + `latest.yml` 到 GitHub Release。应用内「设置 → 关于 → 检查更新」靠 `latest.yml` 发现新版本，静默下载后点「重启安装」完成升级。

> **未签名安装放行**：安装包目前未做代码签名（无证书）。Windows SmartScreen 会提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」放行；安装器由 GitHub Actions 从本仓库源码构建，`latest.yml` 与安装包哈希一致（Release 资产页可核对）。正式签名在路线图中。

---

## 🗺 路线图

- [x] 骨架：Mica 毛玻璃窗口 + 自定义标题栏 + 三栏布局 + IPC 链路
- [x] 游戏库：扫描导入 / 手动入库 / Steam 导入 + 封面墙 + VNDB·Bangumi 刮削
- [x] 启动集成：一键启动 + 时长统计 + LE / Magpie 外部工具自动集成
- [x] 下载整合：Rust 分段引擎 + 任务列表 + 校验和 + 限速 + 代理
- [x] 内嵌游戏站浏览器 + 多站搜索聚合 + 镜像解析 + 下载捕获
- [x] 统计汇总与海报导出 + 新作追踪 + 存档备份与 WebDAV 同步
- [x] 设置 + 托盘 + 通知 + 中英双语 + 多主题
- [x] 全局快捷键 + 快捷键帮助 + 封面右键菜单 + 全屏模式
- [x] 应用内自动更新（electron-updater + tag 触发 Release）
- [ ] 浏览器扩展投递下载链接（native messaging 通道）
- [ ] 安装包代码签名

---

## 📄 许可

MIT
