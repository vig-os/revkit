// Tiny static file server used by Playwright to serve `site/dist` in the
// foreground (`astro preview` in Astro 7 daemonises, which Playwright's
// `webServer` cannot manage, and the smoke must exercise the built artefact
// rather than the dev server).
//
// The server serves files directly from `site/dist`, with `index.html`
// resolution for directory paths and a plain 404 for anything missing.
import { file } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "4321", 10);
const distDir = resolve(import.meta.dirname, "..", "dist");

if (!existsSync(distDir)) {
  console.error(`site/dist does not exist at ${distDir}; run 'bun run build' first.`);
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);

    // Reject any traversal outside dist by normalising and refusing '..' segments.
    if (pathname.includes("\0") || normalize(pathname).includes("..")) {
      return new Response("Bad request", { status: 400 });
    }

    let candidate = join(distDir, pathname);

    // Resolve directories to their `index.html`.
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      candidate = join(candidate, "index.html");
    } else if (!existsSync(candidate) && existsSync(`${candidate}.html`)) {
      candidate = `${candidate}.html`;
    }

    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      const notFound = join(distDir, "404.html");
      if (existsSync(notFound)) {
        return new Response(file(notFound), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("Not Found", { status: 404 });
    }

    return new Response(file(candidate));
  },
});

console.log(`revkit smoke server listening on http://${server.hostname}:${server.port}`);
