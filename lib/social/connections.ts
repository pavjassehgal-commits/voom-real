/**
 * Voom Multi-Social Core — social provider connections.
 *
 * One channel-neutral view of what Voom can truthfully reach per channel:
 *
 *   instagram  the REAL connection (instagram_connections, encrypted tokens
 *              server-side only) — exactly as production ships it today.
 *   youtube    the REAL connection (youtube_connections, migration 0047:
 *              encrypted OAuth tokens server-side only, the authoritative
 *              channel identity YouTube returned, the scopes Google actually
 *              granted, and the truthful audit-restriction note).
 *   tiktok     the REAL connection (tiktok_connections, migration 0049:
 *              encrypted OAuth tokens server-side only, the authoritative
 *              open_id TikTok itself returned, the scopes TikTok actually
 *              granted, and the truthful content-sharing-audit note).
 *   email      the existing Resend server configuration.
 *
 * Rules:
 *   - No token, secret or encrypted value ever leaves the server through
 *     this module; the view below is sanitized presentation metadata only.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getResendAvailability } from "@/lib/email/config";
import { hasPublishPermission } from "@/lib/tiktok/scopes";
import { YOUTUBE_UPLOAD_SCOPE } from "@/lib/youtube/scopes";
import { SOCIAL_CHANNELS, type SocialChannel } from "./channels";

/** The truthful connection states, shared with the UI. */
export const SOCIAL_CONNECTION_STATES = [
  /** A real, usable provider connection exists for this owner. */
  "connected",
  /** A connection row exists but is not usable (expired/disconnected). */
  "disconnected",
  /** Voom has no integration for this channel yet — nothing to connect. */
  "not_configured",
] as const;

export type SocialConnectionState = (typeof SOCIAL_CONNECTION_STATES)[number];

export const SOCIAL_CONNECTION_STATE_LABELS: Record<SocialConnectionState, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  not_configured: "Not configured",
};

/** One channel's connection, as the UI may see it. Metadata only. */
export interface SocialConnectionView {
  channel: SocialChannel;
  state: SocialConnectionState;
  /** Truthful one-line explanation of the state. */
  detail: string;
  /** Whether Voom can publish on this channel right now. */
  canPublish: boolean;
  /** Sanitized display metadata. Never tokens or secrets. */
  account: {
    handle: string | null;
    name: string | null;
    kind: string | null;
  } | null;
  /**
   * Provider-specific metadata, isolated per channel and empty until the real
   * integration exists. Deliberately `unknown`-valued: no TikTok/YouTube
   * field is invented before its provider work ships.
   */
  provider: Record<string, unknown>;
}

/** The truthful static view for a channel Voom has not integrated yet. */
export function unconfiguredConnection(channel: SocialChannel): SocialConnectionView {
  const label = channel === "tiktok" ? "TikTok" : channel === "youtube" ? "YouTube" : channel;
  return {
    channel,
    state: "not_configured",
    detail: `${label} is not connected yet. Voom can plan, approve and schedule ${label} content; publishing becomes available when the real ${label} integration ships. Nothing is published anywhere until then.`,
    canPublish: false,
    account: null,
    provider: {},
  };
}

export interface SocialConnectionsDeps {
  db: SupabaseClient;
  ownerId: string;
  /** Whether server-side Instagram credentials are configured (env present). */
  instagramConfigured: boolean;
  /** Whether server-side YouTube (Google OAuth) credentials are configured. */
  youtubeConfigured?: boolean;
  /** Google's API-project audit state, surfaced truthfully in the provider bag. */
  youtubeProjectAudited?: boolean;
  /** Whether server-side TikTok OAuth credentials are configured. */
  tiktokConfigured?: boolean;
  /** Voom's TikTok app content-sharing-audit state, surfaced truthfully. */
  tiktokAppAudited?: boolean;
}

/**
 * Builds the full channel-neutral connection view.
 *
 * Instagram, TikTok and YouTube each come from their real connection row
 * (instagram_connections; tiktok_connections, migration 0049;
 * youtube_connections, migration 0047) — all through sanitized,
 * owner-scoped reads. An unconfigured deployment reports
 * `not_configured` truthfully — never a mocked connection.
 */
