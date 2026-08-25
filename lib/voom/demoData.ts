import type {
  AdAllocation,
  AdHistoryRow,
  CampaignRow,
  Channel,
  EmailOrSms,
  IndustryPack,
  Insight,
  Kpi,
  Plan,
  Post,
  ReelQueueItem,
} from "./types";

export const PACKS: Record<string, IndustryPack> = {
  "Restaurant / Café": {
    brand: "Marina Café",
    site: "marinacafe.ae",
    handle: "@marinacafe",
    aud: ["Local residents nearby", "Young adults (18–29)", "Families with children"],
    r: [
      "Behind the pass: signature breakfast",
      "60 seconds inside the kitchen",
      "New autumn menu tasting",
      "Our most-ordered dish, made slowly",
    ],
    p: ["New autumn menu", "Weekend brunch set", "Meet the head chef", "Friday family offer"],
    cap: "We changed one thing about our breakfast and people noticed 👀\nHere's what actually goes into the plate everyone orders twice.",
    hooks: [
      "“The dish we almost took off the menu — and why we didn’t.”",
      "“What AED 45 gets you at our table.”",
      "“60 seconds in our kitchen before we open.”",
    ],
    trend: "“weekend brunch”",
    slot: "7:10 PM",
    slotWhy: "people book dinner tables in the evening",
    emailN: "Autumn menu is live",
    emailSub: "The new menu is on the table",
    emailBody:
      "If you have been waiting for the autumn menu, it lands this Thursday. Here is what we added — and the one dish we kept by popular demand.",
    smsT: "Marina Café: Weekend brunch seats just opened — book at marinacafe.ae/book. Reply STOP to opt out",
    camp: [
      "Autumn menu — teaser",
      "Weekend brunch newsletter",
      "Flash: 2-for-1 dessert",
      "Retargeting — table bookings",
      "Meet the chef — carousel",
    ],
    ad: ["Reels — signature breakfast", "Retargeting — booking page", "Lookalike 1% — past diners", "Story — weekend brunch"],
    top: ["Behind the pass: breakfast", "Meet the head chef", "Autumn menu tasting"],
    cold: "diners who haven’t booked in 60 days",
    win: "bring regulars back in",
    unit: "bookings",
  },
  "Salon / Spa": {
    brand: "Studio Rima",
    site: "studiorima.ae",
    handle: "@studiorima",
    aud: ["Local residents nearby", "Young adults (18–29)", "Professionals (30–50)"],
    r: [
      "Colour correction, start to finish",
      "What a blow-dry really costs",
      "Client transformation of the week",
      "3 things to ask before you colour",
    ],
    p: ["New treatment menu", "Stylist spotlight", "Weekday booking offer", "Aftercare routine"],
    cap: "Colour correction in 45 seconds ✂️\nThis took four hours — here's what we actually did, step by step.",
    hooks: [
      "“What most people get wrong before a colour appointment.”",
      "“Four hours in 45 seconds — colour correction.”",
      "“The one question to ask your stylist.”",
    ],
    trend: "“colour correction”",
    slot: "6:30 PM",
    slotWhy: "clients book after work",
    emailN: "Weekday chairs open",
    emailSub: "Quieter chair, better price",
    emailBody:
      "Our Tuesday and Wednesday chairs are the calmest of the week — and right now they are also the best value. Here is what is open.",
    smsT: "Studio Rima: Two chairs opened this Thursday. Book at studiorima.ae/book. Reply STOP to opt out",
    camp: [
      "Colour correction — Reel",
      "Weekday chairs newsletter",
      "Flash: 20% off treatments",
      "Retargeting — booking page",
      "Stylist spotlight — carousel",
    ],
    ad: ["Reels — colour correction", "Retargeting — booking page", "Lookalike 1% — past clients", "Story — weekday offer"],
    top: ["Colour correction start to finish", "Stylist spotlight", "Client transformation"],
    cold: "clients who haven’t booked in 60 days",
    win: "rebook lapsed clients",
    unit: "appointments",
  },
  "Gym / Fitness studio": {
    brand: "Grit Studio",
    site: "gritstudio.ae",
    handle: "@gritstudio",
    aud: ["Young adults (18–29)", "Professionals (30–50)", "Local residents nearby"],
    r: [
      "Your first class, honestly",
      "Form check: the 3 most common mistakes",
      "Members on why they stayed",
      "What 6am actually looks like",
    ],
    p: ["New class timetable", "Coach spotlight", "Founding member offer", "Members’ results board"],
    cap: "Your first class, honestly 💪\nNobody is watching you. Here's exactly what happens in the first ten minutes.",
    hooks: [
      "“Nobody is watching you — what your first class is really like.”",
      "“Three form mistakes we fix every single week.”",
      "“Why our 6am members never miss.”",
    ],
    trend: "“strength for beginners”",
    slot: "6:00 PM",
    slotWhy: "members plan tomorrow’s session in the evening",
    emailN: "New timetable is live",
    emailSub: "Your new week, mapped out",
    emailBody:
      "The new timetable goes live Monday, with two extra evening strength slots you asked for. Here is how to lock in your spot.",
    smsT: "Grit Studio: 3 spots left in tomorrow’s 6am strength class — grab one at gritstudio.ae. Reply STOP to opt out",
    camp: [
      "First class — Reel",
      "New timetable newsletter",
      "Flash: founding member rate",
      "Retargeting — trial signup",
      "Coach spotlight — carousel",
    ],
    ad: ["Reels — first class", "Retargeting — trial page", "Lookalike 1% — members", "Story — class spots"],
    top: ["Your first class, honestly", "Form check: 3 mistakes", "Members on why they stayed"],
    cold: "members who haven’t booked in 60 days",
    win: "win back lapsed members",
    unit: "class bookings",
  },
  "Clothing / Fashion": {
    brand: "Atelier Nine",
    site: "ateliernine.ae",
    handle: "@ateliernine",
    aud: ["Young adults (18–29)", "Professionals (30–50)", "Luxury / high-income"],
    r: [
      "New arrivals, styled 3 ways",
      "How this piece is actually made",
      "Fit check: sizing honestly",
      "What sells out first, every time",
    ],
    p: ["New arrivals drop", "Styling guide", "Restock announcement", "Behind the fabric"],
    cap: "One piece, three ways 🖤\nSave this before the drop — the middle look is the one that sells out first.",
    hooks: [
      "“One piece, three ways — save this before the drop.”",
      "“How this is actually made, start to finish.”",
      "“Fit check: sizing, honestly.”",
    ],
    trend: "“capsule wardrobe”",
    slot: "8:00 PM",
    slotWhy: "shoppers browse late evening",
    emailN: "The drop goes live Thursday",
    emailSub: "Early access opens tonight",
    emailBody:
      "The new drop lands Thursday at 8pm. You are on the early access list, which means you see it — and can buy it — twelve hours before everyone else.",
    smsT: "Atelier Nine: Early access to the drop opens in 1 hour — ateliernine.ae/drop. Reply STOP to opt out",
    camp: [
      "New drop — teaser Reel",
      "Early access newsletter",
      "Flash: 24h 20% off",
      "Retargeting — cart abandon",
      "Behind the fabric — carousel",
    ],
    ad: ["Reels — new arrivals", "Retargeting — cart abandon", "Lookalike 1% — buyers", "Story — drop reminder"],
    top: ["New arrivals, styled 3 ways", "How this is made", "Fit check: sizing"],
    cold: "subscribers who haven’t opened in 60 days",
    win: "recover lapsed shoppers",
    unit: "orders",
  },
  "Real estate": {
    brand: "Meridian Properties",
    site: "meridianproperties.ae",
    handle: "@meridianproperties",
    aud: ["Professionals (30–50)", "Luxury / high-income", "Businesses (B2B)"],
    r: [
      "Inside a 2-bed on the Marina",
      "What AED 1.2M actually buys",
      "3 questions before you view",
      "Handover day, start to finish",
    ],
    p: ["New listing walkthrough", "Market update", "Buyer’s checklist", "Client handover story"],
    cap: "What AED 1.2M actually buys on the Marina 🔑\nFull walkthrough — including the thing most listings don't show you.",
    hooks: [
      "“What AED 1.2M actually buys — full walkthrough.”",
      "“Three questions to ask before any viewing.”",
      "“The part of the listing nobody photographs.”",
    ],
    trend: "“first-time buyer guides”",
    slot: "8:30 PM",
    slotWhy: "buyers browse listings at night",
    emailN: "This month’s market update",
    emailSub: "What moved this month",
    emailBody:
      "Three things shifted in the market this month, and one of them changes what a first-time buyer can realistically offer. Here is the short version.",
    smsT: "Meridian: New 2-bed listing on the Marina, viewings open Saturday — meridianproperties.ae. Reply STOP to opt out",
    camp: [
      "Marina walkthrough — Reel",
      "Monthly market update",
      "Flash: open house Saturday",
      "Retargeting — listing viewers",
      "Buyer’s checklist — carousel",
    ],
    ad: ["Reels — Marina walkthrough", "Retargeting — listing page", "Lookalike 1% — past buyers", "Story — open house"],
    top: ["Inside a 2-bed on the Marina", "What AED 1.2M buys", "Handover day"],
    cold: "enquiries that went quiet 60 days ago",
    win: "reopen cold enquiries",
    unit: "viewings",
  },
  "Online store": {
    brand: "Kestrel Goods",
    site: "kestrelgoods.ae",
    handle: "@kestrelgoods",
    aud: ["Young adults (18–29)", "Professionals (30–50)", "Budget-conscious shoppers"],
    r: [
      "Unboxing the bestseller",
      "Why this costs what it costs",
      "3 uses you didn’t expect",
      "Packing your order, start to finish",
    ],
    p: ["Bestseller restock", "Product breakdown", "Customer review feature", "Free delivery weekend"],
    cap: "Why this costs what it costs 📦\nFull breakdown — materials, shipping, and the bit most brands leave out.",
    hooks: [
      "“Why this costs what it costs — full breakdown.”",
      "“Three uses for this you didn’t expect.”",
      "“Packing your order, start to finish.”",
    ],
    trend: "“honest pricing breakdowns”",
    slot: "8:00 PM",
    slotWhy: "carts fill in the evening",
    emailN: "Restock: the bestseller is back",
    emailSub: "It’s back in stock",
    emailBody:
      "The one that sold out in four days is back, in slightly larger numbers this time. Here is the restock, plus the two colours you kept asking for.",
    smsT: "Kestrel Goods: Your bestseller is back in stock — kestrelgoods.ae/restock. Reply STOP to opt out",
    camp: [
      "Bestseller — teaser Reel",
      "Restock newsletter",
      "Flash: 24h free delivery",
      "Retargeting — cart abandon",
      "Customer review — carousel",
    ],
    ad: ["Reels — bestseller unboxing", "Retargeting — cart abandon", "Lookalike 1% — buyers", "Story — restock alert"],
    top: ["Unboxing the bestseller", "Why this costs what it costs", "Packing your order"],
    cold: "subscribers who haven’t opened in 60 days",
    win: "recover abandoned carts",
    unit: "orders",
  },
  "Clinic / Healthcare": {
    brand: "Northside Clinic",
    site: "northsideclinic.ae",
    handle: "@northsideclinic",
    aud: ["Families with children", "Professionals (30–50)", "Local residents nearby"],
    r: ["What your first visit involves", "3 myths we hear every week", "Meet the team", "When to book, and when to wait"],
    p: ["New appointment hours", "Team introduction", "Preventive check reminder", "Patient FAQ"],
    cap: "What your first visit actually involves 🩺\nNo surprises — here's the full process, start to finish.",
    hooks: [
      "“What your first visit actually involves.”",
      "“Three things we hear every week that aren’t true.”",
      "“When to book, and when it can wait.”",
    ],
    trend: "“preventive check-ups”",
    slot: "7:00 PM",
    slotWhy: "patients book after working hours",
    emailN: "Extended evening hours",
    emailSub: "We’re open later now",
    emailBody:
      "From this month we are open until 8pm on weekdays, which should make booking around work considerably easier. Here is the new schedule.",
    smsT: "Northside Clinic: Evening appointments now open until 8pm — book at northsideclinic.ae. Reply STOP to opt out",
    camp: [
      "First visit — Reel",
      "Evening hours newsletter",
      "Reminder: preventive checks",
      "Retargeting — booking page",
      "Meet the team — carousel",
    ],
    ad: ["Reels — first visit explained", "Retargeting — booking page", "Lookalike 1% — past patients", "Story — evening hours"],
    top: ["What your first visit involves", "Meet the team", "3 myths we hear weekly"],
    cold: "patients who haven’t booked in 12 months",
    win: "bring patients back for checks",
    unit: "appointments",
  },
  "Professional services": {
    brand: "Harbour Consulting",
    site: "harbourconsulting.ae",
    handle: "@harbourconsulting",
    aud: ["Businesses (B2B)", "Professionals (30–50)", "Local residents nearby"],
    r: [
      "The mistake that costs clients most",
      "What our first call covers",
      "A project, start to finish",
      "3 questions before you hire anyone",
    ],
    p: ["Case study: 90-day project", "Team spotlight", "Free consultation week", "Client result story"],
    cap: "The mistake that costs our clients the most 📊\nIt takes ten minutes to fix and almost nobody checks it.",
    hooks: [
      "“The mistake that costs our clients the most.”",
      "“What actually happens on our first call.”",
      "“Three questions to ask before you hire anyone.”",
    ],
    trend: "“practical how-to breakdowns”",
    slot: "9:00 AM",
    slotWhy: "business audiences read in the morning",
    emailN: "Case study: 90 days in",
    emailSub: "What 90 days actually changed",
    emailBody:
      "We ran the same process with three clients this quarter. Here is what changed, what did not, and the part we would do differently.",
    smsT: "Harbour Consulting: Two consultation slots opened this week — book at harbourconsulting.ae. Reply STOP to opt out",
    camp: [
      "Common mistake — Reel",
      "Case study newsletter",
      "Consultation week push",
      "Retargeting — enquiry page",
      "Team spotlight — carousel",
    ],
    ad: ["Reels — common mistake", "Retargeting — enquiry page", "Lookalike 1% — past clients", "Story — consultation week"],
    top: ["The mistake that costs most", "What our first call covers", "A project, start to finish"],
    cold: "enquiries that went quiet 60 days ago",
    win: "reopen cold enquiries",
    unit: "enquiries",
  },
  Other: {
    brand: "Your Business",
    site: "yourbusiness.ae",
    handle: "@yourbusiness",
    aud: ["Local residents nearby", "Professionals (30–50)"],
    r: ["Behind the scenes", "How we actually do this", "Customer story of the week", "The question we get asked most"],
    p: ["What’s new this month", "Meet the team", "This week’s offer", "Customer story"],
    cap: "Behind the scenes 👀\nHere's how this actually gets made — and the step most people never see.",
    hooks: [
      "“Here’s how this actually gets made.”",
      "“The question we get asked most — answered.”",
      "“A customer story worth two minutes.”",
    ],
    trend: "“behind-the-scenes content”",
    slot: "7:10 PM",
    slotWhy: "your audience is most active in the evening",
    emailN: "What’s new this month",
    emailSub: "A short update from us",
    emailBody:
      "A few things changed this month that are worth two minutes of your time. Here is the short version, with the one update most people care about first.",
    smsT: "Your Business: Something new just went live — see it at yourbusiness.ae. Reply STOP to opt out",
    camp: [
      "Behind the scenes — Reel",
      "Monthly newsletter",
      "Flash: this week only",
      "Retargeting — website visitors",
      "Customer story — carousel",
    ],
    ad: ["Reels — behind the scenes", "Retargeting — website visitors", "Lookalike 1% — past customers", "Story — this week’s offer"],
    top: ["Behind the scenes", "Customer story of the week", "How we actually do this"],
    cold: "contacts who haven’t engaged in 60 days",
    win: "re-engage quiet contacts",
    unit: "enquiries",
  },
};

