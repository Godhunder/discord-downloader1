import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events
} from "discord.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import express from "express";

const execAsync = promisify(exec);

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL
  ? process.env.BASE_URL.replace(/\/$/, '')
  : process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${PORT}`;

const FILE_EXPIRY_HOURS = 4;

console.log("=".repeat(50));
console.log("🚀 DISCORD VIDEO DOWNLOADER BOT STARTING");
console.log("=".repeat(50));
console.log("📅 Start time:", new Date().toISOString());
console.log("🌐 BASE_URL:", BASE_URL);
console.log("🔧 Node version:", process.version);
console.log("📦 Platform:", process.platform);
console.log("=".repeat(50));

// ============================================
// EXPRESS WEB SERVER
// ============================================
const app = express();

if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
  console.log("✅ Created downloads directory");
}

app.use("/downloads", express.static("downloads"));

// Global bot status for health endpoint
let botStatus = {
  connected: false,
  username: null,
  loginAttempts: 0,
  lastError: null
};

app.get("/", (req, res) => {
  res.json({
    status: "online",
    bot: botStatus.connected ? "connected" : "connecting",
    botUsername: botStatus.username,
    loginAttempts: botStatus.loginAttempts,
    lastError: botStatus.lastError,
    uptime: `${Math.floor(process.uptime() / 60)}m`,
    downloads: fs.readdirSync("downloads").length,
    queue: queue.length,
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/debug", (req, res) => {
  res.json({
    tokenSet: !!process.env.TOKEN,
    tokenLength: process.env.TOKEN ? process.env.TOKEN.length : 0,
    botStatus: botStatus,
    env: {
      PORT: process.env.PORT,
      BASE_URL: process.env.BASE_URL,
      NODE_ENV: process.env.NODE_ENV
    }
  });
});

const server = app.listen(PORT, () => {
  console.log("✅ Web server started on port", PORT);
  console.log("📊 Health endpoint:", `${BASE_URL}/`);
  console.log("🐛 Debug endpoint:", `${BASE_URL}/debug`);
});

// ============================================
// DISCORD BOT SETUP
// ============================================

let videoCache = {};
let queue = [];
let busy = false;

console.log("=".repeat(50));
console.log("🤖 INITIALIZING DISCORD CLIENT");
console.log("=".repeat(50));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

console.log("✅ Discord client created with intents");

// ============================================
// BOT EVENT HANDLERS
// ============================================

client.on(Events.Debug, (info) => {
  console.log("🐛 Discord Debug:", info);
});

client.once(Events.ClientReady, (c) => {
  console.log("=".repeat(50));
  console.log("✅✅✅ BOT IS ONLINE! ✅✅✅");
  console.log("=".repeat(50));
  console.log("📱 Username:", c.user.tag);
  console.log("🆔 User ID:", c.user.id);
  console.log("🔧 Servers:", c.guilds.cache.size);
  console.log("=".repeat(50));
  
  botStatus.connected = true;
  botStatus.username = c.user.tag;
});

client.on(Events.Error, (error) => {
  console.error("❌ Discord Error Event:", error);
  botStatus.lastError = error.message;
});

client.on(Events.Warn, (info) => {
  console.warn("⚠️ Discord Warning:", info);
});

client.on(Events.ShardError, (error) => {
  console.error("❌ Shard Error:", error);
  botStatus.lastError = `Shard: ${error.message}`;
});

client.on(Events.ShardDisconnect, (event) => {
  console.log("🔌 Shard Disconnected:", event.code, event.reason);
  botStatus.connected = false;
});

client.on(Events.ShardReconnecting, () => {
  console.log("🔄 Shard Reconnecting...");
});

client.on(Events.ShardReady, (id) => {
  console.log(`✅ Shard ${id} Ready`);
});

// ============================================
// COMMAND HANDLER
// ============================================

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!dl")) return;

  console.log(`📥 Command from ${msg.author.tag}: ${msg.content}`);

  const args = msg.content.trim().split(/\s+/);
  const url = args[1];

  if (!url) {
    return msg.reply("❌ Usage: `!dl <video_url>`");
  }

  try {
    new URL(url);
  } catch {
    return msg.reply("❌ Invalid URL");
  }

  videoCache[msg.author.id] = url;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("select_type")
    .setPlaceholder("Choose download type")
    .addOptions([
      { label: "🎥 Video", value: "video" },
      { label: "🎵 Audio", value: "audio" }
    ]);

  await msg.channel.send({
    content: "📥 Select download type:",
    components: [new ActionRowBuilder().addComponents(menu)]
  });
});

// ============================================
// INTERACTION HANDLER
// ============================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  const userId = interaction.user.id;
  const url = videoCache[userId];

  if (!url) {
    return interaction.reply({ content: "❌ Session expired", ephemeral: true });
  }

  if (interaction.customId === "select_type") {
    const type = interaction.values[0];

    if (type === "audio") {
      queue.push({
        user: interaction.user,
        channel: interaction.channel,
        url,
        format: "bestaudio",
        type: "audio"
      });
      await interaction.reply(`🎵 Added to queue! Position: ${queue.length}`);
      processQueue();
      return;
    }

    if (type === "video") {
      await interaction.reply("🔍 Fetching qualities...");

      try {
        const { stdout } = await execAsync(`yt-dlp -F "${url}"`);
        const lines = stdout.split("\n");
        const formats = [];
        const seen = new Set();

        for (const line of lines) {
          const match = line.match(/^(\d+)\s+.*?(\d+)p/);
          if (!match) continue;

          const [, id, height] = match;
          const fps = line.includes("60fps") ? "60fps" : "30fps";
          const label = `${height}p ${fps}`;

          if (!seen.has(label)) {
            seen.add(label);
            formats.push({ label, value: id });
          }
        }

        if (!formats.length) {
          return interaction.followUp("❌ No formats found");
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId("select_quality")
          .setPlaceholder("Choose quality")
          .addOptions(formats.slice(0, 25));

        await interaction.followUp({
          content: "🎥 Select quality:",
          components: [new ActionRowBuilder().addComponents(menu)]
        });

      } catch (err) {
        console.error("Format fetch error:", err);
        await interaction.followUp("❌ Failed to fetch formats");
      }
    }
  }

  if (interaction.customId === "select_quality") {
    const format = interaction.values[0];
    queue.push({
      user: interaction.user,
      channel: interaction.channel,
      url,
      format,
      type: "video"
    });
    await interaction.reply(`📥 Added to queue! Position: ${queue.length}`);
    processQueue();
  }
});

// ============================================
// QUEUE PROCESSOR
// ============================================

async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;

  const job = queue.shift();
  const timestamp = Date.now();
  const ext = job.type === "audio" ? "mp3" : "mp4";
  const filename = `${job.type}_${timestamp}.${ext}`;
  const filepath = path.join("downloads", filename);

  console.log(`⬇️ Processing ${job.type} for ${job.user.username}`);

  await job.channel.send(`⬇️ Downloading ${job.type}...`);

  try {
    let cmd;
    if (job.type === "audio") {
      cmd = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 -o "${filepath}" "${job.url}"`;
    } else {
      cmd = `yt-dlp -f ${job.format}+bestaudio --merge-output-format mp4 -o "${filepath}" "${job.url}"`;
    }

    await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });

    if (!fs.existsSync(filepath)) {
      throw new Error("File not created");
    }

    const stats = fs.statSync(filepath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const link = `${BASE_URL}/downloads/${filename}`;

    await job.channel.send({
      embeds: [{
        color: 0x00ff00,
        title: "✅ Download Ready!",
        fields: [
          { name: "📊 Size", value: `${sizeMB} MB`, inline: true },
          { name: "⏱️ Expires", value: `${FILE_EXPIRY_HOURS}h`, inline: true },
          { name: "🔗 Link", value: `[Download](${link})` }
        ],
        timestamp: new Date()
      }]
    });

    console.log(`✅ Download complete: ${filename}`);
    delete videoCache[job.user.id];

  } catch (err) {
    console.error("Download error:", err);
    await job.channel.send(`❌ Download failed`);
  }

  busy = false;
  processQueue();
}

