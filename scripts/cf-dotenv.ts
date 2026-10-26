// Shared by the loader, merge writer and encrypted-copy writer. Values are data:
// quotes/backslash escapes are decoded, but expansions and commands never run.
const DOTENV_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
export interface DotenvLine { raw: string; key?: string; value?: string }
export class DotenvError extends Error {
  constructor(line: number, key?: string) {
    super(`cf: malformed dotenv line ${line} (${key ?? "unknown key"})`);
  }
}
export const quoteDotenv = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
export function parseDotenv(text: string): DotenvLine[] {
  return text.split(/\r?\n/).map((raw, index) => {
    if (/^\s*(?:#.*)?$/.test(raw)) return { raw };
    const match = DOTENV_KEY.exec(raw);
    const key = match?.[1];
    if (!match || !key) throw new DotenvError(index + 1);
    const input = raw.slice(match[0].length).trimStart();
    let value = "";
    let quote = "";
    for (let i = 0; i < input.length; i++) {
      const char = input[i]!;
      if (quote === "'") {
        if (char === "'") quote = ""; else value += char;
      } else if (char === "\\") {
        const next = input[++i];
        if (next === undefined) throw new DotenvError(index + 1, key);
        // Double quotes retain backslashes before non-shell escape characters.
        if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) value += "\\";
        value += next;
      } else if (quote === '"') {
        if (char === '"') quote = ""; else value += char;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (/\s/.test(char)) {
        const trailing = input.slice(i).trim();
        if (trailing && !trailing.startsWith("#")) throw new DotenvError(index + 1, key);
        break;
      } else if (/[`$;|&<>()]/.test(char)) {
        throw new DotenvError(index + 1, key);
      } else value += char;
    }
    if (quote) throw new DotenvError(index + 1, key);
    return { raw, key, value };
  });
}
export function dotenvValues(lines: DotenvLine[]): Record<string, string> {
  return Object.fromEntries(lines.filter((line) => line.key !== undefined).map((line) => [line.key!, line.value!]));
}
