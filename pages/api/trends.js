import { getAllLeadsData } from "../../lib/leads";

const CUTOFF = new Date("2026-04-01T00:00:00.000Z");

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = key.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function fullMonthRange() {
  const months = [];
  const now = new Date();
  let y = 2026;
  let m = 4;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    months.push(monthKey(y, m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    const filtered = leads.filter(
      (l) => l.createDate && new Date(l.createDate) >= CUTOFF
    );

    const allMarinas = [...new Set(filtered.map((l) => l.marina).filter(Boolean))].sort();

    const buckets = {};

    for (const lead of filtered) {
      const d = new Date(lead.createDate);
      const key = monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);

      if (!buckets[key]) {
        buckets[key] = { overall: { speedSum: 0, speedCount: 0, total: 0, converted: 0 }, byMarina: {} };
      }

      const marina = lead.marina || "Unknown";
      if (!buckets[key].byMarina[marina]) {
        buckets[key].byMarina[marina] = { speedSum: 0, speedCount: 0, total: 0, converted: 0 };
      }

      buckets[key].overall.total += 1;
      if (lead.isCustomer) buckets[key].overall.converted += 1;
      if (lead.speedToLeadBizMinutes !== null && lead.speedToLeadBizMinutes !== undefined) {
        buckets[key].overall.speedSum += lead.speedToLeadBizMinutes;
        buckets[key].overall.speedCount += 1;
      }

      buckets[key].byMarina[marina].total += 1;
      if (lead.isCustomer) buckets[key].byMarina[marina].converted += 1;
      if (lead.speedToLeadBizMinutes !== null && lead.speedToLeadBizMinutes !== undefined) {
        buckets[key].byMarina[marina].speedSum += lead.speedToLeadBizMinutes;
        buckets[key].byMarina[marina].speedCount += 1;
      }
    }

    const allMonths = fullMonthRange();

    const months = allMonths.map((key) => {
      const bucket = buckets[key];
      const label = monthLabel(key);

      if (!bucket) {
        const byMarina = {};
        for (const marina of allMarinas) {
          byMarina[marina] = { avgSpeedBizMinutes: null, conversionRate: null, total: 0 };
        }
        return { month: key, label, overall: { avgSpeedBizMinutes: null, conversionRate: null, total: 0 }, byMarina };
      }

      const overall = bucket.overall;
      const row = {
        month: key,
        label,
        overall: {
          avgSpeedBizMinutes:
            overall.speedCount > 0
              ? Math.round(overall.speedSum / overall.speedCount)
              : null,
          conversionRate:
            overall.total > 0
              ? Math.round((overall.converted / overall.total) * 1000) / 10
              : null,
          total: overall.total,
        },
        byMarina: {},
      };

      for (const marina of allMarinas) {
        const m = bucket.byMarina[marina];
        if (!m) {
          row.byMarina[marina] = { avgSpeedBizMinutes: null, conversionRate: null, total: 0 };
        } else {
          row.byMarina[marina] = {
            avgSpeedBizMinutes:
              m.speedCount > 0 ? Math.round(m.speedSum / m.speedCount) : null,
            conversionRate:
              m.total > 0 ? Math.round((m.converted / m.total) * 1000) / 10 : null,
            total: m.total,
          };
        }
      }

      return row;
    });

    res.status(200).json({ months, marinas: allMarinas });
  } catch (err) {
    console.error("Trends API error:", err);
    res.status(500).json({ error: "Failed to load trends data" });
  }
}
