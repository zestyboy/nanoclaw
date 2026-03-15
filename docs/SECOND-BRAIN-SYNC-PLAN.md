# Second Brain: Multi-Device Sync Plan

> How to access and sync the Second Brain vault across devices without storing personal data on the work laptop.

---

## Current State

Railway volume (`/data/second-brain`) is the working copy. NanoClaw agents read/write here. R2 is a 12-hour backup. There is no device sync yet.

## Goal

Access the vault from:
- **Work computer** — view and occasionally edit via browser (no files stored locally)
- **Phone** — full Obsidian mobile app with offline support
- **Railway** — NanoClaw agents (primary writer)

## Proposed Architecture

```
Phone (Obsidian mobile)
    │
    │  Syncthing (real-time, bidirectional, conflict-aware)
    │
Railway volume /data/second-brain  ← single source of truth
    ├── NanoClaw agents read/write
    ├── Silver Bullet serves via web (browser access)
    ├── qmd indexes for search
    └── rclone → R2 every 12h (backup only)
```

### Components

| Component | Purpose | Access method |
|-----------|---------|---------------|
| **NanoClaw** | Agent writes (primary) | Direct filesystem on Railway volume |
| **Silver Bullet** | Web-based markdown editor | Browser via Tailscale or Cloudflare Access |
| **Syncthing** | Real-time file sync to phone | Peer-to-peer between Railway and phone |
| **R2** | Disaster recovery backup | rclone push from Railway every 12h |
| **Obsidian mobile** | Full vault on phone | Syncthing keeps it current |

---

## Silver Bullet (Web Access)

[Silver Bullet](https://github.com/silverbulletmd/silverbullet) is a markdown-focused web app that reads/writes directly to a folder. Run it on Railway pointed at the vault volume.

### Setup

1. Add a new Railway service in the `fulfilling-adventure` project
2. Use the Silver Bullet Docker image: `zefhemel/silverbullet`
3. Mount the same `/data` volume as the NanoClaw service
4. Set the start command to point at the vault: `silverbullet /data/second-brain`
5. Expose via one of:
   - **Tailscale** (preferred — already in use for other purposes, no public exposure)
   - **Cloudflare Zero Trust** app access (alternative)

### Notes

- Silver Bullet has its own query/template language but the main use is as a web editor
- Single user — no contention concerns between Silver Bullet and NanoClaw since they won't be writing simultaneously
- No files stored on the work computer — everything stays on Railway

---

## Syncthing (Phone Sync)

[Syncthing](https://syncthing.net/) provides real-time bidirectional file sync with built-in conflict resolution. Conflicts create `.sync-conflict` files rather than silently overwriting.

### Setup

1. Add Syncthing as a Railway service (or sidecar process) sharing the `/data` volume
2. Expose Syncthing's TCP sync port via Railway TCP proxy (no UDP/auto-discovery needed)
3. Configure explicit peer addresses — Railway endpoint ↔ phone
4. Install Syncthing on Android phone, configure to sync the vault folder
5. Install Obsidian mobile, open the synced vault

### Configuration

- **No auto-discovery needed** — configure explicit device IDs and addresses on both sides
- **Sync on Wi-Fi only** recommended to preserve battery
- **Ignore patterns** in Syncthing config:
  ```
  .obsidian/workspace*.json
  .obsidian/plugins/*/data.json
  .trash/
  .qmd/
  ```
  These are device-specific or Railway-specific files that shouldn't sync.

### Conflict handling

Syncthing's default behavior on conflict: keep both versions. The newer write wins the original filename, the older gets renamed to `filename.sync-conflict-YYYYMMDD-HHMMSS.md`. This is safe for a single-user vault — conflicts would be rare (NanoClaw edits a note while you're editing the same one on your phone) and easy to resolve manually.

---

## R2 Backup (unchanged)

R2 remains a dumb backup, not a sync hub:
- Railway → R2 every 12 hours via `rclone sync`
- R2 → Railway restore only if the volume is empty (fresh deploy)
- No bidirectional complexity, no conflict risk

---

## Implementation Order

### Phase 1: Silver Bullet (web access — immediate value)
- Add Railway service with Silver Bullet Docker image
- Mount shared volume
- Expose via Tailscale or Cloudflare Access
- Result: view and edit vault from any browser

### Phase 2: Syncthing (phone sync — when needed)
- Add Railway service with Syncthing
- Configure peer connection to phone
- Install Obsidian mobile on phone
- Result: full offline vault on phone, real-time sync

### Phase 3 (optional): Additional devices
- Any new device just joins the Syncthing cluster with explicit peer config
- Silver Bullet is already accessible from any browser via Tailscale

---

## Decision Log

| Decision | Reasoning |
|----------|-----------|
| Railway volume = source of truth | NanoClaw is the primary writer; no round-trip through external storage |
| Silver Bullet over local sync for work computer | No personal data stored on work machine; IT policy compliance |
| Syncthing over Remotely Save | Native conflict resolution; real-time; doesn't require R2 as a bidirectional hub |
| Tailscale for Silver Bullet access | Already in use for other purposes; zero-trust without Cloudflare setup |
| R2 as backup only | Keeps the architecture simple; one source of truth, not a merge point |
| No auto-discovery for Syncthing | Railway doesn't support UDP; explicit peers are simpler and more secure |