export const INDUSTRY_KEYS = Object.keys(PACKS);

export const POST_SLOTS: { d: number; ch: Channel; time: string; st: Post["st"] }[] = [
  { d: 2, ch: "Reel", time: "7:10 PM", st: "Scheduled" },
  { d: 2, ch: "Email", time: "9:00 AM", st: "Scheduled" },
  { d: 5, ch: "Reel", time: "7:10 PM", st: "Draft" },
  { d: 7, ch: "Feed", time: "12:30 PM", st: "Scheduled" },
  { d: 9, ch: "SMS", time: "11:00 AM", st: "Scheduled" },
  { d: 11, ch: "Reel", time: "6:45 PM", st: "Draft" },
  { d: 14, ch: "Email", time: "8:00 AM", st: "Scheduled" },
  { d: 14, ch: "Reel", time: "7:10 PM", st: "Scheduled" },
  { d: 18, ch: "Feed", time: "1:00 PM", st: "Idea" },
  { d: 20, ch: "Reel", time: "7:10 PM", st: "Idea" },
  { d: 23, ch: "SMS", time: "10:30 AM", st: "Draft" },
  { d: 26, ch: "Email", time: "9:00 AM", st: "Draft" },
];

export const CH_COL: Record<Channel, string> = {
  Reel: "#e8481f",
  Feed: "#c9306b",
  Email: "#0f6f68",
  SMS: "#f2a516",
};

