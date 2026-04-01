const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: "http://localhost:8080",
      activeTab: "applications",

      tabs: [
        { id: "applications", label: "Applications", icon: "work" },
        { id: "followups",    label: "Follow-ups",   icon: "mail" },
        { id: "activity",     label: "History",      icon: "history" },
      ],

      statusList: [
        { value: "saved",        label: "Saved" },
        { value: "applied",      label: "Applied" },
        { value: "interviewing", label: "Interviewing" },
        { value: "offer",        label: "Offer" },
        { value: "rejected",     label: "Rejected" },
        { value: "ghosted",      label: "Ghosted" },
      ],

      applications: [],
      followUps:    [],
      activityLogs: [],

      gmailConnected: false,
      loading:  false,
      scanning: false,
      saving:   false,
      appFilter: "all",
      appView: "dashboard",

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
    filtered() {
      return this.appFilter === "all"
        ? this.applications
        : this.applications.filter((a) => a.status === this.appFilter);
    },
    pendingCount() {
      return this.followUps.filter((f) => !f.sent).length;
    },
    replyItems() {
      return this.followUps.filter((f) => f.isReply);
    },
    followUpItems() {
      return this.followUps.filter((f) => !f.isReply);
    },
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
      await Promise.all([
        this.fetchApplications(),
        this.fetchFollowUps(),
        this.fetchActivity(),
        this.fetchGmailStatus(),
      ]);
      this.loading = false;
    },

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

    countByStatus(status) {
      return this.applications.filter((a) => a.status === status).length;
    },

    byStatus(status) {
      return this.applications.filter((a) => a.status === status);
    },

    openModalWithStatus(status) {
      this.editing = null;
      this.errors = {};
      this.form = { company: "", position: "", status, appliedDate: "", interviewDate: "", location: "", salary: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" };
      this.showModal = true;
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

    async scanInbox() {
      this.scanning = true;
      try {
        const res  = await fetch(`${this.apiUrl}/scan-inbox`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await Promise.all([this.fetchApplications(), this.fetchFollowUps(), this.fetchActivity()]);
        this.notify(`Scan complete — ${data.threadsFound} threads, ${data.classified} classified, ${data.followUpsDrafted} drafts`);
        if (data.followUpsDrafted > 0) this.activeTab = "followups";
      } catch (err) {
        this.notify(err.message, "error");
      } finally {
        this.scanning = false;
      }
    },

    async draftFollowUp(app) {
      const input = prompt("Schedule send date (leave blank to save as draft only):\n(YYYY-MM-DDTHH:MM)", new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
      if (input === null) return;
      const scheduledDate = input ? new Date(input) : null;
      if (scheduledDate && isNaN(scheduledDate)) return this.notify("Invalid date", "error");
      const res = await fetch(`${this.apiUrl}/applications/${app._id}/draft-followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledDate }),
      });
      const data = await res.json();
      if (res.ok) {
        await this.fetchFollowUps();
        this.activeTab = "followups";
        this.notify(scheduledDate ? `Follow-up drafted & scheduled for ${scheduledDate.toLocaleString()}` : "Follow-up drafted");
      } else {
        this.notify(data.error, "error");
      }
    },

    async draftReply(app) {
      this.notify("Finding latest email and drafting reply…");
      const res = await fetch(`${this.apiUrl}/applications/${app._id}/draft-reply`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        await this.fetchFollowUps();
        this.activeTab = "followups";
        this.notify("Reply drafted");
      } else {
        this.notify(data.error, "error");
      }
    },

    async sendEmail(fu) {
      const res = await fetch(`${this.apiUrl}/follow-ups/${fu._id}/send`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        await Promise.all([this.fetchFollowUps(), this.fetchActivity()]);
        this.notify("Email sent");
      } else {
        this.notify(data.error, "error");
      }
    },

    async scheduleEmail(fu) {
      const input = prompt("Schedule send date and time (YYYY-MM-DDTHH:MM):", new Date(Date.now() + 86400000).toISOString().slice(0, 16));
      if (!input) return;
      const scheduledDate = new Date(input);
      if (isNaN(scheduledDate)) return this.notify("Invalid date", "error");
      const res = await fetch(`${this.apiUrl}/follow-ups/${fu._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledDate }),
      });
      if (res.ok) {
        await this.fetchFollowUps();
        this.notify(`Scheduled for ${scheduledDate.toLocaleString()}`);
      }
    },

    async deleteFollowUp(id) {
      const res = await fetch(`${this.apiUrl}/follow-ups/${id}`, { method: "DELETE" });
      if (res.ok) {
        this.followUps = this.followUps.filter((f) => f._id !== id);
        this.notify("Deleted");
      }
    },

    dragStart(app) {
      this.draggingApp = app;
    },
    dragEnd() {
      this.draggingApp = null;
      this.dragOverCol = null;
    },
    dragOver(e) {
      this.dragOverCol = e.currentTarget.dataset.col;
    },
    dragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        this.dragOverCol = null;
      }
    },
    async drop(status, e) {
      if (!this.draggingApp || this.draggingApp.status === status) {
        this.draggingApp = null;
        this.dragOverCol = null;
        return;
      }
      const res = await fetch(`${this.apiUrl}/applications/${this.draggingApp._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        await Promise.all([this.fetchApplications(), this.fetchActivity()]);
        this.notify(`Moved to ${status}`);
      }
      this.draggingApp = null;
      this.dragOverCol = null;
    },

    async fetchEmailSummary(app) {
      const res = await fetch(`${this.apiUrl}/applications/${app._id}/email-summary`);
      const data = await res.json();
      if (res.ok) {
        const idx = this.applications.findIndex(a => a._id === app._id);
        if (idx !== -1) this.applications[idx] = { ...this.applications[idx], emailSummary: data.summary };
        this.notify("Summary updated");
      } else {
        this.notify(data.error || "Failed to fetch summary", "error");
      }
    },

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
