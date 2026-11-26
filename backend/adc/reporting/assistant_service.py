from datetime import date, timedelta
from decimal import Decimal
from http.client import HTTPException
from urllib.error import URLError

from django.conf import settings
from django.core import signing
from django.core.cache import caches
from django.db import connection, transaction
from django.utils.timezone import now

from adc.common.http import ApiProblem
from adc.identity.audit import record_event
from adc.identity.models import AuditLog, Clinic
from adc.identity.permissions import current_principal
from adc.reporting.assistant_actions import accepted_action, claim_analysis, require_action_result, require_action_scope
from adc.reporting.assistant_intent import (
    BUSINESS_METRICS, MAX_DAYS, METRICS, MONEY_METRICS, POLICIES, POLICY_TOPICS, POLICY_VERSION, SOURCES_BY_METRIC,
    compile_question, periods_valid, previous_window, selection_data, week_windows,
)
from adc.reporting.assistant_provider import InvalidModel, Tool, arrange
from adc.reporting.fact_queries import consistent_read
from adc.reporting.operations_service import APPOINTMENT_GROUPS, authorized_filters, rate, report
from adc.reporting.period_locks import BUSINESS_ZONE
from adc.reporting.permissions import QUERY
from adc.reporting.snapshots import binding, read_snapshot, store_snapshot


LOOKUP_TTL = 30 * 60
REFERENCE_SALT = "adc.assistant.report.v1"
MODEL_ACCOUNT_LIMIT = 6
MODEL_GLOBAL_LIMIT = 30


def available_clinics(principal):
    clinic_ids, _ = authorized_filters(principal, {})
    return [
        {"clinic_id": str(pk), "name": name}
        for pk, name in Clinic.objects.filter(pk__in=clinic_ids).order_by("pk").values_list("pk", "clinic_name")
    ]


def suggestions(principal, filters):
    clinic_ids, dentist_ids = authorized_filters(principal, filters)
    clinics = available_clinics(principal)
    end = filters["date_to"]
    days = min((end - filters["date_from"]).days, MAX_DAYS - 1)
    current = {"date_from": end - timedelta(days=days), "date_to": end,
               "clinic_ids": clinic_ids, "dentist_ids": dentist_ids}
    items = [
        ("unprocessed", "看哪些门店到期未处置较多", {**current, "metric": "unprocessed"}),
        ("net_received", "本期诊疗净实收为什么变化", {**current, "metric": "net_received"}),
        ("deposit_refund", "查询预约金退还规则", {**current, "metric": "deposit_refund"}),
        ("clinic_performance", "哪家诊所经营表现更好", {**current, "metric": "net_profit"}),
        ("month_attendance", "本月预约履约情况如何", {**current, "date_from": end.replace(day=1), "metric": "attendance_rate"}),
        ("low_utilization", "哪些门店资源利用率较低", {**current, "metric": "chair_utilization"}),
        ("top_workload", "哪些牙医工作量较大", {**current, "metric": "workload"}),
        ("revenue_cost_change", "近期收入与成本发生了什么变化", {**current, "metric": "business_change"}),
    ]
    try:
        items[1][2].update(previous_window(current["date_from"], current["date_to"]))
        items[-1][2].update(previous_window(current["date_from"], current["date_to"]))
    except OverflowError:
        pass
    if len(clinics) >= 2:
        allowed = [int(item["clinic_id"]) for item in clinics]
        two_clinics = list(dict.fromkeys([*clinic_ids, *allowed]))[:2]
        weeks = week_windows(now().astimezone(BUSINESS_ZONE).date())
        items.insert(0, ("weekly_attendance", "对比两店本周与上周的实际就诊率", {
            **current, **weeks, "clinic_ids": two_clinics, "metric": "attendance_rate",
        }))
    return {"clinics": clinics, "suggestions": [
        {"id": key, "label": label, "selection": selection_data(selection)} for key, label, selection in items
    ]}


def require_same_scope(principal, expected, filters):
    if binding(principal) != expected:
        raise ApiProblem(403, "PERMISSION_DENIED", "经营查询授权已变化，请重新分析。")
    authorized_filters(principal, filters)


def fresh_scope(principal, filters):
    current = current_principal(principal.account_id, "staff")
    if current is None:
        raise ApiProblem(401, "AUTHENTICATION_REQUIRED", "请登录后继续。")
    current.require(QUERY)
    require_same_scope(current, binding(principal), filters)


