import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activate, signIn } from "../main.js";

const manifest = JSON.parse(await readFile(new URL("../mcdh-plugin.json", import.meta.url), "utf8"));

function fixture(caller = "desktop") {
  const handlers = new Map(); const files = new Map(); const requests = []; const processes = [];
  let settings = { bindings: [] };
  const ctx = {
    environment: { caller, dataDir: "D:/data", packageDir: "D:/package" },
    commands: { register: (name, handler) => handlers.set(name, handler) },
    components: { list: async () => [{ id: "component-a", name: "模组A", path: "D:/模组A", kind: "addon" }], get: async (id) => { assert.equal(id, "component-a"); return { id, path: "D:/模组A" }; } },
    settings: { get: async () => structuredClone(settings), set: async (value) => { settings = structuredClone(value); return value; } },
    fs: { mkdir: async () => {}, writeText: async (path, text) => files.set(path, text), readText: async (path) => { assert.ok(files.has(path)); return files.get(path); }, remove: async (path) => files.delete(path) },
    process: { run: async (options) => {
      processes.push(options);
      const request = JSON.parse(files.get(options.args[1])); requests.push(request);
      const result = request.operation === "acquire_binding_lock" ? {token:"test-lock"} : request.operation === "validate_binding" ? { feedback_path: "D:/模组A/feedback" } : request.operation === "list_workspaces" ? { items: [] } : { ok: true };
      files.set(options.args[3], JSON.stringify({ ok: true, result }));
      return { exit_code: 0, stdout: '{"ok":true}', stderr: "", truncated: false };
    } },
    ui: { openPanel: async () => {} },
  };
  activate(ctx);
  return { ctx, handlers, files, requests, processes, settings: () => settings };
}

test("all declared commands are registered; credentials are never MCP tools", () => {
  const state = fixture();
  assert.deepEqual([...state.handlers.keys()].sort(), manifest.commands.map((item) => item.id).sort());
  for (const item of manifest.mcp_tools) {
    assert.ok(state.handlers.has(item.command));
    assert.ok(!["login_password", "login_cookie", "logout", "open_feedback"].includes(item.command));
  }
  assert.deepEqual(manifest.settings_schema.properties.bindings.default, []);
});

test("binding lifecycle preserves long ID strings and documents", async () => {
  const state = fixture();
  await state.handlers.get("upsert_workspace_binding")({ component_id: "component-a", resource_id: "46999999999999999999" });
  assert.deepEqual(state.settings().bindings[0].resource_ids, ["46999999999999999999"]);
  await state.handlers.get("list_player_comments")({ component_id: "component-a" });
  assert.equal(state.requests.at(-1).input.limit, 100);
  assert.equal(state.requests.at(-1).workspace.component_path, "D:/模组A");
  assert.equal(state.files.size, 0);
  const result = await state.handlers.get("remove_workspace_binding")({ component_id: "component-a" });
  assert.equal(result.documents_preserved, true);
  assert.deepEqual(state.settings().bindings, []);
  await assert.rejects(state.handlers.get("read_feedback_document")({ component_id: "component-a", path: "x.md" }), /尚未绑定/);
});

test("remote developer catalog works without local components or bindings", async () => {
  const state = fixture("mcp");
  state.ctx.components.list = async () => { throw new Error("Must not read local components"); };
  state.ctx.components.get = async () => { throw new Error("Must not require a local binding"); };
  state.ctx.settings.get = async () => { throw new Error("Must not depend on local settings"); };
  const command = state.handlers.get("list_developer_components");
  await command();
  assert.equal(state.requests.at(-1).operation, "list_developer_components");
  assert.equal(state.requests.at(-1).workspace, null);
  assert.deepEqual(state.requests.at(-1).input, {});
  await command({ cursor: "v1:all:comp:100", limit: 25 });
  assert.deepEqual(state.requests.at(-1).input, { cursor: "v1:all:comp:100", limit: 25 });
  assert.equal(state.files.size, 0);
  const tool = manifest.mcp_tools.find(item => item.name === "list_developer_components");
  assert.equal(tool.command, "list_developer_components");
  const schema = manifest.commands.find(item => item.id === tool.command).input_schema;
  assert.equal(schema.properties.limit.maximum, 100);
  assert.deepEqual(schema.properties.platform.enum, ["all", "pe", "comp"]);
  assert.equal(schema.required, undefined);
});

test("login secrets use only a transient environment, not request files or arguments", async () => {
  const state = fixture(); const secret = "never-persist-this-password";
  await signIn(state.ctx, "password", { account: "developer", password: secret });
  assert.equal(state.processes[0].env.MCDH_FEEDBACK_SECRET, secret);
  assert.ok(!JSON.stringify(state.requests).includes(secret));
  assert.ok(!JSON.stringify(state.processes[0].args).includes(secret));
  assert.equal(state.files.size, 0);
  const mcp = fixture("mcp");
  assert.throws(() => signIn(mcp.ctx, "cookie", { cookie: secret }), /桌面/);
  assert.equal(mcp.processes.length, 0);
  assert.equal(manifest.commands.some(item => item.id === "login_password" || item.id === "login_cookie"), false);
  assert.throws(() => signIn(state.ctx, "password", {account:"developer",password:secret.repeat(100)}), error => !error.message.includes(secret));
  assert.equal(state.processes.length, 1);
});

test("duplicate generic settings and numeric resource IDs are rejected", async () => {
  const state = fixture();
  await state.handlers.get("upsert_workspace_binding")({ component_id: "component-a", resource_id: "46" });
  state.settings().bindings.push({ ...state.settings().bindings[0] });
  await assert.rejects(state.handlers.get("list_workspaces")(), /重复/);
});