// ============================================
// CLEANUP
// ============================================

setInterval(() => {
  const now = Date.now();
  fs.readdirSync("downloads").forEach((file) => {
    const filepath = path.join("downloads", file);
    const age = now - fs.statSync(filepath).mtimeMs;
    if (age > FILE_EXPIRY_HOURS * 3600 * 1000) {
      fs.unlinkSync(filepath);
      console.log(`🗑️ Deleted: ${file}`);
    }
  });
}, 3600 * 1000);

// ============================================
// DISCORD LOGIN WITH MAXIMUM DEBUGGING
// ============================================

console.log("=".repeat(50));
console.log("🔐 ATTEMPTING DISCORD LOGIN");
console.log("=".repeat(50));

// Check TOKEN
if (!process.env.TOKEN) {
  console.error("❌ TOKEN environment variable is NOT SET!");
  console.error("💡 Add TOKEN in Render Environment tab");
  botStatus.lastError = "TOKEN not set";
  process.exit(1);
}

const token = process.env.TOKEN.trim();
console.log("✅ TOKEN found");
console.log("📏 TOKEN length:", token.length, "characters");
console.log("🔍 TOKEN starts with:", token.substring(0, 10) + "...");
console.log("🔍 TOKEN has dots:", (token.match(/\./g) || []).length, "dots");

