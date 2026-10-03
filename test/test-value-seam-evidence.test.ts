import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { recordsNonTestCallerSearch } from './helpers/test-value-fixture';

const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/test-value-seam-evidence.json'), 'utf8')) as
  { known_good: Record<string, unknown>; known_bad: Record<string, unknown> };

describe('test-only export caller-search evidence', () => {
  test.each(Object.entries(stored.known_good))('accepts %s', (_name, evidence) => {
    expect(recordsNonTestCallerSearch({ evidence })).toBe(true);
  });
  test.each(Object.entries(stored.known_bad))('rejects %s', (_name, evidence) => {
    expect(recordsNonTestCallerSearch({ evidence })).toBe(false);
  });
});
