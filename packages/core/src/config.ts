import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const ROOT = process.env.ACDC_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cache = new Map<string, unknown>();

export function loadConfig<T = Record<string, unknown>>(name: string): T {
  if (!cache.has(name)) cache.set(name, parse(readFileSync(join(ROOT, "config", `${name}.yaml`), "utf8")));
  return cache.get(name) as T;
}
