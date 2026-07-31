# Login por RA + vínculo obrigatório de GitHub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o professor importar alunos por RA+Nome (colado direto de planilha, sem GitHub), e fazer o aluno ativar a conta via RA+senha (senha inicial = RA), troca de senha obrigatória, e vínculo obrigatório do GitHub — a partir do qual só GitHub OAuth é usado.

**Architecture:** `crivo-api` ganha um segundo namespace de JWT ("token de pré-ativação", curto, com `etapa`) totalmente separado da sessão normal; o RA vira o campo âncora e único em `Usuario`, e `github_id`/`github_login` passam a ser opcionais até o vínculo. O callback do GitHub existente é estendido para, quando receber um `state` com um token de pré-ativação, vincular em vez de logar/criar. `crivo-front` ganha duas telas novas de ativação e reescreve a tela de login e a aba de import de matrículas. `mock-server` replica os três endpoints novos e o fluxo de vínculo com contas fictícias.

**Tech Stack:** Fastify 5 + Zod + Prisma/PostgreSQL + `bcryptjs` (novo) no backend; React 19 + react-router-dom 7 no front; Vitest nos dois repos.

## Global Constraints

- Domínio em português nos nomes de campo/rota (`ra`, `senha`, `matricula`, `vincular`), consistente com o resto do schema.
- `strict: true` no `tsconfig.json` da API — toda mudança de nullability em `Usuario.github_id`/`github_login` precisa ser resolvida com asserção `!` nos pontos onde o dado é *garantidamente* não-nulo (repositório já existe ⇒ dono já vinculado), nunca com `as any`.
- Sem `prisma db push` — toda mudança de schema é uma migration em `prisma/migrations/`.
- Nenhuma tela nova do front recebe teste automatizado de componente (convenção do projeto: telas se verificam rodando contra o mock); só lógica pura (`src/lib/*`) ganha teste Vitest.
- `bcryptjs` (não `bcrypt` nativo) — evita compilação nativa (node-gyp) em ambiente Windows sem toolchain garantido.
- Todo teste de rota no backend segue o padrão já existente: `app.inject()`, mock de `prisma` por model com `vi.mock('../src/lib/prisma.js', ...)`, mock de `bullmq` com classes (`class { add = vi.fn(); }`), `signToken`/tokens reais gerados via os próprios helpers (não strings fixas).

---

## Task 1: Schema — RA como âncora, GitHub opcional, campos de senha

**Files:**
- Modify: `crivo-api/prisma/schema.prisma`
- Modify: `crivo-api/prisma/seed.ts`
- Modify: `crivo-api/package.json` (dependências)
- Create: `crivo-api/prisma/migrations/<timestamp>_ra_como_ancora_de_identidade/` (gerado pelo Prisma)

**Interfaces:**
- Produces: `Usuario.github_id: BigInt | null`, `Usuario.github_login: String | null`, `Usuario.matricula: String | null @unique` (era `String?` sem unique), `Usuario.senha_hash: String | null`, `Usuario.senha_redefinida_em: DateTime | null`. Todas as tasks seguintes dependem deste shape.

- [ ] **Step 1: Editar o schema**

Em `crivo-api/prisma/schema.prisma`, no `model Usuario`, trocar o bloco de campos escalares por:

```prisma
model Usuario {
  id                  Int       @id @default(autoincrement())
  github_id           BigInt?   @unique
  github_login        String?   @unique
  nome                String
  papel               Papel
  matricula           String?   @unique
  senha_hash          String?
  senha_redefinida_em DateTime?
  criado_em           DateTime  @default(now())

  emails            EmailCommit[]
  matriculas        Matricula[]
  equipe_membros    EquipeMembro[]
  repositorios      Repositorio[]
  revisoes          Sinalizacao[]  @relation("RevisorSinalizacao")
  commits           Commit[]

  @@map("usuarios")
}
```

(Só `github_id`, `github_login` ganham `?`; `matricula` ganha `@unique` mantendo o `?`; `senha_hash`/`senha_redefinida_em` são novos. `matricula` continua opcional porque professores nunca têm RA — só fica único quando presente, igual `github_id`/`github_login` hoje.)

- [ ] **Step 2: Instalar bcryptjs**

Run: `cd crivo-api; npm install bcryptjs; npm install -D @types/bcryptjs`

- [ ] **Step 3: Gerar e aplicar a migration**

Run: `cd crivo-api; npx prisma migrate dev --name ra_como_ancora_de_identidade`
Expected: migration criada em `prisma/migrations/`, aplicada no Postgres local sem erro (dados existentes de seed já têm `matricula` preenchido nos alunos e `null` no professor — nenhum dado viola o novo `@unique`).

- [ ] **Step 4: Adicionar um aluno pendente de exemplo no seed**

Em `crivo-api/prisma/seed.ts`, depois do bloco `// 4. Seed Alunos` (após a criação de `aluno3`, antes de `console.log('Seeded Alunos: ...')`), adicionar:

```ts
  const aluno4Pendente = await prisma.usuario.upsert({
    where: { matricula: '25-99999' },
    update: {},
    create: {
      nome: 'Aluno Pendente de Vínculo',
      papel: 'ALUNO',
      matricula: '25-99999',
    },
  });
  console.log('Seeded Aluno Pendente:', aluno4Pendente.matricula);
```

E no bloco `// 5. Seed Matriculas`, adicionar depois do upsert de `aluno3`:

```ts
  await prisma.matricula.upsert({
    where: { usuario_id_turma_id: { usuario_id: aluno4Pendente.id, turma_id: turmaB.id } },
    update: {},
    create: { usuario_id: aluno4Pendente.id, turma_id: turmaB.id },
  });
```

- [ ] **Step 5: Rodar o seed e verificar**

Run: `cd crivo-api; npx prisma db seed`
Expected: log final inclui `Seeded Aluno Pendente: 25-99999`, sem erro de constraint.

- [ ] **Step 6: Commit**

```bash
cd crivo-api
git add prisma/schema.prisma prisma/seed.ts prisma/migrations package.json package-lock.json
git commit -m "feat(schema): RA vira ancora de identidade, github opcional, campos de senha"
```

---

## Task 2: `POST /auth/login-ra`

**Files:**
- Modify: `crivo-api/src/lib/auth.ts`
- Modify: `crivo-api/src/routes/auth.ts`
- Create: `crivo-api/tests/auth_ra.test.ts`

**Interfaces:**
- Consumes: `config.JWT_SECRET` (`crivo-api/src/lib/config.ts`), `prisma.usuario.findUnique` (Task 1 shape).
- Produces: `PreAuthPayload { usuario_id: number; etapa: 'redefinir_senha' | 'vincular_github' }`, `signPreAuthToken(payload): string`, `verifyPreAuthToken(token): PreAuthPayload` — usados por Tasks 3 e 4. Rota `POST /auth/login-ra` retorna `{ preauth_token: string; etapa: 'redefinir_senha' | 'vincular_github' }` (200), `{ error: string }` (401/409).

- [ ] **Step 1: Escrever o teste (falhando)**

Create `crivo-api/tests/auth_ra.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/index.js';
import { prisma } from '../src/lib/prisma.js';
import { verifyPreAuthToken } from '../src/lib/auth.js';

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
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd crivo-api; npx vitest run tests/auth_ra.test.ts`
Expected: FAIL — rota `/auth/login-ra` não existe (404) e `verifyPreAuthToken` não existe.

- [ ] **Step 3: Implementar os helpers de pré-ativação**

Em `crivo-api/src/lib/auth.ts`, adicionar (depois de `verifyToken`, antes de `requireAuth`):

```ts
export interface PreAuthPayload {
  usuario_id: number;
  etapa: 'redefinir_senha' | 'vincular_github';
}

/**
 * Token de pré-ativação: namespace de JWT separado da sessão normal. Nunca é
 * aceito por requireAuth/requireProfessor — só serve para as duas etapas de
 * ativação (trocar senha, vincular GitHub), com vida curta.
 */
export function signPreAuthToken(payload: PreAuthPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyPreAuthToken(token: string): PreAuthPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET) as any;
  if (
    typeof decoded.usuario_id !== 'number' ||
    (decoded.etapa !== 'redefinir_senha' && decoded.etapa !== 'vincular_github')
  ) {
    throw new Error('Token de pré-ativação inválido');
  }
  return { usuario_id: decoded.usuario_id, etapa: decoded.etapa };
}

declare module 'fastify' {
  interface FastifyRequest {
    preAuth?: PreAuthPayload;
  }
}

/**
 * Middleware: exige um token de pré-ativação na etapa esperada. Rejeita se a
 * etapa não bater — impede pular a troca de senha indo direto pro vínculo.
 */
export function requirePreAuth(etapaEsperada: PreAuthPayload['etapa']) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      reply.status(401).send({ error: 'Token de pré-ativação ausente' });
      return;
    }
    try {
      const payload = verifyPreAuthToken(token);
      if (payload.etapa !== etapaEsperada) {
        reply.status(400).send({ error: `Etapa incorreta: esperado '${etapaEsperada}'` });
        return;
      }
      request.preAuth = payload;
    } catch {
      reply.status(401).send({ error: 'Token de pré-ativação inválido ou expirado' });
    }
  };
}
```

