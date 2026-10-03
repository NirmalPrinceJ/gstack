import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { triageLabels } from './helpers/ship-triage-labels';

const DIR = path.join(import.meta.dir, 'fixtures', 'ship-triage');
const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');
const correct = (output: string) => {
  const labels = triageLabels(output);
  return labels.string === 'in-branch' && labels.math === 'pre-existing';
};

describe('ship triage label grader', () => {
  test.each(['known-good-json.txt', 'known-good-lines.txt'])('accepts %s', (name) => {
    expect(correct(read(name))).toBe(true);
  });
  test.each(['known-bad-swapped.txt', 'known-bad-words-only.txt', 'known-bad-one-label.txt'])('rejects %s', (name) => {
    expect(correct(read(name))).toBe(false);
  });
  test('the previous word-presence check passed the words-only and swapped outputs', () => {
    const previous = (output: string) => {
      const lower = output.toLowerCase();
      return /in-branch|in branch|introduced/.test(lower) && /pre-existing|pre existing|existed before/.test(lower)
        && /truncate|string/.test(lower) && /divide|math/.test(lower);
    };
    expect(previous(read('known-bad-words-only.txt'))).toBe(true);
    expect(previous(read('known-bad-swapped.txt'))).toBe(true);
  });
});
