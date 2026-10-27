import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { prisma } from '../db/client';
import { User } from '@prisma/client';

export interface AuthTokenPayload {
  userId: string;
  email: string;
}

export function signToken(user: { id: string; email: string }): string {
  return jwt.sign(
    { userId: user.id, email: user.email },
    env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Authentication Middleware:
 * Inspects `token` HTTP cookie or `Authorization: Bearer <token>` header.
 * 
 * Security policies:
 * - Production: Strictly requires a valid token; unauthenticated requests receive HTTP 401.
 * - Development: Only permits fallback to `dev@reachinbox.test` if ALLOW_DEV_AUTH is explicitly true.
 */
export async function authenticateUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });
      if (user) {
        (req as any).user = user;
        return next();
      }
    }
  }

  // In production, strictly reject with 401
  if (env.NODE_ENV === 'production') {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication required. Please log in.',
    });
    return;
  }

  // In development/test mode: only fall back if explicitly permitted
  if (env.ALLOW_DEV_AUTH) {
    const devUser = await prisma.user.upsert({
      where: { email: 'dev@reachinbox.test' },
      update: {},
      create: {
        email: 'dev@reachinbox.test',
        name: 'ReachInbox Development User',
        avatarUrl: 'https://avatar.iran.liara.run/public/boy',
      },
    });

    (req as any).user = devUser;
    return next();
  }

  // Otherwise, reject unauthenticated request
  res.status(401).json({
    success: false,
    error: 'Unauthorized: Authentication required.',
  });
}

/**
 * Optional Authentication Middleware:
 * Attaches user to `req.user` if valid token exists, but does not block if unauthenticated.
 */
export async function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });
      if (user) {
        (req as any).user = user;
      }
    }
  }

  next();
}

/**
 * Constructs Google OAuth Consent URL
 */
export function getGoogleOAuthUrl(): string {
  if (!env.GOOGLE_CLIENT_ID) {
    return '';
  }
  const redirectUri = env.GOOGLE_CALLBACK_URL || `${env.FRONTEND_URL}/api/auth/google/callback`;
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: redirectUri,
    client_id: env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options);
  return `${rootUrl}?${qs.toString()}`;
}

/**
 * Exchanges Google OAuth Authorization Code for User Profile
 */
export async function exchangeGoogleCode(code: string): Promise<{
  googleId: string;
  email: string;
  name: string;
  picture: string;
}> {
  const redirectUri = env.GOOGLE_CALLBACK_URL || `${env.FRONTEND_URL}/api/auth/google/callback`;
  const tokenUrl = 'https://oauth2.googleapis.com/token';

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as { id_token?: string; access_token?: string };
  if (!data.access_token) {
    throw new Error('Google did not return an access token');
  }

  // Fetch Google User Profile
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });

  if (!profileRes.ok) {
    throw new Error('Failed to retrieve user info from Google');
  }

  const profile = (await profileRes.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  return {
    googleId: profile.id,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  };
}

/**
 * Constructs Slack OAuth Authorization URL
 */
export function getSlackOAuthUrl(): string {
  if (!env.SLACK_CLIENT_ID) {
    return '';
  }
  const redirectUri = env.SLACK_CALLBACK_URL || `${env.FRONTEND_URL}/api/slack/callback`;
  const rootUrl = 'https://slack.com/oauth/v2/authorize';
  const options = {
    client_id: env.SLACK_CLIENT_ID,
    scope: 'incoming-webhook,chat:write',
    redirect_uri: redirectUri,
  };

  const qs = new URLSearchParams(options);
  return `${rootUrl}?${qs.toString()}`;
}

/**
 * Exchanges Slack Authorization Code and saves SlackConnection
 */
export async function exchangeSlackCode(
  user: User,
  code: string
): Promise<{ teamId: string; channelId?: string }> {
  const redirectUri = env.SLACK_CALLBACK_URL || `${env.FRONTEND_URL}/api/slack/callback`;
  const tokenUrl = 'https://slack.com/api/oauth.v2.access';

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    team?: { id: string; name?: string };
    access_token?: string;
    incoming_webhook?: { channel?: string; channel_id?: string; url?: string };
  };

  if (!data.ok || !data.access_token) {
    throw new Error(`Slack OAuth exchange failed: ${data.error || 'Unknown error'}`);
  }

  const teamId = data.team?.id || 'default_team';
  const channelId = data.incoming_webhook?.channel_id || data.incoming_webhook?.channel;

  await prisma.slackConnection.upsert({
    where: { userId: user.id },
    update: {
      teamId,
      accessToken: data.access_token,
      channelId,
    },
    create: {
      userId: user.id,
      teamId,
      accessToken: data.access_token,
      channelId,
    },
  });

  return { teamId, channelId };
}
