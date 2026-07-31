import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    usuario: { upsert: vi.fn(), findMany: vi.fn() },
    matricula: { upsert: vi.fn(), findMany: vi.fn() },
  },
}));

const PROFESSOR = { id: 1, github_id: '1', github_login: 'prof1', papel: 'PROFESSOR' as const };
const authProf = { authorization: `Bearer ${signToken(PROFESSOR)}` };

describe('POST /prof/turmas/:id/matriculas (RA)', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exige papel professor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/prof/turmas/5/matriculas',
      payload: { matriculas: [{ ra: '25-13353', nome: 'Breno Moreira Soares' }] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('cria usuario novo por RA sem tocar em github_id/github_login e vincula a turma', async () => {
    vi.mocked(prisma.usuario.upsert).mockResolvedValue({ id: 50, matricula: '25-13353' } as any);
    vi.mocked(prisma.matricula.upsert).mockResolvedValue({} as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/turmas/5/matriculas',
      headers: authProf,
      payload: { matriculas: [{ ra: '25-13353', nome: 'Breno Moreira Soares' }] },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.imported).toEqual(['25-13353']);
    expect(prisma.usuario.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matricula: '25-13353' },
        create: expect.objectContaining({
          matricula: '25-13353',
          nome: 'Breno Moreira Soares',
          papel: 'ALUNO',
          github_id: null,
          github_login: null,
          senha_hash: null,
        }),
      }),
    );
    expect(prisma.matricula.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usuario_id_turma_id: { usuario_id: 50, turma_id: 5 } },
      }),
    );
  });
});

describe('GET /prof/turmas/:id/matriculas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista o status de ativação de cada matriculado', async () => {
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([
      {
        usuario_id: 50,
        turma_id: 5,
        usuario: {
          id: 50,
          nome: 'Breno Moreira Soares',
          matricula: '25-13353',
          github_login: null,
          github_id: null,
          senha_hash: 'algum-hash',
        },
      },
    ] as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/turmas/5/matriculas',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([
      {
        usuario_id: 50,
        nome: 'Breno Moreira Soares',
        matricula: '25-13353',
        github_login: null,
        senha_definida: true,
        vinculado: false,
      },
    ]);
  });
});
