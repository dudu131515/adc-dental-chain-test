export function ActionFeedback({ fault, unknown, retry, busy }: {
  fault: string; unknown: boolean; retry: () => void; busy: boolean;
}) {
  return <>
    {fault && <p className="error-text" role="alert">{fault}</p>}
    {unknown && <button className="button primary" disabled={busy} onClick={retry}>核对原办理结果</button>}
  </>;
}
