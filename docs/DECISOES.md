# DECISOES.md — Registro de decisões do Crivo

> ADRs informais: o *porquê* de cada escolha estrutural, para que ninguém (humano ou IA) "melhore" o sistema desfazendo uma decisão que tinha razão de ser. Formato: decisão → contexto → justificativa → alternativa rejeitada e por quê. Operação em `OPERACAO.md`; orientação de código em `CLAUDE.md`.

---

## D1. Filosofia: o sistema sinaliza, o humano decide

**Decisão:** nenhuma métrica ou detector produz punição, nota ou juízo automático. Detectores geram `sinalizacoes` com evidência anexada; o professor revisa (PROCEDE/DESCARTADA) com **nota obrigatória**, e a decisão fica imutável (correção = nova sinalização manual).

**Justificativa:** (1) padrões suspeitos têm explicações legítimas — divergência pusher×autor em equipe pode ser pareamento na máquina de um só; sem atividade pode ser licença médica; o sistema não tem contexto, o professor tem. (2) Defensabilidade: numa contestação de nota, "decisão do professor informada por evidência datada" sustenta; "um script decidiu" não. (3) Pedagogia: sinalização é convite à conversa, não veredito — a diferença entre crivo e tribunal.

**Rejeitado:** score automático de contribuição / corte de nota por métrica. Linhas de código são trivialmente gameáveis (colar arquivo, reformatar tudo) e métrica punitiva ensina a burlar métrica, não a trabalhar.

**Corolário (transparência LGPD):** o aluno vê sobre si exatamente o que o professor vê (`GET /me/repositorios/:id/metricas`), incluindo sinalizações que o citam. Vigilância opaca educa menos do que medição declarada; e o professor que ensina LGPD aplicada entrega um sistema exemplar nisso.

## D2. Rastreabilidade: pusher é fato, autor é declaração

**Decisão:** o mecanismo central de veracidade é o cruzamento entre o **autor declarado** do commit e o **pusher autenticado** do push, capturado via webhook.

**Contexto:** a autoria de commit vem do `git config user.name/email` local — qualquer aluno commita "em nome" de qualquer colega, o Git não verifica nada. Medir contribuição só por autoria mede uma declaração falsificável.

**Justificativa:** o push exige autenticação real no GitHub; o payload do webhook entrega `sender` (quem empurrou, com certeza criptográfica) ao lado dos autores declarados de cada commit. Analogia canônica: o commit é a carta (remetente escrito à mão); o push é entregar a carta na portaria mostrando documento com foto. Guardamos os dois e a leitura nasce do cruzamento.

**Interpretação por contexto (não mover para regra única):** em repo INDIVIDUAL, divergência pontual já é sinal; em EQUIPE, divergência pontual é vida normal (par-programming) e o sinal é apenas o **padrão sistemático** (thresholds em `config.detectors`).

**Muletas complementares:** force push é **sinalizado** quando ocorre (reescrita de histórico = adulteração de evidência). O ideal seria *bloqueá-lo* por ruleset na main, mas isso não está disponível no plano atual (ver correção em D14) — a garantia é a **detecção** pelo webhook, não a prevenção; e-mails de commit declarados pelo aluno no onboarding (`emails_commit`) — autor não reconhecido também sinaliza.

## D3. Identidade de máquina: GitHub App, não PAT nem conta-robô

**Decisão:** todas as ações na org e o recebimento de webhooks acontecem via GitHub App `crivo-faminas`, autenticado por chave privada → installation tokens efêmeros.

**Contexto:** "token genérico da org" não existe — no modelo do GitHub, organização é lugar, não ator; todo token pertence a uma identidade.

