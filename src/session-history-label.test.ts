import { describe, expect, it } from 'vitest';

import {
  formatSessionHistoryLabel,
  sanitizeSessionHistoryPrompt,
} from './session-history-label.js';

describe('sanitizeSessionHistoryPrompt', () => {
  it('extracts plain message text from formatted XML prompts', () => {
    const prompt = `<context timezone="UTC" />
<messages>
<message id="1" sender="User" time="2026-03-21 08:51">Reply with exactly: session two ready</message>
</messages>`;

    expect(sanitizeSessionHistoryPrompt(prompt)).toBe(
      'Reply with exactly: session two ready',
    );
  });

  it('decodes XML entities from formatted prompts', () => {
    const prompt = `<context timezone="UTC" />
<messages>
<message id="1" sender="User" time="2026-03-21 08:51">Use &lt;tag&gt; &amp; keep &quot;quotes&quot;</message>
</messages>`;

    expect(sanitizeSessionHistoryPrompt(prompt)).toBe(
      'Use <tag> & keep "quotes"',
    );
  });

  it('falls back to trimmed raw prompts for non-XML input', () => {
    expect(sanitizeSessionHistoryPrompt('  session two ready  ')).toBe(
      'session two ready',
    );
  });
});

describe('formatSessionHistoryLabel', () => {
  it('prefers the custom name when present', () => {
    expect(
      formatSessionHistoryLabel({
        name: 'session-one',
        first_prompt: '<messages><message>ignored</message></messages>',
        session_id: 'abcd1234',
      }),
    ).toBe('session-one');
  });

  it('uses sanitized prompt text when no custom name exists', () => {
    expect(
      formatSessionHistoryLabel({
        name: null,
        first_prompt: `<context timezone="UTC" />
<messages>
<message id="1" sender="User" time="2026-03-21 08:51">Reply with exactly: session two ready</message>
</messages>`,
        session_id: 'abcd1234',
      }),
    ).toBe('Reply with exactly: session two ready');
  });
});
