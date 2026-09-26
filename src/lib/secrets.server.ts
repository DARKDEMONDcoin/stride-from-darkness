/**
 * الطبقة الموحّدة لمفاتيح المنصة: جدول app_secrets الخاص بالخادم أولاً،
 * ثم خزنة Supabase Secrets كاحتياط. القيم لا تعبر هذه الوحدة إلى المتصفح.
 */

let cache: { at: number; rows: Record<string, string> } | null = null;
const TTL = 60 * 1000;

/** إبطال الذاكرة المؤقتة — يُنادى بعد أي تعديل على المفاتيح. */
export function resetSecretsCache(): void {
  cache = null;
}

/** يقرأ مفاتيح المنصة من الجدول الخادمي ويُظهر أخطاء القراءة بدلاً من إخفائها. */
export async function loadSecrets(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < TTL) return cache.rows;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("app_secrets").select("name, value");
  if (error) {
    console.error("[secrets] تعذّرت قراءة app_secrets:", error.message);
    throw new Error("تعذّرت قراءة مفاتيح المنصة من الخادم.");
  }
  const rows: Record<string, string> = {};
  for (const row of (data ?? []) as { name: string; value: string }[]) {
    const value = (row.value ?? "").trim();
    if (value) rows[row.name] = value;
  }
  cache = { at: Date.now(), rows };
  return rows;
}

/** قيمة مفتاح واحد: الجدول الخادمي أولاً ثم خزنة التشغيل. */
export async function getSecret(name: string): Promise<string> {
  const rows = await loadSecrets();
  return rows[name] || (process.env[name] ?? "").trim();
}

/** قيم عدة مفاتيح من المصدرين في نداء واحد. */
export async function getSecrets<T extends readonly string[]>(
  names: T,
): Promise<Record<T[number], string>> {
  const rows = await loadSecrets();
  const out = {} as Record<T[number], string>;
  for (const name of names) {
    out[name as T[number]] = rows[name] || (process.env[name] ?? "").trim();
  }
  return out;
}
