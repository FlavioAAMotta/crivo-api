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
    trabalho: {
      findUnique: vi.fn(),
    },
  },
}));

const ALUNO_MATRICULADO = { id: 10, github_id: '1010', github_login: 'aluno-turma', papel: 'ALUNO' as const };
const ALUNO_DE_FORA = { id: 99, github_id: '9999', github_login: 'aluno-de-fora', papel: 'ALUNO' as const };

function auth(user: typeof ALUNO_MATRICULADO) {
  return { authorization: `Bearer ${signToken(user)}` };
}

/** Trabalho em equipe com duas equipes: uma com repositório, outra sem. */
function trabalhoComEquipes() {
  return {
    id: 1,
    tipo: 'EQUIPE',
    turma: {
      matriculas: [{ usuario_id: ALUNO_MATRICULADO.id }, { usuario_id: 11 }, { usuario_id: 12 }],
    },
    equipes: [
      {
        id: 1,
        nome: 'Equipe Barramento',
        membros: [{ usuario_id: ALUNO_MATRICULADO.id }, { usuario_id: 11 }],
        repositorios: [{ id: 500 }],
      },
      {
        id: 2,
        nome: 'Grupo 02',
        membros: [{ usuario_id: 12 }],
        repositorios: [],
      },
    ],
  };
}

describe('GET /trabalhos/:id/equipes', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exige autenticação', async () => {
    const response = await app.inject({ method: 'GET', url: '/trabalhos/1/equipes' });
    expect(response.statusCode).toBe(401);
  });

  it('lista as equipes com tamanho e status, sem expor os membros', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(trabalhoComEquipes() as any);

    const response = await app.inject({
      method: 'GET',
      url: '/trabalhos/1/equipes',
      headers: auth(ALUNO_MATRICULADO),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);

    const barramento = body.find((e: any) => e.id === 1);
    expect(barramento.total_integrantes).toBe(2);
    // Repositório criado => completo, e é a equipe do requisitante.
    expect(barramento.status).toBe('completo');
    expect(barramento.tem_repositorio).toBe(true);
    expect(barramento.sou_membro).toBe(true);
    // Privacidade: a composição não vaza.
    expect(barramento.membros).toBeUndefined();

    const grupo02 = body.find((e: any) => e.id === 2);
    // Sem repositório => ainda formando, e não é a equipe do requisitante.
    expect(grupo02.status).toBe('formando');
    expect(grupo02.sou_membro).toBe(false);
  });

  it('bloqueia aluno não matriculado na turma do trabalho', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(trabalhoComEquipes() as any);

    const response = await app.inject({
      method: 'GET',
      url: '/trabalhos/1/equipes',
      headers: auth(ALUNO_DE_FORA),
    });

    expect(response.statusCode).toBe(403);
  });

  it('retorna 404 para trabalho inexistente', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'GET',
      url: '/trabalhos/999/equipes',
      headers: auth(ALUNO_MATRICULADO),
    });

    expect(response.statusCode).toBe(404);
  });

  it('devolve lista vazia para trabalho individual (sem equipes)', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 2,
      tipo: 'INDIVIDUAL',
      turma: { matriculas: [{ usuario_id: ALUNO_MATRICULADO.id }] },
      equipes: [],
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/trabalhos/2/equipes',
      headers: auth(ALUNO_MATRICULADO),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it('id não numérico vira NaN e resolve como trabalho inexistente (404)', async () => {
    // O schema do projeto (`z.string().transform(Number)`) não rejeita 'abc':
    // transforma em NaN. Num banco real, `id: NaN` não acha nada -> 404.
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'GET',
      url: '/trabalhos/abc/equipes',
      headers: auth(ALUNO_MATRICULADO),
    });

    expect(response.statusCode).toBe(404);
  });
});
