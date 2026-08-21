// -----------------------------
// Imports
// -----------------------------
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");

const { Client, GatewayIntentBits } = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");


// -----------------------------
// Config
// -----------------------------
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";
const MUSIC_DIR = path.resolve(__dirname, "music");

const WEB_HOST = process.env.WEB_HOST || "127.0.0.1";
const WEB_PORT = process.env.WEB_PORT || 3000;
const WEB_USER = process.env.WEB_USER || "uploader";
const WEB_PASS = process.env.WEB_PASS;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN env var");
  process.exit(1);
}

fs.mkdirSync(MUSIC_DIR, { recursive: true });


// -----------------------------
// Discord Client
// -----------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});


// -----------------------------
// Audio Player
// -----------------------------
const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

player.on("error", (err) => {
  console.error("Audio player error:", err);
});

player.on("stateChange", (oldState, newState) => {
  console.log(`Audio player state: ${oldState.status} -> ${newState.status}`);
});


// -----------------------------
// Directory Helper Functions
// -----------------------------

/**
 * Recursively fetches all subdirectories inside a directory (1-level deep for categories)
 */
function getCategories() {
  try {
    return fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (err) {
    console.error("Error reading categories:", err);
    return [];
  }
}

/**
 * Builds a structured map of categories and their respective MP3 files.
 * Format: { "villains": ["boss_theme"], "players": ["level_up"], "uncategorized": ["airhorn"] }
 */
function getMusicStructure() {
  const structure = {};
  
  try {
    // Read root files (Uncategorized)
    const rootFiles = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
    const uncategorized = rootFiles
      .filter(dirent => dirent.isFile() && dirent.name.endsWith(".mp3"))
      .map(dirent => path.basename(dirent.name, ".mp3"));
      
    if (uncategorized.length > 0) {
      structure["uncategorized"] = uncategorized;
    }

    // Read subdirectories
    const categories = getCategories();
    for (const cat of categories) {
      const catPath = path.join(MUSIC_DIR, cat);
      const files = fs.readdirSync(catPath, { withFileTypes: true })
        .filter(dirent => dirent.isFile() && dirent.name.endsWith(".mp3"))
        .map(dirent => path.basename(dirent.name, ".mp3"));
        
      if (files.length > 0) {
        structure[cat] = files;
      }
    }
  } catch (err) {
    console.error("Error scanning music structure:", err);
  }
  
  return structure;
}

/**
 * Deep-safe path resolution supporting subfolders
 * Expects relative tracking paths like "villains/boss_theme" or just "airhorn"
 */
function safeResolveMp3(songPathIdentifier) {
  const base = songPathIdentifier.endsWith(".mp3") ? songPathIdentifier : `${songPathIdentifier}.mp3`;
  const resolved = path.resolve(MUSIC_DIR, base);
  
  // Guard against directory traversal attacks
  if (!resolved.startsWith(MUSIC_DIR + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;

  return resolved;
}


// -----------------------------
// Voice Connection Helper
// -----------------------------
async function ensureConnectionReady(guild, voiceChannel) {
  let connection = getVoiceConnection(guild.id);

  if (!connection) {
    console.log(`Joining voice channel ${voiceChannel.id}`);
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (err) {
    console.error("entersState READY failed:", err);
    throw err;
  }

  return connection;
}


// -----------------------------
// Commands
// -----------------------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);

  // HELP
  if (cmd === "help") {
    return msg.reply(`Commands:
!list
!play <category/name or name>
!stop`);
  }

  // LIST (Flattened view for discord visibility)
  if (cmd === "list") {
    const structure = getMusicStructure();
    let replyStr = "";

    for (const [category, tracks] of Object.entries(structure)) {
      replyStr += `**[${category.toUpperCase()}]**\n`;
      tracks.forEach(t => {
        replyStr += `  ${category === 'uncategorized' ? '' : category + '/'}${t}\n`;
      });
    }

    return msg.reply(replyStr || "No MP3 files found.");
  }

  // PLAY
  if (cmd === "play") {
    const name = args.join(" ");
    if (!name) return msg.reply("Usage: !play <name> or !play <category/name>");

    const voiceChannel = msg.member?.voice?.channel;
    if (!voiceChannel) return msg.reply("Join a voice channel first.");

    // Try finding it directly, or matching an uncategorized fallback
    let filePath = safeResolveMp3(name);
    if (!filePath && !name.includes("/")) {
      filePath = safeResolveMp3(path.join("uncategorized", name));
    }

    if (!filePath) return msg.reply("File not found.");

    try {
      const connection = await ensureConnectionReady(msg.guild, voiceChannel);
      connection.subscribe(player);
      const resource = createAudioResource(filePath);
      player.play(resource);
      return msg.reply(`Playing ${name}`);
    } catch (err) {
      console.error(err);
      return msg.reply("Failed to play track.");
    }
  }

  // STOP
  if (cmd === "stop") {
    player.stop(true);
    const connection = getVoiceConnection(msg.guild.id);
    if (connection) connection.destroy();
    return msg.reply("Stopped.");
  }
});


// -----------------------------
// Voice State Monitor
// -----------------------------
client.on("voiceStateUpdate", (oldState, newState) => {
  const connection = getVoiceConnection(oldState.guild.id);
  if (!connection) return;

  const channel = oldState.guild.channels.cache.get(connection.joinConfig.channelId);
  if (!channel) return;

  const humans = channel.members.filter(m => !m.user.bot);
  if (humans.size === 0) {
    connection.destroy();
  }
});


// -----------------------------
// Express Web Uploader Setup
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function basicAuth(req, res, next) {
  if (!WEB_PASS) return res.status(500).send("WEB_PASS environment variable is not set");
  const header = req.headers.authorization || "";
  const [type, encoded] = header.split(" ");
  if (type !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
    return res.status(401).send("Authentication required");
  }
  const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  if (user !== WEB_USER || pass !== WEB_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
    return res.status(401).send("Invalid credentials");
  }
  next();
}

// Multer Storage configured to dynamically adjust destination folder based on user selection
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = req.body.category || "uncategorized";
    const targetDir = category === "uncategorized" ? MUSIC_DIR : path.join(MUSIC_DIR, category);
    
    // Ensure subfolder exists safely
    fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const customName = req.body.mp3Name ? req.body.mp3Name.trim() : null;
    const base = customName || path.parse(file.originalname).name;
    cb(null, base + ".mp3");
  },
});

