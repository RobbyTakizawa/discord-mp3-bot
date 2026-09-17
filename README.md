# Discord MP3 Bot

A small Discord soundboard bot that plays MP3 files from a local `music/` directory. The same Node.js process also serves a password-protected web panel for uploading tracks and starting or stopping playback.

## What works

- List MP3s from the `music/` directory in Discord.
- Join the requesting user's voice channel and play a selected track.
- Stop playback and disconnect the bot.
- Group tracks into one level of category folders.
- Upload MP3s through an HTTP Basic Auth-protected web panel.
- Validate bounded uploads in a private staging area and reject unsafe or duplicate destinations.
- Use the web panel to play a track in the first voice channel that contains a human user.
- Queue up to 100 tracks, skip the current track, loop the current track, and adjust volume (0–100) from the web panel.
- Display cached FFprobe durations and live now-playing/elapsed status in the web panel.
- Disconnect automatically when the bot is alone in its voice channel.
- Run a real local regression suite with `npm test`.

Playback is intentionally simple: one global voice session owns one audio player, at most one Discord voice connection, one queue, one loop flag, and one volume setting. **Play Now** (and Discord `!play`) immediately replaces the current track and clears the pending queue; **Add to Queue** appends and starts immediately when idle. Looping repeats the current track while the queue waits; **Skip** advances even while looping. **Stop** clears playback, queue, and loop mode and disconnects. Queue, loop, and volume are in-memory only and reset on restart. There is no simultaneous per-server playback.

## Accepted stabilization contract

The behavior decisions for the stabilization work are frozen, as extended by the playback-controls release below. The voice lifecycle and command-adapter items below are implemented and covered by local tests; later stabilization work remains tracked in the roadmap:

- One global voice session owns one player, at most one voice connection, one target channel, one current track, one pending queue (max 100), one loop-current flag, and one volume (0–100, default 100).
- A successful Discord or web **Play Now** request replaces the current track, clears the pending queue, and moves that session when the selected target changes. Discord `!play` keeps this replacement meaning and clears the web queue; no new Discord commands were added.
- Web **Add to Queue** appends (duplicates allowed); when nothing is playing it starts immediately. A queued session stays in its current voice channel; when idle, web actions reuse the existing first-cached-channel-with-a-human selection rule.
- **Skip** starts the next queued entry even while looping is enabled. While looping, natural completion recreates the current track with a fresh audio resource and the queue waits.
- Discord stop, web stop, last-human departure, unrecoverable disconnect, and graceful shutdown all clear playback, queue, and loop state. Stopping an already stopped session succeeds harmlessly.
- Volume applies immediately to the current resource (via `inlineVolume`) and to future tracks, and persists in memory until restart.
- The catalog remains filesystem-only: root tracks are labeled `uncategorized`, categories are one directory deep, and only lowercase `.mp3` filenames at those depths are discoverable and playable. Queued files are revalidated for containment and existence when they start; missing files are skipped.
- Uploads reject an existing destination instead of overwriting it implicitly.
- Every web route remains protected by Basic Auth behind HTTPS. Read-only `GET /api/playback` and `GET /api/library` require auth; all `POST /api/control` mutations require auth, CSRF, and the mutation rate limiter.
- Browser actions use relative URLs so the panel works both at the direct Express root and through the `/discord/` prefix-stripping reverse proxy.
- The supported Discord commands remain `!help`, `!list`, `!play`, and `!stop`; simultaneous multi-guild playback, nested catalogs, and remote URL ingestion remain out of scope.

