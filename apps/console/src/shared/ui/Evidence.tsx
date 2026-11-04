/** The PR evidence is markdown written by the loop. It is rendered from a small subset (headings,
 * lists, bold, code) after escaping, so nothing in it can become HTML. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1<em>$2</em>");

export function renderEvidence(md: string): string {
  const out: string[] = [];
  let list = false;
  for (const line of md.split("\n")) {
    const item = line.match(/^- (.*)$/);
    if (!item && list) {
      out.push("</ul>");
      list = false;
    }
    if (item) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(item[1] ?? "")}</li>`);
    } else if (line.startsWith("### ")) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith("## ")) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

export function Evidence({ markdown }: { markdown: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: renderEvidence escapes everything first
  return <div className="evidence" dangerouslySetInnerHTML={{ __html: renderEvidence(markdown) }} />;
}
