---
description: "按 harness home 划分的匿名身份，供本地功能或组合关联自身记录。"
kind: "package-library"
---

# @deepseek-ai/dsh-anonymous-user-id

[English](README.md) | 中文

## 概述

DeepSeek Harness 为每个 harness home 提供一个匿名标识符，供需要关联自身记录又不识别用户身份的本地功能或组合使用。该随机 UUID 存储在 `$DSH_HOME/.anonymous-user-id`（`$DSH_HOME` 默认为 `~/.dsh`）中，可跨重启保留，并在你删除文件后重新生成。不同 harness home 使用不同的标识符，且该值不包含机器或账户数据。包消费方可复用同一个值进行安装范围的关联，但无法跨 home 关联记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

DeepSeek Harness 为每个 harness home 提供一个匿名 id，本包负责生成并保存它。无需安装或配置任何东西：首次使用时 id 即会出现。不要用它来识别用户，也不要用它关联不同 home 之间的记录；它是匿名的且限定于单个 home。

### 该 id 能为你做什么

该 id 是限定于单个 home、且只留在本机的关联值。没有任何随附功能会把它附加到外发请求、导出或确认文本中：本次构建不记录会话遥测，提供方请求也不携带用户 id 标头。需要共享安装 id 的组合直接读取该值即可。

### 查看与重置 id

该 id 存放在 `$DSH_HOME/.anonymous-user-id`（`$DSH_HOME` 默认为 `~/.dsh`）中，是一个纯 UUID 文本文件。删除该文件即可在下次启动时获得全新 id；正在运行的进程在退出前会一直保留当前 id。不同 harness home 各自保留独立 id，值中永远不会包含任何机器或账户信息。

### 在自己的包中使用

当你构建的功能需要该安装的匿名 id 时，导入一次并复用该值即可：

```ts
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'

const userId = getOrCreateAnonymousUserId() // stable for the process lifetime
```

该值在进程内保持稳定；只有当文件被删除、后续启动生成替代值时才会改变。即使 home 目录不可写，该值在本次运行中依然可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释本包背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **随机生成，绝不派生。** id 来自 `crypto.randomUUID()`；绝不从 hostname、网络地址、git remote 或任何其他可识别来源派生，因此匿名性是生成过程的属性。
- **同步且记忆化。** 一个进程对每个解析后的文件路径只触碰一次磁盘：读写都是同步的，结果按解析后的文件路径记忆化。
- **Best-effort 持久化。** 写入失败仍会为本次运行返回可用 id，消费方因此不会因 home 不可写而阻塞。
- **库而非插件。** 没有 Cordis 插件入口或配置。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 库入口：`getOrCreateAnonymousUserId`、文件持久化、按路径记忆化 |
| [`tests/anonymous-user-id.spec.ts`](tests/anonymous-user-id.spec.ts) | 测试覆盖的行为：生成、持久化、损坏、并发、记忆化 |

### API

本包暴露一个函数，返回该安装的匿名 id，并在首次使用时生成并持久化；确切的签名、选项与默认值见 `src/index.ts`。

### 存储约定

文件是名为 `ANONYMOUS_USER_ID_FILE_NAME` 的裸 UUID 行，读取时按 UUID 模式校验。首个写入方使用独占创建（`wx`）；并发落败方重新读取并采用胜出方的值。遇到损坏或不可读的文件时，系统会转而生成新值并覆盖该文件。记忆化按解析后的文件路径为键，因此不同 home 永远不会共享 id。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 identity 组映射逐步进入本包所依赖的 home 路径解析。

- [identity 组映射](../README.zh.md)——兄弟包与组范围。
- [dsh-home-paths](../../util/home-paths/README.zh.md)——负责 `$DSH_HOME` 与 `~/.dsh` 的解析。
- [dsh-llm-deepseek](../../llm/llm-deepseek/README.zh.md)——保留一个可选的旧版 `x-deepseek-harness-user-id` 钩子，随附宿主均不提供它。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该标识符只留在本地 home 中，且不注册任何面向模型的内容。

#### KV Cache 影响

无；没有任何模型请求会携带该标识符。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 id 何时不合适或需要特别注意。它们是当前包约束，不是匿名性方案的通用对比，也不是任务积压。

- **删除后无法恢复**——文件丢失后会按设计生成新的匿名身份；恢复需要稳定的派生材料，这会削弱匿名性。
- **Best-effort 并发**——如果读取方恰好落在并发进程完成独占创建但尚未写完的狭窄时间窗内，本次运行可能使用不同的内存 UUID；后续启动会收敛到已持久化的值。
- **没有跨 home 身份**——不同 `$DSH_HOME` 值之间无法关联。
- **删除文件不会重置当前进程**——记忆化会让本次运行的 id 一直保留到下次启动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和包代码为准，结论一旦稳定就迁移到对应归属。

#### 开放：文件格式演进

持久化约定是没有任何版本标记的裸 UUID 行。在 id 旁边增加第二个值，或用容器包裹该行，对现有文件都没有迁移方案；带版本的行格式是让此类变更安全的一种方式。

</details>
