import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events
} from "discord.js";
import ytdlp from "yt-dlp-exec";
import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `https://your-app.onrender.com`;
const FILE_EXPIRY_HOURS = 4;
const SELF_PING_INTERVAL = 15 * 60 * 1000; // 15 min

// --- EXPRESS SERVER ---
const app = express();
if (!fs.existsSync("downloads")) fs.mkdirSync("downloads");
app.use("/downloads", express.static("downloads"));
app.get("/", (req, res) => res.send("🤖 Bot online"));
app.listen(PORT, () => console.log(`🌐 Web running on port ${PORT}`));

// --- DISCORD BOT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let videoCache = {}; // store URLs per user
let typeCache = {};  // store if user chose video/audio
let queue = [];
let busy = false;

client.once(Events.ClientReady, c => {
  console.log("🤖 Logged in as", c.user.tag);
});

// --- COMMAND HANDLER ---
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!dl")) return;

  const args = msg.content.split(" ");
  const url = args[1];
  if (!url) return msg.reply("❌ Usage: `!dl <URL>`");

  videoCache[msg.author.id] = url;

  // Step 1: ask user to choose Video or Audio
  const menu = new StringSelectMenuBuilder()
    .setCustomId("select_type")
    .setPlaceholder("Choose download type")
    .addOptions([
      { label: "Video", value: "video" },
      { label: "Audio", value: "audio" }
    ]);

  msg.channel.send({
    content: "🎬 Select download type:",
    components: [new ActionRowBuilder().addComponents(menu)]
  });
});

// --- INTERACTION HANDLER ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isStringSelectMenu()) return;

  const userId = interaction.user.id;
  const url = videoCache[userId];
  if (!url) return interaction.reply("❌ URL expired, try again");

  // Step 2: handle type selection
  if (interaction.customId === "select_type") {
    const selectedType = interaction.values[0];
    typeCache[userId] = selectedType;

    if (selectedType === "audio") {
      // directly queue audio download
      queue.push({
        user: interaction.user,
        channel: interaction.channel,
        url,
        format: "bestaudio",
        type: "audio"
      });
      await interaction.reply("🎵 Added to audio download queue");
      processQueue();
    } else if (selectedType === "video") {
      // fetch video qualities
      await interaction.reply("🔍 Fetching video qualities...");
      try {
        const info = await ytdlp(url, { dumpJson: true, skipDownload: true });
        const formats = info.formats
          .filter(f => f.vcodec !== "none" && f.height)
          .sort((a, b) => b.height - a.height)
          .map(f => ({
            label: `${f.height}p ${f.fps || 30}fps`,
            value: f.format_id
          }))
          .slice(0, 25);

        const qualityMenu = new StringSelectMenuBuilder()
          .setCustomId("select_quality")
          .setPlaceholder("Choose video quality")
          .addOptions(formats);

        await interaction.followUp({
          content: "🎥 Select video quality:",
          components: [new ActionRowBuilder().addComponents(qualityMenu)]
        });
      } catch (err) {
        console.error(err);
        await interaction.followUp("❌ Failed to fetch video formats");
      }
    }
  }

  // Step 3: handle video quality selection
  if (interaction.customId === "select_quality") {
    const format = interaction.values[0];
    queue.push({
      user: interaction.user,
      channel: interaction.channel,
      url,
      format,
      type: "video"
    });
    await interaction.reply("📥 Added to video queue");
    processQueue();
  }
});

// --- QUEUE PROCESSING ---
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
    await ytdlp(job.url, {
      format: job.format,
      mergeOutputFormat: ext === "mp4" ? "mp4" : undefined,
      output: filepath,
      postprocessorArgs: ext === "mp3" ? ["-vn", "-ab", "192k", "-ar", "44100", "-y"] : undefined
    });

    const link = `${BASE_URL}/downloads/${filename}`;
    await job.channel.send(`✅ Done!\n${link}`);

    delete videoCache[job.user.id];
    delete typeCache[job.user.id];

  } catch (err) {
    console.error(err);
    await job.channel.send(`❌ ${job.type} download failed`);
  }

  busy = false;
  processQueue();
}

// --- CLEANUP OLD FILES ---
setInterval(() => {
  const now = Date.now();
  fs.readdirSync("downloads").forEach(file => {
    const filepath = path.join("downloads", file);
    if (now - fs.statSync(filepath).mtimeMs > FILE_EXPIRY_HOURS * 3600 * 1000) {
      fs.unlinkSync(filepath);
    }
  });
}, 3600 * 1000);

// --- SELF-PING ---
setInterval(async () => {
  try {
    await fetch(BASE_URL);
    console.log("🌟 Self-ping successful");
  } catch (err) {
    console.error("⚠ Self-ping failed:", err);
  }
}, SELF_PING_INTERVAL);

// --- LOGIN ---
client.login(process.env.TOKEN);
