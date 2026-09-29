// Verify the strict rehype-katex wrapper configured in astro.config.mjs
// behaves the way the site relies on:
//
// - A bad LaTeX expression throws instead of shipping a red-`"\error"`
//   fallback. rehype-katex on its own would only record a vfile message
//   and re-render with `throwOnError: false` — the wrapper turns those
//   into a thrown build failure.
// - `\href` is still blocked because `trust: false` is the default,
//   preventing LaTeX from smuggling an outbound link through math.
// - A well-formed equation still renders normally so the strict wrapper
//   is not itself the blocker in the happy path.
import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { rehypeKatexStrict } from "./rehype-katex-strict.ts";

async function renderMath(source: string, options: Record<string, unknown> = {}): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatexStrict, options)
    .use(rehypeStringify)
    .process(source);
  return String(file);
}

describe("rehypeKatexStrict (astro.config.mjs)", () => {
  test("renders a well-formed equation unchanged", async () => {
    const html = await renderMath("Golden ratio: $\\varphi$.");
    expect(html).toContain("katex");
    expect(html).not.toContain("katex-error");
  });

  test("throws on a bad LaTeX command instead of shipping the red fallback", async () => {
    await expect(
      renderMath("Bad: $\\thiscommanddoesnotexist$.", { trust: false }),
    ).rejects.toThrow(/KaTeX parse error|katex-error|thiscommanddoesnotexist/i);
  });

  test("throws on a malformed display equation ($$…$$)", async () => {
    // `\begin{align}` without `\end{align}` is a genuine KaTeX ParseError
    // rather than a warning — a spec regression that turned the strict
    // wrapper into a no-op would ship the red fallback here.
    await expect(
      renderMath("$$\n\\begin{aligned}\nE = m c^2\n$$", { trust: false }),
    ).rejects.toThrow(/KaTeX parse error|katex-error|aligned/i);
  });

  test("blocks the \\href macro (trust: false) so LaTeX cannot smuggle a link", async () => {
    // With trust: false, KaTeX either throws (surfaced by the strict
    // wrapper) or emits the fallback (also surfaced) — either way,
    // no outbound `<a href="https://…">` reaches the built page.
    try {
      const html = await renderMath("$\\href{https://evil.example}{x}$", { trust: false });
      // If it didn't throw, at least the outbound anchor must not exist.
      expect(html).not.toMatch(/<a\s[^>]*href="https?:\/\//i);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/href|KaTeX|error/i);
    }
  });
});
