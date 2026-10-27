# Browser Sync — Project Context

A self-hosted bookmark sync extension for Chromium-based browsers.
Encrypts bookmarks client-side (AES-256-GCM) and syncs via a lightweight Go server.

---

## Machines

| Name | Role | Notes |
|------|------|-------|
| hp3  | Primary dev machine (this one) | Linux Mint 21.3, x86_64 |
| hp4  | Secondary dev machine (upstairs laptop) | Same OS family |
| DR1  | VPS — sync server | Debian 12, x86_64, 2GB RAM, 30GB disk |

---

## SSH access

The DR1 VPS is in `~/.ssh/config` and reachable as:

```
ssh dr1
```

Full config entry (for reference when setting up hp4):

```
# DR1 - Bookmarks sync server (2GB RAM, 30GB disk, Debian 12)
Host DR1 dr1
    HostName 198.23.202.164
    User root
    Port 22
    IdentityFile ~/.ssh/id_rsa
    IdentitiesOnly yes
```

---

## Server (Go binary on DR1)

- Binary: `/opt/bookmarksync/bookmarksync`
- Source copy: `/opt/bookmarksync/main.go` (for reference only — not compiled on VPS)
- Data dir: `/opt/bookmarksync/data/` — one `.blob` + one `.rev` file per sync ID (old `.hash` files are legacy)
- Service: `systemctl {start|stop|restart|status} bookmarksync`
- Caddy sits in front as reverse proxy (handles HTTPS for `sync.satoshihost.com`)

**Go is NOT installed on DR1.** Compile locally on hp3/hp4 and deploy the binary.

---

## Go installation (hp3 — already done)

Go 1.26.5 is installed at `/usr/local/go`. PATH is set in `~/.profile`.

```bash
go version   # should print go1.26.5 linux/amd64
```

### To install Go on hp4 (or any new machine)

```bash
cd /tmp
wget https://go.dev/dl/go1.26.5.linux-amd64.tar.gz
# Verify checksum:
echo "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053  go1.26.5.linux-amd64.tar.gz" | sha256sum -c
# Install:
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.26.5.linux-amd64.tar.gz
# Add to PATH (once):
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile
source ~/.profile
go version
```

---

## Build & deploy workflow

From the `server/` directory on hp3 or hp4:

```bash
# 1. Build (produces ./bookmarksync binary)
cd /home/andy/work/projects/browser-sync/server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bookmarksync .

# 2. Stage on the VPS only after deployment approval
scp bookmarksync dr1:/opt/bookmarksync/bookmarksync.new
```

Before activation, preserve the existing binary and data in uniquely named backups. Activate the staged binary by renaming it over the executable, restart `bookmarksync`, and verify service health. Copy `main.go` afterward to keep the source reference current. Do not overwrite a running binary directly with scp ("Text file busy"); staging and rename avoids stopping the service during transfer. Deployment and restart require explicit user approval.

---

## Sync design — change detection

Bookmarks are encrypted client-side before upload. Because AES-GCM uses a random nonce,
the same content encrypted twice produces different bytes — so the server can't detect
changes by comparing blob bytes.

**Solution:** The server maintains a monotonic revision counter (`{id}.rev` sidecar file).
Every `PUT /sync/{id}` increments `rev` by 1 and returns `{ "rev": newRev }`.
The `/sync/{id}/info` endpoint returns `{ "rev": currentRev }`.

Each browser stores `lastSyncRev`, `localDirty`, and `syncDataVersion` in local storage.
- A new browser or one without `syncDataVersion: 2` must explicitly choose an initial upload or download. Old saved revisions may describe stale cached content.
- If both the local bookmarks and the server revision changed, stop and ask the user to resolve the conflict; do not silently overwrite either copy.
- If only local bookmarks changed, upload with `X-Expected-Rev` set to their base revision. A concurrent server change produces HTTP 409.
- If only the server revision changed, download with `cache: 'no-store'` and record the `X-Sync-Rev` header attached to that exact response, never the earlier `/info` revision.
- If neither changed, report unchanged without rewriting bookmarks.

All sync fetches bypass HTTP caches and have a 20-second timeout. Server API responses send `Cache-Control: no-store`; downloads expose `X-Sync-Rev` through CORS. GET copies the blob and its revision under the same server mutex used by PUT/DELETE, then releases the lock before sending the response. This protects concurrent requests; separate blob/revision disk writes are not a crash-atomic transaction.

One worker queue handles alarms, Sync Now, explicit directions, local imports, and reset. The popup never performs network sync or bookmark restoration itself. Missing polling alarms are restored at worker startup, browser startup, and configuration changes. Bookmark edits during network work remain dirty, including edits made after an upload snapshot was taken. Retries use alarms, not just in-memory timers.

During full-tree restoration, bookmark events are suppressed. Avoid editing bookmarks while a restore is running. `restorePending` is persisted before modification; failed/interrupted restores do not advance the revision and cannot upload a partial tree. Recovery preserves the pre-restore safety backup. Bookmark API and backup errors must propagate, not be logged as successful restores. This is snapshot replacement, not a per-bookmark merge system.

---

## Extension structure

```
extension/
  background.js       — service worker: debounced upload on bookmark change, periodic alarm
  lib/
    crypto.js         — AES-256-GCM encrypt/decrypt, PBKDF2 key derivation, hashContent()
    sync.js           — fetch wrappers: uploadBlob, downloadBlob, getInfo, checkServerStatus
    bookmarks.js      — Chrome bookmarks API helpers: restoreBookmarks, countBookmarks
  popup/
    popup.js          — manual Sync Now UI, settings, local backup export/import
    popup.html
    popup.css
  manifest.json
```

---

## Extensions — Chrome only

