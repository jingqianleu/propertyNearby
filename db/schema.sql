CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS states (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS districts (
  id text PRIMARY KEY,
  state_id text NOT NULL REFERENCES states(id),
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cities (
  id text PRIMARY KEY,
  district_id text NOT NULL REFERENCES districts(id),
  state_id text NOT NULL REFERENCES states(id),
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL DEFAULT 'teduh',
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  pages_fetched integer NOT NULL DEFAULT 0,
  projects_seen integer NOT NULL DEFAULT 0,
  projects_changed integer NOT NULL DEFAULT 0,
  details_fetched integer NOT NULL DEFAULT 0,
  errors_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  dim_id bigint,
  developer_code text,
  developer_name text,
  name text NOT NULL,
  phase text,
  state_id text REFERENCES states(id),
  district_id text REFERENCES districts(id),
  city_id text REFERENCES cities(id),
  postcode text,
  parliament_id text,
  pbt_id text,
  status_code text,
  status_label text,
  latitude double precision,
  longitude double precision,
  location geography(Point, 4326),
  permit_id bigint,
  permit_number text,
  permit_start date,
  permit_expiry date,
  permit_cancelled boolean NOT NULL DEFAULT false,
  price_min numeric(15, 2),
  price_max numeric(15, 2),
  source_version integer,
  source_updated_at timestamptz,
  source_hash text NOT NULL,
  raw_summary jsonb NOT NULL,
  raw_detail jsonb,
  detail_synced_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  last_sync_run_id bigint REFERENCES sync_runs(id)
);

CREATE TABLE IF NOT EXISTS project_components (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  component_index integer NOT NULL,
  property_type text,
  floors text,
  bedrooms text,
  bathrooms text,
  area text,
  units integer,
  price_min numeric(15, 2),
  price_max numeric(15, 2),
  completion_percent numeric(7, 2),
  status text,
  ccc_date date,
  vacant_possession_date date,
  raw_data jsonb NOT NULL,
  PRIMARY KEY (project_id, component_index)
);

CREATE TABLE IF NOT EXISTS sync_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_run_id bigint NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  project_id text,
  request_url text,
  http_status integer,
  attempt integer,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_location_gist_idx ON projects USING gist(location);
CREATE INDEX IF NOT EXISTS projects_filters_idx ON projects(state_id, district_id, city_id, status_code) WHERE is_active;
CREATE INDEX IF NOT EXISTS projects_permit_expiry_idx ON projects(permit_expiry) WHERE is_active;
CREATE INDEX IF NOT EXISTS projects_price_idx ON projects(price_min, price_max) WHERE is_active;
CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(source_updated_at DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS projects_name_trgm_idx ON projects USING gin(lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS projects_developer_trgm_idx ON projects USING gin(lower(developer_name) gin_trgm_ops);

INSERT INTO states (id, name) VALUES
  ('01', 'Johor'), ('02', 'Kedah'), ('03', 'Kelantan'), ('04', 'Melaka'),
  ('05', 'Negeri Sembilan'), ('06', 'Pahang'), ('07', 'Pulau Pinang'), ('08', 'Perak'),
  ('09', 'Perlis'), ('10', 'Selangor'), ('11', 'Terengganu'), ('12', 'Sabah'),
  ('13', 'Sarawak'), ('14', 'WP Kuala Lumpur'), ('15', 'WP Labuan'), ('16', 'WP Putrajaya')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

