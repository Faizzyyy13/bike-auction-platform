# 🏍️ Bike Auction Platform — High-Concurrency Real-Time Bidding Engine

A production-ready, real-time motorcycle auction platform engineered to process high-frequency bids with zero race conditions, sub-millisecond atomic validation, soft-close anti-sniping protection, and full observability.

---

## 📑 Table of Contents
- [Architecture Overview](#-architecture-overview)
- [Tech Stack](#-tech-stack)
- [Key Features & Anti-Fraud Protections](#-key-features--anti-fraud-protections)
- [Quick Start (One-Command Setup)](#-quick-start-one-command-setup)
- [Running Automated Tests](#-running-automated-tests)
- [Testing the Race Condition Fix](#-testing-the-race-condition-fix)
- [API Contracts & Documentation](#-api-contracts--documentation)
- [Observability & Metrics](#-observability--metrics)
- [Production Deployment Guidelines](#-production-deployment-guidelines)

---

## 🏛️ Architecture Overview

The system uses a **Modular Monolith** pattern with dual-phase bidding evaluation:

```
[ Client / SPA ] ──(WebSocket / REST)──▶ [ Nginx Reverse Proxy :8080 ]
                                                   │
                                                   ▼
                                     ┌───────────────────────────┐
                                     │   Node.js Backend (:3000) │
                                     └─────────────┬─────────────┘
                                                   │
                   ┌───────────────────────────────┴───────────────────────────────┐
                   ▼                                                               ▼
     ┌───────────────────────────┐                                   ┌───────────────────────────┐
     │      Redis 7 (:6379)      │                                   │    PostgreSQL 16 (:5432)  │
     │  - Atomic Lua Script      │                                   │  - Optimistic Lock        │
     │  - Pub/Sub Broadcast      │ ─── (Write-Behind Persistence) ──▶ │  - Anti-Shill Triggers    │
     │  - AOF Durable Logging    │                                   │  - Immutable Bid Ledger   │
     └───────────────────────────┘                                   └───────────────────────────┘
```

1. **Phase 1 (Redis Atomic Evaluation)**: Bids are validated and evaluated atomically inside a Redis Lua script. No two bids can execute concurrently; exactly one wins and subsequent bids are evaluated against the newly updated state.
2. **Phase 2 (PostgreSQL Write-Behind)**: Accepted bids are persisted to PostgreSQL inside a database transaction using optimistic concurrency control (`WHERE version = $expected`).

For full technical trade-offs and domain boundaries, see [architecture_document.md](file:///C:/Users/faiza/.gemini/antigravity/brain/45f66dab-d225-4a05-90b2-596944e3f41f/architecture_document.md).

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Backend Runtime** | Node.js 20 (TypeScript) + Express |
| **Real-Time Layer** | Socket.io (WebSockets) |
| **In-Memory Store** | Redis 7 (Lua Scripting + Pub/Sub + AOF log) |
| **Primary Database** | PostgreSQL 16 (Optimistic Locking + Triggers) |
| **Frontend SPA** | React 18 (TypeScript) + Vite |
| **Web Server** | Nginx Alpine (Reverse Proxy & Static Host) |
| **Containerization** | Docker & Docker Compose |
| **Observability** | Prometheus (`prom-client`) + Pino Logger |
| **Testing** | Vitest |

---

## 🛡️ Key Features & Anti-Fraud Protections

- **Atomic Bid Evaluation**: Prevents race conditions during bidding wars without complex distributed locking overhead.
- **Soft-Close Auto-Extension**: Any bid placed within the final 2 minutes extends the auction clock by 2 minutes, eliminating bid sniping.
- **Anti-Shill Bidding**: Database trigger `trg_prevent_shill_bidding` prevents sellers from bidding on their own auctions.
- **Rate Limiting**: Per-user sliding-window rate limiter (max 5 bids per 10 seconds per auction).
- **Correlation ID Lifecycle Tracing**: Unique `correlationId` assigned to every bid for end-to-end logging, database auditing, and WebSocket delivery confirmation.

---

## 🚀 Quick Start (One-Command Setup)

### Prerequisites
- Docker Engine `^20.10` and Docker Compose `^2.0`

### Spin Up the Full Stack

```bash
# Clone repository and navigate to root
cd bike-auction-platform

# Spin up Postgres 16, Redis 7, Backend, and Frontend containers
docker-compose up --build
```

Access services:
- **Frontend SPA**: `http://localhost:8080`
- **Backend API**: `http://localhost:3000/api`
- **Prometheus Metrics**: `http://localhost:3000/metrics`
- **Health Check**: `http://localhost:3000/health`

---

## 🧪 Running Automated Tests

Navigate to the `backend/` directory to run tests.

### Prerequisites for Running Tests Locally
- Node.js `^20.0`
- Running Redis instance on `localhost:6379` (or via Docker: `docker run -d -p 6379:6379 redis:7-alpine`)

```bash
cd backend

# Install dependencies
npm install

# Run all tests
npm test
```

---

## ⚡ Testing the Race Condition Fix

The race condition test suite explicitly proves that simultaneous bids at the exact same millisecond are serialized atomically.

```bash
cd backend
npm run test:race
```

### What `test:race` Demonstrates:
1. **Concurrent Same-Amount Bids**: Two bidders fire $101.00 bids at the exact same millisecond via `Promise.all`. **Result**: Exactly 1 wins (version 1→2), the second is rejected with `BID_TOO_LOW`.
2. **Ascending Concurrent Bids**: Multiple bids dispatched simultaneously are serialized in strict execution order.
3. **Anti-Shill Protection**: Seller bid attempts are rejected with `SHILL_BID_REJECTED`.
4. **Expired Auction**: Bids after end time get rejected with `AUCTION_ENDED`.
5. **Soft-Close Extension**: Verifies end time extends by 2 minutes when a bid lands in the soft-close window.
6. **10-Bidder Stress Test**: 10 simultaneous bids result in 1 winner and 9 deterministic rejections.

---

## 📖 API Contracts & Documentation

- **OpenAPI 3.0 Spec**: Located at [docs/openapi.yaml](file:///C:/Users/faiza/.gemini/antigravity/scratch/bike-auction-platform/backend/docs/openapi.yaml).
- **PostgreSQL Schema**: Located at [database/schema.sql](file:///C:/Users/faiza/.gemini/antigravity/scratch/bike-auction-platform/database/schema.sql).

### Key Endpoints

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Register new user (returns JWT access token + refresh cookie) | No |
| `POST` | `/api/auth/login` | Login user | No |
| `POST` | `/api/auth/refresh` | Rotate access & refresh tokens | Refresh Cookie |
| `GET` | `/api/motorcycles` | List approved motorcycle inventory with filters | No |
| `POST` | `/api/motorcycles` | Create motorcycle listing | Verified Seller |
| `GET` | `/api/auctions` | List auctions (filter by status, make, sort) | No |
| `POST` | `/api/auctions` | Create auction for approved motorcycle | Verified Seller |
| `GET` | `/api/auctions/:id/bids` | Fetch paginated bid audit history | No |
| `GET` | `/metrics` | Prometheus metrics exposition endpoint | No |

---

## 📊 Observability & Metrics

Prometheus metrics are exposed at `GET /metrics`.

### Key Metrics Exported

- `bike_auction_active_websocket_connections`: Active connected Socket.io clients gauge.
- `bike_auction_bids_processed_total`: Total bids counter labeled by `status` (`accepted`, `rejected`, `rate_limited`).
- `bike_auction_bid_latency_seconds`: End-to-end bid latency histogram.
- `bike_auction_redis_lua_duration_seconds`: Atomic Redis Lua duration histogram.
- `bike_auction_postgres_persist_duration_seconds`: PostgreSQL write-behind duration histogram.
- `bike_auction_soft_close_extensions_total`: Soft-close extension counter.

---

## 🚢 Production Deployment Guidelines

1. **Environment Configuration**: Set strong values for `JWT_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` in `.env`.
2. **PostgreSQL Tuning**: Ensure `max_connections >= 100` and enable WAL archival for point-in-time recovery.
3. **Redis Cluster / Sentinel**: For multi-region production, deploy a Redis High Availability Cluster with sentinel failover.
4. **TLS Termination**: Place Nginx behind AWS ALB or Cloudflare for TLS (HTTPS / WSS) termination.