def report_reference(principal, metadata, report_token):
    return signing.dumps({
        "binding": binding(principal), "report_token": report_token,
        "date_from": metadata["date_from"], "date_to": metadata["date_to"],
        "scope": metadata["scope"], "as_of": metadata["as_of"],
    }, salt=REFERENCE_SALT)


def stored_filters(source):
    return {
        "date_from": date.fromisoformat(source["date_from"]), "date_to": date.fromisoformat(source["date_to"]),
        "clinic_ids": list(map(int, source["scope"]["clinic_ids"])),
        "dentist_ids": list(map(int, source["scope"]["dentist_ids"])),
    }


def original_report(principal, reference):
    try:
        original = signing.loads(reference, salt=REFERENCE_SALT)
    except signing.BadSignature:
        raise ApiProblem(400, "VALIDATION_ERROR", "报告引用无效，请重新分析。") from None
    filters = stored_filters(original)
    require_same_scope(principal, original["binding"], filters)
    token = original["report_token"]
    snapshot = read_snapshot(principal, token)
    refreshed = snapshot is None
    if snapshot is None:
        with consistent_read():
            metadata, results, details = report(principal, filters, now())
        token = store_snapshot(principal, metadata, details, results=results)
    else:
        metadata, results = snapshot["metadata"], snapshot["results"]
    return {**metadata, **results, "report_token": token, "snapshot_refreshed": refreshed, "original_as_of": original["as_of"]}


def result_for(principal, analysis_id):
    cached = caches["report_snapshots"].get("assistant:" + analysis_id)
    if cached is None:
        raise ApiProblem(409, "RESULT_EXPIRED", "本次分析已失效，请重新分析。")
    result = cached["result"]
    require_same_scope(principal, cached["binding"], stored_filters(result))
    return result


def recover_analysis(principal, operation, accepted=None):
    accepted = accepted if accepted is not None else accepted_action(operation)
    if accepted is None:
        raise ApiProblem(404, "NOT_FOUND", "尚未找到原分析请求。")
    require_action_scope(principal, accepted)
    try:
        return result_for(principal, accepted.after_value["analysis_id"])
    except ApiProblem as error:
        if error.code != "RESULT_EXPIRED":
            raise
        require_action_result(accepted)


def percent_value(rate):
    if not rate or rate.get("availability") != "AVAILABLE" or rate.get("value") is None:
        return None
    return format(Decimal(rate["value"]) * 100, ".2f")


def approved_metrics(metric, results, details):
    if metric == "net_received":
        return [{
            "clinic_id": None, **{key: results["financial"][key] for key in ("received", "refunded", "net_received")},
            "receipt_count": len(details["net_received"]),
        }]
    if metric in MONEY_METRICS:
        return [{
            "clinic_id": row["clinic_id"], "clinic_name": row.get("clinic_name"),
            "value": row[metric], "display_label": METRICS[metric], "display": "¥" + row[metric],
        } for row in results.get("clinics", [])]
    if metric == "visits":
        return [{
            "clinic_id": row["clinic_id"], "clinic_name": row.get("clinic_name"),
            "value": row["visits"], "display_label": "就诊数量", "display": str(row["visits"]) + " 次",
        } for row in results.get("clinics", [])]
    if metric == "workload":
        return [{
            "clinic_id": row["clinic_id"], "clinic_name": row.get("clinic_name"),
            "dentist_id": row["dentist_id"], "dentist_name": row["dentist_name"],
            "value": row["minutes"], "display_label": "牙医工作量",
            "display": row["hours"] + " 小时 / " + str(row["visits"]) + " 次",
        } for row in results.get("workload", {}).get("dentists", [])]
    if metric == "chair_utilization":
        return [{
            "clinic_id": row["clinic_id"], "clinic_name": row.get("clinic_name"),
            "chair_utilization": row["chair_utilization"],
            "value": percent_value(row["chair_utilization"]), "display_label": "诊椅利用率",
            "display": (percent_value(row["chair_utilization"]) or "不适用") + "%",
        } for row in results.get("clinics", [])]
    if metric == "business_change":
        operation = results.get("operations", {})
        finance = {key: operation.get(key, "0.00") for key in ("revenue", "material_cost", "operating_cost", "net_profit")}
        return [{
            "clinic_id": None, "finance": finance, "display_label": "收入与成本",
            "display": "收入 ¥" + finance["revenue"] + " · 成本 ¥" + finance["material_cost"]
                       + " · 费用 ¥" + finance["operating_cost"] + " · 利润 ¥" + finance["net_profit"],
        }]
    rows = []
    for office in results["appointments"]["by_clinic"]:
        denominator = sum(office[key] for key in APPOINTMENT_GROUPS[:4])
        key = "attended" if metric == "attendance_rate" else "unprocessed"
        rows.append({
            "clinic_id": office["clinic_id"],
            metric: rate(office[key], denominator, incomplete=bool(office["unclassified"])),
        })
    return rows


