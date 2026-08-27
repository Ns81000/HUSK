/**
 * Safe link tokenisation for message text.
 *
 * Returns plain tokens for React to render. No HTML string is ever produced,
 * so dangerouslySetInnerHTML is never needed and XSS payloads render inert.
 */

export type TextToken = { readonly kind: "text"; readonly value: string };
export type LinkToken = { readonly kind: "link"; readonly value: string; readonly href: string };
export type Token = TextToken | LinkToken;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    const raw = match[0];
    let href: string | null = null;
    try {
      const parsed = new URL(raw);
      href = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      href = null;
    }
    tokens.push(href === null ? { kind: "text", value: raw } : { kind: "link", value: raw, href });
    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}
