/**
 * C4: carved skills on external hosts point at sections relative to the
 * installed skill directory. `$GSTACK_ROOT/<skill>/sections/...` does not exist
 * in external runtime roots (Codex's holds bin, lib, browse, review only), so a
 * root-relative pointer would 404 and the model would work from memory.
 */
import { describe, expect, test } from 'bun:test';
import { ALL_HOST_CONFIGS } from '../hosts';
import { sectionPath } from '../scripts/resolvers/sections';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const context = (host: string, skillName: string): TemplateContext => ({ host, skillName, tmplPath: '', paths: HOST_PATHS[host] });

describe('C4: external section pointers', () => {
  for (const config of ALL_HOST_CONFIGS.filter(c => c.name !== 'claude')) {
    test(`${config.name}: ship and plan-ceo-review point relative to the installed skill directory`, () => {
      expect(sectionPath(context(config.name, 'ship'), 'ship', 'tests'))
        .toBe('`sections/tests.md` relative to the installed `gstack-ship` SKILL.md directory');
      expect(sectionPath(context(config.name, 'plan-ceo-review'), 'plan-ceo-review', 'review-sections'))
        .toBe('`sections/review-sections.md` relative to the installed `gstack-plan-ceo-review` SKILL.md directory');
      expect(sectionPath(context(config.name, 'ship'), 'ship', 'tests')).not.toContain('$GSTACK_ROOT');
    });
  }

  test('claude keeps its global-root pointer (bytes unchanged)', () => {
    expect(sectionPath(context('claude', 'ship'), 'ship', 'tests')).toBe('`~/.claude/skills/gstack/ship/sections/tests.md`');
  });
});