if (token.length < 50) {
  console.error("⚠️ TOKEN seems too short!");
  console.error("💡 Discord tokens are usually 70+ characters");
  botStatus.lastError = "TOKEN too short";
}

console.log("🔌 Calling client.login()...");
botStatus.loginAttempts++;

client.login(token)
  .then(() => {
    console.log("✅ Login promise resolved successfully!");
  })
  .catch((error) => {
    console.error("=".repeat(50));
    console.error("❌❌❌ LOGIN FAILED! ❌❌❌");
    console.error("=".repeat(50));
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    console.error("Full error:", error);
    console.error("=".repeat(50));
    
    botStatus.lastError = `${error.code}: ${error.message}`;
    
    if (error.code === "TokenInvalid") {
      console.error("\n💡 TOKEN IS INVALID!");
      console.error("1. Go to Discord Developer Portal");
      console.error("2. Bot section → Reset Token");
      console.error("3. Copy NEW token");
      console.error("4. Update in Render Environment");
    } else if (error.code === "DisallowedIntents") {
      console.error("\n💡 INTENTS NOT ENABLED!");
      console.error("1. Discord Developer Portal → Bot");
      console.error("2. Enable MESSAGE CONTENT INTENT");
      console.error("3. Save changes");
    } else {
      console.error("\n💡 UNKNOWN ERROR");
      console.error("Check TOKEN and intents");
    }
    
    console.error("=".repeat(50));
    process.exit(1);
  });

console.log("⏳ Waiting for Discord connection...");

// Timeout check
setTimeout(() => {
  if (!botStatus.connected) {
    console.error("=".repeat(50));
    console.error("⏰ LOGIN TIMEOUT!");
    console.error("=".repeat(50));
    console.error("Bot has been trying to connect for 30 seconds");
    console.error("This usually means:");
    console.error("1. TOKEN is invalid");
    console.error("2. MESSAGE CONTENT INTENT not enabled");
    console.error("3. Network issues");
    console.error("=".repeat(50));
    botStatus.lastError = "Login timeout after 30s";
  }
}, 30000);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("👋 Shutting down...");
  server.close();
  client.destroy();
  process.exit(0);
});
