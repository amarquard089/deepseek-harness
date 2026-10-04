# Official DeepSeek LLM API wire extensions

English | [中文](deepseek-llm-api-wire-extensions.zh.md)

This reference defines the Harness-specific HTTP headers sent by [`@deepseek-ai/dsh-llm-deepseek`](../packages/llm/llm-deepseek/README.md) on official Messages requests. Shipped profiles do not add Session logs, plugin inventories, analytics, or telemetry fields to request bodies.

## Request headers

| Header | Presence | Value |
|---|---|---|
| `user-agent` | Every provider HTTP request, including Files API operations | Application identity in `product/version (+url)` form |
| `x-deepseek-harness-user-id` | Every authorized model request | Stable anonymous identifier for the resolved Harness home |
| `x-deepseek-harness-session-id` | Model requests carrying a Session id | Exact request `sessionId` |
| `x-deepseek-harness-compact` | Model requests whose purpose is `compaction` | Literal string `1` |

Credential failure happens before anonymous-user-id resolution, so an unauthorized request neither sends these headers nor creates the identity file. A direct request without a Session omits `x-deepseek-harness-session-id`.

## Request-body extensions

The [`DeepSeekLlmApiExtensionRegistry`](../packages/llm/deepseek-llm-api-extensions/README.md) remains available for explicitly composed provider metadata. A deployment must register each field through the registry; the base, Web, Desktop, SDK, and ACP profiles register no Session-log or package-inventory fields.

The adapter prepares registered fields from the exact serialized base body before HTTP dispatch. Preparation or field-collision failure prevents the request. After HTTP 2xx, captured acceptance callbacks run before the SSE body is consumed. A composition without the registry sends the unextended base body.
