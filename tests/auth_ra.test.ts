import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { verifyPreAuthToken, signPreAuthToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    usuario: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const ALUNO_PENDENTE = {
  id: 40,
  github_id: null,
  github_login: null,
  nome: 'Aluno Pendente',
  papel: 'ALUNO' as const,
  matricula: '25-99999',
  senha_hash: null as string | null,
};

describe('POST /auth/login-ra', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejeita RA inexistente', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '00-00000', senha: '00-00000' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejeita quando já vinculado ao GitHub, orientando a usar GitHub', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      ...ALUNO_PENDENTE,
      github_id: 999n,
      github_login: 'ja-vinculado',
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '25-99999', senha: '25-99999' },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toContain('GitHub');
  });

  it('rejeita senha errada no primeiro acesso (senha != RA)', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(ALUNO_PENDENTE as any);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '25-99999', senha: 'senha-errada' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('primeiro acesso: senha == RA emite token de pré-ativação etapa redefinir_senha', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(ALUNO_PENDENTE as any);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '25-99999', senha: '25-99999' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.etapa).toBe('redefinir_senha');
    expect(verifyPreAuthToken(body.preauth_token)).toEqual({
      usuario_id: 40,
      etapa: 'redefinir_senha',
    });
  });

  it('senha já trocada: credenciais corretas emitem token etapa vincular_github', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('nova-senha-123', 10);
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      ...ALUNO_PENDENTE,
      senha_hash: hash,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '25-99999', senha: 'nova-senha-123' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.etapa).toBe('vincular_github');
  });

  it('senha já trocada: credenciais erradas são rejeitadas', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash('nova-senha-123', 10);
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      ...ALUNO_PENDENTE,
      senha_hash: hash,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login-ra',
      payload: { ra: '25-99999', senha: 'chute' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /auth/redefinir-senha', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejeita sem token de pré-ativação', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/redefinir-senha',
      payload: { senha_nova: 'senha-nova-123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejeita token na etapa errada', async () => {
    const tokenEtapaErrada = signPreAuthToken({ usuario_id: 40, etapa: 'vincular_github' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/redefinir-senha',
      headers: { authorization: `Bearer ${tokenEtapaErrada}` },
      payload: { senha_nova: 'senha-nova-123' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejeita senha nova curta', async () => {
    const token = signPreAuthToken({ usuario_id: 40, etapa: 'redefinir_senha' });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/redefinir-senha',
      headers: { authorization: `Bearer ${token}` },
      payload: { senha_nova: '123' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('troca a senha e emite token para a etapa vincular_github', async () => {
    vi.mocked(prisma.usuario.update).mockResolvedValue({} as any);
    const token = signPreAuthToken({ usuario_id: 40, etapa: 'redefinir_senha' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/redefinir-senha',
      headers: { authorization: `Bearer ${token}` },
      payload: { senha_nova: 'senha-nova-123' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.etapa).toBe('vincular_github');
    expect(prisma.usuario.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 40 } }),
    );
  });
});
