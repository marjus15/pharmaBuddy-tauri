import { readFileSync, writeFileSync } from "node:fs";
import { buildLatestJson } from "../src/widget-logic.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing ${name}`);
  }
  return process.argv[index + 1];
}

const version = arg("--version");
const signature = readFileSync(arg("--signature-file"), "utf8").trim();
const url = arg("--url");
const pubDate = process.env.RELEASE_PUB_DATE || new Date().toISOString();
const latest = buildLatestJson({
  version,
  signature,
  url,
  notes: `PharmaBuddy ${version}`,
  pubDate,
});
writeFileSync(arg("--out"), `${JSON.stringify(latest, null, 2)}\n`);
