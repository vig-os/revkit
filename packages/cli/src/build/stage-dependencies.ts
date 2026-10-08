// Preserve each installed package's dependency context when Vite and Node
// keep staging symlink paths. Bun's isolated dependencies are siblings in
// a store slot; linking only the package loses that sibling lookup path.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Stage a dependency graph without copying package contents or flattening
 * conflicting versions. Each physical package gets one writable wrapper;
 * its files remain links to the trusted install and its node_modules links
 * to the wrappers of the dependencies resolved from that physical package.
 * Memoizing before recursion also preserves cyclic dependency graphs. */
export function stageIsolatedDependencies(sourceNodeModules: string, targetNodeModules: string): void {
  const staged = new Map<string, string>();
  const transitive = new Map<string, string>();

  function installedDependency(from: string, name: string): string | undefined {
    let current = from;
    for (;;) {
      const candidate = join(current, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
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
    const manifest = JSON.parse(readFileSync(join(physical, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
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
  for (const [name, target] of transitive) {
    if (!existsSync(join(targetNodeModules, name))) link(targetNodeModules, name, target);
  }
}
