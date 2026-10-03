import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { browseJudgeFloorsMet } from './helpers/workflow-judge-cache';

type Scores = { clarity: number; completeness: number; actionability: number };
const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/browse-judge/panel-means.json'), 'utf8')) as
  { known_good: Record<string, Scores>; known_bad: Record<string, Scores> };

describe('browse judge floors', () => {
  test.each(Object.entries(stored.known_good))('passes %s', (_name, scores) => expect(browseJudgeFloorsMet(scores)).toBe(true));
  test.each(Object.entries(stored.known_bad))('fails %s', (_name, scores) => expect(browseJudgeFloorsMet(scores)).toBe(false));
});
