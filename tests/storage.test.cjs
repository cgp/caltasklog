const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../storage.js');
const T=require('../transfer.js');

class MemoryDB {
  constructor(state){this.state=structuredClone(state);}
  async get(){return structuredClone(this.state);}
  async update(key,change){this.state=change(structuredClone(this.state));return structuredClone(this.state);}
}
class Remote {
  constructor(state){this.base='https://example.test/dav/';this.files=new Map([['workspace.json',{body:S.json(state.manifest),etag:'"manifest"'}]]);this.counter=0;}
  async list(){return [...this.files.keys()].filter(path=>/^(plans|logs|templates)\//.test(path));}
  async read(path){return structuredClone(this.files.get(path)||null);}
  async write(path,body,etag){
    if((this.files.get(path)?.etag??null)!==etag) throw new S.HTTPError(412,path);
    const saved={body,etag:`"${++this.counter}"`};this.files.set(path,saved);return structuredClone(saved);
  }
}
Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:async(name,fn)=>fn()}});
async function setup(t){const state=S.workspace();state.connection={type:'webdav',url:'https://example.test/dav/'};const db=new MemoryDB(state),engine=new S.Engine(db);t.after(()=>engine.channel?.close());await engine.select(state.id);const remote=new Remote(state);engine.adapter=remote;return {engine,db,remote};}

