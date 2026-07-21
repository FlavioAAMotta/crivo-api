import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { enqueueStatsJob, enqueueDetectorJob } from '../src/jobs/queues.js';

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

// Mock BullMQ Queues
vi.mock('../src/jobs/queues.js', () => {
  return {
    enqueueStatsJob: vi.fn(),
    enqueueDetectorJob: vi.fn(),
  };
});

describe('POST /webhooks/github', () => {
  const app = buildApp();
  const secret = 'mock_webhook_secret';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Utility to generate signatures
  function getSignature(body: string) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  }

  it('should return 401 if HMAC signature header is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ zen: 'Hello' }),
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toContain('Invalid webhook signature');
  });

  it('should return 401 if HMAC signature header is invalid', async () => {
    const payload = JSON.stringify({ zen: 'Hello' });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid_hash',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  // Regressão: se a verificação passasse a rodar sobre JSON.stringify(request.body) em vez
  // do buffer cru, qualquer diferença de formatação preservada pelo GitHub (espaços, ordem,
  // escapes unicode) quebraria assinaturas legítimas — e, pior, um payload reserializado
  // por um proxy passaria a validar. O teste fixa que a conta é feita sobre os bytes recebidos.
  it('verifica o HMAC sobre o raw body: payload reserializado falha a assinatura', async () => {
    // Bytes que o "GitHub" enviou e sobre os quais a assinatura foi calculada.
    const rawPayload = '{"zen":  "Hello",\n  "hook_id": 42}';
    const signature = getSignature(rawPayload);

    // Mesmo objeto, serialização diferente (é o que JSON.parse -> JSON.stringify produz).
    const reserialized = JSON.stringify(JSON.parse(rawPayload));
    expect(reserialized).not.toBe(rawPayload);

    // O raw body original valida.
    const original = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'ping',
        'x-github-delivery': 'raw-body-1',
      },
      payload: rawPayload,
    });
    expect(original.statusCode).toBe(200);

    // O payload reserializado, com a MESMA assinatura, deve ser rejeitado.
    const tampered = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'ping',
        'x-github-delivery': 'raw-body-2',
      },
      payload: reserialized,
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('should return 200 on ping event with valid signature', async () => {
    const payload = JSON.stringify({ zen: 'Hello' });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': getSignature(payload),
        'x-github-event': 'ping',
        'x-github-delivery': '12345',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
  });

  it('should persist push and enqueue jobs on a valid push event', async () => {
    const payloadObj = {
      repository: { id: 98765 },
      sender: { id: 1111, login: 'pusher-boy' },
      ref: 'refs/heads/main',
      forced: false,
      commits: [
        {
          id: 'commitsha123',
          message: 'Feat: something cool',
          timestamp: '2026-07-19T14:50:00Z',
          author: { name: 'Coder Aluno', email: 'aluno@faculdade.com' },
        },
      ],
    };
    const payload = JSON.stringify(payloadObj);

    // Mock DB finds repo but push doesn't exist yet (idempotency ok)
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      nome_completo: 'faminas-ads/test-repo',
      github_repo_id: 98765n,
    } as any);

    vi.mocked(prisma.push.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.emailCommit.findUnique).mockResolvedValue({
      usuario_id: 42,
      email: 'aluno@faculdade.com',
    } as any);

    vi.mocked(prisma.commit.findUnique).mockResolvedValue(null);
    
    vi.mocked(prisma.push.create).mockResolvedValue({ id: 5 } as any);
    vi.mocked(prisma.commit.create).mockResolvedValue({ id: 6, repositorio_id: 1, sha: 'commitsha123' } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': getSignature(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'unique-delivery-id-999',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.push.create).toHaveBeenCalled();
    expect(prisma.commit.create).toHaveBeenCalled();
    
    // Check that jobs were enqueued
    expect(enqueueStatsJob).toHaveBeenCalledWith(6, 'faminas-ads/test-repo', 'commitsha123');
    expect(enqueueDetectorJob).toHaveBeenCalledWith(1, 'push');
  });

  it('should return 200 and skip database save if push is duplicate (idempotency)', async () => {
    const payloadObj = {
      repository: { id: 98765 },
      sender: { id: 1111, login: 'pusher-boy' },
    };
    const payload = JSON.stringify(payloadObj);

    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      nome_completo: 'faminas-ads/test-repo',
      github_repo_id: 98765n,
    } as any);

    // Mock that push exists already
    vi.mocked(prisma.push.findUnique).mockResolvedValue({
      id: 5,
      github_delivery_id: 'duplicate-delivery-111',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': getSignature(payload),
        'x-github-event': 'push',
        'x-github-delivery': 'duplicate-delivery-111',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe('Push already processed');
    expect(prisma.push.create).not.toHaveBeenCalled();
  });
});
