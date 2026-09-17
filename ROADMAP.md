# Discord MP3 Bot Roadmap

This document records the repository assessment performed on 2026-08-21 and the recommended order of work. It separates the stabilization required for the current soundboard from later product enhancements.

The supported product remains deliberately small: local MP3 storage, Discord voice playback, and an authenticated web upload/control panel. The web uploader is the only supported ingestion path.

## Direction

Do not rewrite the application from scratch. The current integrations and product model are appropriate, and the supported Node.js implementation is small enough to improve safely in place.

Use a staged structural refactor instead:

- Preserve the documented behavior while tests are introduced.
- Remove the abandoned remote-media ingestion path.
- Harden filesystem and web boundaries before adding features.
- Extract testable modules until `index.js` is only the process bootstrap.
- Manage playback through one explicit global voice session for the current product.
- Keep CommonJS, one Node.js process, local filesystem storage, and server-rendered HTML for now.

Do not add a database, frontend framework, TypeScript migration, queue, cloud storage, or microservices merely as part of the cleanup. Those changes should be justified by a concrete later feature.

## Current assessment

### Critical security boundaries

1. **Upload storage is hardened.** Uploads accept only the root or an existing immediate category, apply a conservative normalized basename policy, reject symlinked categories and duplicate destinations, and publish validated files from an out-of-catalog staging directory without overwriting.
2. **Browser defenses are in place.** Filesystem-derived output is escaped, scripts and styles use per-response CSP nonces, state changes require a CSRF token, and authentication failures plus state-changing requests have bounded in-memory rate limits.
3. **Uploads are bounded and verified.** Multer limits multipart files, bytes, fields, field sizes, and parts. FFprobe must identify an MP3 audio stream and FFmpeg must decode a bounded sample within a shared ten-second timeout; rejected, oversized, invalid, or aborted staging files are removed.

The panel still uses shared Basic Auth and should remain trusted-administrator tooling behind HTTPS. Optional Discord guild, controller-role, and cooldown policies are available, while stronger multi-user web identity belongs to later work.

### Voice lifecycle and correctness

- One global voice-session controller owns the shared player, at most one connection, the active guild/channel target, the current track/resource, a pending queue (max 100), a loop-current flag, volume (0–100), and a monotonic revision snapshot.
- A request for a different target destroys the old connection before joining and subscribing only the new connection.
- Discord `!play` and web **Play Now** replace the current track and clear the pending queue. Web **Add to Queue** appends (duplicates allowed) and starts immediately when idle; queued playback stays in the current channel.
- Natural completion advances to the next queued entry, recreates the current resource when looping (queue waits), or goes idle while keeping the connection. **Skip** advances even while looping. Queued files are revalidated for containment/existence at start; missing files are skipped. Stale completion/error events from prior resources are ignored via generation IDs.
- Discord `!stop`, web stop, last-human departure, unrecoverable disconnect, and graceful shutdown clear playback, queue, and loop state through an idempotent operation.
- The player uses `NoSubscriberBehavior.Stop`, and losing an unrecoverable connection stops the resource rather than leaving it running without a subscriber.
- Web and Discord play/queue/skip/loop/volume/stop operations are serialized by the controller. Volume uses `inlineVolume` and applies immediately plus to future tracks.
- Web playback still chooses the first cached voice channel containing a human member when idle, so target selection is implicit but now displayed in the panel.

The voice lifecycle is covered by fake-driven state-transition tests, including queue advancement, loop recreation, skip-while-looping, Play Now clearing, stop/departure/disconnect/shutdown clearing, volume, deleted-file skipping, stale events, and concurrent controls. Live Discord verification of play, queue, loop, skip, volume, replacement, movement, stop, departure, reconnection, and shutdown remains outstanding. True simultaneous multi-guild playback belongs in the later roadmap.

### Structure and testability

