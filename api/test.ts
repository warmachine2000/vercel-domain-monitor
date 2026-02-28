export default async function handler(req, res) {
  try {

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: "🚀 Teste do bot funcionando!"
      })
    });

    return res.status(200).json({ ok: true });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
