import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Map between camelCase JS field names and snake_case DB column names.
const TABLE_MAP = {
    projects: { table: 'projects', fields: { id: 'id', name: 'name', budget: 'budget', currency: 'currency', status: 'status', desc: 'desc', startDate: 'start_date', endDate: 'end_date', priority: 'priority', lead: 'lead', active: 'active', createdAt: 'created_at', updatedAt: 'updated_at' } },
    workers: { table: 'workers', fields: { id: 'id', name: 'name', phone: 'phone', position: 'position', rate: 'rate', schedule: 'schedule', active: 'active', createdAt: 'created_at', updatedAt: 'updated_at' } },
    expenses: { table: 'expenses', fields: { id: 'id', projectId: 'project_id', category: 'category', amount: 'amount', date: 'date', desc: 'desc', workers: 'workers', splits: 'splits', createdAt: 'created_at', updatedAt: 'updated_at' } },
    timeEntries: { table: 'time_entries', fields: { id: 'id', workerId: 'worker_id', projectId: 'project_id', date: 'date', hours: 'hours', type: 'type', comment: 'comment', rateSnapshot: 'rate_snapshot', createdAt: 'created_at', updatedAt: 'updated_at' } },
    templates: { table: 'templates', fields: { id: 'id', name: 'name', category: 'category', amount: 'amount', projectId: 'project_id', desc: 'desc', createdAt: 'created_at', updatedAt: 'updated_at' } },
    stages: { table: 'stages', fields: { id: 'id', projectId: 'project_id', name: 'name', description: 'description', status: 'status', startDate: 'start_date', endDate: 'end_date', order: 'order', createdAt: 'created_at', updatedAt: 'updated_at' } },
    tasks: { table: 'tasks', fields: { id: 'id', projectId: 'project_id', stageId: 'stage_id', title: 'title', description: 'description', status: 'status', priority: 'priority', workerIds: 'worker_ids', startDate: 'start_date', dueDate: 'due_date', completedAt: 'completed_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    activityLog: { table: 'activity_log', fields: { id: 'id', ts: 'ts', entity: 'entity', action: 'action', label: 'label' } }
};

function toDbRow(collection, item) {
    const { fields } = TABLE_MAP[collection];
    const row = {};
    for (const [jsKey, dbCol] of Object.entries(fields)) {
        if (item[jsKey] !== undefined) {
            row[dbCol] = item[jsKey];
        }
    }
    return row;
}

function fromDbRow(collection, row) {
    const { fields } = TABLE_MAP[collection];
    const item = {};
    for (const [jsKey, dbCol] of Object.entries(fields)) {
        item[jsKey] = row[dbCol];
    }
    return item;
}

// Load all data from Supabase, reconstruct the Store.data shape.
export async function loadFromSupabase() {
    const data = {
        projects: [], workers: [], expenses: [],
        timeEntries: [], templates: [],
        stages: [], tasks: [], activityLog: [],
        settings: null
    };

    const [projects, workers, expenses, timeEntries, templates, stages, tasks, activityLog, settingsRow] = await Promise.all([
        supabase.from('projects').select('*').order('created_at'),
        supabase.from('workers').select('*').order('created_at'),
        supabase.from('expenses').select('*').order('date'),
        supabase.from('time_entries').select('*').order('date'),
        supabase.from('templates').select('*').order('created_at'),
        supabase.from('stages').select('*').order('order'),
        supabase.from('tasks').select('*').order('created_at'),
        supabase.from('activity_log').select('*').order('ts'),
        supabase.from('app_settings').select('*').eq('id', 1).maybeSingle()
    ]);

    const results = { projects, workers, expenses, timeEntries, templates, stages, tasks, activityLog };
    for (const [coll, res] of Object.entries(results)) {
        if (res.error) throw new Error(`load ${coll}: ${res.error.message}`);
        data[coll] = res.data.map(row => fromDbRow(coll, row));
    }

    if (activityLog.error) throw new Error(`load activityLog: ${activityLog.error.message}`);
    data.activityLog = activityLog.data.map(row => fromDbRow('activityLog', row));

    if (settingsRow.error) throw new Error(`load settings: ${settingsRow.error.message}`);
    data.settings = settingsRow.data ? settingsRow.data.settings : null;

    return data;
}

// Full sync: upsert all rows from Store.data to Supabase.
// Called debounced by Storage.write().
export async function syncToSupabase(data) {
    const collections = ['projects', 'workers', 'expenses', 'timeEntries', 'templates', 'stages', 'tasks', 'activityLog'];

    for (const coll of collections) {
        const { table } = TABLE_MAP[coll];
        const rows = (data[coll] || []).map(item => toDbRow(coll, item));
        if (rows.length === 0) {
            const { error } = await supabase.from(table).delete().neq('id', '___never___');
            if (error) throw new Error(`sync ${coll} delete: ${error.message}`);
        } else {
            const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' });
            if (error) throw new Error(`sync ${coll} upsert: ${error.message}`);
            // Delete rows that no longer exist in the local data
            const localIds = rows.map(r => r.id);
            const { error: delError } = await supabase.from(table).delete().not('id', 'in', `(${localIds.map(id => `'${id}'`).join(',')})`);
            if (delError) throw new Error(`sync ${coll} cleanup: ${delError.message}`);
        }
    }

    // Sync settings
    const settingsRow = { id: 1, settings: data.settings || {}, updated_at: new Date().toISOString() };
    const { error: settingsError } = await supabase.from('app_settings').upsert(settingsRow, { onConflict: 'id' });
    if (settingsError) throw new Error(`sync settings: ${settingsError.message}`);
}
