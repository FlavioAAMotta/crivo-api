import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { config } from '../lib/config.js';
import { signToken, requireAuth, signPreAuthToken, verifyPreAuthToken, requirePreAuth } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { serializeBigInt } from '../lib/serializer.js';
import { docSchema } from '../lib/openapi.js';

const callbackQuerySchema = z.object({
  code: z.string(),
});

const postEmailBodySchema = z.object({
  email: z.string().email(),
});

const loginRaBodySchema = z.object({
  ra: z.string().min(1),
  senha: z.string().min(1),
});

const redefinirSenhaBodySchema = z.object({
  senha_nova: z.string().min(8),
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
    const parseResult = redefinirSenhaBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400).send({ error: parseResult.error.message });
      return;
    }

    const { senha_nova } = parseResult.data;
    const usuarioId = request.preAuth!.usuario_id;

    const senhaHash = await bcrypt.hash(senha_nova, 10);
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { senha_hash: senhaHash, senha_redefinida_em: new Date() },
    });

    const token = signPreAuthToken({ usuario_id: usuarioId, etapa: 'vincular_github' });
    reply.send({ preauth_token: token, etapa: 'vincular_github' });
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
      return reply.status(201).send(newEmail);
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
