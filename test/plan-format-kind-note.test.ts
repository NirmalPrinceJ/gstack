import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { KIND_NOTE_RE } from './helpers/plan-format-kind-note';

const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/plan-format-kind-notes.json'), 'utf8')) as
  { known_good: string[]; known_bad: string[] };

describe('plan-format kind note', () => {
  test.each(stored.known_good)('accepts %s', line => expect(line).toMatch(KIND_NOTE_RE));
  test.each(stored.known_bad)('rejects %s', line => expect(line).not.toMatch(KIND_NOTE_RE));
});
