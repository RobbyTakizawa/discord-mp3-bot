# Coding Agent Context

## Purpose

This repository is a small Discord MP3 soundboard. Keep its supported core focused on local MP3 storage, Discord voice playback, and the authenticated web upload/control panel. The authenticated web uploader is the only supported upload path; remote URL ingestion is outside the product scope.

## Read first

- `README.md` describes the user-facing setup, behavior, reverse-proxy contract, and known risks.
- `ROADMAP.md` records the agreed stabilization order, target boundaries, and later product work. Roadmap items are not implemented behavior until the code and README are updated.
- `index.js` composes the runtime; `config.js`, `catalog.js`, `discord-adapter.js`, `render.js`, and `web-app.js` provide testable boundaries.
- `package.json` and `package-lock.json` are the source of truth for Node dependencies.

There are no database migrations or build system in the current repository. Tests use temporary filesystem fixtures under `test/`.

## Architecture

One Node.js process owns all runtime behavior:

- A `discord.js` client listens for `!` prefix commands and voice-state changes through `discord-adapter.js`.
- A single `@discordjs/voice` audio player is shared globally.
- `voice-session.js` owns that player, at most one connection, the active target and resource, and serialized lifecycle operations.
- Express serves a server-rendered control panel and JSON control endpoint.
- Multer stages bounded uploads in `.discord-mp3-upload-staging/`; `upload-storage.js` validates and exclusively publishes them into the local `music/` tree.
- Catalog functions in `catalog.js` rescan the filesystem synchronously when requested.
- `web-app.js` constructs the Express application without listening; `runtime-preflight.js` checks FFmpeg, FFprobe, and Opus; `index.js` owns process startup and Discord login.
- `operational-logger.js` emits concise JSON lifecycle and request events while omitting secret-named fields. Each HTTP response receives a generated request ID; request logs do not include query strings, credentials, cookies, or bodies.

Runtime data is filesystem-only. `music/` is created at startup and ignored by Git. There is no queue, database, cloud storage, or per-guild player state.

## Current supported behavior contract

- `!help`, `!list`, `!play`, and `!stop` are the supported Discord commands.
- Command names are case-insensitive; Discord replies suppress mentions and reply pings, escape filesystem-derived Markdown/control characters, and chunk long catalog output to 2,000 characters.
- Optional guild allowlists, controller-role restrictions for play/stop, and per-user cooldowns are disabled by default.
- A Discord `!play` caller must already be in a voice channel.
- Starting a track immediately replaces the current track.
- A different Discord or web target moves the single global session after destroying its previous connection.
- Root MP3s appear under the logical `uncategorized` label but physically live directly in `music/`.
- Categories are immediate subdirectories of `music/`; discovery does not recurse into deeper levels.
- Only filenames ending in lowercase `.mp3` are cataloged.
- `safeResolveMp3` must continue to prevent resolution outside `music/` for playback paths.
- Uploads accept only `uncategorized` or an existing, real immediate category; category symlinks are rejected.
- Upload basenames are NFC-normalized, conservatively constrained, limited to 100 characters, and published as lowercase `.mp3` filenames without overwriting duplicates.
- Upload requests accept one file up to 25 MB, stage outside the catalog, require FFprobe identification plus a bounded FFmpeg decode sample within a shared ten-second timeout, and clean up rejected or aborted staging files.
- The bot destroys its connection when no human members remain in its voice channel.
- Web playback chooses the first cached voice channel with a human member across all guilds.
- Discord stop, web stop, last-human departure, and graceful shutdown all clear the same global session; stop is idempotent.

Changing any of these semantics requires corresponding README updates and focused manual verification.

## Frozen stabilization acceptance contract

Phase 1 behavior decisions are complete. The Phase 5 voice-session implementation and automated tests now converge on these results. Phase 5 was closed by owner direction on 2026-08-21 without live non-production Discord verification:

- Exactly one global voice session owns the player, at most one connection, one target guild/channel, and one current resource.
- Successful Discord or web play replaces the current resource. A different selected target destroys the old connection and moves the session so only the new connection is subscribed.
- Discord play targets the caller's voice channel and rejects callers outside voice without disturbing an active session.
- Web play retains the temporary first-cached-voice-channel-with-a-human rule and rejects no-target requests without disturbing an active session.
- Discord stop, web stop, last-human departure from the active channel, and graceful shutdown all clear the same global session. Stop is idempotent.
- Discovery and playback identifiers accept only root tracks or one immediate category level, only catalog lowercase `.mp3` filenames, preserve the logical `uncategorized` label for physical root files, and remain contained beneath `music/`.
- The web uploader rejects duplicate final destinations by default. Replacement requires a separate explicit future operation.
- Basic Auth remains on every web route and HTTPS remains mandatory at the deployment boundary.
- Generated form actions, control requests, and back links use relative URLs and work from both the direct Express root and a prefix-stripping `/discord/` reverse proxy.
- Supported Discord commands remain `!help`, `!list`, `!play`, and `!stop`; no queue, simultaneous multi-guild playback, nested catalog, database, cloud storage, or remote URL ingestion is introduced during stabilization.

The global session, unified stop paths, target movement, serialized operations, disconnect handling, and graceful shutdown wiring are implemented. Keep the outstanding live Discord verification visible as a Phase 9 release gate until it is performed; never imply that Phase 5's administrative closeout means the live checks ran.

## Web routing contract

The generated HTML now uses relative URLs, so the panel actions work at the direct Express root and beneath the `/discord/` prefix-stripping proxy.

Express defines `/`, `/upload`, and `/api/control`. The generated HTML uses relative URLs, so it works at the direct root and when a reverse proxy publishes `/discord/` and strips that prefix before forwarding requests to Express. Minimal unauthenticated `GET /healthz` and `GET /readyz` routes are intentional operational exceptions: liveness reports HTTP availability, while readiness requires completed Discord login plus a currently ready client.

Do not casually change only one side of this contract. If routing is revised, update all form actions, fetch URLs, back links, Express routes, deployment examples, and tests together.

Relative browser URLs are implemented, covered by direct-root tests, and were verified through the production prefix-stripping `/discord/` proxy on 2026-08-21.

Every operator route is protected by the local `basicAuth` middleware. Preserve authentication on any new control, upload, delete, or administrative route; health and readiness must remain minimal and disclose no configuration or secrets.

All state-changing web routes also require the process-local CSRF token and pass through the in-memory mutation rate limiter. The panel uses per-response CSP nonces and restrictive security headers. Preserve these boundaries and keep generated actions relative.

## Environment and toolchain

- Node.js `>=22.12.0` is required by `@discordjs/voice@0.19.x`.
- The production service was moved from its obsolete Node.js 18 pin to `/usr/bin/node-24` through a systemd drop-in during the verified 2026-08-21 deployment.
- Install exact Node dependencies with `npm ci`.
- Use `npm start` to run the validated entry point.
- Startup requires working system `ffmpeg` and `ffprobe` executables on `PATH` and a loadable `opusscript` encoder.
- Required environment variables: `DISCORD_TOKEN` and `WEB_PASS`.
- Optional Discord policy variables: `DISCORD_ALLOWED_GUILD_IDS` and `DISCORD_CONTROLLER_ROLE_IDS` are comma-separated Discord IDs; `DISCORD_COMMAND_COOLDOWN_MS` defaults to `0` (disabled) and accepts integers through `3600000`.
- Web variables: `WEB_USER` defaults to `uploader`; `WEB_HOST` defaults to `127.0.0.1`; `WEB_PORT` defaults to `3000`. Invalid or empty startup values fail before login or listening.
- The supported pure-JavaScript `opusscript` encoder is intentional for this singleton workload; it avoids the advisory-bearing native `@discordjs/opus` installation chain at the cost of lower encoding performance.
- The app does not import `dotenv`; a `.env` file is ignored by Git but is not loaded unless the process manager loads it.
- Discord's privileged Message Content Intent must be enabled in the Developer Portal.

Do not introduce secrets, tokens, real uploaded music, or generated media into Git.

## Code conventions

- The Node code uses CommonJS (`require`) and semicolons.
- Keep configuration parsing in `config.js` and use environment variables for secrets or deploy-specific values.
- Prefer small named helpers for filesystem, voice, authentication, and validation behavior rather than adding more logic inside event callbacks.
- User-facing Discord errors should be concise; log the underlying exception on the server when useful.
- Preserve absolute, containment-checked path resolution for reads and add equivalent validation for writes.
- Avoid adding dependencies unless they materially simplify or secure the implementation; update both package files through npm when a dependency changes.
- Keep README command, configuration, and routing tables synchronized with code changes.