export const TMPLS: { n: string; g: string }[] = [
  { n: "Talking head", g: "linear-gradient(160deg,#ff8a3d,#c9306b)" },
  { n: "Before / after", g: "linear-gradient(160deg,#2f6f9f,#0f6f68)" },
  { n: "Product hero", g: "linear-gradient(160deg,#e8481f,#f2a516)" },
  { n: "Text hook", g: "linear-gradient(160deg,#0f6f68,#141a18)" },
  { n: "Tutorial", g: "linear-gradient(160deg,#9fd6c9,#f4cdb4)" },
  { n: "UGC stitch", g: "linear-gradient(160deg,#c9306b,#f2a516)" },
];

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    m: 0,
    y: 0,
    blurb: "Try MARA on one business.",
    hot: false,
    f: ["MARA chat — 20 messages / mo", "1 connected business", "Content calendar", "5 scheduled posts / mo"],
    off: ["Reel auto-scheduling", "Email & SMS campaigns", "Paid ad management", "Competitor tracking"],
  },
  {
    id: "pro",
    name: "Pro",
    m: 199,
    y: 199,
    blurb: "For businesses posting every week.",
    hot: true,
    f: [
      "Unlimited MARA chat",
      "3 connected businesses",
      "Unlimited scheduling",
      "Email & SMS campaigns",
      "Reel auto-scheduling at best times",
      "Performance dashboard",
    ],
    off: ["Paid ad budget management"],
  },
  {
    id: "max",
    name: "Max",
    m: 549,
    y: 549,
    blurb: "MARA runs your marketing end-to-end.",
    hot: false,
    f: [
      "Everything in Pro",
      "Unlimited businesses & seats",
      "Paid ad budget management",
      "Budget limits and automatic performance pauses",
      "Competitor & trend tracking",
      "Priority support",
    ],
    off: [],
  },
];

