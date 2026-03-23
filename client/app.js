const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: "http://localhost:8080",
      activeTab: "profile",

      tabs: [
        { id: "profile", label: "Profile", icon: "person" },
        { id: "checklist", label: "Checklist", icon: "checklist" },
        { id: "mealplan", label: "Meal Plan", icon: "restaurant" },
        { id: "timeline", label: "Timeline", icon: "schedule" },
      ],

      checklistCategories: [
        { id: "swim", label: "Swim", icon: "pool" },
        { id: "bike", label: "Bike", icon: "directions_bike" },
        { id: "run", label: "Run", icon: "directions_run" },
        { id: "t1", label: "T1 — Swim to Bike", icon: "transfer_within_a_station" },
        { id: "t2", label: "T2 — Bike to Run", icon: "transfer_within_a_station" },
        { id: "nutrition", label: "Nutrition", icon: "restaurant" },
      ],

      // Athlete
      athlete: null,
      profileLoading: false,
      profileForm: {
        name: "",
        gender: "",
        height: "",
        weight: "",
        raceDate: "",
        raceLocation: "",
        profilePicture: "",
      },
      profileErrors: {},

      // Checklist
      checklist: [],
      checklistLoading: false,

      // Meal Plan
      mealPlan: null,
      generatingPlan: false,

      // Reminders
      reminders: [],
      remindersLoading: false,

      // Global message
      globalMessage: "",
      globalMessageType: "success",
      globalMessageTimer: null,
    };
  },

  computed: {
    daysUntilRace() {
      if (!this.athlete || !this.athlete.raceDate) return null;
      const diff = new Date(this.athlete.raceDate) - new Date();
      return Math.ceil(diff / (1000 * 60 * 60 * 24));
    },

    urgencyClass() {
      const d = this.daysUntilRace;
      if (d === null) return "";
      if (d <= 7) return "urgent";
      if (d <= 30) return "soon";
      return "plenty";
    },

    checkedCount() {
      return this.checklist.filter((i) => i.checked).length;
    },

    purchasedCount() {
      return this.checklist.filter((i) => i.purchased).length;
    },

    sortedReminders() {
      return [...this.reminders].sort((a, b) => b.daysBeforeRace - a.daysBeforeRace);
    },
  },

  mounted() {
    this.fetchAthlete();
    this.fetchChecklist();
    this.fetchMealPlan();
    this.fetchReminders();
  },

  methods: {
    // ── PROFILE ──────────────────────────────────────────────────────────────

    async fetchAthlete() {
      try {
        const res = await fetch(`${this.apiUrl}/athlete`);
        if (res.status === 404) return;
        if (!res.ok) throw new Error("Failed to load profile");
        this.athlete = await res.json();
        this.fillProfileForm(this.athlete);
      } catch (err) {
        console.error(err);
      }
    },

    fillProfileForm(athlete) {
      this.profileForm.name = athlete.name;
      this.profileForm.gender = athlete.gender;
      this.profileForm.height = athlete.height;
      this.profileForm.weight = athlete.weight;
      this.profileForm.raceDate = athlete.raceDate
        ? new Date(athlete.raceDate).toISOString().split("T")[0]
        : "";
      this.profileForm.raceLocation = athlete.raceLocation;
      this.profileForm.profilePicture = athlete.profilePicture || "";
    },

    validateProfile() {
      const errors = {};
      if (!this.profileForm.name.trim()) errors.name = "Name is required";
      if (!this.profileForm.gender) errors.gender = "Gender is required";

      const h = Number(this.profileForm.height);
      if (!this.profileForm.height) errors.height = "Height is required";
      else if (h < 36 || h > 108) errors.height = "Height must be between 36 and 108 inches";

      const w = Number(this.profileForm.weight);
      if (!this.profileForm.weight) errors.weight = "Weight is required";
      else if (w < 50 || w > 500) errors.weight = "Weight must be between 50 and 500 lbs";

      if (!this.profileForm.raceDate) {
        errors.raceDate = "Race date is required";
      } else if (new Date(this.profileForm.raceDate) <= new Date()) {
        errors.raceDate = "Race date must be in the future";
      }

      if (!this.profileForm.raceLocation.trim()) errors.raceLocation = "Race location is required";

      this.profileErrors = errors;
      return Object.keys(errors).length === 0;
    },

    async saveProfile() {
      if (!this.validateProfile()) return;
      this.profileLoading = true;

      try {
        let res;
        if (this.athlete) {
          res = await fetch(`${this.apiUrl}/athlete/${this.athlete._id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.profileForm),
          });
        } else {
          res = await fetch(`${this.apiUrl}/athlete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.profileForm),
          });
        }

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save profile");
        }

        this.athlete = await res.json();
        this.showMessage("Profile saved successfully!", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.profileLoading = false;
      }
    },

    // ── CHECKLIST ─────────────────────────────────────────────────────────────

    async fetchChecklist() {
      this.checklistLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/checklist`);
        if (!res.ok) throw new Error("Failed to load checklist");
        this.checklist = await res.json();
      } catch (err) {
        console.error(err);
      } finally {
        this.checklistLoading = false;
      }
    },

    getCategoryItems(categoryId) {
      return this.checklist.filter((i) => i.category === categoryId);
    },

    getCategoryCheckedCount(categoryId) {
      return this.getCategoryItems(categoryId).filter((i) => i.checked).length;
    },

    async toggleChecked(item) {
      try {
        const res = await fetch(`${this.apiUrl}/checklist/${item._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checked: !item.checked }),
        });
        if (!res.ok) throw new Error("Failed to update item");
        const updated = await res.json();
        const idx = this.checklist.findIndex((i) => i._id === item._id);
        if (idx !== -1) this.checklist[idx] = updated;
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    async togglePurchased(item) {
      try {
        const res = await fetch(`${this.apiUrl}/checklist/${item._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchased: !item.purchased }),
        });
        if (!res.ok) throw new Error("Failed to update item");
        const updated = await res.json();
        const idx = this.checklist.findIndex((i) => i._id === item._id);
        if (idx !== -1) this.checklist[idx] = updated;
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    async deleteChecklistItem(id) {
      try {
        const res = await fetch(`${this.apiUrl}/checklist/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete item");
        this.checklist = this.checklist.filter((i) => i._id !== id);
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    // ── MEAL PLAN ────────────────────────────────────────────────────────────

    async fetchMealPlan() {
      try {
        const res = await fetch(`${this.apiUrl}/meal-plan`);
        if (res.status === 404) return;
        if (!res.ok) throw new Error("Failed to load meal plan");
        this.mealPlan = await res.json();
      } catch (err) {
        console.error(err);
      }
    },

    async generatePlan() {
      if (!this.athlete) return;
      this.generatingPlan = true;

      try {
        const res = await fetch(`${this.apiUrl}/generate-plan`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to generate plan");
        }
        const data = await res.json();
        this.mealPlan = data.mealPlan;
        this.reminders = data.reminders;
        this.showMessage("Plan generated successfully!", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.generatingPlan = false;
      }
    },

    // ── REMINDERS ────────────────────────────────────────────────────────────

    async fetchReminders() {
      this.remindersLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/reminders`);
        if (!res.ok) throw new Error("Failed to load reminders");
        this.reminders = await res.json();
      } catch (err) {
        console.error(err);
      } finally {
        this.remindersLoading = false;
      }
    },

    getCategoryIcon(category) {
      const icons = {
        purchase: "shopping_cart",
        maintenance: "build",
        training: "fitness_center",
        nutrition: "restaurant",
        logistics: "checklist",
      };
      return icons[category] || "notifications";
    },

    // ── UTILITIES ────────────────────────────────────────────────────────────

    formatDate(dateStr) {
      if (!dateStr) return "";
      return new Date(dateStr).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    },

    showMessage(msg, type = "success") {
      this.globalMessage = msg;
      this.globalMessageType = type;
      if (this.globalMessageTimer) clearTimeout(this.globalMessageTimer);
      this.globalMessageTimer = setTimeout(() => {
        this.globalMessage = "";
      }, 4000);
    },
  },
}).mount("#app");
