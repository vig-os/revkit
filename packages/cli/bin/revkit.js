#!/usr/bin/env node
// Thin wrapper around @revkit/cli's `dispatch`: streams the result and exits.
// Kept minimal so the testable logic stays in `src/index.ts`.
//
// A subcommand that runs a server (`revkit serve`) sets `blockForever`
// on the result — we await it so the process does not exit while the
// daemon is up, then exit with the returned code once it stops.
import { dispatch } from "../src/index.ts";

const result = await dispatch(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.blockForever) {
  await result.blockForever;
}
process.exit(result.exitCode);