The remaining deployment work and live verification gates are documented under **Current limitations and security notes** and in [`ROADMAP.md`](ROADMAP.md). Phase 5 was closed by owner direction without performing live Discord play, movement, stop, departure, reconnection, or shutdown verification; those checks remain release gates. The queue/loop/volume/duration release below was verified with automated tests only; live Discord and proxy verification remain outstanding.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.js` | Process composition, Discord login, HTTP startup, and graceful shutdown wiring. |
| `discord-adapter.js` | Discord command parsing, safe replies, optional access policy, event translation, and web voice-target selection. |
| `voice-session.js` | Serialized global ownership of the audio player, voice connection, target, current track/resource, queue, loop, volume, and playback snapshots. |
| `config.js` | Environment configuration parsing and startup validation. |
| `catalog.js` | Music discovery and containment-checked playback identifiers. |
| `media-metadata.js` | Cached FFprobe duration lookups by path, size, and mtime with bounded concurrency. |
| `render.js` | Escaped server-rendered control-panel HTML. |
| `web-app.js` | Testable Express application, authentication, upload, library/playback, and control routes. |
| `upload-storage.js` | Upload naming policy, path containment, staging, FFprobe validation, and exclusive publication. |
| `runtime-preflight.js` | Startup checks for FFmpeg, FFprobe, and the configured Opus encoder. |
| `operational-logger.js` | Secret-conscious JSON logging for startup, shutdown, Discord readiness, and HTTP requests. |
| `test/` | Node built-in test-runner coverage for bootstrap/readiness, structured logging, commands, configuration, catalog, voice transitions, queue/loop/volume, durations, authentication, rendering, routing, and hardened uploads. |
| `music/` | Runtime MP3 library. It is created automatically and ignored by Git. |
| `package.json` | Node.js dependencies and package metadata. |
| `.gitignore` | Excludes dependencies, local environment configuration, and runtime music. |
| `AGENTS.md` | Implementation context and guardrails for coding agents. |
| `ROADMAP.md` | Prioritized stabilization plan and separate post-stabilization feature roadmap. |

## Requirements

- Node.js 22.12.0 or newer. This is required by the installed `@discordjs/voice` release.
- npm.
- System `ffmpeg` and `ffprobe` executables available on `PATH` for playback and upload validation.
- A Discord application and bot token.
- A persistent writable filesystem if uploaded music must survive restarts or deployments.

## Discord bot setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the privileged **Message Content Intent** for the bot. The code reads prefix commands from message content.
3. Invite the bot to the target server with permission to view channels, read and send messages, connect to voice, and speak.
4. Install dependencies from the lockfile:

   ```sh
   npm ci
   ```

5. Set the runtime environment variables. The application does not load `.env` files itself.

   PowerShell:

   ```powershell
   $env:DISCORD_TOKEN = "your-bot-token"
   $env:WEB_PASS = "a-long-random-password"
   $env:WEB_USER = "uploader" # optional
   $env:WEB_HOST = "127.0.0.1" # optional
   $env:WEB_PORT = "3000"     # optional
   npm start
   ```

   Bash:

   ```sh
   export DISCORD_TOKEN='your-bot-token'
   export WEB_PASS='a-long-random-password'
   export WEB_USER='uploader' # optional
   export WEB_HOST='127.0.0.1' # optional
   export WEB_PORT='3000'     # optional
   npm start
   ```

Never commit bot tokens or passwords. `DISCORD_TOKEN` and `WEB_PASS` are required at startup. Before Discord login or HTTP listening, startup also verifies the listener configuration, FFmpeg, FFprobe, and the Opus encoder and exits with an actionable error if any check fails.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | None | Discord bot token used by `client.login`. |
| `DISCORD_ALLOWED_GUILD_IDS` | No | Empty | Comma-separated Discord server IDs allowed to use commands. Empty permits every server the bot has joined. |
| `DISCORD_CONTROLLER_ROLE_IDS` | No | Empty | Comma-separated Discord role IDs allowed to use `!play` and `!stop`. Empty permits every user. |
| `DISCORD_COMMAND_COOLDOWN_MS` | No | `0` | Per-user delay between supported commands, from `0` through `3600000` milliseconds. `0` disables the cooldown. |
| `WEB_PASS` | Yes | None | Password checked by HTTP Basic Auth. An empty value is rejected at startup. |
| `WEB_USER` | No | `uploader` | HTTP Basic Auth username. It must be non-empty and cannot contain a colon or control character. |
| `WEB_HOST` | No | `127.0.0.1` | Address on which Express listens. Use `0.0.0.0` only when container or network topology requires it, and restrict access at the deployment boundary. |
| `WEB_PORT` | No | `3000` | Port on which Express listens. |

The Discord command prefix is currently hard-coded as `!`, and the music directory is hard-coded as `<repository>/music`.

## Organizing music

Root-level MP3s are reported as `uncategorized`. Immediate subdirectories are treated as categories:

```text
music/
├── airhorn.mp3
├── players/
│   └── level_up.mp3
└── villains/
    └── boss_theme.mp3
