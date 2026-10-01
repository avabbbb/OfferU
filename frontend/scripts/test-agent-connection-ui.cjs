const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.env.OFFERU_UI_EVIDENCE_DIR || 'H:/tmp/offeru/agent-contract-ui');
const allowed = path.resolve('H:/tmp/offeru');
if (!ROOT.startsWith(allowed + path.sep)) throw new Error('UI evidence must stay under H:/tmp/offeru');
fs.mkdirSync(ROOT, {recursive:true});
const URL = 'http://127.0.0.1:7410';
const host = {id:'codex',name:'Codex',installed:true,compatible:true,can_install_skill:true,skill_status:'NOT_INSTALLED',connection_verified:false,status:'integration_missing',last_error:''};
(async () => {
  const ready = await fetch(URL, {signal:AbortSignal.timeout(3000)});
  if (!ready.ok) throw new Error('Frontend is not ready');
  const browser = await chromium.launch({headless:true});
  const results = [];
  try {
    for (const desktop of [false,true]) {
      const context = await browser.newContext({viewport:{width:1365,height:1000}});
      await context.addInitScript(({desktop}) => {globalThis.isTauri=desktop; localStorage.setItem('offeru_onboarding',JSON.stringify({wizardCompleted:true,wizardSkipped:false,wizardStep:3}));}, {desktop});
      let installs=0, scans=0, version=0;
      await context.route('**/api/**', async route => {
        const req=route.request(); const path=new globalThis.URL(req.url()).pathname;
        let value={};
        if (path==='/api/health') value={status:'ok',service:'OfferU',runtime:'python',version:'0.4.0'};
        else if (path.endsWith('/context')) {const body=req.postDataJSON() || {};value={ok:true,outputs:{...body,version:++version}};}
        else if (path.endsWith('/runtime/connections')) {scans++;value={items:[host],recommended_provider_id:'codex'};}
        else if (path.includes('/runtime/connections/codex/')) {installs++;value={items:[{...host,skill_status:'INSTALLED',connection_verified:true,status:'ready'}],recommended_provider_id:'codex'};}
        else if (path.includes('/calendar')) value=[];
        else if (path.includes('/notifications')) value=[];
        else if (path.includes('/pools') || path.includes('/batches')) value=[];
        else if (path==='/api/tasks' || path==='/api/tasks/' || path.includes('/job-search/tasks') || path==='/api/scraper/tasks') value=[];
        else if (path.includes('/profile')) value={sections:[],facts:[],evidence:[]};
        else if (path.includes('/jobs')) value={items:[],total:0,page:1,page_size:20};
        else value={items:[],tasks:[],proposals:[],deliveries:[],conversations:[],connected:false};
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
      });
      const page=await context.newPage();
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(URL+'/#/jobs',{waitUntil:'domcontentloaded'});
      await page.waitForTimeout(2000);
      fs.writeFileSync(ROOT+'/ui-mounted-diagnostic.json',JSON.stringify({errors,text:await page.locator('body').innerText()},null,2));
      await page.screenshot({path:ROOT+'/ui-mounted-diagnostic.png'});
      if (errors.length) throw new Error(errors.join('; '));
      await page.getByTestId('agent-connection-status').first().click({timeout:20000});
      await expect(page.getByRole('heading',{name:'把 OfferU 交给你正在使用的 Agent。'})).toBeVisible();
      await expect(page.getByRole('button',{name:'复制接入提示词'})).toHaveCount(0);
      if (desktop) {
        await page.getByRole('button',{name:'发现本机 Agent'}).click();
        await expect(page.getByText('已发现 Agent，接入尚未完成。')).toBeVisible();
        await page.screenshot({path:ROOT+'/desktop-discovered.png'});
        await page.getByRole('button',{name:'连接 Codex',exact:true}).click();
        await expect(page.getByText('已验证连接：Agent 已完成真实工具读取。')).toBeVisible();
        await page.screenshot({path:ROOT+'/desktop-verified-fixture.png'});
        if (installs!==1 || scans!==1) throw new Error('Unexpected adapter calls');
      } else {
        await expect(page.getByText(/当前网页不会扫描本机/)).toBeVisible();
        await expect(page.getByRole('button',{name:'发现本机 Agent'})).toHaveCount(0);
        if (scans || installs) throw new Error('Browser invoked local adapter');
        await page.screenshot({path:ROOT+'/browser-contract.png'});
      }
      results.push({surface:desktop?'AUTOMATED_DESKTOP_PREVIEW_FIXTURE':'ISOLATED_BROWSER_UI',passed:true,scans,installs,native_desktop:false,real_connection:false});
      await context.close();
    }
    fs.writeFileSync(ROOT+'/ui-contract-result.json',JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
