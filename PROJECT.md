https://claude.ai/share/48006fe3-b8ff-478a-9bcb-f001273c623f

# Full Browser Sync — Project Context

> This document exists to give an AI coding assistant full context on the project's goals, architecture, decisions, and rationale. Read this before touching any code.

---

## What This Is

A simple, privacy-first bookmark synchronisation tool — a clean-room rewrite of [xBrowserSync](https://www.xbrowsersync.org/), which has been abandoned (last real release May 2020, never updated to Manifest V3, now broken in Chrome).

The guiding principle is **radical simplicity**. xBrowserSync's appeal was that it just worked, had no account, and stored nothing readable on the server. We want to preserve that philosophy while fixing the technical debt and adding a local-first tier.

---

## What xBrowserSync Did (and Why It Mattered)

- Browser extension (Chrome + Firefox) that synced your bookmarks across machines
- No account, no login — just a UUID and a passphrase
- End-to-end encrypted: the server stored only ciphertext, never plaintext
- Anyone could self-host the server
- Distinguishing feature: **it was invisible and simple**. Set it up once, forget about it.

It died because:
- Never migrated from Manifest V2 to Manifest V3 (now required by Chrome)
- Node.js/MongoDB server rotted from dependency neglect
- Maintainer went silent ~2022

---

## Two-Tier Architecture

### Tier 1 — Local Only (no server needed)

The first local-only release is deliberately manual: the extension exports/imports bookmarks as a JSON file using the browser's standard Save As and file-picker dialogs. This covers:
- Single-machine backup
- Manual sync between machines (copy the file yourself via USB, Syncthing, Dropbox, etc.)
- Zero trust required — nothing ever leaves the machine

This is the simplest possible thing and covers a large fraction of use cases.

#### Local import safety and behaviour

- Import is a full replacement: the destination browser is made to match the selected backup, including deletions.
- Before replacement, the extension always creates a dated `before-import-*.json` safety backup.
- The user can choose a location for that safety backup (the default), or save it automatically to the browser's Downloads folder.
- A browser extension cannot discover the folder selected in the import file picker, so it cannot silently save the safety backup beside the imported file.

Future local-only automatic sync would require an optional native companion application to safely read and write a user-selected folder. It is explicitly out of scope for the first release.

### Practical manual workflow (current)

For the time being, a user may keep one chosen backup JSON file in a folder synchronised by a tool such as Syncthing. After making changes in one browser, export a new backup deliberately and import it into the other browsers. This remains a manual full-replacement workflow; the extension creates a safety backup before every import. A future optional native companion application can make a selected local folder automatic without weakening browser security.

### Tier 2 — Sync Server (optional)

A minimal HTTP server that stores one encrypted blob per UUID. The client generates the UUID; the server never knows who you are. The blob is AES-256-GCM encrypted client-side before upload — the server sees only ciphertext.

The server is genuinely stateless from a business logic perspective: it's a key-value store over HTTP, nothing more.

---

## Explicit Non-Goals

- No mobile app (extension only, at least to start)
- No bookmark sharing / public links (complexity not worth it)
- No automatic merge / conflict resolution — writes are last-write-wins, but concurrent-change conflicts are detected via the revision counter and surfaced as HTTP 409
- No accounts, email, passwords on the server
- No database
- No server-side UI or accounts — the read-only `www/index.html` Web Viewer is a static page that decrypts in the browser
- No analytics, telemetry, or tracking of any kind
- No monetisation complexity (cheap VPS, donation model if anything)

---

## Data Format

Bookmarks are serialised to JSON using the browser's native `chrome.bookmarks` tree format, then:
1. UTF-8 encoded
2. Compressed (optional, gzip) 
3. Encrypted with AES-256-GCM, key derived from passphrase via PBKDF2 (100,000 iterations, SHA-256)
4. Base64-encoded for transport

The JSON schema mirrors `chrome.bookmarks.BookmarkTreeNode` exactly — this makes import/export trivial and avoids any custom schema to maintain.

```json
{
  "version": 1,
  "created": "2025-01-01T00:00:00Z",
  "bookmarks": [ ...chrome.bookmarks tree... ]
}
```

The `version` field allows future schema changes without breaking existing clients.

---

## Sync Strategy

**Last write wins, full replacement.** The entire bookmark tree is replaced on each sync. No per-bookmark diffing, no merge logic. This is the same approach xBrowserSync used and it's the right call — merge logic is where complexity explodes (see: floccus).

Each browser stores `lastSyncRev` (the server revision of the last successful sync), `localDirty` (whether local bookmarks changed since then), and `syncDataVersion` (currently `2`) locally. On sync:
1. Read the current server revision from `GET /sync/{id}/info` (or the `X-Sync-Rev` header of a download).
2. If both the local bookmarks and the server revision changed since the last sync → stop and surface the conflict; never silently overwrite.
3. If only local changed → upload with `X-Expected-Rev` set to the base revision; a concurrent server change returns HTTP 409.
4. If only the server changed → download with `cache: 'no-store'` and record the `X-Sync-Rev` of that exact response (not a later `/info` read).
5. If neither changed → report "already in sync".

A browser without `syncDataVersion: 2` (a new install, or pre-revision data) must explicitly choose an initial upload or download.

For the primary use case (one person, a few machines) this is sufficient — and the revision counter turns what would be a silent overwrite into a detectable 409 conflict.

## Future Import Review

After the manual-replacement workflow is proven, add a pre-import change review. It should group bookmarks that would be added and destination-only bookmarks that would be removed, with bulk choices first. Individual selection is a later enhancement; the initial import action stays "make this browser match the file."

---

## Server Design

### Language: Go

Single static binary, no runtime, no dependency manager on the server. Compiles to ~6MB. Runs indefinitely on a €5 VPS with negligible CPU/memory.

### Storage: Flat files

Each sync ID maps to two files: `data/{id}.blob` (ciphertext) and `data/{id}.rev` (a monotonic revision counter).

No database. No ORM. No migrations. An `id` is either a UUID v4 or a custom 3–64 character name, so at most 64 characters; 10,000 users = 20,000 files in one directory, trivially handled by any filesystem.

### Infrastructure

- **Caddy** as reverse proxy for automatic HTTPS / Let's Encrypt (one config file)
- **systemd** service for the Go binary (auto-restart on crash)
- No Docker required (optional but not needed for something this simple)

### API — Complete Specification

```
POST   /sync              Create new sync ID
                          Response: { "id": "uuid-v4", "rev": 0 }

GET    /sync/{id}         Download encrypted blob
                          Response: raw blob bytes (application/octet-stream)
                          Headers: X-Sync-Rev (paired revision), Cache-Control: no-store
                          404 if not found

PUT    /sync/{id}         Upload encrypted blob
                          Body: raw blob bytes (application/octet-stream)
                          Max body: 2MB
                          Headers: X-Expected-Rev (mismatch → HTTP 409)
                          Response: { "rev": N }

DELETE /sync/{id}         Delete sync data
                          Response: 204 No Content

GET    /sync/{id}/info    Lightweight check — no body download
                          Response: { "rev": N }

GET    /status            Server health check
                          Response: { "status": "online", "version": "1.0.1", "maxSyncSize": 2097152 }
```

No authentication beyond the Sync ID itself. A Sync ID may be a random UUID v4 generated client-side, or a custom 3–64 character name (`[A-Za-z0-9_-]`) — so memorable IDs like `andy` are allowed, which means a guessable ID relies on a strong passphrase. The server never links an ID to a user and never receives the passphrase.

### Rate Limiting

- Max 1 PUT per sync ID per 5 seconds (in-memory, resets on restart — fine for this use case)
- Max body size: 2MB (enforced by Go's http.MaxBytesReader)
- No rate limiting on GET (reads are cheap; caching headers help)

### Server Code Sketch

The complete, current implementation lives in [`server/main.go`](server/main.go) and is the single source of truth for server behaviour: flat-file storage (`{id}.blob` plus a `{id}.rev` revision sidecar), custom Sync ID validation, `X-Sync-Rev` on downloads and `X-Expected-Rev` with HTTP 409 conflict handling on uploads, `Cache-Control: no-store`, CORS, request logging, timeouts, rate limiting, and graceful shutdown.

---

## Extension Design

### Manifest V3 (required for Chrome)

MV3 replaces persistent background pages with **service workers**. Key implications:
- The background script (`background.js`) is a service worker — it can be killed by the browser at any time and must be stateless between invocations
- Use `chrome.storage.local` (not in-memory variables) for any persistent state
- Use `chrome.alarms` API for periodic sync (not `setInterval`, which dies with the service worker)

### File Structure

```
extension/
  manifest.json         # MV3 manifest
  background.js         # Service worker: alarms, debounced change listeners, sync
  popup/
    popup.html          # UI: Local backup tab, Sync tab, Settings tab
    popup.js            # All popup logic including server syncNow()
    popup.css
  lib/
    crypto.js           # AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
    bookmarks.js        # chrome.bookmarks helpers: restoreBookmarks, countBookmarks
    sync.js             # Server API client: uploadBlob, downloadBlob, getInfo
    storage.js          # chrome.storage.local wrapper
  icons/
    icon-16.png
    icon-48.png
    icon-128.png

server/
  main.go               # Complete Go server (flat-file storage, all API endpoints)
  go.mod

tools/
  merge_bookmark_exports.py  # One-off utility: merge and de-duplicate multiple exports

www/                    # Static Web Viewer + user guide served at sync.satoshihost.com
  favicons/
```

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Full Browser Sync",
  "version": "1.0.2",
  "description": "Privacy-first bookmark synchronization. No account, end-to-end encrypted.",
  "permissions": ["bookmarks", "storage", "alarms", "downloads"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
  },
  "icons": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
}
```

`"downloads"` is required for the Save As export and the automatic safety backup before import. `"<all_urls>"` covers user-configured self-hosted server URLs; this permission will need justification on Chrome Web Store submission.

### Crypto (crypto.js sketch)

```javascript
const PBKDF2_ITERATIONS = 100000;
const SALT = new TextEncoder().encode("bookmarksync-v1"); // fixed salt is fine; passphrase is the secret

async function deriveKey(passphrase) {
  const raw = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(passphrase, plaintext) {
  const key = await deriveKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  // Prepend IV to ciphertext for storage
  const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.byteLength);
  return result;
}

async function decrypt(passphrase, data) {
  const key = await deriveKey(passphrase);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
```

Uses the **Web Crypto API** — available in both extension service workers and regular extension pages. No external crypto library needed.

---

## Local File Mode

Export and import use the browser's own download and file-picker dialogs — no third-party APIs.

**Export** calls `chrome.downloads.download({ saveAs: true })`, which opens the browser's native Save As dialog. The file is a plain JSON backup (not encrypted — it stays on the user's machine).

**Import** uses an `<input type="file">` picker. After the user selects a file, the extension validates it, saves a dated safety backup via `chrome.downloads`, then does a full-replacement restore.

The local backup format is identical to the server blob format (minus the encryption layer), so switching between local and server mode is trivial.

> **Why not the File System Access API?** That API could theoretically persist a chosen directory handle, but Chrome requires a fresh user gesture to re-grant access each browser session and the behaviour has changed repeatedly. The downloads/file-picker approach is stable, works in all Chromium browsers, and requires no extra permissions beyond `"downloads"`.

Automatic local-folder sync (e.g. watching a Syncthing folder) requires a native companion application. It is explicitly out of scope for the extension alone.

---

## Settings (stored in chrome.storage.local)

```json
{
  "syncMode": "Server" | "None",
  "syncId": "uuid-v4",
  "passphrase": "...",
  "serverUrl": "https://sync.yourdomain.com",
  "autoSync": true,
  "syncInterval": 10,
  "lastSyncRev": 0,
  "syncDataVersion": 2,
  "localDirty": false,
  "lastSync": "ISO timestamp — last sync attempt",
  "lastSyncError": "error message from last failed sync, if any"
}
```

The passphrase is stored in `chrome.storage.local` (encrypted storage within the browser profile). This is the same approach xBrowserSync used and is acceptable — if someone has access to your browser profile, they have your bookmarks anyway.

---

## Server Deployment

### Requirements
- Any Linux VPS (1 vCPU, 512MB RAM is plenty — €3-5/month)
- Go 1.22+ (only needed to compile; the binary runs standalone)
- Caddy (for HTTPS)

### Caddyfile
```
sync.yourdomain.com {
    reverse_proxy localhost:8080
}
```
That's it. Caddy handles Let's Encrypt automatically.

### systemd service
```ini
[Unit]
Description=Full Browser Sync API
After=network.target

[Service]
Type=simple
User=bookmarksync
WorkingDirectory=/opt/bookmarksync
ExecStart=/opt/bookmarksync/bookmarksync
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Building & deploying
```bash
# On dev machine (cross-compile for Linux amd64)
GOOS=linux GOARCH=amd64 go build -o bookmarksync .

# Copy to server and restart (live server is DR1 — ssh dr1)
scp bookmarksync dr1:/opt/bookmarksync/
ssh dr1 'systemctl restart bookmarksync'
```

Zero downtime deploys: the new binary is a single file copy + service restart (~100ms).

---

## Compatibility Notes

- **Chrome**: MV3 required. Service workers supported since Chrome 88.
- **Firefox**: support is discontinued. The Firefox build was dropped after a Mozilla AMO policy rejection; see [`extension-firefox-not-continuing/`](extension-firefox-not-continuing/README.md). Development targets Chromium-based browsers.
- **Safari**: Would need a separate build via Xcode's web extension converter. Not a priority.
- **`chrome.bookmarks` API**: Works identically in Chrome and Firefox (Firefox implements the Chrome extension APIs). No browser-specific code needed for bookmark access.

---

## Project Status

See `PROGRESS.md` for the live tracker. Summary:

- [x] Server: Go implementation — deployed at sync.satoshihost.com
- [x] Extension: Manifest V3 + service worker scaffold
- [x] Extension: crypto module (AES-256-GCM + PBKDF2)
- [x] Extension: bookmark read/write helpers
- [x] Extension: local backup — export (Save As) and import (file picker + safety backup)
- [x] Extension: popup UI (Local backup tab, Sync tab, Settings tab)
- [x] Extension: server sync — upload, download, revision-based change detection, first-sync prompt
- [x] Extension: auto-sync on bookmark change (debounced, 5 s) and on alarm (default 10 min, configurable)
- [x] Tools: `tools/merge_bookmark_exports.py` — de-duplicate and merge multiple exports
- [x] Testing: Chrome/Chromium end-to-end (core sync loop verified)
- [ ] Testing: Firefox — discontinued
- [ ] Chrome Web Store submission
- [ ] ~~Firefox Add-ons submission~~ — discontinued
- [ ] Easy self-hosting: pre-built binaries, Docker image, .deb packages

---

## Reference

- [xBrowserSync app repo](https://github.com/xbrowsersync/app) — original source, study for UI patterns and bookmark handling
- [xBrowserSync API spec](https://github.com/xbrowsersync/api) — original API, ours is compatible but simplified
- [mBackstrom/xbsapi](https://github.com/mBackstrom/xbsapi) — Go reimplementation of xBS API, updated Nov 2025, worth reading
- [Chrome MV3 migration guide](https://developer.chrome.com/docs/extensions/develop/migrate)
- [Web Crypto API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [File System Access API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Caddy docs](https://caddyserver.com/docs/)
