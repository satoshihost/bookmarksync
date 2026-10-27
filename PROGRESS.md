# Full Browser Sync - Development Progress

**Last Updated:** 2026-10-27

> [!NOTE]
> **Firefox Status:** Firefox extension submission / packaging has been abandoned per user decision following Mozilla's generic AMO policy rejection. Primary development focus is 100% on Chromium-based browsers (`extension/`).

---

## ✅ COMPLETED

### Server (100% Complete)
- [x] Go server implementation (flat-file storage)
- [x] All API endpoints working
  - POST /sync (create sync ID)
  - GET /sync/{id} (download blob)
  - PUT /sync/{id} (upload blob)
  - DELETE /sync/{id} (delete)
  - GET /sync/{id}/info (metadata)
  - GET /status (health check)
- [x] Rate limiting (1 PUT per 5 seconds per ID)
- [x] Deployed to https://sync.satoshihost.com
- [x] HTTPS with Let's Encrypt (automatic via Caddy)
- [x] Security hardened (UFW, fail2ban, SSH keys)
- [x] Info page with favicons
- [x] systemd service (auto-restart)

**Server Location:** dr1 (198.23.202.164) - `/opt/bookmarksync/`

### Extension Structure (95% Complete)
- [x] Manifest V3 configuration
- [x] Icons (16x16, 48x48, 128x128)
- [x] Popup UI with tabs
  - [x] Sync tab (server configuration)
  - [x] Settings tab (statistics, danger zone)
- [x] Background service worker
- [x] All library modules created:
  - [x] crypto.js (AES-256-GCM + PBKDF2)
  - [x] sync.js (server API client)
  - [x] bookmarks.js (Chrome API helpers)
  - [x] storage.js (settings management)

### Extension Features
- [x] Generate sync IDs (UUID v4)
- [x] Save server settings
- [x] Bookmark counting
- [x] Tab switching
- [x] Settings persistence
- [x] Local bookmark export using the browser's Save As dialog
- [x] Local bookmark import using the browser's file picker
- [x] Pre-import safety backup, with a choice of Save As location or Downloads
- [x] Manual transfer tested: Brave profile → new Brave profile → original Brave profile, including additions and deletions
- [x] **Server sync — upload, download, timestamp comparison**
- [x] **First-sync prompt** (server has data → ask upload or download)
- [x] **Automatic periodic sync** via `chrome.alarms` (default 10 min, configurable)
- [x] **Sync on bookmark change** — debounced 5 s, upload only; `isBusy` flag prevents sync loops during restore
- [x] **localDirty flag** — replaces broken timestamp upload logic; clock-skew proof; background resets it after upload, popup resets it after download
- [x] **End-to-end auto-sync verified** — add/remove on Browser A, Browsers B and C auto-updated within 5 minutes via alarm
- [x] **Cross-Browser Root Folder Mapping** — Chrome `Bookmarks bar` $\leftrightarrow$ Firefox `Bookmarks Toolbar` / `Bookmarks Menu`
- [x] **Pre-restore payload validation & empty-tree safety guard** — prevents zero-bookmark payloads from wiping local browser bookmarks
- [x] **Auto pre-restore local safety backup & 1-click rollback UI** in popup
- [x] **Smart URL filtering** — strips Firefox `place:` smart bookmarks during sync to prevent Chromium API errors
- [x] Separate extension packages for Chrome (`extension/`) and Firefox (`extension-firefox/`)
- [x] `<all_urls>` host permission — supports self-hosted server URLs

### Repository & Documentation
- [x] GitHub repo: github.com/satoshihost/bookmarksync
- [x] Professional README
- [x] xBrowserSync tribute
- [x] Home server deployment guide
- [x] MIT License
- [x] PROJECT.md with full technical spec

---

## 🔨 IN PROGRESS

### Testing
Core sync loop confirmed working across 3 browsers. Remaining:
- [x] ~~Test in Firefox~~ — dropped, Firefox discontinued
- [ ] Test in Opera / Vivaldi
- [ ] Test edge cases: rate limiting, service worker sleep/wake, clock skew

