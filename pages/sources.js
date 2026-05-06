import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";

function pct(n) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function sortRows(rows, key, dir) {
  if (!key) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const r = cmp(a[key], b[key]);
    return dir === "asc" ? r : -r;
  });
  return copy;
}

function SortHeader({ label, sortKey, state, setState, align = "left" }) {
  const active = state.key === sortKey;
  const arrow = !active ? "" : state.dir === "asc" ? " ▲" : " ▼";
  const alignClass = align === "right" ? "text-right" : "text-left";
  return (
    <th className={`px-4 py-2 ${alignClass} text-xs font-semibold uppercase`}>
      <button
        type="button"
        onClick={() =>
          setState((prev) =>
            prev.key === sortKey
              ? { key: sortKey, dir: prev.dir === "asc" ? "desc" : "asc" }
              : { key: sortKey, dir: align === "right" ? "desc" : "asc" }
          )
        }
        className={`inline-flex items-center gap-0.5 hover:text-navy transition-colors ${
          active ? "text-navy" : "text-gray-600"
        }`}
      >
        {label}
        <span className="text-[10px]">{arrow}</span>
      </button>
    </th>
  );
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
  const [selectedProperty, setSelectedProperty] = useState("__all__");

  const [bySourceSort, setBySourceSort] = useState({ key: "total", dir: "desc" });
  const [byPropertySort, setByPropertySort] = useState({ key: "total", dir: "desc" });
  const [pxsSort, setPxsSort] = useState({ key: "total", dir: "desc" });

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

  // Full list of properties (for the selector) — derived from all rows
  // before any property filter is applied.
  const allProperties = useMemo(() => {
    if (!data?.byProperty) return [];
    return data.byProperty.map((r) => r.property).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const propertyFilterActive = selectedProperty && selectedProperty !== "__all__";

  // Filter the dataset client-side when a property is selected.
  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    if (!propertyFilterActive) return data.rows;
    return data.rows.filter((r) => r.property === selectedProperty);
  }, [data, selectedProperty, propertyFilterActive]);

  const filteredByProperty = useMemo(() => {
    if (!data?.byProperty) return [];
    if (!propertyFilterActive) return data.byProperty;
    return data.byProperty.filter((r) => r.property === selectedProperty);
  }, [data, selectedProperty, propertyFilterActive]);

  // When a property is selected, recompute By-Source and totals from the
  // filtered cell rows so the numbers reflect just that property.
  const filteredBySource = useMemo(() => {
    if (!data) return [];
    if (!propertyFilterActive) return data.bySource;
    const m = new Map();
    for (const r of filteredRows) {
      if (!m.has(r.source)) m.set(r.source, { source: r.source, total: 0, converted: 0 });
      const s = m.get(r.source);
      s.total += r.total;
      s.converted += r.converted;
    }
    return Array.from(m.values())
      .map((r) => ({ ...r, closeRatio: r.total > 0 ? r.converted / r.total : 0 }))
      .sort((a, b) => b.total - a.total);
  }, [data, filteredRows, propertyFilterActive]);

  const filteredTotals = useMemo(() => {
    if (!data) return null;
    if (!propertyFilterActive) return data.totals;
    const leads = filteredRows.reduce((s, r) => s + r.total, 0);
    const converted = filteredRows.reduce((s, r) => s + r.converted, 0);
    return { leads, converted, closeRatio: leads > 0 ? converted / leads : 0 };
  }, [data, filteredRows, propertyFilterActive]);

  const sortedBySource = useMemo(
    () => sortRows(filteredBySource, bySourceSort.key, bySourceSort.dir),
    [filteredBySource, bySourceSort]
  );

  const sortedByProperty = useMemo(
    () => sortRows(filteredByProperty, byPropertySort.key, byPropertySort.dir),
    [filteredByProperty, byPropertySort]
  );

  // Group property×source rows by property for the detailed table.
  // Sort the property groups by the chosen column (using each group's
  // aggregate for numeric columns, property name for the property column),
  // and sort the source rows within each group by the same column.
  const grouped = useMemo(() => {
    if (!filteredRows.length) return [];
    const map = new Map();
    for (const row of filteredRows) {
      if (!map.has(row.property)) map.set(row.property, []);
      map.get(row.property).push(row);
    }
    let groups = Array.from(map.entries()).map(([property, rows]) => {
      const total = rows.reduce((s, r) => s + r.total, 0);
      const converted = rows.reduce((s, r) => s + r.converted, 0);
      return {
        property,
        rows,
        total,
        converted,
        closeRatio: total > 0 ? converted / total : 0,
      };
    });

    // Inner row sort
    const innerKey = pxsSort.key === "property" ? "source" : pxsSort.key;
    groups = groups.map((g) => ({
      ...g,
      rows: sortRows(g.rows, innerKey, pxsSort.dir),
    }));

    // Group order
    const groupKey = pxsSort.key === "source" ? "property" : pxsSort.key;
    groups = sortRows(groups, groupKey, pxsSort.dir);

    return groups;
  }, [filteredRows, pxsSort]);

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
            <div className="flex items-center gap-2 text-xs text-gray-600 ml-auto">
              <label className="flex items-center gap-1">
                Property
                <select
                  value={selectedProperty}
                  onChange={(e) => setSelectedProperty(e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-navy/40 bg-white"
                >
                  <option value="__all__">All properties</option>
                  {allProperties.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
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
                <div className="text-2xl font-semibold text-navy mt-1">{filteredTotals.leads}</div>
              </div>
              <div className="bg-white rounded-xl border p-5">
                <div className="text-xs uppercase text-gray-500 font-medium">Converted</div>
                <div className="text-2xl font-semibold text-emerald-600 mt-1">{filteredTotals.converted}</div>
              </div>
              <div className="bg-white rounded-xl border p-5">
                <div className="text-xs uppercase text-gray-500 font-medium">Overall Close Ratio</div>
                <div className="text-2xl font-semibold text-gold mt-1">{pct(filteredTotals.closeRatio)}</div>
              </div>
            </div>

            {/* By Source */}
            <section className="bg-white rounded-xl border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">
                  By Source ({propertyFilterActive ? selectedProperty : "all properties"})
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <SortHeader label="Source" sortKey="source" state={bySourceSort} setState={setBySourceSort} />
                      <SortHeader label="Leads" sortKey="total" state={bySourceSort} setState={setBySourceSort} align="right" />
                      <SortHeader label="Converted" sortKey="converted" state={bySourceSort} setState={setBySourceSort} align="right" />
                      <SortHeader label="Close Ratio" sortKey="closeRatio" state={bySourceSort} setState={setBySourceSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedBySource.map((row) => (
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
                      <SortHeader label="Property" sortKey="property" state={byPropertySort} setState={setByPropertySort} />
                      <SortHeader label="Leads" sortKey="total" state={byPropertySort} setState={setByPropertySort} align="right" />
                      <SortHeader label="Converted" sortKey="converted" state={byPropertySort} setState={setByPropertySort} align="right" />
                      <SortHeader label="Close Ratio" sortKey="closeRatio" state={byPropertySort} setState={setByPropertySort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedByProperty.map((row) => (
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
                      <SortHeader label="Property" sortKey="property" state={pxsSort} setState={setPxsSort} />
                      <SortHeader label="Source" sortKey="source" state={pxsSort} setState={setPxsSort} />
                      <SortHeader label="Leads" sortKey="total" state={pxsSort} setState={setPxsSort} align="right" />
                      <SortHeader label="Converted" sortKey="converted" state={pxsSort} setState={setPxsSort} align="right" />
                      <SortHeader label="Close Ratio" sortKey="closeRatio" state={pxsSort} setState={setPxsSort} align="right" />
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
