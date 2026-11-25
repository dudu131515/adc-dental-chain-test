import { FormEvent, useEffect, useState } from "react";

import { request } from "../../shared/api";

type Price = {
  price_id: string;
  unit_price: string;
  effective_from: string;
  effective_to: string | null;
};

export function PriceVersions({ treatmentId, onChange }: { treatmentId: string; onChange: () => void }) {
  const [versions, setVersions] = useState<Price[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [replace, setReplace] = useState("");
  const route = "/catalog/treatments/" + treatmentId + "/prices";

  useEffect(() => {
    const abort = new AbortController();
    request<{ items: Price[] }>(route, { signal: abort.signal })
      .then(response => setVersions(response.items))
      .catch(failure => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, [revision, route]);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      await request<Price>(route, {
        method: "POST", actionKey: crypto.randomUUID(),
        body: {
          unit_price: fields.get("unit_price"), effective_from: fields.get("effective_from"),
          effective_to: fields.get("effective_to") || null,
          ...(replace ? { replace_price_id: replace, replace_effective_to: fields.get("replace_effective_to") } : {}),
        },
      });
      form.reset();
      setReplace("");
      setRevision(old => old + 1);
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存价格版本。");
    } finally {
      setPending(false);
    }
  }

  return <section>
    <h2>价格版本</h2>
    <div className="catalog-scroll">
      <table className="catalog-table">
        <thead><tr><th>价格</th><th>生效日期</th><th>结束日期</th></tr></thead>
        <tbody>
          {versions.map(price => <tr key={price.price_id}>
            <td>¥{price.unit_price}</td><td>{price.effective_from}</td><td>{price.effective_to || "持续生效"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {!versions.length && <p className="muted">暂无价格版本。</p>}
    <form className="catalog-form" onSubmit={publish}>
      <label>单价（元）<input name="unit_price" inputMode="decimal" required /></label>
      <label>生效日期<input type="date" name="effective_from" required /></label>
      <label>结束日期<input type="date" name="effective_to" /></label>
      <label>同时结束原版本<select value={replace} onChange={event => setReplace(event.target.value)}>
        <option value="">不调整原版本</option>
        {versions.map(price => <option value={price.price_id} key={price.price_id}>
          {price.effective_from} 生效 · ¥{price.unit_price}
        </option>)}
      </select></label>
      {replace && <label>原版本结束日期<input name="replace_effective_to" type="date" required /></label>}
      <button className="button primary" disabled={pending}>保存价格版本</button>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
