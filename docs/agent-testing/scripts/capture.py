import os, sys, time
from playwright.sync_api import sync_playwright

HOST = '127.0.0.1'
PORT = 8766
BASE = 'http' + ':' + '//' + HOST + ':' + str(PORT)
PAIR = sys.argv[1]
OUT = 'H:/tmp/offeru/agent-test/media'
os.makedirs(OUT, exist_ok=True)
ROUTES = [('01-today', '/'), ('02-jobs', '/jobs'), ('03-job-detail', '/jobs/9'), ('04-profile', '/profile'), ('05-resume', '/resume/14'), ('06-interview', '/interview'), ('07-settings', '/settings')]

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN', record_video_dir=OUT + '/video', record_video_size={'width': 1440, 'height': 900})
    pg = ctx.new_page()
    pg.goto(BASE + '/#/pair/' + PAIR, wait_until='networkidle')
    time.sleep(2)
    print('after pair', pg.url)
    for name, r in ROUTES:
        t = time.time()
        pg.goto(BASE + '/#' + r, wait_until='networkidle')
        time.sleep(1.5)
        pg.screenshot(path=f'{OUT}/{name}.png')
        body = pg.inner_text('body')
        print(name, round(time.time() - t, 1), 's', 'chars', len(body), 'first', body[:60].replace(chr(10), ' | '))
    pg.goto(BASE + '/#/', wait_until='networkidle')
    time.sleep(1)
    pg.keyboard.press('Control+K')
    time.sleep(1.2)
    pg.screenshot(path=f'{OUT}/08-ctrl-k.png')
    try:
        pg.keyboard.type('把星河科技改成已投递', delay=60)
        time.sleep(1)
        pg.screenshot(path=f'{OUT}/09-ctrl-k-typed.png')
    except Exception as e:
        print('typing failed', e)
    time.sleep(1)
    ctx.close()
    b.close()
print('videos', os.listdir(OUT + '/video'))
