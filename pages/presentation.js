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

const SLIDES = ["overview", "calls", "conversions", "sources"];

export default function Presentation() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slide, setSlide] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(null);

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

  useEffect(() => { load(); }, [load]);

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
            {lastRefresh && (
              <span className="text-white/40 text-xs">
                Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button
              onClick={load}
              className="text-xs border border-white/20 hover:border-[#c4933f] text-white/60 hover:text-white px-3 py-1.5 rounded transition-colors"
            >
              Refresh
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
                    />
                    <KpiCard
                      label={`Total Leads — ${monthName}`}
                      value={data.monthlyLeads}
                      accent="text-blue-400"
                    />
                    <KpiCard
                      label="Total Leads (All Time)"
                      value={data.totalLeads}
                      accent="text-white/60"
                      small
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
                  <div className="grid grid-cols-3 gap-5">
                    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5 text-center">
                      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">📞 Calls / Walk-ins</div>
                      <div className="text-5xl font-bold text-[#0c2340] bg-white/90 rounded-lg py-2">{data.sourceCount?.Call ?? 0}</div>
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
                            <Tooltip
                              contentStyle={{ background: "#0c2340", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                              labelStyle={{ color: "#fff" }}
                            />
                            <Legend wrapperStyle={{ color: "rgba(255,255,255,0.6)", fontSize: 12, paddingTop: 8 }} />
                            <Bar dataKey="Call" name="Call / Walk-in" stackId="a" fill="#0c2340" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
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
                                <td className="px-5 py-2.5 text-right font-semibold text-[#c4933f]">{row["Web Form"]}</td>
                                <td className="px-5 py-2.5 text-right font-semibold text-blue-400">{row.Digital}</td>
                                <td className="px-5 py-2.5 text-right text-white/50">{row.total}</td>
                              </tr>
                            ))}
                            <tr className="border-t border-white/20 font-bold">
                              <td className="px-5 py-3 text-white/60 text-xs uppercase tracking-wide">Total</td>
                              <td className="px-5 py-3 text-right text-white/80">{data.sourceCount?.Call ?? 0}</td>
                              <td className="px-5 py-3 text-right text-[#c4933f]">{data.sourceCount?.["Web Form"] ?? 0}</td>
                              <td className="px-5 py-3 text-right text-blue-400">{data.sourceCount?.Digital ?? 0}</td>
                              <td className="px-5 py-3 text-right text-white">
                                {(data.sourceCount?.Call ?? 0) + (data.sourceCount?.["Web Form"] ?? 0) + (data.sourceCount?.Digital ?? 0)}
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
              {slide === 2 && (
                <div className="flex-1 px-8 py-6 flex flex-col gap-6">
                  <h2 className="text-2xl font-bold text-[#c4933f] tracking-wide">
                    Conversions — Leads to Customers
                  </h2>

                  {/* KPI row */}
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                    <KpiCard
                      label="Total Conversions"
                      value={data.conversionTotal ?? 0}
                      accent="text-emerald-400"
                    />
                    <KpiCard
                      label="Avg Days to Convert"
                      value={data.conversionAvgDays !== null ? `${data.conversionAvgDays}d` : "--"}
                      accent="text-blue-400"
                    />
                    <KpiCard
                      label="Fastest Conversion"
                      value={data.conversionFastest !== null ? `${data.conversionFastest}d` : "--"}
                      accent="text-[#c4933f]"
                      small
                    />
                  </div>

                  {/* Breakdown table */}
                  <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
                      <div className="px-5 py-3 border-b border-white/10">
                        <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest">Conversions by Property</h3>
                      </div>
                      {!data.conversionsByMarina || data.conversionsByMarina.length === 0 ? (
                        <div className="px-5 py-6 text-center text-white/30">No conversion data</div>
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
                            {data.conversionsByMarina.map((row) => (
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
                                {data.conversionsByMarina.reduce((s, r) => s + r.count, 0)}
                              </td>
                              <td className="px-5 py-3 text-right text-white/60"></td>
                            </tr>
                          </tbody>
                        </table>
                      )}
                    </div>

                    {/* Bar chart */}
                    <div className="bg-white/5 rounded-xl border border-white/10 p-5 flex flex-col">
                      <h3 className="font-semibold text-sm text-white/70 uppercase tracking-widest mb-4">Conversions by Property</h3>
                      <div className="flex-1 min-h-[220px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={data.conversionsByMarina || []}
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
                      </div>
                    </div>
                  </div>
                </div>
              )}
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

function KpiCard({ label, value, accent = "text-[#c4933f]", small = false }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-5">
      <div className="text-white/50 text-xs uppercase tracking-widest mb-2">{label}</div>
      <div className={`font-bold ${small ? "text-4xl" : "text-6xl"} ${accent}`}>{value}</div>
    </div>
  );
}
