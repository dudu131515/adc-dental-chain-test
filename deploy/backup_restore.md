# ADC 合成环境备份与恢复

适用于 FR-003、FR-004、FR-007、FR-210、FR-408 与 AC-X-10。恢复使用独立的空业务库和技术库，应用与原环境隔离。

1. 暂停模拟资金派发并停止本次备份点前的业务写入。记录备份时间、排班及预约编号、原预约金、主单与原收款、审批、季度确认版及未终结资金义务的业务编号。
2. 以初始化账号分别备份业务库与技术库，在新的隔离库恢复并按 [部署说明](README.md) 重建运行权限。连接串通过当前环境提供。

```sh
pg_dump --format=custom --file=adc-business.dump "$ADC_BACKUP_BUSINESS_DSN"
pg_dump --format=custom --file=adc-runtime.dump "$ADC_BACKUP_RUNTIME_DSN"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$ADC_RECOVERY_BUSINESS_DSN" adc-business.dump
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$ADC_RECOVERY_RUNTIME_DSN" adc-runtime.dump
```

3. 恢复实例保持 `ADC_SIMULATION_PAUSED=1`。换用恢复环境密钥，清除恢复库内的既有会话和报告快照，使体验账号重新登录。
4. 比较备份点的业务编号和状态，逐笔核对备份点后的回执。资金凭证需要同时匹配义务、来源、金额及最终结果。已知成功且恢复库缺少整笔义务时，保留差异记录，依原授权和已验证业务事实核对。恢复库已有待办义务且原结果仍未终结时，保留原业务键和绑定对象。
5. 核对完成后，恢复授权人员逐笔指定已核对的义务类型和 ID， `python backend/manage.py replay_simulated_funds --obligation deposit:123`。多笔用重复的 --obligation，类型为 deposit、deposit_refund、invoice_payment 或 invoice_refund。恢复场景只传已确认可以补跑的原义务。复核两次执行的终态及原款关联，并保留差异与处置记录。

恢复演练见 [AC-X-10 记录](../docs/verification/adc-recovery.md)。
