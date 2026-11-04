/** The labelled history, committed as data/history.jsonl.gz so the study reruns without an n8n checkout. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ROOT } from "@acdc/core";
import type { Labelled } from "./history.js";

export const DATASET = join(ROOT, "data/history.jsonl.gz");

export function writeDataset(rows: Labelled[], path = DATASET) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(path, gzipSync(`${text}\n`, { level: 9 }));
}

export function readDataset(path = DATASET): Labelled[] {
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Labelled);
}
