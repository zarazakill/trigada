import './styles.css';
import { loadFromSupabase, syncToSupabase } from './supabase';

// ===============================================================
//  Brigade Manager Pro — core application logic
//  Logical layering: CONFIG > LOGGER > UTILS > STORAGE > MIGRATIONS
//  > VALIDATION > STORE > CALCULATIONS > SERVICES > RENDER > UI
//  > IMPORT/EXPORT > EVENTS > APP
// ===============================================================

// ---------------- 1. CONFIG ----------------
const CONFIG = {
    STORAGE_KEY: 'brigadeProV2',
    APP_VERSION: '6.0.0',
    SCHEMA_VERSION: 5,
    DEFAULT_CURRENCY: 'RUB',
    PAYMENT_CATEGORIES: ['advance', 'salary'],
    // Feature flags — disabling a flag removes the feature from UI AND code paths.
    features: { stages: true, tasks: true, activityLog: true, analytics: true, finance: true, payroll: true, notifications: true, smartSummary: true, globalSearch: true },
    TASK_STATUSES: ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'],
    TASK_PRIORITIES: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    STAGE_STATUSES: ['planning', 'active', 'done', 'archived'],
    PROJECT_PRIORITIES: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    ACTIVITY_LOG_LIMIT: 500,
    RATE_MULTIPLIERS: { regular: 1, overtime: 1.5, weekend: 2 },
    MAX_MONEY: 1e12,
    MONEY_PRECISION: 2,
    DEFAULT_SETTINGS: {
        notifyBudget: true,
        notifyDebt: true,
        currency: 'RUB',
        budgetWarningPercent: 80,
        maxHoursPerDay: 24
    },
    CURRENCIES: ['RUB', 'USD', 'EUR'],
    CATEGORIES: {
        food: 'Еда', transport: 'Транспорт', materials: 'Материалы',
        tools: 'Инструменты', advance: 'Аванс работнику', salary: 'Зарплата',
        rent: 'Аренда', utilities: 'Коммунальные', other: 'Другое'
    },
    PROJECT_STATUSES: ['active', 'planning', 'completed', 'paused']
};

// ---------------- 2. LOGGER ----------------
const AppLogger = {
    level: 'debug', // debug | info | warn | error
    debug(...a) { if (this.level === 'debug') console.debug('[BMP]', ...a); },
    info(...a) { if (['debug', 'info'].includes(this.level)) console.info('[BMP]', ...a); },
    warn(...a) { console.warn('[BMP]', ...a); },
    error(...a) { console.error('[BMP]', ...a); }
};

// ---------------- 3. UTILS ----------------
const Utils = {
    eq(a, b) { return String(a) === String(b); },

    escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    genId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            try { return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
        }
        return 'id-' + Date.now().toString(36) + '-' +
            Math.random().toString(36).slice(2, 10) + '-' +
            Math.random().toString(36).slice(2, 6);
    },

    cents(n) {
        const x = Number(n);
        if (!Number.isFinite(x)) return 0;
        return Math.round(x * 100);
    },
    toRub(c) { return c / 100; },

    formatMoney(n, currency) {
        const cur = currency || Store.settings().currency || CONFIG.DEFAULT_CURRENCY;
        const v = Number.isFinite(Number(n)) ? Number(n) : 0;
        return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur }).format(v);
    },
    formatMoneyCents(c, currency) { return this.formatMoney(this.toRub(c), currency); },

    formatDate(d) {
        if (!d) return '-';
        const t = new Date(d + (typeof d === 'string' && d.length === 10 ? 'T00:00:00' : ''));
        if (isNaN(t.getTime())) return '-';
        return t.toLocaleDateString('ru-RU');
    },

    todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },

    validateAmount(v) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > CONFIG.MAX_MONEY) return false;
        return true;
    },
    validateDate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        const [y, m, d] = s.split('-').map(Number);
        if (m < 1 || m > 12 || d < 1 || d > 31) return false;
        const dt = new Date(y, m - 1, d);
        return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
    },

    // Strict date-range validation: returns true only if both dates valid and from <= to.
    validateDateRange(from, to) {
        if (!from || !to) return true; // empty = no constraint
        if (!this.validateDate(from) || !this.validateDate(to)) return false;
        return from <= to;
    },
    validateHours(v, max) {
        const n = Number(v);
        const lim = max || Store.settings().maxHoursPerDay;
        if (!Number.isFinite(n) || n <= 0 || n > lim) return false;
        return true;
    },

csvEscape(value) {
        if (value === null || value === undefined) return '';
        const s = String(value);
if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    },

    // App-wide single currency (single source of truth for money display).
    currency() { return Store.settings().currency || CONFIG.DEFAULT_CURRENCY; },

    // Distribute totalCents across `count` shares so the sum is EXACTLY totalCents.
    evenSplitCents(totalCents, count) {
        count = Math.max(1, Math.floor(Number(count) || 1));
        const base = Math.floor(totalCents / count);
        const rem = totalCents - base * count;
        return Array.from({ length: count }, (_, i) => (i < rem ? base + 1 : base));
    },

    // Resolve per-worker splits (ruble values or null) into exact cent amounts
    // that sum to totalCents. Returns { splitsCents } or { error }.
    computeSplitsCents(workers, splitsRuble, totalCents) {
        const fixed = {};
        const fill = [];
        let fixedSum = 0;
        for (const wid of workers) {
            const v = splitsRuble ? splitsRuble[wid] : null;
            if (v != null && Number(v) > 0) {
                const c = this.cents(v);
                fixed[wid] = c;
                fixedSum += c;
            } else {
                fill.push(wid);
            }
        }
        if (fixedSum > totalCents) return { error: 'over' };
        const remaining = totalCents - fixedSum;
        if (fill.length) {
            const even = this.evenSplitCents(remaining, fill.length);
            fill.forEach((wid, i) => { fixed[wid] = even[i]; });
        } else if (remaining !== 0) {
            return { error: 'mismatch' };
        }
        return { splitsCents: fixed };
    },

    // Period helpers for filters/payroll/analytics
    periodRange(period) {
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
        let from, to;
        const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        switch (period) {
            case 'day': from = to = fmt(now); break;
            case 'week': { const w = new Date(y, m, d - 6); from = fmt(w); to = fmt(now); break; }
            case 'month': { from = y + '-' + String(m + 1).padStart(2, '0') + '-01'; to = fmt(now); break; }
            case 'year': { from = y + '-01-01'; to = fmt(now); break; }
            default: from = ''; to = '';
        }
        return { from, to };
    }
};

// ---------------- 4. STORAGE ----------------
const Storage = {
    _timer: null,
    _dirty: false,

    read() {
        try { return localStorage.getItem(CONFIG.STORAGE_KEY); }
        catch (e) { AppLogger.error('Не удалось прочитать локальное хранилище', e); return null; }
    },

    write(payload, immediate) {
        const write = () => {
            this._dirty = false;
            this._saveStatusTimer && clearTimeout(this._saveStatusTimer);
            try {
                localStorage.setItem(CONFIG.STORAGE_KEY, payload);
            } catch (e) {
                AppLogger.error('Не удалось сохранить в локальное хранилище', e);
            }
            // Fire-and-forget cloud sync
            if (typeof Store !== 'undefined' && Store.data) {
                UI.saveStatus('saving');
                syncToSupabase(Store.data)
                    .then(() => { UI.saveStatus('ok'); })
                    .catch((err) => {
                        AppLogger.error('Ошибка синхронизации с облаком', err);
                        UI.saveStatus('error');
                        UI.toast('Не удалось синхронизировать с облаком', 'error');
                    });
            } else {
                UI.saveStatus('ok');
            }
        };
        if (immediate) { this._saveStatusTimer && clearTimeout(this._saveStatusTimer); UI.saveStatus('saving'); if (this._timer) clearTimeout(this._timer); write(); return; }
        if (this._timer) clearTimeout(this._timer);
        this._dirty = true;
        this._saveStatusTimer && clearTimeout(this._saveStatusTimer);
        UI.saveStatus('saving');
        this._timer = setTimeout(write, 250);
    },

    flush() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._dirty && typeof Store !== 'undefined' && Store.data) {
            this.write(this._serialize(Store.data), true);
        }
    },

    _serialize(data) {
        return JSON.stringify({
            ...data,
            schemaVersion: CONFIG.SCHEMA_VERSION,
            applicationVersion: CONFIG.APP_VERSION
        });
    }
};

// ---------------- 5. MIGRATIONS ----------------
const Migrations = {
    v0(data) {
        return {
            schemaVersion: 1,
            applicationVersion: CONFIG.APP_VERSION,
            projects: Array.isArray(data.projects) ? data.projects : [],
            workers: Array.isArray(data.workers) ? data.workers : [],
            expenses: Array.isArray(data.expenses) ? data.expenses : [],
            timeEntries: Array.isArray(data.timeEntries) ? data.timeEntries : [],
            templates: Array.isArray(data.templates) ? data.templates : [],
            settings: { ...CONFIG.DEFAULT_SETTINGS, ...(data.settings || {}) }
        };
    },
    v1(data) {
        data.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(data.settings || {}) };
        ['projects', 'workers', 'expenses', 'timeEntries', 'templates'].forEach(col => {
            (data[col] || []).forEach(item => {
                if (item && typeof item === 'object') {
                    if (!item.createdAt) item.createdAt = new Date().toISOString();
                    if (!item.updatedAt) item.updatedAt = item.createdAt;
                    item.active = item.active !== false;
                }
            });
        });
        data.schemaVersion = 2;
        return data;
    },
    v2(data) {
        (data.expenses || []).forEach(e => {
            if (e && typeof e === 'object') e.amount = Utils.cents(e.amount) / 100;
        });
        (data.templates || []).forEach(t => {
            if (t && typeof t === 'object') t.amount = Utils.cents(t.amount) / 100;
        });
        (data.workers || []).forEach(w => {
            if (w && typeof w === 'object') w.rate = Utils.cents(w.rate) / 100;
        });
        data.schemaVersion = 3;
        return data;
    },
    v3(data) {
        ['stages', 'tasks', 'activityLog', 'notifications'].forEach(col => {
            if (!Array.isArray(data[col])) data[col] = [];
        });
        (data.projects || []).forEach(p => {
            if (p && typeof p === 'object') {
                if (p.startDate == null) p.startDate = '';
                if (p.endDate == null) p.endDate = '';
                if (p.priority == null) p.priority = 'NORMAL';
                if (p.lead == null) p.lead = '';
            }
        });
        data.schemaVersion = 4;
        return data;
    },
    // v4: LEGACY RATE RECOVERY — backfill rateSnapshot on existing timeEntries
    // from the worker's CURRENT rate. This is inherently imprecise for historical
    // records but prevents silent recalculations when a worker's rate changes later.
    v4(data) {
        const workerMap = new Map();
        (data.workers || []).forEach(w => { if (w && w.id) workerMap.set(String(w.id), w); });
        (data.timeEntries || []).forEach(t => {
            if (t && typeof t === 'object' && t.rateSnapshot == null) {
                const w = workerMap.get(String(t.workerId));
                t.rateSnapshot = w ? w.rate : 0;
            }
        });
        data.schemaVersion = 5;
        return data;
    },

    getSteps() { return [this.v0, this.v1, this.v2, this.v3, this.v4]; }
};

// ---------------- 6. VALIDATION / NORMALIZATION ----------------
const Validation = {
    normalizeData(raw) {
        const data = {
            projects: [], workers: [], expenses: [],
            timeEntries: [], templates: [],
            stages: [], tasks: [], activityLog: [], notifications: [],
            settings: { ...CONFIG.DEFAULT_SETTINGS }
        };
        if (!raw || typeof raw !== 'object') return data;

        data.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(raw.settings || {}) };
        data.settings.budgetWarningPercent = Math.max(1, Math.min(100, Number(data.settings.budgetWarningPercent) || 80));
        data.settings.maxHoursPerDay = Math.max(1, Math.min(168, Number(data.settings.maxHoursPerDay) || 24));
        data.settings.currency = CONFIG.CURRENCIES.includes(data.settings.currency) ? data.settings.currency : 'RUB';

        const normItem = (item, def) => {
            if (!item || typeof item !== 'object') return null;
            return { ...def, ...item };
        };

        (Array.isArray(raw.projects) ? raw.projects : []).forEach(p => {
            const o = normItem(p, { id: Utils.genId(), name: '', budget: 0, currency: 'RUB', status: 'active', desc: '', startDate: '', endDate: '', priority: 'NORMAL', lead: '', active: true, createdAt: null, updatedAt: null });
            if (!o) return;
            if (typeof o.name !== 'string') o.name = String(o.name ?? '');
            o.budget = Number.isFinite(Number(o.budget)) ? Utils.cents(o.budget) / 100 : 0;
            if (!CONFIG.PROJECT_STATUSES.includes(o.status)) o.status = 'active';
            if (!Utils.validateDate(o.startDate)) o.startDate = '';
            if (!Utils.validateDate(o.endDate)) o.endDate = '';
            if (!CONFIG.PROJECT_PRIORITIES.includes(o.priority)) o.priority = 'NORMAL';
            if (o.lead == null) o.lead = '';
            data.projects.push(o);
        });

        (Array.isArray(raw.workers) ? raw.workers : []).forEach(w => {
            const o = normItem(w, { id: Utils.genId(), name: '', phone: '', position: '', rate: 0, schedule: 'full', active: true, createdAt: null, updatedAt: null });
            if (!o) return;
            if (typeof o.name !== 'string') o.name = String(o.name ?? '');
            o.rate = Number.isFinite(Number(o.rate)) ? Utils.cents(Math.max(0, Number(o.rate))) / 100 : 0;
            data.workers.push(o);
        });

        (Array.isArray(raw.expenses) ? raw.expenses : []).forEach(e => {
            const o = normItem(e, { id: Utils.genId(), projectId: '', category: 'other', amount: 0, date: '', desc: '', workers: [], splits: {}, createdAt: null, updatedAt: null });
            if (!o) return;
            o.projectId = o.projectId == null ? '' : String(o.projectId);
            if (!CONFIG.CATEGORIES[o.category]) o.category = 'other';
            if (!Utils.validateDate(o.date)) o.date = '';
            o.amount = Number.isFinite(Number(o.amount)) ? Utils.cents(Math.max(0, Number(o.amount))) / 100 : 0;
            o.workers = Array.isArray(o.workers) ? o.workers.filter(Boolean).map(String) : [];
            if (o.splits && typeof o.splits === 'object') {
                o.splits = Object.fromEntries(Object.entries(o.splits).map(([k, v]) => [String(k), Number.isFinite(Number(v)) ? Utils.cents(Number(v)) / 100 : 0]));
            } else { o.splits = {}; }
            data.expenses.push(o);
        });

        (Array.isArray(raw.timeEntries) ? raw.timeEntries : []).forEach(t => {
            const o = normItem(t, { id: Utils.genId(), workerId: '', projectId: '', date: '', hours: 0, type: 'regular', comment: '', rateSnapshot: null, createdAt: null, updatedAt: null });
            if (!o) return;
            o.workerId = o.workerId == null ? '' : String(o.workerId);
            o.projectId = o.projectId == null ? '' : String(o.projectId);
            if (!Utils.validateDate(o.date)) o.date = '';
            o.hours = Number.isFinite(Number(o.hours)) ? Number(o.hours) : 0;
            if (!CONFIG.RATE_MULTIPLIERS[o.type]) o.type = 'regular';
            // rateSnapshot: if present, normalize to number; if null, leave null (migration fills it)
            if (o.rateSnapshot != null) o.rateSnapshot = Number.isFinite(Number(o.rateSnapshot)) ? Number(o.rateSnapshot) : null;
            data.timeEntries.push(o);
        });

        (Array.isArray(raw.templates) ? raw.templates : []).forEach(t => {
            const o = normItem(t, { id: Utils.genId(), name: '', category: 'other', amount: 0, projectId: '', desc: '', createdAt: null, updatedAt: null });
            if (!o) return;
            o.amount = Number.isFinite(Number(o.amount)) ? Utils.cents(Math.max(0, Number(o.amount))) / 100 : 0;
            if (!CONFIG.CATEGORIES[o.category]) o.category = 'other';
            data.templates.push(o);
        });

        (Array.isArray(raw.stages) ? raw.stages : []).forEach(s => {
            const o = normItem(s, { id: Utils.genId(), projectId: '', name: '', description: '', status: 'planning', startDate: '', endDate: '', order: 0 });
            if (!o) return;
            o.projectId = o.projectId == null ? '' : String(o.projectId);
            if (typeof o.name !== 'string') o.name = String(o.name ?? '');
            if (!CONFIG.STAGE_STATUSES.includes(o.status)) o.status = 'planning';
            if (typeof o.description !== 'string') o.description = '';
            if (!Utils.validateDate(o.startDate)) o.startDate = '';
            if (!Utils.validateDate(o.endDate)) o.endDate = '';
            o.order = Number.isFinite(Number(o.order)) ? Number(o.order) : 0;
            data.stages.push(o);
        });

        (Array.isArray(raw.tasks) ? raw.tasks : []).forEach(t => {
            const o = normItem(t, { id: Utils.genId(), projectId: '', stageId: '', title: '', description: '', status: 'TODO', priority: 'NORMAL', workerIds: [], startDate: '', dueDate: '', completedAt: null, createdAt: null, updatedAt: null });
            if (!o) return;
            o.projectId = o.projectId == null ? '' : String(o.projectId);
            o.stageId = o.stageId == null ? '' : String(o.stageId);
            if (typeof o.title !== 'string') o.title = String(o.title ?? '');
            if (typeof o.description !== 'string') o.description = '';
            if (!CONFIG.TASK_STATUSES.includes(o.status)) o.status = 'TODO';
            if (!CONFIG.TASK_PRIORITIES.includes(o.priority)) o.priority = 'NORMAL';
            if (!Utils.validateDate(o.startDate)) o.startDate = '';
            if (!Utils.validateDate(o.dueDate)) o.dueDate = '';
            o.workerIds = Array.isArray(o.workerIds) ? o.workerIds.filter(Boolean).map(String) : [];
            // Enforce completedAt invariant: DONE requires timestamp, non-DONE requires null.
            if (o.status === 'DONE') {
                if (!o.completedAt) o.completedAt = o.updatedAt || o.createdAt || new Date().toISOString();
            } else {
                o.completedAt = null;
            }
            data.tasks.push(o);
        });

        (Array.isArray(raw.activityLog) ? raw.activityLog : []).forEach(l => {
            if (!l || typeof l !== 'object') return;
            const o = {
                id: String(l.id ?? Utils.genId()),
                ts: Number(l.ts) || Date.now(),
                entity: String(l.entity ?? ''),
                action: String(l.action ?? ''),
                label: String(l.label ?? '')
            };
            data.activityLog.push(o);
        });
        data.activityLog = data.activityLog.slice(-CONFIG.ACTIVITY_LOG_LIMIT);

        return data;
    },

    // Legacy audit() — now a thin wrapper over auditSplit() for backward compatibility.
    // Returns a flat array of errors + warnings (excludes business alerts).
    audit(data) {
        const split = this.auditSplit(data || Store.data);
        return split.errors.concat(split.warnings);
    },

    // Data Health: split into ERRORS, WARNINGS, BUSINESS ALERTS.
    // Errors = data corruption. Warnings = legacy data issues. Alerts = business conditions.
    auditSplit(data) {
        const d = data || Store.data;
        const errors = [];
        const warnings = [];
        const alerts = [];
        if (!d || typeof d !== 'object') { errors.push('Данные отсутствуют или повреждены'); return { errors, warnings, alerts }; }

        const projIds = new Set();
        const workerIds = new Set();
        const seenIds = new Set();

        (Array.isArray(d.projects) ? d.projects : []).forEach((p, i) => {
            if (!p || typeof p !== 'object') { errors.push(`Проект #${i + 1} повреждён`); return; }
            const id = String(p.id);
            if (!id) errors.push(`Проект #${i + 1}: отсутствует id`);
            else if (seenIds.has('p:' + id)) errors.push(`Проект #${i + 1}: дублирующийся id`);
            else { seenIds.add('p:' + id); projIds.add(id); }
            if (typeof p.name !== 'string' || !p.name) errors.push(`Проект #${i + 1}: отсутствует название`);
            if (!Number.isFinite(Number(p.budget)) || Number(p.budget) < 0) errors.push(`Проект #${i + 1}: некорректный бюджет`);
            if (p.startDate && p.endDate && !Utils.validateDateRange(p.startDate, p.endDate)) errors.push(`Проект #${i + 1}: дата начала позже даты окончания`);
        });

        (Array.isArray(d.workers) ? d.workers : []).forEach((w, i) => {
            if (!w || typeof w !== 'object') { errors.push(`Работник #${i + 1} повреждён`); return; }
            const id = String(w.id);
            if (!id) errors.push(`Работник #${i + 1}: отсутствует id`);
            else if (seenIds.has('w:' + id)) errors.push(`Работник #${i + 1}: дублирующийся id`);
            else { seenIds.add('w:' + id); workerIds.add(id); }
            if (typeof w.name !== 'string' || !w.name) errors.push(`Работник #${i + 1}: отсутствует имя`);
            if (!Number.isFinite(Number(w.rate)) || Number(w.rate) < 0) errors.push(`Работник #${i + 1}: некорректная ставка`);
        });

        (Array.isArray(d.expenses) ? d.expenses : []).forEach((e, i) => {
            if (!e || typeof e !== 'object') { errors.push(`Расход #${i + 1} повреждён`); return; }
            if (!projIds.has(String(e.projectId))) errors.push(`Расход #${i + 1} ссылается на отсутствующий проект`);
            if (!Number.isFinite(Number(e.amount)) || Number(e.amount) < 0) errors.push(`Расход #${i + 1}: некорректная сумма`);
            if (!Utils.validateDate(e.date)) errors.push(`Расход #${i + 1}: некорректная дата`);
            const wlist = Array.isArray(e.workers) ? e.workers.map(String) : [];
            wlist.forEach(w => { if (!workerIds.has(String(w))) errors.push(`Расход #${i + 1} ссылается на отсутствующего работника`); });
            // P0: salary/advance without worker is an error.
            if (CONFIG.PAYMENT_CATEGORIES.includes(e.category) && wlist.length === 0) errors.push(`Расход #${i + 1}: выплата (${CONFIG.CATEGORIES[e.category]}) без указания работника`);
            if (e.splits && typeof e.splits === 'object') {
                const splitKeys = Object.keys(e.splits);
                splitKeys.forEach(k => {
                    if (!wlist.includes(String(k))) errors.push(`Расход #${i + 1}: доля для работника, не участвующего в расходе`);
                });
                const sumCents = splitKeys.reduce((s, k) => s + Utils.cents(e.splits[k]), 0);
                if (wlist.length && Math.abs(sumCents - Utils.cents(e.amount)) > 0) {
                    errors.push(`Расход #${i + 1}: сумма долей (${sumCents} коп.) не равна сумме расхода (${Utils.cents(e.amount)} коп.)`);
                }
            }
        });

        (Array.isArray(d.timeEntries) ? d.timeEntries : []).forEach((t, i) => {
            if (!t || typeof t !== 'object') { errors.push(`Запись времени #${i + 1} повреждена`); return; }
            if (!workerIds.has(String(t.workerId))) errors.push(`Запись времени #${i + 1} ссылается на отсутствующего работника`);
            if (!projIds.has(String(t.projectId))) errors.push(`Запись времени #${i + 1} ссылается на отсутствующий проект`);
            const h = Number(t.hours);
            if (!Number.isFinite(h) || h <= 0 || h > (d.settings && d.settings.maxHoursPerDay) || h > 168) {
                errors.push(`Запись времени #${i + 1}: некорректное количество часов`);
            }
            if (!Utils.validateDate(t.date)) errors.push(`Запись времени #${i + 1}: некорректная дата`);
            // Warning: missing rateSnapshot (legacy data before migration).
            if (t.rateSnapshot == null) warnings.push(`Запись времени #${i + 1}: отсутствует rateSnapshot (legacy data)`);
        });

        (Array.isArray(d.stages) ? d.stages : []).forEach((s, i) => {
            if (!s || typeof s !== 'object') { errors.push(`Этап #${i + 1} повреждён`); return; }
            if (!String(s.id)) errors.push(`Этап #${i + 1}: отсутствует id`);
            else if (seenIds.has('s:' + s.id)) errors.push(`Этап #${i + 1}: дублирующийся id`);
            else seenIds.add('s:' + s.id);
            if (typeof s.name !== 'string' || !s.name) errors.push(`Этап #${i + 1}: отсутствует название`);
            if (!projIds.has(String(s.projectId))) errors.push(`Этап #${i + 1} ссылается на отсутствующий проект`);
            if (s.startDate && s.endDate && !Utils.validateDateRange(s.startDate, s.endDate)) errors.push(`Этап #${i + 1}: дата начала позже даты окончания`);
        });

        const stageOwners = new Map();
        (Array.isArray(d.tasks) ? d.tasks : []).forEach((t, i) => {
            if (!t || typeof t !== 'object') { errors.push(`Задача #${i + 1} повреждена`); return; }
            if (!String(t.id)) errors.push(`Задача #${i + 1}: отсутствует id`);
            else if (seenIds.has('t:' + t.id)) errors.push(`Задача #${i + 1}: дублирующийся id`);
            else seenIds.add('t:' + t.id);
            if (typeof t.title !== 'string' || !t.title) errors.push(`Задача #${i + 1}: отсутствует название`);
            if (!projIds.has(String(t.projectId))) errors.push(`Задача #${i + 1} ссылается на отсутствующий проект`);
            if (t.stageId) {
                const owns = stageOwners.get(String(t.stageId));
                if (owns !== undefined && owns !== String(t.projectId)) errors.push(`Задача #${i + 1}: этап принадлежит другому проекту`);
                stageOwners.set(String(t.stageId), String(t.projectId));
                if (!(d.stages || []).some(s => String(s.id) === String(t.stageId))) errors.push(`Задача #${i + 1} ссылается на отсутствующий этап`);
            }
            (Array.isArray(t.workerIds) ? t.workerIds : []).forEach(w => { if (!workerIds.has(String(w))) errors.push(`Задача #${i + 1} ссылается на отсутствующего работника`); });
            if (t.startDate && t.dueDate && !Utils.validateDateRange(t.startDate, t.dueDate)) errors.push(`Задача #${i + 1}: дата начала позже дедлайна`);
            // Business alert (NOT an error): overdue task.
            if (t.dueDate && (t.status === 'TODO' || t.status === 'IN_PROGRESS') && Utils.validateDate(t.dueDate) && t.dueDate < Utils.todayStr()) {
                alerts.push(`Задача «${t.title}» просрочена (${t.dueDate})`);
            }
        });

        // Business alerts: budget exceeded, unpaid payroll.
        // Use d (the data being validated), not Store.data — critical for import validation.
        const dSettings = (d && d.settings) || CONFIG.DEFAULT_SETTINGS;
        const dCur = dSettings.currency || CONFIG.DEFAULT_CURRENCY;
        (Array.isArray(d.projects) ? d.projects : []).forEach(p => {
            if (!p || !p.id) return;
            const budget = Utils.cents(p.budget);
            let spent = 0;
            for (const e of (d.expenses || [])) if (Utils.eq(e.projectId, p.id)) spent += Utils.cents(e.amount);
            if (budget > 0 && spent > budget) alerts.push(`Бюджет проекта «${p.name}» превышен`);
        });
        (Array.isArray(d.workers) ? d.workers : []).forEach(w => {
            if (!w || !w.id) return;
            let earned = 0, paid = 0;
            for (const t of (d.timeEntries || [])) {
                if (!Utils.eq(t.workerId, w.id)) continue;
                const rate = t.rateSnapshot != null ? Number(t.rateSnapshot) : Number(w.rate);
                const mult = CONFIG.RATE_MULTIPLIERS[t.type] || 1;
                earned += Utils.cents((Number(t.hours) || 0) * rate * mult);
            }
            for (const e of (d.expenses || [])) {
                if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) continue;
                if (!(e.workers || []).includes(String(w.id))) continue;
                paid += Calc.expenseWorkerShareCents(e, w.id);
            }
            const debt = earned - paid;
            if (debt > 0) alerts.push(`Невыплаченная зарплата: ${w.name} (${Utils.formatMoneyCents(debt, dCur)})`);
        });

        return { errors, warnings, alerts };
    },

    // Data Health: counts + audit summary
    healthReport(data) {
        const d = data || Store.data;
        const counts = {
            projects: (d.projects || []).length,
            workers: (d.workers || []).length,
            expenses: (d.expenses || []).length,
            timeEntries: (d.timeEntries || []).length,
            tasks: (d.tasks || []).length,
            stages: (d.stages || []).length,
            templates: (d.templates || []).length,
            activityLog: (d.activityLog || []).length
        };
        const split = this.auditSplit(d);
        return { counts, ...split };
    }
};

