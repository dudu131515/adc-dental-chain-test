# ADC 快速验证与联验指南

[技术方案](plan.md) · [接口契约](contracts/api.md) · [数据模型](data-model.md) · [已审核 UI](../../docs/superpowers/specs/2026-11-22-adc-product-ui-design.md)

2026-11-23 · 当前可运行同源数据库验证、后端测试、React 构建及原生小程序逻辑测试。体验环境入口参见 [部署说明](../../deploy/README.md)，合成联验记录参见 [验证记录](../../docs/verification/adc-e2e.md)。

## 现有 PostgreSQL 验证

准备仅用于验证的 PostgreSQL 17、`psql`、`createdb` 和可在专用数据库安装 `btree_gist` 的初始化账号。确认连接环境的服务器地址、环境和账号指向授权测试实例。运行目录为 ADC 项目根目录。每次使用新建的空验证库。

```powershell
$adcVerifyDb = 'adc_schema_verify_' + (Get-Date -Format 'yyyyMMddHHmmssfff')
createdb --maintenance-db=postgres $adcVerifyDb
if ($LASTEXITCODE -ne 0) { throw '创建 ADC 验证库失败' }

psql -X -v ON_ERROR_STOP=1 --single-transaction -d $adcVerifyDb -f './usecase/ADC_PostgreSQL_设计与统计.sql' -f './backend/scripts/master_data_access.sql'
if ($LASTEXITCODE -ne 0) { throw 'ADC 设计 SQL 执行失败' }

psql -X -v ON_ERROR_STOP=1 -d $adcVerifyDb -f './usecase/ADC_PostgreSQL_验证.sql'
if ($LASTEXITCODE -ne 0) { throw 'ADC 验证 SQL 执行失败' }

psql -X -v ON_ERROR_STOP=1 -d $adcVerifyDb -c 'SELECT count(*) AS appointments_after_rollback FROM appointment'
if ($LASTEXITCODE -ne 0) { throw 'ADC 样例回滚核对失败' }
```

预期最后出现 `PASS ADC PostgreSQL schema and scenario tests`，基线为 40 张表、268 个字段、70 条外键和 4 个视图，样例回滚后预约行数为 0。阶段 5 已在独立 PostgreSQL 17.11 实例按同源脚本复现。验证 SQL 内的撤销、统计和资金样例覆盖数据库行为，整段椅池匹配、服务授权、工作日历及外部回执流程由下文验证。基线测试在事务内回滚，保留空结构复核。

## 实现后联验准备

1. 环境提供业务库和同一实例的 `adc_runtime` 技术库连接、运行密钥、已核准门店工作日历版本、合成账户配置与模拟资金配置。微信真机测试另提供受邀测试 AppID、服务端凭据和合法 HTTPS 请求域名。普通开发工具可在隔离环境中使用合成身份适配。
2. 两家虚构门店含不同椅型、一条停用区间及一名跨店牙医。准备两名合成患者、两店权限与总部各功能权限、同意及拒绝追加、有效／无效资格、项目价格版本、耗材成本凭据、直接和共同费用、未处置预约、成功与失败的模拟资金。
3. 业务库用同源 SQL 初始化，Django 技术库分别运行其会话和快照存储的初始化。实现后的测试库创建流程必须先加载完整业务 DDL，映射模型不重新生成业务结构。并发测试使用独立 PostgreSQL 连接和 `TransactionTestCase` 或等效真实提交机制。

以下命令约定在应用实现后由对应目录提供，按锁文件和部署配置安装依赖。后端使用项目的测试数据库配置，网站本地开发代理将 `/api/v1` 指向 Django。

```powershell
python -m pip install -r backend/requirements.txt
python backend/manage.py check
python backend/manage.py migrate --database=runtime
python backend/manage.py createcachetable --database=runtime
python backend/manage.py test

npm --prefix web ci
npm --prefix web run test
npm --prefix web run build
node --test mini-program/tests/*.test.cjs
```

启动联调时使用两个窗口分别运行 `python backend/manage.py runserver` 和 `npm --prefix web run dev`。微信开发者工具打开 `mini-program/`，切换到相应隔离 API，体验版在受邀真机验证同一调用链。部署后使用实际服务配置执行 Django `check --deploy` 并验证 HTTPS 与授权头转发。资金补跑以已保存待处理记录为输入，复跑同一义务核对同键只产生一个结果。

