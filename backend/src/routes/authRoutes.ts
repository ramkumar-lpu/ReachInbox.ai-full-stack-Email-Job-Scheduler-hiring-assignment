import { Router, Request, Response } from 'express';
import {
  getGoogleOAuthUrl,
  exchangeGoogleCode,
  signToken,
  getSlackOAuthUrl,
  exchangeSlackCode,
} from '../services/authService';
import { prisma } from '../db/client';
import { env } from '../config/env';

export const authRouter = Router();
export const slackRouter = Router();

// =============================================================================
// Google OAuth & User Auth Routes (/api/auth)
// =============================================================================

/**
 * GET /api/auth/google
 * Initiates Google OAuth redirection
 */
authRouter.get('/google', (_req: Request, res: Response) => {
  const url = getGoogleOAuthUrl();
  if (!url) {
    res.status(400).json({
      success: false,
      error: 'Google OAuth is not configured. Missing GOOGLE_CLIENT_ID environment variable.',
    });
    return;
  }
  res.redirect(url);
});

/**
 * GET /api/auth/google/callback
 * Handles Google OAuth authorization code redirect
 */
authRouter.get('/google/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.redirect(`${env.FRONTEND_URL}?error=missing_code`);
    return;
  }

  try {
    const profile = await exchangeGoogleCode(code);

    const user = await prisma.user.upsert({
      where: { email: profile.email },
      update: {
        googleId: profile.googleId,
        name: profile.name,
        avatarUrl: profile.picture,
      },
      create: {
        email: profile.email,
        googleId: profile.googleId,
        name: profile.name,
        avatarUrl: profile.picture,
      },
    });

    const token = signToken(user);

    // Set secure HTTP-only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.redirect(`${env.FRONTEND_URL}?auth=success`);
  } catch (err: unknown) {
    console.error('❌ Google OAuth Callback Error:', (err as Error).message);
    res.redirect(`${env.FRONTEND_URL}?error=oauth_failed`);
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user
 */
authRouter.get('/me', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ success: false, authenticated: false });
    return;
  }

  res.status(200).json({
    success: true,
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      hasGoogleAuth: Boolean(user.googleId),
    },
  });
});

/**
 * POST /api/auth/logout
 * Clears authentication session cookie
 */
authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.status(200).json({ success: true, message: 'Logged out successfully' });
});

// =============================================================================
// Slack Integration Routes (/api/slack)
// =============================================================================

/**
 * GET /api/slack/connect
 * Initiates Slack OAuth connection
 */
slackRouter.get('/connect', (_req: Request, res: Response) => {
  const url = getSlackOAuthUrl();
  if (!url) {
    res.status(400).json({
      success: false,
      error: 'Slack OAuth is not configured. Missing SLACK_CLIENT_ID environment variable.',
    });
    return;
  }
  res.redirect(url);
});

/**
 * GET /api/slack/callback
 * Handles Slack OAuth redirect
 */
slackRouter.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const user = (req as any).user;

  if (!code) {
    res.redirect(`${env.FRONTEND_URL}?error=slack_missing_code`);
    return;
  }

  try {
    await exchangeSlackCode(user, code);
    res.redirect(`${env.FRONTEND_URL}?slack=connected`);
  } catch (err: unknown) {
    console.error('❌ Slack OAuth Callback Error:', (err as Error).message);
    res.redirect(`${env.FRONTEND_URL}?error=slack_failed`);
  }
});

/**
 * GET /api/slack/status
 * Returns Slack integration status for current tenant
 */
slackRouter.get('/status', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const connection = await prisma.slackConnection.findUnique({
    where: { userId: user.id },
    select: {
      teamId: true,
      channelId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.status(200).json({
    success: true,
    connected: Boolean(connection),
    connection,
  });
});
