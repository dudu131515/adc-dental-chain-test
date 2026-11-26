-- ADC 数据库可复核测试。先在空白隔离数据库执行设计脚本，再执行本文件。
-- 全部样例写入在末尾回滚。psql -v ON_ERROR_STOP=1 -f ADC_PostgreSQL_验证.sql
BEGIN;
DO $$ DECLARE seq record; BEGIN
 FOR seq IN SELECT schemaname, sequencename FROM pg_sequences WHERE schemaname='public'
 LOOP EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH 10000',seq.schemaname,seq.sequencename); END LOOP;
END $$;
CREATE FUNCTION pg_temp.adc_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', msg; END IF;
END $$;
CREATE FUNCTION pg_temp.adc_reject(stmt text, expected text, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE stmt;
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE=expected THEN RETURN; END IF;
  RAISE;
 END;
 RAISE EXCEPTION 'FAIL: % unexpectedly succeeded', msg;
END $$;

DO $$
BEGIN
 PERFORM pg_temp.adc_assert((SELECT count(*)=41 FROM pg_tables WHERE schemaname='public'),'41 tables');
 PERFORM pg_temp.adc_assert((SELECT count(*)=279 FROM information_schema.columns col
  JOIN information_schema.tables tbl USING(table_schema,table_name)
  WHERE col.table_schema='public' AND tbl.table_type='BASE TABLE'),'279 table fields');
 PERFORM pg_temp.adc_assert((SELECT count(*)=72 FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace),'72 physical FKs');
 PERFORM pg_temp.adc_assert((SELECT count(*)=4 FROM pg_views WHERE schemaname='public'),'4 reporting views');
END $$;

INSERT INTO employee(employee_id,employee_no,full_name) VALUES
 (1,'E1','Dentist A'),(2,'E2','Dentist B'),(3,'E3','Front desk'),(4,'E4','Supervisor');
INSERT INTO clinic(clinic_id,clinic_no,clinic_name,postal_address) VALUES
 (1,'C1','Demo North Dental Clinic','Test'),(2,'C2','Demo South Dental Clinic','Test');
INSERT INTO app_role(role_id,role_code,role_name) VALUES(1,'HQ','HQ'),(2,'FRONT_DESK','Front desk');
INSERT INTO employee_role(employee_id,role_id) VALUES(1,1);
INSERT INTO employee_role(employee_id,role_id,scope_clinic_id) VALUES(3,2,1);
INSERT INTO user_account(id,employee_id,login_identity) VALUES(1,3,'demo-front-desk');
DO $$ BEGIN
 PERFORM pg_temp.adc_reject('INSERT INTO employee_role(employee_id,role_id) VALUES(1,1)','23505','global role uniqueness');
 PERFORM pg_temp.adc_reject('UPDATE employee SET job_code=''DENTIST'' WHERE employee_id=3','23514','local job requires a home clinic');
 UPDATE employee SET job_code='DENTIST', home_clinic_id=2 WHERE employee_id=3;
 PERFORM pg_temp.adc_assert((SELECT e.job_code='DENTIST' AND e.home_clinic_id=2 AND er.scope_clinic_id=1
  FROM employee e JOIN employee_role er USING(employee_id) WHERE e.employee_id=3),'job, home clinic and grant are independent');
END $$;
INSERT INTO shift(shift_id,clinic_id,dentist_id,start_at,end_at,status) VALUES
 (1,1,1,'2026-06-30 21:00+08','2026-07-01 04:00+08','PUBLISHED'),
 (2,2,2,'2026-06-30 21:00+08','2026-07-01 08:00+08','PUBLISHED'),
 (3,2,1,'2026-07-01 05:00+08','2026-07-01 09:00+08','PUBLISHED');
INSERT INTO dental_chair(chair_id,clinic_id,chair_no) VALUES(1,1,'A'),(3,2,'C');
INSERT INTO dental_chair(chair_id,clinic_id,chair_no,chair_kind) VALUES(2,2,'B','SURGICAL');
INSERT INTO dental_chair_unavailability(chair_id,start_at,end_at,reason) VALUES
 (1,'2026-07-01 00:30+08','2026-07-01 01:00+08','Maintenance'),
 (1,'2026-07-01 01:00+08','2026-07-01 01:30+08','Calibration'),
 (2,'2026-07-01 00:30+08','2026-07-01 01:00+08','Maintenance');
INSERT INTO treatment_type(treatment_type_id,treatment_code,treatment_name,standard_unit,default_slot_minutes,required_chair_kind) VALUES
 (1,'X','Demo checkup','unit',30,'GENERAL'),(2,'Y','Demo consultation','unit',NULL,NULL),
 (3,'Z','Demo surgery','unit',45,'SURGICAL');
DO $$ BEGIN
 PERFORM pg_temp.adc_assert((SELECT chair_kind='GENERAL' FROM dental_chair WHERE chair_id=1),'default chair class');
 PERFORM pg_temp.adc_assert((SELECT default_slot_minutes IS NULL AND required_chair_kind IS NULL
 FROM treatment_type WHERE treatment_type_id=2),'dentist estimate and unrestricted chair class');
 PERFORM pg_temp.adc_reject($t$UPDATE dental_chair SET chair_kind=' ' WHERE chair_id=1$t$,'23514','blank chair class');
 PERFORM pg_temp.adc_reject($t$UPDATE treatment_type SET default_slot_minutes=0 WHERE treatment_type_id=1$t$,'23514','default duration must be positive');
 PERFORM pg_temp.adc_reject($t$UPDATE treatment_type SET required_chair_kind=' ' WHERE treatment_type_id=1$t$,'23514','blank required chair class');
 PERFORM pg_temp.adc_reject($t$INSERT INTO dental_chair_unavailability(chair_id,start_at,end_at,reason)
 VALUES(1,'2026-07-01 00:45+08','2026-07-01 01:00+08','Demo')$t$,'23P01','overlapping unavailability on one chair');
 PERFORM pg_temp.adc_reject($t$INSERT INTO dental_chair_unavailability(chair_id,start_at,end_at,reason)
 VALUES(1,'2026-07-01 03:00+08','2026-07-01 03:00+08','Demo')$t$,'23514','empty unavailability interval');
END $$;
-- 示例班次的跨店间隔为 60 分钟。核准工作日历、整段分类容量和跨店间隔的拦截由服务验收。
INSERT INTO patient(patient_id,patient_no,full_name,birth_date,billing_address,phone,emergency_name,emergency_phone) VALUES
 (1,'P1','Sample A','2000-01-01','Test','100','Contact','101'),
 (2,'P2','Sample B','2000-01-01','Test','102','Contact','103');
INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,expires_at,status) VALUES
 (1,1,1,1,1,1,'GENERAL','2026-06-30 22:00+08','2026-06-30 22:30+08',NULL,'RELEASED'),
 (2,1,1,1,1,1,'GENERAL','2026-07-01 00:00+08','2026-07-01 00:30+08',NULL,'CONFIRMED'),
 (3,2,1,1,1,1,'GENERAL','2026-07-01 01:30+08','2026-07-01 02:00+08',NULL,'RELEASED'),
 (4,2,2,2,2,1,'GENERAL','2026-07-01 00:00+08','2026-07-01 00:30+08',NULL,'RELEASED'),
 (5,2,2,2,2,3,'SURGICAL','2026-07-01 02:00+08','2026-07-01 02:45+08','2026-07-01 01:40+08','HOLD');
