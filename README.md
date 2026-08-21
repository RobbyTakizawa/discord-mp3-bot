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
- Disconnect automatically when the bot is alone in its voice channel.
- Run a real local regression suite with `npm test`.

Playback is intentionally simple: there is one shared audio player, no queue, and starting a track replaces the current track. This also means playback is global rather than independent per Discord server.

## Accepted stabilization contract

The behavior decisions for the stabilization work are frozen. This is the acceptance target for later code and tests, not a claim that every item is implemented yet:

- One global voice session owns one player, at most one voice connection, one target channel, and one current track.
- A successful Discord or web play request replaces the current track and moves that session when the selected target changes.
- Discord play targets the caller's current voice channel. Web play temporarily keeps its existing first-cached-channel-with-a-human selection rule.
- Discord stop, web stop, last-human departure, and graceful shutdown will all clear the same global session. Stopping an already stopped session will succeed harmlessly.
- The catalog remains filesystem-only: root tracks are labeled `uncategorized`, categories are one directory deep, and only lowercase `.mp3` filenames at those depths are discoverable and playable.
- Uploads reject an existing destination instead of overwriting it implicitly.
- Every web route remains protected by Basic Auth behind HTTPS.
- Browser actions will use relative URLs so the panel works both at the direct Express root and through the `/discord/` prefix-stripping reverse proxy.
- The supported Discord commands remain `!help`, `!list`, `!play`, and `!stop`; queues, simultaneous multi-guild playback, nested catalogs, and remote URL ingestion remain out of scope.

Current mismatches are still documented under **Current limitations and security notes** and in [`ROADMAP.md`](ROADMAP.md). In particular, session movement, unified stop behavior, and graceful shutdown are not implemented yet. Upload hardening and duplicate rejection are implemented.

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.js` | Discord client, command handling, voice playback, and process composition. |
| `config.js` | Environment configuration parsing and startup validation. |
| `catalog.js` | Music discovery and containment-checked playback identifiers. |
| `render.js` | Escaped server-rendered control-panel HTML. |
| `web-app.js` | Testable Express application, authentication, upload, and control routes. |
| `upload-storage.js` | Upload naming policy, path containment, staging, FFprobe validation, and exclusive publication. |
| `test/` | Node built-in test-runner coverage for bootstrap, catalog, authentication, rendering, routing, and hardened uploads. |
| `music/` | Runtime MP3 library. It is created automatically and ignored by Git. |
| `package.json` | Node.js dependencies and package metadata. |
| `.gitignore` | Excludes dependencies, local environment configuration, and runtime music. |
| `AGENTS.md` | Implementation context and guardrails for coding agents. |
| `ROADMAP.md` | Prioritized stabilization plan and separate post-stabilization feature roadmap. |

## Requirements

- Node.js 22.12.0 or newer. This is required by the installed `@discordjs/voice` release.
- npm.
- A system `ffmpeg` executable available on `PATH` for MP3 transcoding.
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
   node index.js
   ```

   Bash:

   ```sh
   export DISCORD_TOKEN='your-bot-token'
   export WEB_PASS='a-long-random-password'
   export WEB_USER='uploader' # optional
   export WEB_HOST='127.0.0.1' # optional
   export WEB_PORT='3000'     # optional
   node index.js
   ```

Never commit bot tokens or passwords. `DISCORD_TOKEN` is required at startup. If `WEB_PASS` is missing, the bot still starts but every web-panel request returns an error.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | None | Discord bot token used by `client.login`. |
| `WEB_PASS` | For web use | None | Password checked by HTTP Basic Auth. |
| `WEB_USER` | No | `uploader` | HTTP Basic Auth username. |
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

Catalog discovery only includes lowercase `.mp3` files at the root or directly inside a first-level category. Deeper nesting is not shown by `!list` or the web panel. Filename matching follows the host filesystem's case-sensitivity rules.

## Discord commands

| Command | Behavior |
| --- | --- |
| `!help` | Shows the supported command summary. |
| `!list` | Lists root tracks and tracks in first-level category folders. |
| `!play <name>` | Plays a root track in the caller's current voice channel. |
| `!play <category/name>` | Plays a categorized track in the caller's current voice channel. |
| `!stop` | Stops the shared player and destroys the connection for that Discord server. |

