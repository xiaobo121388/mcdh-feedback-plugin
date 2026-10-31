function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resourceIdsOf(binding) {
  if (!binding) return [];
  if (binding.resource_id !== undefined && binding.resource_ids !== undefined) {
    throw failure("invalid_arguments", "resource_id 与 resource_ids 不能同时填写。");
  }
  const ids = binding.resource_ids ?? [binding.resource_id];
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some(id => typeof id !== "string" || !/^\d{1,64}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw failure("invalid_arguments", "请填写 1 至 100 个不重复的完整数字模组 ID，每个 ID 必须是字符串。");
  }
  return [...ids];
}

function bindingsOf(settings) {
  const bindings = settings.bindings ?? [];
  if (!Array.isArray(bindings)) throw failure("invalid_settings", "反馈绑定必须是数组。");
  const seen = new Set();
  return bindings.map(binding => {
    if (!binding || typeof binding.component_id !== "string" || !binding.component_id.trim() ||
        typeof binding.feedback_directory !== "string" ||
        !binding.feedback_directory.trim() || seen.has(binding.component_id)) {
      throw failure("invalid_settings", "反馈绑定无效或组件重复，请在插件设置中修正。");
    }
    seen.add(binding.component_id);
    return { component_id: binding.component_id, resource_ids: resourceIdsOf(binding), feedback_directory: binding.feedback_directory };
  });
}

export async function invokeHelper(ctx, operation, input = {}, workspace = null, secret) {
  const directory = `${ctx.environment.dataDir}/ipc`;
  await ctx.fs.mkdir(directory);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const requestPath = `${directory}/${id}.request.json`;
  const responsePath = `${directory}/${id}.response.json`;
  const request = { operation, input, workspace, data_dir: ctx.environment.dataDir };
  await ctx.fs.writeText(requestPath, JSON.stringify(request));
  try {
    const result = await ctx.process.run({
      program: `${ctx.environment.packageDir}/bin/mcdh-feedback-helper.exe`,
      args: ["--request", requestPath, "--response", responsePath],
      cwd: ctx.environment.dataDir,
      env: { MCDH_FEEDBACK_SECRET: secret ?? "" },
      timeout_ms: 57000,
    });
    if (result.truncated) throw failure("helper_output_limit", "辅助程序输出超限，结果未采用。");
    let response;
    if (result.exit_code !== 0) {
      try { response = JSON.parse(result.stdout); } catch { /* Do not echo native output or request data. */ }
      throw failure(response?.error?.code ?? "helper_error", response?.error?.message ?? "反馈辅助程序启动失败。");
    }
    try { response = JSON.parse(await ctx.fs.readText(responsePath)); }
    catch { throw failure("invalid_helper_response", "辅助程序没有返回有效结果。"); }
    if (!response.ok) throw failure(response.error?.code ?? "helper_error", response.error?.message ?? "反馈操作失败。");
    return response.result;
  } finally {
    for (const path of [requestPath, responsePath]) {
      try { await ctx.fs.remove(path); } catch { /* A cancelled host call is cleaned on a later helper launch. */ }
    }
  }
}

async function workspaceOf(ctx, input) {
  const bindings = bindingsOf(await ctx.settings.get());
  const binding = bindings.find((item) => item.component_id === input.component_id);
  if (!binding) throw failure("workspace_unbound", "该组件尚未绑定模组 ID 和反馈目录。");
  const component = await ctx.components.get(binding.component_id);
  return { ...binding, component_path: component.path };
}

async function editBindings(ctx, edit) {
  const lease = await invokeHelper(ctx, "acquire_binding_lock");
  try { return await edit(); }
  finally { await invokeHelper(ctx, "release_binding_lock", { token: lease.token }); }
}