---

## 📋 TODO (Post-MVP)

### Polish
- [ ] Better error messages
- [ ] Progress indicators during sync
- [ ] Sync status in popup (syncing/success/error)
- [ ] Last sync time display
- [ ] Network error handling

### Testing
- [x] Test in Chrome/Chromium — core sync loop verified
- [x] ~~Test in Firefox~~ — dropped, Firefox discontinued
- [ ] Test in Opera
- [ ] Test in Vivaldi

### Distribution
- [ ] **Landing/home page framing** — https://sync.satoshihost.com already covers the Web Viewer, User Guide & FAQ, Server & Extension, and Changelog tabs, so it effectively doubles as the landing page. Before store submission, decide whether to present it that way (and whether the popup's GitHub link should point there instead).
- [ ] **Chrome Web Store submission** — submit Full Browser Sync once the 1.0.2 changes have been fully tried out (Web Viewer docs, popup "Web Viewer" link, extension 1.0.2, site Changelog tab)
- [x] ~~Firefox Add-ons submission~~ — abandoned (Mozilla AMO policy rejection)
- [ ] Release binaries (Windows/Mac/Linux)
- [ ] Docker image
- [ ] .deb packages

### Features (Maybe)
- [x] Manual bookmark backup/export and full-replacement import
- [x] Sync on bookmark change
- [ ] Multiple sync profiles
- [ ] Bookmark conflict resolution UI

---

## ⏸️ DEFERRED

### Automatic Local File Sync
Deferred — browser extensions cannot silently keep an arbitrary user-selected file up to date. The implemented local mode is intentionally manual: export a JSON backup from one browser, then import it in another using standard browser dialogs. Automatic local-file sync would require an optional native companion application.

### Local Import Review
Planned after the replacement workflow has been tested further. Show source-only additions and destination-only removals before import, initially with grouped keep/remove choices and later optional per-bookmark selection.

---

## 🧪 TESTING NOTES

### Known Working
- Extension loads in Opera, Vivaldi, Chrome
- UI tabs work
- Settings save/load
- Sync ID generation
- Server API responds correctly
- Icons display properly

### 2026-09-15 Handoff — manual cross-device consolidation

- Public-facing product name changed to **Full Browser Sync** (manifest, popup, logs, and primary docs). Existing technical identifiers remain `bookmarksync` for deployment and compatibility: Go module, encryption salt, server URL, server directory/binary, and GitHub repository.
- Six intentional bookmark exports were gathered from three browsers on each of two machines (`hp3` and `hp4`). A verified de-duplicated union was created at:
  `/home/andy/Documents/Backups/browser data/browser-sync/full-browser-sync-unified-2026-09-15.json`
- The unified backup contains **1,332 unique URLs** and includes every URL present in those six exports. Safety/test backups in `originals/` and `before-import` were checked and had no additional URLs, so they were not merged. Originals remain untouched.
- Tomorrow: let Syncthing deliver that unified JSON to the other machine, then import the same file into each browser. Import is intentionally a full replacement and creates a safety backup first. Confirm each browser ends with the same bookmark count/tree.
- The one-off merger is retained as `tools/merge_bookmark_exports.py`. It prefers the first input's title/folder placement for any duplicate URL and appends URLs missing from later inputs.
- Immediate local use stays manual: keep one chosen export/union JSON in a Syncthing folder and import it deliberately after changes. Automatic local-folder synchronisation remains a future optional native companion/helper application; it is not feasible from an extension alone because browser extensions cannot silently read and rewrite an arbitrary chosen folder.

### 2026-09-17 Handoff — server sync implemented and verified

