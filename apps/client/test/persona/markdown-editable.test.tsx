import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MarkdownEditable } from '../../src/features/persona/MarkdownEditable';

afterEach(() => cleanup());

describe('MarkdownEditable', () => {
  function Harness({ initial, defaultEditing }: { initial: string; defaultEditing?: boolean }) {
    const [v, setV] = useState(initial);
    return <MarkdownEditable label="个人介绍与背景" ariaLabel="个人介绍与背景" value={v} onChange={setV} defaultEditing={defaultEditing} placeholder="写点什么" />;
  }
  it('renders Markdown by default and switches to a textarea on 编辑', () => {
    const { container } = render(<Harness initial={'- Male\n- Hobbie: **跑步**'} />);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('.ps-md-preview li')).toHaveLength(2);
    expect(container.querySelector('.ps-md-preview strong')?.textContent).toBe('跑步');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = screen.getByLabelText('个人介绍与背景') as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    fireEvent.change(ta, { target: { value: '# 新标题' } });
    fireEvent.click(screen.getByRole('button', { name: /完成预览/ }));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.ps-md-preview')?.textContent).toContain('新标题');
  });
  it('clicking the preview edits; empty values show a tappable placeholder', () => {
    const a = render(<Harness initial="正文" />);
    fireEvent.click(a.container.querySelector('.ps-md-preview')!);
    expect(a.container.querySelector('textarea')).toBeTruthy();
    a.unmount();
    const b = render(<Harness initial="" />);
    fireEvent.click(screen.getByRole('button', { name: '写点什么' }));
    expect(b.container.querySelector('textarea')).toBeTruthy();
  });
});
