import "server-only";
// Separate composition boundary permits deterministic transports in isolated tests.
export { createDeletionTransport } from "./deletion-delivery.ts";
