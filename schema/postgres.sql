-- Vanilla Postgres schema for homeserver mode (DATABASE_URL, no Supabase).
-- Flattened from supabase/migrations/* with auth.users replaced by public.users
-- and RLS/storage/GoTrue dropped. The app is the only client.
--
-- Apply once on an empty database:
--   psql "$DATABASE_URL" -f schema/postgres.sql
-- docker compose mounts this as docker-entrypoint-initdb.d (first boot only).

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text,
    google_sub text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE meals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    logged_at timestamptz NOT NULL DEFAULT now(),
    meal_type text CHECK (
        meal_type IS NULL
        OR meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')
    ),
    description text NOT NULL,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    fiber_g numeric CHECK (fiber_g >= 0),
    sugar_g numeric CHECK (sugar_g >= 0),
    alcohol_g numeric CHECK (alcohol_g >= 0),
    caffeine_mg numeric CHECK (caffeine_mg >= 0),
    saturated_fat_g numeric CHECK (saturated_fat_g >= 0),
    trans_fat_g numeric CHECK (trans_fat_g >= 0),
    added_sugar_g numeric CHECK (added_sugar_g >= 0),
    sodium_mg numeric CHECK (sodium_mg >= 0),
    potassium_mg numeric CHECK (potassium_mg >= 0),
    cholesterol_mg numeric CHECK (cholesterol_mg >= 0),
    calcium_mg numeric CHECK (calcium_mg >= 0),
    iron_mg numeric CHECK (iron_mg >= 0),
    magnesium_mg numeric CHECK (magnesium_mg >= 0),
    vitamin_a_mcg numeric CHECK (vitamin_a_mcg >= 0),
    vitamin_c_mg numeric CHECK (vitamin_c_mg >= 0),
    vitamin_d_mcg numeric CHECK (vitamin_d_mcg >= 0),
    nutrient_provenance jsonb,
    notes text,
    idempotency_key text
);

CREATE INDEX idx_meals_logged_at ON meals (logged_at);
CREATE INDEX idx_meals_user_id ON meals (user_id);
CREATE UNIQUE INDEX uniq_meals_user_idem
    ON meals (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE water_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    amount_ml integer NOT NULL CHECK (amount_ml > 0),
    logged_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text
);

CREATE INDEX idx_water_log_user_id ON water_log (user_id);
CREATE INDEX idx_water_log_logged_at ON water_log (logged_at);
CREATE UNIQUE INDEX uniq_water_log_user_idem
    ON water_log (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE weight_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    weight_g integer NOT NULL CHECK (weight_g > 0),
    logged_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text
);

CREATE INDEX idx_weight_log_user_id ON weight_log (user_id);
CREATE INDEX idx_weight_log_logged_at ON weight_log (logged_at);
CREATE UNIQUE INDEX uniq_weight_log_user_idem
    ON weight_log (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE profiles (
    user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    timezone text,
    preferred_weight_unit text CHECK (
        preferred_weight_unit IS NULL
        OR preferred_weight_unit IN ('kg', 'lb')
    ),
    widgets_enabled boolean NOT NULL DEFAULT true,
    alcohol_tracking_enabled boolean NOT NULL DEFAULT false,
    preferred_drink_unit text CHECK (
        preferred_drink_unit IS NULL
        OR preferred_drink_unit IN ('us', 'uk')
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nutrition_goals (
    user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    daily_calories integer,
    daily_protein_g numeric(6, 2),
    daily_carbs_g numeric(6, 2),
    daily_fat_g numeric(6, 2),
    daily_fiber_g numeric(6, 2) CHECK (daily_fiber_g >= 0),
    daily_sugar_g numeric(6, 2) CHECK (daily_sugar_g >= 0),
    daily_alcohol_g numeric(6, 2) CHECK (daily_alcohol_g >= 0),
    daily_caffeine_mg numeric(7, 2) CHECK (daily_caffeine_mg >= 0),
    daily_water_ml integer,
    target_weight_g integer CHECK (target_weight_g > 0),
    max_saturated_fat_g numeric(6, 2) CHECK (max_saturated_fat_g >= 0),
    max_sodium_mg numeric(7, 2) CHECK (max_sodium_mg >= 0),
    min_potassium_mg numeric(7, 2) CHECK (min_potassium_mg >= 0),
    max_cholesterol_mg numeric(7, 2) CHECK (max_cholesterol_mg >= 0),
    min_calcium_mg numeric(7, 2) CHECK (min_calcium_mg >= 0),
    min_iron_mg numeric(7, 2) CHECK (min_iron_mg >= 0),
    min_magnesium_mg numeric(7, 2) CHECK (min_magnesium_mg >= 0),
    min_vitamin_a_mcg numeric(7, 2) CHECK (min_vitamin_a_mcg >= 0),
    min_vitamin_c_mg numeric(7, 2) CHECK (min_vitamin_c_mg >= 0),
    min_vitamin_d_mcg numeric(7, 2) CHECK (min_vitamin_d_mcg >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE food_cache (
    source text NOT NULL,
    source_id text NOT NULL,
    payload jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, source_id)
);

CREATE TABLE oauth_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_tokens_expires_at ON oauth_tokens (expires_at);
CREATE INDEX idx_oauth_tokens_user_id ON oauth_tokens (user_id);

CREATE TABLE refresh_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_codes (
    code text PRIMARY KEY,
    redirect_uri text NOT NULL,
    code_challenge text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_auth_codes_expires_at ON auth_codes (expires_at);

CREATE TABLE registered_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name varchar(255),
    redirect_uris text[] NOT NULL DEFAULT '{}',
    registered_at timestamptz DEFAULT now()
);

CREATE TABLE tool_analytics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id varchar(255) NOT NULL,
    tool_name varchar(100) NOT NULL,
    success boolean NOT NULL,
    duration_ms integer NOT NULL,
    error_category varchar(50),
    date_range_days integer,
    mcp_session_id varchar(255),
    invoked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_tool_analytics_invoked_at ON tool_analytics (invoked_at);
CREATE INDEX idx_tool_analytics_tool_name ON tool_analytics (tool_name);
CREATE INDEX idx_tool_analytics_user_id ON tool_analytics (user_id);
CREATE INDEX idx_tool_analytics_user_tool ON tool_analytics (user_id, tool_name);

-- Same aggregate the Supabase migrations expose as public_landing_stats().
CREATE OR REPLACE FUNCTION public_landing_stats()
RETURNS json
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'food_logs',       (SELECT count(*) FROM meals),
    'total_calories',  (SELECT coalesce(sum(calories), 0) FROM meals),
    'total_protein_g', (SELECT coalesce(sum(protein_g), 0) FROM meals),
    'total_carbs_g',   (SELECT coalesce(sum(carbs_g), 0) FROM meals),
    'total_fat_g',     (SELECT coalesce(sum(fat_g), 0) FROM meals),
    'timezones',       (SELECT count(DISTINCT timezone) FROM profiles),
    'timezone_list',   (
        SELECT coalesce(json_agg(DISTINCT timezone), '[]'::json)
        FROM profiles
        WHERE timezone IS NOT NULL
    ),
    'timezone_counts', (
        SELECT coalesce(json_object_agg(timezone, n), '{}'::json)
        FROM (
            SELECT timezone, count(*)::int AS n
            FROM profiles
            WHERE timezone IS NOT NULL
            GROUP BY timezone
        ) per_tz
    )
  );
$$;
