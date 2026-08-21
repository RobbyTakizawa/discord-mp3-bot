# Discord MP3 Bot Roadmap

This document records the repository assessment performed on 2026-08-21 and the recommended order of work. It separates the stabilization required for the current soundboard from later product enhancements.

The supported product remains deliberately small: local MP3 storage, Discord voice playback, and an authenticated web upload/control panel. YouTube downloading and conversion are not part of the future direction.

## Direction

Do not rewrite the application from scratch. The current integrations and product model are appropriate, and the supported Node.js implementation is small enough to improve safely in place.

Use a staged structural refactor instead:

- Preserve the documented behavior while tests are introduced.
- Remove the abandoned Python/YouTube path.
- Harden filesystem and web boundaries before adding features.
- Extract testable modules until `index.js` is only the process bootstrap.
- Manage playback through one explicit global voice session for the current product.
- Keep CommonJS, one Node.js process, local filesystem storage, and server-rendered HTML for now.

Do not add a database, frontend framework, TypeScript migration, queue, cloud storage, or microservices merely as part of the cleanup. Those changes should be justified by a concrete later feature.

## Current assessment

### Critical security boundaries

1. **Upload destinations are not contained.** Category and custom filename fields currently influence Multer paths without server-side basename or containment validation. Traversal can create directories and write or overwrite `.mp3`-suffixed files outside `music/` wherever the process has permission.
2. **The panel has stored-XSS paths.** Filesystem-derived categories, track names, and upload result paths are interpolated into HTML and inline JavaScript without context-appropriate escaping. URL encoding does not make inline JavaScript safe.
3. **Uploads are unbounded and unverified.** There are no file-size or field-count limits, actual MP3 validation, safe staging workflow, duplicate policy, or reliable failed-upload cleanup.

Until these issues are fixed, treat the panel as trusted-network administration only, keep it behind HTTPS, and do not expose it broadly to the internet.

### Voice lifecycle and correctness

- One audio player is shared globally, while voice connections can remain active in multiple guilds. Subscribing the player to another connection can send the next resource to multiple servers.
- An existing guild connection is reused without checking whether it is in the newly requested channel.
- Discord `!stop` stops the global player but destroys only the requesting guild's connection, while web stop destroys all connections.
- `NoSubscriberBehavior.Play` allows a resource to continue after its last subscription disappears.
- Web and Discord control actions are not serialized and can race.
- Web playback still chooses the first cached voice channel containing a human member, so target selection is implicit.

For the current product, the recommended rule is one globally active voice session: one player, one active guild/channel connection, and one current resource. Starting playback moves that session to the new target. Stop and shutdown clear the complete session. True simultaneous multi-guild playback belongs in the later roadmap.

### Structure and testability

- `index.js` owns configuration, catalog scanning, Discord events, voice state, Express routes, upload storage, HTML rendering, login, and listening.
- Importing the module has process side effects, which prevents isolated unit and HTTP tests.
- `npm test` is a placeholder that intentionally fails.
- Catalog and path behavior have no regression tests despite being security-sensitive.
- There is no automated coverage for authentication, rendering, uploads, routing, command parsing, or voice state transitions.

### Dependencies and runtime

At the time of the assessment:

- `node --check index.js` passed.
- Node.js 24.16.0 satisfied the required runtime range.
- FFmpeg was not found in the assessment environment, so live playback could not be verified there.
- `npm audit --omit=dev` reported 15 production-tree advisories: 1 critical, 10 high, 3 moderate, and 1 low. Some are transitive or installation-time findings rather than directly reachable application vulnerabilities.
- Available direct upgrades included `@discordjs/voice` 0.19.2, `discord.js` 14.27.0, and Multer 2.2.0.
- The native `@discordjs/opus` installation chain had unresolved audit findings through `@discordjs/node-pre-gyp` and `tar`.
- `prism-media` appeared redundant as a direct dependency because the application does not import it and `@discordjs/voice` already provides it.

Dependency versions and advisories are time-sensitive. Rerun `npm outdated` and `npm audit --omit=dev` immediately before dependency work rather than treating this snapshot as current forever.

### Additional gaps

