"""从用户选定的二次元图生成应用图标(icon.ico 多尺寸)与托盘图标。

用法: python scripts/gen_icon_from_image.py
输入: build/user_icon_src.jpg (用户上传的源图)
输出:
  build/icon.ico            Windows 打包图标 (16/32/48/64/128/256)
  build/tray.png            托盘 32×32
  build/icon-256.png        预览用 256×256
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'build', 'user_icon_src.jpg')
OUT_ICO = os.path.join(HERE, '..', 'build', 'icon.ico')
OUT_TRAY = os.path.join(HERE, '..', 'build', 'tray.png')
OUT_256 = os.path.join(HERE, '..', 'build', 'icon-256.png')

MASK_RADIUS_PCT = 0.21  # 圆角半径 = 边长 * 21%

def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask

def main() -> None:
    src = Image.open(SRC).convert('RGBA')
    w, h = src.size
    side = min(w, h)
    left = (w - side) // 2
    top = int((h - side) * 0.18)  # 略偏上,把脸/主体框进裁切窗
    top = max(0, min(top, h - side))
    crop = src.crop((left, top, left + side, top + side))
    crop = crop.resize((256, 256), Image.LANCZOS)

    # 应用圆角
    mask = rounded_mask(256, 256 * MASK_RADIUS_PCT)
    icon_256 = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    icon_256.paste(crop, (0, 0), mask)

    # 多尺寸 ICO(Windows 习惯:小尺寸用真彩,大尺寸用 PNG 压缩)
    sizes = [16, 32, 48, 64, 128, 256]
    imgs = {s: icon_256.resize((s, s), Image.LANCZOS) for s in sizes}
    ico = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    # Pillow 的 ICO 保存:传已提到底图的尺寸序列,逐档缩放
    imgs[256].save(OUT_ICO, format='ICO', sizes=[(s, s) for s in sizes])

    # 托盘 32×32(Windows 高 DPI 实际取 32H;再留一份 16H 由系统缩放)
    imgs[32].save(OUT_TRAY, format='PNG')
    icon_256.save(OUT_256, format='PNG')

    print(f'icon.ico   -> {OUT_ICO}  ({os.path.getsize(OUT_ICO)} B)')
    print(f'tray.png   -> {OUT_TRAY}  ({os.path.getsize(OUT_TRAY)} B)')
    print(f'icon-256   -> {OUT_256}  ({os.path.getsize(OUT_256)} B)')

if __name__ == '__main__':
    main()