test("legacy bindings are read without writes and adding an ID preserves the directory", async () => {
  const state = fixture();
  const legacy = { component_id: "component-a", resource_id: "46999999999999999999", feedback_directory: "D:/外部报告" };
  await state.ctx.settings.set({ bindings: [legacy] });
  await state.handlers.get("list_workspaces")();
  assert.deepEqual(state.settings().bindings, [legacy]);
  assert.deepEqual(state.requests.at(-1).input.bindings[0].resource_ids, [legacy.resource_id]);
  await state.handlers.get("upsert_workspace_binding")({ component_id: "component-a", resource_id: "46123456789012345678" });
  assert.deepEqual(state.settings().bindings, [{component_id:"component-a",resource_ids:[legacy.resource_id,"46123456789012345678"],feedback_directory:legacy.feedback_directory}]);
  await state.handlers.get("upsert_workspace_binding")({ component_id: "component-a", resource_id: legacy.resource_id });
  assert.equal(state.settings().bindings[0].resource_ids.length, 2);
  assert.equal(state.settings().bindings.length, 1);
});

test("batch binding replaces the ID set explicitly and removals preserve other IDs and documents", async () => {
  const state = fixture();
  const upsert = state.handlers.get("upsert_workspace_binding");
  const remove = state.handlers.get("remove_workspace_binding");
  await upsert({component_id:"component-a",resource_ids:["46999999999999999999","46123456789012345678"],feedback_directory:"reports"});
  await upsert({component_id:"component-a",resource_ids:["46123456789012345678","46888888888888888888"]});
  const removed = await remove({component_id:"component-a",resource_id:"46123456789012345678"});
  assert.deepEqual(removed.removed_resource_ids, ["46123456789012345678"]);
  assert.deepEqual(state.settings().bindings[0].resource_ids, ["46888888888888888888"]);
  assert.equal(state.settings().bindings[0].feedback_directory, "reports");
  assert.equal(removed.documents_preserved, true);
  assert.equal((await remove({component_id:"component-a",resource_id:"46"})).removed, false);
  assert.equal(state.settings().bindings.length, 1);
  await remove({component_id:"component-a",resource_id:"46888888888888888888"});
  assert.deepEqual(state.settings().bindings, []);
  assert.equal(state.requests.some(request => /^(delete|rename)_feedback_document$/.test(request.operation)), false);
});

test("queries include all bound IDs by default and reject an unbound selector before native calls", async () => {
  const state = fixture();
  const ids = ["46999999999999999999","46123456789012345678"];
  await state.handlers.get("upsert_workspace_binding")({component_id:"component-a",resource_ids:ids});
  for (const command of ["list_player_comments", "list_player_feedback"]) {
    await state.handlers.get(command)({component_id:"component-a"});
    assert.deepEqual(state.requests.at(-1).workspace.resource_ids, ids);
    assert.equal(state.requests.at(-1).input.resource_id, undefined);
    await state.handlers.get(command)({component_id:"component-a",resource_id:ids[1],offset:100});
    assert.equal(state.requests.at(-1).input.resource_id, ids[1]);
    assert.equal(state.requests.at(-1).input.offset, 100);
    const count = state.requests.length;
    await assert.rejects(state.handlers.get(command)({component_id:"component-a",resource_id:"46999999999999999998"}), error => error.code === "resource_not_bound");
    assert.equal(state.requests.length, count);
  }
});

test("invalid ID sets never replace a saved binding", async () => {
  const state = fixture();
  const upsert = state.handlers.get("upsert_workspace_binding");
  await upsert({component_id:"component-a",resource_id:"46"});
  const saved = structuredClone(state.settings());
  for (const invalid of [
    {resource_id:46}, {resource_ids:[]}, {resource_ids:["46","46"]}, {resource_ids:[46]},
    {resource_ids:["46","invalid"]}, {resource_id:"46",resource_ids:["46"]},
    {resource_ids:Array.from({length:101},(_,index)=>String(index))},
  ]) {
    await assert.rejects(upsert({component_id:"component-a",...invalid}));
    assert.deepEqual(state.settings(), saved);
  }
});

test("MCP schemas distinguish additive IDs, complete lists and optional query/removal selectors", () => {
  const upsert = manifest.commands.find(item => item.id === "upsert_workspace_binding").input_schema;
  assert.deepEqual(upsert.required, ["component_id"]);
  assert.deepEqual(upsert.oneOf, [{required:["resource_ids"]},{required:["resource_id"]}]);
  assert.equal(upsert.properties.resource_ids.uniqueItems, true);
  assert.equal(upsert.properties.resource_ids.maxItems, 100);
  assert.equal(upsert.properties.feedback_directory.default, undefined);
  for (const command of ["remove_workspace_binding","list_player_comments","list_player_feedback"]) {
    const schema = manifest.commands.find(item => item.id === command).input_schema;
    assert.equal(schema.properties.resource_id.type, "string");
    assert.deepEqual(schema.required, ["component_id"]);
  }
});

test("adding an ID cannot exceed the batch limit or discard the previous list", async () => {
  const state = fixture();
  const upsert = state.handlers.get("upsert_workspace_binding");
  const ids = Array.from({length:100},(_,index)=>`46${String(index).padStart(18,"0")}`);
  await upsert({component_id:"component-a",resource_ids:ids});
  await assert.rejects(upsert({component_id:"component-a",resource_id:"46123456789012345678"}));
  assert.deepEqual(state.settings().bindings[0].resource_ids,ids);
  await upsert({component_id:"component-a",resource_id:ids[99]});
  assert.deepEqual(state.settings().bindings[0].resource_ids,ids);
});
