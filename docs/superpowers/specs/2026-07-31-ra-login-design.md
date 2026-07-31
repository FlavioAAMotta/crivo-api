# Login por RA + vínculo obrigatório de GitHub

Data: 2026-07-31
Repos afetados: `crivo-api` (schema, auth, import de matrículas), `crivo-front` (telas de login/ativação, import), `crivo-front/mock-server` (paridade de rotas)

## Contexto

Hoje o único jeito de entrar no Crivo é OAuth do GitHub (`docs/DECISOES.md` D3/D9), e a importação de alunos (`POST /prof/turmas/:id/matriculas`) exige `github_login` no momento do import — a API resolve o login via API do GitHub antes de criar o `Usuario`.

Isso não corresponde ao fluxo real de sala de aula: o professor recebe uma lista de matrícula (RA + Nome civil/social) direto do sistema acadêmico, sem nenhuma informação de GitHub — quem associa a conta GitHub é o próprio aluno, depois. Hoje isso é impossível de representar: `Usuario.github_id`/`github_login` são obrigatórios e únicos no schema, então não existe "aluno cadastrado, GitHub pendente".

## Objetivo

1. Professor importa alunos colando `RA<TAB>Nome(Status)` de uma planilha — sem precisar saber o GitHub de ninguém.
2. Aluno faz o primeiro acesso com **RA como usuário e RA como senha inicial**, é **obrigado** a trocar a senha, e **obrigado** a vincular sua conta GitHub antes de qualquer outra coisa.
3. A partir do vínculo, o aluno usa exclusivamente GitHub OAuth — a senha nunca mais é usada (não é um segundo método permanente de login).
4. `/login` já nasce como a tela de entrada de verdade — RA+senha funcional, sem gate escondido atrás de outra tela.

## Fora de escopo

- Fluxo de "esqueci minha senha" permanente (a senha só existe como portão de ativação único).
- Qualquer verificação de identidade além do RA em si na hora da troca de senha (aceito por decisão do usuário — risco de RA-como-senha-padrão é aceito, é prática comum em sistemas acadêmicos brasileiros).
- Mudança de comportamento para `PROFESSOR` (continua só GitHub OAuth, promovido via `PROFESSOR_LOGINS`, nasce sempre com `github_id`).
- Múltiplos provedores de auth além de GitHub (não generalizamos para um modelo de "credenciais plugáveis" — YAGNI, o projeto só usa GitHub como identidade de longo prazo).

## Modelo de dados (`crivo-api/prisma/schema.prisma`)

```prisma
model Usuario {
  id                   Int       @id @default(autoincrement())
  github_id            BigInt?   @unique   // era obrigatório
  github_login         String?   @unique   // era obrigatório
  nome                 String
  papel                Papel
  matricula            String    @unique   // era opcional; agora é o RA, âncora da identidade
  senha_hash           String?              // novo. null = senha ainda é o próprio RA
  senha_redefinida_em  DateTime?            // novo
  criado_em            DateTime  @default(now())
  // ...relations inalteradas
}
```

Estados possíveis de um `Usuario` com `papel = ALUNO`:

| Estado | `github_id` | `senha_hash` | Como chegou aqui |
| --- | --- | --- | --- |
| Importado, sem GitHub | `null` | `null` | Import por RA |
| Senha trocada, sem GitHub | `null` | setado | `POST /auth/redefinir-senha` |
| Completo | setado | setado | Vínculo GitHub concluído |

`Usuario` com `papel = PROFESSOR` sempre nasce e permanece no estado "Completo" (nunca passa pelo fluxo de RA) — nenhuma mudança de comportamento para professores.

Migration: `npx prisma migrate dev --name ra_como_ancora_de_identidade`. Requer popular `matricula` pra qualquer `Usuario` existente que hoje tenha `matricula = null` antes de tornar a coluna `@unique` (dados de dev/seed atuais têm `matricula` preenchido para alunos — conferir e ajustar seed se necessário).

## Import de matrícula (professor)

`crivo-front`: nova área de colar texto em **Alunos → Importar matrículas**, formato:

```
RA	Nome Civil ou Nome Social
25-13353	BRENO MOREIRA SOARES(Matriculado)
```

Parser client-side (`parsearLinhasRA`):
- Separador: tab ou múltiplos espaços.
- Extrai `ra`, `nome` (removendo sufixo `(Status)`), `status`.
- **Só linhas com `status === 'Matriculado'` seguem para o import.** As demais entram num resumo "N linhas ignoradas" exibido ao professor, sem travar o restante.
- Dedupe de RA repetido na mesma colagem antes de enviar.

`crivo-api`: `POST /prof/turmas/:id/matriculas` muda de schema —

```ts
const importarMatriculasBodySchema = z.object({
  matriculas: z.array(z.object({
    ra: z.string().min(1),
    nome: z.string().min(1),
  })),
});
```

Handler, por item:
- `Usuario` já existe com essa `matricula` (importado antes, em outra turma) → só garante o vínculo `Matricula(turma_id, usuario_id)`, sem tocar em `github_id`/`senha_hash`.
- Não existe → cria `Usuario` (`papel: 'ALUNO'`, `matricula: ra`, `nome`, `github_id: null`, `github_login: null`, `senha_hash: null`) + `Matricula`.

Sem chamada à API do GitHub nesse endpoint — remove a dependência de rate limit que existia no fluxo antigo.

## Autenticação por RA (novos endpoints, `crivo-api`)