// ---------------- 7. STORE ----------------
const Store = {
    data: Validation.normalizeData({}),
    _needsResave: false,

    settings() { return this.data.settings; },

    async load() {
        // 1. Fast-start: load from localStorage cache first (instant UI)
        const raw = Storage.read();
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                let version = Number(parsed.schemaVersion) || 0;
                if (version > CONFIG.SCHEMA_VERSION) throw new Error('newer schema version: ' + version);
                const steps = Migrations.getSteps();
                let migrated = false;
                for (let i = version; i <= CONFIG.SCHEMA_VERSION && i < steps.length; i++) {
                    Object.assign(parsed, steps[i](parsed));
                    migrated = true;
                }
                parsed.schemaVersion = CONFIG.SCHEMA_VERSION;
                this.data = Validation.normalizeData(parsed);
                if (migrated) this.save(true);
            } catch (e) {
                AppLogger.error('Ошибка локальных данных', e);
                this.data = Validation.normalizeData({});
            }
        } else {
            this.data = Validation.normalizeData({});
        }

        // 2. Cloud sync: load authoritative data from Supabase
        try {
            const cloudData = await loadFromSupabase();
            if (cloudData) {
                this.data = Validation.normalizeData({
                    ...cloudData,
                    settings: cloudData.settings || CONFIG.DEFAULT_SETTINGS
                });
                Storage.write(Storage._serialize(this.data), true);
            }
        } catch (e) {
            AppLogger.error('Не удалось загрузить данные из облака, используются локальные данные', e);
            UI.toast('Не удалось загрузить данные из облака. Показаны локальные данные.', 'warning');
        }
    },

    save(immediate) {
        this._rev = (this._rev || 0) + 1;
        if (this._needsResave || immediate) {
            Storage.write(Storage._serialize(this.data), immediate);
            this._needsResave = false;
        } else {
            Storage.write(Storage._serialize(this.data), false);
        }
    },

    replaceData(data) {
        this.data = Validation.normalizeData(data);
        this._needsResave = true;
        this.save(true);
    },

    getProject(id) { return this.data.projects.find(p => Utils.eq(p.id, id)) || null; },
    getWorker(id) { return this.data.workers.find(w => Utils.eq(w.id, id)) || null; },
    activeProjects() { return this.data.projects.filter(p => p.active); },
    activeWorkers() { return this.data.workers.filter(w => w.active); },

    // --- Projects ---
    addProject(p) {
        const now = new Date().toISOString();
        const o = { active: true, createdAt: now, updatedAt: now, ...p, id: Utils.genId() };
        this.data.projects.push(o);
        this.log('project', 'create', `Проект «${o.name}»`);
        this.save();
        return o;
    },
    updateProject(id, u) {
        const p = this.getProject(id);
        if (!p) return;
        Object.assign(p, u, { updatedAt: new Date().toISOString() });
        this.log('project', 'update', `Проект «${p.name}»`);
        this.save();
    },
    archiveProject(id) {
        const p = this.getProject(id);
        if (!p) return;
        p.active = false;
        p.updatedAt = new Date().toISOString();
        this.log('project', 'archive', `Проект «${p.name}»`);
        this.save();
    },
    restoreProject(id) {
        const p = this.getProject(id);
        if (!p) return;
        p.active = true;
        p.updatedAt = new Date().toISOString();
        this.log('project', 'restore', `Проект «${p.name}»`);
        this.save();
    },

    // --- Workers ---
    addWorker(w) {
        const now = new Date().toISOString();
        const o = { active: true, createdAt: now, updatedAt: now, ...w, id: Utils.genId() };
        this.data.workers.push(o);
        this.log('worker', 'create', `Работник «${o.name}»`);
        this.save();
        return o;
    },
    updateWorker(id, u) {
        const w = this.getWorker(id);
        if (!w) return;
        Object.assign(w, u, { updatedAt: new Date().toISOString() });
        this.log('worker', 'update', `Работник «${w.name}»`);
        this.save();
    },
    archiveWorker(id) {
        const w = this.getWorker(id);
        if (!w) return;
        w.active = false;
        w.updatedAt = new Date().toISOString();
        this.log('worker', 'archive', `Работник «${w.name}»`);
        this.save();
    },
    restoreWorker(id) {
        const w = this.getWorker(id);
        if (!w) return;
        w.active = true;
        w.updatedAt = new Date().toISOString();
        this.log('worker', 'restore', `Работник «${w.name}»`);
        this.save();
    },

    // --- Expenses ---
    addExpense(e) {
        const now = new Date().toISOString();
        const o = { createdAt: now, updatedAt: now, ...e, id: Utils.genId() };
        this.data.expenses.push(o);
        this.log('expense', 'create', `Расход ${Utils.formatMoney(o.amount)} (${CONFIG.CATEGORIES[o.category] || o.category})`);
        this.save();
        return o;
    },
    updateExpense(id, u) {
        const e = this.data.expenses.find(x => Utils.eq(x.id, id));
        if (!e) return;
        Object.assign(e, u, { updatedAt: new Date().toISOString() });
        this.log('expense', 'update', `Расход ${Utils.formatMoney(e.amount)}`);
        this.save();
    },
    deleteExpense(id) {
        const e = this.data.expenses.find(x => Utils.eq(x.id, id));
        this.data.expenses = this.data.expenses.filter(x => !Utils.eq(x.id, id));
        if (e) this.log('expense', 'delete', `Расход ${Utils.formatMoney(e.amount)}`);
        this.save();
    },
    duplicateExpense(id) {
        const e = this.data.expenses.find(x => Utils.eq(x.id, id));
        if (!e) return;
        const now = new Date().toISOString();
        const copy = { ...e, id: Utils.genId(), createdAt: now, updatedAt: now };
        this.data.expenses.push(copy);
        this.log('expense', 'duplicate', `Расход ${Utils.formatMoney(e.amount)}`);
        this.save();
        return copy;
    },

    // --- Time entries ---
    // rateSnapshot is captured at creation time from worker.rate.
    // After this, changing worker.rate never affects historical records.
    addTimeEntry(t) {
        const now = new Date().toISOString();
        const w = this.getWorker(t.workerId);
        const rateSnapshot = w ? w.rate : 0;
        const o = { createdAt: now, updatedAt: now, ...t, rateSnapshot, id: Utils.genId() };
        this.data.timeEntries.push(o);
        this.log('time', 'create', `${o.hours}ч — ${w ? w.name : '?'} (${Utils.formatDate(o.date)})`);
        this.save();
        return o;
    },
    updateTimeEntry(id, u) {
        const t = this.data.timeEntries.find(x => Utils.eq(x.id, id));
        if (!t) return;
        // If worker changed, capture new worker's current rate as snapshot.
        if (u.workerId && u.workerId !== t.workerId) {
            const w = this.getWorker(u.workerId);
            u.rateSnapshot = w ? w.rate : 0;
        }
        Object.assign(t, u, { updatedAt: new Date().toISOString() });
        this.log('time', 'update', `${t.hours}ч (${Utils.formatDate(t.date)})`);
        this.save();
    },
    deleteTimeEntry(id) {
        this.data.timeEntries = this.data.timeEntries.filter(x => !Utils.eq(x.id, id));
        this.log('time', 'delete', 'Запись времени удалена');
        this.save();
    },

    // --- Templates ---
    addTemplate(t) {
        const now = new Date().toISOString();
        const o = { createdAt: now, updatedAt: now, ...t, id: Utils.genId() };
        this.data.templates.push(o);
        this.log('template', 'create', `Шаблон «${o.name}»`);
        this.save();
        return o;
    },
    updateTemplate(id, u) {
        const t = this.data.templates.find(x => Utils.eq(x.id, id));
        if (!t) return;
        Object.assign(t, u, { updatedAt: new Date().toISOString() });
        this.log('template', 'update', `Шаблон «${t.name}»`);
        this.save();
    },
    deleteTemplate(id) {
        const t = this.data.templates.find(x => Utils.eq(x.id, id));
        this.data.templates = this.data.templates.filter(x => !Utils.eq(x.id, id));
        if (t) this.log('template', 'delete', `Шаблон «${t.name}»`);
        this.save();
    },

    // --- Activity log ---
    // Does NOT call save() — the caller already saves. This prevents double-save.
    log(entity, action, label) {
        if (!CONFIG.features.activityLog) return;
        this.data.activityLog.push({ id: Utils.genId(), ts: Date.now(), entity, action, label: String(label ?? '') });
        if (this.data.activityLog.length > CONFIG.ACTIVITY_LOG_LIMIT) this.data.activityLog = this.data.activityLog.slice(-CONFIG.ACTIVITY_LOG_LIMIT);
    },

    // --- Stages ---
    addStage(o) {
        const now = new Date().toISOString();
        const order = this.data.stages.filter(s => Utils.eq(s.projectId, o.projectId)).length;
        const s = { ...o, status: CONFIG.STAGE_STATUSES.includes(o.status) ? o.status : 'planning', order, createdAt: now, updatedAt: now, id: Utils.genId() };
        this.data.stages.push(s);
        this.log('stage', 'create', `Этап «${s.name}»`);
        this.save();
        return s;
    },
    updateStage(id, u) {
        const s = this.data.stages.find(x => Utils.eq(x.id, id));
        if (!s) return null;
        Object.assign(s, u, { updatedAt: new Date().toISOString() });
        this.log('stage', 'update', `Этап «${s.name}»`);
        this.save();
        return s;
    },
    moveStage(id, dir) {
        const s = this.data.stages.find(x => Utils.eq(x.id, id));
        if (!s) return;
        const list = this.data.stages.filter(x => Utils.eq(x.projectId, s.projectId)).sort((a, b) => a.order - b.order);
        const idx = list.findIndex(x => Utils.eq(x.id, id));
        const swap = idx + dir;
        if (swap < 0 || swap >= list.length) return;
        [list[idx], list[swap]] = [list[swap], list[idx]];
        list.forEach((x, i) => x.order = i);
        this.save();
    },
    setStageStatus(id, status) {
        const s = this.data.stages.find(x => Utils.eq(x.id, id));
        if (!s || !CONFIG.STAGE_STATUSES.includes(status)) return;
        s.status = status;
        s.updatedAt = new Date().toISOString();
        this.log('stage', 'status', `Этап «${s.name}» → ${status}`);
        this.save();
    },
    archiveStage(id) {
        const s = this.data.stages.find(x => Utils.eq(x.id, id));
        if (!s) return;
        s.status = 'archived';
        s.updatedAt = new Date().toISOString();
        this.log('stage', 'archive', `Этап «${s.name}»`);
        this.save();
    },
    stagesOfProject(pid) {
        return this.data.stages.filter(s => Utils.eq(s.projectId, pid)).sort((a, b) => a.order - b.order);
    },

    // --- Tasks ---
    addTask(o) {
        const now = new Date().toISOString();
        const status = CONFIG.TASK_STATUSES.includes(o.status) ? o.status : 'TODO';
        const t = { ...o, status, priority: CONFIG.TASK_PRIORITIES.includes(o.priority) ? o.priority : 'NORMAL', completedAt: status === 'DONE' ? now : null, createdAt: now, updatedAt: now, id: Utils.genId() };
        this.data.tasks.push(t);
        this.log('task', 'create', `Задача «${t.title}»`);
        this.save();
        return t;
    },
    updateTask(id, u) {
        const t = this.data.tasks.find(x => Utils.eq(x.id, id));
        if (!t) return null;
        if (u.status && CONFIG.TASK_STATUSES.includes(u.status)) {
            u.completedAt = u.status === 'DONE' ? new Date().toISOString() : null;
        }
        Object.assign(t, u, { updatedAt: new Date().toISOString() });
        this.log('task', 'update', `Задача «${t.title}»`);
        this.save();
        return t;
    },
    setTaskStatus(id, status) {
        const t = this.data.tasks.find(x => Utils.eq(x.id, id));
        if (!t || !CONFIG.TASK_STATUSES.includes(status)) return;
        t.status = status;
        t.completedAt = status === 'DONE' ? new Date().toISOString() : null;
        t.updatedAt = new Date().toISOString();
        this.log('task', 'status', `Задача «${t.title}» → ${status}`);
        this.save();
    },
    deleteTask(id) {
        const t = this.data.tasks.find(x => Utils.eq(x.id, id));
        this.data.tasks = this.data.tasks.filter(x => !Utils.eq(x.id, id));
        if (t) this.log('task', 'delete', `Задача «${t.title}»`);
        this.save();
    },
    tasksOfProject(pid) {
        return this.data.tasks.filter(t => Utils.eq(t.projectId, pid));
    }
};