const upload = multer({ storage });


// Serve Control Panel HTML
app.get("/", basicAuth, (req, res) => {
  const musicStructure = getMusicStructure();
  const categories = getCategories();

  // Create Dropdown Options for the Uploader UI Form
  let dropdownHtml = `<option value="uncategorized">Default (Root /music)</option>`;
  categories.forEach(cat => {
    dropdownHtml += `<option value="${cat}">${cat}</option>`;
  });

  // Create Native Collapsible HTML Accordions (<details>) grouped by Directory Context
  let controlPanelHtml = "";
  if (Object.keys(musicStructure).length === 0) {
    controlPanelHtml = `<p style="color: #b9bbbe; text-align: center;">No MP3 files found.</p>`;
  } else {
    for (const [category, tracks] of Object.entries(musicStructure)) {
      controlPanelHtml += `
        <details class="category-block" open>
            <summary class="category-title">📁 ${category.toUpperCase()} (${tracks.length})</summary>
            <div class="song-list">
               ${tracks.map(song => {
                 // Send relative location parameter up (e.g. "villains/boss" or "airhorn")
                 const internalPath = category === "uncategorized" ? song : `${category}/${song}`;
                 return `
                    <div class="song-item">
                        <span class="song-name">${song}</span>
                        <button class="btn btn-play" onclick="controlBot('play', '${encodeURIComponent(internalPath)}')">▶ Play</button>
                    </div>
                 `;
               }).join("")}
            </div>
        </details>
      `;
    }
  }

  res.send(`
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
            
            <form action="/discord/upload" method="POST" enctype="multipart/form-data">
                <div class="form-group">
                    <label for="mp3Name">Name the MP3 File (Optional)</label>
                    <input type="text" id="mp3Name" name="mp3Name" placeholder="e.g. airhorn (defaults to filename)">
                </div>
                <div class="form-group">
                    <label for="category">Target Category Folder</label>
                    <select id="category" name="category">
                        ${dropdownHtml}
                    </select>
                </div>
                <div class="form-group">
                    <label for="mp3">Select MP3 File</label>
                    <input type="file" id="mp3" name="mp3" accept=".mp3" required>
                </div>
                <button type="submit" class="btn btn-submit">Upload Audio</button>
            </form>

            <h3>Live Audio Control</h3>
            <button class="btn btn-stop" onclick="controlBot('stop')">🛑 Stop All Playback</button>
            
            <div class="control-container">
                ${controlPanelHtml}
            </div>
        </div>

        <script>
            async function controlBot(action, songName = '') {
                try {
                    const response = await fetch('/discord/api/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action, song: decodeURIComponent(songName) })
                    });
                    const data = await response.text();
                    if (!response.ok) alert('Error: ' + data);
                } catch (err) {
                    alert('Network error communicating with the bot.');
                }
            }
        </script>
    </body>
    </html>
  `);
});

