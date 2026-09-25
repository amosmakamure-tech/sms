/* =============================================================
 * School Management System — Supabase client (browser, anon key)
 *
 * Include AFTER the supabase-js UMD bundle:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 *   <script src="js/supabase-client.js"></script>
 *
 * CONFIG: edit SUPABASE_URL and SUPABASE_ANON_KEY, or call
 *   window.SMS_SUPABASE.configure(url, anonKey)  before first use.
 *
 * When configured, the app runs in CLOUD mode:
 *   - sign-in uses Supabase Auth (email + password)
 *   - state is pulled/pushed to the shared multi-tenant database
 *   - RLS scopes every user to their own school
 * When NOT configured the app keeps its existing offline IndexedDB mode.
 * ============================================================= */
(function () {
  if (typeof window.supabase === 'undefined') {
    console.warn('[SMS_SUPABASE] supabase-js not loaded — offline mode only.');
  }

  let SUPABASE_URL = '';
  let SUPABASE_ANON_KEY = '';

  let sb = null;               // supabase client
  let session = null;          // current auth session
  let profile = null;          // current profile row (role/school)
  let lastPull = {};           // table -> { id: JSON(data) } for dedup

  const ENTITIES = [
    { table: 'students', key: 'students' },
    { table: 'teachers', key: 'teachers' },
    { table: 'staff', key: 'staff' },
    { table: 'administration', key: 'administration' },
    { table: 'fee_components', key: 'feeComponents' },
    { table: 'income_categories', key: 'incomeCategories' },
    { table: 'expenditure_categories', key: 'expenditureCategories' },
    { table: 'fees', key: 'fees' },
    { table: 'income', key: 'income' },
    { table: 'expenditure', key: 'expenditure' },
    { table: 'discipline', key: 'discipline' },
    { table: 'bank_deposits', key: 'bankDeposits' },
    { table: 'bank_transactions', key: 'bankTransactions' },
    { table: 'attendance', key: 'attendance' },
    { table: 'marks', key: 'marks' },
    { table: 'committees', key: 'committees' },
    { table: 'documents', key: 'documents' },
    { table: 'notifications', key: 'notifications' },
    { table: 'notices', key: 'notices' },
    { table: 'timetables', key: 'timetables' },
    { table: 'timetable_input', key: 'timetableInput' },
    { table: 'exams', key: 'exams' },
    { table: 'assets', key: 'assets' },
    { table: 'learner_profiles', key: 'learnerProfiles' },
    { table: 'supervision', key: 'supervision' },
    { table: 'lesson_observations', key: 'lessonObservations' },
    { table: 'exercise_inspections', key: 'exerciseInspections' },
    { table: 'attendance_register_inspections', key: 'attendanceRegisterInspections' },
    { table: 'subject_configs', key: 'subjectConfigs', obj: true },
    { table: 'overall_remarks', key: 'overallRemarks', obj: true },
  ];

  function errorMsg(e, fallback) {
    if (!e) return fallback || 'Unknown error';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    return fallback || 'Unknown error';
  }

  function toAuthUserMap(row) {
    return { id: row.id, username: row.username, name: row.display_name, role: row.role, email: row.email, schoolId: row.school_id };
  }

  /* -------------------------------------------------------- */
  const SMS_SUPABASE = {
    configured: false,

    configure(url, anonKey) {
      SUPABASE_URL = (url || '').trim().replace(/\/+$/, '');
      SUPABASE_ANON_KEY = (anonKey || '').trim();
      this.configured = !!(SUPABASE_URL && SUPABASE_ANON_KEY && typeof window.supabase !== 'undefined');
      if (this.configured) {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
        console.log('[SMS_SUPABASE] Cloud mode enabled (' + SUPABASE_URL + ')');
      }
      return this.configured;
    },

    async init() {
      if (!this.configured) {
        if (SUPABASE_URL && SUPABASE_ANON_KEY && typeof window.supabase !== 'undefined') this.configure(SUPABASE_URL, SUPABASE_ANON_KEY);
      }
      if (!this.configured) return false;
      const { data } = await sb.auth.getSession();
      session = data.session || null;
      return true;
    },

    /* ---------------- AUTH ---------------- */
    async signIn(email, password) {
      if (!this.configured) return { ok: false, error: 'Supabase not configured' };
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error || !data.session) return { ok: false, error: errorMsg(error, 'Invalid credentials. Contact your administrator.') };
      session = data.session;
      const pf = await this.refreshProfile();
      if (!pf) {
        await sb.auth.signOut();
        return { ok: false, error: 'Account has no school profile. Contact your administrator.' };
      }
      return { ok: true, profile: pf };
    },

    async refreshProfile() {
      if (!this.configured || !session) return null;
      const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (error || !data) return null;
      profile = toAuthUserMap(data);
      return profile;
    },

    async signOut() {
      if (this.configured) await sb.auth.signOut();
      session = null;
      profile = null;
      lastPull = {};
    },

    get currentProfile() { return profile; },
    get currentSession() { return session; },

    async changeMyPassword(newPassword) {
      if (!this.configured) return { ok: false, error: 'Supabase not configured' };
      const { error } = await sb.auth.updateUser({ password: newPassword });
      return error ? { ok: false, error: errorMsg(error) } : { ok: true };
    },

    /* ---------------- PROVISIONING (edge function) ---------------- */
    async provision(action, payload) {
      if (!this.configured || !session) return { ok: false, error: 'Not signed in' };
      const { data, error } = await sb.functions.invoke('provision', { body: { action, ...(payload || {}) } });
      if (error) {
        const ctx = error.context || {};
        let parsed = ctx.data || ctx.data_channel || ctx.body || ctx.Message || null;
        if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
        if (parsed && parsed.error) return { ok: false, error: parsed.error };
        const raw = typeof ctx.data === 'string' ? ctx.data : (error.message || '');
        console.error('[SMS_SUPABASE] provision failed:', error, ctx);
        if (typeof ctx.status === 'number' && ctx.status >= 400) return { ok: false, error: 'Account action rejected by server (' + ctx.status + '): ' + raw.slice(0, 300) };
        return { ok: false, error: errorMsg(error) };
      }
      return { ok: true, ...(data || {}) };
    },

    suggestPassword(name) { return this.provision('suggest-password', { name }); },
    listSchools() { return this.provision('list-schools'); },
    listUsers() { return this.provision('list-users'); },
    createSchool(payload) { return this.provision('create-school', payload); },
    createUser(payload) { return this.provision('create-user', payload); },
    resetPassword(payload) { return this.provision('reset-password', payload); },
    updateUser(payload) { return this.provision('update-user', payload); },
    deleteUser(payload) { return this.provision('delete-user', payload); },

    /* ---------------- DATA SYNC ---------------- */
    get schoolId() { return profile ? profile.schoolId : null; },

    async pullState() {
      if (!this.configured) return { ok: false, error: 'Not configured' };
      if (!session) return { ok: false, error: 'Not signed in' };
      if (!profile) await this.refreshProfile();
      if (!profile || !profile.schoolId) return { ok: false, error: 'No school on this account' };

      const out = {};
      for (const ent of ENTITIES) {
        const { data, error } = await sb.from(ent.table).select('id,data').eq('school_id', profile.schoolId);
        if (error) continue;
        const rows = data || [];
        lastPull[ent.table] = {};
        rows.forEach((r) => { lastPull[ent.table][r.id] = JSON.stringify(r.data); });
        if (ent.obj) {
          out[ent.key] = {};
          rows.forEach((r) => { out[ent.key][r.id] = r.data || {}; });
        } else {
          out[ent.key] = rows.map((r) => r.data || {});
        }
      }

      // school_config (settings + plain lists)
      try {
        const { data: cfg } = await sb.from('school_config')
          .select('settings, subjects, classes, departments, timetable_periods, opening_balance')
          .eq('school_id', profile.schoolId)
          .maybeSingle();
        if (cfg) {
          out.settings = cfg.settings || out.settings;
          out.subjects = cfg.subjects || out.subjects;
          out.classes = cfg.classes || out.classes;
          out.departments = cfg.departments || out.departments;
          out.timetablePeriods = cfg.timetable_periods || out.timetablePeriods;
          out.openingBalance = Number(cfg.opening_balance || 0);
        }
      } catch (e) { /* keep defaults */ }

      return { ok: true, state: out };
    },

    /* Row-diff upsert. Deletes rows that exist remotely but not locally. */
    async pushState(state) {
      if (!this.configured || !session) return { ok: false, error: 'Not signed in or not configured' };
      if (!profile || !profile.schoolId) return { ok: false, error: 'No school on this account' };
      const sid = profile.schoolId;

      for (const ent of ENTITIES) {
        let local = state[ent.key];
        if (ent.obj) {
          if (!local) continue;
          local = Object.keys(local).map((k) => ({ id: k, ...(local[k] || {}) }));
        }
        if (!Array.isArray(local)) continue;

        const remote = lastPull[ent.table] || {};
        const nextRemote = {};
        const upserts = [];

        local.forEach((row) => {
          if (!row || typeof row.id === 'undefined') return;
          const data = ent.obj ? { id: row.id, ...row } : row;
          const sig = JSON.stringify(data);
          if (remote[row.id] !== sig) upserts.push({ school_id: sid, id: row.id, data });
          nextRemote[row.id] = sig;
        });

        if (upserts.length) {
          // chunk to stay under postgrest URL limits
          for (let i = 0; i < upserts.length; i += 100) {
            const { error } = await sb.from(ent.table).upsert(upserts.slice(i, i + 100), { onConflict: 'school_id,id' });
            if (error) return { ok: false, error: ent.table + ': ' + errorMsg(error) };
          }
        }

        const toDelete = Object.keys(remote).filter((id) => !(id in nextRemote));
        if (toDelete.length) {
          const { error } = await sb.from(ent.table).delete().eq('school_id', sid).in('id', toDelete);
          if (error) return { ok: false, error: ent.table + ' delete: ' + errorMsg(error) };
        }

        lastPull[ent.table] = nextRemote;
      }

      // school_config upsert
      const cfg = {
        school_id: sid,
        settings: state.settings || {},
        subjects: state.subjects || [],
        classes: state.classes || [],
        departments: state.departments || [],
        timetable_periods: state.timetablePeriods || [],
        opening_balance: Number(state.openingBalance || 0),
      };
      const { error: cfgErr } = await sb.from('school_config').upsert(cfg, { onConflict: 'school_id' });
      if (cfgErr) return { ok: false, error: 'school_config: ' + errorMsg(cfgErr) };

      return { ok: true };
    },
  };

  window.SMS_SUPABASE = SMS_SUPABASE;
  console.log('[SMS_SUPABASE] client loaded. Call SMS_SUPABASE.configure(url, anonKey) or edit js/supabase-client.js SUPABASE_URL/ANON_KEY.');
})();