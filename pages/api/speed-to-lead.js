import { getAllLeadsData } from "../../lib/leads";

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return {
    year: d.getFullYear(),
    week: 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7),
  };
}

function getWeekLabel(year, week) {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    // Get last 12 weeks
    const now = new Date();
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const { year, week } = getISOWeek(d);
      const label = getWeekLabel(year, week);
      if (!weeks.find((w) => w.label === label)) {
        weeks.push({ year, week, label });
      }
    }

    // Group leads by marina and week of first response
    const marinas = [...new Set(leads.map((l) => l.marina))].sort();
    const data = weeks.map((w) => {
      const row = { week: w.label };
      for (const marina of marinas) {
        const marinaLeads = leads.filter((l) => {
          if (l.marina !== marina || !l.firstResponseTime) return false;
          const { year, week } = getISOWeek(l.firstResponseTime);
          return year === w.year && week === w.week;
        });
        if (marinaLeads.length > 0) {
          const avg =
            marinaLeads.reduce((sum, l) => sum + l.speedToLeadMinutes, 0) /
            marinaLeads.length;
          row[marina] = Math.round(avg * 10) / 10;
        } else {
          row[marina] = null;
        }
      }
      return row;
    });

    res.status(200).json({ data, marinas, weeks: weeks.map((w) => w.label) });
  } catch (error) {
    console.error("Error fetching speed to lead:", error);
    res.status(500).json({ error: "Failed to fetch speed to lead data" });
  }
}
