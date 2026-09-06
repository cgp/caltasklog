/* Run with CTL_PLAYWRIGHT_MODULE pointing at Playwright, or install it locally. */
const {chromium}=require(process.env.CTL_PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const files=new Map(),folders=new Set(['/dav/','/dav/plans/','/dav/logs/','/dav/templates/']);let revision=0;
const escape=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
async function handler(req,res){
  const name=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin || '*');res.setHeader('Access-Control-Allow-Methods','GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Depth, If-Match, If-None-Match');res.setHeader('Access-Control-Expose-Headers','ETag');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(name.startsWith('/dav/') || name.startsWith('/published/')){
    const target=name.replace(/^\/published\//,'/dav/');
    if(req.method==='PROPFIND'){
      if(!folders.has(target)){res.writeHead(404);res.end();return;}
      const children=[...folders,...files.keys()].filter(p=>p===target || (p.startsWith(target) && !p.slice(target.length).replace(/\/$/,'').includes('/')));
      res.setHeader('Content-Type','application/xml');res.writeHead(207);res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${children.map(p=>`<d:response><d:href>${escape(p)}</d:href><d:propstat><d:prop><d:resourcetype>${folders.has(p)?'<d:collection/>':''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`);return;
    }
    if(req.method==='MKCOL'){const existed=folders.has(target);folders.add(target);res.writeHead(existed?405:201);res.end();return;}
    const prior=files.get(target);
    if(req.method==='PUT' || req.method==='DELETE'){
      if((req.headers['if-none-match']==='*' && prior) || (req.headers['if-match'] && req.headers['if-match']!==prior?.etag)){res.writeHead(412);res.end();return;}
      if(req.method==='DELETE'){files.delete(target);res.writeHead(204);res.end();return;}
      const chunks=[];for await(const part of req) chunks.push(part);
      const value={body:Buffer.concat(chunks).toString('utf8'),etag:`"r${++revision}"`};files.set(target,value);res.setHeader('ETag',value.etag);res.writeHead(201);res.end();return;
    }
    if(!prior){res.writeHead(404);res.end();return;}
    res.setHeader('ETag',prior.etag);res.setHeader('Content-Type',target.endsWith('.json')?'application/json':'text/plain');res.end(prior.body);return;
  }
  const relative=name==='/'?'index.html':name.slice(1);
  if(!['index.html','storage.js','transfer.js','workspace-ui.js','workspace.css','favicon.svg'].includes(relative)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(path.join(root,relative)));
}
async function server(){const instance=http.createServer((req,res)=>handler(req,res).catch(error=>{res.writeHead(500);res.end(error.message);}));await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));return instance;}
async function main(){
  const app=await server(),dav=await server(),base=`http://127.0.0.1:${app.address().port}`,remote=`http://127.0.0.1:${dav.address().port}`;
  const browser=await chromium.launch({channel:process.env.CTL_BROWSER_CHANNEL || 'chrome',headless:true});
  const errors=[];let lastPage;
  try{
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();lastPage=page;
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByRole('button',{name:'Save as',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#save-plan').disabled);
    await page.getByRole('button',{name:'Library',exact:true}).click();await page.getByRole('button',{name:'New plan',exact:true}).click();
    await page.locator('#items').fill('@timezone=America/New_York\n! Project 2026\nSep 5-6: Ship storage (Chris) [Active] ^P1\n: Undated item');
    await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent==='Saved on this device');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#items').value.includes('Ship storage'));
    assert.match(await page.locator('#items').inputValue(),/Undated item/);
    await page.getByRole('tab',{name:'Today',exact:true}).click();await page.locator('#log-editor').fill('# Notes\n\n- [ ] Verify sync 🦾');
    await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent==='Saved on this device');
    // Two real tabs write different documents through shared IndexedDB transactions.
    const second=await context.newPage();second.on('pageerror',error=>errors.push(error.message));await second.goto(base);
    await second.waitForFunction(()=>!document.querySelector('#save-plan').disabled);
    await second.getByRole('tab',{name:'Today',exact:true}).click();await page.getByRole('tab',{name:'Edit',exact:true}).click();
    await Promise.all([page.locator('#items').fill((await page.locator('#items').inputValue())+'\n: Edited in first tab'),second.locator('#log-editor').fill('# Notes\n\n- [ ] Updated in second tab')]);
    await second.waitForFunction(()=>document.querySelector('.workspace-state').textContent==='Saved on this device');
    await page.waitForFunction(()=>document.querySelector('#log-editor').value.includes('second tab'));
    await page.reload();await page.waitForFunction(()=>document.querySelector('#items').value.includes('Edited in first tab'));
    await second.close();
    await page.getByRole('button',{name:'Export',exact:true}).first().click();
    const [backup]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download workspace ZIP'}).click()]);
    const bytes=await fs.readFile(await backup.path());assert.ok(bytes.length>200);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Import',exact:true}).click();
    await page.locator('#ws-files').setInputFiles({name:'backup.zip',mimeType:'application/zip',buffer:bytes});
    await page.getByRole('button',{name:'Preview import'}).click();await page.getByRole('button',{name:'Apply import'}).click();
    await page.waitForFunction(()=>document.querySelector('#workspace-select').selectedOptions[0].textContent.includes('imported'));
    await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('#ws-search').fill('Ship storage');
    await page.getByRole('button',{name:'Open',exact:true}).click();assert.match(await page.locator('#items').inputValue(),/Ship storage/);
    await page.getByRole('button',{name:'Storage',exact:true}).click();await page.locator('#ws-url').fill(remote+'/dav/');
    await page.getByRole('button',{name:'Connect / open',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent.startsWith('Synced'));
    assert.ok(files.has('/dav/workspace.json'));assert.ok(files.has('/dav/index.json'));assert.ok([...files.keys()].some(p=>p.startsWith('/dav/logs/')));
    assert.ok(![...files.keys()].some(p=>p.includes('connection-test')));
    const planPath=[...files.keys()].find(p=>p.startsWith('/dav/plans/'));
    const original=JSON.parse(files.get(planPath).body);
    files.set(planPath,{body:JSON.stringify({...original,content:original.content+'\n: Remote edit'}),etag:`"r${++revision}"`});
    await page.locator('#items').fill((await page.locator('#items').inputValue())+'\n: Local edit');
    await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent.includes('conflict'),{timeout:15000});
    await page.getByRole('button',{name:'Sync details',exact:true}).click();await page.getByRole('button',{name:'Review versions'}).click();
    assert.match(await page.locator('#ws-merged').inputValue(),/Local edit/);assert.match(await page.locator('textarea[readonly]').last().inputValue(),/Remote edit/);
    await page.getByRole('button',{name:'Keep both',exact:true}).click();await page.getByRole('button',{name:'Retry / refresh'}).click();
    await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent.startsWith('Synced'));
    assert.equal([...files.keys()].filter(p=>p.startsWith('/dav/plans/')).length,2);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    // Read-only catalogs use the same portable files, on a second origin.
    await page.getByRole('button',{name:'Storage',exact:true}).click();await page.locator('#ws-provider').selectOption('http');await page.locator('#ws-url').fill(remote+'/published/index.json');
    await page.getByRole('button',{name:'Connect / open',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.workspace-state').textContent.startsWith('Read-only URL'));
    await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('#ws-search').fill('Remote edit');await page.getByRole('button',{name:'Open',exact:true}).click();
    assert.equal(await page.locator('#items').getAttribute('readonly'),'');assert.equal(await page.locator('#save-plan').isDisabled(),true);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'tests','workspace-mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Sync details',exact:true}).click();await page.screenshot({path:path.join(root,'tests','workspace-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'Connection settings'}).click();await page.getByRole('button',{name:'Make a local copy'}).click();
    await page.getByRole('button',{name:'Import',exact:true}).click();
    await page.locator('#ws-files').setInputFiles({name:'mapped.csv',mimeType:'text/csv',buffer:Buffer.from('name,start,end,priority\nCSV task,2026-09-05,2026-09-06,P2\nBad date,2026-02-30,,P0\n')});
    await page.locator('[data-csv="name"]').waitFor();await page.getByRole('button',{name:'Preview import'}).click();
    await page.locator('[data-do="apply"]:enabled').waitFor();
    assert.match(await page.locator('#ws-import-preview').textContent(),/Row 3 skipped/);
    await page.getByRole('button',{name:'Apply import'}).click();await page.waitForFunction(()=>!document.querySelector('.workspace-dialog').open);
    await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('#ws-search').fill('CSV task');await page.getByRole('button',{name:'Open',exact:true}).click();
    assert.match(await page.locator('#items').inputValue(),/Sep 5 2026 - Sep 6 2026: CSV task \^P2/);
    await page.getByRole('button',{name:'Export',exact:true}).first().click();
    const [calendar]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Calendar ICS'}).click()]);
    assert.match(await fs.readFile(await calendar.path(),'utf8'),/DTEND;VALUE=DATE:20260907/);
    await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Import',exact:true}).click();
    await page.locator('#ws-files').setInputFiles({name:'events.ics',mimeType:'text/calendar',buffer:Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260907\r\nDTEND;VALUE=DATE:20260909\r\nSUMMARY:Calendar import\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')});
    await page.getByRole('button',{name:'Preview import'}).click();await page.locator('[data-do="apply"]:enabled').waitFor();assert.match(await page.locator('#ws-import-preview').textContent(),/%Sep 7 2026 - Sep 8 2026: Calendar import/);
    await page.getByRole('button',{name:'Apply import'}).click();await page.waitForFunction(()=>!document.querySelector('.workspace-dialog').open);
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: persistence, concurrent tabs, Markdown, ZIP restore, cross-origin WebDAV, conflicts, URL catalog, read-only controls, mobile layout, CSV mapping, and ICS interchange.');
  }catch(error){
    if(lastPage) console.error('Browser state:',await lastPage.locator('.workspace-state').textContent(),await lastPage.locator('.workspace-message').allTextContents(),'Page errors:',errors);
    throw error;
  }finally{await browser.close();await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>dav.close(resolve))]);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
