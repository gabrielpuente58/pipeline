const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: 'http://localhost:8080',
      screen: 'auth', // 'auth' | 'workout' | 'loading' | 'board'

      // Auth state
      authMode: 'login', // 'login' | 'register'
      token: null,
      userId: null,
      email: '',
      password: '',
      confirmPassword: '',
      heightFt: '',
      heightIn: '',
      weightLbs: '',
      age: '',
      sex: '',

      workouts: { swim: 0, bike: 0, run: 0, lift: 0 }, // minutes
      foodPreference: '',

      suggestions: [
        'High Protein', 'Low Carb', 'Mediterranean', 'Vegetarian',
        'Quick Meals', 'No Dairy', 'No Gluten', 'Spicy',
      ],

      errors: {},
      globalError: '',
      generating: false,

      statusMessage: 'Initializing…',
      plan: null,
      detailMeal: null,
    };
  },

  mounted() {
    try {
      const saved = JSON.parse(localStorage.getItem('nw_auth') || 'null');
      if (saved?.token) {
        this.token  = saved.token;
        this.userId = saved.userId;
        this.email  = saved.email || '';
        this.screen = 'workout';
      }
    } catch {}
  },

  computed: {
    avgCalories() {
      return this.plan?.totalCalories || 0;
    },

    workoutSummary() {
      const sports = [
        { key: 'swim', icon: 'pool',           label: 'Swim' },
        { key: 'bike', icon: 'directions_bike', label: 'Bike' },
        { key: 'run',  icon: 'directions_run',  label: 'Run'  },
        { key: 'lift', icon: 'fitness_center',  label: 'Lift' },
      ];
      return sports
        .filter(s => this.workouts[s.key] > 0)
        .map(s => ({ ...s, duration: this.formatDuration(this.workouts[s.key]) }));
    },
  },

  methods: {
    // ── Formatting ────────────────────────────────────────────────────────────

    formatDuration(min) {
      if (!min || min === 0) return 'Off';
      if (min < 60) return `${min} min`;
      const h = Math.floor(min / 60);
      const m = min % 60;
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    },

    sliderStyle(value, color) {
      const pct = (value / 240) * 100;
      return `background: linear-gradient(to right, ${color} ${pct}%, var(--surface2) ${pct}%)`;
    },

    // ── Auth ──────────────────────────────────────────────────────────────────

    async login() {
      const e = {};
      if (!this.email.trim())    e.email    = 'Email is required';
      if (!this.password)        e.password = 'Password is required';
      this.errors = e;
      if (Object.keys(e).length) return;

      this.generating  = true;
      this.globalError = '';

      try {
        const res  = await fetch(`${this.apiUrl}/auth/login`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email: this.email, password: this.password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        this._saveAuth(data);
        this.screen = 'workout';
      } catch (err) {
        this.globalError = err.message;
      } finally {
        this.generating = false;
      }
    },

    async register() {
      const e = {};
      if (!this.email.trim())               e.email           = 'Email is required';
      if (!this.password)                   e.password        = 'Password is required';
      if (this.password !== this.confirmPassword) e.confirmPassword = 'Passwords do not match';
      if (!this.heightFt || this.heightFt < 1 || this.heightFt > 8) e.heightFt = 'Enter feet (1–8)';
      if (this.heightIn === '' || this.heightIn < 0 || this.heightIn > 11) e.heightIn = 'Enter inches (0–11)';
      if (!this.weightLbs || this.weightLbs <= 0) e.weightLbs = 'Required, must be > 0';
      if (!this.age       || this.age       <= 0) e.age       = 'Required, must be > 0';
      if (!this.sex)                        e.sex             = 'Please select';
      this.errors = e;
      if (Object.keys(e).length) return;

      this.generating  = true;
      this.globalError = '';

      try {
        const res  = await fetch(`${this.apiUrl}/auth/register`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            email:     this.email,
            password:  this.password,
            heightFt:  this.heightFt,
            heightIn:  this.heightIn,
            weightLbs: this.weightLbs,
            age:       this.age,
            sex:       this.sex,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration failed');

        this._saveAuth(data);
        this.screen = 'workout';
      } catch (err) {
        this.globalError = err.message;
      } finally {
        this.generating = false;
      }
    },

    _saveAuth(data) {
      this.token  = data.token;
      this.userId = data.userId || data._id;
      const payload = {
        token:     data.token,
        userId:    this.userId,
        email:     this.email,
        heightFt:  data.heightFt  || this.heightFt,
        heightIn:  data.heightIn  || this.heightIn,
        weightLbs: data.weightLbs || this.weightLbs,
        age:       data.age       || this.age,
        sex:       data.sex       || this.sex,
      };
      localStorage.setItem('nw_auth', JSON.stringify(payload));
    },

    logout() {
      localStorage.removeItem('nw_auth');
      this.token          = null;
      this.userId         = null;
      this.email          = '';
      this.password       = '';
      this.confirmPassword = '';
      this.heightFt       = '';
      this.heightIn       = '';
      this.weightLbs      = '';
      this.age            = '';
      this.sex            = '';
      this.plan           = null;
      this.errors         = {};
      this.globalError    = '';
      this.authMode       = 'login';
      this.screen         = 'auth';
    },

    // ── Navigation ────────────────────────────────────────────────────────────

    regenerate() {
      this.plan        = null;
      this.errors      = {};
      this.globalError = '';
      this.generating  = false;
      this.screen      = 'workout';
    },

    addSuggestion(chip) {
      const current = this.foodPreference.trim();
      if (current && !current.endsWith(',')) {
        this.foodPreference = current + ', ' + chip;
      } else {
        this.foodPreference = (current ? current + ' ' : '') + chip;
      }
    },

    // ── Generation ────────────────────────────────────────────────────────────

    async generate() {
      const e = {};
      const hasWorkout = Object.values(this.workouts).some(v => v > 0);
      if (!hasWorkout) e.workouts = 'Set at least one workout duration';
      if (!this.foodPreference.trim()) e.foodPreference = 'Tell us what you want to eat';
      this.errors = e;
      if (Object.keys(e).length) return;

      this.generating    = true;
      this.globalError   = '';
      this.screen        = 'loading';
      this.statusMessage = 'Initializing…';

      try {
        await this.streamDailyPlan();
      } catch (err) {
        this.globalError = err.message;
        this.screen      = 'workout';
        this.generating  = false;
      }
    },

    streamDailyPlan() {
      return new Promise((resolve, reject) => {
        fetch(`${this.apiUrl}/daily-plans`, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            workouts:       this.workouts,
            foodPreference: this.foodPreference,
          }),
        }).then(response => {
          if (!response.ok) {
            return response.json().then(d => reject(new Error(d.error || 'Server error')));
          }
          const reader  = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer    = '';

          const read = () => {
            reader.read().then(({ done, value }) => {
              if (done) { resolve(); return; }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed.status) this.statusMessage = parsed.status;
                    if (parsed.error) { reject(new Error(parsed.error)); return; }
                    if (parsed.done && parsed.planId) {
                      this.loadPlan(parsed.planId).then(resolve).catch(reject);
                      return;
                    }
                  } catch {}
                }
              }
              read();
            }).catch(reject);
          };
          read();
        }).catch(reject);
      });
    },

    async loadPlan(planId) {
      const res  = await fetch(`${this.apiUrl}/daily-plans/${planId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      this.plan       = data;
      this.generating = false;
      this.screen     = 'board';
    },

    // ── Board ─────────────────────────────────────────────────────────────────

    openDetail(meal) { this.detailMeal = meal; },
    closeDetail()    { this.detailMeal = null; },

    maxMacro(meal) {
      return Math.max(meal.macros?.protein || 0, meal.macros?.carbs || 0, meal.macros?.fat || 0, 1);
    },

    capitalize(str) {
      return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    },
  },
}).mount('#app');
