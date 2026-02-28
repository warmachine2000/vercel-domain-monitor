export default async function handler(req, res) {
  try {

    const domain = process.env.MONITOR_DOMAIN;

    const rdap = await fetch(`https://rdap.registro.br/domain/${domain}`);

    let available = false;

    if (rdap.status === 404) {
      available = true;
    } else {
      const data = await rdap.json();
      const status = data.status || [];

      if (!status.includes("active")) {
        available = true;
      }
    }

    if (available) {

      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `🚨 DOMÍNIO DISPONÍVEL: ${domain}`
        })
      });

    }

    return res.status(200).json({ ok: true });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
