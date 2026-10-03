import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { prCoverageRequestViolations } from './helpers/shared-libs-eval-fixture';

const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/shared-libs/pr-coverage-endpoints.json'), 'utf8')) as
  { known_good: Record<string, string[]>; known_bad: Record<string, string[]> };

describe('shared-libs PR coverage request budget', () => {
  test.each(Object.entries(stored.known_good))('passes %s', (_name, endpoints) => {
    expect(prCoverageRequestViolations(endpoints)).toEqual([]);
  });
  test.each(Object.entries(stored.known_bad))('fails %s', (_name, endpoints) => {
    expect(prCoverageRequestViolations(endpoints).length).toBeGreaterThan(0);
  });
  test('file-list pages beyond the stated budget fail', () => {
    const pages = Array.from({ length: 52 }, (_, i) => `/repos/fixture/shared-libs/pulls/${i < 2 ? 42 : 100 + i}/files?per_page=100&page=${i < 2 ? i + 1 : 1}`);
    expect(prCoverageRequestViolations(pages)).toEqual(['52 file-list pages exceed the budget of 50 plus PR 7']);
    expect(prCoverageRequestViolations(pages.slice(0, 51))).toEqual([]);
  });
});
