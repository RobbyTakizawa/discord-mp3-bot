function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderControlPanel({ musicStructure, categories, csrfToken = "", nonce = "" }) {
  const dropdownHtml = [
    '<option value="uncategorized">Default (Root /music)</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");

  let controlPanelHtml = "";
  if (Object.keys(musicStructure).length === 0) {
    controlPanelHtml = '<p class="empty-library">No MP3 files found.</p>';
  } else {
    for (const [category, tracks] of Object.entries(musicStructure)) {
      controlPanelHtml += `
        <details class="category-block" open>
            <summary class="category-title">📁 ${escapeHtml(category.toUpperCase())} (${tracks.length})</summary>
            <div class="song-list">
               ${tracks.map((song) => {
                 const internalPath = category === "uncategorized" ? song : `${category}/${song}`;
                 return `
                    <div class="song-item">
                        <span class="song-name">${escapeHtml(song)}</span>
                        <span class="song-duration" data-duration-for="${escapeHtml(internalPath)}">…</span>
                        <span class="song-actions">
                          <button class="btn btn-play js-play" data-song="${escapeHtml(internalPath)}">▶ Play Now</button>
                          <button class="btn btn-queue js-enqueue" data-song="${escapeHtml(internalPath)}">＋ Queue</button>
                        </span>
                    </div>
                 `;
               }).join("")}
            </div>
        </details>
      `;
    }
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
            .container { background: #36393f; padding: 30px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); width: 100%; max-width: 520px; }
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
            .song-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; color: #e1e1e1; }
            .song-duration { font-size: 12px; color: #b9bbbe; min-width: 44px; text-align: right; }
            .song-actions { display: flex; gap: 6px; }
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
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Bot Control Panel</h2>
            <form action="upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
                <div class="form-group">
                    <label for="mp3Name">Name the MP3 File (Optional)</label>
                    <input type="text" id="mp3Name" name="mp3Name" placeholder="e.g. airhorn (defaults to filename)">
                </div>
                <div class="form-group">
                    <label for="category">Target Category Folder</label>
                    <select id="category" name="category">${dropdownHtml}</select>
                </div>
                <div class="form-group">
                    <label for="mp3">Select MP3 File</label>
                    <input type="file" id="mp3" name="mp3" accept=".mp3" required>
                </div>
                <button type="submit" class="btn btn-submit">Upload Audio</button>
            </form>
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
            <h3>Library</h3>
            <div class="control-container">${controlPanelHtml}</div>
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
            let libraryInFlight = false;
            let libraryLoaded = false;
            function setStatus(message, isError) {
                statusEl.textContent = message || '';
                if (isError) statusEl.classList.add('error');
                else statusEl.classList.remove('error');
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
            async function refreshLibrary() {
                if (libraryLoaded || libraryInFlight) return;
                libraryInFlight = true;
                try {
                    const response = await fetch('api/library', { headers: { 'Accept': 'application/json' } });
                    if (!response.ok) return;
                    const data = await response.json();
                    const durations = new Map((data.tracks || []).map((t) => [t.song, t.durationMs]));
                    document.querySelectorAll('[data-duration-for]').forEach((el) => {
                        const song = el.getAttribute('data-duration-for');
                        const duration = durations.get(song);
                        el.textContent = duration ? formatTime(duration) : '?:??';
                    });
                    libraryLoaded = true;
                } catch {} finally {
                    libraryInFlight = false;
                }
            }
            document.querySelector('.js-stop').addEventListener('click', () => controlBot({ action: 'stop' }));
            const skipButton = document.querySelector('.js-skip');
            if (skipButton) skipButton.addEventListener('click', () => controlBot({ action: 'skip' }));
            const clearButton = document.querySelector('.js-clear-queue');
            if (clearButton) clearButton.addEventListener('click', () => controlBot({ action: 'clearQueue' }));
            document.querySelectorAll('.js-play').forEach((button) => {
                button.addEventListener('click', () => controlBot({ action: 'play', song: button.dataset.song }));
            });
            document.querySelectorAll('.js-enqueue').forEach((button) => {
                button.addEventListener('click', () => controlBot({ action: 'enqueue', song: button.dataset.song }));
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
