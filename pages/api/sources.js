import { getAllLeadsData } from "../../lib/leads";

// --- UTM / referrer parsing helpers --------------------------------------
//
// HubSpot's hs_analytics_source attribution is unreliable for traffic that
// hits the marina site via in-app browsers (Facebook, Instagram), URL
// shorteners, or any path that strips document.referrer. Many of those
// leads end up tagged DIRECT_TRAFFIC even though their first-referrer URL
// clearly contains UTM parameters or platform click-IDs identifying the
// real source.
//
// We re-derive the channel by parsing UTM params and known click-ID
// markers out of `firstReferrer` and `firstUrl`, then fall back to the
// referrer hostname, then HubSpot's native attribution as a last resort.
// -------------------------------------------------------------------------

function parseUrlParts(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const params = {};
    for (const [k, v] of u.searchParams.entries()) {
      params[k.toLowerCase()] = (v || "").toLowerCase();
    }
    return { host: u.hostname.toLowerCase(), params };
  } catch {
    return null;
  }
}

function bucketFromUtmAndClickIds(parts) {
  if (!parts) return null;
  const p = parts.params;

  // Explicit click-IDs are the strongest signal — they identify the ad
  // network even if utm tags are missing or wrong.
  if (p.fbclid || p.hsa_net === "facebook" || p.hsa_src === "ig") return "Social Media";
  if (p.gclid || p.gbraid || p.wbraid) return "Google PPC";
  if (p.msclkid) return "Bing Ads";
  if (p.li_fat_id) return "Social Media"; // LinkedIn
  if (p.ttclid) return "Social Media";    // TikTok
  if (p.twclid) return "Social Media";    // Twitter/X

  const src = p.utm_source || "";
  const med = p.utm_medium || "";

  if (med === "cpc" || med === "ppc" || med === "paid") {
    if (src.includes("google")) return "Google PPC";
    if (src.includes("bing")) return "Bing Ads";
    if (src.includes("facebook") || src.includes("instagram") || src.includes("meta")) return "Social Media";
    return "Paid Other";
  }
  if (med.includes("paidsocial") || med === "social" || med === "paid_social") return "Social Media";
  if (med === "email") return "Email";
  if (med === "organic" && src.includes("google")) return "Organic Search";
  if (med === "referral") return "Referral";

  if (src) {
    if (src.includes("facebook") || src.includes("instagram") || src.includes("meta") || src.includes("ig")) return "Social Media";
    if (src.includes("google")) return src === "google" && !med ? "Organic Search" : "Google PPC";
    if (src.includes("bing")) return "Bing Ads";
    if (src.includes("yahoo")) return "Organic Search";
    if (src.includes("linkedin") || src.includes("tiktok") || src.includes("twitter") || src.includes("x.com")) return "Social Media";
    if (src.includes("email") || src.includes("newsletter") || src.includes("mailchimp")) return "Email";
  }
  return null;
}

function bucketFromReferrerHost(parts, leadMarinaSlugs) {
  if (!parts || !parts.host) return null;
  const h = parts.host;

  if (h.includes("facebook.") || h === "fb.me" || h.includes("instagram.") || h.includes("l.facebook")) return "Social Media";
  if (h.includes("linkedin.") || h.includes("t.co") || h.includes("twitter.") || h.includes("x.com") || h.includes("tiktok.") || h.includes("pinterest.")) return "Social Media";
  if (h.includes("google.")) return "Organic Search"; // (paid would have gclid → already caught)
  if (h.includes("bing.") || h.includes("duckduckgo.") || h.includes("yahoo.")) return "Organic Search";
  if (h.includes("youtube.")) return "Social Media";
  if (h.includes("mail.") || h.includes("outlook.") || h.includes("gmail")) return "Email";

  // The marina's own site as referrer means the user was already on-site
  // when tracking attached — this is HubSpot's classic "looks direct but
  // isn't" case. Don't claim a channel; let the caller fall back.
  if (leadMarinaSlugs && leadMarinaSlugs.some((slug) => h.includes(slug))) return null;

  return "Referral"; // any other external site
}

// Map HubSpot's coarse hs_analytics_source enum onto our buckets, used
// as the final fallback when neither UTMs nor referrer give a signal.
function bucketFromHubSpotSource(lead) {
  const hs = (lead.hsSource || "").trim();
  const ls = (lead.leadSource || "").trim();
  const hsLower = hs.toLowerCase();

  if (hsLower.includes("walk")) return "Walk-in";
  if (hsLower.includes("phone") || hsLower === "call") return "Call";
  if (hs === "Social Media" || hs === "Social (Form)") return "Social Media";
  if (hs === "Referral" || hs === "Referral (Form)" || hsLower.includes("referral")) return "Referral";
  if (hs === "Paid Search" || hs === "Paid Search (Form)") return "Google PPC";
  if (hs === "Organic Search" || hs === "Organic Search (Form)") return "Organic Search";
  if (hs === "Direct Traffic" || hs === "Direct (Form)") return "Direct";
  if (hs === "Email") return "Email";
  if (hs === "Web Form") return "Web Form";

  if (ls === "Walk-in") return "Walk-in";
  if (ls === "Call") return "Call";
  if (ls === "Web Form") return "Web Form";
  if (ls === "Digital") return "Other";
  return "Other";
}