test('backup restores exact text, deleted documents, and conflict alternatives without credentials',async()=>{
  const state=S.workspace('Robotics 🦾');state.connection={type:'webdav',url:'https://private.test/'};
  const plan=S.document('plan','Plan','\r\n# comment\r\nSep 5 2026: café 🦾\r\n','p1'),log=S.document('log','2026-09-05','# Notes\n\n- [ ] test\n','2026-09-05');
  state.docs[plan.path]={body:plan.body,etag:'"private"',dirty:true,conflict:{body:S.tombstone(plan.path,plan.body),etag:'"other"',source:'remote'}};
  state.docs[log.path]={body:log.body,etag:null,dirty:false};
  const archive=await T.backup(state),restored=await T.restore(archive);
  assert.equal(restored.docs[plan.path].body,plan.body);assert.equal(restored.docs[log.path].body,log.body);assert.equal(restored.docs[plan.path].conflict.body,state.docs[plan.path].conflict.body);
  assert.equal(restored.connection,null);assert.equal(restored.docs[plan.path].etag,null);
  assert.ok(!JSON.stringify(await T.unzip(archive)).includes('private.test'));
});
test('backup rejects a modified file even when ZIP CRC is valid',async()=>{
  const state=S.workspace(),doc=S.document('plan','Original',': Original','p1');state.docs[doc.path]={body:doc.body};
  const files=await T.unzip(await T.backup(state));files[doc.path]=doc.body.replace('Original','Altered');
  await assert.rejects(T.restore(T.zip(files)),/checksum mismatch/);
});
test('archives and catalogs reject traversal and unsupported versions',async()=>{
  await assert.rejects(T.unzip(T.zip({'../secret.txt':'no'})),/Unsafe/);
  assert.throws(()=>S.record('plans/../../secret.json','{}'),/Unsupported/);
  assert.throws(()=>S.record('plans/a.json',S.json({format:S.FORMAT,version:999,type:'plan',id:'a',name:'a',content:''})),/unsupported/);
  await assert.rejects(S.readURL('https://example.test/index.json',async()=>new Response(S.json({format:S.FORMAT,version:1,workspace:S.workspace().manifest,documents:[{path:'../secret'}]}))),/Unsupported document path/);
});
test('CSV handles quotes, commas, newlines, spreadsheet formulas, and row conversion errors',()=>{
  assert.deepEqual(T.parseCSV('name,note\r\n"A, B","said ""hi""\nnext"\r\n'),[['name','note'],['A, B','said "hi"\nnext']]);
  assert.throws(()=>T.parseCSV('a\n"bad'),/Unclosed/);
  const rows=T.parseCSV('name,start,end,priority\nBuild,2026-09-05,2026-09-06,P1\nBad,2026-02-30,,P2\n');
  const result=T.csvImport(rows,{name:0,start:1,end:2,priority:3});
  assert.equal(result.count,1);assert.match(result.text,/Sep 5 2026 - Sep 6 2026: Build \^P1/);assert.match(result.warnings[0],/Row 3 skipped/);
  assert.match(T.csvExport([{name:'=HYPERLINK("x")',people:[],depth:0}]),/"'=HYPERLINK/);
});
test('ICS converts exclusive all-day ends and reports unsupported events',()=>{
  const source='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260905\r\nDTEND;VALUE=DATE:20260907\r\nSUMMARY:Weekend\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:20260905T100000Z\r\nDURATION:PT1H\r\nSUMMARY:Unsupported\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const result=T.icsImport(source,'UTC');assert.equal(result.count,1);assert.match(result.text,/%Sep 5 2026 - Sep 6 2026: Weekend/);assert.match(result.warnings.join('\n'),/DURATION/);
});
test('ICS export preserves date boundaries, UTC wall time, UTF-8 folding, and stable identities',()=>{
  const task={name:'🦾'.repeat(40),start:new Date(2026,8,5),end:new Date(2026,8,6),startTime:null,endTime:null,people:[],lineNumber:1};
  const plan={id:'plan1',lineIds:['item1']},first=T.icsExport([task],plan,'America/New_York');
  assert.match(first.text,/DTEND;VALUE=DATE:20260907/);assert.match(first.text,/UID:plan1-item1-0@caltasklog/);
  assert.ok(first.text.split('\r\n').every(line=>Buffer.byteLength(line)<=75));
  const timed=T.icsExport([{...task,end:task.start,startTime:14*60,endTime:15*60}],plan,'America/New_York');
  assert.match(timed.text,/DTSTART:20260905T180000Z/);
  const ambiguous=T.icsExport([{...task,start:new Date(2026,10,1),end:new Date(2026,10,1),startTime:90,endTime:150}],plan,'America/New_York');
  assert.equal(ambiguous.count,0);assert.match(ambiguous.warnings[0],/ambiguous/);
  assert.deepEqual(T.lineIds({content:'a\nb',lineIds:['a-id','b-id']},'new\na\nb').slice(1),['a-id','b-id']);
});
test('sync merges independent changes and regenerates a missing catalog',async t=>{
  const {engine,remote}=await setup(t),a=S.document('plan','Local',': A','a'),b=S.document('log','2026-09-05','# Remote','2026-09-05');
  await engine.edit([a]);await remote.write(b.path,b.body,null);await engine.sync();
  assert.equal(engine.state.docs[b.path].body,b.body);assert.equal(engine.state.docs[a.path].dirty,false);
  assert.equal(JSON.parse((await remote.read('index.json')).body).documents.length,2);
});
test('concurrent remote updates produce a conflict; resolving yours uses the reviewed revision',async t=>{
  const {engine,remote}=await setup(t),doc=S.document('plan','Plan',': Base','a');
  await engine.edit([doc]);await engine.sync();
  const local=S.document('plan','Plan',': Local','a'),other=S.document('plan','Plan',': Remote','a');
  await engine.edit([{...local,expected:doc.body}]);await remote.write(doc.path,other.body,(await remote.read(doc.path)).etag);
  await engine.sync();assert.equal(engine.state.docs[doc.path].conflict.body,other.body);assert.equal((await remote.read(doc.path)).body,other.body);
  await engine.resolve(doc.path,'local');await engine.sync();assert.equal((await remote.read(doc.path)).body,local.body);assert.equal(engine.state.docs[doc.path].dirty,false);
});
test('an edit during upload stays queued and is sent on the next pass',async t=>{
  const {engine,remote}=await setup(t),doc=S.document('plan','Plan',': First','a'),newer=S.document('plan','Plan',': Newer','a');
  await engine.edit([doc]);const write=remote.write.bind(remote);let first=true;
  remote.write=async(path,body,etag)=>{if(path===doc.path && first){first=false;await engine.edit([{...newer,expected:doc.body}]);}return write(path,body,etag);};
  await engine.sync();assert.equal(engine.state.docs[doc.path].body,newer.body);assert.equal(engine.state.docs[doc.path].dirty,true);
  await engine.sync();assert.equal((await remote.read(doc.path)).body,newer.body);assert.equal(engine.state.docs[doc.path].dirty,false);
});
test('offline queue survives failure, and an uncertain successful upload is acknowledged on retry',async t=>{
  const {engine,remote}=await setup(t),doc=S.document('plan','Plan',': First','a');await engine.edit([doc]);
  const write=remote.write.bind(remote);let fail=true;
  remote.write=async(path,body,etag)=>{const result=await write(path,body,etag);if(path===doc.path && fail){fail=false;throw new Error('Connection interrupted');}return result;};
  await assert.rejects(engine.sync(),/interrupted/);assert.equal(engine.state.docs[doc.path].dirty,true);
  await engine.sync();assert.equal(engine.state.docs[doc.path].dirty,false);
});
test('stale browser tab edits preserve both local versions',async t=>{
  const {engine}=await setup(t),doc=S.document('plan','Plan',': First','a'),other=S.document('plan','Plan',': Other','a'),stale=S.document('plan','Plan',': Stale','a');
  await engine.edit([doc]);await engine.edit([{...other,expected:doc.body}]);await engine.edit([{...stale,expected:doc.body}]);
  assert.equal(engine.state.docs[doc.path].body,stale.body);assert.equal(engine.state.docs[doc.path].conflict.body,other.body);assert.equal(engine.state.docs[doc.path].conflict.source,'device');
});
test('synced tombstones prevent a stale device from resurrecting a deleted note',async t=>{
  const {engine,remote}=await setup(t),doc=S.document('log','2026-09-05','# Notes','2026-09-05');
  await engine.edit([doc]);await engine.sync();const stale=structuredClone(engine.state);
  await engine.edit([{path:doc.path,body:S.tombstone(doc.path,doc.body),expected:doc.body}]);await engine.sync();
  const second=new S.Engine(new MemoryDB(stale));t.after(()=>second.channel?.close());await second.select(stale.id);second.adapter=remote;
  await second.sync();assert.equal(S.record(doc.path,second.state.docs[doc.path].body).deleted,true);
});
test('catalog failure is reported separately from successful document saves',async t=>{
  const {engine,remote}=await setup(t),doc=S.document('plan','Plan',': First','a');await engine.edit([doc]);
  const write=remote.write.bind(remote);remote.write=(path,...args)=>{if(path==='index.json') throw new Error('Index unavailable');return write(path,...args);};
  await engine.sync();assert.equal(engine.state.docs[doc.path].dirty,false);assert.match(engine.state.catalogError,/catalog needs repair/);
});
test('a conflict resolution cannot overwrite versions changed since review opened',async t=>{
  const {engine}=await setup(t),doc=S.document('plan','Plan',': First','a');await engine.edit([doc]);
  await engine.edit([{...S.document('plan','Plan',': Second','a'),expected:null}]);
  const entry=engine.state.docs[doc.path],reviewed=JSON.stringify([entry.body,entry.conflict]);
  await engine.edit([{...S.document('plan','Plan',': Third','a'),expected:entry.body}]);
  await assert.rejects(engine.resolve(doc.path,'remote',undefined,reviewed),/changed while you were reviewing/);
  assert.match(S.record(doc.path,engine.state.docs[doc.path].body).content,/Third/);
});
test('sync accepts remote workspace metadata updates but refuses another workspace identity',async t=>{
  const {engine,remote}=await setup(t);
  const info={...engine.state.manifest,name:'Remote name',timezone:'UTC'};
  remote.files.set('workspace.json',{body:S.json(info),etag:'"next"'});await engine.sync();assert.equal(engine.state.manifest.name,'Remote name');
  remote.files.set('workspace.json',{body:S.json({...info,id:'different-workspace'}),etag:'"other"'});
  await assert.rejects(engine.sync(),/identity changed/);
});