Nota: já existe um `declare module 'fastify' { interface FastifyRequest { user?: UserPayload } }` mais acima no arquivo — o novo `declare module` para `preAuth` é um bloco de augmentation separado (TypeScript faz merge automático), não precisa juntar no mesmo bloco.

- [ ] **Step 4: Implementar a rota**

Em `crivo-api/src/routes/auth.ts`, adicionar o import de `bcryptjs` e dos novos helpers no topo:

```ts
import bcrypt from 'bcryptjs';
```

E trocar a linha de import de `../lib/auth.js`:

```ts
import { signToken, requireAuth, signPreAuthToken, verifyPreAuthToken, requirePreAuth } from '../lib/auth.js';
```

Adicionar o schema (perto de `postEmailBodySchema`):

```ts
const loginRaBodySchema = z.object({
  ra: z.string().min(1),
  senha: z.string().min(1),
});
```

E a rota, logo depois do bloco `// 2. OAuth Callback Handler` (antes de `// 3. Get profile /me`):

```ts
  // 2b. Login inicial do aluno por RA — porta de entrada única antes do vínculo com GitHub
  fastify.post('/auth/login-ra', {
    schema: {
      tags: ['auth'],
      summary: 'Login por RA (primeiro acesso do aluno, antes de vincular o GitHub)',
      body: docSchema(loginRaBodySchema),
    },
  }, async (request, reply) => {
    const { ra, senha } = loginRaBodySchema.parse(request.body);

    const usuario = await prisma.usuario.findUnique({ where: { matricula: ra } });

    // Comparação dummy quando o usuário não existe: mantém o tempo de resposta
    // parecido com o caminho de senha errada, para não vazar por timing quais
    // RAs estão cadastrados.
    if (!usuario || usuario.papel !== 'ALUNO') {
      await bcrypt.compare(senha, '$2a$10$invalidinvalidinvalidu.invalidinvalidinva');
      reply.status(401).send({ error: 'Credenciais inválidas' });
      return;
    }

    if (usuario.github_id) {
      reply.status(409).send({ error: 'Esta conta já está vinculada ao GitHub — entre com GitHub.' });
      return;
    }

    if (usuario.senha_hash === null) {
      if (senha !== ra) {
        reply.status(401).send({ error: 'Credenciais inválidas' });
        return;
      }
      const token = signPreAuthToken({ usuario_id: usuario.id, etapa: 'redefinir_senha' });
      reply.send({ preauth_token: token, etapa: 'redefinir_senha' });
      return;
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaCorreta) {
      reply.status(401).send({ error: 'Credenciais inválidas' });
      return;
    }

    const token = signPreAuthToken({ usuario_id: usuario.id, etapa: 'vincular_github' });
    reply.send({ preauth_token: token, etapa: 'vincular_github' });
  });
```

- [ ] **Step 5: Rodar e confirmar sucesso**

Run: `cd crivo-api; npx vitest run tests/auth_ra.test.ts`
Expected: 6 testes passando.

- [ ] **Step 6: Commit**

```bash
cd crivo-api
git add src/lib/auth.ts src/routes/auth.ts tests/auth_ra.test.ts
git commit -m "feat(auth): POST /auth/login-ra com token de pre-ativacao"
```

---

## Task 3: `POST /auth/redefinir-senha`

**Files:**
- Modify: `crivo-api/src/routes/auth.ts`
- Modify: `crivo-api/tests/auth_ra.test.ts`

**Interfaces:**
- Consumes: `requirePreAuth('redefinir_senha')`, `signPreAuthToken` (Task 2).
- Produces: `POST /auth/redefinir-senha` — header `Authorization: Bearer <preauth_token etapa=redefinir_senha>`, body `{ senha_nova: string }`, retorna `{ preauth_token: string; etapa: 'vincular_github' }` (200) ou `{ error }` (400/401).

- [ ] **Step 1: Adicionar os testes (falhando)**

No mesmo `crivo-api/tests/auth_ra.test.ts`, adicionar `import { signPreAuthToken } from '../src/lib/auth.js';` ao topo e um novo `describe`:

```ts
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
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd crivo-api; npx vitest run tests/auth_ra.test.ts -t "redefinir-senha"`
Expected: FAIL — rota não existe.

- [ ] **Step 3: Implementar a rota**

Em `crivo-api/src/routes/auth.ts`, adicionar o schema perto de `loginRaBodySchema`:

```ts
const redefinirSenhaBodySchema = z.object({
  senha_nova: z.string().min(8),
});
```

E a rota, logo depois de `POST /auth/login-ra`:

```ts
  // 2c. Troca a senha inicial — etapa obrigatória antes de vincular o GitHub
  fastify.post('/auth/redefinir-senha', {
    preHandler: [requirePreAuth('redefinir_senha')],
    schema: {
      tags: ['auth'],
      summary: 'Troca a senha inicial do aluno',
      security: [{ bearerAuth: [] }],
      body: docSchema(redefinirSenhaBodySchema),
    },
  }, async (request, reply) => {
    const { senha_nova } = redefinirSenhaBodySchema.parse(request.body);
    const usuarioId = request.preAuth!.usuario_id;

    const senhaHash = await bcrypt.hash(senha_nova, 10);
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { senha_hash: senhaHash, senha_redefinida_em: new Date() },
    });

    const token = signPreAuthToken({ usuario_id: usuarioId, etapa: 'vincular_github' });
    reply.send({ preauth_token: token, etapa: 'vincular_github' });
  });
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `cd crivo-api; npx vitest run tests/auth_ra.test.ts`
Expected: 10 testes passando (6 de login-ra + 4 de redefinir-senha).

- [ ] **Step 5: Commit**

```bash
cd crivo-api
git add src/routes/auth.ts tests/auth_ra.test.ts
git commit -m "feat(auth): POST /auth/redefinir-senha"
```

---

## Task 4: Vínculo do GitHub no callback + correção do redirect pro front

**Files:**
- Modify: `crivo-api/src/lib/config.ts`
- Modify: `crivo-api/.env.example`
- Modify: `crivo-api/src/routes/auth.ts`
- Create: `crivo-api/tests/auth_github_link.test.ts`

**Interfaces:**
- Consumes: `verifyPreAuthToken`, `signPreAuthToken` (Task 2), `config.FRONTEND_URL` (novo).
- Produces: `GET /auth/github?state=<preauth_token>` propaga `state` pro GitHub. `GET /auth/github/callback` — com `state` válido etapa `vincular_github`, vincula `github_id`/`github_login` ao usuário do token e redireciona pra `${FRONTEND_URL}/auth/callback?token=...`; sem `state`, comportamento de hoje (find-or-create), mas agora **redirecionando** em vez de devolver JSON.

- [ ] **Step 1: Adicionar `FRONTEND_URL` à config**

Em `crivo-api/src/lib/config.ts`, adicionar logo abaixo de `APP_BASE_URL`:

```ts
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
```

Em `crivo-api/.env.example`, adicionar logo abaixo da linha `APP_BASE_URL=http://localhost:3000`:

```
FRONTEND_URL=http://localhost:5173
```

- [ ] **Step 2: Escrever os testes (falhando)**

Create `crivo-api/tests/auth_github_link.test.ts`:

```ts
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
```

- [ ] **Step 3: Rodar e confirmar falha**

Run: `cd crivo-api; npx vitest run tests/auth_github_link.test.ts`
Expected: FAIL — resposta ainda é `200` com JSON, não `302`; modo vínculo não existe.

- [ ] **Step 4: Implementar**

Em `crivo-api/src/routes/auth.ts`:

1. Trocar `callbackQuerySchema` para incluir `state`:

```ts
const callbackQuerySchema = z.object({
  code: z.string(),
  state: z.string().optional(),
});
```

2. Trocar `iniciarOauthQuerySchema` — adicionar antes de `callbackQuerySchema`:

```ts
const iniciarOauthQuerySchema = z.object({ state: z.string().optional() });
```

3. Reescrever a rota `GET /auth/github` inteira para:

```ts
  // 1. Redirect to GitHub OAuth Authorization Page
  fastify.get('/auth/github', {
    schema: {
      tags: ['auth'],
      summary: 'Inicia o fluxo de OAuth com o GitHub',
      description: 'Redireciona para a autorização do GitHub. Se `state` vier preenchido com um token de pré-ativação (etapa vincular_github), o callback vincula o GitHub autorizado ao usuário pendente em vez de criar/logar uma conta nova.',
      querystring: docSchema(iniciarOauthQuerySchema),
    },
  }, async (request, reply) => {
    const { state } = iniciarOauthQuerySchema.parse(request.query);
    const clientId = config.GITHUB_OAUTH_CLIENT_ID;
    const redirectUri = `${config.APP_BASE_URL}/auth/github/callback`;
    let oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email`;
    if (state) {
      oauthUrl += `&state=${encodeURIComponent(state)}`;
    }

    return reply.redirect(oauthUrl);
  });
