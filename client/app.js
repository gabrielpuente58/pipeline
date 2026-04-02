const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: 'http://localhost:8080',
      screen: 'profile', // 'profile' | 'chat' | 'loading' | 'board'

      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],

      profile: { height: '', weight: '', age: '', sex: '' },
      workouts: { Mon: '', Tue: '', Wed: '', Thu: '', Fri: '', Sat: '', Sun: '' },
      foodPreference: '',

      suggestions: [
        'High Protein', 'Low Carb', 'Mediterranean', 'Vegetarian',
        'Quick Meals', 'Comfort Food', 'Asian', 'Budget Friendly',
        'No Dairy', 'No Gluten', 'Spicy', 'Meal Prep Friendly',
      ],

      errors: {},
      globalError: '',
      generating: false,

      statusMessage: 'Initializing…',
      plan: null,
      userId: null,
      detailDay: null,
    };
  },

  mounted() {
    try {
      const saved = JSON.parse(localStorage.getItem('nourishweek_profile') || 'null');
      if (saved) {
        this.profile = { height: saved.height, weight: saved.weight, age: saved.age, sex: saved.sex };
        this.userId  = saved.userId || null;
        this.screen  = 'chat'; // skip profile screen
      }
    } catch {}
  },

  computed: {
    avgCalories() {
      if (!this.plan || !this.plan.days.length) return 0;
      const total = this.plan.days.reduce((s, d) => s + (d.calories || 0), 0);
      return Math.round(total / this.plan.days.length);
    },
  },

  methods: {
    // ── Navigation ────────────────────────────────────────────────────────────

    goToChat() {
      const e = {};
      if (!this.profile.height || this.profile.height <= 0) e.height = 'Required, must be > 0';
      if (!this.profile.weight || this.profile.weight <= 0) e.weight = 'Required, must be > 0';
      if (!this.profile.age    || this.profile.age    <= 0) e.age    = 'Required, must be > 0';
      if (!this.profile.sex) e.sex = 'Please select';
      this.errors = e;
      if (Object.keys(e).length) return;
      this.screen = 'chat';
    },

    goToProfile() {
      this.screen = 'profile';
      this.errors = {};
    },

    clearProfile() {
      localStorage.removeItem('nourishweek_profile');
      this.profile = { height: '', weight: '', age: '', sex: '' };
      this.userId  = null;
      this.plan    = null;
      this.errors  = {};
      this.globalError = '';
      this.screen  = 'profile';
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
      const hasWorkout = this.days.some(d => this.workouts[d].trim());
      if (!hasWorkout) e.workouts = 'Enter at least one workout';
      if (!this.foodPreference.trim()) e.foodPreference = 'Tell us what you want to eat';
      this.errors = e;
      if (Object.keys(e).length) return;

      this.generating = true;
      this.globalError = '';
      this.screen = 'loading';
      this.statusMessage = 'Initializing…';

      try {
        // Reuse saved userId if we already have one, otherwise create a new user
        if (!this.userId) {
          const userRes = await fetch(`${this.apiUrl}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.profile),
          });
          const userData = await userRes.json();
          if (!userRes.ok) throw new Error(userData.error);
          this.userId = userData._id;
          localStorage.setItem('nourishweek_profile', JSON.stringify({ ...this.profile, userId: this.userId }));
        }

        await this.streamMealPlan();
      } catch (err) {
        this.globalError = err.message;
        this.screen = 'chat';
        this.generating = false;
      }
    },

    streamMealPlan() {
      return new Promise((resolve, reject) => {
        fetch(`${this.apiUrl}/meal-plans`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: this.userId,
            workouts: this.workouts,
            foodPreference: this.foodPreference,
          }),
        }).then(response => {
          if (!response.ok) {
            return response.json().then(d => reject(new Error(d.error || 'Server error')));
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

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
      const res = await fetch(`${this.apiUrl}/meal-plans/${planId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      this.plan = data;
      this.generating = false;
      this.screen = 'board';
    },

    regenerate() {
      this.screen = 'chat';
      this.plan = null;
      this.userId = null;
      this.errors = {};
      this.globalError = '';
      this.generating = false;
    },

    // ── Board ─────────────────────────────────────────────────────────────────

    openDetail(day) { this.detailDay = day; },
    closeDetail()   { this.detailDay = null; },

    maxMacro(day) {
      return Math.max(day.macros?.protein || 0, day.macros?.carbs || 0, day.macros?.fat || 0, 1);
    },
  },
}).mount('#app');