export async function getSocialConnections(deps: SocialConnectionsDeps): Promise<SocialConnectionView[]> {
  const { db, ownerId, instagramConfigured } = deps;

  const { data, error } = await db.from("instagram_connections")
    .select("username,display_name,account_type,status")
    .eq("owner_user_id", ownerId)
    .maybeSingle();

  const instagram: SocialConnectionView = (() => {
    if (error) {
      return {
        channel: "instagram",
        state: "disconnected",
        detail: "Voom could not read the Instagram connection. Publishing is paused until it can.",
        canPublish: false,
        account: null,
        provider: {},
      };
    }
    if (!data) {
      return {
        channel: "instagram",
        state: "disconnected",
        detail: instagramConfigured
          ? "No Instagram account is connected yet. Connect a professional account to enable real publishing."
          : "Instagram integration is not configured on the server yet.",
        canPublish: false,
        account: null,
        provider: {},
      };
    }
    const connected = data.status === "connected";
    return {
      channel: "instagram",
      state: connected ? "connected" : "disconnected",
      detail: connected
        ? "Connected. Publishing goes through the existing Instagram publish queue and only reports Published after Instagram confirms."
        : "The Instagram connection is not active. Reconnect to resume real publishing.",
      canPublish: connected,
      account: {
        handle: data.username ? String(data.username) : null,
        name: data.display_name ? String(data.display_name) : null,
        kind: data.account_type ? String(data.account_type) : null,
      },
      provider: {},
    };
  })();

  const resend = getResendAvailability();
  const email: SocialConnectionView = {
    channel: "email",
    state: resend.configured ? "connected" : "not_configured",
    detail: resend.configured
      ? "Campaign email delivery is configured on the server. Approved emails send only on an explicit send action, and Delivered requires the verified webhook."
      : "Campaign delivery integration is not configured yet.",
    canPublish: resend.configured,
    account: null,
    provider: {},
  };

  const tiktok = await tikTokConnectionView(db, ownerId, deps.tiktokConfigured === true, deps.tiktokAppAudited === true);
  const youtube = await youTubeConnectionView(db, ownerId, deps.youtubeConfigured === true, deps.youtubeProjectAudited === true);

  return [
    instagram,
    tiktok,
    youtube,
    email,
  ];
}

/**
 * The REAL TikTok connection view, from the sanitized `tiktok_connections`
 * row (migration 0049). Truthfulness rules:
 *   - `connected` requires the row's own status AND the video.publish scope
 *     TikTok actually granted — never an assumed capability;
 *   - the provider bag carries only sanitized metadata (open_id, granted
 *     scopes, expiry, explicit privacy default, audit state) — never tokens;
 *   - TikTok's unaudited-app restriction (posts restricted to SELF_ONLY
 *     viewership, 5 posting users per 24h) is surfaced plainly instead of
 *     promising public posting TikTok would refuse. The LIVE provider
 *     response always remains authoritative.
 */
async function tikTokConnectionView(
  db: SupabaseClient,
  ownerId: string,
  configured: boolean,
  appAudited: boolean,
): Promise<SocialConnectionView> {
  if (!configured) {
    return {
      channel: "tiktok",
      state: "not_configured",
      detail: "TikTok integration is not configured on the server yet. Content can be planned, approved and scheduled inside Voom; nothing is published to TikTok until it is.",
      canPublish: false,
      account: null,
      provider: {},
    };
  }
  const { data, error } = await db.from("tiktok_connections")
    .select("open_id,display_name,avatar_url,creator_username,status,scopes,access_token_expires_at,default_privacy")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  if (error) {
    return {
      channel: "tiktok",
      state: "disconnected",
      detail: "Voom could not read the TikTok connection. Publishing is paused until it can.",
      canPublish: false,
      account: null,
      provider: {},
    };
  }
  if (!data) {
    return {
      channel: "tiktok",
      state: "disconnected",
      detail: "No TikTok account is connected yet. Connect an account to enable real publishing; until then nothing is published to TikTok.",
      canPublish: false,
      account: null,
      provider: { appAudited },
    };
  }
  const row = data as Record<string, unknown>;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
  const status = String(row.status ?? "");
  const connected = status === "connected" && hasPublishPermission(scopes);
  const auditNote = appAudited
    ? null
    : " Until Voom's TikTok app passes TikTok's content-sharing audit, TikTok restricts posts through it to private (Only me) viewership; Voom reports what TikTok actually accepts.";
  return {
    channel: "tiktok",
    state: connected ? "connected" : "disconnected",
    detail: connected
      ? `Connected. Publishing rides the durable TikTok queue and reports Published only after TikTok's own post-status confirms PUBLISH_COMPLETE.${auditNote ?? ""}`
      : status === "revoked"
        ? "TikTok authorization was revoked. Reconnect the account to resume publishing; your posts on TikTok are untouched."
        : status === "disconnected"
          ? "The TikTok account was disconnected. Historical Voom records remain; your posts on TikTok are untouched."
          : `The TikTok connection is not active (${status || "unknown"}). Reconnect to resume real publishing.${auditNote ?? ""}`,
    canPublish: connected,
    account: {
      handle: row.creator_username ? String(row.creator_username) : null,
      name: row.display_name ? String(row.display_name) : null,
      kind: "account",
    },
    provider: {
      openId: row.open_id ? String(row.open_id) : null,
      grantedScopes: scopes,
      accessTokenExpiresAt: row.access_token_expires_at ? String(row.access_token_expires_at) : null,
      defaultPrivacy: row.default_privacy ? String(row.default_privacy) : null,
      appAudited,
    },
  };
}

