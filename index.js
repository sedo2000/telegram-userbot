require("dotenv").config();

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { ChatAction } = require("telegram/events/ChatAction");

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING;
const PORT = Number(process.env.PORT || 3000);
const CONFIG_MARKER = "#USERBOT_CONFIG";
const SCHEDULE_MS = 5 * 60 * 1000;
const DOWNLOAD_DIR = path.join(os.tmpdir(), "tg-userbot");

if (!API_ID || !API_HASH || !SESSION_STRING) {
  console.error("Missing API_ID, API_HASH, or SESSION_STRING environment variables.");
  process.exit(1);
}

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const app = express();
app.get("/", (_req, res) => res.status(200).send("Telegram userbot is running"));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));
app.listen(PORT, () => console.log("Health server listening on", PORT));

const client = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
  connectionRetries: 5,
  autoReconnect: true
});

const defaults = {
  welcomeEnabled: true,
  welcomeText: "أهلاً بك {name} نورت المجموعة ❤️",
  excludedUsers: [],
  scheduleEnabled: false,
  scheduleText: "",
  scheduleChatId: process.env.SCHEDULE_CHAT_ID || "",
  smartReplyEnabled: false,
  smartReplyPrivateOnly: true
};
let config = { ...defaults };
let selfId = null;
let scheduleTimer = null;
let busySchedule = false;
let gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-1.5-flash" })
  : null;

const isOwner = (event) => Boolean(selfId && String(event.message.senderId || "") === String(selfId));
const isPrivate = (message) => Boolean(message.isPrivate);
const isGroup = (message) => Boolean(message.isGroup || message.isChannel);
const clean = (s) => String(s || "").trim();
const mentionName = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ") || "صديقنا";

async function saveConfig() {
  const messages = await client.getMessages("me", { limit: 50 });
  const old = messages.find(m => (m.message || "").startsWith(CONFIG_MARKER));
  const body = CONFIG_MARKER + "\n" + JSON.stringify(config);
  if (old) await client.editMessage("me", { message: old.id, text: body });
  else await client.sendMessage("me", { message: body });
}

async function loadConfig() {
  const messages = await client.getMessages("me", { limit: 100 });
  const saved = messages.find(m => (m.message || "").startsWith(CONFIG_MARKER));
  if (saved) {
    try { config = { ...defaults, ...JSON.parse(saved.message.slice(CONFIG_MARKER.length).trim()) }; }
    catch (e) { console.error("Could not parse saved config:", e.message); }
  }
  if (!config.scheduleChatId && process.env.SCHEDULE_CHAT_ID) config.scheduleChatId = process.env.SCHEDULE_CHAT_ID;
}

function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(async () => {
    if (!config.scheduleEnabled || !config.scheduleText || !config.scheduleChatId || busySchedule) return;
    busySchedule = true;
    try {
      await client.sendMessage(config.scheduleChatId, { message: config.scheduleText });
      console.log("Scheduled message sent");
    } catch (e) { console.error("Scheduled send failed:", e.message); }
    finally { busySchedule = false; }
  }, SCHEDULE_MS);
}

function helpText() {
  return [
    "أوامر اليوزربوت:",
    ".اوامر — عرض الأوامر",
    ".ترحيب نص الترحيب — ضبط رسالة الترحيب",
    ".تفعيل — تشغيل/إيقاف الترحيب",
    ".استثناء ID — إضافة مستخدم للاستثناء",
    ".حذف_استثناء ID — حذف استثناء",
    ".المستثناة — عرض قائمة الاستثناءات",
    ".جدولة نص — إرسال النص كل 5 دقائق إلى المحادثة المحددة",
    ".الجدولة — حالة الجدولة",
    ".إيقاف_الجدولة — إيقاف الجدولة",
    ".ذكاء تشغيل أو .ذكاء إيقاف — الرد الذكي في الخاص",
    ".mp3 رابط — تنزيل الصوت كرابط ملف في المحادثة"
  ].join("\n");
}

