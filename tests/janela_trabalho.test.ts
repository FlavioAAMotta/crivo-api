import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { signToken } from '../src/lib/auth.js';

// Evita conexões reais com Redis ao importar as filas
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); },
  Worker: class { on = vi.fn(); },
}));

vi.mock('../src/lib/octokit.js', () => ({
  getInstallationOctokit: vi.fn(),
  withGithubRetry: (fn: any) => fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    matricula: { findMany: vi.fn() },
    equipeMembro: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    usuario: { findUnique: vi.fn() },
    trabalho: { findUnique: vi.fn() },
    equipe: { findUnique: vi.fn() },
    repositorio: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const ALUNO = { id: 2, github_id: '222', github_login: 'joaopsilva', papel: 'ALUNO' as const };
const auth = { authorization: `Bearer ${signToken(ALUNO)}` };

const DAQUI_A_POUCO = new Date(Date.now() + 3600_000);
const JA_ABRIU = new Date(Date.now() - 3600_000);

/** Uma turma com um único trabalho, cuja abertura o teste escolhe. */
function turmaComTrabalho(janelaInicio: Date, extras: Record<string, unknown> = {}) {
  return [
    {
      turma: {
        id: 1,
        nome: 'Turma A',
        periodo: '2026.1',
        disciplina: { id: 1, nome: 'Estrutura de Dados', codigo: 'ED-2026-1' },
        trabalhos: [
          {
            id: 7,
            titulo: 'Trabalho 2 — Árvore AVL',
            descricao_md: '## Objetivo\nImplementar uma AVL.',
            slug: 'ed-arvore-avl',
            tipo: 'INDIVIDUAL',
            janela_inicio: janelaInicio,
            deadline: new Date(Date.now() + 7 * 86400_000),
            congelamento_automatico: true,
            repositorios: [],
            ...extras,
          },
        ],
      },
    },
  ];
}

describe('janela do trabalho — GET /me/turmas', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.equipeMembro.findMany).mockResolvedValue([] as any);
  });

  it('mostra uma vez o trabalho compartilhado ao aluno matriculado em duas subturmas', async () => {
    const [matriculaPrincipal] = turmaComTrabalho(JA_ABRIU);
    const trabalho = matriculaPrincipal.turma.trabalhos[0];
    matriculaPrincipal.turma.trabalhos_vinculados = [{ trabalho }] as any;
    const matriculaAdicional = { turma: {
      id: 2, nome: 'Turma B', periodo: '2026.1', disciplina: matriculaPrincipal.turma.disciplina,
      trabalhos: [], trabalhos_vinculados: [{ trabalho }],
    } };
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([matriculaPrincipal, matriculaAdicional] as any);
    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });
    expect(response.statusCode).toBe(200);
    const turmas = response.json();
    expect(turmas.flatMap((t: any) => t.trabalhos).map((t: any) => t.id)).toEqual([7]);
  });

  it('aluno matriculado depois da criação vê o trabalho vinculado à sua subturma', async () => {
    const [principal] = turmaComTrabalho(JA_ABRIU);
    const matriculaNova = { turma: { id: 2, nome: 'Turma B', periodo: '2026.1',
      disciplina: principal.turma.disciplina, trabalhos: [],
      trabalhos_vinculados: [{ trabalho: principal.turma.trabalhos[0] }] } };
    vi.mocked(prisma.matricula.findMany).mockResolvedValue([matriculaNova] as any);
    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });
    expect(response.json()[0].trabalhos.map((t: any) => t.id)).toEqual([7]);
  });

  it('esconde enunciado e prazo enquanto o trabalho não abriu', async () => {
    vi.mocked(prisma.matricula.findMany).mockResolvedValue(turmaComTrabalho(DAQUI_A_POUCO) as any);

    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });

    expect(response.statusCode).toBe(200);
    const [turma] = JSON.parse(response.body);
    const trabalho = turma.trabalhos[0];

    // O aluno vê que o trabalho existe e quando abre...
    expect(trabalho.titulo).toBe('Trabalho 2 — Árvore AVL');
    expect(trabalho.tipo).toBe('INDIVIDUAL');
    expect(trabalho.janela_inicio).toBe(DAQUI_A_POUCO.toISOString());
    expect(trabalho.liberado).toBe(false);
    expect(trabalho.status).toBe('agendado');

    // ...e nada do que ele pede. O enunciado não sai do servidor.
    expect(trabalho.descricao_md).toBeNull();
    expect(trabalho.deadline).toBeNull();
  });

  it('devolve o trabalho inteiro depois da abertura', async () => {
    vi.mocked(prisma.matricula.findMany).mockResolvedValue(turmaComTrabalho(JA_ABRIU) as any);

    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });

    const trabalho = JSON.parse(response.body)[0].trabalhos[0];
    expect(trabalho.liberado).toBe(true);
    expect(trabalho.status).toBe('sem repo');
    expect(trabalho.descricao_md).toContain('Implementar uma AVL');
    expect(trabalho.deadline).not.toBeNull();
  });

  it('não esconde o trabalho de quem já tem repositório, mesmo se a janela for reagendada', async () => {
    // Professor empurrou `janela_inicio` para o futuro depois que o aluno já
    // criou o repositório: esconder agora seria esconder o trabalho dele mesmo.
    vi.mocked(prisma.matricula.findMany).mockResolvedValue(
      turmaComTrabalho(DAQUI_A_POUCO, {
        repositorios: [
          {
            id: 500,
            dono_tipo: 'ALUNO',
            usuario_id: ALUNO.id,
            equipe_id: null,
            nome_completo: 'faminas-ads/ed-avl-joaopsilva',
            github_repo_id: 900500n,
            entregas: [],
          },
        ],
      }) as any,
    );

    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });

    const trabalho = JSON.parse(response.body)[0].trabalhos[0];
    expect(trabalho.liberado).toBe(true);
    expect(trabalho.status).toBe('em andamento');
    expect(trabalho.descricao_md).not.toBeNull();
    expect(trabalho.repositorio.github_repo_id).toBe('900500');
  });

  it('resolve o repositório da equipe pelas equipes do aluno', async () => {
    vi.mocked(prisma.equipeMembro.findMany).mockResolvedValue([{ equipe_id: 42 }] as any);
    vi.mocked(prisma.matricula.findMany).mockResolvedValue(
      turmaComTrabalho(JA_ABRIU, {
        tipo: 'EQUIPE',
        repositorios: [
          {
            id: 501,
            dono_tipo: 'EQUIPE',
            usuario_id: null,
            equipe_id: 42,
            nome_completo: 'faminas-ads/ed-avl-equipe',
            github_repo_id: 900501n,
            entregas: [{ id: 1 }],
          },
        ],
      }) as any,
    );

    const response = await app.inject({ method: 'GET', url: '/me/turmas', headers: auth });

    const trabalho = JSON.parse(response.body)[0].trabalhos[0];
    expect(trabalho.repositorio.id).toBe(501);
    // Já tem Entrega => congelado.
    expect(trabalho.status).toBe('congelado');
  });
});

