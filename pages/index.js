import React, { useState, useEffect, useCallback } from "react";
import {
  JOB_SCORE_MIN_LEADS,
  JOB_SCORE_WEIGHTS,
  JOB_SCORE_THRESHOLDS,
  computePropertyRawSignals,
  computeJobScore,
} from "../lib/job-score";
import Head from "next/head";
import Link from "next/link";
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
const Cell = dynamic(() => import("recharts").then((mod) => mod.Cell), { ssr: false });

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

function urgencyRowStyle(urgency) {
  if (urgency === "critical") return "border-b border-l-4 border-l-red-500 hover:bg-red-50/40";
  if (urgency === "high") return "border-b border-l-4 border-l-orange-400 hover:bg-orange-50/30";
  if (urgency === "medium") return "border-b border-l-4 border-l-yellow-400 hover:bg-yellow-50/30";
  return "border-b border-l-4 border-l-gray-200 hover:bg-gray-50/30";
}

function urgencyAgeStyle(urgency) {
  if (urgency === "critical") return "text-red-600 font-semibold";
  if (urgency === "high") return "text-orange-500 font-semibold";
  if (urgency === "medium") return "text-yellow-600 font-medium";
  return "text-gray-500";
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
  const [conversionData, setConversionData] = useState(null);
  const [trendsData, setTrendsData] = useState(null);
  const [classifierMetrics, setClassifierMetrics] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [cacheStatus, setCacheStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState("missed");
  const [summaryMarina, setSummaryMarina] = useState("all");
  const [sourceChartView, setSourceChartView] = useState("property");
  const [dateWindow, setDateWindow] = useState("7");
  const [callDays, setCallDays] = useState(30);
  const [callsMarinaFilter, setCallsMarinaFilter] = useState("all");
  const [leadsDateWindow, setLeadsDateWindow] = useState("apr1");
  const [marinaFilter, setMarinaFilter] = useState("all");
  const [tableSort, setTableSort] = useState({ col: "waitMinutes", dir: "desc" });
  const [tableFilter, setTableFilter] = useState({ marina: "all" });
  const [nameSearch, setNameSearch] = useState("");
  const [expandedLead, setExpandedLead] = useState(null);
  const [leadDetail, setLeadDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [pageTab, setPageTab] = useState("overview");
  const [expandedScoreRow, setExpandedScoreRow] = useState(null);
  const [scoreHelpOpen, setScoreHelpOpen] = useState(false);

  const fetchCacheStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/cache-status");
      if (res.ok) {
        const data = await res.json();
        setCacheStatus(data);
      }
    } catch {}
  }, []);

  const fetchAll = useCallback(async () => {
    const endpoints = [
      fetch("/api/leads").then((r) => r.json()),
      fetch("/api/speed-to-lead").then((r) => r.json()),
      fetch("/api/action-queue").then((r) => r.json()),
      fetch(`/api/calls?days=${callDays}`).then((r) => r.json()),
      fetch("/api/conversions").then((r) => r.json()),
      fetch("/api/trends").then((r) => r.json()),
      fetch("/api/classifier-metrics").then((r) => r.json()),
    ];
    const [leadsRes, speedRes, queueRes, callsRes, convRes, trendsRes, classifierRes] =
      await Promise.allSettled(endpoints);

    if (leadsRes.status === "fulfilled") setLeads(leadsRes.value);
    if (speedRes.status === "fulfilled") setSpeedData(speedRes.value);
    if (queueRes.status === "fulfilled") setActionQueue(queueRes.value);
    if (callsRes.status === "fulfilled") setCallData(callsRes.value);
    if (convRes.status === "fulfilled") setConversionData(convRes.value);
    if (trendsRes.status === "fulfilled") setTrendsData(trendsRes.value);
    if (classifierRes.status === "fulfilled") setClassifierMetrics(classifierRes.value);
    setLastUpdated(new Date());
  }, [callDays]);

  useEffect(() => {
    fetchAll();
    fetchCacheStatus();
  }, [fetchAll, fetchCacheStatus]);

  // Poll cache status every 60s so "Last updated" stays current
  useEffect(() => {
    const interval = setInterval(fetchCacheStatus, 60000);
    return () => clearInterval(interval);
  }, [fetchCacheStatus]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      // Poll until the background refresh completes, then re-fetch dashboard data
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
        await fetchAll();
        await fetchCacheStatus();
        setRefreshing(false);
      };
      setTimeout(poll, 2000);
    } catch {
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
      // Fetch AI summary separately so it doesn't block the panel from opening
      fetch(`/api/lead-summary/${contactId}`)
        .then((r) => r.json())
        .then((s) => {
          if (s.aiSummary) {
            setLeadDetail((prev) => prev ? { ...prev, aiSummary: s.aiSummary } : prev);
          }
        })
        .catch(() => {});
    } catch {} finally {
      setLoadingDetail(false);
    }
  };

  // Global date window
  const windowStart = dateWindow === "all"
    ? new Date("2026-01-01T00:00:00.000Z")
    : new Date(Date.now() - parseInt(dateWindow, 10) * 24 * 60 * 60 * 1000);

  // Date-filtered base (all marinas)
  const dateFilteredLeads = (leads?.leads || []).filter(
    (l) => l.createDate && new Date(l.createDate) >= windowStart
  );

  // Summary calculations — filtered by summaryMarina + date window
  const summaryLeads = dateFilteredLeads.filter(
    (l) => summaryMarina === "all" || l.marina === summaryMarina
  );
  const totalLeads = summaryLeads.length;
  const sourceCallCount    = summaryLeads.filter((l) => l.leadSource === "Call").length;
  const sourceWalkInCount  = summaryLeads.filter((l) => l.leadSource === "Walk-in").length;
  const sourceFormCount    = summaryLeads.filter((l) => l.leadSource === "Web Form").length;
  const sourceDigitalCount = summaryLeads.filter((l) => !["Call","Walk-in","Web Form"].includes(l.leadSource)).length;
  const respondedCount = summaryLeads.filter((l) => l.responded).length;
  const respondedPct = totalLeads > 0 ? Math.round((respondedCount / totalLeads) * 100) : 0;
  const avgSpeedLeads = summaryLeads.filter((l) => l.speedToLeadBizMinutes !== null);
  const avgSpeed =
    avgSpeedLeads.length > 0
      ? avgSpeedLeads.reduce((s, l) => s + l.speedToLeadBizMinutes, 0) / avgSpeedLeads.length
      : null;

  // Action queue items — filter by date window + marina.
  // Anchor on the most recent lead-initiated activity (form fill, inbound
  // call, or original create date) so re-engaging leads stay visible in
  // recent windows even when the contact record itself is old.
  const filterByDateAndMarina = (arr) =>
    (arr || []).filter((i) => {
      if (summaryMarina !== "all" && i.marina !== summaryMarina) return false;
      const anchor = i.lastLeadActivityAt || i.createDate;
      if (anchor && new Date(anchor).getTime() < windowStart.getTime()) return false;
      return true;
    });
  const filteredMissedCalls = filterByDateAndMarina(actionQueue?.missedCalls);
  const filteredWaitingOnReply = filterByDateAndMarina(actionQueue?.waitingOnReply);
  const filteredNeverResponded = filterByDateAndMarina(actionQueue?.neverResponded);
  const filteredAllUnresponded = filterByDateAndMarina(actionQueue?.allUnresponded);
  const waitingCount = filteredMissedCalls.length + filteredWaitingOnReply.length;

  // Per-marina conversion rate (for calls breakdown table)
  const marinaConversionMap = {};
  for (const lead of (leads?.leads || [])) {
    if (!marinaConversionMap[lead.marina]) marinaConversionMap[lead.marina] = { total: 0, converted: 0 };
    marinaConversionMap[lead.marina].total += 1;
    if (lead.isCustomer) marinaConversionMap[lead.marina].converted += 1;
  }

  // Filtered marinas list
  const allMarinas = leads?.leads
    ? [...new Set(leads.leads.map((l) => l.marina))].sort()
    : [];
  // All Leads tab — its own independent date window
  const leadsWindowStart = leadsDateWindow === "all"
    ? new Date("2026-01-01T00:00:00.000Z")
    : leadsDateWindow === "apr1"
    ? new Date("2026-04-01T00:00:00.000Z")
    : new Date(Date.now() - parseInt(leadsDateWindow, 10) * 24 * 60 * 60 * 1000);

  // Sorted / filtered leads table (respects its own date window)
  // Date window is ignored when a name search is active so you can find anyone
  const nameSearchLower = nameSearch.trim().toLowerCase();
  const filteredLeads = (leads?.leads || []).filter((l) => {
    if (tableFilter.marina !== "all" && l.marina !== tableFilter.marina) return false;
    if (!nameSearchLower && l.createDate && new Date(l.createDate) < leadsWindowStart) return false;
    if (nameSearchLower && !(l.name || "").toLowerCase().includes(nameSearchLower)) return false;
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
            {cacheStatus?.cachedAt && (
              <span className="text-gray-400 text-xs hidden sm:block">
                {cacheStatus.isRefreshing
                  ? "Refreshing data..."
                  : `Data from ${timeAgo(cacheStatus.cachedAt)}`}
              </span>
            )}
            <Link
              href="/presentation"
              target="_blank"
              rel="noreferrer"
              className="border border-gold/50 hover:border-gold text-gold px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
              Present
            </Link>
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

        {/* Page-level Tab Navigation */}
        <div className="bg-white border-b shadow-sm">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 flex gap-0">
            {[
              { id: "overview", label: "Overview" },
              { id: "calls", label: "Calls by Property" },
              { id: "leads", label: "All Leads" },
              { id: "insights", label: "Insights" },
              { id: "trends", label: "Trends" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setPageTab(tab.id)}
                className={`px-6 py-3 text-sm font-semibold border-b-2 transition-colors ${
                  pageTab === tab.id
                    ? "border-gold text-navy"
                    : "border-transparent text-gray-500 hover:text-navy hover:border-gray-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">

          {/* ── OVERVIEW TAB ──────────────────────────────── */}
          {pageTab === "overview" && (<>
          {/* Summary Bar */}
          {!leads?.leads ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <LoadingSkeleton key={i} height="h-24" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Property:</span>
                  <select
                    value={summaryMarina}
                    onChange={(e) => setSummaryMarina(e.target.value)}
                    className="text-sm border rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-gold focus:outline-none bg-white"
                  >
                    <option value="all">All Properties</option>
                    {allMarinas.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Period:</span>
                  <div className="flex gap-1">
                    {[["7","Last 7d"],["30","Last 30d"],["90","Last 90d"],["all","All 2026"]].map(([v, label]) => (
                      <button
                        key={v}
                        onClick={() => setDateWindow(v)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          dateWindow === v
                            ? "bg-navy text-white border-navy"
                            : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Total Leads with source breakdown */}
                <div className="bg-white rounded-xl shadow-sm border p-5">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
                    {summaryMarina === "all" ? "Total Leads" : `${summaryMarina} — Leads`}
                  </p>
                  <p className="text-2xl font-bold mt-1 text-navy">{totalLeads}</p>
                  <p className="text-xs text-gray-400 mt-1">{dateWindow === "all" ? "Since Jan 1" : `Last ${dateWindow} days`}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-navy/10 text-navy">
                      📞 {sourceCallCount}
                    </span>
                    {sourceWalkInCount > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-teal-50 text-teal-700">
                        🚶 {sourceWalkInCount}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gold/10 text-yellow-700">
                      📋 {sourceFormCount}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600">
                      🌐 {sourceDigitalCount}
                    </span>
                  </div>
                </div>
                <StatCard label="Responded" value={`${respondedPct}%`} sub={`${respondedCount} of ${totalLeads}`} />
                <StatCard label="Avg Speed to Lead" value={formatSpeedToLead(avgSpeed)} sub="business hours" />
                <StatCard
                  label="Waiting Now"
                  value={waitingCount}
                  highlight={waitingCount > 0}
                />
              </div>
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
                  count={filteredMissedCalls.length}
                  color="red"
                />
                <TabButton
                  active={activeTab === "waiting"}
                  onClick={() => setActiveTab("waiting")}
                  label="Waiting on Reply"
                  count={filteredWaitingOnReply.length}
                  color="orange"
                />
                <TabButton
                  active={activeTab === "never"}
                  onClick={() => setActiveTab("never")}
                  label="Never Responded"
                  count={filteredNeverResponded.length}
                  color="yellow"
                />
                <TabButton
                  active={activeTab === "unresponded"}
                  onClick={() => setActiveTab("unresponded")}
                  label="All Unresponded"
                  count={filteredAllUnresponded.length}
                  color="red"
                />
              </div>
              <div className="overflow-x-auto">
                {activeTab === "missed" && (
                  <ActionTable
                    items={filteredMissedCalls}
                    columns={["Lead", "Marina", "Missed Call Time", "Attempts", "Phone", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-red-50/30">
                        <td className="px-4 py-3 font-medium text-sm">
                          {item.name}
                          {item.recentFormDate && (() => { const d = Math.floor((Date.now()-new Date(item.recentFormDate))/86400000); return <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium ${d<=7?"bg-emerald-100 text-emerald-700":"bg-blue-50 text-blue-700"}`} title={item.recentFormName||"Form submission"}>📋 {d===0?"Today":`${d}d ago`}</span>; })()}
                        </td>
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
                    items={filteredWaitingOnReply}
                    columns={["Lead", "Marina", "Waiting Since", "Last Inbound", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-orange-50/30">
                        <td className="px-4 py-3 font-medium text-sm">
                          {item.name}
                          {item.recentFormDate && (() => { const d = Math.floor((Date.now()-new Date(item.recentFormDate))/86400000); return <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium ${d<=7?"bg-emerald-100 text-emerald-700":"bg-blue-50 text-blue-700"}`} title={item.recentFormName||"Form submission"}>📋 {d===0?"Today":`${d}d ago`}</span>; })()}
                        </td>
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
                    items={filteredNeverResponded}
                    columns={["Lead", "Marina", "Time Since Created", ""]}
                    renderRow={(item) => (
                      <tr key={item.contactId} className="border-b hover:bg-yellow-50/30">
                        <td className="px-4 py-3 font-medium text-sm">
                          {item.name}
                          {item.recentFormDate && (() => { const d = Math.floor((Date.now()-new Date(item.recentFormDate))/86400000); return <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium ${d<=7?"bg-emerald-100 text-emerald-700":"bg-blue-50 text-blue-700"}`} title={item.recentFormName||"Form submission"}>📋 {d===0?"Today":`${d}d ago`}</span>; })()}
                        </td>
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
                {activeTab === "unresponded" && (
                  <div>
                    {/* Urgency legend */}
                    <div className="flex items-center gap-4 px-4 py-2 bg-gray-50 border-b text-xs text-gray-500">
                      <span className="font-medium text-gray-600">Urgency:</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-red-500"></span> Over 24h</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-orange-400"></span> 4–24h</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-yellow-400"></span> 1–4h</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-gray-200"></span> Under 1h</span>
                    </div>
                    <ActionTable
                      items={filteredAllUnresponded}
                      columns={["Lead", "Marina", "Waiting Since", "Signals", "Phone", ""]}
                      renderRow={(item) => (
                        <tr key={item.contactId} className={urgencyRowStyle(item.urgency)}>
                          <td className="px-4 py-3 font-medium text-sm">
                            {item.name}
                            {item.hasMissedInbound && (
                              <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs">Missed Call</span>
                            )}
                            {item.waitingOnReply && !item.hasMissedInbound && (
                              <span className="ml-2 px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-xs">Awaiting Reply</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">{item.marina}</td>
                          <td className={`px-4 py-3 text-sm ${urgencyAgeStyle(item.urgency)}`}>
                            {timeAgo(item.createDate)}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {item.recentFormDate && (() => {
                              const daysSince = Math.floor((Date.now() - new Date(item.recentFormDate)) / 86400000);
                              const isNew = daysSince <= 7;
                              return (
                                <span className={`mr-2 inline-block px-1.5 py-0.5 rounded font-medium ${isNew ? "bg-emerald-100 text-emerald-700" : "bg-blue-50 text-blue-700"}`}
                                  title={item.recentFormName || "Form submission"}>
                                  📋 Form {daysSince === 0 ? "today" : `${daysSince}d ago`}
                                </span>
                              );
                            })()}
                            {item.emailsSent > 0 && <span className="mr-2">{item.emailsSent} email{item.emailsSent !== 1 ? "s" : ""}</span>}
                            {item.callsOutbound > 0 && <span>{item.callsOutbound} call attempt{item.callsOutbound !== 1 ? "s" : ""}</span>}
                            {!item.recentFormDate && !item.emailsSent && !item.callsOutbound && <span className="italic">No outreach yet</span>}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {item.phone ? (
                              <a href={`tel:${item.phone}`} className="text-blue-600 hover:underline font-medium">
                                {item.phone}
                              </a>
                            ) : "--"}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <a href={item.hubspotUrl} target="_blank" rel="noreferrer" className="text-gold hover:underline text-xs font-medium whitespace-nowrap">
                              Open in HubSpot
                            </a>
                          </td>
                        </tr>
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Lead Sources */}
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold text-navy">Lead Sources</h2>
                <p className="text-xs text-gray-400 mt-0.5">CRM-entered contacts (calls, walk-ins) included. Excludes Power Automate &amp; bulk imports.</p>
              </div>
              <div className="flex gap-1">
                {[["property","By Property"],["source","By Source"]].map(([v,label]) => (
                  <button key={v} onClick={() => setSourceChartView(v)}
                    className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${sourceChartView === v ? "bg-navy text-white border-navy" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!leads?.leads ? (
              <LoadingSkeleton height="h-64" />
            ) : sourceChartView === "property" ? (() => {
              const sourceMap = {};
              for (const lead of dateFilteredLeads) {
                if (lead.marina === "Unknown") continue;
                if (summaryMarina !== "all" && lead.marina !== summaryMarina) continue;
                if (!sourceMap[lead.marina]) sourceMap[lead.marina] = { Call: 0, "Walk-in": 0, "Web Form": 0, Digital: 0 };
                const bucket = lead.leadSource === "Call" ? "Call"
                  : lead.leadSource === "Walk-in" ? "Walk-in"
                  : lead.leadSource === "Web Form" ? "Web Form"
                  : "Digital";
                sourceMap[lead.marina][bucket]++;
              }
              const chartData = Object.entries(sourceMap)
                .map(([marina, counts]) => ({
                  marina, ...counts,
                  total: (counts.Call||0) + (counts["Walk-in"]||0) + (counts["Web Form"]||0) + (counts.Digital||0)
                }))
                .sort((a, b) => b.total - a.total);
              return (
                <ResponsiveContainer width="100%" height={Math.max(280, chartData.length * 36)}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 16, right: 48, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="marina" tick={{ fontSize: 12 }} width={110} />
                    <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                    <Legend verticalAlign="top" />
                    <Bar dataKey="Call" name="Call" stackId="a" fill="#0c2340" radius={[0,0,0,0]} />
                    <Bar dataKey="Walk-in" name="Walk-in" stackId="a" fill="#0f766e" radius={[0,0,0,0]} />
                    <Bar dataKey="Web Form" name="Web Form" stackId="a" fill="#c4933f" radius={[0,0,0,0]} />
                    <Bar dataKey="Digital" name="Digital / Other" stackId="a" fill="#60a5fa" radius={[0,4,4,0]} label={{ position: "right", fontSize: 11, formatter: (v, entry) => entry?.payload?.total }} />
                  </BarChart>
                </ResponsiveContainer>
              );
            })() : (() => {
              // By Source — group by hsSource across the marina filter (date-filtered)
              const COLORS = {
                "Call": "#0c2340",
                "Phone Call": "#0c2340",
                "Walk-in": "#0f766e",
                "Walk-In": "#0f766e",
                "Referral": "#2dd4bf",
                "Web Form": "#c4933f",
                "Paid Search (Form)": "#f59e0b",
                "Organic Search (Form)": "#10b981",
                "Social (Form)": "#8b5cf6",
                "Direct (Form)": "#06b6d4",
                "Referral (Form)": "#14b8a6",
                "Paid Search": "#fbbf24",
                "Organic Search": "#34d399",
                "Social Media": "#a78bfa",
                "Direct Traffic": "#67e8f9",
                "Email": "#f472b6",
              };
              const counts = {};
              for (const lead of dateFilteredLeads) {
                if (lead.marina === "Unknown") continue;
                if (summaryMarina !== "all" && lead.marina !== summaryMarina) continue;
                const src = lead.hsSource || "Unknown";
                counts[src] = (counts[src] || 0) + 1;
              }
              const total = Object.values(counts).reduce((s, v) => s + v, 0);
              const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
              return (
                <div className="space-y-2 mt-2">
                  {rows.map(([src, cnt]) => {
                    const pct = total ? Math.round((cnt / total) * 100) : 0;
                    const color = COLORS[src] || "#94a3b8";
                    return (
                      <div key={src} className="flex items-center gap-3">
                        <div className="w-36 text-xs text-gray-600 text-right shrink-0">{src}</div>
                        <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                          <div className="h-4 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color, minWidth: cnt > 0 ? "2px" : 0 }} />
                        </div>
                        <div className="w-16 text-xs text-gray-700 font-medium">{cnt} <span className="text-gray-400">({pct}%)</span></div>
                      </div>
                    );
                  })}
                  <p className="text-xs text-gray-400 pt-2">Total: {total} leads</p>
                </div>
              );
            })()}
          </div>

          {/* Conversions Panel */}
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="px-6 py-4 border-b flex items-center gap-3 flex-wrap">
              <h2 className="text-lg font-semibold text-navy mr-auto">Conversions</h2>
              <span className="text-xs text-gray-400">
                {dateWindow === "all" ? "All 2026" : `Last ${dateWindow} days`}
                {summaryMarina !== "all" ? ` · ${summaryMarina}` : ""}
              </span>
            </div>
            {!conversionData ? (
              <div className="p-6"><LoadingSkeleton height="h-32" /></div>
            ) : (() => {
              const allConvLeads = summaryMarina === "all"
                ? (conversionData.leads || [])
                : (conversionData.leads || []).filter((l) => l.marina === summaryMarina);
              const convLeads = dateWindow === "all"
                ? allConvLeads
                : allConvLeads.filter((l) => l.convertedAt && new Date(l.convertedAt) >= windowStart);
              const withDays = convLeads.filter((l) => l.daysToConvert !== null);
              const convAvgDays = withDays.length > 0 ? Math.round(withDays.reduce((s, l) => s + l.daysToConvert, 0) / withDays.length) : null;
              const convFastest = withDays.length > 0 ? Math.min(...withDays.map((l) => l.daysToConvert)) : null;

              // Build monthly trend data (filtered to same window)
              const monthMap = {};
              for (const l of convLeads) {
                if (!l.convertedAt) continue;
                const d = new Date(l.convertedAt);
                const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
                const label = d.toLocaleString("en-US",{month:"short",year:"2-digit"});
                if (!monthMap[key]) monthMap[key] = { key, label, count: 0 };
                monthMap[key].count++;
              }
              const trendData = Object.values(monthMap).sort((a,b)=>a.key.localeCompare(b.key));

              return (
              <div>
                {/* KPI cards */}
                <div className="grid grid-cols-3 divide-x border-b">
                  <div className="px-6 py-4 text-center">
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">Total Converted</p>
                    <p className="text-3xl font-bold text-emerald-600">{convLeads.length}</p>
                  </div>
                  <div className="px-6 py-4 text-center">
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">Avg Days to Convert</p>
                    <p className="text-3xl font-bold text-navy">
                      {convAvgDays !== null ? `${convAvgDays}d` : "--"}
                    </p>
                  </div>
                  <div className="px-6 py-4 text-center">
                    <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">Fastest Conversion</p>
                    <p className="text-3xl font-bold text-gold">
                      {convFastest !== null ? `${convFastest}d` : "--"}
                    </p>
                  </div>
                </div>
                {/* Conversions over time trend */}
                {trendData.length > 0 && (
                  <div className="px-6 pt-4 pb-2 border-b">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Conversions Over Time</p>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={trendData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={24} />
                        <Tooltip formatter={(v) => [v, "Conversions"]} />
                        <Bar dataKey="count" name="Conversions" fill="#16a34a" radius={[3,3,0,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {/* Converted leads table */}
                {convLeads.length > 0 ? (
                  <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Name</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Marina</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Source</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Created</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Converted</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Days to Convert</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {convLeads.map((lead) => (
                          <tr key={lead.contactId} className="border-b hover:bg-emerald-50/30">
                            <td className="px-4 py-3 text-sm font-medium">
                              {lead.name}
                              <span className="ml-2 px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-xs font-medium">Converted</span>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">{lead.marina}</td>
                            <td className="px-4 py-3 text-sm">
                              {lead.leadSource === "Call" ? (
                                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-navy/10 text-navy">📞 Call</span>
                              ) : lead.leadSource === "Web Form" ? (
                                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gold/10 text-gold">📋 Web Form</span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600">{lead.leadSource || "Digital"}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-500">
                              {lead.createDate ? new Date(lead.createDate).toLocaleDateString() : "--"}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-500">
                              {lead.convertedAt ? new Date(lead.convertedAt).toLocaleDateString() : "--"}
                            </td>
                            <td className="px-4 py-3 text-sm font-semibold text-emerald-600">
                              {lead.daysToConvert !== null ? `${lead.daysToConvert}d` : "--"}
                            </td>
                            <td className="px-4 py-3 text-sm">
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
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="px-6 py-6 text-center text-gray-400 text-sm">
                    No conversions yet in the tracked period
                  </div>
                )}
              </div>
              );
            })()}
          </div>

          </>)}

          {/* ── CALLS TAB ──────────────────────────────── */}
          {pageTab === "calls" && (<>
            {/* KPI Summary */}
            {!callData?.marinaStats ? (
              <div className="grid grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => <LoadingSkeleton key={i} height="h-24" />)}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Total Inbound"
                  value={Object.values(callData.marinaStats).reduce((s, m) => s + m.totalInbound, 0)}
                />
                <StatCard
                  label="Total Outbound"
                  value={Object.values(callData.marinaStats).reduce((s, m) => s + m.totalOutbound, 0)}
                />
                <StatCard
                  label="Outbound Connected"
                  value={`${Math.round(
                    (Object.values(callData.marinaStats).reduce((s, m) => s + (m.connectedRate * m.totalOutbound / 100), 0) /
                    Math.max(1, Object.values(callData.marinaStats).reduce((s, m) => s + m.totalOutbound, 0))) * 100
                  )}%`}
                  sub="connection rate"
                />
                <div className="bg-white rounded-xl shadow-sm border p-5 flex flex-wrap items-center justify-end gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Property:</span>
                    <select
                      value={callsMarinaFilter}
                      onChange={(e) => setCallsMarinaFilter(e.target.value)}
                      className="text-sm border rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-gold focus:outline-none"
                    >
                      <option value="all">All Properties</option>
                      {(callData?.marinas || []).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Period:</span>
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
                </div>
              </div>
            )}

            {/* Bar Chart */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <h2 className="text-lg font-semibold text-navy mb-4">Inbound vs Outbound by Property</h2>
              {!callData?.chartData ? (
                <LoadingSkeleton height="h-72" />
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={callData.chartData.filter(d => callsMarinaFilter === "all" || d.marina === callsMarinaFilter)} margin={{ bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="marina" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" height={70} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend verticalAlign="top" />
                    <Bar dataKey="inbound" fill="#c4933f" name="Inbound" radius={[3,3,0,0]} />
                    <Bar dataKey="outbound" fill="#0c2340" name="Outbound" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Detail Table by Property */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">Breakdown by Property</h2>
              </div>
              {!callData?.marinas ? (
                <div className="p-6"><LoadingSkeleton height="h-48" /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase">Property</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Total Leads</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Conv %</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Inbound</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Outbound</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Connected Rate</th>
                        <th className="px-5 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Avg Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {callData.marinas
                        .filter((marina) => callsMarinaFilter === "all" || marina === callsMarinaFilter)
                        .map((marina) => ({ marina, ...callData.marinaStats[marina] }))
                        .sort((a, b) => (b.totalInbound + b.totalOutbound) - (a.totalInbound + a.totalOutbound))
                        .map((row) => (
                          <tr key={row.marina} className="border-b hover:bg-gray-50/50">
                            <td className="px-5 py-3 text-sm font-medium">{row.marina}</td>
                            <td className="px-5 py-3 text-sm text-center text-gray-600">
                              {marinaConversionMap[row.marina]?.total ?? "--"}
                            </td>
                            <td className="px-5 py-3 text-sm text-center">
                              {(() => {
                                const m = marinaConversionMap[row.marina];
                                if (!m || m.total === 0) return <span className="text-gray-400">--</span>;
                                const pct = Math.round((m.converted / m.total) * 100);
                                return (
                                  <span className={`font-semibold ${pct >= 20 ? "text-emerald-600" : pct >= 10 ? "text-yellow-600" : "text-gray-500"}`}>
                                    {pct}%
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-5 py-3 text-sm text-center">
                              <span className="font-semibold text-gold">{row.totalInbound}</span>
                            </td>
                            <td className="px-5 py-3 text-sm text-center">
                              <span className="font-semibold text-navy">{row.totalOutbound}</span>
                            </td>
                            <td className="px-5 py-3 text-sm text-center">
                              <span className={`font-semibold ${row.connectedRate >= 40 ? "text-green-600" : row.connectedRate >= 20 ? "text-yellow-600" : "text-red-500"}`}>
                                {row.connectedRate}%
                              </span>
                            </td>
                            <td className="px-5 py-3 text-sm text-center text-gray-500">{row.avgDurationFormatted}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {/* Recent Calls Log */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-semibold text-navy">Recent Calls Log</h2>
                <p className="text-xs text-gray-400 mt-0.5">Most recent calls first · showing up to 60 per property</p>
              </div>
              {!callData?.marinaStats ? (
                <div className="p-6"><LoadingSkeleton height="h-48" /></div>
              ) : (() => {
                const allCalls = Object.values(callData.marinaStats)
                  .filter(m => callsMarinaFilter === "all" || m.marina === callsMarinaFilter)
                  .flatMap(m => (m.recentCalls || []).map(c => ({ ...c, marina: m.marina })))
                  .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                  .slice(0, 100);
                if (allCalls.length === 0) return <p className="px-6 py-8 text-center text-sm text-gray-400">No calls in this period.</p>;
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">When</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Rep</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Lead</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Closed</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Property</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Direction</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Outcome</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Duration</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {allCalls.map((call, i) => (
                          <tr key={i} className="hover:bg-gray-50/50">
                            <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{new Date(call.timestamp).toLocaleDateString()} {new Date(call.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                            <td className="px-4 py-2.5 text-xs font-medium text-indigo-700 whitespace-nowrap">{call.repName || "—"}</td>
                            <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap">
                              {call.hubspotUrl ? (
                                <a href={call.hubspotUrl} target="_blank" rel="noreferrer" className="text-gold hover:underline">{call.leadName}</a>
                              ) : call.leadName}
                            </td>
                            <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                              {call.isClosed
                                ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">✓ Closed</span>
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{call.marina}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                call.direction === "INBOUND" ? "bg-amber-100 text-amber-800" : "bg-navy/10 text-navy"
                              }`}>{call.direction}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                call.disposition === "Connected" ? "bg-green-100 text-green-800"
                                : call.disposition === "Left Voicemail" ? "bg-blue-100 text-blue-800"
                                : call.disposition === "No Answer" ? "bg-red-100 text-red-700"
                                : "bg-gray-100 text-gray-600"
                              }`}>{call.disposition || "Unknown"}</span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{call.duration || "—"}</td>
                            <td className="px-4 py-2.5 text-xs text-gray-400 max-w-xs truncate">{call.notes || ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

          </>)}

          {/* ── LEADS TAB ──────────────────────────────── */}
          {pageTab === "leads" && (<>
            {/* Speed to Lead Chart — horizontal bar per marina */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-navy">Avg Speed to Lead by Property</h2>
                <p className="text-xs text-gray-400 mt-0.5">Business hours (9am–5pm, 7 days/week, marina timezone) · fastest to slowest · window: {dateWindow === "all" ? "All 2026" : `Last ${dateWindow} days`}</p>
              </div>
              {!leads?.leads ? (
                <LoadingSkeleton height="h-64" />
              ) : (() => {
                const map = {};
                for (const l of dateFilteredLeads) {
                  if (!l.marina || l.marina === "Unknown") continue;
                  if (l.speedToLeadBizMinutes === null || l.speedToLeadBizMinutes === undefined) continue;
                  if (!map[l.marina]) map[l.marina] = { sum: 0, count: 0 };
                  map[l.marina].sum += l.speedToLeadBizMinutes;
                  map[l.marina].count += 1;
                }
                const windowSummary = Object.entries(map)
                  .map(([marina, { sum, count }]) => ({
                    marina,
                    avgBizMinutes: Math.round(sum / count),
                    respondedCount: count,
                  }))
                  .sort((a, b) => a.avgBizMinutes - b.avgBizMinutes);

                if (windowSummary.length === 0) {
                  return <div className="text-sm text-gray-400 italic py-8 text-center">No responded leads in this window.</div>;
                }

                return (
                <ResponsiveContainer width="100%" height={Math.max(280, windowSummary.length * 36)}>
                  <BarChart
                    data={windowSummary}
                    layout="vertical"
                    margin={{ left: 16, right: 48, top: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => formatSpeedToLead(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="marina"
                      tick={{ fontSize: 12 }}
                      width={110}
                    />
                    <Tooltip
                      formatter={(value) => [formatSpeedToLead(value), "Avg Speed to Lead"]}
                      cursor={{ fill: "rgba(0,0,0,0.04)" }}
                    />
                    <Bar dataKey="avgBizMinutes" radius={[0, 4, 4, 0]} label={{ position: "right", fontSize: 11, formatter: (v) => formatSpeedToLead(v) }}>
                      {windowSummary.map((entry) => (
                        <Cell
                          key={entry.marina}
                          fill={
                            entry.avgBizMinutes < 60
                              ? "#16a34a"
                              : entry.avgBizMinutes <= 240
                              ? "#ca8a04"
                              : "#dc2626"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                );
              })()}
              {leads?.leads && (
                <div className="flex items-center gap-5 mt-3 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-green-600"></span>Under 1 hour</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-yellow-600"></span>1–4 hours</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-red-600"></span>Over 4 hours</span>
                </div>
              )}
            </div>

            {/* Leads Table — activity for each lead is shown in its expanded row */}
            <div>
              <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="px-6 py-4 border-b flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold text-navy mr-auto">All Leads</h2>
                  <div className="flex gap-1">
                    {[["7","Last 7d"],["30","Last 30d"],["90","Last 90d"],["apr1","Since Apr 1"],["all","All 2026"]].map(([v,label]) => (
                      <button key={v} onClick={() => setLeadsDateWindow(v)}
                        className={`px-2.5 py-1.5 rounded text-xs font-medium border transition-colors ${leadsDateWindow === v ? "bg-navy text-white border-navy" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Name search */}
                  <div className="relative">
                    <svg className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                    </svg>
                    <input
                      type="text"
                      placeholder="Search name..."
                      value={nameSearch}
                      onChange={(e) => setNameSearch(e.target.value)}
                      className="text-xs border rounded pl-6 pr-2 py-1 w-36 focus:outline-none focus:ring-1 focus:ring-navy/40"
                    />
                    {nameSearch && (
                      <button onClick={() => setNameSearch("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                      </button>
                    )}
                  </div>
                  {/* Property filter */}
                  <select
                    value={tableFilter.marina}
                    onChange={(e) => setTableFilter((f) => ({ ...f, marina: e.target.value }))}
                    className="text-xs border rounded px-2 py-1"
                  >
                    <option value="all">All Properties</option>
                    {allMarinas.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <span className="text-xs text-gray-400">{filteredLeads.length} leads</span>
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
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Type</th>
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
                            <td className={`px-4 py-3 text-sm font-semibold ${speedToLeadColor(lead.speedToLeadBizMinutes ?? lead.speedToLeadMinutes)}`}>
                              {lead.speedToLeadBizFormatted || lead.speedToLeadFormatted}
                              {lead.speedToLeadBizMinutes !== null && lead.speedToLeadBizMinutes !== undefined && (
                                <span className="ml-1 text-xs font-normal text-gray-400">biz</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {(() => {
                                const src = lead.leadSource;
                                if (src === "Call") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-navy/10 text-navy whitespace-nowrap">📞 Call</span>;
                                if (src === "Walk-in") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800 whitespace-nowrap">🚶 Walk-in</span>;
                                if (src === "Web Form") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 whitespace-nowrap">📋 Web Form</span>;
                                return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 whitespace-nowrap">🌐 Digital</span>;
                              })()}
                            </td>
                            <td className="px-4 py-3">
                              <StatusBadge status={lead.status} />
                              {lead.isCustomer && lead.convertedAt && (
                                <div className="text-xs text-emerald-600 mt-0.5 whitespace-nowrap">
                                  {new Date(lead.convertedAt).toLocaleDateString()}
                                  {lead.daysToConvert !== null && (
                                    <span className="ml-1 font-medium">· {lead.daysToConvert}d</span>
                                  )}
                                </div>
                              )}
                            </td>
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
                              <td colSpan={10} className="bg-gray-50 px-0 py-0">
                                <LeadDetailPanel detail={leadDetail} loading={loadingDetail} />
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        ))}
                        {sortedLeads.length === 0 && (
                          <tr>
                            <td colSpan={10} className="px-4 py-8 text-center text-gray-400 text-sm">
                              No leads found
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

            </div>
          </>)}

          {/* ── INSIGHTS TAB ────────────────────────────── */}
          {pageTab === "insights" && (<>

            {/* AI Classifier Monitoring */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-navy">Reply Classifier Activity</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    How often the keyword + AI filter ran and what it decided
                    {classifierMetrics?.startedAt
                      ? ` · since ${new Date(classifierMetrics.startedAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <a
                  href="/api/classifier-metrics?format=csv"
                  className="text-xs text-blue-600 hover:underline"
                >
                  Download recent decisions (CSV)
                </a>
              </div>
              {!classifierMetrics ? (
                <div className="p-6"><LoadingSkeleton height="h-32" /></div>
              ) : classifierMetrics.total === 0 ? (
                <div className="p-6 text-sm text-gray-500">
                  No inbound replies have been classified yet. Once new email replies come in, this card will start tracking how the keyword and AI filter is being used.
                </div>
              ) : (
                <div className="p-6 space-y-6">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 uppercase">Total evaluations</div>
                      <div className="text-2xl font-bold text-navy mt-1">{classifierMetrics.total}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{classifierMetrics.cacheHits} cache reuse · {classifierMetrics.freshClassifications} fresh runs</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 uppercase">Keyword</div>
                      <div className="text-2xl font-bold text-emerald-600 mt-1">{classifierMetrics.pctByInvocation.keyword}%</div>
                      <div className="text-xs text-gray-400 mt-0.5">{classifierMetrics.invocations.keyword} of fresh runs</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 uppercase">AI</div>
                      <div className="text-2xl font-bold text-indigo-600 mt-1">{classifierMetrics.pctByInvocation.ai}%</div>
                      <div className="text-xs text-gray-400 mt-0.5">{classifierMetrics.invocations.ai} of fresh runs</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="text-xs text-gray-500 uppercase">Fallback</div>
                      <div className="text-2xl font-bold text-gray-600 mt-1">{classifierMetrics.pctByInvocation.fallback}%</div>
                      <div className="text-xs text-gray-400 mt-0.5">{classifierMetrics.invocations.fallback} of fresh runs</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="border rounded-lg p-4">
                      <div className="text-sm font-semibold text-navy mb-2">Outcome split</div>
                      <div className="flex items-center gap-3 text-sm">
                        <div className="flex-1">
                          <div className="flex justify-between mb-1">
                            <span className="text-gray-600">Acknowledgment (filtered out)</span>
                            <span className="font-medium">{classifierMetrics.pctByOutcome.acknowledgment}% · {classifierMetrics.byOutcome.acknowledgment}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded">
                            <div className="h-2 bg-emerald-500 rounded" style={{ width: `${classifierMetrics.pctByOutcome.acknowledgment}%` }} />
                          </div>
                          <div className="flex justify-between mt-3 mb-1">
                            <span className="text-gray-600">Needs response (kept in queue)</span>
                            <span className="font-medium">{classifierMetrics.pctByOutcome.needs_response}% · {classifierMetrics.byOutcome.needs_response}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded">
                            <div className="h-2 bg-orange-500 rounded" style={{ width: `${classifierMetrics.pctByOutcome.needs_response}%` }} />
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="border rounded-lg p-4">
                      <div className="text-sm font-semibold text-navy mb-2">Top acknowledgment triggers</div>
                      {classifierMetrics.topAckPhrases.length === 0 ? (
                        <div className="text-xs text-gray-400">No acknowledgments yet.</div>
                      ) : (
                        <ul className="text-sm space-y-1">
                          {classifierMetrics.topAckPhrases.map((p, i) => (
                            <li key={`${p.source}-${p.phrase}-${i}`} className="flex justify-between items-center gap-2">
                              <span className="flex items-center gap-2 min-w-0">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                                  p.source === "ai" ? "bg-indigo-100 text-indigo-700" : "bg-emerald-100 text-emerald-700"
                                }`}>{p.source}</span>
                                <span className="text-gray-700 font-mono text-xs truncate" title={p.phrase}>{p.phrase}</span>
                              </span>
                              <span className="text-gray-500">{p.count}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-navy mb-2">Recent decisions</div>
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-xs font-semibold text-gray-600 uppercase">When</th>
                            <th className="px-3 py-2 text-xs font-semibold text-gray-600 uppercase">Reason</th>
                            <th className="px-3 py-2 text-xs font-semibold text-gray-600 uppercase">Decision</th>
                            <th className="px-3 py-2 text-xs font-semibold text-gray-600 uppercase">Label</th>
                            <th className="px-3 py-2 text-xs font-semibold text-gray-600 uppercase">Inbound preview</th>
                          </tr>
                        </thead>
                        <tbody>
                          {classifierMetrics.recent.slice(0, 20).map((r, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{timeAgo(r.at)}</td>
                              <td className="px-3 py-2 text-xs">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  r.source === "ai" ? "bg-indigo-100 text-indigo-700" :
                                  r.source === "keyword" ? "bg-emerald-100 text-emerald-700" :
                                  r.source === "cache" ? "bg-gray-100 text-gray-600" :
                                  "bg-yellow-100 text-yellow-700"
                                }`}>
                                  {r.source}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-xs">
                                {r.needsResponse ? (
                                  <span className="text-orange-700 font-medium">Needs response</span>
                                ) : (
                                  <span className="text-emerald-700 font-medium">Acknowledgment</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs font-mono text-gray-600">
                                {r.matchedPhrase ? r.matchedPhrase : (r.label || "--")}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-700 max-w-md truncate" title={r.preview}>{r.preview || <span className="text-gray-400">(no body)</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Property Job Score */}
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="px-6 py-4 border-b flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-navy">Property Job Score</h2>
                  <p className="text-xs text-gray-400 mt-0.5">One number per property — are reps doing the job? Click a row to see the four signals behind the score. Window: {dateWindow === "all" ? "All 2026" : `Last ${dateWindow} days`}.</p>
                </div>
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setScoreHelpOpen(v => !v)}
                    className="text-xs text-blue-600 hover:text-blue-800 underline whitespace-nowrap"
                  >
                    How this is scored
                  </button>
                  {scoreHelpOpen && (
                    <div className="absolute right-0 top-6 z-20 w-80 bg-white border rounded-lg shadow-lg p-4 text-xs text-gray-700">
                      <div className="font-semibold text-navy mb-2">Job Score = weighted blend of four signals</div>
                      <ul className="space-y-1.5">
                        <li><span className="font-semibold">{Math.round(JOB_SCORE_WEIGHTS.resp * 100)}% Response rate</span> — leads with any rep reply. Full credit at ≥{JOB_SCORE_THRESHOLDS.resp.greenAtPct}%, zero at ≤{JOB_SCORE_THRESHOLDS.resp.redAtPct}%.</li>
                        <li><span className="font-semibold">{Math.round(JOB_SCORE_WEIGHTS.speed * 100)}% Speed to lead</span> — average first reply, business hours. Full credit at ≤{JOB_SCORE_THRESHOLDS.speedBizMins.greenAtMins}m, zero at ≥{JOB_SCORE_THRESHOLDS.speedBizMins.redAtMins}m.</li>
                        <li><span className="font-semibold">{Math.round(JOB_SCORE_WEIGHTS.callCov * 100)}% Call coverage</span> — leads with at least one call attempt. Full credit at ≥{JOB_SCORE_THRESHOLDS.callCov.greenAtPct}%, zero at ≤{JOB_SCORE_THRESHOLDS.callCov.redAtPct}%.</li>
                        <li><span className="font-semibold">{Math.round(JOB_SCORE_WEIGHTS.noteCov * 100)}% Note coverage</span> — logged calls that have notes. Full credit at ≥{JOB_SCORE_THRESHOLDS.noteCov.greenAtPct}%, zero at ≤{JOB_SCORE_THRESHOLDS.noteCov.redAtPct}%.</li>
                      </ul>
                      <div className="mt-3 text-gray-500">Each signal scales linearly between those thresholds. Properties with fewer than {JOB_SCORE_MIN_LEADS} leads in the window show "—" instead of a score. Conversion is shown separately as an outcome — it's not part of the score.</div>
                      <button onClick={() => setScoreHelpOpen(false)} className="mt-3 text-blue-600 hover:underline">Close</button>
                    </div>
                  )}
                </div>
              </div>
              {!leads?.leads ? (
                <div className="p-6"><LoadingSkeleton height="h-48" /></div>
              ) : (() => {
                const W = JOB_SCORE_WEIGHTS;

                const convMap = {};
                for (const l of (conversionData?.leads || [])) {
                  if (!convMap[l.marina]) convMap[l.marina] = 0;
                  convMap[l.marina]++;
                }

                const rows = allMarinas
                  .filter(m => m !== "Unknown")
                  .map(m => {
                    const mLeads = dateFilteredLeads.filter(l => l.marina === m);
                    if (mLeads.length === 0) return null;

                    const raw = computePropertyRawSignals(mLeads);
                    const { jobScore, belowMinLeads, sub } = computeJobScore(raw);

                    const convTotal = (leads?.leads || []).filter(l => l.marina === m).length;
                    const convCount = convMap[m] || 0;
                    const convPct = convTotal > 0 ? Math.round((convCount / convTotal) * 100) : null;

                    return { m, ...raw, convPct, jobScore, belowMinLeads, sub };
                  })
                  .filter(Boolean)
                  .sort((a, b) => {
                    // Worst first; nulls (insufficient data) sink to bottom
                    const av = a.jobScore === null ? 9999 : a.jobScore;
                    const bv = b.jobScore === null ? 9999 : b.jobScore;
                    return av - bv;
                  });

                const colorFor = (score) => {
                  if (score === null || score === undefined) return { bg: "bg-gray-100", text: "text-gray-400", bar: "bg-gray-300" };
                  if (score >= 75) return { bg: "bg-emerald-100", text: "text-emerald-700", bar: "bg-emerald-500" };
                  if (score >= 50) return { bg: "bg-yellow-100", text: "text-yellow-700", bar: "bg-yellow-400" };
                  return { bg: "bg-red-100", text: "text-red-600", bar: "bg-red-500" };
                };

                const ScoreBadge = ({ score, belowMin }) => {
                  if (belowMin || score === null) {
                    return (
                      <span
                        className="inline-block px-3 py-1 rounded-full bg-gray-100 text-gray-400 text-sm font-bold"
                        title={belowMin ? `Not enough data — fewer than ${JOB_SCORE_MIN_LEADS} leads in this window` : "Not enough data"}
                      >
                        —
                      </span>
                    );
                  }
                  const c = colorFor(score);
                  return (
                    <span className={`inline-block px-3 py-1 rounded-full ${c.bg} ${c.text} text-sm font-bold tabular-nums`}>
                      {score}
                    </span>
                  );
                };

                const SubSignal = ({ label, raw, sub, weight, hint }) => {
                  const c = colorFor(sub);
                  return (
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</div>
                        <div className="text-[10px] text-gray-400">{Math.round(weight * 100)}%</div>
                      </div>
                      <div className="mt-1 flex items-baseline justify-between gap-2">
                        <div className="text-base font-semibold text-navy">{raw}</div>
                        <div className={`text-sm font-bold tabular-nums ${c.text}`}>{sub === null ? "—" : sub}</div>
                      </div>
                      <div className="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full ${c.bar}`} style={{ width: `${sub === null ? 0 : sub}%` }} />
                      </div>
                      {hint && <div className="text-[11px] text-gray-500 mt-1.5">{hint}</div>}
                    </div>
                  );
                };

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Property</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Leads</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase text-center">Job Score</th>
                          <th className="px-4 py-3 text-xs font-semibold text-gray-600 uppercase text-center">
                            Outcome
                            <div className="text-[10px] text-gray-400 normal-case font-normal">conversion</div>
                          </th>
                          <th className="px-4 py-3 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => {
                          const isOpen = expandedScoreRow === r.m;
                          return (
                            <React.Fragment key={r.m}>
                              <tr
                                className="border-b hover:bg-gray-50/50 cursor-pointer"
                                onClick={() => setExpandedScoreRow(isOpen ? null : r.m)}
                              >
                                <td className="px-4 py-3 text-sm font-medium">{r.m}</td>
                                <td className="px-4 py-3 text-center text-sm text-gray-600 tabular-nums">{r.total}</td>
                                <td className="px-4 py-3 text-center"><ScoreBadge score={r.jobScore} belowMin={r.belowMinLeads} /></td>
                                <td className="px-4 py-3 text-center text-sm text-gray-600 tabular-nums">
                                  {r.convPct === null ? <span className="text-gray-300">—</span> : `${r.convPct}%`}
                                </td>
                                <td className="px-4 py-3 text-center text-gray-400 text-xs">{isOpen ? "▾" : "▸"}</td>
                              </tr>
                              {isOpen && (
                                <tr className="bg-gray-50/40 border-b">
                                  <td colSpan={5} className="px-4 py-4">
                                    {r.belowMinLeads ? (
                                      <div className="text-sm text-gray-500 italic">Only {r.total} lead{r.total === 1 ? "" : "s"} in this window — need at least {JOB_SCORE_MIN_LEADS} to compute a reliable score.</div>
                                    ) : (
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                        <SubSignal
                                          label="Response rate"
                                          raw={`${r.respPct}%`}
                                          sub={r.sub.resp}
                                          weight={W.resp}
                                          hint="leads with any rep reply"
                                        />
                                        <SubSignal
                                          label="Speed to lead"
                                          raw={r.medSpeed === null ? "—" : formatSpeedToLead(r.medSpeed)}
                                          sub={r.sub.speed}
                                          weight={W.speed}
                                          hint="average, business hours"
                                        />
                                        <SubSignal
                                          label="Call coverage"
                                          raw={`${r.callCovPct}%`}
                                          sub={r.sub.callCov}
                                          weight={W.callCov}
                                          hint="leads with ≥1 call attempt"
                                        />
                                        <SubSignal
                                          label="Note coverage"
                                          raw={r.noteCovPct === null ? "—" : `${r.noteCovPct}%`}
                                          sub={r.sub.noteCov}
                                          weight={W.noteCov}
                                          hint={r.totalLogged > 0 ? `${r.totalLogged} logged call${r.totalLogged === 1 ? "" : "s"}` : "no logged calls in window"}
                                        />
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

            {/* Word Cloud */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-navy">Call Notes Word Cloud</h2>
                <p className="text-xs text-gray-400 mt-0.5">Words extracted from call notes — size reflects frequency · common filler words removed</p>
              </div>
              {!callData?.marinaStats ? (
                <LoadingSkeleton height="h-48" />
              ) : (() => {
                const STOP = new Set(["the","a","an","and","or","but","is","was","are","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","can","this","that","these","those","to","of","in","for","on","with","at","by","from","about","as","into","through","during","before","after","up","down","out","off","over","then","when","where","how","all","both","each","more","most","other","some","no","not","only","so","too","very","just","we","i","me","my","you","your","he","she","it","they","their","our","us","him","her","its","she","his","s","t","re","ll","ve","d","m","left","message","voicemail","called","calling","spoke","speak","talked","talk","asked","told","said","call","calls","also","back","got","let","go","going","get","give","need","new","said","well","would","wanted","wants","per","been","will","its","they","there","here","know","said","if","he","she","we","our","they","what","who","which","been","than","then","i","any","was","were","has","had"]);
                const COLORS = ["#0c2340","#c4933f","#2563eb","#16a34a","#9333ea","#dc2626","#0891b2","#ea580c","#ca8a04","#0d9488"];

                const freq = {};
                for (const marina of Object.values(callData.marinaStats)) {
                  for (const call of marina.recentCalls || []) {
                    if (!call.notes) continue;
                    const words = call.notes.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/);
                    for (const w of words) {
                      if (w.length < 3 || STOP.has(w)) continue;
                      freq[w] = (freq[w] || 0) + 1;
                    }
                  }
                }

                const sorted = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 80);
                if (sorted.length === 0) return <p className="text-gray-400 text-sm text-center py-8">No call notes available yet.</p>;

                const maxCount = sorted[0][1];
                const minCount = sorted[sorted.length-1][1];
                const range = Math.max(maxCount - minCount, 1);

                return (
                  <div className="flex flex-wrap gap-2 justify-center py-4">
                    {sorted.map(([word, count], i) => {
                      const size = 12 + Math.round(((count - minCount) / range) * 32);
                      const color = COLORS[i % COLORS.length];
                      const opacity = 0.6 + ((count - minCount) / range) * 0.4;
                      return (
                        <span key={word}
                          title={`${word}: ${count} occurrences`}
                          style={{ fontSize: `${size}px`, color, opacity, lineHeight: 1.3 }}
                          className="cursor-default select-none hover:opacity-100 transition-opacity"
                        >
                          {word}
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

          </>)}

          {/* ── TRENDS TAB ──────────────────────────────── */}
          {pageTab === "trends" && (<>

            {/* Speed to Lead Over Time */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-navy">Speed to Lead Over Time</h2>
                <p className="text-xs text-gray-400 mt-0.5">Average business-minute response time per calendar month · April 2026 onward</p>
              </div>
              {!trendsData?.months ? (
                <LoadingSkeleton height="h-72" />
              ) : trendsData.months.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-16">No data available yet for April 2026 onward.</p>
              ) : (() => {
                const chartData = trendsData.months.map((m) => {
                  const row = { month: m.label };
                  if (m.overall.avgSpeedBizMinutes !== null) row["Overall"] = m.overall.avgSpeedBizMinutes;
                  for (const marina of trendsData.marinas) {
                    const v = m.byMarina[marina]?.avgSpeedBizMinutes;
                    if (v !== null && v !== undefined) row[marina] = v;
                  }
                  return row;
                });
                const keys = ["Overall", ...trendsData.marinas];
                const colors = ["#64748b", ...MARINA_COLORS];
                return (
                  <>
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={chartData} margin={{ left: 8, right: 24, top: 8, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatSpeedToLead(v)} width={64} />
                        <Tooltip formatter={(value, name) => [formatSpeedToLead(value), name]} />
                        <Legend />
                        {keys.map((key, i) => (
                          <Line
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stroke={colors[i % colors.length]}
                            strokeWidth={key === "Overall" ? 2.5 : 1.5}
                            strokeDasharray={key === "Overall" ? "6 3" : undefined}
                            dot={{ r: 3 }}
                            connectNulls={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                    <p className="text-xs text-gray-400 mt-2">Lower is better · gaps indicate no data for that marina/month</p>
                  </>
                );
              })()}
            </div>

            {/* Conversion Rate Over Time */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-navy">Conversion Rate Over Time</h2>
                <p className="text-xs text-gray-400 mt-0.5">Percentage of leads that converted per calendar month · April 2026 onward</p>
              </div>
              {!trendsData?.months ? (
                <LoadingSkeleton height="h-72" />
              ) : trendsData.months.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-16">No data available yet for April 2026 onward.</p>
              ) : (() => {
                const chartData = trendsData.months.map((m) => {
                  const row = { month: m.label };
                  if (m.overall.conversionRate !== null) row["Overall"] = m.overall.conversionRate;
                  for (const marina of trendsData.marinas) {
                    const v = m.byMarina[marina]?.conversionRate;
                    if (v !== null && v !== undefined) row[marina] = v;
                  }
                  return row;
                });
                const keys = ["Overall", ...trendsData.marinas];
                const colors = ["#64748b", ...MARINA_COLORS];
                return (
                  <>
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={chartData} margin={{ left: 8, right: 24, top: 8, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} width={48} domain={[0, "auto"]} />
                        <Tooltip formatter={(value, name) => [`${value}%`, name]} />
                        <Legend />
                        {keys.map((key, i) => (
                          <Line
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stroke={colors[i % colors.length]}
                            strokeWidth={key === "Overall" ? 2.5 : 1.5}
                            strokeDasharray={key === "Overall" ? "6 3" : undefined}
                            dot={{ r: 3 }}
                            connectNulls={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                    <p className="text-xs text-gray-400 mt-2">Higher is better · gaps indicate no data for that marina/month</p>
                  </>
                );
              })()}
            </div>

          </>)}
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
      {!detail.aiSummary && (
        <div className="bg-white rounded-lg border p-4 shadow-sm flex items-center gap-2 text-gray-400 text-sm">
          <svg className="animate-spin h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Generating AI analysis...
        </div>
      )}
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

      {/* Form-fill Ask */}
      {(detail.formAsk || detail.recentFormName) && (
        <div className="bg-white rounded-lg border p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-base">📋</span>
            <h3 className="text-sm font-semibold text-navy">What they asked for</h3>
            {detail.recentFormName && (
              <span className="text-xs text-gray-500 truncate" title={detail.recentFormName}>
                · via {detail.recentFormName}
              </span>
            )}
          </div>
          {detail.formAsk?.message && (
            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed mb-3">
              "{detail.formAsk.message}"
            </p>
          )}
          {detail.formAsk && (
            <div className="flex flex-wrap gap-2">
              {detail.formAsk.inquiryType && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">
                  Inquiry: {detail.formAsk.inquiryType}
                </span>
              )}
              {detail.formAsk.storageType && (
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">
                  Storage: {detail.formAsk.storageType}
                </span>
              )}
              {(detail.formAsk.boatMake || detail.formAsk.boatModel || detail.formAsk.boatType || detail.formAsk.boatLoa) && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                  Boat: {[detail.formAsk.boatMake, detail.formAsk.boatModel, detail.formAsk.boatType, detail.formAsk.boatLoa && `${detail.formAsk.boatLoa}'`].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
          )}
          {!detail.formAsk?.message && !detail.formAsk && (
            <p className="text-xs text-gray-400 italic">No additional details captured on the form.</p>
          )}
        </div>
      )}

      {/* Engagement Timeline */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-navy">Rep Activity Timeline</h3>
          {detail.timeline?.length > 0 && (
            <span className="text-xs text-gray-400">{detail.timeline.length} {detail.timeline.length === 1 ? "event" : "events"}</span>
          )}
        </div>
        {(!detail.timeline || detail.timeline.length === 0) ? (
          <p className="text-sm text-gray-400">No engagement activity found.</p>
        ) : (
          <div className="space-y-4">
            {(() => {
              const groups = {};
              const order = [];
              for (const ev of detail.timeline) {
                const d = new Date(ev.timestamp);
                const key = d.toDateString();
                if (!groups[key]) { groups[key] = []; order.push(key); }
                groups[key].push(ev);
              }
              const today = new Date().toDateString();
              const yesterday = new Date(Date.now() - 86400000).toDateString();
              return order.map((dayKey) => {
                let label = new Date(dayKey).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                if (dayKey === today) label = "Today · " + label;
                else if (dayKey === yesterday) label = "Yesterday · " + label;
                return (
                  <div key={dayKey}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
                      <div className="flex-1 h-px bg-gray-200" />
                      <span className="text-xs text-gray-400">{groups[dayKey].length}</span>
                    </div>
                    <div className="space-y-2">
                      {groups[dayKey].map((event, i) => {
                        const cfg = event.type === "NOTE"
                          ? { border: "border-l-yellow-400", chipBg: "bg-yellow-50", chipText: "text-yellow-700", label: "Note" }
                          : event.type === "CALL"
                          ? event.isLogged
                            ? { border: "border-l-purple-500", chipBg: "bg-purple-50", chipText: "text-purple-700", label: "Logged Call" }
                            : event.direction === "INBOUND"
                            ? { border: "border-l-orange-400", chipBg: "bg-orange-50", chipText: "text-orange-700", label: "Inbound Call" }
                            : { border: "border-l-navy", chipBg: "bg-blue-50", chipText: "text-navy", label: "Outbound Call" }
                          : event.subtype === "EMAIL_INBOUND"
                          ? { border: "border-l-gray-400", chipBg: "bg-gray-100", chipText: "text-gray-700", label: "Inbound Email" }
                          : event.subtype === "EMAIL_LOGGED"
                          ? { border: "border-l-purple-500", chipBg: "bg-purple-50", chipText: "text-purple-700", label: "Logged Email" }
                          : event.isAutomated
                          ? { border: "border-l-gray-300", chipBg: "bg-gray-50", chipText: "text-gray-500", label: "Automated Email" }
                          : { border: "border-l-gold", chipBg: "bg-amber-50", chipText: "text-amber-700", label: "Outbound Email" };
                        const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                        const body = event.bodyPreview || event.notes;
                        return (
                          <div key={i} className={`bg-white rounded-md border border-l-4 ${cfg.border} px-3 py-2 shadow-sm`}>
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${cfg.chipBg} ${cfg.chipText}`}>
                                  {cfg.label}
                                </span>
                                {event.actorName && (
                                  <span className="text-xs font-medium text-indigo-700">{event.actorName}</span>
                                )}
                                {event.durationFormatted && (
                                  <span className="text-xs text-gray-400">· {event.durationFormatted}</span>
                                )}
                                {event.sentBy && !event.actorName && (
                                  <span className="text-xs text-gray-500">from {event.sentBy}</span>
                                )}
                                {event.isAcknowledgment && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200" title={`Classified by ${event.ackReason || "system"} — no reply needed`}>
                                    ✓ Acknowledged · no reply needed
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-gray-400 whitespace-nowrap font-mono">{time}</span>
                            </div>
                            {(event.subject || event.label) && (
                              <p className="text-sm text-gray-800 mt-1 truncate">
                                {event.subject || event.label}
                              </p>
                            )}
                            {body && (
                              <p className="text-xs text-gray-500 mt-1 italic line-clamp-2">{body}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
