# 任务 09 · 真实 DeepSeek 联调记录

日期：2026-11-27

## 专用合成环境

- 业务库：`adc_workspace_preview_ai10`，运行库：`adc_workspace_preview_ai10_rt`（本机 PostgreSQL 55467）。
- 独立后端端口：8001，使用合成患者、门店、预约、主单、耗材和费用数据。
- 模型：`deepseek-flash`，接口 `https://api.deepseek.com/chat/completions`。
- 保护条件全部满足：`ADC_ASSISTANT_DEEPSEEK_ENABLED=1`、`ADC_ASSISTANT_SYNTHETIC_ENV=local`、合成主机/端口/库名与业务库一致。
- API Key 只从服务端私有环境注入，未写入仓库、演示前端或截图。

## 实际模型请求

问题：`近期收入与成本发生了什么变化`

结果：

```text
metric: business_change
mode: deepseek
model_status: completed
工具: compare_reports
模型调用: 2 次
prompt_tokens: 1383
completion_tokens: 65
```

模型选择并返回的观察：

- 本期营业收入 ¥26,250.00，诊疗成本 ¥11,059.50，经营费用 ¥4,636.98，净利润 ¥10,553.52。
- 与对比期相比：营业收入 +¥22,190.00，诊疗成本 +¥9,393.00，经营费用 ¥0.00，净利润 +¥12,797.00。
- 收入增长若伴随成本或费用上升，需要结合耗材与经营费用明细核对利润质量。

## 门店对比

问题：`哪家诊所经营表现更好`

```text
metric: net_profit
mode: deepseek
model_status: completed
```

模型返回：中心口腔门诊 ¥5,555.82 最高，滨江口腔门诊 ¥4,997.70 最低；净利润合计 ¥10,553.52。

## 来源回查

使用分析结果中的 period reference 调用 `/reports/operations/assistant/report`，返回同一快照：

```text
scope: 1,2
revenue: 26250.00
material_cost: 11059.50
operating_cost: 4636.98
net_profit: 10553.52
snapshot_refreshed: false
```

与助手引用的数字一致，未出现重新查询导致的口径漂移。

## 故障降级

另起后端 8002，保持同一合成库和模型开关，但注入无效 API Key：

```text
metric: business_change
mode: template
model_status: unavailable
```

返回完整的模板经营解读、两期对比、门店范围和来源条款，页面仍可查看原报表。模型调用 1 次、0 token，失败不会影响经营事实与回查。

## 兼容性修正

联调中发现并修正：

- DeepSeek 在可见多个工具时会返回并行工具调用；首轮只暴露必需的汇总/报表工具，后续轮次改为回答模式。
- 工具返回的 observations/questions/sources 使用带 id 的对象数组，避免模型把来源 ID 误当观察 ID。
- 对比工具数据中的 Decimal 统一序列化，避免经营金额导致工具消息序列化失败。

这些修正保留原有权限、快照、幂等、来源回查和模板降级逻辑。