- `index.js` composes configuration, the Discord and web adapters, login, HTTP startup, and shutdown; command handling, voice lifecycle, catalog access, web routes, rendering, and upload storage are independently importable boundaries.
- Importing the application no longer logs in, listens, or creates runtime directories.
- The Node test suite covers bootstrap, command parsing and authorization, catalog behavior, voice-session transitions, authentication, rendering, routing, upload policy, validation boundaries, rate limiting, CSRF, duplicate rejection, and cleanup.
- Command handling and voice-session state transitions have isolated fake-driven tests.

### Dependencies and runtime

- The supported runtime is explicit at Node.js `>=22.12.0`, with `start` and real `test` package scripts.
- Direct Discord dependencies are refreshed to `@discordjs/voice` 0.19.2 and `discord.js` 14.27.0; Multer was at 2.2.0 and is now resolved to 2.4.0 with transitive `qs` 6.16.0 via a non-force `npm audit fix` (`npm audit --omit=dev` clean).
- Redundant direct `prism-media` and native `@discordjs/opus` declarations were removed. The supported pure-JavaScript `opusscript` 0.0.x fallback was selected for this single-stream bot, avoiding the native downloader/build chain at the accepted cost of lower encoding performance.
- Safe transitive updates cleared the production-tree audit on 2026-08-21. Advisory results are time-sensitive and must still be rerun for release and future dependency work.
- Startup validates the token, web credentials, listener host/port, Discord authorization configuration, FFmpeg, FFprobe, and Opus encoder before login or listening.
- FFmpeg was not available in the local assessment workspace, so the real startup preflight correctly could not pass there; its behavior is covered with injected test doubles. The production preflight subsequently passed under Node.js 24, and a production web play/stop check succeeded. The full Phase 9 Discord voice checklist remains unverified.

### Additional gaps

- Discord catalog responses are chunked to the message-size limit, escape filesystem-derived Markdown, and suppress mentions.
- Catalog output is deterministic, and a failed category scan no longer aborts readable categories.
- Playback identifiers and upload destinations now follow the documented root/one-level catalog depth and containment rules.
- Discord guild allowlists, controller roles, and per-user cooldowns are optional and disabled by default.
- Browser actions now use relative URLs and are covered at the direct root and through a prefix-stripping application mount; the live `/discord/` reverse proxy was verified on 2026-08-21.
- Basic Auth still depends on HTTPS at the deployment boundary. Authentication failure and state-changing request limits are process-local and reset on restart.
- Startup ordering and readiness are explicit: HTTP exposes liveness while Discord connects, and readiness follows the live Discord client state.
- Minimal health/readiness probes and secret-conscious structured request/lifecycle logs are implemented and verified locally and in production.
- Music backup and restore remain operator responsibilities. Phase 0 included a verified off-server archive and full restore test; the current README command sequence was not rerun during the owner-directed Phase 8 closeout.

## Target structure

The exact filenames may evolve, but responsibilities should converge on these boundaries:

| Boundary | Responsibility |
| --- | --- |
| Process bootstrap | Validate startup, construct components, log in, listen, and shut down |
| Configuration | Parse and validate environment values without process side effects |
| Catalog and storage | Track discovery, identifier rules, and safe read/write resolution |
| Media metadata | Cached FFprobe durations keyed by path, size, and mtime |
| Voice session | Own the player, active connection, current target/track, queue, loop, volume, and serialized operations |
| Discord adapter | Command parsing, authorization, replies, and Discord event translation |
| Web application | Express middleware, authentication, upload/library/playback/control routes, and errors |
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

Accepted design decision: the owner chose to keep `/discord/` internet-addressable through the HTTPS reverse proxy with Basic Auth instead of restricting it by client IP or trusted network. Phase 0 is considered complete with this explicit exception to the original network-restriction recommendation. At that point the decision did not classify the uploader as hardened; the upload validation, output escaping, rate limiting, and CSRF work was subsequently implemented in Phase 4.

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
- **Supported scope:** `!help`, `!list`, `!play`, and `!stop` remain the supported Discord commands. There is no queue, database, cloud storage, arbitrary nested catalog, or remote URL ingestion path.

This checklist is the target contract for subsequent implementation and tests. Phase 1 records decisions only; known mismatches in the current code remain visible in `README.md` and are addressed by later phases.