describe('janela do trabalho — o que trava e o que não trava antes da abertura', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aceita matrícula na subturma vinculada para o repositório individual', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({ id: ALUNO.id, github_login: 'joaopsilva' } as any);
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ id: 7, turma_id: 1, tipo: 'INDIVIDUAL',
      janela_inicio: JA_ABRIU, turma: { disciplina: { codigo: 'ED' }, matriculas: [] },
      turmas_vinculadas: [{ turma_id: 2, turma: { matriculas: [{ usuario_id: ALUNO.id }] } }],
    } as any);
    vi.mocked(prisma.repositorio.findFirst).mockResolvedValue({ id: 50 } as any);
    const response = await app.inject({ method: 'POST', url: '/trabalhos/7/repositorio', headers: auth });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Repository already exists');
    expect(prisma.repositorio.findFirst).toHaveBeenCalled();
  });

  it('isola matrícula em turma não vinculada antes de consultar repositório', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({ id: ALUNO.id, github_login: 'joaopsilva' } as any);
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({ id: 7, turma_id: 1, tipo: 'INDIVIDUAL',
      janela_inicio: JA_ABRIU, turma: { disciplina: { codigo: 'ED' }, matriculas: [] },
      turmas_vinculadas: [{ turma_id: 2, turma: { matriculas: [] } }],
    } as any);
    const response = await app.inject({ method: 'POST', url: '/trabalhos/7/repositorio', headers: auth });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('not matriculated');
    expect(prisma.repositorio.findFirst).not.toHaveBeenCalled();
  });

  it('recusa criar repositório individual antes da abertura (403)', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({ id: ALUNO.id, github_login: 'joaopsilva' } as any);
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7,
      tipo: 'INDIVIDUAL',
      slug: 'ed-arvore-avl',
      template_repo: 'faminas-ads/avl-template',
      janela_inicio: DAQUI_A_POUCO,
      turma: { disciplina: { codigo: 'ED-2026-1' }, matriculas: [{ usuario_id: ALUNO.id }] },
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/trabalhos/7/repositorio',
      headers: auth,
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toMatch(/ainda não foi liberado/);
    // Nada chegou a ser criado.
    expect(prisma.repositorio.findFirst).not.toHaveBeenCalled();
  });

  it('recusa criar repositório de equipe antes da abertura (403)', async () => {
    // O aluno é membro da equipe — a barreira que sobra é a janela, não o acesso.
    vi.mocked(prisma.equipeMembro.count).mockResolvedValue(1 as any);
    vi.mocked(prisma.equipe.findUnique).mockResolvedValue({ id: 3, trabalho_id: 7, nome: 'Grupo 01' } as any);
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7,
      tipo: 'EQUIPE',
      slug: 'ed-arvore-avl',
      template_repo: 'faminas-ads/avl-template',
      janela_inicio: DAQUI_A_POUCO,
      turma: { disciplina: { codigo: 'ED-2026-1' } },
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/equipes/3/repositorio',
      headers: auth,
    });

    expect(response.statusCode).toBe(403);
  });

  it('permite formar equipe antes da abertura — é a única coisa liberada', async () => {
    vi.mocked(prisma.trabalho.findUnique).mockResolvedValue({
      id: 7,
      tipo: 'EQUIPE',
      janela_inicio: DAQUI_A_POUCO,
      turma: { matriculas: [{ usuario_id: ALUNO.id }] },
    } as any);
    vi.mocked(prisma.equipeMembro.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) =>
      fn({
        equipe: { create: vi.fn().mockResolvedValue({ id: 9, trabalho_id: 7, nome: 'Grupo 01' }) },
        equipeMembro: { create: vi.fn().mockResolvedValue({ equipe_id: 9, usuario_id: ALUNO.id }) },
      })) as any);

    const response = await app.inject({
      method: 'POST',
      url: '/trabalhos/7/equipes',
      headers: auth,
      payload: { nome: 'Grupo 01' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).id).toBe(9);
  });
});
