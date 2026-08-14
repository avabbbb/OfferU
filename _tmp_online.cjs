const { chromium } = require('playwright');
const SITES = [
  { name: 'GH', url: 'https://avabbbb.github.io/OfferU/#/jobs' },
  { name: 'CF', url: 'https://offeru-showcase.pages.dev/#/jobs' },
];
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  for (const site of SITES) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4500);
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      const hasData = /星辰科技|云帆数据|林晓/.test(text);
      console.log(site.name, hasData ? 'DATA-OK' : 'EMPTY', '|', text.slice(60, 130));
      console.log(site.name, 'errors:', errors.length ? errors.slice(0, 2) : 'none');
    } catch (e) { console.log(site.name, 'NAV-ERR', String(e).slice(0, 150)); }
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error('FATAL', String(e).slice(0, 300)); process.exit(1); });
