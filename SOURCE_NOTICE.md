# 源码与许可说明

本仓库整理自同一作者维护的反馈工具中的 `mcdh-plugin/`。`helper/src/netease/` 保留了原工具 `src-tauri/src/` 下的 `api.rs`、`api/developer_components.rs`、`crypto.rs`、`error.rs` 和 `models.rs`，使插件无需引用仓库外的源码即可构建。

本次拆分仅调整目录、构建及测试依赖；网易客户端实现没有因此改变。未包含旧查看器、网页服务、部署脚本、账户、Cookie、用户绑定或反馈数据。

保留原项目的许可声明：本仓库公开源代码供审阅，但当前没有主动授予复制、修改或再分发许可证。需要开放源代码许可或商业分发时，应另行确认网易平台条款、参考项目许可、第三方依赖许可证、源码发布义务及平台签名要求。本次仓库整理不构成重新授权。

第三方依赖不适用上述项目源码声明，仍遵循各自许可证。构建产物包含 `THIRD_PARTY_NOTICES.md`、`HELPER_THIRD_PARTY_NOTICES.md`、`DEPENDENCY_LICENSES.txt` 和 `dependency-licenses.json`。
