"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface TrendPoint {
  date: string;
  count: number;
}

const fallback: TrendPoint[] = [
  { date: "Mon", count: 0 },
  { date: "Tue", count: 0 },
  { date: "Wed", count: 0 },
];

const barColors = ["#D02020", "#1040C0", "#F0C020"];

export function TrendChart({ data }: { data?: TrendPoint[] }) {
  const chartData = data && data.length > 0 ? data : fallback;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={chartData}
        margin={{ top: 12, right: 12, left: -12, bottom: 0 }}
      >
        <CartesianGrid stroke="#121212" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: "#121212", fontSize: 12, fontWeight: 700 }}
          axisLine={{ stroke: "#121212", strokeWidth: 2 }}
          tickLine={{ stroke: "#121212", strokeWidth: 2 }}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: "#121212", fontSize: 12, fontWeight: 700 }}
          axisLine={{ stroke: "#121212", strokeWidth: 2 }}
          tickLine={{ stroke: "#121212", strokeWidth: 2 }}
        />
        <Tooltip
          cursor={{ fill: "rgba(18, 18, 18, 0.06)" }}
          contentStyle={{
            background: "#ffffff",
            border: "3px solid #121212",
            borderRadius: "0px",
            boxShadow: "6px 6px 0 0 #121212",
            color: "#121212",
            fontWeight: 700,
          }}
          labelStyle={{
            color: "#121212",
            fontWeight: 900,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
          formatter={(value: number) => [`${value}`, "新增岗位"]}
        />
        <Bar dataKey="count" barSize={36} stroke="#121212" strokeWidth={2}>
          {chartData.map((point, index) => (
            <Cell
              key={`${point.date}-${index}`}
              fill={barColors[index % barColors.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
