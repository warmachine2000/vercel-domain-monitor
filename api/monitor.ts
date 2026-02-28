// /api/monitor.ts
export default async function handler(req, res) {
  try {
    const domain = (process.env.MONITOR_DOMAIN || "").trim().toLowerCase();
    if (!domain) return res.status(400).json({ ok: false, error: "MONITOR_DOMAIN not set" });

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ ok: false, error: "Upstash KV env vars missing" });
    }

    // 1) Checa domínio via RDAP
    const rdap = await fetch(`https://rdap.registro.br/domain/${domain}`, {
      headers: { "User-Agent": "vercel-domain-monitor/1.0" }
    });

    let available = false;

    if (rdap.status === 404) {
      available = true;
    } else if (rdap.ok) {
      const data = await rdap.json();
      const status: string[] = Array.isArray(data?.status) ? data.status : [];
      if (!status.includes("active")) available = true;
    } else {
      // se RDAP der erro (429/500), não notifica pra evitar falso positivo
      return res.status(200).json({ ok: true, skipped: true, rdap_status: rdap.status });
    }

    // 2) Lê último estado salvo
    const stateKey = `domain:${domain}:available`;
    const lastNotifiedKey = `domain:${domain}:last_notified_at`;

    const [prevStateResp, lastNotifResp] = await Promise.all([
      fetch(`${kvUrl}/get/${encodeURIComponent(stateKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      }),
      fetch(`${kvUrl}/get/${encodeURIComponent(lastNotifiedKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      })
    ]);

    const prevStateJson = await prevStateResp.json();
    const lastNotifJson = await lastNotifResp.json();

    const prevAvailable = prevStateJson?.result === "1";
    const lastNotifiedAt = Number(lastNotifJson?.result || 0);

    // 3) Cooldown (ex: 30 min) pra segurar spam se ficar “available” e alguém bater várias vezes
    const COOLDOWN_MS = 30 * 60 * 1000;
    const now = Date.now();
    const inCooldown = lastNotifiedAt && now - lastNotifiedAt < COOLDOWN_MS;

    const shouldNotify = available && (!prevAvailable) && !inCooldown;

    // 4) Salva estado atual sempre
    await fetch(`${kvUrl}/set/${encodeURIComponent(stateKey)}/${available ? "1" : "0"}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });

    // 5) Se mudou pra disponível, notifica uma vez
    if (shouldNotify) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `🚨 DOMÍNIO DISPONÍVEL: ${domain}`
        })
      });

      // marca horário da notificação (pra cooldown)
      await fetch(`${kvUrl}/set/${encodeURIComponent(lastNotifiedKey)}/${now}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
    }

    return res.status(200).json({
      ok: true,
      domain,
      available,
      prevAvailable,
      notified: shouldNotify,
      cooldown: inCooldown
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "unknown_error" });
  }
}