在同源 DDL 已初始化的**空本地合成库**中可用
`python backend/manage.py shell -c "from tests.fixtures.scenarios import load_synthetic_base; load_synthetic_base()"`
加载两店、角色和合成患者。员工的本地哈希使用 `ADC_STAFF_PASSWORD_HASHES` 提供。开发者工具使用本机合成患者时，`ADC_ENV=local`，配置 `ADC_MINI_SYNTHETIC_CODES` 为形如 `{"local-demo-code":"adc-demo-patient-a"}` 的 JSON，并在本地开发设置中填入同一 `LOCAL_SYNTHETIC_LOGIN_CODE`。此入口只对开发版及回环 API 生效。微信工具的本地不校验域名选项仅在本机私有设置中使用，提交配置保留合法域名校验。

## UC01–UC07 联验

| 场景 | 操作 | 可核对结果 |
| --- | --- | --- |
| 排班与发布 · AC-01-01 至 AC-01-04 | 分别提交班次内资格到期、跨店 59 分钟、满 60 分钟但路线不可行，以及恰好 60 分钟且资格、路线和接受均有效的案例。另测牙医拒绝及停诊 | 合格且达标的发布进入候选。不合格保留原有效安排或草案，显示原因。停诊可进入同店替代或患者同意协调 |
| 正常、并发及已到期预约 · AC-02-01 至 AC-02-04、AC-02-10 | 小程序和网站代办使用同一可约规则。分别查询唯一适配椅中途停用或资格未覆盖整段的时段。用两个会话同时占用最后一椅，测试失败、到期和重复晚到回执 | 整段不可行时反馈备选。同一临界容量内仅合法请求成功。10 分钟和 50 元一致，到期晚到成功仅记唯一全额退金义务，原支付及实际结果可回查 |
| 改期、取消与爽约 · AC-02-05 至 AC-02-09、AC-02-11 | 覆盖 20:00 整、超时、缺日历、部分重叠和资源争抢。对照诊所原因在患者截止之后协商，分别核对同意和未同意。按 24:00、23:59、2:00、1:59 提前量对照取消，并复核已签到及延误 | 合法改期保留原号原款，失败保留原预约。诊所协商按同意及资源判定。患者取消退 50、25、25 或 0 元，诊所原因取消原路全退。责任待核实期间保留签到事实，已签到不能登记爽约 |
| 签到到诊疗 · AC-03-01 至 AC-03-04 | 前台签到并尝试分配唯一专用椅，同时保留其他预约。指定牙医重复点击开始，分别记录同意、拒绝追加以及完成与中止 | 签到和开始各有证据。仅可行的整体分配提交。开始产生一个实际就诊和一笔原路退金义务。拒绝不计费，记录完毕释放椅位，计时和实际事实保存 |
| 主单与原收款退款 · AC-04-01 至 AC-04-06 | 区分未结束、缺计价证据、零额中止与正常开单。重复开单，办理部分收款、获批冲销及两笔原款退款，并检查失败及非法引用 | 唯一原主单。零治疗中止显示已结清。成功原款与退款逐笔关联，异单、失败原款或累计超额请求被拒绝。120 元原应收、收 60 元、冲销 -120 元案例中，在途净实收仍为 60 元，退款成功后为 0 元 |
| 标准与价格 · AC-05-01、AC-05-02 | 提交重叠生效区间，随后发布合法版本并重读既有预约、治疗及主单 | 不合法价格不生效。更新后的标准按有效期适用，原占位、使用的名称／单位／价格与主单快照可核对 |
| 经营与回查 · AC-06-01 至 AC-06-04 | 覆盖跨期改约、截止、已确认与已签到未接诊、零分母或缺数据；用两张主单核对实际治疗及各类资金结果 | 8 笔集合的 4/8 为 50%、1/8 为 12.5%，爽约 1，未处置 2。AC-06-04 按单核对后应计 160 元、成功收款 120 元、退款 10 元、净实收 110 元、欠款 60 元，不以总应计减总净收替代逐单汇总 |
| 季度冻结与修订 · AC-07-01 至 AC-07-04 | 试算缺证据、零分钟及负利润，补证据确认后入账两笔差额，测试重复来源及越序确认 | 当地 Visit 结束归期。费用闭合、非正利润基金为 0。基金按批准顺序从 27 元、15 元至 20 元，复核期间用最新已确认版，越序不发布 |
| 一套系统、权限和异常 · AC-X-01 至 AC-X-07 | 同一预约链贯通两端，对照各岗位正反例、提交结果未知，以及网站键盘焦点、窄屏和小程序触控与安全区 | 两端一致识别相同预约。越权操作及字段被拒绝。结果未知先核对，恢复不重复办理。交互符合已审核 UI/UX |

## 批准补充场景