- **Chrome Extension**: [`extension/`](file:///home/andy/work/projects/browser-sync/extension) — Load in `chrome://extensions` (PRIMARY TARGET)
- **Firefox**: discontinued. `extension-firefox-not-continuing/` contains only a note explaining why; the last Firefox source lives in git history. Do not update or build Firefox packages unless the user explicitly revives the port.

If the Firefox port is ever revived, the relevant differences: Firefox MV3 uses `"background": { "scripts": [...] }` instead of a service worker, and root folders map as Chrome `"Bookmarks bar"` ↔ Firefox `"Bookmarks Toolbar"`, `"Other bookmarks"` ↔ `"Other Bookmarks"`, with Firefox `"Bookmarks Menu"` falling back to a sensible destination.

---

## Browser resource usage

Idle checks fetch only revision metadata, without reading the bookmark tree or running crypto. The default interval is 10 minutes; 1 minute is supported for testing. HTTP/TLS overhead is additional to the small JSON body. Retry and debounced-change alarms can add checks.

Uploads read and encrypt the full tree. Downloads decrypt and restore the full tree with individual bookmark API calls, so large collections may take meaningful CPU time and allocations. PBKDF2 uses 100,000 iterations. No reliable per-device CPU/RAM benchmark has been recorded; do not claim zero resource usage or a fixed daily CPU budget.

Chromium can terminate idle MV3 workers, but extension metadata still has overhead and DevTools can keep workers alive. Firefox uses a different background implementation. Test automatic scheduling with DevTools closed as well as open.

## Server API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/sync` | Create new sync ID |
| GET | `/sync/{id}` | Download blob with paired `X-Sync-Rev` header |
| PUT | `/sync/{id}` | Upload blob with `X-Expected-Rev`; returns `{ "rev": N }` |
| GET | `/sync/{id}/info` | Returns `{ "rev": N }` — lightweight change check |
| DELETE | `/sync/{id}` | Remove blob, revision sidecar, and legacy hash sidecar |
| GET | `/status` | Server health check |

## Verification and cache-fix rollout (2026-09-27)

Version 1.0.1 contains the cache/coordination fix in both extension directories and the server. Deployed to DR1 with user approval on 2026-09-27. The service was briefly stopped for a consistent backup, the staged binary checksum was verified, and the service was restarted successfully. Public HTTPS `/status` reports 1.0.1; `/info` and the download both reported revision 191, with `Cache-Control: no-store` and an exposed `X-Sync-Rev` download header. Archive comparison confirmed deployment did not modify the sync data. Live service reported zero automatic restarts after activation.

Pre-deployment backup on DR1: `/opt/bookmarksync/deploy-1.0.1-MdvsdfzJ/before-deploy.tar.gz` (root-only permissions; contains the previous binary, main.go, and data directory). Preserve this backup. Restoring the binary or data requires separate explicit approval; do not roll back bookmark data automatically.

User-confirmed live smoke tests passed on hp3 with Chromium, Brave, and Brave Origin, all running extension 1.0.1 at a one-minute interval:
- Fresh server downloads restored the correct bookmarks in all three browsers.
- Folder creation and adding a bookmark propagated automatically from Chromium.
- Bookmark deletion from Brave propagated, preserving the empty folder.
- Empty-folder deletion from Brave Origin propagated to the other browsers.
- Changes made in Chromium while the other browsers were closed appeared automatically when they restarted, without pressing Sync Now. The worker deliberately checks on browser startup.
- Folder renaming and moving a bookmark out onto the bookmarks bar propagated successfully.

These results cover the basic Chromium-family workflows, not all failure scenarios or long-term reliability. Live Firefox testing and hp4 rollout/testing are still unconfirmed. Existing ZIP packages have not been rebuilt; use the updated source directories and verify extension version 1.0.1.

Confirmed incident: Brave recorded revision 191 while normal GET returned a cached blob dated 26 September; a `no-store` GET returned different bytes dated 27 September while `/info` remained 191. A separate missing `autoSync` alarm was also confirmed after extension reload plus Force Download.

Verification commands from the repository root:

```bash
python3 tools/test_extension_sync.py
(cd server && /usr/local/go/bin/go test -race ./...)
(cd server && /usr/local/go/bin/go vet ./...)
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 /usr/local/go/bin/go build -o bookmarksync .)
```

The Python runner uses only the standard library and an installed Chromium/Chrome binary. It creates a temporary browser profile and a loopback HTTP server; no personal browser profile or VPS data is used. It tests both source trees with mocked extension APIs, actual popup DOM, and an actual HTTP-cache regression. It does not replace live testing inside Firefox or installed extensions.

Rollout order:
1. Obtain explicit approval before changing the live VPS. Preserve a server/data backup and stage the new binary before replacing the running executable and restarting the service.
2. Deploy the server first: new clients reject downloads without the paired revision header. Existing blob/revision files remain compatible. Keep the old browser versions from writing during the coordinated upgrade.
3. Export local bookmark backups, then reload version 1.0.1 in every participating browser/profile, including hp4. Do not mix old and new writers indefinitely; old clients do not enforce upload revision preconditions.
4. Each browser shows a one-time fresh-copy choice. If the server copy is correct, choose Download from server. Upload is only for an explicit decision to replace the server copy. Do not reset settings or edit revision values in the console to bypass this step.
5. At a one-minute interval, create a uniquely named test bookmark in one browser; verify it appears in another automatically. Delete that test bookmark and verify automatic removal. Repeat in the opposite direction, then restart browsers and repeat with DevTools closed. Reopen the console only afterward to inspect alarms/revisions/errors if needed.

Future optional sync types should remain opt-in modules within each browser's extension package. Bookmark-only users should not pay for unnecessary polling or permissions. Defer new sync features until this baseline is reliable.
