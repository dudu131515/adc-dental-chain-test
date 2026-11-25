# ADC 合成环境性能基线

2026-11-23 · PostgreSQL 17.11 · Windows 隔离测试实例 · 两家合成门店 · AC-X-09。

| 操作 | 条件 | 一次实测 |
| --- | --- | --- |
| 候选查询 | 一店两个已发布牙医班次、一把椅，查询同一半小时。第二家店的资源不参与。 | 26.6 毫秒，查询返回两个医生选项。 |
| 并发争用最后一把椅 | 两名合成患者及不同牙医，两个独立 PostgreSQL 连接。本店资源锁先由测试控制连接持有。 | 用时 17.7 毫秒观察到两种锁等待事件 `tuple`、`transactionid`。释放锁后一次占位成功（70.2 毫秒），另一次资源冲突（108.0 毫秒）。数据库只有一条活动占位。 |
| 季度版本复核 | 三笔实际接诊贡献。核对并依序复核原版和两笔获批调整。 | 各次约 14.0、13.6、12.9 毫秒。正式基金按顺序为 27、15、20 元。 |

测试入口为 `tests.integration.test_booking_transactions.FinalChairConcurrencyTests` 与 `tests.contract.test_performance.PerformanceContractTests`。记录一次实测耗时及锁等待事件，按数据一致性和授权结果验收。