| 验收 | 关键条件和结果 |
| --- | --- |
| AC-02-12、AC-02-13 | 以 10:00 为预约开始，09:59 已确认且未签到可普通取消，10:00 转核实。对照已签到未接诊后的继续履约、患者责任及诊所责任，核对原退款档位与留痕 |
| AC-02-14 | 未转正占位尚未过期，但停诊或椅位停用导致复查无资源。付款成功后保留原款、释放占位、只登记一次 50 元全额原路退款。重复回执无新预约或退款 |
| AC-02-15、AC-X-08 | 核对单店、双店授权，诊所原因须患者同意。原店只见本店交接和资金事实。按 Spec 最小资料表分别核对前台、履职牙医及总部经营投影 |
| AC-04-07 | 原诊疗退款失败后在仍满足应退和限额时按同一义务原路重试。在途先查，晚到成功只计一次，成功后的旧失败不回退。不匹配留证暂停 |
| AC-07-05 | 0.02 元共同费用三人等分钟分摊，三份均为 0.00 元，未分配 0.02 元并纳入公司费用。跨年就诊 23:50 至 00:20 的 30 分钟全部归新季度 |
| AC-X-09 | 在同一两店合成环境记录预约查询、竞争最后一份资源、季度复核的操作时长、并发结果及异常。以原业务一致性验收，时长作为性能基线 |
| AC-X-10 | 选定合成备份点并恢复至隔离环境。核对该点的排班、原预约号与原款、主单、审批、已确认版。比较恢复点后一笔结果未明的模拟资金，先按原义务核对后再处理，留存差异清单 |

联验提交证据采用合成样例，保存预期、得到的业务标识及状态、并发两边结果、关键截图和异常关联号。不要在交付记录中包含会话、秘密或受保护的明文。

## 工作台与患者小程序演示

使用专用的空数据库，名称须以前缀 `adc_workspace_preview_` 开头。先执行同源 DDL，在单独的运行库建立会话表及快照表。设置 `ADC_ENV=local`、两套数据库 URL、运行密钥和指向本地新文件的 `ADC_WORK_CALENDARS_PATH`。然后在项目根目录执行以下命令一次。

```powershell
python backend/manage.py shell --verbosity 0 -c "import runpy; runpy.run_path('backend/scripts/seed_local_preview.py')"
```

将返回的 JSON 设为 `ADC_STAFF_PASSWORD_HASHES`。前台账号 `demo.front-a`，责任牙医账号 `demo.dentist`，合成账号口令为 `ADC-preview-2026`。这批数据包括当日六类预约状态、已经登记的过敏条目、前台待结算就诊及患者下一次预约。小程序的本地专用预览配置按本文件的合成身份说明设置。

进入前台工作台，点击已签到指标检查日历范围。由患者档案打开预约或代办。登录责任牙医后在接诊队列选择许言，并保存一次过敏核对。微信模拟器以合成患者陈晓雨进入，核对首页显示的预约号 ADC-DEMO-011 与网站档案一致。

## 课程补充验收

在本文件的空本地合成库流程中，新增账号 demo.access、demo.reports 和 demo.reports-a 分别用于人员授权、双店经营、单店经营。使用前台账号核对首页业务入口旁的红点和「收费与日结 → 日结对账」。选择昨天可核对中心门诊 80.00 元诊疗到账和一笔仍待处理的模拟收款。以合成患者陈晓雨打开「我的 → 诊疗费用单」，核对 ADC-DEMO-INV-120 已收 80.00 元、尚欠 100.00 元。

从「经营与配置 → 经营智能助手」打开按授权范围推荐问题的对话工作区。选择双店对比后可指定昨天当天为本期、八天前当天为对比期，两店分别由 6/8 到 4/8、由 2/4 到 3/4。两期均可查看原报表。单店账号只能分析中心门诊。省略外部模型配置时，可直接演示本地报表解读和来源回查。

以实际 DeepSeek 验收时，在启动 Django 的私有环境配置 ADC_ASSISTANT_DEEPSEEK_ENABLED=1，ADC_ASSISTANT_SYNTHETIC_ENV、ADC_ASSISTANT_SYNTHETIC_HOST、ADC_ASSISTANT_SYNTHETIC_PORT、ADC_ASSISTANT_SYNTHETIC_DB 填实际专用合成环境、主机、端口和业务库名，ADC_DEEPSEEK_API_KEY 由服务环境注入。默认模型和可配置项见部署示例。启用后在操作页面手动提交一次，再核对结果、用量审计及原报表入口。密钥存放于服务环境，课程仓库和小程序均不存放。
