function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderControlPanel({ musicStructure, categories }) {
  const dropdownHtml = [
    '<option value="uncategorized">Default (Root /music)</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");

  let controlPanelHtml = "";
  if (Object.keys(musicStructure).length === 0) {
    controlPanelHtml = '<p style="color: #b9bbbe; text-align: center;">No MP3 files found.</p>';
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
                        <button class="btn btn-play js-play" data-song="${escapeHtml(internalPath)}">▶ Play</button>
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
        <style>
            body { font-family: Arial, sans-serif; background: #2f3136; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .container { background: #36393f; padding: 30px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); width: 100%; max-width: 450px; }
            h2, h3 { margin-top: 0; color: #7289da; text-align: center;}
            h3 { border-bottom: 1px solid #40444b; padding-bottom: 10px; margin-top: 25px; color: #fff; }
            .form-group { margin-bottom: 20px; display: flex; flex-direction: column; }
            label { margin-bottom: 8px; font-weight: bold; color: #b9bbbe; }
            input[type="text"], select, input[type="file"] { padding: 10px; border-radius: 4px; border: 1px solid #202225; background: #40444b; color: #fff; font-size: 14px; }
            .btn { color: #fff; border: none; padding: 12px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 16px; }
            .btn-submit { background: #7289da; width: 100%; margin-top: 10px; }
            .btn-submit:hover { background: #5b73c7; }
            .btn-stop { background: #f04747; width: 100%; margin-bottom: 20px; }
            .btn-stop:hover { background: #fd5d5d; }
            .category-block { background: #2f3136; margin-bottom: 12px; border-radius: 4px; border: 1px solid #202225; overflow: hidden;}
            .category-title { background: #202225; padding: 10px; font-weight: bold; cursor: pointer; user-select: none; color: #b9bbbe; }
            .song-list { padding: 5px 10px; max-height: 200px; overflow-y: auto; }
            .song-item { display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid #40444b; }
            .song-item:last-child { border-bottom: none; }
            .song-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; color: #e1e1e1; }
            .btn-play { background: #43b581; padding: 6px 12px; font-size: 13px; }
            .btn-play:hover { background: #3ca374; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Bot Control Panel</h2>
            <form action="upload" method="POST" enctype="multipart/form-data">
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
            <button class="btn btn-stop js-stop">🛑 Stop All Playback</button>
            <div class="control-container">${controlPanelHtml}</div>
        </div>
        <script>
            async function controlBot(action, song = '') {
                try {
                    const response = await fetch('api/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action, song })
                    });
                    const data = await response.text();
                    if (!response.ok) alert('Error: ' + data);
                } catch (err) {
                    alert('Network error communicating with the bot.');
                }
            }
            document.querySelector('.js-stop').addEventListener('click', () => controlBot('stop'));
            document.querySelectorAll('.js-play').forEach((button) => {
                button.addEventListener('click', () => controlBot('play', button.dataset.song));
            });
        </script>
    </body>
    </html>
  `;
}

function renderUploadSuccess(relativePath) {
  return `
    <div style="font-family: Arial; padding: 20px; background: #2f3136; color: #fff; height: 100vh; margin:0; box-sizing: border-box;">
        <h3>Success!</h3>
        <p>Uploaded and saved to destination details: <strong>${escapeHtml(relativePath)}</strong></p>
        <a href="./" style="color: #7289da; text-decoration: none; font-weight: bold;">← Back to Uploader</a>
    </div>
  `;
}

module.exports = { escapeHtml, renderControlPanel, renderUploadSuccess };
