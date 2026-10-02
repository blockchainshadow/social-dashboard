export function normalizeYouTubeHandle(input) {
  let value = String(input ?? "").trim();
  if (!value) return null;
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname.toLowerCase())) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel" && parts.length === 2) value = parts[1];
      else if (parts.length === 1 && parts[0].startsWith("@")) value = parts[0];
      else return null;
    }
    value = decodeURIComponent(value).normalize("NFC");
  } catch { return null; }
  if (/^UC[\w-]{22}$/.test(value)) return value;
  if (!value.startsWith("@")) value = "@" + value;
  return /^@[\p{L}\p{M}\p{N}_.\-·]{1,40}$/u.test(value) ? value : null;
}
