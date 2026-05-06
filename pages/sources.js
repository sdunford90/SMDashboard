import React, { useEffect, useState } from "react";
import Head from "next/head";

function pct(n) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

export default function SourcesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/sources")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  // Group property×source rows by property for the detailed table.
  const grouped = React.useMemo(() => {
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
            {data?.windowStart && (
              <> Window: {new Date(data.windowStart).toLocaleDateString()} → today.</>
            )}
          </p>
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