```

4. Dentro do handler de `GET /auth/github/callback`, logo depois de:

```ts
      const githubId = BigInt(userProfile.id);
      const githubLogin = userProfile.login;
      const nome = userProfile.name || userProfile.login;
```

inserir o branch de vínculo (antes do bloco `// Check if user is in predefined professor list`):

```ts
      const { state } = parseResult.data;

      if (state) {
        let preAuth;
        try {
          preAuth = verifyPreAuthToken(state);
        } catch {
          reply.status(401).send({ error: 'Token de pré-ativação inválido ou expirado' });
          return;
        }
        if (preAuth.etapa !== 'vincular_github') {
          reply.status(400).send({ error: "Etapa incorreta: esperado 'vincular_github'" });
          return;
        }

        const conflito = await prisma.usuario.findUnique({ where: { github_id: githubId } });
        if (conflito && conflito.id !== preAuth.usuario_id) {
          reply.status(409).send({ error: 'Esta conta do GitHub já está vinculada a outro usuário' });
          return;
        }

        const usuarioPendente = await prisma.usuario.findUnique({ where: { id: preAuth.usuario_id } });
        if (!usuarioPendente) {
          reply.status(404).send({ error: 'Usuário pendente não encontrado' });
          return;
        }

        const vinculado = await prisma.usuario.update({
          where: { id: preAuth.usuario_id },
          data: { github_id: githubId, github_login: githubLogin },
        });

        const tokenVinculo = signToken({
          id: vinculado.id,
          github_id: vinculado.github_id!,
          github_login: vinculado.github_login!,
          papel: vinculado.papel,
        });

        reply.setCookie('token', tokenVinculo, {
          path: '/',
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60,
        });

        return reply.redirect(`${config.FRONTEND_URL}/auth/callback?token=${tokenVinculo}`);
      }

```

5. No fluxo normal (sem `state`), trocar a linha `const token = signToken(user);` por:

```ts
      const token = signToken({
        id: user.id,
        github_id: user.github_id!,
        github_login: user.github_login!,
        papel: user.papel,
      });
```

(necessário porque `user.github_id`/`github_login` agora são `bigint | null` / `string | null` no tipo do Prisma, mesmo sendo sempre não-nulos neste ponto — acabaram de ser setados pelo create/update logo acima)

6. E a linha final do fluxo normal, trocar:

```ts
      return reply.send({ success: true, token, user: serializeBigInt(user) });
```

por:

```ts
      return reply.redirect(`${config.FRONTEND_URL}/auth/callback?token=${token}`);
```

- [ ] **Step 5: Rodar e confirmar sucesso**

Run: `cd crivo-api; npx vitest run tests/auth_github_link.test.ts`
Expected: 5 testes passando.

Run: `cd crivo-api; npx vitest run`
Expected: toda a suíte (incluindo `webhook.test.ts`, `alunos_metricas.test.ts`, `detectors.test.ts`, `congelador.test.ts`, `email_resolution.test.ts`) continua passando — nenhuma delas exercita `/auth/github/callback`, então não há regressão esperada.

- [ ] **Step 6: Commit**

```bash
cd crivo-api
git add src/lib/config.ts .env.example src/routes/auth.ts tests/auth_github_link.test.ts
git commit -m "feat(auth): vinculo de GitHub via state + redirect do callback pro front"
```

---

## Task 5: Import de matrícula por RA + listagem de status

**Files:**
- Modify: `crivo-api/src/routes/professores.ts`
- Create: `crivo-api/tests/matriculas_ra.test.ts`

**Interfaces:**
- Consumes: `requireProfessor` (existente), `prisma.usuario.upsert/findMany`, `prisma.matricula.upsert/findMany`.
- Produces: `POST /prof/turmas/:id/matriculas` body `{ matriculas: [{ ra: string; nome: string }] }` → `{ success: true; imported: string[] }`. `GET /prof/turmas/:id/matriculas` → `{ usuario_id, nome, matricula, github_login, senha_definida, vinculado }[]`.

- [ ] **Step 1: Escrever os testes (falhando)**

Create `crivo-api/tests/matriculas_ra.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd crivo-api; npx vitest run tests/matriculas_ra.test.ts`
Expected: FAIL — schema atual exige `github_login`, `zod` rejeita o payload com `ra`/sem `github_login`.

- [ ] **Step 3: Implementar**

Em `crivo-api/src/routes/professores.ts`, trocar `importarMatriculasBodySchema` inteiro:

```ts
const importarMatriculasBodySchema = z.object({
  matriculas: z.array(
    z.object({
      ra: z.string().min(1),
      nome: z.string().min(1),
    })
  ),
});
```

E substituir o corpo inteiro da rota `POST /prof/turmas/:id/matriculas` (o handler, mantendo `schema:` com a mesma `summary` trocada) por:

```ts
  fastify.post('/prof/turmas/:id/matriculas', {
    schema: {
      tags: ['professores'],
      summary: 'Importa matrículas de alunos em uma turma a partir do RA (sem GitHub)',
      security: AUTH_SECURITY,
      params: docSchema(turmaIdParamsSchema),
      body: docSchema(importarMatriculasBodySchema),
    },
  }, async (request, reply) => {
    const { id: turmaId } = turmaIdParamsSchema.parse(request.params);
    const { matriculas } = importarMatriculasBodySchema.parse(request.body);

    const importados: string[] = [];

    for (const item of matriculas) {
      const usuario = await prisma.usuario.upsert({
        where: { matricula: item.ra },
        update: {},
        create: {
          matricula: item.ra,
          nome: item.nome,
          papel: 'ALUNO',
          github_id: null,
          github_login: null,
          senha_hash: null,
        },
      });

      await prisma.matricula.upsert({
        where: { usuario_id_turma_id: { usuario_id: usuario.id, turma_id: turmaId } },
        update: {},
        create: { usuario_id: usuario.id, turma_id: turmaId },
      });

      importados.push(item.ra);
    }

    return reply.send({ success: true, imported: importados });
  });

  fastify.get('/prof/turmas/:id/matriculas', {
    schema: {
      tags: ['professores'],
      summary: 'Lista os alunos matriculados na turma e o status de ativação de cada um',
      security: AUTH_SECURITY,
      params: docSchema(turmaIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id: turmaId } = turmaIdParamsSchema.parse(request.params);

    const matriculas = await prisma.matricula.findMany({
      where: { turma_id: turmaId },
      include: { usuario: true },
    });

    const linhas = matriculas.map((m) => ({
      usuario_id: m.usuario.id,
      nome: m.usuario.nome,
      matricula: m.usuario.matricula,
      github_login: m.usuario.github_login,
      senha_definida: m.usuario.senha_hash !== null,
      vinculado: m.usuario.github_login !== null,
    }));

    return reply.send(linhas);
  });
```

Remover os imports que ficaram sem uso nesse trecho: `getInstallationOctokit`/`withGithubRetry` continuam usados mais abaixo no arquivo (validação de `template_repo` em `criarTrabalho`) — **não remover** esses imports.

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `cd crivo-api; npx vitest run tests/matriculas_ra.test.ts`
Expected: 3 testes passando.

- [ ] **Step 5: Commit**

```bash
cd crivo-api
git add src/routes/professores.ts tests/matriculas_ra.test.ts
git commit -m "feat(professores): import de matricula por RA + listagem de status"
```

---

## Task 6: `POST /prof/alunos/:id/resetar-senha`

**Files:**
- Modify: `crivo-api/src/routes/professores.ts`
- Modify: `crivo-api/tests/matriculas_ra.test.ts`

**Interfaces:**
- Produces: `POST /prof/alunos/:id/resetar-senha` → `{ success: true; usuario }` (200), `{ error }` (404/409).

- [ ] **Step 1: Adicionar o teste (falhando)**

No mesmo `crivo-api/tests/matriculas_ra.test.ts`, estender o `vi.mock('../src/lib/prisma.js', ...)` para incluir `findUnique` e `update` em `usuario`:

```ts
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    usuario: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    matricula: { upsert: vi.fn(), findMany: vi.fn() },
  },
}));
```

E adicionar um novo `describe`:

```ts
describe('POST /prof/alunos/:id/resetar-senha', () => {
  const app = buildApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404 quando o aluno não existe', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/999/resetar-senha',
      headers: authProf,
    });
    expect(response.statusCode).toBe(404);
  });

  it('409 quando o aluno já está vinculado ao GitHub', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 50, papel: 'ALUNO', github_id: 123n,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/50/resetar-senha',
      headers: authProf,
    });
    expect(response.statusCode).toBe(409);
  });

  it('zera senha_hash quando pendente de vínculo', async () => {
    vi.mocked(prisma.usuario.findUnique).mockResolvedValue({
      id: 50, papel: 'ALUNO', github_id: null,
    } as any);
    vi.mocked(prisma.usuario.update).mockResolvedValue({ id: 50 } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/prof/alunos/50/resetar-senha',
      headers: authProf,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { senha_hash: null, senha_redefinida_em: null },
    });
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd crivo-api; npx vitest run tests/matriculas_ra.test.ts -t "resetar-senha"`
Expected: FAIL — rota não existe (404 genérico do Fastify, não o 404 esperado do handler).