## Security priorities

The current web uploader should be considered trusted-network/admin-only. When touching it, prioritize:

1. Preserve canonical containment, the basename policy, existing-category rule, symlink rejection, and exclusive duplicate-safe publication for upload writes.
2. Preserve multipart limits, out-of-catalog staging, bounded FFprobe validation, and cleanup on every failure or abort path.
3. Retain context-safe escaping, nonce-based CSP, CSRF validation, and security headers for web output and actions.
4. Require HTTPS at the deployment boundary and retain authentication plus rate limiting for all state-changing routes.
5. Configure the optional Discord guild allowlist, controller roles, and cooldown if the bot will be shared beyond trusted users.

Do not weaken `safeResolveMp3`, Basic Auth coverage, or secret handling while making unrelated changes.

## Known issues and deliberate warnings

- Web authentication is still one shared Basic Auth identity, and its process-local rate limits reset on restart.
- Startup depends on system FFprobe and FFmpeg executables plus the Opus encoder; the process fails before login or listening when any preflight check fails.
- After preflight, HTTP intentionally listens before Discord login so probes can observe startup. Readiness remains false until login succeeds, and login rejection closes the partial runtime with a failing exit status.
- Categories cannot be created by the uploader; only the root and existing immediate real directories are valid targets.
- Discord access controls and cooldowns exist but are disabled by default, so an unconfigured bot accepts supported commands from every visible user and guild.
- The singleton player means one guild can interrupt another guild's playback.
- An existing guild voice connection is reused without moving it to a newly requested channel.
- Web channel selection is implicit and cache-order dependent.
- Runtime persistence remains operator-managed; deployments must mount `music/` at the repository path and follow the documented backup/restore procedure. Phase 0 produced an off-server archive and full restore test, but the current README command sequence was not rerun when Phase 8 was closed by owner direction.
- The production Nginx proxy still exposed its `nginx/1.28.1` version token when Phase 8 was closed by owner direction, despite the documented `server_tokens off` recommendation.

Keep known limitations visible. Do not silently describe intended behavior as if it were already implemented.

## Server-operation guidance

Assume the repository owner is not familiar with server administration. When work must be performed on the deployed server, do not hand off a high-level checklist by itself. Provide explicit, ordered, copy-pasteable commands whenever safely possible.

The current deployment is accessed as `ec2-user@18.216.161.208` with the identity file at `C:\Users\Robby\newkey.pem`. The identity file is outside the repository; never copy it into the repository, print its contents, or commit it.

- SSH access is for deployment, operations, inspection, and verification—not code authoring. Make every code change in the local repository at `C:\Users\Robby\discord-mp3-bot`, review and validate it locally, and then deploy the exact validated artifact to production. Never create or edit application source code directly on the server, including with interactive editors, shell substitutions, inline scripts, or emergency hotfixes. If production differs from the local source, inspect and copy the relevant production state back to a safe local comparison file before deciding what to change; do not reconcile it by editing production in place.
- Obtain the owner's permission before beginning a new category of server work. Once the owner authorizes the task, proceed independently with all low-risk, bounded operations needed to complete it; do not repeatedly ask permission for routine SSH calls or safe checkpoints. Permission is not blanket authorization for newly discovered high-risk, destructive, host-wide, or materially broader actions.
- Low-risk standing authorization includes read-only discovery and health checks; bounded log inspection; syntax and dependency-load checks that do not build or install; staging files outside live paths; creating new timestamped, permission-restricted backups with application-consistent tools; checksums and restore verification; copying verified backups off-server; atomic deployment of already-validated files; and controlled restart of only the in-scope Discord service when a verified rollback is ready and colocated services are checked before and after.
- Low-risk actions should be performed directly through SSH. Give concise progress and results instead of instructions for the owner to execute. Ask the owner to run commands only when direct access is unavailable or an interactive step genuinely requires them.
- Begin with read-only discovery commands to identify the operating system, application path, process manager, reverse proxy, container setup, service name, and music-directory location instead of expecting the owner to know them.
- Separate commands that are safe to run verbatim from commands containing placeholders. Define every placeholder and show a concrete example.
- State where each command must be run, whether it needs elevated privileges, and what successful output or state should look like.
- For configuration changes, provide the exact file to edit and the complete relevant configuration block. Include syntax checks, reload or restart commands, and post-change verification.
- For backups or other data-sensitive operations, verify source and destination paths first, avoid overwriting live data during restore tests, and include a rollback or recovery procedure.
- Break instructions into small checkpoints and ask the owner to paste command output when the next command depends on details of their environment.
- Never claim an operational roadmap phase is complete until its server-side completion conditions have been verified.

