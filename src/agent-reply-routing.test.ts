import { describe, expect, it } from 'vitest';

import {
  _extractReplySourceChannelJid,
  _getAgentReplyTargets,
} from './index.js';

describe('agent reply target selection', () => {
  it('replies only to the source channel for delegated conversations', () => {
    expect(_getAgentReplyTargets('dc:brain-router', 'dc:personal-assistant')).toEqual([
      'dc:personal-assistant',
    ]);
  });

  it('replies to the current chat for direct conversations', () => {
    expect(_getAgentReplyTargets('dc:brain-router')).toEqual([
      'dc:brain-router',
    ]);
  });

  it('falls back to the current chat when source matches current chat', () => {
    expect(_getAgentReplyTargets('dc:brain-router', 'dc:brain-router')).toEqual([
      'dc:brain-router',
    ]);
  });

  it('extracts the source channel from the newest delegated message', () => {
    expect(
      _extractReplySourceChannelJid([
        { content: 'older direct message' },
        {
          content:
            '<source_channel jid="dc:personal-assistant" />\nCatalog this note',
        },
      ]),
    ).toBe('dc:personal-assistant');
  });

  it('does not reuse an older delegated source for a newer direct message', () => {
    expect(
      _extractReplySourceChannelJid([
        {
          content:
            '<source_channel jid="dc:personal-assistant" />\nOlder delegated message',
        },
        { content: 'Catalog this directly from brain router' },
      ]),
    ).toBeUndefined();
  });
});
