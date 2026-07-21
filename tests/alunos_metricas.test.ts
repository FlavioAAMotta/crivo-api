import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { getRepositoryMetrics } from '../src/services/metrics.js';
import { signToken } from '../src/lib/auth.js';

// Evita conexões reais com Redis ao importar as filas
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    repositorio: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/services/metrics.js', () => ({
  getRepositoryMetrics: vi.fn(),
}));

const ALUNO_DONO = { id: 10, github_id: '1010', github_login: 'aluno-dono', papel: 'ALUNO' as const };
const ALUNO_INTRUSO = { id: 20, github_id: '2020', github_login: 'aluno-intruso', papel: 'ALUNO' as const };

function auth(user: typeof ALUNO_DONO) {
  return { authorization: `Bearer ${signToken(user)}` };
}

describe('GET /me/repositorios/:id/metricas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRepositoryMetrics).mockResolvedValue({
      repositorio: { id: 1, nome_completo: 'faminas-ads/repo' },
      total_commits: 3,
      commits: [{ sha: 'abc', additions: 10, deletions: 2 }],
      timeline_commits: [{ date: '2026-07-20', count: 3 }],
      sinalizacoes: [{ id: 7, tipo: 'FORCE_PUSH' }],
    } as any);
  });

  it('exige autenticação', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me/repositorios/1/metricas',
    });

    expect(response.statusCode).toBe(401);
  });

  it('retorna ao aluno dono as mesmas métricas que o professor vê (transparência)', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      dono_tipo: 'ALUNO',
      usuario_id: ALUNO_DONO.id,
      equipe: null,
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/me/repositorios/1/metricas',
      headers: auth(ALUNO_DONO),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // commits, linhas, distribuição temporal e sinalizações
    expect(body.commits[0].additions).toBe(10);
    expect(body.timeline_commits).toHaveLength(1);
    expect(body.sinalizacoes[0].tipo).toBe('FORCE_PUSH');
    expect(getRepositoryMetrics).toHaveBeenCalledWith(1);
  });

  it('bloqueia aluno tentando ver métricas do repositório de outro aluno', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 1,
      dono_tipo: 'ALUNO',
      usuario_id: ALUNO_DONO.id,
      equipe: null,
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/me/repositorios/1/metricas',
      headers: auth(ALUNO_INTRUSO),
    });

    expect(response.statusCode).toBe(403);
    // O vazamento seria calcular as métricas mesmo negando: garante que nem chegou lá.
    expect(getRepositoryMetrics).not.toHaveBeenCalled();
  });

  it('permite membro da equipe e bloqueia não-membro em repositório de equipe', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({
      id: 2,
      dono_tipo: 'EQUIPE',
      usuario_id: null,
      equipe: { membros: [{ usuario_id: ALUNO_DONO.id }] },
    } as any);

    const membro = await app.inject({
      method: 'GET',
      url: '/me/repositorios/2/metricas',
      headers: auth(ALUNO_DONO),
    });
    expect(membro.statusCode).toBe(200);

    const naoMembro = await app.inject({
      method: 'GET',
      url: '/me/repositorios/2/metricas',
      headers: auth(ALUNO_INTRUSO),
    });
    expect(naoMembro.statusCode).toBe(403);
  });

  it('retorna 404 para repositório inexistente', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'GET',
      url: '/me/repositorios/999/metricas',
      headers: auth(ALUNO_DONO),
    });

    expect(response.statusCode).toBe(404);
  });
});
