// Frozen rail fixtures must carry provenance from the real shared renderer
// and the exact source the daemon reads; handwritten stamps cannot prove it.
import { renderFixture } from "../../packages/cli/test/fixtures/render-markdown.ts";
import { parseDataSrc } from "../../packages/cli/src/data-src-format.ts";

export { renderFixture };

export async function provenanceFixture(source: string, path: string, targetLine: number, secondLine?: number): Promise<string> {
  const document = await renderFixture("/repo", path, source);
  const target = [...document.querySelectorAll("p[data-src]")].find((p) => {
    const bounds = parseDataSrc(p.getAttribute("data-src")!);
    return bounds && bounds.startLine <= targetLine && bounds.endLine >= targetLine;
  });
  if (!target) throw new Error("Fixture target has no rendered source paragraph");
  target.id = "target";
  if (secondLine !== undefined) {
    const second = [...document.querySelectorAll("p[data-src]")].find((p) => {
      const bounds = parseDataSrc(p.getAttribute("data-src")!);
      return bounds && bounds.startLine <= secondLine && bounds.endLine >= secondLine;
    });
    if (!second) throw new Error("Second fixture paragraph absent");
    // Two source lines can be one Markdown paragraph. Target its leaf
    // for the second selection without inventing another source block.
    (second === target ? second.querySelector("[data-revkit-leaf]")! : second).id = "target2";
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rail fixture</title></head><body><main><h1>Rail fixture</h1>${document.body.innerHTML}</main></body></html>`;
}
