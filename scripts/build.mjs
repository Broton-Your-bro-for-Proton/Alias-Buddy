// Packs src/ into dist/aliasbuddy-<version>.xpi, and into dist/aliasbuddy-<version>-atn.xpi
// without the Experiment APIs, which addons.thunderbird.net does not accept.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));

/** The ATN variant as a folder, dist/atn: src/ without api/ and experiment_apis. */
export function stageAtn() {
  const dir = path.join(root, "dist", "atn");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(src, dir, { recursive: true, filter: from => from != path.join(src, "api") });
  const { experiment_apis, ...rest } = manifest;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(rest, null, 2) + "\n");
  return dir;
}

function pack(dir, name) {
  const out = path.join(root, "dist", name);
  fs.rmSync(out, { force: true });
  const entries = fs.readdirSync(dir);
  if (process.platform == "win32") {
    // The bsdtar shipped with Windows writes zip archives.
    execFileSync("C:/Windows/System32/tar.exe", ["--format", "zip", "-cf", out, "-C", dir, ...entries]);
  } else {
    execFileSync("zip", ["-qr", out, ...entries], { cwd: dir });
  }
  console.log(out);
}

if (process.argv[1] == fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  pack(src, `aliasbuddy-${manifest.version}.xpi`);
  pack(stageAtn(), `aliasbuddy-${manifest.version}-atn.xpi`);
}
