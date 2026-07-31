import { Router, Request, Response } from 'express';
import { getPool } from '../config/database';
import { logger } from '../config/logger';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/auctions — List auctions with filters
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.status) {
      conditions.push(`a.status = $${paramIdx}`);
      params.push(req.query.status);
      paramIdx++;
    }

    if (req.query.make) {
      conditions.push(`m.make ILIKE $${paramIdx}`);
      params.push(`%${req.query.make}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortMap: Record<string, string> = {
      ending_soon: 'a.current_end_time ASC',
      newest: 'a.created_at DESC',
      most_bids: 'a.total_bids DESC',
      price_asc: 'a.current_highest_bid_cents ASC',
      price_desc: 'a.current_highest_bid_cents DESC',
    };
    const sort = sortMap[req.query.sort as string] || 'a.current_end_time ASC';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM auctions a JOIN motorcycles m ON a.motorcycle_id = m.id ${whereClause}`,
      params
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT
         a.id, a.motorcycle_id, a.seller_id, a.starting_price_cents,
         a.reserve_price_cents, a.bid_increment_cents,
         a.current_highest_bid_cents, a.current_highest_bidder_id, a.total_bids,
         a.starts_at, a.original_end_time, a.current_end_time,
         a.soft_close_window_seconds, a.soft_close_extension_seconds,
         a.status, a.version, a.created_at, a.updated_at,
         m.title AS motorcycle_title, m.make, m.model, m.year,
         m.thumbnail_url, m.condition, m.mileage_km, m.engine_cc
       FROM auctions a
       JOIN motorcycles m ON a.motorcycle_id = m.id
       ${whereClause}
       ORDER BY ${sort}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map(formatAuction),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'List auctions failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list auctions' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auctions/:id — Get auction details
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
         a.id, a.motorcycle_id, a.seller_id, a.starting_price_cents,
         a.reserve_price_cents, a.bid_increment_cents,
         a.current_highest_bid_cents, a.current_highest_bidder_id, a.total_bids,
         a.starts_at, a.original_end_time, a.current_end_time,
         a.soft_close_window_seconds, a.soft_close_extension_seconds,
         a.status, a.version, a.created_at, a.updated_at,
         m.id AS m_id, m.seller_id AS m_seller_id, m.title, m.make, m.model,
         m.year, m.vin, m.mileage_km, m.engine_cc, m.condition, m.description,
         m.photo_urls, m.thumbnail_url, m.listing_status,
         m.created_at AS m_created_at, m.updated_at AS m_updated_at
       FROM auctions a
       JOIN motorcycles m ON a.motorcycle_id = m.id
       WHERE a.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Auction not found' });
    }

    return res.status(200).json(formatAuctionFull(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Get auction failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get auction' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auctions — Create auction (verified seller only)
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('seller', 'admin'), async (req: Request, res: Response) => {
  try {
    const pool = getPool();

    // Check seller verification
    const sellerResult = await pool.query(
      'SELECT is_seller_verified FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!sellerResult.rows[0]?.is_seller_verified && req.user!.role !== 'admin') {
      return res.status(403).json({
        error: 'SELLER_NOT_VERIFIED',
        message: 'You must complete seller verification before creating auctions',
      });
    }

    const {
      motorcycleId, startingPriceCents, reservePriceCents,
      bidIncrementCents, startsAt, endsAt,
      softCloseWindowSeconds, softCloseExtensionSeconds,
    } = req.body;

    // Validate required fields
    if (!motorcycleId || !startingPriceCents || !startsAt || !endsAt) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'motorcycleId, startingPriceCents, startsAt, and endsAt are required',
      });
    }

    // Validate motorcycle exists, is approved, and belongs to seller
    const motoResult = await pool.query(
      'SELECT seller_id, listing_status FROM motorcycles WHERE id = $1',
      [motorcycleId]
    );

    if (motoResult.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Motorcycle not found' });
    }

    if (motoResult.rows[0].seller_id !== req.user!.userId && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not the motorcycle owner' });
    }

    if (motoResult.rows[0].listing_status !== 'approved') {
      return res.status(400).json({
        error: 'LISTING_NOT_APPROVED',
        message: 'Motorcycle listing must be approved before creating an auction',
      });
    }

    // Check no active/scheduled auction for this motorcycle
    const existingAuction = await pool.query(
      `SELECT id FROM auctions WHERE motorcycle_id = $1 AND status IN ('scheduled', 'active', 'soft_close')`,
      [motorcycleId]
    );

    if (existingAuction.rows.length > 0) {
      return res.status(409).json({
        error: 'AUCTION_EXISTS',
        message: 'This motorcycle already has an active or scheduled auction',
      });
    }

    // Validate dates
    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);

    if (startDate >= endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Start date must be before end date',
      });
    }

    const result = await pool.query(
      `INSERT INTO auctions
         (motorcycle_id, seller_id, starting_price_cents, reserve_price_cents,
          bid_increment_cents, starts_at, original_end_time, current_end_time,
          soft_close_window_seconds, soft_close_extension_seconds, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 'scheduled')
       RETURNING *`,
      [
        motorcycleId, req.user!.userId, startingPriceCents,
        reservePriceCents || null,
        bidIncrementCents || 100,
        startDate, endDate,
        softCloseWindowSeconds || 120,
        softCloseExtensionSeconds || 120,
      ]
    );

    logger.info({ auctionId: result.rows[0].id, motorcycleId }, 'Auction created');
    return res.status(201).json(formatAuctionRow(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Create auction failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create auction' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auctions/:id/cancel — Cancel auction (seller/admin)
// ---------------------------------------------------------------------------
router.post('/:id/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();

    const existing = await pool.query(
      'SELECT seller_id, status FROM auctions WHERE id = $1',
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Auction not found' });
    }

    if (existing.rows[0].seller_id !== req.user!.userId && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not the auction seller or admin' });
    }

    if (existing.rows[0].status !== 'scheduled') {
      return res.status(400).json({
        error: 'INVALID_STATE',
        message: `Can only cancel scheduled auctions. Current status: ${existing.rows[0].status}`,
      });
    }

    const result = await pool.query(
      `UPDATE auctions SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    logger.info({ auctionId: req.params.id }, 'Auction cancelled');
    return res.status(200).json(formatAuctionRow(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Cancel auction failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to cancel auction' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auctions/:id/bids — Get bid history
// ---------------------------------------------------------------------------
router.get('/:id/bids', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    // Verify auction exists
    const auctionCheck = await pool.query('SELECT id FROM auctions WHERE id = $1', [req.params.id]);
    if (auctionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Auction not found' });
    }

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM bids WHERE auction_id = $1',
      [req.params.id]
    );
    const totalItems = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT b.id, b.auction_id, b.bidder_id, u.username AS bidder_username,
              b.amount_cents, b.status, b.correlation_id, b.created_at
       FROM bids b
       JOIN users u ON b.bidder_id = u.id
       WHERE b.auction_id = $1
       ORDER BY b.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map((row) => ({
        id: row.id,
        auctionId: row.auction_id,
        bidderId: row.bidder_id,
        bidderUsername: row.bidder_username,
        amountCents: row.amount_cents,
        status: row.status,
        correlationId: row.correlation_id,
        createdAt: row.created_at,
      })),
      meta: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
    });
  } catch (err) {
    logger.error({ err }, 'Get auction bids failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get bids' });
  }
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function formatAuctionRow(row: any) {
  return {
    id: row.id,
    motorcycleId: row.motorcycle_id,
    sellerId: row.seller_id,
    startingPriceCents: row.starting_price_cents,
    reservePriceCents: row.reserve_price_cents,
    bidIncrementCents: row.bid_increment_cents,
    currentHighestBidCents: row.current_highest_bid_cents,
    currentHighestBidderId: row.current_highest_bidder_id,
    totalBids: row.total_bids,
    startsAt: row.starts_at,
    originalEndTime: row.original_end_time,
    currentEndTime: row.current_end_time,
    softCloseWindowSeconds: row.soft_close_window_seconds,
    softCloseExtensionSeconds: row.soft_close_extension_seconds,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatAuction(row: any) {
  return {
    ...formatAuctionRow(row),
    motorcycle: {
      title: row.motorcycle_title || row.title,
      make: row.make,
      model: row.model,
      year: row.year,
      thumbnailUrl: row.thumbnail_url,
      condition: row.condition,
      mileageKm: row.mileage_km,
      engineCc: row.engine_cc,
    },
  };
}

function formatAuctionFull(row: any) {
  return {
    ...formatAuctionRow(row),
    motorcycle: {
      id: row.m_id,
      sellerId: row.m_seller_id,
      title: row.title,
      make: row.make,
      model: row.model,
      year: row.year,
      vin: row.vin,
      mileageKm: row.mileage_km,
      engineCc: row.engine_cc,
      condition: row.condition,
      description: row.description,
      photoUrls: row.photo_urls,
      thumbnailUrl: row.thumbnail_url,
      listingStatus: row.listing_status,
      createdAt: row.m_created_at,
      updatedAt: row.m_updated_at,
    },
  };
}

export default router;
