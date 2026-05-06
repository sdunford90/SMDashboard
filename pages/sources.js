import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";

function pct(n) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

function isoDay(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${da}`;
}

const QUICK_WINDOWS = [
  { id: "7", label: "Last 7d" },
  { id: "30", label: "Last 30d" },
  { id: "90", label: "Last 90d" },
  { id: "mtd", label: "Month to date" },
  { id: "ytd", label: "All 2026" },
];

function rangeForQuick(id) {
  const today = new Date();
  const todayStr = isoDay(today);
  if (id === "ytd") return { from: "2026-01-01", to: todayStr };
  if (id === "mtd") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: isoDay(first), to: todayStr };
  }
  const days = parseInt(id, 10);
  if (!isNaN(days)) {
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    return { from: isoDay(start), to: todayStr };
  }
  return { from: "2026-01-01", to: todayStr };
}

export default function SourcesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Default to all-2026 to match the previous behavior on first load.
  const [range, setRange] = useState(() => rangeForQuick("ytd"));
  const [activeQuick, setActiveQuick] = useState("ytd");

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    fetch(`/api/sources?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [range.from, range.to]);

  function applyQuick(id) {
    setActiveQuick(id);
    setRange(rangeForQuick(id));
  }

  function applyCustom(field, value) {
    setActiveQuick(null);
    setRange((prev) => ({ ...prev, [field]: value }));
  }

  // Group property×source rows by property for the detailed table.
  const grouped = useMemo(() => {
    if (!data?.rows) return [];
    const map = new Map();
    for (const row of data.rows) {
      if (!map.has(row.property)) map.set(row.property, []);
      map.get(row.property).push(row);
    }
    return Array.from(map.entries())
      .map(([property, rows]) => ({
        property,
        rows,
        total: rows.reduce((s, r) => s + r.total, 0),
        converted: rows.reduce((s, r) => s + r.converted, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [data]);

  const windowText = data
    ? `${new Date(data.windowStart).toLocaleDateString()} → ${
        data.windowEnd ? new Date(data.windowEnd).toLocaleDateString() : "today"
      }`
    : "";

  return (
    <div className="min-h-screen bg-gray-50">
      <Head>
        <title>Source Close Ratios</title>
      </Head>
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <h1 className="text-2xl font-semibold text-navy">Close Ratio by Source</h1>
          <p className="text-sm text-gray-500 mt-1">
            Per-property breakdown of leads grouped by acquisition channel.
            {data && <> Window: {windowText}.</>}
          </p>

          {/* Date controls */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-1">
              {QUICK_WINDOWS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => applyQuick(w.id)}
                  className={`px-2.5 py-1.5 rounded text-xs font-medium border transition-colors ${
                    activeQuick === w.id
                      ? "bg-navy text-white border-navy"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <label className="flex items-center gap-1">
                From
                <input
                  type="date"
                  value={range.from || ""}
                  onChange={(e) => applyCustom("from", e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-navy/40"
                />
              </label>
              <label className="flex items-center gap-1">
                To
                <input
                  type="date"
                  value={range.to || ""}
                  onChange={(e) => applyCustom("to", e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-navy/40"
                />
              </label>
              {loading && <span className="text-gray-400 italic ml-2">Loading…</span>}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
            Failed to load source data: {error}
          </div>
        )}

        {!data && !error && (
          <div className="text-gray-400 text-sm">Loading…</div>
        )}

        {data && (
          <>
            {/* Totals */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white rounded-xl border p-5">
                <div className="text-xs uppercase text-gray-500 font-medium">Total Leads</div>
                <div className="text-2xl font-semibold text-navy mt-1">{data.totals.leads}</div>
              </div>
              <div className="bg-white rounded-xl border p-5">
                <div className="text-xs uppercase text-gray-500 font-medium">Converted</div>
                <div className="text-2xl font-semibold text-emerald-600 mt-1">{data.totals.converted}</div>
              </div>
              <div className="bg-white rounded-xl border p-5">
                <div className="text-xs uppercase text-gray-500 font-medium">Overall Close Ratio</div>
                <div className="text-2xl font-semibold text-gold mt-1">{pct(data.totals.closeRatio)}</div>
              </div>
            </div>

            {/* By Source */}
            <section className="bg-white rounded-xl border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">By Source (all properties)</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Source</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Leads</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Converted</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Close Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySource.map((row) => (
                      <tr key={row.source} className="border-b hover:bg-gray-50/60">
                        <td className="px-4 py-2 font-medium">{row.source}</td>
                        <td className="px-4 py-2 text-right">{row.total}</td>
                        <td className="px-4 py-2 text-right text-emerald-600">{row.converted}</td>
                        <td className="px-4 py-2 text-right font-semibold">{pct(row.closeRatio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* By Property */}
            <section className="bg-white rounded-xl border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">By Property (all sources)</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Property</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Leads</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Converted</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Close Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byProperty.map((row) => (
                      <tr key={row.property} className="border-b hover:bg-gray-50/60">
                        <td className="px-4 py-2 font-medium">{row.property}</td>
                        <td className="px-4 py-2 text-right">{row.total}</td>
                        <td className="px-4 py-2 text-right text-emerald-600">{row.converted}</td>
                        <td className="px-4 py-2 text-right font-semibold">{pct(row.closeRatio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Property × Source */}
            <section className="bg-white rounded-xl border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">Property × Source</h2>
                <p className="text-xs text-gray-500 mt-1">
                  Each property's leads broken out by acquisition channel.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Property</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase">Source</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Leads</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Converted</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase">Close Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map((group) => (
                      <React.Fragment key={group.property}>
                        {group.rows.map((row, idx) => (
                          <tr key={`${group.property}-${row.source}`} className="border-b hover:bg-gray-50/60">
                            {idx === 0 ? (
                              <td
                                className="px-4 py-2 font-semibold align-top text-navy"
                                rowSpan={group.rows.length + 1}
                              >
                                {group.property}
                              </td>
                            ) : null}
                            <td className="px-4 py-2">{row.source}</td>
                            <td className="px-4 py-2 text-right">{row.total}</td>
                            <td className="px-4 py-2 text-right text-emerald-600">{row.converted}</td>
                            <td className="px-4 py-2 text-right font-semibold">{pct(row.closeRatio)}</td>
                          </tr>
                        ))}
                        <tr className="border-b bg-gray-50/70 text-xs">
                          <td className="px-4 py-2 italic text-gray-600">Total</td>
                          <td className="px-4 py-2 text-right font-semibold">{group.total}</td>
                          <td className="px-4 py-2 text-right font-semibold text-emerald-600">{group.converted}</td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {pct(group.total > 0 ? group.converted / group.total : 0)}
                          </td>
                        </tr>
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