def comparisons(metric, periods):
    if len(periods) < 2:
        return None
    current, earlier = (periods[0]["metrics"], periods[1]["metrics"])
    if metric in MONEY_METRICS:
        return {"changes": [{
            "clinic_id": row["clinic_id"],
            "value": format(Decimal(row["value"]) - Decimal(prior["value"]), ".2f"),
            "display": ("+" if Decimal(row["value"]) - Decimal(prior["value"]) > 0 else "") +
                       "¥" + format(Decimal(row["value"]) - Decimal(prior["value"]), ".2f"),
        } for row, prior in zip(current, earlier, strict=True)]}
    if metric == "visits":
        return {"changes": [{
            "clinic_id": row["clinic_id"], "value": row["value"] - prior["value"],
            "display": ("+" if row["value"] - prior["value"] > 0 else "") + str(row["value"] - prior["value"]) + " 次",
        } for row, prior in zip(current, earlier, strict=True)]}
    if metric == "workload":
        prior_by_dentist = {(row["clinic_id"], row.get("dentist_id")): row for row in earlier}
        changes = []
        for row in current:
            prior = prior_by_dentist.get((row["clinic_id"], row.get("dentist_id")))
            if prior is None:
                continue
            minutes = Decimal(row["value"]) - Decimal(prior["value"])
            changes.append({"clinic_id": row["clinic_id"], "dentist_id": row.get("dentist_id"),
                            "dentist_name": row.get("dentist_name"), "value": format(minutes, ".2f"),
                            "display": ("+" if minutes > 0 else "") + format(minutes / Decimal("60"), ".2f") + " 小时"})
        return {"changes": changes}
    if metric == "chair_utilization":
        changes = []
        for row, prior in zip(current, earlier, strict=True):
            if row["value"] is None or prior["value"] is None:
                changes.append({"clinic_id": row["clinic_id"], "percentage_points": None, "availability": "NOT_APPLICABLE"})
            else:
                difference = Decimal(row["value"]) - Decimal(prior["value"])
                changes.append({"clinic_id": row["clinic_id"], "value": format(difference, ".2f"),
                                "display": ("+" if difference > 0 else "") + format(difference, ".2f") + " 个百分点"})
        return {"changes": changes}
    if metric == "business_change":
        now_finance = current[0]["finance"]
        prior_finance = earlier[0]["finance"]
        keys = ("revenue", "material_cost", "operating_cost", "net_profit")
        values = {key: format(Decimal(now_finance.get(key, "0.00")) - Decimal(prior_finance.get(key, "0.00")), ".2f")
                  for key in keys}
        return {"changes": [{"clinic_id": None, **values,
                             "display": " · ".join(f"{METRICS[key]} {'+' if Decimal(values[key]) > 0 else ''}¥{values[key]}" for key in keys)}]}
    changes = []
    for row, prior in zip(current, earlier, strict=True):
        if metric == "net_received":
            changes.append({"clinic_id": None, **{
                key: format(Decimal(row[key]) - Decimal(prior[key]), ".2f")
                for key in ("received", "refunded", "net_received")
            }})
        else:
            value, baseline = row[metric]["value"], prior[metric]["value"]
            difference = None if value is None or baseline is None else (Decimal(value) - Decimal(baseline)) * 100
            change = {"clinic_id": row["clinic_id"],
                      "percentage_points": None if difference is None else format(difference, ".2f")}
            if difference is None:
                availability = {row[metric]["availability"], prior[metric]["availability"]}
                change["availability"] = "MISSING" if "MISSING" in availability else "NOT_APPLICABLE"
            changes.append(change)
    return {"changes": changes}


