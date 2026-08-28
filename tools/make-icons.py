#!/usr/bin/env python3
"""Иконки приложения. Без зависимостей: PNG пишется руками.

   python3 tools/make-icons.py
"""
import struct, zlib, os

BG = (0x1C, 0x19, 0x17)
CIRCLES = [  # (cx, cy, r, color) в долях от стороны
    (0.215, 0.5, 0.059, (0x7A, 0x46, 0x32)),
    (0.445, 0.5, 0.113, (0xC4, 0x66, 0x3F)),
    (0.762, 0.5, 0.195, (0xE8, 0x84, 0x5C)),
]
SS = 3  # подпиксельная сетка для сглаживания


def render(size, inset=1.0):
    px = bytearray(size * size * 3)
    for y in range(size):
        row = y * size * 3
        for x in range(size):
            px[row + x * 3:row + x * 3 + 3] = bytes(BG)

    for cxf, cyf, rf, color in CIRCLES:
        cx = (cxf - 0.5) * inset * size + size / 2
        cy = (cyf - 0.5) * inset * size + size / 2
        r = rf * inset * size
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
                if not hits:
                    continue
                a = hits / (SS * SS)
                i = (y * size + x) * 3
                for c in range(3):
                    px[i + c] = round(px[i + c] * (1 - a) + color[c] * a)
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
    (512, 'icons/icon-maskable-512.png', 0.66),
    (180, 'icons/apple-touch-icon.png', 1.0),
]:
    write_png(name, size, render(size, inset))
