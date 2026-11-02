# HaneHana 浏览器扩展（Chrome / Edge）

把网页上的下载链接交给 **HaneHana** 桌面应用，由应用自带的下载引擎接手下载。
扩展本身不下载任何东西，它只是通过浏览器的 native messaging 通道把链接递过去。

- 协议契约（唯一真值）：`app/src/shared/nmProtocol.ts`
- 宿主名：`com.lxfebd.hanehana`
- 扩展 ID（固定）：`jjoapnhpnedocdkfffpiccdehollooab`

---

## 一、能做什么

| 操作 | 结果 |
| --- | --- |
| 在链接上右键 → **用 HaneHana 下载** | 这条链接立刻交给应用 |
| 在页面空白处右键 → **把本页链接交给 HaneHana** | 投递本页发现的第一个下载链接；本页没有下载链接时投递当前页地址 |
| 在网页上**按住 Alt 点击**下载链接 | 该链接被高亮并收集到扩展弹窗里（不会触发浏览器自己的下载） |
| 点击扩展图标 → 粘贴链接 → **投递到 HaneHana** | 手动投递任意 http/https 链接 |

弹窗里还会显示最近 10 条投递记录（时间、文件名、结果）。

---

## 二、安装

### Chrome

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择扩展目录：`app/extension`（就是有 `manifest.json` 的那一层，不要进 `icons`）
5. 装好后扩展卡片上应显示扩展 ID `jjoapnhpnedocdkfffpiccdehollooab`
   —— 这个 ID 是写死的（manifest 里的 `key` 字段），**不要重新生成**，否则桌面应用那边会拒绝本扩展

### Edge

1. 打开 `edge://extensions`
2. 左下角打开 **开发人员模式**
3. 点 **加载解压缩的扩展**
4. 同样选择 `app/extension` 目录

> 装完扩展后建议**重启一次浏览器**：native messaging 宿主清单是应用侧写进注册表的，
> 浏览器只在启动时读取一次。

### 桌面应用也要装好

扩展只是「递纸条的」，真正下载的是 HaneHana 应用。
第一次使用请在应用设置里完成 native messaging 宿主的注册。
注册写进注册表的是**宿主中继程序**（`fastdrop-nm-host`，随应用一起装在 `resources/` 下）——
Chrome 拉起它，它再把消息递给桌面端；这一层存在的意义是让 Chrome 收到的字节流
只有 native messaging 协议帧（桌面端自己启动时会往 stdout 写噪音，直接对接会错位）。
应用没运行时链接会先排队，应用下次启动自动接手。

---

## 三、Cookie（可选）

默认 **不携带** Cookie。

需要带登录态的直链时（比如某个网盘链接离开浏览器就 403）：

1. 在弹窗里勾选 **携带当前站点 Cookie**
2. 浏览器会弹出权限确认，需要同意：
   - 读取 Cookie
   - 访问当前站点
3. 之后再投递，扩展会读取当前站点的 Cookie 一并发给应用

几条规矩：

- 只在**目标链接与当前站点同源**时才会附带 Cookie；跨站链接不会带，
  避免把 A 站的登录凭据发给 B 站
- 取消勾选会**撤回当前站点的访问权限**
- Cookie 只在投递那一刻读一次，**不会写进扩展的本地记录**
- 扩展的权限清单里 `cookies` 是**可选权限**，不勾就永远不读

---

## 四、常见问题

| 弹窗里的提示 | 原因 | 怎么办 |
| --- | --- | --- |
| 找不到 HaneHana 宿主（可能没在设置里注册） | 浏览器找不到 `com.lxfebd.hanehana` 这个宿主 | 在应用设置里重新注册宿主，然后重启浏览器 |
| HaneHana 宿主拒绝了本扩展的访问 | 扩展 ID 与宿主清单 `allowed_origins` 不一致 | 确认扩展 ID 是 `jjoapnhpnedocdkfffpiccdehollooab`；不一致就让应用侧改清单或重新生成 manifest 的 `key` |
| HaneHana 宿主已退出 | 应用正在关闭或崩溃 | 重开应用再试 |
| 只支持 http/https 链接 | 协议不支持 | 只支持 `http://` / `https://` 直链 |
| HaneHana 拒绝了这条链接：… | 应用侧校验没过 | 按提示改链接（常见是链接过期、需要登录态） |
| HaneHana 未运行，链接已排队 | 应用没开 | 不用管，应用下次启动会自动接手 |
| 点了右键菜单没反应 | 菜单被浏览器吞了，或页面不支持 | 看扩展图标上的角标（`OK` / `!`），或打开弹窗看状态 |

另外：

- 弹窗顶部如果出现 **扩展 ID 与宿主清单不一致** 的红条，说明当前扩展 ID 和应用写死的
  ID 对不上，native messaging 一定被拒。先把两边对齐。
- Chrome 商店 / Edge 商店都还没上架，只能手动加载。

---

## 五、已知限制

- 只适配 **Chromium 系**（Chrome / Edge / Brave）；Firefox 的 manifest 字段与
  native messaging 行为不同，本扩展没有做适配
- **未上架应用商店**，需要手动「加载已解压的扩展程序」
- 只支持 **http/https** 直链，不支持 `magnet:` / `ftp:` / `file:` 等
- Alt+点击收集只认**看起来像下载文件**的链接（常见压缩包 / 安装包 / 镜像扩展名，
  或带 `download` 属性的 `<a>`），普通链接不会被动
- Cookie 同源限制（见上一节）
- 右键页面菜单只投递**第一个**找到的下载链接；多个链接请在弹窗里逐条投递
- 扩展不接管浏览器自己的下载，只在你明确用右键菜单 / 弹窗 / Alt+点击时才介入

---

## 六、目录结构

```
app/extension/
├── manifest.json      MV3 清单（权限、固定 key、图标、content script）
├── background.js      service worker：右键菜单 → native messaging → 结果/记录
├── content.js         识别下载链接、Alt+点击收集与高亮
├── popup.html/css/js  弹窗：手动投递、Cookie 开关、本页链接、最近记录
├── strings.js         全部中文字案集中在这里
└── icons/             16 / 32 / 48 / 128 PNG 图标
```
