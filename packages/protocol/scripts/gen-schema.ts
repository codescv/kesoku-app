/* Emits dist/protocol.schema.json — JSON Schema of every V1.2 payload (for pydantic codegen). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EnvelopeSchema } from '../src/envelope.ts';
import { ClientToEngine, EngineToClient, EngineToRelay, RelayToEngine } from '../src/events.ts';
import { SegmentSchema } from '../src/common.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Kesoku wire protocol V1.2',
  envelope: zodToJsonSchema(EnvelopeSchema),
  segment: zodToJsonSchema(SegmentSchema),
};
for (const [group, table] of Object.entries({ ClientToEngine, EngineToClient, EngineToRelay, RelayToEngine })) {
  const g: Record<string, unknown> = {};
  for (const [type, schema] of Object.entries(table)) g[type] = zodToJsonSchema(schema as never);
  out[group] = g;
}
const file = join(here, '..', 'dist', 'protocol.schema.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`wrote ${file}`);
