/* Portable workspace archives and explicit, previewable interchange conversions. */
(function (root) {
  'use strict';
  const S = root.CTLStorage || require('./storage.js');
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal:true});
  const MAX_ARCHIVE = 64 * 1024 * 1024;
  const concat = arrays => { const out = new Uint8Array(arrays.reduce((n,a) => n+a.length, 0)); let at=0; for (const a of arrays) { out.set(a,at); at+=a.length; } return out; };
  const crcTable = Array.from({length:256}, (_,n) => { for (let k=0;k<8;k++) n = n&1 ? 0xedb88320 ^ (n>>>1) : n>>>1; return n>>>0; });
  function crc32(bytes) { let crc=0xffffffff; for (const byte of bytes) crc=crcTable[(crc^byte)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }
  async function sha256(bytes) {
    if (!crypto.subtle) throw new Error('Verified backups require HTTPS or localhost in this browser.');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function zip(files) {
    const locals=[], central=[]; let offset=0;
    for (const [path, text] of Object.entries(files)) {
      const name=encoder.encode(path), data=encoder.encode(text), crc=crc32(data);
      const local=new Uint8Array(30), l=new DataView(local.buffer);
      l.setUint32(0,0x04034b50,true); l.setUint16(4,20,true); l.setUint16(6,0x800,true);
      l.setUint16(12,33,true); l.setUint32(14,crc,true); l.setUint32(18,data.length,true); l.setUint32(22,data.length,true); l.setUint16(26,name.length,true);
      locals.push(local,name,data);
      const header=new Uint8Array(46), c=new DataView(header.buffer);
      c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true); c.setUint16(14,33,true);
      c.setUint32(16,crc,true); c.setUint32(20,data.length,true); c.setUint32(24,data.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true);
      central.push(header,name); offset+=local.length+name.length+data.length;
    }
    const directory=concat(central), end=new Uint8Array(22), view=new DataView(end.buffer), count=Object.keys(files).length;
    if (count>10000 || offset+directory.length+22>MAX_ARCHIVE) throw new Error('Workspace exceeds the 64 MiB / 10,000 file backup limit.');
    view.setUint32(0,0x06054b50,true); view.setUint16(8,count,true); view.setUint16(10,count,true); view.setUint32(12,directory.length,true); view.setUint32(16,offset,true);
    return concat([...locals,directory,end]);
  }
  async function unzip(input) {
    const bytes=input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length>MAX_ARCHIVE || bytes.length<22) throw new Error('Invalid or oversized ZIP archive.');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let end=-1;
    for (let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--) if(v.getUint32(p,true)===0x06054b50 && p+22+v.getUint16(p+20,true)===bytes.length) {end=p;break;}
    if(end<0 || v.getUint16(end+4,true) || v.getUint16(end+6,true)) throw new Error('Unsupported ZIP archive.');
    const count=v.getUint16(end+10,true), directorySize=v.getUint32(end+12,true), start=v.getUint32(end+16,true);
    if(count>10000 || v.getUint16(end+8,true)!==count || start+directorySize!==end) throw new Error('Invalid ZIP directory.');
    const files=Object.create(null); let cursor=start, total=0;
    for(let i=0;i<count;i++) {
      if(cursor+46>end || v.getUint32(cursor,true)!==0x02014b50) throw new Error('Invalid ZIP entry.');
      const flags=v.getUint16(cursor+8,true), method=v.getUint16(cursor+10,true), crc=v.getUint32(cursor+16,true), compressed=v.getUint32(cursor+20,true), size=v.getUint32(cursor+24,true);
      const n=v.getUint16(cursor+28,true), x=v.getUint16(cursor+30,true), comment=v.getUint16(cursor+32,true), local=v.getUint32(cursor+42,true);
      if(cursor+46+n+x+comment>end || local+30>start || v.getUint32(local,true)!==0x04034b50) throw new Error('Invalid ZIP offsets.');
      const name=decoder.decode(bytes.slice(cursor+46,cursor+46+n)); cursor+=46+n+x+comment;
      if(flags&1 || ![0,8].includes(method) || size>S.LIMIT || (total+=size)>MAX_ARCHIVE) throw new Error('Encrypted, oversized, or unsupported ZIP entry.');
      if(!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part=>!part || part==='.' || part==='..') || Object.hasOwn(files,name)) throw new Error('Unsafe or duplicate archive path.');
      const ln=v.getUint16(local+26,true), lx=v.getUint16(local+28,true), dataAt=local+30+ln+lx;
      if(dataAt+compressed>start || decoder.decode(bytes.slice(local+30,local+30+ln))!==name || v.getUint16(local+8,true)!==method) throw new Error('Mismatched ZIP entry.');
      let data=bytes.slice(dataAt,dataAt+compressed);
      if(method===8) {
        let stream;
        try { stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')); } catch (_) { throw new Error('This browser cannot read compressed ZIPs. Use a ZIP exported by CalTaskLog or a current browser.'); }
        const reader=stream.getReader(), chunks=[]; let length=0;
        while(true) { const next=await reader.read(); if(next.done) break; length+=next.value.length; if(length>size) { await reader.cancel(); throw new Error('Archive expands beyond its declared size.'); } chunks.push(next.value); }
        data=concat(chunks);
      }
      if(data.length!==size || crc32(data)!==crc) throw new Error(`Corrupt archive entry: ${name}`);
      files[name]=decoder.decode(data);
    }
    if(cursor!==end) throw new Error('Invalid ZIP directory length.');
    return files;
  }
  async function backup(state) {
    const files={'workspace.json':S.json(state.manifest), 'index.json':S.json(S.catalog(state))};
    for(const [path,entry] of Object.entries(state.docs)) { S.record(path,entry.body); files[path]=entry.body; }
    // Include unresolved alternatives so a backup is also a recovery snapshot.
    const conflicts=Object.entries(state.docs).filter(([,entry])=>entry.conflict).map(([path,entry])=>({path, body:entry.conflict.body}));
    if(conflicts.length) files['conflicts.json']=S.json(conflicts);
    const inventory=[];
    for(const [path,body] of Object.entries(files)) {const data=encoder.encode(body); inventory.push({path,size:data.length,sha256:await sha256(data)});}
    files['backup.json']=S.json({format:S.FORMAT,version:S.VERSION,exportedAt:new Date().toISOString(),files:inventory});
    return zip(files);
  }
  async function restore(input) {
    const files=await unzip(input), info=JSON.parse(files['backup.json'] || 'null');
    if(info?.format!==S.FORMAT || info.version!==S.VERSION || !Array.isArray(info.files)) throw new Error('This is not a supported CalTaskLog backup.');
    const expected=new Set(['backup.json']);
    for(const item of info.files) {
      if(expected.has(item.path) || !Object.hasOwn(files,item.path)) throw new Error('Invalid backup inventory.'); expected.add(item.path);
      const data=encoder.encode(files[item.path]);
      if(item.size!==data.length || item.sha256!==await sha256(data)) throw new Error(`Backup checksum mismatch: ${item.path}`);
    }
    if(Object.keys(files).some(path=>!expected.has(path))) throw new Error('Archive contains files outside its inventory.');
    const state=S.workspace(); state.manifest=S.manifest(JSON.parse(files['workspace.json'] || 'null'));
    for(const [path,body] of Object.entries(files)) {
      if(['backup.json','workspace.json','index.json','conflicts.json'].includes(path)) continue;
      S.record(path,body); state.docs[path]={body,etag:null,dirty:true};
    }
    for(const conflict of JSON.parse(files['conflicts.json'] || '[]')) {
      if(!state.docs[conflict.path]) throw new Error('Conflict refers to a missing document.');
      if(conflict.body!==null) S.record(conflict.path,conflict.body);
      state.docs[conflict.path].conflict={body:conflict.body,etag:null,source:'device'};
    }
    return state;
  }
  function parseCSV(text) {
    text=text.replace(/^\uFEFF/,'');
    const rows=[]; let row=[], value='', quoted=false, closed=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted) { if(c==='"') { if(text[i+1]==='"') {value+='"';i++;} else {quoted=false;closed=true;} } else value+=c; continue; }
      if(c==='"' && !value && !closed) {quoted=true;continue;}
      if(c===',' || c==='\r' || c==='\n') {
        row.push(value);value='';closed=false;
        if(c!==',') {rows.push(row);row=[];if(c==='\r' && text[i+1]==='\n') i++;}
      } else {if(closed || c==='"') throw new Error('Malformed CSV quoting.');value+=c;}
    }
    if(quoted) throw new Error('Unclosed CSV quote.');
    if(value || row.length || closed) {row.push(value);rows.push(row);}
    if(!rows.length) throw new Error('CSV is empty.');
    return rows;
  }
  const dateKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const clock=minutes=>minutes==null?'':`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
  const csvCell=value=>{let text=String(value ?? '');if(/^[\s]*[=+\-@]/.test(text)) text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  const CSV_FIELDS=['name','start','end','startTime','endTime','people','status','note','priority','color','link','type','depth'];
  function csvExport(tasks) {
    return [CSV_FIELDS.join(','), ...tasks.map(task=>CSV_FIELDS.map(key=>csvCell(
      key==='start'||key==='end' ? (task[key]?dateKey(task[key]):'') : key==='startTime'||key==='endTime' ? clock(task[key]) : key==='people' ? task.people.join(', ') : key==='type' ? (task.isEvent?'event':'task') : task[key]
    )).join(','))].join('\r\n')+'\r\n';
  }
  const monthNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function sourceDate(value) {if(!S.validDate(value)) throw new Error(`Invalid date ${value}; use YYYY-MM-DD.`);const [y,m,d]=value.split('-');return `${monthNames[Number(m)-1]} ${Number(d)} ${y}`;}
  function safeText(value,label) {if(/[\r\n\[\]{}()]/.test(value)) throw new Error(`${label} contains syntax that needs manual conversion.`);return value.trim();}
  function csvImport(rows, mapping) {
    const lines=[],warnings=[];
    rows.slice(1).forEach((row,index)=>{
      if(row.every(value=>!value.trim())) return;
      try {
        const value=key=>mapping[key]==null || mapping[key]==='' ? '' : (row[Number(mapping[key])] || '').replace(/^'(?=\s*[=+\-@])/,'');
        const name=safeText(value('name'),'Name'); if(!name) throw new Error('Missing task name.');
        const start=value('start'), end=value('end'); if(end && !start) throw new Error('End date has no start date.');
        if(end && end<start) throw new Error('End date precedes start date.');
        let prefix=start?sourceDate(start):'';
        if(end && end!==start) prefix+=` - ${sourceDate(end)}`;
        const startTime=value('startTime'),endTime=value('endTime');
        if(startTime || endTime) {
          if(!start || (end && end!==start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || (endTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) || endTime<=startTime))) throw new Error('Unsupported or invalid time range.');
          prefix+=` ${startTime}${endTime?'-'+endTime:''}`;
        }
        const people=safeText(value('people'),'People'),status=safeText(value('status'),'Status'),note=safeText(value('note'),'Note'),priority=value('priority'),color=value('color'),link=value('link');
        if(priority && !/^P[0-4]$/.test(priority)) throw new Error('Priority must be P0–P4.');
        if(color && !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new Error('Invalid color.');
        if(link && (!/^https?:\/\/[^\s{}]+$/.test(link))) throw new Error('Invalid link.');
        const depth=value('depth'); if(depth && (!/^\d+$/.test(depth) || Number(depth)>30)) throw new Error('Invalid depth.');
        lines.push(`${'    '.repeat(Number(depth)||0)}${value('type').toLowerCase()==='event'?'%':''}${prefix}: ${name}${people?' ('+people+')':''}${status||note?' ['+(status||'Note')+(note?' - '+note:'')+']':''}${priority?' ^'+priority:''}${color?' '+color:''}${link?' {{'+link+'}}':''}`);
      } catch(error) {warnings.push(`Row ${index+2} skipped: ${error.message}`);}
    });
    return {text:lines.join('\n'),warnings,count:lines.length};
  }
  const icsEscape=value=>String(value).replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
  const icsUnescape=value=>value.replace(/\\([nN,;\\])/g,(_,c)=>/[nN]/.test(c)?'\n':c);
  function fold(line) {let result='',part='',size=0;for(const char of line){const n=encoder.encode(char).length;if(size+n>75){result+=part+'\r\n';part=' ';size=1;}part+=char;size+=n;}return result+part;}
  function utcForWall(date,minutes,timezone) {
    const target=Date.UTC(date.getFullYear(),date.getMonth(),date.getDate(),Math.floor(minutes/60),minutes%60);
    const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const wall=value=>{const p=Object.fromEntries(formatter.formatToParts(new Date(value)).map(part=>[part.type,part.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);};
    // Sample offsets on both sides of a transition, including non-hour changes.
    const candidates=new Set();
    for(const hours of [-48,-24,-12,0,12,24,48]) {
      const probe=target+hours*3600000,candidate=target-(wall(probe)-probe);
      if(wall(candidate)===target) candidates.add(candidate);
    }
    if(!candidates.size) throw new Error(`A time on ${dateKey(date)} does not exist in ${timezone} because of a clock change.`);
    if(candidates.size>1) throw new Error(`A time on ${dateKey(date)} is ambiguous in ${timezone}. Adjust it before calendar export.`);
    return new Date([...candidates][0]).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  }
  function icsExport(tasks, plan, timezone) {
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//CalTaskLog//Calendar Export//EN','CALSCALE:GREGORIAN'];
    const warnings=[];let count=0;
    for(const task of tasks) {
      if(!task.start || !task.end || task.hasChildren) {warnings.push(`${task.name}: undated or summary item omitted.`);continue;}
      try {
        const values=[];
        if(task.startTime==null) {
          const exclusive=new Date(task.end);exclusive.setDate(exclusive.getDate()+1);
          values.push('DTSTART;VALUE=DATE:'+dateKey(task.start).replace(/-/g,''),'DTEND;VALUE=DATE:'+dateKey(exclusive).replace(/-/g,''));
        } else {
          values.push('DTSTART:'+utcForWall(task.start,task.startTime,timezone));
          if(task.endTime!=null) {if(task.endTime<=task.startTime) throw new Error('End time must follow start time.');values.push('DTEND:'+utcForWall(task.end,task.endTime,timezone));}
        }
        const lineId=plan.lineIds?.[task.lineNumber-1] || `line-${task.lineNumber}`;
        lines.push('BEGIN:VEVENT',`UID:${plan.id}-${lineId}-${task.occurrenceIndex ?? 0}@caltasklog`, 'DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),...values,'SUMMARY:'+icsEscape(task.name));
        if(task.note || task.people.length || task.status) lines.push('DESCRIPTION:'+icsEscape([task.note,task.people.length?'Assignees: '+task.people.join(', '):'',task.status?'Status: '+task.status:''].filter(Boolean).join('\n')));
        if(task.link) lines.push('URL:'+task.link);
        if(/^cancell?ed\b/i.test(task.status)) lines.push('STATUS:CANCELLED');
        lines.push('END:VEVENT');count++;
      } catch(error) {warnings.push(`${task.name}: ${error.message}`);}
    }
    lines.push('END:VCALENDAR');
    return {text:lines.map(fold).join('\r\n')+'\r\n',warnings,count};
  }
  function icsImport(text, timezone='UTC') {
    const warnings=[],events=[], lines=text.replace(/^\uFEFF/,'').replace(/\r?\n[ \t]/g,'').split(/\r?\n/); let event=null, nested=0;
    if(!lines.includes('BEGIN:VCALENDAR') || !lines.includes('END:VCALENDAR')) throw new Error('Not an iCalendar file.');
    for(const line of lines) {
      if(line==='BEGIN:VEVENT') {event=[];nested=0;continue;}
      if(line==='END:VEVENT') {if(event) events.push(event);event=null;continue;}
      if(!event) {if(/^BEGIN:V(TODO|JOURNAL|FREEBUSY)/.test(line)) warnings.push(`${line.slice(6)} component omitted.`);continue;}
      if(line.startsWith('BEGIN:')) {nested++;warnings.push(`${line.slice(6)} component omitted.`);continue;}
      if(line.startsWith('END:')) {nested--;continue;}
      if(!nested) event.push(line);
    }
    const output=[];
    for(const [index,eventLines] of events.entries()) {
      try {
        const props=eventLines.map(line=>{const colon=line.indexOf(':');if(colon<0) throw new Error('Malformed property.');const head=line.slice(0,colon).split(';');return {key:head[0].toUpperCase(),params:head.slice(1),value:line.slice(colon+1)};});
        const get=key=>props.find(p=>p.key===key);
        const title=icsUnescape(get('SUMMARY')?.value||'Untitled event');
        for(const property of ['DTSTART','DTEND','SUMMARY','RRULE']) if(props.filter(p=>p.key===property).length>1) throw new Error(`Repeated ${property} is unsupported.`);
        if(props.some(p=>['RECURRENCE-ID','EXDATE','RDATE','EXRULE','DURATION'].includes(p.key))) throw new Error('Recurrence exceptions or DURATION need manual conversion.');
        const parse=p=>{
          if(!p) throw new Error('Missing DTSTART.');
          const match=p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
          if(!match) throw new Error('Unsupported date/time.');
          let date=`${match[1]}-${match[2]}-${match[3]}`,time=match[4]?`${match[4]}:${match[5]}`:'';
          if(!S.validDate(date) || (time && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || match[6]!=='00'))) throw new Error('Invalid date or unsupported seconds.');
          const zone=p.params.find(v=>v.toUpperCase().startsWith('TZID='))?.slice(5).replace(/^"|"$/g,'');
          if(zone && zone!==timezone) throw new Error(`Timezone ${zone} differs from workspace timezone ${timezone}.`);
          if(match[7]) {
            const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(`${date}T${time}:00Z`)).map(p=>[p.type,p.value]));
            date=`${parts.year}-${parts.month}-${parts.day}`;time=`${parts.hour}:${parts.minute}`;
          }
          return {date,time,utc:!!match[7]};
        };
        const start=parse(get('DTSTART')), end=get('DTEND')?parse(get('DTEND')):{...start};
        if(!!start.time!==!!end.time || end.date<start.date || (start.time && end.date===start.date && get('DTEND') && end.time<=start.time)) throw new Error('Invalid event end.');
        if(!start.time && get('DTEND')) {
          const day=new Date(end.date+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-1);end.date=day.toISOString().slice(0,10);
          if(end.date<start.date) throw new Error('All-day end must follow its start.');
        }
        if(start.time && end.date!==start.date) throw new Error('Timed events spanning days need manual conversion.');
        let prefix=sourceDate(start.date)+(end.date!==start.date?' - '+sourceDate(end.date):'');
        if(start.time) prefix+=' '+start.time+(get('DTEND')?'-'+end.time:'');
        const rule=get('RRULE')?.value;
        if(rule) {
          const fields=Object.fromEntries(rule.split(';').map(v=>v.split('=')));
          if(Object.keys(fields).some(k=>!['FREQ','INTERVAL','BYDAY','COUNT','UNTIL'].includes(k)) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(fields.FREQ) || (fields.BYDAY && !/^(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*$/.test(fields.BYDAY))) throw new Error('Unsupported recurrence rule.');
          if(start.utc || (fields.UNTIL && fields.UNTIL.includes('T'))) throw new Error('UTC recurrence or timed UNTIL needs manual conversion to preserve clock-change semantics.');
          prefix+=',rrule='+rule;
        }
        const name=safeText(title,'Event title'), status=get('STATUS')?.value==='CANCELLED'?' [cancelled]':'';
        const link=get('URL')?.value;
        const description=get('DESCRIPTION')?.value;
        if(description) output.push(...icsUnescape(description).split(/\r?\n/).map(line=>'# '+line));
        if(link && !/^https?:\/\/[^\s{}]+$/.test(link)) warnings.push(`Event ${index+1}: URL omitted.`);
        output.push(`%${prefix}: ${name}${status}${link && /^https?:\/\/[^\s{}]+$/.test(link)?' {{'+link+'}}':''}`);
        const ignored=props.filter(p=>!['DTSTART','DTEND','SUMMARY','DESCRIPTION','URL','STATUS','RRULE','UID','DTSTAMP','CREATED','LAST-MODIFIED','SEQUENCE'].includes(p.key)).map(p=>p.key);
        if(ignored.length) warnings.push(`Event ${index+1}: ${[...new Set(ignored)].join(', ')} omitted.`);
      } catch(error) {warnings.push(`Event ${index+1} skipped: ${error.message}`);}
    }
    return {text:`@timezone=${timezone}\n`+output.join('\n'),warnings,count:output.filter(line=>line.startsWith('%')).length};
  }
  function lineIds(previous, text) {
    const oldLines=(previous?.content || '').split(/\r?\n/), next=text.split(/\r?\n/), queues=new Map(), used=new Set();
    oldLines.forEach((line,i)=>{if(!queues.has(line)) queues.set(line,[]);queues.get(line).push(i);});
    const matches=next.map(line=>{const old=queues.get(line)?.shift();if(old!==undefined) used.add(old);return old;});
    // Preserve identities across ordinary one-line edits as well as insertions/moves.
    return matches.map((match,i)=>{
      if(match!==undefined) return previous?.lineIds?.[match] || S.id();
      if(oldLines.length===next.length && !used.has(i)) {used.add(i);return previous?.lineIds?.[i] || S.id();}
      return S.id();
    });
  }
  const api={MAX_ARCHIVE,crc32,sha256,zip,unzip,backup,restore,parseCSV,CSV_FIELDS,csvImport,csvExport,icsImport,icsExport,lineIds,dateKey};
  root.CTLTransfer=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);
