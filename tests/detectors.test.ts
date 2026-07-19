import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { runDetectors } from '../src/detectors/index.js';

// Mock Prisma Client
vi.mock('../src/lib/prisma.js', () => {
  return {
    prisma: {
      repositorio: {
        findUnique: vi.fn(),
      },
      sinalizacao: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      push: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      commit: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
    },
  };
});

describe('Anomaly Detectors Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should flag DIVERGENCIA_PUSHER_AUTOR for individual repo when pusher is not the owner', async () => {
    const repoMock = {
      id: 1,
      dono_tipo: 'ALUNO',
      usuario: {
        id: 42,
        github_id: 100n,
        github_login: 'student-owner',
        nome: 'Student Owner',
      },
      trabalho: {
        janela_inicio: '2026-07-01T00:00:00Z',
        deadline: '2026-07-20T00:00:00Z',
      },
    };

    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue(repoMock as any);
    
    // Simulate no pending signal of this type exists
    vi.mocked(prisma.sinalizacao.findFirst).mockResolvedValue(null);

    // Mock pushes where pusher is NOT the owner
    vi.mocked(prisma.push.findMany).mockResolvedValue([
      {
        id: 9,
        pusher_github_id: 999n, // different id!
        pusher_login: 'stranger-pusher',
        forced: false,
        recebido_em: new Date(),
      },
    ] as any);

    vi.mocked(prisma.commit.findMany).mockResolvedValue([]); // no commit anomalies

    await runDetectors(1, 'push');

    // Expect DIVERGENCIA_PUSHER_AUTOR signal creation
    expect(prisma.sinalizacao.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositorio_id: 1,
        tipo: 'DIVERGENCIA_PUSHER_AUTOR',
        intensidade: 'ALTA',
        status: 'PENDENTE',
        evidencia_json: expect.objectContaining({
          context: 'individual_pusher_mismatch',
          pusher_login: 'stranger-pusher',
        }),
      }),
    });
  });

  it('should flag DIVERGENCIA_PUSHER_AUTOR for team repo on systematic dominant pusher (>70%) pattern', async () => {
    const repoMock = {
      id: 2,
      dono_tipo: 'EQUIPE',
      equipe: {
        id: 5,
        nome: 'Equipe Alpha',
        membros: [],
      },
      trabalho: {
        janela_inicio: '2026-07-01T00:00:00Z',
        deadline: '2026-07-20T00:00:00Z',
      },
    };

    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue(repoMock as any);
    vi.mocked(prisma.sinalizacao.findFirst).mockResolvedValue(null);

    // Mock requirements: >= 10 commits, >= 3 authors
    vi.mocked(prisma.commit.count).mockResolvedValue(12);
    vi.mocked(prisma.commit.groupBy).mockResolvedValue([
      { autor_email: 'a1@email.com' },
      { autor_email: 'a2@email.com' },
      { autor_email: 'a3@email.com' },
    ] as any);

    // Mock pushes where dominant-pusher is responsible for 8 out of 10 pushes (80% which is > 70%)
    vi.mocked(prisma.push.findMany).mockResolvedValue([
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'dominant-pusher', forced: false },
      { pusher_login: 'other-member', forced: false },
      { pusher_login: 'another-member', forced: false },
    ] as any);

    await runDetectors(2, 'push');

    expect(prisma.sinalizacao.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositorio_id: 2,
        tipo: 'DIVERGENCIA_PUSHER_AUTOR',
        intensidade: 'MEDIA',
        evidencia_json: expect.objectContaining({
          context: 'team_systematic_push_divergence',
          dominant_pusher: 'dominant-pusher',
          push_percentage: 80,
        }),
      }),
    });
  });
});