// Slugs we treat as the marina's own domain when they show up in the
// referrer host. Sourced from the public sites observed in the probe;
// extend as needed. We also auto-build a slug from the marina name on
// the lead in case a property's site isn't listed here.
const KNOWN_MARINA_HOSTS = [
  "allseasonsmarina", "stockislandmarinafl", "elliottbaymarina", "harbortownmarina",
  "millstonemarinas", "timsfordmarina", "haydenlakemarina", "sequoyahmarina",
  "sanmarcomarina", "fourcornersresortandmarina", "oceanislemarina", "westshoremarina",
  "cedarcreekmarina", "calabashmarina", "grandharborresortandmarina", "f3marinafl",
  "southernmarinas",
];

function ownDomainSlugsFor(lead) {
  const slugs = [...KNOWN_MARINA_HOSTS];
  if (lead.marina) {
    const slug = lead.marina.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (slug.length > 4) slugs.push(slug);
  }
  return slugs;
}

function bucketSource(lead) {
  const hsLower = (lead.hsSource || "").toLowerCase();

  // Rep-entered records (CRM_UI) bypass referrer logic entirely.
  if (hsLower.includes("walk")) return "Walk-in";
  if (hsLower.includes("phone") || hsLower === "call") return "Call";

  const refParts = parseUrlParts(lead.firstReferrer);
  const urlParts = parseUrlParts(lead.firstUrl);

  // 1) UTMs / click-IDs on the landing URL (strongest — campaign tags)
  let bucket = bucketFromUtmAndClickIds(urlParts);
  if (bucket) return bucket;

  // 2) UTMs / click-IDs on the referring URL
  bucket = bucketFromUtmAndClickIds(refParts);
  if (bucket) return bucket;

  // 3) Referrer hostname (google.com, m.facebook.com, etc.)
  bucket = bucketFromReferrerHost(refParts, ownDomainSlugsFor(lead));
  if (bucket) return bucket;

  // 4) HubSpot's native source enum as last resort
  return bucketFromHubSpotSource(lead);
}

const DEFAULT_WINDOW_START = new Date("2026-01-01T00:00:00.000Z");

function parseDateParam(v, fallback) {
  if (!v) return fallback;
  const d = new Date(v);
  if (isNaN(d.getTime())) return fallback;
  return d;
}

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    const from = parseDateParam(fromRaw, DEFAULT_WINDOW_START);
    const to = parseDateParam(toRaw, null);
    const fromMs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const toMs = to
      ? Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23, 59, 59, 999)
      : null;

    const eligible = leads.filter((l) => {
      if (l.isSpam) return false;
      if (!l.createDate) return false;
      if (!l.marina || l.marina === "Unknown") return false;
      const t = new Date(l.createDate).getTime();
      if (t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    });

    const cellMap = new Map();
    const sourceMap = new Map();
    const propertyMap = new Map();

    for (const lead of eligible) {
      const property = lead.marina;
      const source = bucketSource(lead);
      const key = `${property}\u0000${source}`;

      if (!cellMap.has(key)) cellMap.set(key, { property, source, total: 0, converted: 0 });
      if (!sourceMap.has(source)) sourceMap.set(source, { source, total: 0, converted: 0 });
      if (!propertyMap.has(property)) propertyMap.set(property, { property, total: 0, converted: 0 });

      const cell = cellMap.get(key);
      const src = sourceMap.get(source);
      const prop = propertyMap.get(property);

      cell.total++;
      src.total++;
      prop.total++;
      if (lead.isCustomer) {
        cell.converted++;
        src.converted++;
        prop.converted++;
      }
    }

    const withRatio = (row) => ({
      ...row,
      closeRatio: row.total > 0 ? row.converted / row.total : 0,
    });

    const rows = Array.from(cellMap.values())
      .map(withRatio)
      .sort((a, b) => {
        if (a.property !== b.property) return a.property.localeCompare(b.property);
        return b.total - a.total;
      });

    const bySource = Array.from(sourceMap.values())
      .map(withRatio)
      .sort((a, b) => b.total - a.total);

    const byProperty = Array.from(propertyMap.values())
      .map(withRatio)
      .sort((a, b) => b.total - a.total);

    const totalLeads = eligible.length;
    const totalConverted = eligible.filter((l) => l.isCustomer).length;

    res.status(200).json({
      windowStart: new Date(fromMs).toISOString(),
      windowEnd: toMs !== null ? new Date(toMs).toISOString() : null,
      totals: {
        leads: totalLeads,
        converted: totalConverted,
        closeRatio: totalLeads > 0 ? totalConverted / totalLeads : 0,
      },
      rows,
      bySource,
      byProperty,
    });
  } catch (err) {
    console.error("Sources API error:", err);
    res.status(500).json({ error: "Failed to load source breakdown" });
  }
}