Token de pré-ativação: JWT curto (~15min), separado do JWT de sessão normal, claims `{ usuario_id, etapa: 'redefinir_senha' | 'vincular_github' }`. Nunca aceito em nenhuma rota autenticada normal (`requireAuth`/`requireProfessor` continuam exigindo o JWT de sessão de sempre).

**`POST /auth/login-ra`** — body `{ ra: string, senha: string }`
- `Usuario` não encontrado por `matricula = ra`, ou `papel !== 'ALUNO'` → `401` genérico ("credenciais inválidas"). Executa uma comparação bcrypt dummy mesmo no caminho de "não encontrado" pra manter tempo de resposta constante (evita side-channel de enumeração de RA).
- `github_id` já setado → `409`, mensagem "Esta conta já está vinculada ao GitHub — entre com GitHub."
- `senha_hash === null` → válido apenas se `senha === ra`. Emite token de pré-ativação `etapa: 'redefinir_senha'`.
- `senha_hash` setado → `bcrypt.compare(senha, senha_hash)`. Válido → token de pré-ativação `etapa: 'vincular_github'`.

**`POST /auth/redefinir-senha`** — `Authorization: Bearer <token pré-ativação>`, body `{ senha_nova: string.min(8) }`
- Rejeita se o token não estiver exatamente na etapa `redefinir_senha` (evita reuso fora de ordem).
- `senha_hash = bcrypt.hash(senha_nova)`, `senha_redefinida_em = now()`.
- Emite novo token de pré-ativação, `etapa: 'vincular_github'`.

**`POST /prof/alunos/:id/resetar-senha`** — só professor. Zera `senha_hash = null` (aluno volta a poder entrar com RA+RA e refazer a troca). Escape hatch para quando o aluno abandona o fluxo entre trocar a senha e vincular o GitHub — sem isso ele fica travado sem conseguir se auto-recuperar (mesmo princípio de D11: falha operacional tem que ser visível e acionável, não um beco sem saída).

## Vínculo do GitHub (reaproveita `GET /auth/github` + `GET /auth/github/callback`)

- Botão "Vincular GitHub" no front envia o token de pré-ativação (`etapa: 'vincular_github'`) como `state` na URL de autorização do GitHub.
- No callback: se `state` decodifica um token de pré-ativação válido nessa etapa, o handler NÃO segue o fluxo normal de find-or-create por `github_id` — em vez disso, localiza o `Usuario` pelo `usuario_id` do token e faz `UPDATE` setando `github_id`/`github_login`.
  - Esse `github_id` já pertence a outro `Usuario` → erro claro, nenhuma escrita.
  - Sucesso → emite o JWT de sessão completo (formato de hoje: `id, github_id, github_login, papel, iat, exp`) e **redireciona** para `${FRONTEND_URL}/auth/callback?token=...` (fecha a lacuna hoje documentada no `CLAUDE.md` do front, onde a API respondia com JSON cru).
- `state` ausente/inválido → comportamento de hoje, sem regressão para o login normal de professor (ou aluno já vinculado, se algum dia reentrar aqui por engano).

## Front (`crivo-front`)

- `LoginPage` reestruturada: formulário RA+senha como conteúdo principal; "Entrar com GitHub" vira link secundário ("Sou professor"). Entrada manual de token mantida como fallback discreto.
- Novas telas: `PaginaRedefinirSenha` (form senha nova + confirmação, chama `redefinir-senha`, navega para vincular), `PaginaVincularGithub` (explica a etapa, botão único que inicia o OAuth com `state`).
- `CallbackPage`: simplifica — com o redirect corrigido na API, o caso `?token=` ausente vira exceção rara; lógica de entrada manual permanece como já existe hoje.
- `AlunosPage`: aba de import trocada para RA+Nome (formato acima); novo botão "Resetar senha" por aluno pendente de vínculo, chamando o endpoint do professor.
- `src/api/endpoints.ts` / `src/api/types.ts`: novas funções e tipos para `loginRa`, `redefinirSenha`, `resetarSenha`, e o novo formato de `importarMatriculas`.

## Mock server (`crivo-front/mock-server/server.mjs`)

Implementa os três endpoints novos e o novo formato de import — sem isso o front fica dependente da API real pra ser desenvolvido, quebrando a convenção já documentada no `CLAUDE.md` do front ("o mock não é um segundo backend... se uma rota mudar na API, o mock muda junto").

## Casos de borda

- RA duplicado na mesma colagem → dedupe no parser antes de enviar.
- Token de pré-ativação expira no meio do fluxo (15min) → front detecta `401`, volta para `/login` com aviso de sessão expirada.
- Aluno abandona entre trocar senha e vincular GitHub → coberto pelo escape hatch do professor (`resetar-senha`).
- `github_id` que alguém tenta vincular já pertence a outro `Usuario` (inclusive professor) → rejeitado, nenhuma escrita parcial.

## Testes (vitest, mocks de Prisma/octokit — sem DB real, seguindo o padrão existente)

- Parser RA+Nome+Status (`crivo-front`): extração, filtro por status, dedupe.
- `POST /auth/login-ra`: as 4 transições de estado (não encontrado, já vinculado, primeiro acesso, senha trocada sem vínculo) + tempo constante na falha.
- `POST /auth/redefinir-senha`: rejeita token fora da etapa certa ou expirado.
- Callback do GitHub em modo vínculo: sucesso, conflito de `github_id` já usado, `state` ausente (zero regressão no fluxo normal).
- `POST /prof/alunos/:id/resetar-senha`: só professor, idempotente.

## Dependência nova

`bcrypt` (ou `@node-rs/bcrypt`) em `crivo-api` — não existe hoje no `package.json`.
