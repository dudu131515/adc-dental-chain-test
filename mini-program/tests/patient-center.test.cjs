const assert = require("node:assert/strict");
const test = require("node:test");
const booking = require("../services/booking");

function visit(id, status, start, end) {
  return {
    appointment_id: id, appointment_no: "ADC-" + id, status, start_at: start, end_at: end,
    clinic: { clinic_id: "1", name: "中心门诊", address: "中心路" },
    dentist: { dentist_id: "3", name: "林医生" }, treatment: { treatment_type_id: "6", name: "检查" },
  };
}

test("current visits lead future appointments and outdated confirmations go into dated history in Shanghai", () => {
  assert.equal(typeof booking.groupAppointments, "function");
  const groups = booking.groupAppointments([
    visit("tomorrow", "CONFIRMED", "2031-01-09T02:00:00Z", "2031-01-09T03:00:00Z"),
    visit("old", "CONFIRMED", "2031-01-07T14:30:00Z", "2031-01-07T15:00:00Z"),
    visit("cancel", "CANCELLED", "2031-01-09T03:00:00Z", "2031-01-09T04:00:00Z"),
    visit("treat", "IN_TREATMENT", "2031-01-07T16:00:00Z", "2031-01-07T16:20:00Z"),
    visit("today", "CONFIRMED", "2031-01-08T03:00:00Z", "2031-01-08T04:00:00Z"),
  ], Date.parse("2031-01-07T16:30:00Z"));
  assert.deepEqual(groups.upcoming.map(x => x.id), ["treat", "today", "tomorrow"]);
  assert.deepEqual(groups.history.map(x => x.id), ["cancel", "old"]);
  assert.equal(groups.upcoming[0].dateLabel, "1月8日");
  assert.equal(groups.upcoming[0].time, "00:00–00:20");
  assert.equal(groups.upcoming[0].clinicName, "中心门诊");
});

test("deposit receipts show billed money, distinguish retained from refunded, and skip appointments without payments", () => {
  assert.equal(typeof booking.appointmentReceipts, "function");
  const older = visit("1","COMPLETED","2031-01-08T03:00:00Z","2031-01-08T04:00:00Z");
  const newer = visit("2","CANCELLED","2031-01-09T03:00:00Z","2031-01-09T04:00:00Z");
  const rows = booking.appointmentReceipts([
    {...older, deposit:{deposit_id:"10",amount:"50.00",status:"PAID"},refund:{refund_id:"20",amount:"25.00",status:"SUCCEEDED"}},
    {...newer, deposit:{deposit_id:"11",amount:"50.00",status:"PAID"},refund:{refund_id:"21",amount:"0.00",status:"RETAINED"}},
    {...older, appointment_id:"3"},
  ]);
  assert.deepEqual(rows.map(x => x.depositId), ["11", "10"]);
  assert.equal(rows[0].refundLabel, "已留存");
  assert.equal(rows[1].amount, "50.00");
  assert.equal(rows[1].refundAmount, "25.00");
  assert.equal(rows[1].appointmentId, "1");
});

test("changing the booking date never accepts an old request's time slots", async () => {
  let page;
  global.Page = definition => { page = {...definition, data:{...definition.data}, setData(data){ Object.assign(this.data,data); }}; };
  require("../pages/time-selection/index");
  const pending = [];
  global.wx = {
    getAccountInfoSync: () => ({miniProgram:{envVersion:"develop"}}),
    request: options => pending.push(options),
  };
  page.params = {clinic_id:"4",treatment_type_id:"3"};
  page.data.date = "2031-04-10";
  const first = page.refresh();
  page.data.date = "2031-04-11";
  const second = page.refresh();
  function respond(request, day) {
    request.success({statusCode:200,data:{data:{items:[{
      dentist_name:"医生",shift_id:day,start_at:"2031-04-"+day+"T03:00:00Z",end_at:"2031-04-"+day+"T04:00:00Z",
    }]}}});
  }
  respond(pending[1],"11");
  await second;
  respond(pending[0],"10");
  await first;
  assert.equal(page.data.slots[0].shift_id,"11");
});


test("an encoded native confirmation route keeps the selected dentist name and sends clean hold timestamps", () => {
  let page;
  global.Page = definition => { page = {...definition, data:{...definition.data}, setData(data){ Object.assign(this.data,data); }}; };
  require("../pages/booking-confirm/index");
  assert.doesNotThrow(() => page.onLoad({
    clinic_id:"4",dentist_id:"7",shift_id:"9",treatment_type_id:"3", dentist_name:"%E6%9E%97%E5%8C%BB%E7%94%9F",
    start_at:"2031-04-10T10%3A00%3A00%2B08%3A00",end_at:"2031-04-10T10%3A30%3A00%2B08%3A00",
  }));
  assert.equal(page.data.dentistName,"林医生");
  assert.equal(page.params.start_at,"2031-04-10T10:00:00+08:00");
  assert.equal("dentist_name" in page.params,false);
});

test("patient home opens the real next appointment and clears it when the server returns no appointments", async () => {
  const fs = require("node:fs");
  assert.ok(fs.existsSync(require("node:path").join(__dirname,"../pages/home/index.js")));
  let page, target, result=[visit("72","CONFIRMED","2099-05-03T01:00:00Z","2099-05-03T01:30:00Z")];
  global.Page = definition => { page = {...definition,data:{...definition.data},setData(fields){Object.assign(this.data,fields);}}; };
  require("../pages/home/index");
  global.wx = {
    getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}), login:({success})=>success({code:"test-home"}),
    navigateTo:({url})=>{target=url;},
    request:({url,success})=>{
      if (url.endsWith("/auth/mini/login")) return success({statusCode:200,data:{data:{patient_id:"41",profile_required:false,token:"own"}}});
      assert.ok(url.endsWith("/appointments")); success({statusCode:200,data:{data:{items:result}}});
    },
  };
  await page.onShow(); page.open();
  assert.equal(target,"/pages/appointment-detail/index?id=72");
  result=[]; await page.onShow();
  assert.equal(page.data.next,null);
});
