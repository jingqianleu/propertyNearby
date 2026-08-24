# Property Nearby

Property Nearby is a Google Maps project finder backed by its own PostgreSQL/PostGIS database and REST API. A scheduled job reads TEDUH every day, stores new or changed records, and serves the website without browser-to-TEDUH requests.

## Architecture

```text
GitHub Actions (daily at 02:00 MYT) ──> TEDUH sync worker ──> PostgreSQL/PostGIS
                                                                  │
Browser ──> Property Nearby API ───────────────────────────────────┘
   │
   └──────> Google Maps JavaScript API
```

The browser creates Google Maps once per page load. Searches update its markers without recreating the map. Project data, prices, permit expiry dates, districts, and cities come from `/api/v1`, not directly from TEDUH.

## Local setup

Prerequisites:

- Node.js 20 or newer
- pnpm
- Docker Desktop, or another PostgreSQL server with PostGIS

Create the local environment file:

```sh
cp .env.example .env
```

Start only the local database:

```sh
docker compose up -d database
```

Install packages and create the schema:

```sh
pnpm install
pnpm db:migrate
```

Import one TEDUH page and up to five project details for a quick test:

```sh
pnpm sync:sample
```

Start the website and API:

```sh
pnpm start
```

Open <http://localhost:8000>. The old `python3 -m http.server` command is no longer sufficient because the website now needs the application API.

To start the database and application together instead:

```sh
docker compose up --build
```

Run the complete first import when the sample is working:

```sh
pnpm sync
```

The first import can take a long time because it must fetch project detail and price data. Later daily imports fetch details only for new or changed project summaries. It is safe to rerun because all writes are upserts.

## Google Maps

Put a browser-restricted Maps JavaScript API key in `config.js`, or leave it empty and enter the key in the one-time browser dialog:

```js
window.PROPERTY_NEARBY_CONFIG = {
  googleMapsApiKey: 'YOUR_BROWSER_RESTRICTED_KEY',
  apiBaseUrl: '/api/v1',
};
```

In Google Cloud Console, restrict the key to:

- Maps JavaScript API
- `http://localhost:8000/*` during development
- Your production HTTPS domain

Do not put a database password or Supabase service-role key in `config.js`.

## Managed database with Supabase

The SQL in `db/schema.sql` works with Supabase PostgreSQL and enables PostGIS.

1. Create a Supabase project.
2. Copy its PostgreSQL pooler connection string from **Project Settings → Database**.
3. Set `DATABASE_URL` in `.env` and set `DB_SSL=true`.
4. Run `pnpm db:migrate`.
5. Run `pnpm sync:sample`, then check the `projects`, `project_components`, and `sync_runs` tables in Supabase.
6. Run `pnpm sync` for the complete initial import.

The database service connection is used only by the server and sync worker. The frontend has no direct database credentials.

## Daily scheduler

`.github/workflows/daily-sync.yml` runs at 18:00 UTC, which is 02:00 in Malaysia. To enable it:

1. Push this project to GitHub.
2. In **Repository Settings → Secrets and variables → Actions**, add a secret named `DATABASE_URL` containing the production PostgreSQL connection string.
3. Enable GitHub Actions for the repository.
4. Run **Daily TEDUH sync → Run workflow** once to verify it.

The database advisory lock prevents overlapping scheduled runs. Retries handle temporary TEDUH `429` and server errors. The job records totals in `sync_runs` and individual detail failures in `sync_errors`.

For Cloud Run Jobs, deploy the same Docker image and override its command with:

```sh
node scripts/sync-teduh.js
```

Then configure Cloud Scheduler to execute that job daily. Use either GitHub Actions or Cloud Scheduler, not both.

## API

```text
GET /api/v1/health
GET /api/v1/projects
GET /api/v1/projects/:id
GET /api/v1/filters/states
GET /api/v1/filters/districts?state=10
GET /api/v1/filters/cities?district=1005
GET /api/v1/filters/statuses
```

Project query parameters:

```text
page, per_page, q, search_type, state, district, city, statusProjek,
pricemin, pricemax, permit_expiry_year, lat, lng, radius_km
```

Example:

```text
/api/v1/projects?state=10&statusProjek=5&permit_expiry_year=2027&page=1&per_page=50
```

## Useful commands

```sh
pnpm start          # Start API and website
pnpm dev            # Restart automatically after code changes
pnpm db:migrate     # Create or update database tables and indexes
pnpm sync:sample    # Safe small import for setup verification
pnpm sync           # Complete TEDUH synchronization
pnpm check          # JavaScript syntax checks
```
