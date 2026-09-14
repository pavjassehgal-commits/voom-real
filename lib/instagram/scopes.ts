/**
 * The permissions Voom asks Instagram (Meta) for when a business connects.
 *
 * `instagram_business_manage_insights` is what makes per-media insights
 * (reach, views, saves, shares, interactions) readable. Without it Voom can
 * still read the media node, so Performance Intelligence degrades truthfully
 * to likes/comments instead of failing.
 */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const;
