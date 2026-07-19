import { describe, it, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { buildApp } from '../src/index.js';
import crypto from 'crypto';

// Mock BullMQ completely to prevent Redis connections in tests
vi.mock('bullmq', () => {
  return {
    Queue: vi.fn().mockImplementation(() => ({
      add: vi.fn(),
    })),
    Worker: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
    })),
  };
});

// Mock Queues helper
vi.mock('../src/jobs/queues.js', () => {
  return {
    enqueueStatsJob: vi.fn(),
    enqueueDetectorJob: vi.fn(),
  };
});

// Mock Prisma Client
vi.mock('../src/lib/prisma.js', () => {
  return {
    prisma: {
      repositorio: {
        findUnique: vi.fn(),
      },
      push: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      commit: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      emailCommit: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn((callback) => callback(prisma)),
    },
  };
});

describe('Email commit author resolution', () => {
  const app = buildApp();
  const secret = 'mock_webhook_secret';

  function getSignature(body: string) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  }

  it('should resolve autor_usuario_id when author email is registered', async () => {
    const payloadObj = {
      repository: { id: 100 },
      sender: { id: 200, login: 'student1' },
      ref: 'refs/heads/main',
      commits: [
        {
          id: 'sha1',
          message: 'fixed bug',
          timestamp: '2026-07-19T12:00:00Z',
          author: { name: 'Student One', email: 'registered@college.edu' },
        },
      ],
    };
    const payload = JSON.stringify(payloadObj);

    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      nome_completo: 'faminas-ads/lab-1',
      github_repo_id: 100n,
    } as any);

    vi.mocked(prisma.push.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.commit.findUnique).mockResolvedValue(null);
    
    // Simulate that email is registered in db
    vi.mocked(prisma.emailCommit.findUnique).mockResolvedValue({
      usuario_id: 99,
      email: 'registered@college.edu',
    } as any);

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': getSignature(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-id-1',
      },
      payload,
    });

    // Expect commit.create to have been called with the resolved author's ID (99)
    expect(prisma.commit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        autor_usuario_id: 99,
        autor_email: 'registered@college.edu',
      }),
    });
  });

  it('should set autor_usuario_id to null when author email is unrecognized', async () => {
    const payloadObj = {
      repository: { id: 100 },
      sender: { id: 200, login: 'student1' },
      ref: 'refs/heads/main',
      commits: [
        {
          id: 'sha2',
          message: 'docs update',
          timestamp: '2026-07-19T13:00:00Z',
          author: { name: 'Stranger Coder', email: 'intruder@unknown.com' },
        },
      ],
    };
    const payload = JSON.stringify(payloadObj);

    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      nome_completo: 'faminas-ads/lab-1',
      github_repo_id: 100n,
    } as any);

    vi.mocked(prisma.push.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.commit.findUnique).mockResolvedValue(null);
    
    // Simulate email not registered
    vi.mocked(prisma.emailCommit.findUnique).mockResolvedValue(null);

    await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': getSignature(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-id-2',
      },
      payload,
    });

    // Expect commit.create to be called with autor_usuario_id as null
    expect(prisma.commit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        autor_usuario_id: null,
        autor_email: 'intruder@unknown.com',
      }),
    });
  });
});
