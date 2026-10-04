---
kind: upgrade-guide
description: "Shipped profiles no longer upload Session logs, product analytics, or plugin inventory metadata."
---

# Privacy egress removal

English | [中文](guide.zh.md)

## Change

Shipped profiles no longer upload Session logs or plugin inventory metadata with DeepSeek requests. Desktop product analytics and OpenTelemetry collection packages are removed. The `DSH_TELEMETRY_*` and `DSH_PRODUCT_ANALYTICS_OTLP_URL` settings no longer have an effect.

## Migration

1. Remove `session-log-deepseek`, `plugin-package-inventory-deepseek`, product analytics, and telemetry rows from custom `cordis.yml` or patch files.
2. Remove `DSH_TELEMETRY_*` and `DSH_PRODUCT_ANALYTICS_OTLP_URL` from launch environments.
3. Remove dependencies on the deleted packages from custom workspace compositions.
4. Start a new profile and inspect the first provider request. It must contain neither `dsh_session_log` nor `dsh_plugin_packages`.
