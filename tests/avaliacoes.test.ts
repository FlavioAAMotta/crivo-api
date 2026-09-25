import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
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
    avaliacao: {
      upsert: vi.fn(),
    },
  },
}));

const PROFESSOR = { id: 1, github_id: '111', github_login: 'prof', papel: 'PROFESSOR' as const };
const ALUNO = { id: 10, github_id: '1010', github_login: 'aluno', papel: 'ALUNO' as const };

function auth(user: typeof PROFESSOR | typeof ALUNO) {
  return { authorization: `Bearer ${signToken(user)}` };
}

describe('PUT /prof/repositorios/:id/avaliacao', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue({ id: 1 } as any);
  });

  it('exige autenticação', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/repositorios/1/avaliacao',
      payload: { nota: 8.5 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('bloqueia aluno', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/repositorios/1/avaliacao',
      headers: auth(ALUNO),
      payload: { nota: 8.5 },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lança nota e comentário, registrando quem avaliou', async () => {
    vi.mocked(prisma.avaliacao.upsert).mockResolvedValue({
      id: 1,
      repositorio_id: 1,
      nota: 8.5,
      comentario: 'Bom trabalho, faltou testar o caso de borda.',
      avaliado_por: PROFESSOR.id,
    } as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/repositorios/1/avaliacao',
      headers: auth(PROFESSOR),
      payload: { nota: 8.5, comentario: 'Bom trabalho, faltou testar o caso de borda.' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.nota).toBe(8.5);
    expect(prisma.avaliacao.upsert).toHaveBeenCalledWith({
      where: { repositorio_id: 1 },
      create: {
        repositorio_id: 1,
        nota: 8.5,
        comentario: 'Bom trabalho, faltou testar o caso de borda.',
        avaliado_por: PROFESSOR.id,
      },
      update: {
        nota: 8.5,
        comentario: 'Bom trabalho, faltou testar o caso de borda.',
        avaliado_por: PROFESSOR.id,
      },
    });
  });

  it('aceita nota fora do intervalo 0-10 (escala livre por enquanto)', async () => {
    vi.mocked(prisma.avaliacao.upsert).mockResolvedValue({
      id: 1,
      repositorio_id: 1,
      nota: 11,
      comentario: null,
      avaliado_por: PROFESSOR.id,
    } as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/repositorios/1/avaliacao',
      headers: auth(PROFESSOR),
      payload: { nota: 11 },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.nota).toBe(11);
  });

  it('retorna 404 para repositório inexistente', async () => {
    vi.mocked(prisma.repositorio.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'PATCH',
      url: '/prof/repositorios/999/avaliacao',
      headers: auth(PROFESSOR),
      payload: { nota: 8 },
    });

    expect(response.statusCode).toBe(404);
    expect(prisma.avaliacao.upsert).not.toHaveBeenCalled();
  });
});
