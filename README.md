# DapperDriver API

Node.js + Express backend for **DapperDriver** — a 3-sided fashion marketplace connecting shoppers, boutiques, and delivery drivers.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Framework | Express 4 |
| Database / Auth | Supabase (PostgreSQL + Supabase Auth JWT) |
| Payments | Stripe Connect (Express accounts) |
| Push Notifications | Firebase Cloud Messaging (FCM) |
| Scheduled Jobs | node-cron |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in credentials
cp .env.example .env

# 3. Start dev server (with auto-reload)
npm run dev

# 4. Start production server
npm start
```

---

## Project Structure

```
src/
├── app.js                    # Express app + route mounting
├── config/
│   ├── supabase.js           # Supabase admin client
│   ├── stripe.js             # Stripe client + commission helper
│   └── firebase.js           # Firebase Admin SDK (FCM)
├── middleware/
│   ├── auth.js               # JWT verification + role guard
│   ├── errorHandler.js       # Global error handler + asyncHandler
│   └── validate.js           # express-validator result checker
├── routes/
│   ├── auth.js               # Register, login, refresh, logout, password reset
│   ├── shoppers.js           # Shopper profile, addresses, favorites
│   ├── boutiques.js          # Browse boutiques, products, dashboard
│   ├── drivers.js            # Driver profile, status, location, earnings
│   ├── orders.js             # Full order lifecycle
│   ├── payments.js           # Stripe Connect onboarding + payout history
│   ├── notifications.js      # FCM token registration
│   └── webhooks.js           # Stripe webhook handler (raw body)
├── controllers/
│   └── orderController.js    # Order validation chains + controller functions
├── services/
│   ├── orderService.js       # Order CRUD + status machine + notifications
│   ├── stripeService.js      # Payments, Connect onboarding, transfers, refunds
│   └── fcmService.js         # FCM multicast + domain helpers
└── jobs/
    └── mondayPayouts.js      # Weekly driver payout cron (Mon 8 AM)
```

---

## API Endpoints

### Auth — `/api/v1/auth`
| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create account (role: shopper / boutique / driver) |
| POST | `/login` | Sign in → returns JWT |
| POST | `/refresh` | Refresh access token |
| POST | `/logout` | Invalidate session |
| POST | `/forgot-password` | Send password reset email |
| POST | `/reset-password` | Set new password (requires JWT) |

### Orders — `/api/v1/orders`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | shopper | Place a new order |
| GET | `/` | all | List orders (auto-filtered by role) |
| GET | `/:id` | all | Get full order detail |
| PATCH | `/:id/status` | boutique / driver / admin | Advance order status |
| POST | `/:id/assign-driver` | driver | Self-assign to an order |
| POST | `/:id/cancel` | shopper / boutique | Cancel + refund |

**Order Status Machine:**
```
pending → confirmed → preparing → ready_for_pickup
  → driver_assigned → picked_up → out_for_delivery → delivered
```
Any status → `cancelled` (pre-delivery)

### Payments — `/api/v1/payments`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/boutique/onboard` | boutique | Start Stripe Connect onboarding |
| GET | `/boutique/status` | boutique | Check Stripe account status |
| POST | `/driver/onboard` | driver | Start Stripe Connect onboarding |
| GET | `/driver/status` | driver | Check Stripe account status |
| GET | `/payouts` | boutique / driver | Payout history |

### Boutiques — `/api/v1/boutiques`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | public | Browse boutiques |
| GET | `/:id` | public | Boutique detail + products |
| GET | `/:id/products` | public | Product catalog |
| GET | `/me` | boutique | Own profile |
| PATCH | `/me` | boutique | Update profile |
| GET | `/me/dashboard` | boutique | Revenue + order stats |
| POST | `/me/products` | boutique | Add product |
| PATCH | `/me/products/:id` | boutique | Update product |
| DELETE | `/me/products/:id` | boutique | Deactivate product |

---

## Payment Flow

```
Shopper pays full amount (Stripe PaymentIntent)
    ↓
Platform holds funds (25% commission retained)
    ↓
Order delivered
    ↓
Stripe Transfer: 75% → Boutique Connect account
    ↓
Every Monday 8 AM: Stripe Transfer → Driver (flat fee + tip)
```

---

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

---

## Stripe Webhook Setup

1. Install the Stripe CLI: `brew install stripe/stripe-cli/stripe`
2. Forward webhooks in dev: `stripe listen --forward-to localhost:3000/webhooks/stripe`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` in your `.env`

**Required webhook events:**
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`
- `account.updated`
- `transfer.created`

---

## Roles

Users are assigned a role at registration stored in `user_metadata.role`:

- `shopper` — browse boutiques, place orders, track deliveries
- `boutique` — manage products, fulfill orders, view earnings
- `driver` — accept deliveries, update status, receive payouts
- `admin` — platform management (assign drivers, view all data)