**Justificativa:** (1) autenticação por criptografia assimétrica: a chave privada nunca trafega, só assinaturas; um PAT é o segredo em si. (2) Tokens de trabalho expiram em 1h e carregam só as permissões declaradas (Administration RW, Contents RW, Metadata) naquela org — vazamento tem raio de dano mínimo e prazo de validade. (3) Permissões vivem na identidade, não no uso: o App *não consegue* agir fora das caixas marcadas, ainda que o código peça. (4) O App é simultaneamente braço (API) e ouvido (webhook com secret próprio), uma peça para os dois lados. (5) Auditoria institucional: ações aparecem como `crivo-faminas[bot]`, não como o professor — distinção valiosa em contencioso. (6) Desacoplamento de pessoa física: o sistema não morre com a conta pessoal do criador.

**Rejeitados:** PAT pessoal (poder total da conta, atribuição pessoal, expiração surpresa, sem webhook embutido, ponto único de falha com nome próprio); conta-robô com PAT (fantoche com e-mail/senha/2FA para gerenciar — a gambiarra que o App veio aposentar).

**Parcimônia como regra viva:** o plano de implementação chegou a propor permissões extras (Pull Requests, Commit statuses, Org Members/Administration); foram cortadas por não servirem a nenhuma funcionalidade. Adicionar permissão depois é um clique; carregar permissão ociosa é risco permanente.

## D4. Granularidade: um repositório por aluno por trabalho

**Decisão:** cada trabalho gera um repo próprio por aluno/equipe, criado de template. Cada lab semanal é um "trabalho" no sistema; um template genérico serve à maioria, templates dedicados onde há esqueleto de código.

**Contexto:** o desenho original era repo por aluno por *disciplina* com trabalhos em pastas; mudou na revisão do plano de implementação e foi refinado depois (labs como trabalhos próprios).

**Justificativa:** (1) *generate from template* só funciona limpo em repo novo — no repo-por-disciplina, cada trabalho novo exigiria gambiarra de commit de pasta. (2) Congelamento trivial e sem ambiguidade: uma tag de entrega por repo (no modelo antigo: congelar o repo inteiro por causa do lab02 com o lab03 em andamento?). (3) Detectores com escopo natural ("sem atividade *neste trabalho*"). (4) Repo criado no dia do uso carrega o template *daquele dia* — melhorias de material chegam aos alunos sem atualização retroativa (que o mecanismo de template não tem: template é carimbo, não cordão umbilical; editar o template não afeta repos já nascidos — e isso é bom: repositório de aluno é evidência). (5) Microgestão por lab na grade (criado/sem push/entregue) em vez de arqueologia de pastas. (6) Ritual semanal criar→clonar→commitar→push é treino de Git disfarçado de logística.

**Custo aceito e mitigação:** mais repos por aluno (~15/semestre) — irrelevante tecnicamente; visão longitudinal do aluno nasce do **banco** (agregação de todos os repos), não da estrutura Git, então nada se perde. Manutenção de templates contida: 4–6 reais, não 15 (genérico reutilizado + dedicados apenas onde a interface padronizada importa — as provas de bancada assumem os nomes de métodos do esqueleto).

## D5. Congelamento de entrega como evidência formal

**Decisão:** no deadline (job repetível de 60s) ou manualmente, o sistema grava o SHA do HEAD e cria a tag `entrega-N` no repo + linha em `entregas`. N contado **por repositório** (a tag mora no repo). `force=true` no endpoint manual gera reentrega (`entrega-N+1`) para prazos estendidos. O endpoint manual **não** reescreve o deadline do trabalho (efeito colateral destrutivo removido). Idempotência: repo com `Entrega` é pulado na varredura automática — remover esse skip faria cada varredura cunhar tag nova.

**Justificativa:** mata o "professor, eu tinha feito, só subi depois" com prova técnica datada; commits pós-congelamento existem, mas fora da evidência de avaliação. É a feature de maior retorno por linha de código do sistema.

## D6. Dois processos: API e worker

**Decisão:** produção roda `api` (HTTP; webhooks apenas **enfileiram**) e `worker` (consome stats-commit, detector, repo-setup, congelador) como processos separados do mesmo código.

