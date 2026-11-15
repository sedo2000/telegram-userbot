require("dotenv").config();
const input = require("input");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

async function main() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  if (!apiId || !apiHash) throw new Error("ضع API_ID و API_HASH في ملف .env");
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5
  });
  await client.start({
    phoneNumber: async () => await input.text("رقم الهاتف مع رمز الدولة: "),
    password: async () => await input.text("كلمة مرور التحقق بخطوتين (إن وجدت): "),
    phoneCode: async () => await input.text("رمز Telegram: "),
    onError: (err) => console.error(err)
  });
  console.log("\nانسخ SESSION_STRING التالي إلى متغير البيئة SESSION_STRING في منصة الاستضافة:\n");
  console.log(client.session.save());
  await client.disconnect();
}
main().catch((err) => { console.error(err); process.exit(1); });