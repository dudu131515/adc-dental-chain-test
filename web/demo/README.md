# ADC 仪表盘静态演示

[打开公开仪表盘](https://dudu131515.github.io/adc-demo/) · [静态发布仓库](https://github.com/dudu131515/adc-demo)

## 导航与验收

| 一级入口 | 左栏子入口 | 用例与需求 |
| --- | --- | --- |
| 首页 | 门店总览、四个业务区直达 | FR-010 |
| 门诊运营 | 预约趋势、预约日历、跨店排班、牙椅资源 | UC01、UC02、FR-010 |
| 患者与诊疗 | 患者档案、接诊队列、诊疗记录 | UC03、FR-212、AC-03-05 |
| 收费与日结 | 结算队列、账单与收退、日结对账、更正与审批 | UC04、FR-409、FR-410 |
| 经营与配置 | 经营概览、门店对比、AI 分析、季度核算、项目与价格、门店与授权 | UC05 至 UC07、FR-011、FR-606、FR-607 |

从「门诊运营 → 预约日历」进入，可在牙医、牙椅和列表之间切换。预约详情分为概要、就诊记录、过敏核对与可用的费用单。从经营概览切换指标或期间，再通过「门店对比」核对原始汇总。从「经营与配置 → AI 分析」打开独立对话。点击建议填入问题，再发送，也可以自行输入。每轮结果可以回到原报表。GitHub Pages 以合成指标展示整个流程。全部操作基于合成样例。

CDC Manager 的诊室排程和收费队列、OpenClinic 的档案内标签和独立报表，以及 dental-chain(test) 的 T044、T070、T079、T090、T127、T135 是本次交互分栏的参照。业务数据、状态、品牌和入口沿用 ADC 当前课程口径。 [CDC Manager](https://github.com/Orlando-Pedrazzoli/cdc-manager) · [OpenClinic](https://github.com/N4D3RR/openclinic-fe)

## 构建

从项目根目录运行 npm --prefix web run dev:demo 调试。运行 npm --prefix web run build:demo 输出 web/demo/dist。构建使用相对资源和 hash 导航。GitHub Pages 从专用演示仓库 main 分支根目录提供静态文件。员工网站和微信小程序沿用现有 Django 和 PostgreSQL 服务结构。