### 2. Remove the abandoned feature — Complete (2026-08-21)

- Remove the Discord `!upload` command.
- Delete `bb.py`.
- Remove Python, cookie, download, cache, and conversion-specific guidance and ignore rules that no longer apply.
- Keep `!help`, README command documentation, and `AGENTS.md` synchronized.

Completion condition: the authenticated web uploader is the only upload path and no stale YouTube/Python workflow remains.

Completion record:

- Removed the Discord `!upload` command and its child-process launch path.
- Deleted `bb.py`; it was the only remote-media helper artifact in the repository.
- Removed obsolete cookie and Python cache/environment ignore rules.
- Updated `README.md` and `AGENTS.md` so the supported command list and web-only upload boundary match the code.
- Confirmed that no package dependency changes were needed because the removed helper's dependencies were never part of the Node package manifests.

### 3. Establish the first testable boundaries

Status: Complete (2026-08-21)

- Replace the failing test placeholder with Node's built-in test runner.
- Extract configuration, catalog/path handling, and web rendering first.
- Construct the Express application without immediately listening.
- Let Discord handlers and voice code receive mocked dependencies.
- Use temporary music directories in tests.
- Add characterization tests for the current catalog, identifier, authentication, and routing contracts.

Initial tests should cover root tracks, one-level categories, lowercase extensions, missing tracks, traversal attempts, Basic Auth, and direct/proxied browser URLs.

Completion condition: the most security-sensitive pure behavior is independently testable without Discord credentials or a network listener.

Completion record:

- Replaced the failing test placeholder with Node's built-in test runner (`node --test`).
- Extracted configuration, catalog/path handling, escaped web rendering, and the Express application factory into importable modules.
- Added temporary-filesystem tests for root and one-level catalog discovery, lowercase extensions, missing files, traversal, and depth validation.
- Added HTTP tests for Basic Auth, direct-root relative browser actions, control routing, and escaped filesystem-derived labels.
- Importing `index.js` no longer requires `DISCORD_TOKEN`, logs in to Discord, opens an HTTP listener, or creates the runtime music directory.

Phase 4 completed the upload storage and browser hardening boundary. Phase 5 and Phase 6 implementation plus automated coverage are complete. The unperformed live Discord checklist remains visible and is carried into the Phase 9 release gates.

### 4. Harden upload storage and web output

Status: Complete (2026-08-21)

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
- Retain context-safe escaping for every rendered text and attribute context.
- Remove inline event handlers and introduce a restrictive Content Security Policy.
- Add consistent errors, security headers, CSRF defense, and appropriate rate limits.

Completion condition: automated tests cover traversal, stored XSS, invalid and oversized uploads, duplicate handling, aborted-upload cleanup, and authentication on every state-changing route.

Completion record:

- Added normalized conservative category and filename validation, canonical containment checks, existing-category enforcement, and explicit rejection of category symlinks and Windows-reserved basenames.
- Changed uploads to random files in a permission-restricted staging directory outside `music/`, validated them with bounded FFprobe identification and FFmpeg decoding, and published them with exclusive hard links so concurrent or existing destinations cannot be overwritten.
- Added multipart limits (one file, 25 MB, bounded fields/parts), MIME and extension screening, consistent upload errors, and cleanup for validation failures, limit failures, CSRF failures, duplicates, and aborted requests.
- Upgraded Multer from 2.0.2 to the patched 2.2.0 release.
- Added per-response CSP nonces, restrictive security headers, CSRF protection for upload and control actions, removal of inline style attributes, and in-memory limits for failed authentication and state changes.
- Added automated coverage for direct and prefix-mounted routing, authentication on state-changing routes, CSRF, traversal, Unicode normalization, reserved names, symlink policy, stored XSS escaping, invalid MIME/audio, oversized files, duplicates, rate limiting, and aborted-upload cleanup.
- Re-ran the production-tree audit after the Multer upgrade: Multer advisories were cleared, while 14 unrelated/transitive findings remain for the later dependency phase (1 critical, 9 high, 3 moderate, and 1 low).

