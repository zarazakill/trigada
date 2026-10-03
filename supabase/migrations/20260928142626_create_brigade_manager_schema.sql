/*
# Brigade Manager Pro — initial schema

1. Purpose
   Migrate data persistence from localStorage to Supabase.
   Single-tenant app (no sign-in) — all tables use TO anon, authenticated policies.

2. New Tables
   - projects: construction/project records with budget, status, priority
   - workers: crew members with hourly rate and schedule
   - expenses: financial operations (materials, salary, advance, etc.)
   - time_entries: hours worked per worker per project per date
   - templates: reusable expense templates
   - stages: project phases with ordering
   - tasks: project tasks with status, priority, assignees
   - activity_log: audit trail of all CRUD operations
   - app_settings: single-row settings table (currency, limits, notifications)

3. Column Notes
   - All money values stored as numeric(12,2) (rubles, not cents)
   - JSON columns use jsonb for expenses.workers/splits and tasks.worker_ids
   - Dates stored as date type where the app uses YYYY-MM-DD strings
   - Timestamps stored as timestamptz
   - "desc" is a reserved keyword in PostgreSQL so it is double-quoted

4. Security
   - RLS enabled on every table
   - TO anon, authenticated with USING(true)/WITH CHECK(true) — single-tenant, no sign-in
   - No user_id columns — data is intentionally shared
*/