**Justificativa:** o GitHub espera resposta do webhook em ~10s; e o enriquecimento exige uma chamada de API **por commit** (o payload do push não traz additions/deletions), sujeita a latência, falha e rate limit — dois ritmos incompatíveis que pedem um amortecedor (a fila) e um consumidor independente. Retry com backoff transforma falha de rede às 2h da manhã de "dado perdido" em "tenta de novo"; a fila persiste trabalho pendente através de reinícios.

**Cicatriz registrada:** a primeira versão do código tinha os jobs escritos e **nenhum processo consumindo** ("corpo sem coração") — webhook gravava, fila enchia, nada acontecia. Sintoma diagnóstico: `stats_status` eternamente PENDENTE e zero sinalizações. Se tocar em execução de jobs, garantir que o entrypoint do worker existe e roda.

## D7. Fila: BullMQ + Redis, com porta de saída pg-boss

**Decisão:** BullMQ sobre Redis para jobs, retries/backoff e agendamento (congelador repetível).

**Justificativa:** resposta padrão do ecossistema Node — madura, recursos prontos, qualquer dev/IA conhece.

**Honestidade dimensionada:** para a escala real (turmas de dezenas, centenas de pushes/semana), o Redis é a única infra que existe *só* para a fila; BullMQ é dimensionado três ordens de grandeza acima da necessidade. **Porta de saída registrada:** `pg-boss` (fila dentro do Postgres já existente) cobre os mesmos conceitos (retry, backoff, cron) eliminando um serviço. Migrar não muda o desenho — muda só quem guarda a lista de pendências. Acionar se o Redis virar atrito operacional.

## D8. Segurança do webhook: HMAC sobre o corpo bruto

**Decisão:** validação HMAC-SHA256 do `X-Hub-Signature-256` com comparação timing-safe, **sobre o raw body** — nunca sobre payload re-serializado. Dedup por `X-GitHub-Delivery` + unique de SHA por repo (reentregas não duplicam).

**Justificativa:** o secret é a única prova de que o POST veio do GitHub; e `JSON.parse`→`stringify` altera bytes, gerando assinatura divergente — o bug clássico do gênero. Invariante protegido por teste: payload reserializado DEVE falhar a verificação. Framework: exige configuração de raw body na rota (Fastify parseia por padrão).

## D9. Papéis: promoção via env, nunca rebaixamento

**Decisão:** `PROFESSOR_LOGINS` (env) promove ALUNO→PROFESSOR no login OAuth; papel persiste no banco; remoção da lista **não** rebaixa (só manual no banco).

**Justificativa:** auto-registro de professor seria furo de segurança; e rebaixamento silencioso por edição de env removeria acesso de quem já revisou sinalizações — mudança de permissão tem que ser ato deliberado.

## D10. Migrations versionadas, nunca `db push`

**Decisão:** `prisma migrate dev` em dev, `migrate deploy` no start da API em produção; pasta `prisma/migrations/` commitada.

**Justificativa:** num sistema cujo produto é **evidência**, o schema precisa de histórico tanto quanto os dados — "que estrutura o banco tinha quando esta sinalização foi gerada" pode ser pergunta real de contestação futura. `db push` altera sem gravar história e faz o `migrate` divergir.

## D11. Falha de setup de repo é estado visível, não log

**Decisão:** pós-criação (poll da main, collaborator, ruleset de proteção) roda como job com 5 tentativas e backoff; esgotado, grava `setup_status=ERRO` + `setup_erro` no repositório, exposto na grade do professor. `POST /prof/repositorios/:id/reprocessar-setup` reabre o ciclo (volta a `PENDENTE` e reenfileira) sem exigir recriar o repositório no GitHub.

**Justificativa:** o pior caso do "logar e seguir" é aluno sem acesso de push ou main sem proteção (furo de evidência) com a única testemunha numa linha de log que ninguém lê. Falha operacional relevante tem que aparecer onde o operador olha.

## D12. Detectores: dedup por pendência e thresholds centralizados

