const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: 'http://localhost:8080',
      screen: 'profile', // 'profile' | 'workout' | 'loading' | 'board'

      profile: { height: '', weight: '', age: '', sex: '' },
      userId: null,

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
      const saved = JSON.parse(localStorage.getItem('nw_profile') || 'null');
      if (saved) {
        this.profile = { height: saved.height, weight: saved.weight, age: saved.age, sex: saved.sex };
        this.userId  = saved.userId || null;
        this.screen  = 'workout';
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

    // ── Navigation ────────────────────────────────────────────────────────────

    goToProfile() {
      this.screen = 'profile';
      this.errors = {};
      this.globalError = '';
    },

    goToWorkout() {
      const e = {};
      if (!this.profile.height || this.profile.height <= 0) e.height = 'Required, must be > 0';
      if (!this.profile.weight || this.profile.weight <= 0) e.weight = 'Required, must be > 0';
      if (!this.profile.age    || this.profile.age    <= 0) e.age    = 'Required, must be > 0';
      if (!this.profile.sex) e.sex = 'Please select';
      this.errors = e;
      if (Object.keys(e).length) return;
      this.screen = 'workout';
    },

    clearProfile() {
      localStorage.removeItem('nw_profile');
      this.profile     = { height: '', weight: '', age: '', sex: '' };
      this.userId      = null;
      this.plan        = null;
      this.errors      = {};
      this.globalError = '';
      this.screen      = 'profile';
    },

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
        if (!this.userId) {
          const userRes = await fetch(`${this.apiUrl}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.profile),
          });
          const userData = await userRes.json();
          if (!userRes.ok) throw new Error(userData.error);
          this.userId = userData._id;
          localStorage.setItem('nw_profile', JSON.stringify({ ...this.profile, userId: this.userId }));
        }

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId:         this.userId,
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
      const res  = await fetch(`${this.apiUrl}/daily-plans/${planId}`);
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
