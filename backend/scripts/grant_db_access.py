"""Grant the ADC application role access after its dedicated database is initialized."""
import argparse
import os
from pathlib import Path

import psycopg
from psycopg import sql


BUSINESS_WRITES = (
    "shift_demand", "shift", "patient", "patient_allergy", "treatment_type", "treatment_price",
    "slot_claim", "deposit_payment", "appointment", "deposit_refund",
    "visit", "chair_usage", "invoice", "invoice_payment",
    "treatment_correction", "performance_period", "operating_expense",
    "expense_allocation", "dentist_performance", "company_performance", "performance_revision",
)
# PostgreSQL requires UPDATE on at least one column to take a row lock.
BUSINESS_REFERENCE_LOCKS = (
    ("employee", "employee_id"), ("clinic", "clinic_id"), ("dental_chair", "chair_id"),
)
BUSINESS_APPENDS = (
    "audit_log", "appointment_change", "appointment_requested_treatment",
    "dental_chair_unavailability", "dentist_work_session", "treatment_item",
    "material_usage", "invoice_line", "correction_approval", "invoice_adjustment", "user_account",
)


def protect_deployment_identity(cursor):
    cursor.execute(
        '''
        CREATE OR REPLACE FUNCTION public.adc_guard_identity_changes() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
        DECLARE
            role_key bigint;
            clinic_key bigint;
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_class WHERE oid = TG_RELID AND pg_has_role(relowner, 'USAGE')
            ) THEN
                IF TG_TABLE_NAME = 'employee_role' THEN
                    IF TG_OP = 'DELETE' THEN
                        role_key := OLD.role_id;
                        clinic_key := OLD.scope_clinic_id;
                    ELSE
                        role_key := NEW.role_id;
                        clinic_key := NEW.scope_clinic_id;
                    END IF;
                    IF clinic_key IS NULL OR NOT EXISTS (
                        SELECT 1 FROM app_role
                        WHERE role_id = role_key AND role_code IN (
                            'FRONT_DESK', 'DENTIST', 'CLINIC_MANAGER', 'HQ_SCHEDULER', 'HQ_CATALOG', 'HQ_OPERATIONS_QUERY'
                        )
                    ) THEN
                        RAISE EXCEPTION 'This grant is managed by deployment' USING ERRCODE = '42501';
                    END IF;
                ELSIF TG_OP = 'INSERT' THEN
                    IF NEW.employee_id IS NOT NULL THEN
                        RAISE EXCEPTION 'Staff accounts are managed by deployment' USING ERRCODE = '42501';
                    END IF;
                ELSIF OLD.employee_id IS NULL OR EXISTS (
                    SELECT 1 FROM employee_role er JOIN app_role ar ON ar.role_id = er.role_id
                    WHERE er.employee_id = OLD.employee_id AND (
                        ar.role_code IN ('HQ_ACCESS_ADMIN', 'HQ_PERFORMANCE_CALCULATE', 'HQ_PERFORMANCE_REVIEW', 'HQ_PERFORMANCE_CONFIRM')
                        OR (ar.role_code IN ('HQ_SCHEDULER', 'HQ_CATALOG', 'HQ_OPERATIONS_QUERY') AND er.scope_clinic_id IS NULL)
                    )
                ) THEN
                    RAISE EXCEPTION 'This account is managed by deployment' USING ERRCODE = '42501';
                END IF;
            END IF;
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END;
        $guard$
        '''
    )
    cursor.execute("DROP TRIGGER IF EXISTS adc_guard_scope_changes ON public.employee_role")
    cursor.execute(
        "CREATE TRIGGER adc_guard_scope_changes BEFORE INSERT OR DELETE ON public.employee_role "
        "FOR EACH ROW EXECUTE FUNCTION public.adc_guard_identity_changes()"
    )
    cursor.execute("DROP TRIGGER IF EXISTS adc_guard_account_changes ON public.user_account")
    cursor.execute(
        "CREATE TRIGGER adc_guard_account_changes BEFORE INSERT OR UPDATE OF status ON public.user_account "
        "FOR EACH ROW EXECUTE FUNCTION public.adc_guard_identity_changes()"
    )


