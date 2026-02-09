import "dotenv/config";
import { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, Events } from "discord.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

// ===================== CONFIG =====================
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL
  ? process.env.BASE_URL.replace(/\/$/, '')
  : process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${PORT}`;

const FILE_EXPIRY_HOURS = 4;
const SELF_PING_INTERVAL = 15 * 60 * 1000; // 15 min

if (!fs.existsSync("downloads")) fs.mkdirSync("downloads");
console.log("🌐 BASE_URL:", BASE_URL);

// ===================== EXPRESS =====================
import express from "express";
const app = express();
app.use("/downloads", express.static("downloads"));
app.get("/", (req, res) => res.send("🤖 Bot online"));
app.get("/ping", (req, res) => res.send("pong"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ===================== DISCORD =====================
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

client.once(Events.ClientReady, c => {
  console.log("✅ Bot online as", c.user.tag);
});

// ===================== COMMAND =====================
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!dl")) return;

  const args = msg.content.split(" ");
  const url = args[1];
  if (!url) return msg.reply("❌ Usage: !dl <URL>");
  try { new URL(url); } catch { return msg.reply("❌ Invalid URL"); }

  videoCache[msg.author.id] = url;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("select_type")
    .setPlaceholder("Choose download type")
    .addOptions([
      { label: "🎥 Video", value: "video" },
      { label: "🎵 Audio", value: "audio" }
    ]);

  msg.channel.send({ content: "📥 Select download type:", components: [new ActionRowBuilder().addComponents(menu)] });
});

// ===================== INTERACTIONS =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isStringSelectMenu()) return;

  const userId = interaction.user.id;
  const url = videoCache[userId];
  if (!url) return interaction.reply({ content: "❌ Session expired", ephemeral: true });

  // Type selection
  if (interaction.customId === "select_type") {
    const type = interaction.values[0];

    if (type === "audio") {
      queue.push({ user: interaction.user, channel: interaction.channel, url, format: "bestaudio", type: "audio" });
      await interaction.reply(`🎵 Added to audio queue (position ${queue.length})`);
      processQueue();
      return;
    }

    if (type === "video") {
      await interaction.reply("🔍 Fetching video formats...");

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
          const sizeMatch = line.match(/(\d+(\.\d+)?[KMG]B)/);
          const sizeStr = sizeMatch ? `(${sizeMatch[1]})` : '';
          const label = `${height}p ${fps} ${sizeStr}`;
          if (!seen.has(label)) {
            seen.add(label);
            formats.push({ label, value: id });
          }
        }

        if (!formats.length) return interaction.followUp("❌ No formats found");

        const menu = new StringSelectMenuBuilder()
          .setCustomId("select_quality")
          .setPlaceholder("Choose quality")
          .addOptions(formats.slice(0, 25));

        await interaction.followUp({ content: "🎥 Select video quality:", components: [new ActionRowBuilder().addComponents(menu)] });

      } catch (err) {
        console.error(err);
        await interaction.followUp("❌ Failed to fetch formats");
      }
    }
  }

  // Quality selection
  if (interaction.customId === "select_quality") {
    const format = interaction.values[0];
    queue.push({ user: interaction.user, channel: interaction.channel, url, format, type: "video" });
    await interaction.reply(`📥 Added to video queue (position ${queue.length})`);
    processQueue();
  }
});

// ===================== QUEUE PROCESSOR =====================
async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;

  const job = queue.shift();
  const timestamp = Date.now();
  const ext = job.type === "audio" ? "mp3" : "mp4";
  const filename = `${job.type}_${timestamp}.${ext}`;
  const filepath = path.join("downloads", filename);

  await job.channel.send(`⬇️ Downloading ${job.type}...`);

  try {
    const cmd = job.type === "audio"
      ? `yt-dlp -f bestaudio --extract-audio --audio-format mp3 -o "${filepath}" "${job.url}"`
      : `yt-dlp -f ${job.format}+bestaudio --merge-output-format mp4 -o "${filepath}" "${job.url}" "${job.url}"`;

    await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });

    if (!fs.existsSync(filepath)) throw new Error("File not created");

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

    delete videoCache[job.user.id];

  } catch (err) {
    console.error(err);
    await job.channel.send("❌ Download failed");
  }

  busy = false;
  processQueue();
}

// ===================== CLEANUP =====================
setInterval(() => {
  const now = Date.now();
  fs.readdirSync("downloads").forEach(file => {
    const filepath = path.join("downloads", file);
    if (now - fs.statSync(filepath).mtimeMs > FILE_EXPIRY_HOURS * 3600 * 1000) {
      fs.unlinkSync(filepath);
      console.log(`🗑️ Deleted: ${file}`);
    }
  });
}, 3600 * 1000);

// ===================== SELF-PING =====================
setInterval(async () => {
  try {
    await fetch(BASE_URL);
    console.log("🌟 Self-ping successful");
  } catch (err) {
    console.error("⚠ Self-ping failed:", err);
  }
}, SELF_PING_INTERVAL);

// ===================== LOGIN =====================
if (!process.env.TOKEN) {
  console.error("❌ TOKEN not set! Add TOKEN in Render environment variables.");
  process.exit(1);
}

const token = process.env.TOKEN.trim();
client.login(token)
  .then(() => console.log("✅ Login promise resolved"))
  .catch(err => {
    console.error("❌ LOGIN FAILED:", err.message);
    process.exit(1);
  });