export function signIn(ctx, mode, input) {
  if (ctx.environment.caller !== "desktop") throw failure("desktop_only", "登录仅允许在 MCDH 桌面面板完成。");
  if (!["password", "cookie"].includes(mode)) throw failure("invalid_arguments", "登录方式无效。");
  const secret = mode === "password" ? input.password : input.cookie;
  if (typeof secret !== "string" || !secret || secret.length > (mode === "password" ? 1024 : 8192) || secret.includes("\0")) {
    throw failure("invalid_arguments", "登录凭据为空或格式无效。");
  }
  if (mode === "password" && (typeof input.account !== "string" || !input.account.trim() || input.account.length > 320)) {
    throw failure("invalid_arguments", "请输入有效的网易账号。");
  }
  return invokeHelper(ctx, mode === "password" ? "login_password" : "login_cookie", mode === "password" ? { account: input.account.trim() } : {}, null, secret);
}

export function activate(ctx) {
  ctx.commands.register("list_developer_components", (input = {}) => invokeHelper(ctx, "list_developer_components", input));
  ctx.commands.register("list_workspaces", async () => {
    const settings = await ctx.settings.get();
    return invokeHelper(ctx, "list_workspaces", { components: await ctx.components.list(), bindings: bindingsOf(settings) });
  });
  ctx.commands.register("upsert_workspace_binding", (input) => editBindings(ctx, async () => {
    const requestedIds = resourceIdsOf(input);
    const component = await ctx.components.get(input.component_id);
    const settings = await ctx.settings.get();
    const previous = bindingsOf(settings);
    const current = previous.find(item => item.component_id === component.id);
    const ids = input.resource_ids !== undefined ? requestedIds : [...new Set([...(current?.resource_ids ?? []), ...requestedIds])];
    const binding = { component_id: component.id, resource_ids: resourceIdsOf({ resource_ids: ids }), feedback_directory: input.feedback_directory ?? current?.feedback_directory ?? "feedback" };
    const validated = await invokeHelper(ctx, "validate_binding", {}, { ...binding, component_path: component.path });
    const bindings = previous.filter((item) => item.component_id !== component.id);
    await ctx.settings.set({ ...settings, bindings: [...bindings, binding] });
    return { binding, feedback_path: validated.feedback_path };
  }));
  ctx.commands.register("remove_workspace_binding", (input) => editBindings(ctx, async () => {
    if (input.resource_id !== undefined) resourceIdsOf({ resource_id: input.resource_id });
    const settings = await ctx.settings.get();
    const previous = bindingsOf(settings);
    const current = previous.find(item => item.component_id === input.component_id);
    const removedIds = (current?.resource_ids ?? []).filter(id => input.resource_id === undefined || id === input.resource_id);
    const remaining = (current?.resource_ids ?? []).filter(id => !removedIds.includes(id));
    const binding = remaining.length ? { ...current, resource_ids: remaining } : null;
    if (removedIds.length) {
      const bindings = previous.flatMap(item => item.component_id !== input.component_id ? [item] : binding ? [binding] : []);
      await ctx.settings.set({ ...settings, bindings });
    }
    return { removed: removedIds.length > 0, removed_resource_ids: removedIds, binding, documents_preserved: true };
  }));
  for (const command of ["get_account_status", "logout"]) {
    ctx.commands.register(command, () => {
      if (command === "logout" && ctx.environment.caller !== "desktop") throw failure("desktop_only", "请在反馈设置中退出登录。");
      return invokeHelper(ctx, command);
    });
  }
  for (const command of ["list_player_comments", "list_player_feedback", "list_feedback_documents", "read_feedback_document",
    "write_feedback_document", "rename_feedback_document", "delete_feedback_document", "restore_feedback_document"]) {
    ctx.commands.register(command, async (input) => {
      const workspace = await workspaceOf(ctx, input);
      const query = command === "list_player_comments" || command === "list_player_feedback";
      if (query && input.resource_id !== undefined && !workspace.resource_ids.includes(input.resource_id)) {
        throw failure("resource_not_bound", "指定的模组 ID 未绑定到该工作区。");
      }
      return invokeHelper(ctx, command, query ? { offset: 0, limit: 100, ...input } : input, workspace);
    });
  }
  ctx.commands.register("open_feedback", () => ctx.ui.openPanel("feedback"));
}
