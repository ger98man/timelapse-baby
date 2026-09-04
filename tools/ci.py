#!/usr/bin/env python3
"""Прогон проверочных страниц без браузера на экране.

Тесты здесь — обычные страницы, и открывать их глазами правильно: видно, что
именно упало. Но открывать четыре страницы руками перед каждым push никто не
станет, а незамеченная поломка store.js доезжает до Pages за десять минут.
Поэтому то же самое умеет делать и машина: свой сервер, свой Chrome без окна,
и один ответ на выходе — сошлось или нет.

Зависимостей по-прежнему нет: Chrome берётся тот, что уже стоит в системе,
а страницы те же самые, что открывают руками. Отдельного «тестового» кода,
который живёт своей жизнью и расходится с настоящим, здесь не заводится.

    python3 tools/ci.py            # все страницы
    python3 tools/ci.py align      # только tools/test-align.html
"""

import re
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ['align', 'dates', 'store', 'zip']
PORT = 8799          # не 8787: рядом может идти обычная разработка

# Сколько ждать итога. Виртуальным временем Chrome здесь не обойтись: половина
# работы идёт через IndexedDB, а его Chrome не прокручивает — страница просто
# не успевает досчитать до того, как истечёт бюджет. Поэтому ждём по-честному
# и ровно до строки HARNESS, которую печатает harness.js.
#
# Тридцати секунд хватает с запасом: самая долгая страница считает две. Ждать
# дольше незачем — не досчитавшая до итога страница почти всегда не досчитала
# вовсе (сломанный импорт, опечатка в модуле), а не считает медленно.
TIMEOUT_S = 30

CHROMES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
]


def find_chrome():
    for path in CHROMES:
        try:
            subprocess.run([path, '--version'], capture_output=True, check=True)
            return path
        except (OSError, subprocess.CalledProcessError):
            continue
    sys.exit('Не нашёл Chrome. Поставьте его или откройте страницы руками: '
             'python3 tools/serve.py')


class Quiet(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, *args):
        pass


def serve():
    handler = partial(Quiet, directory=str(ROOT))
    server = ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# Итог печатает harness.js — строкой в консоль и той же строкой на странице.
# Читаем консоль: она приходит по мере работы, и ждать до конца отведённого
# времени, когда всё уже сошлось, не приходится.
# Строку Chrome оборачивает в свой формат («…CONSOLE(45)] "HARNESS pass 0 48",
# source: …»), поэтому берём ровно то, что напечатал harness, и ни слова больше.
COUNTED = re.compile(r'HARNESS (pass|fail) (\d+) (\d+)')
CRASHED = re.compile(r'HARNESS crash (.*?)(?:"|$)')
BAD = re.compile(r'HARNESS bad (.*?)(?:", source:|$)')


def run(chrome, name):
    url = f'http://127.0.0.1:{PORT}/tools/test-{name}.html'
    started = time.monotonic()
    # Свой профиль на каждый прогон: страницы держат данные в IndexedDB, и
    # прошлый прогон не должен доставаться следующему — как не достаётся он и
    # человеку, открывшему страницу в первый раз.
    with tempfile.TemporaryDirectory() as profile:
        proc = subprocess.Popen([
            chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
            '--no-first-run', '--disable-extensions',
            f'--user-data-dir={profile}',
            '--enable-logging=stderr', '--v=0', url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
           errors='replace')

        verdict, failed, total, why = None, 0, 0, ''
        bad, lines = [], []
        deadline = started + TIMEOUT_S
        try:
            while time.monotonic() < deadline:
                line = proc.stderr.readline()
                if not line:
                    break
                lines.append(line)
                spoiled = BAD.search(line)
                if spoiled:
                    bad.append(spoiled.group(1).strip())
                    continue
                counted = COUNTED.search(line)
                crashed = CRASHED.search(line)
                if counted:
                    verdict = counted.group(1)
                    failed, total = int(counted.group(2)), int(counted.group(3))
                    break
                if crashed:
                    verdict, why = 'crash', crashed.group(1).strip()
                    break
        finally:
            proc.kill()
            proc.wait()

    took = time.monotonic() - started
    if verdict == 'pass':
        print(f'  ✓ {name}: {total} проверок за {took:.1f} с')
        return True

    if verdict == 'fail':
        print(f'  ✗ {name}: провалено {failed} из {total}')
    elif verdict == 'crash':
        print(f'  ✗ {name}: тест упал — {why}')
    else:
        print(f'  ✗ {name}: итога нет за {TIMEOUT_S} с. Обычно это значит, что '
              'модуль страницы не запустился — сломан импорт или синтаксис. '
              'Откройте её в браузере: там будет видно, что именно.')

    for line in bad[:12]:
        print(f'      {line}')
    # Итога нет вовсе — значит, не запустился сам модуль, и объяснение этому
    # лежит в ошибках страницы. В остальных случаях они только мешают: там
    # уже сказано, какие проверки не сошлись.
    if not verdict:
        for line in lines:
            if 'CONSOLE' in line and 'ERROR' in line:
                print(f'      {line.rstrip()[-220:]}')
    return False


def main():
    wanted = sys.argv[1:] or PAGES
    unknown = [n for n in wanted if n not in PAGES]
    if unknown:
        sys.exit(f'Не знаю таких страниц: {", ".join(unknown)}. Есть: {", ".join(PAGES)}')

    chrome = find_chrome()
    server = serve()
    print(f'Прогон {len(wanted)} {"страницы" if len(wanted) < 5 else "страниц"}:')
    try:
        results = [run(chrome, name) for name in wanted]
    finally:
        server.shutdown()

    if all(results):
        print('Всё сошлось.')
        return 0
    print(f'Не сошлось: {results.count(False)} из {len(results)}.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
