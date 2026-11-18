import { describe, expect, it } from 'vitest';
import { ChoiceItemSchema, QuestionSegmentSchema, SegmentSchema } from '../src';

describe('question choice_items (character picker)', () => {
  it('parses rich choice items with avatar / subtitle and a layout hint', () => {
    const seg = SegmentSchema.parse({
      type: 'question',
      prompt: '选一位角色',
      choices: ['asuka', '🎲 再帮我想 8 个不同的候选'],
      layout: 'character_grid',
      choice_items: [
        { value: 'asuka', name: '明日香', subtitle: '傲娇 · 机师', avatar: 'personas/asuka.webp' },
        { value: '🎲 再帮我想 8 个不同的候选' },
      ],
    });
    expect(seg.type).toBe('question');
    if (seg.type !== 'question') throw new Error('unreachable');
    expect(seg.layout).toBe('character_grid');
    expect(seg.choice_items?.[0]).toEqual({ value: 'asuka', name: '明日香', subtitle: '傲娇 · 机师', avatar: 'personas/asuka.webp' });
    expect(seg.choice_items?.[1].avatar).toBeUndefined();
  });

  it('stays backward compatible with plain `choices` only questions', () => {
    const seg = QuestionSegmentSchema.parse({ type: 'question', choices: ['A', 'B'] });
    expect(seg.choices).toEqual(['A', 'B']);
    expect(seg.choice_items).toBeUndefined();
    expect(seg.layout).toBeUndefined();
    expect(seg.multi).toBe(false);
  });

  it('accepts optional group on choice items for mutually exclusive option groups', () => {
    const seg = SegmentSchema.parse({
      type: 'question',
      prompt: '选择升级招式',
      choices: ['替换火球术', '保留现有招式', '替换冰箭术'],
      multi: true,
      choice_items: [
        { value: '替换火球术', name: '烈焰风暴', subtitle: '威力 2d8 · 替换火球术', group: '明日香' },
        { value: '保留现有招式', group: '明日香' },
        { value: '替换冰箭术', name: '极寒新星', subtitle: '威力 2d6 + 减速', group: '绫波丽' },
      ],
    });
    expect(seg.type).toBe('question');
    if (seg.type !== 'question') throw new Error('unreachable');
    expect(seg.choice_items?.[0]).toEqual({
      value: '替换火球术',
      name: '烈焰风暴',
      subtitle: '威力 2d8 · 替换火球术',
      group: '明日香',
    });
    expect(seg.choice_items?.[1].group).toBe('明日香');
    expect(seg.choice_items?.[2].group).toBe('绫波丽');
  });

  it('requires a string value on every choice item', () => {
    expect(ChoiceItemSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(ChoiceItemSchema.safeParse({ value: 'x', avatar: 3 }).success).toBe(false);
    expect(ChoiceItemSchema.safeParse({ value: 'x', group: 123 }).success).toBe(false);
    expect(ChoiceItemSchema.safeParse({ value: 'x' }).success).toBe(true);
    expect(ChoiceItemSchema.safeParse({ value: 'x', group: 'G1' }).success).toBe(true);
  });
});
