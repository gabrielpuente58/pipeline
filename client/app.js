const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: "http://localhost:8080",
      activeTab: "applications",

      tabs: [
        { id: "applications", label: "Applications", icon: "work" },
        { id: "followups",    label: "Follow-ups",   icon: "mail" },
        { id: "activity",     label: "Activity",     icon: "history" },
      ],

      statusList: [
        { value: "applied",      label: "Applied" },
        { value: "interviewing", label: "Interviewing" },
        { value: "offer",        label: "Offer" },
        { value: "rejected",     label: "Rejected" },
        { value: "ghosted",      label: "Ghosted" },
      ],

      // Data
      applications: [],
      followUps:    [],
      activityLogs: [],

      // UI state
      gmailConnected: false,
      loading:  false,
      scanning: false,
      saving:   false,
      appFilter: "all",

      // Modal
      showModal: false,
      editing: null,
      form: { company: "", position: "", status: "applied", appliedDate: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" },
      errors: {},

      // Message banner
      message: "",
      messageType: "success",
    };
  },

  computed: {
    filtered() {
      return this.appFilter === "all"
        ? this.applications
        : this.applications.filter((a) => a.status === this.appFilter);
    },
    activeCount() {
      return this.applications.filter((a) => ["applied", "interviewing"].includes(a.status)).length;
    },
    pendingCount() {
      return this.followUps.filter((f) => !f.sent).length;
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;
      await Promise.all([
        this.fetchApplications(),
        this.fetchFollowUps(),
        this.fetchActivity(),
        this.fetchGmailStatus(),
      ]);
      this.loading = false;
    },

    // ── FETCH ───────────────────────────────────────────────────────────────

    async fetchApplications() {
      const res = await fetch(`${this.apiUrl}/applications`);
      this.applications = res.ok ? await res.json() : [];
    },

    async fetchFollowUps() {
      const res = await fetch(`${this.apiUrl}/follow-ups`);
      this.followUps = res.ok ? await res.json() : [];
    },

    async fetchActivity() {
      const res = await fetch(`${this.apiUrl}/activity-logs`);
      this.activityLogs = res.ok ? await res.json() : [];
    },

    async fetchGmailStatus() {
      const res = await fetch(`${this.apiUrl}/auth/gmail/status`).catch(() => null);
      this.gmailConnected = res?.ok ? (await res.json()).connected : false;
    },

    // ── APPLICATIONS ────────────────────────────────────────────────────────

    countByStatus(status) {
      return this.applications.filter((a) => a.status === status).length;
    },

    openModal(app) {
      this.editing = app;
      this.errors = {};
      this.form = app
        ? { ...app, appliedDate: app.appliedDate ? new Date(app.appliedDate).toISOString().split("T")[0] : "" }
        : { company: "", position: "", status: "applied", appliedDate: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" };
      this.showModal = true;
    },

    closeModal() {
      this.showModal = false;
      this.editing = null;
      this.errors = {};
    },

    validate() {
      const e = {};
      if (!this.form.company.trim())  e.company   = "Required";
      if (!this.form.position.trim()) e.position  = "Required";
      if (!this.form.appliedDate)     e.appliedDate = "Required";
      this.errors = e;
      return !Object.keys(e).length;
    },

    async saveApp() {
      if (!this.validate()) return;
      this.saving = true;
      try {
        const url    = this.editing ? `${this.apiUrl}/applications/${this.editing._id}` : `${this.apiUrl}/applications`;
        const method = this.editing ? "PUT" : "POST";
        const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.form) });
        const data   = await res.json();
        if (!res.ok) throw new Error(data.error);
        this.closeModal();
        await Promise.all([this.fetchApplications(), this.fetchActivity()]);
        this.notify(this.editing ? "Application updated" : "Application added");
      } catch (err) {
        this.notify(err.message, "error");
      } finally {
        this.saving = false;
      }
    },

    async deleteApp(id) {
      if (!confirm("Delete this application?")) return;
      const res = await fetch(`${this.apiUrl}/applications/${id}`, { method: "DELETE" });
      if (res.ok) {
        await Promise.all([this.fetchApplications(), this.fetchFollowUps(), this.fetchActivity()]);
        this.notify("Deleted");
      }
    },

    // ── SCAN INBOX ──────────────────────────────────────────────────────────

    async scanInbox() {
      this.scanning = true;
      try {
        const res  = await fetch(`${this.apiUrl}/scan-inbox`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await Promise.all([this.fetchApplications(), this.fetchFollowUps(), this.fetchActivity()]);
        this.notify(`Scan complete — ${data.threadsFound} threads, ${data.classified} classified, ${data.followUpsDrafted} drafts`);
        this.activeTab = "followups";
      } catch (err) {
        this.notify(err.message, "error");
      } finally {
        this.scanning = false;
      }
    },

    // ── FOLLOW-UPS ──────────────────────────────────────────────────────────

    async markSent(fu) {
      const res = await fetch(`${this.apiUrl}/follow-ups/${fu._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sent: true }),
      });
      if (res.ok) {
        await Promise.all([this.fetchFollowUps(), this.fetchActivity()]);
        this.notify("Marked as sent");
      }
    },

    async deleteFollowUp(id) {
      const res = await fetch(`${this.apiUrl}/follow-ups/${id}`, { method: "DELETE" });
      if (res.ok) { this.followUps = this.followUps.filter((f) => f._id !== id); this.notify("Deleted"); }
    },

    // ── UTILITIES ───────────────────────────────────────────────────────────

    fmtDate(d) {
      return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    },

    fmtDateTime(d) {
      return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    },

    notify(msg, type = "success") {
      this.message = msg;
      this.messageType = type;
      clearTimeout(this._msgTimer);
      this._msgTimer = setTimeout(() => { this.message = ""; }, 4000);
    },
  },
}).mount("#app");