There are currently no role or user restrictions on Discord commands.

## Web panel and reverse proxy

The Express server implements these authenticated routes:

- `GET /` - renders the upload and playback panel.
- `POST /upload` - stores an uploaded MP3.
- `POST /api/control` - starts or stops playback.

The generated browser UI uses relative URLs. This allows the same page to work at the direct Express root and when a reverse proxy exposes the app under `/discord/` and strips that prefix before forwarding requests to Express. For example, the important Nginx behavior is:

```nginx
location /discord/ {
    proxy_pass http://127.0.0.1:3000/;
}
```

The application listens on loopback by default, which fits a reverse proxy running on the same host. Container deployments that need to publish the listener outside the container must set `WEB_HOST=0.0.0.0` and keep the published port private to the proxy or trusted network.

Opening `http://localhost:3000/` directly now keeps upload, control, and back-link actions at the direct Express root. The same HTML also works beneath the documented `/discord/` proxy prefix.

Web playback searches all connected Discord servers and selects the first voice channel containing at least one non-bot member. A user must therefore join a voice channel before pressing **Play**. The web **Stop** action stops playback and destroys all of the bot's voice connections.

## Runtime workflows

### Discord playback

1. A user sends `!play <track>` while in a voice channel.
2. The bot resolves the identifier under `music/` and rejects paths outside that directory.
3. It creates or reuses the server's voice connection.
4. The shared audio player starts the MP3 and replaces any current resource.

### Browser upload

1. Basic Auth validates `WEB_USER` and `WEB_PASS`.
2. The panel supplies a CSRF token, and request limits allow one MP3 file up to 25 MB plus bounded form fields.
3. Multer writes to a random filename in `.discord-mp3-upload-staging/`, outside the visible `music/` catalog.
4. The server accepts only `uncategorized` or an existing immediate category. Names are Unicode-normalized and must use letters or numbers followed by letters, numbers, spaces, `_`, `-`, `.`, parentheses, or square brackets. Separators, control characters, dot segments, trailing dots, reserved Windows device names, and names longer than 100 characters are rejected.
5. FFprobe must identify an MP3 audio stream, then FFmpeg decodes up to the first 30 seconds. Both checks share a ten-second timeout. A valid file is published without overwriting any existing destination; invalid, duplicate, oversized, failed, and aborted uploads are removed from staging.
6. The catalog is rebuilt from disk on the next page load or `!list` command.

Tracks live only on the local filesystem; there is no database, object storage, metadata store, or backup process.

## Current limitations and security notes

This repository is an early, single-process implementation. Keep these constraints in mind before exposing it publicly:

- HTTP Basic Auth must be placed behind HTTPS to protect credentials in transit.
- The panel uses one shared Basic Auth identity. Its failed-authentication and state-change rate limits are in memory, apply per connecting IP address, and reset when the process restarts.
- Upload validation requires the system `ffprobe` and `ffmpeg` executables. If either is unavailable, uploads fail closed.
- Uploads can target only the root or an existing immediate category; the panel does not create categories.
- Discord commands have no authorization checks or rate limits.
- One singleton audio player is shared across every Discord server.
- Discord stop currently destroys only the requesting guild's connection, while web stop destroys every connection; the accepted target is one unified global stop operation.
- Existing guild connections are currently reused without moving to a newly requested voice channel.
- The web player's target-channel choice depends on cache iteration order and is not user-selectable.

Treat the web panel as trusted-administrator tooling because it still relies on a shared Basic Auth credential. Keep it behind the documented HTTPS deployment boundary.

See [`ROADMAP.md`](ROADMAP.md) for the ordered remediation plan, target structure, release gates, and later product improvements. The roadmap is an assessment and planning document; items described there are not implemented behavior unless this README and the code say otherwise.

## Development checks

Run the automated checks and syntax validation:

```sh
node --check index.js
npm test
```

For behavior changes, manually verify `!list`, `!play`, `!stop`, authenticated upload, web playback, and automatic voice disconnection in a non-production Discord server.
