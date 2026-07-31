import { Router, Request, Response } from 'express';
import { getPool } from '../config/database';
import { logger } from '../config/logger';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/motorcycles — List approved motorcycles (public)
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    // Build WHERE clauses
    const conditions: string[] = ["listing_status = 'approved'"];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.make) {
      conditions.push(`make ILIKE $${paramIdx}`);
      params.push(`%${req.query.make}%`);
      paramIdx++;
    }
    if (req.query.yearMin) {
      conditions.push(`year >= $${paramIdx}`);
      params.push(parseInt(req.query.yearMin as string));
      paramIdx++;
    }
    if (req.query.yearMax) {
      conditions.push(`year <= $${paramIdx}`);
      params.push(parseInt(req.query.yearMax as string));
      paramIdx++;
    }
    if (req.query.condition) {
      conditions.push(`condition = $${paramIdx}`);
      params.push(req.query.condition);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort
    const sortMap: Record<string, string> = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      year_asc: 'year ASC',
      year_desc: 'year DESC',
    };
    const sort = sortMap[req.query.sort as string] || 'created_at DESC';

    // Count total
    const countResult = await pool.query(`SELECT COUNT(*) FROM motorcycles ${whereClause}`, params);
    const totalItems = parseInt(countResult.rows[0].count);

    // Fetch page
    const dataResult = await pool.query(
      `SELECT id, seller_id, title, make, model, year, vin, mileage_km, engine_cc,
              condition, description, photo_urls, thumbnail_url, listing_status,
              created_at, updated_at
       FROM motorcycles ${whereClause}
       ORDER BY ${sort}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return res.status(200).json({
      data: dataResult.rows.map(formatMotorcycle),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (err) {
    logger.error({ err }, 'List motorcycles failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list motorcycles' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/motorcycles/:id — Get motorcycle details
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, seller_id, title, make, model, year, vin, mileage_km, engine_cc,
              condition, description, photo_urls, thumbnail_url, listing_status,
              created_at, updated_at
       FROM motorcycles WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Motorcycle not found' });
    }

    return res.status(200).json(formatMotorcycle(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Get motorcycle failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get motorcycle' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/motorcycles — Create listing (verified seller only)
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
        message: 'You must complete seller verification before creating listings',
      });
    }

    const { title, make, model, year, vin, mileageKm, engineCc, condition, description, photoUrls, thumbnailUrl } = req.body;

    if (!title || !make || !model || !year || mileageKm === undefined || !condition) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Title, make, model, year, mileageKm, and condition are required',
      });
    }

    const result = await pool.query(
      `INSERT INTO motorcycles
         (seller_id, title, make, model, year, vin, mileage_km, engine_cc,
          condition, description, photo_urls, thumbnail_url, listing_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')
       RETURNING *`,
      [
        req.user!.userId, title, make, model, year,
        vin || null, mileageKm, engineCc || null, condition,
        description || null, photoUrls || [], thumbnailUrl || null,
      ]
    );

    logger.info({ motorcycleId: result.rows[0].id, sellerId: req.user!.userId }, 'Motorcycle listing created');
    return res.status(201).json(formatMotorcycle(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Create motorcycle failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create motorcycle listing' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/motorcycles/:id — Update listing (owner only)
// ---------------------------------------------------------------------------
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();

    // Check ownership
    const existing = await pool.query(
      'SELECT seller_id, listing_status FROM motorcycles WHERE id = $1',
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Motorcycle not found' });
    }

    if (existing.rows[0].seller_id !== req.user!.userId && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not the listing owner' });
    }

    // Check no active auction
    const activeAuction = await pool.query(
      `SELECT id FROM auctions WHERE motorcycle_id = $1 AND status IN ('scheduled', 'active', 'soft_close')`,
      [req.params.id]
    );

    if (activeAuction.rows.length > 0) {
      return res.status(409).json({
        error: 'ACTIVE_AUCTION',
        message: 'Cannot update — motorcycle has an active or scheduled auction',
      });
    }

    const fields = ['title', 'make', 'model', 'year', 'vin', 'mileage_km', 'engine_cc', 'condition', 'description', 'photo_urls', 'thumbnail_url'];
    const bodyMap: Record<string, string> = {
      title: 'title', make: 'make', model: 'model', year: 'year',
      vin: 'vin', mileageKm: 'mileage_km', engineCc: 'engine_cc',
      condition: 'condition', description: 'description',
      photoUrls: 'photo_urls', thumbnailUrl: 'thumbnail_url',
    };

    const setClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [bodyKey, dbKey] of Object.entries(bodyMap)) {
      if (req.body[bodyKey] !== undefined) {
        setClauses.push(`${dbKey} = $${idx}`);
        values.push(req.body[bodyKey]);
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE motorcycles SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} RETURNING *`,
      values
    );

    return res.status(200).json(formatMotorcycle(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Update motorcycle failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update motorcycle' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/motorcycles/:id — Delete listing (owner only)
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();

    const existing = await pool.query(
      'SELECT seller_id FROM motorcycles WHERE id = $1',
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Motorcycle not found' });
    }

    if (existing.rows[0].seller_id !== req.user!.userId && req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not the listing owner' });
    }

    // Check no active auction
    const activeAuction = await pool.query(
      `SELECT id FROM auctions WHERE motorcycle_id = $1 AND status IN ('scheduled', 'active', 'soft_close')`,
      [req.params.id]
    );

    if (activeAuction.rows.length > 0) {
      return res.status(409).json({
        error: 'ACTIVE_AUCTION',
        message: 'Cannot delete — motorcycle has an active or scheduled auction',
      });
    }

    await pool.query('DELETE FROM motorcycles WHERE id = $1', [req.params.id]);

    logger.info({ motorcycleId: req.params.id }, 'Motorcycle listing deleted');
    return res.status(200).json({ message: 'Motorcycle listing deleted' });
  } catch (err) {
    logger.error({ err }, 'Delete motorcycle failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete motorcycle' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/motorcycles/:id/submit — Submit for approval
// ---------------------------------------------------------------------------
router.post('/:id/submit', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();

    const existing = await pool.query(
      'SELECT seller_id, listing_status FROM motorcycles WHERE id = $1',
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Motorcycle not found' });
    }

    if (existing.rows[0].seller_id !== req.user!.userId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not the listing owner' });
    }

    if (existing.rows[0].listing_status !== 'draft') {
      return res.status(400).json({
        error: 'INVALID_STATE',
        message: `Listing is already in '${existing.rows[0].listing_status}' status`,
      });
    }

    const result = await pool.query(
      `UPDATE motorcycles SET listing_status = 'pending_approval', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    logger.info({ motorcycleId: req.params.id }, 'Motorcycle submitted for approval');
    return res.status(200).json(formatMotorcycle(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'Submit motorcycle failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to submit motorcycle' });
  }
});

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------
function formatMotorcycle(row: any) {
  return {
    id: row.id,
    sellerId: row.seller_id,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default router;
