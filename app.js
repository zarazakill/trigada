// ===============================================================
//  Brigade Manager Pro — core application logic
//  Logical layering: CONFIG > LOGGER > UTILS > STORAGE > MIGRATIONS
//  > VALIDATION > STORE > CALCULATIONS > SERVICES > RENDER > UI
//  > IMPORT/EXPORT > EVENTS > APP
// ===============================================================

// ---------------- 1. CONFIG ----------------
const CONFIG = {
    STORAGE_KEY: 'brigadeProV2',
    APP_VERSION: '2.1.0',
    SCHEMA_VERSION: 3,
    DEFAULT_CURRENCY: 'RUB',
    PAYMENT_CATEGORIES: ['advance', 'salary'],
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
        // Fallback for older browsers
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
        const d = new Date(s + 'T00:00:00');
        return !isNaN(d.getTime());
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
    }
};

// ---------------- 4. STORAGE ----------------
const Storage = {
    _timer: null,
    _dirty: false,

    read() {
        try { return localStorage.getItem(CONFIG.STORAGE_KEY); }
        catch (e) { AppLogger.error('Не удалось прочитать хранилище', e); return null; }
    },

    write(payload, immediate) {
        const write = () => {
            this._dirty = false;
            try { localStorage.setItem(CONFIG.STORAGE_KEY, payload); }
            catch (e) {
                AppLogger.error('Не удалось сохранить данные. Возможно, закончилось место в браузере.', e);
                UI.toast('Не удалось сохранить данные (хранилище переполнено?)', 'error');
            }
        };
        if (immediate) { if (this._timer) clearTimeout(this._timer); write(); return; }
        // Debounced write: batch rapid CRUD into a single localStorage write
        if (this._timer) clearTimeout(this._timer);
        this._dirty = true;
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
    // version 0 -> 1 : legacy brigadeProV2 without schemaVersion
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
    // version 1 -> 2 : fill expanded settings; add lifecycle timestamps
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
    // version 2 -> 3 : normalize money to 2 decimals, ensure category/type validity
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

    getSteps() { return [this.v0, this.v1, this.v2]; }
};

// ---------------- 6. VALIDATION / NORMALIZATION ----------------
const Validation = {
    normalizeData(raw) {
        const data = {
            projects: [], workers: [], expenses: [],
            timeEntries: [], templates: [],
            settings: { ...CONFIG.DEFAULT_SETTINGS }
        };
        if (!raw || typeof raw !== 'object') return data;

        data.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(raw.settings || {}) };
        // settings numeric guards
        data.settings.budgetWarningPercent = Utils.cents(Math.max(1, Math.min(100, Number(data.settings.budgetWarningPercent) || 80))) / 100;
        data.settings.maxHoursPerDay = Math.max(1, Math.min(168, Number(data.settings.maxHoursPerDay) || 24));
        data.settings.currency = ['RUB', 'USD', 'EUR'].includes(data.settings.currency) ? data.settings.currency : 'RUB';

        const normItem = (item, def) => {
            if (!item || typeof item !== 'object') return null;
            return { ...def, ...item };
        };

        (Array.isArray(raw.projects) ? raw.projects : []).forEach(p => {
            const o = normItem(p, { id: Utils.genId(), name: '', budget: 0, currency: 'RUB', status: 'active', desc: '', active: true, createdAt: null, updatedAt: null });
            if (!o) return;
            if (typeof o.name !== 'string') o.name = String(o.name ?? '');
            o.budget = Number.isFinite(Number(o.budget)) ? Utils.cents(o.budget) / 100 : 0;
            if (!CONFIG.PROJECT_STATUSES.includes(o.status)) o.status = 'active';
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
            const o = normItem(t, { id: Utils.genId(), workerId: '', projectId: '', date: '', hours: 0, type: 'regular', comment: '', createdAt: null, updatedAt: null });
            if (!o) return;
            o.workerId = o.workerId == null ? '' : String(o.workerId);
            o.projectId = o.projectId == null ? '' : String(o.projectId);
            if (!Utils.validateDate(o.date)) o.date = '';
            o.hours = Number.isFinite(Number(o.hours)) ? Number(o.hours) : 0;
            if (!CONFIG.RATE_MULTIPLIERS[o.type]) o.type = 'regular';
            data.timeEntries.push(o);
        });

        (Array.isArray(raw.templates) ? raw.templates : []).forEach(t => {
            const o = normItem(t, { id: Utils.genId(), name: '', category: 'other', amount: 0, projectId: '', desc: '', createdAt: null, updatedAt: null });
            if (!o) return;
            o.amount = Number.isFinite(Number(o.amount)) ? Utils.cents(Math.max(0, Number(o.amount))) / 100 : 0;
            if (!CONFIG.CATEGORIES[o.category]) o.category = 'other';
            data.templates.push(o);
        });

        return data;
    },

    // Integrity check: returns array of warnings; never throws
    audit() {
        const problems = [];
        const projIds = new Set(Store.data.projects.map(p => String(p.id)));
        const workerIds = new Set(Store.data.workers.map(w => String(w.id)));

        Store.data.expenses.forEach((e, i) => {
            if (!projIds.has(String(e.projectId))) problems.push(`Расход #${i + 1} ссылается на отсутствующий проект`);
            (e.workers || []).forEach(w => { if (!workerIds.has(String(w))) problems.push(`Расход #${i + 1} ссылается на отсутствующего работника`); });
        });
        Store.data.timeEntries.forEach((t, i) => {
            if (!workerIds.has(String(t.workerId))) problems.push(`Запись времени #${i + 1} ссылается на отсутствующего работника`);
            if (!projIds.has(String(t.projectId))) problems.push(`Запись времени #${i + 1} ссылается на отсутствующий проект`);
        });
        return problems;
    }
};

