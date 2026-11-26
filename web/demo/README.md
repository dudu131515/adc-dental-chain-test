# ADC 仪表盘静态演示

以门诊工作台为首页。可切换两家合成门店和样例日期，查看预约、过敏标记、诊疗费用和模拟日结。在经营分析中选择问题，可复核两店就诊率、到期未处置数量和诊疗净实收的两期统计。

从项目根目录执行 npm --prefix web run dev:demo 可调试。执行 npm --prefix web run build:demo 可生成独立发布目录 web/demo/dist。发布目录以相对地址加载资源，导航使用 hash。GitHub Pages 从专用演示仓库的 main 分支根目录提供静态文件。员工端和微信小程序仍共用原 Django 服务和 PostgreSQL 数据库。

[打开公开仪表盘](https://dudu131515.github.io/adc-demo/) · [静态发布仓库](https://github.com/dudu131515/adc-demo)