**Decisão:** `createSignal` não recria sinalização se já existe uma PENDENTE do mesmo tipo no repo (re-execução segura; re-flag só após revisão humana). Thresholds vivem em `config.detectors`, nunca hardcoded. `COMMIT_GIGANTE` só avalia commits `CALCULADO` — por isso o worker de stats **reenfileira** o detector ao concluir (sem isso, o commit gigante da véspera nunca seria visto: o detector do push rodaria antes das linhas existirem).

**Justificativa:** detectores idempotentes + fila de revisão sem spam; thresholds são hipóteses a calibrar com turma real (primeiro trabalho em modo observação — falsos positivos esperados: duplas que pareiam numa máquina só).

## D13. Domínio em português

**Decisão:** schema, rotas e variáveis usam o vocabulário do domínio em português (`trabalho`, `entrega`, `sinalizacao`...), sem mistura com termos ingleses equivalentes.

**Justificativa:** o domínio é regulatório-acadêmico brasileiro (quem lê contestação, ata ou tela é falante de português); consistência evita o dialeto híbrido que confunde busca e manutenção.

## D14. Proteção da main via Repository Ruleset, não branch protection clássica

**Decisão:** `configureRepository()` protege a `main` criando um Repository Ruleset (`POST /repos/{owner}/{repo}/rulesets`, nome fixo `protect-main`) com as regras `non_fast_forward` e `deletion`, em vez de `PUT .../branches/main/protection` (branch protection clássica).

**Contexto:** a API clássica de branch protection **exige GitHub Pro/Team/Enterprise para repositórios privados** — plano Free retorna erro ao tentar aplicá-la num repo privado. A org `faminas-ads` está no plano Free e **vai continuar** (decisão de custo, não técnica) — ver `OPERACAO.md §2`. Repositórios de aluno são privados por design (evidência de um aluno não é material de outro), então essa etapa falhava sistematicamente em produção real, deixando `setup_status=ERRO` em todo repo criado.

**Justificativa:** Rulesets são gratuitos em qualquer plano, inclusive repositório privado, e cobrem exatamente o requisito real do sistema (D2: bloquear reescrita de histórico e deleção da main — não branch protection completa com PR review, status checks etc., que o Crivo nunca usou). Mesma permissão do GitHub App já cobre o endpoint (`Administration RW`, ver D3) — nenhuma mudança de escopo do App foi necessária.

**Idempotência:** `POST /rulesets` não é idempotente como o antigo `PUT` era — chamar duas vezes cria conflito de nome. `runPostCreationSequence` lista os rulesets existentes e pula a criação se `protect-main` já existir, antes de criar. Isso é o que torna seguro reprocessar um repositório (`POST /prof/repositorios/:id/reprocessar-setup`) que já tinha avançado parcialmente numa tentativa anterior.

**Rejeitado:** manter branch protection clássica e forçar upgrade de plano da org — custo recorrente rejeitado para um requisito que Rulesets cobrem de graça. Também rejeitado: aplicar a proteção só nos templates (não nos repos gerados) — geração por template não herda configuração de branch/ruleset do repo-fonte, a proteção tem que ser aplicada em cada repo criado, como já era o caso.

**Migração dos repositórios de teste já em `ERRO` por essa causa:** não é necessário recriar o repositório no GitHub — `POST /prof/repositorios/:id/reprocessar-setup` volta o registro para `PENDENTE` e reenfileira `repo-setup`, que reaplica a sequência no mesmo repositório já existente.

**Correção (2026-08): a premissa "rulesets grátis em repo privado" NÃO vale para uma ORGANIZAÇÃO no plano Free.** Rulesets em repositórios **privados de organização** exigem Team/Enterprise; numa org Free, `POST /rulesets` num repo privado retorna 403 `"Upgrade to GitHub Pro or make this repository public to enable this feature"`. Ou seja: nem branch protection clássica nem rulesets estão disponíveis para repo privado na org Free — a troca de mecanismo de D14 não resolveu, só mudou a mensagem de erro. Como upgrade e tornar público seguem rejeitados (custo / privacidade), **não há como *impor* proteção da main no plano atual.**

