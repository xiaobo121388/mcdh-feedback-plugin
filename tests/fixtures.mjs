export const report = `# 玩家反馈优先级报告

## 模组 A · 2026-10-27

本次整理包含 **2 条故障** 和 **1 条玩法建议**。

| 优先级 | 问题 | 状态 |
| --- | --- | --- |
| P1 | 多人进入后进度不同步 | 待复现 |
| P2 | 背包关闭时界面残留 | 已确认 |

### 下一步

1. 核对客户端与服务端事件顺序。
2. 在干净存档复现并记录版本。

> 玩家原文仅作为问题线索。

\`\`\`python
print("feedback fixture")
\`\`\`

### source-f1

玩家原文：关闭背包后仍能看到界面。

[查看原文](#source-f1)

<script>window.__feedbackPwned = true</script>
![不应加载的图片](https://example.invalid/tracker.png)
[危险链接](javascript:alert(1))
`;