/**
 * The REAL YouTube connection view, from the sanitized `youtube_connections`
 * row (migration 0047). Truthfulness rules:
 *   - `connected` requires the row's own status AND the upload scope Google
 *     actually granted — never an assumed capability;
 *   - the provider bag carries only sanitized metadata (channel id, granted
 *     scopes, expiry, explicit defaults, audit state) — never tokens;
 *   - Google's unaudited-project restriction is surfaced plainly instead of
 *     promising public publishing Google would lock to private.
 */
async function youTubeConnectionView(
  db: SupabaseClient,
  ownerId: string,
  configured: boolean,
  projectAudited: boolean,
): Promise<SocialConnectionView> {
  if (!configured) {
    return {
      channel: "youtube",
      state: "not_configured",
      detail: "YouTube integration is not configured on the server yet. Content can be planned, approved and scheduled inside Voom; nothing is published to YouTube until it is.",
      canPublish: false,
      account: null,
      provider: {},
    };
  }
  const { data, error } = await db.from("youtube_connections")
    .select("channel_id,channel_title,channel_handle,status,scopes,access_token_expires_at,default_privacy,default_made_for_kids")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  if (error) {
    return {
      channel: "youtube",
      state: "disconnected",
      detail: "Voom could not read the YouTube connection. Publishing is paused until it can.",
      canPublish: false,
      account: null,
      provider: {},
    };
  }
  if (!data) {
    return {
      channel: "youtube",
      state: "disconnected",
      detail: "No YouTube channel is connected yet. Connect a channel to enable real publishing; until then nothing is published to YouTube.",
      canPublish: false,
      account: null,
      provider: { projectAudited },
    };
  }
  const row = data as Record<string, unknown>;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
  const status = String(row.status ?? "");
  const connected = status === "connected" && scopes.includes(YOUTUBE_UPLOAD_SCOPE);
  const auditNote = projectAudited
    ? null
    : " Google locks uploads from unaudited API projects to private viewing mode; Voom reports the privacy YouTube actually applied.";
  return {
    channel: "youtube",
    state: connected ? "connected" : "disconnected",
    detail: connected
      ? `Connected. Publishing rides the durable YouTube queue and reports Published only after YouTube confirms the video is processed.${auditNote ?? ""}`
      : status === "revoked"
        ? "YouTube authorization was revoked. Reconnect the channel to resume publishing; your videos on YouTube are untouched."
        : status === "disconnected"
          ? "The YouTube channel was disconnected. Historical Voom records remain; your videos on YouTube are untouched."
          : `The YouTube connection is not active (${status || "unknown"}). Reconnect to resume real publishing.${auditNote ?? ""}`,
    canPublish: connected,
    account: {
      handle: row.channel_handle ? String(row.channel_handle) : null,
      name: row.channel_title ? String(row.channel_title) : null,
      kind: "channel",
    },
    provider: {
      channelId: row.channel_id ? String(row.channel_id) : null,
      grantedScopes: scopes,
      accessTokenExpiresAt: row.access_token_expires_at ? String(row.access_token_expires_at) : null,
      defaultPrivacy: row.default_privacy ? String(row.default_privacy) : null,
      defaultMadeForKids: typeof row.default_made_for_kids === "boolean" ? row.default_made_for_kids : null,
      projectAudited,
    },
  };
}

/** Quick lookup helper for UI surfaces. */
export function connectionForChannel(views: SocialConnectionView[], channel: SocialChannel): SocialConnectionView | null {
  return views.find((view) => view.channel === channel) ?? null;
}

/** The channels a given connection view set can truthfully publish on. */
export function publishableChannels(views: SocialConnectionView[]): SocialChannel[] {
  return SOCIAL_CHANNELS.filter((channel) => views.some((view) => view.channel === channel && view.canPublish));
}
