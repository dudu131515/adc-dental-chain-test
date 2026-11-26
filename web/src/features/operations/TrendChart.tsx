import { useId, useMemo, useState } from "react";
import type { TrendPoint } from "./operationsTypes";

export type TrendSeries = {
  key: keyof Pick<TrendPoint, "revenue" | "material_cost" | "operating_cost" | "net_profit" | "appointments" | "attended" | "visits" | "work_minutes">;
  label: string;
  color: string;
  format: "money" | "count" | "minutes";
};

const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const axisCompact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 0 });

function valueLabel(value: number, format: TrendSeries["format"]) {
  if (format === "money") return (value < 0 ? "−" : "") + "¥" + compact.format(Math.abs(value));
  if (format === "minutes") return compact.format(value) + " 分钟";
  return compact.format(value) + " 笔";
}

function axisLabel(value: number, format: TrendSeries["format"]) {
  if (format === "money") return (value < 0 ? "−" : "") + "¥" + axisCompact.format(Math.abs(value));
  return axisCompact.format(value);
}
export function TrendChart({ points, series, emptyText = "所选期间暂无趋势数据。" }: {
  points: TrendPoint[]; series: TrendSeries[]; emptyText?: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const gradientId = useId().replaceAll(":", "");
  const visible = series.filter(item => !hidden.has(item.key));
  const primary = visible[0];
  const values = useMemo(() => points.flatMap(point => visible.map(item => Number(point[item.key]) || 0)), [points, visible]);
  if (!points.length) return <p className="ops-chart-empty">{emptyText}</p>;
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const span = rawMax - rawMin || 1;
  const max = rawMax + span * 0.12;
  const min = rawMin - (rawMin < 0 ? span * 0.08 : 0);
  const width = 880, height = 290;
  const plot = { left: 58, right: 18, top: 18, bottom: 38 };
  const innerWidth = width - plot.left - plot.right;
  const innerHeight = height - plot.top - plot.bottom;
  const x = (index: number) => points.length === 1
    ? plot.left + innerWidth / 2
    : plot.left + (index / (points.length - 1)) * innerWidth;
  const y = (value: number) => plot.top + ((max - value) / (max - min)) * innerHeight;
  const ticks = [0, 1, 2, 3, 4].map(step => min + ((max - min) * step) / 4);
  const step = Math.max(1, Math.ceil(points.length / 8));
  function path(key: TrendSeries["key"]) {
    return points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(Number(point[key]) || 0).toFixed(2)}`).join(" ");
  }
  function toggle(key: string) {
    setHidden(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (visible.length > 1) next.add(key);
      return next;
    });
  }
  const area = primary
    ? `${path(primary.key)} L${x(points.length - 1).toFixed(2)},${y(Math.max(0, min)).toFixed(2)} L${x(0).toFixed(2)},${y(Math.max(0, min)).toFixed(2)} Z`
    : "";
  return <div className="ops-trend">
    <div className="ops-chart-legend" aria-label="趋势指标图例">
      {series.map(item => <button type="button" key={item.key} className="ops-legend-item"
        aria-pressed={!hidden.has(item.key)} onClick={() => toggle(item.key)}>
        <i style={{ background: item.color }} aria-hidden="true" />{item.label}
      </button>)}
    </div>
    <svg className="ops-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="经营指标趋势图">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={primary?.color ?? "#1c6b5b"} stopOpacity="0.24" />
          <stop offset="100%" stopColor={primary?.color ?? "#1c6b5b"} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((tick, index) => <g key={index}>
        <line x1={plot.left} x2={width - plot.right} y1={y(tick)} y2={y(tick)}
          className={Math.abs(tick) < 0.0001 ? "ops-grid-zero" : "ops-grid-line"} />
        <text x={plot.left - 10} y={y(tick) + 4} textAnchor="end" className="ops-axis-text">
          {axisLabel(tick, primary?.format ?? "count")}
        </text>
      </g>)}
      {area && <path d={area} fill={`url(#${gradientId})`} />}
      {visible.map(item => <g key={item.key}>
        <path d={path(item.key)} fill="none" stroke={item.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => <circle key={point.period} cx={x(index)} cy={y(Number(point[item.key]) || 0)} r="3.1"
          fill="#fff" stroke={item.color} strokeWidth="2">
          <title>{point.label + " · " + item.label + " " + valueLabel(Number(point[item.key]) || 0, item.format)}</title>
        </circle>)}
      </g>)}
      {points.map((point, index) => index % step === 0 && <text key={point.period} x={x(index)}
        y={height - 12} textAnchor="middle" className="ops-axis-text">{point.label}</text>)}
    </svg>
  </div>;
}
