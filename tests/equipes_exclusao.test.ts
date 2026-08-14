import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { deleteTeam } from '../src/services/team.js';
import { buildApp } from '../src/index.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    equipe: { findUnique: vi.fn(), delete: vi.fn() },
  },
}));

describe('exclusão de equipe pelo criador', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 quando a equipe não existe', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue(null as any);
    await expect(deleteTeam(1, 10)).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.equipe.delete).not.toHaveBeenCalled();
  });

  it('403 quando quem pede não é o líder', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 1, lider_id: 10, repositorios: [],
    } as any);
    await expect(deleteTeam(1, 11)).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.equipe.delete).not.toHaveBeenCalled();
  });

  it('409 quando a equipe já tem repositório', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 1, lider_id: 10, repositorios: [{ id: 99 }],
    } as any);
    await expect(deleteTeam(1, 10)).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.equipe.delete).not.toHaveBeenCalled();
  });

  it('permite ao líder excluir uma equipe ainda sem repositório', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({
      id: 1, lider_id: 10, repositorios: [],
    } as any);
    vi.mocked(prisma.equipe.delete).mockResolvedValue({ id: 1 } as any);

    await deleteTeam(1, 10);

    expect(prisma.equipe.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

describe('DELETE /equipes/:id', () => {
  const app = buildApp();
  const LIDER = { id: 10, github_id: '10', github_login: 'lider', papel: 'ALUNO' as const };
  const OUTRO = { id: 11, github_id: '11', github_login: 'outro', papel: 'ALUNO' as const };
  const auth = (user: typeof LIDER) => ({ authorization: `Bearer ${signToken(user)}` });

  beforeEach(() => vi.clearAllMocks());

  it('exige autenticação', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/equipes/1' });
    expect(response.statusCode).toBe(401);
  });

  it('204 quando o líder exclui a própria equipe sem repositório', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({ id: 1, lider_id: 10, repositorios: [] } as any);
    vi.mocked(prisma.equipe.delete).mockResolvedValue({ id: 1 } as any);

    const response = await app.inject({ method: 'DELETE', url: '/equipes/1', headers: auth(LIDER) });

    expect(response.statusCode).toBe(204);
  });

  it('403 quando quem não é o líder tenta excluir', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({ id: 1, lider_id: 10, repositorios: [] } as any);

    const response = await app.inject({ method: 'DELETE', url: '/equipes/1', headers: auth(OUTRO) });

    expect(response.statusCode).toBe(403);
    expect(prisma.equipe.delete).not.toHaveBeenCalled();
  });

  it('409 quando a equipe já tem repositório criado', async () => {
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({ id: 1, lider_id: 10, repositorios: [{ id: 500 }] } as any);

    const response = await app.inject({ method: 'DELETE', url: '/equipes/1', headers: auth(LIDER) });

    expect(response.statusCode).toBe(409);
    expect(prisma.equipe.delete).not.toHaveBeenCalled();
  });
});
