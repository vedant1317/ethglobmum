CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  telegram_id BIGINT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'cli')),
  github_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  cli_port INT,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE link_codes (
  code TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE name_challenges (
  nonce TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo_private BOOLEAN NOT NULL,
  branch TEXT NOT NULL,
  subfolder TEXT NOT NULL DEFAULT '',
  output_dir TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'custom')),
  name TEXT NOT NULL UNIQUE,
  preview_name TEXT,
  resolver TEXT NOT NULL,
  prod_resolver TEXT,
  ipns_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_repo ON projects (repo_id, branch);
CREATE TABLE deploys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects ON DELETE CASCADE,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deploys_queue ON deploys (created_at) WHERE status = 'queued';
CREATE TABLE deploy_logs (
  deploy_id UUID NOT NULL REFERENCES deploys ON DELETE CASCADE,
  seq BIGSERIAL,
  kind TEXT NOT NULL DEFAULT 'log',
  line TEXT NOT NULL,
  PRIMARY KEY (deploy_id, seq)
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
