function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderControlPanel({ musicStructure, categories, session = { revision: 0, pins: [] }, csrfToken = "", nonce = "" }) {
  const dropdownHtml = [
    '<option value="uncategorized">Default (Root /music)</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");

  let controlPanelHtml = "";
  const visibleStructure = Object.fromEntries([
    ["uncategorized", musicStructure.uncategorized || []],
    ...[...new Set([...categories, ...Object.keys(musicStructure)])].filter((name) => name !== "uncategorized")
      .sort().map((name) => [name, musicStructure[name] || []]),
  ]);
  for (const [category, tracks] of Object.entries(visibleStructure)) {
    controlPanelHtml += `
        <details class="category-block" open>
            <summary class="category-title">📁 ${escapeHtml(category.toUpperCase())} (${tracks.length})</summary>
            <div class="song-list">
               ${tracks.length ? "" : '<p class="empty-library">No songs in this folder.</p>'}
               ${tracks.map((song) => {
                 const internalPath = category === "uncategorized" ? song : `${category}/${song}`;
                 return `
                    <div class="song-item" data-song-row="${escapeHtml(internalPath)}">
                        <input type="checkbox" class="js-select-song" value="${escapeHtml(internalPath)}" aria-label="Select ${escapeHtml(song)}">
                        <span class="song-name">${escapeHtml(song)}</span>
                        <span class="song-duration" data-duration-for="${escapeHtml(internalPath)}">…</span>
                        <span class="song-actions">
                          <button class="btn btn-play js-play" data-song="${escapeHtml(internalPath)}">▶ Play Now</button>
                          <button class="btn btn-queue js-enqueue" data-song="${escapeHtml(internalPath)}">＋ Queue</button>
                          <button class="btn btn-small js-pin" data-song="${escapeHtml(internalPath)}">Pin</button>
                          <button class="btn btn-small js-move" data-song="${escapeHtml(internalPath)}">Move…</button>
                        </span>
                    </div>
                 `;
               }).join("")}
            </div>
        </details>
    `;
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Bot Control Panel</title>
        <style nonce="${escapeHtml(nonce)}">
            body { font-family: Arial, sans-serif; background: #2f3136; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .container { background: #36393f; padding: 24px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); width: 100%; max-width: 820px; }
            h2, h3 { margin-top: 0; color: #7289da; text-align: center;}
            h3 { border-bottom: 1px solid #40444b; padding-bottom: 10px; margin-top: 25px; color: #fff; }
            .form-group { margin-bottom: 20px; display: flex; flex-direction: column; }
            label { margin-bottom: 8px; font-weight: bold; color: #b9bbbe; }
            input[type="text"], select, input[type="file"] { padding: 10px; border-radius: 4px; border: 1px solid #202225; background: #40444b; color: #fff; font-size: 14px; }
            .btn { color: #fff; border: none; padding: 12px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 16px; }
            .btn-submit { background: #7289da; width: 100%; margin-top: 10px; }
            .btn-submit:hover { background: #5b73c7; }
            .btn-stop { background: #f04747; width: 100%; margin-bottom: 10px; }
            .btn-stop:hover { background: #fd5d5d; }
            .btn-skip { background: #faa61a; width: 100%; margin-bottom: 20px; color: #202225; }
            .btn-skip:hover { background: #fbb94a; }
            .category-block { background: #2f3136; margin-bottom: 12px; border-radius: 4px; border: 1px solid #202225; overflow: hidden;}
            .category-title { background: #202225; padding: 10px; font-weight: bold; cursor: pointer; user-select: none; color: #b9bbbe; }
            .song-list { padding: 5px 10px; max-height: 240px; overflow-y: auto; }
            .song-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #40444b; }
            .song-item:last-child { border-bottom: none; }
            .song-name { font-size: 14px; overflow-wrap: anywhere; flex: 1; min-width: 80px; color: #e1e1e1; }
            .song-duration { font-size: 12px; color: #b9bbbe; min-width: 44px; text-align: right; }
            .song-actions { display: flex; flex-wrap: wrap; gap: 6px; }
            .btn-play { background: #43b581; padding: 6px 10px; font-size: 12px; }
            .btn-play:hover { background: #3ca374; }
            .btn-queue { background: #7289da; padding: 6px 10px; font-size: 12px; }
            .btn-queue:hover { background: #5b73c7; }
            .empty-library { color: #b9bbbe; text-align: center; }
            .now-playing { background: #2f3136; border: 1px solid #202225; border-radius: 4px; padding: 12px; margin-bottom: 12px; }
            .now-playing-row { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; margin-bottom: 6px; }
            .now-playing-label { color: #b9bbbe; font-weight: bold; }
            .now-playing-value { color: #fff; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
            .playback-controls { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
            .volume-slider { flex: 1; }
            .loop-toggle { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #b9bbbe; }
            .queue-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
            .queue-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #40444b; font-size: 14px; }
            .queue-item:last-child { border-bottom: none; }
            .btn-small { padding: 4px 8px; font-size: 12px; background: #4f545c; }
            .btn-small:hover { background: #5d626b; }
            .btn-clear { background: #4f545c; width: 100%; margin-top: 8px; padding: 8px; font-size: 13px; }
            .status-area { min-height: 20px; font-size: 13px; color: #b9bbbe; margin-top: 10px; text-align: center; }
            .status-area.error { color: #f47fff; }
            .upload-result { font-family: Arial, sans-serif; padding: 20px; background: #2f3136; color: #fff; min-height: 100vh; margin: 0; box-sizing: border-box; }
            .back-link { color: #7289da; text-decoration: none; font-weight: bold; }
            [hidden] { display: none !important; }
            .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
            .toolbar input { flex: 1; min-width: 100px; }
            .hint { font-size: 13px; color: #b9bbbe; line-height: 1.5; }
            .session-list { list-style: none; padding: 0; }
            .session-item { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px; margin-bottom: 8px; background: #2f3136; border-radius: 4px; }
            .session-label { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
            .session-label small { display: block; color: #b9bbbe; margin-top: 4px; }
            button:disabled { opacity: .55; cursor: default; }
            button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #b6c3ff; outline-offset: 3px; }
            dialog { max-width: 420px; border: 1px solid #7289da; border-radius: 8px; background: #36393f; color: #fff; padding: 24px; }
            dialog::backdrop { background: rgba(0,0,0,.65); }
            .upload-section { margin-top: 28px; }
            .upload-section summary { cursor: pointer; padding: 12px 0; font-weight: bold; }
            @media (max-width: 600px) { body { padding: 8px; } .container { padding: 14px; } .song-item { flex-wrap: wrap; } .song-actions { width: 100%; } .song-actions button { min-height: 40px; min-width: 40px; } .playback-controls { flex-wrap: wrap; } #clearSession, .toolbar button { min-height: 40px; } }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Bot Control Panel</h2>
            <h3>Live Audio Control</h3>
            <div class="now-playing">
                <div class="now-playing-row"><span class="now-playing-label">Now playing</span><span class="now-playing-value" id="nowPlayingTrack">Idle</span></div>
                <div class="now-playing-row"><span class="now-playing-label">Voice target</span><span class="now-playing-value" id="nowPlayingTarget">No active target</span></div>
                <div class="now-playing-row"><span class="now-playing-label">Elapsed</span><span class="now-playing-value" id="nowPlayingTime">0:00 / ?:??</span></div>
            </div>
            <div class="playback-controls">
                <label class="loop-toggle" for="volumeRange">Volume</label>
                <input class="volume-slider" type="range" id="volumeRange" min="0" max="100" step="1" value="100">
                <span id="volumeValue">100%</span>
                <label class="loop-toggle"><input type="checkbox" id="loopToggle"> Loop</label>
            </div>
            <button class="btn btn-stop js-stop">🛑 Stop All Playback</button>
            <button class="btn btn-skip js-skip">⏭ Skip Current Track</button>
            <h3>Queue</h3>
            <ul class="queue-list" id="queueList"></ul>
            <button class="btn btn-clear js-clear-queue">Clear Queue</button>
            <div class="status-area" id="controlStatus" aria-live="polite"></div>
            <h3>Next Session</h3>
            <p class="hint">Shared with everyone using this panel. Pin songs below, arrange your scenes, and keep them ready for replay.</p>
            <ol class="session-list" id="sessionBoard"></ol>
            <button class="btn btn-small" id="clearSession">Clear session</button>
            <h3>Library</h3>
            <div class="status-area" id="libraryStatus" aria-live="polite"></div>
            <form id="folderForm" class="toolbar">
                <label for="folderName">New folder</label>
                <input type="text" id="folderName" maxlength="100" placeholder="e.g. Castle ambience" required>
                <button class="btn btn-queue" type="submit">Create Folder</button>
            </form>
            <label for="librarySearch">Search songs and folders</label>
            <div class="toolbar"><input type="text" id="librarySearch" placeholder="Find music…"><button class="btn btn-small" id="reloadLibrary">Refresh library</button></div>
            <div class="toolbar"><span id="selectedCount">0 selected</span><button class="btn btn-small" id="moveSelected" disabled>Move selected…</button></div>
            <p class="hint">Select up to 20 songs to move together. Playing or queued songs must be stopped or removed from the queue first.</p>
            <div class="control-container" id="libraryList">${controlPanelHtml}</div>
            <p class="hint" id="noSearchResults" hidden>No songs or folders match your search.</p>
            <details class="upload-section">
                <summary>Upload audio</summary>
                <form action="upload" method="POST" enctype="multipart/form-data">
                    <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
                    <div class="form-group"><label for="mp3Name">Name the MP3 File (Optional)</label><input type="text" id="mp3Name" name="mp3Name" placeholder="e.g. airhorn (defaults to filename)"></div>
                    <div class="form-group"><label for="category">Target Category Folder</label><select id="category" name="category">${dropdownHtml}</select></div>
                    <button class="btn btn-small js-new-folder" type="button">New folder…</button>
                    <div class="form-group"><label for="mp3">Select MP3 File</label><input type="file" id="mp3" name="mp3" accept=".mp3" required></div>
                    <button type="submit" class="btn btn-submit">Upload Audio</button>
                </form>
            </details>
            <dialog id="moveDialog" aria-labelledby="moveTitle">
                <form id="moveForm">
                    <h3 id="moveTitle">Move songs</h3><p id="moveSummary" class="hint"></p>
                    <div class="form-group"><label for="moveTarget">Destination folder</label><select id="moveTarget">${dropdownHtml}</select></div>
                    <div class="toolbar"><button class="btn btn-play" type="submit">Move</button><button class="btn btn-small" id="cancelMove" type="button">Cancel</button></div>
                </form>
            </dialog>
        </div>
        <script nonce="${escapeHtml(nonce)}">
            const csrfToken = ${JSON.stringify(csrfToken)};
            const statusEl = document.getElementById('controlStatus');
            const trackEl = document.getElementById('nowPlayingTrack');
            const targetEl = document.getElementById('nowPlayingTarget');
            const timeEl = document.getElementById('nowPlayingTime');
            const queueEl = document.getElementById('queueList');
            const volumeRange = document.getElementById('volumeRange');
            const volumeValue = document.getElementById('volumeValue');
            const loopToggle = document.getElementById('loopToggle');
            let lastSnapshot = null;
            let lastSnapshotAt = 0;
            let playbackInFlight = false;
            let libraryRequest = null;
            let libraryLoaded = false;
            let session = ${JSON.stringify(session).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026")};
            const libraryEl = document.getElementById('libraryList');
            const selectedSongs = new Set();
            const moveDialog = document.getElementById('moveDialog');
            let moveSongs = [];
            let editingLibrary = false;
            function setStatus(message, isError) {
                statusEl.textContent = message || '';
                if (isError) statusEl.classList.add('error');
                else statusEl.classList.remove('error');
            }
            function setLibraryStatus(message, isError) {
                setStatus(message, isError);
                const element = document.getElementById('libraryStatus');
                element.textContent = message || '';
                element.classList.toggle('error', Boolean(isError));
            }
            function makeButton(label, className, song) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn ' + className;
                button.textContent = label;
                if (song !== undefined) button.dataset.song = song;
                return button;
            }
            function updatePinButtons() {
                const pinned = new Set(session.pins.map((pin) => pin.song));
                document.querySelectorAll('.js-pin').forEach((button) => {
                    button.disabled = pinned.has(button.dataset.song);
                    button.textContent = button.disabled ? 'Pinned' : 'Pin';
                });
            }
            function renderSession(next) {
                if (next.revision < session.revision) return;
                session = next;
                const board = document.getElementById('sessionBoard');
                board.replaceChildren();
                if (!session.pins.length) {
                    const empty = document.createElement('li');
                    empty.className = 'hint';
                    empty.textContent = 'No songs pinned yet. Use Pin in the library to prepare your next session.';
                    board.appendChild(empty);
                }
                session.pins.forEach((pin, index) => {
                    const row = document.createElement('li');
                    row.className = 'session-item';
                    const label = document.createElement('div');
                    label.className = 'session-label';
                    const slash = pin.song.lastIndexOf('/');
                    label.textContent = (index + 1) + '. ' + pin.song.slice(slash + 1);
                    const folder = document.createElement('small');
                    folder.textContent = (slash < 0 ? 'Uncategorized' : pin.song.slice(0, slash)) + (pin.available ? '' : ' — Unavailable');
                    label.appendChild(folder);
                    row.appendChild(label);
                    const actions = document.createElement('div');
                    actions.className = 'song-actions';
                    const play = makeButton('▶ Play Now', 'btn-play js-play', pin.song);
                    play.disabled = !pin.available;
                    const queue = makeButton('＋ Queue', 'btn-queue js-enqueue', pin.song);
                    queue.disabled = !pin.available;
                    actions.append(play, queue);
                    ['up', 'down'].forEach((direction) => {
                        const button = makeButton(direction === 'up' ? '↑' : '↓', 'btn-small');
                        button.setAttribute('aria-label', 'Move ' + pin.song + ' ' + direction);
                        button.disabled = direction === 'up' ? index === 0 : index === session.pins.length - 1;
                        button.addEventListener('click', () => editSession({ action: 'reorder', id: pin.id, direction }));
                        actions.appendChild(button);
                    });
                    const unpin = makeButton('Unpin', 'btn-small');
                    unpin.addEventListener('click', () => editSession({ action: 'unpin', id: pin.id }));
                    actions.appendChild(unpin);
                    row.appendChild(actions);
                    board.appendChild(row);
                });
                document.getElementById('clearSession').disabled = !session.pins.length;
                updatePinButtons();
            }
            async function libraryAction(endpoint, payload) {
                if (editingLibrary) return null;
                editingLibrary = true;
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                        body: JSON.stringify(payload)
                    });
                    const parsed = await parseControlResponse(response);
                    if (!response.ok) {
                        setLibraryStatus('Error: ' + parsed.text, true);
                        await refreshLibrary(true);
                        return null;
                    }
                    if (parsed.json.session) renderSession(parsed.json.session);
                    if (parsed.json.message) setLibraryStatus(parsed.json.message, false);
                    return parsed.json;
                } catch {
                    setLibraryStatus('Could not confirm the change. Refresh the library before trying again.', true);
                    return null;
                } finally { editingLibrary = false; }
            }
            async function editSession(payload) {
                await libraryAction('api/session', { ...payload, revision: session.revision });
            }
            function updateSelection() {
                document.getElementById('selectedCount').textContent = selectedSongs.size + ' selected';
                document.getElementById('moveSelected').disabled = selectedSongs.size === 0;
            }
            function filterLibrary() {
                const query = document.getElementById('librarySearch').value.normalize('NFC').toLocaleLowerCase().trim();
                let visible = 0;
                libraryEl.querySelectorAll('.category-block').forEach((folder) => {
                    let matching = 0;
                    const matchesFolder = folder.querySelector('summary').textContent.toLocaleLowerCase().includes(query);
                    folder.querySelectorAll('[data-song-row]').forEach((row) => {
                        row.hidden = !matchesFolder && !row.dataset.songRow.normalize('NFC').toLocaleLowerCase().includes(query);
                        if (!row.hidden) matching += 1;
                    });
                    folder.hidden = Boolean(query) && !matchesFolder && matching === 0;
                    if (query && !folder.hidden) folder.open = true;
                    if (!folder.hidden) visible += 1;
                });
                document.getElementById('noSearchResults').hidden = visible > 0;
            }
            function renderLibrary(data) {
                const categories = ['uncategorized', ...(data.categories || []).filter((name) => name !== 'uncategorized')];
                const openFolders = new Set([...libraryEl.querySelectorAll('details[open]')].map((el) => el.querySelector('summary').dataset.category));
                const oldFolders = new Set([...libraryEl.querySelectorAll('summary')].map((el) => el.dataset.category));
                const currentSongs = new Set(data.tracks.map((track) => track.song));
                for (const song of selectedSongs) if (!currentSongs.has(song)) selectedSongs.delete(song);
                libraryEl.replaceChildren();
                categories.forEach((category) => {
                    const tracks = data.tracks.filter((track) => track.category === category);
                    const folder = document.createElement('details');
                    folder.className = 'category-block';
                    folder.open = !oldFolders.has(category) || openFolders.has(category);
                    const title = document.createElement('summary');
                    title.className = 'category-title';
                    title.dataset.category = category;
                    title.textContent = '📁 ' + (category === 'uncategorized' ? 'Uncategorized' : category) + ' (' + tracks.length + ')';
                    folder.appendChild(title);
                    const list = document.createElement('div');
                    list.className = 'song-list';
                    if (!tracks.length) {
                        const empty = document.createElement('p');
                        empty.className = 'empty-library';
                        empty.textContent = 'No songs in this folder.';
                        list.appendChild(empty);
                    }
                    tracks.forEach((track) => {
                        const row = document.createElement('div');
                        row.className = 'song-item';
                        row.dataset.songRow = track.song;
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'js-select-song';
                        checkbox.value = track.song;
                        checkbox.checked = selectedSongs.has(track.song);
                        checkbox.setAttribute('aria-label', 'Select ' + track.song);
                        const name = document.createElement('span');
                        name.className = 'song-name';
                        name.textContent = track.song.slice(track.song.lastIndexOf('/') + 1);
                        const duration = document.createElement('span');
                        duration.className = 'song-duration';
                        duration.textContent = formatTime(track.durationMs);
                        const actions = document.createElement('span');
                        actions.className = 'song-actions';
                        actions.append(makeButton('▶ Play Now', 'btn-play js-play', track.song), makeButton('＋ Queue', 'btn-queue js-enqueue', track.song),
                            makeButton('Pin', 'btn-small js-pin', track.song), makeButton('Move…', 'btn-small js-move', track.song));
                        row.append(checkbox, name, duration, actions);
                        list.appendChild(row);
                    });
                    folder.appendChild(list);
                    libraryEl.appendChild(folder);
                });
                ['category', 'moveTarget'].forEach((id) => {
                    const select = document.getElementById(id);
                    const previous = select.value;
                    select.replaceChildren();
                    categories.forEach((category) => {
                        const option = document.createElement('option');
                        option.value = category;
                        option.textContent = category === 'uncategorized' ? 'Uncategorized' : category;
                        select.appendChild(option);
                    });
                    if (categories.includes(previous)) select.value = previous;
                });
                updateSelection();
                filterLibrary();
                updatePinButtons();
            }
            function openMove(songs) {
                if (!songs.length || songs.length > 20) {
                    setLibraryStatus('Select between 1 and 20 songs to move.', true);
                    return;
                }
                moveSongs = songs;
                document.getElementById('moveSummary').textContent = songs.length === 1 ? songs[0] : 'Move ' + songs.length + ' selected songs.';
                moveDialog.showModal();
            }
            function formatTime(ms) {
                if (ms === null || ms === undefined) return '?:??';
                const totalSeconds = Math.max(0, Math.floor(ms / 1000));
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                return minutes + ':' + String(seconds).padStart(2, '0');
            }
            function formatElapsed(elapsedMs, durationMs) {
                return formatTime(elapsedMs) + ' / ' + formatTime(durationMs);
            }
            function estimatedElapsed(snapshot) {
                if (!snapshot || !snapshot.current) return 0;
                const base = snapshot.current.elapsedMs || 0;
                if (snapshot.status !== 'playing') return base;
                return base + Math.max(0, Date.now() - lastSnapshotAt);
            }
            function renderSnapshot(snapshot) {
                lastSnapshot = snapshot;
                lastSnapshotAt = Date.now();
                if (!snapshot) return;
                if (snapshot.current) trackEl.textContent = snapshot.current.song;
                else trackEl.textContent = snapshot.queue.length > 0 ? 'Idle (queued)' : 'Idle';
                if (snapshot.guildName || snapshot.channelName) {
                    const guild = snapshot.guildName || snapshot.guildId || 'guild';
                    const channel = snapshot.channelName || snapshot.channelId || 'channel';
                    targetEl.textContent = guild + ' / ' + channel;
                } else if (snapshot.guildId && snapshot.channelId) {
                    targetEl.textContent = snapshot.guildId + ' / ' + snapshot.channelId;
                } else {
                    targetEl.textContent = 'No active target';
                }
                const duration = snapshot.current ? snapshot.current.durationMs : null;
                timeEl.textContent = snapshot.current ? formatElapsed(snapshot.current.elapsedMs, duration) : '0:00 / ?:??';
                if (document.activeElement !== volumeRange) {
                    volumeRange.value = String(snapshot.volume);
                    volumeValue.textContent = snapshot.volume + '%';
                }
                if (document.activeElement !== loopToggle) loopToggle.checked = Boolean(snapshot.loop);
                while (queueEl.firstChild) queueEl.removeChild(queueEl.firstChild);
                if (snapshot.queue.length === 0) {
                    const empty = document.createElement('li');
                    empty.textContent = 'Queue is empty.';
                    empty.className = 'queue-item';
                    queueEl.appendChild(empty);
                } else {
                    snapshot.queue.forEach((entry) => {
                        const item = document.createElement('li');
                        item.className = 'queue-item';
                        const label = document.createElement('span');
                        label.textContent = entry.song + (entry.durationMs ? ' (' + formatTime(entry.durationMs) + ')' : '');
                        const remove = document.createElement('button');
                        remove.className = 'btn btn-small js-remove';
                        remove.textContent = 'Remove';
                        remove.setAttribute('data-id', String(entry.id));
                        remove.addEventListener('click', () => controlBot({ action: 'remove', id: entry.id }));
                        item.appendChild(label);
                        item.appendChild(remove);
                        queueEl.appendChild(item);
                    });
                }
            }
            function tickElapsed() {
                if (!lastSnapshot || !lastSnapshot.current) return;
                if (document.hidden) return;
                const duration = lastSnapshot.current.durationMs;
                timeEl.textContent = formatElapsed(estimatedElapsed(lastSnapshot), duration);
            }
            async function parseControlResponse(response) {
                const text = await response.text();
                try {
                    return { json: JSON.parse(text), text };
                } catch {
                    return { json: null, text };
                }
            }
            async function controlBot(payload) {
                const action = typeof payload === 'string' ? payload : payload.action;
                const body = typeof payload === 'string'
                    ? { action, song: arguments[1] || '' }
                    : payload;
                try {
                    const response = await fetch('api/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                        body: JSON.stringify(body)
                    });
                    const parsed = await parseControlResponse(response);
                    if (!response.ok) {
                        setStatus('Error: ' + parsed.text, true);
                        return;
                    }
                    if (parsed.json && parsed.json.message) setStatus(parsed.json.message, false);
                    else if (parsed.text) setStatus(parsed.text, false);
                    if (parsed.json && parsed.json.snapshot) renderSnapshot(parsed.json.snapshot);
                    else await refreshPlayback();
                } catch (err) {
                    setStatus('Network error communicating with the bot.', true);
                }
            }
            async function refreshPlayback() {
                if (playbackInFlight) return;
                playbackInFlight = true;
                try {
                    const response = await fetch('api/playback', { headers: { 'Accept': 'application/json' } });
                    if (!response.ok) return;
                    const data = await response.json();
                    if (data && data.snapshot) renderSnapshot(data.snapshot);
                } catch {} finally {
                    playbackInFlight = false;
                }
            }
            async function refreshLibrary(force = false) {
                if (libraryRequest) {
                    await libraryRequest;
                    if (force) return refreshLibrary(true);
                    return;
                }
                if (!force && libraryLoaded) return;
                libraryRequest = (async () => { try {
                    const response = await fetch('api/library', { headers: { 'Accept': 'application/json' } });
                    if (!response.ok) {
                        setLibraryStatus('Could not load the library. Use Refresh library to retry.', true);
                        return;
                    }
                    const data = await response.json();
                    renderSession(data.session);
                    renderLibrary(data);
                    libraryLoaded = true;
                } catch {
                    setLibraryStatus('Could not load the library. Use Refresh library to retry.', true);
                } })();
                try { await libraryRequest; } finally { libraryRequest = null; }
            }
            document.querySelector('.js-stop').addEventListener('click', () => controlBot({ action: 'stop' }));
            const skipButton = document.querySelector('.js-skip');
            if (skipButton) skipButton.addEventListener('click', () => controlBot({ action: 'skip' }));
            const clearButton = document.querySelector('.js-clear-queue');
            if (clearButton) clearButton.addEventListener('click', () => controlBot({ action: 'clearQueue' }));
            document.addEventListener('click', (event) => {
                const button = event.target.closest('button');
                if (!button || button.disabled) return;
                if (button.classList.contains('js-play')) controlBot({ action: 'play', song: button.dataset.song });
                if (button.classList.contains('js-enqueue')) controlBot({ action: 'enqueue', song: button.dataset.song });
                if (button.classList.contains('js-pin')) editSession({ action: 'pin', song: button.dataset.song });
                if (button.classList.contains('js-move')) openMove([button.dataset.song]);
            });
            libraryEl.addEventListener('change', (event) => {
                if (!event.target.classList.contains('js-select-song')) return;
                if (event.target.checked) selectedSongs.add(event.target.value);
                else selectedSongs.delete(event.target.value);
                updateSelection();
            });
            document.getElementById('librarySearch').addEventListener('input', filterLibrary);
            document.getElementById('reloadLibrary').addEventListener('click', () => refreshLibrary(true));
            document.getElementById('moveSelected').addEventListener('click', () => openMove([...selectedSongs]));
            document.getElementById('cancelMove').addEventListener('click', () => moveDialog.close());
            document.getElementById('moveForm').addEventListener('submit', async (event) => {
                event.preventDefault();
                const result = await libraryAction('api/library/move', { songs: moveSongs, category: document.getElementById('moveTarget').value });
                if (!result) return;
                moveDialog.close();
                result.results.filter((entry) => entry.status !== 'error').forEach((entry) => selectedSongs.delete(entry.song));
                await refreshLibrary(true);
                const errors = result.results.filter((entry) => entry.status === 'error');
                const moved = result.results.filter((entry) => entry.status === 'moved').length;
                setLibraryStatus('Moved ' + moved + ' song(s).' + (errors.length ? ' ' + errors.map((entry) => entry.song + ': ' + entry.message).join(' ') : ''), errors.length > 0);
            });
            document.getElementById('folderForm').addEventListener('submit', async (event) => {
                event.preventDefault();
                const input = document.getElementById('folderName');
                const result = await libraryAction('api/folders', { name: input.value });
                if (!result) return;
                input.value = '';
                await refreshLibrary(true);
                document.getElementById('category').value = result.name;
                document.getElementById('moveTarget').value = result.name;
            });
            document.querySelector('.js-new-folder').addEventListener('click', () => document.getElementById('folderName').focus());
            document.getElementById('clearSession').addEventListener('click', () => {
                if (confirm('Clear all pins from Next Session? Your audio files will stay in the library.')) editSession({ action: 'clear' });
            });
            volumeRange.addEventListener('change', () => {
                const volume = Number(volumeRange.value);
                volumeValue.textContent = volume + '%';
                controlBot({ action: 'setVolume', volume });
            });
            loopToggle.addEventListener('change', () => {
                controlBot({ action: 'setLoop', enabled: loopToggle.checked });
            });
            setInterval(tickElapsed, 1000);
            setInterval(() => { if (!document.hidden) refreshPlayback(); }, 5000);
            document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPlayback(); });
            refreshPlayback();
            renderSession(session);
            refreshLibrary();
        </script>
    </body>
    </html>
  `;
}

function renderUploadSuccess(relativePath, nonce = "") {
  return `
    <style nonce="${escapeHtml(nonce)}">
      body { margin: 0; }
      .upload-result { font-family: Arial, sans-serif; padding: 20px; background: #2f3136; color: #fff; min-height: 100vh; box-sizing: border-box; }
      .back-link { color: #7289da; text-decoration: none; font-weight: bold; }
    </style>
    <div class="upload-result">
        <h3>Success!</h3>
        <p>Uploaded and saved to destination details: <strong>${escapeHtml(relativePath)}</strong></p>
        <a href="./" class="back-link">← Back to Uploader</a>
    </div>
  `;
}

module.exports = { escapeHtml, renderControlPanel, renderUploadSuccess };
