import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { auqMachineFormatProblems, scoreAuqFormat } from './helpers/auq-sdk-capture';

const briefs = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/auq-matrix/briefs.json'), 'utf8')) as
  { known_good: Record<string, string>; known_bad: Record<string, string> };

describe('AUQ matrix format gate', () => {
  test.each(Object.entries(briefs.known_good))('passes %s', (_name, text) => {
    expect(auqMachineFormatProblems(text)).toEqual([]);
  });
  test.each(Object.entries(briefs.known_bad))('fails %s', (_name, text) => {
    expect(auqMachineFormatProblems(text).length).toBeGreaterThan(0);
  });
  test('a brief missing only presentation elements no longer fails, but they are still reported', () => {
    expect(scoreAuqFormat(briefs.known_good['no-emoji-or-net']!).missing).toEqual(['Pros / cons:', '✅', '❌', 'Net:']);
  });
});
