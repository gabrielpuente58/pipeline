const { createApp } = Vue;

createApp({
  data() {
    return {
      apiUrl: "http://localhost:8080",
      activeTab: "dashboard",

      tabs: [
        { id: "dashboard",    label: "Dashboard",    icon: "dashboard" },
        { id: "applications", label: "Applications", icon: "work" },
        { id: "contacts",     label: "Contacts",     icon: "contacts" },
        { id: "followups",    label: "Follow-ups",   icon: "mail" },
      ],

      statusFilters: [
        { value: "all",          label: "All" },
        { value: "applied",      label: "Applied" },
        { value: "interviewing", label: "Interviewing" },
        { value: "offer",        label: "Offer" },
        { value: "rejected",     label: "Rejected" },
        { value: "ghosted",      label: "Ghosted" },
      ],

      // Gmail
      gmailConnected: false,

      // Applications
      applications: [],
      applicationsLoading: false,
      appFilter: "all",
      showAppModal: false,
      editingApp: null,
      appForm: { company: "", position: "", status: "applied", appliedDate: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" },
      appErrors: {},
      appSaving: false,

      // Scanning
      scanning: false,

      // Contacts
      contacts: [],
      contactsLoading: false,
      showContactModal: false,
      editingContact: null,
      contactForm: { name: "", email: "", company: "", role: "", linkedinUrl: "", notes: "" },
      contactErrors: {},
      contactSaving: false,

      // Follow-ups
      followUps: [],
      followUpsLoading: false,

      // Activity
      activityLogs: [],
      activityLoading: false,

      // Global message
      globalMessage: "",
      globalMessageType: "success",
      globalMessageTimer: null,
    };
  },

  computed: {
    filteredApplications() {
      if (this.appFilter === "all") return this.applications;
      return this.applications.filter((a) => a.status === this.appFilter);
    },

    activeCount() {
      return this.applications.filter((a) => ["applied", "interviewing"].includes(a.status)).length;
    },

    pendingFollowUps() {
      return this.followUps.filter((f) => !f.sent).length;
    },
  },

  mounted() {
    this.fetchGmailStatus();
    this.fetchApplications();
    this.fetchContacts();
    this.fetchFollowUps();
    this.fetchActivityLogs();
  },

  methods: {

    // ── GMAIL ─────────────────────────────────────────────────────────────────

    async fetchGmailStatus() {
      try {
        const res = await fetch(`${this.apiUrl}/auth/gmail/status`);
        const data = await res.json();
        this.gmailConnected = data.connected;
      } catch {
        this.gmailConnected = false;
      }
    },

    connectGmail() {
      window.open(`${this.apiUrl}/auth/gmail`, "_blank", "width=500,height=600");
      setTimeout(() => this.fetchGmailStatus(), 5000);
    },

    // ── APPLICATIONS ──────────────────────────────────────────────────────────

    async fetchApplications() {
      this.applicationsLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/applications`);
        if (!res.ok) throw new Error("Failed to load applications");
        this.applications = await res.json();
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.applicationsLoading = false;
      }
    },

    countByStatus(status) {
      return this.applications.filter((a) => a.status === status).length;
    },

    openAppModal(app) {
      this.editingApp = app;
      if (app) {
        this.appForm = {
          company: app.company,
          position: app.position,
          status: app.status,
          appliedDate: app.appliedDate ? new Date(app.appliedDate).toISOString().split("T")[0] : "",
          jobUrl: app.jobUrl || "",
          notes: app.notes || "",
          contactName: app.contactName || "",
          contactEmail: app.contactEmail || "",
        };
      } else {
        this.appForm = { company: "", position: "", status: "applied", appliedDate: "", jobUrl: "", notes: "", contactName: "", contactEmail: "" };
      }
      this.appErrors = {};
      this.showAppModal = true;
    },

    closeAppModal() {
      this.showAppModal = false;
      this.editingApp = null;
      this.appErrors = {};
    },

    validateApp() {
      const e = {};
      if (!this.appForm.company.trim())   e.company   = "Company is required";
      if (!this.appForm.position.trim())  e.position  = "Position is required";
      if (!this.appForm.appliedDate)      e.appliedDate = "Applied date is required";
      this.appErrors = e;
      return Object.keys(e).length === 0;
    },

    async saveApp() {
      if (!this.validateApp()) return;
      this.appSaving = true;
      try {
        let res;
        if (this.editingApp) {
          res = await fetch(`${this.apiUrl}/applications/${this.editingApp._id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.appForm),
          });
        } else {
          res = await fetch(`${this.apiUrl}/applications`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.appForm),
          });
        }
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save");
        }
        this.closeAppModal();
        await Promise.all([this.fetchApplications(), this.fetchActivityLogs()]);
        this.showMessage(this.editingApp ? "Application updated" : "Application added", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.appSaving = false;
      }
    },

    async deleteApp(id) {
      if (!confirm("Delete this application? This cannot be undone.")) return;
      try {
        const res = await fetch(`${this.apiUrl}/applications/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete");
        this.applications = this.applications.filter((a) => a._id !== id);
        await Promise.all([this.fetchFollowUps(), this.fetchActivityLogs()]);
        this.showMessage("Application deleted", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    // ── SCAN INBOX ────────────────────────────────────────────────────────────

    async scanInbox() {
      this.scanning = true;
      try {
        const res = await fetch(`${this.apiUrl}/scan-inbox`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Scan failed");
        await Promise.all([
          this.fetchApplications(),
          this.fetchFollowUps(),
          this.fetchActivityLogs(),
        ]);
        this.showMessage(
          `Scan complete — ${data.threadsFound} threads found, ${data.classified} classified, ${data.followUpsDrafted} follow-ups drafted`,
          "success"
        );
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.scanning = false;
      }
    },

    // ── CONTACTS ──────────────────────────────────────────────────────────────

    async fetchContacts() {
      this.contactsLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/contacts`);
        if (!res.ok) throw new Error("Failed to load contacts");
        this.contacts = await res.json();
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.contactsLoading = false;
      }
    },

    openContactModal(contact) {
      this.editingContact = contact;
      if (contact) {
        this.contactForm = {
          name: contact.name,
          email: contact.email,
          company: contact.company,
          role: contact.role || "",
          linkedinUrl: contact.linkedinUrl || "",
          notes: contact.notes || "",
        };
      } else {
        this.contactForm = { name: "", email: "", company: "", role: "", linkedinUrl: "", notes: "" };
      }
      this.contactErrors = {};
      this.showContactModal = true;
    },

    closeContactModal() {
      this.showContactModal = false;
      this.editingContact = null;
      this.contactErrors = {};
    },

    validateContact() {
      const e = {};
      if (!this.contactForm.name.trim())    e.name    = "Name is required";
      if (!this.contactForm.email.trim())   e.email   = "Email is required";
      if (!this.contactForm.company.trim()) e.company = "Company is required";
      this.contactErrors = e;
      return Object.keys(e).length === 0;
    },

    async saveContact() {
      if (!this.validateContact()) return;
      this.contactSaving = true;
      try {
        let res;
        if (this.editingContact) {
          res = await fetch(`${this.apiUrl}/contacts/${this.editingContact._id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.contactForm),
          });
        } else {
          res = await fetch(`${this.apiUrl}/contacts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(this.contactForm),
          });
        }
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save contact");
        }
        this.closeContactModal();
        await this.fetchContacts();
        this.showMessage(this.editingContact ? "Contact updated" : "Contact added", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.contactSaving = false;
      }
    },

    async deleteContact(id) {
      if (!confirm("Delete this contact?")) return;
      try {
        const res = await fetch(`${this.apiUrl}/contacts/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete contact");
        this.contacts = this.contacts.filter((c) => c._id !== id);
        this.showMessage("Contact deleted", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    // ── FOLLOW-UPS ────────────────────────────────────────────────────────────

    async fetchFollowUps() {
      this.followUpsLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/follow-ups`);
        if (!res.ok) throw new Error("Failed to load follow-ups");
        this.followUps = await res.json();
      } catch (err) {
        this.showMessage(err.message, "error");
      } finally {
        this.followUpsLoading = false;
      }
    },

    async markSent(fu) {
      try {
        const res = await fetch(`${this.apiUrl}/follow-ups/${fu._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sent: true }),
        });
        if (!res.ok) throw new Error("Failed to update follow-up");
        const updated = await res.json();
        const idx = this.followUps.findIndex((f) => f._id === fu._id);
        if (idx !== -1) this.followUps[idx] = updated;
        await this.fetchActivityLogs();
        this.showMessage("Marked as sent", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    async deleteFollowUp(id) {
      try {
        const res = await fetch(`${this.apiUrl}/follow-ups/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete follow-up");
        this.followUps = this.followUps.filter((f) => f._id !== id);
        this.showMessage("Follow-up deleted", "success");
      } catch (err) {
        this.showMessage(err.message, "error");
      }
    },

    // ── ACTIVITY LOGS ─────────────────────────────────────────────────────────

    async fetchActivityLogs() {
      this.activityLoading = true;
      try {
        const res = await fetch(`${this.apiUrl}/activity-logs`);
        if (!res.ok) throw new Error("Failed to load activity");
        this.activityLogs = await res.json();
      } catch (err) {
        console.error(err);
      } finally {
        this.activityLoading = false;
      }
    },

    eventIcon(event) {
      const icons = {
        "status-change":   "swap_horiz",
        "email-received":  "mail",
        "follow-up-sent":  "send",
        "ai-scan":         "auto_awesome",
        "created":         "add_circle",
        "updated":         "edit",
      };
      return icons[event] || "circle";
    },

    // ── UTILITIES ─────────────────────────────────────────────────────────────

    formatDate(dateStr) {
      if (!dateStr) return "";
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    },

    formatShortDate(dateStr) {
      if (!dateStr) return "";
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
    },

    showMessage(msg, type = "success") {
      this.globalMessage = msg;
      this.globalMessageType = type;
      if (this.globalMessageTimer) clearTimeout(this.globalMessageTimer);
      this.globalMessageTimer = setTimeout(() => { this.globalMessage = ""; }, 5000);
    },
  },
}).mount("#app");
