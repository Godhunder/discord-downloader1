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
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🚀 Discord Video Downloader Bot");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`🌐 BASE_URL: ${BASE_URL}`);
console.log(`📁 Downloads expire: ${FILE_EXPIRY_HOURS} hours`);
console.log(`🔧 Node version: ${process.version}`);

// ============================================
// EXPRESS WEB SERVER
// ============================================
const app = express();

// Create downloads directory
if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
  console.log("📁 Created downloads directory");
}

// Serve static files
app.use("/downloads", express.static("downloads"));

// Health check endpoint
app.get("/", (req, res) => {
  const uptime = Math.floor(process.uptime());
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  res.json({
    status: "online",
    bot: client.isReady() ? "connected" : "connecting",
    uptime: `${hours}h ${minutes}m`,
    downloads: fs.readdirSync("downloads").length,
    queue: queue.length,
    timestamp: new Date().toISOString()
  });
});

// Ping endpoint
app.get("/ping", (req, res) => res.send("pong"));

// Start server
const server = app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
  console.log(`📊 Health check: ${BASE_URL}/`);
});

// ============================================
// DISCORD BOT SETUP
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let videoCache = {};
let queue = [];
let busy = false;

// ============================================
// BOT EVENT HANDLERS
// ============================================

client.once(Events.ClientReady, (c) => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ Bot is ONLINE!`);
  console.log(`📱 Logged in as: ${c.user.tag}`);
  console.log(`🔧 Serving ${c.guilds.cache.size} server(s)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

client.on(Events.Error, (error) => {
  console.error("❌ Discord client error:", error);
});

client.on(Events.Warn, (info) => {
  console.warn("⚠️ Discord warning:", info);
});

// ============================================
// COMMAND HANDLER
// ============================================

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!dl")) return;

  const args = msg.content.trim().split(/\s+/);
  const url = args[1];

  if (!url) {
    return msg.reply({
      content: "❌ **Usage:** `!dl <video_url>`\n**Example:** `!dl https://youtube.com/watch?v=...`"
    });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return msg.reply("❌ Invalid URL format. Please provide a valid link.");
  }

  // Store URL for this user
  videoCache[msg.author.id] = url;

  // Create type selection menu
  const menu = new StringSelectMenuBuilder()
    .setCustomId("select_type")
    .setPlaceholder("Choose download type")
    .addOptions([
      { label: "🎥 Video", value: "video", description: "Download as video file" },
      { label: "🎵 Audio", value: "audio", description: "Download as MP3 audio" }
    ]);

  await msg.channel.send({
    content: `📥 **Download request from ${msg.author.username}**\nSelect download type:`,
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
    return interaction.reply({
      content: "❌ Session expired. Please use `!dl <url>` command again.",
      ephemeral: true
    });
  }

  // ===== TYPE SELECTION =====
  if (interaction.customId === "select_type") {
    const selectedType = interaction.values[0];

    if (selectedType === "audio") {
      queue.push({
        user: interaction.user,
        channel: interaction.channel,
        url,
        format: "bestaudio",
        type: "audio"
      });
      await interaction.reply(`🎵 Added to audio download queue! Position: **${queue.length}**`);
      processQueue();
      return;
    }

    if (selectedType === "video") {
      await interaction.reply("🔍 Fetching available video qualities...");

      try {
        // Get video formats using yt-dlp
        const { stdout } = await execAsync(`yt-dlp -F "${url}"`);
        const lines = stdout.split("\n");
        
        // Parse formats
        const formats = [];
        const seen = new Set();

        for (const line of lines) {
          const match = line.match(/^(\d+)\s+.*?(\d+)p/);
          if (!match) continue;

          const [, formatId, height] = match;
          const fps = line.includes("60fps") ? "60fps" : "30fps";
          const label = `${height}p ${fps}`;

          if (!seen.has(label)) {
            seen.add(label);
            formats.push({
              label: label,
              value: formatId
            });
          }
        }

        if (formats.length === 0) {
          return interaction.followUp("❌ No video formats found for this URL.");
        }

        // Create quality selection menu (max 25 options)
        const qualityMenu = new StringSelectMenuBuilder()
          .setCustomId("select_quality")
          .setPlaceholder("Choose video quality")
          .addOptions(formats.slice(0, 25));

        await interaction.followUp({
          content: "🎥 **Select video quality:**",
          components: [new ActionRowBuilder().addComponents(qualityMenu)]
        });

      } catch (err) {
        console.error("Format fetch error:", err);
        await interaction.followUp("❌ Failed to fetch video formats. Make sure the URL is valid.");
      }
    }
  }

  // ===== QUALITY SELECTION =====
  if (interaction.customId === "select_quality") {
    const format = interaction.values[0];
    
    queue.push({
      user: interaction.user,
      channel: interaction.channel,
      url,
      format,
      type: "video"
    });

    await interaction.reply(`📥 Added to video download queue! Position: **${queue.length}**`);
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

  console.log(`⬇️ Processing ${job.type} download for ${job.user.username}`);

  await job.channel.send(`⬇️ Downloading ${job.type} for **${job.user.username}**...\n*This may take a few minutes.*`);

  try {
    let command;

    if (job.type === "audio") {
      // Download audio only and convert to MP3
      command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 192K -o "${filepath}" "${job.url}"`;
    } else {
      // Download video with best audio and merge
      command = `yt-dlp -f ${job.format}+bestaudio --merge-output-format mp4 -o "${filepath}" "${job.url}"`;
    }

    const { stderr } = await execAsync(command, {
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (stderr && stderr.includes("ERROR")) {
      throw new Error(stderr);
    }

    // Check if file exists
    if (!fs.existsSync(filepath)) {
      throw new Error("File was not created");
    }

    // Get file size
    const stats = fs.statSync(filepath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
    const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${sizeMB} MB`;

    const downloadLink = `${BASE_URL}/downloads/${filename}`;

    // Send success message
    await job.channel.send({
      embeds: [{
        color: 0x00ff00,
        title: `✅ ${job.type === "audio" ? "Audio" : "Video"} Ready!`,
        description: `Download complete for **${job.user.username}**`,
        fields: [
          {
            name: "📊 File Size",
            value: sizeDisplay,
            inline: true
          },
          {
            name: "⏱️ Expires In",
            value: `${FILE_EXPIRY_HOURS} hours`,
            inline: true
          },
          {
            name: "🔗 Download Link",
            value: `[Click here to download](${downloadLink})`,
            inline: false
          }
        ],
        footer: {
          text: `Expires in ${FILE_EXPIRY_HOURS} hours • Auto-deleted`
        },
        timestamp: new Date().toISOString()
      }]
    });

    console.log(`✅ ${job.type} download complete: ${filename} (${sizeDisplay})`);

    // Cleanup cache
    delete videoCache[job.user.id];

  } catch (err) {
    console.error(`❌ Download failed for ${job.user.username}:`, err.message);
    
    await job.channel.send(
      `❌ **Download failed for ${job.user.username}**\n` +
      `*The URL might be invalid, geo-restricted, or the video is unavailable.*`
    );
  }

  busy = false;
  processQueue();
}

// ============================================
// FILE CLEANUP
// ============================================

setInterval(() => {
  try {
    const files = fs.readdirSync("downloads");
    const now = Date.now();
    let deletedCount = 0;

    files.forEach((file) => {
      const filepath = path.join("downloads", file);
      const stats = fs.statSync(filepath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge > FILE_EXPIRY_HOURS * 60 * 60 * 1000) {
        fs.unlinkSync(filepath);
        deletedCount++;
        console.log(`🗑️ Deleted expired file: ${file}`);
      }
    });

    if (deletedCount > 0) {
      console.log(`🧹 Cleanup complete: ${deletedCount} file(s) removed`);
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, CLEANUP_INTERVAL_MS);

// ============================================
// DISCORD LOGIN WITH ERROR HANDLING
// ============================================

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🔐 Attempting Discord login...");

if (!process.env.TOKEN) {
  console.error("❌ FATAL ERROR: TOKEN environment variable not set!");
  console.error("Please add your Discord bot token to environment variables.");
  process.exit(1);
}

const token = process.env.TOKEN.trim();
console.log(`📝 Token found (${token.length} characters)`);

client.login(token)
  .catch((error) => {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ DISCORD LOGIN FAILED!");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("Error:", error.message);
    
    if (error.code === "TokenInvalid") {
      console.error("\n⚠️ INVALID TOKEN!");
      console.error("1. Go to https://discord.com/developers/applications");
      console.error("2. Select your app → Bot section");
      console.error("3. Click 'Reset Token' and copy the new token");
      console.error("4. Update TOKEN in environment variables");
      console.error("5. Enable MESSAGE CONTENT INTENT!");
    } else if (error.code === "DisallowedIntents") {
      console.error("\n⚠️ MISSING INTENTS!");
      console.error("1. Go to Discord Developer Portal → Bot section");
      console.error("2. Enable 'MESSAGE CONTENT INTENT'");
      console.error("3. Enable 'SERVER MEMBERS INTENT'");
      console.error("4. Save changes");
    }
    
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    process.exit(1);
  });

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on("SIGTERM", () => {
  console.log("\n👋 Received SIGTERM, shutting down gracefully...");
  server.close(() => {
    console.log("✅ HTTP server closed");
    client.destroy();
    console.log("✅ Discord client destroyed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("\n👋 Received SIGINT, shutting down gracefully...");
  server.close(() => {
    console.log("✅ HTTP server closed");
    client.destroy();
    console.log("✅ Discord client destroyed");
    process.exit(0);
  });
});