INSERT INTO deposit_payment(deposit_id,claim_id,amount,status,payment_token,paid_at) VALUES
 (1,1,50,'PAID','original','2026-06-28 11:00+08'),
 (2,3,50,'PAID','patient-cancel','2026-06-28 11:30+08'),
 (3,4,50,'PAID','clinic-cancel','2026-06-29 11:00+08');
INSERT INTO appointment(appointment_id,appointment_no,claim_id,deposit_id,status,is_attended) VALUES
 (1,'A1',2,1,'COMPLETED',true),(2,'A2',3,2,'CANCELLED',false),(3,'A3',4,3,'CANCELLED',false);
INSERT INTO appointment_change(appointment_id,change_type,cancel_party,old_claim_id,new_claim_id,changed_by_patient_id,changed_at) VALUES
 (1,'RESCHEDULE',NULL,1,2,1,'2026-06-29 19:59+08'),(2,'CANCEL','PATIENT',3,NULL,2,'2026-06-29 22:30+08');
INSERT INTO appointment_change(appointment_id,change_type,cancel_party,old_claim_id,changed_by,reason,changed_at)
 VALUES(3,'CANCEL','CLINIC',4,4,'Dentist unavailable','2026-06-30 23:45+08');
INSERT INTO appointment_requested_treatment(appointment_id,treatment_type_id) VALUES(1,2);
INSERT INTO chair_usage(appointment_id,chair_id,assigned_at,released_at)
 VALUES (1,1,'2026-07-01 00:00+08','2026-07-01 00:30+08');
