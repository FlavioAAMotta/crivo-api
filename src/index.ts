import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhooks.js';
import { alunoRoutes } from './routes/alunos.js';
import { professorRoutes } from './routes/professores.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
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