def policy_sources(metric):
    return {key: {"id": key, "title": POLICIES[key][0], "summary": POLICIES[key][1], "version": POLICY_VERSION}
            for key in SOURCES_BY_METRIC[metric]}


def business_interpretations(metric, periods, comparison, sources):
    observations, questions, next_steps = {}, {}, []
    source_id = next(iter(sources), "FR-604")
    rows = periods[0]["metrics"] if periods else []
    summary = periods[0].get("summary", {}) if periods else {}
    clinic_ids = {row["clinic_id"] for row in rows if row.get("clinic_id")}
    clinic_names = dict(Clinic.objects.filter(pk__in=clinic_ids).values_list("pk", "clinic_name"))
    names_by_id = {str(row["clinic_id"]): row.get("clinic_name") for row in rows if row.get("clinic_name")}

    def office_name(clinic_id):
        if str(clinic_id) in names_by_id:
            return names_by_id[str(clinic_id)]
        try:
            return clinic_names.get(int(clinic_id), str(clinic_id))
        except (TypeError, ValueError):
            return str(clinic_id)

    def observe(key, text):
        observations[key] = (text, source_id)

    if metric in MONEY_METRICS:
        numeric = [(row["clinic_id"], Decimal(row["value"])) for row in rows]
        total = sum((value for _, value in numeric), Decimal("0.00"))
        ranked = sorted(numeric, key=lambda item: item[1], reverse=True)
        label = METRICS[metric]
        if ranked:
            observe("total", f"本期{label}合计 ¥{format(total, '.2f')}，{office_name(ranked[0][0])}门店最高 ¥{format(ranked[0][1], '.2f')}。")
            observe("ranking", f"{office_name(ranked[0][0])}门店最高（¥{format(ranked[0][1], '.2f')}），"
                               f"{office_name(ranked[-1][0])}门店最低（¥{format(ranked[-1][1], '.2f')}）。")
        if metric in {"material_cost", "operating_cost"} and Decimal(summary.get("revenue", "0")) > 0:
            observe("ratio", f"{label}占营业收入 "
                             f"{format(Decimal(summary.get(metric, '0')) / Decimal(summary['revenue']) * 100, '.1f')}%。")
        if metric == "net_profit" and Decimal(summary.get("revenue", "0")) > 0:
            observe("margin", f"公司净利润率约 "
                              f"{format(Decimal(summary['net_profit']) / Decimal(summary['revenue']) * 100, '.1f')}%。")
    elif metric == "visits":
        numeric = [(row["clinic_id"], int(row["value"])) for row in rows]
        total = sum(value for _, value in numeric)
        observe("total", f"本期完成就诊 {total} 次。")
        if numeric:
            top = max(numeric, key=lambda item: item[1])
            observe("ranking", f"{office_name(top[0])}门诊就诊量最高，共 {top[1]} 次。")
    elif metric == "workload":
        numeric = [(row, Decimal(row["value"])) for row in rows]
        total_minutes = sum((value for _, value in numeric), Decimal("0"))
        observe("total", f"本期牙医实际计时合计 {format(total_minutes / Decimal('60'), '.1f')} 小时。")
        if numeric:
            top = max(numeric, key=lambda item: item[1])
            observe("ranking", f"{top[0].get('dentist_name')}（{office_name(top[0]['clinic_id'])}）工作量最高，"
                               f"约 {format(top[1] / Decimal('60'), '.1f')} 小时。")
    elif metric == "chair_utilization":
        numeric = [(row["clinic_id"], Decimal(row["value"])) for row in rows if row.get("value") is not None]
        if numeric:
            low = min(numeric, key=lambda item: item[1])
            high = max(numeric, key=lambda item: item[1])
            observe("total", f"诊椅时段利用率最低为 {office_name(low[0])}（{format(low[1], '.1f')}%），"
                             f"最高为 {office_name(high[0])}（{format(high[1], '.1f')}%）。")
            observe("advice", "利用率偏低通常意味着开放时段与预约需求不匹配，可核对班次与牙椅开放时间。")
        else:
            observe("missing", "所选期间缺少可用的诊椅开放时段或牙椅资料。")
    elif metric == "business_change":
        current = summary
        if current:
            observe("current", f"本期营业收入 ¥{current.get('revenue')}，诊疗成本 ¥{current.get('material_cost')}，"
                               f"经营费用 ¥{current.get('operating_cost')}，净利润 ¥{current.get('net_profit')}。")
        if comparison:
            change = comparison["changes"][0]
            parts = [f"{METRICS[key]} {'+' if Decimal(change[key]) > 0 else ''}¥{change[key]}"
                     for key in ("revenue", "material_cost", "operating_cost", "net_profit")]
            observe("change", "与对比期相比：" + "，".join(parts) + "。")
            observe("quality", "收入增长若伴随成本或费用上升，需要结合耗材与经营费用明细核对利润质量。")
        else:
            next_steps.append({"id": "change_period", "label": "选择对比期"})

    if metric in {"business_change", "workload", "chair_utilization", "visits"}:
        next_steps.append({"id": "report_rules", "label": "查看统计口径"})
    else:
        next_steps.append({"id": "report_rules", "label": "查看统计口径"})
    questions["source"] = "可打开所选期间的原报表，回到主单、耗材、计时或预约记录逐项核对。"
    return observations, questions, next_steps