## Production server safety

The EC2 host is a shared production server. In addition to this Discord bot, it runs a book-tracker website backed by SQLite. Protecting the unrelated website and its data takes priority over completing Discord work quickly.

- Before every production mutation, identify the command's complete blast radius, affected processes, expected CPU, memory, disk, and network load, downtime, failure modes, and rollback path. If any of these are unknown, stop and investigate read-only first.
- Inventory colocated services, active users, listening ports, current load, available RAM, configured swap, free disk space, and service restart policies before installing packages, rebuilding native modules, changing runtimes, or restarting anything.
- Do not compile native dependencies or run other resource-intensive work on the production host until capacity has been measured and shown sufficient. Prefer building and testing elsewhere, then deploying the verified artifact. Adding swap, resizing the instance, or changing build concurrency requires its own risk review and permission.
- Treat package installation, global runtime selection, `npm ci`, native builds, unbounded or resource-intensive commands, termination of processes not created by the current low-risk step, firewall or security-group changes, credential rotation, database writes or migrations, proxy changes, changes to unrelated services, and host lifecycle operations as high-risk material steps. Explain the exact impact and obtain explicit permission immediately before each step.
- A controlled restart of only `discord-mp3-bot.service` is pre-authorized when it is required to activate an already-validated Discord-only change, expected downtime is a few minutes or less, rollback is verified, and the book tracker plus Nginx are checked immediately before and after. Restarting the book tracker, Nginx, SSH, or any host-wide target is not covered by this standing authorization.
- Never reboot, stop, resize, or terminate the EC2 instance without separate, immediate owner approval after explaining that every colocated service will be interrupted. A prior request to maintain the Discord bot is not permission to affect the whole host.
- Before any action that might interrupt the book tracker or host, locate its SQLite database and journal/WAL files, identify its service, create an application-consistent backup using a SQLite-aware method, verify that backup, and document the restore procedure. Never copy only the main database file while writes may be active.
- Create and verify rollback artifacts before a mutation, but do not assume that having a rollback makes a risky action acceptable. Confirm that rollback can be executed under the same failure conditions the change might create.
- Use small checkpoints. After each mutation, verify host responsiveness and every affected and colocated service before continuing. If resource pressure, loss of access, or an unexpected effect appears, stop the current work; do not proceed to the next mutation or broaden recovery without permission.
- Never experiment on production. If a command has not been validated in a comparable non-production environment and could affect availability or persistent data, present the risk and wait for direction.

## Change workflow

1. Inspect `git status` before editing and preserve unrelated user changes.
2. Read the complete affected application paths; runtime composition is in `index.js`, with catalog, rendering, and web routes in their respective modules.
3. Make the smallest coherent change and update documentation in the same patch.
4. After every code change, review this `AGENTS.md` context and update it in the same patch whenever the change affects supported behavior, architecture, configuration, environment or deployment requirements, routes, dependencies, security boundaries, known limitations, or verification expectations. If none of that context changed, no `AGENTS.md` edit is required.
5. Run syntax and relevant available checks.
6. Manually exercise affected Discord behavior in a non-production server when credentials and voice access are available.
7. Report unverified runtime behavior explicitly; never imply a live Discord or upload test ran when it did not.

## Verification baseline

Run at least:

```sh
node --check index.js
npm test
```

Use a targeted manual checklist as applicable:

- Bot fails fast with a clear message when `DISCORD_TOKEN` is absent.
- Bot logs in and the Express listener starts with valid configuration.
- `!list` reflects root and first-level category MP3s.
- `!play` rejects missing files and callers outside voice.
- Playback starts, replacement playback works, and `!stop` disconnects.
- The bot disconnects when the last human leaves.
- Web routes reject missing or invalid Basic Auth.
- `/healthz` reports HTTP liveness without authentication and `/readyz` tracks live Discord readiness.
- Upload destinations remain inside `music/`.
- `/discord/` proxy rewriting reaches the corresponding Express routes.
- Web play requires a human in voice; web stop clears all connections.

Keep the real non-network `npm test` command and its documented scope synchronized with the test suite.
