# ADC B 方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 打通员工待办提醒、授权管理、日结核对、患者账单和可演示的经营分析。

**Architecture:** 维持 Django 业务服务及 PostgreSQL 同源 DDL，React 网站按业务分组路由，微信原生小程序读取本人费用。智能分析复用经营汇总和快照，服务端限制数据范围并负责 DeepSeek 调用。

**Tech Stack:** Python 3.12、Django 5.2、DRF、PostgreSQL 17、React、TypeScript、微信 WXML/WXSS、DeepSeek 工具调用。

**Spec:** [已确认设计](../specs/2026-11-25-adc-operations-and-assistant-design.md) · [统一系统规约](../../../specs/001-adc-system/spec.md)

## 统一约束

- 一个员工网站和一个微信原生小程序。现有预约、诊疗和支付状态继续按母本核算。
- 工作台仅在已有合适入口旁显示红点。保留读屏可感知的提示，页面只显示小红点，现有入口继续负责办理。
- 用户选择的经营问题可编辑并显式提交。 DeepSeek 数据入参仅包含本地许可的结构化意图、合成汇总和已确认的知识条款。
- 界面及 API 同时验证角色、门店与患者所有权。 新功能在受限运行数据库角色下验收。

## 审查重点

- 两种岗位同时登录和授权撤销后的遗留提示。T069、T070。
- 已失效会话尝试使用缓存分析和本店日结。T070、T071、T073。
- 跨店改约和跨日迟到回执的现金流归属。T071。
- 其他患者访问已开立主单或同一支付记录。T072。
- 零分母与未配置模型，及用户自由输入包含个人信息时的处理。T073。

## T069 工作台红点与导航

**文件** `web/src/shared/navigation.ts`、`AppShell.tsx`、`theme.css`、`web/src/main.tsx`、`web/src/features/dashboard/DashboardPage.tsx`、`backend/adc/identity/workbench_api.py` 和相应测试。

- [x] 先验证只有有权入口出现红点，可在键盘、窄屏和历史直达时到达相同业务视图。
- [x] 添加 `GET /workbench/alerts?clinic_id=`，返回 `billing`、`clinical`、`schedule`、`corrections` 等布尔状态。当前权限决定每类投影。
- [x] 左导航合并患者诊疗、收费经营及基础管理。保留旧路径和业务范围检查。红点复用工作台已有快捷入口及完整日历按钮。
- [x] 复测门店切换和已有前台、牙医、总部等登录路径。

## T070 门店与员工权限

**文件** `backend/adc/identity/admin_api.py`、`permissions.py`、`backend/scripts/grant_db_access.py`、`web/src/features/admin/AccessPage.tsx`、对应契约测试及同源验证。

- [x] 先覆盖角色允许清单、外店范围、自授权、已有账号启停及审计。
- [x] 使用部署预置的 `HQ_ACCESS_ADMIN`。实现员工和门店最小投影、启停、预设角色及指定门店的原子授权。沿用操作键及状态对照。
- [x] 让基础管理页查询和维护授权。有成功、拒绝、旧数据冲突和重试反馈。权限管理职责和季度职责以部署方式维护。
- [x] 用受限 DB 角色执行写入，验证普通角色、旧会话与跨店拒绝。

## T071 日结对账

**文件** `backend/adc/billing/reconciliation_api.py`、`web/src/features/billing/DailyReconciliation.tsx` 及相应契约和组件测试。

- [x] 先覆盖成功回执按本地日期归期、跨日未决、跨店改约归原店及未转正退金。
- [x] 添加 `GET /billing/reconciliation?clinic_id=<id>&date=<ISO>`。返回一致截止、四类成功资金及彼此分离的净额、当前在途和最小证据。可按现有权限链接源记录。
- [x] 在收费与经营下添加日结页，保留核心结算流水。测试权限隔离以及币值与原流水一致。

## T072 患者本人费用单

**文件** `backend/adc/billing/patient_invoice_api.py`、小程序 `pages/invoices` 与 `pages/invoice-detail`、`app.json`、账户及预约详情页、契约和原生逻辑测试。

- [x] 先覆盖患者能查本人已开立主单及异主单拒绝，已获批入账差额和在途资金按现行规则投影。
- [x] 添加 `GET /patients/me/invoices` 及其详情，通过患者会话和归属校验，返回最小投影及分页。预约详情提供同一费用单入口。
- [x] 真正运行原生页面，检查发票、预约金区分和空列表、查询失败反馈。

## T073 经营助手与选择建议

**文件** `backend/adc/reporting/assistant_api.py`、`assistant_service.py`、`web/src/features/operations/AssistantPanel.tsx`、报表页面、部署配置示例及前后端测试。

- [x] 先覆盖双店建议、单店降级、自定义条件、明确点击提交、授权聚合、规则引用、同快照和保留报表。
- [x] 实现建议读取、分析提交及结果回查。复用现有汇总服务，在一致性读取中计算比较，并保留原汇总和报告截止。
- [x] Django 仅把批准的汇总及知识片段传给 DeepSeek，使用独立合成环境开关、超时、次数封顶和无模型模板。
- [x] 测试零分母、空内容、模型超时、未授权范围、未知意图和临床/个人信息输入。使用可验证的服务替身覆盖工具调用。

## T074 双店演示

**文件** `backend/scripts/seed_local_preview.py`、`使用说明.md` 以及真实 PostgreSQL 集成验证。

- [x] 为两家门店及两个期间准备稳定的合成预约和模拟资金、源账单、未决款以及角色账户。
- [x] 核对同号预约的双端和实际日结口径。在本地可选问题中演示查询、解释、同一截止回查，以及模型未配置场景。

## T075 文档与整体验收

**文件** 课程 Word 补充、`spec.md`、`plan.md`、`data-model.md`、`contracts/api.md`、`tasks.md`、`adc-release-evidence.md`。

- [x] 以现行规范保存新增决定及追踪关系。Word 采用补充形式，呈现单一系统。
- [x] 执行 PostgreSQL 真库、Django 测试、网站及小程序测试和构建、原生编译。按验收项记录结果。
- [x] 交付当前实现和同步的本地提交版。实际公网备案及真机状态依现场证据记录。

本地完成和验证结果见[课程补充验收](../../verification/adc-release-evidence.md#2026-11-26-双端补充验收)。实际 DeepSeek、GitHub 公布和受邀真机分别按外部环境状态记录。
