// Isolated test composition only. Never imported by application code.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './deletion-transport.ts' && context.parentURL?.includes('/lib/youtube/privacy.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export function createDeletionTransport() { return {
        journal: async event => 'synthetic-intent:' + event.id,
        complete: async event => 'synthetic-complete:' + event.id,
        alert: async () => undefined,
      }; }
    `) };
  }
  return next(specifier, context);
} });
