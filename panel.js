import MarkdownIt from "markdown-it";
import { createElement, Folder, FileText, Settings, RefreshCw, Search, X, Save, Unlink, LogIn, LogOut, PanelLeft, ChevronRight, CircleHelp, Copy, Check, Link2, CalendarClock, ArrowDownWideNarrow, ExternalLink, AlertTriangle } from "lucide";
import styles from "./panel.css";
import { signIn, resourceIdsOf } from "./main.js";
import { HELP_PROMPTS } from "./prompts.js";

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "className") element.className = value;
    else if (value !== null && value !== undefined) element.setAttribute(key, String(value));
  }
  element.append(...children.filter((value) => value !== null && value !== undefined));
  return element;
}

function icon(definition) {
  const result = createElement(definition);
  result.setAttribute("width", "17"); result.setAttribute("height", "17"); result.setAttribute("aria-hidden", "true");
  return result;
}

function button(label, definition, handler, className = "icon-button", text = false) {
  return node("button", { type: "button", title: label, "aria-label": label, className, onClick: handler }, icon(definition), text ? node("span", {}, label) : null);
}

function message(text, definition = FileText) { return node("div", { className: "empty-state", role: "status" }, icon(definition), node("span", {}, text)); }
const errorText = (error) => String(error?.message ?? error).split(/\r?\n/, 1)[0];

export function createMarkdownRenderer() {
  const renderer = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false, maxNesting: 40 });
  renderer.validateLink = (value) => /^https?:\/\//i.test(value) || /^#[a-z0-9_-]+$/i.test(value);
  renderer.renderer.rules.image = (tokens, index) => renderer.utils.escapeHtml(tokens[index].content ?? "");
  const defaultLink = renderer.renderer.rules.link_open ?? ((tokens, index, options, environment, self) => self.renderToken(tokens, index, options));
  renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    if (!tokens[index].attrGet("href")?.startsWith("#")) {
      tokens[index].attrSet("target", "_blank"); tokens[index].attrSet("rel", "noopener noreferrer nofollow");
    }
    return defaultLink(tokens, index, options, environment, self);
  };
  const defaultHeading = renderer.renderer.rules.heading_open ?? ((tokens, index, options, environment, self) => self.renderToken(tokens, index, options));
  renderer.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
    const content = tokens[index + 1]?.content ?? "";
    if (/^source-[fc]\d+$/i.test(content.trim())) tokens[index].attrSet("id", content.trim().toLowerCase());
    return defaultHeading(tokens, index, options, environment, self);
  };
  return renderer;
}