def configure_access(cursor, layer, application_role):
    cursor.execute(
        """
        SELECT current_database(), current_user,
               to_regclass('public.appointment') IS NOT NULL,
               to_regclass('public.django_session') IS NOT NULL,
               to_regclass('public.adc_report_snapshot') IS NOT NULL
        """
    )
    database, initializer, business, sessions, snapshots = cursor.fetchone()
    if layer == "business" and (not business or sessions or snapshots):
        raise ValueError("Initialize the dedicated ADC business database before granting access.")
    if layer == "runtime" and (business or not sessions or not snapshots):
        raise ValueError("Initialize the dedicated ADC runtime database before granting access.")
    if layer not in {"business", "runtime"}:
        raise ValueError("Specify business or runtime.")

    cursor.execute(
        """
        SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication
               OR pg_has_role(r.oid, d.datdba, 'MEMBER')
               OR pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER')
               OR pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER')
        FROM pg_roles AS r JOIN pg_database AS d ON d.datname = current_database()
        WHERE r.rolname = %s
        """,
        [application_role],
    )
    attributes = cursor.fetchone()
    if application_role == initializer or attributes is None or attributes[0]:
        raise ValueError("The application role must be an existing unprivileged role distinct from the initializer.")

    role = sql.Identifier(application_role)
    database_name = sql.Identifier(database)
    cursor.execute(sql.SQL("REVOKE CONNECT, TEMPORARY ON DATABASE {} FROM PUBLIC").format(database_name))
    cursor.execute(sql.SQL("REVOKE ALL PRIVILEGES ON DATABASE {} FROM {}").format(database_name, role))
    cursor.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(database_name, role))
    cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
    cursor.execute(sql.SQL("REVOKE ALL PRIVILEGES ON SCHEMA public FROM {}").format(role))
    cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(role))
    cursor.execute(sql.SQL("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {}").format(role))
    cursor.execute(sql.SQL("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {}").format(role))
    if layer == "runtime":
        cursor.execute(
            sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON django_session, adc_report_snapshot TO {}").format(role)
        )
        return

    cursor.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}").format(role))
    cursor.execute(sql.SQL("GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {}").format(role))
    cursor.execute(sql.SQL(
        "GRANT UPDATE (job_code, home_clinic_id) ON public.employee TO {}"
    ).format(role))
    for table, column in BUSINESS_REFERENCE_LOCKS:
        cursor.execute(
            sql.SQL("GRANT UPDATE ({}) ON {} TO {}").format(
                sql.Identifier(column), sql.Identifier("public", table), role,
            )
        )
    cursor.execute(
        sql.SQL("GRANT INSERT, UPDATE ON {} TO {}").format(
            sql.SQL(", ").join(sql.Identifier("public", table) for table in BUSINESS_WRITES), role,
        )
    )
    cursor.execute(
        sql.SQL("GRANT INSERT ON {} TO {}").format(
            sql.SQL(", ").join(sql.Identifier("public", table) for table in BUSINESS_APPENDS), role,
        )
    )
    protect_deployment_identity(cursor)
    cursor.execute(Path(__file__).with_name("master_data_access.sql").read_text(encoding="utf-8"))
    cursor.execute(sql.SQL(
        "GRANT EXECUTE ON FUNCTION public.adc_write_master_data(BIGINT, TEXT, BIGINT, JSONB) TO {}"
    ).format(role))
    cursor.execute(sql.SQL("GRANT UPDATE (status) ON user_account TO {}").format(role))
    cursor.execute(sql.SQL("GRANT INSERT (employee_id, role_id, scope_clinic_id), DELETE ON employee_role TO {}").format(role))
    cursor.execute(sql.SQL("GRANT DELETE ON patient_allergy, expense_allocation, dentist_performance, company_performance TO {}").format(role))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("layer", choices=("business", "runtime"))
    parser.add_argument("application_role")
    args = parser.parse_args()
    dsn = os.environ.get("ADC_INITIALIZER_DSN")
    if not dsn:
        raise SystemExit("Set ADC_INITIALIZER_DSN to the designated database initializer connection.")
    with psycopg.connect(dsn) as conn, conn.cursor() as cursor:
        configure_access(cursor, args.layer, args.application_role)


if __name__ == "__main__":
    main()