export const KPIS: Kpi[] = [
  { k: "reach", lab: "Reach", val: "184.2K", d: "+18.4%", up: true, ic: "eye", c: "--brand" },
  { k: "eng", lab: "Engagement rate", val: "6.8%", d: "+1.2 pts", up: true, ic: "heart", c: "--rose" },
  { k: "foll", lab: "New followers", val: "3,412", d: "+24.1%", up: true, ic: "users", c: "--blue" },
  { k: "rev", lab: "Attributed revenue", val: "AED 42,860", d: "-3.2%", up: false, ic: "wallet", c: "--brand-2" },
];

export const SERIES = {
  labels: ["Jul 28", "Aug 2", "Aug 6", "Aug 10", "Aug 14", "Aug 18", "Aug 22"],
  reach: [62, 74, 71, 96, 88, 118, 134],
  eng: [28, 41, 36, 52, 61, 58, 79],
};

export const CHANNEL_SHARE = [
  { n: "Instagram Reels", v: 42, c: "#e8481f" },
  { n: "Instagram Feed", v: 23, c: "#f2a516" },
  { n: "Email", v: 19, c: "#0f6f68" },
  { n: "SMS", v: 10, c: "#2f6f9f" },
  { n: "Paid Social", v: 6, c: "#c9306b" },
];

