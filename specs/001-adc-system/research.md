# ADC 技术调研与决策

2026-11-22 · Spec Kit Phase 0 · [统一规约](spec.md) · [已审核的 UI/UX](../../docs/superpowers/specs/2026-11-22-adc-product-ui-design.md)

以章程 I–V 和母本附录 A 为边界。下面的选择属于实现方式，业务动作、门店权限、统计口径和界面范围由已审核资料确定。

## RD-01 单一系统与版本基线

- **决定** 采用一个模块化 Django 服务、一个 PostgreSQL 实例、一个 React 管理网站和一个微信原生小程序。设计基线为 Python 3.12、Django 5.2 LTS、支持该 Django 系列的 Django REST framework、psycopg 3、PostgreSQL 17、React 19 与 TypeScript。部署时锁定依赖的兼容补丁版。小程序使用原生页面与组件。
- **理由** UC01–UC07 跨排班、预约、就诊及财务共用事务和事实。PostgreSQL 17 与 V1.1 SQL 的实测基线一致。Web 与小程序共用 HTTP JSON 契约、独立渲染。
- **比较** 评估过按领域独立服务及独立数据源，跨域一致性成本较高。评估过浏览器共用的跨端框架，小程序原生是已定边界。
- **依据** FR-004 至 FR-007。[Django 事务](https://docs.djangoproject.com/en/5.2/topics/db/transactions/) · [DRF 权限](https://www.django-rest-framework.org/api-guide/permissions/) · [React 状态结构](https://react.dev/learn/choosing-the-state-structure)

## RD-02 物理模型和演进

- **决定** 以活跃设计 SQL 初始化业务库并维护版本化 SQL 变更。Django 业务模型按现有结构映射，使用 `managed=False`，保留数据库原生 identity、部分索引、带条件的 GiST 排他、可延迟约束和组合外键。绩效明细用现有单列主键，组合关联由数据库校验并在查询中按两列连接。
- **理由** 双重建表会让附录 A、DDL、ORM 与验证脚本漂移。保留已验证的 40 张业务表和 4 个事实视图，可独立检查外键、字段、索引以及约束行为。
- **比较** 评估过由 ORM 重新生成全部 DDL及直接沿用早期 SQL 草案，二者均需额外校对结构和约束语义。
- **依据** FR-005、FR-007、I01–I13、Q06。[Django managed 选项](https://docs.djangoproject.com/en/5.2/ref/models/options/#managed) · [PostgreSQL 范围与排他](https://www.postgresql.org/docs/17/rangetypes.html) · [已验证设计脚本](../../usecase/ADC_PostgreSQL_设计与统计.sql)

## RD-03 登录、授权与运行态

- **决定** 员工 Web 登录使用现有 `login_identity` 和只在服务端供应的课程账号密码哈希，认证成功后建立可撤销的 Django 数据库会话。网站同源、使用 HttpOnly 会话 Cookie 及 CSRF。小程序由 `wx.login` 获取一次性 code，Django 换取微信身份并映射本人账号，返回可撤销的随机 bearer 会话。开发工具可用仅在隔离演示环境启用的合成身份配置。测试和体验均校验业务账号状态。
- **理由** 附录 A 的 `user_account` 只有账号关联和登录标识。密码哈希、技术会话和短期只读报告快照放在运行环境。会话和快照存储使用同一 PostgreSQL 实例上的独立技术库 `adc_runtime`，权限事实从业务库逐请求读取。令牌用途与客户端绑定，撤销、越权和拒绝由服务端判定。
- **比较** 评估过仅使用签名 Cookie、前端长期 JWT、使用 Django 内置角色作为业务权限。服务端会话便于撤销和隔离两个渠道，业务授权保留 `employee_role`、就诊归属及患者本人关联。课程账号的初始化凭据由部署人员供应。
- **依据** FR-001 至 FR-003、AC-X-01。[Django 会话](https://docs.djangoproject.com/en/5.2/topics/http/sessions/) · [Django 多库](https://docs.djangoproject.com/en/5.2/topics/db/multi-db/) · [Django CSRF](https://docs.djangoproject.com/en/5.2/ref/csrf/) · [腾讯小程序登录说明](https://cloud.tencent.com/document/product/1441/68677) · [微信登录入口文档](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)

## RD-04 排班、椅位与改期并发

- **决定** 采用显式短事务，按牙医与门店统一顺序获取锁，再读资源和执行最终业务校验。门店行锁保护椅位容量。同一牙医的跨店相邻班次在共同串行边界内复核。区间统一为 `[开始,结束)`。给重叠且相互影响的预约计算整段可分配方案；分椅时将候选实际椅位固定后核对其他有效占位。改期事务内先形成可行新配置，再换当前引用并释放原位，命名约束提交前恢复立即校验。
- **理由** 排他约束可约束单牙医或单牙椅，门店级容量还需检验异质椅位、维护期和多笔占位的可行组合。区间和版本均由服务在写入时重查。候选搜索结果允许过时，提交返回可重选的冲突结果。
- **比较** 评估过按并发数量简单减椅位、预约时绑定某把牙椅、所有请求使用全局锁。上述选择分别丢失类型及整段约束、提前分椅，或扩大不相干门店的争用。
- **依据** FR-101 至 FR-104、FR-201 至 FR-209、FR-301 至 FR-304。[PostgreSQL 显式锁](https://www.postgresql.org/docs/17/explicit-locking.html) · [SET CONSTRAINTS](https://www.postgresql.org/docs/17/sql-set-constraints.html)

## RD-05 模拟资金与持久化证据

- **决定** 预约金和诊疗资金分别通过共享模拟资金适配器处理。锁内创建稳定业务键和待处理义务，提交后唤醒。回执匹配目标、原款、方向与金额。诊疗退款失败按同一义务重试，在途或冲突先核对，成功只计一次。恢复环境中的未明资金先与原义务、恢复点后差异对账，再允许补跑。核实、同意或拒绝、费用凭据、原收款及季度证据沿用最小结构化审计。
- **理由** 业务记录需先提交才可产生资金处理，行锁内执行可重放的状态校验更易处理重复和迟到结果。批准的附录没有新增同意表、凭据表或支付通道列。类型化的审计证据通过已有业务目标关联，授权取用，并随对应业务变更原子保存。
- **比较** 评估过直接由客户端回执确认、在数据库锁内等待外部操作、建立额外支付队列库。课程模拟可使用同一业务记录及稳定键完成恢复。
- **依据** FR-003、FR-204 至 FR-210、FR-304 至 FR-306、FR-404 至 FR-408、FR-701、FR-705 至 FR-707。[Django 提交后回调与回滚](https://docs.djangoproject.com/en/5.2/topics/db/transactions/#performing-actions-after-commit)

## RD-06 对照统计与季度冻结

- **决定** 使用四个已批准的事实视图，在一次一致读内生成同范围的聚合和明细分类。以查询开始时间筛选最终时段，使用绑定请求人的短期快照下钻。正式季度读最新已确认版，每条获批入账差额对应原季度一次修订。全段实际分钟随就诊结束季度。同店比例分摊逐份向下保留到分，尾差留未分配。
- **理由** 统一读范围保证分母、明细和下钻一致。季度快照保留版本确认事实和复算证据。共同费用非负且未分配继续计入公司费用，按分取整后的余数可按母本保留。
- **比较** 评估过每次下钻重新取数和覆盖原季度汇总。前者可能在取消或改期后改变同一查询范围的明细，后者丢失原版与差额证据。
- **依据** FR-601 至 FR-605、FR-701 至 FR-707、AC-06-01 至 AC-06-03、AC-07-01 至 AC-07-03。[PostgreSQL 事务隔离](https://www.postgresql.org/docs/17/transaction-iso.html)

## RD-07 双端状态与设计系统

- **决定** React 按已审核的五个导航区域分路由模块，列表筛选进 URL，服务端数据通过统一请求层加载，页面级表单与弹层保持局部状态。微信仅「预约就诊」「我的预约」两项一级入口，以原生组件和统一 `wx.request` 封装复用契约。色板、字号、间距、状态文案及组件状态从同一份设计令牌映射 CSS 自定义属性和 WXSS。
- **理由** 两端遵从审核版页面结构。服务端状态和权限是唯一写入依据，前端可在返回或重试时保留输入并刷新业务事实。
- **比较** 评估过全局存储所有页面数据及跨端共用渲染组件。其状态生命周期和不同交互环境的成本较高，设计令牌与契约即可覆盖一致性。
- **依据** FR-001 至 FR-008、SC-006 至 SC-007。[React 状态结构](https://react.dev/learn/choosing-the-state-structure) · [React reducer 与 Context](https://react.dev/learn/scaling-up-with-reducer-and-context) · [微信请求文档入口](https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html)

## RD-08 部署与验证

- **决定** 课程与体验环境均使用同一部署拓扑。静态发布 React，经 HTTPS 反向代理把 `/api/v1` 转发到 Django WSGI。PostgreSQL 在内部网络，业务库与技术库使用不同连接权限，数据库初始化和运行账号分离。同一服务内提供模拟资金补跑命令。微信真机接入合法 HTTPS 请求域名。
- **理由** 对课程环境可在本地复现 SQL 验证，体验环境可独立验证微信、角色范围和异常路径。没有既定响应时间或吞吐量指标，按规约以两家合成门店和一名跨店牙医作验收，再观察慢查询与事务竞争。部署域名、AppID 和凭据由实际体验环境提供。
- **比较** 评估过对外公布独立 API 域及增加专用消息基础设施。一个同源网站加微信访问同一 API 可满足已确认范围。
- **依据** FR-006 至 FR-008、SC-001、SC-002、SC-006。[Django 部署检查](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/) · [母本验收记录](../../usecase/ADC_开发基线_业务决策与验收记录.md)

R08、R09 已批准。课程记录预约查询、最后一份资源争抢和季度复核的实际时长，并完成一次合成备份点恢复及未明资金对账。实际凭据、域名和演示资料由环境提供。主动提前提醒归后续范围。
