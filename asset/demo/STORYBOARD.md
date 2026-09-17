# OfferU Demo Capture — Storyboard & Script

## Goal

A 6–8 second looping GIF that shows the core product surfaces in a real demo
workspace. Every frame is captured from the live UI in **Showcase mode**
(`VITE_SHOWCASE=true`), which serves fictional data from IndexedDB — no real
user data, credentials, or production backend required.

## Capture Environment

- Frontend: `vite dev` on `http://127.0.0.1:7412` (separate port from dev 7410)
- Mode: `VITE_SHOWCASE=true` — all API calls route to `src/lib/showcase/router.ts`
- Browser: managed Chromium, `headless: true`, viewport 1280×720
- Frames: Playwright `page.screenshot()` → ffmpeg palette → GIF

## Shot Sequence

| # | Surface | URL | Wait | Notes |
|---|---------|-----|------|-------|
| 1 | Today / Workbench | `#/` | 3s | Inbox items, quick-start checklist, pipeline preview |
| 2 | Pipeline board | `#/applications?view=board` | 2.5s | Stage columns, application cards |
| 3 | Jobs list | `#/jobs` | 2.5s | Job cards, filters, pools |
| 4 | Job detail | `#/jobs/1` | 2.5s | Role intelligence, evidence gaps, preparation |
| 5 | Profile | `#/profile` | 2.5s | Career evidence, sections, goals |
| 6 | Settings | `#/settings` | 2.5s | Agent connection, data sources, privacy |

## Re-capture

```powershell
# 1. Start showcase frontend
$env:VITE_SHOWCASE = "true"
cd frontend
npx vite --port 7412 --strictPort

# 2. Run capture script (from repo root)
node asset/demo/capture.mjs

# 3. Convert frames to GIF
ffmpeg -framerate 1 -i H:/tmp/offeru/demo-video/real-%02d.png `
  -vf "scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse" `
  -loop 0 -y asset/demo/offeru-demo.gif
```

## Sanitization

- Showcase seeds are fictional companies （星辰科技， 云帆数据， 极光互动， etc.)
- No real names, phone numbers, emails, or resumes
- No external network calls — all data stays in IndexedDB
- `offeru-demo.gif` is ~1 MB at 1280×720, 1 fps, 6 frames
