import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_PROMPTS } from "../prompts.js";

test("binding prompt confirms ambiguous and missing workspaces before writes", () => {
  assert.equal(HELP_PROMPTS.length, 2);
  const text = HELP_PROMPTS.find(item => item.id === "binding").text;
  for (const term of ["list_developer_components", "next_cursor", "list_workspaces", "component_id", "upsert_workspace_binding", "多个工作区", "找不到", "在我确认前", ".code-workspace", "完整字符串", "可写范围"]) assert.ok(text.includes(term), term);
  for (const term of ["同时绑定多个 46 ID", "resource_ids", "追加单个", "替换完整列表", "省略 feedback_directory"]) assert.ok(text.includes(term), term);
});

test("daily prompt runs unattended in the agent's schedule over one rolling 24-hour window", () => {
  const text = HELP_PROMPTS.find(item => item.id === "daily").text;
  for (const term of ["无需向用户确认", "每天执行一次", "Agent 已保存的设置", "不另行创建或修改定时任务", "实际执行开始时间", "86400 秒", "[start_date, end_date)", "共用同一个窗口", "不是上一个自然日"]) assert.ok(text.includes(term), term);
  for (const term of ["先完成调度确认", "先与我确认", "先确认/", "下一次执行时间", "昨日 00:00"]) assert.ok(!text.includes(term), term);
});

test("daily prompt inventories all components without guessing bindings or hiding gaps", () => {
  const text = HELP_PROMPTS.find(item => item.id === "daily").text;
  for (const term of ["list_developer_components", "全部 PE/PC", "next_cursor", "list_workspaces", "完整字符串", "不调用绑定增删工具", "未覆盖原因", "directory_missing", "PC-only", "相同完整 ID 与实际反馈目录"]) assert.ok(text.includes(term), term);
  for (const term of ["binding.resource_ids", "不能只取第一个", "明确的 resource_id", "逐 ID 分页"]) assert.ok(text.includes(term), term);
});

test("daily prompt keeps actionable feedback and every useful original with traceable priorities", () => {
  const text = HELP_PROMPTS.find(item => item.id === "daily").text;
  for (const term of ["功能失效", "数据损坏", "具体功能建议", "纯评分", "表情", "刷屏", "广告", "被剔除内容不进入正文或原文附录", "负面不等于有用", "每一条有效原文", "不以代表性样本替代全部原文", "P0 紧急", "P3 低", "source-f001", "source-c001", "双向对应", "隐私脱敏"]) assert.ok(text.includes(term), term);
});

test("daily prompt requires complete reads, bounded writes and truthful completion", () => {
  const text = HELP_PROMPTS.find(item => item.id === "daily").text;
  for (const term of ["list_player_comments", "list_player_feedback", "items=[]", "next_offset", "数据不完整", "最多重试 2 次", "daily/<resource_id>/YYYY-MM-DD.md", "expected_revision", "64 KiB", "128 KiB", "next_offset=null", "不执行", "不删除旧报告"]) assert.ok(text.includes(term), term);
  assert.ok(!text.includes("明文密码"));
});
