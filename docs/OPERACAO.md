# OPERACAO.md — Runbook do Crivo

> Manual de operação. Leitor-alvo: o professor operando o sistema (hoje, Flávio) ou um sucessor assumindo do zero. Para o *porquê* das escolhas, ver `DECISOES.md`. Para orientação de código, ver `CLAUDE.md`.

---

## 1. Mapa de onde tudo mora

| Peça | Onde | Acesso |
|---|---|---|
| GitHub Organization | `github.com/faminas-ads` | Owner: conta pessoal `FlavioAAMotta` (adicionar 2º owner é pendência de resiliência) |
| GitHub App | Settings da org → Developer settings → GitHub Apps → **crivo-faminas** | Só owners da org |
| Deploy | Railway, projeto com 4 serviços: `api`, `worker`, `Postgres`, `Redis` | Login Railway via GitHub `FlavioAAMotta` |
| Domínio público | `https://crivo-api-production-eb84.up.railway.app` | Gerado no serviço `api` (worker NÃO tem domínio) |
| Código | Repositório `crivo-api` (GitHub pessoal) | Push na `main` = deploy automático de api e worker |
| Swagger | `{domínio}/docs` | Público (rotas protegidas exigem login) |

### ⚠ Os 3 pontos de acoplamento do domínio
Se o domínio Railway mudar (recriação do serviço, migração de plataforma), atualizar **três lugares**, ou webhook e login quebram:
1. GitHub App → **Webhook URL** = `{domínio}/webhooks/github`
2. GitHub App → **Callback URL** = `{domínio}/auth/github/callback`
3. Variável **`APP_BASE_URL`** nos serviços api e worker

## 2. Configuração da Organization (estado esperado)

- Plano **Free** (suficiente; aplicação GitHub Education como teacher em andamento — benefício, não dependência).
- **Member privileges → Base permissions: "No permission"**.
- Alunos **não são membros** da org: entram como *collaborators* apenas no(s) próprio(s) repositório(s). Membros: professores/monitores apenas.
- Criação de repositórios: restrita a owners (quem cria é o App, via API).

## 3. Configuração do GitHub App (estado esperado)

- **Permissões de repositório** (somente estas): Administration RW · Contents RW · Metadata read. Nada de Organization permissions.
- **Eventos assinados**: Push (Repository e Member opcionais para auditoria).
- **Webhook**: Active, URL do ponto de acoplamento 1, **secret** = mesmo valor de `GITHUB_WEBHOOK_SECRET` (a igualdade dos dois lados é o que faz a validação HMAC passar).
- **Callback URLs**: a de produção + `http://localhost:3000/auth/github/callback` (o App aceita múltiplas; mantém dev e produção no mesmo App).
- **Instalação**: na org `faminas-ads`, escopo **All repositories** (inclui repositórios futuros criados pelo próprio sistema).
- **Where can this app be installed**: Only on this account.
- Obs. de tela: no formulário de *criação* do App a seção "Subscribe to events" pode não renderizar; criar o App e configurar eventos depois em *Permissions & events* funciona sempre.

## 4. Variáveis de ambiente — o que são e onde re-obter

