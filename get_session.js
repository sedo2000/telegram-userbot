require("dotenv").config();
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

async function main() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  if (!apiId || !apiHash) throw new Error("ضع API_ID و API_HASH في متغيرات البيئة أو ملف .env");
  const rl = readline.createInterface({ input, output });
  const ask = (q) => rl.question(q);
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  try {
    await client.start({
      phoneNumber: () => ask("رقم الهاتف مع رمز الدولة: "),
      password: () => ask("كلمة مرور التحقق بخطوتين (إن وجدت): "),
      phoneCode: () => ask("رمز Telegram: "),
      onError: (err) => console.error(err)
    });
    console.log("\nانسخ SESSION_STRING التالي إلى إعدادات Environment Variables في الاستضافة:\n");
    console.log(client.session.save());
  } finally {
    await client.disconnect().catch(() => {});
    rl.close();
  }
}
main().catch(err => { console.error(err); process.exit(1); });
