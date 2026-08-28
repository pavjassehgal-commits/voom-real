export type AutomationModeValue = "manual" | "assisted" | "autopilot";

export function normalizeAutomationMode(value: string | null | undefined): AutomationModeValue {
  return value === "manual" || value === "autopilot" ? value : "assisted";
}
