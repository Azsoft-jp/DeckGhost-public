#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

async function assertFile(path) {
  await stat(join(root, path));
}

async function validateSamples() {
  const manifest = JSON.parse(await readFile(join(root, "public/samples/manifest.json"), "utf8"));
  if (!Array.isArray(manifest.tracks) || manifest.tracks.length === 0) {
    throw new Error("public/samples/manifest.json has no tracks");
  }
  await assertFile("public/samples/LICENSE.md");
  for (const track of manifest.tracks) {
    const file = track.file ?? String(track.url ?? "").replace(/^\/?samples\//, "");
    if (!file) throw new Error(`sample track without file/url: ${JSON.stringify(track)}`);
    await assertFile(`public/samples/${file}`);
  }
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function main() {
  for (const path of [
    "package.json",
    "package-lock.json",
    "server/index.js",
    "public/index.html",
    "public/help.html",
    "data/techniques.json",
    "LICENSE",
  ]) {
    await assertFile(path);
  }
  await validateSamples();

  const port = 39876;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const response = await waitForHttp(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    if (!html.includes("DeckGhost")) throw new Error("top page does not contain DeckGhost");
  } finally {
    child.kill("SIGTERM");
  }
  if (stderr) throw new Error(`server wrote to stderr: ${stderr}`);
  console.log("Public smoke test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
