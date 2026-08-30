export type Channel = "Reel" | "Feed" | "Email" | "SMS";

export type PostStatus = "Scheduled" | "Draft" | "Idea" | "Live" | "Sent";

export interface Post {
  d: number;
  t: string;
  c: string;
  ch: Channel;
  time: string;
  st: PostStatus;
}

export interface ReelQueueItem {
  t: string;
  when: string;
  st: "Scheduled" | "Draft" | "Live";
  t2: string;
  g: string;
  views: string;
}

export interface CampaignRow {
  n: string;
  ch: string;
  sent: string;
  open: string;
  clk: string;
  rev: string;
  st: string;
  t: string;
}

export interface EmailOrSms {
  n: string;
  seg: string;
  st: "Sent" | "Scheduled" | "Draft" | "Live";
  t: string;
  o: string;
  c: string;
  r: string;
  when: string;
}

export interface AdAllocation {
  n: string;
  ch: string;
  pct: number;
  c: string;
  roas: string;
}

export interface AdHistoryRow {
  n: string;
  amt: string;
  st: string;
  t: string;
  roas: string;
  when: string;
}

export interface ApprovedPlan {
  limit: number;
  alloc: AdAllocation[];
  spent: number;
  start: string;
  end: string;
  paused: boolean;
}

export interface Kpi {
  k: string;
  lab: string;
  val: string;
  d: string;
  up: boolean;
  ic: string;
  c: string;
}

export interface Insight {
  t: string;
  b: string;
  ic: string;
  c: string;
  act: string;
  go: string;
  ex: boolean;
}

export interface Plan {
  id: "free" | "pro" | "max";
  name: string;
  m: number;
  y: number;
  blurb: string;
  hot: boolean;
  f: string[];
  off: string[];
}

export interface IndustryPack {
  brand: string;
  site: string;
  handle: string;
  aud: string[];
  r: string[];
  p: string[];
  cap: string;
  hooks: string[];
  trend: string;
  slot: string;
  slotWhy: string;
  emailN: string;
  emailSub: string;
  emailBody: string;
  smsT: string;
  camp: string[];
  ad: string[];
  top: string[];
  cold: string;
  win: string;
  unit: string;
}

export interface ChatMessage {
  r: "me" | "mara";
  h: string;
  acts?: [string, string][];
}

export interface OnboardingAnswers {
  displayName: string;
  desc: string;
  name: string;
  site: string;
  industry: string;
  customer: string[];
  goal: string;
  tone: string[];
  channels: string[];
  budget: string;
  freq: string;
  auto: string;
  permission: string;
  color: string;
}

export interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "err" | "info";
  proto?: boolean;
}

export interface ProfileRecord {
  user_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessRecord {
  id: string;
  owner_user_id: string;
  brand_name: string | null;
  brand_description: string | null;
  industry: string | null;
  target_customer: string[];
  main_goal: string | null;
  brand_personality: string[];
  preferred_channels: string[];
  monthly_ad_budget: string | null;
  content_frequency: string | null;
  automation_level: string | null;
  publishing_permission: string | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface BusinessProfileInput {
  displayName: string;
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string[];
  mainGoal: string;
  brandPersonality: string[];
  preferredChannels: string[];
  monthlyAdBudget: string;
  contentFrequency: string;
  automationLevel: string;
  publishingPermission: string;
}

export type CampaignStatus = "draft" | "approved" | "rejected";

export interface CampaignRecord {
  id: string;
  kind: "email" | "sms";
  name: string;
  objective: string;
  audience: string;
  subject: string | null;
  preview_text: string | null;
  content: string;
  proposed_send_at: string | null;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
}
