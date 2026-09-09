import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { logger } from './logger';

describe('frontend logger IPC payloads', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('preserves nested structured data for backend redaction', () => {
    logger.info('provider response', {
      nested: {
        apiKey: 'secret-key',
      },
      tokenCount: 2,
    });

    expect(invokeMock).toHaveBeenCalledWith('log_frontend_message', {
      level: 'info',
      message: 'provider response',
      data: [
        {
          nested: {
            apiKey: 'secret-key',
          },
          tokenCount: 2,
        },
      ],
    });
  });
});
