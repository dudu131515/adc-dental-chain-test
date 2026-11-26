from django.contrib.auth.hashers import make_password
from django.db import connection
from django.test import Client, TestCase, override_settings

from adc.booking.models import Appointment, DepositPayment, SlotClaim
from adc.catalog.models import TreatmentType
from adc.identity.models import EmployeeRole
from adc.scheduling.models import Shift
from tests.fixtures.scenarios import load_synthetic_base


class SchedulingContractTests(TestCase):
    databases = {"default", "runtime"}

    @classmethod
    def setUpTestData(cls):
        load_synthetic_base()

    def setUp(self):
        password = "synthetic-shift-password"
        self.password = password
        config = override_settings(ADC_STAFF_PASSWORD_HASHES={
            f"demo.{role}": make_password(password, hasher="pbkdf2_sha256")
            for role in ("manager-a", "scheduler", "dentist", "front-b")
        })
        config.enable()
        self.addCleanup(config.disable)
        self.manager = self.client_as("manager-a")
        self.scheduler = self.client_as("scheduler")
        self.dentist = self.client_as("dentist")
        self.other_store = self.client_as("front-b")
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO qualification (qualification_code, qualification_name) VALUES (%s, %s) RETURNING qualification_id",
                ["ADC-SYNTHETIC-GENERAL", "合成全科资质"],
            )
            self.qualification = cursor.fetchone()[0]
            cursor.execute(
                """
                INSERT INTO employee_qualification (employee_id, qualification_id, valid_from, valid_until)
                VALUES (%s, %s, DATE '2030-01-01', DATE '2030-12-31')
                """,
                [1, self.qualification],
            )

    def client_as(self, role):
        client = Client()
        response = self.post(client, "/auth/web/login", {
            "login_identity": f"demo.{role}", "password": self.password,
        })
        self.assertEqual(response.status_code, 200, response.content)
        return client

    def post(self, client, path, payload):
        return client.post("/api/v1" + path, payload, content_type="application/json")

    def draft(self, clinic, start, end, demand=None):
        response = self.post(self.scheduler, "/shifts", {
            "clinic_id": str(clinic), "dentist_id": "1", "demand_id": demand,
            "start_at": start, "end_at": end,
        })
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["data"]["shift_id"]

    def transition(self, actor, shift, action, **payload):
        return self.post(actor, f"/shifts/{shift}/{action}", payload)

    def test_demand_submission_and_accepted_shift_publication_keep_role_scopes(self):
        payload = {
            "clinic_id": "1", "start_at": "2030-10-14T09:00:00+08:00", "end_at": "2030-10-14T10:00:00+08:00",
            "required_qualification_id": str(self.qualification), "required_count": 1,
        }
        out_of_scope = self.post(self.manager, "/shift-demands", {**payload, "clinic_id": "2"})
        self.assertIn(out_of_scope.status_code, (403, 404))
        demand = self.post(self.manager, "/shift-demands", payload)
        self.assertEqual(demand.status_code, 201)
        shift = self.draft(1, payload["start_at"], payload["end_at"], demand.json()["data"]["demand_id"])
        self.assertEqual(self.transition(self.scheduler, shift, "publish").status_code, 409)
        self.assertEqual(self.transition(self.scheduler, shift, "submit").status_code, 200)
        self.assertEqual(self.transition(self.dentist, shift, "respond", decision="ACCEPTED").status_code, 200)
        published = self.transition(self.scheduler, shift, "publish")
        self.assertEqual(published.status_code, 200)
        self.assertEqual(published.json()["data"]["status"], "PUBLISHED")
        hidden = self.other_store.get("/api/v1/schedule/board", {
            "clinic_id": "1", "date_from": "2030-10-14", "date_to": "2030-10-14",
        })
        self.assertIn(hidden.status_code, (403, 404))

    def test_cross_clinic_59_minutes_conflicts_and_60_minutes_still_needs_route_check(self):
        published = self.draft(1, "2030-10-15T09:00:00+08:00", "2030-10-15T10:00:00+08:00")
        self.assertEqual(self.transition(self.scheduler, published, "submit").status_code, 200)
        self.assertEqual(self.transition(self.dentist, published, "respond", decision="ACCEPTED").status_code, 200)
        self.assertEqual(self.transition(self.scheduler, published, "publish").status_code, 200)
        next_id = self.draft(2, "2030-10-15T10:59:00+08:00", "2030-10-15T12:00:00+08:00")
        rejected = self.transition(self.scheduler, next_id, "submit")
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error"]["code"], "SHIFT_CONFLICT")
        revised = self.scheduler.patch(f"/api/v1/shifts/{next_id}", {
            "expected_status": "DRAFT", "start_at": "2030-10-15T11:00:00+08:00",
            "reason": "合成转场调整",
        }, content_type="application/json")
        self.assertEqual(revised.status_code, 200)
        self.assertEqual(self.transition(self.scheduler, next_id, "submit").status_code, 200)
        self.assertEqual(self.transition(self.dentist, next_id, "respond", decision="ACCEPTED").status_code, 200)
        incompatible = self.transition(self.scheduler, next_id, "publish", route_feasible=False, evidence_ref="演示路线不可行")
        self.assertEqual(incompatible.status_code, 409)
        feasible = self.transition(self.scheduler, next_id, "publish", route_feasible=True, evidence_ref="演示路线核验")
        self.assertEqual(feasible.status_code, 200)

    def test_dentist_loses_board_and_response_access_when_clinic_grant_is_revoked(self):
        treatment = TreatmentType.objects.create(
            treatment_code="ADC-SCOPE", treatment_name="合成项目", standard_unit="次",
        )
        shifts = {}
        for clinic_id, hour in ((1, 9), (2, 11)):
            start = f"2030-10-17T{hour:02d}:00:00+08:00"
            end = f"2030-10-17T{hour:02d}:30:00+08:00"
            shift = Shift.objects.create(
                clinic_id=clinic_id, dentist_id=1, start_at=start, end_at=end, status="PUBLISHED",
            )
            shifts[clinic_id] = shift
            claim = SlotClaim.objects.create(
                clinic_id=clinic_id, dentist_id=1, patient_id=clinic_id, shift=shift,
                requested_treatment_type=treatment, start_at=start, end_at=end, status="CONFIRMED",
            )
            deposit = DepositPayment.objects.create(claim=claim, status="PAID")
            Appointment.objects.create(
                claim=claim, deposit=deposit, status="CONFIRMED", appointment_no=f"ADC-SCOPE-{clinic_id}",
            )
        pending = self.draft(1, "2030-10-17T14:00:00+08:00", "2030-10-17T15:00:00+08:00")
        self.assertEqual(self.transition(self.scheduler, pending, "submit").status_code, 200)
        EmployeeRole.objects.filter(employee_id=1, role__role_code="DENTIST", scope_clinic_id=1).delete()

        filters = {"date_from": "2030-10-17", "date_to": "2030-10-17"}
        board = self.dentist.get("/api/v1/schedule/board", filters)
        self.assertEqual(board.status_code, 200, board.content)
        board_data = board.json()["data"]
        self.assertEqual([item["shift_id"] for item in board_data["shifts"]], [str(shifts[2].pk)])
        self.assertEqual([item["appointment_no"] for item in board_data["appointments"]], ["ADC-SCOPE-2"])
        self.assertEqual(board_data["appointments"][0]["patient_display"], "合成患者2")
        self.assertEqual(self.transition(self.dentist, pending, "respond", decision="ACCEPTED").status_code, 404)
        self.assertEqual(Shift.objects.get(pk=pending).status, "PENDING")

    def test_chair_unavailability_only_allows_local_manager_and_excludes_overlap(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO dental_chair(clinic_id, chair_no) VALUES(1, 'ADC-SYNTHETIC-CHAIR') RETURNING chair_id"
            )
            chair_id = cursor.fetchone()[0]
        payload = {
            "start_at": "2030-10-16T09:00:00+08:00",
            "end_at": "2030-10-16T10:00:00+08:00",
            "reason": "合成维修",
        }
        action = f"/chairs/{chair_id}/unavailability"
        self.assertIn(self.post(self.other_store, action, payload).status_code, (403, 404))
        self.assertEqual(self.post(self.manager, action, payload).status_code, 201)
        self.assertEqual(self.post(self.manager, action, payload).status_code, 409)
        chairs = self.manager.get("/api/v1/clinics/1/chairs").json()["data"]["items"]
        self.assertEqual(chairs[0]["chair_id"], str(chair_id))
        self.assertEqual(chairs[0]["unavailability"][0]["reason"], "合成维修")

    def test_qualification_must_cover_the_whole_local_slot(self):
        payload = {
            "clinic_id": "1", "start_at": "2030-12-31T23:30:00+08:00",
            "end_at": "2031-01-01T00:30:00+08:00",
            "required_qualification_id": str(self.qualification), "required_count": 1,
        }
        demand = self.post(self.manager, "/shift-demands", payload)
        self.assertEqual(demand.status_code, 201, demand.content)
        need = demand.json()["data"]["demand_id"]
        shift = self.draft(1, payload["start_at"], payload["end_at"], need)
        rejected = self.transition(self.scheduler, shift, "submit")
        self.assertEqual(rejected.status_code, 409)
        self.assertIn("资格", rejected.json()["error"]["message"])
        valid = self.draft(1, payload["start_at"], "2031-01-01T00:00:00+08:00", need)
        self.assertEqual(self.transition(self.scheduler, valid, "submit").status_code, 200)

    def test_withdrawal_refuses_active_appointment_until_it_is_coordinated(self):
        shift_id = self.draft(1, "2030-10-18T09:00:00+08:00", "2030-10-18T10:00:00+08:00")
        self.assertEqual(self.transition(self.scheduler, shift_id, "submit").status_code, 200)
        self.assertEqual(self.transition(self.dentist, shift_id, "respond", decision="ACCEPTED").status_code, 200)
        self.assertEqual(self.transition(self.scheduler, shift_id, "publish").status_code, 200)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                WITH t AS (
                    INSERT INTO treatment_type(treatment_code, treatment_name, standard_unit, default_slot_minutes)
                    VALUES('ADC-SYNTHETIC-VISIT', '合成检查', '次', 30) RETURNING treatment_type_id
                ), c AS (
                    INSERT INTO slot_claim(patient_id, clinic_id, dentist_id, shift_id, requested_treatment_type_id,
                                           start_at, end_at, status)
                    SELECT 1, 1, 1, %s, treatment_type_id,
                           '2030-10-18T09:00+08:00', '2030-10-18T09:30+08:00', 'CONFIRMED' FROM t
                    RETURNING claim_id
                ), p AS (
                    INSERT INTO deposit_payment(claim_id, status) SELECT claim_id, 'PAID' FROM c
                    RETURNING deposit_id, claim_id
                )
                INSERT INTO appointment(appointment_no, claim_id, deposit_id, status)
                SELECT 'ADC-SYNTHETIC-RESOURCE-1', claim_id, deposit_id, 'CONFIRMED' FROM p
                RETURNING appointment_id
                """,
                [shift_id],
            )
            appointment_id = cursor.fetchone()[0]
        affected = self.manager.get(f"/api/v1/shifts/{shift_id}/affected-appointments")
        self.assertEqual(affected.status_code, 200)
        self.assertEqual(
            [item["appointment_id"] for item in affected.json()["data"]["items"]], [str(appointment_id)],
        )
        waiting = self.transition(self.scheduler, shift_id, "withdraw", reason="合成停诊")
        self.assertEqual(waiting.status_code, 409)
        with connection.cursor() as cursor:
            cursor.execute("UPDATE appointment SET status='CANCELLED' WHERE appointment_id=%s", [appointment_id])
            cursor.execute("UPDATE slot_claim SET status='RELEASED' WHERE shift_id=%s", [shift_id])
        response = self.transition(self.scheduler, shift_id, "withdraw", reason="合成停诊")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["status"], "CANCELLED")

    def test_batch_publish_rolls_back_until_every_doctor_and_route_check_succeeds(self):
        batch = "/shifts/batch"
        payload = {
            "action": "draft",
            "shifts": [
                {
                    "clinic_id": str(clinic), "dentist_id": "1",
                    "start_at": f"2030-10-22T{start}:00+08:00", "end_at": f"2030-10-22T{end}:00+08:00",
                }
                for clinic, start, end in ((1, "09:00", "10:00"), (2, "11:00", "12:00"))
            ],
        }
        self.assertEqual(self.post(self.manager, batch, payload).status_code, 403)
        headers = {"HTTP_IDEMPOTENCY_KEY": "synthetic-batch-2030-10-22"}
        draft = self.scheduler.post("/api/v1" + batch, payload, content_type="application/json", **headers)
        self.assertEqual(draft.status_code, 200, draft.content)
        replay = self.scheduler.post("/api/v1" + batch, payload, content_type="application/json", **headers)
        self.assertEqual(replay.json(), draft.json())
        entries = [{"shift_id": row["shift_id"]} for row in draft.json()["data"]["items"]]
        first, second = [entry["shift_id"] for entry in entries]
        self.assertEqual(self.post(self.scheduler, batch, {"action": "submit", "shifts": entries}).status_code, 200)
        self.assertEqual(self.transition(self.dentist, first, "respond", decision="ACCEPTED").status_code, 200)

        publish = {"action": "publish", "shifts": entries}
        denied = self.post(self.scheduler, batch, publish)
        self.assertEqual(denied.status_code, 409, denied.content)
        self.assertEqual(denied.json()["error"]["code"], "INVALID_TRANSITION")
        self.assertEqual(Shift.objects.get(pk=first).status, "ACCEPTED")

        self.assertEqual(self.transition(self.dentist, second, "respond", decision="ACCEPTED").status_code, 200)
        route_missing = self.post(self.scheduler, batch, publish)
        self.assertEqual(route_missing.status_code, 409, route_missing.content)
        self.assertEqual(route_missing.json()["error"]["details"]["shift_id"], second)
        self.assertEqual(Shift.objects.get(pk=first).status, "ACCEPTED")

        entries[1].update(route_feasible=True, evidence_ref="合成跨店路线核验")
        published = self.post(self.scheduler, batch, publish)
        self.assertEqual(published.status_code, 200, published.content)
        self.assertEqual([row["status"] for row in published.json()["data"]["items"]], ["PUBLISHED", "PUBLISHED"])

        copied = self.post(self.scheduler, batch, {
            "action": "copy", "source_shift_id": first, "target_date": "2030-10-29",
        })
        self.assertEqual(copied.status_code, 200, copied.content)
        self.assertEqual(copied.json()["data"]["items"][0]["status"], "DRAFT")
        reused = self.post(self.scheduler, batch, {"action": "reuse_week", "target_week": "2030-10-28"})
        self.assertEqual(reused.status_code, 200, reused.content)
        self.assertEqual(reused.json()["data"]["skipped_count"], 1)
        self.assertEqual([row["clinic_id"] for row in reused.json()["data"]["items"]], ["2"])

    def test_filtered_week_warns_about_visible_cross_clinic_drafts_and_staggered_staffing(self):
        first = self.draft(1, "2030-10-23T09:00:00+08:00", "2030-10-23T10:00:00+08:00")
        second = self.draft(2, "2030-10-23T10:30:00+08:00", "2030-10-23T12:00:00+08:00")
        demand = self.post(self.manager, "/shift-demands", {
            "clinic_id": "1", "start_at": "2030-10-23T09:00:00+08:00",
            "end_at": "2030-10-23T11:00:00+08:00", "required_count": 1,
        })
        self.assertEqual(demand.status_code, 201, demand.content)
        self.assertEqual(self.transition(self.scheduler, first, "submit").status_code, 200)
        self.assertEqual(self.transition(self.dentist, first, "respond", decision="ACCEPTED").status_code, 200)
        self.assertEqual(self.transition(self.scheduler, first, "publish").status_code, 200)

        params = {"date_from": "2030-10-21", "date_to": "2030-10-27", "clinic_id": "1", "view": "week"}
        response = self.scheduler.get("/api/v1/schedule/board", params)
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual([row["shift_id"] for row in data["shifts"]], [first])
        self.assertEqual(data["conflicts"][0]["code"], "CROSS_CLINIC_TRAVEL")
        self.assertEqual(data["conflicts"][0]["shift_ids"], [first, second])
        self.assertEqual(data["shortages"][0]["missing_count"], 1)
        local = self.manager.get("/api/v1/schedule/board", params)
        self.assertEqual(local.status_code, 200, local.content)
        self.assertEqual(local.json()["data"]["conflicts"], [])