DO $$ BEGIN
 PERFORM pg_temp.adc_reject($t$INSERT INTO shift(clinic_id,dentist_id,start_at,end_at,status)
 VALUES(2,1,'2026-07-01 00:00+08','2026-07-01 02:00+08','PUBLISHED')$t$,'23P01','doctor shift collision across clinics');
 PERFORM pg_temp.adc_reject($t$INSERT INTO slot_claim(patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,start_at,end_at,expires_at,status)
 VALUES(2,1,1,1,1,'2026-07-01 00:01+08','2026-07-01 00:29+08','2026-07-01 00:03+08','HOLD')$t$,'23P01','active dentist claim overlap');
 PERFORM pg_temp.adc_reject($t$UPDATE slot_claim SET requested_treatment_type_id=999 WHERE claim_id=2$t$,'23503','main requested treatment must exist');
 PERFORM pg_temp.adc_reject($t$UPDATE slot_claim SET requested_treatment_type_id=NULL WHERE claim_id=2$t$,'23502','main requested treatment is required');
 PERFORM pg_temp.adc_reject($t$UPDATE slot_claim SET required_chair_kind=' ' WHERE claim_id=2$t$,'23514','blank chair snapshot');
 PERFORM pg_temp.adc_reject($t$INSERT INTO chair_usage(appointment_id,chair_id,assigned_at,released_at)
 VALUES(2,1,'2026-07-01 00:10+08','2026-07-01 00:40+08')$t$,'23P01','chair collision');
 PERFORM pg_temp.adc_reject($t$UPDATE appointment SET status='CHECKED_IN' WHERE appointment_id=1$t$,'23514','check-in cannot mean attended');
 PERFORM pg_temp.adc_reject($t$UPDATE deposit_payment SET payment_token='original' WHERE deposit_id=2$t$,'23505','duplicate payment token');
 UPDATE treatment_type SET required_chair_kind=NULL WHERE treatment_type_id=1;
 PERFORM pg_temp.adc_assert((SELECT required_chair_kind='GENERAL' FROM slot_claim WHERE claim_id=2),'claim chair class remains a snapshot');
 UPDATE treatment_type SET required_chair_kind='GENERAL' WHERE treatment_type_id=1;
END $$;

INSERT INTO visit(visit_id,appointment_id,main_dentist_id,started_at,ended_at,status,termination_reason) VALUES
 (1,1,1,'2026-07-01 00:00+08','2026-07-01 00:20+08','TERMINATED','Test stop');
INSERT INTO invoice(invoice_id,invoice_no,visit_id,original_total,status,issued_at)
 VALUES(1,'I1',1,0,'SETTLED','2026-10-01 00:02+08');
INSERT INTO deposit_refund(deposit_id,refund_amount,reason,status,idempotency_key) VALUES (1,50,'attended','SUCCEEDED','attend-1');
INSERT INTO deposit_refund(deposit_id,refund_amount,reason,status,idempotency_key) VALUES
 (2,50,'patient cancellation at least 24 hours','SUCCEEDED','cancel-2'),(3,50,'dentist unavailable','SUCCEEDED','cancel-3');
INSERT INTO treatment_price(treatment_type_id,unit_price,effective_from,effective_to) VALUES (1,100,'2026-01-01','2026-07-01'),(1,120,'2026-07-01',NULL);
DO $$ BEGIN
 PERFORM pg_temp.adc_reject($t$INSERT INTO treatment_price(treatment_type_id,unit_price,effective_from,effective_to)
 VALUES (1,90,'2026-02-01','2026-03-01')$t$,'23P01','overlapping price versions');
 PERFORM pg_temp.adc_reject($t$INSERT INTO invoice(invoice_no,visit_id,original_total,status) VALUES('I2',1,100,'ISSUED')$t$,'23505','one invoice per visit');
 PERFORM pg_temp.adc_reject($t$INSERT INTO deposit_refund(deposit_id,refund_amount,reason,status,idempotency_key) VALUES(1,50,'duplicate','PENDING','attend-1')$t$,'23505','duplicate refund obligation');
 PERFORM pg_temp.adc_reject($t$INSERT INTO treatment_item(visit_id,treatment_type_id,performing_dentist_id,units,unit_name_snapshot,unit_price_snapshot,amount,patient_consented,is_additional)
 VALUES(1,1,1,1,'unit',120,120,false,true)$t$,'23514','no additional treatment without consent');
 PERFORM pg_temp.adc_assert((SELECT count(*)=0 FROM invoice_line WHERE invoice_id=1),'zero-line terminated invoice');
 PERFORM pg_temp.adc_assert((SELECT ended_local_date='2026-07-01' AND accrued_amount=0 AND refund_due=0 FROM invoice_reporting_fact WHERE invoice_id=1),'accrual uses local visit end, not issue date');
 PERFORM pg_temp.adc_assert((SELECT count(*)=2 AND count(*) FILTER(WHERE patient_cancelled)=1 AND count(*) FILTER(WHERE is_attended)=1
 FROM appointment_reporting_fact WHERE service_date='2026-07-01' AND NOT clinic_cancelled),'same denominator and final appointment date');
 PERFORM pg_temp.adc_assert((SELECT count(*)=1 FROM appointment_reporting_fact WHERE clinic_cancelled),'clinic cancellation separately counted');
 PERFORM pg_temp.adc_assert((SELECT count(*)=0 FROM appointment_reporting_fact WHERE service_date='2026-06-30'),'no old reschedule slot');