### 5. Introduce a voice-session controller

Status: Complete by owner direction (2026-08-21); live Discord verification was not performed

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

Implementation record:

- Added `voice-session.js` as the single owner of the player, active connection, guild/channel target, and current resource.
- Serialized Discord and web play/stop operations, made target changes destroy the old connection before joining the new target, and unified Discord stop, web stop, last-human departure, and shutdown.
- Changed the player to stop when it has no subscriber, clear completed resources, attempt bounded recovery for disconnected connections, and clear the session after an unrecoverable disconnect or player error.
- Added idempotent SIGINT/SIGTERM runtime cleanup that closes the web listener, clears voice state, and destroys the Discord client while attempting every cleanup step even if one fails.
- Added fake-driven tests for initial play, same-target replacement, cross-target movement, resource failure preservation, serialization, idempotent stop, last-human departure, completion, disconnect failure, and shutdown.
- Local syntax checks and the automated suite passed. On 2026-08-21, the owner directed that Phase 5 be marked complete based on its implementation and fake-driven coverage. The non-production live Discord checklist was not run; no live result is implied, and those checks remain in the Phase 9 manual release gates.

### 6. Complete modularization and command robustness

Status: Complete (2026-08-21)

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

Completion record:

- Added `discord-adapter.js` to own command parsing, safe replies, Discord event translation, web target selection, and optional command-access policy; `index.js` now focuses on composition, startup, and shutdown.
- Normalized supported command names case-insensitively and normalized whitespace in play identifiers while preserving the existing `!` prefix and supported command set.
- Chunked `!list` output at Discord's 2,000-character limit, escaped filesystem-derived Markdown and control characters, and disabled parsing of mentions and reply pings on every bot command response.
- Added optional comma-separated guild allowlists and controller-role restrictions plus a disabled-by-default per-user cooldown.
- Sorted root tracks, categories, and category tracks deterministically and isolated category read failures so other readable categories remain available.
- Added focused configuration, command, authorization, cooldown, output-safety, chunking, web-target, and catalog-failure tests. Local syntax checks and all 34 automated tests pass; live Discord behavior was not exercised in this workspace.

### 7. Refresh dependencies and runtime configuration

Status: Complete (2026-08-21)

- Upgrade Discord.js, `@discordjs/voice`, Multer, and safe transitive dependencies in reviewable batches.
- Remove the redundant direct `prism-media` declaration if verification confirms it is unnecessary.
- Evaluate `opusscript` against the native `@discordjs/opus` installation chain for this workload.
- If native Opus remains, document the accepted residual risk and use a controlled, immutable build environment.
- Add `engines` and `start` scripts; retain the existing real `test` script.
- Validate host, port, credentials, base path, and authorization configuration at startup.
- Add a clear FFmpeg/Opus dependency preflight.
- Rerun tests and the production dependency audit after every batch.

Do not use an unreviewed `npm audit fix --force` as a substitute for understanding dependency changes.

Completion condition: supported versions are explicit, startup failures are actionable, direct dependencies are intentional, and remaining advisories are either resolved or documented with context.

Completion record:

- Refreshed `@discordjs/voice` to 0.19.2 and `discord.js` to 14.27.0, retained patched Multer 2.2.0, and applied safe transitive updates without a forced audit rewrite.
- Removed the unused direct `prism-media` declaration and replaced native `@discordjs/opus` with the supported `opusscript` 0.0.x fallback. The pure-JavaScript encoder initialized successfully under Node.js 24.19.0; lower performance is accepted for the one-stream workload. `npm outdated` reports only `opusscript` 0.1.1; 0.0.8 is intentionally retained because `prism-media` declares the 0.0.x line as its supported optional peer and 0.1.1 produces a resolver warning.
- Added the explicit Node.js `>=22.12.0` engine, `npm start`, and retained the real `node --test` test script.
- Expanded startup validation for the Discord token, required web password, Basic Auth username, listener host/port, guild/role IDs, and cooldown configuration.
- Added fail-fast FFmpeg, FFprobe, and Opus initialization checks before Discord login or HTTP listening, with focused automated coverage for success and actionable failures.
- The production-tree audit fell from 14 findings (1 critical, 9 high, 3 moderate, 1 low) to zero on 2026-08-21 after removing the native installation chain and refreshing safe transitive packages.
- Local syntax checks passed, all 39 automated tests passed with loopback-listener permission, the real `opusscript` encoder initialized, and `npm audit --omit=dev` reported zero findings. No live Discord playback or real FFmpeg/upload behavior was exercised in this workspace.