// Process File Uploads into dynamic destinations
app.post("/upload", basicAuth, upload.single("mp3"), (req, res) => {
  if (!req.file) return res.status(400).send("Error: No file uploaded.");
  res.send(`
    <div style="font-family: Arial; padding: 20px; background: #2f3136; color: #fff; height: 100vh; margin:0; box-sizing: border-box;">
        <h3>Success!</h3>
        <p>Uploaded and saved to destination details: <strong>${req.file.path.replace(MUSIC_DIR, '')}</strong></p>
        <a href="/discord/" style="color: #7289da; text-decoration: none; font-weight: bold;">← Back to Uploader</a>
    </div>
  `);
});

// Controls bot playback remotely
app.post("/api/control", basicAuth, async (req, res) => {
  const { action, song } = req.body;

  if (action === "stop") {
    player.stop(true);
    client.guilds.cache.forEach(guild => {
      const connection = getVoiceConnection(guild.id);
      if (connection) connection.destroy();
    });
    return res.send("Stopped.");
  }

  if (action === "play") {
    if (!song) return res.status(400).send("Missing song identifier.");
    const filePath = safeResolveMp3(song);
    if (!filePath) return res.status(404).send("File not found on server.");

    let targetChannel = null;
    let targetGuild = null;

    for (const [guildId, guild] of client.guilds.cache) {
      const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased());
      for (const [channelId, channel] of voiceChannels) {
        const humans = channel.members.filter(m => !m.user.bot);
        if (humans.size > 0) {
          targetChannel = channel;
          targetGuild = guild;
          break;
        }
      }
      if (targetChannel) break;
    }

    if (!targetChannel) {
      return res.status(400).send("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
    }

    try {
      console.log(`Web Control: Playing "${song}" in channel ${targetChannel.name}`);
      const connection = await ensureConnectionReady(targetGuild, targetChannel);
      connection.subscribe(player);
      
      const resource = createAudioResource(filePath);
      player.play(resource);

      return res.send(`Playing ${song}`);
    } catch (err) {
      console.error("Web control voice playback failure:", err);
      return res.status(500).send("Failed to bridge voice connection.");
    }
  }

  res.status(400).send("Unknown action.");
});

client.login(TOKEN);

app.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`Uploader and remote controller running at http://${WEB_HOST}:${WEB_PORT}`);
});
