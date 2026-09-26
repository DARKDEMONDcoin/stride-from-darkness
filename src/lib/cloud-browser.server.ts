/**
 * متصفح سحابي مشترك لكل الموظفين (Browserbase عبر CDP مباشر — بلا Playwright،
 * لأن الخادم لا يشغّل Chromium محلياً).
 *
 * المرحلة الحالية: قراءة المواقع الديناميكية كما يراها المستخدم + لقطة شاشة.
 * أي إجراء حساس (دفع/حجز/إرسال نموذج/تسجيل) لا يُنفَّذ آلياً: يُصنَّف "high"
 * ويتوقف عند طلب موافقة المالك.
 */
import { getSecrets } from "./secrets.server";

const BB = "https://api.browserbase.com/v1";

export type BrowserRisk = "low" | "medium" | "high";

/** يصنّف نية الطلب: القراءة آمنة، الإرسال/الدفع يحتاج موافقة. */
export function classifyBrowserRisk(request: string): BrowserRisk {
  const t = request.toLowerCase();
  if (/(ادفع|دفع|اشتري|اشترِ|شراء|احجز|حجز|اطلب لي|checkout|pay|buy|purchase|book|order)/i.test(t)) return "high";
  if (/(سجّل|سجل لي|اشترك|ارسل النموذج|املأ|submit|sign ?up|register|apply)/i.test(t)) return "medium";
  return "low";
}

type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;
  close: () => void;
};

function connectCdp(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    const timer = setTimeout(() => reject(new Error("cdp connect timeout")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
            setTimeout(() => {
              if (pending.delete(mid)) rej(new Error(`cdp timeout: ${method}`));
            }, 30_000);
          }),
        close: () => {
          try { ws.close(); } catch { /* ignore */ }
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (typeof msg.id !== "number") return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message ?? "cdp error"));
        else p.res(msg.result);
      } catch { /* ignore */ }
    });
    ws.addEventListener("error", () => reject(new Error("cdp socket error")));
  });
}

export type BrowsedPage = { url: string; title: string; text: string; screenshotUrl: string | null };

async function uploadShot(base64: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const path = `browser/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const up = await supabaseAdmin.storage.from("nour-media").upload(path, bytes, { contentType: "image/jpeg" });
    if (up.error) return null;
    const signed = await supabaseAdmin.storage.from("nour-media").createSignedUrl(path, 60 * 60 * 24 * 7);
    return signed.data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

/** يفتح الرابط في متصفح سحابي حقيقي ويعيد النص المعروض ولقطة شاشة. للقراءة فقط. */
export async function browsePage(url: string, opts: { screenshot?: boolean } = {}): Promise<BrowsedPage | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const s = await getSecrets(["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"] as const).catch(() => null);
  const apiKey = s?.BROWSERBASE_API_KEY;
  const projectId = s?.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;

  const created = await fetch(`${BB}/sessions`, {
    method: "POST",
    headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, timeout: 120 }),
  });
  if (!created.ok) {
    console.warn("[browser] session create failed", created.status);
    return null;
  }
  const session = (await created.json()) as { id: string; connectUrl: string };
  let cdp: Cdp | null = null;
  try {
    cdp = await connectCdp(session.connectUrl);
    const { targetInfos } = await cdp.send("Target.getTargets");
    let targetId = (targetInfos as { type: string; targetId: string }[]).find((t) => t.type === "page")?.targetId;
    if (!targetId) targetId = (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    // انتظار تحميل المحتوى الديناميكي.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 750));
      const st = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
      if (st?.result?.value === "complete" && i >= 3) break;
    }
    const ev = await cdp.send(
      "Runtime.evaluate",
      { expression: "JSON.stringify({t:document.title,u:location.href,x:(document.body&&document.body.innerText)||''})", returnByValue: true },
      sessionId,
    );
    const parsed = JSON.parse(ev?.result?.value ?? "{}") as { t?: string; u?: string; x?: string };
    let screenshotUrl: string | null = null;
    if (opts.screenshot) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sessionId).catch(() => null);
      if (shot?.data) screenshotUrl = await uploadShot(shot.data);
    }
    const text = (parsed.x ?? "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 50) return null;
    return { url: parsed.u ?? url, title: parsed.t || url, text: text.slice(0, 20_000), screenshotUrl };
  } catch (e) {
    console.warn("[browser] failed:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    cdp?.close();
    await fetch(`${BB}/sessions/${session.id}`, {
      method: "POST",
      headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    }).catch(() => null);
  }
}
