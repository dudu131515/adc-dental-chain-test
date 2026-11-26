import { FormEvent, useRef, useState } from "react";

import { useApiRequest } from "../../shared/ApiTransport";
import { useRead } from "../../shared/useRead";
import { DirectoryTable, resultUnknown, validationMessage } from "../admin/DirectoryUI";

type Version = {
  price_id?: string;
  cost_id?: string;
  unit_price?: string;
  unit_cost?: string;
  effective_from: string;
  effective_to: string | null;
};

export function PriceVersions({ treatmentId, onChange, canEdit, kind = "price", onPending, disabled }: {
  treatmentId: string; onChange: () => void; canEdit: boolean; kind?: "price" | "cost";
  onPending?: (pending: boolean) => void; disabled?: boolean;
}) {
  const request = useApiRequest();
  const active = useRef(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [replace, setReplace] = useState("");
  const isCost = kind === "cost";
  const route = isCost ? "/admin/materials/" + treatmentId + "/costs" : "/catalog/treatments/" + treatmentId + "/prices";
  const amountKey = isCost ? "unit_cost" : "unit_price";
  const idKey = isCost ? "cost_id" : "price_id";
  const label = isCost ? "成本版本" : "价格版本";
  const source = useRead<{ items: Version[] }>(route, revision);
  const versions = source.data?.items ?? [];
  const locked = pending || disabled || !source.data;

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || locked) return;
    active.current = true;
    setPending(true);
    onPending?.(true);
    setError("");
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      await request<Version>(route, {
        method: "POST", actionKey: crypto.randomUUID(),
        body: {
          [amountKey]: fields.get(amountKey), effective_from: fields.get("effective_from"),
          effective_to: fields.get("effective_to") || null,
          ...(replace ? {
            ["replace_" + idKey]: replace,
            replace_effective_to: fields.get(isCost ? "effective_from" : "replace_effective_to"),
          } : {}),
        },
      });
      form.reset();
      setReplace("");
      setRevision(old => old + 1);
      onChange();
    } catch (failure) {
      if (resultUnknown(failure)) {
        setError("保存结果待核对。请查看重新查询后的版本。");
        setRevision(old => old + 1);
        onChange();
      } else {
        setError(validationMessage(failure));
      }
    } finally {
      active.current = false;
      setPending(false);
      onPending?.(false);
    }
  }

  return <section>
    <h2>{label}</h2>
    {source.loading && <p className="muted" role="status">正在读取{label}…</p>}
    {source.fault && <><p className="error-text" role="alert">{source.fault}</p>
      <button type="button" className="button" onClick={() => setRevision(old => old + 1)}>重新查询版本</button></>}
    {source.data && <DirectoryTable rows={versions} identify={version => version[idKey] ?? version.effective_from} empty={`暂无${label}。`}
      columns={[
        { label: isCost ? "单位成本" : "价格", cell: version => "¥" + version[amountKey] },
        { label: "生效日期", cell: version => version.effective_from },
        { label: "结束日期", cell: version => version.effective_to || "持续生效" },
      ]} />}
    {canEdit && <form className="admin-form admin-version-form" onSubmit={publish}>
      <fieldset className="admin-fields" disabled={locked}>
        <label>{isCost ? "单位成本（元）" : "单价（元）"}<input name={amountKey} inputMode="decimal" required /></label>
        <label>生效日期<input type="date" name="effective_from" required /></label>
        <label>结束日期<input type="date" name="effective_to" /></label>
        <label>同时结束原版本<select value={replace} onChange={event => setReplace(event.target.value)}>
          <option value="">保留原版本日期</option>
          {versions.map(version => <option value={version[idKey]} key={version[idKey]}>
            {version.effective_from} 生效 · ¥{version[amountKey]}
          </option>)}
        </select></label>
        {replace && !isCost && <label>原版本结束日期<input name="replace_effective_to" type="date" required /></label>}
        {replace && isCost && <p className="muted admin-full-field">原版本将于新成本生效当天结束。</p>}
      </fieldset>
      <div className="admin-controls"><button className="button primary" disabled={locked}>保存{label}</button></div>
    </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
