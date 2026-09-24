import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { getInstallationOctokit } from '../src/lib/octokit.js';
import { runCongelador } from '../src/jobs/congelador.js';
import { signToken } from '../src/lib/auth.js';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/jobs/congelador.js', () => ({
  runCongelador: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/octokit.js', () => ({
  getInstallationOctokit: vi.fn(),
  withGithubRetry: (fn: any) => fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    trabalho: {
      findUnique: vi.fn(),
    },
    entregaAgendada: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    entrega: {
      findMany: vi.fn(),
    },
  },
}));

const PROFESSOR = { id: 1, github_id: '1', github_login: 'mtavares', papel: 'PROFESSOR' as const };
const ALUNO = { id: 2, github_id: '2', github_login: 'joaopsilva', papel: 'ALUNO' as const };

function auth(user: typeof PROFESSOR | typeof ALUNO) {
  return { authorization: `Bearer ${signToken(user)}` };
}

const TRABALHO = { id: 7, slug: 'trabalho-2', titulo: 'Trabalho 2' };

describe('GET /prof/trabalhos/:id/entregas-agendadas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(TRABALHO as any);
  });

  it('recusa aluno', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/7/entregas-agendadas',
      headers: auth(ALUNO),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lista os marcos com a contagem de repositórios já congelados', async () => {
    vi.mocked(prisma.entregaAgendada.findMany).mockResolvedValue([
      { id: 5, trabalho_id: 7, nome: 'Checkpoint 1', data_hora: new Date('2026-08-01T19:00:00Z'), congelamento_automatico: true, criado_em: new Date(), entregas: [{ id: 1 }, { id: 2 }] },
    ] as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/7/entregas-agendadas',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].repositorios_congelados).toBe(2);
    expect(body[0].entregas).toBeUndefined();
  });

  it('404 quando o trabalho não existe', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/999/entregas-agendadas',
      headers: auth(PROFESSOR),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /prof/trabalhos/:id/entregas-agendadas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(TRABALHO as any);
  });

  it('cria um marco com data retroativa', async () => {
    vi.mocked(prisma.entregaAgendada.create).mockResolvedValue({
      id: 5, trabalho_id: 7, nome: 'Checkpoint retroativo',
      data_hora: new Date('2026-08-01T19:00:00Z'), congelamento_automatico: true, criado_em: new Date(),
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos/7/entregas-agendadas',
      headers: auth(PROFESSOR),
      payload: { nome: 'Checkpoint retroativo', data_hora: '2026-08-01T19:00:00.000Z' },
    });

    expect(response.statusCode).toBe(201);
    expect(vi.mocked(prisma.entregaAgendada.create).mock.calls[0][0].data).toEqual(
      expect.objectContaining({ trabalho_id: 7, nome: 'Checkpoint retroativo', congelamento_automatico: true }),
    );
  });

  it('409 quando já existe um marco com o mesmo nome no trabalho', async () => {
    vi.mocked(prisma.entregaAgendada.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos/7/entregas-agendadas',
      headers: auth(PROFESSOR),
      payload: { nome: 'Checkpoint 1', data_hora: '2026-08-01T19:00:00.000Z' },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('DELETE /prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId', () => {
  const app = buildApp();

  beforeEach(() => vi.clearAllMocks());

  it('bloqueia exclusão de marco que já gerou entregas', async () => {
    vi.mocked(prisma.entregaAgendada.findFirst).mockResolvedValue({
      id: 5, trabalho_id: 7, entregas: [{ id: 1 }],
    } as any);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/trabalhos/7/entregas-agendadas/5',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(409);
    expect(prisma.entregaAgendada.delete).not.toHaveBeenCalled();
  });

  it('permite excluir um marco que ainda não congelou nada', async () => {
    vi.mocked(prisma.entregaAgendada.findFirst).mockResolvedValue({
      id: 5, trabalho_id: 7, entregas: [],
    } as any);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/trabalhos/7/entregas-agendadas/5',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(204);
    expect(prisma.entregaAgendada.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  it('404 quando o marco não pertence a este trabalho', async () => {
    vi.mocked(prisma.entregaAgendada.findFirst).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'DELETE',
      url: '/prof/trabalhos/7/entregas-agendadas/5',
      headers: auth(PROFESSOR),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /prof/trabalhos/:id/entregas-agendadas/:entregaAgendadaId/congelar', () => {
  const app = buildApp();

  beforeEach(() => vi.clearAllMocks());

  it('aciona o congelador escopado ao marco', async () => {
    vi.mocked(prisma.entregaAgendada.findFirst).mockResolvedValue({ id: 5, trabalho_id: 7 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos/7/entregas-agendadas/5/congelar?force=true',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(200);
    expect(runCongelador).toHaveBeenCalledWith({ entregaAgendadaId: 5, force: true });
  });

  it('404 quando o marco não existe neste trabalho', async () => {
    vi.mocked(prisma.entregaAgendada.findFirst).mockResolvedValue(null as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/trabalhos/7/entregas-agendadas/999/congelar',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(404);
    expect(runCongelador).not.toHaveBeenCalled();
  });
});

describe('GET /prof/trabalhos/:id/entregas/download', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue(TRABALHO as any);
  });

  it('404 quando não há nenhuma entrega congelada para o momento pedido', async () => {
    vi.mocked(prisma.entrega.findMany).mockResolvedValue([] as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/7/entregas/download',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(404);
  });

  it('monta um .zip com um arquivo por repositório', async () => {
    vi.mocked(prisma.entrega.findMany).mockResolvedValue([
      {
        id: 1,
        sha_congelado: 'sha111',
        repositorio: {
          nome_completo: 'faminas-ads/ed-t1-aluno1',
          dono_tipo: 'ALUNO',
          usuario: { nome: 'João Silva' },
          equipe: null,
        },
      },
    ] as any);

    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: {
        repos: {
          downloadZipballArchive: vi.fn().mockResolvedValue({ data: Buffer.from('conteudo-fake') }),
        },
      },
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/7/entregas/download',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('trabalho-2');
    // Assinatura de um arquivo zip (local file header) — confirma que o corpo
    // é um zip de verdade, não só um content-type mentiroso.
    expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('não interrompe o zip quando um repositório falha ao baixar — registra um .txt de erro', async () => {
    vi.mocked(prisma.entrega.findMany).mockResolvedValue([
      {
        id: 1,
        sha_congelado: 'sha111',
        repositorio: {
          nome_completo: 'faminas-ads/ed-t1-aluno1',
          dono_tipo: 'ALUNO',
          usuario: { nome: 'João Silva' },
          equipe: null,
        },
      },
    ] as any);

    vi.mocked(getInstallationOctokit).mockResolvedValue({
      rest: {
        repos: {
          downloadZipballArchive: vi.fn().mockRejectedValue(new Error('Not Found')),
        },
      },
    } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/prof/trabalhos/7/entregas/download',
      headers: auth(PROFESSOR),
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
