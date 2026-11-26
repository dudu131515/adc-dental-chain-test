from datetime import date, timedelta
import re
import unicodedata

from adc.common.http import ApiProblem


METRICS = {
    "attendance_rate": "实际就诊率",
    "unprocessed": "到期未处置",
    "net_received": "诊疗净实收",
    "deposit_refund": "预约金退还规则",
    "report_rules": "预约统计口径",
}
POLICY_TOPICS = {"deposit_refund", "report_rules"}
POLICY_VERSION = "ADC 系统规约 · 2026-11-25"
POLICIES = {
    "FR-602": ("正式预约的归期和共享分母", "按最终时段的本地日期归期，已到期的接诊、患者取消、已核实爽约及未处置预约共用分母。诊所取消另列。"),
    "FR-603": ("实际就诊率和缺项", "实际接诊数除以共用分母。分母为零时显示不适用，资料缺失时单独标注。"),
    "FR-604": ("授权经营指标及回查", "授权范围内可核对实收、退款、净实收与来源明细。"),
    "FR-405": ("诊疗资金核算", "净实收为成功收款减成功退款。在途及失败流水不参与净实收，预约金另行核算。"),
    "FR-208": ("预约金取消与退还", "符合普通取消条件时，距离开诊满 24 小时全退，满 2 小时且不足 24 小时退半，不足 2 小时留存。已签到或到开始时点请门店核实。"),
    "FR-207": ("诊所原因取消", "诊所原因无法履约时先协商，无法安排时取消并全额原路退还。"),
    "FR-304": ("实际接诊退金", "实际开始接诊时登记全额原路退还义务，即使退金失败仍保留已接诊事实。"),
    "FR-210": ("退金回执", "匹配的成功回执才记为已退，失败时可以按原业务标识与支付路径重试。"),
}
SOURCES_BY_METRIC = {
    "attendance_rate": ("FR-602", "FR-603"), "unprocessed": ("FR-602", "FR-603"),
    "net_received": ("FR-405", "FR-604"), "report_rules": ("FR-602", "FR-603"),
    "deposit_refund": ("FR-208", "FR-207", "FR-304", "FR-210"),
}
QUESTION_METRICS = {
    **{label: metric for metric, label in METRICS.items()},
    "就诊率": "attendance_rate", "到期未处置数": "unprocessed", "净实收": "net_received",
    "预约金退款规则": "deposit_refund", "统计口径": "report_rules",
}
DATE_TEXT = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
DATE_SPAN = re.compile(rf"从?({DATE_TEXT})(?:至|到|~)({DATE_TEXT})")
MAX_DAYS = 366


def periods_valid(first, last):
    if not first <= last < date.max or (last - first).days >= MAX_DAYS:
        raise ApiProblem(400, "VALIDATION_ERROR", "请选择有效期间，每个期间最多 366 天。")


def week_windows(today):
    current_start = today - timedelta(days=today.weekday())
    return {
        "date_from": current_start, "date_to": today,
        "comparison_date_from": current_start - timedelta(days=7),
        "comparison_date_to": today - timedelta(days=7),
    }


def previous_window(first, last):
    return {
        "comparison_date_from": first - timedelta(days=(last - first).days + 1),
        "comparison_date_to": first - timedelta(days=1),
    }


def selection_data(fields):
    return {key: value.isoformat() if isinstance(value, date) else list(map(str, value)) if key.endswith("_ids") else value
            for key, value in fields.items()}


def compile_question(question, fields, clinics, today):
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", question)).rstrip("?。")
    metrics = re.compile("|".join(map(re.escape, sorted(QUESTION_METRICS, key=len, reverse=True))))
    clinic_names = {}
    for clinic in clinics:
        name = re.sub(r"\s+", "", unicodedata.normalize("NFKC", clinic["name"]))
        if name:
            clinic_names.setdefault(name, []).append(int(clinic["clinic_id"]))
    names = "|".join(map(re.escape, sorted(clinic_names, key=len, reverse=True)))
    scope = r"(?P<two>两家门店|两店)"
    if names:
        scope += rf"|(?P<scope>(?:{names})(?:(?:和|与|、)(?:{names}))*)"
    scope = rf"(?:{scope})?"
    date_filter = r"本期|(?P<weeks>本周(?:与|和|对比)上周)"
    dated = rf"(?:从?{DATE_TEXT}(?:至|到|~){DATE_TEXT})"
    date_filter += rf"|(?P<dates>{dated}(?:(?:对比|和|与){dated})?)"
    prefix = r"(?:请)?(?:查询|查看|分析|对比|看看|看哪些门店)?"
    time_filter = rf"(?:{date_filter})?"
    suffix = rf"的?(?P<metric>{metrics.pattern})(?:为什么变化|的变化|较多)?"
    # Accept date-first and clinic-first queries using the same authorized names.
    match = re.fullmatch(prefix + scope + time_filter + suffix, text)
    if not match:
        match = re.fullmatch(prefix + time_filter + scope + suffix, text)
    problem = ApiProblem(400, "QUESTION_NEEDS_SELECTION", "请通过选项补全门店、统计期间和指标。")
    if not match:
        raise problem
    parsed = match.groupdict()
    metric = QUESTION_METRICS[parsed["metric"]]
    compiled = {**fields, "metric": metric}
    clinic_text = parsed.get("scope")
    if clinic_text:
        named = re.findall(names, clinic_text)
        if any(len(clinic_names[name]) != 1 for name in named):
            raise problem
        compiled["clinic_ids"] = [clinic_names[name][0] for name in named]

    if parsed["two"]:
        allowed = [int(clinic["clinic_id"]) for clinic in clinics]
        if len(allowed) < 2:
            raise problem
        compiled["clinic_ids"] = list(dict.fromkeys([*compiled.get("clinic_ids", []), *allowed]))[:2]

    if parsed["weeks"]:
        compiled.update(week_windows(today))
    elif parsed["dates"]:
        try:
            ranges = [(date.fromisoformat(first), date.fromisoformat(last)) for first, last in DATE_SPAN.findall(parsed["dates"])]
        except ValueError:
            raise problem from None
        compiled.update(zip(("date_from", "date_to"), ranges[0], strict=True))
        if len(ranges) == 2:
            compiled.update(zip(("comparison_date_from", "comparison_date_to"), ranges[1], strict=True))
    if metric == "net_received" and text.endswith("为什么变化") and "comparison_date_from" not in compiled:
        try:
            compiled.update(previous_window(compiled["date_from"], compiled["date_to"]))
        except OverflowError:
            raise problem from None
    return compiled
