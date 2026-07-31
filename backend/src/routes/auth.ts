import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../config/database';
import { logger } from '../config/logger';
import { requireAuth, signAccessToken, signRefreshToken, verifyToken, AuthPayload } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, username, password, role } = req.body;

    // Validation
    if (!email || !username || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email, username, and password are required',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Password must be at least 8 characters',
      });
    }

    const pool = getPool();

    // Check uniqueness
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Email or username is already taken',
      });
    }

    // Hash password (using crypto.scrypt as placeholder — Argon2id via argon2 package in production)
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const passwordHash = `${salt}:${hash}`;

    const userRole = role === 'seller' ? 'seller' : 'buyer';

    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, role, is_seller_verified, has_card_on_file, created_at`,
      [email, username, passwordHash, userRole]
    );

    const user = result.rows[0];

    // Generate tokens
    const payload: AuthPayload = { userId: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(user.id);

    // Store refresh token hash
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshHash]
    );

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    logger.info({ userId: user.id, role: userRole }, 'User registered');

    return res.status(201).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isSellerVerified: user.is_seller_verified,
        hasCardOnFile: user.has_card_on_file,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Registration failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Registration failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required',
      });
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT id, email, username, password_hash, role, is_seller_verified, has_card_on_file, created_at
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Verify password
    const [salt, storedHash] = user.password_hash.split(':');
    const computedHash = crypto.scryptSync(password, salt, 64).toString('hex');

    if (computedHash !== storedHash) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    // Generate tokens
    const payload: AuthPayload = { userId: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(user.id);

    // Store refresh token hash
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshHash]
    );

    // Set cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    logger.info({ userId: user.id }, 'User logged in');

    return res.status(200).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isSellerVerified: user.is_seller_verified,
        hasCardOnFile: user.has_card_on_file,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Login failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Login failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) {
      return res.status(401).json({ error: 'NO_REFRESH_TOKEN', message: 'Refresh token not found' });
    }

    // Verify JWT
    let decoded: any;
    try {
      decoded = verifyToken(token);
    } catch {
      return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Refresh token is invalid or expired' });
    }

    const pool = getPool();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Check token exists and not revoked
    const stored = await pool.query(
      `SELECT id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2 AND revoked = false AND expires_at > NOW()`,
      [tokenHash, decoded.userId]
    );

    if (stored.rows.length === 0) {
      return res.status(401).json({ error: 'TOKEN_REVOKED', message: 'Refresh token has been revoked' });
    }

    // Revoke old token
    await pool.query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);

    // Get user details for new access token
    const userResult = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'USER_NOT_FOUND', message: 'User no longer exists' });
    }

    const user = userResult.rows[0];

    // Issue new tokens (rotation)
    const payload: AuthPayload = { userId: user.id, email: user.email, role: user.role };
    const newAccessToken = signAccessToken(payload);
    const newRefreshToken = signRefreshToken(user.id);

    const newRefreshHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, newRefreshHash]
    );

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({ accessToken: newAccessToken });
  } catch (err) {
    logger.error({ err }, 'Token refresh failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Token refresh failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken;

    if (token) {
      const pool = getPool();
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
    }

    res.clearCookie('refreshToken', { path: '/api/auth' });

    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    logger.error({ err }, 'Logout failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Logout failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, email, username, role, is_seller_verified, has_card_on_file, created_at
       FROM users WHERE id = $1`,
      [req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    const user = result.rows[0];
    return res.status(200).json({
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      isSellerVerified: user.is_seller_verified,
      hasCardOnFile: user.has_card_on_file,
      createdAt: user.created_at,
    });
  } catch (err) {
    logger.error({ err }, 'Get profile failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get profile' });
  }
});

export default router;
