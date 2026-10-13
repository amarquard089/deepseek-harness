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

Prepared JSON values are detached from provider-owned state, merged as top-level siblings of the base fields, and serialized in the same HTTP body. A contributor whose preparation fails is omitted from that request, with only its first failure logged, while the other fields are still sent; a field that collides with a base field prevents the request. If the merged body fails to serialize, the adapter sends the base body without any extension field, skips the acceptance transaction so contributors resend their state on a later request, and logs the omitted field names. A composition without the registry sends the unextended base body.

After the configured endpoint returns HTTP 2xx, the adapter runs the prepared `accept()` transaction before reading the SSE response body. Transport failures and non-2xx responses do not accept any contribution. An acceptance failure is logged and does not fail the model request; the contributor resends its unaccepted state on a later request. Acceptance records endpoint-level HTTP success; it does not assert that an SSE stream completed or that the endpoint persisted an extension.

## Exposure and receiver requirements

The request headers expose the Harness application version, one anonymous Harness-home identity, and an optional Session identity. A gateway selected through `baseURL` receives the same values as the official endpoint; with no registered contribution, no body extension field is sent.

Receivers address extension fields by name, dispatch each field by its own `version`, and ignore JSON member ordering. The base request remains usable without either the registry or a particular contribution; field absence means that contribution did not apply to that request.