export function defaultCampaignsTable(): CampaignRow[] {
  return [
    { n: "Glow Drop — launch teaser", ch: "Reels", sent: "—", open: "112K views", clk: "4.2K", rev: "AED 8,420", st: "Live", t: "t-green" },
    { n: "Summer Barrier Repair", ch: "Email", sent: "8,412", open: "41.2%", clk: "6.8%", rev: "AED 12,190", st: "Sent", t: "t-blue" },
    { n: "Flash 24h — 20% off", ch: "SMS", sent: "3,190", open: "98.1%", clk: "11.4%", rev: "AED 9,340", st: "Sent", t: "t-blue" },
    { n: "Retargeting — cart abandon", ch: "Paid", sent: "—", open: "62K impr.", clk: "2.9%", rev: "AED 6,720", st: "Live", t: "t-green" },
    { n: "Founder story — carousel", ch: "Feed", sent: "—", open: "28K reach", clk: "1.1K", rev: "AED 2,180", st: "Scheduled", t: "t-amber" },
  ];
}

export function defaultEmails(): EmailOrSms[] {
  return [
    { n: "Summer Barrier Repair", seg: "All subscribers · 8,412", st: "Sent", t: "t-blue", o: "41.2%", c: "6.8%", r: "AED 12,190", when: "Aug 18" },
    { n: "Glow Drop — launch", seg: "VIP + engaged · 4,120", st: "Scheduled", t: "t-amber", o: "—", c: "—", r: "—", when: "Sep 6, 8:00 AM" },
    { n: "Win-back flow #1", seg: "Cold 60d · 1,284", st: "Draft", t: "t-grey", o: "—", c: "—", r: "—", when: "Not scheduled" },
    { n: "Welcome series — step 1", seg: "New signups · auto", st: "Live", t: "t-green", o: "62.4%", c: "14.1%", r: "AED 18,430", when: "Automated" },
  ];
}

