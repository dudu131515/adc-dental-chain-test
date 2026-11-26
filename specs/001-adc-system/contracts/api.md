# ADC HTTP API 契约

[技术方案](../plan.md) · [系统 Spec](../spec.md) · [数据模型](../data-model.md) · [联验指南](../quickstart.md)

预约补偿、核实取消、最小字段、跨店交接和诊疗退款重试按 [R01–R09 批准记录](../checklists/requirements-review.md#审核汇总)及 [Spec 已定字段范围](../spec.md#最小可见资料及跨店交接)执行。

同一 Django 服务提供 HTTPS JSON，本文路径以 `/api/v1` 为前缀。表中输入均为拟定字段名。标识均为十进制字符串，金额、数量和实际分钟为按字典精度的十进制字符串，避免 JavaScript 数值精度丢失。服务端返回 ISO 8601 带时区时点，本地日期为 `YYYY-MM-DD`。营业日、截止与季度使用 Asia/Shanghai。列表使用 `items`、`next_cursor`，游标绑定主体、范围、排序与筛选。

## 身份与访问范围

| 代号 | 服务端核验 |
| --- | --- |
| P | 患者小程序 bearer，仅本人患者记录及可约目录。入口拒绝员工会话和其他患者 ID |
| F | 管理网站员工会话，有当前门店前台且获该动作授权 |
| D | 管理网站员工会话，牙医本人班次或负责的同次就诊 |
| C | 管理网站员工会话，有本店主管且获该动作授权 |
| S / K | 总部排班授权／总部项目标准授权，门店及业务数据最小可见 |
| R | 总部经营，另按查询、核算、复核和确认动作检查授权及门店集合 |

网站使用 HttpOnly、Secure 会话 Cookie，修改请求和登录带 CSRF。小程序用 `Authorization: Bearer <token>`，服务端只接受患者渠道令牌。各端退出撤销服务端会话。查询先按范围过滤，详情与写入重新校验。按预约、结算、临床和经营分别投影。前台的预约或结算序列化不包含病史、过敏详情和耗材成本。总部经营明细以业务编号关联，不返回患者联络资料。对象超出可见范围为 404，已可见对象但无动作权限为 403。

| 方法与路径 | 访问 | 输入 → 结果 | 追溯 |
| --- | --- | --- | --- |
| GET `/auth/web/csrf` | 网站登录入口 | 取 CSRF Cookie 和允许发送的 token | FR-001、FR-002 |
| POST `/auth/web/login` | 网站及 CSRF | `login_identity,password` → 设置会话 Cookie，返回员工身份及权限范围 | FR-001、FR-002 |
| POST `/auth/mini/login` | 微信入口 | `code` → 服务端换取微信身份。已绑定返回 bearer，未绑定返回短期 `profile_token` 和 `profile_required` | FR-001、FR-002 |
| POST `/auth/mini/bind-profile` | 小程序首次绑定 | `profile_token`、本人必填档案 → 原子创建本人患者与账号并签发患者 bearer。已预置患者按环境提供的受控关联就绪后登录 | FR-001、FR-002、FR-201 |
| GET `/auth/me` | P 或授权员工 | 当前 `account_id`、类别、`capabilities`、可用门店及本人关联标识。员工会话同时返回姓名、工号、岗位代码、所属门店、员工和账号状态。 | FR-001、FR-002 |
| POST `/auth/logout` | P 或授权员工 | 撤销当前会话，网站清除 Cookie，小程序清除本地令牌 | FR-001、FR-002 |

档案字段为 `full_name,birth_date,billing_address,phone,email,emergency_name,emergency_phone`。第一阶段微信仅服务课程合成身份。微信 `openid` 由服务端取得，禁止使用客户端提供的微信身份或按姓名、手机号自动认领既有档案。首次绑定令牌只用于建立本人资料，重复提交回读既有合法绑定，不建立重复档案。

## 统一状态、结果与安全写入

- 成功体包含 `data`，创建返回 201，已有结果回读返回 200，无正文操作 204。支付仍待处理可返回 202，客户端持有稳定的资源标识及查询链接。
- 预约详情返回 `appointment_id,appointment_no,claim_id,clinic,patient_display,dentist,treatment,start_at,end_at,status,change_deadline_at,allowed_actions`。其中 `patient_display`、就诊链接及临床字段按授权投影。占位期限 `expires_at`、预约金状态、退金状态、签到与实际接诊时点、原主单与资金状态分别表示。
- 占位、预约、诊疗、原款、退金、主单、差额及季度采用 [现行状态值](../data-model.md#数据生命周期与状态)。`awaiting_chair`、`eligible_for_review` 为界面派生提示。付款并发、已签到及资金在途均不得直接推断另一对象已完成。
- 更新型命令核对表中约定的目标及有效前置状态。预约变更携带 `expected_claim_id`，更正带 `invoice_id` 和申请标识，确认季度带 `revision_no`。服务器不接受客户端写入状态、最终金额、退款资格或审计主体。
- 内部可审计投影包含业务目标、授权范围内的必要操作者、时间、理由和结果。API 不返回凭据、微信 secret、完整原始回执或原始审计 JSON。跨店和请求来源由服务根据现有记录核验。

## 排班与预约

| 方法与路径 | 访问 | 请求 → 主要响应 | 追溯 |
| --- | --- | --- | --- |
| GET `/clinics` | P、F、D、C、S、R | 返回可预约门店或已授权门店列表。字段含编号、名称和地址 | FR-001、FR-002、FR-201 |
| GET `/schedule/board` | F、D、C、S | `clinic_id,date_from,date_to,dentist_id,status,view` → 用对应范围的班次、预约摘要和可见状态构建视图。周视图还返回 `shortages`、`conflicts`，单门店日视图还返回其全部可用牙椅均无法使用的 `unavailable` 区间 | FR-002、FR-101、FR-102、FR-202、FR-301 |
| GET `/schedule/dentists`；GET `/qualifications` | S、C、K 各按办理所需字段；前台仅本店牙医标识与姓名，牙医仅本人标识与姓名 | 返回可拟排牙医、获权资格，或标准和需求所需的资格目录。预约筛选与复杂项目代办复用该目录 | FR-101、FR-102、FR-201、FR-203、FR-501 |
| GET `/shift-demands`；POST `/shift-demands` | C、S 读；C 本店写 | 起止、门店、资格、人数 → 需求及当前办理状态 | FR-101 |
| GET `/shifts`；POST `/shifts` | D、C、S 按权读；S 拟排 | 拟排提交 `clinic_id,dentist_id,demand_id,start_at,end_at` → 草案、关联需求与允许动作 | FR-101、FR-102 |
| PATCH `/shifts/{id}` | S 按授权门店拟排 | `expected_status,clinic_id,dentist_id,demand_id,start_at,end_at,reason` → 调整同一草案。仅 `DRAFT`、`REJECTED` 可进入 `DRAFT`，原回应和调整原因留痕，提交和发布仍按原校验 | FR-101 至 FR-103 |
| POST `/shifts/{id}/submit`；POST `/shifts/{id}/respond` | S 提交；D 本人回应 | 提交校验资格、间隔及冲突。牙医传 `decision,reason`，输出回应与当前状态 | FR-102、FR-103 |
| POST `/shifts/{id}/publish`；POST `/shifts/{id}/withdraw` | S | 相邻班次跨店时发布传 `route_feasible,evidence_ref`；撤销传 `reason`。返回班次、冲突或允许查看的受影响预约 | FR-102 至 FR-104、FR-207 |
| POST `/shifts/batch` | S 按授权门店办理 | `draft` 批量拟排、`copy` 复制到目标日、`reuse_week` 复用上周、`submit` 提交选中草案、`publish` 发布已接受班次。需 `Idempotency-Key`。每批同一事务，返回 `items,skipped_count`。复用复制班次配置并跳过重复，每条仍走单班次校验 | FR-101 至 FR-104 |
| GET `/shifts/{id}/affected-appointments` | S、C 按协调范围 | 显示停诊可能影响的已有预约、同店可行候选和允许的协调操作 | FR-104、FR-207 |
| GET `/clinics/{id}/chairs`；POST `/chairs/{id}/unavailability` | F、C、S 按权读；C 本店写 | 写入 `start_at,end_at,reason` → 停用区间及有权限查看的影响；分椅候选另按预约查询 | FR-104、FR-202、FR-302 |
| GET `/patients/me`；PATCH `/patients/me` | P | 读取或更新本人允许的资料字段 → 本人档案 | FR-001、FR-002、FR-201 |
| GET `/clinics/{id}/patients`；POST `/clinics/{id}/patients` | F 本店办理 | 按授权办理范围搜索或提交代办必填资料 → 仅本人核验所需的最小字段 | FR-002、FR-201 |
| GET `/booking/options` | P、F；C、S 仅在获授权的诊所协调场景 | `clinic_id,date,treatment_type_id,dentist_id?`；可用 `preferred_start_at` 核对指定开始时点。改期带 `appointment_id`，以原快照和替换后的资源检验候选。复杂项目由 F 录入选定牙医的已确认估时与证据 | FR-201、FR-202、FR-206、FR-207 |
| POST `/holds` | P、F | 门店、牙医、班次、主项目、起止与意向，F 可在范围内提供 `patient_id` 和估时证据 → 临时占位、`expires_at`、`server_time`、原预约金待付记录。需幂等键 | FR-201 至 FR-204 |
| GET `/holds/by-action` | 发起占位的 P 或获当前本店代办范围的 F | `Idempotency-Key` 请求头、`clinic_id`，代办还提供 `patient_id` → 按同一主体和目标回读已提交占位的当前状态。无可见提交记录返回 404 | FR-002、FR-008、FR-203 |
| GET `/holds/{id}`；POST `/holds/{id}/release` | P、F 按原占位范围 | 返回实际占位状态、剩余时点、原款及关联预约。主动放弃时释放尚可释放的临时占位 | FR-203 至 FR-205 |
| GET `/appointments`；GET `/appointments/{id}` | P、F、D 本人或履职；C、S 在授权动作范围内 | 可按门店、牙医、日期及状态筛选，返回各自投影和允许动作 | FR-001、FR-002、FR-004、FR-204 |
| POST `/appointments/{id}/reschedule` | P、F；C、S 仅授权诊所协调 | `expected_claim_id`、目标资源、起止、`cause,reason`。员工跨店须有原店变更和目标店承接权。诊所原因填写 `patient_consent_ref`，不适用患者原因截止。成功返回原号原款及最新时段，失败保留原约 | FR-002、FR-206、FR-207 |
| GET `/appointments/{id}/handover-evidence` | 仅获授权的该原店人员 | 依据交接事件返回原时段、本店处理记录、本店已形成的原款或资金证据。当前预约详情依现门店权限单独检查 | FR-002、FR-004、FR-206 |
| POST `/appointments/{id}/coordination-intents` | 获影响门店协调动作权限的现有员工 | `expected_claim_id,impact,patient_intent` → 在原预约下保存本店影响与患者意向证据，返回有权的证据引用。记录意向不等同于取得改期同意，当前预约、占位及资金保持原事实 | FR-002 至 FR-004、FR-104、FR-206、FR-207 |
| GET `/appointments/{id}/cancellation-quote`；POST `/appointments/{id}/cancel` | P、F；C、S 仅授权诊所协调 | 查询带 `cause`。提交带 `expected_claim_id,cause,reason,quoted_refund_amount`，重核授权、时点及退金。诊所原因引用已有协调证据或填写 `coordination_evidence`。到点或已签到转核实 | FR-207、FR-208、FR-210 |
| POST `/appointments/{id}/cancellation-review` | 本店获该核实权限的人员 | `expected_claim_id,conclusion,reason`。结论为 `CONTINUE`、`PATIENT_CANCEL` 或 `CLINIC_CANCEL`，诊所原因取消使用协调证据。继续接诊保留原约。结论、原状态及资金结果留痕 | FR-207 至 FR-210 |
| POST `/appointments/{id}/no-show` | F 本店 | `expected_claim_id,reason,patient_absent,clinic_able` → 核实后的预约、保留额及必要审计引用；已签到及并非可履约须人工另处置 | FR-209、FR-210 |
| GET `/deposit-payments/{id}`；GET `/deposit-refunds/{id}` | P、F 按本人或门店范围 | 原占位或预约可见时读取金额、状态、允许的关联标识、原路退金结果 | FR-204、FR-205、FR-210 |
| POST `/deposit-payments/{id}/simulate`；POST `/deposit-refunds/{id}/retry` | 前者 P、F 按范围及模拟配置；后者获授权的 F | 返回资金和实际预约结果。未转正且支付成功后确认无法履约时，原支付为成功、无正式预约，返回释放结果和唯一原路退金引用。重复回读原结果 | FR-204、FR-205、FR-210、FR-304 |

## 诊疗、结算及标准

| 方法与路径 | 访问 | 请求 → 主要响应 | 追溯 |
| --- | --- | --- | --- |
| POST `/appointments/{id}/check-in` | F | `expected_claim_id` 和身份核实信息 → 签到时点、就诊条件及可选下一步 | FR-301、FR-302 |
| GET `/appointments/{id}/chair-options`；POST `/appointments/{id}/assign-chair` | F | 可行同店牙椅列表。提交 `expected_claim_id,chair_id` → 当前牙椅及签到结果。换椅仍走同一命令并保存历史 | FR-302 |
| GET `/clinical/queue`（`view=history` 为最近 100 笔本人已结束或中止就诊）；GET `/appointments/{id}/clinical-context` | D | 本人接诊队列可按 clinic_id 限制门店。接诊上下文返回履职所需病史、过敏及特殊需求，分椅和有效预约状态 | FR-301、FR-303 |
| POST `/appointments/{id}/start-visit`；GET `/visits/{id}` | D；F 可查看结算必需投影 | `expected_claim_id` → 唯一就诊、开始时间、已接诊和原预约金退款义务。详情提供授权已实施项目、耗材和费用快照，并按本店前台和就诊状态返回 can_issue_invoice | FR-303 至 FR-305、FR-308 |
| POST `/visits/{id}/additional-decisions` | D | 项目、患者同意或拒绝、必要证据 → 不计费的决定引用。可在随后实际治疗项关联已同意记录 | FR-003、FR-306 |
| GET `/clinical/materials`；POST `/visits/{id}/treatment-items` | D | 读取可用耗材和履职所需凭据引用。记录实际项目、实施时间、数量、同意引用及耗材用量和成本凭据 → 冻结治疗、有效单价及成本快照和暂计结果 | FR-305、FR-306、FR-503 |
| POST `/visits/{id}/finish`；POST `/visits/{id}/terminate` | D | 中止填写原因 → 记录结果、结束时间、实际分钟和待结算依据 | FR-307、FR-308、FR-403 |
| GET `/billing/queue`；POST `/visits/{id}/invoice`；GET `/invoices/{id}` | F；D、C 按更正权限读相关主单 | 取待结算队列或开单。主单详情返回原始明细、原额、已入账差额、应计、成功实收／退款、净收、欠款、应退、在途及允许动作 | FR-401 至 FR-405 |
| POST `/invoices/{id}/payments`；GET `/invoices/{id}/payments/{payment_id}` | F；C 仅授权核对 | 创建模拟收款金额，返回原主单与独立流水。稳定幂等键。支持全额和部分办理 | FR-404、FR-405 |
| GET `/invoices/{id}/payments/by-action` | 发起收款且仍获本店该主单收款权限的 F | `Idempotency-Key` 请求头 → 回读原动作产生的流水、原主单与当前资金结果。无可见提交记录返回 404 | FR-002、FR-008、FR-404、FR-405 |
| GET `/corrections`；POST `/visits/{id}/corrections` | D、C、F 在履职范围读；D 发起 | `invoice_id,reason,proposed_changes` → 更正及原就诊关联。列表按指定处理状态筛选。获批条目显示审批凭据的 approved_signed_amount | FR-406、FR-407 |
| POST `/corrections/{id}/decision`；POST `/corrections/{id}/apply` | C 审批；F 入账 | 审批传 `decision,reason` 及获批内容。入账用原申请及原主单标识复核，返回唯一差额和应计。重复返回已有结果 | FR-406、FR-407、FR-706 |
| POST `/invoices/{id}/refunds`；POST `/invoices/{id}/refunds/{payment_id}/retry` | 本店获授权 F | 创建提供 `source_payment_id,amount,adjustment_id?`。重试按原 `payment_id` 复查原路、原金额、限额及剩余应退，保持同一退款义务。已在途先查，冲突留证暂停，成功后旧失败不回退 | FR-405、FR-407、FR-408 |
| GET `/invoices/{id}/refunds/by-action` | 发起退款且仍获本店退款授权的 F | 用原 Idempotency-Key 回读原退款和当前主单结果。无可见原动作返回 404 | FR-002、FR-008、FR-405、FR-408 |
| GET `/catalog/treatments`；POST `/catalog/treatments`；PATCH `/catalog/treatments/{id}` | P、F、D 按需读取；K 维护 | 统一项目、单位、资格、估时和适配椅型。P 返回预约所需字段。写入后返回校验及有效标准 | FR-201、FR-501、FR-502 |
| GET `/catalog/treatments/{id}/prices`；POST `/catalog/treatments/{id}/prices` | D、F、K 按需读；K 写 | 价格、区间以及需要同次关闭的原版本引用与期末 → 生效版本或区间重叠理由。已有业务快照继续可回查 | FR-501 至 FR-503 |

原路退金以各自原支付记录为准。模拟适配器由服务端按批准的演示配置产出结果，可驱动成功、失败和延迟的验收场景，业务 API 禁止任意提交「已成功」及伪造原款。支付响应和后续查询携带实际结果、原目标及下一步。模拟回执仅由内部适配边界调用，访问来源与操作载荷先验证，关联丢失、金额冲突或重复终态都按异常或原结果处理。

占位回执和原预约金查询在尚未发起付款时返回 NOT_STARTED，发起后未收到最终回执返回 PENDING。放弃占位后的迟到成功保留原款并登记原路退金。数据库存储仍以付款状态和原办理标识区分这两种情形。

课程的隔离模拟能力对应 FR-006。本文接口、权限和记录字段由契约测试追溯至 FR-007，统一反馈对应 FR-008。

## 报表、费用与绩效

| 方法与路径 | 访问 | 请求 → 主要响应 | 追溯 |
| --- | --- | --- | --- |
| GET `/reports/operations` | R 查询权 | `date_from,date_to,clinic_ids,dentist_ids` → 查询截止 `as_of`、授权范围、`report_token`、预约共享分母、两率及分子、未处置、爽约与独立诊所原因取消计数，治疗、技能、标准覆盖、资金和正式季度版 | FR-601 至 FR-605 |
| GET `/reports/operations/details` | R 查询权 | `report_token,metric,clinic_id?,cursor?` → 同次一致读内产生的允许查看的明细。重新核对可见范围，筛选和账号不匹配或过期须重新查询 | FR-002、FR-601 至 FR-605 |
| GET `/expenses`；POST `/expenses` | C 本店读写；R 核算范围内读 | `clinic_id,period_id,expense_category,amount,scope,dentist_id?,evidence_ref` → 费用及凭据引用。范围及归属现场核对 | FR-701、FR-705 |
| GET `/performance/periods`；GET `/performance/periods/{id}` | R 分别按查询／复核。C 费用入口仅查询年季及期间标识 | 年、季、状态、按店贡献和公司结果。正式可见确认版及同授权明细，工作区可见核算证据、初版或修订状态 | FR-605、FR-701 至 FR-707 |
| POST `/performance/periods` | R 核算权 | `year,quarter` → 取得对应自然季度的唯一核算记录。已有期间原样返回，可随后试算或复核 | FR-701、FR-702 |
| POST `/performance/periods/{id}/calculate` | R 核算权 | 原季度初算或补证据重算 → 草案、缺项、金额闭合、未分配及复核信息。已确认季度仅采用有来源的修订版 | FR-701 至 FR-706 |
| GET `/performance/periods/{id}/revisions`；GET `/performance/periods/{id}/revisions/{revision_no}` | R 按查询／复核授权 | 版本、证据、确认状态。显示原值、差额、最新已确认值和被授权的复核输入 | FR-605、FR-704 至 FR-707 |
| POST `/performance/periods/{id}/revisions/{revision_no}/review`；POST `/performance/periods/{id}/revisions/{revision_no}/confirm` | R 独立复核／确认授权 | 复核传判断、理由，确认校验该版来源及闭合。同一版确认只一次。历次确认结果可读 | FR-705 至 FR-707 |

报告比例含 `numerator,denominator,value,availability`，`value` 是十进制比例字符串或空。区分实际零值、分母为零不适用、缺少数据。最终时段已结束且仍为已确认或已签到、尚无实际接诊的正式预约计入未处置。报告快照仅覆盖当前聚合、已授权投影及下钻所需关联，终端不会用新的分母覆盖已展示的结果。任何权限范围变化均拒绝使用旧快照。

## 错误和幂等

统一错误体字段 `error.code,error.message,error.field_errors,error.request_id,error.details`。细节仅返回经过授权的资源或报价。日期、格式、字段范围等错误为 400，未经认证为 401，权限及 CSRF 拒绝为 403，未找到或不可见为 404，合法请求遇资源、前置状态、报价或重复载荷冲突为 409。未知错误返回通用 500 与追踪号。暂时无法连接服务返回可重试 503，客户端先核对已有业务结果再重试写入。

| 错误码 | 场景与客户端反馈 |
| --- | --- |
| `VALIDATION_ERROR`、`PERMISSION_DENIED`、`NOT_FOUND` | 字段定位，提示返回有权页面或安全空态 |
| `RESOURCE_CONFLICT`、`SHIFT_CONFLICT` | 班次、牙医或椅位已变，刷新候选或返回原安排 |
| `HOLD_EXPIRED`、`STALE_APPOINTMENT`、`RESCHEDULE_CLOSED`、`CALENDAR_UNAVAILABLE` | 保留原业务，刷新最新预约或返回备选。超期提示实际截止，缺日历承担配置方可处理 |
| `CANCELLATION_QUOTE_CHANGED`、`CANCELLATION_REVIEW_REQUIRED`、`NO_SHOW_NOT_ELIGIBLE` | 更新可见退金金额。达到开始或已签到且未接诊按核实办理，核实前原状态及资金保持。非法爽约保持原状态 |
| `INVALID_TRANSITION`、`EVIDENCE_REQUIRED` | 显示原状态、缺项和允许动作。实际就诊、退款和季度证据独立 |
| `REFUND_LIMIT_EXCEEDED`、`PAYMENT_RESULT_CONFLICT` | 校对成功原款、退款限额和原业务状态，不以客户端状态冲销 |
| `IDEMPOTENCY_CONFLICT`、`REPORT_REFRESH_REQUIRED` | 同键不同载荷禁止覆盖；报表范围或快照失效重查 |

会新增业务事实或资金义务的提交携带 `Idempotency-Key`。身份、命令类型、稳定目标、规范化输入共同确定重放范围。相同键和载荷返回已提交结果，不产生第二笔事实；不同载荷返回冲突。首次临时占位以患者及键在门店事务内串行核对并写现有审计关联。已有聚合的动作在相应行锁内以现有唯一源或审计输入摘要核对。资金使用已存在的支付 token 或收退幂等键；重复开单、开始接诊、获批差额和季度修订同时有相应唯一约束和结果回读。作用域按服务端会话确定。前端记录动作键及业务编号用于超时查询，不更换同一写入的键来重试。

首次占位或诊疗收款响应丢失且业务编号未知时，先走对应 `by-action` 只读接口。查询重新校验当前授权及原动作主体，禁止跨主体或跨目标查询。回读 404 表示当前没有可见的已提交记录，仍允许办理时可以保持原键和载荷提交，由原写入事务处理可能尚在途或已经提交的并发请求。

## 界面与契约对照

| 审核版界面 | 主契约 |
| --- | --- |
| 网站排班与预约及预约侧栏 | schedule、shift-demands、shifts、chairs、appointments、holds、deposit-payments 与 deposit-refunds |
| 网站诊疗与就诊详情 | clinical/queue、clinical-context、签到分椅命令、start-visit、visits |
| 网站结算及主单 | billing/queue、invoice、invoices、corrections、payments、refunds |
| 网站项目与价格 | catalog/treatments 及对应 prices |
| 网站经营、费用及季度对照 | reports/operations、expenses、performance/periods 及 revisions |
| 小程序预约就诊、我的预约和本人资料 | auth/mini、clinics、catalog/treatments、booking/options、holds、appointments、本人资料与本人预约金结果 |

## 工作台与患者连续服务

| 方法与路径 | 数据与适用范围 |
|---|---|
| GET /appointments?date=&clinic_id= | 工作台复用预约读取权限，按 Asia/Shanghai 日期汇总。 |
| GET /clinics/{clinic_id}/patient-directory?q=&page= | 本店前台。返回 items、total、page、page_size，条目包括最小身份联络字段及 next_start。姓名模糊匹配，编号和完整电话匹配。 |
| GET /clinics/{clinic_id}/patients/{patient_id}?page= | 本店前台且患者与本店有关联。返回 patient、appointments、total、page、page_size。预约行含编号、时间、状态、牙医及主项目，以及有记录时的就诊标识、状态和主单编号。返回结算交接所需字段。 |
| GET /appointments/{id}/clinical-context | 仅当次责任牙医。返回当前必要的过敏资料和当店核对历史，及同店历史就诊的状态、日期和实际项目摘要。历史临床原文依既有就诊详情授权读取。 |
| POST /appointments/{id}/allergy-reviews | 责任牙医在签到至关单前提交，带动作键、expected_claim_id、expected_version、status、allergies。status 为 KNOWN 或 NONE_KNOWN。已知过敏须有 allergen，notes 可选。409 STALE_ALLERGY_REVIEW 重新读取。201 为新增，200 为同动作重放。 |
| GET /visits/{id} | 责任牙医的临床投影返回该次就诊原文，以及接诊门店当次过敏核对。前台投影仅含结算交接数据。 |
| GET /billing/queue | 本店前台按授权门店查询，支持 clinic_id、status、cursor。可选请求头 X-ADC-Queue-Search 使用 UTF-8 百分号编码传递姓名、完整手机号码、预约或主单编号。每页 20 笔，按结束时间和就诊编号倒序，响应包含 items 和 next_cursor，号码仅投影必要尾号。待退款可筛到仍有可退余额且另有退款在途的主单。 |
| GET /appointments、GET /patients/me | 小程序复用患者范围、预约与本人资料。 |

## 课程补充接口

路径均以 /api/v1 开头。响应沿用项目的 data 和 error 封装。

| 需求 | 方法及相对路径 | 请求与返回 |
| --- | --- | --- |
| FR-010 | GET /workbench/alerts | 可按 clinic_id、date 过滤。网站员工使用，返回 schedule、clinical、billing、reconciliation、corrections 五个布尔值。 |
| FR-011、产品任务 04 | GET、POST /admin/clinics；PATCH /admin/clinics/{id} | 全局权限管理员维护 `clinic_no,name,address,phone,email,status`。停用门店停止新增业务，释放未确认占位，原预约及历史仍可由有权员工办理。 |
| FR-011、产品任务 04 | POST /admin/access/employees；POST /admin/access/employees/{id}/account | 全局权限管理员登记工号、姓名、岗位和所属门店，可同时开通普通账号，也可单独开通。写入需 `Idempotency-Key`，账号配置与功能授权分开，密码只用于生成存储哈希。 |
| FR-101、FR-201、FR-501、产品任务 04 | GET、POST /admin/qualifications、/admin/dentist-qualifications；PATCH 对应记录 | 全局配置或权限管理员分别维护资质类型、牙医证书与有效期。证书更新保留牙医及资质关联。同一牙医同类证书有效期不得重叠。 |
| FR-202、FR-302、产品任务 04 | GET、POST /admin/chairs；PATCH /admin/chairs/{id} | 全局配置或权限管理员维护所属门店、编号、类型和可用状态。更新须保留已有预约容量和分配关系。 |
| FR-305、FR-501、产品任务 04 | GET、POST /admin/materials；PATCH /admin/materials/{id}；GET、POST /admin/materials/{id}/costs | 全局配置或权限管理员维护编码、名称、单位、状态及单位成本版本。生效区间左闭右开，版本不得重叠。历史诊疗用量保留实施时的名称、单位及成本。 |
| FR-011 | GET /admin/access | 返回可选门店、员工档案、账号状态、全部有效功能权限及其范围，并标注哪些授权由部署维护。 |
| FR-011 | POST /admin/access/employees/{employee_id}/grants | 传 role_code、clinic_id、expected_granted、granted、reason 和 Idempotency-Key。 |
| FR-011、产品任务 02 | POST /admin/access/employees/{employee_id}/profile | 管理员提交 job_code、home_clinic_id、expected_job_code、expected_home_clinic_id、reason 与 Idempotency-Key。仅更新独立岗位资料并审计。总部岗位的 home_clinic_id 为空，三个门店岗位须指定所属门店。 |
| FR-011 | POST /admin/access/employees/{employee_id}/account-status | 传 expected_status、status、reason 和 Idempotency-Key。已过期状态返回 STALE_ACCESS_STATE，要求查新后提交。 |
| FR-409 | GET /billing/reconciliation | 须指定 clinic_id、date。返回上海营业日、统计截止、历史日标识、totals、settled、pending、refund_due、retained 和适用的原业务引用。 |
| FR-410 | GET /patients/me/invoices | 患者会话。可按 appointment_id 查本人记录，支持 limit、cursor 和 next_cursor。 |
| FR-410 | GET /patients/me/invoices/{invoice_id} | 患者可查看自己的门店、就诊日期、原主单、冻结行、应缴、诊疗收退、欠款和入账差额。异人编号返回与缺失编号相同的 404。 |
| FR-606、FR-607 | GET /reports/operations/assistant/suggestions | 复用经营报告日期、门店和牙医范围参数，返回允许的主动建议和可编辑默认条件。 |
| FR-606、FR-607 | POST /reports/operations/assistant/analysis | 支持 metric 或 question 二选一，并附带本期、可选对比期和报告授权范围、Idempotency-Key 请求头。返回结构化分析、来源、后续选项及 analysis_id。同键同范围同载荷复用结果。 |
| FR-606、FR-607 | GET /reports/operations/assistant/analysis | 使用 analysis_id 回查本账号当前范围仍有效的分析。 |
| FR-607 | GET /reports/operations/assistant/analysis/by-action | 传原 Idempotency-Key。按原账号和现行授权回查；处理中、已过期或同键异载荷分别返回明确状态。 |
| FR-607 | GET /reports/operations/assistant/report | 使用本地签名 reference 打开原报表。快照失效时，在权限允许的前提下按原筛选重新查询并标注新旧截止。 |

权限管理页的 GET /admin/access/employees/{id}/history 仅允许总部权限管理账号读取，返回指定员工最近 50 条岗位资料、授权或账号状态变更，包含原因、操作者、时间及白名单中的变更前后值。对应 FR-011。
