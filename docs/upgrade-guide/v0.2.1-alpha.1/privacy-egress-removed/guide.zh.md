---
kind: upgrade-guide
description: "随附组合不再上传会话日志、产品分析或插件清单元数据。"
---

# 移除隐私外发

[English](guide.md) | 中文

## 变更

随附组合不再在 DeepSeek 请求中上传会话日志或插件清单元数据。桌面产品分析与 OpenTelemetry 采集包已移除。`DSH_TELEMETRY_*` 与 `DSH_PRODUCT_ANALYTICS_OTLP_URL` 设置不再生效。

## 迁移

1. 从自定义 `cordis.yml` 或 patch 文件中移除 `session-log-deepseek`、`plugin-package-inventory-deepseek`、产品分析和遥测行。
2. 从启动环境中移除 `DSH_TELEMETRY_*` 与 `DSH_PRODUCT_ANALYTICS_OTLP_URL`。
3. 从自定义 workspace 组合中移除对已删除包的依赖。
4. 启动新的 profile 并检查首个提供方请求。请求不得包含 `dsh_session_log` 或 `dsh_plugin_packages`。
