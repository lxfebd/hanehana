# HaneHana（羽花）— galgame 管理器

把**「管理已拥有的 galgame」**和**「下载新游戏」**缝在一起的桌面应用。封面墙式的游戏库：扫描导入本地游戏、多源元数据刮削（VNDB / Bangumi）、分类与标签整理、一键启动（后续接 LE 转区 / Magpie 缩放）、游玩时长统计；同时整合下载能力——复用 FastDrop 的 Rust 多线程分段下载引擎与内嵌游戏站捕获，做到「在同一个窗口里找到、下下来、入库、启动、记录时长」的完整闭环。

外壳是 Electron，界面是 Vue 3 + Ant Design Vue，视觉走 Windows 11 Mica 毛玻璃 + 玻璃卡片风格（深色优先）。

> 名称由来：取自 galgame 文化意象，避开与 GitHub 上已存在的同名项目（huoshen80/ReinaManager 等）撞名。

## 特性

**游戏库**

- 文件夹扫描导入（exe / bat / lnk），封面墙大图网格展示（竖版封面书架）
- 多源元数据刮削：VNDB + Bangumi 双源，图片 CDN 缓存
- 分类 / 标签 / 收藏夹 / 搜索（模糊 + 拼音）
- 一键启动游戏，后续接入 Locale Emulator（转区）与 Magpie（缩放）

**游玩统计**（规划）

- 进程监控自动计时、每日/周/月/年汇总
- 统计卡片海报导出

**下载**（规划，复用 FastDrop）

- Rust 多线程分段下载引擎：Range 分段并发、暂停/续传、断点续传、限速、哈希校验
- 内嵌游戏站浏览器 + 搜索聚合，真实直链进入下载队列
- 可选浏览器扩展（Edge / Chrome）投递下载链接

**界面与体验**

- Windows 11 Mica 毛玻璃窗口（22H2+，低版本自动降级）+ 自定义标题栏
- 玻璃卡片设计系统：blur + 内边框高光 + 顶部渐变高光 + 阴影栈
- 深 / 浅两套主题，深色优先
- 托盘常驻、系统通知、应用内自动更新（electron-updater）

## 快速开始

```bash
cd app && npm install
cd app && npm run dev      # 开发模式
cd app && npm run dist     # 打包安装包
```

前置依赖：**Node.js 20+ 与 npm**。Electron 由 npm 依赖安装。

开发验证：`npm run dev` 启动后，设置 `HANEHANA_DEBUG_PORT=9222` 再启动即可用
`node scripts/cdp_verify.mjs` 从 CDP 检查真实窗口的 DOM、preload 桥与 IPC 链路。

```bash
cd app && npm run typecheck   # 类型检查，零错误
cd app && npm run build       # 构建产物
```

## 架构

三层外壳 + 独立引擎（规划中）。渲染进程和主进程之间只走 IPC；主进程和下载引擎之间走 stdio——两条边界都不共享内存。

```
renderer (Vue3 + antd + 玻璃 CSS) ──IPC──▶ main (Electron) ──stdio──▶ engine-rs (Rust 下载引擎)
```

## 路线图

- [x] 骨架：Mica 毛玻璃窗口 + 自定义标题栏 + 三栏布局 + IPC 链路
- [ ] 游戏库：扫描导入 + 封面墙 + VNDB/Bangumi 刮削
- [ ] 启动集成：一键启动 + LE / Magpie
- [ ] 下载整合：FastDrop 引擎 + 游戏站捕获
- [ ] 游玩统计 + 设置 + 自动更新

## 许可

MIT