END $$;

INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,status)
 VALUES(6,1,2,2,2,1,'GENERAL','2026-07-01 03:00+08','2026-07-01 03:30+08','CONFIRMED');
INSERT INTO deposit_payment(deposit_id,claim_id,amount,status,payment_token) VALUES(4,6,50,'PAID','second');
INSERT INTO appointment(appointment_id,appointment_no,claim_id,deposit_id,status,is_attended) VALUES(4,'A4',6,4,'COMPLETED',true);
INSERT INTO visit(visit_id,appointment_id,main_dentist_id,started_at,ended_at,status)
 VALUES(2,4,2,'2026-07-01 03:00+08','2026-07-01 03:20+08','COMPLETED');
INSERT INTO treatment_item(item_id,visit_id,treatment_type_id,performing_dentist_id,units,unit_name_snapshot,unit_price_snapshot,amount,patient_consented,is_additional)
 VALUES(2,2,1,2,1,'unit',120,120,false,false),(3,2,1,2,1,'unit',120,120,true,true);
INSERT INTO invoice(invoice_id,invoice_no,visit_id,original_total,status,issued_at)
 VALUES(2,'I2',2,240,'SETTLED','2026-07-01 03:25+08');
INSERT INTO invoice_line(invoice_id,treatment_item_id,treatment_name_snapshot,unit_name_snapshot,units,unit_price,subtotal)
 VALUES(2,2,'Sample','unit',1,120,120),(2,3,'Sample','unit',1,120,120);
INSERT INTO invoice_payment(payment_id,invoice_id,payment_kind,amount,status,idempotency_key,paid_at)
 VALUES(1,2,'PAYMENT',240,'SUCCEEDED','clinical-pay','2026-07-01 03:30+08');
INSERT INTO treatment_correction(id,visit_id,requested_by,reason,proposed_changes,status)
 VALUES(1,2,2,'Sample adjustment','{"delta":-20}','APPLIED');
INSERT INTO correction_approval(correction_id,reviewer_id,decision) VALUES(1,1,'APPROVED');
INSERT INTO invoice_adjustment(id,invoice_id,correction_id,signed_amount) VALUES(1,2,1,-20);
INSERT INTO invoice_payment(invoice_id,payment_kind,amount,status,idempotency_key,adjustment_id,source_payment_id)
 VALUES(2,'REFUND',20,'SUCCEEDED','clinical-refund',1,1);
DO $$ BEGIN
 PERFORM pg_temp.adc_assert((SELECT original_total=240 FROM invoice WHERE invoice_id=2),'preserve original amount');
 PERFORM pg_temp.adc_assert((SELECT accrued_amount=220 AND received_amount=240 AND refunded_amount=20 AND outstanding_amount=0 AND refund_due=0
 FROM invoice_reporting_fact WHERE invoice_id=2),'approved adjustment and real refund');
END $$;

-- 固定截点覆盖已结束未处理、医生停诊取消和已开始但未结束的预约。
INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,status) VALUES
 (7,2,1,1,1,1,'GENERAL','2026-07-01 02:00+08','2026-07-01 02:30+08','CONFIRMED'),
 (8,1,1,1,1,1,'GENERAL','2026-07-01 02:30+08','2026-07-01 03:00+08','CONFIRMED'),
 (9,2,2,2,2,2,NULL,'2026-07-01 02:45+08','2026-07-01 03:00+08','CONFIRMED'),
 (10,1,2,1,3,1,'GENERAL','2026-07-01 05:00+08','2026-07-01 05:30+08','CONFIRMED'),
 (11,2,2,1,3,1,'GENERAL','2026-07-01 06:45+08','2026-07-01 07:15+08','CONFIRMED'),
 (12,1,2,2,2,2,NULL,'2026-07-01 07:00+08','2026-07-01 07:30+08','CONFIRMED');
INSERT INTO deposit_payment(deposit_id,claim_id,amount,status,payment_token,paid_at) VALUES
 (5,7,50,'PAID','no-show','2026-06-29 10:15+08'),(6,8,50,'PAID','pending-arrival','2026-06-29 10:15+08'),
 (7,9,50,'PAID','pending-checkin','2026-06-29 10:15+08'),(8,10,50,'PAID','third','2026-06-29 10:15+08'),
 (9,11,50,'PAID','fourth','2026-06-29 10:15+08'),(10,12,50,'PAID','slot-open-at-cutoff','2026-06-29 10:15+08');