### 8. Stabilize startup, routing, and deployment

Status: Complete by owner direction (2026-08-21), with accepted operational exceptions recorded below

- Use relative or consistently configurable browser URLs.
- Handle Discord login rejection explicitly.
- Define whether HTTP can serve before Discord is ready and expose readiness accurately.
- Add minimal health and readiness endpoints.
- Disable unnecessary server-identification headers.
- Add request IDs and concise structured logs without secrets.
- Document bind host, reverse-proxy headers, HTTPS, persistent-volume ownership, backup, and restore.

Completion condition: direct access and `/discord/` proxy access are both verified, startup/shutdown states are observable, and deployment assumptions are explicit.

Implementation record:

- Kept relative browser actions and extended direct-root plus prefix-mounted automated coverage to the new operational routes.
- Defined startup ordering explicitly: validated preflight runs first, HTTP listens second so liveness is observable, and Discord login runs third. Readiness stays false until login succeeds and the live Discord client reports ready.
- Added unauthenticated minimal `/healthz` and `/readyz` probes. Discord login rejection is logged, closes the partially started runtime, and produces a failing process status.
- Added generated response/request IDs and concise JSON lifecycle/request logging that excludes query strings, request bodies, authentication headers, cookies, and secret-named fields.
- Retained Express server-header suppression and documented Nginx version-token suppression, HTTPS termination, prefix stripping, forwarded headers, loopback binding, storage ownership, and an offline verified backup/restore workflow.
- Local automated tests cover direct and prefix-mounted probe routing, readiness transitions, login rejection cleanup, request correlation, and secret-field omission.
- Production was deployed at `c98cd8a` under `/usr/bin/node-24` using dependencies prepared in a resource-constrained staging worktree. A failed first restart under the former Node.js 18 runtime was rolled back before the validated Node.js 24 cutover. Nginx and the colocated book tracker remained active, and an integrity-checked application-consistent backup of the book tracker's SQLite database was created before the dependency operation.
- Direct and HTTPS `/discord/` requests returned `200` for both `/healthz` and `/readyz`; readiness reported Discord ready across three guilds. Response request IDs matched concise JSON request logs, and the production web control successfully started playback, reached a ready voice connection, played audio, stopped the player, and destroyed the connection.
- The owner directed Phase 8 to close without two recommended follow-ups: the production proxy still returned `Server: nginx/1.28.1` rather than applying the documented `server_tokens off`, and the current README music backup/restore command sequence was not rerun. Phase 0's verified, off-server music archive and full restore test remain the recorded recovery evidence. These exceptions are not represented as verified behavior.

### 9. Release verification and documentation

Automated gates:

- `node --check index.js`
- A real `npm test`
- `npm audit --omit=dev`, with remaining findings reviewed rather than counted blindly
- Tests for traversal, XSS, authentication, upload limits, base paths, catalog rules, voice transitions, queue/loop/volume, durations, and control/library/playback routing

Manual gates:

- Login and HTTP startup with valid configuration
- Root and categorized catalog listing
- Missing-file and outside-voice rejection
- Play, replacement play, channel move, stop, and last-human disconnect
- Web authentication, upload, Play Now, queue advance, loop, skip, volume, and global stop clearing queue/loop
- Direct-port and `/discord/` reverse-proxy behavior for panel, library, playback, and control
- Invalid, oversized, duplicate, and interrupted uploads
- Restart with persistent music storage (queue/loop/volume intentionally reset)

Update `README.md` and `AGENTS.md` in the same release. Explicitly record any live behavior that could not be verified.

## Playback-controls release (queue, loop, volume, durations)

