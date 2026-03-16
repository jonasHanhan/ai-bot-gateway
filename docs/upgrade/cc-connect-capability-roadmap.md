# Agent Bot Gateway 升级路线（参考 cc-connect）

目标：在不影响现网运行的前提下，逐步增强 `agent-bot-gateway` 的可扩展性（平台 / Agent 能力），同时保持现有 turn 与审批链路稳定。

更新时间：2026-03-16

## 原则

1. **不动现网目录**：所有改造先在 `agent-bot-gateway-upgrade` 完成。
2. **不改主链路语义**：turn、approval、recovery 行为保持兼容。
3. **增量抽象**：优先增加抽象层，不做一次性重构。
4. **灰度上线**：每一阶段都先小流量验证。

## 分阶段计划

### Phase 1（当前）— 抽象基建（低风险）

- [x] 新增 `src/agents/agentRegistry.ts`：统一 Agent 元数据与 capability 查询。
- [x] 新增基础测试 `test/agentRegistry.test.ts`。
- [x] 补充 capability matrix 文档（平台 × Agent）。

### Phase 2 — 接口收敛（中风险）

- [ ] 统一 `PlatformAdapter` / `AgentAdapter` 的最小接口。
- [ ] 将现有 Codex 调用点包裹为 `CodexAgentAdapter`。
- [ ] 在 runtime 中注入 registry，默认行为与当前一致。

### Phase 3 — 能力扩展（中高风险）

- [ ] 新增一个实验性 Agent（开关控制，默认关闭）。
- [ ] 新增一个实验性平台入口（仅测试路由）。
- [ ] 加入能力协商（如：是否支持图片输入、是否支持交互审批）。

### Phase 4 — 运维增强（低风险）

- [x] CLI 增加 `capabilities` 命令，输出平台/Agent能力表。
- [x] 增加健康检查细项（adapter 注册完整性、默认 agent 有效性）。

## 当前实现状态（对齐整改代码）

### 已落地

- Agent 抽象：`src/agents/agentRegistry.ts`
  - 支持 `listAgents` / `listEnabledAgents` / `getAgent`
  - 支持 `getCapabilities` / `agentSupports` / `anyAgentSupports`
  - 支持 `getDefaultAgentId`
- Setup 解析：`src/agents/setupResolution.js`
  - 统一解析 `agentId + model`（channel override > defaultAgent > defaultModel）
  - 统一能力查询入口 `setupSupportsCapability(...)`
- Platform 抽象：
  - `src/platforms/platformRegistry.js`
  - `src/platforms/discordPlatform.js`
  - `src/platforms/feishuPlatform.js`
- 命令面：`!agents` 已支持展示 agent 状态（enabled/model/image capability）

### 待完成（下一步）

- 将 “平台能力 + Agent 能力” 的协商结果显式落到统一 adapter 接口（Phase 2）。
- 增加 capability 视图命令（CLI 侧），避免仅通过 `!agents` 人工查看（Phase 4）。

## Capability Matrix（平台 × Agent）

说明：

- 平台能力来自 `src/platforms/*Platform.js` 的静态 capabilities。
- Agent 能力来自 `channels.json > agents.<agentId>.capabilities`（动态配置）。
- 运行时执行时，需同时满足：**平台支持 + 当前 agent 支持**。

### 平台能力矩阵

| capability | discord | feishu | 备注 |
| --- | --- | --- | --- |
| `supportsPlainMessages` | ✅ | ✅ | 两端均可发送文本 |
| `supportsSlashCommands` | ✅ | ❌ | Feishu 当前无 slash 命令面 |
| `supportsButtons` | ✅ | ❌ | 审批交互在 Feishu 走文本回落 |
| `supportsAttachments` | ✅ | ❌ | Feishu 目前不走附件解析链路 |
| `supportsRepoBootstrap` | ✅ | ❌ | repo channel 自动引导仅 Discord |
| `supportsAutoDiscovery` | ✅ | ❌ | `!route` 自动发现仅 Discord |
| `supportsWebhookIngress` | ❌ | ⚠️ 条件支持 | Feishu 在 webhook transport 下启用 |

### Agent 能力矩阵（配置驱动）

| capability | 默认值 | 来源 | 当前使用点 |
| --- | --- | --- | --- |
| `supportsImageInput` | `true`（fallback） | `channels.json > agents.*.capabilities.supportsImageInput` | `src/app/discordRuntime.js`、`src/feishu/runtime.js` |

补充：

- 若 agent 未显式声明某项 capability，则走 `setupSupportsCapability(..., fallback)`。
- 当前 `supportsImageInput` fallback 为 `true`，保证向后兼容历史行为。

## 阶段验收门槛（可执行）

### Phase 1 -> Phase 2

- [x] `agentRegistry` 已接入并有单测覆盖。
- [x] 平台能力已结构化并可查询（platform registry）。
- [x] 文档化 capability matrix 并与代码一致。
- [x] 全量测试通过（基线：`bun test`）。

### Phase 2 -> Phase 3

- [ ] Adapter 最小接口冻结（含兼容说明）。
- [ ] runtime 仅依赖 adapter/registry，不直接分支平台实现。
- [ ] 新旧路径并行开关可灰度切换。

### Phase 3 -> Phase 4

- [ ] 至少 1 个实验 Agent 接入并可回滚。
- [ ] 至少 1 个实验平台入口接入并可回滚。
- [ ] 能力协商失败路径具备可观测日志与回退策略。

## 验收标准

- 现有 Discord/Feishu 主流程回归通过。
- 现有 `bun test` 通过。
- 无新增 P0/P1 运行故障。
- 关键链路日志可定位（route、thread、agentId、platformId）。

## 回滚策略

- 每阶段独立提交，可直接回退单个阶段。
- 所有新能力均由 feature flag 控制，异常时可一键关闭。