INSERT INTO appointment(appointment_id,appointment_no,claim_id,deposit_id,status,is_attended,confirmed_at) VALUES
 (5,'A5',7,5,'CONFIRMED',false,'2026-06-29 10:15+08'),(6,'A6',8,6,'CONFIRMED',false,'2026-06-29 10:15+08'),
 (7,'A7',9,7,'CHECKED_IN',false,'2026-06-29 10:15+08'),(8,'A8',10,8,'COMPLETED',true,'2026-06-29 10:15+08'),
 (9,'A9',11,9,'COMPLETED',true,'2026-06-29 10:15+08'),(10,'A10',12,10,'CONFIRMED',false,'2026-06-29 10:15+08');
INSERT INTO visit(visit_id,appointment_id,main_dentist_id,started_at,ended_at,status) VALUES
 (3,8,1,'2026-07-01 05:00+08','2026-07-01 05:20+08','COMPLETED'),
 (4,9,1,'2026-07-01 06:45+08','2026-07-01 07:05+08','COMPLETED');
INSERT INTO dentist_work_session(visit_id,dentist_id,started_at,ended_at,duration_minutes) VALUES
 (1,1,'2026-07-01 00:00+08','2026-07-01 00:20+08',20),
 (2,2,'2026-07-01 03:00+08','2026-07-01 03:20+08',20),
 (3,1,'2026-07-01 05:00+08','2026-07-01 05:20+08',20),
 (4,1,'2026-07-01 06:45+08','2026-07-01 07:05+08',20);

-- 前台授权、结束时点、到诊与停诊核实，以及状态、资金、审计联动由服务验收。
-- 此处验证爽约需要员工，并演示人工确认后保存的记录与报表归类。
DO $$ BEGIN
 PERFORM pg_temp.adc_reject($t$INSERT INTO appointment_change(appointment_id,change_type,old_claim_id,changed_at)
 VALUES(5,'NO_SHOW',7,'2026-07-01 02:30+08')$t$,'23514','no-show record requires an employee');
END $$;
UPDATE appointment SET status='NO_SHOW' WHERE appointment_id=5;
UPDATE slot_claim SET status='RELEASED' WHERE claim_id=7;
INSERT INTO appointment_change(appointment_id,change_type,old_claim_id,changed_by,reason,changed_at)
 VALUES(5,'NO_SHOW',7,3,'Front desk verified absence','2026-07-01 02:30+08');
INSERT INTO deposit_refund(deposit_id,refund_amount,reason,status,idempotency_key)
 VALUES(5,0,'verified no-show','RETAINED','no-show-5');
INSERT INTO audit_log(account_id,action,target_type,target_id,before_value,after_value,occurred_at)
 VALUES(1,'CONFIRM_NO_SHOW','APPOINTMENT',5,'{"status":"CONFIRMED"}','{"status":"NO_SHOW"}','2026-07-01 02:30+08');
DO $$ BEGIN
 PERFORM pg_temp.adc_assert((SELECT s.status='RELEASED' AND ch.changed_at=s.end_at AND ch.changed_by=3
  AND audit.after_value->>'status'='NO_SHOW' AND refund.status='RETAINED' AND refund.refund_amount=0
 FROM appointment a JOIN slot_claim s ON s.claim_id=a.claim_id
 JOIN appointment_change ch ON ch.appointment_id=a.appointment_id AND ch.change_type='NO_SHOW'
 JOIN audit_log audit ON audit.target_type='APPOINTMENT' AND audit.target_id=a.appointment_id AND audit.action='CONFIRM_NO_SHOW'
 JOIN user_account u ON u.id=audit.account_id AND u.employee_id=ch.changed_by
 JOIN deposit_refund refund ON refund.deposit_id=a.deposit_id
 WHERE a.appointment_id=5),'manual no-show at end time, audit and retained deposit');
 PERFORM pg_temp.adc_assert((SELECT v.ended_at='2026-07-01 07:05+08'::timestamptz
   AND r.slot_end_at>'2026-07-01 07:14+08'::timestamptz
   AND r.slot_end_at='2026-07-01 07:15+08'::timestamptz AND r.is_attended
  FROM appointment_reporting_fact r JOIN visit v USING(appointment_id)
  WHERE r.appointment_id=9),'early visit ends before cutoff but counts only at scheduled end');
 PERFORM pg_temp.adc_assert((SELECT count(*)=8 AND count(*) FILTER(WHERE is_attended)=4
   AND count(*) FILTER(WHERE patient_cancelled)=1 AND count(*) FILTER(WHERE status='NO_SHOW')=1
   AND count(*) FILTER(WHERE status IN ('CONFIRMED','CHECKED_IN'))=2
   AND count(*) FILTER(WHERE is_attended)::numeric/NULLIF(count(*),0)=0.50
   AND count(*) FILTER(WHERE patient_cancelled)::numeric/NULLIF(count(*),0)=0.125
 FROM appointment_reporting_fact WHERE service_date='2026-07-01' AND NOT clinic_cancelled
   AND slot_end_at<='2026-07-01 07:15+08'::timestamptz),'as-of denominator, 50% attended and 12.5% patient cancellations');
 PERFORM pg_temp.adc_assert((SELECT count(*)=1 FROM appointment_reporting_fact
  WHERE service_date='2026-07-01' AND slot_end_at>'2026-07-01 07:15+08'::timestamptz),'unfinished slot excluded at cutoff');
 PERFORM pg_temp.adc_assert((SELECT count(*)=1 FROM appointment_reporting_fact
  WHERE service_date='2026-07-01' AND slot_end_at<='2026-07-01 07:15+08'::timestamptz AND clinic_cancelled),'clinic cancellation for dentist unavailability reported separately');