- **Server sync fully implemented**: `syncNow()` uploads/downloads with timestamp comparison. First-sync prompt asks user which direction when server already has data.
- **Auto-sync on bookmark change**: debounced 5 s, upload-only. `isBusy` flag prevents sync loops during restore. All four bookmark change events wired.
- **Auto-sync checkbox removed**: sync is always-on when configured. No toggle needed.
- **Sync Now reads from form fields** directly (not storage), so no need to click Save Settings first. Values are saved to storage as a side-effect of syncing.
- **Warning box added** to Sync tab reminding users to keep their ID and passphrase safe.
- **Server confusion resolved**: DNS for `sync.satoshihost.com` points to **DR1** (198.23.202.164), not es6. Bookmarksync was moved to DR1 on 2026-04-13. All docs and deploy commands updated to use `ssh dr1`.
- **es6 cleaned up**: bookmarksync binary, data directory, and systemd unit all removed from es6. Nothing left there.
- **Upload confirmed working**: blob `2d800de7-5bc4-4915-a1f4-e76a00d100e2.blob` on DR1 created successfully during first test sync.
- **PROJECT.md updated**: Local File Mode section rewritten to reflect actual implementation (downloads API + file picker, not File System Access API); manifest sketch corrected; settings schema corrected; status checklist updated; file structure expanded.
- **lib/bookmarks.js**: `restoreBookmarks` and `restoreNode` moved here from popup.js so both popup and background service worker share the same implementation.
- **manifest.json**: `host_permissions` changed to `<all_urls>` to support self-hosted server URLs.

### 2026-09-17 — Sync fix: localDirty flag replaces broken timestamp upload check

- **Root cause of "already up to date" bug**: `lastModified` is always set to the server's timestamp after a sync, so `localTime` can never be `> serverTime`. The upload branch was dead code — uploads never happened after the first sync regardless of local changes.
- **Fix**: replaced the broken timestamp comparison with a `localDirty` boolean in `chrome.storage.local`.
  - `onBookmarkChange` sets `localDirty = true` (in addition to scheduling the debounced sync).
  - A successful upload sets `localDirty = false`.
  - A successful download sets `localDirty = false`.
  - `performSync` (background) and `syncNow` (popup) upload when `localDirty` is true; download when `serverTime > lastModified`; skip only when neither is true.
  - No local machine clock involved in the upload decision — eliminates clock-skew as a failure mode.
- **Spurious upload prevention**: `downloadFromServer` (popup) now sends `lockSync`/`unlockSync` messages to the background so the bookmark change events fired during `restoreBookmarks` don't set `localDirty = true` and trigger an unnecessary upload.
- **Save Settings button removed** from the Sync tab — Sync Now already saves server settings as a side effect. A scoped Save button remains in the Settings tab for the sync interval.
- **Alarm management**: Sync Now now creates/refreshes the `autoSync` alarm after every successful sync, ensuring the periodic background sync is always running once configured.

### 2026-09-20 Handoff — core sync loop race conditions & root folder crash fixed, Web Viewer & Debug Mode added

- **Root folder crash fix (`lib/bookmarks.js`)**: Fixed `restoreBookmarks` to match root folders by title or index position and fallback to valid root folder IDs (`root.children[1].id` or `root.children[0].id`). Strictly eliminated invalid `parentId: "0"` calls that caused Chrome API crashes mid-restore.
- **`isBusy` event lockout fix (`background.js`)**: Removed post-restore delay so user edits made immediately after downloading a sync are captured instantly instead of being dropped.
- **MV3 sleep resilience (`background.js`)**: Added `pendingSync` alarm backup (`delayInMinutes: 0.1` / 6s) in `onBookmarkChange`. If Chrome suspends the service worker mid-debounce (within 5s), the alarm wakes the worker up 6s later to push the upload.
- **Server rate limit adjusted (`server/main.go`)**: Reduced PUT rate-limiting window from 30s to 5s per sync ID to support rapid test edits while preventing flood spam. Deployed updated binary to `DR1`.
- **Plaintext Debug Mode (`popup.html`, `popup.js`, `crypto.js`)**: Added toggle under Settings -> Debug & Testing. When enabled, raw bookmark JSON is stored unencrypted so `/opt/bookmarksync/data/{id}.blob` can be inspected via `cat` on DR1.
- **Web Bookmark Viewer (`www/index.html`)**: Deployed client-side Web Crypto bookmark tree viewer at `https://sync.satoshihost.com/`.
- **Force Download / Upload buttons (`popup.html`, `popup.js`)**: Added explicit `⬇ Force Download` and `⬆ Force Upload` buttons underneath `Sync Now` in the extension popup.
- **Extension Manager error badge fix (`background.js`)**: Switched network error logging in auto-sync from `console.error` to `console.warn` so transient network drops don't trigger red error badges in `chrome://extensions`.