// ---------------- 8. CALCULATIONS ----------------
const Calc = {
    // Historical rate: rateSnapshot has priority. Fallback to worker.rate only for
    // legacy entries that haven't been migrated yet (rateSnapshot == null).
    timeCostCents(entry) {
        const w = Store.getWorker(entry.workerId);
        const rate = entry.rateSnapshot != null ? Number(entry.rateSnapshot) : (w ? w.rate : 0);
        const mult = CONFIG.RATE_MULTIPLIERS[entry.type] || 1;
        return Utils.cents(entry.hours * rate * mult);
    },

    workerHours(wid) {
        let s = 0;
        for (const t of Store.data.timeEntries) if (Utils.eq(t.workerId, wid)) s += Number(t.hours) || 0;
        return s;
    },

    expenseWorkerShareCents(e, wid) {
        if (e.splits && e.splits[wid] != null) return Utils.cents(e.splits[wid]);
        const w = Array.isArray(e.workers) ? e.workers.map(String) : [];
        if (w.length === 0) return 0;
        const total = Utils.cents(e.amount);
        if (w.length === 1) return total;
        const parts = Utils.evenSplitCents(total, w.length);
        const idx = w.indexOf(String(wid));
        return idx === -1 ? 0 : parts[idx];
    },

    workerEarnedCents(wid) {
        let s = 0;
        for (const t of Store.data.timeEntries) if (Utils.eq(t.workerId, wid)) s += this.timeCostCents(t);
        return s;
    },

    workerPaidCents(wid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) continue;
            if (!(e.workers || []).includes(String(wid))) continue;
            s += this.expenseWorkerShareCents(e, wid);
        }
        return s;
    },

    workerDebtCents(wid) { return this.workerEarnedCents(wid) - this.workerPaidCents(wid); },

    // Budget Consumption = cash outflow (direct expenses + payroll payments).
    // This is the amount that left the bank account for this project.
    projectSpentCents(pid) {
        let s = 0;
        for (const e of Store.data.expenses) if (Utils.eq(e.projectId, pid)) s += Utils.cents(e.amount);
        return s;
    },

    // Labor Cost = sum(hours × rateSnapshot × multiplier) — accrued, not paid.
    projectLaborCostCents(pid) {
        let s = 0;
        for (const t of Store.data.timeEntries) if (Utils.eq(t.projectId, pid)) s += this.timeCostCents(t);
        return s;
    },

    // Direct Cost = expenses excluding salary/advance (materials, transport, etc.).
    projectDirectExpenseCents(pid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (Utils.eq(e.projectId, pid) && !CONFIG.PAYMENT_CATEGORIES.includes(e.category)) s += Utils.cents(e.amount);
        }
        return s;
    },

    // Payroll Paid = actual salary/advance payments for this project.
    projectPayrollPaidCents(pid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (Utils.eq(e.projectId, pid) && CONFIG.PAYMENT_CATEGORIES.includes(e.category)) s += Utils.cents(e.amount);
        }
        return s;
    },

    // Cash Outflow = direct expenses + payroll payments (actual money out).
    projectCashOutflowCents(pid) {
        return this.projectDirectExpenseCents(pid) + this.projectPayrollPaidCents(pid);
    },

    // Project Cost = direct cost + labor cost (accrued cost of work done).
    // Does NOT include payroll payments — those are settlements, not project cost.
    projectTotalCostCents(pid) {
        return this.projectDirectExpenseCents(pid) + this.projectLaborCostCents(pid);
    },

    projectCategoryCents(pid) {
        const out = {};
        for (const e of Store.data.expenses) {
            if (!Utils.eq(e.projectId, pid)) continue;
            const c = CONFIG.CATEGORIES[e.category] ? e.category : 'other';
            out[c] = (out[c] || 0) + Utils.cents(e.amount);
        }
        return out;
    },

    projectWorkers(pid) {
        const ids = new Set();
        for (const e of Store.data.expenses) if (Utils.eq(e.projectId, pid)) (e.workers || []).forEach(w => ids.add(String(w)));
        for (const t of Store.data.timeEntries) if (Utils.eq(t.projectId, pid)) ids.add(String(t.workerId));
        for (const task of Store.data.tasks) if (Utils.eq(task.projectId, pid)) (task.workerIds || []).forEach(w => ids.add(String(w)));
        return [...ids];
    },

    projectWorkersDetailed(pid) {
        const hours = {};
        const earned = {};
        for (const t of Store.data.timeEntries) {
            if (!Utils.eq(t.projectId, pid)) continue;
            hours[t.workerId] = (hours[t.workerId] || 0) + (Number(t.hours) || 0);
            earned[t.workerId] = (earned[t.workerId] || 0) + this.timeCostCents(t);
        }
        const taskCount = {};
        for (const task of Store.data.tasks) {
            if (!Utils.eq(task.projectId, pid)) continue;
            if (task.status === 'DONE' || task.status === 'CANCELLED') continue;
            (task.workerIds || []).forEach(w => taskCount[w] = (taskCount[w] || 0) + 1);
        }
        return this.projectWorkers(pid).map(wid => {
            const w = Store.getWorker(wid);
            return { id: wid, name: w ? w.name : '?', active: w ? w.active : false, hours: hours[wid] || 0, earnedCents: earned[wid] || 0, openTasks: taskCount[wid] || 0 };
        }).filter(x => x.name !== '?' || x.hours || x.openTasks);
    },

    projectHours(pid) {
        let s = 0;
        for (const t of Store.data.timeEntries) if (Utils.eq(t.projectId, pid)) s += Number(t.hours) || 0;
        return s;
    },

    projectStats(pid) {
        const p = Store.getProject(pid);
        const spent = this.projectSpentCents(pid);
        const budget = Utils.cents(p ? p.budget : 0);
        const pct = budget > 0 ? (spent / budget) * 100 : 0;
        return {
            budget,
            spent,
            remaining: budget - spent,
            pct,
            over: budget > 0 && spent > budget,
            warn: budget > 0 && !(spent > budget) && pct >= Store.settings().budgetWarningPercent
        };
    },

    taskOverdue(t) {
        if (!t || !t.dueDate) return false;
        if (t.status === 'DONE' || t.status === 'CANCELLED') return false;
        return Utils.validateDate(t.dueDate) && t.dueDate < Utils.todayStr();
    },
    overdueTasksCount() { return Store.data.tasks.filter(t => this.taskOverdue(t)).length; },
    openTasksCount() { return Store.data.tasks.filter(t => t.status !== 'DONE' && t.status !== 'CANCELLED').length; },

    // V5: period-scoped calculations (all reuse existing Calc primitives)
    // All period functions use the SAME date range and are mutually exclusive:
    //   periodDirectCents  = direct expenses (no salary/advance)
    //   periodLaborCents   = accrued labor cost (hours × rate × mult)
    //   periodPaidCents    = actual salary/advance payments
    //   periodCashOutflow  = direct + paid (actual money out)
    //   periodProjectCost  = direct + labor (accrued cost, NO double-counting)
    periodDirectCents(from, to, pid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (CONFIG.PAYMENT_CATEGORIES.includes(e.category)) continue;
            if (pid && !Utils.eq(e.projectId, pid)) continue;
            if (from && e.date < from) continue;
            if (to && e.date > to) continue;
            s += Utils.cents(e.amount);
        }
        return s;
    },
    periodExpensesCents(from, to, pid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (pid && !Utils.eq(e.projectId, pid)) continue;
            if (from && e.date < from) continue;
            if (to && e.date > to) continue;
            s += Utils.cents(e.amount);
        }
        return s;
    },
    periodLaborCents(from, to, pid) {
        let s = 0;
        for (const t of Store.data.timeEntries) {
            if (pid && !Utils.eq(t.projectId, pid)) continue;
            if (from && t.date < from) continue;
            if (to && t.date > to) continue;
            s += this.timeCostCents(t);
        }
        return s;
    },
    periodPaidCents(from, to, pid) {
        let s = 0;
        for (const e of Store.data.expenses) {
            if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) continue;
            if (pid && !Utils.eq(e.projectId, pid)) continue;
            if (from && e.date < from) continue;
            if (to && e.date > to) continue;
            s += Utils.cents(e.amount);
        }
        return s;
    },
    // Cash outflow = direct + paid (actual money leaving the account).
    periodCashOutflowCents(from, to, pid) {
        return this.periodDirectCents(from, to, pid) + this.periodPaidCents(from, to, pid);
    },
    // Project cost = direct + labor (accrued, no payroll double-counting).
    periodProjectCostCents(from, to, pid) {
        return this.periodDirectCents(from, to, pid) + this.periodLaborCents(from, to, pid);
    },
    periodHours(from, to, pid) {
        let s = 0;
        for (const t of Store.data.timeEntries) {
            if (pid && !Utils.eq(t.projectId, pid)) continue;
            if (from && t.date < from) continue;
            if (to && t.date > to) continue;
            s += Number(t.hours) || 0;
        }
        return s;
    },

    // V5: worker stats for payroll, scoped to period
    workerStatsForPeriod(wid, from, to) {
        let hours = 0, earnedCents = 0;
        for (const t of Store.data.timeEntries) {
            if (!Utils.eq(t.workerId, wid)) continue;
            if (from && t.date < from) continue;
            if (to && t.date > to) continue;
            hours += Number(t.hours) || 0;
            earnedCents += this.timeCostCents(t);
        }
        let paidCents = 0;
        for (const e of Store.data.expenses) {
            if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) continue;
            if (!(e.workers || []).includes(String(wid))) continue;
            if (from && e.date < from) continue;
            if (to && e.date > to) continue;
            paidCents += this.expenseWorkerShareCents(e, wid);
        }
        const totalEarned = this.workerEarnedCents(wid);
        const totalPaid = this.workerPaidCents(wid);
        const avgRate = hours > 0 ? earnedCents / hours / 100 : 0;
        return {
            hours,
            earnedCents,
            paidCents,
            debtCents: totalEarned - totalPaid,
            avgRate
        };
    },

    // V5: notifications (local, computed from real data)
    notifications() {
        const list = [];
        // Overdue tasks
        for (const t of Store.data.tasks) {
            if (this.taskOverdue(t)) {
                list.push({ type: 'overdue_task', icon: '⚠️', text: `Просрочена задача: «${t.title}»`, severity: 'danger' });
            }
        }
        // Budget over
        if (Store.settings().notifyBudget) {
            for (const p of Store.data.projects) {
                if (!p.active) continue;
                const st = this.projectStats(p.id);
                if (st.over) list.push({ type: 'budget_over', icon: '💰', text: `Бюджет превышен: «${p.name}»`, severity: 'danger' });
                else if (st.warn) list.push({ type: 'budget_warn', icon: '📊', text: `Бюджет на исходе: «${p.name}» (${st.pct.toFixed(0)}%)`, severity: 'warning' });
            }
        }
        // Debt
        if (Store.settings().notifyDebt) {
            for (const w of Store.data.workers) {
                if (!w.active) continue;
                const debt = this.workerDebtCents(w.id);
                if (debt > 0) list.push({ type: 'debt', icon: '💵', text: `Задолженность: ${w.name} — ${Utils.formatMoneyCents(debt)}`, severity: 'info' });
            }
        }
        // Upcoming deadlines (next 3 days)
        const soon = new Date(); soon.setDate(soon.getDate() + 3);
        const soonStr = soon.getFullYear() + '-' + String(soon.getMonth() + 1).padStart(2, '0') + '-' + String(soon.getDate()).padStart(2, '0');
        for (const t of Store.data.tasks) {
            if (t.status === 'DONE' || t.status === 'CANCELLED') continue;
            if (t.dueDate && Utils.validateDate(t.dueDate) && t.dueDate >= Utils.todayStr() && t.dueDate <= soonStr) {
                list.push({ type: 'deadline', icon: '📅', text: `Дедлайн скоро: «${t.title}» — ${Utils.formatDate(t.dueDate)}`, severity: 'warning' });
            }
        }
        return list;
    }
};

// ---------------- 9. SERVICES (reports) ----------------
const Reports = {
    collect(pid, from, to) {
        return Store.data.expenses.filter(e => {
            if (pid !== 'all' && !Utils.eq(e.projectId, pid)) return false;
            if (from && e.date < from) return false;
            if (to && e.date > to) return false;
            if (!Utils.validateDate(e.date)) return false;
            return true;
        });
    },

    group(entries, group) {
        const out = {};
        entries.forEach(e => {
            if (group === 'worker') {
                const wlist = Array.isArray(e.workers) ? e.workers : [];
                if (wlist.length === 0) {
                    out['Общие'] = (out['Общие'] || 0) + Utils.cents(e.amount);
                    return;
                }
                wlist.forEach(wid => {
                    const w = Store.getWorker(wid);
                    const key = w ? w.name : 'Бывший работник';
                    out[key] = (out[key] || 0) + Calc.expenseWorkerShareCents(e, wid);
                });
                return;
            }
            let key;
            if (group === 'category') key = CONFIG.CATEGORIES[e.category] || e.category;
            else if (group === 'project') { const p = Store.getProject(e.projectId); key = p ? p.name : 'Без проекта'; }
            else if (group === 'date') key = e.date;
            else key = 'Всего';
            out[key] = (out[key] || 0) + Utils.cents(e.amount);
        });
        return out;
    }
};

