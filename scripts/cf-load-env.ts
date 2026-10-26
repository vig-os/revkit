import { readFileSync } from "node:fs";
import { DotenvError, dotenvValues, parseDotenv } from "./cf-dotenv.ts";

try {
  const values = dotenvValues(parseDotenv(readFileSync(process.argv[2]!, "utf8")));
  Object.assign(process.env, values);
  process.argv.splice(2, 1);
  await import("./cf.ts");
} catch (error) {
  process.stderr.write((error instanceof DotenvError ? error.message : "cf: could not load local credentials") + "\n");
  process.exitCode = 1;
}
