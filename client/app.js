const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: "http://localhost:8080",
      activeTab: "applications",
      appView: "dashboard",

      statusList: [
        { value: "saved",        label: "Saved" },
        { value: "applied",      label: "Applied" },
        { value: "interviewing", label: "Interviewing" },
        { value: "offer",        label: "Offer" },
        { value: "rejected",     label: "Rejected" },
        { value: "ghosted",      label: "Ghosted" },
      ],

      applications: [],
      gmailConnected: false,
      loading:  false,
      scanning: false,
      saving:   false,

      showModal: false,
      editing: null,
      form: { company: "", position: "", status: "applied", appliedDate: "", interviewDate: "", location: "", salary: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" },
      errors: {},

      message: "",
      messageType: "success",

      draggingApp: null,
      dragOverCol: null,
    };
  },

  computed: {
    upcomingInterviews() {
      const now = Date.now();
      return this.applications.filter((a) => {
        if (!a.interviewDate) return false;
        const diff = new Date(a.interviewDate) - now;
        return diff > 0 && diff < 7 * 86400000;
      });
    },
  },

  mounted() {
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;
      await Promise.all([this.fetchApplications(), this.fetchGmailStatus()]);
      this.loading = false;
    },

    async fetchApplications() {
      const res = await fetch(`${this.apiUrl}/applications`);
      this.applications = res.ok ? await res.json() : [];
    },

    async fetchGmailStatus() {
      const res = await fetch(`${this.apiUrl}/auth/gmail/status`).catch(() => null);
      this.gmailConnected = res?.ok ? (await res.json()).connected : false;
    },

    countByStatus(status) {
      return this.applications.filter((a) => a.status === status).length;
    },

    byStatus(status) {
      return this.applications.filter((a) => a.status === status);
    },

    isUpcoming(date) {
      const diff = new Date(date) - Date.now();
      return diff > 0 && diff < 7 * 86400000;
    },

    openModal(app) {
      this.editing = app;
      this.errors = {};
      this.form = app
        ? {
            ...app,
            appliedDate:   app.appliedDate   ? new Date(app.appliedDate).toISOString().split("T")[0]   : "",
            interviewDate: app.interviewDate ? new Date(app.interviewDate).toISOString().split("T")[0] : "",
          }
        : { company: "", position: "", status: "applied", appliedDate: "", interviewDate: "", location: "", salary: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" };
      this.showModal = true;
    },

    openModalWithStatus(status) {
      this.editing = null;
      this.errors = {};
      this.form = { company: "", position: "", status, appliedDate: "", interviewDate: "", location: "", salary: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" };
      this.showModal = true;
    },

    closeModal() {
      this.showModal = false;
      this.editing = null;
      this.errors = {};
    },

    validate() {
      const e = {};
      if (!this.form.company.trim())  e.company     = "Required";
      if (!this.form.position.trim()) e.position    = "Required";
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
        await this.fetchApplications();
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
        await this.fetchApplications();
        this.notify("Deleted");
      }
    },

    async scanInbox() {
      this.scanning = true;
      try {
        const res  = await fetch(`${this.apiUrl}/scan-inbox`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await this.fetchApplications();
        this.notify(`Scan complete — ${data.threadsFound} threads found, ${data.classified} classified`);
      } catch (err) {
        this.notify(err.message, "error");
      } finally {
        this.scanning = false;
      }
    },

    async fetchEmailSummary(app) {
      const res  = await fetch(`${this.apiUrl}/applications/${app._id}/email-summary`);
      const data = await res.json();
      if (res.ok) {
        const idx = this.applications.findIndex((a) => a._id === app._id);
        if (idx !== -1) this.applications[idx] = { ...this.applications[idx], emailSummary: data.summary };
        this.notify("Summary updated");
      } else {
        this.notify(data.error || "Failed to fetch summary", "error");
      }
    },

    dragStart(app)  { this.draggingApp = app; },
    dragEnd()       { this.draggingApp = null; this.dragOverCol = null; },
    dragOver(e)     { this.dragOverCol = e.currentTarget.dataset.col; },
    dragLeave(e)    { if (!e.currentTarget.contains(e.relatedTarget)) this.dragOverCol = null; },

    async drop(status) {
      if (!this.draggingApp || this.draggingApp.status === status) {
        this.draggingApp = null; this.dragOverCol = null; return;
      }
      const res = await fetch(`${this.apiUrl}/applications/${this.draggingApp._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        await this.fetchApplications();
        this.notify(`Moved to ${status}`);
      }
      this.draggingApp = null; this.dragOverCol = null;
    },

    fmtDate(d) {
      return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    },
    notify(msg, type = "success") {
      this.message = msg;
      this.messageType = type;
      clearTimeout(this._msgTimer);
      this._msgTimer = setTimeout(() => { this.message = ""; }, 4000);
    },
  },
}).mount("#app");