// ---------------- 10. UI ----------------
const UI = {
    _lastFocus: null,
    _toastLimit: 4,

    tab(id) {
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === id));
        document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === id)));
        if (id === 'expenses') updateExpenseForm();
        if (id === 'timetracking') updateTimeForm();
        if (id === 'templates') updateTemplateForm();
        if (id === 'reports') updateReportFilters();
        if (id === 'tasks') updateTaskFilters();
        if (id === 'finance') updateFinanceFilters();
        if (id === 'analytics') updateAnalyticsFilters();
        if (Render[id]) Render[id]();
    },

    toast(msg, type = 'success') {
        const container = document.getElementById('toast-container');
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = icons[type] || 'ℹ️';
        const text = document.createElement('span');
        text.textContent = msg;
        t.appendChild(icon);
        t.appendChild(text);
        container.appendChild(t);
        while (container.children.length > this._toastLimit) container.firstChild.remove();
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, 3200);
    },

    saveStatus(state) {
        const el = document.getElementById('saveStatus');
        if (!el) return;
        if (state === 'error') {
            el.textContent = '⚠ Не удалось сохранить';
            el.className = 'save-status error';
            setTimeout(() => { if (el.className.includes('error')) { el.textContent = '✓ Сохранено'; el.className = 'save-status'; } }, 5000);
        } else if (state === 'saving') {
            el.textContent = '● Сохранение...';
            el.className = 'save-status saving';
        } else {
            el.textContent = '✓ Сохранено';
            el.className = 'save-status';
        }
    },

    openModal(title, bodyHtml, actionsHtml) {
        const ov = document.getElementById('modalOverlay');
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').innerHTML = bodyHtml;
        document.getElementById('modalActions').innerHTML = actionsHtml;
        this._lastFocus = document.activeElement;
        ov.classList.add('active');
        const first = document.getElementById('modalBody').querySelector('input, select, textarea, button');
        if (first) first.focus();
    },

    closeModal() {
        document.getElementById('modalOverlay').classList.remove('active');
        if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
    },

    confirm(title, message, onConfirm, danger = true) {
        const body = `<p style="margin:0; font-size:15px; line-height:1.6;">${Utils.escapeHtml(message)}</p>`;
        const actions = `<button class="secondary" data-modal-close>Отмена</button><button class="${danger ? 'danger' : 'primary'}" data-confirm-yes>${danger ? 'Удалить' : 'OK'}</button>`;
        this.openModal(title, body, actions);
        const ov = document.getElementById('modalOverlay');
        ov.querySelector('[data-confirm-yes]').onclick = () => { this.closeModal(); onConfirm && onConfirm(); };
        ov.querySelector('[data-modal-close]').onclick = () => this.closeModal();
    },

    emptyState(icon, title, hint) {
        return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${Utils.escapeHtml(title)}</p><small>${Utils.escapeHtml(hint)}</small></div>`;
    },

    btn(label, cls, data) {
        return `<button class="${cls || ''}" ${data || ''}>${label}</button>`;
    }
};

// ---------------- 11. RENDER ----------------
const Render = {
    dashboard() {
        const exp = Store.data.expenses;
        const totalSpent = exp.reduce((s, e) => s + Utils.cents(e.amount), 0);
        const activeProj = Store.data.projects.filter(p => p.active).length;
        const totalWorkers = Store.data.workers.length;
        const cur = Store.settings().currency;

        let totalDebtCents = 0;
        let totalHours = 0;
        Store.data.workers.forEach(w => {
            totalDebtCents += Calc.workerDebtCents(w.id);
            totalHours += Calc.workerHours(w.id);
        });

        const totalLabor = Store.data.projects.reduce((s, p) => s + Calc.projectLaborCostCents(p.id), 0);
        const totalDirect = Store.data.projects.reduce((s, p) => s + Calc.projectDirectExpenseCents(p.id), 0);
        const totalCost = totalLabor + totalDirect;
        const totalPaid = Store.data.workers.reduce((s, w) => s + Calc.workerPaidCents(w.id), 0);
        const totalBudget = Store.data.projects.reduce((s, p) => s + Utils.cents(p.budget), 0);
        const budgetUsed = totalBudget > 0 ? totalSpent : 0;
        const budgetRemaining = totalBudget - budgetUsed;

        const debtLabel = totalDebtCents < 0
            ? 'Переплата: ' + Utils.formatMoneyCents(Math.abs(totalDebtCents), cur)
            : Utils.formatMoneyCents(totalDebtCents, cur);
        const debtClass = totalDebtCents > 0 ? 'danger' : (totalDebtCents < 0 ? 'success' : 'flat');
        document.getElementById('dashboardStats').innerHTML =
            `<div class="stat-card"><h4>Всего расходов</h4><div class="value">${Utils.formatMoneyCents(totalSpent, cur)}</div></div>` +
            `<div class="stat-card secondary"><h4>Активных проектов</h4><div class="value">${activeProj}</div></div>` +
            `<div class="stat-card success"><h4>Работников</h4><div class="value">${totalWorkers}</div></div>` +
            `<div class="stat-card ${debtClass}"><h4>Долг по зарплате</h4><div class="value">${Utils.escapeHtml(debtLabel)}</div></div>` +
            `<div class="stat-card flat"><h4>Часов отработано</h4><div class="value">${totalHours.toLocaleString('ru-RU')}</div></div>` +
            `<div class="stat-card flat"><h4>Стоимость труда</h4><div class="value">${Utils.formatMoneyCents(totalLabor, cur)}</div></div>` +
            `<div class="stat-card flat"><h4>Общая стоимость</h4><div class="value">${Utils.formatMoneyCents(totalCost, cur)}</div></div>` +
            `<div class="stat-card flat"><h4>Выплачено</h4><div class="value">${Utils.formatMoneyCents(totalPaid, cur)}</div></div>` +
            `<div class="stat-card flat"><h4>Бюджет (план)</h4><div class="value">${Utils.formatMoneyCents(totalBudget, cur)}</div></div>` +
            `<div class="stat-card flat"><h4>Остаток бюджета</h4><div class="value">${Utils.formatMoneyCents(budgetRemaining, cur)}</div></div>`;

        // Smart Summary
        if (CONFIG.features.smartSummary) this._smartSummary();
        else document.getElementById('smartSummary').innerHTML = '';

        // Alerts / Notifications
        if (CONFIG.features.notifications) this._dashboardAlerts();

        // Category chart
        const cats = {};
        exp.forEach(e => { const c = e.category; cats[c] = (cats[c] || 0) + Utils.cents(e.amount); });
        const maxCat = Math.max(...Object.values(cats), 1);
        document.getElementById('categoryChart').innerHTML =
            Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
                `<div class="chart-bar"><div class="chart-label">${Utils.escapeHtml(CONFIG.CATEGORIES[k] || k)}</div><div class="chart-bar-wrapper"><div class="chart-bar-fill" style="width:${(v / maxCat) * 100}%">${Utils.formatMoneyCents(v, cur)}</div></div></div>`
            ).join('') || '<p style="color:var(--secondary)">Нет данных</p>';

        // Project chart
        const projs = {};
        exp.forEach(e => { const p = Store.getProject(e.projectId); if (p) { projs[p.name] = (projs[p.name] || 0) + Utils.cents(e.amount); } });
        const maxProj = Math.max(...Object.values(projs), 1);
        document.getElementById('projectChart').innerHTML =
            Object.entries(projs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) =>
                `<div class="chart-bar"><div class="chart-label">${Utils.escapeHtml(k)}</div><div class="chart-bar-wrapper"><div class="chart-bar-fill" style="width:${(v / maxProj) * 100}%; background: linear-gradient(90deg, #22c55e, #16a34a);">${Utils.formatMoneyCents(v, cur)}</div></div></div>`
            ).join('') || '<p style="color:var(--secondary)">Нет данных</p>';

        // Daily chart last 7 days
        const byDate = this._expenseDateIndex();
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const sum = (byDate.get(key) || []).reduce((s, e) => s + Utils.cents(e.amount), 0);
            days.push({ key, sum });
        }
        const maxDay = Math.max(...days.map(d => d.sum), 1);
        document.getElementById('dailyChart').innerHTML = days.map(d =>
            `<div class="chart-bar"><div class="chart-label">${Utils.escapeHtml(Utils.formatDate(d.key))}</div><div class="chart-bar-wrapper"><div class="chart-bar-fill" style="width:${(d.sum / maxDay) * 100}%; background: linear-gradient(90deg, #06b6d4, #0891b2);">${Utils.formatMoneyCents(d.sum, cur)}</div></div></div>`
        ).join('');
    },

    _smartSummary() {
        const cur = Store.settings().currency;
        const month = Utils.periodRange('month');
        const prevMonthDate = new Date(); prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
        const prevFrom = prevMonthDate.getFullYear() + '-' + String(prevMonthDate.getMonth() + 1).padStart(2, '0') + '-01';
        const prevTo = prevMonthDate.getFullYear() + '-' + String(prevMonthDate.getMonth() + 1).padStart(2, '0') + '-' + String(new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1, 0).getDate()).padStart(2, '0');

        const expThis = Calc.periodExpensesCents(month.from, month.to);
        const expPrev = Calc.periodExpensesCents(prevFrom, prevTo);
        const expTrend = expThis - expPrev;
        const hoursThis = Calc.periodHours(month.from, month.to);
        const paidThis = Calc.periodPaidCents(month.from, month.to);
        const laborThis = Calc.periodLaborCents(month.from, month.to);
        const totalBudget = Store.data.projects.reduce((s, p) => s + Utils.cents(p.budget), 0);
        const totalSpent = Store.data.projects.reduce((s, p) => s + Calc.projectSpentCents(p.id), 0);
        const budgetRemaining = totalBudget - totalSpent;

        const trendIcon = expTrend > 0 ? '📈' : expTrend < 0 ? '📉' : '➖';
        const trendClass = expTrend > 0 ? 'up' : expTrend < 0 ? 'down' : '';
        const trendText = expTrend === 0 ? 'без изменений' : (expTrend > 0 ? '+' : '') + Utils.formatMoneyCents(Math.abs(expTrend), cur);

        document.getElementById('smartSummary').innerHTML =
            `<div class="ss-card"><div class="ss-icon">${trendIcon}</div><div class="ss-body"><div class="ss-label">Расходы за месяц</div><div class="ss-value">${Utils.formatMoneyCents(expThis, cur)}</div><div class="ss-trend ${trendClass}">${trendText} к пред. месяцу</div></div></div>` +
            `<div class="ss-card"><div class="ss-icon">⏱</div><div class="ss-body"><div class="ss-label">Часов за месяц</div><div class="ss-value">${hoursThis}</div></div></div>` +
            `<div class="ss-card"><div class="ss-icon">🔧</div><div class="ss-body"><div class="ss-label">Стоимость труда</div><div class="ss-value">${Utils.formatMoneyCents(laborThis, cur)}</div></div></div>` +
            `<div class="ss-card"><div class="ss-icon">💵</div><div class="ss-body"><div class="ss-label">Выплачено за месяц</div><div class="ss-value">${Utils.formatMoneyCents(paidThis, cur)}</div></div></div>` +
            `<div class="ss-card"><div class="ss-icon">💰</div><div class="ss-body"><div class="ss-label">Остаток бюджета</div><div class="ss-value">${Utils.formatMoneyCents(budgetRemaining, cur)}</div></div></div>`;
    },

    _dashboardAlerts() {
        const notifs = Calc.notifications();
        const el = document.getElementById('dashboardAlerts');
        if (!el) return;
        if (!notifs.length) { el.innerHTML = ''; return; }
        el.innerHTML = notifs.slice(0, 8).map(n =>
            `<div class="da-item ${n.severity}">${n.icon} ${Utils.escapeHtml(n.text)}</div>`
        ).join('');
    },

    _expenseDateIndex() {
        if (!this._dateIndex || this._dateIndexVersion !== (Store._rev || 0)) {
            const map = new Map();
            Store.data.expenses.forEach(e => {
                const key = e.date;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(e);
            });
            this._dateIndex = map;
            this._dateIndexVersion = Store._rev || 0;
            return map;
        }
        return this._dateIndex;
    },

    projects() {
        const search = (document.getElementById('searchProjects').value || '').toLowerCase();
        const status = document.getElementById('filterProjectStatus').value;
        const view = document.getElementById('filterProjectView').value;
        const cur = Store.settings().currency;

        let list = Store.data.projects.filter(p => {
            if (view === 'active' && !p.active) return false;
            if (view === 'archived' && p.active) return false;
            if (status !== 'all' && p.status !== status) return false;
            if (search && !String(p.name || '').toLowerCase().includes(search)) return false;
            return true;
        });

        document.getElementById('projectsList').innerHTML = list.map(p => {
            const st = Calc.projectStats(p.id);
            const pct = st.budget > 0 ? st.pct : 0;
            const fillClass = st.over ? 'over-budget' : (st.warn ? 'warn' : '');
            const warnHtml = st.over
                ? `<div class="alert danger">⚠️ Бюджет превышен</div>`
                : (st.warn ? `<div class="alert warning">⚠️ Использовано ${pct.toFixed(0)}% бюджета</div>` : '');
            const catsCents = Calc.projectCategoryCents(p.id);
            const wcount = Calc.projectWorkers(p.id).length;
            const hours = Calc.projectHours(p.id);
            const stageCount = Store.stagesOfProject(p.id).filter(s => s.status !== 'archived').length;
            const openTasks = Store.data.tasks.filter(t => Utils.eq(t.projectId, p.id) && t.status !== 'DONE' && t.status !== 'CANCELLED').length;
            const planLine = (p.startDate || p.endDate) ? ` · ${p.startDate ? 'с ' + Utils.formatDate(p.startDate) : ''}${p.endDate ? ' по ' + Utils.formatDate(p.endDate) : ''}` : '';
            const leadHtml = p.lead ? ` · Ответств: ${Utils.escapeHtml(p.lead)}` : '';
            const priBadge = p.priority && p.priority !== 'NORMAL' ? ` <span class="badge pri-${String(p.priority).toLowerCase()}">${p.priority}</span>` : '';
            return `<div class="card ${p.active ? '' : 'archived'}">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                    <h3 style="margin:0;">${Utils.escapeHtml(p.name)}</h3>
                    <span class="badge ${p.active ? p.status : 'archived'}">${p.active ? (p.status === 'active' ? 'Активный' : p.status) : 'Архив'}</span>
                </div>
                ${p.desc ? `<p style="color:var(--secondary); font-size:13px; margin:5px 0;">${Utils.escapeHtml(p.desc)}</p>` : ''}
                <div style="margin-top:10px; font-size:14px;">
                    <div>Бюджет: <b>${Utils.formatMoneyCents(st.budget, cur)}</b></div>
                    <div>Потрачено: <b style="color:${st.over ? 'var(--danger)' : 'var(--text)'}">${Utils.formatMoneyCents(st.spent, cur)}</b></div>
                    <div>Остаток: <b style="color:${st.remaining < 0 ? 'var(--danger)' : 'var(--success)'}">${Utils.formatMoneyCents(st.remaining, cur)}</b></div>
                    <div style="color:var(--secondary); font-size:12px; margin-top:4px;">Использовано: ${pct.toFixed(1)}% · Работников: ${wcount} · Часов: ${hours}<br>Этапов: ${stageCount} · Открытых задач: ${openTasks}${planLine}${leadHtml}</div>
                    ${priBadge}
                </div>
                <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${Math.min(pct, 100)}%"></div></div>
                ${warnHtml}
                <div class="card-actions">
                    <button class="sm secondary" data-edit-project="${Utils.escapeHtml(p.id)}">✏️</button>
                    <button class="sm info" data-detail-project="${Utils.escapeHtml(p.id)}">👁</button>
                    ${p.active
                        ? `<button class="sm warning" data-archive-project="${Utils.escapeHtml(p.id)}">🗄 Архив</button>`
                        : `<button class="sm success" data-restore-project="${Utils.escapeHtml(p.id)}">↩ Восстановить</button>`}
                </div>
            </div>`;
        }).join('') || UI.emptyState('📁', 'Проектов пока нет.', 'Создайте первый проект, чтобы начать работу.');
    },

    workers() {
        const search = (document.getElementById('searchWorkers').value || '').toLowerCase();
        const view = document.getElementById('filterWorkerView').value;
        const cur = Store.settings().currency;
        const list = Store.data.workers.filter(w => {
            if (view === 'active' && !w.active) return false;
            if (view === 'archived' && w.active) return false;
            if (search && !String(w.name || '').toLowerCase().includes(search)) return false;
            return true;
        });

        document.getElementById('workersList').innerHTML = list.length ? `<table><thead><tr><th>ФИО</th><th>Должность</th><th>Ставка</th><th>Часы</th><th>Заработано</th><th>Выплачено</th><th>Долг</th><th>Действия</th></tr></thead><tbody>` +
            list.map(w => {
                const earned = Utils.toRub(Calc.workerEarnedCents(w.id));
                const paid = Utils.toRub(Calc.workerPaidCents(w.id));
                const debt = earned - paid;
                const hours = Calc.workerHours(w.id);
                return `<tr class="${w.active ? '' : 'archived-row'}">
                    <td><b>${Utils.escapeHtml(w.name)}</b><br><small style="color:var(--secondary)">${Utils.escapeHtml(w.phone || '')}${w.active ? '' : ' · в архиве'}</small></td>
                    <td>${Utils.escapeHtml(w.position || '-')}</td>
                    <td>${w.rate ? Utils.formatMoney(w.rate, cur) + '/ч' : '-'}</td>
                    <td>${hours}</td>
                    <td>${Utils.formatMoney(earned, cur)}</td>
                    <td>${Utils.formatMoney(paid, cur)}</td>
                    <td style="color:${debt > 0 ? 'var(--danger)' : debt < 0 ? 'var(--success)' : 'inherit'}; font-weight:bold;">
                        ${debt < 0 ? 'Переплата: ' + Utils.formatMoney(Math.abs(debt), cur) : Utils.formatMoney(debt, cur)}
                    </td>
                    <td>
                        <button class="sm secondary" data-edit-worker="${Utils.escapeHtml(w.id)}">✏️</button>
                        <button class="sm info" data-detail-worker="${Utils.escapeHtml(w.id)}">👁</button>
                        ${w.active
                            ? `<button class="sm warning" data-archive-worker="${Utils.escapeHtml(w.id)}">🗄</button>`
                            : `<button class="sm success" data-restore-worker="${Utils.escapeHtml(w.id)}">↩</button>`}
                    </td>
                </tr>`;
            }).join('') + '</tbody></table>'
            : UI.emptyState('👷', 'Работников пока нет.', 'Добавьте работников и их ставки для расчёта зарплаты.');
    },

    expenses() {
        const search = (document.getElementById('searchExpenses').value || '').toLowerCase();
        const catF = document.getElementById('filterExpenseCategory').value;
        const projF = document.getElementById('filterExpenseProject').value;
        const from = document.getElementById('filterExpenseFrom').value;
        const to = document.getElementById('filterExpenseTo').value;
        const sort = document.getElementById('filterExpenseSort').value;
        const cur = Store.settings().currency;

        let list = Store.data.expenses.filter(e => {
            if (catF !== 'all' && e.category !== catF) return false;
            if (projF !== 'all' && !Utils.eq(e.projectId, projF)) return false;
            if (from && e.date < from) return false;
            if (to && e.date > to) return false;
            if (search) {
                const p = Store.getProject(e.projectId);
                const hay = (e.desc || '') + ' ' + (p ? p.name : '') + ' ' + (CONFIG.CATEGORIES[e.category] || '');
                if (!hay.toLowerCase().includes(search)) return false;
            }
            return true;
        });

        list.sort((a, b) => {
            const dir = sort.endsWith('-asc') ? 1 : -1;
            if (sort.startsWith('date')) return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * dir;
            if (sort.startsWith('amount')) return (Utils.cents(a.amount) - Utils.cents(b.amount)) * dir;
            if (sort.startsWith('name')) {
                const pa = (Store.getProject(a.projectId) || {}).name || '';
                const pb = (Store.getProject(b.projectId) || {}).name || '';
                return pa.localeCompare(pb) * dir;
            }
            return 0;
        });

        document.getElementById('expensesList').innerHTML = list.length ? `<table><thead><tr><th>Дата</th><th>Проект</th><th>Категория</th><th>Сумма</th><th>Описание</th><th></th></tr></thead><tbody>` +
            list.map(e => {
                const p = Store.getProject(e.projectId);
                const workers = (e.workers || []).length
                    ? e.workers.map(w => { const ww = Store.getWorker(w); return ww ? ww.name : '?'; }).join(', ')
                    : '';
                return `<tr>
                    <td>${Utils.escapeHtml(Utils.formatDate(e.date))}</td>
                    <td>${p ? Utils.escapeHtml(p.name) : '<span style="color:var(--danger)">?</span>'}</td>
                    <td><span class="badge ${e.category}">${Utils.escapeHtml(CONFIG.CATEGORIES[e.category] || e.category)}</span></td>
                    <td><b>${Utils.formatMoney(e.amount, cur)}</b>${workers ? `<br><small style="color:var(--secondary)">Работники: ${Utils.escapeHtml(workers)}</small>` : ''}</td>
                    <td style="font-size:12px;color:var(--secondary)">${Utils.escapeHtml(e.desc || '-')}</td>
                    <td>
                        <button class="sm secondary" data-edit-expense="${Utils.escapeHtml(e.id)}">✏️</button>
                        <button class="sm secondary" data-dup-expense="${Utils.escapeHtml(e.id)}">⧉</button>
                        <button class="sm delete" data-del-expense="${Utils.escapeHtml(e.id)}">🗑</button>
                    </td>
                </tr>`;
            }).join('') + '</tbody></table>'
            : UI.emptyState('💸', 'Операций нет.', 'Добавьте расход или выплату, чтобы видеть их здесь.');
    },

    timetracking() {
        const list = [...Store.data.timeEntries].reverse();
        const cur = Store.settings().currency;
        document.getElementById('timeEntriesList').innerHTML = list.length ? `<table><thead><tr><th>Дата</th><th>Работник</th><th>Проект</th><th>Часы</th><th>Тип</th><th>Стоимость</th><th></th></tr></thead><tbody>` +
            list.map(t => {
                const w = Store.getWorker(t.workerId);
                const p = Store.getProject(t.projectId);
                const cost = Calc.timeCostCents(t);
                const typeName = { regular: 'Обычная', overtime: 'Переработка', weekend: 'Выходной' }[t.type] || t.type;
                return `<tr>
                    <td>${Utils.escapeHtml(Utils.formatDate(t.date))}</td>
                    <td>${w ? Utils.escapeHtml(w.name) : '<span style="color:var(--danger)">?</span>'}</td>
                    <td>${p ? Utils.escapeHtml(p.name) : '<span style="color:var(--danger)">?</span>'}</td>
                    <td>${t.hours}ч</td>
                    <td>${Utils.escapeHtml(typeName)}</td>
                    <td>${Utils.formatMoneyCents(cost, cur)}</td>
                    <td>
                        <button class="sm secondary" data-edit-time="${Utils.escapeHtml(t.id)}">✏️</button>
                        <button class="sm delete" data-del-time="${Utils.escapeHtml(t.id)}">🗑</button>
                    </td>
                </tr>`;
            }).join('') + '</tbody></table>'
            : UI.emptyState('⏱', 'Записей времени нет.', 'Добавьте отработанные часы — зарплата рассчитается автоматически.');
    },

    _allDateIndex() {
        const map = new Map();
        const put = (key, item) => { if (!map.has(key)) map.set(key, []); map.get(key).push(item); };
        Store.data.expenses.forEach(e => put(e.date, { type: 'expense', id: e.id, amount: Utils.cents(e.amount), category: e.category, projectId: e.projectId, desc: e.desc }));
        Store.data.timeEntries.forEach(t => put(t.date, { type: 'time', id: t.id, hours: t.hours, workerId: t.workerId, projectId: t.projectId }));
        Store.data.tasks.forEach(t => {
            if (t.dueDate) put(t.dueDate, { type: 'deadline', id: t.id, title: t.title, status: t.status, projectId: t.projectId });
        });
        Store.data.stages.forEach(s => {
            if (s.startDate) put(s.startDate, { type: 'stage', id: s.id, name: s.name, projectId: s.projectId });
            if (s.endDate) put(s.endDate, { type: 'stage', id: s.id, name: s.name, projectId: s.projectId });
        });
        return map;
    },

    calendar() {
        const y = currentCalDate.getFullYear(), m = currentCalDate.getMonth();
        document.getElementById('calendarMonthYear').textContent = currentCalDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
        const byDate = this._allDateIndex();
        const firstDay = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const pad = (firstDay === 0 ? 6 : firstDay - 1);
        const cur = Store.settings().currency;

        let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="calendar-header">${d}</div>`).join('');
        for (let i = 0; i < pad; i++) html += `<div class="calendar-day empty"></div>`;

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            const dayItems = byDate.get(dateStr) || [];
            const expenses = dayItems.filter(i => i.type === 'expense');
            const times = dayItems.filter(i => i.type === 'time');
            const deadlines = dayItems.filter(i => i.type === 'deadline');
            const stages = dayItems.filter(i => i.type === 'stage');
            const sumCents = expenses.reduce((s, e) => s + e.amount, 0);
            const isToday = new Date().toDateString() === new Date(y, m, d).toDateString();
            const hasContent = dayItems.length > 0;
            const items = [];
            expenses.slice(0, 2).forEach(e => {
                const p = Store.getProject(e.projectId);
                const icon = CONFIG.PAYMENT_CATEGORIES.includes(e.category) ? '💵' : '💰';
                items.push(`<div class="day-exp">${icon} ${Utils.formatMoneyCents(e.amount, cur)} · ${Utils.escapeHtml(p ? p.name : '')}</div>`);
            });
            if (times.length) items.push(`<div class="day-time">⏱ ${times.length} зап. · ${times.reduce((s, t) => s + t.hours, 0)}ч</div>`);
            if (stages.length) items.push(`<div class="day-stage">🏗 ${Utils.escapeHtml(stages[0].name)}${stages.length > 1 ? ' +' + (stages.length - 1) : ''}</div>`);
            deadlines.slice(0, 2).forEach(t => {
                const overdue = t.status !== 'DONE' && t.status !== 'CANCELLED' && dateStr < Utils.todayStr();
                items.push(`<div class="day-deadline ${overdue ? 'overdue' : ''}">⚠ ${Utils.escapeHtml(t.title)}</div>`);
            });
            html += `<div class="calendar-day ${isToday ? 'today' : ''} ${hasContent ? 'has-expenses' : ''}" data-cal-date="${dateStr}">
                <div class="day-number">${d}</div>
                ${sumCents > 0 ? `<div class="day-amount">-${Utils.formatMoneyCents(sumCents, cur)}</div>` : ''}
                ${items.join('')}
            </div>`;
        }
        document.getElementById('calendarGrid').innerHTML = html;
    },

    templates() {
        const cur = Store.settings().currency;
        document.getElementById('templatesList').innerHTML = Store.data.templates.map(t =>
            `<div class="template-card">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <b>${Utils.escapeHtml(t.name)}</b>
                    <span class="badge ${t.category}">${Utils.escapeHtml(CONFIG.CATEGORIES[t.category] || t.category)}</span>
                </div>
                <div style="margin-top:5px;color:var(--secondary)">${Utils.escapeHtml(t.desc || '')}</div>
                <div style="margin-top:8px;font-weight:bold">${Utils.formatMoney(t.amount, cur)}</div>
                <div class="card-actions" style="margin-top:10px;">
                    <button class="sm secondary" data-apply-template="${Utils.escapeHtml(t.id)}">Применить</button>
                    <button class="sm secondary" data-edit-template="${Utils.escapeHtml(t.id)}">✏️</button>
                    <button class="sm delete" data-del-template="${Utils.escapeHtml(t.id)}">Удалить</button>
                </div>
            </div>`
        ).join('') || UI.emptyState('📋', 'Шаблонов пока нет.', 'Создайте шаблон для частых расходов.');
    },

    settings() {
        document.getElementById('setCurrency').value = Store.settings().currency;
        document.getElementById('setBudgetWarn').value = Store.settings().budgetWarningPercent;
        document.getElementById('setMaxHours').value = Store.settings().maxHoursPerDay;
        document.getElementById('notifyBudgetOver').checked = !!Store.settings().notifyBudget;
        document.getElementById('notifyLowBalance').checked = !!Store.settings().notifyDebt;
    },

    reports() {
        generateReport();
    },

    tasks() {
        if (!CONFIG.features.tasks) return;
        updateTaskFilters();
        const projF = document.getElementById('taskFilterProject').value;
        const statusF = document.getElementById('taskFilterStatus').value;
        const priF = document.getElementById('taskFilterPriority').value;
        const onlyOverdue = document.getElementById('taskFilterOverdue').checked;
        const cur = Store.settings().currency;
        let list = Store.data.tasks.slice().sort((a, b) => {
            const pr = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
            const pa = pr[a.priority] || 9, pb = pr[b.priority] || 9;
            if (pa !== pb) return pa - pb;
            return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
        });
        if (projF !== 'all') list = list.filter(t => Utils.eq(t.projectId, projF));
        if (statusF !== 'all') list = list.filter(t => t.status === statusF);
        if (priF !== 'all') list = list.filter(t => t.priority === priF);
        if (onlyOverdue) list = list.filter(t => Calc.taskOverdue(t));
        const rows = list.map(t => {
            const p = Store.getProject(t.projectId);
            const stage = t.stageId ? (Store.data.stages.find(x => Utils.eq(x.id, t.stageId)) || {}).name : '';
            const wnames = (t.workerIds || []).map(wid => { const w = Store.getWorker(wid); return w ? w.name : '?'; }).join(', ');
            const overdue = Calc.taskOverdue(t);
            const priBadge = t.priority !== 'NORMAL' ? `<span class="badge pri-${String(t.priority).toLowerCase()}">${t.priority}</span>` : '';
            return `<tr class="${overdue ? 'overtask' : ''}">
                <td><label class="task-check"><input type="checkbox" data-task-toggle="${t.id}" ${t.status === 'DONE' ? 'checked' : ''} ${t.status === 'CANCELLED' ? 'disabled' : ''}></label></td>
                <td><b class="${t.status === 'DONE' ? 'done' : ''}">${Utils.escapeHtml(t.title)}</b> ${overdue ? '<span class="badge pri-urgent">ПРОСРОЧЕНО</span>' : ''}</td>
                <td>${p ? Utils.escapeHtml(p.name) : '?'}</td>
                <td>${Utils.escapeHtml(stage || '—')}</td>
                <td><span class="badge tk-${t.status.toLowerCase()}">${t.status}</span> ${priBadge}</td>
                <td>${Utils.escapeHtml(wnames || '—')}</td>
                <td>${t.dueDate ? `<span class="${overdue ? 'text-danger' : ''}">${Utils.formatDate(t.dueDate)}</span>` : '—'}</td>
                <td>
                    <button class="sm primary" data-task-status="${t.id}" data-st="IN_PROGRESS">▶</button>
                    <button class="sm secondary" data-task-edit="${t.id}">✏️</button>
                    <button class="sm danger" data-task-del="${t.id}">🗑</button>
                </td>
            </tr>`;
        }).join('');
        document.getElementById('tasksList').innerHTML = list.length
            ? `<div class="table-wrapper"><table><thead><tr><th></th><th>Задача</th><th>Проект</th><th>Этап</th><th>Статус</th><th>Исполнители</th><th>Дедлайн</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : UI.emptyState('▦', 'Задач нет.', 'Добавьте задачи в карточке проекта.');

        const summary = list.length ? `${onlyOverdue ? 'Просрочено: ' : 'Задач: '}${list.length} · Открыто: ${list.filter(t => t.status !== 'DONE' && t.status !== 'CANCELLED').length} · Готово: ${list.filter(t => t.status === 'DONE').length}` : '';
        document.getElementById('tasksSummary').textContent = summary;
    },

    // V5: Payroll tab
    payroll() {
        if (!CONFIG.features.payroll) return;
        const period = document.getElementById('payrollPeriod').value;
        const { from, to } = Utils.periodRange(period);
        const cur = Store.settings().currency;
        const workers = Store.data.workers;

        const rows = workers.map(w => {
            const s = Calc.workerStatsForPeriod(w.id, from, to);
            const debtClass = s.debtCents > 0 ? 'color:var(--danger);font-weight:bold' : s.debtCents < 0 ? 'color:var(--success)' : '';
            const debtLabel = s.debtCents < 0 ? 'Переплата: ' + Utils.formatMoneyCents(Math.abs(s.debtCents), cur) : Utils.formatMoneyCents(s.debtCents, cur);
            return `<tr class="${w.active ? '' : 'archived-row'}">
                <td><b>${Utils.escapeHtml(w.name)}</b>${w.active ? '' : ' <small>(арх)</small>'}</td>
                <td>${s.hours}</td>
                <td>${s.avgRate > 0 ? Utils.formatMoney(s.avgRate, cur) + '/ч' : '—'}</td>
                <td>${Utils.formatMoneyCents(s.earnedCents, cur)}</td>
                <td>${Utils.formatMoneyCents(s.paidCents, cur)}</td>
                <td style="${debtClass}">${debtLabel}</td>
                <td class="payroll-action">
                    <button class="sm success" data-pay-worker="${Utils.escapeHtml(w.id)}">💵 Выплата</button>
                </td>
            </tr>`;
        }).join('');

        document.getElementById('payrollList').innerHTML = workers.length
            ? `<table><thead><tr><th>Работник</th><th>Часы за период</th><th>Ср. ставка</th><th>Начислено за период</th><th>Выплачено за период</th><th>Текущий долг (за всё время)</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
            : UI.emptyState('💵', 'Нет работников.', 'Добавьте работников для расчёта зарплаты.');
    },

    // V5: Finance Center tab
    finance() {
        if (!CONFIG.features.finance) return;
        const pid = document.getElementById('financeProject').value || 'all';
        const from = document.getElementById('financeFrom').value;
        const to = document.getElementById('financeTo').value;
        const cur = Store.settings().currency;
        const pf = pid === 'all' ? null : pid;

        // Each metric computed separately — no double-counting.
        const direct = Calc.periodDirectCents(from, to, pf);
        const labor = Calc.periodLaborCents(from, to, pf);
        const paid = Calc.periodPaidCents(from, to, pf);
        const cashOutflow = Calc.periodCashOutflowCents(from, to, pf);
        const projectCost = Calc.periodProjectCostCents(from, to, pf);
        const hours = Calc.periodHours(from, to, pf);
        let debt = 0;
        Store.data.workers.forEach(w => { debt += Calc.workerDebtCents(w.id); });
        const totalBudget = Store.data.projects.filter(p => pid === 'all' || Utils.eq(p.id, pid)).reduce((s, p) => s + Utils.cents(p.budget), 0);
        const totalSpent = Store.data.projects.filter(p => pid === 'all' || Utils.eq(p.id, pid)).reduce((s, p) => s + Calc.projectSpentCents(p.id), 0);
        const remaining = totalBudget - totalSpent;

        document.getElementById('financeContent').innerHTML =
            `<div class="finance-summary">
                <div class="f-card"><div class="f-label">Прямые расходы</div><div class="f-value">${Utils.formatMoneyCents(direct, cur)}</div></div>
                <div class="f-card"><div class="f-label">Стоимость труда (начислено)</div><div class="f-value">${Utils.formatMoneyCents(labor, cur)}</div></div>
                <div class="f-card"><div class="f-label">Себестоимость работ</div><div class="f-value">${Utils.formatMoneyCents(projectCost, cur)}</div></div>
                <div class="f-card"><div class="f-label">Выплачено (зарплата/аванс)</div><div class="f-value">${Utils.formatMoneyCents(paid, cur)}</div></div>
                <div class="f-card"><div class="f-label">Денежный отток</div><div class="f-value">${Utils.formatMoneyCents(cashOutflow, cur)}</div></div>
                <div class="f-card"><div class="f-label">Текущий долг по зарплате</div><div class="f-value" style="color:${debt > 0 ? 'var(--danger)' : 'inherit'}">${Utils.formatMoneyCents(debt, cur)}</div></div>
                <div class="f-card"><div class="f-label">Бюджет (план)</div><div class="f-value">${Utils.formatMoneyCents(totalBudget, cur)}</div></div>
                <div class="f-card"><div class="f-label">Остаток бюджета</div><div class="f-value" style="color:${remaining < 0 ? 'var(--danger)' : 'var(--success)'}">${Utils.formatMoneyCents(remaining, cur)}</div></div>
            </div>` +
            `<div class="analytics-section">
                <h3>Расходы по категориям</h3>
                <div class="table-wrapper"><table><thead><tr><th>Категория</th><th>Сумма</th></tr></thead><tbody>${this._financeCategoryRows(from, to, pid)}</tbody></table></div>
            </div>` +
            `<div class="analytics-section">
                <h3>Расходы по проектам</h3>
                <div class="table-wrapper"><table><thead><tr><th>Проект</th><th>Прямые расходы</th><th>Труд</th><th>Себестоимость</th><th>Выплачено</th></tr></thead><tbody>${this._financeProjectRows(from, to, pid)}</tbody></table></div>
            </div>`;
    },

    _financeCategoryRows(from, to, pid) {
        const cur = Store.settings().currency;
        const cats = {};
        Store.data.expenses.forEach(e => {
            if (pid !== 'all' && !Utils.eq(e.projectId, pid)) return;
            if (from && e.date < from) return;
            if (to && e.date > to) return;
            const c = CONFIG.CATEGORIES[e.category] ? e.category : 'other';
            cats[c] = (cats[c] || 0) + Utils.cents(e.amount);
        });
        const rows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<tr><td><span class="badge ${k}">${Utils.escapeHtml(CONFIG.CATEGORIES[k] || k)}</span></td><td>${Utils.formatMoneyCents(v, cur)}</td></tr>`).join('');
        return rows || `<tr><td colspan="2" style="text-align:center;color:var(--secondary)">Нет данных</td></tr>`;
    },

    _financeProjectRows(from, to, pidFilter) {
        const cur = Store.settings().currency;
        const projects = Store.data.projects.filter(p => pidFilter === 'all' || Utils.eq(p.id, pidFilter));
        const rows = projects.map(p => {
            const direct = Calc.periodDirectCents(from, to, p.id);
            const labor = Calc.periodLaborCents(from, to, p.id);
            const cost = direct + labor;
            const paid = Calc.periodPaidCents(from, to, p.id);
            return `<tr><td>${Utils.escapeHtml(p.name)}</td><td>${Utils.formatMoneyCents(direct, cur)}</td><td>${Utils.formatMoneyCents(labor, cur)}</td><td>${Utils.formatMoneyCents(cost, cur)}</td><td>${Utils.formatMoneyCents(paid, cur)}</td></tr>`;
        }).join('');
        return rows || `<tr><td colspan="5" style="text-align:center;color:var(--secondary)">Нет данных</td></tr>`;
    },

    // V5: Analytics tab
    analytics() {
        if (!CONFIG.features.analytics) return;
        const pid = document.getElementById('analyticsProject').value || 'all';
        const from = document.getElementById('analyticsFrom').value;
        const to = document.getElementById('analyticsTo').value;
        const cur = Store.settings().currency;
        const pf = pid === 'all' ? null : pid;

        // Projects analytics — period-scoped for consistency with Finance.
        const projects = Store.data.projects.filter(p => pid === 'all' || Utils.eq(p.id, pid));
        const projCards = projects.map(p => {
            const direct = Calc.periodDirectCents(from, to, p.id);
            const labor = Calc.periodLaborCents(from, to, p.id);
            const total = direct + labor;
            const budget = Utils.cents(p.budget);
            return `<div class="a-card">
                <div class="a-label">${Utils.escapeHtml(p.name)}</div>
                <div class="a-value">${Utils.formatMoneyCents(total, cur)}</div>
                <div style="font-size:12px;color:var(--secondary);margin-top:4px">
                    Бюджет: ${Utils.formatMoneyCents(budget, cur)} · Расходы: ${Utils.formatMoneyCents(direct, cur)} · Труд: ${Utils.formatMoneyCents(labor, cur)}
                </div>
            </div>`;
        }).join('');

        // Workers analytics — period-scoped.
        const workerCards = Store.data.workers.map(w => {
            const s = Calc.workerStatsForPeriod(w.id, from, to);
            return `<div class="a-card">
                <div class="a-label">${Utils.escapeHtml(w.name)}</div>
                <div class="a-value">${s.hours}ч</div>
                <div style="font-size:12px;color:var(--secondary);margin-top:4px">
                    Начислено за период: ${Utils.formatMoneyCents(s.earnedCents, cur)} · Выплачено за период: ${Utils.formatMoneyCents(s.paidCents, cur)} · Долг (за всё время): ${Utils.formatMoneyCents(s.debtCents, cur)}
                </div>
            </div>`;
        }).join('');

        // Expenses by category (period-scoped)
        const cats = {};
        Store.data.expenses.forEach(e => {
            if (pf && !Utils.eq(e.projectId, pf)) return;
            if (from && e.date < from) return;
            if (to && e.date > to) return;
            const c = CONFIG.CATEGORIES[e.category] ? e.category : 'other';
            cats[c] = (cats[c] || 0) + Utils.cents(e.amount);
        });
        const maxCat = Math.max(...Object.values(cats), 1);
        const catChart = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<div class="chart-bar"><div class="chart-label">${Utils.escapeHtml(CONFIG.CATEGORIES[k] || k)}</div><div class="chart-bar-wrapper"><div class="chart-bar-fill" style="width:${(v / maxCat) * 100}%">${Utils.formatMoneyCents(v, cur)}</div></div></div>`
        ).join('') || '<p style="color:var(--secondary)">Нет данных</p>';

        // Hours by month (last 6 months)
        const months = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const mFrom = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
            const mTo = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0');
            const h = Calc.periodHours(mFrom, mTo, pf);
            months.push({ label: d.toLocaleString('ru-RU', { month: 'short' }), hours: h });
        }
        const maxH = Math.max(...months.map(m => m.hours), 1);
        const hoursChart = months.map(m =>
            `<div class="chart-bar"><div class="chart-label">${Utils.escapeHtml(m.label)}</div><div class="chart-bar-wrapper"><div class="chart-bar-fill" style="width:${(m.hours / maxH) * 100}%; background:linear-gradient(90deg, #06b6d4, #0891b2);">${m.hours}ч</div></div></div>`
        ).join('');

        document.getElementById('analyticsContent').innerHTML =
            `<div class="analytics-section"><h3>Проекты</h3><div class="analytics-grid">${projCards || '<p style="color:var(--secondary)">Нет проектов</p>'}</div></div>` +
            `<div class="analytics-section"><h3>Работники</h3><div class="analytics-grid">${workerCards || '<p style="color:var(--secondary)">Нет работников</p>'}</div></div>` +
            `<div class="analytics-section"><h3>Расходы по категориям</h3>${catChart}</div>` +
            `<div class="analytics-section"><h3>Часы по месяцам</h3>${hoursChart}</div>`;
    },

    // V5: Activity Log tab
    activity() {
        const log = [...Store.data.activityLog].reverse();
        const entityIcons = { project: '📁', worker: '👷', expense: '💸', time: '⏱', stage: '📋', task: '▦', template: '📋' };
        const actionLabels = { create: 'создан', update: 'изменён', delete: 'удалён', archive: 'архивирован', restore: 'восстановлён', status: 'статус' };
        document.getElementById('activityList').innerHTML = log.length
            ? `<table><thead><tr><th>Время</th><th>Действие</th></tr></thead><tbody>` +
                log.slice(0, 200).map(l => {
                    const time = new Date(l.ts).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                    const icon = entityIcons[l.entity] || '•';
                    const act = actionLabels[l.action] || l.action;
                    return `<tr class="activity-log-row"><td class="al-time">${Utils.escapeHtml(time)}</td><td class="al-action">${icon} ${Utils.escapeHtml(act)}: ${Utils.escapeHtml(l.label)}</td></tr>`;
                }).join('') + `</tbody></table>`
            : UI.emptyState('📜', 'История пуста.', 'Действия будут записываться автоматически.');
    }
};

