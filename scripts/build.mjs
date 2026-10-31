import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { writeDependencyLicenses } from "./licenses.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = plugin;
const output = path.join(plugin, "dist");
const delivery = path.join(repository, "target", "mcdh-plugin");
const archive = path.join(delivery, "mcdh-plugin.zip");
const helperIndex = process.argv.indexOf("--helper");
let helper = path.join(repository, "target", "release", "mcdh-feedback-helper.exe");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Creating the Windows x64 distribution requires Windows x64, Rust MSVC, and PowerShell");
}

function run(program, args, cwd = repository) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${program} exited with ${code}`)));
  });
}

if (helperIndex >= 0) {
  if (!process.argv[helperIndex + 1] || process.argv[helperIndex + 1].startsWith("--")) {
    throw new Error("--helper requires the path to a built Windows x64 helper executable");
  }
  helper = path.resolve(process.argv[helperIndex + 1]);
} else {
  await run("cargo", ["build", "--locked", "--release", "-p", "mcdh-feedback-helper"]);
}
await mkdir(path.join(output, "bin"), { recursive: true });
await mkdir(delivery, { recursive: true });
await build({ entryPoints: [path.join(plugin, "main.js")], outfile: path.join(output, "main.js"), bundle: true, format: "esm", platform: "neutral", target: "es2020", charset: "utf8", legalComments: "eof" });
await build({ entryPoints: [path.join(plugin, "panel.js")], outfile: path.join(output, "panel.js"), bundle: true, format: "esm", platform: "browser", target: "es2020", loader: { ".css": "text" }, charset: "utf8", legalComments: "eof", minify: true });
await cp(helper, path.join(output, "bin", "mcdh-feedback-helper.exe"));
for (const name of ["mcdh-plugin.json", "README.md", "CHANGELOG.md", "SOURCE_NOTICE.md"]) await cp(path.join(plugin, name), path.join(output, name));
const notices = ["# Third-Party Notices", "", "The helper reuses this repository's independently implemented NetEase API client. See the source repository's licensing notice.", ""];
for (const [name, file] of [["markdown-it 14.1.0 (MIT)", "markdown-it/LICENSE"], ["Lucide 0.468.0 (ISC)", "lucide/LICENSE"]]) {
  notices.push(`## ${name}`, "", await readFile(path.join(plugin, "node_modules", file), "utf8"));
}
await writeFile(path.join(output, "THIRD_PARTY_NOTICES.md"), notices.join("\n"), "utf8");
await cp(path.join(repository, "THIRD_PARTY_NOTICES.md"), path.join(output, "HELPER_THIRD_PARTY_NOTICES.md"));
await writeDependencyLicenses(repository,plugin,output);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const files = ["main.js", "panel.js", "mcdh-plugin.json", "README.md", "CHANGELOG.md", "SOURCE_NOTICE.md", "THIRD_PARTY_NOTICES.md", "HELPER_THIRD_PARTY_NOTICES.md", "DEPENDENCY_LICENSES.txt", "dependency-licenses.json", "bin"].map((file) => quote(path.join(output, file)));
await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -LiteralPath ${files.join(",")} -DestinationPath ${quote(archive)} -Force`]);
console.log(`Plugin package: ${archive}`);
