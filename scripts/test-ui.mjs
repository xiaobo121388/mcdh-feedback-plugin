import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "../tests/fixtures.mjs";
import { HELP_PROMPTS } from "../prompts.js";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(plugin, "artifacts", "browser");
await mkdir(output, { recursive: true });
const bundle = await readFile(path.join(plugin, "dist", "panel.js"));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Feedback QA</title><style>html,body,#app{margin:0;height:100%;width:100%}body{background:#fafafa}.host{height:100%}</style><div id="app"></div><script type="module">
import {mount,createMarkdownRenderer} from '/panel.js';
const parent=document.querySelector('#app').attachShadow({mode:'open'});const container=document.createElement('div');container.className='host';parent.append(container);
const workspaces=[
{component_id:'a',name:'回声工坊 · 联机拓展',component_path:'D:/Projects/回声工坊',binding:{resource_id:'46999999999999999999',feedback_directory:'feedback'},feedback_path:'D:/Projects/回声工坊/feedback',status:'ready'},
{component_id:'b',name:'远行者装备',component_path:'D:/Projects/远行者装备',binding:{resource_id:'46123456789012345678',feedback_directory:'D:/Reports/远行者装备'},feedback_path:'D:/Reports/远行者装备',status:'directory_missing'},
{component_id:'c',name:'拓展模组 · 超长工作区名称与兼容性回归测试',component_path:'D:/Projects/长名称',binding:{resource_id:'46999999999999999997',feedback_directory:'feedback'},feedback_path:'D:/Projects/长名称/feedback',status:'ready'}];
window.workspaces=workspaces;
window.documents=[
{path:'日报/反馈优先级报告.md',size:6912,modified_at:1793404800},
{path:'日报/2026-10-29 玩家反馈.md',size:12400,modified_at:1793318400},
{path:'专项/多人联机兼容性排查.markdown',size:3260,modified_at:1793232000},
{path:'已归档/2026-10-27 问题跟进.md',size:840,modified_at:1793145600}];
window.calls=[];window.headerCalls=[];window.panelOpenCalls=[];const listeners=new Set();window.theme=(mode,accent=mode==='dark'?'#70b5f9':'#0f6cbd')=>{ctx.theme={mode,accent};listeners.forEach(fn=>fn(ctx.theme));};
const query=new URLSearchParams(location.search);
window.ctx={environment:{caller:'desktop',componentId:'a'},placement:query.get('placement')??'main',setHeaderVisible(visible){headerCalls.push(visible);},ui:{async openPanel(...args){panelOpenCalls.push(args);}},theme:{mode:'light',accent:'#0f6cbd'},onThemeChanged(fn){listeners.add(fn);return()=>listeners.delete(fn)},commands:{async invoke(command,input={}){window.calls.push({command,input});
if(command==='list_workspaces')return {items:workspaces};
if(command==='list_feedback_documents')return {items:input.component_id==='a'?window.documents:[],next_offset:null};
if(command==='read_feedback_document'){
  if(window.deferReadNext){window.deferReadNext=false;await new Promise(resolve=>window.releaseRead=resolve);}
  if(window.readError)throw new Error(window.readError);
  return {content:window.report,revision:'a'.repeat(64),size:2048,next_offset:null};
}
if(command==='get_account_status')return {session_state:'missing'};
if(command==='upsert_workspace_binding'){const item=workspaces.find(x=>x.component_id===input.component_id);item.binding={...input};return {binding:input};}
if(command==='remove_workspace_binding'){workspaces.find(x=>x.component_id===input.component_id).binding=null;return {removed:true};}
throw new Error('Unexpected UI command: '+command);}}};
if(query.has('legacy')){delete ctx.setHeaderVisible;delete ctx.placement;}
window.report=${JSON.stringify(report).replaceAll("<", "\\u003c")};window.markdown=createMarkdownRenderer();window.dispose=mount(container,ctx);window.ready=true;
</script></html>`;
const server = createServer((request, response) => {
  if (request.url === "/panel.js") { response.setHeader("Content-Type", "text/javascript;charset=utf-8"); response.end(bundle); }
  else { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(html); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = []; const remote = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(url)) remote.push(request.url()); });
  const documentButton = () => page.getByRole("button", { name: "日报/反馈优先级报告.md", exact: true });
  const preview = () => page.getByRole("dialog", { name: "反馈文档预览", exact: true });
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  async function noOverflow(locator) {
    const metrics = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { overflow: element.scrollWidth > element.clientWidth + 2, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(metrics.overflow).toBe(false); expect(metrics.left).toBeGreaterThanOrEqual(0); expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1);
    expect(metrics.top).toBeGreaterThanOrEqual(0); expect(metrics.bottom).toBeLessThanOrEqual(metrics.height + 1);
  }
  async function helpColors(accent, contrast) {
    await page.getByRole("heading", { name: "AI 提示词", exact: true }).hover();
    await expect(page.locator(".help-tabs button[aria-selected=true]")).toHaveCSS("border-bottom-color", accent);
    await expect(page.locator(".help-tabs button[aria-selected=true] svg")).toHaveCSS("color", accent);
    await expect(page.locator(".help-dialog .dialog-title > svg")).toHaveCSS("color", accent);
    const copy = page.getByRole("button", { name: "复制提示词", exact: true });
    await expect(copy).toHaveCSS("background-color", accent);
    await expect(copy).toHaveCSS("color", contrast);
  }
  await page.goto(url);
  await expect(documentButton()).toBeVisible();
  expect(await page.evaluate(() => headerCalls)).toEqual([false]);
  await expect(page.getByRole("heading", { name: "反馈文档", exact: true })).toHaveCount(1);
  await expect(page.getByText("已绑定", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "回声工坊 · 联机拓展", exact: true }).locator(".status")).toHaveCount(0);
  await expect(page.getByText("目录待创建", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "在独立窗口打开", exact: true }).click();
  expect(await page.evaluate(() => panelOpenCalls)).toEqual([["feedback", "window", "a"]]);
  await expect(page.locator(".preview-pane,.preview-dialog,.markdown")).toHaveCount(0);
  expect(await page.evaluate(() => calls.filter(item => item.command === 'read_feedback_document').length)).toBe(0);
  await expect(page.locator(".document-item")).toHaveCount(4);
  await expect(page.locator(".file-icon").first()).toHaveCSS("color", "rgb(15, 108, 189)");
  await screenshot("desktop-light");
  await page.evaluate(() => theme("dark")); await screenshot("desktop-dark");
  await page.getByRole("searchbox", { name: "搜索文档" }).fill("兼容性");
  await expect(page.locator(".document-item")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "搜索文档" }).fill("");
  await page.getByLabel("文档排序", { exact: true }).selectOption("name");
  const names = await page.locator(".document-item").evaluateAll(items => items.map(item => item.getAttribute("aria-label")));
  expect(names).toEqual([...names].sort((a,b) => a.localeCompare(b,"zh-CN",{numeric:true})));
  await page.getByLabel("文档排序", { exact: true }).selectOption("modified");

  await documentButton().click();
  await expect(preview()).toBeVisible();
  await expect(page.getByRole("heading", { name: "玩家反馈优先级报告", exact: true })).toBeVisible();
  await expect(page.locator(".markdown table")).toHaveCount(1);
  await expect(page.locator(".markdown pre code")).toContainText("feedback fixture");
  await expect(page.locator(".markdown script,.markdown img,.markdown a[href^='javascript:']")).toHaveCount(0);
  await expect(page.locator(".markdown #source-f1")).toHaveCount(1);
  await expect(page.locator(".markdown blockquote")).toHaveCSS("border-left-color", "rgb(112, 181, 249)");
  await expect(page.locator(".preview-dialog .dialog-title > svg")).toHaveCSS("color", "rgb(112, 181, 249)");
  await noOverflow(preview()); await screenshot("preview-dark");
  await page.evaluate(() => theme("light"));
  await expect(page.locator(".markdown blockquote")).toHaveCSS("border-left-color", "rgb(15, 108, 189)");
  await expect(page.locator(".feedback-app")).toHaveCSS("color-scheme", "light");
  await screenshot("preview-light");
  await page.evaluate(() => { report += '\n自动刷新验证'; window.dispatchEvent(new Event('focus')); });
  await expect(page.locator(".markdown")).toContainText("自动刷新验证");
  await page.keyboard.press("Escape");
  await expect(preview()).toHaveCount(0); await expect(documentButton()).toBeFocused();
  const reads = await page.evaluate(() => calls.filter(item => item.command === 'read_feedback_document').length);
  await page.getByRole("button", { name: "刷新反馈", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新反馈", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => calls.filter(item => item.command === 'read_feedback_document').length)).toBe(reads);

  await page.getByRole("button", { name: "帮助与 AI 提示词", exact: true }).click();
  const help = page.getByRole("dialog", { name: "帮助与 AI 提示词", exact: true });
  await expect(help).toBeVisible();
  await helpColors("rgb(15, 108, 189)", "rgb(255, 255, 255)");
  await expect(page.getByRole("textbox", { name: "工作区绑定提示词", exact: true })).toHaveValue(HELP_PROMPTS[0].text);
  await page.getByRole("button", { name: "复制提示词", exact: true }).click();
  await expect(page.getByText("已复制到剪贴板", { exact: true })).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(HELP_PROMPTS[0].text);
  await screenshot("help-binding");
  await page.getByRole("tab", { name: "工作区绑定", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "每日总结", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "每日总结提示词", exact: true })).toHaveValue(HELP_PROMPTS[1].text);
  expect(HELP_PROMPTS[1].text).toContain("无需向用户确认");
  expect(HELP_PROMPTS[1].text).toContain("86400 秒");
  await page.getByRole("button", { name: "复制提示词", exact: true }).click();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")).toBe(HELP_PROMPTS[1].text);
  await screenshot("help-daily");
  await page.evaluate(() => theme("dark"));
  await helpColors("rgb(112, 181, 249)", "rgb(16, 24, 32)");
  await screenshot("help-dark");
  await page.evaluate(() => theme("dark", "#ed9dbb"));
  await helpColors("rgb(237, 157, 187)", "rgb(16, 24, 32)");
  await page.evaluate(() => {
    const host = document.querySelector("#app").shadowRoot.querySelector(".host");
    host.style.setProperty("--accent", "#72cbdc");
    host.style.setProperty("--accent-hover", "#98deeb");
    host.style.setProperty("--accent-contrast", "#122529");
  });
  await helpColors("rgb(114, 203, 220)", "rgb(18, 37, 41)");
  await page.getByRole("button", { name: "复制提示词", exact: true }).hover();
  await expect(page.getByRole("button", { name: "复制提示词", exact: true })).toHaveCSS("background-color", "rgb(152, 222, 235)");
  await screenshot("help-host-accent");
  await page.getByRole("heading", { name: "AI 提示词", exact: true }).hover();
  await page.evaluate(() => {
    const host = document.querySelector("#app").shadowRoot.querySelector(".host");
    for (const property of ["--accent", "--accent-hover", "--accent-contrast"]) host.style.removeProperty(property);
  });
  await helpColors("rgb(237, 157, 187)", "rgb(16, 24, 32)");
  await page.evaluate(() => theme("light"));
  await helpColors("rgb(15, 108, 189)", "rgb(255, 255, 255)");
  await page.evaluate(() => { window.originalCopy = document.execCommand.bind(document); window.originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); }; document.execCommand = () => false; });
  await page.getByRole("button", { name: "复制提示词", exact: true }).click();
  await expect(page.getByText("复制失败，请选中提示词后复制。", { exact: true })).toBeVisible();
  await page.evaluate(() => { document.execCommand = window.originalCopy; navigator.clipboard.writeText = window.originalClipboardWrite; });
  await page.keyboard.press("Escape"); await expect(help).toHaveCount(0);

  await page.getByRole("button", { name: "反馈设置", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "模组 46 ID" })).toHaveValue("46999999999999999999");
  await expect(page.getByRole("textbox", { name: "模组 46 ID" })).toHaveAttribute("rows", "4");
  await expect(page.getByRole("textbox", { name: "模组 46 ID" })).not.toHaveAttribute("maxlength", /.+/);
  await page.getByRole("textbox", { name: "模组 46 ID" }).fill("46999999999999999999\n46999999999999999999");
  await page.getByRole("button", { name: "保存绑定", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("不重复");
  expect(await page.evaluate(() => calls.filter(x => x.command === 'upsert_workspace_binding').length)).toBe(0);
  await page.getByRole("textbox", { name: "模组 46 ID" }).fill("46999999999999999999，46888888888888888888");
  await page.getByRole("textbox", { name: "反馈文档目录" }).fill("reports/反馈");
  await page.getByRole("button", { name: "保存绑定", exact: true }).click();
  await expect.poll(() => page.evaluate(() => calls.filter(x => x.command === 'upsert_workspace_binding').length)).toBe(1);
  await expect(page.getByRole("textbox", { name: "模组 46 ID" })).toHaveValue("46999999999999999999\n46888888888888888888");
  expect(await page.evaluate(() => calls.find(x => x.command === 'upsert_workspace_binding').input.resource_ids)).toEqual(["46999999999999999999","46888888888888888888"]);
  await page.getByRole("heading", { name: "反馈设置", exact: true }).hover();
  await expect(page.getByRole("button", { name: "保存绑定", exact: true })).toHaveCSS("background-color", "rgb(15, 108, 189)");
  await screenshot("settings");
  await page.evaluate(() => theme("dark"));
  await expect(page.getByRole("button", { name: "保存绑定", exact: true })).toHaveCSS("background-color", "rgb(112, 181, 249)");
  await expect(page.getByRole("button", { name: "保存绑定", exact: true })).toHaveCSS("color", "rgb(16, 24, 32)");
  await screenshot("settings-dark");
  await page.evaluate(() => theme("light"));
  await page.getByRole("tab", { name: "Cookie", exact: true }).click();
  await expect(page.locator("input[aria-label='NTES_SESS Cookie']")).toBeVisible();
  await expect(page.locator("input[aria-label='网易密码']")).not.toBeVisible();
  await page.getByRole("button", { name: "关闭反馈设置" }).click();
  await expect(page.locator(".workspace-item").first().locator(".resource-id")).toHaveCount(2);
  await page.getByRole("searchbox", { name: "搜索模组", exact: true }).fill("46888888888888888888");
  await expect(page.locator(".workspace-item")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "搜索模组", exact: true }).fill("");
  await expect(page.locator(".workspace-item")).toHaveCount(3);

  await page.evaluate(() => { window.deferReadNext = true; });
  await documentButton().click(); await expect(preview().getByText("正在读取文档", { exact:true })).toBeVisible();
  await page.keyboard.press("Escape"); await page.evaluate(() => releaseRead());
  await expect(preview()).toHaveCount(0);
  await page.evaluate(() => { window.readError = '文档读取失败测试'; });
  await documentButton().click(); await expect(preview().getByText("文档读取失败测试", { exact:true })).toBeVisible();
  await page.keyboard.press("Escape"); await page.evaluate(() => { window.readError = null; });

  for (const [width,height,name] of [[760,820,"narrow"],[390,844,"mobile"]]) {
    await page.setViewportSize({ width, height });
    await noOverflow(page.locator(".feedback-app")); await screenshot(`${name}-list`);
    if (width < 700) {
      await page.getByRole("button", { name: "切换工作区列表", exact: true }).click();
      await expect(page.getByRole("button", { name: "回声工坊 · 联机拓展", exact: true })).toBeVisible();
      await screenshot(`${name}-workspaces`);
      await page.getByRole("button", { name: "回声工坊 · 联机拓展", exact: true }).click();
    }
    await documentButton().click(); await expect(page.locator(".markdown table")).toHaveCount(1);
    await noOverflow(preview()); await screenshot(`${name}-preview`); await page.keyboard.press("Escape");
    if (width === 390) {
      await page.evaluate(() => {
        window.longPath = '很长的中文目录名称/'.repeat(30) + '长文件名称'.repeat(40) + '.md';
        documents.push({ path: longPath, size: 1024, modified_at: 1793404801 });
        window.dispatchEvent(new Event('focus'));
      });
      await page.getByRole('button', { name: await page.evaluate(() => longPath), exact: true }).click();
      await expect(page.locator('.markdown table')).toHaveCount(1);
      await noOverflow(preview()); await expect(page.getByText('只读', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(() => { documents.pop(); window.dispatchEvent(new Event('focus')); });
    }
    await page.getByRole("button", { name: "帮助与 AI 提示词", exact: true }).click();
    await noOverflow(help); await expect(page.getByRole("button", { name: "复制提示词", exact:true })).toBeVisible();
    await screenshot(`${name}-help`); await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width:1360,height:900 });
  await page.evaluate(() => { document.querySelector('#app').style.width = '620px'; });
  await expect(page.getByRole("button", { name: "切换工作区列表", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-pane")).not.toBeVisible(); await noOverflow(page.locator(".feedback-app"));
  await page.evaluate(() => { document.querySelector('#app').style.width = '100%'; });
  await page.getByRole("button", { name: "远行者装备", exact: true }).click();
  await expect(page.getByText("暂无反馈文档", { exact:true })).toBeVisible(); await screenshot("empty");
  await page.evaluate(() => { workspaces[1].status = 'component_missing'; window.dispatchEvent(new Event('focus')); });
  await expect(page.getByText("模组目录不可用，请检查绑定。", { exact:true })).toBeVisible(); await screenshot("unavailable");
  await page.evaluate(() => { workspaces.forEach(item => { item.binding = null; }); window.dispatchEvent(new Event('focus')); });
  await expect(page.getByRole("button", { name:"绑定工作区", exact:true })).toBeVisible(); await screenshot("unbound");
  expect(await page.evaluate(() => Boolean(window.__feedbackPwned))).toBe(false);
  expect(remote).toEqual([]); expect(errors).toEqual([]);
  const writes = await page.evaluate(() => calls.filter(item => /^(write|rename|delete|restore)_feedback_document$/.test(item.command)));
  expect(writes).toEqual([]);
  await page.getByRole("button", { name:"帮助与 AI 提示词", exact:true }).click();
  await page.evaluate(() => dispose());
  await expect(page.locator(".feedback-app,dialog[open]")).toHaveCount(0);
  expect(await page.evaluate(() => headerCalls)).toEqual([false, true]);
  await page.goto(`${url}?legacy=1`);
  await expect(documentButton()).toBeVisible();
  await expect(page.getByRole("button", { name: "在独立窗口打开", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => headerCalls)).toEqual([]);
  await page.evaluate(() => dispose());
  await page.goto(`${url}?placement=window`);
  await expect(documentButton()).toBeVisible();
  await expect(page.getByRole("button", { name: "在独立窗口打开", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => headerCalls)).toEqual([false]);
  await page.evaluate(() => dispose());
  expect(errors).toEqual([]);
  await writeFile(path.join(output,"result.json"), JSON.stringify({passed:true,errors,remote,documentWrites:writes.length,lazyPreview:true,copyVerified:true,responsive:true,headerLifecycle:true,legacyCompatible:true,noBoundLabels:true,hostAccent:true,sdkAccentFallback:true,unattendedDailyPrompt:true,multipleResourceIds:true},null,2));
  console.log(`Browser QA passed: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
