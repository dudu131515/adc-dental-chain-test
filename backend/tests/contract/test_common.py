from django.utils.module_loading import import_string
from django.test import SimpleTestCase


class CommonApiContractTests(SimpleTestCase):
    def test_api_returns_uniform_json_for_missing_route_and_missing_identity(self):
        missing = self.client.get("/api/v1/unavailable")
        self.assertEqual(missing.status_code, 404)
        self.assertIn("application/json", missing.headers["Content-Type"])
        self.assertEqual(missing.json()["error"]["code"], "NOT_FOUND")
        self.assertTrue(missing.json()["error"]["request_id"])
        unrecognized = self.client.get("/api/v1/auth/me", HTTP_AUTHORIZATION="Bearer unknown")
        self.assertEqual(unrecognized.status_code, 401)
        self.assertEqual(unrecognized.json()["error"]["code"], "AUTHENTICATION_REQUIRED")

    def test_local_role_does_not_imply_another_clinics_access(self):
        principal_type = import_string("adc.identity.permissions.Principal")
        principal = principal_type(1, "staff", 2, None, frozenset({("FRONT_DESK", 9)}))
        self.assertTrue(principal.allows("FRONT_DESK", 9))
        self.assertFalse(principal.allows("FRONT_DESK", 10))
        self.assertFalse(principal.allows("HQ_SCHEDULER", 9))
        invalid_grant = principal_type(1, "staff", 2, None, frozenset({("FRONT_DESK", None)}))
        self.assertFalse(invalid_grant.allows("FRONT_DESK", 9))

    def test_cursor_can_only_be_used_with_its_owner_and_filter(self):
        from adc.common.http import ApiProblem, cursor_position, scoped_cursor

        scope = {"account_id": "21", "scope": ["7"], "sort": "id", "filter": {"status": "ACTIVE"}}
        token = scoped_cursor(scope, "148")
        self.assertEqual(cursor_position(token, scope), "148")
        with self.assertRaises(ApiProblem) as error:
            cursor_position(token, {**scope, "account_id": "22"})
        self.assertEqual(error.exception.status_code, 400)
