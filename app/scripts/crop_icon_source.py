"""把 AI 生成图裁成干净的应用图标源图（去文字/水印/摄影棚背景）。

用法: python scripts/crop_icon_source.py <源图路径>
输出: build/icon_src.png（带透明圆角的方图，gen_icon_from_image.py 直接可用）

原理：
  1. 强粉像素自动定位图标方框（粉顶边框 → top/left/right；正方形推出 bottom）。
     底部的「软件名文字 + AI 水印」都在方框外，裁切即去除。
  2. 按图标自身的圆角半径（实测 ~24% 边长）做圆角 alpha 蒙版，
     把四角的摄影棚背景抠成透明。背景与图标内场颜色接近，靠颜色分不开，
     所以用几何蒙版而不是像素分类。
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src or not os.path.exists(src):
        print('用法: python scripts/crop_icon_source.py <源图>')
        sys.exit(1)
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', 'build', 'icon_src.png')

    im = Image.open(src).convert('RGB')
    w, h = im.size
    px = im.load()

    # ---- 1. 强粉像素 → 图标方框 ----
    def strong_pink(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        return r > 235 and 120 < g < 215 and 170 < b < 235 and r - g > 35

    pink_rows = {}
    for y in range(0, h):
        xs = [x for x in range(0, w, 2) if strong_pink(x, y)]
        if len(xs) > 80:
            pink_rows[y] = (min(xs), max(xs))
    if not pink_rows:
        print('未找到粉色边框像素，无法定位图标')
        sys.exit(1)

    top = min(pink_rows)
    left = min(v[0] for v in pink_rows.values())
    right = max(v[1] for v in pink_rows.values())
    side = right - left + 1
    bottom = top + side
    print(f'图标方框: left={left} top={top} side={side} bottom={bottom} (图像 {w}x{h})')
    if bottom > h or right > w:
        print('方框越界：源图可能贴边，请检查')
        sys.exit(1)

    # ---- 2. 裁切 + 圆角蒙版（半径 24.2%，实测该图图标圆角 ~244/1011） ----
    crop = im.crop((left, top, left + side, bottom)).convert('RGBA')
    radius = int(side * 0.242)
    mask = Image.new('L', (side, side), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, side - 1, side - 1], radius=radius, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))  # 边缘抗锯齿
    result = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    result.paste(crop, (0, 0), mask)
    result.save(out)

    rp = result.load()
    corners = [rp[x, y][3] for x, y in ((1, 1), (side - 2, 1), (1, side - 2), (side - 2, side - 2))]
    center = rp[side // 2, side // 2]
    print(f'保存 -> {out} ({os.path.getsize(out)} B)')
    print(f'四角 alpha={corners} (应全 0)  中心={center} (应不透明)')

if __name__ == '__main__':
    main()
