#!/usr/bin/env python3
"""Тот же http.server, только без кэша.

Обычный `python3 -m http.server` не шлёт Cache-Control, и браузер кэширует
файлы по своей эвристике — на часы. Во время правки это приводит к худшему из
возможного: часть модулей приезжает свежей, часть из кэша, импорт не находит
только что добавленный экспорт, и приложение молча показывает пустой экран.

Поэтому здесь одна строчка поверх стандартного сервера: «не кэшировать».
На боевой выкладке ничего этого не нужно — там файлы отдаёт GitHub Pages.

    python3 tools/serve.py [порт]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    handler = partial(NoCache, directory=str(ROOT))
    print(f'http://localhost:{port} — отдаю {ROOT}, без кэша')
    ThreadingHTTPServer(('', port), handler).serve_forever()
