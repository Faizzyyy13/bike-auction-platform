import { Router, Request, Response } from 'express';
import { getPool } from '../config/database';
import { logger } from '../config/logger';
import { requireAuth } from '../middleware/auth';

const router = Router();

// All routes in this router require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/users/me/bids — Get current user's bid history
// ---------------------------------------------------------------------------
router.get('/me/bids', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const conditions = ['b.bidder_id = $1'];
    const params: any[] = [req.user!.userId];

    if (req.query.status) {
      conditions.push('b.status = $2');
      params.push(req.query.status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM bids b ${whereClause}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT b.id, b.auction_id, b.bidder_id, b.amount_cents, b.status,
              b.correlation_id, b.created_at,
              a.motorcycle_id, m.title AS motorcycle_title
       FROM bids b
       JOIN auctions a ON b.auction_id = a.id
       JOIN motorcycles m ON a.motorcycle_id = m.id
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        auctionId: r.auction_id,
        bidderId: r.bidder_id,
        amountCents: r.amount_cents,
        status: r.status,
        correlationId: r.correlation_id,
        createdAt: r.created_at,
        motorcycleTitle: r.motorcycle_title,
      })),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'Get my bids failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve bid history' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users/me/auctions — Get current user's auctions (seller dashboard)
// ---------------------------------------------------------------------------
router.get('/me/auctions', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const conditions = ['a.seller_id = $1'];
    const params: any[] = [req.user!.userId];

    if (req.query.status) {
      conditions.push('a.status = $2');
      params.push(req.query.status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM auctions a ${whereClause}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT a.*, m.title AS motorcycle_title, m.thumbnail_url
       FROM auctions a
       JOIN motorcycles m ON a.motorcycle_id = m.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        motorcycleId: r.motorcycle_id,
        sellerId: r.seller_id,
        startingPriceCents: r.starting_price_cents,
        reservePriceCents: r.reserve_price_cents,
        currentHighestBidCents: r.current_highest_bid_cents,
        totalBids: r.total_bids,
        startsAt: r.starts_at,
        currentEndTime: r.current_end_time,
        status: r.status,
        version: r.version,
        motorcycleTitle: r.motorcycle_title,
        thumbnailUrl: r.thumbnail_url,
      })),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'Get my auctions failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve auctions' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users/me/motorcycles — Get seller's motorcycle listings
// ---------------------------------------------------------------------------
router.get('/me/motorcycles', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const conditions = ['seller_id = $1'];
    const params: any[] = [req.user!.userId];

    if (req.query.listingStatus) {
      conditions.push('listing_status = $2');
      params.push(req.query.listingStatus);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM motorcycles ${whereClause}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT * FROM motorcycles ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        sellerId: r.seller_id,
        title: r.title,
        make: r.make,
        model: r.model,
        year: r.year,
        vin: r.vin,
        mileageKm: r.mileage_km,
        condition: r.condition,
        listingStatus: r.listing_status,
        createdAt: r.created_at,
      })),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'Get my motorcycles failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve motorcycles' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users/me/notifications — Get user notifications
// ---------------------------------------------------------------------------
router.get('/me/notifications', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const conditions = ['user_id = $1'];
    const params: any[] = [req.user!.userId];

    if (req.query.unreadOnly === 'true') {
      conditions.push('is_read = false');
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM notifications ${whereClause}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT id, type, auction_id, payload, is_read, delivered_via, created_at
       FROM notifications ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map((r) => ({
        id: r.id,
        type: r.type,
        auctionId: r.auction_id,
        payload: r.payload,
        isRead: r.is_read,
        deliveredVia: r.delivered_via,
        createdAt: r.created_at,
      })),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'Get my notifications failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve notifications' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/users/me/notifications/:id/read — Mark notification read
// ---------------------------------------------------------------------------
router.post('/me/notifications/:id/read', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found' });
    }

    return res.status(200).json({ message: 'Notification marked as read' });
  } catch (err) {
    logger.error({ err }, 'Mark notification read failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update notification' });
  }
});

export default router;