END $$;

INSERT INTO treatment_item(item_id,visit_id,treatment_type_id,performing_dentist_id,units,unit_name_snapshot,unit_price_snapshot,amount)
 VALUES(4,3,1,1,1,'unit',120,120);
INSERT INTO material(material_id,material_code,material_name,standard_unit) VALUES(1,'MAT1','Demo material','unit');
INSERT INTO material_usage(treatment_item_id,material_id,quantity,unit_cost_snapshot) VALUES(2,1,1,10);
INSERT INTO invoice(invoice_id,invoice_no,visit_id,original_total,status,issued_at)
 VALUES(3,'I3',3,120,'SETTLED','2026-07-01 05:25+08');
INSERT INTO invoice_line(invoice_id,treatment_item_id,treatment_name_snapshot,unit_name_snapshot,units,unit_price,subtotal)
 VALUES(3,4,'Demo checkup','unit',1,120,120);
INSERT INTO invoice_payment(payment_id,invoice_id,payment_kind,amount,status,idempotency_key,paid_at)
 VALUES(2,3,'PAYMENT',120,'SUCCEEDED','reversal-original-payment','2026-07-01 05:30+08');

INSERT INTO performance_period(period_id,perf_year,perf_quarter,status) VALUES(1,2026,3,'CONFIRMED'),(2,2026,4,'REVIEW');
INSERT INTO operating_expense(expense_id,clinic_id,period_id,expense_category,amount,scope,dentist_id) VALUES
 (1,2,1,'Demo direct cost',60,'DIRECT',2),(2,1,2,'Demo rent',60,'SHARED',NULL);
INSERT INTO performance_revision(period_id,revision_no,confirmed_by,confirmed_at) VALUES
 (1,1,4,'2026-10-01 09:00+08'),(2,1,NULL,NULL);
INSERT INTO company_performance(period_id,revenue,material_cost,operating_cost,net_profit,incentive_fund,calculated_at) VALUES
 (1,340,10,60,270,27,'2026-10-01 08:30+08'),(2,0,0,60,-60,0,'2027-01-01 08:30+08');
INSERT INTO dentist_performance(period_id,dentist_id,clinic_id,revenue,material_cost,operating_cost,net_profit) VALUES
 (1,1,1,0,0,0,0),(1,1,2,120,0,0,120),(1,2,2,220,10,60,150);

-- 全额冲销沿用已批准更正、差额和实际退款。季度归期仍按原 Visit 本地结束日期。
INSERT INTO treatment_correction(id,visit_id,requested_by,reason,proposed_changes,status,requested_at)
 VALUES(2,3,1,'Demo full reversal','{"delta":-120}','APPLIED','2026-10-04 08:30+08');
INSERT INTO correction_approval(correction_id,reviewer_id,decision,decided_at)
 VALUES(2,4,'APPROVED','2026-10-04 09:00+08');
INSERT INTO invoice_adjustment(id,invoice_id,correction_id,signed_amount,created_at)
 VALUES(2,3,2,-120,'2026-10-04 09:15+08');
DO $$ BEGIN
 PERFORM pg_temp.adc_assert((SELECT accrued_amount=0 AND received_amount=120 AND refunded_amount=0
  AND outstanding_amount=0 AND refund_due=120 AND ended_local_date='2026-07-01'
 FROM invoice_reporting_fact WHERE invoice_id=3),'full reversal creates a refund due in the original quarter');
END $$;
INSERT INTO invoice_payment(invoice_id,payment_kind,amount,status,idempotency_key,adjustment_id,source_payment_id,paid_at)
 VALUES(3,'REFUND',120,'SUCCEEDED','reversal-refund',2,2,'2026-10-04 09:20+08');
INSERT INTO performance_revision(period_id,revision_no,source_adjustment_id,confirmed_by,confirmed_at)
 VALUES(1,2,2,4,'2026-10-04 10:00+08');
