#!/usr/bin/env node
// Thin wrapper around @revkit/cli's `dispatch`: streams the result and exits.
// Kept minimal so the testable logic stays in `src/index.ts`.
import { dispatch } from "../src/index.ts";

const result = await dispatch(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