### 2026-10-27 — Web Bookmark Viewer documented; extension bumped to 1.0.2

- **Web Viewer documented for users.** README gained a "Web Viewer" section explaining the passphrase page at `https://sync.satoshihost.com/` — enter Server URL + Sync ID + passphrase, and it decrypts in the browser. Notes that there is no account/login and that a guessable custom Sync ID relies on the passphrase alone.
- **Popup link renamed** from "Server Status" to **"Web Viewer"** (`extension/popup/popup.html`) so the page is discoverable.
- **README corrected**: removed the stale "hosted server synchronisation is not implemented yet" claim; rate limit 30s → 5s; API table now shows `X-Sync-Rev` / `X-Expected-Rev` / `{rev}`; roadmap Tier 2 checked; Firefox marked discontinued; status line updated.
- **PROJECT.md refreshed**: revision-based sync model, custom Sync ID validation, `/status` version 1.0.1, server code sketch marked historical (pointer to `server/main.go`), Firefox compatibility note updated.
- **Version bumped to 1.0.2** (`extension/manifest.json`). Server unchanged at 1.0.1.
- **Site Changelog tab added** to `www/index.html` — needs deploying to DR1 to go live.

### Test Credentials
- Server: https://sync.satoshihost.com
- Test sync ID: (generate new for testing)
- Test passphrase: (your choice)

---

## 🚀 DEPLOYMENT

### Server
```bash
# Update server code:
cd /home/andy/work/projects/browser-sync/server
GOOS=linux GOARCH=amd64 go build -o bookmarksync .
scp bookmarksync dr1:/opt/bookmarksync/
ssh dr1 'systemctl restart bookmarksync'
```

### Extension
```bash
# Update extension:
cd /home/andy/work/projects/browser-sync/extension

# In browser:
# 1. Go to chrome://extensions (or opera://extensions, etc.)
# 2. Click reload button on Full Browser Sync extension
```

---

## 📝 NEXT SESSION PLAN

1. **Polish UI feedback** — "Already up to date" after a manual sync feels wrong when the background already uploaded; show last auto-sync time in the popup status bar so the user understands what happened
2. **Test edge cases** — rate limiting (rapid bookmark adds), service worker sleep mid-debounce, mismatched clocks
3. **Write the local-sync explainer page** — static page at sync.satoshihost.com explaining why automatic local-folder sync isn't possible from an extension, what does work, and what a future companion app would look like

---

## 📞 HELP/REFERENCE

### Important URLs
- Live server: https://sync.satoshihost.com
- GitHub: https://github.com/satoshihost/bookmarksync
- Server SSH: `ssh dr1` (configured in ~/.ssh/config) — DR1 (198.23.202.164)

### Key Files
- `server/main.go` - Server implementation
- `extension/manifest.json` - Extension config
- `extension/popup/popup.js` - Main UI logic
- `extension/background.js` - Background worker
- `extension/lib/crypto.js` - Encryption
- `extension/lib/sync.js` - Server API client

### Useful Commands
```bash
# View server logs
ssh dr1 'journalctl -u bookmarksync -f'

# Check server status
curl https://sync.satoshihost.com/status

# Restart server
ssh dr1 'systemctl restart bookmarksync'

# Test API
curl -X POST https://sync.satoshihost.com/sync
```

---

**Status:** Server complete and live on DR1. Extension complete and core sync loop fully verified working across browsers — automatic upload on bookmark change, automatic download, Plaintext Debug Mode, and Web Bookmark Viewer live at https://sync.satoshihost.com.
