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

准备好的 JSON 值与提供方自有状态分离，作为基础字段的顶层同级成员合并，并在同一个 HTTP 请求体中序列化。准备失败的贡献方会从该请求中省略，只记录其首次失败，其余字段仍然发送；与基础字段冲突的字段会阻止请求。合并后的请求体序列化失败时，适配器只发送不带任何扩展字段的基础请求体，跳过接受事务以便贡献方在之后的请求中重发自身状态，并记录被省略的字段名。没有注册表的组合会发送未扩展的基础请求体。

配置的端点返回 HTTP 2xx 后，适配器会在读取 SSE 响应体前运行已准备好的 `accept()` 事务。传输失败与非 2xx 响应不会接受任何贡献。接受失败会记录日志，但不会让模型请求失败；贡献方会在之后的请求中重发未被接受的状态。接受只记录端点层面的 HTTP 成功，并不表明 SSE 流已完成，也不表明端点已持久化该扩展。

## 暴露范围与接收方要求

请求头会暴露 Harness 应用版本、一个匿名 Harness home 身份，以及可选的 Session 身份。通过 `baseURL` 选择的网关会收到与官方端点相同的值；未注册任何贡献时，不会发送任何请求体扩展字段。

接收方按名称识别扩展字段，按各字段自身的 `version` 分派，并忽略 JSON 成员顺序。即使没有注册表或某个具体贡献，基础请求仍然可用；字段缺失表示该贡献不适用于该请求。