const statusLabels = { directory_missing: "目录待创建", component_missing: "组件已移除", unsafe_path: "目录不可用", unbound: "未绑定" };
const humanPath = (value) => (value ?? "").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
const fileSize = (size) => size < 1024 ? `${size ?? 0} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const modifiedDate = (seconds) => seconds ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(seconds * 1000)) : "未记录";

export function mount(container, ctx) {
  const previousHeight = container.style.height;
  const previousMinHeight = container.style.minHeight;
  container.style.height = "100%"; container.style.minHeight = "0";
  const renderer = createMarkdownRenderer();
  const ownsHeader = typeof ctx.setHeaderVisible === "function";
  let disposed = false;
  let workspaces = [];
  let documents = [];
  let workspaceId = ctx.environment.componentId ?? null;
  let selectedPath = null;
  let workspaceFilter = "";
  let documentFilter = "";
  let documentSort = "modified";
  let refreshGeneration = 0;
  let listGeneration = 0;
  let previewGeneration = 0;
  let refreshTask = Promise.resolve();
  let dialogOpen = false;
  let previewState = null;

  const root = node("div", { className: "feedback-app", "data-theme": ctx.theme.mode, "data-pane": "documents" });
  const applyTheme = (theme) => {
    root.dataset.theme = theme.mode;
    if (theme.accent) root.style.setProperty("--feedback-sdk-accent", theme.accent);
    else root.style.removeProperty("--feedback-sdk-accent");
  };
  applyTheme(ctx.theme);
  const style = node("style", {}, styles);
  const notice = node("div", { className: "notice", role: "alert", hidden: "" });
  const run = (command, input = {}) => ctx.commands.invoke(command, input);
  const report = (error) => {
    if (disposed) return;
    notice.replaceChildren(icon(AlertTriangle), node("span", {}, errorText(error)), button("关闭错误", X, () => { notice.hidden = true; }));
    notice.hidden = false;
  };
  const currentWorkspace = () => workspaces.find((item) => item.component_id === workspaceId);
  const execute = (work) => { void work().catch(report); };

  const refreshButton = button("刷新反馈", RefreshCw, () => execute(refresh));
  const settingsButton = button("反馈设置", Settings, () => execute(openSettings));
  const helpButton = button("帮助与 AI 提示词", CircleHelp, openHelp);
  const workspaceToggle = button("切换工作区列表", PanelLeft, () => {
    root.dataset.pane = root.dataset.pane === "workspaces" ? "documents" : "workspaces";
    workspaceToggle.setAttribute("aria-expanded", String(root.dataset.pane === "workspaces"));
  }, "icon-button workspace-toggle");
  workspaceToggle.setAttribute("aria-expanded", "false");
  const windowButton = ownsHeader && ctx.placement !== "window" ? button("在独立窗口打开", ExternalLink, () => execute(() => ctx.ui.openPanel("feedback", "window", workspaceId))) : null;
  const toolbar = node("header", { className: "feedback-toolbar" }, node("div", { className: "product-title" }, workspaceToggle, icon(FileText), node("h1", {}, "反馈文档")), node("div", { className: "toolbar-actions" }, refreshButton, helpButton, settingsButton, windowButton));
  const workspaceList = node("div", { className: "item-list workspace-list", role: "group", "aria-label": "模组列表" });
  const documentList = node("div", { className: "item-list document-list", role: "group", "aria-label": "反馈文档列表" });
  const documentTitle = node("h2", {}, "全部文档");
  const workspacePath = node("p", { className: "location" });
  const workspaceCount = node("span", { className: "count" }, "0");
  const documentCount = node("span", { className: "document-count", role: "status" }, "0 份文档");
  const workspaceStatus = node("span", { className: "workspace-status" });
  function search(label, handler) {
    return node("label", { className: "search-field" }, icon(Search), node("input", { type: "search", "aria-label": label, placeholder: label, onInput: (event) => handler(event.target.value) }));
  }
  const workspacePane = node("section", { className: "workspace-pane", "aria-label": "工作区" }, node("header", { className: "pane-heading" }, node("h3", {}, "工作区"), workspaceCount), search("搜索模组", (value) => { workspaceFilter = value; renderWorkspaces(); }), workspaceList,
    node("footer", { className: "workspace-footer" }, button("管理绑定", Link2, () => execute(openSettings), "text-button quiet", true)));
  const sortSelect = node("select", { "aria-label": "文档排序", onChange: (event) => { documentSort = event.target.value; renderDocuments(); } }, node("option", { value: "modified" }, "最近更新"), node("option", { value: "name" }, "文件名称"));
  const columns = node("div", { className: "document-columns", "aria-hidden": "true" }, node("span", {}, "名称"), node("span", { className: "date-column" }, "更新于"), node("span", { className: "size-column" }, "大小"), node("span"));
  const documentPane = node("section", { className: "document-pane" },
    node("header", { className: "document-heading" }, node("div", { className: "document-heading-main" }, documentTitle, workspaceStatus), workspacePath),
    node("div", { className: "document-tools" }, documentCount, search("搜索文档", (value) => { documentFilter = value; renderDocuments(); }), node("label", { className: "sort-field" }, icon(ArrowDownWideNarrow), sortSelect)), columns, documentList);
  root.append(toolbar, notice, node("div", { className: "feedback-layout" }, workspacePane, documentPane));
  container.append(style, root);

  function renderWorkspaces() {
    const bound = workspaces.filter((item) => item.binding);
    workspaceCount.textContent = String(bound.length);
    const visible = bound.filter((item) => `${item.name} ${resourceIdsOf(item.binding).join(" ")}`.toLowerCase().includes(workspaceFilter.toLowerCase()));
    workspaceList.replaceChildren(...visible.map((item) => {
      const active = item.component_id === workspaceId;
      const ids = resourceIdsOf(item.binding);
      return node("button", { type: "button", className: `workspace-item${active ? " selected" : ""}`, "aria-label": item.name, "aria-current": active ? "true" : "false", onClick: () => {
        workspaceId = item.component_id; selectedPath = null; renderWorkspaces(); root.dataset.pane = "documents"; workspaceToggle.setAttribute("aria-expanded", "false"); execute(loadDocuments);
      } }, node("span", { className: "workspace-icon" }, icon(Folder)), node("span", { className: "item-text", title: ids.join("\n") }, node("strong", {}, item.name),
        ...ids.slice(0, 3).map(id => node("small", { className: "resource-id" }, id)),
        ids.length > 3 ? node("small", {}, `另 ${ids.length - 3} 个 ID`) : null,
        item.status === "ready" ? null : node("small", { className: "status" }, statusLabels[item.status] ?? "目录不可用")));
    }));
    if (!visible.length) workspaceList.append(message(bound.length ? "没有匹配的模组" : "尚未绑定模组", Folder));
  }

  function renderDocuments() {
    const visible = documents.filter((item) => item.path.toLowerCase().includes(documentFilter.toLowerCase())).sort((a, b) =>
      (documentSort === "modified" ? (b.modified_at ?? 0) - (a.modified_at ?? 0) : 0) || a.path.localeCompare(b.path, "zh-CN", { numeric: true }));
    documentCount.textContent = documentFilter ? `${visible.length} / ${documents.length} 份文档` : `${documents.length} 份文档`;
    columns.hidden = !visible.length;
    documentList.replaceChildren(...visible.map((item) => node("button", { type: "button", className: "document-item", "aria-label": item.path, title: item.path, "aria-haspopup": "dialog", onClick: () => openPreview(item.path) },
      node("span", { className: "document-name" }, node("span", { className: "file-icon" }, icon(FileText)), node("span", { className: "item-text" }, node("strong", {}, item.path.split("/").at(-1)), node("small", {}, item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "Markdown"))),
      node("time", { className: "date-column", datetime: item.modified_at ? new Date(item.modified_at * 1000).toISOString() : null }, modifiedDate(item.modified_at)), node("span", { className: "size-column" }, fileSize(item.size)), icon(ChevronRight))));
    if (!visible.length) documentList.append(message(documents.length ? "没有匹配的文档" : "暂无反馈文档"));
  }

  function createDialog(label, className, onClose = () => {}) {
    if (dialogOpen || disposed) return null;
    dialogOpen = true;
    const previouslyFocused = container.getRootNode().activeElement;
    const dialog = node("dialog", { className: `feedback-dialog ${className}`, "aria-label": label });
    let alive = true;
    const close = () => {
      if (!alive) return;
      alive = false; dialogOpen = false; dialog.close(); dialog.remove(); onClose();
      if (!disposed) {
        const fallback = [...documentList.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === selectedPath);
        (previouslyFocused?.isConnected ? previouslyFocused : fallback ?? helpButton).focus?.();
      }
    };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    return { dialog, close, get alive() { return alive; }, show() { root.append(dialog); dialog.showModal(); } };
  }

  function openPreview(path) {
    const modal = createDialog("反馈文档预览", "preview-dialog", () => { ++previewGeneration; previewState = null; });
    if (!modal) return;
    selectedPath = path;
    const preview = node("article", { className: "markdown", "aria-label": "Markdown 预览", tabindex: "0" });
    preview.addEventListener("click", (event) => {
      const href = event.target.closest?.("a")?.getAttribute("href");
      if (!href?.startsWith("#")) return;
      const target = [...preview.querySelectorAll("[id]")].find(item => item.id === href.slice(1));
      if (target) { event.preventDefault(); target.scrollIntoView({ block: "start" }); }
    });
    const meta = node("span", { className: "preview-meta" });
    const status = node("span", { className: "read-only-label" }, "只读");
    const heading = node("div", { className: "dialog-title", title: path }, icon(FileText), node("div", {}, node("h2", {}, path.split("/").at(-1)), node("p", {}, `${currentWorkspace()?.name ?? ""} / ${path}`)));
    modal.dialog.append(node("header", { className: "dialog-heading" }, heading, button("关闭预览", X, modal.close)), preview, node("footer", { className: "dialog-footer" }, status, meta));
    previewState = { component: workspaceId, path, preview, meta, modal };
    modal.show(); execute(loadPreview);
  }

  async function loadPreview(preserveScroll = false) {
    const state = previewState;
    if (!state || disposed) return;
    const generation = ++previewGeneration;
    const { component, path, preview, meta } = state;
    const scroll = preserveScroll ? preview.scrollTop : 0;
    const valid = () => !disposed && generation === previewGeneration && previewState === state;
    if (!preserveScroll || !preview.dataset.revision) preview.replaceChildren(message("正在读取文档"));
    preview.setAttribute("aria-busy", "true");
    meta.textContent = "正在读取";
    let offset = 0; let revision; let content = ""; let size = 0;
    try {
      do {
        const result = await run("read_feedback_document", { component_id: component, path, offset, ...(revision ? { expected_revision: revision } : {}) });
        if (!valid()) return;
        if (result.size > 2 * 1024 * 1024) throw new Error("文档超过 2 MiB 预览上限。");
        content += result.content; revision = result.revision; size = result.size;
        if (result.next_offset !== null && result.next_offset <= offset) throw new Error("文档分页未前进。");
        offset = result.next_offset;
      } while (offset !== null);
      if (!valid()) return;
      preview.innerHTML = renderer.render(content.replace(/^\uFEFF/, ""));
      if (!content.trim()) preview.replaceChildren(message("空文档"));
      meta.textContent = fileSize(size);
      preview.dataset.revision = revision;
      preview.scrollTop = scroll;
    } catch (error) {
      if (!valid()) return;
      preview.replaceChildren(message(errorText(error), AlertTriangle));
      delete preview.dataset.revision;
      meta.textContent = "读取失败";
    } finally { if (valid()) preview.setAttribute("aria-busy", "false"); }
  }

  async function loadDocuments() {
    const generation = ++listGeneration;
    ++previewGeneration;
    const workspace = currentWorkspace();
    documents = []; documentCount.textContent = "0 份文档"; columns.hidden = true;
    documentTitle.textContent = workspace?.name ?? "工作区文档";
    workspaceStatus.hidden = !workspace || workspace.status === "ready";
    workspaceStatus.textContent = workspaceStatus.hidden ? "" : statusLabels[workspace.status] ?? "目录不可用";
    workspacePath.textContent = humanPath(workspace?.feedback_path);
    workspacePath.title = humanPath(workspace?.feedback_path);
    documentList.replaceChildren(message(workspace ? "正在读取目录" : "选择一个模组", Folder));
    const previewUnavailable = (text) => {
      if (!previewState) return;
      previewState.preview.replaceChildren(message(text, AlertTriangle));
      previewState.preview.setAttribute("aria-busy", "false");
      delete previewState.preview.dataset.revision;
      previewState.meta.textContent = "无法预览";
    };
    if (!workspace?.binding) {
      const empty = message("尚未绑定模组", Folder);
      empty.append(node("div", { className: "empty-actions" }, button("绑定工作区", Link2, () => execute(openSettings), "text-button", true), button("AI 提示词", CircleHelp, openHelp, "text-button quiet", true)));
      documentList.replaceChildren(empty); previewUnavailable("工作区已移除或解除绑定"); return;
    }
    try {
      if (!["ready", "directory_missing"].includes(workspace.status)) throw new Error(workspace.error ?? "模组目录不可用，请检查绑定。");
      let offset = 0;
      const items = [];
      do {
        const result = await run("list_feedback_documents", { component_id: workspace.component_id, offset, limit: 500 });
        if (disposed || generation !== listGeneration) return;
        items.push(...result.items);
        if (result.next_offset !== null && result.next_offset <= offset) throw new Error("文档目录分页未前进。");
        offset = result.next_offset;
      } while (offset !== null);
      documents = items;
      renderDocuments();
      if (previewState) {
        if (previewState.component !== workspace.component_id) previewUnavailable("工作区已移除或解除绑定");
        else if (!documents.some(item => item.path === previewState.path)) previewUnavailable("文档已移除或更名");
        else await loadPreview(true);
      }
    } catch (error) {
      if (disposed || generation !== listGeneration) return;
      documentList.replaceChildren(message(errorText(error), AlertTriangle));
      previewUnavailable(errorText(error));
    }
  }

  function refresh() {
    refreshTask = refreshTask.catch(() => {}).then(refreshNow);
    return refreshTask;
  }

  async function refreshNow() {
    if (disposed) return;
    refreshButton.disabled = true; refreshButton.classList.add("loading");
    const generation = ++refreshGeneration;
    try {
      const result = await run("list_workspaces");
      if (disposed || generation !== refreshGeneration) return;
      workspaces = result.items;
      if (!workspaces.some((item) => item.binding && item.component_id === workspaceId)) {
        workspaceId = workspaces.find((item) => item.binding)?.component_id ?? null; selectedPath = null;
      }
      renderWorkspaces(); await loadDocuments();
      notice.hidden = true;
    } finally {
      if (!disposed) { refreshButton.disabled = false; refreshButton.classList.remove("loading"); }
    }
  }

  function openHelp() {
    const modal = createDialog("帮助与 AI 提示词", "help-dialog");
    if (!modal) return;
    let selected = HELP_PROMPTS[0];
    let copyGeneration = 0;
    const promptText = node("textarea", { className: "prompt-text", readonly: "", spellcheck: "false", "aria-label": "工作区绑定提示词" });
    promptText.value = selected.text;
    const copyStatus = node("span", { className: "copy-status", role: "status", "aria-live": "polite" });
    const copyButton = button("复制提示词", Copy, () => execute(copyPrompt), "text-button primary", true);
    const tabs = HELP_PROMPTS.map((prompt, index) => node("button", { type: "button", role: "tab", id: `feedback-help-${prompt.id}`, "aria-controls": "feedback-prompt-panel", "aria-selected": String(index === 0), tabindex: index === 0 ? "0" : "-1", onClick: () => selectPrompt(index), onKeyDown: (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      selectPrompt(next); tabs[next].focus();
    } }, icon(index === 0 ? Link2 : CalendarClock), node("span", {}, prompt.title)));
    const promptPanel = node("div", { className: "prompt-panel", id: "feedback-prompt-panel", role: "tabpanel", "aria-labelledby": tabs[0].id }, promptText);
    function selectPrompt(index) {
      selected = HELP_PROMPTS[index]; ++copyGeneration;
      promptText.value = selected.text; promptText.scrollTop = 0;
      promptText.setAttribute("aria-label", `${selected.title}提示词`);
      tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
      promptPanel.setAttribute("aria-labelledby", tabs[index].id);
      copyStatus.textContent = ""; copyButton.replaceChildren(icon(Copy), node("span", {}, "复制提示词"));
    }
    async function copyPrompt() {
      const generation = ++copyGeneration;
      const text = selected.text;
      copyButton.disabled = true; copyStatus.textContent = "";
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
      } catch { /* Some WebView2 hosts deny the async clipboard; use a user-initiated selection. */ }
      if (!modal.alive || disposed || generation !== copyGeneration) { copyButton.disabled = false; return; }
      if (!copied) {
        promptText.focus(); promptText.select();
        try { copied = document.execCommand("copy"); } catch { copied = false; }
      }
      copyButton.disabled = false;
      if (copied) {
        copyStatus.textContent = "已复制到剪贴板";
        copyButton.replaceChildren(icon(Check), node("span", {}, "已复制")); copyButton.focus();
      } else copyStatus.textContent = "复制失败，请选中提示词后复制。";
    }
    modal.dialog.append(node("header", { className: "dialog-heading" }, node("div", { className: "dialog-title" }, icon(CircleHelp), node("h2", {}, "AI 提示词")), button("关闭帮助", X, modal.close)),
      node("div", { className: "help-tabs", role: "tablist", "aria-label": "提示词类型" }, ...tabs), promptPanel,
      node("footer", { className: "dialog-footer" }, copyStatus, copyButton));
    modal.show();
  }

  async function openSettings() {
    if (dialogOpen || disposed) return;
    dialogOpen = true;
    const previouslyFocused = container.getRootNode().activeElement;
    const dialog = node("dialog", { className: "feedback-dialog settings-dialog", "aria-label": "反馈设置" });
    let alive = true; let authMode = "password";
    const close = () => { alive = false; dialogOpen = false; dialog.close(); dialog.remove(); previouslyFocused?.focus?.(); };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    const errorBox = node("div", { className: "form-error", role: "alert", hidden: "" });
    const pending = async (action, form) => {
      const controls = [...form.querySelectorAll("button,input,select,textarea")];
      const disabled = controls.map((item) => item.disabled);
      controls.forEach((item) => { item.disabled = true; }); errorBox.hidden = true;
      try { await action(); }
      catch (error) { if (alive && !disposed) { errorBox.textContent = errorText(error); errorBox.hidden = false; } }
      finally {
        controls.forEach((item, index) => { item.disabled = disabled[index]; });
        removeBinding.disabled = !selectedBinding()?.binding;
      }
    };
    const selector = node("select", { "aria-label": "模组组件", required: "" });
    const resource = node("textarea", { "aria-label": "模组 46 ID", className: "resource-ids-input", rows: "4", required: "", spellcheck: "false" });
    const directory = node("input", { "aria-label": "反馈文档目录", type: "text", required: "", maxlength: "2048" });
    const bindingStatus = node("span", { className: "binding-status" });
    const field = (label, control) => node("label", { className: "form-field" }, node("span", {}, label), control);
    const bindingForm = node("form", { className: "binding-form" });
    const selectedBinding = () => workspaces.find((item) => item.component_id === selector.value);
    function populate() {
      const workspace = selectedBinding();
      resource.value = resourceIdsOf(workspace?.binding).join("\n");
      directory.value = workspace?.binding?.feedback_directory ?? "feedback";
      bindingStatus.textContent = workspace?.component_path ? humanPath(workspace.component_path) : "组件目录不可用";
      removeBinding.disabled = !workspace?.binding;
    }
    const removeBinding = button("移除绑定", Unlink, () => {
      void pending(async () => {
        await run("remove_workspace_binding", { component_id: selector.value });
        await refresh(); populate();
      }, bindingForm);
    }, "text-button danger", true);
    selector.addEventListener("change", populate);
    for (const workspace of workspaces) selector.append(node("option", { value: workspace.component_id }, `${workspace.name}${workspace.status === "component_missing" ? "（已移除）" : ""}`));
    if (workspaceId) selector.value = workspaceId;
    const saveBinding = button("保存绑定", Save, () => {}, "text-button primary", true); saveBinding.type = "submit";
    bindingForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void pending(async () => {
        const ids = resourceIdsOf({ resource_ids: resource.value.trim().split(/[\s,;，；]+/) });
        await run("upsert_workspace_binding", { component_id: selector.value, resource_ids: ids, feedback_directory: directory.value.trim() });
        workspaceId = selector.value; await refresh(); populate();
      }, bindingForm);
    });
    bindingForm.append(field("模组组件", selector), bindingStatus, field("模组 46 ID（每行一个）", resource), field("反馈文档目录", directory), node("div", { className: "form-actions" }, removeBinding, saveBinding));
    populate();
    if (!workspaces.length) { selector.disabled = true; saveBinding.disabled = true; }

    const accountState = node("span", { className: "account-state", role: "status" }, "正在检查登录状态");
    const account = node("input", { "aria-label": "网易账号", autocomplete: "username", type: "text", maxlength: "320" });
    const password = node("input", { "aria-label": "网易密码", autocomplete: "current-password", type: "password", maxlength: "1024" });
    const cookie = node("input", { "aria-label": "NTES_SESS Cookie", autocomplete: "off", type: "password", maxlength: "8192" });
    const passwordFields = node("div", { className: "password-fields" }, field("网易账号", account), field("网易密码", password));
    const cookieFields = node("div", { hidden: "" }, field("NTES_SESS Cookie", cookie));
    const authForm = node("form", { className: "auth-form" });
    const logout = button("退出登录", LogOut, () => { void pending(async () => { await run("logout"); await accountStatus(); }, authForm); }, "text-button", true);
    async function accountStatus() {
      try {
        const result = await run("get_account_status");
        if (!alive || disposed) return;
        accountState.textContent = result.session_state === "valid" ? `已登录 · ${result.nickname ?? "网易开发者"}` : result.session_state === "expired" ? "登录已过期" : "未登录";
        logout.hidden = result.session_state !== "valid";
      } catch (error) { if (alive && !disposed) accountState.textContent = errorText(error); }
    }
    const passwordTab = node("button", { type: "button", className: "active", role: "tab", "aria-selected": "true", onClick: () => setAuthMode("password") }, "账号密码");
    const cookieTab = node("button", { type: "button", role: "tab", "aria-selected": "false", onClick: () => setAuthMode("cookie") }, "Cookie");
    function setAuthMode(mode) {
      authMode = mode; passwordFields.hidden = mode !== "password"; cookieFields.hidden = mode !== "cookie";
      passwordTab.classList.toggle("active", mode === "password"); cookieTab.classList.toggle("active", mode === "cookie");
      passwordTab.setAttribute("aria-selected", String(mode === "password")); cookieTab.setAttribute("aria-selected", String(mode === "cookie"));
      password.value = ""; cookie.value = "";
    }
    const login = button("登录", LogIn, () => {}, "text-button primary", true); login.type = "submit";
    authForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const mode = authMode;
      const input = mode === "password" ? { account: account.value.trim(), password: password.value } : { cookie: cookie.value };
      password.value = ""; cookie.value = "";
      void pending(async () => {
        try { await signIn(ctx, mode, input); await accountStatus(); }
        finally { delete input.password; delete input.cookie; }
      }, authForm);
    });
    authForm.append(node("div", { className: "account-summary" }, accountState, logout), node("div", { className: "segmented", role: "tablist", "aria-label": "登录方式" }, passwordTab, cookieTab), passwordFields, cookieFields, node("div", { className: "form-actions" }, login));
    dialog.append(node("header", { className: "dialog-heading" }, node("h2", {}, "反馈设置"), button("关闭反馈设置", X, close)), errorBox,
      node("section", {}, node("h3", {}, "工作区绑定"), bindingForm), node("section", {}, node("h3", {}, "网易开发者账号"), authForm));
    root.append(dialog); dialog.showModal(); void accountStatus();
  }

  const onFocus = () => { if (!dialogOpen || previewState) execute(refresh); };
  window.addEventListener("focus", onFocus);
  const stopTheme = ctx.onThemeChanged(applyTheme);
  if (ownsHeader) ctx.setHeaderVisible(false);
  execute(refresh);
  return () => {
    disposed = true; ++refreshGeneration; ++listGeneration; ++previewGeneration;
    stopTheme(); window.removeEventListener("focus", onFocus);
    root.querySelectorAll("input[type=password]").forEach((input) => { input.value = ""; });
    root.querySelectorAll("dialog").forEach((dialog) => { dialog.close(); });
    root.remove(); style.remove();
    if (ownsHeader) ctx.setHeaderVisible(true);
    container.style.height = previousHeight; container.style.minHeight = previousMinHeight;
  };
}
