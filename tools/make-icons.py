#!/usr/bin/env python3
"""Иконки и заставки приложения. Без зависимостей: PNG пишется руками.

   python3 tools/make-icons.py

Рисунок: три детские головки в ряд, растущие слева направо, — тот самый
таймлапс, ради которого всё и затевалось. Мелкой иконку видят чаще, чем
крупной, поэтому в ней одна мысль и ни одной тонкой линии: на сорока
пикселях выживают только крупные пятна.
"""
import struct, zlib, os, math, sys

# Windows отдаёт консоль в кодировке системы — у русской это cp1251, а в отчёте
# ниже есть «×» и «КБ». Без этой строки скрипт рисует иконки и падает на первой
# же попытке о них рассказать. Подпись к работе не стоит того, чтобы ронять
# саму работу, поэтому просим UTF-8 и разрешаем заменять непечатаемое.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

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


def write_png(path, w, h, px):
    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {w}×{h}  {len(png) // 1024} КБ')


os.makedirs('icons', exist_ok=True)
for size, name, inset in [
    (192, 'icons/icon-192.png', 1.0),
    (512, 'icons/icon-512.png', 1.0),
    # Маскируемую иконку системы обрезают по кругу — мотив уводим внутрь.
    (512, 'icons/icon-maskable-512.png', 0.72),
    (180, 'icons/apple-touch-icon.png', 1.0),
]:
    write_png(name, size, size, render(size, inset))


# ---- Заставки для айфона ----------------------------------------------------
#
# Пока приложение просыпается, iOS показывает картинку, а если её нет — белый
# лист. Именно по этому листу установленное приложение и опознаётся как сайт:
# полторы секунды пустоты при каждом запуске.
#
# Картинка обязана совпадать с экраном по пикселям: iOS выбирает её медиа-
# запросом на точный размер и, не найдя совпадения, показывает всё тот же
# белый лист. Отсюда список ниже — он не про поддержку, а про попадание.
# Незнакомая модель просто останется с белым листом, то есть с тем, что было.
#
# Только портрет: приложение портретное, и заставки на поворот удвоили бы
# список ради случая, которого в нём не бывает.

# Фон — между двумя темами приложения: розовой «для девочки» (#FFF6F9) и
# голубой «для мальчика» (#F2F8FE). Какая из них выбрана, лежит в config.json
# и на момент запуска ещё не прочитано, поэтому заставка не может быть ни той,
# ни другой; посередине она не спорит ни с одной.
SPLASH_BG = (0xF8, 0xF7, 0xFB)
SPLASH_ICON = 120     # сторона значка в точках — как у крупной иконки в системе
CORNER = 0.2237       # скругление: та же доля стороны, что у иконок на экране «Домой»

# ширина, высота (в точках), плотность пикселей, кто это
DEVICES = [
    (320, 568, 2, 'SE 1, 5s'),
    (375, 667, 2, 'SE 2 и 3, 6, 7, 8'),
    (414, 736, 3, '8 Plus'),
    (375, 812, 3, 'X, XS, 11 Pro, 12 mini, 13 mini'),
    (414, 896, 2, 'XR, 11'),
    (414, 896, 3, 'XS Max, 11 Pro Max'),
    (390, 844, 3, '12, 12 Pro, 13, 13 Pro, 14'),
    (428, 926, 3, '12 Pro Max, 13 Pro Max, 14 Plus'),
    (393, 852, 3, '14 Pro, 15, 15 Pro, 16, 16e'),
    (430, 932, 3, '14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus'),
    (402, 874, 3, '16 Pro'),
    (440, 956, 3, '16 Pro Max'),
]


def rounded_alpha(side):
    """Маска скруглённого квадрата: внутри непрозрачно, углы сходят на нет."""
    r = CORNER * side
    edge = int(math.ceil(r))
    mask = bytearray(b'\xff' * (side * side))
    for y in range(edge):
        for x in range(edge):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    dx = x + (sx + 0.5) / SS - r
                    dy = y + (sy + 0.5) / SS - r
                    # За центром скругления — по кругу, до него — по прямой.
                    if dx >= 0 or dy >= 0 or dx * dx + dy * dy <= r * r:
                        hits += 1
            a = round(255 * hits / (SS * SS))
            # Один посчитанный угол ложится на все четыре.
            for py, px_ in ((y, x), (y, side - 1 - x),
                            (side - 1 - y, x), (side - 1 - y, side - 1 - x)):
                mask[py * side + px_] = a
    return mask


def render_splash(w, h, side, icon, mask):
    """Значок посреди ровного фона — ровно то, что показывает система."""
    px = bytearray(bytes(SPLASH_BG) * w * h)
    x0, y0 = (w - side) // 2, (h - side) // 2
    for y in range(side):
        dst = ((y0 + y) * w + x0) * 3
        src = y * side * 3
        for x in range(side):
            a = mask[y * side + x]
            if not a:
                continue
            for c in range(3):
                i, j = dst + x * 3 + c, src + x * 3 + c
                px[i] = icon[j] if a == 255 else round(px[i] * (1 - a / 255) + icon[j] * a / 255)
    return px


# Значок зависит только от плотности пикселей, а не от модели: считаем по разу.
art = {}
links = []
for w_pt, h_pt, dpr, who in DEVICES:
    side = round(SPLASH_ICON * dpr)
    if side not in art:
        art[side] = (render(side, 1.0), rounded_alpha(side))
    w, h = w_pt * dpr, h_pt * dpr
    name = f'icons/splash-{w}x{h}.png'
    write_png(name, w, h, render_splash(w, h, side, *art[side]))
    links.append(
        f'<link rel="apple-touch-startup-image" href="{name}"\n'
        f'      media="(device-width: {w_pt}px) and (device-height: {h_pt}px) and '
        f'(-webkit-device-pixel-ratio: {dpr}) and (orientation: portrait)"><!-- {who} -->')

print('\nСтроки для <head> в index.html:\n')
print('\n'.join(links))
