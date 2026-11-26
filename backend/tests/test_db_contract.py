from django.contrib.sessions.models import Session
from django.core.cache import caches
from django.db import connections, router, transaction
from django.test import SimpleTestCase, TransactionTestCase
from psycopg import sql


class DatabaseRoutingTests(SimpleTestCase):
    def test_sessions_and_snapshot_cache_cannot_migrate_to_business_database(self):
        self.assertEqual(router.db_for_read(Session), "runtime")
        self.assertEqual(router.db_for_write(Session), "runtime")
        self.assertTrue(router.allow_migrate("runtime", "sessions"))
        self.assertFalse(router.allow_migrate("default", "sessions"))
        self.assertFalse(router.allow_migrate("default", "booking"))
        snapshot_cache = caches["report_snapshots"]
        self.assertEqual(router.db_for_write(snapshot_cache.cache_model_class), "runtime")


class DatabaseStructureTests(TransactionTestCase):
    databases = {"default", "runtime"}

    def test_business_test_database_uses_exact_adc_structure(self):
        with connections["default"].cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    count(*) FILTER (WHERE table_type = 'BASE TABLE'),
                    count(*) FILTER (WHERE table_type = 'VIEW')
                FROM information_schema.tables
                WHERE table_schema = 'public'
                """
            )
            self.assertEqual(cursor.fetchone(), (40, 4))
            cursor.execute(
                """
                SELECT count(*)
                FROM information_schema.columns AS c
                JOIN information_schema.tables AS t USING (table_schema, table_name)
                WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                """
            )
            self.assertEqual(cursor.fetchone()[0], 270)
            cursor.execute(
                """
                SELECT count(*)
                FROM information_schema.table_constraints
                WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'
                """
            )
            self.assertEqual(cursor.fetchone()[0], 71)
            cursor.execute(
                """
                SELECT column_name, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'employee'
                    AND column_name IN ('job_code', 'home_clinic_id')
                ORDER BY column_name
                """
            )
            self.assertEqual(cursor.fetchall(), [("home_clinic_id", "YES"), ("job_code", "YES")])

    def test_runtime_stores_sessions_and_report_snapshots_only(self):
        session = Session.objects.create(
            session_key="adc-routing-test",
            session_data="example",
            expire_date="2030-01-01T00:00:00+08:00",
        )
        self.assertEqual(session._state.db, "runtime")
        cache = caches["report_snapshots"]
        cache.set("adc-routing-test", {"appointment_ids": ["31"]}, timeout=20)
        try:
            self.assertEqual(cache.get("adc-routing-test"), {"appointment_ids": ["31"]})
            self.assertNotIn("django_session", connections["default"].introspection.table_names())
            self.assertNotIn("appointment", connections["runtime"].introspection.table_names())
        finally:
            cache.delete("adc-routing-test")

    def test_initialization_can_limit_the_business_role_to_business_dml(self):
        from scripts.grant_db_access import configure_access

        role = "adc_test_business_runtime_acl"
        connection = connections["default"]
        with transaction.atomic(using="default"), connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
            configure_access(cursor, "business", role)
            cursor.execute(
                """
                SELECT has_table_privilege(%s, 'appointment', 'INSERT'),
                       has_table_privilege(%s, 'audit_log', 'INSERT'),
                       has_table_privilege(%s, 'audit_log', 'UPDATE'),
                       has_table_privilege(%s, 'employee_role', 'UPDATE'),
                       has_schema_privilege(%s, 'public', 'CREATE')
                """,
                [role] * 5,
            )
            self.assertEqual(cursor.fetchone(), (True, True, False, False, False))
            transaction.set_rollback(True, using="default")

    def test_business_role_can_lock_reference_rows_without_broad_update_permission(self):
        from scripts.grant_db_access import configure_access

        role = "adc_test_reference_row_locks"
        with transaction.atomic(using="default"), connections["default"].cursor() as cursor:
            cursor.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
            configure_access(cursor, "business", role)
            cursor.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
            for table, pk, field in (
                ("employee", "employee_id", "full_name"),
                ("clinic", "clinic_id", "clinic_name"),
                ("dental_chair", "chair_id", "chair_no"),
            ):
                with self.subTest(table=table), transaction.atomic(using="default"):
                    cursor.execute(
                        sql.SQL("SELECT {} FROM {} FOR UPDATE").format(sql.Identifier(pk), sql.Identifier(table))
                    )
                    cursor.execute(
                        "SELECT has_table_privilege(current_user, %s, 'UPDATE'), "
                        "has_column_privilege(current_user, %s, %s, 'UPDATE')",
                        [table, table, field],
                    )
                    self.assertEqual(cursor.fetchone(), (False, False))
            transaction.set_rollback(True, using="default")

    def test_initialization_rejects_a_role_with_inherited_global_data_access(self):
        from scripts.grant_db_access import configure_access

        role = "adc_test_inherited_global_data"
        with transaction.atomic(using="default"), connections["default"].cursor() as cursor:
            cursor.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
            cursor.execute(sql.SQL("GRANT pg_read_all_data TO {}").format(sql.Identifier(role)))
            with self.assertRaisesRegex(ValueError, "unprivileged role"):
                configure_access(cursor, "business", role)
            transaction.set_rollback(True, using="default")

    def test_runtime_role_can_revoke_sessions_but_cannot_change_the_schema(self):
        from scripts.grant_db_access import configure_access

        role = "adc_test_runtime_acl"
        connection = connections["runtime"]
        with transaction.atomic(using="runtime"), connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
            configure_access(cursor, "runtime", role)
            cursor.execute(
                """
                SELECT has_table_privilege(%s, 'django_session', 'DELETE'),
                       has_table_privilege(%s, 'adc_report_snapshot', 'INSERT'),
                       has_table_privilege(%s, 'django_migrations', 'INSERT'),
                       has_schema_privilege(%s, 'public', 'CREATE')
                """,
                [role] * 4,
            )
            self.assertEqual(cursor.fetchone(), (True, True, False, False))
            transaction.set_rollback(True, using="runtime")
