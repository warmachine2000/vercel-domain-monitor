// api/monitor.ts

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const domain = (process.env.MONITOR_DOMAIN || "").trim();
    if (!domain) {
      return res.status(400).json({ ok: false, error: "MONITOR_DOMAIN não definido" });
    }

    // Telegram
    const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const tgChatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!tgToken || !tgChatId) {
      return res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não definidos" });
    }

    // Upstash KV REST
    const kvUrl = (process.env.KV_REST_API_URL || "").trim();
    const kvToken = (process.env.KV_REST_API_TOKEN || "").trim();
    if (!kvUrl || !kvToken) {
      return res.status(400).json({ ok: false, error: "KV_REST_API_URL/KV_REST_API_TOKEN não definidos" });
    }

    // Cooldown (em segundos) pra evitar spam se ficar chamando /api/monitor no browser
    const cooldownSec = Number(process.env.NOTIFY_COOLDOWN_SEC || "3600"); // default: 1h
    const now = Date.now();

    const stateKey = `domain-monitor:${domain}:available`;      // "0" ou "1"
    const lastNotifiedKey = `domain-monitor:${domain}:lastNotify`; // timestamp em ms

    // 1) Lê estado anterior e último notify do KV
    const [prevStateResp, lastNotifyResp] = await Promise.all([
      fetch(`${kvUrl}/get/${encodeURIComponent(stateKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      }),
      fetch(`${kvUrl}/get/${encodeURIComponent(lastNotifiedKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      }),
    ]);

    const prevStateJson = await prevStateResp.json().catch(() => ({}));
    const lastNotifyJson = await lastNotifyResp.json().catch(() => ({}));

    const prevAvailable = String(prevStateJson?.result ?? "0") === "1";
    const lastNotifiedAt = Number(lastNotifyJson?.result ?? "0") || 0;

    // 2) Consulta RDAP do Registro.br
    const rdapResp = await fetch(`https://rdap.registro.br/domain/${domain}`, {
      headers: { "User-Agent": "vercel-domain-monitor/1.0" },
    });

    // Regra segura:
    // - 404 => não existe => disponível (para registrar)
    // - 200 => existe => NÃO disponível (mesmo que status do RDAP venha diferente de "active")
    const available = rdapResp.status === 404;

    // 3) Decide se deve notificar
    const changedToAvailable = !prevAvailable && available;
    const inCooldown = now - lastNotifiedAt < cooldownSec * 1000;

    let notified = false;
    let cooldownRemainingSec = 0;

    if (changedToAvailable && !inCooldown) {
      const tgResp = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: `🚨 DOMÍNIO DISPONÍVEL: ${domain}\n(Registro.br RDAP: 404)`,
          disable_web_page_preview: true,
        }),
      });

      if (!tgResp.ok) {
        const txt = await tgResp.text().catch(() => "");
        return res.status(502).json({
          ok: false,
          error: "Falha ao enviar Telegram",
          telegram_status: tgResp.status,
          telegram_body: txt,
        });
      }

      notified = true;

      // grava horário do notify
      await fetch(`${kvUrl}/set/${encodeURIComponent(lastNotifiedKey)}/${encodeURIComponent(String(now))}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
    } else {
      cooldownRemainingSec = inCooldown ? Math.ceil((cooldownSec * 1000 - (now - lastNotifiedAt)) / 1000) : 0;
    }

    // 4) Salva estado atual sempre
    await fetch(`${kvUrl}/set/${encodeURIComponent(stateKey)}/${available ? "1" : "0"}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });

    return res.status(200).json({
      ok: true,
      domain,
      rdapHttpStatus: rdapResp.status,
      available,
      prevAvailable,
      notified,
      cooldownRemainingSec,
      rule: "available=true somente quando RDAP retorna 404",
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
}
