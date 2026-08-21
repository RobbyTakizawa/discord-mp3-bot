# Coding Agent Context

## Purpose

This repository is a small Discord MP3 soundboard. Keep its supported core focused on local MP3 storage, Discord voice playback, and the authenticated web upload/control panel.

The YouTube-to-MP3 implementation is known broken and is scheduled for removal in the next task. Do not repair, expand, or treat `bb.py` or the `!upload` command as supported behavior. When removing that feature, delete its command path and helper artifacts, then update both this file and `README.md` so no stale Python, cookie, download, or conversion guidance remains.

## Read first

- `README.md` describes the user-facing setup, behavior, reverse-proxy contract, and known risks.
- `ROADMAP.md` records the agreed stabilization order, target boundaries, and later product work. Roadmap items are not implemented behavior until the code and README are updated.
- `index.js` contains the entire supported application.
- `package.json` and `package-lock.json` are the source of truth for Node dependencies.
- `bb.py` is legacy, broken, and pending removal.

There are no hidden service layers, database migrations, test fixtures, or build system in the current repository.

## Architecture

One Node.js process owns all runtime behavior:

- A `discord.js` client listens for `!` prefix commands and voice-state changes.
- A single `@discordjs/voice` audio player is shared globally.
- Express serves a server-rendered control panel and JSON control endpoint.
- Multer writes uploads into the local `music/` tree.
- Catalog functions rescan the filesystem synchronously when requested.

Runtime data is filesystem-only. `music/` is created at startup and ignored by Git. There is no queue, database, cloud storage, or per-guild player state.

## Supported behavior contract

- `!help`, `!list`, `!play`, and `!stop` are the supported Discord commands.
- A Discord `!play` caller must already be in a voice channel.
- Starting a track immediately replaces the current track.
- Root MP3s appear under the logical `uncategorized` label but physically live directly in `music/`.
- Categories are immediate subdirectories of `music/`; discovery does not recurse into deeper levels.
- Only filenames ending in lowercase `.mp3` are cataloged.
- `safeResolveMp3` must continue to prevent resolution outside `music/` for playback paths.
- The bot destroys its connection when no human members remain in its voice channel.
- Web playback chooses the first cached voice channel with a human member across all guilds.
- Web stop is global and destroys all voice connections.

Changing any of these semantics requires corresponding README updates and focused manual verification.

## Web routing contract

Express defines `/`, `/upload`, and `/api/control`. The generated HTML calls `/discord/`, `/discord/upload`, and `/discord/api/control`, assuming a reverse proxy publishes `/discord/` and strips that prefix before forwarding to Express.

Do not casually change only one side of this contract. If routing is revised, update all form actions, fetch URLs, back links, Express routes, deployment examples, and tests together. Direct access to the current root port renders HTML but does not make the panel actions work without rewriting.

Every existing web route is protected by the local `basicAuth` middleware. Preserve authentication on any new control, upload, delete, or administrative route.

## Environment and toolchain

- Node.js `>=22.12.0` is required by `@discordjs/voice@0.19.x`.
- Install exact Node dependencies with `npm ci`.
- MP3 playback expects a system `ffmpeg` executable on `PATH`.
- Required environment variable: `DISCORD_TOKEN`.
- Web variables: `WEB_PASS` is required for usable web routes; `WEB_USER` defaults to `uploader`; `WEB_PORT` defaults to `3000`.
- The app does not import `dotenv`; a `.env` file is ignored by Git but is not loaded unless the process manager loads it.
- Discord's privileged Message Content Intent must be enabled in the Developer Portal.

Do not introduce secrets, tokens, cookies, real uploaded music, or generated media into Git.

## Code conventions

- The Node code uses CommonJS (`require`) and semicolons.
- Keep configuration near the top of `index.js` and use environment variables for secrets or deploy-specific values.
- Prefer small named helpers for filesystem, voice, authentication, and validation behavior rather than adding more logic inside event callbacks.
- User-facing Discord errors should be concise; log the underlying exception on the server when useful.
- Preserve absolute, containment-checked path resolution for reads and add equivalent validation for writes.
- Avoid adding dependencies unless they materially simplify or secure the implementation; update both package files through npm when a dependency changes.
- Keep README command, configuration, and routing tables synchronized with code changes.

## Security priorities

The current web uploader should be considered trusted-network/admin-only. When touching it, prioritize:

1. Constrain category and custom filename input to safe basenames and verified destinations under `music/`.
2. Add file-size limits and server-side file/content validation.
3. Escape track and category names before inserting them into HTML or JavaScript.
4. Require HTTPS at the deployment boundary and retain authentication for all state-changing routes.
5. Add Discord authorization and rate limiting if the bot will be shared beyond trusted users.

Do not weaken `safeResolveMp3`, Basic Auth coverage, or secret handling while making unrelated changes.

## Known issues and deliberate warnings

- `bb.py` and Discord `!upload` are broken legacy code pending removal.
- `npm test` is a placeholder that always fails; there is no automated test suite.
- Upload write paths are currently derived from untrusted form fields without adequate containment checks.
- Uploaded files are not limited or validated beyond the browser's file-picker hint.
- Generated HTML does not escape filesystem-derived labels.
- The singleton player means one guild can interrupt another guild's playback.
- An existing guild voice connection is reused without moving it to a newly requested channel.
- Web channel selection is implicit and cache-order dependent.
- Temporary/runtime persistence is unmanaged; deployments must mount or back up `music/` themselves.

Keep known limitations visible. Do not silently describe intended behavior as if it were already implemented.

## Change workflow

1. Inspect `git status` before editing and preserve unrelated user changes.
2. Read the complete affected path in `index.js`; related UI, route, player, and catalog logic all live in the same file.
3. Make the smallest coherent change and update documentation in the same patch.
4. Run syntax and relevant available checks.
5. Manually exercise affected Discord behavior in a non-production server when credentials and voice access are available.
6. Report unverified runtime behavior explicitly; never imply a live Discord or upload test ran when it did not.

## Verification baseline

Run at least:

```sh
node --check index.js
```

Until tests are added, use a targeted manual checklist as applicable:

- Bot fails fast with a clear message when `DISCORD_TOKEN` is absent.
- Bot logs in and the Express listener starts with valid configuration.
- `!list` reflects root and first-level category MP3s.
- `!play` rejects missing files and callers outside voice.
- Playback starts, replacement playback works, and `!stop` disconnects.
- The bot disconnects when the last human leaves.
- Web routes reject missing or invalid Basic Auth.
- Upload destinations remain inside `music/`.
- `/discord/` proxy rewriting reaches the corresponding Express routes.
- Web play requires a human in voice; web stop clears all connections.

If adding tests, replace the failing placeholder `npm test` script with a real non-network test command and document it in `README.md`.