INSERT INTO company_performance(period_id,revision_no,revenue,material_cost,operating_cost,net_profit,incentive_fund,calculated_at)
 VALUES(1,2,220,10,60,150,15,'2026-10-04 09:30+08');
INSERT INTO dentist_performance(period_id,revision_no,dentist_id,clinic_id,revenue,material_cost,operating_cost,net_profit) VALUES
 (1,2,1,1,0,0,0,0),(1,2,1,2,0,0,0,0),(1,2,2,2,220,10,60,150);
DO $$ BEGIN
 PERFORM pg_temp.adc_assert((SELECT unallocated=60 FROM expense_reporting_fact WHERE expense_id=2),'zero minute expense remains unallocated');
 PERFORM pg_temp.adc_assert((SELECT original_total=120 AND status='SETTLED' FROM invoice WHERE invoice_id=3),'full reversal preserves original invoice');
 PERFORM pg_temp.adc_assert((SELECT count(*)=1 AND SUM(subtotal)=120 FROM invoice_line WHERE invoice_id=3),'full reversal preserves original lines');
 PERFORM pg_temp.adc_assert((SELECT accrued_amount=0 AND received_amount=120 AND refunded_amount=120
  AND outstanding_amount=0 AND refund_due=0 FROM invoice_reporting_fact WHERE invoice_id=3),'full reversal refund closes the balance');
 PERFORM pg_temp.adc_reject($t$INSERT INTO invoice_payment(invoice_id,payment_kind,amount,status,idempotency_key)
 VALUES(3,'REFUND',1,'PENDING','missing-source')$t$,'23514','refund requires the original payment');
 PERFORM pg_temp.adc_reject($t$INSERT INTO invoice_payment(invoice_id,payment_kind,amount,status,idempotency_key,source_payment_id)
 VALUES(3,'PAYMENT',1,'PENDING','payment-with-source',2)$t$,'23514','payment has no refund source');
 PERFORM pg_temp.adc_reject($t$INSERT INTO invoice_payment(invoice_id,payment_kind,amount,status,idempotency_key,source_payment_id)
 VALUES(3,'REFUND',1,'PENDING','unknown-source',999)$t$,'23503','refund source must exist');
 PERFORM pg_temp.adc_assert((SELECT revenue=340 AND net_profit=270 AND incentive_fund=27
  AND source_adjustment_id IS NULL AND incentive_fund_delta=0 AND confirmed_by=4
 FROM company_performance_revision_fact WHERE period_id=1 AND revision_no=1),'original confirmed company snapshot preserved');
 PERFORM pg_temp.adc_assert((SELECT revenue=220 AND material_cost=10 AND operating_cost=60 AND net_profit=150 AND incentive_fund=15
  AND original_revenue=340 AND original_material_cost=10 AND original_operating_cost=60
  AND original_net_profit=270 AND original_incentive_fund=27
  AND revenue_delta=-120 AND material_cost_delta=0 AND operating_cost_delta=0 AND net_profit_delta=-120 AND incentive_fund_delta=-12
  AND source_adjustment_id=2 AND confirmed_by=4
 FROM company_performance_revision_fact WHERE period_id=1 AND revision_no=2),'company revision compares original, revised values and deltas');
 PERFORM pg_temp.adc_assert((SELECT count(*)=4 AND SUM(revenue) FILTER(WHERE revision_no=1)=120
  AND SUM(revenue) FILTER(WHERE revision_no=2)=0 FROM dentist_performance WHERE period_id=1 AND dentist_id=1),'cross-clinic dentist results preserve both revisions');
 PERFORM pg_temp.adc_reject($t$UPDATE company_performance SET incentive_fund=1 WHERE period_id=2$t$,'23514','negative profit produces no fund');
 PERFORM pg_temp.adc_reject($t$INSERT INTO company_performance(period_id,revision_no) VALUES(1,2)$t$,'23505','one company result per quarter and revision');
 PERFORM pg_temp.adc_reject($t$INSERT INTO dentist_performance(period_id,revision_no,dentist_id,clinic_id) VALUES(1,2,1,2)$t$,'23505','one dentist result per clinic, quarter and revision');
 PERFORM pg_temp.adc_reject($t$INSERT INTO company_performance(period_id,revision_no) VALUES(2,2)$t$,'23503','company result references existing period and revision pair');
 PERFORM pg_temp.adc_reject($t$INSERT INTO dentist_performance(period_id,revision_no,dentist_id,clinic_id) VALUES(2,2,1,2)$t$,'23503','dentist result references existing period and revision pair');
 PERFORM pg_temp.adc_reject($t$INSERT INTO performance_revision(period_id,revision_no,source_adjustment_id) VALUES(2,0,1)$t$,'23514','revision number starts at one');
 PERFORM pg_temp.adc_reject($t$UPDATE performance_revision SET source_adjustment_id=1 WHERE period_id=2 AND revision_no=1$t$,'23514','original revision has no source adjustment');
 PERFORM pg_temp.adc_reject($t$INSERT INTO performance_revision(period_id,revision_no) VALUES(2,2)$t$,'23514','later revision requires a source adjustment');
 PERFORM pg_temp.adc_reject($t$INSERT INTO performance_revision(period_id,revision_no,source_adjustment_id) VALUES(2,2,2)$t$,'23505','an adjustment produces at most one revision');
 PERFORM pg_temp.adc_reject($t$INSERT INTO performance_revision(period_id,revision_no,source_adjustment_id) VALUES(2,2,999)$t$,'23503','revision links to a recorded adjustment');
 PERFORM pg_temp.adc_reject($t$UPDATE performance_revision SET confirmed_by=4 WHERE period_id=2 AND revision_no=1$t$,'23514','confirmation actor and instant must accompany each other');