// ---------------- Calendar state ----------------
let currentCalDate = new Date();

// ---------------- Form updaters ----------------
function updateExpenseForm() {
    const ps = document.getElementById('expenseProject');
    ps.innerHTML = '<option value="">— выберите проект —</option>' + Store.activeProjects().map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('');

    const fp = document.getElementById('filterExpenseProject');
    fp.innerHTML = '<option value="all">Все проекты</option>' + Store.data.projects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${p.active ? '' : '(арх) '}${Utils.escapeHtml(p.name)}</option>`).join('');

    const fc = document.getElementById('filterExpenseCategory');
    fc.innerHTML = '<option value="all">Все категории</option>' + Object.entries(CONFIG.CATEGORIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');

    renderSplitForm(document.getElementById('expenseWorkersSplit'), null);
}

function renderSplitForm(container, current) {
    const workers = Store.data.workers;
    if (!workers.length) { container.innerHTML = '<small>Нет работников. Сначала добавьте работников.</small>'; return; }
    container.innerHTML = workers.map(w => {
        const checked = current && Array.isArray(current.workers) && current.workers.map(String).includes(String(w.id));
        const val = current && current.splits && current.splits[w.id] != null ? current.splits[w.id] : '';
        return `<div class="split-row" data-split-worker="${Utils.escapeHtml(w.id)}">
            <input type="checkbox" class="ws-cb" value="${Utils.escapeHtml(w.id)}" ${checked ? 'checked' : ''}>
            <label>${Utils.escapeHtml(w.name)}</label>
            <input type="number" class="ws-am" data-wid="${Utils.escapeHtml(w.id)}" placeholder="Сумма" min="0" step="0.01" value="${Utils.escapeHtml(val)}" ${checked ? '' : 'disabled'}>
            <span class="share"></span>
        </div>`;
    }).join('');
    renderSplitShares();
}

function renderSplitShares() {
    const amt = parseFloat(document.getElementById('expenseAmount').value) || 0;
    document.querySelectorAll('.split-row').forEach(row => {
        const cb = row.querySelector('.ws-cb');
        const inp = row.querySelector('.ws-am');
        const share = row.querySelector('.share');
        if (!cb || !cb.checked) { if (share) share.textContent = ''; return; }
        const v = parseFloat(inp.value) || 0;
        if (v > 0) share.textContent = (v / (amt || 1) * 100).toFixed(0) + '%';
        else share.textContent = 'равно';
    });
}

// V5: Finance / Analytics filter updaters
function updateFinanceFilters() {
    const fp = document.getElementById('financeProject');
    if (fp) fp.innerHTML = '<option value="all">Все проекты</option>' + Store.data.projects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${p.active ? '' : '(арх) '}${Utils.escapeHtml(p.name)}</option>`).join('');
}
function updateAnalyticsFilters() {
    const ap = document.getElementById('analyticsProject');
    if (ap) ap.innerHTML = '<option value="all">Все проекты</option>' + Store.data.projects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${p.active ? '' : '(арх) '}${Utils.escapeHtml(p.name)}</option>`).join('');
}

// ---------------- 12. IMPORT / EXPORT / BACKUP ----------------
const Backup = {
    AUTO_KEY: 'brigadeProV2_autobackup',

    create() {
        const payload = {
            application: 'Brigade Manager Pro',
            applicationVersion: CONFIG.APP_VERSION,
            schemaVersion: CONFIG.SCHEMA_VERSION,
            timestamp: new Date().toISOString(),
            data: Store.data
        };
        try {
            localStorage.setItem(this.AUTO_KEY, JSON.stringify(payload));
            return { timestamp: payload.timestamp, size: JSON.stringify(payload).length };
        } catch (e) {
            AppLogger.error('Не удалось создать резервную копию', e);
            UI.toast('Не удалось создать резервную копию (хранилище переполнено?)', 'error');
            return null;
        }
    },

    read() {
        try { return localStorage.getItem(this.AUTO_KEY); }
        catch (e) { AppLogger.error('Не удалось прочитать резервную копию', e); return null; }
    },

    restore() {
        const raw = this.read();
        if (!raw) { UI.toast('Автоматическая копия не найдена', 'warning'); return; }
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { UI.toast('Автоматическая копия повреждена', 'error'); return; }
        try {
            const result = prepareIncomingData(parsed);
            UI.confirm('Восстановить автокопию?',
                'Текущие данные будут заменены содержимым последней автоматической копии. Продолжить?',
                () => { applyIncomingData(result); },
                true);
        } catch (e) {
            AppLogger.error('Ошибка восстановления автокопии', e);
            UI.toast('Автокопия не распознана. Текущие данные не изменены.', 'error');
        }
    }
};

function exportJSON() {
    const payload = JSON.stringify({
        schemaVersion: CONFIG.SCHEMA_VERSION,
        applicationVersion: CONFIG.APP_VERSION,
        exportedAt: new Date().toISOString(),
        data: Store.data
    }, null, 2);
    downloadFile(payload, `brigade_data_${Utils.todayStr()}.json`, 'application/json');
    Store.log('system', 'export', 'Экспорт JSON');
    Store.save();
    UI.toast('Данные экспортированы', 'success');
}

function exportBackup() {
    const payload = JSON.stringify({
        schemaVersion: CONFIG.SCHEMA_VERSION,
        applicationVersion: CONFIG.APP_VERSION,
        timestamp: new Date().toISOString(),
        data: Store.data
    }, null, 2);
    downloadFile(payload, `brigade_backup_${Utils.todayStr()}.json`, 'application/json');
    Store.log('system', 'backup', 'Резервная копия создана');
    Store.save();
    UI.toast('Резервная копия создана', 'success');
}

function downloadFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 100);
}

function importJSONFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.target.result); }
        catch (e) { UI.toast('Файл повреждён: неверный формат JSON', 'error'); return; }
        try {
            const result = prepareIncomingData(parsed);
            // P1: ERROR blocks import. WARNING allows import.
            if (result.errors.length > 0) {
                const msg = `Импорт невозможен: обнаружено ${result.errors.length} ошибок целостности.\n\nОшибки:\n${result.errors.slice(0, 10).join('\n')}${result.errors.length > 10 ? '\n...' : ''}`;
                UI.confirm('Импорт заблокирован', msg, () => {}, false);
                return;
            }
            const warnNote = result.warnings.length ? ` Предупреждений: ${result.warnings.length}.` : '';
            const alertNote = result.alerts.length ? ` Бизнес-уведомлений: ${result.alerts.length}.` : '';
            UI.confirm('Импорт данных',
                'Текущие данные будут заменены данными из файла.' + warnNote + alertNote +
                ' Перед заменой будет создана резервная копия текущих данных. Продолжить?',
                () => applyIncomingData(result),
                true);
        } catch (e) {
            AppLogger.error('Ошибка импорта', e);
            UI.toast('Файл не распознан как корректный экспорт/бэкап. Текущие данные не изменены.', 'error');
        }
    };
    reader.readAsText(file);
}

function importBackupFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.target.result); }
        catch (e) { UI.toast('Файл копии повреждён: неверный JSON', 'error'); return; }
        try {
            const result = prepareIncomingData(parsed);
            if (result.errors.length > 0) {
                const msg = `Восстановление невозможно: обнаружено ${result.errors.length} ошибок целостности.\n\nОшибки:\n${result.errors.slice(0, 10).join('\n')}${result.errors.length > 10 ? '\n...' : ''}`;
                UI.confirm('Восстановление заблокировано', msg, () => {}, false);
                return;
            }
            const warnNote = result.warnings.length ? ` Предупреждений: ${result.warnings.length}.` : '';
            UI.confirm('Восстановление из копии',
                'Данные будут заменены содержимым резервной копии.' + warnNote +
                ' Перед заменой текущие данные будут сохранены в автокопии. Продолжить?',
                () => applyIncomingData(result),
                true);
        } catch (e) {
            AppLogger.error('Ошибка восстановления', e);
            UI.toast('Копия не распознана. Текущие данные не изменены.', 'error');
        }
    };
    reader.readAsText(file);
}

function prepareIncomingData(parsed) {
    let raw = (parsed && typeof parsed === 'object' && 'data' in parsed) ? parsed.data : parsed;
    if (!raw || typeof raw !== 'object') throw new Error('bad structure');
    let version = Number(raw.schemaVersion) || 0;
    if (version > CONFIG.SCHEMA_VERSION) throw new Error('newer schema version: ' + version);
    const steps = Migrations.getSteps();
    for (let i = version; i <= CONFIG.SCHEMA_VERSION && i < steps.length; i++) {
        raw = steps[i](raw);
    }
    raw.schemaVersion = CONFIG.SCHEMA_VERSION;
    const data = Validation.normalizeData(raw);
    const split = Validation.auditSplit(data);
    return { data, errors: split.errors, warnings: split.warnings, alerts: split.alerts, problems: split.errors.concat(split.warnings) };
}

function applyIncomingData(result) {
    const auto = Backup.create();
    if (!auto) {
        UI.toast('Невозможно создать защитную копию — замена данных отменена.', 'error');
        return;
    }
    Store.replaceData(result.data);
    Store.log('system', 'import', `Импорт данных. Автокопия: ${auto.timestamp.slice(0, 16)}`);
    Store.save();
    if (result.problems && result.problems.length) {
        AppLogger.warn('Проблемы целостности при импорте: ', result.problems);
        UI.toast('Данные импортированы. Обнаружены проблемы целостности: ' + result.problems.length + '. Автокопия: ' + auto.timestamp.slice(0, 16).replace('T', ' '), 'warning');
    } else {
        UI.toast('Данные загружены. Автокопия: ' + auto.timestamp.slice(0, 16).replace('T', ' '), 'success');
    }
    renderAll();
}

function exportCSV() {
    let csv = '\ufeffДата;Проект;Категория;Сумма;Описание\n';
    [...Store.data.expenses].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(e => {
        const p = Store.getProject(e.projectId);
        csv += [Utils.csvEscape(e.date), Utils.csvEscape(p ? p.name : ''), Utils.csvEscape(CONFIG.CATEGORIES[e.category] || e.category), Utils.csvEscape(e.amount), Utils.csvEscape(e.desc || '')].join(';') + '\n';
    });
    downloadFile(csv, `brigade_expenses_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (расходы)');
    Store.save();
}

