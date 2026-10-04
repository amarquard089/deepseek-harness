# Official DeepSeek LLM API wire extensions

[English](deepseek-llm-api-wire-extensions.md) | 中文

本参考定义 [`@deepseek-ai/dsh-llm-deepseek`](../packages/llm/llm-deepseek/README.zh.md) 在 official Messages 请求中发送的 Harness 专用 HTTP 请求头。随附组合不会在请求体中添加会话日志、插件清单、分析或遥测字段。

## 请求头

| 请求头 | 出现条件 | 值 |
|---|---|---|
| `user-agent` | 每个提供方 HTTP 请求，包括 Files API 操作 | `product/version (+url)` 格式的应用身份 |
| `x-deepseek-harness-user-id` | 每个已授权的模型请求 | 解析后的 Harness home 的稳定匿名标识 |
| `x-deepseek-harness-session-id` | 携带 Session id 的模型请求 | 请求的确切 `sessionId` |
| `x-deepseek-harness-compact` | `purpose` 为 `compaction` 的模型请求 | 字面量 `1` |

凭据失败发生在 anonymous-user-id 解析之前，因此未授权请求既不会发送这些请求头，也不会创建身份文件。不带 Session 的直接请求会省略 `x-deepseek-harness-session-id`。

## 请求体扩展

[`DeepSeekLlmApiExtensionRegistry`](../packages/llm/deepseek-llm-api-extensions/README.zh.md) 仍可用于明确组合的提供方元数据。部署必须通过注册表注册每个字段；base、Web、Desktop、SDK 与 ACP 组合都不会注册会话日志或插件清单字段。

适配器会在 HTTP 分发前根据确切序列化的基础请求体准备已注册字段。准备或字段冲突失败会阻止请求。HTTP 2xx 后，已捕获的接受回调会在消费 SSE 请求体前运行。没有注册表的组合会发送未扩展的基础请求体。
