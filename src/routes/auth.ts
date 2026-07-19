import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { signToken, requireAuth } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { serializeBigInt } from '../lib/serializer.js';
import { docSchema } from '../lib/openapi.js';

const callbackQuerySchema = z.object({
  code: z.string(),
});

const postEmailBodySchema = z.object({
  email: z.string().email(),
});

const deleteEmailParamsSchema = z.object({
  id: z.string().transform(Number),
});

export async function authRoutes(fastify: FastifyInstance) {

  // 1. Redirect to GitHub OAuth Authorization Page
  fastify.get('/auth/github', {
    schema: {
      tags: ['auth'],
      summary: 'Inicia o fluxo de OAuth com o GitHub',
      description: 'Redireciona o usuário para a página de autorização do GitHub.',
    },
  }, async (request, reply) => {
    const clientId = config.GITHUB_OAUTH_CLIENT_ID;
    const redirectUri = `${config.APP_BASE_URL}/auth/github/callback`;
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email`;
    
    return reply.redirect(oauthUrl);
  });

  // 2. OAuth Callback Handler
  fastify.get('/auth/github/callback', {
    schema: {
      tags: ['auth'],
      summary: 'Callback do OAuth do GitHub',
      description: 'Troca o código de autorização por um token, cria/atualiza o usuário e retorna um JWT.',
      querystring: docSchema(callbackQuerySchema),
    },
  }, async (request, reply) => {
    const querySchema = callbackQuerySchema;

    const parseResult = querySchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400).send({ error: 'OAuth code missing' });
      return;
    }
    
    const { code } = parseResult.data;
    
    try {
      // Trade OAuth code for GitHub Access Token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: config.GITHUB_OAUTH_CLIENT_ID,
          client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
          code,
        }),
      });
      
      const tokenData = await tokenResponse.json() as any;
      if (!tokenData.access_token) {
        logger.error({ tokenData }, 'OAuth token exchange failed');
        reply.status(400).send({ error: 'OAuth token exchange failed' });
        return;
      }
      
      const accessToken = tokenData.access_token;
      
      // Get User Profile from GitHub
      const userProfileResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${accessToken}`,
          'User-Agent': 'Crivo-API',
        },
      });
      
      const userProfile = await userProfileResponse.json() as any;
      if (!userProfile.id) {
        reply.status(400).send({ error: 'Failed to retrieve GitHub user profile' });
        return;
      }
      
      const githubId = BigInt(userProfile.id);
      const githubLogin = userProfile.login;
      const nome = userProfile.name || userProfile.login;
      
      // Check if user is in predefined professor list
      const isPredefinedProf = config.PROFESSOR_LOGINS.includes(githubLogin.toLowerCase());
      
      // Check if user already exists
      const existingUser = await prisma.usuario.findUnique({
        where: { github_id: githubId },
      });
      
      let papel: 'ALUNO' | 'PROFESSOR' = 'ALUNO';
      let user;
      
      if (existingUser) {
        // Rule: Only promote, never demote automatically from ENV
        papel = existingUser.papel;
        if (papel === 'ALUNO' && isPredefinedProf) {
          papel = 'PROFESSOR';
        }
        
        user = await prisma.usuario.update({
          where: { id: existingUser.id },
          data: {
            github_login: githubLogin,
            nome,
            papel,
          },
        });
      } else {
        // First login: check predefined lists
        papel = isPredefinedProf ? 'PROFESSOR' : 'ALUNO';
        
        user = await prisma.usuario.create({
          data: {
            github_id: githubId,
            github_login: githubLogin,
            nome,
            papel,
          },
        });
      }
      
      // Fetch user's emails from GitHub to prepopulate their commit_emails if possible
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `token ${accessToken}`,
          'User-Agent': 'Crivo-API',
        },
      });
      
      if (emailsResponse.ok) {
        const emailsList = await emailsResponse.json() as any[];
        for (const emailObj of emailsList) {
          if (emailObj.email) {
            await prisma.emailCommit.upsert({
              where: { email: emailObj.email },
              update: { verificado: emailObj.verified },
              create: {
                usuario_id: user.id,
                email: emailObj.email,
                verificado: emailObj.verified,
              },
            }).catch(() => {}); // Suppress duplicate conflicts across different users
          }
        }
      }
      
      // Generate JWT Token
      const token = signToken(user);
      
      // Set Cookie and send success response
      reply.setCookie('token', token, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });
      
      return reply.send({ success: true, token, user: serializeBigInt(user) });
      
    } catch (error) {
      logger.error(error, 'OAuth callback processing failed');
      reply.status(500).send({ error: 'Authentication internal server error' });
    }
  });

  // 3. Get profile /me
  fastify.get('/me', {
    preHandler: [requireAuth],
    schema: {
      tags: ['auth'],
      summary: 'Retorna o perfil do usuário autenticado',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const user = await prisma.usuario.findUnique({
      where: { id: request.user!.id },
      include: {
        emails: true,
      },
    });
    
    if (!user) {
      reply.status(404).send({ error: 'User not found' });
      return;
    }
    
    return reply.send(serializeBigInt(user));
  });

  // 4. Manage Emails for Commit Matching
  fastify.get('/me/emails', {
    preHandler: [requireAuth],
    schema: {
      tags: ['auth'],
      summary: 'Lista os e-mails de commit vinculados ao usuário autenticado',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const emails = await prisma.emailCommit.findMany({
      where: { usuario_id: request.user!.id },
    });
    return reply.send(emails);
  });

  fastify.post('/me/emails', {
    preHandler: [requireAuth],
    schema: {
      tags: ['auth'],
      summary: 'Adiciona um e-mail de commit ao usuário autenticado',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      body: docSchema(postEmailBodySchema),
    },
  }, async (request, reply) => {
    const bodySchema = postEmailBodySchema;

    const parseResult = bodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400).send({ error: parseResult.error.message });
      return;
    }
    
    const { email } = parseResult.data;
    
    try {
      const newEmail = await prisma.emailCommit.create({
        data: {
          usuario_id: request.user!.id,
          email: email.toLowerCase(),
          verificado: false, // In real apps, needs email verification. Defaulting false
        },
      });
      return reply.status(212).send(newEmail); // 201 Created
    } catch (error: any) {
      if (error.code === 'P2002') {
        reply.status(409).send({ error: 'Email already registered' });
      } else {
        reply.status(500).send({ error: 'Internal server error' });
      }
    }
  });

  fastify.delete('/me/emails/:id', {
    preHandler: [requireAuth],
    schema: {
      tags: ['auth'],
      summary: 'Remove um e-mail de commit do usuário autenticado',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      params: docSchema(deleteEmailParamsSchema),
    },
  }, async (request, reply) => {
    const paramsSchema = deleteEmailParamsSchema;

    const parseResult = paramsSchema.safeParse(request.params);
    if (!parseResult.success) {
      reply.status(400).send({ error: 'Invalid email ID' });
      return;
    }
    
    const emailId = parseResult.data.id;
    
    const email = await prisma.emailCommit.findUnique({
      where: { id: emailId },
    });
    
    if (!email) {
      reply.status(404).send({ error: 'Email not found' });
      return;
    }
    
    if (email.usuario_id !== request.user!.id) {
      reply.status(403).send({ error: 'Forbidden' });
      return;
    }
    
    await prisma.emailCommit.delete({
      where: { id: emailId },
    });
    
    return reply.send({ success: true });
  });
}
