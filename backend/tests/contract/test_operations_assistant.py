from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.client import IncompleteRead
from io import BytesIO
import json
from threading import Event
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth.hashers import make_password
from django.core.cache import caches
from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings

from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.clinical.models import Visit
from adc.identity.models import AppRole, AuditLog, Clinic, Employee, EmployeeRole, UserAccount
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


ROOT = "/api/v1/reports/operations/assistant/"
FILTERS = {"date_from": "2031-06-04", "date_to": "2031-06-04", "clinic_ids": [1, 2]}
CUTOFF = datetime.fromisoformat("2031-06-04T22:00:00+08:00")
TRANSPORT = "urllib.request.OpenerDirector.open"


def model_message(*, content=None, tool_calls=None):
    message = {"role": "assistant", "content": json.dumps(content) if content is not None else None}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return BytesIO(json.dumps({"choices": [{"message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
                               "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}).encode())


def tool_call(name, arguments):
    return {"id": "call_1", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


def model_settings(**overrides):
    db = connection.settings_dict
    return override_settings(**{
        "ADC_ENV": "local", "ADC_ASSISTANT_SYNTHETIC_ENV": "local",
        "ADC_ASSISTANT_SYNTHETIC_HOST": db["HOST"], "ADC_ASSISTANT_SYNTHETIC_PORT": str(db["PORT"]),
        "ADC_ASSISTANT_SYNTHETIC_DB": db["NAME"], "ADC_ASSISTANT_DEEPSEEK_ENABLED": True,
        "ADC_DEEPSEEK_API_KEY": "fake-key-for-transport", **overrides,
    })


class OperationsAssistantTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()
        cls.password = make_password("synthetic-assistant-password")

    def login(self, identity="demo.reports"):
        client = Client()
        with override_settings(ADC_STAFF_PASSWORD_HASHES={identity: self.password}):
            response = client.post("/api/v1/auth/web/login", {
                "login_identity": identity, "password": "synthetic-assistant-password",
            }, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        return client


    def analyze(self, client, data, *, key=None):
        return client.post(ROOT + "analysis", {**FILTERS, **data}, content_type="application/json",
                           HTTP_IDEMPOTENCY_KEY=key or str(uuid4()))

    def test_business_questions_use_profit_workload_and_change_evidence(self):
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            ranked = self.analyze(client, {"question": "哪家诊所经营表现更好"})
            self.assertEqual(ranked.status_code, 200, ranked.content)
            ranked_data = ranked.json()["data"]
            self.assertEqual(ranked_data["metric"], "net_profit")
            self.assertTrue(ranked_data["periods"][0]["metrics"])
            self.assertIn("¥", ranked_data["periods"][0]["metrics"][0]["display"])
            self.assertTrue(any("净利润" in item["text"] for item in ranked_data["observations"]))

            workload = self.analyze(client, {"question": "哪些牙医工作量较大"})
            self.assertEqual(workload.status_code, 200, workload.content)
            workload_data = workload.json()["data"]
            self.assertEqual(workload_data["metric"], "workload")
            self.assertTrue(any("牙医实际计时" in item["text"] for item in workload_data["observations"]))

            change = self.analyze(client, {"question": "近期收入与成本发生了什么变化"})
            self.assertEqual(change.status_code, 200, change.content)
            change_data = change.json()["data"]
            self.assertEqual(change_data["metric"], "business_change")
            self.assertIsNotNone(change_data["comparison"])
            self.assertTrue(any(item["id"] == "change" for item in change_data["observations"]))

    def test_suggestions_respect_current_permissions_and_equal_weekday_windows(self):
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            response = client.get(ROOT + "suggestions", {"date_from": "2031-06-01", "date_to": "2031-06-04"})
        self.assertEqual(response.status_code, 200, response.content)
        suggestions = response.json()["data"]["suggestions"]
        self.assertEqual(len(suggestions), 9)
        self.assertIn("clinic_performance", [item["id"] for item in suggestions])
        self.assertIn("top_workload", [item["id"] for item in suggestions])
        weeks = [item for item in suggestions if item["id"] == "weekly_attendance"][0]["selection"]
        self.assertEqual(weeks["date_from"], "2031-06-02")
        self.assertEqual(weeks["date_to"], "2031-06-04")
        self.assertEqual(weeks["comparison_date_from"], "2031-05-26")
        self.assertEqual(weeks["comparison_date_to"], "2031-05-28")
        self.assertEqual(AuditLog.objects.filter(action__startswith="ASSISTANT_MODEL").count(), 0)

        EmployeeRole.objects.filter(employee_id=8, role__role_code="HQ_OPERATIONS_QUERY").update(scope_clinic_id=1)
        response = client.get(ROOT + "suggestions", {"date_from": "2031-06-01", "date_to": "2031-06-04"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(response.json()["data"]["suggestions"]), 8)
        self.assertEqual(self.analyze(client, {"metric": "attendance_rate"}).status_code, 403)

    def test_knowledge_and_bounded_chinese_questions_never_echo_rejected_input(self):
        client = self.login()
        for question in ("查看实际就诊率以及张三的过敏病历", "实际就诊率 13812345678", "请计算库存", "", "合成甲店 2031-06-04"):
            with self.subTest(question=question):
                response = self.analyze(client, {"question": question})
                self.assertEqual(response.status_code, 400, response.content)
                if question:
                    self.assertNotContains(response, question, status_code=400)

        response = self.analyze(client, {"question": "查询合成甲店2031-06-01至2031-06-02的实际就诊率"})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["periods"][0]["scope"]["clinic_ids"], ["1"])
        self.assertEqual(data["periods"][0]["date_to"], "2031-06-02")
        self.assertEqual(data["periods"][0]["metrics"][0]["attendance_rate"]["availability"], "NOT_APPLICABLE")
        self.assertIsNone(data["periods"][0]["metrics"][0]["attendance_rate"]["value"])
        self.assertIn("change_period", [item["id"] for item in data["next_steps"]])

        response = self.analyze(client, {"question": "查询预约金退还规则"})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        rule = [source for source in data["sources"] if source["id"] == "FR-208"][0]
        self.assertIn("24 小时", rule["summary"])
        self.assertTrue(rule["version"])
        self.assertEqual(data["periods"], [])

    def make_appointments(self):
        project = TreatmentType.objects.create(treatment_code="ADC-ASST", treatment_name="经营助手合成项目", standard_unit="次")
        for clinic, dentist, current, prior in ((1, 2, 2, 3), (2, 3, 3, 2)):
            for day, attendance in ((4, current), (3, prior)):
                start = CUTOFF.replace(day=day, hour=9)
                shift = Shift.objects.create(clinic_id=clinic, dentist_id=dentist, start_at=start,
                                             end_at=start + timedelta(hours=5), status="PUBLISHED")
                for index in range(4):
                    began = start + timedelta(minutes=index * 40)
                    attended = index < attendance
                    claim = SlotClaim.objects.create(
                        clinic_id=clinic, dentist_id=dentist, patient_id=1, shift=shift, requested_treatment_type=project,
                        start_at=began, end_at=began + timedelta(minutes=15), status="RELEASED" if attended else "CONFIRMED",
                    )
                    deposit = DepositPayment.objects.create(claim=claim, status="PAID", paid_at=began - timedelta(days=1))
                    appointment = Appointment.objects.create(
                        claim=claim, deposit=deposit, appointment_no=f"ADC-ASST-{clinic}-{day}-{index}",
                        status="COMPLETED" if attended else "CONFIRMED", is_attended=attended,
                    )
                    if attended:
                        Visit.objects.create(appointment=appointment, main_dentist_id=dentist, status="COMPLETED",
                                             started_at=began, ended_at=began + timedelta(minutes=5))

    def test_comparison_reopens_frozen_summaries_and_details_then_refreshes(self):
        self.make_appointments()
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            response = self.analyze(client, {"metric": "attendance_rate", "comparison_date_from": "2031-06-03",
                                             "comparison_date_to": "2031-06-03"})
        self.assertEqual(response.status_code, 200, response.content)
        result = response.json()["data"]
        self.assertEqual(result["mode"], "template")
        primary, previous = result["periods"]
        self.assertEqual(primary["as_of"], previous["as_of"])
        self.assertEqual(result["comparison"]["changes"], [
            {"clinic_id": "1", "percentage_points": "-25.00"},
            {"clinic_id": "2", "percentage_points": "25.00"},
        ])
        self.assertEqual(client.get(ROOT + "analysis", {"analysis_id": result["analysis_id"]}).json()["data"], result)
        Appointment.objects.filter(appointment_no="ADC-ASST-1-4-2").update(status="CHECKED_IN")
        for item, expected in ((primary, 5), (previous, 5)):
            response = client.get(ROOT + "report", {"reference": item["reference"]})
            self.assertEqual(response.status_code, 200, response.content)
            report = response.json()["data"]
            self.assertFalse(report["snapshot_refreshed"])
            self.assertEqual(report["appointments"]["attended"], expected)
            self.assertEqual(report["as_of"], item["as_of"])
            details = client.get("/api/v1/reports/operations/details", {
                "report_token": report["report_token"], "metric": "unprocessed", "clinic_id": 1,
            }).json()["data"]
            self.assertNotIn("CHECKED_IN", [row["status"] for row in details["items"]])
        caches["report_snapshots"].delete(report["report_token"])
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF + timedelta(hours=1)):
            refreshed = client.get(ROOT + "report", {"reference": previous["reference"]}).json()["data"]
        self.assertTrue(refreshed["snapshot_refreshed"])
        self.assertEqual(refreshed["original_as_of"], previous["as_of"])
        self.assertNotEqual(refreshed["as_of"], previous["as_of"])
        UserAccount.objects.filter(pk=8).update(status="DISABLED")
        self.assertEqual(client.get(ROOT + "report", {"reference": primary["reference"]}).status_code, 401)

    def test_model_receives_only_approved_rules_with_bounded_tool_schema(self):
        client = self.login()
        replies = [
            model_message(tool_calls=[tool_call("search_policy", {"topic": "deposit_refund"})]),
            model_message(content={"observations": ["refund_rules"], "questions": [], "sources": ["FR-208"]}),
        ]
        with model_settings(), patch(TRANSPORT, side_effect=replies) as transport:
            response = self.analyze(client, {"question": "查询预约金退还规则"})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["mode"], "deepseek")
        self.assertEqual([source["id"] for source in data["sources"]], ["FR-208"])
        payloads = [json.loads(call.args[0].data) for call in transport.call_args_list]
        self.assertEqual(len(payloads), 2)
        self.assertEqual(transport.call_args_list[0].args[0].full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(payloads[-1]["messages"][-1]["tool_call_id"], "call_1")
        wire = json.dumps(payloads, ensure_ascii=False)
        self.assertIn("FR-208", wire)
        for secret in ("fake-key-for-transport", "查询预约金退还规则", "合成甲店", "dentist_ids", "report_token"):
            self.assertNotIn(secret, wire)
        for secret in ("fake-key-for-transport", "查询预约金退还规则"):
            self.assertNotContains(response, secret)
        audit = AuditLog.objects.get(action="ASSISTANT_MODEL_FINISHED").after_value
        self.assertEqual(audit["tools"], ["search_policy"])
        self.assertEqual(audit["usage"]["calls"], 2)
        self.assertNotIn("fake-key-for-transport", str(audit))

    def test_model_failures_fall_back_without_losing_report(self):
        client = self.login()
        for replies, status in (
            ([TimeoutError("private transport error")], "unavailable"),
            ([model_message(tool_calls=[tool_call("get_report_details", {"clinic_id": "4"})])], "invalid_model"),
            ([model_message(tool_calls=[tool_call("get_summary", {"period": "custom", "clinic": "outside"})])], "invalid_model"),
            ([model_message(tool_calls=[tool_call("get_summary", {"period": "current"})]),
              model_message(content={"observations": ["attendance"], "questions": [], "sources": ["FR-999"]})], "invalid_model"),
        ):
            with self.subTest(status=status), model_settings(), patch(TRANSPORT, side_effect=replies):
                response = self.analyze(client, {"metric": "attendance_rate"})
            self.assertEqual(response.status_code, 200, response.content)
            data = response.json()["data"]
            self.assertEqual(data["mode"], "template")
            self.assertEqual(data["model_status"], status)
            self.assertTrue(data["periods"][0]["reference"])
            self.assertNotContains(response, "private transport error")

    def test_natural_suggestion_queries_resolve_to_structured_periods(self):
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            response = self.analyze(client, {"question": "对比两店本周和上周的实际就诊率", "clinic_ids": [1]})
        self.assertEqual(response.status_code, 200, response.content)
        current, previous = response.json()["data"]["periods"]
        self.assertEqual(current["scope"]["clinic_ids"], ["1", "2"])
        self.assertEqual((current["date_from"], current["date_to"]), ("2031-06-02", "2031-06-04"))
        self.assertEqual((previous["date_from"], previous["date_to"]), ("2031-05-26", "2031-05-28"))

        response = self.analyze(client, {"question": "本期诊疗净实收为什么变化"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["periods"][1]["date_from"], "2031-06-03")

    def test_model_comparison_contains_aliases_and_amounts_without_details(self):
        self.make_appointments()
        client = self.login()
        replies = [
            model_message(tool_calls=[tool_call("compare_reports", {"comparison": "selected"})]),
            model_message(content={"observations": ["rate_change"], "questions": [], "sources": ["FR-603"]}),
        ]
        with model_settings(), patch(TRANSPORT, side_effect=replies) as transport:
            with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
                response = self.analyze(client, {"metric": "attendance_rate", "comparison_date_from": "2031-06-03",
                                                 "comparison_date_to": "2031-06-03", "dentist_ids": [2, 3]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["mode"], "deepseek")
        payloads = [json.loads(call.args[0].data) for call in transport.call_args_list]
        comparison = json.loads(payloads[1]["messages"][-1]["content"])
        self.assertEqual(comparison["changes"], [
            {"clinic_id": "clinic_1", "percentage_points": "-25.00"},
            {"clinic_id": "clinic_2", "percentage_points": "25.00"},
        ])
        self.assertEqual(comparison["periods"][0]["metrics"][0]["attendance_rate"]["numerator"], 2)
        wire = json.dumps(payloads, ensure_ascii=False)
        for secret in ("ADC-ASST-", "合成甲店", "合成乙店", "dentist_ids", "report_token", "reference", "patient_id"):
            self.assertNotIn(secret, wire)

    def test_model_budget_is_reserved_only_for_designated_synthetic_database(self):
        client = self.login()
        with model_settings(ADC_ASSISTANT_SYNTHETIC_DB="independent-other-db"), patch(TRANSPORT) as transport:
            response = self.analyze(client, {"metric": "unprocessed"})
            self.assertEqual(response.json()["data"]["model_status"], "disabled")
            transport.assert_not_called()

        with model_settings(), patch(TRANSPORT, side_effect=TimeoutError) as transport:
            with patch("adc.reporting.assistant_service.MODEL_ACCOUNT_LIMIT", 1):
                first = self.analyze(client, {"metric": "unprocessed"})
                self.assertEqual(first.json()["data"]["model_status"], "unavailable")
                later = self.analyze(client, {"metric": "unprocessed"})
                self.assertEqual(later.json()["data"]["model_status"], "limit_reached")
            self.assertEqual(transport.call_count, 1)
        self.assertTrue(later.json()["data"]["periods"][0]["reference"])

    def test_mixed_personal_input_and_unauthorized_structured_scope_are_rejected(self):
        client = self.login()
        private_input = "SECRET-PATIENT-13312345678"
        for body in ({"metric": private_input}, {"metric": "attendance_rate", "patient_name": private_input}):
            with self.subTest(body=body):
                response = self.analyze(client, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertNotContains(response, private_input, status_code=400)
        response = self.analyze(client, {"question": "查看合成甲店的实际就诊率", "clinic_ids": [999]})
        self.assertEqual(response.status_code, 403, response.content)

    def test_analysis_replays_semantic_selection_and_preserves_outbound_budget(self):
        client = self.login()
        with model_settings(), patch(TRANSPORT, side_effect=TimeoutError) as transport:
            original = self.analyze(client, {"metric": "attendance_rate", "clinic_ids": [2, 1]}, key="same-analysis")
            recovered = client.get(ROOT + "analysis/by-action", HTTP_IDEMPOTENCY_KEY="same-analysis")
            duplicate = self.analyze(client, {"question": "实际就诊率", "clinic_ids": [1, 2]}, key="same-analysis")
            conflicting = self.analyze(client, {"metric": "unprocessed"}, key="same-analysis")
            self.assertEqual(original.status_code, 200, original.content)
            self.assertEqual(recovered.json()["data"], original.json()["data"])
            self.assertEqual(duplicate.json()["data"], original.json()["data"])
            self.assertEqual(conflicting.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
            self.assertEqual(transport.call_count, 1)

            fresh = self.analyze(client, {"metric": "attendance_rate"}, key="fresh-analysis")
            self.assertNotEqual(fresh.json()["data"]["analysis_id"], original.json()["data"]["analysis_id"])
            self.assertEqual(transport.call_count, 2)

        EmployeeRole.objects.filter(employee_id=8, role__role_code="HQ_OPERATIONS_QUERY").update(scope_clinic_id=1)
        self.assertEqual(client.get(ROOT + "analysis/by-action", HTTP_IDEMPOTENCY_KEY="same-analysis").status_code, 403)
        self.assertEqual(self.analyze(client, {"metric": "attendance_rate", "clinic_ids": [1]}, key="same-analysis").status_code, 403)

    def test_follow_up_opens_only_period_with_unprocessed_appointments(self):
        self.make_appointments()
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            response = self.analyze(client, {"metric": "unprocessed", "date_from": "2031-06-02", "date_to": "2031-06-02",
                                             "comparison_date_from": "2031-06-03", "comparison_date_to": "2031-06-03"})
        self.assertEqual(response.status_code, 200, response.content)
        result = response.json()["data"]
        step = next(item for item in result["next_steps"] if item["id"] == "unprocessed_details")
        original = client.get(ROOT + "report", {"reference": result["periods"][step["period_index"]]["reference"]})
        self.assertEqual(original.json()["data"]["date_from"], "2031-06-03")

    def test_comparison_distinguishes_incomplete_and_zero_denominator(self):
        self.make_appointments()
        Appointment.objects.filter(appointment_no="ADC-ASST-1-4-2").update(status="NO_SHOW")
        client = self.login()
        with patch("adc.reporting.assistant_service.now", return_value=CUTOFF):
            response = self.analyze(client, {"metric": "attendance_rate", "comparison_date_from": "2031-06-02",
                                             "comparison_date_to": "2031-06-02"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["comparison"]["changes"], [
            {"clinic_id": "1", "percentage_points": None, "availability": "MISSING"},
            {"clinic_id": "2", "percentage_points": None, "availability": "NOT_APPLICABLE"},
        ])

    def test_suggested_period_can_be_submitted_after_large_report_range(self):
        client = self.login()
        response = client.get(ROOT + "suggestions", {"date_from": "2030-05-22", "date_to": "2031-06-04"})
        past = next(item for item in response.json()["data"]["suggestions"] if item["id"] == "net_received")
        self.assertEqual(past["selection"]["date_from"], "2030-06-04")
        submitted = self.analyze(client, past["selection"])
        self.assertEqual(submitted.status_code, 200, submitted.content)

    def test_deepseek_requires_matching_synthetic_environment_host_port_and_name(self):
        client = self.login()
        for config in (
            {"ADC_ASSISTANT_SYNTHETIC_ENV": "experience"}, {"ADC_ASSISTANT_SYNTHETIC_HOST": "separate-postgres"},
            {"ADC_ASSISTANT_SYNTHETIC_PORT": "5431"}, {"ADC_ASSISTANT_SYNTHETIC_DB": "separate-database"},
            {"ADC_ENV": "test", "ADC_ASSISTANT_SYNTHETIC_ENV": "test"},
        ):
            with self.subTest(config=config), model_settings(**config), patch(TRANSPORT) as transport:
                result = self.analyze(client, {"metric": "attendance_rate"})
                self.assertEqual(result.json()["data"]["model_status"], "disabled")
                transport.assert_not_called()

    def test_truncated_transport_falls_back_and_model_cannot_hide_data_limits(self):
        client = self.login()
        with model_settings(), patch(TRANSPORT, side_effect=IncompleteRead(b"private-response")):
            truncated = self.analyze(client, {"metric": "attendance_rate", "clinic_ids": [1]})
        self.assertEqual(truncated.status_code, 200, truncated.content)
        self.assertEqual(truncated.json()["data"]["model_status"], "unavailable")
        self.assertNotContains(truncated, "private-response")

        replies = [
            model_message(tool_calls=[tool_call("get_summary", {"period": "current"})]),
            model_message(content={"observations": ["attendance"], "questions": [], "sources": ["FR-603"]}),
        ]
        with model_settings(), patch(TRANSPORT, side_effect=replies):
            verified = self.analyze(client, {"metric": "attendance_rate", "clinic_ids": [1]})
        self.assertEqual(verified.status_code, 200, verified.content)
        result = verified.json()["data"]
        self.assertEqual(result["mode"], "deepseek")
        self.assertIn("no_denominator", [item["id"] for item in result["observations"]])
        self.assertIn("unprocessed_reason", [item["id"] for item in result["questions"]])


class ConcurrentOperationsAssistantTests(TransactionTestCase):
    databases = {"default", "runtime"}

    def test_in_flight_analysis_is_visible_before_model_completes(self):
        account_name = "demo.reports.concurrent"
        clinic = Clinic.objects.create(clinic_no="ADC-ASST-RACE", clinic_name="合成并发门店", postal_address="合成地址")
        employee = Employee.objects.create(employee_no="ADC-ASST-RACE", full_name="合成并发经营")
        account = UserAccount.objects.create(employee=employee, login_identity=account_name)
        role, created = AppRole.objects.get_or_create(role_code="HQ_OPERATIONS_QUERY", defaults={"role_name": "经营查询"})
        grant = EmployeeRole.objects.create(employee=employee, role=role, scope_clinic=clinic)
        entered = Event()
        release = Event()
        client = Client()
        try:
            with override_settings(ADC_STAFF_PASSWORD_HASHES={account_name: make_password("synthetic-race-password")}):
                login = client.post("/api/v1/auth/web/login", {
                    "login_identity": account_name, "password": "synthetic-race-password",
                }, content_type="application/json")
            self.assertEqual(login.status_code, 200, login.content)

            def provider(*args, **kwargs):
                self.assertFalse(connection.in_atomic_block)
                entered.set()
                if not release.wait(10):
                    raise AssertionError("provider was never released")
                raise TimeoutError

            def send():
                worker_client = Client()
                worker_client.cookies = client.cookies.copy()
                try:
                    return worker_client.post(
                        ROOT + "analysis",
                        {**FILTERS, "clinic_ids": [clinic.pk], "metric": "attendance_rate"},
                        content_type="application/json", HTTP_IDEMPOTENCY_KEY="race-same-analysis",
                    )
                finally:
                    connections.close_all()

            with model_settings(), patch(TRANSPORT, side_effect=provider) as transport, ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(send)
                try:
                    self.assertTrue(entered.wait(5))
                    lookup = client.get(ROOT + "analysis/by-action", HTTP_IDEMPOTENCY_KEY="race-same-analysis")
                    duplicate = pool.submit(send).result(timeout=5)
                    for pending in (lookup, duplicate):
                        self.assertEqual(pending.status_code, 409, pending.content)
                        self.assertEqual(pending.json()["error"]["code"], "RESULT_PENDING")
                finally:
                    release.set()
                completed = first.result(timeout=5)

            self.assertEqual(transport.call_count, 1)
            self.assertEqual(completed.status_code, 200, completed.content)
            recovered = client.get(ROOT + "analysis/by-action", HTTP_IDEMPOTENCY_KEY="race-same-analysis")
            self.assertEqual(recovered.json()["data"], completed.json()["data"])
        finally:
            AuditLog.objects.filter(account=account).delete()
            grant.delete()
            account.delete()
            employee.delete()
            clinic.delete()
            if created:
                role.delete()