def interpretations(metric, periods, comparison, sources):
    if metric in BUSINESS_METRICS:
        return business_interpretations(metric, periods, comparison, sources)
    observations = {}
    questions = {}
    next_steps = []
    if metric in POLICY_TOPICS:
        for index, (source, rule) in enumerate(sources.items()):
            key = "refund_rules" if metric == "deposit_refund" and index == 0 else source
            observations[key] = (rule["summary"], source)
        return observations, questions, next_steps

    if metric == "net_received":
        observations["net_receipts"] = ("诊疗净实收由成功收款和成功退款共同决定。", "FR-405")
        if comparison:
            observations["net_change"] = ("两期净实收差额可由实收差额减去退款差额核对。", "FR-405")
        questions["receipt_timing"] = "需要解释波动时，可核对成功收退款的回执日期。"
        eligible = next((index for index, period in enumerate(periods)
                         if any(row["receipt_count"] for row in period["metrics"])), None)
        if eligible is not None:
            next_steps.append({"id": "money_breakdown", "label": "查看收退构成", "period_index": eligible})
        else:
            observations["no_receipts"] = ("所选期间没有成功的诊疗收退款回执。", "FR-405")
            next_steps.append({"id": "change_period", "label": "换一个期间"})
        return observations, questions, next_steps

    if metric == "attendance_rate":
        observations["attendance"] = ("按正式预约口径核对实际就诊率。", "FR-603")
    else:
        observations["unprocessed"] = ("用共用分母核对各店到期未处置的件数和占比。", "FR-602")
    if comparison and any(row["percentage_points"] is not None for row in comparison["changes"]):
        observations["rate_change"] = ("百分点变化按本期比率减对比期比率计算。", "FR-603")
    metric_rows = [row[metric] for period in periods for row in period["metrics"]]
    if any(row["availability"] == "NOT_APPLICABLE" for row in metric_rows):
        observations["no_denominator"] = ("部分门店或期间的共用分母为零，比率不适用。", "FR-603")
    if any(row["availability"] == "MISSING" for row in metric_rows):
        observations["missing_facts"] = ("部分预约归类资料尚缺，相关比率待核实。", "FR-603")
    if any(row["availability"] != "AVAILABLE" for row in metric_rows):
        next_steps.append({"id": "change_period", "label": "换一个期间"})
    if metric == "unprocessed":
        eligible = next((index for index, period in enumerate(periods)
                         if any(row[metric]["numerator"] for row in period["metrics"])), None)
        if eligible is not None:
            next_steps.append({"id": "unprocessed_details", "label": "查看同范围异常明细", "period_index": eligible})
    next_steps.append({"id": "report_rules", "label": "查看统计口径"})
    questions["unprocessed_reason"] = "要解释到期未处置的原因，可由门店核实排班和签到情况。"
    return observations, questions, next_steps


