/* CalTaskLog storage format and adapters. No server or third-party runtime required. */
(function (root) {
  'use strict';
  const FORMAT = 'caltasklog', VERSION = 1;
  const TOMBSTONE = '<!-- caltasklog:deleted:v1 -->';
  const LIMIT = 8 * 1024 * 1024;
  const clone = value => structuredClone(value);
  const id = () => crypto.randomUUID();
  const json = value => JSON.stringify(value, null, 2) + '\n';
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return !isNaN(date) && date.toISOString().slice(0, 10) === value;
  }
  function kind(path) {
    if (/^plans\/[a-zA-Z0-9_-]+\.json$/.test(path)) return 'plan';
    if (/^templates\/[a-zA-Z0-9_-]+\.json$/.test(path)) return 'template';
    const log = path.match(/^logs\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (log && validDate(log[3]) && log[3].startsWith(`${log[1]}-${log[2]}-`)) return 'log';
    throw new Error(`Unsupported document path: ${path}`);
  }
  function record(path, body) {
    const type = kind(path);
    if (typeof body !== 'string' || new TextEncoder().encode(body).length > LIMIT) throw new Error(`Invalid or oversized file: ${path}`);
    if (type === 'log') return {type, id:path.slice(-13, -3), name:path.slice(-13, -3), content:body, deleted:body === TOMBSTONE};
    let value;
    try { value = JSON.parse(body); } catch (_) { throw new Error(`Invalid JSON: ${path}`); }
    if (value?.format !== FORMAT || value.version !== VERSION || value.type !== type || typeof value.id !== 'string' ||
        path !== `${type === 'plan' ? 'plans' : 'templates'}/${value.id}.json` || typeof value.name !== 'string' ||
        typeof value.content !== 'string' || (value.deleted !== undefined && typeof value.deleted !== 'boolean')) throw new Error(`Invalid or unsupported document: ${path}`);
    if (value.lineIds !== undefined && (!Array.isArray(value.lineIds) || value.lineIds.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(key)))) throw new Error(`Invalid calendar identities: ${path}`);
    return value;
  }
  function document(type, name, content, key = id()) {
    const path = type === 'log' ? `logs/${key.slice(0,4)}/${key.slice(5,7)}/${key}.md` : `${type === 'plan' ? 'plans' : 'templates'}/${key}.json`;
    const body = type === 'log' ? content : json({format:FORMAT, version:VERSION, type, id:key, name, content});
    record(path, body);
    return {path, body};
  }
  function tombstone(path, body) {
    return kind(path) === 'log' ? TOMBSTONE : json({...record(path, body), content:'', deleted:true});
  }
  function manifest(value) {
    if (!value || value.format !== FORMAT || value.version !== VERSION || typeof value.id !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(value.id) || typeof value.name !== 'string' || typeof value.timezone !== 'string') throw new Error('Unsupported workspace format.');
    try { new Intl.DateTimeFormat('en-US', {timeZone:value.timezone}).format(); } catch (_) { throw new Error('Invalid workspace timezone.'); }
    return value;
  }
  function workspace(name = 'My workspace') {
    return {id:id(), manifest:{format:FORMAT, version:VERSION, id:id(), name, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}, docs:{}, connection:null, lastSync:null, revision:0};
  }
  class Database {
    async open() {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('caltasklog-workspaces', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('workspaces', {keyPath:'id'});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this;
    }
    async list() {
      return new Promise((resolve,reject) => {
        const req = this.db.transaction('workspaces').objectStore('workspaces').getAll();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    }
    async get(key) { return (await this.list()).find(value => value.id === key); }
    async update(key, change) {
      return new Promise((resolve,reject) => {
        const tx = this.db.transaction('workspaces', 'readwrite');
        const store = tx.objectStore('workspaces');
        let result, failure;
        const req = store.get(key);
        req.onsuccess = () => {
          try { result = change(req.result); result.revision = (req.result?.revision || 0) + 1; store.put(result); }
          catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('Could not save on this device.'));
      });
    }
  }
  function url(value, folder = false) {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) throw new Error('Use an HTTPS URL (HTTP is allowed for localhost testing).');
    if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('Use a URL without embedded credentials, query parameters, or a fragment.');
    if (folder && !parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed.href;
  }
  class HTTPError extends Error {
    constructor(status, path) { super(`Storage request failed (${status}) for ${path}.`); this.status = status; }
  }
  class WebDAV {
    constructor(base, username = '', password = '', request = (...args) => root.fetch(...args)) {
      this.base = url(base, true); this.request = request;
      this.auth = username || password ? 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`))) : '';
    }
    async call(path, method = 'GET', body, headers = {}) {
      const destination = new URL(path, this.base);
      if (!destination.href.startsWith(this.base)) throw new Error('Path is outside the workspace.');
      const response = await this.request(destination.href, {method, body, headers:{...(this.auth ? {Authorization:this.auth} : {}), ...headers}, credentials:'omit', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(30000)});
      return response;
    }
    async read(path) {
      const response = await this.call(path);
      if (response.status === 404) return null;
      if (!response.ok) throw new HTTPError(response.status, path);
      if (Number(response.headers.get('Content-Length')) > LIMIT) throw new Error(`File is too large: ${path}`);
      const body = await response.text();
      if (new TextEncoder().encode(body).length > LIMIT) throw new Error(`File is too large: ${path}`);
      return {body, etag:response.headers.get('ETag')};
    }
    async folders(path) {
      const parts = path.split('/'); parts.pop();
      let prefix = '';
      for (const part of parts) {
        prefix += part + '/';
        const response = await this.call(prefix, 'MKCOL');
        if (!response.ok && response.status !== 405) throw new HTTPError(response.status, prefix);
      }
    }
    async write(path, body, etag) {
      if (etag !== null && (!etag || etag.startsWith('W/'))) throw new Error('This server must expose strong ETags for safe editing. Check CORS and ETag configuration.');
      await this.folders(path);
      const response = await this.call(path, 'PUT', body, {'Content-Type':path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', ...(etag === null ? {'If-None-Match':'*'} : {'If-Match':etag})});
      if (!response.ok) throw new HTTPError(response.status, path);
      // Read back: a PUT response is allowed to omit ETag; also detects intervening writes.
      const saved = await this.read(path);
      if (!saved || saved.body !== body) throw new Error(`The remote file changed immediately after saving: ${path}. Retry to review both versions.`);
      if (!saved.etag || saved.etag.startsWith('W/')) throw new Error('The server did not expose a strong ETag. Reconnect after fixing its configuration.');
      return saved;
    }
    async list() {
      const pending = ['']; const found = new Set(); let count = 0;
      while (pending.length) {
        const folder = pending.shift();
        if (++count > 1000) throw new Error('Workspace contains too many folders.');
        const response = await this.call(folder, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>', {Depth:'1', 'Content-Type':'application/xml'});
        if (response.status === 404 && folder) continue;
        if (!response.ok) throw new HTTPError(response.status, folder || '/');
        const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) throw new Error('Invalid WebDAV folder response.');
        for (const item of xml.getElementsByTagNameNS('DAV:', 'response')) {
          const href = item.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent;
          if (!href) continue;
          const resolved = new URL(href, new URL(folder, this.base));
          if (!resolved.href.startsWith(this.base)) continue;
          const path = decodeURIComponent(resolved.href.slice(this.base.length));
          if (path === folder || !path) continue;
          if (item.getElementsByTagNameNS('DAV:', 'collection').length) {
            if (/^(plans|templates)\/$/.test(path) || /^logs\/(?:\d{4}\/(?:\d{2}\/)?)?$/.test(path)) pending.push(path);
          } else {
            try { kind(path); found.add(path); } catch (_) { /* Ignore unrelated files. */ }
          }
          if (found.size > 10000) throw new Error('Workspace contains too many documents.');
        }
      }
      return [...found];
    }
    async test() {
      await this.list();
      const path = `.ctl-connection-test-${id()}.json`;
      let saved;
      try {
        saved = await this.write(path, '{}', null);
        let rejected = false;
        try { await this.write(path, '{"test":true}', '"intentionally-stale-revision"'); }
        catch (error) { if (error.status === 412) rejected = true; else throw error; }
        if (!rejected) throw new Error('The server ignored a conditional write. Safe sync is unavailable.');
      } finally {
        if (saved) {
          const response = await this.call(path, 'DELETE', undefined, {'If-Match':saved.etag});
          if (!response.ok && response.status !== 404) throw new Error(`Connection test cleanup failed (${response.status}). Remove ${path} from the storage folder.`);
        }
      }
    }
  }
  function catalog(state) {
    return {format:FORMAT, version:VERSION, workspace:state.manifest, documents:Object.entries(state.docs).map(([path, entry]) => {
      const value = record(path, entry.body);
      return {path, type:value.type, id:value.id, name:value.name, deleted:!!value.deleted};
    })};
  }
  class Engine {
    constructor(db, changed = () => {}) {
      this.db = db; this.changed = changed; this.state = null; this.adapter = null; this.busy = false;
      this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('caltasklog-workspaces') : null;
      if (this.channel) this.channel.onmessage = event => { if (event.data === this.state?.id) this.refresh().catch(error => this.changed(null, error)); };
    }
    async refresh() {
      const key = this.state.id, fresh = await this.db.get(key);
      if (this.state.id === key) { this.state = fresh; this.changed(this.state); }
      return this.state;
    }
    async select(key) { if (this.busy) throw new Error('Wait for sync to finish before switching workspaces.'); this.adapter = null; this.state = await this.db.get(key); this.changed(this.state); }
    async update(change) {
      const key = this.state.id;
      const next = await this.db.update(key, change);
      if (this.state.id === key) { this.state = next; this.changed(next); }
      this.channel?.postMessage(key);
      return next;
    }
    async edit(changes) {
      return this.update(state => {
        if (state.connection?.type === 'http') throw new Error('This workspace is read-only. Make a local copy to edit.');
        for (const change of changes) {
          record(change.path, change.body);
          const previous = state.docs[change.path];
          if (previous?.body === change.body) continue;
          if (Object.hasOwn(change, 'expected') && (previous?.body ?? null) !== change.expected) {
            state.docs[change.path] = {...previous, body:change.body, dirty:true, conflict:{body:previous?.body ?? null, etag:previous?.etag ?? null, source:'device'}};
          } else state.docs[change.path] = {...previous, body:change.body, etag:previous?.etag ?? null, dirty:true};
        }
        return state;
      });
    }
    async sync(adapter = this.adapter) {
      if (this.busy) return;
      if (!adapter || this.state.connection?.type !== 'webdav') throw new Error('Connect WebDAV with session credentials first.');
      if (!globalThis.navigator?.locks) throw new Error('This browser needs Web Locks support for safe synchronization. Use a current browser over HTTPS.');
      this.busy = true; this.changed(this.state);
      try {
        await navigator.locks.request('ctl-sync:' + adapter.base, async () => {
          await this.refresh();
          const remoteManifest = await adapter.read('workspace.json');
          if (!remoteManifest || manifest(JSON.parse(remoteManifest.body)).id !== this.state.manifest.id) throw new Error('The remote workspace identity changed. Reconnect without uploading.');
          await this.update(state => { state.manifest = manifest(JSON.parse(remoteManifest.body)); return state; });
          const paths = new Set([...await adapter.list(), ...Object.keys(this.state.docs)]);
          for (const path of paths) {
            const remote = await adapter.read(path);
            if (remote) record(path, remote.body);
            if (remote && (!remote.etag || remote.etag.startsWith('W/'))) throw new Error(`Strong ETag is missing for ${path}. Check the server’s CORS configuration.`);
            const snapshot = (await this.db.get(this.state.id)).docs[path];
            if (snapshot?.conflict?.source === 'device') continue;
            if (!snapshot?.dirty) {
              await this.update(state => {
                if (state.docs[path]?.dirty) return state;
                if (remote) state.docs[path] = {...remote, dirty:false};
                else if (state.docs[path]) state.docs[path] = {body:tombstone(path, state.docs[path].body), etag:null, dirty:false};
                return state;
              });
              continue;
            }
            if (remote?.body === snapshot.body) {
              await this.update(state => {
                const current = state.docs[path];
                current.etag = remote.etag;
                if (current.body === snapshot.body) { current.dirty = false; delete current.conflict; }
                return state;
              });
              continue;
            }
            if ((remote?.etag ?? null) !== snapshot.etag || (remote && !remote.etag)) {
              await this.conflict(path, remote); continue;
            }
            try {
              const saved = await adapter.write(path, snapshot.body, snapshot.etag);
              await this.update(state => {
                const current = state.docs[path]; current.etag = saved.etag;
                if (current.body === snapshot.body) { current.dirty = false; delete current.conflict; }
                return state;
              });
            } catch (error) {
              if (error.status !== 412 && error.status !== 409) throw error;
              await this.conflict(path, await adapter.read(path));
            }
          }
          // Rebuild from remote resources, never from unsynced local edits.
          try {
            const remoteState = {manifest:this.state.manifest, docs:{}};
            for (const path of await adapter.list()) { const value = await adapter.read(path); if (value) { record(path, value.body); remoteState.docs[path] = value; } }
            const prior = await adapter.read('index.json');
            await adapter.write('index.json', json(catalog(remoteState)), prior?.etag ?? null);
            await this.update(state => { state.catalogError = ''; return state; });
          } catch (error) { await this.update(state => { state.catalogError = `Documents checked; catalog needs repair: ${error.message}`; return state; }); }
          await this.update(state => { state.lastSync = new Date().toISOString(); return state; });
        });
      } finally { this.busy = false; this.changed(this.state); }
    }
    async conflict(path, remote) {
      if (remote) record(path, remote.body);
      await this.update(state => { state.docs[path].conflict = {body:remote?.body ?? null, etag:remote?.etag ?? null, source:'remote'}; return state; });
    }
    async resolve(path, choice, merged, reviewed) {
      await this.update(state => {
        const entry = state.docs[path], conflict = entry?.conflict;
        if (!conflict) return state;
        if (reviewed && reviewed !== JSON.stringify([entry.body, conflict])) throw new Error('These versions changed while you were reviewing. Reopen Sync details and review them again.');
        if (choice === 'both') {
          const value = record(path, entry.body);
          // A second daily note becomes a template so both exact Markdown bodies survive.
          const copy = document(value.type === 'log' ? 'template' : value.type, `${value.name} (conflict copy)`, value.content);
          state.docs[copy.path] = {body:copy.body, etag:null, dirty:true};
        }
        if (choice === 'remote' || choice === 'both') entry.body = conflict.body ?? tombstone(path, entry.body);
        if (choice === 'merge') { record(path, merged); entry.body = merged; }
        entry.etag = conflict.etag;
        entry.dirty = conflict.source === 'device' || !['remote','both'].includes(choice);
        delete entry.conflict;
        return state;
      });
    }
  }
  async function readURL(value, request = fetch) {
    const source = url(value);
    async function get(target) {
      const response = await request(target, {credentials:'omit', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new HTTPError(response.status, target);
      const body = await response.text();
      if (new TextEncoder().encode(body).length > LIMIT) throw new Error('Remote document exceeds the size limit.');
      return body;
    }
    const body = await get(source);
    const state = workspace('Published workspace');
    if (new URL(source).pathname.endsWith('.json')) {
      const index = JSON.parse(body);
      if (index.format !== FORMAT || index.version !== VERSION || !Array.isArray(index.documents) || index.documents.length > 10000) throw new Error('Unsupported URL catalog.');
      state.manifest = manifest(index.workspace);
      const base = new URL('.', source).href;
      for (const entry of index.documents) {
        kind(entry.path);
        if (Object.hasOwn(state.docs, entry.path)) throw new Error('Duplicate catalog path.');
        const text = await get(new URL(entry.path, base).href);
        record(entry.path, text); state.docs[entry.path] = {body:text, etag:null, dirty:false};
      }
    } else {
      state.manifest.name = decodeURIComponent(new URL(source).pathname.split('/').pop()) || 'Published plan';
      const item = document('plan', state.manifest.name, body, 'published-plan');
      state.docs[item.path] = {body:item.body, etag:null, dirty:false};
    }
    state.connection = {type:'http', url:source};
    return state;
  }
  const api = {FORMAT, VERSION, LIMIT, TOMBSTONE, id, json, clone, validDate, kind, record, document, tombstone, manifest, workspace, Database, Engine, WebDAV, HTTPError, url, catalog, readURL};
  root.CTLStorage = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
