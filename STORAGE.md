# Workspaces, storage, and data exchange

CalTaskLog is a static client. It does not run a storage server, issue signed URLs, or manage storage accounts. Host the app's HTML, CSS, JavaScript, and icon together on HTTPS (localhost HTTP is supported for development).

## Workspace controls

The workspace bar is available above all seven views:

- **Workspace selector / New workspace:** open recent local or remote workspaces and create a separate workspace.
- **Library:** search the full text of plans, daily notes, and templates; open, rename, duplicate, delete, or download a document. Search runs locally over cached documents. Deleted records can be shown but their deleted contents are not retained; use backups for recovery.
- **Storage:** connect a WebDAV folder, open an HTTPS plan or catalog, make a local copy, or disconnect.
- **Import / Export:** preview conversions, restore a complete workspace, or download native and interchange formats.
- **Sync details:** inspect pending uploads, last sync, catalog errors, and conflicting versions; retry or reconnect.

Daily logs and templates belong to the workspace, independently of the selected plan. UI preferences and the active plan are remembered on this device separately for each workspace. A workspace timezone supplies the default for plans without `@timezone`; a plan directive overrides it.

Existing browser-local storage is not migrated. The old keys are left untouched. New workspaces use IndexedDB; only local UI preferences and the active workspace selection use localStorage.

## File format, version 1

```text
workspace.json
index.json
plans/<id>.json
logs/YYYY/MM/YYYY-MM-DD.md
templates/<id>.json
```

`workspace.json` contains `format: "caltasklog"`, `version: 1`, a stable `id`, `name`, and IANA `timezone`.

Plan and template files are UTF-8 JSON envelopes:

```json
{
  "format": "caltasklog",
  "version": 1,
  "type": "plan",
  "id": "a-stable-id",
  "name": "Build season",
  "content": "@timezone=America/New_York\n! Build 2026\nSep 5: Build prototype\n",
  "lineIds": ["timezone-id", "schedule-id", "task-id", "blank-id"]
}
```

The original source string is preserved, including comments and newlines. Optional `lineIds` give calendar exports persistent identities for source lines; ordinary line edits, moves, and insertions retain matching identities. Identical duplicate lines and wholesale rewrites may require new identities. Templates use `type: "template"` and Markdown `content`. Daily log files contain plain Markdown.

Deletion is a conditional replacement at the same path: JSON documents receive `deleted: true` and empty content; daily logs become exactly `<!-- caltasklog:deleted:v1 -->`. This marker is reserved. Keeping tombstones prevents an offline device from treating an old document as a new file. Do not routinely remove tombstones while devices may still have unsynced copies.

`index.json` is a catalog with `format`, `version`, `workspace` (the manifest), and `documents` entries containing `path`, `type`, `id`, `name`, and `deleted`. WebDAV sync discovers authoritative files by listing folders and rebuilds the catalog from remote files after saving. A failed catalog write is reported separately. There is no transaction across the workspace's files; backups and remote sync capture individual document revisions, not a globally atomic multi-user snapshot.

## Connecting WebDAV

1. Create a dedicated folder in your external WebDAV service.
2. Open **Storage**, select **WebDAV**, and enter the folder URL and, if required, username and app password.
3. **Test connection** checks folder listing, a temporary file write/read, rejection of a deliberately stale revision, and cleanup.
4. **Connect / open** repeats the test. If `workspace.json` exists, the app opens that workspace (or reconnects its cache). An empty folder receives the current workspace. A folder containing documents but no manifest is rejected for repair.

Credentials are held only in the current tab's memory and are discarded on refresh, switching workspaces, or disconnecting. They are never written into IndexedDB, localStorage, remote documents, or backups. Use app-specific credentials over HTTPS. URL credentials, query strings, redirects, and fragments are not accepted. This means expiring signed URLs are not supported by the URL adapter.

The server must support `GET`, `PUT`, `PROPFIND`, `MKCOL`, and `DELETE`, plus browser `OPTIONS` preflight. Configure the storage service or its external reverse proxy to:

- Allow the app's exact origin through `Access-Control-Allow-Origin`.
- Allow those methods through `Access-Control-Allow-Methods`.
- Allow `Authorization`, `Content-Type`, `Depth`, `If-Match`, and `If-None-Match` request headers.
- Expose the `ETag` response header through `Access-Control-Expose-Headers`.
- Return strong ETags and honor `If-Match` and `If-None-Match: *` atomically.

Listing uses `Depth: 1` and walks only recognized document folders. The connection-test file is removed afterward; if cleanup fails, the app reports its exact path. A CORS/network failure may be indistinguishable to browser JavaScript; inspect the browser network panel and server configuration when troubleshooting. No CORS proxy is included in this project.

