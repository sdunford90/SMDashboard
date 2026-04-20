import React, { useState, useEffect, useCallback } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import Link from "next/link";

const BarChart = dynamic(() => import("recharts").then((m) => m.BarChart), { ssr: false });
const Bar = dynamic(() => import("recharts").then((m) => m.Bar), { ssr: false });
const XAxis = dynamic(() => import("recharts").then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import("recharts").then((m) => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import("recharts").then((m) => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import("recharts").then((m) => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import("recharts").then((m) => m.Legend), { ssr: false });
const ResponsiveContainer = dynamic(() => import("recharts").then((m) => m.ResponsiveContainer), { ssr: false });

function speedColor(minutes) {
  if (minutes === null) return "text-gray-400";
  if (minutes < 60) return "text-emerald-400";
  if (minutes <= 240) return "text-yellow-400";
  return "text-red-400";
}

function speedBarColor(minutes) {
  if (minutes === null) return "#6b7280";
  if (minutes < 60) return "#34d399";
  if (minutes <= 240) return "#fbbf24";
  return "#f87171";
}

// Custom tooltip for the Lead Sources stacked bar — explicitly lists every
// source in legend order with a colored swatch and value, so the Call line
// never gets dropped by Recharts' default tooltip rendering.
const SOURCE_ROWS = [
  { key: "Call", label: "Call", color: "#e5e7eb" },
  { key: "Walk-in", label: "Walk-in", color: "#2dd4bf" },
  { key: "Web Form", label: "Web Form", color: "#c4933f" },
  { key: "Digital", label: "Digital / Other", color: "#60a5fa" },
];

function LeadSourceTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload || {};
  return (
    <div style={{ background: "#0c2340", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ color: "#fff", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {SOURCE_ROWS.map((r) => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.85)", lineHeight: 1.6 }}>
          <span style={{ width: 10, height: 10, background: r.color, display: "inline-block", borderRadius: 2 }} />
          <span style={{ flex: 1 }}>{r.label}</span>
          <span style={{ fontWeight: 600 }}>{row[r.key] ?? 0}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.15)", marginTop: 6, paddingTop: 4, display: "flex", color: "#fff", fontWeight: 600 }}>
        <span style={{ flex: 1 }}>Total</span>
        <span>{row.total ?? 0}</span>
      </div>
    </div>
  );
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SLIDES = ["overview", "calls", "conversions", "sources"];

export default function Presentation() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slide, setSlide] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [convPeriod, setConvPeriod] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState(null);

  const fetchCacheStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/cache-status");
      if (res.ok) setCacheStatus(await res.json());
    } catch {}
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/presentation");
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date());
    } catch {}
    finally { setLoading(false); }
  }, []);

  // Same flow the main dashboard uses: kick off /api/refresh, poll
  // /api/cache-status until the background HubSpot pull finishes, then reload.
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      const poll = async () => {
        try {
          const res = await fetch("/api/cache-status");
          if (res.ok) {
            const status = await res.json();
            setCacheStatus(status);
            if (status.isRefreshing) {
              setTimeout(poll, 2000);
              return;
            }
          }
        } catch {}
        await load();
        await fetchCacheStatus();
        setRefreshing(false);
      };
      setTimeout(poll, 2000);
    } catch {
      setRefreshing(false);
    }
  }, [refreshing, load, fetchCacheStatus]);

  useEffect(() => {
    load();
    fetchCacheStatus();
  }, [load, fetchCacheStatus]);

  useEffect(() => {
    const interval = setInterval(fetchCacheStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchCacheStatus]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") setSlide((s) => Math.min(s + 1, SLIDES.length - 1));
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") setSlide((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const now = new Date();
  const monthName = now.toLocaleString("default", { month: "long" });

  return (
    <>
      <Head>
        <title>Southern Marinas — Presentation</title>
      </Head>
      <div className="min-h-screen bg-[#0c2340] text-white font-sans flex flex-col" style={{ fontFamily: "'Montserrat', sans-serif" }}>

        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚓</span>
            <div>
              <div className="text-lg font-bold tracking-wide">Southern Marinas</div>
              <div className="text-[#c4933f] text-xs font-medium">Lead Response Dashboard</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-white/40 text-xs">
              {refreshing || cacheStatus?.isRefreshing
                ? "Refreshing data…"
                : cacheStatus?.cachedAt
                ? `Data from ${timeAgo(cacheStatus.cachedAt)}`
                : lastRefresh
                ? `Updated ${lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </span>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="text-xs border border-white/20 hover:border-[#c4933f] text-white/60 hover:text-white px-3 py-1.5 rounded transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <Link href="/" className="text-xs border border-white/20 hover:border-[#c4933f] text-white/60 hover:text-white px-3 py-1.5 rounded transition-colors">
              ← Dashboard
            </Link>
          </div>
        </div>

        {/* Slide content */}
        <div className="flex-1 flex flex-col">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-white/40 text-lg">Loading data…</div>
            </div>
          ) : !data ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-red-400 text-lg">Failed to load data.</div>
            </div>
          ) : (
            <>
              {/* SLIDE 1: Overview */}
              {slide === 0 && (
                <div className="flex-1 px-8 py-6 flex flex-col gap-6">
                  <h2 className="text-2xl font-bold text-[#c4933f] tracking-wide">
                    Lead Overview — Last 7 Days &amp; {monthName}
                  </h2>

                  {/* Big KPI row */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                    <KpiCard
                      label="New Leads — Last 7 Days"
                      value={data.newLeads7Days}
                      accent="text-[#c4933f]"
                      src={data.src7Days}
                    />
                    <KpiCard
                      label={`Total Leads — ${monthName}`}
                      value={data.monthlyLeads}
                      accent="text-blue-400"
                      src={data.srcMonth}
                    />
                    <KpiCard
                      label="Total Leads (All Time)"
                      value={data.totalLeads}
                      accent="text-white/60"
                      small
                      src={data.srcAll}
                    />
                  </div>

                  {/* Speed to lead by property */}
                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Table */}
                    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                      <div className="px-5 py-3 border-b border-white/10">
                        <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest">Speed to Lead by Property — Last 7 Days (9am–5pm, 7 days/wk)</h3>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/10 text-white/40 text-xs uppercase">
                            <th className="px-5 py-2 text-left">Property</th>
                            <th className="px-5 py-2 text-right">Leads</th>
                            <th className="px-5 py-2 text-right">Responded</th>
                            <th className="px-5 py-2 text-right">Avg Speed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.speedByProperty.length === 0 ? (
                            <tr><td colSpan={4} className="px-5 py-4 text-center text-white/30">No data</td></tr>
                          ) : data.speedByProperty.map((row) => (
                            <tr key={row.marina} className="border-b border-white/5 hover:bg-white/5">
                              <td className="px-5 py-2.5 font-medium">{row.marina}</td>
                              <td className="px-5 py-2.5 text-right text-white/60">{row.total}</td>
                              <td className="px-5 py-2.5 text-right text-white/60">{row.respondedCount}</td>
                              <td className={`px-5 py-2.5 text-right font-bold ${speedColor(row.avgSpeedMinutes)}`}>
                                {row.avgSpeedFormatted}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Bar chart */}
                    <div className="bg-white/5 rounded-xl border border-white/10 p-5 flex flex-col">
                      <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest mb-4">Avg Speed to Lead (minutes)</h3>
                      <div className="flex-1 min-h-[220px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={data.speedByProperty.filter((r) => r.avgSpeedMinutes !== null)}
                            margin={{ top: 5, right: 10, left: 0, bottom: 60 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                            <XAxis
                              dataKey="marina"
                              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
                              angle={-40}
                              textAnchor="end"
                              height={70}
                            />
                            <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }} />
                            <Tooltip
                              contentStyle={{ background: "#0c2340", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                              labelStyle={{ color: "#fff" }}
                              itemStyle={{ color: "#c4933f" }}
                              formatter={(v) => [`${v} min`, "Avg Speed"]}
                            />
                            <Bar dataKey="avgSpeedMinutes" radius={[4, 4, 0, 0]} fill="#c4933f" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SLIDE 2: Calls by location */}
              {slide === 1 && (
                <div className="flex-1 px-8 py-6 flex flex-col gap-6">
                  <h2 className="text-2xl font-bold text-[#c4933f] tracking-wide">
                    Call Volume by Location — Last 7 Days
                  </h2>

                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Bar chart */}
                    <div className="bg-white/5 rounded-xl border border-white/10 p-5 flex flex-col lg:col-span-1">
                      <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest mb-4">Inbound vs Outbound Calls</h3>
                      <div className="flex-1 min-h-[280px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={data.callsByLocation}
                            margin={{ top: 5, right: 20, left: 0, bottom: 70 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                            <XAxis
                              dataKey="marina"
                              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
                              angle={-40}
                              textAnchor="end"
                              height={80}
                            />
                            <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }} />
                            <Tooltip
                              contentStyle={{ background: "#0c2340", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                              labelStyle={{ color: "#fff" }}
                            />
                            <Legend wrapperStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 12, paddingTop: 8 }} />
                            <Bar dataKey="inbound" name="Inbound" fill="#34d399" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="outbound" name="Outbound" fill="#c4933f" radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Table */}
                    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                      <div className="px-5 py-3 border-b border-white/10">
                        <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest">Call Breakdown by Location</h3>
                      </div>
                      {data.callsByLocation.length === 0 ? (
                        <div className="px-5 py-6 text-center text-white/30">No call data for last 7 days</div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-white/10 text-white/40 text-xs uppercase">
                              <th className="px-5 py-2 text-left">Location</th>
                              <th className="px-5 py-2 text-right text-emerald-400">Inbound</th>
                              <th className="px-5 py-2 text-right text-[#c4933f]">Outbound</th>
                              <th className="px-5 py-2 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.callsByLocation.map((row) => (
                              <tr key={row.marina} className="border-b border-white/5 hover:bg-white/5">
                                <td className="px-5 py-2.5 font-medium">{row.marina}</td>
                                <td className="px-5 py-2.5 text-right text-emerald-400 font-semibold">{row.inbound}</td>
                                <td className="px-5 py-2.5 text-right text-[#c4933f] font-semibold">{row.outbound}</td>
                                <td className="px-5 py-2.5 text-right text-white/60">{row.total}</td>
                              </tr>
                            ))}
                            {/* Totals row */}
                            <tr className="border-t border-white/20 font-bold">
                              <td className="px-5 py-3 text-white/60 text-xs uppercase tracking-wide">Total</td>
                              <td className="px-5 py-3 text-right text-emerald-400">
                                {data.callsByLocation.reduce((s, r) => s + r.inbound, 0)}
                              </td>
                              <td className="px-5 py-3 text-right text-[#c4933f]">
                                {data.callsByLocation.reduce((s, r) => s + r.outbound, 0)}
                              </td>
                              <td className="px-5 py-3 text-right text-white">
                                {data.callsByLocation.reduce((s, r) => s + r.total, 0)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {/* SLIDE 4: Lead Sources */}
              {slide === 3 && (
                <div className="flex-1 px-8 py-6 flex flex-col gap-6">
                  <h2 className="text-2xl font-bold text-[#c4933f] tracking-wide">
                    Lead Sources — Where Leads Come From
                  </h2>

                  {/* Summary KPI row */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
                    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5 text-center">
                      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">📞 Phone Calls</div>
                      <div className="text-5xl font-bold text-white bg-white/10 rounded-lg py-2">{data.sourceCount?.Call ?? 0}</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5 text-center">
                      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">🚶 Walk-ins</div>
                      <div className="text-5xl font-bold text-teal-300 bg-white/10 rounded-lg py-2">{data.sourceCount?.["Walk-in"] ?? 0}</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5 text-center">
                      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">📋 Web Forms</div>
                      <div className="text-5xl font-bold text-[#c4933f] bg-white/10 rounded-lg py-2">{data.sourceCount?.["Web Form"] ?? 0}</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5 text-center">
                      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">🌐 Digital / Other</div>
                      <div className="text-5xl font-bold text-blue-400 bg-white/10 rounded-lg py-2">{data.sourceCount?.Digital ?? 0}</div>
                    </div>
                  </div>

                  {/* Stacked bar chart by marina */}
                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="bg-white/5 rounded-xl border border-white/10 p-5 flex flex-col">
                      <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest mb-4">Lead Source by Property</h3>
                      <div className="flex-1 min-h-[240px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={data.leadSourceByMarina || []}
                            layout="vertical"
                            margin={{ top: 4, right: 40, left: 8, bottom: 4 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" horizontal={false} />
                            <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }} allowDecimals={false} />
                            <YAxis type="category" dataKey="marina" tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11 }} width={115} />
                            <Tooltip content={<LeadSourceTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                            <Legend wrapperStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 12, paddingTop: 8 }} />
                            <Bar dataKey="Call" name="Call" stackId="a" fill="#e5e7eb" />
                            <Bar dataKey="Walk-in" name="Walk-in" stackId="a" fill="#2dd4bf" />
                            <Bar dataKey="Web Form" name="Web Form" stackId="a" fill="#c4933f" />
                            <Bar dataKey="Digital" name="Digital / Other" stackId="a" fill="#60a5fa" radius={[0, 4, 4, 0]}
                              label={{ position: "right", fill: "rgba(255,255,255,0.5)", fontSize: 11, formatter: (v, e) => e?.payload?.total }} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Table */}
                    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                      <div className="px-5 py-3 border-b border-white/10">
                        <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest">Source Breakdown by Property</h3>
                      </div>
                      <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-[#0c2340]">
                            <tr className="border-b border-white/10 text-white/40 text-xs uppercase">
                              <th className="px-5 py-2 text-left">Property</th>
                              <th className="px-5 py-2 text-right text-white/70">📞 Call</th>
                              <th className="px-5 py-2 text-right text-teal-300">🚶 Walk-in</th>
                              <th className="px-5 py-2 text-right text-[#c4933f]">📋 Form</th>
                              <th className="px-5 py-2 text-right text-blue-400">🌐 Digital</th>
                              <th className="px-5 py-2 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(data.leadSourceByMarina || []).map((row) => (
                              <tr key={row.marina} className="border-b border-white/5 hover:bg-white/5">
                                <td className="px-5 py-2.5 font-medium">{row.marina}</td>
                                <td className="px-5 py-2.5 text-right font-semibold text-white/80">{row.Call}</td>
                                <td className="px-5 py-2.5 text-right font-semibold text-teal-300">{row["Walk-in"] ?? 0}</td>
                                <td className="px-5 py-2.5 text-right font-semibold text-[#c4933f]">{row["Web Form"]}</td>
                                <td className="px-5 py-2.5 text-right font-semibold text-blue-400">{row.Digital}</td>
                                <td className="px-5 py-2.5 text-right text-white/50">{row.total}</td>
                              </tr>
                            ))}
                            <tr className="border-t border-white/20 font-bold">
                              <td className="px-5 py-3 text-white/60 text-xs uppercase tracking-wide">Total</td>
                              <td className="px-5 py-3 text-right text-white/80">{data.sourceCount?.Call ?? 0}</td>
                              <td className="px-5 py-3 text-right text-teal-300">{data.sourceCount?.["Walk-in"] ?? 0}</td>
                              <td className="px-5 py-3 text-right text-[#c4933f]">{data.sourceCount?.["Web Form"] ?? 0}</td>
                              <td className="px-5 py-3 text-right text-blue-400">{data.sourceCount?.Digital ?? 0}</td>
                              <td className="px-5 py-3 text-right text-white">
                                {(data.sourceCount?.Call ?? 0) + (data.sourceCount?.["Walk-in"] ?? 0) + (data.sourceCount?.["Web Form"] ?? 0) + (data.sourceCount?.Digital ?? 0)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SLIDE 3: Conversions */}
              {slide === 2 && (() => {
                const periodOptions = [
                  { id: "7", label: "Last 7d" },
                  { id: "30", label: "Last 30d" },
                  { id: "month", label: monthName },
                  { id: "all", label: "Since Jan 1" },
                ];
                const convNow = new Date();
                let cutoff = null;
                if (convPeriod === "7") {
                  cutoff = new Date(convNow); cutoff.setDate(cutoff.getDate() - 7);
                } else if (convPeriod === "30") {
                  cutoff = new Date(convNow); cutoff.setDate(cutoff.getDate() - 30);
                } else if (convPeriod === "month") {
                  cutoff = new Date(convNow.getFullYear(), convNow.getMonth(), 1);
                }
                const converted = (data.convertedLeads || []).filter((l) => {
                  if (!cutoff) return true;
                  if (!l.convertedAt) return false;
                  return new Date(l.convertedAt) >= cutoff;
                });
                const withDays = converted.filter((l) => l.daysToConvert !== null);
                const total = converted.length;
                const avgDays = withDays.length > 0
                  ? Math.round(withDays.reduce((s, l) => s + l.daysToConvert, 0) / withDays.length)
                  : null;
                const fastest = withDays.length > 0
                  ? Math.min(...withDays.map((l) => l.daysToConvert))
                  : null;

                const marinaMap = {};
                for (const l of converted) {
                  if (!marinaMap[l.marina]) marinaMap[l.marina] = { count: 0, totalDays: 0, withDays: 0 };
                  marinaMap[l.marina].count++;
                  if (l.daysToConvert !== null) {
                    marinaMap[l.marina].totalDays += l.daysToConvert;
                    marinaMap[l.marina].withDays++;
                  }
                }
                const byMarina = Object.entries(marinaMap)
                  .filter(([marina]) => marina && marina !== "Unknown")
                  .map(([marina, stats]) => ({
                    marina,
                    count: stats.count,
                    avgDays: stats.withDays > 0 ? Math.round(stats.totalDays / stats.withDays) : null,
                  }))
                  .sort((a, b) => b.count - a.count);

                const periodLabel = periodOptions.find((p) => p.id === convPeriod)?.label || "All";

                return (
                <div className="flex-1 px-8 py-6 flex flex-col gap-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-2xl font-bold text-[#c4933f] tracking-wide">
                      Conversions — Leads to Customers
                      <span className="text-white/40 font-normal text-base ml-3">· {periodLabel}</span>
                    </h2>
                    <div className="flex gap-1">
                      {periodOptions.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setConvPeriod(p.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            convPeriod === p.id
                              ? "bg-[#c4933f] text-[#0c2340] border-[#c4933f]"
                              : "border-white/20 text-white/60 hover:text-white hover:border-white/40"
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* KPI row */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                    <KpiCard
                      label={`Total Conversions — ${periodLabel}`}
                      value={total}
                      accent="text-emerald-400"
                    />
                    <KpiCard
                      label="Avg Days to Convert"
                      value={avgDays !== null ? `${avgDays}d` : "--"}
                      accent="text-blue-400"
                    />
                    <KpiCard
                      label="Fastest Conversion"
                      value={fastest !== null ? `${fastest}d` : "--"}
                      accent="text-[#c4933f]"
                      small
                    />
                  </div>

                  {/* Breakdown table + chart */}
                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                      <div className="px-5 py-3 border-b border-white/10">
                        <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest">Conversions by Property — {periodLabel}</h3>
                      </div>
                      {byMarina.length === 0 ? (
                        <div className="px-5 py-6 text-center text-white/30">No conversions in this period</div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-white/10 text-white/40 text-xs uppercase">
                              <th className="px-5 py-2 text-left">Property</th>
                              <th className="px-5 py-2 text-right">Conversions</th>
                              <th className="px-5 py-2 text-right">Avg Days</th>
                            </tr>
                          </thead>
                          <tbody>
                            {byMarina.map((row) => (
                              <tr key={row.marina} className="border-b border-white/5 hover:bg-white/5">
                                <td className="px-5 py-2.5 font-medium">{row.marina}</td>
                                <td className="px-5 py-2.5 text-right text-emerald-400 font-bold">{row.count}</td>
                                <td className="px-5 py-2.5 text-right text-white/60">
                                  {row.avgDays !== null ? `${row.avgDays}d` : "--"}
                                </td>
                              </tr>
                            ))}
                            <tr className="border-t border-white/20 font-bold">
                              <td className="px-5 py-3 text-white/60 text-xs uppercase tracking-wide">Total</td>
                              <td className="px-5 py-3 text-right text-emerald-400">
                                {byMarina.reduce((s, r) => s + r.count, 0)}
                              </td>
                              <td className="px-5 py-3 text-right text-white/60"></td>
                            </tr>
                          </tbody>
                        </table>
                      )}
                    </div>

                    {/* Bar chart */}
                    <div className="bg-white/5 rounded-xl border border-white/10 p-5 flex flex-col">
                      <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest mb-4">Conversions by Property — {periodLabel}</h3>
                      <div className="flex-1 min-h-[220px]">
                        {byMarina.length === 0 ? (
                          <div className="h-full flex items-center justify-center text-white/30 text-sm">No conversions in this period</div>
                        ) : (
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={byMarina}
                              margin={{ top: 5, right: 10, left: 0, bottom: 60 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                              <XAxis
                                dataKey="marina"
                                tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
                                angle={-40}
                                textAnchor="end"
                                height={70}
                              />
                              <YAxis tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }} allowDecimals={false} />
                              <Tooltip
                                contentStyle={{ background: "#0c2340", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                                labelStyle={{ color: "#fff" }}
                                itemStyle={{ color: "#34d399" }}
                                formatter={(v) => [v, "Conversions"]}
                              />
                              <Bar dataKey="count" name="Conversions" radius={[4, 4, 0, 0]} fill="#34d399" />
                            </BarChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                );
              })()}
            </>
          )}
        </div>

        {/* Slide navigation */}
        <div className="flex items-center justify-between px-8 py-4 border-t border-white/10">
          <button
            onClick={() => setSlide((s) => Math.max(s - 1, 0))}
            disabled={slide === 0}
            className="px-5 py-2 rounded-lg border border-white/20 text-sm text-white/60 hover:text-white hover:border-white/40 disabled:opacity-20 transition-colors"
          >
            ← Prev
          </button>

          {/* Dots */}
          <div className="flex items-center gap-3">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setSlide(i)}
                className={`w-2.5 h-2.5 rounded-full transition-all ${
                  i === slide ? "bg-[#c4933f] scale-125" : "bg-white/30 hover:bg-white/50"
                }`}
              />
            ))}
            <span className="ml-2 text-white/30 text-xs">
              {slide + 1} / {SLIDES.length}
            </span>
          </div>

          <button
            onClick={() => setSlide((s) => Math.min(s + 1, SLIDES.length - 1))}
            disabled={slide === SLIDES.length - 1}
            className="px-5 py-2 rounded-lg border border-white/20 text-sm text-white/60 hover:text-white hover:border-white/40 disabled:opacity-20 transition-colors"
          >
            Next →
          </button>
        </div>

        <div className="text-center text-white/20 text-xs pb-3">
          Use ← → arrow keys to navigate · {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </div>
      </div>
    </>
  );
}

function SourcePills({ src }) {
  if (!src) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-white/10 text-white/80">📞 {src.Call ?? 0}</span>
      {(src.WalkIn ?? 0) > 0 && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-teal-500/20 text-teal-300">🚶 {src.WalkIn}</span>
      )}
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-[#c4933f]/20 text-[#c4933f]">📋 {src.WebForm ?? 0}</span>
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300">🌐 {src.Digital ?? 0}</span>
    </div>
  );
}

function KpiCard({ label, value, accent = "text-[#c4933f]", small = false, src }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5">
      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">{label}</div>
      <div className={`font-bold ${small ? "text-4xl" : "text-6xl"} ${accent}`}>{value}</div>
      {src && <SourcePills src={src} />}
    </div>
  );
}
