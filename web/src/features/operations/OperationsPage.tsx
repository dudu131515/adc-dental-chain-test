import { useEffect, useState } from "react";
import { WorkArea } from "../../shared/AppShell";
import { hasRole, performanceRoles } from "../../shared/navigation";
import { ExpensesPage } from "./ExpensesPage";
import { OperationsReport } from "./OperationsReport";
import { QuarterReview } from "./QuarterReview";
import "./operations.css";

export function OperationsPage({ identity, clinicId, path, open, showTabs = true }: WorkArea & {showTabs?: boolean}) {
  const canReport = hasRole(identity, ["HQ_OPERATIONS_QUERY"], clinicId);
  const canQuarter = hasRole(identity, performanceRoles, clinicId);
  const canManageClinic = hasRole(identity, ["CLINIC_MANAGER"], clinicId);
  const canExpense = canManageClinic || canQuarter;
  const initial = canReport ? "report" : canManageClinic ? "expenses" : "quarters";
  const active = path.split("/")[2] || initial;
  const [visitedReport, setVisitedReport] = useState(active === "report");
  useEffect(() => {
    if (active === "report") setVisitedReport(true);
  }, [active]);
  const sections = [
    { id: "report", label: "经营报告", enabled: canReport },
    { id: "assistant", label: "经营智能助手", enabled: canReport },
    { id: "expenses", label: "费用登记", enabled: canExpense },
    { id: "quarters", label: "季度核算", enabled: canQuarter },
  ];
  const selected = sections.find(section => section.id === active && section.enabled);
  return <div className="operations-sections">
    <h1>经营</h1>
    {showTabs && <div className="schedule-tabs" aria-label="经营页面">
      {sections.filter(section => section.enabled).map(section => <button className="button" key={section.id}
        aria-pressed={active === section.id} onClick={() => {
          if (section.id === "report") setVisitedReport(true);
          open("/operations/" + section.id);
        }}>{section.label}</button>)}
    </div>}
    {(visitedReport || active === "report") && canReport && <div hidden={active !== "report"}>
      <OperationsReport identity={identity} clinicId={clinicId} inlineAssistantActive={active !== "assistant"}
        open={target => { setVisitedReport(true); open(target); }} />
    </div>}
    {selected?.id === "assistant" && <OperationsReport identity={identity} clinicId={clinicId} open={open} assistantWorkspace/>}
    {selected?.id === "expenses" && <ExpensesPage identity={identity} clinicId={clinicId} />}
    {selected?.id === "quarters" && <QuarterReview identity={identity} periodId={path.split("/")[3]} open={open} />}
    {!selected && <p role="alert">当前账号无权访问该经营页面。</p>}
  </div>;
}
