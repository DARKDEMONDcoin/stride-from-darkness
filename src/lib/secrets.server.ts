/**
 * المصدر الموحّد لمفاتيح المنصة: خزنة Supabase Secrets المحقونة في بيئة الخادم.
 * لا تُقرأ مفاتيح المنصة من جداول التطبيق، ولا تعبر هذه الوحدة إلى المتصفح.
 */

/** إبطال الذاكرة المؤقتة — يُنادى بعد أي تعديل على المفاتيح. */
export function resetSecretsCache(): void {
  // أبقينا الدالة للتوافق مع المستدعين القدامى؛ بيئة الخادم لا تحتاج ذاكرة مؤقتة.
}

/** قيمة مفتاح واحد من خزنة Supabase؛ سلسلة فارغة إن لم يُضبط. */
export async function getSecret(name: string): Promise<string> {
  return (process.env[name] ?? "").trim();
}

/** قيم عدة مفاتيح من خزنة Supabase في نداء واحد. */
export async function getSecrets<T extends readonly string[]>(
  names: T,
): Promise<Record<T[number], string>> {
  const out = {} as Record<T[number], string>;
  for (const name of names) {
    out[name as T[number]] = (process.env[name] ?? "").trim();
  }
  return out;
}
