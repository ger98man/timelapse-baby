#!/usr/bin/env python3
"""Иконки приложения. Без зависимостей: PNG пишется руками.

   python3 tools/make-icons.py

Рисунок: три детские головки в ряд, растущие слева направо, — тот самый
таймлапс, ради которого всё и затевалось. Мелкой иконку видят чаще, чем
крупной, поэтому в ней одна мысль и ни одной тонкой линии: на сорока
пикселях выживают только крупные пятна.
"""
import struct, zlib, os, math

# Фон — вертикальная растяжка розового: цвета те же, что у темы «для девочки».
BG_TOP = (0xF2, 0x7F, 0xAB)
BG_BOTTOM = (0xC9, 0x31, 0x6F)
INK = (0xFF, 0xFF, 0xFF)

# Три головки в ряд, растущие слева направо: снимок за снимком ребёнок
# становится больше. Мелкие головы оставлены без завитка — на сорока
# пикселях он превращается в шум.
BASE = 0.78                 # общая «земля», по которой выровнены головы
HEADS = [                   # cx, r, непрозрачность, рисовать ли завиток
    (0.205, 0.085, 0.62, False),
    (0.490, 0.125, 0.82, True),
    (0.800, 0.170, 1.00, True),
]
SS = 3   # подпиксельная сетка для сглаживания


def blend(px, size, x, y, color, a):
    i = (y * size + x) * 3
    for c in range(3):
        px[i + c] = round(px[i + c] * (1 - a) + color[c] * a)


def disc(px, size, cx, cy, r, color, alpha=1.0):
    """Круг со сглаженным краем."""
    x0, x1 = max(0, int(cx - r - 2)), min(size, int(cx + r + 2))
    y0, y1 = max(0, int(cy - r - 2)), min(size, int(cy + r + 2))
    for y in range(y0, y1):
        for x in range(x0, x1):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    dx = x + (sx + 0.5) / SS - cx
                    dy = y + (sy + 0.5) / SS - cy
                    if dx * dx + dy * dy <= r * r:
                        hits += 1
            if hits:
                blend(px, size, x, y, color, alpha * hits / (SS * SS))


def stroke_arc(px, size, cx, cy, r, width, a0, a1, color):
    """Дуга с круглыми концами — штампуем кружки вдоль неё."""
    steps = max(24, int(r * 2))
    for i in range(steps + 1):
        t = math.radians(a0 + (a1 - a0) * i / steps)
        disc(px, size, cx + math.cos(t) * r, cy + math.sin(t) * r, width / 2, color)


def render(size, inset=1.0):
    px = bytearray(size * size * 3)
    for y in range(size):
        t = y / max(1, size - 1)
        row = bytes(round(BG_TOP[c] * (1 - t) + BG_BOTTOM[c] * t) for c in range(3))
        px[y * size * 3:(y + 1) * size * 3] = row * size

    # inset уводит рисунок внутрь: у маскируемой иконки края съедает система
    def s(v):
        return (v - 0.5) * inset * size + size / 2

    for cx, r, alpha, curl in HEADS:
        cy = BASE - r
        disc(px, size, s(cx), s(cy), r * inset * size, INK, alpha)
        if curl:
            stroke_arc(px, size, s(cx + r * 0.30), s(cy - r * 1.16),
                       r * 0.40 * inset * size, r * 0.30 * inset * size,
                       150, 368, INK)
    return px


def write_png(path, size, px):
    raw = bytearray()
    stride = size * 3
    for y in range(size):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}×{size}  {len(png) // 1024} КБ')


os.makedirs('icons', exist_ok=True)
for size, name, inset in [
    (192, 'icons/icon-192.png', 1.0),
    (512, 'icons/icon-512.png', 1.0),
    # Маскируемую иконку системы обрезают по кругу — мотив уводим внутрь.
    (512, 'icons/icon-maskable-512.png', 0.72),
    (180, 'icons/apple-touch-icon.png', 1.0),
]:
    write_png(name, size, render(size, inset))
