# 从 PNG 断言海报文字结构正常(防「文字平铺/碎裂」回归)。
# 用法: node scripts/accept_batch13.mjs 内部调用,或手动: python assert_poster_pixels.py <png>
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else '.batch13-poster.png'
img = Image.open(path).convert('RGB')
w, h = img.size
assert (w, h) == (800, 1100), f'size {w}x{h}'
px = img.load()


def near_white(x0, y0, x1, y1):
    n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y]
            if r > 200 and g > 195 and b > 195:
                n += 1
    return n


checks = [
    # 标题「游玩统计」区必须有明显白字
    ('title-white', near_white(56, 55, 500, 145), 800),
    # KPI 行必须有白字
    ('kpi-white', near_white(56, 215, 744, 300), 400),
    # 图表区块标题
    ('chart-title-white', near_white(56, 515, 400, 555), 200),
    # Top5 区块标题
    ('top5-title-white', near_white(56, 830, 400, 870), 200),
    # 中部大空白区不允许出现白字(平铺/碎裂会污染这里)
    ('mid-empty', near_white(56, 320, 744, 500), -1),
]
failed = []
for name, value, need in checks:
    if need < 0:
        ok = value == 0
        print(f'{"PASS" if ok else "FAIL"} {name}: {value} (want 0)')
    else:
        ok = value >= need
        print(f'{"PASS" if ok else "FAIL"} {name}: {value} (want >= {need})')
    if not ok:
        failed.append(name)
if failed:
    sys.exit(1)
print('PASS poster-pixel structure')
