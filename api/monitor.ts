// api/monitor.ts

import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // -----------------------------
    // 0) Segurança do endpoint (opcional)
    // -----------------------------
    const cronSecret = (process.env.CRON_SECRET || "").trim();
    if (cronSecret) {
      const headerSecret = String(req.headers["x-cron-secret"] || "");
      const querySecret = String((req.query as any)?.secret || "");
      if (headerSecret !== cronSecret && querySecret !== cronSecret) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    // -----------------------------
    // 1) Env vars obrigatórias
    // -----------------------------
    const domain = (process.env.MONITOR_DOMAIN || "").trim();
    if (!domain) {
      return res.status(400).json({ ok: false, error: "MONITOR_DOMAIN não definido" });
    }

    const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const tgChatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!tgToken || !tgChatId) {
      return res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não definidos" });
    }

    const kvUrl = (process.env.KV_REST_API_URL || "").trim();
    const kvToken = (process.env.KV_REST_API_TOKEN || "").trim();
    if (!kvUrl || !kvToken) {
      return res.status(400).json({ ok: false, error: "KV_REST_API_URL/KV_REST_API_TOKEN não definidos" });
    }

    // Cooldown (segundos) para evitar spam (default 1h)
    const cooldownSec = Number(process.env.NOTIFY_COOLDOWN_SEC || "3600");
    const now = Date.now();

    const stateKey = `domain-monitor:${domain}:available`; // "0" ou "1"
    const lastNotifiedKey = `domain-monitor:${domain}:lastNotify`; // timestamp ms
    const lockKey = `domain-monitor:${domain}:lock`;

    // -----------------------------
    // 2) Lock (evita 2 execuções simultâneas notificarem)
    // -----------------------------
    // TTL curto só para evitar corrida: 30s
    const lockTtlSec = Number(process.env.LOCK_TTL_SEC || "30");

    // Upstash KV REST: /set/<key>/<value>?nx=true&ex=<ttl>
    const lockResp = await fetch(
      `${kvUrl}/set/${encodeURIComponent(lockKey)}/1?nx=true&ex=${encodeURIComponent(String(lockTtlSec))}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${kvToken}` },
      }
    );

    // Se o endpoint não suportar POST, tenta GET como fallback
    let lockJson: any = null;
    if (lockResp.ok) {
      lockJson = await lockResp.json().catch(() => ({}));
    } else {
      // fallback GET (algumas configs aceitam GET)
      const lockResp2 = await fetch(
        `${kvUrl}/set/${encodeURIComponent(lockKey)}/1?nx=true&ex=${encodeURIComponent(String(lockTtlSec))}`,
        { headers: { Authorization: `Bearer ${kvToken}` } }
      );
      if (lockResp2.ok) lockJson = await lockResp2.json().catch(() => ({}));
    }

    // Upstash costuma retornar { result: "OK" } quando setou; null quando não setou
    const gotLock = !!lockJson?.result;
    if (!gotLock) {
      return res.status(200).json({
        ok: true,
        domain,
        skipped: "locked",
        hint: "Outra execução já está em andamento (lock ativo)",
      });
    }

    // -----------------------------
    // 3) Lê estado anterior e último notify
    // -----------------------------
    const [prevStateResp, lastNotifyResp] = await Promise.all([
      fetch(`${kvUrl}/get/${encodeURIComponent(stateKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      }),
      fetch(`${kvUrl}/get/${encodeURIComponent(lastNotifiedKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      }),
    ]);

    if (!prevStateResp.ok || !lastNotifyResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Falha ao ler KV",
        kvStatus: { prev: prevStateResp.status, lastNotify: lastNotifyResp.status },
      });
    }

    const prevStateJson = await prevStateResp.json().catch(() => ({}));
    const lastNotifyJson = await lastNotifyResp.json().catch(() => ({}));

    const prevAvailable = String(prevStateJson?.result ?? "0") === "1";
    const lastNotifiedAt = Number(lastNotifyJson?.result ?? "0") || 0;

    // -----------------------------
    // 4) Consulta RDAP (Registro.br)
    // Regra segura:
    // - 404 => não existe => disponível
    // - 200 => existe => NÃO disponível
    // Outros => não conclui disponibilidade (mantém false e informa hint)
    // -----------------------------
    let rdapHttpStatus = 0;
    let rdapErrorHint: string | null = null;

    const rdapResp = await fetch(`https://rdap.registro.br/domain/${domain}`, {
      headers: { "User-Agent": "vercel-domain-monitor/1.1" },
    });

    rdapHttpStatus = rdapResp.status;

    const available = rdapHttpStatus === 404;

    if (rdapHttpStatus !== 200 && rdapHttpStatus !== 404) {
      rdapErrorHint = `RDAP status inesperado: ${rdapHttpStatus} (não assumir disponibilidade)`;
    }

    // -----------------------------
    // 5) Decide notificar
    // - Notifica somente quando muda para disponível
    // - Respeita cooldown
    // -----------------------------
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
      const setNotifyResp = await fetch(
        `${kvUrl}/set/${encodeURIComponent(lastNotifiedKey)}/${encodeURIComponent(String(now))}`,
        { headers: { Authorization: `Bearer ${kvToken}` } }
      );

      if (!setNotifyResp.ok) {
        return res.status(502).json({
          ok: false,
          error: "Falha ao gravar lastNotify no KV",
          kvStatus: setNotifyResp.status,
        });
      }
    } else {
      cooldownRemainingSec = inCooldown
        ? Math.ceil((cooldownSec * 1000 - (now - lastNotifiedAt)) / 1000)
        : 0;
    }

    // -----------------------------
    // 6) Salva estado atual sempre
    // -----------------------------
    const setStateResp = await fetch(
      `${kvUrl}/set/${encodeURIComponent(stateKey)}/${available ? "1" : "0"}`,
      { headers: { Authorization: `Bearer ${kvToken}` } }
    );

    if (!setStateResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Falha ao gravar estado no KV",
        kvStatus: setStateResp.status,
      });
    }

    // -----------------------------
    // 7) Resposta
    // -----------------------------
    return res.status(200).json({
      ok: true,
      domain,
      rdapHttpStatus,
      rdapErrorHint,
      available,
      prevAvailable,
      changedToAvailable,
      notified,
      cooldownRemainingSec,
      rule: "available=true somente quando RDAP retorna 404",
      security: cronSecret ? "CRON_SECRET enabled" : "CRON_SECRET not set",
      lock: { enabled: true, ttlSec: lockTtlSec },
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
}
