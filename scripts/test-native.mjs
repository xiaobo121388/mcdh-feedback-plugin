import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpClient } from "./mcp-client.mjs";
import { report } from "../tests/fixtures.mjs";
import { HELP_PROMPTS } from "../prompts.js";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = plugin;
const host = process.env.MCDH_ROOT ?? path.resolve(repository, "..", "MCDevHelper");
const qaRoot = path.join(repository,"target","mcdh-plugin-qa");
await mkdir(qaRoot,{recursive:true});
const data = await mkdtemp(path.join(qaRoot,"native-"));
const output = path.join(data,"screenshots"); await mkdir(output);
const archive = path.join(repository,"target","mcdh-plugin","mcdh-plugin.zip");

async function command(program,args,cwd) {
  const child=spawn(program,args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="";
  child.stdout.on("data",chunk=>{output+=chunk});child.stderr.on("data",chunk=>{output+=chunk});
  await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(new Error(output)))});
  return output;
}
await command("cargo",["run","--locked","-p","mcdh-plugins","--example","install_fixture","--",data,archive],host);
const socket=createServer();await new Promise(resolve=>socket.listen(0,"127.0.0.1",resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const endpoint=`http://127.0.0.1:${port}`;
const executable=process.env.MCDH_PLUGIN_QA_EXE??path.join(host,"target","release","mcdh-desktop.exe");
const env={...process.env,MCDH_DATA_DIR:data,MCDH_DISABLE_MCS_SCAN:"1",WEBVIEW2_USER_DATA_FOLDER:path.join(data,"webview"),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`};
const child=spawn(executable,[],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let logs="";child.stdout.on("data",chunk=>{logs=(logs+chunk).slice(-512*1024)});child.stderr.on("data",chunk=>{logs=(logs+chunk).slice(-512*1024)});
let browser;let main;let mcp;const errors=[];let checks=0;
async function hostColor(page, property) {
  return page.evaluate(property => {
    const sample = document.createElement("span");
    sample.style.color = `var(${property})`;
    document.body.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  }, property);
}
async function setTheme(mode) {
  await main.evaluate(async theme => {
    const settings = await window.__TAURI_INTERNALS__.invoke("get_settings");
    await window.__TAURI_INTERNALS__.invoke("set_settings", {settings:{...settings,theme}});
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {event:"mcdh:settings-changed",payload:null});
  }, mode);
  await expect(main.locator("html")).toHaveAttribute("data-theme", mode);
}
async function checkHelpColors(page) {
  const accent = await hostColor(page, "--accent");
  await expect(page.locator(".help-tabs button[aria-selected=true]")).toHaveCSS("border-bottom-color", accent);
  await expect(page.locator(".help-dialog .dialog-title > svg")).toHaveCSS("color", accent);
  const copy = page.getByRole("button", {name:"复制提示词",exact:true});
  await expect(copy).toHaveCSS("background-color", accent);
  await expect(copy).toHaveCSS("color", await hostColor(page, "--accent-contrast"));
  checks++;
}
try {
  await expect.poll(async()=>{if(child.exitCode!==null)throw new Error(`MCDH exited: ${logs}`);try{return(await fetch(`${endpoint}/json/version`)).status}catch{return 0}},{timeout:45000}).toBe(200);
  browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];
  await expect.poll(async()=>{for(const page of context.pages()){try{if(await page.evaluate(()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)==="main"){main=page;return true}}catch{}}return false},{timeout:30000}).toBe(true);
  main.on("pageerror",error=>errors.push(error.message));
  await expect(main.getByRole("heading",{name:"全部组件",exact:true})).toBeVisible();
  for(let attempt=0;attempt<6;attempt++){
    for(const page of context.pages())if(page!==main){const label=await page.evaluate(()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(()=>"");if(label==="dialog-startup"){const close=page.getByRole("button",{name:/^(知道了|稍后提醒)$/});if(await close.count())await close.click();}}
    await main.waitForTimeout(200);
  }
  const paths=[];
  for(const [index,name] of [["a","模组 A"],["b","模组 B"]]){
    const directory=path.join(data,"projects",index);await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,"manifest.json"),JSON.stringify({format_version:2,header:{name,description:"Isolated feedback test",uuid:randomUUID(),version:[1,0,0],min_engine_version:[1,20,0]},modules:[{type:"data",uuid:randomUUID(),version:[1,0,0]}]}));
    paths.push(directory);await main.evaluate(async(path)=>window.__TAURI_INTERNALS__.invoke("add_single_component",{path}),directory);
  }
  const components=await main.evaluate(async()=> (await window.__TAURI_INTERNALS__.invoke("refresh_components")).components);
  assert.equal(components.length,2);checks++;
  await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"mcdh:workspace-changed",payload:{}}));
  const a=components.find(item=>item.path.toLowerCase().endsWith("\\a")||item.path.endsWith("/a"));
  const b=components.find(item=>item.id!==a.id);
  mcp=new McpClient(path.join(host,"target","release","mcdh-mcp.exe"),{MCDH_DATA_DIR:data,MCDH_DISABLE_MCS_SCAN:"1"});await mcp.initialize();
  const unauthorized=await mcp.request("tools/list");assert.equal(unauthorized.tools.some(tool=>tool.name.startsWith("plugin__blockecho.feedback__")),false);checks++;
  await main.evaluate(async componentId=>{const plugin=(await window.__TAURI_INTERNALS__.invoke("list_plugins"))[0];await window.__TAURI_INTERNALS__.invoke("configure_plugin",{pluginId:plugin.manifest.id,fingerprint:plugin.fingerprint,enabled:true,allowMcp:true,settings:{...plugin.settings,bindings:[{component_id:componentId,resource_id:"46999999999999999999",feedback_directory:"feedback"}]}});},a.id);
  await expect.poll(async()=>(await mcp.request("tools/list")).tools.filter(tool=>tool.name.startsWith("plugin__blockecho.feedback__")).length,{timeout:10000}).toBe(13);checks++;
  const catalogTool=(await mcp.request("tools/list")).tools.find(tool=>tool.name==="plugin__blockecho.feedback__list_developer_components");
  assert.ok(catalogTool);assert.equal(catalogTool.inputSchema.properties.limit.maximum,100);checks++;
  await assert.rejects(mcp.call("list_developer_components"),/sign in|登录/);checks++;
  await assert.rejects(mcp.call("list_developer_components",{cursor:"v1:pe:comp:0"}),/cursor|platform/);checks++;
  const legacy = await mcp.call("list_workspaces");
  assert.deepEqual(legacy.items.find(item=>item.component_id===a.id).binding.resource_ids,["46999999999999999999"]);
  assert.equal((await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke("list_plugins")))[0].settings.bindings[0].resource_id,"46999999999999999999");checks++;
  await Promise.all([
    mcp.call("upsert_workspace_binding",{component_id:a.id,resource_id:"46999999999999999999"}),
    mcp.call("upsert_workspace_binding",{component_id:b.id,resource_id:"46123456789012345678",feedback_directory:path.join(data,"external","反馈报告")})
  ]);
  const workspaces=await mcp.call("list_workspaces");assert.equal(workspaces.items.filter(item=>item.binding).length,2);checks++;
  const peer = new McpClient(path.join(host,"target","release","mcdh-mcp.exe"),{MCDH_DATA_DIR:data,MCDH_DISABLE_MCS_SCAN:"1"});
  try {
    await peer.initialize();
    await Promise.all([
      mcp.call("upsert_workspace_binding",{component_id:a.id,resource_id:"46888888888888888888"}),
      peer.call("upsert_workspace_binding",{component_id:a.id,resource_id:"46777777777777777777"}),
    ]);
  } finally { await peer.close(); }
  const multi = (await mcp.call("list_workspaces")).items.find(item=>item.component_id===a.id);
  assert.deepEqual([...multi.binding.resource_ids].sort(),["46999999999999999999","46888888888888888888","46777777777777777777"].sort());
  assert.equal(multi.feedback_path,workspaces.items.find(item=>item.component_id===a.id).feedback_path);checks++;
  await mcp.call("remove_workspace_binding",{component_id:a.id,resource_id:"46777777777777777777"});
  assert.deepEqual((await mcp.call("list_workspaces")).items.find(item=>item.component_id===a.id).binding.resource_ids,["46999999999999999999","46888888888888888888"]);checks++;
  await assert.rejects(mcp.call("upsert_workspace_binding",{component_id:a.id,resource_id:"46",resource_ids:["46"]}));
  await assert.rejects(mcp.call("upsert_workspace_binding",{component_id:a.id,resource_ids:[]}));
  await assert.rejects(mcp.call("upsert_workspace_binding",{component_id:a.id,resource_ids:["46","46"]}));checks++;
  const initial=await mcp.call("write_feedback_document",{component_id:a.id,path:"日报/优先级报告.md",content:report});
  const read=await mcp.call("read_feedback_document",{component_id:a.id,path:"日报/优先级报告.md"});assert.equal(read.content,report);assert.equal(read.revision,initial.revision);checks++;
  await assert.rejects(mcp.call("write_feedback_document",{component_id:a.id,path:"日报/优先级报告.md",content:"do not overwrite",mode:"replace",expected_revision:"0".repeat(64)}));checks++;
  await assert.rejects(mcp.call("read_feedback_document",{component_id:a.id,path:"../manifest.json"}));checks++;
  const deleted=await mcp.call("delete_feedback_document",{component_id:a.id,path:"日报/优先级报告.md",expected_revision:initial.revision});
  assert.equal((await mcp.call("list_feedback_documents",{component_id:a.id})).total,0);checks++;
  await mcp.call("restore_feedback_document",{component_id:a.id,trash_id:deleted.trash_id});checks++;
  await mcp.call("rename_feedback_document",{component_id:a.id,path:"日报/优先级报告.md",new_path:"日报/验证报告.md",expected_revision:initial.revision});checks++;
  const account=await mcp.call("get_account_status");assert.equal(account.session_state,"missing");checks++;
  await assert.rejects(mcp.call("list_player_comments",{component_id:a.id}),/sign in|登录/);checks++;
  await assert.rejects(mcp.call("list_player_feedback",{component_id:a.id}),/sign in|登录/);checks++;
  await assert.rejects(mcp.call("list_player_comments",{component_id:a.id,resource_id:"46888888888888888888"}),/sign in|登录/);
  await assert.rejects(mcp.call("list_player_feedback",{component_id:a.id,resource_id:"46123456789012345678"}),/未绑定|not bound/);checks++;
  await mcp.call("write_feedback_document",{component_id:a.id,path:"daily/46888888888888888888/2026-10-31.md",content:"# Second bound ID report"});
  await mcp.call("remove_workspace_binding",{component_id:a.id,resource_id:"46888888888888888888"});
  assert.equal((await mcp.call("read_feedback_document",{component_id:a.id,path:"daily/46888888888888888888/2026-10-31.md"})).content,"# Second bound ID report");
  await mcp.call("upsert_workspace_binding",{component_id:a.id,resource_ids:["46999999999999999999","46888888888888888888"]});checks++;

  await setTheme("light");
  await main.getByRole("button",{name:"反馈",exact:true}).click();
  await expect(main.locator(".workspace-item")).toHaveCount(2,{timeout:30000});
  await main.locator(".workspace-item").filter({hasText:a.name}).click();
  await expect(main.getByRole("button",{name:"日报/验证报告.md",exact:true})).toBeVisible();
  await expect(main.getByRole("button",{name:"关闭插件面板",exact:true})).toHaveCount(0);
  await expect(main.locator(".plugin-panel-workspace > .topbar")).toHaveCount(0);
  await expect(main.getByRole("heading",{name:"反馈文档",exact:true})).toHaveCount(1);
  await expect(main.getByRole("heading",{name:"反馈",exact:true})).toHaveCount(0);
  await expect(main.getByText("已绑定",{exact:true})).toHaveCount(0);
  await expect(main.locator(".workspace-item").filter({hasText:a.name}).locator(".status")).toHaveCount(0);
  const hostBounds=await main.locator(".plugin-panel-workspace").boundingBox();
  const toolbarBounds=await main.locator(".feedback-toolbar").boundingBox();
  assert.ok(Math.abs(toolbarBounds.y-hostBounds.y)<2);checks++;
  await expect(main.locator(".preview-pane,.preview-dialog,.markdown")).toHaveCount(0);checks++;
  await main.screenshot({path:path.join(output,"native-light-list.png")});
  await main.getByRole("button",{name:"日报/验证报告.md",exact:true}).click();
  await expect(main.getByRole("dialog",{name:"反馈文档预览",exact:true})).toBeVisible();checks++;
  await expect(main.getByRole("heading",{name:"玩家反馈优先级报告",exact:true})).toBeVisible({timeout:30000});
  await expect(main.locator(".markdown img,.markdown script")).toHaveCount(0);checks++;
  await expect(main.locator(".markdown blockquote")).toHaveCSS("border-left-color", await hostColor(main, "--accent"));checks++;
  await main.screenshot({path:path.join(output,"native-light.png")});
  await main.getByRole("button",{name:"关闭预览",exact:true}).click();
  await expect(main.getByRole("dialog",{name:"反馈文档预览",exact:true})).toHaveCount(0);
  await main.getByRole("button",{name:"帮助与 AI 提示词",exact:true}).click();
  await expect(main.getByRole("textbox",{name:"工作区绑定提示词",exact:true})).toHaveValue(/多个工作区/);
  await checkHelpColors(main);
  await main.screenshot({path:path.join(output,"native-help-binding.png")});
  await main.getByRole("tab",{name:"每日总结",exact:true}).click();
  await expect(main.getByRole("textbox",{name:"每日总结提示词",exact:true})).toHaveValue(HELP_PROMPTS[1].text);
  await main.screenshot({path:path.join(output,"native-help-daily.png")});checks++;
  await setTheme("dark");
  await expect(main.locator(".feedback-app")).toHaveAttribute("data-theme", "dark");
  await checkHelpColors(main);
  await main.screenshot({path:path.join(output,"native-help-daily-dark.png")});
  await main.getByRole("button",{name:"关闭帮助",exact:true}).click();
  await main.getByRole("button",{name:"反馈设置",exact:true}).click();
  await expect(main.getByRole("textbox",{name:"模组 46 ID"})).toHaveValue("46999999999999999999\n46888888888888888888");
  await main.getByRole("textbox",{name:"模组 46 ID"}).fill("46999999999999999999\n46888888888888888888\n46777777777777777777");
  await main.getByRole("button",{name:"保存绑定",exact:true}).click();
  await expect.poll(async()=>(await mcp.call("list_workspaces")).items.find(item=>item.component_id===a.id).binding.resource_ids.length).toBe(3);
  await main.getByRole("textbox",{name:"模组 46 ID"}).fill("46999999999999999999\n46888888888888888888");
  await main.getByRole("button",{name:"保存绑定",exact:true}).click();
  await expect.poll(async()=>(await mcp.call("list_workspaces")).items.find(item=>item.component_id===a.id).binding.resource_ids.length).toBe(2);
  await expect(main.getByRole("button",{name:"保存绑定",exact:true})).toBeEnabled();
  await expect(main.getByRole("textbox",{name:"模组 46 ID"})).toBeEditable();
  await main.getByRole("heading",{name:"反馈设置",exact:true}).hover();checks++;
  await expect(main.getByRole("button",{name:"保存绑定",exact:true})).toHaveCSS("background-color", await hostColor(main, "--accent"));
  await expect(main.getByRole("button",{name:"保存绑定",exact:true})).toHaveCSS("color", await hostColor(main, "--accent-contrast"));checks++;
  await main.screenshot({path:path.join(output,"native-settings-dark.png")});
  await setTheme("light");
  await expect(main.getByRole("button",{name:"保存绑定",exact:true})).toHaveCSS("background-color", await hostColor(main, "--accent"));checks++;
  await main.screenshot({path:path.join(output,"native-settings.png")});
  await main.getByRole("button",{name:"关闭反馈设置"}).click();
  await main.getByRole("button",{name:"在独立窗口打开",exact:true}).click();
  let standalone;
  await expect.poll(async()=>{for(const page of context.pages()){if(page===main)continue;const label=await page.evaluate(()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(()=>"");if(label.startsWith("dialog-plugin-")){standalone=page;return true}}return false},{timeout:20000}).toBe(true);
  await expect(standalone.locator(".workspace-item")).toHaveCount(2,{timeout:30000});
  await expect(standalone.getByRole("button",{name:"关闭插件面板",exact:true})).toHaveCount(0);
  await expect(standalone.getByRole("button",{name:"在独立窗口打开",exact:true})).toHaveCount(0);
  await expect(standalone.getByText("已绑定",{exact:true})).toHaveCount(0);checks++;
  await standalone.locator(".workspace-item").filter({hasText:a.name}).click();
  await standalone.getByRole("button",{name:"日报/验证报告.md",exact:true}).click();
  await expect(standalone.getByRole("heading",{name:"玩家反馈优先级报告",exact:true})).toBeVisible();
  await setTheme("dark");
  await expect(standalone.locator(".feedback-app")).toHaveAttribute("data-theme","dark");
  await expect(standalone.locator(".markdown blockquote")).toHaveCSS("border-left-color", await hostColor(standalone, "--accent"));checks++;
  await main.screenshot({path:path.join(output,"native-dark-list.png")});
  await standalone.screenshot({path:path.join(output,"native-independent-dark.png")});checks++;
  await standalone.getByRole("button",{name:"关闭预览",exact:true}).click();
  await standalone.screenshot({path:path.join(output,"native-independent-dark-list.png")});
  await standalone.getByRole("button",{name:"帮助与 AI 提示词",exact:true}).click();
  await checkHelpColors(standalone);
  await standalone.screenshot({path:path.join(output,"native-independent-help-dark.png")});
  await standalone.getByRole("button",{name:"关闭帮助",exact:true}).click();
  await standalone.evaluate(()=>window.__TAURI_INTERNALS__.invoke("plugin:window|close",{label:window.__TAURI_INTERNALS__.metadata.currentWindow.label})).catch(error=>{if(!/closed/i.test(error.message))throw error;});
  await expect.poll(()=>standalone.isClosed()).toBe(true);
  await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke("plugin:window|close",{label:"main"})).catch(error=>{if(!/closed/i.test(error.message))throw error;});
  await expect.poll(()=>child.exitCode,{timeout:15000}).not.toBeNull();
  const afterClose=await mcp.call("read_feedback_document",{component_id:a.id,path:"日报/验证报告.md"});assert.equal(afterClose.content,report);checks++;
  await mcp.call("remove_workspace_binding",{component_id:b.id});
  assert.equal((await mcp.call("list_workspaces")).items.find(item=>item.component_id===b.id).binding,null);checks++;
  assert.equal((await readdir(path.join(data,"plugins","data","blockecho.feedback","ipc"))).filter(name=>name.endsWith(".json")).length,0);checks++;
  assert.deepEqual(errors,[]);
  await writeFile(path.join(data,"result.json"),JSON.stringify({passed:true,checks,errors,liveNetEaseTested:false},null,2));
  console.log(`Native WebView2 + independent MCP QA passed (${checks} checks): ${data}`);
}catch(error){
  if(main&&!main.isClosed())await main.screenshot({path:path.join(output,"failure.png")}).catch(()=>{});
  throw error;
}finally{
  await mcp?.close();
  if(child.exitCode===null&&main&&!main.isClosed())await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke("plugin:window|close",{label:"main"})).catch(()=>{});
  await browser?.close().catch(()=>{});
  if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once("exit",resolve));}
  await writeFile(path.join(data,"host.log"),logs);
}