export function defaultSms(): EmailOrSms[] {
  return [
    { n: "Flash 24h — 20% off", seg: "SMS opt-ins · 3,190", st: "Sent", t: "t-blue", o: "98.1%", c: "11.4%", r: "AED 9,340", when: "Aug 14" },
    { n: "Restock heads-up", seg: "Waitlist · 842", st: "Scheduled", t: "t-amber", o: "—", c: "—", r: "—", when: "Aug 26, 10:30 AM" },
    { n: "Glow Drop early access", seg: "VIP · 610", st: "Draft", t: "t-grey", o: "—", c: "—", r: "—", when: "Not scheduled" },
  ];
}

export function defaultAdAlloc(): AdAllocation[] {
  return [
    { n: "Reels — Barrier repair", ch: "Instagram Reels", pct: 45, c: "#e8481f", roas: "4.2×" },
    { n: "Retargeting — cart", ch: "Meta Advantage+", pct: 30, c: "#0f6f68", roas: "5.1×" },
    { n: "Lookalike 1% — buyers", ch: "Instagram Feed", pct: 15, c: "#f2a516", roas: "2.6×" },
    { n: "Story swipe-ups", ch: "Instagram Story", pct: 10, c: "#2f6f9f", roas: "1.9×" },
  ];
}

export function defaultAdHistory(): AdHistoryRow[] {
  return [
    { n: "August boost", amt: "AED 800", st: "Active", t: "t-green", roas: "3.9×", when: "Approved Aug 12" },
    { n: "July always-on retarget", amt: "AED 650", st: "Complete", t: "t-grey", roas: "4.4×", when: "Jul 1 – Jul 31" },
    { n: "June test — Story ads", amt: "AED 300", st: "Complete", t: "t-grey", roas: "1.4×", when: "Jun 8 – Jun 22" },
  ];
}

export function buildPosts(pack: IndustryPack): Post[] {
  const pick = { Reel: 0, Feed: 0, Email: 0, SMS: 0 };
  const lists: Record<Channel, string[]> = {
    Reel: pack.r,
    Feed: pack.p,
    Email: [pack.emailN, "Monthly newsletter", "Win-back message"],
    SMS: ["Flash offer alert", "Reminder message", "Restock heads-up"],
  };
  return POST_SLOTS.map((s) => {
    const list = lists[s.ch];
    const t = list[pick[s.ch]++ % list.length];
    return { d: s.d, t: `${s.ch} · ${t}`, c: CH_COL[s.ch], ch: s.ch, time: s.time, st: s.st };
  });
}