def model_context(metric, scopes, periods, comparison, sources, observations, questions):
    aliases = {clinic_id: f"clinic_{index}" for index, clinic_id in enumerate(scopes, start=1)}
    windows = [{key: period[key] for key in ("date_from", "date_to")} for period in periods]
    def anonymize(row):
        return {**row, "clinic_id": aliases.get(row["clinic_id"])}
    approved = [{**window, "metrics": [anonymize(row) for row in period["metrics"]]}
                for window, period in zip(windows, periods, strict=True)]
    intent = {"metric": metric, "periods": windows, "clinic_aliases": list(aliases.values())}
    candidates = {
        "observations": [{"id": key, "text": value[0], "source_id": value[1]}
                         for key, value in observations.items()],
        "questions": [{"id": key, "text": text} for key, text in questions.items()],
        "sources": list(sources.values()),
    }
    topic = metric if metric in POLICY_TOPICS else ("cash_flow" if metric == "net_received" else "report_rules")
    tools = {
        "search_policy": Tool("检索当前主题的批准制度条款。", {"topic": topic},
                              {"sources": list(sources.values()), **(candidates if metric in POLICY_TOPICS else {})}),
    }
    required = "search_policy"
    if periods:
        tools["get_summary"] = Tool("获取本期授权汇总及可用观察。", {"period": "current"},
                                    {"period": approved[0], "source_ids": list(sources), **candidates})
        required = "get_summary"
    if comparison:
        changes = [anonymize(row) for row in comparison["changes"]]
        tools["compare_reports"] = Tool("比较本期与编辑后确认的对比期。", {"comparison": "selected"},
                                        {"periods": approved, "changes": changes, "source_ids": list(sources), **candidates})
        required = "compare_reports"
    elif approved and len(approved[0]["metrics"]) > 1:
        tools["compare_reports"] = Tool("比较本期已选门店的同口径汇总。", {"comparison": "clinics"},
                                        {"periods": approved, "source_ids": list(sources), **candidates})
    return intent, tools, required


def reserve_model(principal, intent):
    # The existing audit table provides a cross-worker budget without a process-local counter.
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ["adc-operations-assistant-budget"])
        recent = AuditLog.objects.filter(action="ASSISTANT_MODEL_STARTED", occurred_at__gte=now() - timedelta(hours=1))
        if recent.count() >= MODEL_GLOBAL_LIMIT or recent.filter(account_id=principal.account_id).count() >= MODEL_ACCOUNT_LIMIT:
            return False
        record_event(account_id=principal.account_id, action="ASSISTANT_MODEL_STARTED", target_type="operations_assistant",
                     target_id=None, visible_fields=("intent", "status"), after={"intent": intent, "status": "started"})
    return True


def validate_model(output, observations, questions, sources):
    catalogs = {"observations": observations, "questions": questions, "sources": sources}
    if not isinstance(output, dict) or output.keys() != catalogs.keys():
        raise InvalidModel
    for field, catalog in catalogs.items():
        keys = output[field]
        if not isinstance(keys, list) or len(keys) > len(catalog) or any(
            not isinstance(key, str) or key not in catalog for key in keys
        ) or len(set(keys)) != len(keys):
            raise InvalidModel
    if not output["observations"] or any(observations[key][1] not in output["sources"] for key in output["observations"]):
        raise InvalidModel