// ---------------- 7. STORE ----------------
const Store = {
    data: Validation.normalizeData({}),
    _needsResave: false,

    settings() { return this.data.settings; },

    load() {
        const raw = Storage.read();
        if (!raw) { this.data = Validation.normalizeData({}); return; }
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) {
            AppLogger.error('Сохранённые данные повреждены JSON. Данные будут начаты заново.', e);
            UI.toast('Сохранённые данные повреждены. Начато с пустого состояния.', 'error');
            this.data = Validation.normalizeData({});
            return;
        }
        try {
            // migrate
            let version = Number(parsed.schemaVersion) || 0;
            const steps = Migrations.getSteps();
            for (let i = version; i <= CONFIG.SCHEMA_VERSION && i < steps.length; i++) {
                parsed = steps[i](parsed);
            }
            parsed.schemaVersion = CONFIG.SCHEMA_VERSION;
            this.data = Validation.normalizeData(parsed);
            this._needsResave = true;
        } catch (e) {
            AppLogger.error('Ошибка миграции данных', e);
            this.data = Validation.normalizeData({});
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

    // Getters
    getProject(id) { return this.data.projects.find(p => Utils.eq(p.id, id)) || null; },
    getWorker(id) { return this.data.workers.find(w => Utils.eq(w.id, id)) || null; },
    activeProjects() { return this.data.projects.filter(p => p.active); },
    activeWorkers() { return this.data.workers.filter(w => w.active); },

    // --- Projects (soft delete = archive) ---
    addProject(p) {
        const now = new Date().toISOString();
        const o = { active: true, createdAt: now, updatedAt: now, ...p, id: Utils.genId() };
        this.data.projects.push(o);
        this.save();
        return o;
    },
    updateProject(id, u) {
        const p = this.getProject(id);
        if (!p) return;
        Object.assign(p, u, { updatedAt: new Date().toISOString() });
        this.save();
    },
    archiveProject(id) {
        const p = this.getProject(id);
        if (!p) return;
        p.active = false;
        p.updatedAt = new Date().toISOString();
        this.save();
    },
    restoreProject(id) {
        const p = this.getProject(id);
        if (!p) return;
        p.active = true;
        p.updatedAt = new Date().toISOString();
        this.save();
    },

    // --- Workers (soft delete = archive) ---
    addWorker(w) {
        const now = new Date().toISOString();
        const o = { active: true, createdAt: now, updatedAt: now, ...w, id: Utils.genId() };
        this.data.workers.push(o);
        this.save();
        return o;
    },
    updateWorker(id, u) {
        const w = this.getWorker(id);
        if (!w) return;
        Object.assign(w, u, { updatedAt: new Date().toISOString() });
        this.save();
    },
    archiveWorker(id) {
        const w = this.getWorker(id);
        if (!w) return;
        w.active = false;
        w.updatedAt = new Date().toISOString();
        this.save();
    },
    restoreWorker(id) {
        const w = this.getWorker(id);
        if (!w) return;
        w.active = true;
        w.updatedAt = new Date().toISOString();
        this.save();
    },

    // --- Expenses (leaf records) ---
    addExpense(e) {
        const now = new Date().toISOString();
        const o = { createdAt: now, updatedAt: now, ...e, id: Utils.genId() };
        this.data.expenses.push(o);
        this.save();
        return o;
    },
    updateExpense(id, u) {
        const e = this.data.expenses.find(x => Utils.eq(x.id, id));
        if (!e) return;
        Object.assign(e, u, { updatedAt: new Date().toISOString() });
        this.save();
    },
    deleteExpense(id) {
        this.data.expenses = this.data.expenses.filter(x => !Utils.eq(x.id, id));
        this.save();
    },
    duplicateExpense(id) {
        const e = this.data.expenses.find(x => Utils.eq(x.id, id));
        if (!e) return;
        const now = new Date().toISOString();
        const copy = { ...e, id: Utils.genId(), createdAt: now, updatedAt: now };
        this.data.expenses.push(copy);
        this.save();
        return copy;
    },

    // --- Time entries ---
    addTimeEntry(t) {
        const now = new Date().toISOString();
        const o = { createdAt: now, updatedAt: now, ...t, id: Utils.genId() };
        this.data.timeEntries.push(o);
        this.save();
        return o;
    },
    updateTimeEntry(id, u) {
        const t = this.data.timeEntries.find(x => Utils.eq(x.id, id));
        if (!t) return;
        Object.assign(t, u, { updatedAt: new Date().toISOString() });
        this.save();
    },
    deleteTimeEntry(id) {
        this.data.timeEntries = this.data.timeEntries.filter(x => !Utils.eq(x.id, id));
        this.save();
    },

    // --- Templates ---
    addTemplate(t) {
        const now = new Date().toISOString();
        const o = { createdAt: now, updatedAt: now, ...t, id: Utils.genId() };
        this.data.templates.push(o);
        this.save();
        return o;
    },
    updateTemplate(id, u) {
        const t = this.data.templates.find(x => Utils.eq(x.id, id));
        if (!t) return;
        Object.assign(t, u, { updatedAt: new Date().toISOString() });
        this.save();
    },
    deleteTemplate(id) {
        this.data.templates = this.data.templates.filter(x => !Utils.eq(x.id, id));
        this.save();
    }
};

// ---------------- 8. CALCULATIONS (single financial layer) ----------------
const Calc = {
    // earned by one worker for one time entry (cents)
    timeCostCents(entry) {
        const w = Store.getWorker(entry.workerId);
        const rate = w ? w.rate : 0;
        const mult = CONFIG.RATE_MULTIPLIERS[entry.type] || 1;
        return Utils.cents(entry.hours * rate * mult);
    },

    workerHours(wid) {
        let s = 0;
        for (const t of Store.data.timeEntries) if (Utils.eq(t.workerId, wid)) s += Number(t.hours) || 0;
        return s;
    },

    // share of an expense belonging to a worker (cents)
    expenseWorkerShareCents(e, wid) {
        if (e.splits && e.splits[wid] != null) return Utils.cents(e.splits[wid]);
        const w = e.workers && e.workers.length ? e.workers : [];
        if (w.length === 0) return 0;
        if (w.length === 1) return Utils.cents(e.amount);
        return Utils.cents(e.amount / w.length);
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

    projectSpentCents(pid) {
        let s = 0;
        for (const e of Store.data.expenses) if (Utils.eq(e.projectId, pid)) s += Utils.cents(e.amount);
        return s;
    },

    // split of project expenses by category (cents)
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
        return [...ids];
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

    // returns Map<key, cents> respecting multi-worker splits
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

// ---------------- 10. UI (tabs, modal, toast, confirm) ----------------
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
        // limit concurrent toasts
        while (container.children.length > this._toastLimit) container.firstChild.remove();
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350); }, 3200);
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

        const debtRub = Utils.toRub(totalDebtCents);
        document.getElementById('dashboardStats').innerHTML =
            `<div class="stat-card"><h4>Всего расходов</h4><div class="value">${Utils.formatMoneyCents(totalSpent, cur)}</div></div>` +
            `<div class="stat-card secondary"><h4>Активных проектов</h4><div class="value">${activeProj}</div></div>` +
            `<div class="stat-card success"><h4>Работников</h4><div class="value">${totalWorkers}</div></div>` +
            `<div class="stat-card ${debtRub > 0 ? 'danger' : 'flat'}"><h4>Долг по зарплате</h4><div class="value">${Utils.formatMoneyCents(totalDebtCents, cur)}</div></div>` +
            `<div class="stat-card flat"><h4>Часов отработано</h4><div class="value">${totalHours.toLocaleString('ru-RU')}</div></div>`;

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
            return `<div class="card ${p.active ? '' : 'archived'}">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                    <h3 style="margin:0;">${Utils.escapeHtml(p.name)}</h3>
                    <span class="badge ${p.active ? p.status : 'archived'}">${p.active ? (p.status === 'active' ? 'Активный' : p.status) : 'Архив'}</span>
                </div>
                ${p.desc ? `<p style="color:var(--secondary); font-size:13px; margin:5px 0;">${Utils.escapeHtml(p.desc)}</p>` : ''}
                <div style="margin-top:10px; font-size:14px;">
                    <div>Бюджет: <b>${Utils.formatMoneyCents(st.budget, p.currency)}</b></div>
                    <div>Потрачено: <b style="color:${st.over ? 'var(--danger)' : 'var(--text)'}">${Utils.formatMoneyCents(st.spent, p.currency)}</b></div>
                    <div>Остаток: <b style="color:${st.remaining < 0 ? 'var(--danger)' : 'var(--success)'}">${Utils.formatMoneyCents(st.remaining, p.currency)}</b></div>
                    <div style="color:var(--secondary); font-size:12px; margin-top:4px;">Использовано: ${pct.toFixed(1)}% · Работников: ${wcount} · Часов: ${hours}</div>
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
                    <td>${w.rate ? w.rate + ' ₽/ч' : '-'}</td>
                    <td>${hours}</td>
                    <td>${Utils.formatMoney(earned, cur)}</td>
                    <td>${Utils.formatMoney(paid, cur)}</td>
                    <td style="color:${debt > 0 ? 'var(--danger)' : debt < 0 ? 'var(--success)' : 'inherit'}; font-weight:bold;">${Utils.formatMoney(debt, cur)}</td>
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

    calendar() {
        const y = currentCalDate.getFullYear(), m = currentCalDate.getMonth();
        document.getElementById('calendarMonthYear').textContent = currentCalDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
        const byDate = this._expenseDateIndex();
        const firstDay = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const pad = (firstDay === 0 ? 6 : firstDay - 1);
        const cur = Store.settings().currency;

        let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<div class="calendar-header">${d}</div>`).join('');
        for (let i = 0; i < pad; i++) html += `<div class="calendar-day empty"></div>`;

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            const dayExp = (byDate.get(dateStr) || []).map(e => e);
            const sumCents = dayExp.reduce((s, e) => s + Utils.cents(e.amount), 0);
            const isToday = new Date().toDateString() === new Date(y, m, d).toDateString();
            const items = dayExp.slice(0, 3).map(e => {
                const p = Store.getProject(e.projectId);
                return `<div class="day-exp">${Utils.formatMoneyCents(Utils.cents(e.amount), cur)} · ${Utils.escapeHtml(p ? p.name : '')}</div>`;
            }).join('');
            html += `<div class="calendar-day ${isToday ? 'today' : ''} ${sumCents > 0 ? 'has-expenses' : ''}" data-cal-date="${dateStr}">
                <div class="day-number">${d}</div>
                ${sumCents > 0 ? `<div class="day-amount">-${Utils.formatMoneyCents(sumCents, cur)}</div>` : ''}
                ${items}
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
    const cur = Store.settings().currency;
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
    // recompute shares
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

// ---------------- 12. IMPORT / EXPORT ----------------
function exportJSON() {
    const payload = JSON.stringify({
        schemaVersion: CONFIG.SCHEMA_VERSION,
        applicationVersion: CONFIG.APP_VERSION,
        exportedAt: new Date().toISOString(),
        data: Store.data
    }, null, 2);
    downloadFile(payload, `brigade_data_${Utils.todayStr()}.json`, 'application/json');
}

function exportBackup() {
    const payload = JSON.stringify({
        schemaVersion: CONFIG.SCHEMA_VERSION,
        applicationVersion: CONFIG.APP_VERSION,
        timestamp: new Date().toISOString(),
        data: Store.data
    }, null, 2);
    downloadFile(payload, `brigade_backup_${Utils.todayStr()}.json`, 'application/json');
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

// safe import: backup current -> validate -> migrate -> normalize -> integrity -> replace
function importJSONFile(file) {
    if (!file) return;
    const backupNow = JSON.stringify(Store.data);
    const reader = new FileReader();
    reader.onload = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.target.result); }
        catch (e) { UI.toast('Файл повреждён: неверный формат JSON', 'error'); return; }
        try {
            const result = prepareIncomingData(parsed);
            UI.confirm('Импорт данных',
                'Текущие данные будут заменены данными из файла. Текущие данные сохранены как резервная копия в этом окне. Продолжить?',
                () => { applyIncomingData(result); },
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
            UI.confirm('Восстановление из копии',
                'Данные будут заменены содержимым резервной копии. Текущие данные вы сможете экспортировать отдельно. Продолжить?',
                () => { applyIncomingData(result); },
                true);
        } catch (e) {
            AppLogger.error('Ошибка восстановления', e);
            UI.toast('Копия не распознана. Текущие данные не изменены.', 'error');
        }
    };
    reader.readAsText(file);
}

// Accepts either {data: {...}} wrapper (backup/export) or a raw data object (legacy import)
function prepareIncomingData(parsed) {
    const raw = (parsed && typeof parsed === 'object' && 'data' in parsed) ? parsed.data : parsed;
    if (!raw || typeof raw !== 'object') throw new Error('bad structure');
    // migrate through schema versions if present, else treat as legacy
    let version = Number(raw.schemaVersion) || 0;
    const steps = Migrations.getSteps();
    for (let i = version; i <= CONFIG.SCHEMA_VERSION && i < steps.length; i++) {
        raw = steps[i](raw);
    }
    raw.schemaVersion = CONFIG.SCHEMA_VERSION;
    const data = Validation.normalizeData(raw);
    // integrity audit
    const problems = Validation.audit();
    return { data, problems, backupNow: null };
}

function applyIncomingData(result) {
    Store.replaceData(result.data);
    if (result.problems && result.problems.length) {
        AppLogger.warn('Проблемы целостности при импорте: ', result.problems);
        UI.toast('Данные импортированы. Обнаружены ссылки на удалённые записи: ' + result.problems.length, 'warning');
    } else {
        UI.toast('Данные загружены', 'success');
    }
    renderAll();
}

function exportCSV() {
    let csv = '\ufeffДата;Проект;Категория;Сумма;Описание\n';
    [...Store.data.expenses].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(e => {
        const p = Store.getProject(e.projectId);
        csv += [Utils.csvEscape(e.date), Utils.csvEscape(p ? p.name : ''), Utils.csvEscape(CONFIG.CATEGORIES[e.category] || e.category), Utils.csvEscape(e.amount), Utils.csvEscape(e.desc || '')].join(';') + '\n';
    });
    downloadFile(csv, `brigade_report_${Utils.todayStr()}.csv`, 'text/csv;charset=utf-8;');
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

function noteWorkers(ids) {
    if (!ids || !ids.length) return '';
    const names = ids.slice(0, 4).map(id => { const w = Store.getWorker(id); return w ? w.name : '?'; }).join(', ');
    return ` <small style="color:var(--secondary)">(${Utils.escapeHtml(names)})</small>`;
}

function addProjectForm() {
    const name = document.getElementById('projectName').value.trim();
    if (!name) { UI.toast('Введите название проекта', 'error'); return; }
    Store.addProject({
        name,
        budget: Utils.cents(document.getElementById('projectBudget').value) / 100,
        currency: document.getElementById('projectCurrency').value,
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
         <div class="group-field"><label>Валюта</label><select id="pCurrency">${['RUB', 'USD', 'EUR'].map(c => `<option ${p.currency === c ? 'selected' : ''} value="${c}">${c}</option>`).join('')}</select></div>
         <div class="group-field"><label>Статус</label><select id="pStatus">${CONFIG.PROJECT_STATUSES.map(s => `<option ${p.status === s ? 'selected' : ''} value="${s}">${s}</option>`).join('')}</select></div>
         <div class="group-field"><label>Описание</label><textarea id="pDesc" rows="2">${Utils.escapeHtml(p.desc || '')}</textarea></div>`,
        modalActionsHTML());
    wireModal(() => {
        const name = document.getElementById('pName').value.trim();
        if (!name) { UI.toast('Введите название проекта', 'error'); return false; }
        Store.updateProject(id, {
            name,
            budget: Utils.cents(document.getElementById('pBudget').value) / 100,
            currency: document.getElementById('pCurrency').value,
            status: document.getElementById('pStatus').value,
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
    const cur = p.currency;
    const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
        `<tr><td>${Utils.escapeHtml(CONFIG.CATEGORIES[k] || k)}</td><td>${Utils.formatMoneyCents(v, cur)}</td></tr>`).join('');
    UI.openModal('Проект: ' + p.name,
        `<div class="detail-grid">
            <div class="dl"><span>Статус</span><b>${p.active ? p.status : 'Архив'}</b></div>
            <div class="dl"><span>Бюджет</span><b>${Utils.formatMoneyCents(st.budget, cur)}</b></div>
            <div class="dl"><span>Потрачено</span><b>${Utils.formatMoneyCents(st.spent, cur)}</b></div>
            <div class="dl"><span>Остаток</span><b>${Utils.formatMoneyCents(st.remaining, cur)}</b></div>
            <div class="dl"><span>Использовано</span><b>${p.budget > 0 ? st.pct.toFixed(1) + '%' : '-'}</b></div>
            <div class="dl"><span>Работников</span><b>${Calc.projectWorkers(id).length}</b></div>
            <div class="dl"><span>Часов</span><b>${Calc.projectHours(id)}</b></div>
        </div>
        ${p.desc ? `<p style="margin-top:15px;color:var(--secondary);font-size:13px;">${Utils.escapeHtml(p.desc)}</p>` : ''}
        <h3 style="margin-top:20px;">Расходы по категориям</h3>
        <div class="table-wrapper"><table><thead><tr><th>Категория</th><th>Сумма</th></tr></thead><tbody>${catRows || '<tr><td colspan="2" style="text-align:center;color:var(--secondary)">Нет расходов</td></tr>'}</tbody></table></div>`,
        `<button class="secondary" data-modal-close>Закрыть</button>`);
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
    // projects
    const projIds = new Set();
    Store.data.expenses.forEach(e => { if ((e.workers || []).includes(String(id)) && e.projectId) projIds.add(String(e.projectId)); });
    Store.data.timeEntries.forEach(t => { if (Utils.eq(t.workerId, id) && t.projectId) projIds.add(String(t.projectId)); });
    const projNames = [...projIds].map(pid => { const p = Store.getProject(pid); return p ? p.name : ''; }).filter(Boolean);
    // last operations (payments + time entries)
    const ops = [];
    Store.data.expenses.forEach(e => {
        if (!CONFIG.PAYMENT_CATEGORIES.includes(e.category)) return;
        if (!(e.workers || []).includes(String(id))) return;
        const share = Utils.toRub(Calc.expenseWorkerShareCents(e, id));
        ops.push({ date: e.date, text: (CONFIG.CATEGORIES[e.category] || e.category) + ' ' + share + ' ₽', type: 'paid' });
    });
    Store.data.timeEntries.forEach(t => {
        if (!Utils.eq(t.workerId, id)) return;
        ops.push({ date: t.date, text: t.hours + ' ч × ' + w.rate + ' ₽', type: 'earned' });
    });
    ops.sort((a, b) => (a.date < b.date ? -1 : 1)).reverse();
    const opsHtml = ops.slice(0, 10).map(o => `<tr><td>${Utils.escapeHtml(Utils.formatDate(o.date))}</td><td>${Utils.escapeHtml(o.text)}</td></tr>`).join('');

    UI.openModal('Работник: ' + w.name,
        `<div class="detail-grid">
            <div class="dl"><span>Ставка</span><b>${w.rate} ₽/ч</b></div>
            <div class="dl"><span>Статус</span><b>${w.active ? 'Активен' : 'Архив'}</b></div>
            <div class="dl"><span>Часы</span><b>${hours}</b></div>
            <div class="dl"><span>Заработано</span><b>${Utils.formatMoneyCents(earned, cur)}</b></div>
            <div class="dl"><span>Выплачено</span><b>${Utils.formatMoneyCents(paid, cur)}</b></div>
            <div class="dl"><span>Долг</span><b style="color:${debt > 0 ? 'var(--danger)' : debt < 0 ? 'var(--success)' : 'inherit'}">${Utils.formatMoneyCents(debt, cur)}</b></div>
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

    const { workers, splits, splitSumCents } = collectSplitsFromForm();
    const amtCents = Utils.cents(amt);

    if (workers.length) {
        if (splitSumCents > 0 && Math.abs(splitSumCents - amtCents) > 1) {
            UI.toast('Сумма долей работников не совпадает с общей суммой', 'error');
            return;
        }
        // even split for selected workers without amounts
        workers.forEach(wid => { if (splits[wid] == null || splits[wid] === 0) splits[wid] = Utils.toRub(Utils.cents(amt / workers.length)); });
    }

    const expense = Store.addExpense({
        projectId: String(pid),
        category: document.getElementById('expenseCategory').value,
        amount: Utils.toRub(amtCents),
        date,
        desc: document.getElementById('expenseDesc').value,
        workers,
        splits
    });

    // budget checks
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
        const { workers, splits } = collectSplitsFromModal('eSplits');
        if (workers.length) {
            const splitSum = Object.values(splits).reduce((s, v) => s + Utils.cents(v), 0);
            if (Math.abs(splitSum - Utils.cents(amt)) > 1) { UI.toast('Сумма долей не совпадает с общей суммой', 'error'); return false; }
        }
        Store.updateExpense(id, {
            projectId: document.getElementById('eProject').value,
            category: document.getElementById('eCategory').value,
            amount: Utils.toRub(Utils.cents(amt)),
            date,
            desc: document.getElementById('eDesc').value,
            workers,
            splits
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
    // even split for selected workers without an entered amount
    if (workers.length) {
        const amtCents = Utils.cents(parseFloat(document.getElementById('eAmount').value || 0));
        workers.forEach(wid => { if (splits[wid] == null) splits[wid] = Utils.toRub(Math.round(amtCents / workers.length)); });
    }
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
        Store.updateTimeEntry(id, {
            workerId: document.getElementById('tWorker').value,
            projectId: document.getElementById('tProject').value,
            date: document.getElementById('tDate').value,
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

// ---------------- 15. Events wiring ----------------
function wireModal(onSubmit) {
    const ov = document.getElementById('modalOverlay');
    ov.querySelector('[data-modal-submit]').onclick = () => { if (onSubmit()) UI.closeModal(); };
    ov.querySelector('[data-modal-close]').onclick = () => UI.closeModal();
}

function renderAll() {
    const active = document.querySelector('.tab-content.active');
    if (active && Render[active.id]) Render[active.id]();
    // refresh dropdowns when relevant tabs may be shown
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

// Update settings from settings tab controls
function saveSettingsFromInputs() {
    const s = Store.settings();
    const cur = document.getElementById('setCurrency').value;
    s.currency = ['RUB', 'USD', 'EUR'].includes(cur) ? cur : 'RUB';
    s.budgetWarningPercent = Math.max(1, Math.min(100, parseFloat(document.getElementById('setBudgetWarn').value) || 80));
    s.maxHoursPerDay = Math.max(1, Math.min(168, parseFloat(document.getElementById('setMaxHours').value) || 24));
    s.notifyBudget = document.getElementById('notifyBudgetOver').checked;
    s.notifyDebt = document.getElementById('notifyLowBalance').checked;
    Store.save();
    UI.toast('Настройки сохранены');
}

function loadTemplateToForm() {
    // open a small picker modal of templates
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
        'Будут удалены все проекты, работники, расходы, записи времени и шаблоны. Рекомендуется сначала создать резервную копию (☁️). Действие необратимо.',
        () => {
            Store.data = Validation.normalizeData({});
            Storage.write(Storage._serialize(Store.data), true);
            UI.toast('Все данные удалены', 'info');
            renderAll();
        });
}

// Event delegation for data-action buttons, tab clicks, filters
function setupEvents() {
    // Tabs
    document.getElementById('mainTabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (tab) UI.tab(tab.dataset.tab);
    });

    // Action buttons
    document.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn && actionBtn.dataset.action && ACTIONS[actionBtn.dataset.action]) {
            e.preventDefault();
            ACTIONS[actionBtn.dataset.action]();
            return;
        }

        // Scoped element actions (edit/del/detail/...)
        const scoped = e.target.closest('[data-edit-project],[data-edit-worker],[data-edit-expense],[data-edit-time],[data-edit-template],' +
            '[data-detail-project],[data-detail-worker],[data-archive-project],[data-restore-project],' +
            '[data-archive-worker],[data-restore-worker],[data-del-expense],[data-del-time],[data-del-template],' +
            '[data-dup-expense],[data-apply-template],[data-cal-date]');
        if (scoped) {
            e.preventDefault();
            handleScoped(scoped);
        }
    });

    // Modal backdrop
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target.id === 'modalOverlay') UI.closeModal();
    });

    // Modal wire for close/submit where content uses delegation (confirm/pick use direct handlers)
    // Split checkboxes/amounts (add form + edit modal) — delegation
    document.addEventListener('change', (e) => {
        if (e.target.classList && e.target.classList.contains('ws-cb')) {
            const inp = e.target.closest('.split-row').querySelector('.ws-am');
            inp.disabled = !e.target.checked;
            if (!e.target.checked) { inp.value = ''; }
            renderSplitSharesFor(e.target.closest('.split-container').id || 'expenseWorkersSplit');
        }
    });
    document.addEventListener('input', (e) => {
        if (e.target.classList && e.target.classList.contains('ws-am')) {
            const container = e.target.closest('.split-container');
            renderSplitSharesFor(container ? container.id : 'expenseWorkersSplit');
        }
    });

    // Filters
    document.querySelectorAll('[data-filter-input]').forEach(el => {
        const tab = el.closest('.tab-content').id;
        el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { Render[tab] && Render[tab](); });
    });

    // Report filters
    document.querySelectorAll('[data-report-filter]').forEach(el => {
        el.addEventListener('change', () => generateReport());
    });

    // Settings inputs
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
    'export-csv': exportCSV,
    'print': () => window.print(),
    'verify-backup': verifyBackup,
    'clear-all': confirmClearAll,
    'report-refresh': generateReport,
    'cal-prev': () => { currentCalDate.setMonth(currentCalDate.getMonth() - 1); Render.calendar(); },
    'cal-next': () => { currentCalDate.setMonth(currentCalDate.getMonth() + 1); Render.calendar(); }
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
}

function openCalendarDay(dateStr) {
    const dayExp = Store.data.expenses.filter(e => e.date === dateStr);
    const cur = Store.settings().currency;
    const total = dayExp.reduce((s, e) => s + Utils.cents(e.amount), 0);
    const rows = dayExp.map(e => {
        const p = Store.getProject(e.projectId);
        return `<tr><td>${Utils.escapeHtml(Utils.formatDate(dateStr))}</td><td>${p ? Utils.escapeHtml(p.name) : '-'}</td><td><span class="badge ${e.category}">${Utils.escapeHtml(CONFIG.CATEGORIES[e.category] || e.category)}</span></td><td>${Utils.formatMoney(e.amount, cur)}</td><td>${Utils.escapeHtml(e.desc || '-')}</td></tr>`;
    }).join('');
    UI.openModal('Расходы за ' + Utils.formatDate(dateStr),
        `<div class="stat-card flat" style="margin-bottom:15px;"><h4>Итого</h4><div class="value">${Utils.formatMoneyCents(total, cur)}</div></div>
         <div class="table-wrapper"><table><thead><tr><th>Дата</th><th>Проект</th><th>Категория</th><th>Сумма</th><th>Описание</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--secondary)">За этот день нет расходов</td></tr>'}</tbody></table></div>`,
        `<button class="secondary" data-modal-close>Закрыть</button>`);
}

function toggleTheme() {
    const b = document.body;
    const isDark = b.getAttribute('data-theme') === 'dark';
    b.setAttribute('data-theme', isDark ? 'light' : 'dark');
    try { localStorage.setItem('theme', isDark ? 'light' : 'dark'); } catch (e) {}
}

// ---------------- File inputs ----------------
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
function initApp() {
    try {
        if (localStorage.getItem('theme') === 'dark') document.body.setAttribute('data-theme', 'dark');
    } catch (e) {}

    Store.load();
    // apply theme
    // Set initial date fields
    document.getElementById('expenseDate').value = Utils.todayStr();
    document.getElementById('timeDate').value = Utils.todayStr();

    updateExpenseForm();
    updateTimeForm();
    updateTemplateForm();
    updateReportFilters();
    setupEvents();
    setupFileInputs();

    // Notify debt & budget on load if settings enabled
    if (Store.settings().notifyDebt) {
        const debtors = Store.data.workers.filter(w => Calc.workerDebtCents(w.id) > 0 && w.active).length;
        if (debtors) setTimeout(() => UI.toast(`Задолженность по зарплате у ${debtors} работников`, 'info'), 600);
    }
    if (Store.settings().notifyBudget) {
        const over = Store.data.projects.filter(p => p.active && Calc.projectStats(p.id).over);
        if (over.length) setTimeout(() => UI.toast(`Бюджет превышен у ${over.length} проектов`, 'warning'), 1400);
    }

    renderAll();

    // Global error handlers
    window.addEventListener('error', (e) => AppLogger.error('Необработанная ошибка:', e.message), true);
    window.addEventListener('unhandledrejection', (e) => AppLogger.error('Необработанный Promise:', e.reason));
    // Flush pending writes
    window.addEventListener('beforeunload', () => Storage.flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') Storage.flush(); });
    // ESC closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') UI.closeModal();
        if (e.key === 'Escape' && !document.getElementById('modalOverlay').classList.contains('active')) {
            // allow selection navigation default
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
