(function (root) {
  'use strict';
  const S=root.CTLStorage,T=root.CTLTransfer;
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const slug=value=>value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'workspace';
  function download(name,body,type='application/octet-stream') {
    const url=URL.createObjectURL(new Blob([body],{type})),link=document.createElement('a');
    link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  class WorkspaceUI {
    constructor(bridge) {
      this.bridge=bridge;this.pending=new Map();this.baseline={};this.error='';this.chain=Promise.resolve();this.timer=null;this.activeKey=null;
      this.bar=document.createElement('nav');this.bar.className='workspace-bar';this.bar.setAttribute('aria-label','Workspace');
      this.bar.innerHTML='<label><span class="sr-only">Workspace</span><select id="workspace-select" aria-label="Workspace"></select></label><button data-action="new">New workspace</button><button data-action="library">Library</button><button data-action="connect">Storage</button><button data-action="import">Import</button><button data-action="export">Export</button><button data-action="sync">Sync details</button><span class="workspace-state" role="status" aria-live="polite">Opening workspace…</span>';
      document.querySelector('.topbar').after(this.bar);
      this.dialog=document.createElement('dialog');this.dialog.className='workspace-dialog';this.dialog.setAttribute('aria-labelledby','workspace-dialog-title');document.body.appendChild(this.dialog);
      this.bar.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action) this.run(()=>this.action(action));});
      this.bar.querySelector('select').addEventListener('change',event=>this.run(()=>this.select(event.target.value)));
      this.dialog.addEventListener('click',event=>{
        if(event.target.closest('[data-close]')) {this.dialog.close();return;}
        const button=event.target.closest('[data-do]');if(!button) return;
        this.run(async()=>{button.disabled=true;try{await this.handler?.(button.dataset.do,button);}finally{button.disabled=false;}});
      });
      window.addEventListener('online',()=>this.autoSync());
      window.addEventListener('offline',()=>this.status());
      window.addEventListener('beforeunload',event=>{this.bridge.flush();if(this.pending.size){event.preventDefault();event.returnValue='';}});
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') this.autoSync();});
      this.poll=setInterval(()=>this.autoSync(),60000);
    }
    async init() {
      this.db=await new S.Database().open();
      let states=await this.db.list();
      if(!states.length) {const state=S.workspace();await this.db.update(state.id,()=>state);states=[state];}
      this.engine=new S.Engine(this.db,(state,error)=>{
        if(error) {this.report(error);return;}
        if(!state) return;
        if(!this.pending.size) this.apply(state);
        this.status();
      });
      let remembered;try{remembered=localStorage.getItem('caltasklog-active-workspace-v1');}catch(_){}
      await this.select(states.some(state=>state.id===remembered)?remembered:states[0].id, true);
      return this;
    }
    async run(action) {try{await action();}catch(error){this.report(error);}}
    report(error) {this.error=error.message || String(error);this.status();const message=this.dialog.querySelector('.workspace-message');if(message) message.textContent=this.error;}
    status() {
      const state=this.engine?.state,entries=Object.values(state?.docs || {}),conflicts=entries.filter(e=>e.conflict).length,dirty=entries.filter(e=>e.dirty).length;
      let text=this.error?`Not saved or synced: ${this.error}`:this.pending.size?'Saving on this device…':conflicts?`${conflicts} conflict${conflicts===1?'':'s'} · needs review`:this.engine?.busy?'Syncing…':state?.connection?.type==='http'?'Read-only URL · cached on this device':state?.connection?.type==='webdav' ? (!navigator.onLine?`Offline · ${dirty} change${dirty===1?'':'s'} pending`:!this.engine.adapter?`Reconnect to sync · ${dirty} pending`:dirty?`Saved on this device · ${dirty} pending`:state.lastSync?`Synced · ${new Date(state.lastSync).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:'Ready to sync'):'Saved on this device';
      if(state?.catalogError && !this.error) text+=' · catalog needs repair';
      const label=this.bar.querySelector('.workspace-state');label.textContent=text;label.dataset.error=String(!!this.error || !!conflicts);
      this.bridge.status(text);
      return text;
    }
    apply(state) {
      this.baseline=Object.fromEntries(Object.entries(state.docs).map(([path,entry])=>[path,entry.body]));
      const values={plans:[],logs:{},templates:[],readOnly:state.connection?.type==='http',workspaceId:state.id,timezone:state.manifest.timezone};
      for(const [path,entry] of Object.entries(state.docs)) {
        const value=S.record(path,entry.body);if(value.deleted) continue;
        if(value.type==='plan') values.plans.push({id:value.id,name:value.name,items:value.content,lineIds:value.lineIds,readOnly:values.readOnly});
        if(value.type==='log') values.logs[value.id]=value.content;
        if(value.type==='template') values.templates.push({id:value.id,name:value.name,content:value.content});
      }
      this.bridge.apply(values);this.activeKey=state.id;
    }
    async options() {
      const states=await this.db.list();this.bar.querySelector('select').innerHTML=states.map(state=>`<option value="${esc(state.id)}" ${state.id===this.engine.state.id?'selected':''}>${esc(state.manifest.name)} · ${state.connection?.type==='webdav'?'WebDAV':state.connection?.type==='http'?'URL':'local'}</option>`).join('');
    }
    async select(key,initial=false) {
      if(!initial) await this.flush();
      clearTimeout(this.timer);this.error='';await this.engine.select(key);await this.options();
      try{localStorage.setItem('caltasklog-active-workspace-v1',key);}catch(_){}
      this.status();
    }
    save(type,values) {
      if(!this.engine?.state || this.engine.state.connection?.type==='http') return;
      const next={};
      if(type==='plan') for(const value of values) {
        const path=`plans/${value.id}.json`,previous=this.baseline[path]?S.record(path,this.baseline[path]):null;
        const item=S.document('plan',value.name,value.items,value.id);
        item.body=S.json({...JSON.parse(item.body),lineIds:T.lineIds(previous,value.items)});next[item.path]=item.body;
      }
      if(type==='template') for(const value of values) {const item=S.document(type,value.name,value.content,value.id);next[item.path]=item.body;}
      if(type==='log') for(const [date,content] of Object.entries(values)) {const item=S.document(type,date,content,date);next[item.path]=item.body;}
      for(const [path,body] of Object.entries(this.baseline)) if(S.kind(path)===type && !Object.hasOwn(next,path) && !S.record(path,body).deleted) next[path]=S.tombstone(path,body);
      for(const [path,body] of Object.entries(next)) {
        const previous=this.baseline[path] ?? null;if(body===previous) continue;
        this.pending.set(path,{path,body,expected:this.pending.get(path)?.expected ?? previous});this.baseline[path]=body;
      }
      this.status();this.drain();
    }
    drain() {
      if(this.draining || !this.pending.size) return this.chain;
      this.draining=true;
      this.chain=(async()=>{
        try {
          while(this.pending.size) {
            const batch=[...this.pending.values()];
            await this.engine.edit(batch);
            for(const change of batch) {
              const pending=this.pending.get(change.path);
              if(pending===change) this.pending.delete(change.path);
              else if(pending) pending.expected=change.body;
            }
          }
          this.error='';this.apply(this.engine.state);this.status();
          clearTimeout(this.timer);this.timer=setTimeout(()=>this.autoSync(),1500);
        } catch(error) {this.report(error);} finally {this.draining=false;}
      })();
      return this.chain;
    }
    async flush() {this.bridge.flush();await this.drain();if(this.pending.size) throw new Error('Changes have not saved on this device. Retry saving before switching or exporting.');}
    autoSync() {if(this.engine?.adapter && !this.engine.busy && !this.pending.size && navigator.onLine) this.run(async()=>{await this.flush();this.error='';await this.engine.sync();});}
    show(title,html,handler) {
      this.handler=handler;this.dialog.innerHTML=`<header><h2 id="workspace-dialog-title">${esc(title)}</h2><button type="button" data-close aria-label="Close">Close</button></header><div class="workspace-content">${html}</div><p class="workspace-message" role="alert"></p>`;
      if(!this.dialog.open) this.dialog.showModal();
    }
    async action(action) {
      await this.flush();
      if(action==='new') this.show('New workspace','<label>Name<input id="ws-name" value="My workspace" maxlength="150"></label><button class="workspace-primary" data-do="create">Create workspace</button>',async()=>{const state=S.workspace(this.dialog.querySelector('#ws-name').value.trim() || 'My workspace');await this.db.update(state.id,()=>state);await this.select(state.id);this.dialog.close();});
      if(action==='connect') this.connection();
      if(action==='library') this.library();
      if(action==='import') this.importer();
      if(action==='export') this.exporter();
      if(action==='sync') this.syncDetails();
    }
    connection() {
      const state=this.engine.state;
      this.show('Storage',`<p>Connect an existing WebDAV folder or open a published plan/catalog URL. Your storage service stays outside CalTaskLog.</p><label>Provider<select id="ws-provider"><option value="webdav">WebDAV · read and write</option><option value="http">HTTPS URL · read only</option></select></label><label>Folder URL or published file URL<input id="ws-url" type="url" placeholder="https://cloud.example.com/remote.php/dav/files/you/caltasklog/" value="${esc(state.connection?.url || '')}"></label><div class="workspace-grid" id="ws-credentials"><label>Username<input id="ws-user" autocomplete="username"></label><label>App password<input id="ws-password" type="password" autocomplete="off"></label></div><p class="workspace-notice">Credentials are kept in this tab only. The server must allow this app’s origin and expose ETag. An existing remote workspace opens separately; an empty folder receives the current workspace. Connection testing creates and removes a temporary file.</p><div class="workspace-row"><button data-do="test">Test connection</button><button class="workspace-primary" data-do="connect">Connect / open</button><button data-do="copy">Make a local copy</button>${state.connection?'<button data-do="disconnect">Disconnect</button>':''}</div><p id="ws-test" class="workspace-notice"></p>`,async action=>{
        if(action==='copy') {await this.copyWorkspace();this.dialog.close();return;}
        if(action==='disconnect') {if(this.engine.busy) throw new Error('Wait for sync to finish.');this.engine.adapter=null;await this.engine.update(s=>{s.connection=null;return s;});await this.options();this.dialog.close();return;}
        const provider=this.dialog.querySelector('#ws-provider').value,address=this.dialog.querySelector('#ws-url').value.trim();
        if(provider==='http') {
          const incoming=await S.readURL(address);
          if(action==='test') {this.dialog.querySelector('#ws-test').textContent=`Readable: ${incoming.manifest.name} · ${Object.keys(incoming.docs).length} documents`;return;}
          await this.db.update(incoming.id,()=>incoming);await this.select(incoming.id);this.dialog.close();return;
        }
        const adapter=new S.WebDAV(address,this.dialog.querySelector('#ws-user').value,this.dialog.querySelector('#ws-password').value);
        this.dialog.querySelector('#ws-test').textContent='Testing listing, writes, revision protection, and cleanup…';
        await adapter.test();
        this.dialog.querySelector('#ws-test').textContent='Connection passed: listing, writes, ETags, conditional writes, and cleanup.';
        if(action==='test') return;
        if(this.engine.busy) throw new Error('Wait for the current sync to finish.');
        const remote=await adapter.read('workspace.json');let target;
        if(remote) {
          const info=S.manifest(JSON.parse(remote.body));
          target=(await this.db.list()).find(s=>s.connection?.type==='webdav' && s.connection.url===adapter.base);
          if(target && target.manifest.id!==info.id) throw new Error('The folder now contains a different workspace. Disconnect its cached workspace before reconnecting.');
          if(!target) {target=S.workspace();target.manifest=info;}
        } else {
          if((await adapter.list()).length) throw new Error('This folder has documents but no workspace.json. Restore the manifest before connecting.');
          target=S.clone(this.engine.state);
          if(target.connection) {target.id=S.id();target.manifest.id=S.id();}
          for(const entry of Object.values(target.docs)) {entry.etag=null;entry.dirty=true;}
          await adapter.write('workspace.json',S.json(target.manifest),null);
        }
        target.connection={type:'webdav',url:adapter.base};
        await this.db.update(target.id,()=>target);await this.select(target.id);this.engine.adapter=adapter;
        this.dialog.querySelector('#ws-password').value='';await this.engine.sync();this.dialog.close();this.status();
      });
      this.dialog.querySelector('#ws-provider').addEventListener('change',event=>{this.dialog.querySelector('#ws-credentials').hidden=event.target.value==='http';});
    }
    async copyWorkspace() {
      const state=S.clone(this.engine.state);state.id=S.id();state.manifest.id=S.id();state.manifest.name+=' copy';state.connection=null;state.lastSync=null;state.catalogError='';
      for(const entry of Object.values(state.docs)) {entry.etag=null;entry.dirty=true;}
      await this.db.update(state.id,()=>state);await this.select(state.id);
    }
    library() {
      this.show('Workspace library','<div class="workspace-row"><input id="ws-search" type="search" aria-label="Search plans, notes, and templates" placeholder="Search plans, notes, and templates"><button data-do="new-plan">New plan</button><button data-do="trash">Show deleted</button></div><ul class="workspace-library" id="ws-library"></ul>',async(action,button)=>{
        const path=button.dataset.path,value=path?S.record(path,this.engine.state.docs[path].body):null;
        if(action==='new-plan') {
          const item=S.document('plan','Untitled plan',`@timezone=${this.engine.state.manifest.timezone}\n: New task`);await this.engine.edit([item]);this.bridge.open('plan',S.record(item.path,item.body).id);this.dialog.close();return;
        }
        if(action==='trash') {this.showDeleted=!this.showDeleted;button.textContent=this.showDeleted?'Hide deleted':'Show deleted';render();return;}
        if(action==='open') {this.dialog.close();this.bridge.open(value.type,value.id);return;}
        if(action==='download') {download(value.name+(value.type==='plan'?'.txt':'.md'),value.content,'text/plain;charset=utf-8');return;}
        if(action==='rename') {
          const original=this.engine.state.docs[path].body;
          this.show('Rename document',`<label>Name<input id="ws-rename" value="${esc(value.name)}" maxlength="150"></label><button data-do="save">Save name</button>`,async()=>{const name=this.dialog.querySelector('#ws-rename').value.trim();if(!name) throw new Error('Enter a name.');await this.engine.edit([{path,body:S.json({...value,name}),expected:original}]);this.library();});return;
        }
        if(action==='duplicate') {const item=S.document(value.type==='log'?'template':value.type,value.name+' copy',value.content);await this.engine.edit([item]);render();return;}
        if(action==='delete') {
          const original=this.engine.state.docs[path].body;
          this.show('Delete document',`<p>Delete ${esc(value.name)}? The deletion will sync to connected devices. Export a copy first if you need its contents.</p><button data-do="confirm">Delete document</button>`,async()=>{await this.engine.edit([{path,body:S.tombstone(path,original),expected:original}]);this.library();});return;
        }
      });
      const render=()=>{
        const query=this.dialog.querySelector('#ws-search').value.toLocaleLowerCase(),readOnly=this.engine.state.connection?.type==='http';
        this.dialog.querySelector('[data-do="new-plan"]').disabled=readOnly;
        this.dialog.querySelector('#ws-library').innerHTML=Object.entries(this.engine.state.docs).map(([path,entry])=>({path,value:S.record(path,entry.body)})).filter(({value})=>(this.showDeleted||!value.deleted) && `${value.name}\n${value.content}`.toLocaleLowerCase().includes(query)).map(({path,value})=>`<li><div class="workspace-entry"><strong>${esc(value.name)}</strong><small>${value.type}${value.deleted?' · deleted':''}</small></div>${value.deleted?'':`<button data-do="open" data-path="${esc(path)}">Open</button><button data-do="download" data-path="${esc(path)}">Export</button>${readOnly?'':`${value.type!=='log'?`<button data-do="rename" data-path="${esc(path)}">Rename</button>`:''}<button data-do="duplicate" data-path="${esc(path)}">Duplicate</button><button data-do="delete" data-path="${esc(path)}">Delete</button>`}`}</li>`).join('') || '<li>No matching documents.</li>';
      };
      this.dialog.querySelector('#ws-search').addEventListener('input',render);render();
    }
    syncDetails() {
      const state=this.engine.state;
      this.show('Sync details',`<p>${esc(this.status())}</p><p class="workspace-notice">${esc(state.connection?.url || 'Local workspace — connect storage to sync across devices.')}${state.lastSync?'\nLast completed check: '+esc(new Date(state.lastSync).toLocaleString()):''}${state.catalogError?'\n'+esc(state.catalogError):''}</p><div class="workspace-row"><button data-do="retry">Retry / refresh</button><button data-do="connect">Connection settings</button></div><ul class="workspace-library">${Object.entries(state.docs).filter(([,entry])=>entry.dirty||entry.conflict).map(([path,entry])=>`<li><div class="workspace-entry"><strong>${esc(S.record(path,entry.body).name)}</strong><small>${entry.conflict?'Conflict · '+esc(entry.conflict.source):'Pending upload'}</small></div>${entry.conflict?`<button data-do="review" data-path="${esc(path)}">Review versions</button>`:''}</li>`).join('') || '<li>No pending changes.</li>'}</ul>`,async(action,button)=>{
        if(action==='connect') {this.connection();return;}
        if(action==='review') {this.review(button.dataset.path);return;}
        this.error='';await this.flush();
        if(state.connection?.type==='http') {
          const incoming=await S.readURL(state.connection.url);incoming.id=state.id;
          await this.engine.update(()=>incoming);
        } else if(state.connection?.type==='webdav') await this.engine.sync();
        else await this.engine.refresh();
        this.syncDetails();
      });
    }
    review(path) {
      const entry=this.engine.state.docs[path],other=entry.conflict,value=S.record(path,entry.body);
      const reviewed=JSON.stringify([entry.body,other]);
      this.show('Review versions',`<p>${esc(value.name)} · ${other.source==='device'?'another tab changed this document':'remote file changed'}. Keep both saves an extra copy; for a daily note, that copy appears in Templates.</p><div class="workspace-grid"><label>Your version<textarea id="ws-merged" spellcheck="false">${esc(entry.body)}</textarea></label><label>Other version<textarea readonly>${esc(other.body ?? '(deleted)')}</textarea></label></div><p class="workspace-notice">Plans and templates show their complete JSON record. Edit the left side for a manual merge; its format is validated before saving.</p><div class="workspace-row"><button data-do="local">Use yours</button><button data-do="remote">Use other</button><button data-do="both">Keep both</button><button data-do="merge">Save edited version</button></div>`,async action=>{await this.engine.resolve(path,action,this.dialog.querySelector('#ws-merged').value,reviewed);this.syncDetails();});
    }
    importer() {
      if(this.engine.state.connection?.type==='http') throw new Error('Make a local copy of this published workspace before importing.');
      let staged=null,files=[];
      this.show('Import data',`<p>Preview before importing. Text becomes a plan; Markdown becomes a daily note or template. Native ZIP backups preserve the complete workspace.</p><label>Files<input id="ws-files" type="file" multiple accept=".txt,.md,.csv,.ics,.zip"></label><div class="workspace-grid"><label>Markdown destination<select id="ws-md-kind"><option value="log">Daily log</option><option value="template">Template</option></select></label><label>Date when the Markdown filename has no YYYY-MM-DD<input id="ws-md-date" type="date" value="${T.dateKey(new Date())}"></label></div><div id="ws-csv-map"></div><label>Import behavior<select id="ws-import-mode"><option value="new">Import as new (ZIP opens a new workspace)</option><option value="merge">Merge by ID/date; keep conflicts for review</option><option value="replace">Replace matching ID/date after downloading a backup</option></select></label><div class="workspace-row"><button data-do="preview">Preview import</button><button class="workspace-primary" data-do="apply" disabled>Apply import</button></div><pre id="ws-import-preview" class="workspace-preview">Choose files to begin.</pre>`,async action=>{
        if(action==='preview') {
          staged=await this.stageFiles(files);const mode=this.dialog.querySelector('#ws-import-mode').value;
          if(staged.workspace && files.length!==1) throw new Error('Import a workspace ZIP on its own.');
          const changes=staged.workspace?Object.entries(staged.workspace.docs).map(([path,e])=>({path,body:e.body})):staged.documents;
          const counts={create:0,unchanged:0,conflict:0};
          for(const item of changes) {const previous=this.engine.state.docs[item.path];if(!previous) counts.create++;else if(previous.body===item.body) counts.unchanged++;else counts.conflict++;}
          this.dialog.querySelector('#ws-import-preview').textContent=`${changes.length} documents ready.\n${staged.workspace && mode==='new'?'A new local workspace will open.':`${counts.create} new · ${counts.unchanged} identical · ${counts.conflict} matching IDs/dates to review`}\n\n${staged.warnings.join('\n')}\n\n${changes.map(item=>`${item.path}\n${S.record(item.path,item.body).content.slice(0,1200)}`).join('\n\n')}`;
          this.dialog.querySelector('[data-do="apply"]').disabled=!changes.length;
          return;
        }
        if(!staged) throw new Error('Preview the import first.');
        const mode=this.dialog.querySelector('#ws-import-mode').value;
        if(mode==='replace') download(`${slug(this.engine.state.manifest.name)}-before-import.zip`,await T.backup(this.engine.state),'application/zip');
        if(staged.workspace && mode==='new') {
          const state=staged.workspace;state.id=S.id();state.manifest.id=S.id();state.manifest.name+=' (imported)';
          await this.db.update(state.id,()=>state);await this.select(state.id);this.dialog.close();return;
        }
        const items=staged.workspace?Object.entries(staged.workspace.docs).map(([path,e])=>({path,body:e.body,conflict:e.conflict})):staged.documents;
        await this.engine.update(state=>{
          for(let item of items) {
            const value=S.record(item.path,item.body);
            if(mode==='new' && value.type!=='log') item=S.document(value.type,value.name,value.content);
            const existing=state.docs[item.path];
            if(existing?.body===item.body) continue;
            if(existing && mode!=='replace' && !S.record(item.path,existing.body).deleted) {
              state.docs[item.path]={...existing,body:item.body,dirty:true,conflict:{body:existing.body,etag:existing.etag,source:'device'}};
            } else state.docs[item.path]={body:item.body,etag:existing?.etag ?? null,dirty:true,...(item.conflict?{conflict:item.conflict}:{})};
          }
          return state;
        });
        this.dialog.close();this.autoSync();
      });
      const invalidate=()=>{staged=null;this.dialog.querySelector('[data-do="apply"]').disabled=true;};
      this.dialog.querySelector('#ws-files').addEventListener('change',async event=>{
        invalidate();files=[...event.target.files];
        const csv=files.filter(file=>/\.csv$/i.test(file.name));
        this.dialog.querySelector('#ws-csv-map').innerHTML='';
        if(csv.length===1) this.run(async()=>{
          const rows=T.parseCSV(await csv[0].text());
          this.dialog.querySelector('#ws-csv-map').innerHTML='<h3>CSV columns</h3><div class="workspace-grid">'+T.CSV_FIELDS.map(key=>`<label>${key}<select data-csv="${key}"><option value="">Ignore</option>${rows[0].map((heading,i)=>`<option value="${i}" ${heading.toLowerCase()===key.toLowerCase()?'selected':''}>${esc(heading)}</option>`).join('')}</select></label>`).join('')+'</div>';
        });
      });
      this.dialog.querySelector('.workspace-content').addEventListener('change',invalidate);
    }
    async stageFiles(files) {
      if(!files.length) throw new Error('Choose at least one file.');
      if(files.length>1000 || files.reduce((sum,f)=>sum+f.size,0)>T.MAX_ARCHIVE) throw new Error('Import is too large (64 MiB maximum).');
      if(files.filter(f=>/\.csv$/i.test(f.name)).length>1) throw new Error('Import one CSV at a time to map its columns.');
      const result={documents:[],warnings:[]};
      for(const file of files) {
        if(file.size>(/\.zip$/i.test(file.name)?T.MAX_ARCHIVE:S.LIMIT)) throw new Error(`${file.name} exceeds the file size limit.`);
        if(/\.zip$/i.test(file.name)) {result.workspace=await T.restore(await file.arrayBuffer());continue;}
        const text=await file.text(),name=file.name.replace(/\.[^.]+$/,'');let item;
        if(/\.txt$/i.test(file.name)) item=S.document('plan',name,text);
        else if(/\.md$/i.test(file.name)) {
          const type=this.dialog.querySelector('#ws-md-kind').value,date=name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || this.dialog.querySelector('#ws-md-date').value;
          if(type==='log' && !S.validDate(date)) throw new Error(`Choose a valid date for ${file.name}.`);
          item=S.document(type,name,text,type==='log'?date:undefined);
        } else if(/\.(csv|ics)$/i.test(file.name)) {
          const converted=/\.csv$/i.test(file.name)?T.csvImport(T.parseCSV(text),Object.fromEntries([...this.dialog.querySelectorAll('[data-csv]')].map(select=>[select.dataset.csv,select.value]))):T.icsImport(text,this.engine.state.manifest.timezone);
          result.warnings.push(...converted.warnings.map(w=>`${file.name}: ${w}`));
          if(!converted.count) {result.warnings.push(`${file.name}: no supported items to import.`);continue;}
          item=S.document('plan',name,converted.text);
        } else throw new Error(`Unsupported file: ${file.name}`);
        if(S.kind(item.path)==='plan') {
          const value=S.record(item.path,item.body),parsed=this.bridge.parse(value.content);
          result.warnings.push(...parsed.errors.map(w=>`${file.name}: ${w}`),...parsed.warnings.map(w=>`${file.name}: ${w}`));
          item.body=S.json({...value,lineIds:T.lineIds(null,value.content)});
        }
        if(result.documents.some(doc=>doc.path===item.path)) throw new Error(`Two files target ${item.path}. Import them separately to review the overlap.`);
        result.documents.push(item);
      }
      return result;
    }
    exporter() {
      this.show('Export data',`<p>Workspace ZIP is the lossless backup, including deleted records and unresolved versions. Credentials and device preferences are excluded.</p><div class="workspace-row"><button class="workspace-primary" data-do="backup">Download workspace ZIP</button><button data-do="catalog">Download published catalog</button></div><h3>Current plan</h3><p class="workspace-notice">CSV is a task report. iCalendar exports dated leaf items in the selected schedules, with repeating items expanded within the app’s parsed range. It is a calendar snapshot, not a subscription.</p><div class="workspace-row"><button data-do="txt">Plan text</button><button data-do="csv">Task CSV</button><button data-do="ics">Calendar ICS</button></div><h3>Meeting notes and templates</h3><p class="workspace-notice">Use Library to export an individual note or template. Today’s summary composer exports selected days as Markdown.</p><button data-do="markdown">Download all Markdown as ZIP</button><pre id="ws-export-report" class="workspace-preview">Choose an export format.</pre>`,async action=>{
        await this.flush();const state=this.engine.state;
        if(action==='backup') {download(`${slug(state.manifest.name)}.zip`,await T.backup(state),'application/zip');return;}
        if(action==='catalog') {download('index.json',S.json(S.catalog(state)),'application/json');this.dialog.querySelector('#ws-export-report').textContent='Publish index.json beside workspace.json and the plans/, logs/, and templates/ folders from your workspace backup. Your HTTPS host must allow browser reads.';return;}
        if(action==='markdown') {const files={};for(const [path,e] of Object.entries(state.docs)){const v=S.record(path,e.body);if(!v.deleted && v.type!=='plan') files[v.type==='log'?path:`templates/${v.id}-${slug(v.name)}.md`]=v.content;}download('meeting-markdown.zip',T.zip(files),'application/zip');return;}
        const current=this.bridge.current();
        if(action==='txt') {download(slug(current.plan.name)+'.txt',current.plan.items,'text/plain;charset=utf-8');return;}
        if(current.parsed.errors.length) throw new Error('Fix the plan errors before exporting derived tasks or calendar entries.');
        if(action==='csv') {download(slug(current.plan.name)+'.csv',T.csvExport(current.parsed.tasks),'text/csv;charset=utf-8');this.dialog.querySelector('#ws-export-report').textContent='CSV exported. Dates and recurring occurrences are resolved; source comments and recurrence rules are not retained.';return;}
        const result=T.icsExport(current.parsed.tasks,current.plan,current.parsed.timezone);
        download(slug(current.plan.name)+'.ics',result.text,'text/calendar;charset=utf-8');this.dialog.querySelector('#ws-export-report').textContent=`${result.count} calendar entries exported.\n${result.warnings.join('\n')}`;
      });
    }
  }
  root.CTLWorkspace={mount:async bridge=>{const client=new WorkspaceUI(bridge);await client.init();return client;},download};
})(globalThis);
