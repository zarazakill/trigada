/*
# Construction Core — Objects, extended Projects/Stages, Works

1. Purpose
   Phase 1 construction hierarchy: Object → Project → Stage → Work.
   Adds a new "objects" table above projects, extends projects with objectId,
   extends stages with planning/actual dates + progress + budget + actualCost,
   and adds a new "works" table for granular work items within stages.

2. New Tables
   - objects: construction sites / buildings with address, client, contact, area, floors, type
   - works: granular work items within a stage (unit, planned/completed quantity, planned/actual cost)

3. Modified Tables
   - projects: add object_id column (nullable FK to objects, ON DELETE SET NULL)
   - stages: add planned_start, planned_end, actual_start, actual_end, progress, budget, actual_cost, responsible

4. Column Notes
   - Money columns use numeric(12,2) (rubles, same as existing pattern)
   - Progress stored as integer 0-100
   - Dates stored as date type (YYYY-MM-DD, same as existing pattern)
   - "order" already exists on stages; works get their own sort_order

5. Security
   - RLS enabled on objects and works
   - TO anon, authenticated with USING(true)/WITH CHECK(true) — single-tenant, no sign-in
   - No user_id columns — data is intentionally shared

6. Important Notes
   - Old data is NOT destroyed: object_id is nullable so existing projects work without an object
   - Existing stages get default values for new columns (progress=0, budget=0, actual_cost=0, dates=null)
*/

-- Objects table
CREATE TABLE IF NOT EXISTS objects (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    client text NOT NULL DEFAULT '',
    contact text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    area numeric(10,2) NOT NULL DEFAULT 0,
    floors integer NOT NULL DEFAULT 0,
    type text NOT NULL DEFAULT 'residential',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Works table
CREATE TABLE IF NOT EXISTS works (
    id text PRIMARY KEY,
    project_id text REFERENCES projects(id) ON DELETE SET NULL,
    stage_id text REFERENCES stages(id) ON DELETE SET NULL,
    name text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    unit text NOT NULL DEFAULT '',
    planned_quantity numeric(12,2) NOT NULL DEFAULT 0,
    completed_quantity numeric(12,2) NOT NULL DEFAULT 0,
    planned_cost numeric(12,2) NOT NULL DEFAULT 0,
    actual_cost numeric(12,2) NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'TODO',
    responsible text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add object_id to projects (nullable, so existing projects are not affected)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'projects' AND column_name = 'object_id'
    ) THEN
        ALTER TABLE projects ADD COLUMN object_id text REFERENCES objects(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Extend stages with planning/actual dates, progress, budget, actual_cost, responsible
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'planned_start') THEN
        ALTER TABLE stages ADD COLUMN planned_start date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'planned_end') THEN
        ALTER TABLE stages ADD COLUMN planned_end date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'actual_start') THEN
        ALTER TABLE stages ADD COLUMN actual_start date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'actual_end') THEN
        ALTER TABLE stages ADD COLUMN actual_end date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'progress') THEN
        ALTER TABLE stages ADD COLUMN progress integer NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'budget') THEN
        ALTER TABLE stages ADD COLUMN budget numeric(12,2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'actual_cost') THEN
        ALTER TABLE stages ADD COLUMN actual_cost numeric(12,2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stages' AND column_name = 'responsible') THEN
        ALTER TABLE stages ADD COLUMN responsible text NOT NULL DEFAULT '';
    END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_object_id ON projects(object_id);
CREATE INDEX IF NOT EXISTS idx_works_project_id ON works(project_id);
CREATE INDEX IF NOT EXISTS idx_works_stage_id ON works(stage_id);
CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);

-- RLS: enable on new tables
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE works ENABLE ROW LEVEL SECURITY;

-- Objects policies
DROP POLICY IF EXISTS "anon_select_objects" ON objects;
CREATE POLICY "anon_select_objects" ON objects FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_objects" ON objects;
CREATE POLICY "anon_insert_objects" ON objects FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_objects" ON objects;
CREATE POLICY "anon_update_objects" ON objects FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_objects" ON objects;
CREATE POLICY "anon_delete_objects" ON objects FOR DELETE TO anon, authenticated USING (true);

-- Works policies
DROP POLICY IF EXISTS "anon_select_works" ON works;
CREATE POLICY "anon_select_works" ON works FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_works" ON works;
CREATE POLICY "anon_insert_works" ON works FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_works" ON works;
CREATE POLICY "anon_update_works" ON works FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_works" ON works;
CREATE POLICY "anon_delete_works" ON works FOR DELETE TO anon, authenticated USING (true);