```

This produces the playable identifiers `airhorn`, `players/level_up`, and `villains/boss_theme`. The `.mp3` suffix is optional when using `!play`.

Catalog discovery only includes lowercase `.mp3` files at the root or directly inside a first-level category. Deeper nesting is not shown by `!list` or the web panel. Root tracks, categories, and category tracks are sorted deterministically. If one category cannot be read, it is logged and the remaining readable catalog is still returned. Filename matching follows the host filesystem's case-sensitivity rules.

## Discord commands

| Command | Behavior |
| --- | --- |
| `!help` | Shows the supported command summary. |
| `!list` | Lists root tracks and tracks in first-level category folders, splitting long catalogs across safe Discord-sized messages. |
| `!play <name>` | Plays a root track in the caller's current voice channel. |
| `!play <category/name>` | Plays a categorized track in the caller's current voice channel. |
| `!stop` | Stops playback and destroys the single global voice connection, regardless of which Discord server started it. |

Commands are case-insensitive after the `!` prefix, and repeated whitespace in arguments is normalized. Bot replies suppress mentions and reply pings and escape filesystem-derived Markdown. Guild allowlists, controller-role restrictions for `!play` and `!stop`, and per-user cooldowns are available through the optional configuration above; all three restrictions are disabled by default.

## Web panel and reverse proxy

The Express server implements these authenticated operator routes:

- `GET /` - renders the upload and playback panel.
- `POST /upload` - stores an uploaded MP3.
- `POST /api/control` - starts or stops playback, manages the queue, loop, and volume. Supported `action` values are `play` (Play Now, clears queue), `enqueue` (Add to Queue), `skip`, `remove` (with numeric `id`), `clearQueue`, `setLoop` (with boolean `enabled`), and `setVolume` (with integer `volume` 0–100). Successful mutations return `{ message, snapshot }`.
- `GET /api/playback` - returns `{ snapshot }` with status, target names, current track plus elapsed/duration, queue with durations, volume, loop, and revision. No CSRF or mutation rate limit applies.
- `GET /api/library` - returns `{ tracks: [{ song, category, durationMs }] }` with cached durations (`null` when unknown). No CSRF or mutation rate limit applies.

It also exposes two minimal unauthenticated operational probes so a local process manager or reverse proxy can observe startup without storing the panel password:

- `GET /healthz` returns `200 {"status":"ok"}` once the HTTP process is serving.
- `GET /readyz` returns `503` until Discord login has completed and the Discord client currently reports ready, then returns `200`. It returns to `503` if Discord is disconnected or shutdown begins.

Startup runs configuration and media dependency preflight first, opens HTTP second, and then attempts Discord login. This deliberately makes liveness observable while Discord connects. A Discord login rejection is logged, closes the partial runtime, and leaves the process with a failing exit status; the operator panel must not be considered ready merely because HTTP is listening.

The generated browser UI uses relative URLs. This allows the same page to work at the direct Express root and when a reverse proxy exposes the app under `/discord/` and strips that prefix before forwarding requests to Express. For example, the important Nginx behavior is:

```nginx
server_tokens off;

location = /discord {
    return 308 /discord/;
}

