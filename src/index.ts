import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { alunoRoutes } from './routes/alunos.js';
import { professorRoutes } from './routes/professores.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { swaggerOptions, swaggerUiOptions } from './lib/openapi.js';
import './lib/serializer.js'; // Ensure BigInt patch is loaded early

export function buildApp() {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: 'info',
      transport: process.env.NODE_ENV !== 'production' ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
        }
      } : undefined,
    },
  });

  // Register cookie parser
  fastify.register(cookie);

  // crivo-front roda num domínio Railway separado (deploy estático, sem proxy pra
  // /api/*) — chamadas cross-origin precisam de CORS. Só a origem do front, e sem
  // credentials: a sessão nesse caminho vai por Bearer token (localStorage), não
  // pelo cookie httpOnly (que não sobrevive cross-site com SameSite=Lax mesmo). Ver
  // D15 em docs/DECISOES.md.
  //
  // `methods` e `allowedHeaders` são explícitos de propósito: o default do
  // @fastify/cors libera só GET/HEAD/POST, o que bloqueia no preflight o PATCH
  // (revisar sinalização) e o DELETE (remover e-mail de commit). `Content-Type`
  // é necessário porque `application/json` não é um valor safelisted, e
  // `Authorization` porque a sessão vai por Bearer.
  fastify.register(cors, {
    origin: config.FRONTEND_URL,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Register OpenAPI docs (served at /docs)
  fastify.register(swagger, swaggerOptions);
  fastify.register(swaggerUi, swaggerUiOptions);

  // Route schemas (added below in each route file) are documentation-only: every handler
  // already validates its input manually with Zod (safeParse/parse). We disable Fastify's
  // built-in ajv validator so attaching schema.params/body/querystring for docs doesn't
  // change runtime validation behavior. No route declares schema.response, so response
  // serialization is untouched either way.
  fastify.setValidatorCompiler(() => () => true);

  // Register routes
  fastify.register(authRoutes);
  fastify.register(webhookRoutes);
  fastify.register(alunoRoutes);
  fastify.register(professorRoutes);

  return fastify;
}

// Start listener only if not in testing mode
if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  app.listen({ port: config.PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Crivo API server running at ${address}`);
  });
}
