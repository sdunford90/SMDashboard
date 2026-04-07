import React, { useState, useEffect, useCallback } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import LoadingSkeleton from "../components/LoadingSkeleton";

const LineChart = dynamic(
  () => import("recharts").then((mod) => mod.LineChart),
  { ssr: false }
);
const BarChart = dynamic(
  () => import("recharts").then((mod) => mod.BarChart),
  { ssr: false }
);
const Line = dynamic(() => import("recharts").then((mod) => mod.Line), {
  ssr: false,
});
const Bar = dynamic(() => import("recharts").then((mod) => mod.Bar), {
  ssr: false,
});
const XAxis = dynamic(() => import("recharts").then((mod) => mod.XAxis), {
  ssr: false,
});
const YAxis = dynamic(() => import("recharts").then((mod) => mod.YAxis), {
  ssr: false,
});
const CartesianGrid = dynamic(
  () => import("recharts").then((mod) => mod.CartesianGrid),
  { ssr: false }
);
const Tooltip = dynamic(() => import("recharts").then((mod) => mod.Tooltip), {
  ssr: false,
});
const Legend = dynamic(() => import("recharts").then((mod) => mod.Legend), {
  ssr: false,
});
const ResponsiveContainer = dynamic(
  () => import("recharts").then((mod) => mod.ResponsiveContainer),
  { ssr: false }
);

const MARINA_COLORS = [
  "#0c2340", "#c4933f", "#2563eb", "#dc2626", "#16a34a",
  "#9333ea", "#ea580c", "#0891b2", "#4f46e5", "#be123c",
  "#65a30d", "#0d9488", "#7c3aed", "#db2777", "#ca8a04",
];

function timeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatSpeedToLead(minutes) {
  if (minutes === null || minutes === undefined) return "--";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

function speedToLeadColor(minutes) {
  if (minutes === null || minutes === undefined) return "text-red-600";
  if (minutes < 60) return "text-green-600";
  if (minutes <= 240) return "text-yellow-600";
  return "text-red-600";
}

function StatusBadge({ status }) {
  const styles = {
    Converted: "bg-emerald-100 text-emerald-800 border-emerald-200",
    "Missed Call": "bg-red-100 text-red-800 border-red-200",
    "Waiting on Reply": "bg-orange-100 text-orange-800 border-orange-200",
    Responded: "bg-green-100 text-green-800 border-green-200",
    "Never Responded": "bg-yellow-100 text-yellow-800 border-yellow-200",
  };
  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium border ${
        styles[status] || "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

function SortIconBase({ col, tableSort }) {
  if (tableSort.col !== col) return <span className="text-gray-300 ml-1">&#x25B4;&#x25BE;</span>;
  return tableSort.dir === "asc" ? <span className="ml-1">&#x25B4;</span> : <span className="ml-1">&#x25BE;</span>;
}

export default function Dashboard() {
  const [leads, setLeads] = useState(null);
  const [speedData, setSpeedData] = useState(null);
  const [actionQueue, setActionQueue] = useState(null);
  const [callData, setCallData] = useState(null);
  const [activityFeed, setActivityFeed] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState("missed");
  const [callDays, setCallDays] = useState(30);
  const [marinaFilter, setMarinaFilter] = useState("all");
  const [tableSort, setTableSort] = useState({ col: "waitMinutes", dir: "desc" });
  const [tableFilter, setTableFilter] = useState({ marina: "all" });
  const [expandedLead, setExpandedLead] = useState(null);
  const [leadDetail, setLeadDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const fetchAll = useCallback(async () => {
    const endpoints = [
      fetch("/api/leads").then((r) => r.json()),
      fetch("/api/speed-to-lead").then((r) => r.json()),
      fetch("/api/action-queue").then((r) => r.json()),
      fetch(`/api/calls?days=${callDays}`).then((r) => r.json()),
      fetch("/api/activity-feed").then((r) => r.json()),
    ];
    const [leadsRes, speedRes, queueRes, callsRes, feedRes] =
      await Promise.allSettled(endpoints);

    if (leadsRes.status === "fulfilled") setLeads(leadsRes.value);
    if (speedRes.status === "fulfilled") setSpeedData(speedRes.value);
    if (queueRes.status === "fulfilled") setActionQueue(queueRes.value);
    if (callsRes.status === "fulfilled") setCallData(callsRes.value);
    if (feedRes.status === "fulfilled") setActivityFeed(feedRes.value);
    setLastUpdated(new Date());
  }, [callDays]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh activity feed every 60s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/activity-feed");
        const data = await res.json();
        setActivityFeed(data);
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cache/clear", { method: "POST" });
      await fetchAll();
    } catch {} finally {
      setRefreshing(false);
    }
  };

  const handleExpandLead = async (contactId) => {
    if (expandedLead === contactId) {
      setExpandedLead(null);
      setLeadDetail(null);
      return;
    }
    setExpandedLead(contactId);
    setLeadDetail(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/lead-detail/${contactId}`);
      const data = await res.json();
      setLeadDetail(data);
    } catch {} finally {
      setLoadingDetail(false);
    }
  };

  // Summary calculations
  const totalLeads = leads?.total || 0;
  const respondedCount = leads?.leads?.filter((l) => l.responded).length || 0;
  const respondedPct = totalLeads > 0 ? Math.round((respondedCount / totalLeads) * 100) : 0;
  const avgSpeed = leads?.leads?.length
    ? leads.leads
        .filter((l) => l.speedToLeadMinutes !== null)
        .reduce((sum, l, _, arr) => sum + l.speedToLeadMinutes / arr.length, 0)
    : null;
  const waitingCount =
    (actionQueue?.counts?.missedCalls || 0) +
    (actionQueue?.counts?.waitingOnReply || 0);

  // Filtered marinas list
  const allMarinas = leads?.leads
    ? [...new Set(leads.leads.map((l) => l.marina))].sort()
    : [];
  // Sorted / filtered leads table
  const filteredLeads = (leads?.leads || []).filter((l) => {
    if (tableFilter.marina !== "all" && l.marina !== tableFilter.marina) return false;
    return true;
  });
  const sortedLeads = [...filteredLeads].sort((a, b) => {
    const dir = tableSort.dir === "asc" ? 1 : -1;
    const col = tableSort.col;
    if (col === "name") return dir * (a.name || "").localeCompare(b.name || "");
    if (col === "marina") return dir * (a.marina || "").localeCompare(b.marina || "");
    if (col === "ownerName") return dir * (a.ownerName || "").localeCompare(b.ownerName || "");
    if (col === "createDate") return dir * (new Date(a.createDate) - new Date(b.createDate));
    if (col === "speedToLeadMinutes") {
      const av = a.speedToLeadMinutes ?? 999999;
      const bv = b.speedToLeadMinutes ?? 999999;
      return dir * (av - bv);
    }
    if (col === "waitMinutes") {
      const aw = a.waitingSince ? Date.now() - new Date(a.waitingSince).getTime() : a.responded ? -1 : Date.now() - new Date(a.createDate).getTime();
      const bw = b.waitingSince ? Date.now() - new Date(b.waitingSince).getTime() : b.responded ? -1 : Date.now() - new Date(b.createDate).getTime();
      return dir * (aw - bw);
    }
    return 0;
  });

  const handleSort = (col) => {
    setTableSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "desc" }
    );
  };

  const SortIcon = ({ col }) => <SortIconBase col={col} tableSort={tableSort} />;

  return (
    <>
      <Head>
        <title>Southern Marinas - Lead Dashboard</title>
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>

      <div className="min-h-screen bg-gray-50 font-montserrat">
        {/* Header */}
        <header className="bg-navy text-white px-6 py-4 flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-2xl">&#9875;</span>
            <div>
              <h1 className="text-xl font-bold tracking-wide">Southern Marinas</h1>
              <p className="text-gold text-xs font-medium">Lead Response Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {lastUpdated && (
              <span className="text-gray-400 text-xs hidden sm:block">
                Last updated: {timeAgo(lastUpdated)}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="bg-gold hover:bg-yellow-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <svg
                className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </header>

        <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
          {/* Summary Bar */}
          {!leads?.leads ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <LoadingSkeleton key={i} height="h-24" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Total Leads" value={totalLeads} />
              <StatCard label="Responded" value={`${respondedPct}%`} sub={`${respondedCount} of ${totalLeads}`} />
              <StatCard label="Avg Speed to Lead" value={formatSpeedToLead(avgSpeed)} />
              <StatCard
                label="Waiting Now"
                value={waitingCount}
                highlight={waitingCount > 0}
              />
            </div>
          )}

          {/* Action Queue */}
          {!actionQueue?.counts ? (
            <LoadingSkeleton height="h-64" />
          ) : (
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="border-b px-6 py-3 flex items-center gap-1 overflow-x-auto">
                <TabButton
                  active={activeTab === "missed"}
                  onClick={() => setActiveTab("missed")}
                  label="Missed Inbound Calls"
                  count={actionQueue.counts.missedCalls}
                  color="red"
                />
                <TabButton
                  active={activeTab === "waiting"}
                  onClick={() => setActiveTab("waiting")}
                  label="Waiting on Reply"
                  count={actionQueue.counts.waitingOnReply}
                  color="orange"
                />
                <TabButton
                  active={activeTab === "never"}
                  onClick={() => setActiveTab("never")}
                  label="Never Responded"
                  count={actionQueue.counts.neverResponded}
                  color="yellow"
                />
              </div>
              <div className="overflow-x-auto">
                {activeTab === "missed" && (
                  <ActionTable
                    items={actionQueue.missedCalls}
                    columns={["Lead", "Marina", "Missed Call Time", "Attempts", "Phone", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-red-50/30">
                        <td className="px-4 py-3 font-medium text-sm">{item.name}</td>
                        <td className="px-4 py-3 text-sm">{item.marina}</td>
                        <td className="px-4 py-3 text-sm">{timeAgo(item.missedCallTime)}</td>
                        <td className="px-4 py-3 text-sm">{item.attempts}</td>
                        <td className="px-4 py-3 text-sm">
                          {item.phone ? (
                            <a href={`tel:${item.phone}`} className="text-blue-600 hover:underline">
                              {item.phone}
                            </a>
                          ) : "--"}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <a href={item.hubspotUrl} target="_blank" rel="noreferrer" className="text-gold hover:underline text-xs font-medium">
                            Open in HubSpot
                          </a>
                        </td>
                      </tr>
                    )}
                  />
                )}
                {activeTab === "waiting" && (
                  <ActionTable
                    items={actionQueue.waitingOnReply}
                    columns={["Lead", "Marina", "Waiting Since", "Last Inbound", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-orange-50/30">
                        <td className="px-4 py-3 font-medium text-sm">{item.name}</td>
                        <td className="px-4 py-3 text-sm">{item.marina}</td>
                        <td className="px-4 py-3 text-sm">{timeAgo(item.waitingSince)}</td>
                        <td className="px-4 py-3 text-sm capitalize">{item.lastInboundType?.replace(/_/g, " ").toLowerCase()}</td>
                        <td className="px-4 py-3 text-sm">
                          <a href={item.hubspotUrl} target="_blank" rel="noreferrer" className="text-gold hover:underline text-xs font-medium">
                            Open in HubSpot
                          </a>
                        </td>
                      </tr>
                    )}
                  />
                )}
                {activeTab === "never" && (
                  <ActionTable
                    items={actionQueue.neverResponded}
                    columns={["Lead", "Marina", "Time Since Created", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-yellow-50/30">
                        <td className="px-4 py-3 font-medium text-sm">{item.name}</td>
                        <td className="px-4 py-3 text-sm">{item.marina}</td>
                        <td className="px-4 py-3 text-sm">{timeAgo(item.createDate)}</td>
                        <td className="px-4 py-3 text-sm">
                          <a href={item.hubspotUrl} target="_blank" rel="noreferrer" className="text-gold hover:underline text-xs font-medium">
                            Open in HubSpot
                          </a>
                        </td>
                      </tr>
                    )}
                  />
                )}
              </div>
            </div>
          )}

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Speed to Lead Chart */}
            <div className="lg:col-span-3 bg-white rounded-xl shadow-sm border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-navy">Speed to Lead</h2>
                <select
                  value={marinaFilter}
                  onChange={(e) => setMarinaFilter(e.target.value)}
                  className="text-sm border rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-gold focus:outline-none"
                >
                  <option value="all">All Marinas</option>
                  {speedData?.marinas?.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {!speedData?.data ? (
                <LoadingSkeleton height="h-64" />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={speedData.data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      label={{ value: "Hours", angle: -90, position: "insideLeft", fontSize: 12 }}
                      tickFormatter={(v) => formatSpeedToLead(v)}
                    />
                    <Tooltip
                      formatter={(value) => [formatSpeedToLead(value), ""]}
                      labelFormatter={(label) => `Week: ${label}`}
                    />
                    <Legend />
                    {(marinaFilter === "all"
                      ? speedData.marinas
                      : [marinaFilter]
                    ).map((marina, i) => (
                      <Line
                        key={marina}
                        type="monotone"
                        dataKey={marina}
                        stroke={MARINA_COLORS[i % MARINA_COLORS.length]}
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Call Activity Panel */}
            <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-navy">Call Activity</h2>
                <select
                  value={callDays}
                  onChange={(e) => setCallDays(Number(e.target.value))}
                  className="text-sm border rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-gold focus:outline-none"
                >
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </div>
              {!callData?.chartData ? (
                <LoadingSkeleton height="h-64" />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={callData.chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="marina" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="inbound" fill="#c4933f" name="Inbound" />
                      <Bar dataKey="outbound" fill="#0c2340" name="Outbound" />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="mt-4 space-y-2 max-h-32 overflow-y-auto">
                    {callData.marinas?.map((marina) => {
                      const stats = callData.marinaStats[marina];
                      return (
                        <div key={marina} className="flex justify-between text-xs border-b pb-1">
                          <span className="font-medium truncate max-w-[120px]">{marina}</span>
                          <span>{stats.totalOutbound} attempts</span>
                          <span>{stats.connectedRate}% conn.</span>
                          <span>{stats.avgDurationFormatted} avg</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Leads Table + Activity Feed */}
          <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
            {/* Full Leads Table */}
            <div className="lg:col-span-7 bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-navy mr-auto">All Leads</h2>
                <select
                  value={tableFilter.marina}
                  onChange={(e) => setTableFilter((f) => ({ ...f, marina: e.target.value }))}
                  className="text-xs border rounded px-2 py-1"
                >
                  <option value="all">All Marinas</option>
                  {allMarinas.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {!leads?.leads ? (
                <div className="p-6"><LoadingSkeleton height="h-64" /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50">
                      <tr>
                        {[
                          { col: "name", label: "Name" },
                          { col: "marina", label: "Marina" },
                          { col: "createDate", label: "Created" },
                          { col: "speedToLeadMinutes", label: "Speed to Lead" },
                        ].map(({ col, label }) => (
                          <th
                            key={col}
                            className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase cursor-pointer hover:text-navy select-none"
                            onClick={() => handleSort(col)}
                          >
                            {label}
                            <SortIcon col={col} />
                          </th>
                        ))}
                        <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Status</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Last Touch</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Emails</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Calls</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedLeads.map((lead) => (
                        <React.Fragment key={lead.contactId}>
                        <tr className={`border-b hover:bg-gray-50/50 cursor-pointer ${expandedLead === lead.contactId ? "bg-blue-50/40" : ""}`} onClick={() => handleExpandLead(lead.contactId)}>
                          <td className="px-4 py-3 text-sm font-medium">
                            <span className="mr-1 text-gray-400 text-xs">{expandedLead === lead.contactId ? "▼" : "▶"}</span>
                            {lead.name}
                            {lead.isBoatClub && (
                              <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">Boat Club</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">{lead.marina}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {new Date(lead.createDate).toLocaleDateString()}
                          </td>
                          <td className={`px-4 py-3 text-sm font-semibold ${speedToLeadColor(lead.speedToLeadMinutes)}`}>
                            {lead.speedToLeadFormatted}
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={lead.status} /></td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {lead.lastTouch
                              ? `${lead.lastTouch.subtype?.replace(/_/g, " ").toLowerCase()} ${timeAgo(lead.lastTouch.timestamp)}`
                              : "--"}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            <span title="Sent">{lead.emailsSent}s</span>{" "}
                            <span title="Logged">{lead.emailsLogged}l</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">
                            <span title="Outbound">{lead.callsOutbound}o</span>{" "}
                            <span title="Inbound">{lead.callsInbound}i</span>{" "}
                            <span title="Connected" className="text-green-600">{lead.callsConnected}c</span>{" "}
                            {lead.callsLogged > 0 && <span title="Logged" className="text-purple-600">{lead.callsLogged}lg</span>}
                          </td>
                          <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            <a
                              href={lead.hubspotUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-gold hover:underline text-xs font-medium whitespace-nowrap"
                            >
                              HubSpot
                            </a>
                          </td>
                        </tr>
                        {expandedLead === lead.contactId && (
                          <tr key={`${lead.contactId}-detail`}>
                            <td colSpan={9} className="bg-gray-50 px-0 py-0">
                              <LeadDetailPanel detail={leadDetail} loading={loadingDetail} />
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      ))}
                      {sortedLeads.length === 0 && (
                        <tr>
                          <td colSpan={9} className="px-4 py-8 text-center text-gray-400 text-sm">
                            No leads found
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Activity Feed */}
            <div className="lg:col-span-3 bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">Activity Feed</h2>
                <p className="text-xs text-gray-400">Last 30 days &middot; auto-refreshes</p>
              </div>
              {!activityFeed?.activities ? (
                <div className="p-6"><LoadingSkeleton height="h-64" /></div>
              ) : (
                <div className="max-h-[600px] overflow-y-auto divide-y">
                  {activityFeed.activities?.map((activity, i) => (
                    <div key={i} className="px-4 py-3 hover:bg-gray-50/50">
                      <div className="flex items-start gap-3">
                        <span className={`text-lg mt-0.5 ${
                          activity.type === "CALL" ? "text-navy" : "text-gold"
                        }`}>
                          {activity.type === "CALL" ? (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                              <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                            </svg>
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{activity.summary}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-gray-500">{activity.repName}</span>
                            <span className="text-xs text-gray-300">&middot;</span>
                            <span className="text-xs text-gray-400">{activity.marina}</span>
                            <span className="text-xs text-gray-300">&middot;</span>
                            <span className="text-xs text-gray-400">{timeAgo(activity.timestamp)}</span>
                          </div>
                          {activity.duration && (
                            <span className="text-xs text-gray-400">{activity.duration}</span>
                          )}
                          {activity.bodyPreview && (
                            <p className="text-xs text-gray-400 mt-1 line-clamp-2 italic">{activity.bodyPreview.slice(0, 150)}{activity.bodyPreview.length > 150 ? "..." : ""}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {activityFeed.activities?.length === 0 && (
                    <div className="px-4 py-8 text-center text-gray-400 text-sm">
                      No recent activity
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

function StatCard({ label, value, sub, highlight }) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border p-5 ${highlight ? "border-red-300 bg-red-50" : ""}`}>
      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${highlight ? "text-red-600" : "text-navy"}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function TabButton({ active, onClick, label, count, color }) {
  const colors = {
    red: "bg-red-500",
    orange: "bg-orange-500",
    yellow: "bg-yellow-500",
  };
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? "text-navy border-b-2 border-gold"
          : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {label}
      <span className={`ml-2 ${colors[color]} text-white text-xs font-bold px-1.5 py-0.5 rounded-full`}>
        {count}
      </span>
    </button>
  );
}

function ActionTable({ items, columns, renderRow }) {
  if (!items || items.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-gray-400 text-sm">
        No items in this queue
      </div>
    );
  }
  return (
    <table className="w-full text-left">
      <thead className="bg-gray-50">
        <tr>
          {columns.map((col, i) => (
            <th key={i} className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{items.map(renderRow)}</tbody>
    </table>
  );
}

const SENTIMENT_COLORS = {
  positive: "bg-green-100 text-green-800 border-green-200",
  neutral: "bg-gray-100 text-gray-800 border-gray-200",
  negative: "bg-red-100 text-red-800 border-red-200",
  frustrated: "bg-red-200 text-red-900 border-red-300",
  unknown: "bg-gray-100 text-gray-500 border-gray-200",
};

const URGENCY_COLORS = {
  high: "text-red-600 font-bold",
  medium: "text-yellow-600 font-semibold",
  low: "text-green-600",
  unknown: "text-gray-400",
};

function LeadDetailPanel({ detail, loading }) {
  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
          <div className="h-3 bg-gray-200 rounded w-2/3" />
          <div className="h-3 bg-gray-200 rounded w-1/2" />
          <div className="h-20 bg-gray-200 rounded w-full mt-4" />
        </div>
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="p-6 space-y-5">
      {/* AI Summary Card */}
      {detail.aiSummary && (
        <div className="bg-white rounded-lg border p-4 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-semibold text-navy">AI Analysis</h3>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${SENTIMENT_COLORS[detail.aiSummary.sentiment] || SENTIMENT_COLORS.unknown}`}>
              {detail.aiSummary.sentiment}
            </span>
            <span className={`text-xs ${URGENCY_COLORS[detail.aiSummary.urgency] || URGENCY_COLORS.unknown}`}>
              {detail.aiSummary.urgency} urgency
            </span>
          </div>
          <p className="text-sm text-gray-700 leading-relaxed">{detail.aiSummary.summary}</p>
          {detail.aiSummary.keyTopics?.length > 0 && (
            <div className="flex gap-2 mt-3 flex-wrap">
              {detail.aiSummary.keyTopics.map((topic, i) => (
                <span key={i} className="bg-navy/10 text-navy text-xs px-2 py-0.5 rounded">{topic}</span>
              ))}
            </div>
          )}
          {detail.aiSummary.nextStep && (
            <div className="mt-3 bg-gold/10 border border-gold/30 rounded px-3 py-2">
              <span className="text-xs font-semibold text-gold">Suggested Next Step: </span>
              <span className="text-xs text-gray-700">{detail.aiSummary.nextStep}</span>
            </div>
          )}
        </div>
      )}

      {/* Engagement Timeline */}
      <div>
        <h3 className="text-sm font-semibold text-navy mb-3">Rep Activity Timeline</h3>
        <div className="space-y-0 border-l-2 border-gray-200 ml-3">
          {detail.timeline?.map((event, i) => (
            <div key={i} className="relative pl-6 pb-4">
              <div className={`absolute -left-[9px] top-1 w-4 h-4 rounded-full border-2 border-white ${
                event.type === "CALL"
                  ? event.isLogged ? "bg-purple-500"
                  : event.direction === "INBOUND" ? "bg-orange-400"
                  : "bg-navy"
                  : event.subtype === "EMAIL_INBOUND" ? "bg-gray-400"
                  : event.subtype === "EMAIL_LOGGED" ? "bg-purple-500"
                  : event.isAutomated ? "bg-gray-300"
                  : "bg-gold"
              }`} />
              <div className="bg-white rounded border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {event.type === "CALL" ? (
                      <svg className="w-3.5 h-3.5 text-navy" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-gold" fill="currentColor" viewBox="0 0 20 20"><path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" /><path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" /></svg>
                    )}
                    <span className="text-sm font-medium">{event.label}</span>
                    {event.durationFormatted && (
                      <span className="text-xs text-gray-400">({event.durationFormatted})</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {new Date(event.timestamp).toLocaleString()}
                  </span>
                </div>
                {event.subject && (
                  <p className="text-xs text-gray-600 mt-1">
                    <span className="font-medium">Subject:</span> {event.subject}
                  </p>
                )}
                {event.bodyPreview && (
                  <p className="text-xs text-gray-500 mt-1 italic line-clamp-3">{event.bodyPreview}</p>
                )}
                {event.notes && (
                  <p className="text-xs text-gray-500 mt-1 italic line-clamp-3">{event.notes}</p>
                )}
                {event.sentBy && (
                  <p className="text-xs text-gray-400 mt-1">From: {event.sentBy}</p>
                )}
              </div>
            </div>
          ))}
          {(!detail.timeline || detail.timeline.length === 0) && (
            <p className="pl-6 text-sm text-gray-400">No engagement activity found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
