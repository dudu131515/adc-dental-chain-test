import { FormEvent, useState } from "react";
import { ActionFeedback } from "../../shared/ActionFeedback";
import { money } from "../../shared/format";
import type { useAction } from "../../shared/useAction";
import { useRead } from "../../shared/useRead";
import { Visit } from "./clinicalTypes";

type Project = { treatment_type_id: string; treatment_name: string; standard_unit: string; active: boolean; current_unit_price?: string };
type MaterialOption = { material_id: string; material_name: string; standard_unit: string; cost_references: string[] };
type MaterialUse = { material_id: string; quantity: string; cost_evidence_ref: string };

export function TreatmentForm({ visit, action, onChange, initialProject }: {
  visit: Visit; action: ReturnType<typeof useAction>; onChange: (project?: string) => void; initialProject?: string;
}) {
  const projects = useRead<{ items: Project[] }>("/catalog/treatments");
  const materials = useRead<{ items: MaterialOption[] }>("/clinical/materials");
  const selected = projects.data?.items.filter(row => row.active) ?? [];
  const [item, selectItem] = useState(initialProject ?? visit.planned_treatment_type_id);
  const [proposed, setProposed] = useState("");
  const [decision, setDecision] = useState("ACCEPTED");
  const [consentReference, setConsentReference] = useState("");
  const [units, setUnits] = useState("1");
  const [tooth, setTooth] = useState("");
  const [additional, setAdditional] = useState(false);
  const [usage, setUsage] = useState<MaterialUse[]>([]);
  const locked = action.unknown || action.busy;
  const project = selected.find(row => row.treatment_type_id === item);
  const requiresConsent = additional || item !== visit.planned_treatment_type_id;
  const accepted = visit.additional_decisions?.filter(row => row.treatment_type_id === item && row.decision === "ACCEPTED").at(-1);
  const base = "/visits/" + visit.visit_id;

  function recordDecision(event: FormEvent) {
    event.preventDefault();
    action.execute(base + "/additional-decisions", { treatment_type_id: proposed, decision, evidence_ref: consentReference }, () => {
      setConsentReference("");
      onChange(decision === "ACCEPTED" ? proposed : undefined);
    });
  }

  function recordItem(event: FormEvent) {
    event.preventDefault();
    action.execute(base + "/treatment-items", {
      treatment_type_id: item, units, ...(tooth.trim() ? { tooth_code: tooth.trim() } : {}),
      is_additional: requiresConsent, ...(requiresConsent ? { decision_id: accepted?.decision_id } : {}), materials: usage,
    }, () => {
      setUsage([]); setTooth(""); setUnits("1");
      onChange();
    });
  }

  function setMaterial(index: number, changes: Partial<MaterialUse>) {
    setUsage(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row));
  }

  return <section className="schedule-panel">
    <h2>记录实际治疗</h2>
    {(projects.fault || materials.fault) && <p className="error-text" role="alert">{projects.fault || materials.fault}</p>}
    <ActionFeedback {...action} />
    <details>
      <summary>记录追加项目的患者决定</summary>
      <form className="schedule-form" onSubmit={recordDecision}>
        <fieldset disabled={locked} className="record-fields">
          <label>拟追加的项目<select required value={proposed} onChange={event => setProposed(event.target.value)}>
            <option value="">选择项目</option>{selected.map(row => <option key={row.treatment_type_id} value={row.treatment_type_id}>{row.treatment_name}</option>)}
          </select></label>
          <label>患者决定<select value={decision} onChange={event => setDecision(event.target.value)}>
            <option value="ACCEPTED">已同意</option><option value="DECLINED">已拒绝</option>
          </select></label>
          <label>同意或拒绝的凭据<input required value={consentReference} onChange={event => setConsentReference(event.target.value)} /></label>
        </fieldset>
        <button className="button" disabled={locked}>保存患者决定</button>
      </form>
      {!!visit.additional_decisions?.length && <ul className="compact-list">{visit.additional_decisions.map(row => <li key={row.decision_id}>
        {selected.find(project => project.treatment_type_id === row.treatment_type_id)?.treatment_name ?? row.treatment_type_id}
        {" · "}{row.decision === "ACCEPTED" ? "已同意" : "已拒绝"}
      </li>)}</ul>}
    </details>
    <form className="schedule-form" onSubmit={recordItem}>
      <fieldset disabled={locked} className="record-fields">
        <label>实际实施项目<select required value={item} onChange={event => selectItem(event.target.value)}>
          <option value="">选择项目</option>{selected.map(row => <option key={row.treatment_type_id} value={row.treatment_type_id}>{row.treatment_name}</option>)}
        </select></label>
        <label>实际数量{project ? "（" + project.standard_unit + "）" : ""}
          <input required type="number" min="0.001" step="0.001" value={units} onChange={event => setUnits(event.target.value)} />
        </label>
        <label>牙位<input maxLength={20} value={tooth} onChange={event => setTooth(event.target.value)} /></label>
        {item === visit.planned_treatment_type_id && <label className="inline-control">
          <input type="checkbox" checked={additional} onChange={event => setAdditional(event.target.checked)} />本项属于追加治疗
        </label>}
      </fieldset>
      {project?.current_unit_price && <span>当前目录单价 {money(project.current_unit_price)}</span>}
      {requiresConsent && !accepted && <p>记录该项目的患者同意后，方可登记实际实施。</p>}
      <fieldset disabled={locked} className="treatment-materials">
        <legend>本项实际耗材</legend>
        {usage.map((row, index) => {
          const option = materials.data?.items.find(material => material.material_id === row.material_id);
          return <div key={index} className="record-fields">
            <label>耗材<select required value={row.material_id} onChange={event => setMaterial(index, { material_id: event.target.value, cost_evidence_ref: "" })}>
              <option value="">选择耗材</option>{materials.data?.items.map(material =>
                <option key={material.material_id} value={material.material_id}>{material.material_name}</option>)}
            </select></label>
            <label>用量{option ? "（" + option.standard_unit + "）" : ""}
              <input required type="number" min="0" step="0.001" value={row.quantity} onChange={event => setMaterial(index, { quantity: event.target.value })} />
            </label>
            <label>成本凭据<select required value={row.cost_evidence_ref} onChange={event => setMaterial(index, { cost_evidence_ref: event.target.value })}>
              <option value="">选择成本凭据</option>{option?.cost_references.map((reference, index) => <option key={index}>{reference}</option>)}
            </select></label>
            <button className="button" type="button" onClick={() => setUsage(current => current.filter((_, key) => key !== index))}>移除耗材</button>
          </div>;
        })}
        <button type="button" className="button" disabled={!materials.data?.items.length} onClick={() =>
          setUsage(current => [...current, { material_id: "", quantity: "", cost_evidence_ref: "" }])}>添加耗材</button>
      </fieldset>
      <button className="button primary" disabled={locked || !project || (requiresConsent && !accepted)}>保存实际项目</button>
    </form>
  </section>;
}
