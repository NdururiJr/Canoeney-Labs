// Text an agent wrote, as the dashboard shows it (spec M0.7, surface S10;
// threat model SR-C-10, SR-C-11, SR-C-13).
//
// - Always inside an element marked `data-agent-text` and labelled with who
//   wrote it, so it can never pass for HQ's own words.
// - Never parsed as HTML. AgentMarkdown reads a small allow-list of markdown
//   straight into React elements: anything else, raw HTML included, stays text.
// - A link is shown only for http(s) and mailto, opens with
//   rel="noopener noreferrer", and shows its real host next to its text.
//   Images are never loaded.
import type { ReactNode } from "react";

/** The URL when it is http, https or mailto; otherwise null. */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const hostOf = (href: string) => {
  try {
    const u = new URL(href);
    return u.protocol === "mailto:" ? u.pathname : u.host;
  } catch {
    return href;
  }
};

/** An agent's words. Inline: a marked span with the author in its tooltip. Block: a labelled box. */
export function AgentText({ author, text, inline = false, className = "" }: { author: string; text: string; inline?: boolean; className?: string }) {
  if (inline) {
    return (
      <span data-agent-text="" data-author={author} title={`Written by ${author}`} className={`agent-text ${className}`}>
        {text}
      </span>
    );
  }
  return (
    <div data-agent-text="" data-author={author} className={`agent-text-box ${className}`}>
      <div className="agent-text-label">written by {author}</div>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------- markdown

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|!\[[^\]\n]*\]\([^)\s]*\)|\[[^\]\n]*\]\([^)\s]*\))/;

function Link({ text, url }: { text: string; url: string }) {
  const href = safeHref(url);
  // Not an allowed link: its text and target are shown as plain text.
  if (!href) return <>{`${text} (${url})`}</>;
  return (
    <>
      <a href={safeHref(href) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">
        {text}
      </a>{" "}
      <span className="text-muted">({hostOf(href)})</span>
    </>
  );
}

function inline(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  src.split(INLINE).forEach((part, i) => {
    if (!part) return;
    const k = `${key}-${i}`;
    if (i % 2 === 0) return out.push(part);
    if (part.startsWith("**")) return out.push(<strong key={k}>{part.slice(2, -2)}</strong>);
    if (part.startsWith("`")) return out.push(<code key={k}>{part.slice(1, -1)}</code>);
    if (part.startsWith("*")) return out.push(<em key={k}>{part.slice(1, -1)}</em>);
    const m = /^(!?)\[([^\]]*)\]\(([^)\s]*)\)$/.exec(part);
    if (!m) return out.push(part);
    // An image is never loaded: its alt text and, when allowed, a plain link to it.
    if (m[1]) return out.push(<Link key={k} text={m[2] || "image"} url={m[3]} />);
    out.push(<Link key={k} text={m[2] || m[3]} url={m[3]} />);
  });
  return out;
}

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${i}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(
        <pre key={k} className="overflow-x-auto bg-cream-2 p-2 text-[12px]">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const size = h[1].length === 1 ? "text-[16px]" : h[1].length === 2 ? "text-[15px]" : "text-[14px]";
      out.push(
        <div key={k} className={`font-bold ${size}`}>
          {inline(h[2], k)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        items.push(<li key={`${k}-${i}`}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""), `${k}-${i}`)}</li>);
      }
      out.push(ordered ? <ol key={k} className="list-decimal pl-5">{items}</ol> : <ul key={k} className="list-disc pl-5">{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i]); i++) para.push(lines[i]);
    out.push(
      <p key={k} className="my-1">
        {inline(para.join("\n"), k)}
      </p>,
    );
  }
  return out;
}

/** An agent's markdown, from an allow-list, inside the labelled agent box. */
export function AgentMarkdown({ author, source, className = "" }: { author: string; source: string; className?: string }) {
  return (
    <div data-agent-text="" data-author={author} className={`agent-text-box ${className}`}>
      <div className="agent-text-label">written by {author}</div>
      <div className="whitespace-pre-wrap">{blocks(source)}</div>
    </div>
  );
}
