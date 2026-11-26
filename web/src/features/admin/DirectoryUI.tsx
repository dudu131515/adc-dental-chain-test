import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ApiError } from "../../shared/api";
import { useApiRequest } from "../../shared/ApiTransport";
import { errorMessage } from "../../shared/format";
import "../catalog/catalog.css";
import "./admin.css";

const statuses: Record<string, string> = {
  ACTIVE: "启用", AVAILABLE: "可用", INACTIVE: "停用", ON_LEAVE: "休假",
};

export const activeOptions = [{ value: "ACTIVE", label: "启用" }, { value: "INACTIVE", label: "停用" }];
export type Option = { value: string; label: string };
export type ClinicChoice = { clinic_id: string; clinic_no: string; name: string; status: string };

export function statusLabel(status: string | null) {
  return status === null ? "未配置" : statuses[status] ?? status;
}

export function Status({ value }: { value: string | null }) {
  return <span className="admin-status" data-status={value}>{statusLabel(value)}</span>;
}

export function matches(query: string, ...terms: (string | null | undefined)[]) {
  const search = query.trim().toLocaleLowerCase();
  return !search || terms.some(term => term?.toLocaleLowerCase().includes(search));
}

export function fields(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

export function validationMessage(error: unknown) {
  const message = errorMessage(error);
  if (!(error instanceof ApiError)) return message;
  const details = Object.values(error.error.field_errors ?? {}).flat().filter(value => typeof value === "string");
  return [message, ...new Set(details)].join(" ");
}

export function resultUnknown(error: unknown) {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.error.code === "RESULT_UNKNOWN");
}

export function ChoiceOptions({ choices }: { choices: readonly Option[] }) {
  return <>{choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</>;
}

export function DirectoryFilter({ label, value, onChange, all, choices }: {
  label: string; value: string; onChange: (value: string) => void; all: string; choices: readonly Option[];
}) {
  return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}>
    <option value="">{all}</option><ChoiceOptions choices={choices} />
  </select></label>;
}

export function DirectorySearch({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (value: string) => void;
}) {
  return <label>{label}<input type="search" placeholder={placeholder} value={value}
    onChange={event => onChange(event.target.value)} /></label>;
}

export function DirectoryPanel({ title, loading, fault, notice, controls, filters, children }: {
  title: string; loading: boolean; fault: string; notice?: string;
  controls?: ReactNode; filters?: ReactNode; children: ReactNode;
}) {
  const id = useId();
  return <section className="catalog-panel admin-directory" aria-labelledby={id}>
    <div className="catalog-toolbar">
      <h1 id={id}>{title}</h1>
      {controls && <div className="admin-controls">{controls}</div>}
    </div>
    {filters && <div className="catalog-form admin-filters">{filters}</div>}
    {notice && <p role="status" className="admin-notice">{notice}</p>}
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {loading && <p role="status" className="muted">正在查询…</p>}
    {!loading && !fault && children}
  </section>;
}

type Column<Row> = { label: string; cell: (row: Row) => ReactNode; rowHeader?: boolean };

export function DirectoryTable<Row>({ columns, rows, identify, empty }: {
  columns: readonly Column<Row>[]; rows: readonly Row[]; identify: (row: Row) => string; empty: string;
}) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="catalog-scroll">
    <table className="catalog-table">
      <thead><tr>{columns.map(column => <th scope="col" key={column.label}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={identify(row)}>
        {columns.map(column => column.rowHeader
          ? <th scope="row" key={column.label}>{column.cell(row)}</th>
          : <td key={column.label}>{column.cell(row)}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function DirectoryDialog({ title, onClose, disabled, wide, children }: {
  title: string; onClose: () => void; disabled?: boolean; wide?: boolean; children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby={id} aria-modal="true" className={"admin-dialog" + (wide ? " admin-dialog-wide" : "")}
    onCancel={event => { event.preventDefault(); if (!disabled) onClose(); }}>
    <div className="admin-dialog-heading">
      <h2 id={id}>{title}</h2>
      <button className="button" type="button" onClick={onClose} disabled={disabled}>关闭</button>
    </div>
    <div className="admin-dialog-body">{children}</div>
  </dialog>;
}

export function ResourceEditor({ title, route, id, saveLabel, body, onSave, onClose, children }: {
  title: string; route: string; id?: string; saveLabel: string; body: (form: FormData) => Record<string, unknown>;
  onSave: () => void; onClose: (needsRefresh: boolean) => void; children: ReactNode;
}) {
  const request = useApiRequest();
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [fault, setFault] = useState("");
  const [unknown, setUnknown] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || unknown) return;
    const payload = body(new FormData(event.currentTarget));
    if (id && !Object.keys(payload).length) {
      setFault("请先修改要保存的资料。");
      return;
    }
    active.current = true;
    setPending(true);
    setFault("");
    try {
      await request(id ? route + "/" + id : route, {
        method: id ? "PATCH" : "POST", body: payload, actionKey: crypto.randomUUID(),
      });
      onSave();
    } catch (error) {
      const unclear = resultUnknown(error);
      setUnknown(unclear);
      setFault(unclear ? "保存结果待核对。关闭后将重新查询资料。" : validationMessage(error));
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return <DirectoryDialog title={title} onClose={() => onClose(unknown)} disabled={pending}>
    <form className="admin-form" onSubmit={save}>
      <fieldset className="admin-fields" disabled={pending || unknown}>{children}</fieldset>
      {fault && <p className="error-text" role="alert">{fault}</p>}
      <div className="admin-controls"><button className="button primary" disabled={pending || unknown}>{saveLabel}</button></div>
    </form>
  </DirectoryDialog>;
}