- [ ] **Step 3: Implementar**

Em `crivo-api/src/routes/professores.ts`, adicionar o schema de params perto de `turmaIdParamsSchema`:

```ts
const alunoIdParamsSchema = z.object({ id: z.string().transform(Number) });
```

E a rota, depois do bloco de matrículas (após o `GET /prof/turmas/:id/matriculas` do Task 5):

```ts
  fastify.post('/prof/alunos/:id/resetar-senha', {
    schema: {
      tags: ['professores'],
      summary: 'Zera a senha de um aluno pendente de vínculo do GitHub (escape hatch)',
      security: AUTH_SECURITY,
      params: docSchema(alunoIdParamsSchema),
    },
  }, async (request, reply) => {
    const { id } = alunoIdParamsSchema.parse(request.params);

    const aluno = await prisma.usuario.findUnique({ where: { id } });
    if (!aluno || aluno.papel !== 'ALUNO') {
      reply.status(404).send({ error: 'Aluno not found' });
      return;
    }
    if (aluno.github_id) {
      reply.status(409).send({ error: 'Aluno já vinculado ao GitHub — reset não é necessário' });
      return;
    }

    const atualizado = await prisma.usuario.update({
      where: { id },
      data: { senha_hash: null, senha_redefinida_em: null },
    });

    return reply.send({ success: true, usuario: serializeBigInt(atualizado) });
  });
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `cd crivo-api; npx vitest run tests/matriculas_ra.test.ts`
Expected: 6 testes passando (3 do Task 5 + 3 deste).

- [ ] **Step 5: Commit**

```bash
cd crivo-api
git add src/routes/professores.ts tests/matriculas_ra.test.ts
git commit -m "feat(professores): POST /prof/alunos/:id/resetar-senha"
```

---

## Task 7: Corrigir o TypeScript após github_id/github_login opcionais

**Files:**
- Modify: `crivo-api/src/detectors/index.ts`
- Modify: `crivo-api/src/services/repo.ts`
- Modify: `crivo-api/src/routes/professores.ts`

**Interfaces:**
- Nenhuma nova — só resolve os erros de `strictNullChecks` que o Task 1 introduziu em código que **sabe** (por regra de domínio: dono de repositório já vinculou o GitHub) que o valor nunca é nulo ali.

- [ ] **Step 1: Rodar o build e listar os erros**

Run: `cd crivo-api; npm run build`
Expected: FAIL, com erros de tipo em `src/detectors/index.ts`, `src/services/repo.ts` e `src/routes/professores.ts` nas linhas envolvendo `.github_id`/`.github_login`.

- [ ] **Step 2: Aplicar as 9 asserções**

Em `crivo-api/src/detectors/index.ts`:

```ts
// era: pusher_github_id: { not: owner.github_id },
        pusher_github_id: { not: owner.github_id! },
```

```ts
// era: owner_github_id: owner.github_id.toString(),
        owner_github_id: owner.github_id!.toString(),
```

Em `crivo-api/src/services/repo.ts`:

```ts
// era:
//   const studentLogins = repo.dono_tipo === 'ALUNO'
//     ? (repo.usuario ? [repo.usuario.github_login] : [])
//     : repo.equipe?.membros.map((m) => m.usuario.github_login) ?? [];
  const studentLogins = repo.dono_tipo === 'ALUNO'
    ? (repo.usuario ? [repo.usuario.github_login!] : [])
    : repo.equipe?.membros.map((m) => m.usuario.github_login!) ?? [];
```

```ts
// era: const baseName = `${trabalho.turma.disciplina.codigo}-${trabalho.slug}-${user.github_login}`;
  const baseName = `${trabalho.turma.disciplina.codigo}-${trabalho.slug}-${user.github_login!}`;
```

Em `crivo-api/src/routes/professores.ts` (dentro do handler de `GET /prof/turmas/:id/grade`, já existente):

```ts
// era: membros = [r.usuario.github_login];
        membros = [r.usuario.github_login!];
```

```ts
// era: membros = r.equipe.membros.map(m => m.usuario.github_login);
        membros = r.equipe.membros.map(m => m.usuario.github_login!);
```

```ts
// era: membros: [m.usuario.github_login],
            membros: [m.usuario.github_login!],
```

```ts
// era: membros: team.membros.map(m => m.usuario.github_login),
            membros: team.membros.map(m => m.usuario.github_login!),
```

- [ ] **Step 3: Rodar o build de novo**

Run: `cd crivo-api; npm run build`
Expected: PASS, sem erros de tipo.

- [ ] **Step 4: Rodar a suíte inteira**

Run: `cd crivo-api; npm test`
Expected: todos os testes (novos e pré-existentes) passando.

- [ ] **Step 5: Commit**

```bash
cd crivo-api
git add src/detectors/index.ts src/services/repo.ts src/routes/professores.ts
git commit -m "fix: asserções de non-null apos github_id/github_login virarem opcionais"
```

---

## Task 8: Front — tipos e client HTTP

**Files:**
- Modify: `crivo-front/src/api/client.ts`
- Modify: `crivo-front/src/api/types.ts`
- Modify: `crivo-front/src/api/endpoints.ts`
- Create: `crivo-front/src/auth/preAuth.ts`

**Interfaces:**
- Produces: `RequestOptions.bearerOverride?: string` em `request()`. Tipos `LoginRaResposta`, `StatusMatricula`, `MatriculaImportItem` (RA), `ImportarMatriculasResposta` (sem `failed`). `auth.loginRa`, `auth.redefinirSenha`, `professor.importarMatriculas` (novo formato), `professor.statusMatriculas`, `professor.resetarSenhaAluno`. `getPreAuthToken`/`setPreAuthToken` (sessionStorage, key `crivo.preauth`) — usados pelas Tasks 9–11.

- [ ] **Step 1: `bearerOverride` no client**

Em `crivo-front/src/api/client.ts`, na interface `RequestOptions`, adicionar:

```ts
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Sobrescreve o Authorization Bearer — usado pelos tokens de pré-ativação,
   *  que não fazem parte da sessão normal (localStorage `crivo.token`). */
  bearerOverride?: string;
}
```

E dentro de `request()`, trocar:

```ts
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
```

por:

```ts
  const token = options.bearerOverride ?? getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
```

- [ ] **Step 2: `src/auth/preAuth.ts`**

Create `crivo-front/src/auth/preAuth.ts`:

```ts
/* ---------------------------------------------------------------------------
 * Token de pré-ativação: guarda o passo intermediário entre RA+senha e a
 * sessão completa (trocar senha -> vincular GitHub). Usa sessionStorage, não
 * localStorage: some ao fechar a aba, e nunca é o token de sessão normal
 * (`crivo.token`, em client.ts) — namespaces separados de propósito.
 * ------------------------------------------------------------------------- */

const PREAUTH_KEY = 'crivo.preauth';

export function getPreAuthToken(): string | null {
  try {
    return sessionStorage.getItem(PREAUTH_KEY);
  } catch {
    return null;
  }
}

export function setPreAuthToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(PREAUTH_KEY, token);
    else sessionStorage.removeItem(PREAUTH_KEY);
  } catch {
    /* modo privado / storage bloqueado */
  }
}
```

- [ ] **Step 3: Tipos**

Em `crivo-front/src/api/types.ts`:

Trocar a interface `Usuario` (`github_id`/`github_login` viram opcionais):

```ts
export interface Usuario {
  id: number;
  github_id: string | null;
  github_login: string | null;
  nome: string;
  papel: Papel;
  matricula: string | null;
  criado_em: string;
  emails?: EmailCommit[];
}
```

Trocar `MatriculaImportItem` e `ImportarMatriculasResposta`:

```ts
export interface MatriculaImportItem {
  ra: string;
  nome: string;
}

export interface ImportarMatriculasResposta {
  success: boolean;
  imported: string[];
}
```

Adicionar, logo abaixo:

```ts
export interface StatusMatricula {
  usuario_id: number;
  nome: string;
  matricula: string | null;
  github_login: string | null;
  senha_definida: boolean;
  vinculado: boolean;
}

export interface LoginRaResposta {
  preauth_token: string;
  etapa: 'redefinir_senha' | 'vincular_github';
}
```

- [ ] **Step 4: Endpoints**

Em `crivo-front/src/api/endpoints.ts`, adicionar `LoginRaResposta` e `StatusMatricula` ao import de `./types`, e dentro de `export const auth = { ... }`, adicionar:

```ts
  /** Primeiro acesso do aluno: RA como usuário e senha inicial (o próprio RA). */
  loginRa: (ra: string, senha: string) =>
    request<LoginRaResposta>('/auth/login-ra', { method: 'POST', body: { ra, senha } }),

  /** Troca a senha inicial — exige o token de pré-ativação da etapa `redefinir_senha`. */
  redefinirSenha: (preauthToken: string, senhaNova: string) =>
    request<LoginRaResposta>('/auth/redefinir-senha', {
      method: 'POST',
      body: { senha_nova: senhaNova },
      bearerOverride: preauthToken,
    }),
