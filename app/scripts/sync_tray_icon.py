"""把 build/tray.png 同步为 src/main/trayIcon.ts 的内嵌 base64。

为什么需要这一步：托盘图标不能用 createFromPath 读 asar 路径，所以内联成
data URL（见 trayIcon.ts 注释）。生成 tray.png 之后必须同步这个文件，
否则应用托盘还是旧图。已挂到 `npm run icon` 末尾，跑一次图标就不会漏。

用法: python scripts/sync_tray_icon.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TRAY_PNG = os.path.join(HERE, '..', 'build', 'tray.png')
OUT_TS = os.path.join(HERE, '..', 'src', 'main', 'trayIcon.ts')

TEMPLATE = """/**
 * 托盘图标的内嵌 PNG（32x32，透明底）。
 *
 * 为什么不放成资源文件：`nativeImage.createFromPath` 走的是原生文件 IO，读不了
 * asar 里的路径，打包时得再配一份 extraResources 并处理开发与打包两套路径。
 * 这么小一张图直接内联，dev 和安装包的表现必然一致。
 *
 * 图案：羽花图标（粉色樱边 + 白羽 + 樱花）。
 *
 * 本文件由 `npm run icon`（scripts/sync_tray_icon.py）从 build/tray.png 生成，
 * 不要手改；要换图请更新源图后重跑该命令。
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,%s'
"""

def main() -> None:
    import base64
    with open(TRAY_PNG, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    with open(OUT_TS, 'w', encoding='utf-8', newline='\n') as f:
        f.write(TEMPLATE % b64)
    print(f'trayIcon.ts -> {OUT_TS} ({os.path.getsize(OUT_TS)} B, base64 {len(b64)} chars)')

if __name__ == '__main__':
    main()
