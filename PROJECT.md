https://claude.ai/share/48006fe3-b8ff-478a-9bcb-f001273c623f

# BookmarkSync — Project Context

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

The extension can export/import bookmarks as a JSON file on the local filesystem. This covers:
- Single-machine backup
- Manual sync between machines (copy the file yourself via USB, Syncthing, Dropbox, etc.)
- Zero trust required — nothing ever leaves the machine

This is the simplest possible thing and covers a large fraction of use cases.

### Tier 2 — Sync Server (optional)

A minimal HTTP server that stores one encrypted blob per UUID. The client generates the UUID; the server never knows who you are. The blob is AES-256-GCM encrypted client-side before upload — the server sees only ciphertext.

The server is genuinely stateless from a business logic perspective: it's a key-value store over HTTP, nothing more.

---

## Explicit Non-Goals

- No mobile app (extension only, at least to start)
- No bookmark sharing / public links (complexity not worth it)
- No conflict resolution beyond last-write-wins (same as xBrowserSync — keeps it simple)
- No accounts, email, passwords on the server
- No database
- No web UI on the server
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

The client stores a `lastModified` timestamp locally. On sync:
1. Fetch the server's `lastModified` header
2. If server is newer → download and replace local bookmarks
3. If local is newer → encrypt and upload
4. If equal → do nothing

This is sufficient for the primary use case (one person, a few machines). Race conditions are possible but rare and recoverable.

---

## Server Design

### Language: Go

Single static binary, no runtime, no dependency manager on the server. Compiles to ~6MB. Runs indefinitely on a €5 VPS with negligible CPU/memory.

### Storage: Flat files

Each sync ID maps to one file: `data/{uuid}.blob`

No database. No ORM. No migrations. A UUID is a 36-character string; 10,000 users = 10,000 files in one directory, trivially handled by any filesystem.

### Infrastructure

- **Caddy** as reverse proxy for automatic HTTPS / Let's Encrypt (one config file)
- **systemd** service for the Go binary (auto-restart on crash)
- No Docker required (optional but not needed for something this simple)

### API — Complete Specification

```
POST   /sync              Create new sync ID
                          Response: { "id": "uuid-v4", "lastModified": null }

GET    /sync/{id}         Download encrypted blob
                          Response: raw blob bytes (application/octet-stream)
                          Headers: Last-Modified
                          404 if not found

PUT    /sync/{id}         Upload encrypted blob
                          Body: raw blob bytes (application/octet-stream)
                          Max body: 2MB
                          Response: { "lastModified": "RFC3339 timestamp" }

DELETE /sync/{id}         Delete sync data
                          Response: 204 No Content

GET    /sync/{id}/info    Lightweight check — no body download
                          Response: { "lastModified": "RFC3339 timestamp" }

GET    /status            Server health check
                          Response: { "status": "online", "version": "1.0.0", "maxSyncSize": 2097152 }
```

No authentication beyond the UUID itself (unguessable = bearer token). The UUID is generated client-side (crypto.randomUUID()) and never stored server-side in any user-linked way.

### Rate Limiting