END $$;

-- 这个保存点中的样例为改期迭代，回退后保留预约统计场景的固定基数。
SAVEPOINT overlapping_reschedule;
INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,status) VALUES
 (50,1,2,1,3,1,'GENERAL','2026-07-01 07:45+08','2026-07-01 08:15+08','CONFIRMED'),
 (51,2,2,1,3,1,'GENERAL','2026-07-01 08:30+08','2026-07-01 09:00+08','CONFIRMED');
INSERT INTO deposit_payment(deposit_id,claim_id,amount,status,payment_token,paid_at)
 VALUES(50,50,50,'PAID','overlapping-reschedule-deposit','2026-06-26 09:00+08');
INSERT INTO appointment(appointment_id,appointment_no,claim_id,deposit_id,status,confirmed_at)
 VALUES(50,'A50',50,50,'CONFIRMED','2026-06-26 09:00+08');
DO $$ BEGIN PERFORM clinic_id FROM clinic WHERE clinic_id=2 FOR UPDATE; END $$;
SET CONSTRAINTS slot_claim_dentist_time_excl DEFERRED;
INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,status)
 VALUES(52,1,2,1,3,1,'GENERAL','2026-07-01 07:55+08','2026-07-01 08:25+08','CONFIRMED');
UPDATE appointment SET claim_id=52 WHERE appointment_id=50;
UPDATE slot_claim SET status='RELEASED' WHERE claim_id=50;
SET CONSTRAINTS slot_claim_dentist_time_excl IMMEDIATE;
DO $$ DECLARE inserted_replacement boolean := false; BEGIN
 PERFORM pg_temp.adc_assert((SELECT a.claim_id=52 AND a.deposit_id=50 AND old.status='RELEASED' AND replacement.status='CONFIRMED'
 FROM appointment a JOIN deposit_payment d ON d.deposit_id=a.deposit_id
 JOIN slot_claim old ON old.claim_id=d.claim_id JOIN slot_claim replacement ON replacement.claim_id=a.claim_id
 WHERE a.appointment_id=50),'overlapping replacement is valid after release and preserves deposit');
 BEGIN
  SET CONSTRAINTS slot_claim_dentist_time_excl DEFERRED;
  INSERT INTO slot_claim(claim_id,patient_id,clinic_id,dentist_id,shift_id,requested_treatment_type_id,required_chair_kind,start_at,end_at,status)
   VALUES(53,1,2,1,3,1,'GENERAL','2026-07-01 08:15+08','2026-07-01 08:45+08','CONFIRMED');
  inserted_replacement := true;
  UPDATE appointment SET claim_id=53 WHERE appointment_id=50;
  UPDATE slot_claim SET status='RELEASED' WHERE claim_id=52;
  SET CONSTRAINTS slot_claim_dentist_time_excl IMMEDIATE;
  RAISE EXCEPTION 'FAIL: replacement still overlaps another active dentist claim';
 EXCEPTION WHEN exclusion_violation THEN
  PERFORM pg_temp.adc_assert(inserted_replacement,'other active claim conflict rejected at immediate recheck');
 END;
 PERFORM pg_temp.adc_assert((SELECT a.claim_id=52 AND s.status='CONFIRMED' FROM appointment a
 JOIN slot_claim s ON s.claim_id=a.claim_id WHERE a.appointment_id=50)
 AND NOT EXISTS(SELECT FROM slot_claim WHERE claim_id=53),'failed replacement rolls back the new claim, appointment and old release');
END $$;
ROLLBACK TO SAVEPOINT overlapping_reschedule;
RELEASE SAVEPOINT overlapping_reschedule;

ROLLBACK;
SELECT 'PASS ADC PostgreSQL schema and scenario tests' AS adc_result;

