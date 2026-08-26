export type InstagramConnectionStatus = "connected" | "expired" | "revoked" | "error" | "disconnected";

export interface InstagramConnectionView {
  connected: boolean;
  configured: boolean;
  status: InstagramConnectionStatus | "not_connected";
  username: string | null;
  name: string | null;
  accountType: string | null;
  profilePictureUrl: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  connectedAt: string | null;
}
