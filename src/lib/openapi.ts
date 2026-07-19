import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import type { FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import { z } from 'zod';
import { config } from './config.js';

/**
 * Converts a Zod schema into an OpenAPI 3.0-compatible JSON Schema, for documentation
 * purposes only. Route schemas built with this never drive runtime validation — see
 * the setValidatorCompiler override in index.ts.
 */
export function docSchema(schema: z.ZodTypeAny) {
  // io: 'input' documents what the client sends (e.g. numeric path params arrive as
  // strings and are transformed internally), not the post-transform runtime type.
  return z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any', io: 'input' });
}

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Crivo API',
      description: 'API para acompanhamento de repositórios GitHub de alunos/equipes, entregas, métricas e sinalizações de integridade acadêmica.',
      version: '1.0.0',
    },
    servers: [{ url: config.APP_BASE_URL }],
    tags: [
      { name: 'auth', description: 'Autenticação & GitHub OAuth' },
      { name: 'alunos', description: 'Rotas voltadas ao aluno' },
      { name: 'professores', description: 'Rotas voltadas ao professor' },
      { name: 'webhooks', description: 'Ingestão de webhooks do GitHub' },
    ],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
};

export const swaggerUiOptions: FastifySwaggerUiOptions = {
  routePrefix: '/docs',
};