```

E dentro de `export const professor = { ... }`, trocar o comentário/assinatura de `importarMatriculas` e adicionar as duas novas funções:

```ts
  /** Import por RA — sem depender do GitHub no momento do cadastro. */
  importarMatriculas: (turmaId: number, matriculas: MatriculaImportItem[]) =>
    request<ImportarMatriculasResposta>(`/prof/turmas/${turmaId}/matriculas`, {
      method: 'POST',
      body: { matriculas },
    }),

  /** Status de ativação (senha definida / GitHub vinculado) de cada matriculado. */
  statusMatriculas: (turmaId: number) =>
    request<StatusMatricula[]>(`/prof/turmas/${turmaId}/matriculas`),

  /** Escape hatch: zera a senha de quem travou entre trocar senha e vincular GitHub. */
  resetarSenhaAluno: (usuarioId: number) =>
    request<{ success: boolean }>(`/prof/alunos/${usuarioId}/resetar-senha`, { method: 'POST' }),
```

- [ ] **Step 5: Verificar tipos**

Run: `cd crivo-front; npm run typecheck`
Expected: FAIL neste ponto — `AlunosPage.tsx` ainda usa o formato antigo de `MatriculaImportItem`/`ImportarMatriculasResposta.failed` (corrigido no Task 12). Confirmar que o erro aponta exatamente para `src/pages/professor/AlunosPage.tsx`, não para os arquivos deste task.

- [ ] **Step 6: Commit**

```bash
cd crivo-front
git add src/api/client.ts src/api/types.ts src/api/endpoints.ts src/auth/preAuth.ts
git commit -m "feat(api): tipos e client para login por RA e vinculo de GitHub"
```

---

## Task 9: Front — parser de RA+Nome+Status

**Files:**
- Create: `crivo-front/src/lib/importarAlunos.ts`
- Create: `crivo-front/src/lib/importarAlunos.test.ts`

**Interfaces:**
- Produces: `parsearAlunosRA(texto: string): { itens: { ra: string; nome: string }[]; ignoradas: number }` — usado pelo Task 12.

- [ ] **Step 1: Escrever o teste (falhando)**

Create `crivo-front/src/lib/importarAlunos.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parsearAlunosRA } from './importarAlunos';

const EXEMPLO = `RA\tNome Civil ou Nome Social
25-13353\tBRENO MOREIRA SOARES(Matriculado)
25-14810\tCARLOS EDUARDO MOTA BELICE(Matriculado)`;

