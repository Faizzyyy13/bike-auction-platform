-- ============================================================================
-- Bike Auction Platform — PostgreSQL Schema (V1)
-- ============================================================================
-- Concurrency Control:
--   • Optimistic locking via `version` column on `auctions` table
--   • Denormalized `current_highest_bid` + `current_highest_bidder_id` on
--     `auctions` for sub-millisecond read access during live bid rendering
--   • SELECT ... FOR UPDATE used at application layer for critical writes
--
-- Indexes:
--   • High-read paths:  active auction listings, motorcycle search/filter
--   • High-write paths: bid insertion, auction bid-counter increment
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 0. Extensions
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid() fallback

-- --------------------------------------------------------------------------
-- 1. Custom ENUM Types
-- --------------------------------------------------------------------------
CREATE TYPE user_role        AS ENUM ('buyer', 'seller', 'admin');
CREATE TYPE listing_status   AS ENUM ('draft', 'pending_approval', 'approved', 'rejected');
CREATE TYPE auction_status   AS ENUM ('scheduled', 'active', 'soft_close', 'ended', 'reserve_not_met', 'sold', 'cancelled');
CREATE TYPE bid_status       AS ENUM ('valid', 'outbid', 'rejected', 'winning');
CREATE TYPE vehicle_condition AS ENUM ('excellent', 'good', 'fair', 'poor', 'salvage');

-- --------------------------------------------------------------------------
-- 2. Users
-- --------------------------------------------------------------------------
CREATE TABLE users (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email                VARCHAR(255)  NOT NULL,
    username             VARCHAR(100)  NOT NULL,
    password_hash        VARCHAR(512)  NOT NULL,   -- Argon2id output
    role                 user_role     NOT NULL DEFAULT 'buyer',

    -- Seller verification
    is_seller_verified   BOOLEAN       NOT NULL DEFAULT FALSE,
    government_id_url    TEXT,                      -- S3/GCS path for ID doc
    phone_number         VARCHAR(30),
    phone_verified       BOOLEAN       NOT NULL DEFAULT FALSE,

    -- Payment stub (V1 mock — real Stripe in V2)
    has_card_on_file     BOOLEAN       NOT NULL DEFAULT FALSE,

    -- Metadata
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_users_email    UNIQUE (email),
    CONSTRAINT uq_users_username UNIQUE (username)
);

-- Index: login lookup by email
CREATE INDEX idx_users_email ON users (email);

-- --------------------------------------------------------------------------
-- 3. Motorcycles (Inventory)
-- --------------------------------------------------------------------------
CREATE TABLE motorcycles (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_id         UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Vehicle details
    title             VARCHAR(300)   NOT NULL,
    make              VARCHAR(100)   NOT NULL,       -- e.g. "Harley-Davidson"
    model             VARCHAR(100)   NOT NULL,       -- e.g. "Sportster S"
    year              SMALLINT       NOT NULL,
    vin               VARCHAR(17),                   -- Vehicle Identification Number
    mileage_km        INTEGER        NOT NULL DEFAULT 0,
    engine_cc         INTEGER,                       -- Engine displacement
    condition         vehicle_condition NOT NULL DEFAULT 'good',
    description       TEXT,

    -- Media
    photo_urls        TEXT[]         NOT NULL DEFAULT '{}',  -- Array of S3/GCS URLs
    thumbnail_url     TEXT,

    -- Listing lifecycle
    listing_status    listing_status NOT NULL DEFAULT 'draft',

    -- Metadata
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_motorcycles_year CHECK (year BETWEEN 1900 AND 2100),
    CONSTRAINT chk_motorcycles_mileage CHECK (mileage_km >= 0)
);

-- Index: browse approved listings by make/year (high-read)
CREATE INDEX idx_motorcycles_listing_status ON motorcycles (listing_status);
CREATE INDEX idx_motorcycles_seller         ON motorcycles (seller_id);
CREATE INDEX idx_motorcycles_make_year      ON motorcycles (make, year);
CREATE INDEX idx_motorcycles_vin            ON motorcycles (vin) WHERE vin IS NOT NULL;

-- --------------------------------------------------------------------------
-- 4. Auctions
-- --------------------------------------------------------------------------
CREATE TABLE auctions (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    motorcycle_id               UUID           NOT NULL REFERENCES motorcycles(id) ON DELETE CASCADE,
    seller_id                   UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Pricing
    starting_price_cents        BIGINT         NOT NULL,   -- stored in cents
    reserve_price_cents         BIGINT,                    -- NULL = no reserve
    bid_increment_cents         BIGINT         NOT NULL DEFAULT 100, -- min $1.00

    -- Denormalized current state (fast reads — updated atomically with each bid)
    current_highest_bid_cents   BIGINT         NOT NULL DEFAULT 0,
    current_highest_bidder_id   UUID           REFERENCES users(id) ON DELETE SET NULL,
    total_bids                  INTEGER        NOT NULL DEFAULT 0,

    -- Timing
    starts_at                   TIMESTAMPTZ    NOT NULL,
    original_end_time           TIMESTAMPTZ    NOT NULL,   -- original scheduled end
    current_end_time            TIMESTAMPTZ    NOT NULL,   -- may extend on soft-close
    soft_close_window_seconds   INTEGER        NOT NULL DEFAULT 120,  -- 2 minutes
    soft_close_extension_seconds INTEGER       NOT NULL DEFAULT 120,  -- extends by 2 min

    -- State
    status                      auction_status NOT NULL DEFAULT 'scheduled',

    -- Optimistic concurrency control
    version                     INTEGER        NOT NULL DEFAULT 1,

    -- Metadata
    created_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_auctions_starting_price  CHECK (starting_price_cents > 0),
    CONSTRAINT chk_auctions_reserve_price   CHECK (reserve_price_cents IS NULL OR reserve_price_cents >= starting_price_cents),
    CONSTRAINT chk_auctions_dates           CHECK (starts_at < original_end_time),
    CONSTRAINT chk_auctions_end_time        CHECK (current_end_time >= original_end_time),
    CONSTRAINT chk_auctions_bid_increment   CHECK (bid_increment_cents > 0),
    CONSTRAINT chk_auctions_version         CHECK (version >= 1)
);

