# OfferU README screenshots & demo GIF

Everything under `asset/screenshots/` and `asset/demo/offeru-demo.gif` is captured from the
web app (https://offeru.avabbbb.com/) with a **fictional** workspace seeded from
`demo-seed.json`: made-up companies (星辰科技, 云帆数据, 极光互动, 青禾智能, 蓝鲸云, 晨曦游戏,
远山科技), a made-up candidate (林沐, `138-0000-0000`, `linmu@example.com`) and example.com links.
No account, API key or model call is involved, so no AI output appears in the shots
(the job's structured posting, score and reasons are part of the seed).

## Shots (1440×900 @2x, pngquant, each < 500 KB)

| File | Surface | Route |
|---|---|---|
| `01-today-workbench.png` | Today: next step + pipeline board | `#/` |
| `02-pipeline-board.png` | Jobs · board view | `#/jobs` → 看板 |
| `03-jobs-list.png` | Jobs · table view | `#/jobs` → 表格 |
| `04-job-detail.png` | Job detail: posting breakdown, requirements, events | `#/jobs/2` |
| `05-profile.png` | Career profile (evidence the résumé draws from) | `#/resume` → 档案 |
| `06-calendar.png` | Jobs · calendar view (interviews, tests, deadlines) | `#/jobs` → 日历 |
| `07-settings.png` | Settings · model service (no key configured) | `#/settings` → 模型服务 |
| `08-resume-optimize.png` | Résumé editor with live preview and tailor-to-job bar | `#/resume` |
| `09-agent-connect.png` | Settings · connect your own Agent | `#/settings` → 我的 Agent |

## Re-capture

```bash
npm i -D playwright && npx playwright install chromium
node asset/demo/capture.mjs                 # writes asset/screenshots/*.png
for f in asset/screenshots/*.png; do pngquant --quality=70-92 --force --output "$f" "$f"; done
```

## GIF

`offeru-demo.gif` is 1280×800, ~18 s loop: Today → Job detail → Résumé → Board → Calendar →
Profile → Agent, 2.4 s per screen with a short cross-fade, 128-colour palette (~4.4 MB).
Frames are the screenshots above downscaled; build with ffmpeg `concat` + `palettegen`/`paletteuse`.