describe('parsearAlunosRA', () => {
  it('extrai RA e nome de cada linha matriculada', () => {
    const { itens } = parsearAlunosRA(EXEMPLO);
    expect(itens).toHaveLength(2);
    expect(itens[0]).toEqual({ ra: '25-13353', nome: 'BRENO MOREIRA SOARES' });
    expect(itens[1]).toEqual({ ra: '25-14810', nome: 'CARLOS EDUARDO MOTA BELICE' });
  });

  it('pula status diferente de Matriculado e conta como ignorada', () => {
    const texto = '25-99999\tFULANO DE TAL(Trancado)\n25-13353\tBRENO MOREIRA SOARES(Matriculado)';
    const { itens, ignoradas } = parsearAlunosRA(texto);
    expect(itens).toEqual([{ ra: '25-13353', nome: 'BRENO MOREIRA SOARES' }]);
    expect(ignoradas).toBe(1);
  });

  it('remove RA duplicado na mesma colagem', () => {
    const texto =
      '25-13353\tBRENO MOREIRA SOARES(Matriculado)\n25-13353\tBRENO MOREIRA SOARES(Matriculado)';
    const { itens } = parsearAlunosRA(texto);
    expect(itens).toHaveLength(1);
  });

  it('ignora linhas em branco', () => {
    const texto = '\n\n25-13353\tBRENO MOREIRA SOARES(Matriculado)\n\n';
    const { itens } = parsearAlunosRA(texto);
    expect(itens).toHaveLength(1);
  });

  it('aceita múltiplos espaços como separador, não só tab', () => {
    const texto = '25-13353     BRENO MOREIRA SOARES(Matriculado)';
    const { itens } = parsearAlunosRA(texto);
    expect(itens).toEqual([{ ra: '25-13353', nome: 'BRENO MOREIRA SOARES' }]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd crivo-front; npx vitest run src/lib/importarAlunos.test.ts`
Expected: FAIL — módulo `./importarAlunos` não existe.

- [ ] **Step 3: Implementar**

Create `crivo-front/src/lib/importarAlunos.ts`:

```ts
export interface AlunoImportado {
  ra: string;
  nome: string;
}

export interface ResultadoParseRA {
  itens: AlunoImportado[];
  ignoradas: number;
}

/**
 * `RA<TAB>Nome Civil ou Social(Status)` — formato colado direto da planilha
 * acadêmica. Só linhas com status "Matriculado" entram na importação; as
 * demais (Trancado, Cancelado...) são contadas em `ignoradas`, não
 * silenciosamente descartadas — quem chama decide como avisar o professor.
 */
export function parsearAlunosRA(texto: string): ResultadoParseRA {
  const vistos = new Set<string>();
  const itens: AlunoImportado[] = [];
  let ignoradas = 0;

  for (const linhaBruta of texto.split('\n')) {
    const linha = linhaBruta.trim();
    if (!linha) continue;

    const partes = linha
      .split(/\t+|\s{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (partes.length < 2) continue;

    const ra = partes[0];
    const resto = partes.slice(1).join(' ');
    const match = /^(.*?)\(([^)]*)\)\s*$/.exec(resto);
    const nome = (match ? match[1] : resto).trim();
    const status = match ? match[2].trim() : '';

    if (status !== 'Matriculado') {
      ignoradas += 1;
      continue;
    }
    if (vistos.has(ra)) continue;
    vistos.add(ra);

    itens.push({ ra, nome });
  }

  return { itens, ignoradas };
}
```

- [ ] **Step 4: Rodar e confirmar sucesso**

Run: `cd crivo-front; npx vitest run src/lib/importarAlunos.test.ts`
Expected: 5 testes passando.

- [ ] **Step 5: Commit**

```bash
cd crivo-front
git add src/lib/importarAlunos.ts src/lib/importarAlunos.test.ts
git commit -m "feat(lib): parser de RA+Nome+Status colado da planilha academica"
```

---

## Task 10: Front — `LoginPage` reestruturada (RA+senha primário)

**Files:**
- Modify: `crivo-front/src/pages/auth/LoginPage.tsx`

**Interfaces:**
- Consumes: `authApi.loginRa` (Task 8), `setPreAuthToken` (Task 8).
- Produces: navega para `/ativar/senha` ou `/ativar/github` conforme `etapa` da resposta — consumido pelas rotas do Task 13.

- [ ] **Step 1: Reescrever o componente**

Replace `crivo-front/src/pages/auth/LoginPage.tsx` inteiro por:

```tsx
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { Alert, Button, Input } from '@/components/ui';
import { IconCode, IconLogoColorido } from '@/components/ui/Icon';
import { auth as authApi } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import { setPreAuthToken } from '@/auth/preAuth';
import './login.css';

/**
 * Porta de entrada única. RA+senha é o caminho principal (alunos — primeiro
 * acesso ou já vinculados tentando por engano). GitHub é o caminho do
 * professor, e também o único caminho de quem já vinculou a conta.
 */
export default function LoginPage() {
  const { usuario, urlLoginGithub, entrarComToken, expirou } = useAuth();
  const navigate = useNavigate();

  const [ra, setRa] = useState('');
  const [senha, setSenha] = useState('');
  const [erroRa, setErroRa] = useState<string | null>(null);
  const [enviandoRa, setEnviandoRa] = useState(false);

  const [mostrarToken, setMostrarToken] = useState(false);
  const [token, setToken] = useState('');
  const [enviando, setEnviando] = useState(false);

  if (usuario) return <Navigate to="/" replace />;

  async function entrarComRa(e: React.FormEvent) {
    e.preventDefault();
    if (!ra.trim() || !senha) return;
    setErroRa(null);
    setEnviandoRa(true);
    try {
      const resposta = await authApi.loginRa(ra.trim(), senha);
      setPreAuthToken(resposta.preauth_token);
      navigate(resposta.etapa === 'redefinir_senha' ? '/ativar/senha' : '/ativar/github');
    } catch (err) {
      setErroRa(errorMessage(err));
    } finally {
      setEnviandoRa(false);
    }
  }

  async function usarToken(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setEnviando(true);
    await entrarComToken(token.trim());
    setEnviando(false);
  }

  return (
    <div className="login">
      <IconLogoColorido size={54} />

      <div className="login__box">
        {expirou && (
          <Alert tone="warn" style={{ textAlign: 'left', width: '100%', maxWidth: 420 }}>
            Sua sessão expirou e você foi desconectado. Entre de novo para continuar de onde
            parou — nada do que você já registrou foi perdido.
          </Alert>
        )}

        <div>
          <h1 className="login__title">
            Acompanhe as disciplinas de ADS com <span>transparência</span>
          </h1>
          <p className="login__desc">
            Alunos entram com RA e senha. Professores entram com a conta institucional do GitHub.
          </p>
        </div>

        {erroRa && (
          <Alert tone="danger" style={{ textAlign: 'left', width: '100%', maxWidth: 420 }}>
            {erroRa}
          </Alert>
        )}

        <form
          onSubmit={entrarComRa}
          style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <Input value={ra} onChange={(e) => setRa(e.target.value)} placeholder="RA" aria-label="RA" />
          <Input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="Senha (no primeiro acesso, o próprio RA)"
            aria-label="Senha"
          />
          <Button type="submit" block loading={enviandoRa} disabled={!ra.trim() || !senha}>
            Entrar
          </Button>
        </form>

        <div className="login__foot">
          <a className="login__link" href={urlLoginGithub}>
            <IconCode size={13} /> Sou professor, entrar com GitHub
          </a>
          {' · '}
          <button type="button" className="login__link" onClick={() => setMostrarToken((v) => !v)}>
            entrar com token
          </button>
        </div>

        {mostrarToken && (
          <form className="login__token" onSubmit={usarToken}>
            <p className="login__token-help">
              Cole um JWT emitido pela API. Útil quando o navegador não consegue guardar o cookie
              da API.
            </p>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJhbGciOi…"
              mono
              aria-label="Token JWT"
            />
            <Button type="submit" block loading={enviando} disabled={!token.trim()}>
              Entrar
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd crivo-front
git add src/pages/auth/LoginPage.tsx
git commit -m "feat(login): RA+senha vira o formulario principal"
```

---

## Task 11: Front — telas de ativação (`RedefinirSenhaPage`, `VincularGithubPage`)

**Files:**
- Create: `crivo-front/src/pages/auth/RedefinirSenhaPage.tsx`
- Create: `crivo-front/src/pages/auth/VincularGithubPage.tsx`

**Interfaces:**
- Consumes: `authApi.redefinirSenha` (Task 8), `getPreAuthToken`/`setPreAuthToken` (Task 8), `API_ORIGIN` (`crivo-front/src/api/client.ts`).
- Produces: navegação para `/ativar/github` ao concluir a troca de senha — consumido pelas rotas do Task 13.

- [ ] **Step 1: `RedefinirSenhaPage`**

Create `crivo-front/src/pages/auth/RedefinirSenhaPage.tsx`:

```tsx
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Button, Input } from '@/components/ui';
import { IconLogoColorido } from '@/components/ui/Icon';
import { auth as authApi } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import { getPreAuthToken, setPreAuthToken } from '@/auth/preAuth';
import './login.css';

export default function RedefinirSenhaPage() {
  const token = getPreAuthToken();
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [concluido, setConcluido] = useState(false);

  if (!token) return <Navigate to="/login" replace />;
  if (concluido) return <Navigate to="/ativar/github" replace />;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (senha.length < 8) {
      setErro('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    if (senha !== confirmacao) {
      setErro('As senhas não coincidem.');
      return;
    }
    setEnviando(true);
    try {
      const resposta = await authApi.redefinirSenha(token!, senha);
      setPreAuthToken(resposta.preauth_token);
      setConcluido(true);
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <IconLogoColorido size={54} />
      <div className="login__box">
        <div>
          <h1 className="login__title">Defina sua nova senha</h1>
          <p className="login__desc">
            Este é o seu primeiro acesso. Escolha uma senha nova — a senha inicial (seu RA) deixa
            de valer assim que você concluir esta etapa.
          </p>
        </div>

        {erro && (
          <Alert tone="danger" style={{ textAlign: 'left', width: '100%', maxWidth: 420 }}>
            {erro}
          </Alert>
        )}

        <form
          onSubmit={enviar}
          style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <Input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="Nova senha (mínimo 8 caracteres)"
            aria-label="Nova senha"
          />
          <Input
            type="password"
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.target.value)}
            placeholder="Confirme a nova senha"
            aria-label="Confirme a nova senha"
          />
          <Button type="submit" block loading={enviando} disabled={!senha || !confirmacao}>
            Definir senha
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `VincularGithubPage`**

Create `crivo-front/src/pages/auth/VincularGithubPage.tsx`:

```tsx
import { Navigate } from 'react-router-dom';
import { Alert } from '@/components/ui';
import { IconCode, IconLogoColorido } from '@/components/ui/Icon';
import { API_ORIGIN } from '@/api/client';
import { getPreAuthToken } from '@/auth/preAuth';
import './login.css';

export default function VincularGithubPage() {
  const token = getPreAuthToken();
  if (!token) return <Navigate to="/login" replace />;

  const urlVincular = `${API_ORIGIN}/auth/github?state=${encodeURIComponent(token)}`;

  return (
    <div className="login">
      <IconLogoColorido size={54} />
      <div className="login__box">
        <div>
          <h1 className="login__title">Última etapa: vincule sua conta GitHub</h1>
          <p className="login__desc">
            A partir de agora você entra sempre pelo GitHub — a senha que você acabou de definir
            não será mais usada.
          </p>
        </div>

        <Alert tone="info" style={{ textAlign: 'left', width: '100%', maxWidth: 420 }}>
          Use a mesma conta do GitHub que você vai usar para receber os repositórios dos
          trabalhos.
        </Alert>

        <a className="btn btn--primary btn--lg login__github" href={urlVincular}>
          <IconCode size={17} />
          Vincular com GitHub
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd crivo-front
git add src/pages/auth/RedefinirSenhaPage.tsx src/pages/auth/VincularGithubPage.tsx
git commit -m "feat(login): telas de troca de senha e vinculo de GitHub"
```

---

## Task 12: Front — rotas em `App.tsx`

**Files:**
- Modify: `crivo-front/src/App.tsx`

**Interfaces:**
- Consumes: `RedefinirSenhaPage`, `VincularGithubPage` (Task 11).

- [ ] **Step 1: Importar e registrar as rotas**

Em `crivo-front/src/App.tsx`, adicionar os imports logo abaixo de `import CallbackPage from '@/pages/auth/CallbackPage';`:

```tsx
import RedefinirSenhaPage from '@/pages/auth/RedefinirSenhaPage';
import VincularGithubPage from '@/pages/auth/VincularGithubPage';
```

(sem `lazy` — mesmo motivo do `LoginPage`/`CallbackPage`: são exatamente o que o primeiro acesso precisa.)

E, dentro de `<Routes>`, adicionar as duas rotas entre `/login` e `/auth/callback`:

```tsx
          <Route path="/login" element={<LoginPage />} />
          <Route path="/ativar/senha" element={<RedefinirSenhaPage />} />
          <Route path="/ativar/github" element={<VincularGithubPage />} />
          <Route path="/auth/callback" element={<CallbackPage />} />
```

- [ ] **Step 2: Verificar tipos**

Run: `cd crivo-front; npm run typecheck`
Expected: os erros relacionados a `App.tsx`/`LoginPage`/páginas novas desaparecem; só resta o erro em `AlunosPage.tsx` (resolvido no próximo task).

- [ ] **Step 3: Commit**

```bash
cd crivo-front
git add src/App.tsx
git commit -m "feat(rotas): /ativar/senha e /ativar/github"
```

---

## Task 13: Front — `AlunosPage`: import por RA + listagem de ativação

**Files:**
- Modify: `crivo-front/src/pages/professor/AlunosPage.tsx`

**Interfaces:**
- Consumes: `parsearAlunosRA` (Task 9), `professor.importarMatriculas` (novo formato, Task 8), `professor.statusMatriculas`, `professor.resetarSenhaAluno` (Task 8).

- [ ] **Step 1: Trocar os imports do topo**

Em `crivo-front/src/pages/professor/AlunosPage.tsx`, trocar a linha de import de tipos:

```tsx
import type { GradeRow, ImportarMatriculasResposta, MatriculaImportItem } from '@/api/types';
```

por:

```tsx
import type { GradeRow, ImportarMatriculasResposta, StatusMatricula } from '@/api/types';
import { parsearAlunosRA } from '@/lib/importarAlunos';
```

E adicionar `Field` já está importado; confirmar que `useAsync` já está importado (está, via `@/hooks/useAsync`).

- [ ] **Step 2: Substituir `FormularioImportacao` e remover `parsearLinhas`**

Substituir a seção inteira `/* ---- Importação de matrículas ---------------------------------------------- */` até o fim da função `parsearLinhas` (a função `parsearLinhas` e o componente `FormularioImportacao` atuais) por:

```tsx
/* ---- Importação de matrículas ---------------------------------------------- */

function FormularioImportacao({
  turmaId,
  onImportado,
}: {
  turmaId: number;
  onImportado: () => void;
}) {
  const [texto, setTexto] = useState('');
  const [resultado, setResultado] = useState<ImportarMatriculasResposta | null>(null);

  const status = useAsync<StatusMatricula[]>(() => profApi.statusMatriculas(turmaId), [turmaId]);

  const { itens, ignoradas } = useMemo(() => parsearAlunosRA(texto), [texto]);

  const importar = useAction(async () => {
    const resposta = await profApi.importarMatriculas(turmaId, itens);
    setResultado(resposta);
    if (resposta.imported.length > 0) {
      setTexto('');
      onImportado();
      status.reload();
    }
    return resposta;
  });

  const resetar = useAction(async (usuarioId: number) => {
    await profApi.resetarSenhaAluno(usuarioId);
    status.reload();
  });

  return (
    <>
      <Card style={{ maxWidth: 640, marginBottom: 20 }}>
        <div className="card-title">Importar por RA</div>
        <p style={{ fontSize: 13, color: 'var(--c-text-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
          Cole a lista direto da planilha acadêmica (RA, Nome, status entre parênteses). Só linhas
          com status <code>Matriculado</code> são importadas — as demais aparecem no resumo abaixo,
          sem travar as outras. O aluno ativa a conta depois, com RA como usuário e senha inicial.
        </p>

        <Field label="Alunos" hint="Uma linha por aluno: RA, Nome(Status) — cole direto da planilha.">
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={'25-13353\tBRENO MOREIRA SOARES(Matriculado)\n25-14810\tCARLOS EDUARDO MOTA BELICE(Matriculado)'}
            mono
            style={{ minHeight: 160 }}
          />
        </Field>

        {(itens.length > 0 || ignoradas > 0) && (
          <p style={{ fontSize: 12.5, color: 'var(--c-text-subtle)', margin: '0 0 14px' }}>
            {itens.length} {itens.length === 1 ? 'aluno reconhecido' : 'alunos reconhecidos'}
            {ignoradas > 0 &&
              ` · ${ignoradas} ${ignoradas === 1 ? 'linha ignorada' : 'linhas ignoradas'} (status diferente de Matriculado)`}
            .
          </p>
        )}

        {importar.error && (
          <Alert tone="danger" style={{ marginBottom: 14 }}>
            {importar.error}
          </Alert>
        )}

        <Button loading={importar.pending} disabled={itens.length === 0} onClick={() => importar.run()}>
          Importar {itens.length > 0 ? `${itens.length} aluno${itens.length > 1 ? 's' : ''}` : ''}
        </Button>

        {resultado && resultado.imported.length > 0 && (
          <Alert tone="info" style={{ marginTop: 18 }}>
            <strong>
              {resultado.imported.length}{' '}
              {resultado.imported.length === 1 ? 'aluno importado' : 'alunos importados'}.
            </strong>
            <div className="import-resultado">
              {resultado.imported.map((ra) => (
                <Pill key={ra} tone="primary" mono>
                  {ra}
                </Pill>
              ))}
            </div>
          </Alert>
        )}
      </Card>

      <Card style={{ maxWidth: 640 }}>
        <div className="card-title">Ativação nesta turma</div>
        {status.loading && <Loading label="Carregando…" />}
        {status.error && <ErrorState message={status.error} onRetry={status.reload} />}
        {!status.loading && !status.error && (status.data ?? []).length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
            Ninguém importado nesta turma ainda.
          </p>
        )}
        {!status.loading && !status.error && (status.data ?? []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(status.data ?? []).map((s) => (
              <div
                key={s.usuario_id}
                style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}
              >
                <span style={{ flex: 1 }}>
                  {s.nome} <span className="mono" style={{ color: 'var(--c-text-subtle)' }}>· {s.matricula}</span>
                </span>
                {s.vinculado ? (
                  <Pill tone="ok">Vinculado a @{s.github_login}</Pill>
                ) : s.senha_definida ? (
                  <>
                    <Pill tone="warn">Aguardando vínculo do GitHub</Pill>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={resetar.pending}
                      onClick={() => resetar.run(s.usuario_id)}
                    >
                      Resetar senha
                    </Button>
                  </>
                ) : (
                  <Pill tone="neutral">Aguardando primeiro acesso</Pill>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Verificar tipos e testes**

Run: `cd crivo-front; npm run typecheck`
Expected: PASS (nenhum erro restante).

Run: `cd crivo-front; npm test`
Expected: PASS (a suíte inteira, incluindo `src/lib/importarAlunos.test.ts` do Task 9).

- [ ] **Step 3: Commit**

```bash
cd crivo-front
git add src/pages/professor/AlunosPage.tsx
git commit -m "feat(alunos): import por RA + listagem de ativacao com reset de senha"
```

---

## Task 14: Mock server — paridade com os novos endpoints

**Files:**
- Modify: `crivo-front/mock-server/data.mjs`
- Modify: `crivo-front/mock-server/server.mjs`

**Interfaces:**
- Nenhuma nova pro resto do front — só faz o mock responder aos endpoints consumidos pelas Tasks 8–13, pra `npm run mock` continuar sendo suficiente pra desenvolver/testar sem a API real.

- [ ] **Step 1: Adicionar um aluno pendente de exemplo**

Em `crivo-front/mock-server/data.mjs`, no array `usuarios`, adicionar como último elemento (depois do `id: 13`):

```js
  { id: 14, github_id: null, github_login: null, nome: 'Pedro Pendente de Vínculo', papel: 'ALUNO', matricula: '25-99999', senha_hash: null, criado_em: diasAtras(1) },
```

E no array `matriculas`, adicionar:

```js
export const matriculas = [
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((usuario_id) => ({ usuario_id, turma_id: 1 })),
  ...[2, 3, 4, 5].map((usuario_id) => ({ usuario_id, turma_id: 2 })),
  { usuario_id: 14, turma_id: 1 },
];
```

- [ ] **Step 2: Rotas de login por RA**

Em `crivo-front/mock-server/server.mjs`, adicionar logo depois de `const acharUsuario = ...`:

```js
/** Token de pré-ativação do mock: `mock-preauth-<id>-<etapa>`. */
function tokenPreAuth(usuarioId, etapa) {
  return `mock-preauth-${usuarioId}-${etapa}`;
}

function lerPreAuth(req) {
  const header = req.headers.authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  const m = /^mock-preauth-(\d+)-(redefinir_senha|vincular_github)$/.exec(token);
  if (!m) return null;
  return { usuario_id: Number(m[1]), etapa: m[2] };
}
```

E, na seção `/* auth ---------------------------------------------------------------------- */`, logo antes de `rota('GET', /^\/me$/, ...)`, adicionar:

```js
rota('POST', /^\/auth\/login-ra$/, (_req, res, { corpo }) => {
  const ra = String(corpo.ra ?? '').trim();
  const senha = String(corpo.senha ?? '');
  const usuario = estado.usuarios.find((u) => u.matricula === ra && u.papel === 'ALUNO');

  if (!usuario) return json(res, 401, { error: 'Credenciais inválidas' });
  if (usuario.github_login) {
    return json(res, 409, { error: 'Esta conta já está vinculada ao GitHub — entre com GitHub.' });
  }

  if (usuario.senha_hash === null || usuario.senha_hash === undefined) {
    if (senha !== ra) return json(res, 401, { error: 'Credenciais inválidas' });
    return json(res, 200, {
      preauth_token: tokenPreAuth(usuario.id, 'redefinir_senha'),
      etapa: 'redefinir_senha',
    });
  }

  if (senha !== usuario.senha_hash) return json(res, 401, { error: 'Credenciais inválidas' });
  return json(res, 200, {
    preauth_token: tokenPreAuth(usuario.id, 'vincular_github'),
    etapa: 'vincular_github',
  });
});

rota('POST', /^\/auth\/redefinir-senha$/, (req, res, { corpo }) => {
  const preauth = lerPreAuth(req);
  if (!preauth || preauth.etapa !== 'redefinir_senha') {
    return json(res, 401, { error: 'Token de pré-ativação inválido ou expirado' });
  }
  const senhaNova = String(corpo.senha_nova ?? '');
  if (senhaNova.length < 8) return json(res, 400, { error: 'Senha muito curta' });

  const usuario = estado.usuarios.find((u) => u.id === preauth.usuario_id);
  if (!usuario) return json(res, 404, { error: 'Usuário não encontrado' });
  usuario.senha_hash = senhaNova; // mock: texto puro, nunca faça isso na API real

  json(res, 200, {
    preauth_token: tokenPreAuth(usuario.id, 'vincular_github'),
    etapa: 'vincular_github',
  });
});
```

- [ ] **Step 3: Modo vínculo em `/auth/github` + novo `/auth/github/callback`**

Substituir a rota `rota('GET', /^\/auth\/github$/, ...)` inteira por:

```js
rota('GET', /^\/auth\/github$/, (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const state = url.searchParams.get('state');

  if (state) {
    const m = /^mock-preauth-(\d+)-vincular_github$/.exec(state);
    if (!m) {
      res.writeHead(302, { Location: 'http://localhost:5173/login' });
      return res.end();
    }
    const candidatos = ['github-fake-1', 'github-fake-2'].filter(
      (login) => !estado.usuarios.some((u) => u.github_login === login),
    );
    const opcoes = candidatos
      .map(
        (login) => `<li>
          <a href="/auth/github/callback?state=${encodeURIComponent(state)}&escolha=${login}">
            <strong>@${login}</strong>
            <span>conta fictícia para teste de vínculo</span>
          </a>
        </li>`,
      )
      .join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Mock OAuth · Crivo</title>
      <style>
        body{font-family:system-ui;background:#F7F8FA;color:#2A303C;display:flex;min-height:100vh;
          align-items:center;justify-content:center;margin:0}
        div{background:#fff;border:1px solid #D8DCE3;border-radius:14px;padding:28px 32px;width:380px}
        h1{font-size:18px;margin:0 0 4px}
        p{font-size:13px;color:#6B7385;margin:0 0 18px}
        ul{list-style:none;margin:0;padding:0}
        li{border-top:1px solid #EFF1F4}
        a{display:flex;flex-direction:column;gap:2px;padding:13px 4px;text-decoration:none;color:inherit}
        a:hover{background:#F7F8FA}
        span{font-size:12px;color:#6B7385}
      </style>
      <div><h1>Vincular conta do GitHub</h1>
      <p>Escolha a identidade fictícia que vai representar sua conta do GitHub.</p><ul>${opcoes}</ul></div>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  const opcoes = estado.usuarios
    .filter((usuario) => ['mtavares', 'joaopsilva', 'juliaribeiro'].includes(usuario.github_login))
    .map(
      (usuario) => `<li>
        <a href="http://localhost:5173/auth/callback?token=mock-${usuario.github_login}">
          <strong>${usuario.nome}</strong>
          <span>@${usuario.github_login} · ${usuario.papel.toLowerCase()}</span>
        </a>
      </li>`,
    )
    .join('');

  const html = `<!doctype html><meta charset="utf-8"><title>Mock OAuth · Crivo</title>
    <style>
      body{font-family:system-ui;background:#F7F8FA;color:#2A303C;display:flex;min-height:100vh;
        align-items:center;justify-content:center;margin:0}
      div{background:#fff;border:1px solid #D8DCE3;border-radius:14px;padding:28px 32px;width:380px}
      h1{font-size:18px;margin:0 0 4px}
      p{font-size:13px;color:#6B7385;margin:0 0 18px}
      ul{list-style:none;margin:0;padding:0}
      li{border-top:1px solid #EFF1F4}
      a{display:flex;flex-direction:column;gap:2px;padding:13px 4px;text-decoration:none;color:inherit}
      a:hover{background:#F7F8FA}
      span{font-size:12px;color:#6B7385;font-family:ui-monospace,monospace}
    </style>
    <div><h1>Mock do OAuth do GitHub</h1>
    <p>Escolha a conta com que deseja entrar no Crivo.</p><ul>${opcoes}</ul></div>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

rota('GET', /^\/auth\/github\/callback$/, (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const state = url.searchParams.get('state');
  const escolha = url.searchParams.get('escolha');
  const m = state && /^mock-preauth-(\d+)-vincular_github$/.exec(state);

  if (!m || !escolha) {
    res.writeHead(302, { Location: 'http://localhost:5173/login' });
    return res.end();
  }

  const usuario = estado.usuarios.find((u) => u.id === Number(m[1]));
  if (!usuario) {
    res.writeHead(302, { Location: 'http://localhost:5173/login' });
    return res.end();
  }

  const jaUsado = estado.usuarios.some((u) => u.github_login === escolha && u.id !== usuario.id);
  if (jaUsado) {
    res.writeHead(302, { Location: 'http://localhost:5173/login?error=github_ja_vinculado' });
    return res.end();
  }

  usuario.github_id = String(700000 + usuario.id);
  usuario.github_login = escolha;

  res.writeHead(302, { Location: `http://localhost:5173/auth/callback?token=mock-${escolha}` });
  res.end();
});
```

- [ ] **Step 4: Trocar o import de matrículas + adicionar listagem e reset de senha**

Substituir a rota `rota('POST', /^\/prof\/turmas\/(\d+)\/matriculas$/, ...)` existente inteira por:

```js
rota('GET', /^\/prof\/turmas\/(\d+)\/matriculas$/, (_req, res, { params }) => {
  const turmaId = Number(params[0]);
  const linhas = estado.matriculas
    .filter((m) => m.turma_id === turmaId)
    .map((m) => {
      const usuario = acharUsuario(m.usuario_id);
      return {
        usuario_id: usuario.id,
        nome: usuario.nome,
        matricula: usuario.matricula,
        github_login: usuario.github_login,
        senha_definida: usuario.senha_hash !== null && usuario.senha_hash !== undefined,
        vinculado: usuario.github_login !== null,
      };
    });
  json(res, 200, linhas);
}, { professor: true });

rota('POST', /^\/prof\/turmas\/(\d+)\/matriculas$/, (_req, res, { params, corpo }) => {
  const turmaId = Number(params[0]);
  const importados = [];

  for (const item of corpo.matriculas ?? []) {
    const ra = String(item.ra ?? '').trim();
    const nome = String(item.nome ?? '').trim();
    if (!ra || !nome) continue;

    let usuario = estado.usuarios.find((x) => x.matricula === ra);
    if (!usuario) {
      usuario = {
        id: Math.max(...estado.usuarios.map((x) => x.id)) + 1,
        github_id: null,
        github_login: null,
        nome,
        papel: 'ALUNO',
        matricula: ra,
        senha_hash: null,
        criado_em: new Date().toISOString(),
      };
      estado.usuarios.push(usuario);
    }
    if (!estado.matriculas.some((m) => m.usuario_id === usuario.id && m.turma_id === turmaId)) {
      estado.matriculas.push({ usuario_id: usuario.id, turma_id: turmaId });
    }
    importados.push(ra);
  }

  json(res, 200, { success: true, imported: importados });
}, { professor: true });

rota('POST', /^\/prof\/alunos\/(\d+)\/resetar-senha$/, (_req, res, { params }) => {
  const id = Number(params[0]);
  const usuario = estado.usuarios.find((u) => u.id === id && u.papel === 'ALUNO');
  if (!usuario) return json(res, 404, { error: 'Aluno not found' });
  if (usuario.github_login) {
    return json(res, 409, { error: 'Aluno já vinculado ao GitHub — reset não é necessário' });
  }
  usuario.senha_hash = null;
  json(res, 200, { success: true, usuario });
}, { professor: true });
```

- [ ] **Step 5: Atualizar o log de boot**

Em `crivo-front/mock-server/server.mjs`, no `servidor.listen(...)`, trocar o corpo do `console.log` para incluir a nova conta de teste:

```js
servidor.listen(PORTA, () => {
  console.log(`\n  Mock da crivo-api em http://localhost:${PORTA}`);
  console.log('  Contas GitHub: mtavares (professor) · joaopsilva (aluno) · juliaribeiro (aluno sem atividade)');
  console.log('  Conta RA (primeiro acesso): RA 25-99999, senha 25-99999');
  console.log(`  Login:  http://localhost:${PORTA}/auth/github\n`);
});
```

- [ ] **Step 6: Verificar manualmente**

Run: `cd crivo-front; npm run mock` (terminal 1) e `npm run dev` (terminal 2)
Expected: em `http://localhost:5173/login`, entrar com RA `25-99999` e senha `25-99999` leva a `/ativar/senha`; depois de definir uma senha nova, leva a `/ativar/github`; clicar em "Vincular com GitHub" abre o picker fictício do mock e, ao escolher uma conta, cai logado em `/aluno`.

- [ ] **Step 7: Commit**

```bash
cd crivo-front
git add mock-server/data.mjs mock-server/server.mjs
git commit -m "feat(mock): paridade com login por RA e vinculo de GitHub"
```

---

## Self-Review

**Cobertura do spec** (`crivo-api/docs/superpowers/specs/2026-07-31-ra-login-design.md`):
- Modelo de dados → Task 1 (com a correção: `matricula` fica `String? @unique`, não obrigatório — professores não têm RA; o spec dizia "obrigatório" de forma imprecisa, a migration segue a semântica correta).
- Import por RA → Task 5.
- `POST /auth/login-ra`, `POST /auth/redefinir-senha` → Tasks 2, 3.
- Vínculo do GitHub + redirect do callback → Task 4.
- Escape hatch (`resetar-senha`) → Task 6.
- Front: `LoginPage`, telas de ativação, rotas, `AlunosPage` → Tasks 10–13.
- Mock server → Task 14.
- Testes descritos no spec → cobertos nas Tasks 2, 3, 4, 5, 6, 9 (backend com Vitest+mocks de Prisma; front só na lógica pura, conforme convenção do projeto).

**Scan de placeholder:** nenhum `TBD`/`TODO` — todo step tem código completo.

**Consistência de tipos:** `PreAuthPayload`, `signPreAuthToken`, `verifyPreAuthToken`, `requirePreAuth` definidos uma vez no Task 2 e reusados nos Tasks 3–4 com a mesma assinatura. `LoginRaResposta { preauth_token, etapa }` é o mesmo shape em backend (Tasks 2–3) e front (Task 8) e mock (Task 14). `StatusMatricula` idem entre Tasks 5, 8, 13, 14.

---

**Plan complete and saved to `crivo-api/docs/superpowers/plans/2026-07-31-ra-login-plan.md`.** Duas opções de execução:

**1. Subagent-Driven (recomendado)** — dispatco um subagente por task, com revisão entre elas, iteração rápida.

**2. Inline Execution** — executo as tasks nesta sessão via `executing-plans`, em lote com checkpoints.

Qual prefere?
