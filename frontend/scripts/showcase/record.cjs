// 录展示站快照：用真前端连真后端逐页打开，把页面发出的每个 GET /api/ 的 JSON 响应原样存下来。
// 展示站（VITE_SHOWCASE=true）回放这些响应，数据和真实应用一致，接口改了重录一遍就同步。
// 用法（frontend 目录下）：node scripts/showcase/record.cjs [前端地址] [输出文件]
const { chromium } = require('playwright');
const fs = require('fs');
const FRONT = process.argv[2] || 'http://127.0.0.1:7410';
const OUT = process.argv[3] || 'src/lib/showcase/snapshot.json';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('offeru_onboarding', JSON.stringify({ wizardCompleted: true, wizardSkipped: false, wizardStep: 3 })));
  page.setDefaultTimeout(120000); // 第一次打开 vite 开发服务器要预构建依赖，比较慢
  const snapshot = {};
  page.on('response', async (res) => {
    const url = new URL(res.url());
    if (res.request().method() !== 'GET' || !url.pathname.startsWith('/api/') || !res.ok()) return;
    if (!(res.headers()['content-type'] || '').includes('application/json')) return;
    try { snapshot[url.pathname + url.search] = await res.json(); } catch { /* 页面跳走时响应体可能已丢弃 */ }
  });
  const api = async (path) => (await fetch(new URL(path, process.env.API || 'http://127.0.0.1:8766'))).json();
  const jobs = (await api('/api/jobs/?page_size=100')).items || [];
  const resumes = await api('/api/resume/');
  const routes = ['', 'jobs', 'resume', 'applications', 'interview', 'calendar', 'email', 'profile', 'settings',
    ...jobs.map((job) => `jobs/${job.id}`), ...resumes.map((resume) => `resume/${resume.id}`)];
  for (const route of routes) {
    await page.goto(`${FRONT}/#/${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
  }
  // 展示站是公开的：本机数据目录换成占位，录到的配置只来自默认配置（refresh.sh 不接模型）。
  const scrub = process.env.SCRUB;
  const text = JSON.stringify(snapshot, null, 0);
  fs.writeFileSync(OUT, scrub ? text.split(scrub).join('（展示版）') : text);
  console.log(`录了 ${Object.keys(snapshot).length} 个响应，${(fs.statSync(OUT).size / 1024).toFixed(0)} KB → ${OUT}`);
  await browser.close();
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
