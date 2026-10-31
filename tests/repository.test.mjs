import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package metadata and plugin manifest have the same version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("mcdh-plugin.json", root), "utf8"));
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.id, "blockecho.feedback");
  assert.equal(packageJson.license, "UNLICENSED");
  await access(new URL(manifest.entry, root));
  for (const panel of manifest.panels) await access(new URL(panel.entry, root));
});

test("native entry points only import source within the helper package", async () => {
  const helper = new URL("helper/", root);
  for (const name of ["src/main.rs", "tests/catalog_http.rs", "src/netease/api.rs"]) {
    const entry = new URL(name, helper);
    const source = await readFile(entry, "utf8");
    for (const [, relative] of source.matchAll(/#\[path = "([^"]+)"\]/g)) {
      const resolved = new URL(relative, entry);
      assert.ok(resolved.href.startsWith(helper.href), `${name}: external source ${relative}`);
      await access(resolved);
    }
  }
});