-- Index: active/upcoming auctions listing page (high-read)
CREATE INDEX idx_auctions_status           ON auctions (status);
CREATE INDEX idx_auctions_status_end       ON auctions (status, current_end_time);
CREATE INDEX idx_auctions_motorcycle       ON auctions (motorcycle_id);
CREATE INDEX idx_auctions_seller           ON auctions (seller_id);

-- Index: scheduler picks up auctions transitioning state
CREATE INDEX idx_auctions_scheduled_start  ON auctions (starts_at)       WHERE status = 'scheduled';
CREATE INDEX idx_auctions_active_end       ON auctions (current_end_time) WHERE status IN ('active', 'soft_close');

-- --------------------------------------------------------------------------
-- 5. Bids
-- --------------------------------------------------------------------------
CREATE TABLE bids (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auction_id      UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    amount_cents    BIGINT      NOT NULL,
    status          bid_status  NOT NULL DEFAULT 'valid',

    -- Snapshot of auction state at time of bid (audit trail)
    auction_version_at_bid  INTEGER NOT NULL,

    -- Anti-fraud: client metadata
    ip_address      INET,
    user_agent      TEXT,

    -- Observability: correlation ID linking WS event → Redis → Postgres
    correlation_id  UUID        NOT NULL DEFAULT uuid_generate_v4(),

    -- Metadata
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_bids_amount CHECK (amount_cents > 0)
);

-- Anti-shill bidding: prevent seller from bidding on own auction (enforced at
-- application layer AND via trigger below, since a cross-table CHECK isn't
-- possible in standard SQL).

-- Index: high-write insertion path — ordered by auction + timestamp
CREATE INDEX idx_bids_auction_created  ON bids (auction_id, created_at DESC);
-- Index: user's bid history
CREATE INDEX idx_bids_bidder           ON bids (bidder_id, created_at DESC);
-- Index: correlation ID lookup for observability
CREATE INDEX idx_bids_correlation      ON bids (correlation_id);
-- Index: find winning bid quickly
CREATE INDEX idx_bids_auction_status   ON bids (auction_id, status) WHERE status = 'winning';

-- --------------------------------------------------------------------------
-- 6. Anti-Shill Trigger
-- --------------------------------------------------------------------------
-- Prevents a seller from placing a bid on their own auction at the DB level.
CREATE OR REPLACE FUNCTION prevent_shill_bidding()
RETURNS TRIGGER AS $$
DECLARE
    auction_seller_id UUID;
BEGIN
    SELECT seller_id INTO auction_seller_id
    FROM auctions
    WHERE id = NEW.auction_id;

    IF NEW.bidder_id = auction_seller_id THEN
        RAISE EXCEPTION 'Shill bidding detected: seller cannot bid on own auction'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_shill_bidding
    BEFORE INSERT ON bids
    FOR EACH ROW
    EXECUTE FUNCTION prevent_shill_bidding();

-- --------------------------------------------------------------------------
-- 7. Auto-update `updated_at` Trigger
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_motorcycles_updated_at
    BEFORE UPDATE ON motorcycles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_auctions_updated_at
    BEFORE UPDATE ON auctions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- 8. Notification Log (Winner/Outbid Notifications)
-- --------------------------------------------------------------------------
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auction_id      UUID         REFERENCES auctions(id) ON DELETE SET NULL,
    type            VARCHAR(50)  NOT NULL,   -- 'outbid', 'auction_won', 'auction_ending', 'auction_cancelled'
    payload         JSONB        NOT NULL DEFAULT '{}',
    is_read         BOOLEAN      NOT NULL DEFAULT FALSE,
    delivered_via   VARCHAR(30)  NOT NULL DEFAULT 'websocket',  -- 'websocket', 'email'
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user     ON notifications (user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_auction  ON notifications (auction_id);

-- --------------------------------------------------------------------------
-- 9. Refresh Tokens (Auth)
-- --------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(512) NOT NULL,  -- SHA-256 hash of the refresh token
    expires_at      TIMESTAMPTZ  NOT NULL,
    revoked         BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_refresh_tokens_hash UNIQUE (token_hash)
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);

COMMIT;