export function buildReelQueue(pack: IndustryPack): ReelQueueItem[] {
  return [
    { t: pack.r[0], when: "Tue, Aug 25 · " + pack.slot, st: "Scheduled", t2: "t-green", g: "linear-gradient(160deg,#ff8a3d,#c9306b)", views: "—" },
    { t: pack.r[1], when: "Fri, Aug 28 · " + pack.slot, st: "Draft", t2: "t-amber", g: "linear-gradient(160deg,#2f6f9f,#0f6f68)", views: "—" },
    { t: pack.r[2], when: "Mon, Sep 1 · 6:45 PM", st: "Draft", t2: "t-amber", g: "linear-gradient(160deg,#e8481f,#f2a516)", views: "—" },
    { t: pack.r[3] || pack.r[0], when: "Posted Aug 20", st: "Live", t2: "t-blue", g: "linear-gradient(160deg,#0f6f68,#141a18)", views: "112K" },
  ];
}

export function buildCampaignsTable(pack: IndustryPack): CampaignRow[] {
  const base = defaultCampaignsTable();
  base.forEach((r, i) => {
    r.n = pack.camp[i] || r.n;
  });
  return base;
}

export function buildEmails(pack: IndustryPack): EmailOrSms[] {
  const base = defaultEmails();
  base[0].n = pack.emailN;
  base[1].n = pack.camp[0];
  base[2].n = "Win-back — step 1";
  return base;
}

export function buildSms(): EmailOrSms[] {
  const base = defaultSms();
  base[0].n = "Flash offer — 24h";
  base[1].n = "Reminder message";
  base[2].n = "Early access alert";
  return base;
}

export function buildAdAlloc(pack: IndustryPack): AdAllocation[] {
  const base = defaultAdAlloc();
  base.forEach((a, i) => {
    a.n = pack.ad[i] || a.n;
  });
  return base;
}

export function buildAdHistory(pack: IndustryPack): AdHistoryRow[] {
  const base = defaultAdHistory();
  base[0].n = "August boost — " + pack.p[0];
  return base;
}

export function buildInsights(pack: IndustryPack): Insight[] {
  return [
    {
      t: `Content posted at ${pack.slot} performed best`,
      b: `In this demo dataset, ${pack.slotWhy} — evening posts averaged 41K views against 12K in the morning. I can move your queue.`,
      ic: "fire",
      c: "--rose",
      act: "Reschedule queue",
      go: "reels",
      ex: true,
    },
    {
      t: `${pack.trend} is trending in your category`,
      b: `Search interest is up 62% this month in this demo dataset. I drafted 3 Reel hooks around it, ready for review.`,
      ic: "trend",
      c: "--brand",
      act: "See drafts",
      go: "calendar",
      ex: true,
    },
    {
      t: "Your quiet contacts are going cold",
      b: `1,284 ${pack.cold} in this demo list. A two-step win-back should ${pack.win}.`,
      ic: "warn",
      c: "--amber",
      act: "Build flow",
      go: "campaigns",
      ex: true,
    },
    {
      t: "AED 1,200 ad budget awaiting approval",
      b: "I built an allocation you can review below. Nothing spends until you approve it, and ad money is paid through your own ad account.",
      ic: "wallet",
      c: "--green",
      act: "Review budget",
      go: "ads",
      ex: false,
    },
  ];
}

export function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
}

export function nfc(n: number): string {
  return n.toLocaleString("en-US");
}

export function detectIndustry(text: string): string {
  const rules: [RegExp, string][] = [
    [/restaurant|caf[eé]|coffee|bakery|food|kitchen|dine|dining|menu|pizza|shawarma|brunch/i, "Restaurant / Café"],
    [/salon|spa|hair|nails|barber|lash|brow|beauty|grooming/i, "Salon / Spa"],
    [/gym|fitness|yoga|pilates|crossfit|padel|personal train|studio class/i, "Gym / Fitness studio"],
    [/cloth|fashion|boutique|abaya|apparel|wear|shoes|jewel/i, "Clothing / Fashion"],
    [/real estate|property|properties|villa|apartment|broker|listing|landlord/i, "Real estate"],
    [/online store|e-?commerce|shopify|web ?shop|ship orders|deliver orders/i, "Online store"],
    [/clinic|dental|dentist|doctor|medical|physio|aesthetic|therap/i, "Clinic / Healthcare"],
    [/consult|agency|law|legal|account|bookkeep|tutor|repair|cleaning|service business/i, "Professional services"],
  ];
  for (const [re, name] of rules) {
    if (re.test(text)) return name;
  }
  return "";
}