References: [Nextcloud WebDAV operations](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/WebDAV/basic.html), [browser CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [exposing ETag](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).

## Save and sync behavior

User edits are persisted to IndexedDB with their last observed remote revision and a dirty flag. Status distinguishes device saves, pending uploads, offline state, active sync, successful remote checks, failures, and conflicts. Cache errors are surfaced and unsaved changes prevent workspace switching or export until they can be saved.

WebDAV sync runs after edits settle, when the browser reconnects, when the tab becomes visible, once per minute while connected, or through **Retry / refresh**. It uses conditional creates and updates, and reads successful writes back before acknowledging them. If a connection drops after the server accepts a write, the next sync recognizes identical remote content. Edits made during an upload remain pending.

Web Locks serialize synchronization with the same URL between browser tabs. IndexedDB read/write transactions protect local updates. Stale tab edits and remote revision conflicts retain both versions. **Review versions** supports keeping either version, keeping both, or editing a merged JSON/Markdown document. A duplicate daily note is preserved as a template because only one log can occupy a date. Remote changes made after review are checked again during upload.

This is file synchronization for personal use or occasional overlapping edits, not live collaborative editing. All workspace documents are cached locally, so the current limits are 8 MiB per document, 10,000 discovered documents, 1,000 listed folders, and 64 MiB per backup/import. A browser cache is not a backup; export ZIPs or use your provider's backups/version history.

## Read-only URLs and publishing

**Storage → HTTPS URL** can open a `.txt` plan or an `index.json` catalog. Catalog paths are restricted to the native workspace layout. All reads use the supplied origin and no credentials; cross-origin browser access must be allowed by the host. The app caches the source locally and disables editing. Use **Make a local copy** to edit, or **Sync details → Retry / refresh** to reload the source.

To publish a workspace, unpack a native backup into an external HTTPS folder and share the URL to `index.json`. Publish the corresponding document folders as well. `backup.json` and `conflicts.json` are backup metadata and need not be published. A separately downloaded catalog is useful after updating the document files. A catalog cannot provide access control: configure that at the external hosting service. Only publish data you intend readers of that URL to access.

## Import and export

| Format | Behavior |
|---|---|
| Native ZIP | Complete versioned backup: manifest, catalog, documents, deletion records, and unresolved conflict alternatives. SHA-256 inventory plus ZIP CRCs detect corruption. Credentials, ETags, upload state, and local UI preferences are excluded. Restore starts with unsynced local documents. |
| Plan TXT | Imports as a named plan and previews parser errors/warnings. Exports the original source exactly. |
| Markdown | Imports as a daily log or template. A filename containing `YYYY-MM-DD` supplies the log date; otherwise choose a date. Library exports individual notes/templates; Today exports selected-day summaries; Export downloads all Markdown in a ZIP. |
| CSV | Import maps columns to name, dates, times, people, status, note, priority, color, link, type, and depth. Dates use `YYYY-MM-DD`; times use 24-hour `HH:mm`. Invalid rows are reported and skipped. Export is a resolved task/event report, with quoted fields and spreadsheet-formula protection. |
| ICS | Import supports representable VEVENTs, all-day dates, single-day timed events, floating times in the workspace timezone, UTC conversion, and the app's supported recurrence subset. Unsupported properties/components are reported. Export emits dated leaf tasks/events from selected schedules as VEVENTs; recurrences become bounded individual occurrences. |

Import always has a preview step. Default native restore creates a new local workspace. **Merge by ID/date** preserves overlaps for review; **Replace matching ID/date** downloads a backup before replacing matching documents and leaves unrelated documents alone. **Import as new** creates new plan/template IDs; daily notes retain their dates and overlapping notes still require review. Multiple files targeting the same date in one import are rejected so neither is silently dropped.

Native ZIP is the lossless exchange format. CSV cannot preserve comments or recurrence definitions. ICS does not preserve task hierarchy or meeting notes. Calendar export uses exclusive all-day ends, UTC timed values, escaped/folded UTF-8 lines, and stable source identities. Ambiguous/nonexistent clock-change times are reported and omitted instead of guessing. Imports with recurrence exceptions, `DURATION`, different named timezones, timed multi-day events, UTC recurrence, or timed `UNTIL` are reported for manual conversion. Calendar export is a snapshot, not a CalDAV subscription or bidirectional calendar sync.

ZIP export uses standard uncompressed entries, requiring no runtime library. Import also accepts deflated native backups when the browser supports `DecompressionStream('deflate-raw')`. Import rejects unsafe paths, duplicate entries, unsupported versions, corruption, excessive sizes, and inventory mismatches. The all-Markdown ZIP is a convenience export, not a native workspace backup.

Format references: [iCalendar / RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), [CSV / RFC 4180](https://www.rfc-editor.org/rfc/rfc4180).

## Development and verification

The app has no external runtime dependencies. `storage.js` implements the native format, IndexedDB cache, WebDAV/URL adapters, and sync engine. `transfer.js` handles archives and interchange formats. `workspace-ui.js` and `workspace.css` add the workspace controls; the existing parser and views remain in `index.html`.

Run the deterministic storage and transfer regressions:

```powershell
node --test tests/storage.test.cjs
```

The browser integration test uses Playwright and an installed Chrome, starts temporary local static/WebDAV fixtures, and checks cross-origin requests without accessing an external account:

```powershell
# Point this at an existing Playwright installation if it is not locally resolvable.
$env:CTL_PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
node tests/browser.cjs
```

Test fixtures are in-memory and exist only for the test process. They are not a production storage implementation. Generated screenshots are ignored by Git.