Status: Implemented with automated tests only; live Discord/proxy verification outstanding.

- Extended `voice-session.js` into a serialized playback state machine with current track, pending queue (max 100, duplicates allowed), loop-current, volume (0–100 via `inlineVolume`), revisioned snapshots, generation-guarded Idle/error handling, and revalidation of queued files at start.
- Added `media-metadata.js` for cached FFprobe durations (path/size/mtime key, bounded concurrency, short timeout, `null` for unknown without breaking the panel).
- Added authenticated `GET /api/playback` and `GET /api/library`; extended `POST /api/control` with `enqueue`, `skip`, `remove`, `clearQueue`, `setLoop`, and `setVolume`, all behind Basic Auth plus CSRF and mutation rate limiting, returning enriched snapshots without absolute paths.
- Rebuilt the panel with now-playing/target/elapsed, volume slider, loop toggle, Play Now/Queue per track, queue list with remove/clear, and inline status; browser uses relative URLs and `textContent`-only DOM updates with periodic refresh while visible.
- Discord `!play` remains immediate replacement (clearing the queue); no new Discord commands. Queued sessions stay in-channel; idle web actions reuse the first-human-channel rule, now displayed.
- Validation follow-ups: cross-target Play Now preserves loop mode (only stop/departure/disconnect/shutdown clear loop); failed joins leave no ghost queue entry and idle enqueue without a target rejects with the no-target 409 instead of queueing; `enqueueWeb` carries a fallback target so a stale connection snapshot cannot ghost; the panel loads library durations once and polls playback separately with in-flight guards, and the metadata cache deduplicates concurrent probes for the same file.
- Non-force dependency patch: Multer 2.2.0 to 2.4.0 with transitive `qs` 6.15.3 to 6.16.0 via `npm audit fix --omit=dev`; `npm audit --omit=dev` reports zero findings and the upload regression suite passes.
- Automated coverage grew from 44 to 77 tests (queue/loop/volume/snapshot, durations/cache/dedup, playback/library/control validation including the no-target 409, CSRF/rate limiting, proxy routing, escaping, stale events, deleted files, concurrency, loop preservation, and ghost-queue rejection). Live non-production Discord testing of play, queue advance, loop, skip, volume, stop, target movement, last-human departure, reconnect, shutdown, plus direct and `/discord/` proxy checks and production CPU observation for `inlineVolume`, remain release gates.

## Next steps after stabilization

These are separate product improvements, not prerequisites for securing the current bot.

1. **Slash commands and autocomplete.** Replace privileged message-content parsing with `/play`, `/stop`, `/list`, and track/category autocomplete.
2. **Explicit web target selection.** Show available guilds and voice channels, require an operator choice, and display the current session and track.
3. **Discord OAuth for the panel.** Replace a shared Basic Auth secret with Discord identity and guild/role authorization when the panel has multiple users.
4. **Library administration.** Add authenticated delete, rename, category creation, duplicate replacement, search, and metadata display using the same storage and escaping rules. Durations are already displayed via the cached FFprobe boundary.
5. **Playback controls.** Now-playing status, volume, loop-current, and a small queue are implemented. Remaining candidates are pause/resume, replay beyond loop-current, random selection, and per-guild targeting after session ownership is stable.
6. **True multi-guild playback, if required.** Replace the global session with a guild-to-session map and require every web action to select a guild and channel.
7. **Metadata persistence.** Introduce SQLite only when aliases, tags, favorites, playlists, uploader identity, or audit history require data beyond filenames.
8. **Operational maturity.** Add container packaging, continuous integration, automated dependency updates, backup verification, metrics, and alerts.
9. **Storage scaling.** Consider object storage or background media processing only if a local persistent volume no longer fits the workload.

## Explicit non-goals

- Adding remote URL ingestion
- Hiding known limitations before they are fixed
- Supporting arbitrary nested music directories without a deliberate contract change
- Adding a database solely to reorganize the existing filesystem catalog
- Building simultaneous multi-guild playback before deciding that the bot actually needs it
- Replacing the current stack merely for novelty
