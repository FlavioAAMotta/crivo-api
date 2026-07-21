import { App } from 'octokit';
import { config } from './config.js';
import { logger } from './logger.js';

let appInstance: App | null = null;

/**
 * Constrói o App sob demanda. Criar no import quebra qualquer módulo que apenas
 * importe este arquivo sem falar com o GitHub (rotas, testes) quando
 * GITHUB_PRIVATE_KEY não está configurada — o construtor exige a chave.
 */
export function getGithubApp(): App {
  if (!appInstance) {
    if (!config.GITHUB_PRIVATE_KEY) {
      throw new Error('GITHUB_PRIVATE_KEY is not configured');
    }
    appInstance = new App({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_PRIVATE_KEY,
      oauth: {
        clientId: config.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
      },
    });
  }
  return appInstance;
}

let cachedInstallationId: number | null = null;

/**
 * Gets the authenticated Octokit instance for the GitHub App installation 
 * mapped to the specified GITHUB_ORG.
 */
export async function getInstallationOctokit() {
  const githubApp = getGithubApp();

  if (cachedInstallationId) {
    return githubApp.getInstallationOctokit(cachedInstallationId);
  }

  try {
    const octokit = githubApp.octokit;
    const { data: installation } = await octokit.rest.apps.getOrgInstallation({
      org: config.GITHUB_ORG,
    });
    
    cachedInstallationId = installation.id;
    return githubApp.getInstallationOctokit(installation.id);
  } catch (error) {
    logger.error({ error, org: config.GITHUB_ORG }, 'Failed to fetch GitHub App installation ID');
    throw error;
  }
}

/**
 * Helper to run GitHub API requests with automatic retry and exponential backoff
 * in case of rate limiting (403 with retry headers) or temporary server errors (5xx).
 */
export async function withGithubRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const status = error.status;
    const isRateLimit = status === 403 || status === 429;
    const isServerError = status >= 500;
    
    if (retries > 0 && (isRateLimit || isServerError)) {
      let wait = delayMs;
      // Respect standard retry-after header if present (in seconds)
      const retryAfter = error.headers?.['retry-after'];
      if (retryAfter) {
        wait = parseInt(retryAfter, 10) * 1000;
      }
      
      logger.warn({ status, waitMs: wait, retriesLeft: retries }, 'GitHub API hit rate limit or error, retrying...');
      await new Promise((resolve) => setTimeout(resolve, wait));
      return withGithubRetry(fn, retries - 1, delayMs * 2);
    }
    throw error;
  }
}