function exportWorkersCSV() {
    const cur = Store.settings().currency;
    let csv = '\ufeffИмя;Должность;Ставка;Часы;Заработано;Выплачено;Долг;Активен\n';
    Store.data.workers.forEach(w => {
        const earned = Calc.workerEarnedCents(w.id);
        const paid = Calc.workerPaidCents(w.id);
        const debt = earned - paid;
        const hours = Calc.workerHours(w.id);
        csv += [Utils.csvEscape(w.name), Utils.csvEscape(w.position || ''), Utils.csvEscape(w.rate), hours, Utils.csvEscape(Utils.toRub(earned) / 1), Utils.csvEscape(Utils.toRub(paid) / 1), Utils.csvEscape(Utils.toRub(debt) / 1), w.active ? 'да' : 'нет'].join(';') + '\n';
    });
    downloadFile(csv, `brigade_workers_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (работники)');
    Store.save();
}

function exportTimeCSV() {
    let csv = '\ufeffДата;Работник;Проект;Часы;Тип;Стоимость;Комментарий\n';
    [...Store.data.timeEntries].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(t => {
        const w = Store.getWorker(t.workerId);
        const p = Store.getProject(t.projectId);
        const cost = Calc.timeCostCents(t);
        csv += [Utils.csvEscape(t.date), Utils.csvEscape(w ? w.name : '?'), Utils.csvEscape(p ? p.name : '?'), t.hours, Utils.csvEscape(t.type || 'regular'), Utils.csvEscape(Utils.toRub(cost) / 1), Utils.csvEscape(t.comment || '')].join(';') + '\n';
    });
    downloadFile(csv, `brigade_time_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (время)');
    Store.save();
}

function exportTasksCSV() {
    let csv = '\ufeffНазвание;Проект;Этап;Статус;Приоритет;Дедлайн;Исполнители\n';
    Store.data.tasks.forEach(t => {
        const p = Store.getProject(t.projectId);
        const stage = t.stageId ? (Store.data.stages.find(x => Utils.eq(x.id, t.stageId)) || {}).name : '';
        const wnames = (t.workerIds || []).map(wid => { const w = Store.getWorker(wid); return w ? w.name : '?'; }).join(', ');
        csv += [Utils.csvEscape(t.title), Utils.csvEscape(p ? p.name : '?'), Utils.csvEscape(stage || ''), Utils.csvEscape(t.status), Utils.csvEscape(t.priority || 'NORMAL'), Utils.csvEscape(t.dueDate || ''), Utils.csvEscape(wnames || '')].join(';') + '\n';
    });
    downloadFile(csv, `brigade_tasks_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (задачи)');
    Store.save();
}

function exportProjectsCSV() {
    const cur = Store.settings().currency;
    let csv = '\ufeffНазвание;Статус;Бюджет;Потрачено;Остаток;Часы;Работников;Активен\n';
    Store.data.projects.forEach(p => {
        const st = Calc.projectStats(p.id);
        const hours = Calc.projectHours(p.id);
        const wcount = Calc.projectWorkers(p.id).length;
        csv += [Utils.csvEscape(p.name), Utils.csvEscape(p.status), Utils.csvEscape(p.budget), Utils.csvEscape(Utils.toRub(st.spent) / 1), Utils.csvEscape(Utils.toRub(st.remaining) / 1), hours, wcount, p.active ? 'да' : 'нет'].join(';') + '\n';
    });
    downloadFile(csv, `brigade_projects_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (проекты)');
    Store.save();
}

function exportPayrollCSV() {
    const cur = Store.settings().currency;
    let csv = '\ufeffРаботник;Часы (всего);Заработано (всего);Выплачено (всего);Долг (всего)\n';
    Store.data.workers.forEach(w => {
        const earned = Calc.workerEarnedCents(w.id);
        const paid = Calc.workerPaidCents(w.id);
        const debt = earned - paid;
        const hours = Calc.workerHours(w.id);
        csv += [Utils.csvEscape(w.name), hours, Utils.csvEscape(Utils.toRub(earned) / 1), Utils.csvEscape(Utils.toRub(paid) / 1), Utils.csvEscape(Utils.toRub(debt) / 1)].join(';') + '\n';
    });
    downloadFile(csv, `brigade_payroll_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
    Store.log('system', 'export', 'Экспорт CSV (зарплата)');
    Store.save();
}

function verifyBackup() {
    const file = document.getElementById('restoreFile').files[0];
    if (!file) { UI.toast('Сначала выберите файл копии', 'warning'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.target.result); }
        catch (e) { UI.toast('Файл повреждён: неверный JSON', 'error'); return; }
        try {
            const r = prepareIncomingData(parsed);
            const merged = r.data;
            const count = { p: merged.projects.length, w: merged.workers.length, e: merged.expenses.length, t: merged.timeEntries.length, tp: merged.templates.length };
            let msg = `Файл валиден.\nПроектов: ${count.p}\nРаботников: ${count.w}\nОпераций: ${count.e}\nЗаписей времени: ${count.t}\nШаблонов: ${count.tp}`;
            if (r.problems.length) msg += `\nПроблемы целостности: ${r.problems.length}`;
            UI.confirm('Проверка копии', msg, () => {}, false);
        } catch (e) {
            UI.toast('Файл не является корректной копией.', 'error');
        }
    };
    reader.readAsText(file);
}

// ---------------- 13. Reports ----------------
function updateTaskFilters() {
    const psel = document.getElementById('taskFilterProject');
    const cur = psel.value;
    psel.innerHTML = '<option value="all">Все проекты</option>' + Store.data.projects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('');
    if (['all'].includes(cur) || Store.data.projects.some(p => Utils.eq(p.id, cur))) psel.value = cur;
}

function updateReportFilters() {
    document.getElementById('reportProject').innerHTML = '<option value="all">Все проекты</option>' + Store.data.projects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${p.active ? '' : '(арх) '}${Utils.escapeHtml(p.name)}</option>`).join('');
}

function generateReport() {
    const pid = document.getElementById('reportProject').value;
    const from = document.getElementById('reportDateFrom').value;
    const to = document.getElementById('reportDateTo').value;
    const group = document.getElementById('reportGroupBy').value;
    const cur = Store.settings().currency;

    const entries = Reports.collect(pid, from, to);
    const totalCents = entries.reduce((s, e) => s + Utils.cents(e.amount), 0);
    const grouped = Reports.group(entries, group);

    const rows = Object.entries(grouped).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<tr><td>${Utils.escapeHtml(k)}</td><td>${Utils.formatMoneyCents(v, cur)}</td><td>${totalCents ? (v / totalCents * 100).toFixed(1) : 0}%</td></tr>`
    ).join('');

    document.getElementById('reportContent').innerHTML =
        `<div class="stat-card flat" style="margin-bottom:20px;"><h4>Итого за период</h4><div class="value">${Utils.formatMoneyCents(totalCents, cur)}</div></div>` +
        `<div class="table-wrapper"><table><thead><tr><th>Группа</th><th>Сумма</th><th>%</th></tr></thead><tbody>${rows || '<tr><td colspan="3" style="text-align:center;color:var(--secondary)">Нет данных за выбранный период</td></tr>'}</tbody></table></div>`;
}

// ---------------- 14. Modals / CRUD forms ----------------
function modalActionsHTML() {
    return `<button class="secondary" data-modal-close>Отмена</button><button class="success" data-modal-submit>Сохранить</button>`;
}

function addProjectForm() {
    const name = document.getElementById('projectName').value.trim();
    if (!name) { UI.toast('Введите название проекта', 'error'); return; }
    Store.addProject({
        name,
        budget: Utils.cents(document.getElementById('projectBudget').value) / 100,
        currency: Store.settings().currency,
        status: document.getElementById('projectStatus').value,
        desc: document.getElementById('projectDesc').value
    });
    document.getElementById('projectName').value = '';
    renderAll();
    UI.toast('Проект создан');
}

function openEditProject(id) {
    const p = Store.getProject(id);
    if (!p) return;
    UI.openModal('Редактировать проект',
        `<div class="group-field"><label>Название *</label><input id="pName" value="${Utils.escapeHtml(p.name)}"></div>
         <div class="group-field"><label>Бюджет</label><input id="pBudget" type="number" min="0" step="0.01" value="${p.budget}"></div>
         <div class="group-field"><label>Валюта приложения (общая)</label><input id="pCurrency" type="text" readonly value="${Utils.escapeHtml(Store.settings().currency)}" style="background:var(--bg-secondary);color:var(--secondary)"></div>
         <div class="group-field"><label>Статус</label><select id="pStatus">${CONFIG.PROJECT_STATUSES.map(s => `<option ${p.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select></div>
         <div class="group-field"><label>Дата начала (план)</label><input id="pStart" type="date" value="${Utils.escapeHtml(p.startDate || '')}"></div>
         <div class="group-field"><label>Дата окончания (план)</label><input id="pEnd" type="date" value="${Utils.escapeHtml(p.endDate || '')}"></div>
         <div class="group-field"><label>Приоритет</label><select id="pPriority">${CONFIG.PROJECT_PRIORITIES.map(x => `<option ${p.priority === x ? 'selected' : ''} value="${x}">${x}</option>`).join('')}</select></div>
         <div class="group-field"><label>Ответственный</label><input id="pLead" value="${Utils.escapeHtml(p.lead || '')}"></div>
         <div class="group-field"><label>Описание</label><textarea id="pDesc" rows="2">${Utils.escapeHtml(p.desc || '')}</textarea></div>`,
        modalActionsHTML());
    wireModal(() => {
        const name = document.getElementById('pName').value.trim();
        if (!name) { UI.toast('Введите название проекта', 'error'); return false; }
        const startDate = document.getElementById('pStart').value || '';
        const endDate = document.getElementById('pEnd').value || '';
        if (startDate && endDate && !Utils.validateDateRange(startDate, endDate)) { UI.toast('Дата начала не может быть позже даты окончания', 'error'); return false; }
        Store.updateProject(id, {
            name,
            budget: Utils.cents(document.getElementById('pBudget').value) / 100,
            currency: Store.settings().currency,
            status: document.getElementById('pStatus').value,
            startDate,
            endDate,
            priority: document.getElementById('pPriority').value,
            lead: document.getElementById('pLead').value.trim(),
            desc: document.getElementById('pDesc').value
        });
        UI.toast('Проект обновлён');
        renderAll();
        return true;
    });
}

function openProjectDetail(id) {
    const p = Store.getProject(id);
    if (!p) return;
    const st = Calc.projectStats(id);
    const cats = Calc.projectCategoryCents(id);
    const cur = Store.settings().currency;
    const direct = Calc.projectDirectExpenseCents(id);
    const labor = Calc.projectLaborCostCents(id);
    const total = Calc.projectTotalCostCents(id);
    const overHtml = st.over
        ? `<p style="margin-top:12px;color:var(--danger);font-weight:bold;">⚠️ Бюджет превышен на ${Utils.formatMoneyCents(st.remaining < 0 ? -st.remaining : 0, cur)}</p>`
        : (st.warn ? `<p style="margin-top:12px;color:var(--warning);font-weight:bold;">⚠️ Использовано ${st.pct.toFixed(0)}% бюджета</p>` : '');
    const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<tr><td>${Utils.escapeHtml(CONFIG.CATEGORIES[k] || k)}</td><td>${Utils.formatMoneyCents(v, cur)}</td></tr>`).join('');

    const priBadge = p.priority && p.priority !== 'NORMAL' ? ` <span class="badge pri-${String(p.priority).toLowerCase()}">${p.priority}</span>` : '';
    const planHtml = `<div class="dl"><span>План</span><b>${p.startDate ? Utils.formatDate(p.startDate) : '—'} → ${p.endDate ? Utils.formatDate(p.endDate) : '—'}</b></div>
        <div class="dl"><span>Приоритет</span><b>${Utils.escapeHtml(p.priority || 'NORMAL')} ${priBadge}</b></div>
        <div class="dl"><span>Ответственный</span><b>${Utils.escapeHtml(p.lead || '—')}</b></div>`;

    const wAssign = Calc.projectWorkersDetailed(id).map(w =>
        `<tr><td>${Utils.escapeHtml(w.name)}${w.active ? '' : ' <small>(арх)</small>'}</td><td>${w.hours}ч</td><td>${Utils.formatMoneyCents(w.earnedCents, cur)}</td><td>${w.openTasks}</td></tr>`).join('');

    const stages = Store.stagesOfProject(id);
    const stageRow = (s, i) => {
        const stStatus = { planning: 'План', active: 'Активен', done: 'Готов', archived: 'Архив' }[s.status] || s.status;
        return `<div class="stage-row ${s.status === 'archived' ? 'archived' : ''}">
            <div style="flex:1;min-width:0">
                <div><b>${i + 1}. ${Utils.escapeHtml(s.name)}</b> <span class="badge st-${s.status}">${stStatus}</span></div>
                ${s.description ? `<div style="color:var(--secondary);font-size:12px">${Utils.escapeHtml(s.description)}</div>` : ''}
                ${(s.startDate || s.endDate) ? `<div style="color:var(--secondary);font-size:11px">${s.startDate ? Utils.formatDate(s.startDate) : ''}${s.startDate && s.endDate ? ' → ' : ''}${s.endDate ? Utils.formatDate(s.endDate) : ''}</div>` : ''}
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
                <button class="sm secondary" data-stage-move="${s.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Вверх">↑</button>
                <button class="sm secondary" data-stage-move="${s.id}" data-dir="1" ${i === stages.length - 1 ? 'disabled' : ''} title="Вниз">↓</button>
                <button class="sm secondary" data-stage-edit="${s.id}">✏️</button>
                ${s.status === 'done' ? '' : `<button class="sm success" data-stage-status="${s.id}" data-st="done">✓</button>`}
                ${s.status === 'active' ? '' : `<button class="sm primary" data-stage-status="${s.id}" data-st="active">▶</button>`}
                ${s.status !== 'archived' ? `<button class="sm danger" data-stage-status="${s.id}" data-st="archived">🗄</button>` : ''}
            </div>
        </div>`;
    };
    const stagesHtml = CONFIG.features.stages
        ? `<h3 style="margin-top:18px;">Этапы проекта</h3>
           ${stages.length ? stages.map(stageRow).join('') : '<p style="color:var(--secondary);font-size:13px">Этапов пока нет.</p>'}
           <div style="margin-top:8px"><button class="sm success" data-stage-add="${id}">➕ Добавить этап</button></div>`
        : '';

    const tasks = Store.data.tasks.filter(t => Utils.eq(t.projectId, id)).sort((a, b) => {
        const pr = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
        return (pr[a.priority] || 9) - (pr[b.priority] || 9);
    });
    const taskRow = t => {
        const overdue = Calc.taskOverdue(t);
        const stageName = t.stageId ? (Store.data.stages.find(x => Utils.eq(x.id, t.stageId)) || {}).name : '';
        const wnames = (t.workerIds || []).map(wid => { const w = Store.getWorker(wid); return w ? w.name : '?'; }).join(', ');
        const priBadge2 = t.priority !== 'NORMAL' ? ` <span class="badge pri-${String(t.priority).toLowerCase()}">${t.priority}</span>` : '';
        return `<div class="task-row ${t.status === 'CANCELLED' ? 'archived' : ''} ${overdue ? 'overdue' : ''}">
            <label class="task-check">
                <input type="checkbox" data-task-toggle="${t.id}" ${t.status === 'DONE' ? 'checked' : ''} ${t.status === 'CANCELLED' ? 'disabled' : ''}>
                <span class="${t.status === 'DONE' ? 'done' : ''}"><b>${Utils.escapeHtml(t.title)}</b></span>
            </label>
            <div style="color:var(--secondary);font-size:12px;margin:2px 0 0 24px">
                ${stageName ? 'Этап: ' + Utils.escapeHtml(stageName) + ' · ' : ''}${wnames ? 'Исп: ' + Utils.escapeHtml(wnames) + ' · ' : ''}
                Статус: ${t.status} ${priBadge2}
                ${t.dueDate ? ' · Дедлайн: <b class="' + (overdue ? 'text-danger" >' : '">') + Utils.formatDate(t.dueDate) + '</b>' : ''}
                ${overdue ? ' <span class="badge pri-urgent" >ПРОСРОЧЕНО</span>' : ''}
            </div>
            <div style="display:flex;gap:4px;margin-left:24px;margin-top:4px">
                <button class="sm primary" data-task-status="${t.id}" data-st="IN_PROGRESS">▶</button>
                <button class="sm secondary" data-task-edit="${t.id}">✏️</button>
                <button class="sm danger" data-task-del="${t.id}">🗑</button>
            </div>
        </div>`;
    };
    const tasksHtml = CONFIG.features.tasks
        ? `<h3 style="margin-top:18px;">Задачи проекта</h3>
           ${tasks.length ? tasks.map(taskRow).join('') : '<p style="color:var(--secondary);font-size:13px">Задач нет.</p>'}
           <div style="margin-top:8px"><button class="sm success" data-task-add="${id}">➕ Добавить задачу</button></div>`
        : '';

    UI.openModal('Проект: ' + p.name,
        `<div class="detail-grid">
            <div class="dl"><span>Статус</span><b>${p.active ? p.status : 'Архив'}</b></div>
            <div class="dl"><span>Бюджет</span><b>${Utils.formatMoneyCents(st.budget, cur)}</b></div>
            <div class="dl"><span>Потрачено</span><b>${Utils.formatMoneyCents(st.spent, cur)}</b></div>
            <div class="dl"><span>Остаток</span><b>${Utils.formatMoneyCents(st.remaining, cur)}</b></div>
            <div class="dl"><span>Использовано</span><b>${p.budget > 0 ? st.pct.toFixed(1) + '%' : '-'}</b></div>
            <div class="dl"><span>Работников</span><b>${Calc.projectWorkers(id).length}</b></div>
            <div class="dl"><span>Часов</span><b>${Calc.projectHours(id)}</b></div>
            ${planHtml}
        </div>
        ${st.budget > 0 ? `<div class="progress-bar" style="margin-top:12px"><div class="progress-fill ${st.over ? 'over-budget' : st.warn ? 'warn' : ''}" style="width:${Math.min(st.pct, 100)}%"></div></div>` : ''}
        <h3 style="margin-top:18px;">Стоимость проекта</h3>
        <div class="detail-grid">
            <div class="dl"><span>Прямые расходы</span><b>${Utils.formatMoneyCents(direct, cur)}</b></div>
            <div class="dl"><span>Стоимость труда</span><b>${Utils.formatMoneyCents(labor, cur)}</b></div>
            <div class="dl"><span>Итого</span><b>${Utils.formatMoneyCents(total, cur)}</b></div>
        </div>
        ${overHtml}
        ${p.desc ? `<p style="margin-top:15px;color:var(--secondary);font-size:13px;">${Utils.escapeHtml(p.desc)}</p>` : ''}
        ${stagesHtml}
        ${tasksHtml}
        ${wAssign ? `<h3 style="margin-top:18px;">Работники на проекте</h3><div class="table-wrapper"><table><thead><tr><th>Работник</th><th>Часы</th><th>Заработано</th><th>Открытых задач</th></tr></thead><tbody>${wAssign}</tbody></table></div>` : ''}
        <h3 style="margin-top:20px;">Расходы по категориям</h3>
        <div class="table-wrapper"><table><thead><tr><th>Категория</th><th>Сумма</th></tr></thead><tbody>${catRows || '<tr><td colspan="2" style="text-align:center;color:var(--secondary)">Нет расходов</td></tr>'}</tbody></table></div>`,
        `<button class="secondary" data-modal-close>Закрыть</button>`);
}

function openStageForm(params) {
    const existing = params && params.id ? Store.data.stages.find(x => Utils.eq(x.id, params.id)) : null;
    const pid = existing ? existing.projectId : params.projectId;
    const p = Store.getProject(pid);
    if (!p) return;
    const statusOpts = CONFIG.STAGE_STATUSES.map(s => `<option ${existing && existing.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('');
    UI.openModal(existing ? 'Редактировать этап' : 'Добавить этап',
        `<div class="group-field"><label>Название *</label><input id="sgName" value="${existing ? Utils.escapeHtml(existing.name) : ''}"></div>
         <div class="group-field"><label>Статус</label><select id="sgStatus">${statusOpts}</select></div>
         <div class="group-field"><label>Описание</label><input id="sgDesc" value="${existing ? Utils.escapeHtml(existing.description || '') : ''}"></div>
         <div class="group-field"><label>Дата начала</label><input id="sgStart" type="date" value="${Utils.escapeHtml(existing ? existing.startDate || '' : '')}"></div>
         <div class="group-field"><label>Дата окончания</label><input id="sgEnd" type="date" value="${Utils.escapeHtml(existing ? existing.endDate || '' : '')}"></div>`,
        modalActionsHTML());
    wireModal(() => {
        const name = document.getElementById('sgName').value.trim();
        if (!name) { UI.toast('Введите название этапа', 'error'); return false; }
        const startDate = document.getElementById('sgStart').value || '';
        const endDate = document.getElementById('sgEnd').value || '';
        if (startDate && endDate && !Utils.validateDateRange(startDate, endDate)) { UI.toast('Дата начала этапа не может быть позже даты окончания', 'error'); return false; }
        const payload = {
            name,
            status: document.getElementById('sgStatus').value,
            description: document.getElementById('sgDesc').value.trim(),
            startDate,
            endDate
        };
        if (existing) Store.updateStage(existing.id, payload);
        else Store.addStage({ projectId: pid, ...payload });
        UI.toast(existing ? 'Этап обновлён' : 'Этап добавлен');
        openProjectDetail(pid);
        renderAll();
        return true;
    });
}

function openTaskForm(params) {
    const existing = params && params.id ? Store.data.tasks.find(x => Utils.eq(x.id, params.id)) : null;
    const pid = existing ? existing.projectId : params.projectId;
    const p = Store.getProject(pid);
    if (!p) return;
    const stages = Store.stagesOfProject(pid).filter(s => s.status !== 'archived');
    const stageOpts = '<option value="">— без этапа —</option>' + stages.map(s => `<option ${existing && Utils.eq(existing.stageId, s.id) ? 'selected' : ''} value="${Utils.escapeHtml(s.id)}">${Utils.escapeHtml(s.name)}</option>`).join('');
    const statusOpts = CONFIG.TASK_STATUSES.map(s => `<option ${existing && existing.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('');
    const priOpts = CONFIG.TASK_PRIORITIES.map(x => `<option ${(existing ? existing.priority === x : x === 'NORMAL') ? 'selected' : ''} value="${x}">${x}</option>`).join('');
    const workerOpts = Store.data.workers.map(w => `<label class="checkbox-row" style="justify-content:flex-start;gap:8px;font-weight:normal"><input type="checkbox" class="tk-wk" value="${Utils.escapeHtml(w.id)}" ${existing && (existing.workerIds || []).includes(String(w.id)) ? 'checked' : ''}> <span>${Utils.escapeHtml(w.name)}${w.active ? '' : ' (арх)'}</span></label>`).join('');
    UI.openModal(existing ? 'Редактировать задачу' : 'Добавить задачу',
        `<div class="group-field"><label>Название *</label><input id="tkTitle" value="${existing ? Utils.escapeHtml(existing.title) : ''}"></div>
         <div class="group-field"><label>Этап</label><select id="tkStage">${stageOpts}</select></div>
         <div class="group-field"><label>Статус</label><select id="tkStatus">${statusOpts}</select></div>
         <div class="group-field"><label>Приоритет</label><select id="tkPriority">${priOpts}</select></div>
         <div class="group-field"><label>Дедлайн</label><input id="tkDue" type="date" value="${Utils.escapeHtml(existing ? existing.dueDate || '' : '')}"></div>
         <div class="group-field"><label>Описание</label><input id="tkDesc" value="${Utils.escapeHtml(existing ? existing.description || '' : '')}"></div>
         ${workerOpts ? `<div class="group-field"><label>Исполнители</label>${workerOpts}</div>` : '<div class="group-field"><small>Нет работников. Сначала добавьте работников.</small></div>'}`,
        modalActionsHTML());
    wireModal(() => {
        const title = document.getElementById('tkTitle').value.trim();
        if (!title) { UI.toast('Введите название задачи', 'error'); return false; }
        const dueDate = document.getElementById('tkDue').value || '';
        const workerIds = [...document.querySelectorAll('.tk-wk:checked')].map(cb => cb.value);
        const payload = {
            title,
            stageId: document.getElementById('tkStage').value,
            status: document.getElementById('tkStatus').value,
            priority: document.getElementById('tkPriority').value,
            dueDate,
            description: document.getElementById('tkDesc').value.trim(),
            workerIds
        };
        if (existing) Store.updateTask(existing.id, payload);
        else Store.addTask({ projectId: pid, ...payload });
        UI.toast(existing ? 'Задача обновлена' : 'Задача добавлена');
        openProjectDetail(pid);
        renderAll();
        return true;
    });
}

function addWorkerForm() {
    const name = document.getElementById('workerName').value.trim();
    if (!name) { UI.toast('Введите ФИО работника', 'error'); return; }
    Store.addWorker({
        name,
        phone: document.getElementById('workerPhone').value,
        position: document.getElementById('workerPosition').value,
        rate: Utils.cents(document.getElementById('workerRate').value) / 100,
        schedule: document.getElementById('workerSchedule').value
    });
    document.getElementById('workerName').value = '';
    renderAll();
    UI.toast('Работник добавлен');
}

function openEditWorker(id) {
    const w = Store.getWorker(id);
    if (!w) return;
    UI.openModal('Редактировать работника',
        `<div class="group-field"><label>ФИО *</label><input id="wName" value="${Utils.escapeHtml(w.name)}"></div>
         <div class="group-field"><label>Телефон</label><input id="wPhone" value="${Utils.escapeHtml(w.phone || '')}"></div>
         <div class="group-field"><label>Должность</label><input id="wPosition" value="${Utils.escapeHtml(w.position || '')}"></div>
         <div class="group-field"><label>Ставка (руб/час)</label><input id="wRate" type="number" min="0" step="0.01" value="${w.rate}"></div>
         <div class="group-field"><label>График</label><select id="wSchedule">${['full', 'part', 'project'].map(s => `<option ${w.schedule === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select></div>`,
        modalActionsHTML());
    wireModal(() => {
        const name = document.getElementById('wName').value.trim();
        if (!name) { UI.toast('Введите ФИО работника', 'error'); return false; }
        Store.updateWorker(id, {
            name,
            phone: document.getElementById('wPhone').value,
            position: document.getElementById('wPosition').value,
            rate: Utils.cents(document.getElementById('wRate').value) / 100,
            schedule: document.getElementById('wSchedule').value
        });
        UI.toast('Работник обновлён');
        renderAll();
        return true;
    });
}

function openWorkerDetail(id) {
    const w = Store.getWorker(id);
    if (!w) return;
    const earned = Calc.workerEarnedCents(id);
    const paid = Calc.workerPaidCents(id);
    const debt = earned - paid;
    const hours = Calc.workerHours(id);
    const cur = Store.settings().currency;
    const projIds = new Set();
    Store.data.expenses.forEach(e => { if ((e.workers || []).includes(String(id)) && e.projectId) projIds.add(String(e.projectId)); });
    Store.data.timeEntries.forEach(t => { if (Utils.eq(t.workerId, id) && t.projectId) projIds.add(String(t.projectId)); });
    const projNames = [...projIds].map(pid => { const p = Store.getProject(pid); return p ? p.name : ''; }).filter(Boolean);
    const ops = [];
    Store.data.expenses.forEach(e => {
        if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) return;
        if (!(e.workers || []).includes(String(id))) return;
        const share = Utils.toRub(Calc.expenseWorkerShareCents(e, id));
        ops.push({ date: e.date, text: (CONFIG.CATEGORIES[e.category] || e.category) + ' ' + Utils.formatMoney(share, cur), type: 'paid' });
    });
    Store.data.timeEntries.forEach(t => {
        if (!Utils.eq(t.workerId, id)) return;
        ops.push({ date: t.date, text: t.hours + ' ч × ' + Utils.formatMoney(w.rate, cur), type: 'earned' });
    });
    ops.sort((a, b) => (a.date < b.date ? -1 : 1)).reverse();
    const opsHtml = ops.slice(0, 10).map(o => `<tr><td>${Utils.escapeHtml(Utils.formatDate(o.date))}</td><td>${Utils.escapeHtml(o.text)}</td></tr>`).join('');

    UI.openModal('Работник: ' + w.name,
        `<div class="detail-grid">
            <div class="dl"><span>Ставка</span><b>${Utils.formatMoney(w.rate, cur)}/ч</b></div>
            <div class="dl"><span>Статус</span><b>${w.active ? 'Активен' : 'Архив'}</b></div>
            <div class="dl"><span>Часы</span><b>${hours}</b></div>
            <div class="dl"><span>Заработано</span><b>${Utils.formatMoneyCents(earned, cur)}</b></div>
            <div class="dl"><span>Выплачено</span><b>${Utils.formatMoneyCents(paid, cur)}</b></div>
            <div class="dl"><span>Долг</span><b style="color:${debt > 0 ? 'var(--danger)' : debt < 0 ? 'var(--success)' : 'inherit'}">${debt < 0 ? 'Переплата: ' + Utils.formatMoneyCents(Math.abs(debt), cur) : Utils.formatMoneyCents(debt, cur)}</b></div>
        </div>
        ${w.phone ? `<p style="margin-top:12px"><span class="pill">📞 ${Utils.escapeHtml(w.phone)}</span></p>` : ''}
        ${w.position ? `<p><span class="pill">🛠 ${Utils.escapeHtml(w.position)}</span></p>` : ''}
        ${projNames.length ? `<p style="margin-top:12px;font-size:13px;color:var(--secondary)">Проекты: ${Utils.escapeHtml(projNames.join(', '))}</p>` : ''}
        <h3 style="margin-top:20px;">Последние операции</h3>
        <div class="table-wrapper"><table><thead><tr><th>Дата</th><th>Операция</th></tr></thead><tbody>${opsHtml || '<tr><td colspan="2" style="text-align:center;color:var(--secondary)">Нет операций</td></tr>'}</tbody></table></div>`,
        `<button class="secondary" data-modal-close>Закрыть</button>`);
}

function collectSplitsFromForm() {
    const workers = [];
    const splits = {};
    let splitSumCents = 0;
    let hasAmounts = false;
    document.querySelectorAll('.split-row .ws-cb:checked').forEach(cb => {
        const wid = cb.value;
        workers.push(wid);
        const v = parseFloat(document.querySelector(`.ws-am[data-wid="${CSS.escape(wid)}"]`).value) || 0;
        if (v > 0) { splits[wid] = v; splitSumCents += Utils.cents(v); hasAmounts = true; }
        else splits[wid] = null;
    });
    return { workers, splits, splitSumCents, hasAmounts };
}

function addExpense() {
    const pid = document.getElementById('expenseProject').value;
    const amt = parseFloat(document.getElementById('expenseAmount').value);
    if (!pid) { UI.toast('Выберите проект', 'error'); return; }
    if (!Utils.validateAmount(amt)) { UI.toast('Введите корректную сумму (больше нуля)', 'error'); return; }
    const date = document.getElementById('expenseDate').value || Utils.todayStr();
    if (!Utils.validateDate(date)) { UI.toast('Укажите корректную дату', 'error'); return; }

    const category = document.getElementById('expenseCategory').value;
    const { workers, splits, splitSumCents } = collectSplitsFromForm();

    // P0: salary/advance without worker is forbidden.
    if (CONFIG.PAYMENT_CATEGORIES.includes(category) && workers.length === 0) {
        UI.toast('Для выплаты (зарплата/аванс) необходимо выбрать хотя бы одного работника', 'error');
        return;
    }

    const amtCents = Utils.cents(amt);

    let splitsCents = null;
    if (workers.length) {
        const r = Utils.computeSplitsCents(workers, splits, amtCents);
        if (r.error) {
            UI.toast(r.error === 'over' ? 'Сумма долей работников превышает общую сумму' : 'Сумма долей не совпадает с общей суммой', 'error');
            return;
        }
        splitsCents = r.splitsCents;
    }
    const splitsRub = splitsCents ? Object.fromEntries(Object.entries(splitsCents).map(([k, c]) => [k, Utils.toRub(c)])) : null;

    Store.addExpense({
        projectId: String(pid),
        category: category,
        amount: Utils.toRub(amtCents),
        date,
        desc: document.getElementById('expenseDesc').value,
        workers,
        splits: splitsRub
    });

    const proj = Store.getProject(pid);
    if (proj) {
        const st = Calc.projectStats(proj.id);
        if (st.over && Store.settings().notifyBudget) UI.toast(`Бюджет проекта «${proj.name}» превышен!`, 'warning');
        else if (st.warn && Store.settings().notifyBudget) UI.toast(`Проект «${proj.name}»: использовано ${st.pct.toFixed(0)}% бюджета`, 'info');
    }

    document.getElementById('expenseAmount').value = '';
    document.getElementById('expenseDesc').value = '';
    renderAll();
    UI.toast('Операция добавлена');
}

function openEditExpense(id) {
    const e = Store.data.expenses.find(x => Utils.eq(x.id, id));
    if (!e) return;
    UI.openModal('Редактировать операцию',
        `<div class="group-field"><label>Проект *</label><select id="eProject">${Store.data.projects.map(p => `<option ${Utils.eq(p.id, e.projectId) ? 'selected' : ''} value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Категория *</label><select id="eCategory">${Object.entries(CONFIG.CATEGORIES).map(([k, v]) => `<option ${e.category === k ? 'selected' : ''} value="${k}">${Utils.escapeHtml(v)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Сумма *</label><input id="eAmount" type="number" min="0" step="0.01" value="${e.amount}"></div>
         <div class="group-field"><label>Дата *</label><input id="eDate" type="date" value="${Utils.escapeHtml(e.date || Utils.todayStr())}"></div>
         <div class="group-field"><label>Описание</label><input id="eDesc" value="${Utils.escapeHtml(e.desc || '')}"></div>
         <div class="group-field"><label>Распределение по работникам</label><div id="eSplits"></div></div>`,
        modalActionsHTML());
    renderSplitForm(document.getElementById('eSplits'), e);
    document.getElementById('eAmount').addEventListener('input', () => renderSplitSharesFor('eSplits'));

    wireModal(() => {
        const amt = parseFloat(document.getElementById('eAmount').value);
        if (!Utils.validateAmount(amt)) { UI.toast('Введите корректную сумму', 'error'); return false; }
        const date = document.getElementById('eDate').value || Utils.todayStr();
        if (!Utils.validateDate(date)) { UI.toast('Укажите корректную дату', 'error'); return false; }
        const category = document.getElementById('eCategory').value;
        const { workers, splits } = collectSplitsFromModal('eSplits');
        // P0: salary/advance without worker is forbidden in edit too.
        if (CONFIG.PAYMENT_CATEGORIES.includes(category) && workers.length === 0) {
            UI.toast('Для выплаты (зарплата/аванс) необходимо выбрать хотя бы одного работника', 'error');
            return false;
        }
        let splitsCents = null;
        if (workers.length) {
            const r = Utils.computeSplitsCents(workers, splits, Utils.cents(amt));
            if (r.error) { UI.toast(r.error === 'over' ? 'Сумма долей превышает общую сумму' : 'Сумма долей не совпадает с общей суммой', 'error'); return false; }
            splitsCents = r.splitsCents;
        }
        const splitsRub = splitsCents ? Object.fromEntries(Object.entries(splitsCents).map(([k, c]) => [k, Utils.toRub(c)])) : null;
        Store.updateExpense(id, {
            projectId: document.getElementById('eProject').value,
            category: category,
            amount: Utils.toRub(Utils.cents(amt)),
            date,
            desc: document.getElementById('eDesc').value,
            workers,
            splits: splitsRub
        });
        UI.toast('Операция обновлена');
        renderAll();
        return true;
    });
}

function renderSplitSharesFor(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const amt = parseFloat((containerId === 'eSplits' ? document.getElementById('eAmount') : document.getElementById('expenseAmount')).value) || 0;
    container.querySelectorAll('.split-row').forEach(row => {
        const cb = row.querySelector('.ws-cb');
        const inp = row.querySelector('.ws-am');
        const share = row.querySelector('.share');
        if (!cb || !cb.checked) return;
        const v = parseFloat(inp.value) || 0;
        share.textContent = v > 0 ? (v / (amt || 1) * 100).toFixed(0) + '%' : 'равно';
    });
}

function collectSplitsFromModal(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return { workers: [], splits: {} };
    const workers = [];
    const splits = {};
    const checked = container.querySelectorAll('.split-row .ws-cb:checked');
    checked.forEach(cb => {
        const wid = cb.value;
        workers.push(wid);
        const inp = container.querySelector(`.ws-am[data-wid="${CSS.escape(wid)}"]`);
        const v = parseFloat(inp ? inp.value : '') || 0;
        splits[wid] = v > 0 ? v : null;
    });
    return { workers, splits };
}

function addTimeEntry() {
    const wid = document.getElementById('timeWorker').value;
    const pid = document.getElementById('timeProject').value;
    const hrs = parseFloat(document.getElementById('timeHours').value);
    if (!wid) { UI.toast('Выберите работника', 'error'); return; }
    if (!pid) { UI.toast('Выберите проект', 'error'); return; }
    if (!Utils.validateHours(hrs)) { UI.toast('Количество часов некорректно (0 – ' + Store.settings().maxHoursPerDay + ')', 'error'); return; }
    const date = document.getElementById('timeDate').value || Utils.todayStr();
    if (!Utils.validateDate(date)) { UI.toast('Укажите корректную дату', 'error'); return; }

    Store.addTimeEntry({
        workerId: String(wid),
        projectId: String(pid),
        date,
        hours: hrs,
        type: document.getElementById('timeType').value,
        comment: document.getElementById('timeComment').value
    });
    document.getElementById('timeHours').value = '';
    document.getElementById('timeComment').value = '';
    renderAll();
    UI.toast('Время учтено');
}

function openEditTime(id) {
    const t = Store.data.timeEntries.find(x => Utils.eq(x.id, id));
    if (!t) return;
    UI.openModal('Редактировать запись времени',
        `<div class="group-field"><label>Работник *</label><select id="tWorker">${Store.data.workers.map(w => `<option ${Utils.eq(w.id, t.workerId) ? 'selected' : ''} value="${Utils.escapeHtml(w.id)}">${Utils.escapeHtml(w.name)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Проект *</label><select id="tProject">${Store.data.projects.map(p => `<option ${Utils.eq(p.id, t.projectId) ? 'selected' : ''} value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Дата *</label><input id="tDate" type="date" value="${Utils.escapeHtml(t.date || Utils.todayStr())}"></div>
         <div class="group-field"><label>Часы</label><input id="tHours" type="number" min="0" step="0.5" value="${t.hours}"></div>
         <div class="group-field"><label>Тип</label><select id="tType">${['regular', 'overtime', 'weekend'].map(x => `<option ${t.type === x ? 'selected' : ''} value="${x}">${x}</option>`).join('')}</select></div>
         <div class="group-field"><label>Комментарий</label><input id="tComment" value="${Utils.escapeHtml(t.comment || '')}"></div>`,
        modalActionsHTML());
    wireModal(() => {
        const hrs = parseFloat(document.getElementById('tHours').value);
        if (!Utils.validateHours(hrs)) { UI.toast('Количество часов некорректно', 'error'); return false; }
        const date = document.getElementById('tDate').value || Utils.todayStr();
        if (!Utils.validateDate(date)) { UI.toast('Укажите корректную дату', 'error'); return false; }
        Store.updateTimeEntry(id, {
            workerId: document.getElementById('tWorker').value,
            projectId: document.getElementById('tProject').value,
            date,
            hours: hrs,
            type: document.getElementById('tType').value,
            comment: document.getElementById('tComment').value
        });
        UI.toast('Запись обновлена');
        renderAll();
        return true;
    });
}

function addTemplateForm() {
    const name = document.getElementById('templateName').value.trim();
    if (!name) { UI.toast('Введите название шаблона', 'error'); return; }
    Store.addTemplate({
        name,
        category: document.getElementById('templateCategory').value,
        amount: Utils.cents(document.getElementById('templateAmount').value) / 100,
        projectId: document.getElementById('templateProject').value,
        desc: document.getElementById('templateDesc').value
    });
    document.getElementById('templateName').value = '';
    renderAll();
    UI.toast('Шаблон сохранён');
}

function openEditTemplate(id) {
    const t = Store.data.templates.find(x => Utils.eq(x.id, id));
    if (!t) return;
    UI.openModal('Редактировать шаблон',
        `<div class="group-field"><label>Название *</label><input id="tpName" value="${Utils.escapeHtml(t.name)}"></div>
         <div class="group-field"><label>Категория</label><select id="tpCategory">${Object.entries(CONFIG.CATEGORIES).map(([k, v]) => `<option ${t.category === k ? 'selected' : ''} value="${k}">${Utils.escapeHtml(v)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Сумма</label><input id="tpAmount" type="number" min="0" step="0.01" value="${t.amount}"></div>
         <div class="group-field"><label>Проект</label><select id="tpProject">${Store.data.projects.map(p => `<option ${Utils.eq(p.id, t.projectId) ? 'selected' : ''} value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('')}</select></div>
         <div class="group-field"><label>Описание</label><input id="tpDesc" value="${Utils.escapeHtml(t.desc || '')}"></div>`,
        modalActionsHTML());
    wireModal(() => {
        const name = document.getElementById('tpName').value.trim();
        if (!name) { UI.toast('Введите название шаблона', 'error'); return false; }
        Store.updateTemplate(id, {
            name,
            category: document.getElementById('tpCategory').value,
            amount: Utils.cents(document.getElementById('tpAmount').value) / 100,
            projectId: document.getElementById('tpProject').value,
            desc: document.getElementById('tpDesc').value
        });
        UI.toast('Шаблон обновлён');
        renderAll();
        return true;
    });
}

function applyTemplate(id) {
    const t = Store.data.templates.find(x => Utils.eq(x.id, id));
    if (!t) return;
    UI.tab('expenses');
    document.getElementById('expenseProject').value = t.projectId || '';
    document.getElementById('expenseCategory').value = CONFIG.CATEGORIES[t.category] ? t.category : 'other';
    document.getElementById('expenseAmount').value = t.amount;
    document.getElementById('expenseDesc').value = t.desc || t.name;
    UI.toast('Шаблон загружен в форму', 'info');
}

// V5: Payroll payment creation — goes through existing expense model
function openPayrollPayment(workerId) {
    const w = Store.getWorker(workerId);
    if (!w) return;
    const debt = Calc.workerDebtCents(workerId);
    const cur = Store.settings().currency;
    const activeProjects = Store.activeProjects();
    UI.openModal('Выплата: ' + w.name,
        `<div class="group-field"><label>Проект *</label><select id="payProject">${activeProjects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('') || '<option value="">Нет активных проектов</option>'}</select></div>
         <div class="group-field"><label>Тип выплаты</label><select id="payType"><option value="advance">Аванс</option><option value="salary">Зарплата</option></select></div>
         <div class="group-field"><label>Сумма *</label><input id="payAmount" type="number" min="0" step="0.01" value="${debt > 0 ? Utils.toRub(debt).toFixed(2) : ''}" placeholder="0"></div>
         <div class="group-field"><label>Дата</label><input id="payDate" type="date" value="${Utils.todayStr()}"></div>
         <div style="font-size:13px;color:var(--secondary);margin-bottom:10px;">Долг работника: ${Utils.formatMoneyCents(debt, cur)}</div>`,
        modalActionsHTML());
    wireModal(() => {
        const pid = document.getElementById('payProject').value;
        const amt = parseFloat(document.getElementById('payAmount').value);
        if (!pid) { UI.toast('Выберите проект', 'error'); return false; }
        if (!Utils.validateAmount(amt)) { UI.toast('Введите корректную сумму', 'error'); return false; }
        const date = document.getElementById('payDate').value || Utils.todayStr();
        if (!Utils.validateDate(date)) { UI.toast('Укажите корректную дату', 'error'); return false; }
        const payType = document.getElementById('payType').value;
        Store.addExpense({
            projectId: String(pid),
            category: payType,
            amount: Utils.toRub(Utils.cents(amt)),
            date,
            desc: (payType === 'advance' ? 'Аванс' : 'Зарплата') + ': ' + w.name,
            workers: [String(workerId)],
            splits: { [String(workerId)]: Utils.toRub(Utils.cents(amt)) }
        });
        UI.toast('Выплата добавлена', 'success');
        renderAll();
        return true;
    });
}

// V5: Data Health
function runDataHealth() {
    const report = Validation.healthReport();
    const el = document.getElementById('dataHealthResult');
    if (!el) return;
    const c = report.counts;
    const countsHtml = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:15px;">
        ${Object.entries(c).map(([k, v]) => `<div class="a-card"><div class="a-label">${k}</div><div class="a-value">${v}</div></div>`).join('')}
    </div>`;
    const errs = report.errors || [];
    const warns = report.warnings || [];
    const alerts = report.alerts || [];
    const statusClass = errs.length === 0 ? (warns.length === 0 && alerts.length === 0 ? 'data-health-ok' : 'data-health-warn') : 'data-health-err';
    const statusText = errs.length === 0
        ? (warns.length === 0 && alerts.length === 0 ? '✓ Данные корректны, проблем не найдено' : `Ошибок: ${errs.length} · Предупреждений: ${warns.length} · Уведомлений: ${alerts.length}`)
        : `Ошибок: ${errs.length} · Предупреждений: ${warns.length} · Уведомлений: ${alerts.length}`;
    const sectionHtml = (title, items, cls) => items.length
        ? `<div class="data-health-list"><h4 style="margin:10px 0 5px;color:var(--${cls})">${title}: ${items.length}</h4><ul>${items.map(x => `<li>${Utils.escapeHtml(x)}</li>`).join('')}</ul></div>`
        : '';
    const problemsHtml = sectionHtml('Ошибки', errs, 'danger') + sectionHtml('Предупреждения', warns, 'warning') + sectionHtml('Бизнес-уведомления', alerts, 'secondary');
    el.innerHTML = countsHtml + `<div class="${statusClass}">${statusText}</div>` + problemsHtml;
}

// V5: Global Search
function setupGlobalSearch() {
    const input = document.getElementById('globalSearch');
    const results = document.getElementById('globalSearchResults');
    if (!input || !results) return;
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => doGlobalSearch(input.value, results), 150);
    });
    input.addEventListener('focus', () => { if (input.value) doGlobalSearch(input.value, results); });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.global-search-wrapper')) results.classList.remove('active');
    });
}

function doGlobalSearch(query, resultsEl) {
    if (!query || query.length < 2) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    const q = query.toLowerCase();
    const groups = [];
    const add = (group, items) => { if (items.length) groups.push({ group, items }); };

    add('Проекты', Store.data.projects.filter(p => p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q)).slice(0, 5)
        .map(p => ({ label: p.name, sub: p.status, action: () => { UI.tab('projects'); openProjectDetail(p.id); } })));
    add('Работники', Store.data.workers.filter(w => w.name.toLowerCase().includes(q) || (w.position || '').toLowerCase().includes(q)).slice(0, 5)
        .map(w => ({ label: w.name, sub: w.position || '', action: () => { UI.tab('workers'); openWorkerDetail(w.id); } })));
    add('Расходы', Store.data.expenses.filter(e => (e.desc || '').toLowerCase().includes(q)).slice(0, 5)
        .map(e => { const p = Store.getProject(e.projectId); return { label: Utils.formatMoney(e.amount) + ' — ' + (p ? p.name : '?'), sub: CONFIG.CATEGORIES[e.category] || e.category, action: () => { UI.tab('expenses'); openEditExpense(e.id); } }; }));
    add('Задачи', Store.data.tasks.filter(t => t.title.toLowerCase().includes(q)).slice(0, 5)
        .map(t => { const p = Store.getProject(t.projectId); return { label: t.title, sub: (p ? p.name : '?') + ' · ' + t.status, action: () => { UI.tab('tasks'); openTaskForm({ id: t.id, projectId: t.projectId }); } }; }));
    add('Этапы', Store.data.stages.filter(s => s.name.toLowerCase().includes(q)).slice(0, 5)
        .map(s => { const p = Store.getProject(s.projectId); return { label: s.name, sub: p ? p.name : '?', action: () => { UI.tab('projects'); openProjectDetail(s.projectId); } }; }));
    add('Записи времени', Store.data.timeEntries.filter(t => (t.comment || '').toLowerCase().includes(q)).slice(0, 5)
        .map(t => { const w = Store.getWorker(t.workerId); return { label: (w ? w.name : '?') + ' — ' + t.hours + 'ч', sub: Utils.formatDate(t.date), action: () => { UI.tab('timetracking'); openEditTime(t.id); } }; }));
    add('Шаблоны', Store.data.templates.filter(t => t.name.toLowerCase().includes(q)).slice(0, 5)
        .map(t => ({ label: t.name, sub: CONFIG.CATEGORIES[t.category] || t.category, action: () => { UI.tab('templates'); openEditTemplate(t.id); } })));

    if (!groups.length) {
        resultsEl.innerHTML = '<div class="gs-empty">Ничего не найдено</div>';
    } else {
        resultsEl.innerHTML = groups.map(g =>
            `<div class="gs-group">${Utils.escapeHtml(g.group)}</div>` +
            g.items.map((item, i) => `<div class="gs-item" data-gs-idx="${i}" data-gs-group="${Utils.escapeHtml(g.group)}">${Utils.escapeHtml(item.label)} <span style="color:var(--secondary);font-size:11px">${Utils.escapeHtml(item.sub)}</span></div>`).join('')
        ).join('');
        resultsEl.querySelectorAll('.gs-item').forEach((el, idx) => {
            el.onclick = () => {
                let count = 0;
                for (const g of groups) {
                    for (const item of g.items) {
                        if (count === idx) { item.action(); break; }
                        count++;
                    }
                }
                resultsEl.classList.remove('active');
                input.value = '';
            };
        });
    }
    resultsEl.classList.add('active');
}

// ---------------- 15. Events wiring ----------------
function wireModal(onSubmit) {
    const ov = document.getElementById('modalOverlay');
    ov.querySelector('[data-modal-submit]').onclick = () => { if (onSubmit()) UI.closeModal(); };
    ov.querySelector('[data-modal-close]').onclick = () => UI.closeModal();
}

function renderAll() {
    const active = document.querySelector('.tab-content.active');
    if (active && Render[active.id]) Render[active.id]();
    if (['expenses', 'timetracking', 'templates'].includes(active && active.id)) {
        updateExpenseForm(); updateTimeForm(); updateTemplateForm();
    }
}

function updateTimeForm() {
    const activeWorkers = Store.activeWorkers();
    document.getElementById('timeWorker').innerHTML = activeWorkers.length
        ? activeWorkers.map(w => `<option value="${Utils.escapeHtml(w.id)}">${Utils.escapeHtml(w.name)}</option>`).join('')
        : '<option value="">Нет работников</option>';
    const activeProjects = Store.activeProjects();
    document.getElementById('timeProject').innerHTML = activeProjects.length
        ? activeProjects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('')
        : '<option value="">Нет проектов</option>';
}

function updateTemplateForm() {
    const activeProjects = Store.activeProjects();
    document.getElementById('templateProject').innerHTML = activeProjects.length
        ? activeProjects.map(p => `<option value="${Utils.escapeHtml(p.id)}">${Utils.escapeHtml(p.name)}</option>`).join('')
        : '';
}

function saveSettingsFromInputs() {
    const s = Store.settings();
    const cur = document.getElementById('setCurrency').value;
    const newCur = CONFIG.CURRENCIES.includes(cur) ? cur : 'RUB';
    const hasFinancialData = Store.data.expenses.length > 0 || Store.data.timeEntries.length > 0;
    if (newCur !== s.currency && hasFinancialData) {
        UI.toast('В базе уже есть финансовые данные. Смена валюты изменит только единицу отображения, но не пересчитает суммы.', 'warning');
    }
    s.currency = newCur;
    s.budgetWarningPercent = Math.max(1, Math.min(100, parseFloat(document.getElementById('setBudgetWarn').value) || 80));
    s.maxHoursPerDay = Math.max(1, Math.min(168, parseFloat(document.getElementById('setMaxHours').value) || 24));
    s.notifyBudget = document.getElementById('notifyBudgetOver').checked;
    s.notifyDebt = document.getElementById('notifyLowBalance').checked;
    Store.log('settings', 'update', 'Настройки изменены');
    Store.save();
    UI.toast('Настройки сохранены');
}

function loadTemplateToForm() {
    if (!Store.data.templates.length) { UI.toast('Шаблонов пока нет', 'info'); return; }
    const cur = Store.settings().currency;
    const rows = Store.data.templates.map(t =>
        `<div class="template-card" data-pick-template="${Utils.escapeHtml(t.id)}">
            <b>${Utils.escapeHtml(t.name)}</b> <span class="pill">${Utils.escapeHtml(CONFIG.CATEGORIES[t.category] || t.category)}</span>
            <div style="margin-top:4px;font-weight:bold">${Utils.formatMoney(t.amount, cur)}</div>
        </div>`).join('');
    UI.openModal('Выберите шаблон', rows, `<button class="secondary" data-modal-close>Отмена</button>`);
    document.querySelectorAll('[data-pick-template]').forEach(el => {
        el.onclick = () => { applyTemplate(el.dataset.pickTemplate); UI.closeModal(); };
    });
}

function confirmDeleteExpense(id) {
    const e = Store.data.expenses.find(x => Utils.eq(x.id, id));
    UI.confirm('Удалить операцию?', `Операция на сумму ${Utils.formatMoney(e ? e.amount : 0)} будет удалена. Это действие нельзя отменить.`, () => {
        Store.deleteExpense(id);
        renderAll();
        UI.toast('Операция удалена');
    });
}

function confirmDeleteTime(id) {
    UI.confirm('Удалить запись времени?', 'Запись учёта времени будет удалена.', () => {
        Store.deleteTimeEntry(id);
        renderAll();
        UI.toast('Запись удалена');
    });
}

function confirmDeleteTemplate(id) {
    UI.confirm('Удалить шаблон?', 'Шаблон будет удалён из списка.', () => {
        Store.deleteTemplate(id);
        renderAll();
        UI.toast('Шаблон удалён');
    });
}

function confirmArchiveProject(id) {
    const p = Store.getProject(id);
    UI.confirm('Архивировать проект?', `Проект «${p ? p.name : ''}» будет перемещён в архив. Все связанные расходы и история сохранятся.`, () => {
        Store.archiveProject(id);
        renderAll();
        UI.toast('Проект архивирован. История сохранена.', 'info');
    }, false);
}

function confirmArchiveWorker(id) {
    const w = Store.getWorker(id);
    UI.confirm('Архивировать работника?', `Работник «${w ? w.name : ''}» будет перемещён в архив. Все его операции и история сохранятся.`, () => {
        Store.archiveWorker(id);
        renderAll();
        UI.toast('Работник архивирован. История сохранена.', 'info');
    }, false);
}

function confirmClearAll() {
    UI.confirm('Очистить ВСЕ данные?',
        'Будут удалены все проекты, работники, расходы, записи времени и шаблоны. Перед очисткой будет создана резервная копия текущих данных (её можно восстановить кнопкой автокопии). Действие необратимо.',
        () => {
            const auto = Backup.create();
            if (!auto) { UI.toast('Создание автокопии не удалось — очистка отменена.', 'error'); return; }
            Store.data = Validation.normalizeData({});
            Storage.write(Storage._serialize(Store.data), true);
            Store.log('system', 'clear_data', `Все данные очищены. Автокопия: ${auto.timestamp.slice(0, 16)}`);
            Store.save();
            UI.toast('Все данные удалены. Автокопия: ' + auto.timestamp.slice(0, 16).replace('T', ' '), 'info');
            renderAll();
        });
}

function setupEvents() {
    document.getElementById('mainTabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (tab) UI.tab(tab.dataset.tab);
    });

    document.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn && actionBtn.dataset.action && ACTIONS[actionBtn.dataset.action]) {
            e.preventDefault();
            ACTIONS[actionBtn.dataset.action]();
            return;
        }

        const scoped = e.target.closest('[data-edit-project],[data-edit-worker],[data-edit-expense],[data-edit-time],[data-edit-template],' +
            '[data-detail-project],[data-detail-worker],[data-archive-project],[data-restore-project],' +
            '[data-archive-worker],[data-restore-worker],[data-del-expense],[data-del-time],[data-del-template],' +
            '[data-dup-expense],[data-apply-template],[data-cal-date],' +
            '[data-stage-add],[data-stage-edit],[data-stage-move],[data-stage-status],' +
            '[data-task-add],[data-task-edit],[data-task-del],[data-task-status],' +
            '[data-pay-worker]');
        if (scoped) {
            e.preventDefault();
            handleScoped(scoped);
        }
    });

    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target.id === 'modalOverlay') UI.closeModal();
    });

    document.addEventListener('change', (e) => {
        if (e.target.classList && e.target.classList.contains('ws-cb')) {
            const inp = e.target.closest('.split-row').querySelector('.ws-am');
            inp.disabled = !e.target.checked;
            if (!e.target.checked) { inp.value = ''; }
            renderSplitSharesFor(e.target.closest('.split-container').id || 'expenseWorkersSplit');
        } else if (e.target.dataset && e.target.dataset.taskToggle) {
            const t = Store.data.tasks.find(x => Utils.eq(x.id, e.target.dataset.taskToggle));
            Store.setTaskStatus(e.target.dataset.taskToggle, e.target.checked ? 'DONE' : 'TODO');
            if (t && document.getElementById('modalOverlay').classList.contains('active')) openProjectDetail(t.projectId);
            renderAll();
        }
    });
    document.addEventListener('input', (e) => {
        if (e.target.classList && e.target.classList.contains('ws-am')) {
            const container = e.target.closest('.split-container');
            renderSplitSharesFor(container ? container.id : 'expenseWorkersSplit');
        }
    });

    document.querySelectorAll('[data-filter-input]').forEach(el => {
        const tab = el.closest('.tab-content').id;
        el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { Render[tab] && Render[tab](); });
    });

    document.querySelectorAll('[data-report-filter]').forEach(el => {
        el.addEventListener('change', () => generateReport());
    });

    document.querySelectorAll('[data-settings-input]').forEach(el => {
        el.addEventListener('change', saveSettingsFromInputs);
    });
}

const ACTIONS = {
    'quick-stats': () => UI.tab('dashboard'),
    'toggle-theme': toggleTheme,
    'add-project': addProjectForm,
    'add-worker': addWorkerForm,
    'add-expense': addExpense,
    'add-time': addTimeEntry,
    'add-template': addTemplateForm,
    'load-template': loadTemplateToForm,
    'export-json': exportJSON,
    'export-backup': exportBackup,
    'pick-import': () => document.getElementById('importFile').click(),
    'pick-restore': () => document.getElementById('restoreFile').click(),
    'restore-autobackup': () => Backup.restore(),
    'export-csv': exportCSV,
    'export-csv-workers': exportWorkersCSV,
    'export-csv-time': exportTimeCSV,
    'export-csv-tasks': exportTasksCSV,
    'export-csv-projects': exportProjectsCSV,
    'export-csv-payroll': exportPayrollCSV,
    'print': () => window.print(),
    'verify-backup': verifyBackup,
    'clear-all': confirmClearAll,
    'report-refresh': generateReport,
    'cal-prev': () => { currentCalDate.setMonth(currentCalDate.getMonth() - 1); Render.calendar(); },
    'cal-next': () => { currentCalDate.setMonth(currentCalDate.getMonth() + 1); Render.calendar(); },
    'data-health': runDataHealth
};

function handleScoped(el) {
    const d = el.dataset;
    if (d.editProject) openEditProject(d.editProject);
    else if (d.editWorker) openEditWorker(d.editWorker);
    else if (d.editExpense) openEditExpense(d.editExpense);
    else if (d.editTime) openEditTime(d.editTime);
    else if (d.editTemplate) openEditTemplate(d.editTemplate);
    else if (d.detailProject) openProjectDetail(d.detailProject);
    else if (d.detailWorker) openWorkerDetail(d.detailWorker);
    else if (d.archiveProject) confirmArchiveProject(d.archiveProject);
    else if (d.restoreProject) Store.restoreProject(d.restoreProject), renderAll(), UI.toast('Проект восстановлен');
    else if (d.archiveWorker) confirmArchiveWorker(d.archiveWorker);
    else if (d.restoreWorker) Store.restoreWorker(d.restoreWorker), renderAll(), UI.toast('Работник восстановлен');
    else if (d.delExpense) confirmDeleteExpense(d.delExpense);
    else if (d.delTime) confirmDeleteTime(d.delTime);
    else if (d.delTemplate) confirmDeleteTemplate(d.delTemplate);
    else if (d.dupExpense) Store.duplicateExpense(d.dupExpense), renderAll(), UI.toast('Операция продублирована');
    else if (d.applyTemplate) applyTemplate(d.applyTemplate);
    else if (d.calDate) openCalendarDay(d.calDate);
    else if (d.stageAdd) openStageForm({ projectId: d.stageAdd });
    else if (d.stageEdit) {
        const st = Store.data.stages.find(x => Utils.eq(x.id, d.stageEdit));
        openStageForm({ id: d.stageEdit, projectId: st ? st.projectId : '' });
    }
    else if (d.stageMove) { Store.moveStage(d.stageMove, Number(d.dir) || 0); reopenProjectDetailForStage(d.stageMove); }
    else if (d.stageStatus) { Store.setStageStatus(d.stageStatus, d.st); reopenProjectDetailForStage(d.stageStatus); }
    else if (d.taskAdd) openTaskForm({ projectId: d.taskAdd });
    else if (d.taskEdit) {
        const tk = Store.data.tasks.find(x => Utils.eq(x.id, d.taskEdit));
        openTaskForm({ id: d.taskEdit, projectId: tk ? tk.projectId : '' });
    }
    else if (d.taskDel) confirmDeleteTask(d.taskDel);
    else if (d.taskStatus) { Store.setTaskStatus(d.taskStatus, d.st); reopenProjectDetailForTask(d.taskStatus); }
    else if (d.payWorker) openPayrollPayment(d.payWorker);
}

function reopenProjectDetailForStage(stageId) {
    const s = Store.data.stages.find(x => Utils.eq(x.id, stageId));
    if (s && document.getElementById('modalOverlay').classList.contains('active')) openProjectDetail(s.projectId);
    renderAll();
}

function reopenProjectDetailForTask(taskId) {
    const t = Store.data.tasks.find(x => Utils.eq(x.id, taskId));
    if (t && document.getElementById('modalOverlay').classList.contains('active')) openProjectDetail(t.projectId);
    renderAll();
}

function confirmDeleteTask(id) {
    const t = Store.data.tasks.find(x => Utils.eq(x.id, id));
    UI.confirm('Удалить задачу?', `Задача «${t ? t.title : ''}» будет удалена без возможности восстановления.`, () => {
        Store.deleteTask(id);
        if (t) { if (document.getElementById('modalOverlay').classList.contains('active')) openProjectDetail(t.projectId); renderAll(); }
        UI.toast('Задача удалена');
    });
}

function openCalendarDay(dateStr) {
    const cur = Store.settings().currency;
    const idx = Render._allDateIndex();
    const items = idx.get(dateStr) || [];
    const expenses = items.filter(i => i.type === 'expense');
    const times = items.filter(i => i.type === 'time');
    const deadlines = items.filter(i => i.type === 'deadline');
    const stages = items.filter(i => i.type === 'stage');
    const total = expenses.reduce((s, e) => s + e.amount, 0);

    const expRows = expenses.map(e => {
        const p = Store.getProject(e.projectId);
        return `<tr><td><span class="badge ${e.category}">${Utils.escapeHtml(CONFIG.CATEGORIES[e.category] || e.category)}</span></td><td>${p ? Utils.escapeHtml(p.name) : '-'}</td><td>${Utils.formatMoneyCents(e.amount, cur)}</td><td>${Utils.escapeHtml(e.desc || '-')}</td></tr>`;
    }).join('');
    const timeRows = times.map(t => {
        const w = Store.getWorker(t.workerId);
        const p = Store.getProject(t.projectId);
        return `<tr><td>${w ? Utils.escapeHtml(w.name) : '?'}</td><td>${p ? Utils.escapeHtml(p.name) : '?'}</td><td>${t.hours}ч</td></tr>`;
    }).join('');
    const dlRows = deadlines.map(t => {
        const p = Store.getProject(t.projectId);
        const overdue = t.status !== 'DONE' && t.status !== 'CANCELLED' && dateStr < Utils.todayStr();
        return `<tr><td>${Utils.escapeHtml(t.title)}</td><td>${p ? Utils.escapeHtml(p.name) : '?'}</td><td><span class="badge tk-${t.status.toLowerCase()}">${t.status}</span></td>${overdue ? '<td><span class="badge pri-urgent">Просрочено</span></td>' : '<td></td>'}</tr>`;
    }).join('');
    const stRows = stages.map(s => {
        const p = Store.getProject(s.projectId);
        return `<tr><td>${Utils.escapeHtml(s.name)}</td><td>${p ? Utils.escapeHtml(p.name) : '?'}</td></tr>`;
    }).join('');

    const section = (title, body) => body ? `<h4 style="margin:15px 0 5px">${title}</h4><div class="table-wrapper"><table><tbody>${body}</tbody></table></div>` : '';
    UI.openModal('События за ' + Utils.formatDate(dateStr),
        `<div class="stat-card flat" style="margin-bottom:15px;"><h4>Расходы — итого</h4><div class="value">${Utils.formatMoneyCents(total, cur)}</div></div>
         ${section('Расходы / Выплаты', expRows ? `<thead><tr><th>Категория</th><th>Проект</th><th>Сумма</th><th>Описание</th></tr></thead>${expRows}` : '')}
         ${section('Учёт времени', timeRows ? `<thead><tr><th>Работник</th><th>Проект</th><th>Часы</th></tr></thead>${timeRows}` : '')}
         ${section('Этапы', stRows ? `<thead><tr><th>Этап</th><th>Проект</th></tr></thead>${stRows}` : '')}
         ${section('Дедлайны задач', dlRows ? `<thead><tr><th>Задача</th><th>Проект</th><th>Статус</th><th></th></tr></thead>${dlRows}` : '')}
         ${!items.length ? '<p style="text-align:center;color:var(--secondary)">За этот день нет событий</p>' : ''}`,
        `<button class="secondary" data-modal-close>Закрыть</button>`);
}

function toggleTheme() {
    const b = document.body;
    const isDark = b.getAttribute('data-theme') === 'dark';
    b.setAttribute('data-theme', isDark ? 'light' : 'dark');
    try { localStorage.setItem('theme', isDark ? 'light' : 'dark'); } catch (e) { AppLogger.error('Не удалось сохранить тему', e); }
}

function setupFileInputs() {
    document.getElementById('importFile').addEventListener('change', (e) => {
        importJSONFile(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('restoreFile').addEventListener('change', (e) => {
        importBackupFile(e.target.files[0]);
    });
}

// ---------------- 16. APP ----------------
async function initApp() {
    try {
        if (localStorage.getItem('theme') === 'dark') document.body.setAttribute('data-theme', 'dark');
    } catch (e) { AppLogger.error('Не удалось прочитать тему', e); }

    await Store.load();
    document.getElementById('expenseDate').value = Utils.todayStr();
    document.getElementById('timeDate').value = Utils.todayStr();

    // Hide tabs for disabled features.
    const tabFeatureMap = {
        payroll: 'payroll',
        finance: 'finance',
        analytics: 'analytics',
        tasks: 'tasks',
        calendar: 'calendar',
        templates: 'templates',
        activity: 'activityLog'
    };
    Object.entries(tabFeatureMap).forEach(([tab, feat]) => {
        if (CONFIG.features[feat] === false) {
            const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
            const panel = document.getElementById(tab);
            if (btn) btn.style.display = 'none';
            if (panel) panel.style.display = 'none';
        }
    });

    updateExpenseForm();
    updateTimeForm();
    updateTemplateForm();
    updateReportFilters();
    updateFinanceFilters();
    updateAnalyticsFilters();
    const pc = document.getElementById('projectCurrency');
    if (pc) pc.value = Store.settings().currency;
    setupEvents();
    setupFileInputs();
    if (CONFIG.features.globalSearch) setupGlobalSearch();

    if (Store.settings().notifyDebt) {
        const debtors = Store.data.workers.filter(w => Calc.workerDebtCents(w.id) > 0 && w.active).length;
        if (debtors) setTimeout(() => UI.toast(`Задолженность по зарплате у ${debtors} работников`, 'info'), 600);
    }
    if (Store.settings().notifyBudget) {
        const over = Store.data.projects.filter(p => p.active && Calc.projectStats(p.id).over);
        if (over.length) setTimeout(() => UI.toast(`Бюджет превышен у ${over.length} проектов`, 'warning'), 1400);
    }
    // Overdue tasks notification
    if (CONFIG.features.notifications) {
        const overdue = Calc.overdueTasksCount();
        if (overdue) setTimeout(() => UI.toast(`Просрочено задач: ${overdue}`, 'warning'), 2000);
    }

    renderAll();

    window.addEventListener('error', (e) => AppLogger.error('Необработанная ошибка:', e.message), true);
    window.addEventListener('unhandledrejection', (e) => AppLogger.error('Необработанный Promise:', e.reason));
    window.addEventListener('beforeunload', () => Storage.flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') Storage.flush(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') UI.closeModal();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