- `!list` can exceed Discord's message-size limit.
- Filesystem names can affect Discord Markdown or unintended mentions.
- Catalog ordering is not deterministic, and one unreadable category can abort the remainder of a scan.
- Guessed playback paths can reach deeper files even though discovery documents only one category level.
- Discord commands have no guild, role, or user authorization.
- Generated browser actions depend on a hard-coded `/discord/` reverse-proxy arrangement and fail when the rendered page is used directly at the root port.
- Basic Auth depends on HTTPS at the deployment boundary and currently has no rate limiting or CSRF defense.
- Startup does not coordinate Discord readiness with HTTP readiness.
- There is no graceful shutdown, health/readiness reporting, or structured operational logging.
- Package metadata lacks useful `start` and real `test` scripts and an `engines` declaration.
- Music backup and restore remain deployment responsibilities without a verified procedure.

## Target structure

The exact filenames may evolve, but responsibilities should converge on these boundaries:

| Boundary | Responsibility |
| --- | --- |
| Process bootstrap | Validate startup, construct components, log in, listen, and shut down |
| Configuration | Parse and validate environment values without process side effects |
| Catalog and storage | Track discovery, identifier rules, and safe read/write resolution |
| Voice session | Own the player, active connection, current target, and serialized operations |
| Discord adapter | Command parsing, authorization, replies, and Discord event translation |
| Web application | Express middleware, authentication, upload/control routes, and errors |
| Web rendering | Escaped HTML plus static browser CSS and JavaScript |
| Tests | Temporary-filesystem, HTTP, command, and mocked-voice coverage |

Configuration and core modules should be importable without a Discord token, login attempt, open port, or write to the repository.

## Current needed work

The order below is intentional. Each numbered phase should remain a focused, reviewable change set where practical.

### 0. Contain the current deployment — Complete (2026-08-21)

Before implementation:

- Keep the panel off the public internet or restrict it to a trusted network.
- Require HTTPS at the reverse proxy.
- Bind to loopback unless explicit container networking requires another host.
- Back up `music/` and confirm the restore path.
- Consider rotating web credentials if the panel has been broadly reachable.
- Install FFmpeg and FFprobe in the verification environment.

Completion record:

- Express now binds to `127.0.0.1`, so port 3000 is not directly reachable from the internet.
- Nginx continues to publish `/discord/` over HTTPS, and the application retains Basic Auth on every web route.
- The runtime `music/` library was archived, fully restore-tested, copied off-server, and verified by SHA-256. The colocated book tracker's SQLite database also received an application-consistent, integrity-checked off-server backup before further service work.
- FFmpeg and FFprobe are installed, and the preserved Opus module loads successfully under the Discord service's pinned runtime.
- Web credential rotation was considered and declined; the existing credential remains in use.

Accepted design decision: the owner chose to keep `/discord/` internet-addressable through the HTTPS reverse proxy with Basic Auth instead of restricting it by client IP or trusted network. Phase 0 is considered complete with this explicit exception to the original network-restriction recommendation. This decision does not classify the uploader as hardened or remove the upload validation, output escaping, rate limiting, CSRF, or authentication work in later phases.

### 1. Freeze the behavior decisions — Complete (2026-08-21)

- Adopt one globally active voice session for the current product.
- Move that session when a new Discord or web target is selected.
- Make Discord and web stop clear the same global state.
- Keep root tracks, one-level categories, lowercase `.mp3` discovery, and local storage.
- Reject duplicate uploads by default instead of silently overwriting them.
- Keep Basic Auth temporarily, but only behind HTTPS.
- Make browser actions work both directly and through the documented reverse proxy, preferably with relative URLs.
- Turn these rules into an acceptance checklist before implementation changes begin.

Completion condition: ambiguous behavior has an explicit expected result that tests and documentation can share.

Accepted behavior checklist:

- **Session ownership:** The supported product has exactly one globally active voice session: one player, at most one Discord voice connection, one target guild/channel, and one current resource. It does not support simultaneous per-guild playback.
- **Play and move:** A successful Discord or web play request replaces the current resource. If its selected target differs from the active target, the bot moves the global session by destroying the old connection and establishing only the new one before playback continues.
- **Discord targeting:** `!play` requires the caller to be in a voice channel and selects that channel. A caller outside voice receives a concise rejection and does not disturb the active session.
- **Web targeting:** Until explicit target selection is added, web play selects the first cached voice channel containing a human member across all guilds. If no such channel exists, it rejects the request without disturbing the active session.
- **Stop and departure:** Discord stop, web stop, last-human departure from the active channel, and graceful shutdown all stop the player, destroy the active connection, and clear the same global session state. Stop is idempotent when no session exists.
- **Catalog and identifiers:** Root tracks physically remain in `music/` and appear under `uncategorized`; categories are immediate child directories; discovery and valid playback identifiers are limited to the root and one category level; only filenames ending in lowercase `.mp3` are cataloged; and playback resolution remains contained beneath `music/`.
- **Upload duplicates:** The authenticated web uploader rejects an upload whose final destination already exists. Replacement is not implicit and requires a future explicit operation.
- **Authentication:** Basic Auth remains the temporary authentication mechanism for every panel, upload, control, and future administrative route, and the deployment boundary must provide HTTPS.
- **Browser routing:** Generated form actions, control requests, and back links use relative URLs so the same page works both at the direct Express root and beneath the documented `/discord/` prefix-stripping reverse proxy.
- **Supported scope:** `!help`, `!list`, `!play`, and `!stop` remain the supported Discord commands. There is no queue, database, cloud storage, arbitrary nested catalog, or supported YouTube conversion path.

This checklist is the target contract for subsequent implementation and tests. Phase 1 records decisions only; known mismatches in the current code remain visible in `README.md` and are addressed by later phases.

### 2. Remove the abandoned feature

- Remove the Discord `!upload` command.
- Delete `bb.py`.
- Remove Python, cookie, download, cache, and conversion-specific guidance and ignore rules that no longer apply.
- Keep `!help`, README command documentation, and `AGENTS.md` synchronized.

Completion condition: the authenticated web uploader is the only upload path and no stale YouTube/Python workflow remains.

### 3. Establish the first testable boundaries

- Replace the failing test placeholder with Node's built-in test runner.
- Extract configuration, catalog/path handling, and web rendering first.
- Construct the Express application without immediately listening.
- Let Discord handlers and voice code receive mocked dependencies.
- Use temporary music directories in tests.
- Add characterization tests for the current catalog, identifier, authentication, and routing contracts.

Initial tests should cover root tracks, one-level categories, lowercase extensions, missing tracks, traversal attempts, Basic Auth, and direct/proxied browser URLs.

Completion condition: the most security-sensitive pure behavior is independently testable without Discord credentials or a network listener.

### 4. Harden upload storage and web output

- Accept only `uncategorized` or an existing immediate category.
- Define and test a conservative category and filename policy.
- Normalize Unicode and reject separators, dot segments, empty names, reserved names, and control characters.
- Resolve and verify every final destination beneath the canonical `music/` directory.
- Define and test how symlinks are handled.
- Limit files, bytes, fields, and field lengths.
- Upload to a random staging filename outside the visible catalog.
- Verify that the staged file is decodable MP3-compatible audio, with bounded validation work.
- Atomically move valid files into place and remove partial or invalid files.
- Reject duplicate destinations with `409 Conflict` unless replacement is an explicit future operation.
- Upgrade Multer to a patched release.
- Escape every rendered text and attribute context.
- Remove inline event handlers and introduce a restrictive Content Security Policy.
- Add consistent errors, security headers, CSRF defense, and appropriate rate limits.

Completion condition: automated tests cover traversal, stored XSS, invalid and oversized uploads, duplicate handling, aborted-upload cleanup, and authentication on every state-changing route.

### 5. Introduce a voice-session controller

Create one owner for:

- The audio player and resource.
- The active guild and voice channel.
- Connection join, move, reconnect, and destroy behavior.
- Serialized play and stop operations.
- Player and connection errors.
- Resource completion and last-human departure.
- Graceful process shutdown.

Ensure that only the intended connection is subscribed. A request for another target must deliberately move the session. Destroying the last subscription must not leave an unwanted resource running.

Completion condition: state transitions have automated tests with fakes and pass the focused non-production Discord voice checklist.

### 6. Complete modularization and command robustness

- Leave `index.js` as a small composition/startup file.
- Move Discord commands and Express routes into their adapters.
- Chunk or paginate Discord catalog output.
- Prevent unintended mentions and unsafe Markdown effects.
- Normalize and validate commands consistently.
- Return concise user errors while logging useful underlying details.
- Add optional guild allowlists and controller-role restrictions.
- Add per-user cooldowns if the bot is shared beyond a trusted group.
- Sort catalog output deterministically and isolate per-category scan failures.
- Ensure playback identifiers obey the same depth rules as discovery.

