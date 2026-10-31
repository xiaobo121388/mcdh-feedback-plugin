# 第三方与参考说明

## 参考项目

- MCDevManager：<https://github.com/BitterLemonn/MCDevManager>
- 版权所有：BitterLemon，2024–2026
- 许可证：BitterLemon Noncommercial Copyleft License 1.0（BNCL-1.0）
- 使用方式：仅参考公开产品范围和网易接口行为；本项目没有复制其 Kotlin 源码、界面或品牌素材。

## 随包依赖

- markdown-it 14.1.0：MIT，用于只读 Markdown 预览。
- Lucide 0.468.0：ISC，用于插件界面图标。
- reqwest、tokio、serde、RustCrypto、keyring-rs 等 Rust 依赖：保留各自的上游许可证声明与文本。

完整、精确的依赖版本以 `Cargo.lock` 和 `package-lock.json` 为准。`scripts/licenses.mjs` 在构建时遍历 Windows x64 辅助程序的非开发依赖及前端运行依赖，将上游许可证文本保存到 `DEPENDENCY_LICENSES.txt`，索引保存到 `dependency-licenses.json`。

## 开发依赖

esbuild（MIT）和 Playwright（Apache-2.0）仅用于构建与验证，其程序本身不随插件 ZIP 分发。MCDH 宿主独立安装，不包含在插件产物中。此独立仓库不包含原反馈工具的 Tauri 查看器和网页服务。
