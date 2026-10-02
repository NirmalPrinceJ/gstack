import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { hasNarrationLeak } from './helpers/skill-body-narration';

const DIR = path.join(import.meta.dir, 'fixtures', 'skillify-narration');
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');
const KNOWN_BAD = fs.readdirSync(DIR).filter(name => name.startsWith('known-bad-')).sort();

describe('skillify narration grader', () => {
  test('accepts a clean body that says "let me know" in a trigger', () => {
    expect(hasNarrationLeak(read('known-good.md'))).toBe(false);
  });
  test('stored known-bad fixtures exist', () => {
    expect(KNOWN_BAD.length).toBeGreaterThanOrEqual(4);
  });
  test.each(KNOWN_BAD)('still rejects %s', (name) => {
    expect(hasNarrationLeak(read(name))).toBe(true);
  });
  test('the previous grader rejected every known-bad fixture and also the known-good one', () => {
    const previous = (body: string) => /^I /m.test(body) || /Let me /i.test(body) || /^I'll /m.test(body);
    for (const name of KNOWN_BAD) expect(previous(read(name))).toBe(true);
    expect(previous(read('known-good.md'))).toBe(true);
  });
});
