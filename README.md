# BookmarkSync

**Privacy-first bookmark synchronization** — simple, secure, self-hostable.

---

## Why This Project Exists

[xBrowserSync](https://www.xbrowsersync.org/) was an excellent bookmark sync solution that prioritized privacy and simplicity. Unfortunately, development ceased around 2020, and the extension was never updated to Manifest V3 (now required by Chrome). The project has been effectively abandoned since 2022.

Rather than see this excellent idea fade away, BookmarkSync is a **clean-room rewrite** that preserves the core philosophy while modernizing the implementation:

- ✅ **Manifest V3** compatible (works in modern Chrome/Firefox)
- ✅ **Modern stack** (Go server, contemporary JavaScript)
- ✅ **Same privacy guarantee** (end-to-end encryption, zero knowledge server)
- ✅ **Radical simplicity** (no accounts, no tracking, minimal dependencies)

This project stands on the shoulders of xBrowserSync and aims to carry its spirit forward.

---

## Features

### Two-Tier Architecture

**Tier 1 — Local Only** (no server needed)
- Export/import bookmarks as JSON files
- Manual sync via USB, Syncthing, Dropbox, etc.
- Zero trust — nothing leaves your machine

**Tier 2 — Sync Server** (optional)
- Automatic sync across devices
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
- **Extension:** Manifest V3, works in Chrome & Firefox

---

## Quick Start

### Browser Extension

*(Coming soon — extension is under development)*

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

---

## API Documentation

The server exposes a minimal REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync` | POST | Create new sync ID |
| `/sync/{id}` | GET | Download encrypted blob |
| `/sync/{id}` | PUT | Upload encrypted blob |
| `/sync/{id}` | DELETE | Delete sync data |
| `/sync/{id}/info` | GET | Get last modified time |
| `/status` | GET | Server health check |

**Rate limits:** Max 1 PUT per sync ID per 30 seconds  
**Max body size:** 2MB

See [PROJECT.md](PROJECT.md) for detailed API specification and encryption details.

---

## Project Structure

```
bookmarksync/
├── server/          # Go backend
│   ├── main.go
│   └── go.mod
├── extension/       # Browser extension (under development)
├── PROJECT.md       # Full technical specification
└── README.md
```

---

## Comparison to xBrowserSync

| Feature | xBrowserSync | BookmarkSync |
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
- [ ] Browser extension (Manifest V3)
  - [ ] Tier 1: Local file mode
  - [ ] Tier 2: Server sync mode
  - [ ] Popup UI
  - [ ] Crypto module
- [ ] Chrome Web Store submission
- [ ] Firefox Add-ons submission
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
**Status:** In development — server operational, extension coming soon