Consequência no código (`runPostCreationSequence`): aplicar o ruleset virou **best-effort**. Adicionar os colaboradores é o passo essencial (define `CONFIGURADO`); se o ruleset falhar (limitação de plano ou qualquer outro motivo), loga aviso e segue — o repositório **funciona** (o aluno já tem push), então marcá-lo `ERRO` só assustava com uma mensagem de acesso que não condiz com a realidade. A garantia de integridade não depende do ruleset: proteger a main é **prevenção**, mas o **detector de force-push (D2) pega a reescrita de histórico depois do fato via webhook** — prevenção virou detecção, o sinal ainda dispara. Ver `isPlanLimitation` em `src/services/repo.ts` e `tests/repo_setup.test.ts`.

## D15. CORS liberado para a origem do front, sem credentials

**Decisão:** `@fastify/cors` registrado em `src/index.ts` com `origin: config.FRONTEND_URL`, sem `credentials: true`.

**Contexto:** `crivo-front` é servido como site estático num domínio Railway separado da API (deploy sem processo próprio, portanto sem como replicar o proxy `/api/*` que o Vite faz em dev). Sem CORS, toda chamada cross-origin do front falha silenciosamente do jeito mais perigoso possível: o navegador não bloqueia a *navegação* para a URL (não é isso que CORS protege), mas bloquearia a leitura da resposta — só que aqui o sintoma real observado foi outro: chamadas para `/api/*` no domínio do front caem no fallback de SPA (qualquer rota não estática vira `index.html`, 200 OK), e o client (`src/api/client.ts`) não valida que a resposta é JSON antes de aceitar um 200 — o HTML vira `usuario` de tipo string, que quebra mais adiante (`corAvatar(usuario.nome)` com `nome` inexistente numa string).

**Justificativa:** liberar CORS pela origem do front resolve a causa real (a chamada nunca deveria ter sido same-origin numa topologia de dois domínios). `credentials: false` é deliberado: o cookie httpOnly `token` tem `sameSite: 'lax'`, que não é enviado em requisições cross-site de qualquer forma — a sessão nesse caminho depende inteiramente do Bearer token guardado em `localStorage` (`entrarComToken`, já implementado no front para o retorno do OAuth). Não há necessidade de reabrir o cookie para cross-site (o que exigiria `SameSite=None; Secure`, uma superfície maior) quando o Bearer já cobre o caso.

**O client do front deveria ter falhado alto, não silencioso:** `request()` em `crivo-front/src/api/client.ts` aceita como válido qualquer 200 cujo corpo não seja JSON parseável (`parsed = text`), sem checar `content-type` nem o formato esperado. Corrigir esse client é dívida registrada, não coberta por este commit — o CORS resolve a causa (a chamada agora chega na API de verdade), mas o client continua capaz de mascarar um problema parecido no futuro como um crash profundo em vez de um erro claro.

**Requer configuração fora do código (Railway):** `FRONTEND_URL` na API precisa ser a URL pública exata do front (sem barra final, mesmo valor usado no redirect do OAuth); `VITE_API_BASE_URL` e `VITE_API_ORIGIN` no serviço do front precisam apontar pra URL pública da API — e, por serem variáveis do Vite, só valem se estiverem presentes **no momento do build**, não só em runtime.

**Rejeitado:** manter same-origin via um servidor de proxy no front (Node/Express ou Caddy servindo `dist/` + fazendo proxy de `/api/*`). Preservaria o cookie httpOnly sem precisar de CORS, mas troca "adicionar um plugin na API que já é um serviço HTTP" por "adicionar um processo novo inteiro só pra fazer proxy" — rejeitado por não ser a opção mais simples disponível, não por ser tecnicamente inferior; reconsiderar se o Bearer-token-via-localStorage se mostrar insuficiente (ex.: necessidade de refresh token, ou de cookie realmente httpOnly por razão de segurança futura).
