import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessPage } from "./features/admin/AccessPage";
import { BillingPage } from "./features/billing/BillingPage";
import { DailyReconciliation } from "./features/billing/DailyReconciliation";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { PatientsPage } from "./features/patients/PatientsPage";
import { CatalogPage } from "./features/catalog/CatalogPage";
import { ClinicalQueue } from "./features/clinical/ClinicalQueue";
import { VisitDetail } from "./features/clinical/VisitDetail";
import { OperationsPage } from "./features/operations/OperationsPage";
import { SchedulePage } from "./features/schedule/SchedulePage";
import { AppShell } from "./shared/AppShell";
import "./shared/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("ADC 网站入口缺失。");

createRoot(root).render(
  <StrictMode>
    <AppShell renderWorkArea={area => {
      if (area.section === "/dashboard") return <DashboardPage {...area} />;
      if (area.section === "/patients") return <PatientsPage {...area} />;
      if (area.section === "/schedule") return <SchedulePage {...area} />;
      if (area.section === "/catalog") return <CatalogPage canEdit={area.identity.role_clinic_ids?.HQ_CATALOG === null} />;
      if (area.section === "/admin") return <AccessPage {...area} path={area.path === "/admin" ? "/admin/clinics" : area.path} />;
      if (area.section === "/operations") return <OperationsPage {...area} showTabs={false} />;
      if (area.section === "/billing") return area.path === "/billing/reconciliation"
        ? <DailyReconciliation {...area} /> : <BillingPage {...area} />;
      if (area.section === "/clinical") {
        const visit = area.path.match(/^\/clinical\/visits\/(\d+)$/)?.[1];
        return visit ? <VisitDetail id={visit} open={area.open} /> : <ClinicalQueue {...area} />;
      }
      return null;
    }} />
  </StrictMode>,
);
