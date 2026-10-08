// Preserve each installed package's dependency context when Vite and Node
// keep staging symlink paths. Bun's isolated dependencies are siblings in
// a store slot; linking only the package loses that sibling lookup path.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { unlinkStale } from "../review/build.ts";

const packageName = z.string().min(1).max(214)
  .regex(/^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/i, "expected a valid npm package name")
  .refine((name) => name !== "node_modules" && name !== "favicon.ico", "reserved npm package name");
const manifestSchema = z.object({
  name: packageName,
  dependencies: z.record(packageName, z.string()).optional(),
  optionalDependencies: z.record(packageName, z.string()).optional(),
  peerDependencies: z.record(packageName, z.string()).optional(),
});

function readManifest(physical: string) {
  const path = join(physical, "package.json");
  const result = manifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`revkit build: invalid package manifest '${path}': expected a valid npm package name and string dependency maps (${details})`);
  }
  return result.data;
}

/** Preserve the packaged hoisted layout, including .bin and scoped links. */
export function stageHoistedDependencies(sourceNodeModules: string, targetNodeModules: string): void {
  for (const name of readdirSync(sourceNodeModules)) {
    const from = join(sourceNodeModules, name);
    const to = join(targetNodeModules, name);
    if (name.startsWith("@") && statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o755 });
      for (const pkgName of readdirSync(from)) {
        const pkgFrom = join(from, pkgName);
        const pkgTo = join(to, pkgName);
        unlinkStale(pkgTo);
        symlinkSync(pkgFrom, pkgTo);
      }
    } else {
      unlinkStale(to);
      symlinkSync(from, to);
    }
  }
}

/** Stage a dependency graph without copying package contents or flattening
 * conflicting versions. Each physical package gets one writable wrapper;
 * its files remain links to the trusted install and its node_modules links
 * to the wrappers of the dependencies resolved from that physical package.
 * Memoizing before recursion also preserves cyclic dependency graphs. */
export function stageIsolatedDependencies(
  sourceNodeModules: string,
  targetNodeModules: string,
  trustedInstallRoot: string,
): void {
  const installRoot = realpathSync(trustedInstallRoot);
  const staged = new Map<string, string>();
  const transitive = new Map<string, string>();

  function installedDependency(from: string, name: string): string | undefined {
    let current = from;
    for (;;) {
      const withinRoot = relative(installRoot, current);
      if (withinRoot === ".." || withinRoot.startsWith("../") || isAbsolute(withinRoot)) return undefined;
      const candidate = join(current, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      if (current === installRoot) return undefined;
      current = dirname(current);
    }
  }

  function link(dir: string, name: string, target: string): void {
    const dest = join(dir, name);
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(target, dest);
  }

  function stagePackage(source: string): string {
    const physical = realpathSync(source);
    const previous = staged.get(physical);
    if (previous) return previous;
    const manifest = readManifest(physical);
    const wrapper = join(targetNodeModules, ".revkit-deps", String(staged.size), "node_modules", manifest.name);
    staged.set(physical, wrapper);
    mkdirSync(wrapper, { recursive: true });
    for (const entry of readdirSync(physical)) {
      if (entry !== "node_modules") link(wrapper, entry, join(physical, entry));
    }
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of dependencies) {
      const dependency = installedDependency(physical, name);
      if (dependency) {
        const target = stagePackage(dependency);
        link(join(wrapper, "node_modules"), name, target);
        if (!transitive.has(name)) transitive.set(name, target);
      } else if (name in (manifest.dependencies ?? {}) && !(name in (manifest.optionalDependencies ?? {}))) {
        throw new Error(`revkit build: dependency '${name}' of '${manifest.name}' is missing from the trusted install`);
      }
    }
    return wrapper;
  }

  for (const entry of readdirSync(sourceNodeModules)) {
    if (entry.startsWith(".")) continue;
    const source = join(sourceNodeModules, entry);
    if (entry.startsWith("@")) {
      for (const name of readdirSync(source)) {
        link(targetNodeModules, `${entry}/${name}`, stagePackage(join(source, name)));
      }
    } else {
      link(targetNodeModules, entry, stagePackage(source));
    }
  }
  // Prerender bundles can move dynamic require() calls out of their
  // original module into the staging root. Expose transitive names there too.
  // package-local links above retain the correct versions for normal imports.
  // Match Bun’s chosen root versions when its hoist directory is present.
  // Synthetic installs without that directory retain graph-order fallback.
  const bunHoist = join(installRoot, "node_modules", ".bun", "node_modules");
  const hasBunHoist = existsSync(bunHoist);
  for (const [name, walkedTarget] of transitive) {
    if (existsSync(join(targetNodeModules, name))) continue;
    let target = walkedTarget;
    if (hasBunHoist) {
      const hoisted = join(bunHoist, name);
      if (!existsSync(join(hoisted, "package.json"))) continue;
      target = stagePackage(hoisted);
    }
    link(targetNodeModules, name, target);
  }
}