| Variável | O que é | Onde re-obter se perder |
|---|---|---|
| `GITHUB_APP_ID` | ID numérico do App | Página do App → General → "About" (público) |
| `GITHUB_PRIVATE_KEY` | Chave privada `.pem` do App, **em uma linha com `\n` literais** | **Irrecuperável**: GitHub não reexibe. Gerar nova em General → Private keys → *Generate a private key* (baixa novo .pem; apagar chaves antigas da lista) |
| `GITHUB_WEBHOOK_SECRET` | Secret HMAC do webhook | **Irrecuperável** (campo não reexibe). Gerar novo (`openssl rand -hex 32`) e colar **nos dois lados na mesma hora**: campo Secret do App + variável |
| `GITHUB_OAUTH_CLIENT_ID` | Client ID do App (`Iv1.…`) | Página do App → General (público) |
| `GITHUB_OAUTH_CLIENT_SECRET` | Segredo OAuth | **Irrecuperável**. General → Client secrets → *Generate a new client secret* (aparece uma única vez) |
| `GITHUB_ORG` | `faminas-ads` | — |
| `DATABASE_URL` / `REDIS_URL` | Conexões | No Railway: referências `${{Postgres.DATABASE_URL}}` e `${{Redis.REDIS_URL}}` (o Railway resolve). Local: docker-compose (postgres:postgres@localhost:5432/crivo, redis://localhost:6379) |
| `JWT_SECRET` | Assinatura das sessões | É nosso: gerar (`openssl rand -base64 48`). Trocar só invalida sessões ativas |
| `APP_BASE_URL` | URL pública da API | Domínio Railway (sem barra final) |
| `PROFESSOR_LOGINS` | Logins GitHub que nascem PROFESSOR | `flavioaamotta` (minúsculo). Regra: promove, nunca rebaixa |
| `NODE_ENV` | `production` no Railway | — |

Regra geral: **todo segredo vai para o gerenciador de senhas no momento em que é gerado** — três deles são irrecuperáveis por design.

## 5. Railway — estado esperado dos serviços

| Serviço | Build Command | Start Command | Domínio |
|---|---|---|---|
| `api` | vazio (autodetect) ou `npm ci && npm run build` | `npx prisma migrate deploy && npm start` | Sim (o público) |
| `worker` | idem | `npm run start:worker` | **Não** |
| `Postgres` / `Redis` | gerenciados | — | — |

- Ambos os serviços apontam para o **mesmo repositório** `crivo-api` e recebem **o mesmo conjunto de variáveis** (o worker também precisa das credenciais do GitHub: jobs de stats e congelador chamam a API do GitHub).
- Migrations aplicam no start da API (`migrate deploy`). **Nunca usar `prisma db push`** (ver DECISOES).
- O congelador se agenda sozinho no boot do worker (repeatable 60s, jobId fixo).

## 6. Rotina por período letivo

**Início de semestre (checklist):**
1. Criar/revisar repositórios-template na org (marcar caixinha *Template repository*). Um genérico cobre a maioria dos labs; dedicados onde há esqueleto de código com interface padronizada (bancadas dependem disso).
2. Cadastrar disciplina → turmas → trabalhos (cada lab semanal é um trabalho; template, `janela_inicio`, deadline, congelamento automático — padrão dos labs: domingo 23h59).
3. Matricular alunos (por github_login/e-mail).
4. Onboarding em aula: aluno loga com GitHub, cadastra e-mails de commit, aceita termo de transparência, cria o primeiro repo.

**Semanal:** revisar fila de sinalizações (decisão PROCEDE/DESCARTADA sempre com nota — imutável depois); olhar a grade (repos sem push, `setup_status=ERRO`).

**Raro:** rotação de segredos (vazamento); atualização dos 3 pontos de acoplamento (mudança de domínio).

## 7. Teste de fumaça (validação de ambiente, ~30 min)

Rodar após qualquer mudança estrutural (deploy novo, rotação de chaves, migração):

1. `.env`/variáveis reais conferidos (seção 4).
2. Banco migrado, seed aplicado (dev) / migrations no log de start (prod).
3. Webhook apontado ao ambiente (prod: domínio; dev local: túnel — **smee é bloqueado pela rede da IES**, testar de casa/4G ou direto em prod).
4. Dois processos vivos: logs da api (Fastify escutando) e do worker (Redis conectado, congelador agendado).
5. Conta GitHub **aluno-teste** separada (rotas de aluno checam ownership; testar como professor não exercita o caminho real). Login + e-mail de commit cadastrado.
6. Template genérico na org com caixinha marcada.
7. Como professor: disciplina → turma → matrícula do aluno-teste → trabalho com deadline daqui a ~15 min.
8. Como aluno: `POST /trabalhos/:id/repositorio` → conferir no GitHub: repo na org, aluno collaborator, branch protection na main; no banco, `setup_status` saudável.
9. Clonar com a conta-teste, commit, push → conferir cascata: `pushes` (pusher = aluno-teste) e `commits` com `stats_status` PENDENTE→CALCULADO.
10. Forçar sinalização: `git -c user.name="Fulano" -c user.email="fulano@nada.com" commit --allow-empty -m t` + push → nascem AUTOR_NAO_RECONHECIDO e divergência individual. Revisar via PATCH com nota; conferir imutabilidade.
11. Deadline vence → congelador varre (≤60s): tag `entrega-1` no GitHub + linha em `entregas`. Testar `?force=true` → `entrega-2`.
12. Como aluno: `GET /me/repositorios/:id/metricas` → ele vê o mesmo que o professor, inclusive a sinalização que o cita.

## 8. Depuração de webhooks

Ferramenta permanente: página do App → **Advanced → Recent Deliveries** — histórico completo (payload, resposta, status) com botão **Redeliver** para reenviar qualquer evento (inclusive o `ping`). Substituiu o smee.

- Entrega com **401** → secret divergente entre App e variável (erro nº 1 do gênero).
- Entrega com **404/timeout** → URL do webhook errada ou API fora do ar.
- Push chegou mas nada processou (`stats_status` eternamente PENDENTE, sem sinalizações) → **worker não está rodando**; jobs acumulando no Redis.

## 9. Erros conhecidos (reais, já vividos) e correções

| Sintoma | Causa | Correção |
|---|---|---|
| `docker compose up` → "npipe:… O sistema não pode encontrar o arquivo" | Docker Desktop (daemon) desligado no Windows | Abrir Docker Desktop, esperar "running", repetir. Marcar *Start when you sign in* |
| smee.io não recebe nada na faculdade | Rede da IES bloqueia o smee | Testar de casa/4G, ou (adotado) webhook direto no domínio de produção + Recent Deliveries |
| Deploy do worker: "Build Failed … `sh -c npm run start:worker` … Cannot find module dist/…" | Start command colado no campo **Build Command** — o comando de processo rodou na fase de build, antes de existir `dist/` | Build Command vazio/`npm ci && npm run build`; comando de processo em **Deploy → Custom Start Command** |
| `/docs` → **502 em ~2ms** | Nenhum processo escutando atrás do domínio (start quebrado, ou listen em `localhost`/porta errada) | Corrigir start; garantir `listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })` |
| Build falha por falta de `tsc` (aviso `--omit=dev` no log) | Instalação sem devDependencies | Variável `NPM_CONFIG_PRODUCTION=false` ou build `npm install --include=dev && npm run build` |
| 404 `Route GET:/app/auth/github not found` | `/app` sobrando na URL digitada (contaminação do caminho do contêiner) | Rotas são na raiz: `/auth/github` |
| Tela GitHub "Be careful! The redirect_uri is not associated…" | Callback URL do App ≠ `APP_BASE_URL + /auth/github/callback` (localhost esquecido, barra final, `/app`) | Igualar caractere a caractere os dois lados; **Save changes**; se mexeu na variável, esperar o redeploy |
| Login funciona mas papel vem ALUNO | `PROFESSOR_LOGINS` divergente do github_login | Corrigir variável (minúsculo); regra promove no próximo login |

## 10. Pendências registradas

- 2º owner na org (fator ônibus).
- Guia do aluno (1 página: o que o Crivo coleta, transparência, como entregar) — metade onboarding, metade compromisso LGPD.
- Conteúdo dos templates (genérico, lab01 com Cronometro/Main, etapa1 com esqueleto `ListaDupla.java`, etapa2 `ArvoreBST.java`).
- Frontend (protótipo do lado professor existe no Claude Design; lado aluno não iniciado).
- Calibrar thresholds dos detectores com a primeira turma real, em modo observação (esperar falsos positivos de divergência em duplas que pareiam numa máquina só).