async function handleOwnerCommand(message) {
  const text = clean(message.message);
  if (!text.startsWith(".")) return false;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");

  if (command === ".اوامر") {
    await message.delete({ revoke: true }).catch(() => {});
    await client.sendMessage("me", { message: helpText() });
  } else if (command === ".ترحيب") {
    if (!arg) return true;
    config.welcomeText = arg;
    await saveConfig();
    await message.reply({ message: "تم حفظ رسالة الترحيب." });
  } else if (command === ".تفعيل") {
    config.welcomeEnabled = !config.welcomeEnabled;
    await saveConfig();
    await message.reply({ message: config.welcomeEnabled ? "تم تفعيل الترحيب." : "تم إيقاف الترحيب." });
  } else if (command === ".استثناء") {
    const id = arg.replace(/[^0-9-]/g, "");
    if (!id) return true;
    if (!config.excludedUsers.includes(id)) config.excludedUsers.push(id);
    await saveConfig();
    await message.reply({ message: "تمت إضافة الاستثناء." });
  } else if (command === ".حذف_استثناء") {
    config.excludedUsers = config.excludedUsers.filter(x => x !== arg);
    await saveConfig();
    await message.reply({ message: "تم حذف الاستثناء إن كان موجوداً." });
  } else if (command === ".المستثناة") {
    await message.reply({ message: config.excludedUsers.length ? config.excludedUsers.join("\n") : "لا توجد استثناءات." });
  } else if (command === ".جدولة") {
    if (!arg) return true;
    if (!config.scheduleChatId) {
      await message.reply({ message: "حدد SCHEDULE_CHAT_ID في متغيرات البيئة أولاً." });
      return true;
    }
    config.scheduleText = arg;
    config.scheduleEnabled = true;
    await saveConfig();
    startScheduler();
    await message.reply({ message: "تم تفعيل الجدولة. سيتم الإرسال كل 5 دقائق إلى المحادثة المحددة فقط." });
  } else if (command === ".الجدولة") {
    await message.reply({ message: config.scheduleEnabled ? "الجدولة مفعّلة كل 5 دقائق." : "الجدولة متوقفة." });
  } else if (command === ".إيقاف_الجدولة") {
    config.scheduleEnabled = false;
    await saveConfig();
    await message.reply({ message: "تم إيقاف الجدولة." });
  } else if (command === ".ذكاء") {
    config.smartReplyEnabled = arg === "تشغيل";
    await saveConfig();
    await message.reply({ message: config.smartReplyEnabled ? "تم تشغيل الرد الذكي." : "تم إيقاف الرد الذكي." });
  } else if (command === ".mp3") {
    if (!arg) return true;
    await downloadAudio(message, arg);
  } else {
    return false;
  }
  return true;
}

async function downloadAudio(message, url) {
  if (!/^https?:\/\//i.test(url)) {
    await message.reply({ message: "أرسل رابطاً صحيحاً يبدأ بـ http أو https." });
    return;
  }
  const output = path.join(DOWNLOAD_DIR, "audio-%(id)s.%(ext)s");
  const proc = spawn("yt-dlp", ["--no-playlist", "-x", "--audio-format", "mp3", "--max-filesize", "45M", "-o", output, url]);
  let error = "";
  proc.stderr.on("data", d => { error += d.toString(); });
  proc.on("close", async code => {
    if (code !== 0) {
      await message.reply({ message: "تعذر تنزيل الصوت. تحقق من الرابط أو جرّب رابطاً آخر." });
      console.error(error.slice(-1500));
      return;
    }
    const file = fs.readdirSync(DOWNLOAD_DIR).map(f => path.join(DOWNLOAD_DIR, f))
      .filter(f => f.endsWith(".mp3")).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!file) {
      await message.reply({ message: "لم يتم العثور على ملف الصوت بعد التنزيل." });
      return;
    }
    try {
      await client.sendFile(message.chatId, { file, caption: "تم تنزيل الصوت." });
    } catch (e) {
      await message.reply({ message: "فشل إرسال الملف؛ قد يكون حجمه أكبر من حد Telegram." });
    } finally { fs.unlink(file, () => {}); }
  });
}

client.addEventHandler(async (event) => {
  const message = event.message;
  if (!message) return;
  try {
    if (message.out) {
      if (isOwner(event)) await handleOwnerCommand(message);
      return;
    }
    if (config.smartReplyEnabled && gemini && isPrivate(message) && message.senderId && !config.excludedUsers.includes(String(message.senderId))) {
      const prompt = clean(message.message);
      if (prompt && prompt.length < 4000) {
        try {
          const result = await gemini.generateContent(prompt);
          const answer = result.response.text().slice(0, 3500);
          if (answer) await message.reply({ message: answer });
        } catch (e) { console.error("Gemini error:", e.message); }
      }
    }
  } catch (e) { console.error("Message handler error:", e); }
}, new NewMessage({}));

client.addEventHandler(async (event) => {
  try {
    if (!config.welcomeEnabled || !event.isGroup || !event.userAdded) return;
    const user = await event.getUser();
    if (!user || config.excludedUsers.includes(String(user.id))) return;
    const text = config.welcomeText.replace(/\{name\}/g, mentionName(user)).replace(/\{id\}/g, String(user.id));
    await event.chat.sendMessage({ message: text });
  } catch (e) { console.error("Welcome handler error:", e.message); }
}, new ChatAction({}));

async function main() {
  await client.start({ phoneNumber: async () => process.env.PHONE_NUMBER || "", password: async () => "", phoneCode: async () => "" });
  const me = await client.getMe();
  selfId = me.id;
  console.log("Logged in as", me.username || me.firstName || String(me.id));
  await loadConfig();
  startScheduler();
  console.log("Userbot started");
}

main().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  try { if (scheduleTimer) clearInterval(scheduleTimer); await client.disconnect(); }
  finally { process.exit(0); }
});
process.on("SIGTERM", async () => {
  try { if (scheduleTimer) clearInterval(scheduleTimer); await client.disconnect(); }
  finally { process.exit(0); }
});
