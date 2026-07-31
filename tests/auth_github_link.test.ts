import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signPreAuthToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    usuario: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    emailCommit: {
      upsert: vi.fn().mockReturnValue({ catch: () => Promise.resolve() }),
    },
  },
}));

function mockFetchSequence(userProfile: Record<string, unknown>) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({ json: async () => ({ access_token: 'tok' }) }); // troca de code
  fetchMock.mockResolvedValueOnce({ json: async () => userProfile }); // perfil
  fetchMock.mockResolvedValueOnce({ ok: false }); // e-mails (não usado no modo vínculo)
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GET /auth/github/callback', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('sem state: fluxo normal continua funcionando e agora redireciona pro front', async () => {
    mockFetchSequence({ id: 555, login: 'novo-aluno', name: 'Novo Aluno' });
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.usuario.create).mockResolvedValue({
      id: 1, github_id: 555n, github_login: 'novo-aluno', nome: 'Novo Aluno', papel: 'ALUNO',
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?code=abc',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('http://localhost:5173/auth/callback?token=');
  });

  it('state inválido: 401', async () => {
    mockFetchSequence({ id: 555, login: 'x', name: 'X' });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/github/callback?code=abc&state=token-invalido',
    });

    expect(response.statusCode).toBe(401);
  });

  it('state com etapa errada (redefinir_senha): 400', async () => {
    mockFetchSequence({ id: 555, login: 'x', name: 'X' });
    const state = signPreAuthToken({ usuario_id: 40, etapa: 'redefinir_senha' });

    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('github_id já pertence a outro usuário: 409, nenhuma escrita', async () => {
    mockFetchSequence({ id: 555, login: 'ja-de-outro', name: 'X' });
    const state = signPreAuthToken({ usuario_id: 40, etapa: 'vincular_github' });
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({ id: 99, github_id: 555n } as any);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
    });

    expect(response.statusCode).toBe(409);
    expect(prisma.usuario.update).not.toHaveBeenCalled();
  });

  it('sucesso: vincula github_id/github_login ao usuário do token e redireciona pro front', async () => {
    mockFetchSequence({ id: 555, login: 'aluno-vinculando', name: 'Aluno Vinculando' });
    const state = signPreAuthToken({ usuario_id: 40, etapa: 'vincular_github' });

    vi.mocked(prisma.usuario.findUnique)
      .mockResolvedValueOnce(null) // conflito por github_id: nenhum
      .mockResolvedValueOnce({ id: 40, papel: 'ALUNO' } as any); // usuário pendente existe

    vi.mocked(prisma.usuario.update).mockResolvedValue({
      id: 40,
      github_id: 555n,
      github_login: 'aluno-vinculando',
      papel: 'ALUNO',
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=abc&state=${state}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('http://localhost:5173/auth/callback?token=');
    expect(prisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 40 },
      data: { github_id: 555n, github_login: 'aluno-vinculando' },
    });
  });
});
