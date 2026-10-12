"""生成图标预览：透明底检查棋盘 + 多尺寸（模拟桌面/任务栏/托盘）实际观感。"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build')
SRC = os.path.join(BUILD, 'icon-256.png')
OUT = os.path.join(HERE, '..', '..', 'icon_preview.png')

icon = Image.open(SRC).convert('RGBA')

W, H = 1100, 460
canvas = Image.new('RGB', (W, H), (32, 34, 40))
cd = ImageDraw.Draw(canvas)

# 左：棋盘格（验透明）
board = Image.new('RGB', (300, 300), (255, 255, 255))
bd = ImageDraw.Draw(board)
cell = 20
for y in range(0, 300, cell):
    for x in range(0, 300, cell):
        if (x // cell + y // cell) % 2 == 0:
            bd.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(205, 205, 210))
canvas.paste(board, (40, 90), board.convert('RGBA'))
big = icon.resize((300, 300), Image.LANCZOS)
canvas.paste(big, (40, 90), big)

# 右：深色背景多尺寸（模拟暗色桌面/任务栏）
cd.text((380, 40), 'Dark desktop / taskbar', fill=(200, 205, 215))
sizes = [128, 64, 48, 32, 24, 16]
x = 380
base_y = 210
for s in sizes:
    im_s = icon.resize((s, s), Image.LANCZOS)
    canvas.paste(im_s, (x, base_y - s), im_s)
    x += s + 26

# 右：浅色背景多尺寸
light = Image.new('RGBA', (680, 120), (240, 240, 245, 255))
canvas.paste(light, (380, 280), light)
x = 400
for s in sizes:
    im_s = icon.resize((s, s), Image.LANCZOS)
    canvas.paste(im_s, (x, 390 - s), im_s)
    x += s + 26
cd.text((380, 250), 'Light desktop', fill=(200, 205, 215))

# 任务栏条
bar = Image.new('RGBA', (680, 56), (18, 18, 22, 255))
canvas.paste(bar, (380, 400), bar)
tx = 400
for s in (32, 32, 32, 24):
    im_s = icon.resize((s, s), Image.LANCZOS)
    canvas.paste(im_s, (tx, 428 - s), im_s)
    tx += s + 14

canvas.save(OUT)
print('preview ->', OUT, os.path.getsize(OUT), 'B')
