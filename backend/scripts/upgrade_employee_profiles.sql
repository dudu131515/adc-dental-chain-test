-- Apply as the ADC business schema owner. Existing employees remain available for verified entry of their profiles.
ALTER TABLE public.employee
 ADD COLUMN IF NOT EXISTS job_code VARCHAR(20)
   CHECK (job_code IN ('HEADQUARTERS','CLINIC_MANAGER','FRONT_DESK','DENTIST')),
 ADD COLUMN IF NOT EXISTS home_clinic_id BIGINT REFERENCES public.clinic(clinic_id)
   CHECK ((job_code IS NULL AND home_clinic_id IS NULL)
       OR (job_code = 'HEADQUARTERS' AND home_clinic_id IS NULL)
       OR (job_code IS NOT NULL AND job_code <> 'HEADQUARTERS' AND home_clinic_id IS NOT NULL));
