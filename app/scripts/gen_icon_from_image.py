"""生成应用图标(icon.ico 多尺寸)与托盘图标。

用法: python scripts/gen_icon_from_image.py
输入(优先): build/icon_src.png —— 由 crop_icon_source.py 产出的干净圆角图标(带透明角)
输入(兼容): build/user_icon_src.jpg —— 用户上传的原始二次元图(需本脚本自己裁方+圆角)
输出:
  build/icon.ico            Windows 打包图标 (16/32/48/64/128/256)
  build/tray.png            托盘 32×32
  build/icon-256.png        预览用 256×256

规则:
  若输入已带透明通道(预裁好的圆角图) —— 直接信任它的 alpha, 不再二次裁方/加蒙版,
  只缩放到各尺寸, 避免与图中已烘焙的圆角半径冲突把边框切歪。
  否则(原始 jpg) —— 走旧的"中心裁方 + 21% 圆角"逻辑。
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build')
SRC_MASKED = os.path.join(BUILD, 'icon_src.png')
SRC_RAW = os.path.join(BUILD, 'user_icon_src.jpg')
OUT_ICO = os.path.join(BUILD, 'icon.ico')
OUT_TRAY = os.path.join(BUILD, 'tray.png')
OUT_256 = os.path.join(BUILD, 'icon-256.png')

MASK_RADIUS_PCT = 0.21  # 原始图路径下的圆角半径比例

def rounded_mask(size: int, radius: float) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def load_source() -> Image.Image:
    """优先用预裁好的圆角图; 否则回退到原始 jpg。返回 RGBA, 附带是否已带透明圆角。"""
    if os.path.exists(SRC_MASKED):
        im = Image.open(SRC_MASKED).convert('RGBA')
        alpha = im.split()[-1]
        # 存在明显透明区(圆角已抠好)则视为预裁图
        if alpha.getextrema()[0] < 200:
            return im, True
    im = Image.open(SRC_RAW).convert('RGBA')
    return im, False

def main() -> None:
    src, pre_masked = load_source()

    if pre_masked:
        # 已经是带透明圆角的方图, 直接等比缩到 256 主图
        icon_256 = src.resize((256, 256), Image.LANCZOS)
    else:
        w, h = src.size
        side = min(w, h)
        left = (w - side) // 2
        top = int((h - side) * 0.18)  # 略偏上,把脸/主体框进裁切窗
        top = max(0, min(top, h - side))
        crop = src.crop((left, top, left + side, top + side))
        crop = crop.resize((256, 256), Image.LANCZOS)
        mask = rounded_mask(256, 256 * MASK_RADIUS_PCT)
        icon_256 = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
        icon_256.paste(crop, (0, 0), mask)

    # 多尺寸 ICO(逐档缩放)
    sizes = [16, 32, 48, 64, 128, 256]
    imgs = {s: icon_256.resize((s, s), Image.LANCZOS) for s in sizes}
    imgs[256].save(OUT_ICO, format='ICO', sizes=[(s, s) for s in sizes])

    # 托盘 32×32
    imgs[32].save(OUT_TRAY, format='PNG')
    icon_256.save(OUT_256, format='PNG')

    print(f'源: {"预裁圆角图 icon_src.png" if pre_masked else "原始图 user_icon_src.jpg"}')
    print(f'icon.ico   -> {OUT_ICO}  ({os.path.getsize(OUT_ICO)} B)')
    print(f'tray.png   -> {OUT_TRAY}  ({os.path.getsize(OUT_TRAY)} B)')
    print(f'icon-256   -> {OUT_256}  ({os.path.getsize(OUT_256)} B)')

if __name__ == '__main__':
    main()
