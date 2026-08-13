import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { createRepositoryForTeam } from '../src/services/repo.js';
import { finalizeTeam } from '../src/services/team.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    equipe: { findUnique: vi.fn(), update: vi.fn() },
    trabalho: { findUnique: vi.fn() },
    repositorio: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock('../src/lib/octokit.js', () => ({ getInstallationOctokit: vi.fn(), withGithubRetry: (fn: any) => fn() }));
vi.mock('../src/jobs/queues.js', () => ({ enqueueRepoSetupJob: vi.fn() }));

describe('formação da equipe antes do repositório', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bloqueia o repositório enquanto a equipe não foi finalizada', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 3, formada_em: null, membros: [{ usuario: { github_login: 'a' } }, { usuario: { github_login: 'b' } }],
    } as any);
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7, turma: { disciplina: { codigo: 'API' } }, slug: 't1', template_repo: 'org/template',
      janela_inicio: new Date(Date.now() - 60_000),
    } as any);
    vi.mocked(prisma.repositorio.findFirst).mockResolvedValue(null);

    await expect(createRepositoryForTeam(3, 7)).rejects.toThrow(/Finalize a formação/);
    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('exige pelo menos dois integrantes para finalizar', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 3, lider_id: 10, formada_em: null, membros: [{ usuario_id: 10 }], repositorios: [],
      trabalho: { min_integrantes_equipe: 2, max_integrantes_equipe: 4 },
    } as any);
    await expect(finalizeTeam(3, 10)).rejects.toThrow(/pelo menos 2/);
    expect(prisma.equipe.update).not.toHaveBeenCalled();
  });

  it('respeita um mínimo maior que dois configurado no trabalho', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 3, lider_id: 10, formada_em: null, membros: [{ usuario_id: 10 }, { usuario_id: 11 }], repositorios: [],
      trabalho: { min_integrantes_equipe: 3, max_integrantes_equipe: 4 },
    } as any);
    await expect(finalizeTeam(3, 10)).rejects.toThrow(/pelo menos 3/);
    expect(prisma.equipe.update).not.toHaveBeenCalled();
  });

  it('finaliza uma equipe válida', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 3, lider_id: 10, formada_em: null, membros: [{ usuario_id: 10 }, { usuario_id: 11 }], repositorios: [],
      trabalho: { min_integrantes_equipe: 2, max_integrantes_equipe: 4 },
    } as any);
    vi.mocked(prisma.equipe.update).mockResolvedValue({ id: 3, formada_em: new Date() } as any);
    await finalizeTeam(3, 10);
    expect(prisma.equipe.update).toHaveBeenCalledWith({
      where: { id: 3 }, data: { formada_em: expect.any(Date) },
    });
  });
});
