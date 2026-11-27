// UI primitive tests — the token contract in miniature: primitives read
// --fd-* tokens through their Tailwind mapping (no hardcoded values),
// states (disabled/invalid/focus) ship as classes a11y can rely on, and
// the theme engine applies the dark class the tokens override.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';

import { Button } from './Button';
import { Field, Input } from './Input';
import { Badge } from './Badge';
import { Surface } from './Surface';
import { applyTheme } from '../../lib/theme';

describe('Button', () => {
  it('renders the primary variant from accent tokens', () => {
    render(() => <Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('bg-fd-accent');
    expect(button.className).toContain('rounded-fd-sm');
    // focus-visible rides the tokenized outline
    expect(button.className).toContain('focus-visible:outline-fd-accent');
  });

  it('renders variants and sizes from the token sets', () => {
    render(() => (
      <Button variant="secondary" size="sm">
        Cancel
      </Button>
    ));
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('bg-fd-bg-1');
    expect(button.className).toContain('text-fd-xs');
  });

  it('a disabled button never fires its click', async () => {
    let clicked = 0;
    render(() => (
      <Button disabled onClick={() => (clicked += 1)}>
        No
      </Button>
    ));
    const button = screen.getByRole('button', { name: 'No' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(clicked).toBe(0);
  });

  it('wires onClick', async () => {
    let clicked = 0;
    render(() => <Button onClick={() => (clicked += 1)}>Go</Button>);
    await fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(clicked).toBe(1);
  });
});

describe('Input + Field', () => {
  it('wires value and onInput', async () => {
    let value = '';
    const { getByRole } = render(() => <Input value="hi" onInput={(next) => (value = next)} />);
    const input = getByRole('textbox');
    expect((input as HTMLInputElement).value).toBe('hi');
    await fireEvent.input(input, { target: { value: 'hello' } });
    expect(value).toBe('hello');
  });

  it('the invalid state rides the danger token and aria-invalid', () => {
    const { getByRole } = render(() => <Input invalid />);
    const input = getByRole('textbox');
    expect(input.className).toContain('border-fd-danger');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('Field renders the label and hint', () => {
    render(() => (
      <Field label="Board name" hint="Visible to everyone in the workspace.">
        <Input />
      </Field>
    ));
    expect(screen.getByText('Board name')).toBeInTheDocument();
    expect(screen.getByText('Visible to everyone in the workspace.')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('a hue rides the tag tokens — text color and the tinted background', () => {
    render(() => <Badge hue={3}>design</Badge>);
    const badge = screen.getByText('design');
    expect(badge.className).toContain('text-fd-tag-3');
    expect(badge.style.getPropertyValue('background-color')).toContain('--fd-tag-3');
  });
});

describe('Surface', () => {
  it('the raised tone is bg + line + the first elevation token', () => {
    render(() => <Surface>content</Surface>);
    expect(screen.getByText('content').className).toContain('shadow-fd-1');
    expect(screen.getByText('content').className).toContain('bg-fd-bg-1');
  });

  it('flat turns elevation off (the P2 experiment ground truth)', () => {
    render(() => (
      <Surface flat>
        <span>flat</span>
      </Surface>
    ));
    expect(screen.getByText('flat').parentElement!.className).toContain('shadow-none');
  });
});

describe('the theme engine (token override carrier)', () => {
  it('applies and clears the dark class the tokens override', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