location /discord/ {
    proxy_http_version 1.1;
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Place this location in an HTTPS `server` block with a valid certificate and redirect plain HTTP to HTTPS. `proxy_pass` must keep its trailing slash so Nginx strips `/discord/` before forwarding. The forwarded host, client chain, and scheme preserve conventional proxy context, but the application does not trust forwarded client addresses for authorization. Its process-local request limits therefore see a same-host reverse proxy as one connecting client.

The application listens on loopback by default, which fits a reverse proxy running on the same host. Container deployments that need to publish the listener outside the container must set `WEB_HOST=0.0.0.0` and keep the published port private to the proxy or trusted network. Express disables `X-Powered-By`, the recommended Nginx block disables version tokens, and every application response includes a generated `X-Request-ID` that matches its concise JSON request log. Request logs include only the ID, method, path without query parameters, status, duration, and completion outcome; they do not log authorization headers, cookies, or request bodies.

Opening `http://localhost:3000/` directly now keeps upload, control, and back-link actions at the direct Express root. The same HTML also works beneath the documented `/discord/` proxy prefix.

Web playback searches all connected Discord servers and selects the first voice channel containing at least one non-bot member. A user must therefore join a voice channel before pressing **Play Now** or **Add to Queue** when the session is idle; queued requests stay in the current channel once playback has started. The panel displays the active guild/channel names, now-playing track with elapsed/total time, volume, loop state, and the pending queue. The web **Stop** action clears the same global session (including queue and loop) as Discord `!stop`. Durations are probed with FFprobe on demand and cached by path, size, and mtime; unknown durations appear as `?:??` without breaking the panel.

## Persistent storage, backup, and restore

The runtime library is the repository's `music/` directory, so a persistent disk or volume must be mounted at that exact path before the service starts. Both `music/` and `.discord-mp3-upload-staging/` must be writable only by the service account. For the current EC2 layout, verify the real service user and repository path first; the example below uses `ec2-user` and `/home/ec2-user/discord-mp3-bot`:

```sh
BOT_DIR=/home/ec2-user/discord-mp3-bot
BOT_USER=ec2-user
sudo install -d -m 0750 -o "$BOT_USER" -g "$BOT_USER" "$BOT_DIR/music"
sudo install -d -m 0700 -o "$BOT_USER" -g "$BOT_USER" "$BOT_DIR/.discord-mp3-upload-staging"
sudo -u "$BOT_USER" test -w "$BOT_DIR/music"
sudo -u "$BOT_USER" test -w "$BOT_DIR/.discord-mp3-upload-staging"
```

Backups are operational, not automatic. To create an application-consistent archive, first verify that `BOT_DIR`, `music/`, and `discord-mp3-bot.service` are the intended targets, then stop only this bot for the short archive window:

```sh
BOT_DIR=/home/ec2-user/discord-mp3-bot
BACKUP_DIR=/home/ec2-user/discord-mp3-backups
BOT_USER=ec2-user
BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 0700 -o "$BOT_USER" -g "$BOT_USER" "$BACKUP_DIR"
sudo systemctl stop discord-mp3-bot.service
sudo -u "$BOT_USER" tar -C "$BOT_DIR" -czf "$BACKUP_DIR/music-$BACKUP_STAMP.tar.gz" music
sudo -u "$BOT_USER" sha256sum "$BACKUP_DIR/music-$BACKUP_STAMP.tar.gz" | sudo -u "$BOT_USER" tee "$BACKUP_DIR/music-$BACKUP_STAMP.tar.gz.sha256"
sudo systemctl start discord-mp3-bot.service
curl --fail --silent http://127.0.0.1:3000/healthz
curl --fail --silent http://127.0.0.1:3000/readyz
```

Copy both archive and checksum to storage outside the host. A restore is intentionally offline and preserves the current library as a rollback directory. Set `RESTORE_ARCHIVE` to the chosen verified archive; the example assumes an ordinary same-filesystem `music/` directory. A separately mounted volume must use that volume provider's documented snapshot restore instead of renaming the mount point.

```sh
BOT_DIR=/home/ec2-user/discord-mp3-bot
BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESTORE_ARCHIVE=/home/ec2-user/discord-mp3-backups/music-YYYYMMDDTHHMMSSZ.tar.gz
RESTORE_DIR=$(mktemp -d "$BOT_DIR/.music-restore.XXXXXX")
sha256sum --check "$RESTORE_ARCHIVE.sha256"
tar -C "$RESTORE_DIR" -xzf "$RESTORE_ARCHIVE"
test -d "$RESTORE_DIR/music"
sudo systemctl stop discord-mp3-bot.service
mv "$BOT_DIR/music" "$BOT_DIR/music.before-$BACKUP_STAMP"
mv "$RESTORE_DIR/music" "$BOT_DIR/music"
sudo systemctl start discord-mp3-bot.service
curl --fail --silent http://127.0.0.1:3000/healthz
curl --fail --silent http://127.0.0.1:3000/readyz
```

If post-restore checks fail, stop only `discord-mp3-bot.service`, move the restored `music/` aside, move `music.before-$BACKUP_STAMP` back to `music/`, restart the bot, and repeat both probes. Do not remove either copy until playback and catalog checks pass.

## Runtime workflows

### Discord playback

1. A user sends `!play <track>` while in a voice channel.
2. The bot resolves the identifier under `music/` and rejects paths outside that directory.
3. The global session reuses its connection only when the target guild and channel are unchanged; otherwise it destroys the old connection and joins the selected channel.
4. The audio player starts the MP3 with `inlineVolume` and replaces any current resource, clearing the pending web queue. Play, queue, skip, loop, volume, and stop operations are serialized to prevent web and Discord control races.
5. When the track ends naturally, the session advances to the next queued entry, repeats the current track when looping, or goes idle while keeping the connection.

### Browser playback

1. Basic Auth validates `WEB_USER` and `WEB_PASS`; state-changing control requests also require the CSRF token and pass the mutation rate limiter.
2. **Play Now** resolves the identifier and replaces playback (clearing the queue). **Add to Queue** appends (max 100, duplicates allowed) and starts immediately when idle.
3. The panel polls `GET /api/playback` and `GET /api/library` with relative URLs, shows target names, elapsed/total time (estimating locally between polls), volume, loop, and queue, and reports errors inline.

### Browser upload

1. Basic Auth validates `WEB_USER` and `WEB_PASS`.
2. The panel supplies a CSRF token, and request limits allow one MP3 file up to 25 MB plus bounded form fields.
3. Multer writes to a random filename in `.discord-mp3-upload-staging/`, outside the visible `music/` catalog.
4. The server accepts only `uncategorized` or an existing immediate category. Names are Unicode-normalized and must use letters or numbers followed by letters, numbers, spaces, `_`, `-`, `.`, parentheses, or square brackets. Separators, control characters, dot segments, trailing dots, reserved Windows device names, and names longer than 100 characters are rejected.
5. FFprobe must identify an MP3 audio stream, then FFmpeg decodes up to the first 30 seconds. Both checks share a ten-second timeout. A valid file is published without overwriting any existing destination; invalid, duplicate, oversized, failed, and aborted uploads are removed from staging.
6. The catalog is rebuilt from disk on the next page load or `!list` command.

Tracks live only on the local filesystem; there is no database, object storage, metadata store, or automated backup process.

## Current limitations and security notes

This repository is an early, single-process implementation. Keep these constraints in mind before exposing it publicly:

- HTTP Basic Auth must be placed behind HTTPS to protect credentials in transit.
- The panel uses one shared Basic Auth identity. Its failed-authentication and state-change rate limits are in memory, apply per connecting socket address, and reset when the process restarts. Users behind the same reverse proxy share one limit bucket.
- Startup requires working system `ffprobe` and `ffmpeg` executables and a loadable Opus encoder. The process exits before Discord login or HTTP listening if any dependency is unavailable.
- Voice encoding uses the supported pure-JavaScript `opusscript` fallback. It avoids the native module's downloader/build chain and is adequate for this single-stream bot, but it is slower than native `@discordjs/opus` and should be reconsidered if playback becomes CPU-constrained.
- Uploads can target only the root or an existing immediate category; the panel does not create categories.
- Discord command allowlists, controller-role checks, and cooldowns are disabled unless configured; the default deployment therefore permits commands from every user and server the bot can see.
- Playback is intentionally global: a play request from another guild or channel moves and replaces the current session rather than creating simultaneous playback.
- Queue, loop, and volume are in-memory only and disappear on restart; there is no persistence, pause/resume, shuffle, per-track repeat of queued items beyond loop-current, or simultaneous multi-guild playback.
- The web player's target-channel choice depends on cache iteration order and is displayed but not user-selectable.
- Volume uses `inlineVolume`, which adds CPU overhead on top of the pure-JS Opus encoder; observe production CPU while changing volume.
- Voice lifecycle transitions are covered with fakes, but live Discord play, queue advance, loop, skip, volume, channel movement, reconnect behavior, last-human departure, and signal-driven shutdown have not been verified in this workspace. Phase 5 was marked complete by owner direction without implying those checks ran; the playback-controls release is likewise automated-tests only.

Treat the web panel as trusted-administrator tooling because it still relies on a shared Basic Auth credential. Keep it behind the documented HTTPS deployment boundary.

See [`ROADMAP.md`](ROADMAP.md) for the ordered remediation plan, target structure, release gates, and later product improvements. The roadmap is an assessment and planning document; items described there are not implemented behavior unless this README and the code say otherwise.

## Development checks

Run the automated checks and syntax validation:

```sh
node --check index.js
npm test
```

For behavior changes, manually verify `!list`, `!play`, `!stop`, authenticated upload, web Play Now, queue advance, loop, skip, volume, stop clearing queue/loop, and automatic voice disconnection in a non-production Discord server, plus direct and `/discord/` proxy behavior.
