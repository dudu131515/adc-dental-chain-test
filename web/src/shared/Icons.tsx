import type { ReactNode } from "react";

const shapes = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-14 4h3m3 0h3m-9 3h3"/></>,
  patients: <><circle cx="9" cy="8" r="3"/><path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3.5 4.8"/></>,
  tooth: <><path d="M12 5.4C8.6 3.1 5.8 3.4 4.3 5.5c-1.4 2 .1 5.3 1 7.7.8 2.4 1.1 7.3 3.1 7.3 1.7 0 1.3-6.6 3.6-6.6s1.9 6.6 3.6 6.6c2 0 2.3-4.9 3.1-7.3.9-2.4 2.4-5.7 1-7.7-1.5-2.1-4.3-2.4-7.7-.1Z"/><path d="M10 4.5c1.5.7 2.8 1.7 4.4 1.8"/></>,
  receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6m-6 4h6m-6 4h3"/></>,
  catalog: <><path d="M4 5h7v15H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm7 0h7a2 2 0 0 1 2 2v12h-7l-2 1M6 9h2m6 0h3"/></>,
  chart: <><path d="M3 3v18h18M7 16v-4m5 4V7m5 9V9"/></>,
  activity: <><path d="M2 12h5l3-8 4 16 3-8h5"/></>,
  check: <><circle cx="12" cy="12" r="9"/><path d="m8.4 12 2.4 2.6 4.8-5.2"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  clinic: <><path d="M4 21h16M6 21V4h12v17M10 21v-5h4v5M9 8h6m-3-3v6"/></>,
  arrow: <><path d="M4 12h15m-5-5 5 5-5 5"/></>, chevron: <path d="m9 6 6 6-6 6"/>,
  logout: <><path d="M10 4H5v16h5m-1-8h12m-4-4 4 4-4 4"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 6 0 0 1 16 0v2"/></>,
  refresh: <><path d="M20 9a8 8 0 0 0-14-3L3.5 9m0-5v5h5m-5 6A8 8 0 0 0 18 18l2.5-3m0 5v-5h-5"/></>,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 4.5 9-4.5m-18 4 9 4.5 9-4.5"/></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18"/>, close: <path d="m5 5 14 14M19 5 5 19"/>,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="m3 3 18 18M9.4 5.8c.8-.2 1.7-.3 2.6-.3 6.5 0 10 6.5 10 6.5a19 19 0 0 1-3.3 3.8m-3.5 2.3c-1 .3-2 .4-3.2.4-6.5 0-10-6.5-10-6.5a18 18 0 0 1 3.4-3.9"/></>,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof shapes;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">{shapes[name]}</svg>;
}
export function Brand() {
  return <span className="adc-brand"><span className="adc-brand-symbol"><Icon name="tooth" size={29} /></span>
    <span className="adc-brand-type"><strong>ADC</strong><small>安德鲁牙科</small></span></span>;
}
