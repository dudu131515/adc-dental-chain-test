CREATE OR REPLACE FUNCTION public.adc_write_master_data(
    actor_account_id BIGINT, resource TEXT, resource_id BIGINT, attributes JSONB
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $master$
DECLARE
    allowed_fields TEXT[];
    primary_key TEXT := 'id';
    requires_access_admin BOOLEAN := FALSE;
    actor_employee_id BIGINT;
    target_employee_id BIGINT;
    field_names TEXT;
    field_values TEXT;
    updates TEXT;
    saved_id BIGINT;
BEGIN
    CASE resource
      WHEN 'clinic' THEN
        primary_key := 'clinic_id';
        requires_access_admin := TRUE;
        allowed_fields := ARRAY['clinic_no', 'clinic_name', 'postal_address', 'phone', 'email', 'status'];
      WHEN 'employee' THEN
        primary_key := 'employee_id';
        requires_access_admin := TRUE;
        allowed_fields := ARRAY['employee_no', 'full_name', 'job_code', 'home_clinic_id'];
        IF resource_id IS NOT NULL THEN
            RAISE EXCEPTION 'Employee updates use the existing profile command' USING ERRCODE = '42501';
        END IF;
      WHEN 'user_account' THEN
        requires_access_admin := TRUE;
        allowed_fields := ARRAY['employee_id', 'login_identity', 'staff_password_hash'];
        IF resource_id IS NOT NULL THEN
            RAISE EXCEPTION 'The staff provisioning command only creates accounts' USING ERRCODE = '42501';
        END IF;
      WHEN 'qualification' THEN
        primary_key := 'qualification_id';
        allowed_fields := ARRAY['qualification_code', 'qualification_name'];
      WHEN 'employee_qualification' THEN
        allowed_fields := ARRAY['certificate_no', 'valid_from', 'valid_until'];
        IF resource_id IS NULL THEN
            allowed_fields := allowed_fields || ARRAY['employee_id', 'qualification_id'];
        END IF;
      WHEN 'dental_chair' THEN
        primary_key := 'chair_id';
        allowed_fields := ARRAY['clinic_id', 'chair_no', 'status', 'chair_kind'];
      WHEN 'material' THEN
        primary_key := 'material_id';
        allowed_fields := ARRAY['material_code', 'material_name', 'standard_unit', 'status'];
      WHEN 'material_cost' THEN
        allowed_fields := ARRAY['effective_to'];
        IF resource_id IS NULL THEN
            allowed_fields := allowed_fields || ARRAY['material_id', 'unit_cost', 'effective_from'];
        END IF;
      ELSE
        RAISE EXCEPTION 'Master data resource is outside the permitted scope' USING ERRCODE = '42501';
    END CASE;

    SELECT account.employee_id INTO actor_employee_id
    FROM public.user_account AS account
    JOIN public.employee AS employee ON employee.employee_id = account.employee_id
    WHERE account.id = actor_account_id AND account.status = 'ACTIVE' AND employee.status <> 'INACTIVE'
      AND EXISTS (
        SELECT 1 FROM public.employee_role AS grant_record
        JOIN public.app_role AS role_definition ON role_definition.role_id = grant_record.role_id
        WHERE grant_record.employee_id = employee.employee_id AND grant_record.scope_clinic_id IS NULL
          AND (role_definition.role_code = 'HQ_ACCESS_ADMIN'
               OR (NOT requires_access_admin AND role_definition.role_code = 'HQ_CATALOG'))
      );
    IF actor_employee_id IS NULL THEN
        RAISE EXCEPTION 'Missing the required chain-wide administration grant' USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(attributes) IS DISTINCT FROM 'object' OR attributes = '{}'::jsonb OR EXISTS (
        SELECT FROM jsonb_object_keys(attributes) AS fields(field) WHERE NOT field = ANY (allowed_fields)
    ) THEN
        RAISE EXCEPTION 'Master data fields are outside the permitted scope' USING ERRCODE = '42501';
    END IF;

    IF attributes ? 'status' AND (
        (resource IN ('clinic', 'material') AND (attributes->>'status') NOT IN ('ACTIVE', 'INACTIVE'))
        OR (resource = 'dental_chair' AND (attributes->>'status') NOT IN ('AVAILABLE', 'INACTIVE'))
    ) THEN
        RAISE EXCEPTION 'Master data status is outside the permitted scope' USING ERRCODE = '42501';
    END IF;

    IF resource = 'user_account' THEN
        target_employee_id := (attributes->>'employee_id')::BIGINT;
        IF target_employee_id IS NULL OR target_employee_id = actor_employee_id OR
            COALESCE(attributes->>'staff_password_hash', '') !~ '^pbkdf2_sha256[$]' OR
            COALESCE(attributes->>'login_identity', '') = '' OR lower(attributes->>'login_identity') LIKE 'wx:%' THEN
            RAISE EXCEPTION 'The account cannot be provisioned by this command' USING ERRCODE = '42501';
        END IF;
        PERFORM FROM public.employee
        WHERE employee_id = target_employee_id AND status = 'ACTIVE' FOR NO KEY UPDATE;
        IF NOT FOUND OR EXISTS (
            SELECT 1 FROM public.employee_role AS grant_record
            JOIN public.app_role AS role_definition ON role_definition.role_id = grant_record.role_id
            WHERE grant_record.employee_id = target_employee_id AND (
                role_definition.role_code IN (
                    'HQ_ACCESS_ADMIN', 'HQ_PERFORMANCE_CALCULATE', 'HQ_PERFORMANCE_REVIEW', 'HQ_PERFORMANCE_CONFIRM'
                )
                OR (grant_record.scope_clinic_id IS NULL
                    AND role_definition.role_code IN ('HQ_SCHEDULER', 'HQ_CATALOG', 'HQ_OPERATIONS_QUERY'))
            )
        ) THEN
            RAISE EXCEPTION 'This account is managed by deployment' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT string_agg(format('%I', field), ', ' ORDER BY field),
           string_agg(format('r.%I', field), ', ' ORDER BY field),
           string_agg(format('%1$I = r.%1$I', field), ', ' ORDER BY field)
    INTO field_names, field_values, updates
    FROM jsonb_object_keys(attributes) AS fields(field);

    IF resource_id IS NULL THEN
        EXECUTE format(
            'INSERT INTO public.%1$I (%2$s) SELECT %3$s FROM jsonb_populate_record(NULL::public.%1$I, $1) r RETURNING %4$I',
            resource, field_names, field_values, primary_key
        ) USING attributes INTO saved_id;
    ELSE
        EXECUTE format(
            'UPDATE public.%1$I AS row SET %2$s FROM jsonb_populate_record(NULL::public.%1$I, $1) r WHERE row.%3$I = $2 RETURNING row.%3$I',
            resource, updates, primary_key
        ) USING attributes, resource_id INTO saved_id;
    END IF;
    RETURN saved_id;
END;
$master$;

REVOKE ALL ON FUNCTION public.adc_write_master_data(BIGINT, TEXT, BIGINT, JSONB) FROM PUBLIC;
