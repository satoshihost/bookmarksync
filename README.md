# Full Browser Sync

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/satoshihost/bookmarksync)

**Live site: [sync.satoshihost.com](https://sync.satoshihost.com/)**

**Privacy-first bookmark synchronization** — simple, secure, self-hostable.

---

## Why This Project Exists

[xBrowserSync](https://www.xbrowsersync.org/) was an excellent bookmark sync solution that prioritized privacy and simplicity. Unfortunately, development ceased around 2020, and the extension was never updated to Manifest V3 (now required by Chrome). The project has been effectively abandoned since 2022.

Rather than see this excellent idea fade away, Full Browser Sync is a **clean-room rewrite** that preserves the core philosophy while modernizing the implementation:

- ✅ **Manifest V3** compatible (Chromium-based browsers)
- ✅ **Modern stack** (Go server, contemporary JavaScript)
- ✅ **Same privacy guarantee** (end-to-end encryption, zero knowledge server)
- ✅ **Radical simplicity** (no accounts, no tracking, minimal dependencies)

This project stands on the shoulders of xBrowserSync and aims to carry its spirit forward.

---

## Features

### Two-Tier Architecture

**Tier 1 — Local Only** (no server needed)
- Export bookmarks to a versioned JSON backup using the browser's Save As dialog
- Import a backup with the browser's file picker
- Automatic safety backup created in local storage before every import or restore, with 1-click rollback UI
- Import intentionally makes the destination browser match the backup, including deletions
- Manual transfer via USB, Syncthing, Dropbox, etc.
- Zero trust — nothing leaves your machine

**Tier 2 — Sync Server** (optional)
- Automatic sync across devices and browsers
- **Cross-Browser Root Folder Mapping** (Chrome `Bookmarks bar` $\leftrightarrow$ Firefox `Bookmarks Toolbar` / `Bookmarks Menu`)
- **Pre-Restore Validation & Empty-Tree Guard** (prevents corrupt or 0-bookmark payloads from wiping local bookmarks)
- **Smart Bookmark Filtering** (automatically filters internal Firefox `place:` URLs to prevent browser API errors in Chromium)
- End-to-end encrypted (AES-256-GCM)
- Server stores only ciphertext
- Self-hostable (single Go binary)

### Privacy & Security

- **No account required** — just a UUID and passphrase
- **End-to-end encryption** — server never sees plaintext
- **Zero tracking** — no analytics, no telemetry, no logging
- **Self-hostable** — run your own instance
- **Open source** — audit the code yourself

### Technical Highlights

- **Server:** Go (single static binary, ~7MB)
- **Storage:** Flat files (no database)
- **Encryption:** AES-256-GCM with PBKDF2 key derivation (100k iterations)
- **HTTPS:** Automatic Let's Encrypt via Caddy
- **Extension:** Manifest V3 for Chromium-based browsers (`extension/`)

> **Firefox:** support is discontinued. Development targets Chromium-based browsers (`extension/`); the Firefox build was dropped after a Mozilla AMO policy rejection. See [`extension-firefox-not-continuing/`](extension-firefox-not-continuing/README.md).

---

## Web Viewer

Read your synced bookmarks from any machine — no extension required — at **[sync.satoshihost.com](https://sync.satoshihost.com/)**.

1. Open the viewer and enter your **Server URL**, **Sync ID**, and **Passphrase**.
2. Click **Decrypt & View Bookmarks**. The page downloads the encrypted blob and decrypts it **in your browser**; the server never sees plaintext.
3. The bookmark tree appears with a search box.

There is **no account and no login**. Anyone who knows both the Sync ID and the passphrase can read the bookmarks; without the passphrase the blob is unreadable. Because custom Sync IDs (for example `andy`) are guessable, choose a strong passphrase.

If a sync ID was stored in **Plaintext Debug Mode**, the viewer shows it directly, since there is nothing to decrypt — use that mode only for testing.

---

## Quick Start

### Browser Extension

Load the `extension` directory as an unpacked extension from your browser's extensions page. The current local-backup mode works in Chromium-based browsers.

#### Local backup and transfer

1. In the source browser, open **Full Browser Sync → Local backup → Export bookmarks** and choose where to save the JSON file.
2. Transfer that file to the other computer or browser profile, for example with Syncthing, USB, or Dropbox.
3. In the destination browser, choose **Import bookmarks** and select the file.
4. Confirm the replacement. The extension saves a dated `before-import-*.json` safety backup before changing anything.

Import is a deliberate full replacement, not a merge: bookmarks present only in the destination are removed. Keep the safety backup if you may want to restore the previous state.

Hosted server synchronisation is implemented. Once you enter a **Server URL**, **Sync ID**, and **Passphrase**, the extension uploads on bookmark changes (debounced 5 seconds) and checks the server on a configurable interval. Use **Sync Now** or the **⬇ Force Download** / **⬆ Force Upload** buttons in the popup to sync immediately. You can also read the same data in any browser without the extension via the [Web Viewer](#web-viewer).

### Self-Hosting the Server

**Requirements:**
- Linux VPS (512MB RAM, any distro)
- Domain with DNS access
- Go 1.22+ (for building)

**Installation:**

```bash
# Clone repository
git clone https://github.com/satoshihost/bookmarksync.git
cd bookmarksync/server

# Build binary
go build -o bookmarksync .

# Run server
./bookmarksync
```

The server listens on `:8080` by default. Use [Caddy](https://caddyserver.com/) or nginx for HTTPS.

**Minimal Caddyfile:**
```
sync.yourdomain.com {
    reverse_proxy localhost:8080
}
```

That's it! Caddy handles Let's Encrypt automatically.

### Running at Home (Behind Router/NAT)

No static IP? No problem! Modern solutions make home servers practical:

**Option 1: Cloudflare Tunnel (Recommended)**
```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared

# Start tunnel (generates a free .trycloudflare.com subdomain)
./cloudflared tunnel --url http://localhost:8080
```
No port forwarding, no dynamic DNS, works behind any router.

**Option 2: Tailscale (Private Network)**
- Install [Tailscale](https://tailscale.com/) on your server and devices
- Access via private IP (e.g., `http://100.x.x.x:8080`)
- Perfect for personal/family use
- No public internet exposure

**Option 3: Dynamic DNS**
- Use services like [DuckDNS](https://www.duckdns.org/) or [No-IP](https://www.noip.com/)
- Configure router for port forwarding (80, 443)
- Update DNS when IP changes (usually via cron script)

**Option 4: Local Network Only**
- No setup needed - just run the server
- Access via `http://192.168.x.x:8080` on same network
- Perfect for offline sync or maximum privacy

**Hardware Ideas:**
- **Raspberry Pi 4** (2GB+ RAM) — ~$50, silent, low power
- **Old laptop** — repurpose unused hardware
- **NAS** (Synology, QNAP) — many support containers or Go binaries
- **Mini PC** — Intel NUC, Beelink, etc.

**Pre-built Binaries Coming Soon:**
- Windows `.exe` (portable, no install needed)
- macOS universal binary
- Linux `.deb` and `.rpm` packages
- Docker image for one-command deployment

---

## API Documentation

The server exposes a minimal REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync` | POST | Create new sync ID |
| `/sync/{id}` | GET | Download encrypted blob with `X-Sync-Rev` header |
| `/sync/{id}` | PUT | Upload encrypted blob (send `X-Expected-Rev`; returns `{rev}`; 409 on revision mismatch) |
| `/sync/{id}` | DELETE | Delete sync data |
| `/sync/{id}/info` | GET | Current revision (`{rev}`) without downloading the blob |
| `/status` | GET | Server health check |

**Rate limits:** Max 1 PUT per sync ID per 5 seconds  
**Max body size:** 2MB

A **Sync ID** may be a random UUID v4 or a custom 3–64 character name (letters, digits, hyphen, underscore) — this is what makes memorable IDs like `andy` possible. The static [Web Viewer](#web-viewer) and guide are served at `/`.

See [PROJECT.md](PROJECT.md) for detailed API specification and encryption details.

---

## Project Structure

```
bookmarksync/
├── server/          # Go backend
│   ├── main.go
│   └── go.mod
├── extension/       # Browser extension (manual local backup/import implemented)
├── tools/           # One-off maintenance utilities, including backup merger
├── PROJECT.md       # Full technical specification
├── PROGRESS.md      # Current implementation status and handoff notes
└── README.md
```

---

## Comparison to xBrowserSync

| Feature | xBrowserSync | Full Browser Sync |
|---------|-------------|--------------|
| Manifest Version | V2 (broken in Chrome) | V3 (modern) |
| Server Language | Node.js + MongoDB | Go + flat files |
| Encryption | ✅ AES-256-GCM | ✅ AES-256-GCM |
| No account | ✅ | ✅ |
| Self-hostable | ✅ | ✅ |
| Local-only mode | ❌ | ✅ |
| Active development | ❌ (abandoned 2020) | ✅ |

---

## Roadmap

- [x] Server implementation (Go)
- [x] API specification
- [x] Deployment setup (Caddy, systemd)
- [x] Browser extension shell (Manifest V3)
  - [x] Tier 1: Manual local backup/import mode
  - [x] Popup UI
  - [x] Local import safety backup and recovery guidance
  - [x] Tier 2: Server sync mode
  - [x] Crypto module
- [ ] Chrome Web Store submission
- [x] ~~Firefox Add-ons submission~~ — discontinued
- [ ] Easy deployment options
  - [ ] Pre-built binaries (Windows, macOS, Linux)
  - [ ] Docker image
  - [ ] Debian/Ubuntu packages (.deb)
  - [ ] Home server guide (Cloudflare Tunnel, Tailscale, etc.)
- [ ] Mobile app (future consideration)

---

## Contributing

Contributions welcome! This project aims to stay simple and focused. Before adding features, please open an issue to discuss.

**Development principles:**
- Radical simplicity over feature creep
- Privacy first, always
- No dependencies unless absolutely necessary
- Code should be auditable by anyone

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

This project is inspired by and pays tribute to [xBrowserSync](https://github.com/xbrowsersync/app), created by the original maintainers. Their vision of a privacy-first, account-free bookmark sync tool deserves to live on.

Special thanks to:
- The xBrowserSync team for the original concept and implementation
- The open source community for tools like Caddy and Go
- Everyone who values privacy and simplicity in software

---

**Live Instance:** [sync.satoshihost.com](https://sync.satoshihost.com)  
**Status:** Server live and extension functional — hosted sync verified across Chromium browsers; Chrome Web Store submission pending