-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    budget numeric(12,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'RUB',
    status text NOT NULL DEFAULT 'active',
    "desc" text NOT NULL DEFAULT '',
    start_date date,
    end_date date,
    priority text NOT NULL DEFAULT 'NORMAL',
    lead text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Workers
CREATE TABLE IF NOT EXISTS workers (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    phone text NOT NULL DEFAULT '',
    position text NOT NULL DEFAULT '',
    rate numeric(12,2) NOT NULL DEFAULT 0,
    schedule text NOT NULL DEFAULT 'full',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Expenses
CREATE TABLE IF NOT EXISTS expenses (
    id text PRIMARY KEY,
    project_id text REFERENCES projects(id) ON DELETE SET NULL,
    category text NOT NULL DEFAULT 'other',
    amount numeric(12,2) NOT NULL DEFAULT 0,
    date date NOT NULL,
    "desc" text NOT NULL DEFAULT '',
    workers jsonb NOT NULL DEFAULT '[]'::jsonb,
    splits jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Time entries
CREATE TABLE IF NOT EXISTS time_entries (
    id text PRIMARY KEY,
    worker_id text REFERENCES workers(id) ON DELETE SET NULL,
    project_id text REFERENCES projects(id) ON DELETE SET NULL,
    date date NOT NULL,
    hours numeric(8,2) NOT NULL DEFAULT 0,
    type text NOT NULL DEFAULT 'regular',
    comment text NOT NULL DEFAULT '',
    rate_snapshot numeric(12,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Templates
CREATE TABLE IF NOT EXISTS templates (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    category text NOT NULL DEFAULT 'other',
    amount numeric(12,2) NOT NULL DEFAULT 0,
    project_id text REFERENCES projects(id) ON DELETE SET NULL,
    "desc" text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Stages
CREATE TABLE IF NOT EXISTS stages (
    id text PRIMARY KEY,
    project_id text REFERENCES projects(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'planning',
    start_date date,
    end_date date,
    "order" integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
    id text PRIMARY KEY,
    project_id text REFERENCES projects(id) ON DELETE CASCADE,
    stage_id text REFERENCES stages(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'TODO',
    priority text NOT NULL DEFAULT 'NORMAL',
    worker_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    start_date date,
    due_date date,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
    id text PRIMARY KEY,
    ts bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    entity text NOT NULL DEFAULT '',
    action text NOT NULL DEFAULT '',
    label text NOT NULL DEFAULT ''
);

-- App settings (single-row)
CREATE TABLE IF NOT EXISTS app_settings (
    id integer PRIMARY KEY DEFAULT 1,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_expenses_project_id ON expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_time_entries_worker_id ON time_entries(worker_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date);
CREATE INDEX IF NOT EXISTS idx_stages_project_id ON stages(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_activity_log_ts ON activity_log(ts);

-- RLS: enable on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- RLS policies: single-tenant, no auth — anon + authenticated have full CRUD.
-- This is intentionally public/shared data (no sign-in screen).

-- Projects policies
DROP POLICY IF EXISTS "anon_select_projects" ON projects;
CREATE POLICY "anon_select_projects" ON projects FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_projects" ON projects;
CREATE POLICY "anon_insert_projects" ON projects FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_projects" ON projects;
CREATE POLICY "anon_update_projects" ON projects FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_projects" ON projects;
CREATE POLICY "anon_delete_projects" ON projects FOR DELETE TO anon, authenticated USING (true);

-- Workers policies
DROP POLICY IF EXISTS "anon_select_workers" ON workers;
CREATE POLICY "anon_select_workers" ON workers FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_workers" ON workers;
CREATE POLICY "anon_insert_workers" ON workers FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_workers" ON workers;
CREATE POLICY "anon_update_workers" ON workers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_workers" ON workers;
CREATE POLICY "anon_delete_workers" ON workers FOR DELETE TO anon, authenticated USING (true);

-- Expenses policies
DROP POLICY IF EXISTS "anon_select_expenses" ON expenses;
CREATE POLICY "anon_select_expenses" ON expenses FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_expenses" ON expenses;
CREATE POLICY "anon_insert_expenses" ON expenses FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_expenses" ON expenses;
CREATE POLICY "anon_update_expenses" ON expenses FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_expenses" ON expenses;
CREATE POLICY "anon_delete_expenses" ON expenses FOR DELETE TO anon, authenticated USING (true);

-- Time entries policies
DROP POLICY IF EXISTS "anon_select_time_entries" ON time_entries;
CREATE POLICY "anon_select_time_entries" ON time_entries FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_time_entries" ON time_entries;
CREATE POLICY "anon_insert_time_entries" ON time_entries FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_time_entries" ON time_entries;
CREATE POLICY "anon_update_time_entries" ON time_entries FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_time_entries" ON time_entries;
CREATE POLICY "anon_delete_time_entries" ON time_entries FOR DELETE TO anon, authenticated USING (true);

-- Templates policies
DROP POLICY IF EXISTS "anon_select_templates" ON templates;
CREATE POLICY "anon_select_templates" ON templates FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_templates" ON templates;
CREATE POLICY "anon_insert_templates" ON templates FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_templates" ON templates;
CREATE POLICY "anon_update_templates" ON templates FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_templates" ON templates;
CREATE POLICY "anon_delete_templates" ON templates FOR DELETE TO anon, authenticated USING (true);

-- Stages policies
DROP POLICY IF EXISTS "anon_select_stages" ON stages;
CREATE POLICY "anon_select_stages" ON stages FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_stages" ON stages;
CREATE POLICY "anon_insert_stages" ON stages FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_stages" ON stages;
CREATE POLICY "anon_update_stages" ON stages FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_stages" ON stages;
CREATE POLICY "anon_delete_stages" ON stages FOR DELETE TO anon, authenticated USING (true);

-- Tasks policies
DROP POLICY IF EXISTS "anon_select_tasks" ON tasks;
CREATE POLICY "anon_select_tasks" ON tasks FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_tasks" ON tasks;
CREATE POLICY "anon_insert_tasks" ON tasks FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_tasks" ON tasks;
CREATE POLICY "anon_update_tasks" ON tasks FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_tasks" ON tasks;
CREATE POLICY "anon_delete_tasks" ON tasks FOR DELETE TO anon, authenticated USING (true);

-- Activity log policies
DROP POLICY IF EXISTS "anon_select_activity_log" ON activity_log;
CREATE POLICY "anon_select_activity_log" ON activity_log FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_activity_log" ON activity_log;
CREATE POLICY "anon_insert_activity_log" ON activity_log FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_activity_log" ON activity_log;
CREATE POLICY "anon_update_activity_log" ON activity_log FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_activity_log" ON activity_log;
CREATE POLICY "anon_delete_activity_log" ON activity_log FOR DELETE TO anon, authenticated USING (true);

-- App settings policies
DROP POLICY IF EXISTS "anon_select_app_settings" ON app_settings;
CREATE POLICY "anon_select_app_settings" ON app_settings FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_app_settings" ON app_settings;
CREATE POLICY "anon_insert_app_settings" ON app_settings FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_app_settings" ON app_settings;
CREATE POLICY "anon_update_app_settings" ON app_settings FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_app_settings" ON app_settings;
CREATE POLICY "anon_delete_app_settings" ON app_settings FOR DELETE TO anon, authenticated USING (true);