def model_answer(principal, filters, intent, tools, required, observations, questions, sources):
    db = connection.settings_dict
    if not (
        settings.ADC_ASSISTANT_DEEPSEEK_ENABLED and settings.ADC_DEEPSEEK_API_KEY
        and settings.ADC_ENV in {"local", "experience"} and settings.ADC_ASSISTANT_SYNTHETIC_ENV == settings.ADC_ENV
        and settings.ADC_ASSISTANT_SYNTHETIC_HOST and settings.ADC_ASSISTANT_SYNTHETIC_HOST == db["HOST"]
        and settings.ADC_ASSISTANT_SYNTHETIC_PORT == str(db["PORT"])
        and settings.ADC_ASSISTANT_SYNTHETIC_DB and settings.ADC_ASSISTANT_SYNTHETIC_DB == db["NAME"]
    ):
        return "disabled", None
    fresh_scope(principal, filters)
    if not reserve_model(principal, intent):
        return "limit_reached", None
    used, usage = [], {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
    output, status = None, "invalid_model"
    try:
        candidate = arrange(intent, tools, required, lambda: fresh_scope(principal, filters), used, usage)
        validate_model(candidate, observations, questions, sources)
        for key in ("no_denominator", "missing_facts", "no_receipts"):
            if key in observations and key not in candidate["observations"]:
                candidate["observations"].append(key)
                source = observations[key][1]
                if source not in candidate["sources"]:
                    candidate["sources"].append(source)
        candidate["questions"].extend(key for key in questions if key not in candidate["questions"])
        output, status = candidate, "completed"
    except (OSError, URLError, HTTPException):
        status = "unavailable"
    except ApiProblem:
        status = "scope_changed"
        raise
    except (ValueError, TypeError, AttributeError, KeyError, IndexError, RecursionError):
        pass
    finally:
        record_event(account_id=principal.account_id, action="ASSISTANT_MODEL_FINISHED", target_type="operations_assistant",
                     target_id=None, visible_fields=("intent", "tools", "status", "usage"),
                     after={"intent": intent, "tools": used, "status": status, "usage": usage})
    return status, output


def prepare_analysis(principal, fields, cutoff):
    if "question" in fields:  # Discard the original text before claiming an operation.
        authorized_filters(principal, fields)
        question = fields.pop("question")
        fields = compile_question(question, fields, available_clinics(principal), cutoff.astimezone(BUSINESS_ZONE).date())
    metric = fields["metric"]
    first, last = fields["date_from"], fields["date_to"]
    periods_valid(first, last)
    queries = [{key: fields[key] for key in ("date_from", "date_to", "clinic_ids", "dentist_ids") if key in fields}]
    if metric not in POLICY_TOPICS and "comparison_date_from" in fields:
        start, end = fields["comparison_date_from"], fields["comparison_date_to"]
        periods_valid(start, end)
        queries.append({**queries[0], "date_from": start, "date_to": end})
    clinic_ids, dentist_ids = authorized_filters(principal, queries[0])
    report_filters = dict(clinic_ids=clinic_ids, dentist_ids=dentist_ids)
    selected_queries = [{**query, **report_filters} for query in queries]
    return metric, selected_queries, report_filters


def analyze(principal, fields, operation):
    cutoff = now()
    metric, queries, report_filters = prepare_analysis(principal, fields, cutoff)
    accepted, created = claim_analysis(principal, operation, {"metric": metric, "queries": list(map(selection_data, queries))})
    if not created:
        return recover_analysis(principal, operation, accepted)

    first, last = queries[0]["date_from"], queries[0]["date_to"]
    with consistent_read():
        snapshots = [report(principal, query, cutoff) for query in queries] if metric not in POLICY_TOPICS else []
    scope = {key: list(map(str, value)) for key, value in report_filters.items()}
    periods = []
    for metadata, results, details in snapshots:
        token = store_snapshot(principal, metadata, details, results=results)
        periods.append({
            **{key: metadata[key] for key in ("date_from", "date_to", "as_of", "scope")},
            "reference": report_reference(principal, metadata, token),
            "metrics": approved_metrics(metric, results, details),
            "summary": results.get("operations", {}),
        })
    comparison = comparisons(metric, periods)
    sources = policy_sources(metric)
    observations, questions, next_steps = interpretations(metric, periods, comparison, sources)
    intent, tools, required = model_context(metric, scope["clinic_ids"], periods, comparison, sources, observations, questions)
    status, answer = model_answer(principal, report_filters, intent, tools, required, observations, questions, sources)
    fresh_scope(principal, report_filters)

    result = {
        "analysis_id": accepted.after_value["analysis_id"], "metric": metric, "date_from": first.isoformat(), "date_to": last.isoformat(),
        "as_of": cutoff.astimezone(BUSINESS_ZONE).isoformat(), "scope": scope,
        "mode": "deepseek" if answer else "template", "model_status": status, "periods": periods,
        "comparison": comparison, "next_steps": next_steps,
        "observations": [{"id": key, "text": observations[key][0], "source_id": observations[key][1]}
                         for key in (answer["observations"] if answer else observations)],
        "questions": [{"id": key, "text": questions[key]} for key in (answer["questions"] if answer else questions)],
        "sources": [sources[key] for key in (answer["sources"] if answer else sources)],
    }
    caches["report_snapshots"].set("assistant:" + result["analysis_id"], {"result": result, "binding": binding(principal)}, LOOKUP_TTL)
    return result
