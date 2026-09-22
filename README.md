# HaneHana（羽花）— galgame 管理器

把**「管理已拥有的 galgame」**和**「下载新游戏」**缝在一起的桌面应用。封面墙式的游戏库：扫描导入本地游戏、多源元数据刮削（VNDB / Bangumi）、分类与标签整理、一键启动（后续接 LE 转区 / Magpie 缩放）、游玩时长统计；同时整合下载能力——复用 FastDrop 的 Rust 多线程分段下载引擎与内嵌游戏站捕获，做到「在同一个窗口里找到、下下来、入库、启动、记录时长」的完整闭环。

外壳是 Electron，界面是 Vue 3 + Ant Design Vue，视觉走 Windows 11 Mica 毛玻璃 + 玻璃卡片风格（深色优先）。

> 名称由来：取自 galgame 文化意象，避开与 GitHub 上已存在的同名项目（huoshen80/ReinaManager 等）撞名。

## 特性

**游戏库**（已实现）

- 文件夹扫描导入（exe / bat / lnk），封面墙大图网格展示（竖版封面书架，虚拟化渲染）
- 多源元数据刮削：VNDB + Bangumi 双源，封面/缩略图本地缓存（hh:// 协议）
- 分类 / 标签 / 搜索 / 网格与列表双视图
- 一键启动游戏；LE 转区 / Magpie 缩放为每游戏开关（外部工具集成在路线图）
- 游玩时长与上次游玩记录（进程监控自动计时）

**下载**（已实现，复用 FastDrop 引擎）

- Rust 多线程分段下载引擎：Range 分段并发、暂停/续传、限速、MD5/SHA-1/SHA-256 校验
- 任务列表：状态过滤、排序、批量操作、总速度汇总

**界面与体验**

- Windows 11 Mica 毛玻璃窗口（22H2+，低版本自动降级）+ 自定义标题栏
- 玻璃卡片设计系统：token 单源（design/tokens.ts）+ antd 主题映射
- 深色为唯一主题
- 托盘常驻、系统通知
- 应用内自动更新（electron-updater：检查 → 静默下载 → 重启安装）

**路线图中（尚未实现，勿当作现有能力）**

- 浏览器扩展投递下载链接（native messaging 通道）
- 内嵌游戏站浏览器 + 搜索聚合
- 统计汇总（日/周/月）与海报导出
- LE / Magpie 外部工具自动集成

## 快速开始

```bash
cd engine-rs && cargo build --release   # Rust 引擎（打包必需）
cd app && npm install
cd app && npm run dev      # 开发模式
cd app && npm run dist     # 打包安装包
```

前置依赖：**Node.js 20+ 与 npm**、**Rust stable（rustup）**。Electron 由 npm 依赖安装。

开发验证：`npm run dev` 启动后，设置 `HANEHANA_DEBUG_PORT=9222` 再启动即可用
`node scripts/cdp_verify.mjs` 从 CDP 检查真实窗口的 DOM、preload 桥与 IPC 链路。

```bash
cd app && npm run typecheck   # 类型检查，零错误
cd app && npm run build       # 构建产物
```

## 打包与发版

```bash
cd app && npm run icon        # 生成 build/icon.ico（程序化绘制，零依赖）
cd app && npm run dist:dir    # 解包产物（release/win-unpacked），smoke 验证用
cd app && npm run smoke       # 解包产物验收：进程可启动 + hh.hello 通 + 引擎存在
cd app && npm run dist        # NSIS 安装包（--publish never，仅本地产物）
```

发版流程已自动化：推送 `v*` tag 触发 GitHub Actions（`.github/workflows/release.yml`），
在 runner 上构建并发布 NSIS 安装包 + latest.yml 到 GitHub Release，应用内自动更新
（「设置 → 关于 → 检查更新」）靠 latest.yml 发现新版本，静默下载后点「重启安装」完成升级。

> **未签名安装放行**：目前安装包未做代码签名（无证书）。Windows SmartScreen 会提示
> 「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可放行；安装器本身
> 由 GitHub Actions 从本仓库源码构建，latest.yml 与安装包的哈希一致（GitHub Release
> 资产页可核对）。正式签名（EV 证书）在路线图中。

## 架构

三层外壳 + 独立引擎（已实现）。渲染进程和主进程之间只走 IPC（contextBridge，沙箱开启）；主进程和下载引擎之间走 stdio 行级 JSON——两条边界都不共享内存，引擎崩溃只影响单个任务。

```
renderer (Vue3 + antd + token CSS) ──IPC──▶ main (Electron) ──stdio──▶ engine-rs (Rust 下载引擎，每任务一进程)
```

数据目录：`~/.hanehana`（games.json / tasks.json / settings.json / covers / thumbs），可用 `HANEHANA_DATA_DIR` 覆盖。

## 路线图

- [x] 骨架：Mica 毛玻璃窗口 + 自定义标题栏 + 三栏布局 + IPC 链路
- [x] 游戏库：扫描导入 + 封面墙 + VNDB/Bangumi 刮削
- [x] 启动集成：一键启动 + 时长统计（LE / Magpie 开关已存，外部集成待做）
- [x] 下载整合：Rust 引擎 + 任务列表 + 校验和
- [x] 设置 + 托盘 + 通知
- [x] 应用内自动更新（electron-updater + tag 触发 Release）
- [ ] 浏览器扩展投递链接（native messaging）
- [ ] 内嵌游戏站浏览器 + 搜索聚合
- [ ] 统计汇总与海报导出

## 许可

MIT