Completion condition: changing a web route, Discord command, catalog rule, or voice rule no longer requires editing unrelated concerns in one monolithic file.

### 7. Refresh dependencies and runtime configuration

- Upgrade Discord.js, `@discordjs/voice`, Multer, and safe transitive dependencies in reviewable batches.
- Remove the redundant direct `prism-media` declaration if verification confirms it is unnecessary.
- Evaluate `opusscript` against the native `@discordjs/opus` installation chain for this workload.
- If native Opus remains, document the accepted residual risk and use a controlled, immutable build environment.
- Add `engines`, `start`, and real `test` scripts.
- Validate host, port, credentials, base path, and authorization configuration at startup.
- Add a clear FFmpeg/Opus dependency preflight.
- Rerun tests and the production dependency audit after every batch.

Do not use an unreviewed `npm audit fix --force` as a substitute for understanding dependency changes.

Completion condition: supported versions are explicit, startup failures are actionable, direct dependencies are intentional, and remaining advisories are either resolved or documented with context.

### 8. Stabilize startup, routing, and deployment

- Use relative or consistently configurable browser URLs.
- Handle Discord login rejection explicitly.
- Define whether HTTP can serve before Discord is ready and expose readiness accurately.
- Add graceful SIGINT and SIGTERM handling.
- Add minimal health and readiness endpoints.
- Disable unnecessary server-identification headers.
- Add request IDs and concise structured logs without secrets.
- Document bind host, reverse-proxy headers, HTTPS, persistent-volume ownership, backup, and restore.

Completion condition: direct access and `/discord/` proxy access are both verified, startup/shutdown states are observable, and deployment assumptions are explicit.

### 9. Release verification and documentation

Automated gates:

- `node --check index.js`
- A real `npm test`
- `npm audit --omit=dev`, with remaining findings reviewed rather than counted blindly
- Tests for traversal, XSS, authentication, upload limits, base paths, catalog rules, and voice transitions

Manual gates:

- Login and HTTP startup with valid configuration
- Root and categorized catalog listing
- Missing-file and outside-voice rejection
- Play, replacement play, channel move, stop, and last-human disconnect
- Web authentication, upload, playback, and global stop
- Direct-port and `/discord/` reverse-proxy behavior
- Invalid, oversized, duplicate, and interrupted uploads
- Restart with persistent music storage

Update `README.md` and `AGENTS.md` in the same release. Explicitly record any live behavior that could not be verified.

## Next steps after stabilization

These are separate product improvements, not prerequisites for securing the current bot.

1. **Slash commands and autocomplete.** Replace privileged message-content parsing with `/play`, `/stop`, `/list`, and track/category autocomplete.
2. **Explicit web target selection.** Show available guilds and voice channels, require an operator choice, and display the current session and track.
3. **Discord OAuth for the panel.** Replace a shared Basic Auth secret with Discord identity and guild/role authorization when the panel has multiple users.
4. **Library administration.** Add authenticated delete, rename, category creation, duplicate replacement, search, and metadata display using the same storage and escaping rules.
5. **Playback controls.** Add now-playing status, volume, pause/resume, replay, random selection, and a small queue after session ownership is stable.
6. **True multi-guild playback, if required.** Replace the global session with a guild-to-session map and require every web action to select a guild and channel.
7. **Metadata persistence.** Introduce SQLite only when aliases, tags, favorites, playlists, uploader identity, or audit history require data beyond filenames.
8. **Operational maturity.** Add container packaging, continuous integration, automated dependency updates, backup verification, metrics, and alerts.
9. **Storage scaling.** Consider object storage or background media processing only if a local persistent volume no longer fits the workload.

## Explicit non-goals

- Restoring YouTube-to-MP3 downloading or `bb.py`
- Hiding known limitations before they are fixed
- Supporting arbitrary nested music directories without a deliberate contract change
- Adding a database solely to reorganize the existing filesystem catalog
- Building simultaneous multi-guild playback before deciding that the bot actually needs it
- Replacing the current stack merely for novelty