- Max 1 PUT per sync ID per 30 seconds (in-memory, resets on restart — fine for this use case)
- Max body size: 2MB (enforced by Go's http.MaxBytesReader)
- No rate limiting on GET (reads are cheap; caching headers help)

### Server Code Sketch

```go
package main

import (
    "encoding/json"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "sync"
    "time"

    "github.com/google/uuid"
)

const (
    maxSyncSize = 2 * 1024 * 1024 // 2MB
    dataDir     = "./data"
    version     = "1.0.0"
)

var (
    rateLimits   = make(map[string]time.Time)
    rateLimitsMu sync.Mutex
)

func main() {
    os.MkdirAll(dataDir, 0755)

    mux := http.NewServeMux()
    mux.HandleFunc("POST /sync", handleCreate)
    mux.HandleFunc("GET /sync/{id}", handleGet)
    mux.HandleFunc("PUT /sync/{id}", handlePut)
    mux.HandleFunc("DELETE /sync/{id}", handleDelete)
    mux.HandleFunc("GET /sync/{id}/info", handleInfo)
    mux.HandleFunc("GET /status", handleStatus)

    http.ListenAndServe(":8080", mux)
}

func blobPath(id string) string {
    return filepath.Join(dataDir, id+".blob")
}

func isValidUUID(s string) bool {
    _, err := uuid.Parse(s)
    return err == nil
}

func handleCreate(w http.ResponseWriter, r *http.Request) {
    id := uuid.New().String()
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{"id": id, "lastModified": nil})
}

func handleGet(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if !isValidUUID(id) { http.Error(w, "invalid id", 400); return }
    path := blobPath(id)
    f, err := os.Open(path)
    if err != nil { http.Error(w, "not found", 404); return }
    defer f.Close()
    stat, _ := f.Stat()
    w.Header().Set("Content-Type", "application/octet-stream")
    w.Header().Set("Last-Modified", stat.ModTime().UTC().Format(http.TimeFormat))
    io.Copy(w, f)
}

func handlePut(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if !isValidUUID(id) { http.Error(w, "invalid id", 400); return }

    // Rate limiting
    rateLimitsMu.Lock()
    if last, ok := rateLimits[id]; ok && time.Since(last) < 30*time.Second {
        rateLimitsMu.Unlock()
        http.Error(w, "rate limited", 429); return
    }
    rateLimits[id] = time.Now()
    rateLimitsMu.Unlock()

    r.Body = http.MaxBytesReader(w, r.Body, maxSyncSize)
    data, err := io.ReadAll(r.Body)
    if err != nil { http.Error(w, "body too large or read error", 400); return }

    if err := os.WriteFile(blobPath(id), data, 0644); err != nil {
        http.Error(w, "storage error", 500); return
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{"lastModified": time.Now().UTC().Format(time.RFC3339)})
}

func handleDelete(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if !isValidUUID(id) { http.Error(w, "invalid id", 400); return }
    os.Remove(blobPath(id))
    w.WriteHeader(204)
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    if !isValidUUID(id) { http.Error(w, "invalid id", 400); return }
    stat, err := os.Stat(blobPath(id))
    if err != nil { http.Error(w, "not found", 404); return }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{"lastModified": stat.ModTime().UTC().Format(time.RFC3339)})
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{
        "status": "online", "version": version, "maxSyncSize": maxSyncSize,
    })
}
```

This is the near-complete server. Real implementation adds CORS headers, request logging, and graceful shutdown — but the logic above is essentially it.

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
  background.js         # Service worker: handles alarms, sync logic
  popup/
    popup.html          # Settings UI: sync ID, passphrase, server URL, status
    popup.js
    popup.css
  lib/
    crypto.js           # AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
    bookmarks.js        # chrome.bookmarks read/write helpers
    sync.js             # Core sync logic (upload/download/compare)
    storage.js          # chrome.storage.local wrapper (settings, lastModified)
  icons/
    icon-16.png
    icon-48.png
    icon-128.png
```

### manifest.json sketch

```json
{
  "manifest_version": 3,
  "name": "BookmarkSync",
  "version": "1.0.0",
  "description": "Simple, private bookmark sync",
  "permissions": ["bookmarks", "storage", "alarms"],
  "host_permissions": [],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "48": "icons/icon-48.png" }
  }
}
```

Note: `host_permissions` is empty because the sync server URL is user-configurable and we request permission dynamically, or we can use `"<all_urls>"` — TBD.

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

The extension uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) to read/write a JSON file. The user picks a file location once; the handle is persisted via `chrome.storage.local`.

The local file is **not encrypted** by default (it's on your own machine), but can optionally use the same encryption as the server mode.

Local file format is identical to the server blob format (minus encryption), so migrating between modes is trivial.

---

## Settings (stored in chrome.storage.local)

```json
{
  "mode": "local" | "server",
  "syncId": "uuid-v4",
  "passphrase": "...",
  "serverUrl": "https://sync.yourdomain.com",
  "autoSync": true,
  "syncIntervalMinutes": 30,
  "lastModified": "RFC3339 timestamp",
  "lastSyncStatus": "success" | "error" | "never"
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
Description=BookmarkSync API
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

# On server
scp bookmarksync user@server:/opt/bookmarksync/
systemctl restart bookmarksync
```

Zero downtime deploys: the new binary is a single file copy + service restart (~100ms).

---

## Compatibility Notes

- **Chrome**: MV3 required. Service workers supported since Chrome 88.
- **Firefox**: MV3 supported since Firefox 109 (May 2023), though Firefox still accepts MV2. We target MV3 for future-proofing.
- **Safari**: Would need a separate build via Xcode's web extension converter. Not a priority.
- **`chrome.bookmarks` API**: Works identically in Chrome and Firefox (Firefox implements the Chrome extension APIs). No browser-specific code needed for bookmark access.

---

## Project Status

- [ ] Server: Go implementation
- [ ] Extension: manifest + service worker scaffold
- [ ] Extension: crypto module
- [ ] Extension: bookmark read/write
- [ ] Extension: sync logic
- [ ] Extension: popup UI
- [ ] Extension: local file mode
- [ ] Testing: Chrome
- [ ] Testing: Firefox
- [ ] Server: deployment scripts
- [ ] Chrome Web Store submission
- [ ] Firefox Add-ons submission

---

## Reference

- [xBrowserSync app repo](https://github.com/xbrowsersync/app) — original source, study for UI patterns and bookmark handling
- [xBrowserSync API spec](https://github.com/xbrowsersync/api) — original API, ours is compatible but simplified
- [mBackstrom/xbsapi](https://github.com/mBackstrom/xbsapi) — Go reimplementation of xBS API, updated Nov 2025, worth reading
- [Chrome MV3 migration guide](https://developer.chrome.com/docs/extensions/develop/migrate)
- [Web Crypto API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [File System Access API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Caddy docs](https://caddyserver.com/docs/)
