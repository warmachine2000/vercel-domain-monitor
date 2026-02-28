export default async function handler(req, res) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return res.status(400).json({
        ok: false,
        error: "Missing env vars",
        hasToken: !!token,
        hasChatId: !!chatId
      });
    }

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🚀 Teste do bot funcionando!"
      })
    });

    const data = await r.json().catch(() => ({}));

    return res.status(200).json({
      ok: true,
      telegram_http_status: r.status,
      telegram_ok: data.ok,
      telegram_response: data
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
}
