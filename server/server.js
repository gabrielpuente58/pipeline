require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const { Ollama } = require("ollama");
const { StateGraph, START, END } = require("@langchain/langgraph");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI    = process.env.MONGODB_URI    || "mongodb://localhost:27017";
const DB_NAME        = process.env.DB_NAME        || "pipeline";
const OLLAMA_HOST    = process.env.OLLAMA_HOST    || "http://golem:11434";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || "gpt-oss:20b";
const PORT           = process.env.PORT           || 8080;
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/gmail/callback`;

const ollama = new Ollama({ host: OLLAMA_HOST });

// ─── DATABASE ─────────────────────────────────────────────────────────────────

mongoose
  .connect(`${MONGODB_URI}/${DB_NAME}`)
  .then(() => {
    console.log("Connected to MongoDB");
    // seed one example application if the collection is empty
    Application.countDocuments().then((n) => {
      if (n === 0) {
        Application.create({
          company: "Google", position: "Software Engineer II",
          status: "interviewing", appliedDate: new Date(Date.now() - 14 * 86400000),
          notes: "Phone screen scheduled.", contactName: "Sarah Chen", contactEmail: "schen@google.com",
        });
      }
    });
  })
  .catch((err) => console.error("MongoDB error:", err));

// ─── SCHEMAS (all defined here — no separate model files) ─────────────────────

const Application = mongoose.model("Application", new mongoose.Schema({
  company:      { type: String, required: [true, "Company is required"] },
  position:     { type: String, required: [true, "Position is required"] },
  status:       { type: String, enum: ["saved", "applied", "interviewing", "offer", "rejected", "ghosted"], default: "applied" },
  appliedDate:  { type: Date,   required: [true, "Applied date is required"] },
  location:      String,
  salary:        String,
  jobUrl:        String,
  notes:         String,
  contactName:   String,
  contactEmail:  String,
  interviewDate: Date,
}, { timestamps: true }));

const FollowUp = mongoose.model("FollowUp", new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", required: true },
  subject:       { type: String, required: true },
  body:          { type: String, required: true },
  sent:          { type: Boolean, default: false },
  draftedByAI:   { type: Boolean, default: false },
  scheduledDate: { type: Date, default: null },
  isReply:       { type: Boolean, default: false },
}, { timestamps: true }));

const ActivityLog = mongoose.model("ActivityLog", new mongoose.Schema({
  applicationId: mongoose.Schema.Types.ObjectId,
  event:         { type: String, enum: ["status-change", "email-received", "follow-up-sent", "ai-scan", "created"], required: true },
  description:   { type: String, required: true },
  timestamp:     { type: Date, default: Date.now },
}));

const GmailToken = mongoose.model("GmailToken", new mongoose.Schema({
  access_token:  { type: String, required: true },
  refresh_token: { type: String, required: true },
  expiry_date:   Number,
}));

// ─── GMAIL ────────────────────────────────────────────────────────────────────

function makeOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function getGmailClient() {
  const token = await GmailToken.findOne();
  if (!token) throw new Error("Gmail not connected");
  const auth = makeOAuthClient();
  auth.setCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expiry_date: token.expiry_date,
  });
  return google.gmail({ version: "v1", auth });
}

async function createCalendarEvent(auth, app) {
  const calendar = google.calendar({ version: "v3", auth });
  const start = new Date(app.interviewDate);
  const end   = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour
  await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary:     `Interview — ${app.company} (${app.position})`,
      description: `Job application interview\nCompany: ${app.company}\nRole: ${app.position}${app.jobUrl ? '\nJob URL: ' + app.jobUrl : ''}`,
      start: { dateTime: start.toISOString() },
      end:   { dateTime: end.toISOString() },
    },
  });
}

// ─── AI AGENT ────────────────────────────────────────────────────────────────
//
// Triggered by POST /scan-inbox. Runs 5 nodes in order:
//   scanEmails → classifyEmails → checkSilent → draftFollowUps → submitResults
//
// Two LLM tools define the structured output we expect from Ollama:

const classifyTool = {
  type: "function",
  function: {
    name: "classify_email",
    description: "Classify a job application email thread",
    parameters: {
      type: "object",
      properties: {
        classification: { type: "string", enum: ["interview_request", "rejection", "offer", "no_response"] },
        summary:        { type: "string", description: "One sentence summary of the email" },
      },
      required: ["classification", "summary"],
    },
  },
};

const draftTool = {
  type: "function",
  function: {
    name: "draft_follow_up",
    description: "Draft a follow-up email for a silent job application",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body:    { type: "string" },
      },
      required: ["subject", "body"],
    },
  },
};

// Graph state — what gets passed between nodes
const graphState = {
  applications:    { value: (_, y) => y,          default: () => [] },
  emailThreads:    { value: (_, y) => y,          default: () => [] },
  classifications: { value: (x, y) => x.concat(y), default: () => [] },
  silentApps:      { value: (_, y) => y,          default: () => [] },
  followUpDrafts:  { value: (x, y) => x.concat(y), default: () => [] },
};

// Node 1 — search Gmail for threads from tracked companies
async function scanEmailsNode(state) {
  let gmail;
  try { gmail = await getGmailClient(); }
  catch { console.log("Gmail not connected, skipping scan"); return { emailThreads: [] }; }

  const threads = [];
  for (const app of state.applications) {
    const res = await gmail.users.threads
      .list({ userId: "me", q: `"${app.company}" OR subject:"${app.position}"`, maxResults: 3 })
      .catch(() => ({ data: {} }));

    for (const t of res.data.threads || []) {
      const data = await gmail.users.threads.get({ userId: "me", id: t.id }).catch(() => null);
      if (!data) continue;
      const content = (data.data.messages || []).map((m) => {
        const subject = m.payload.headers?.find((h) => h.name === "Subject")?.value || "";
        const from    = m.payload.headers?.find((h) => h.name === "From")?.value || "";
        return `From: ${from}\nSubject: ${subject}\nSnippet: ${m.snippet}`;
      }).join("\n---\n");
      threads.push({ applicationId: app._id.toString(), company: app.company, position: app.position, content });
    }
  }
  console.log(`scanEmails: found ${threads.length} threads`);
  return { emailThreads: threads };
}

// Node 2 — ask the LLM to classify each thread
async function classifyEmailsNode(state) {
  const classifications = [];
  for (const thread of state.emailThreads) {
    const res = await ollama.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: "Classify this job application email thread by calling classify_email. You MUST use one of these exact classification values: interview_request, rejection, offer, no_response. Do not use any other values." },
        { role: "user",   content: `Company: ${thread.company}\nPosition: ${thread.position}\n\n${thread.content}` },
      ],
      tools: [classifyTool],
      stream: false,
    }).catch(() => null);

    const tc = res?.message.tool_calls?.[0];
    if (tc?.function.name === "classify_email") {
      classifications.push({ applicationId: thread.applicationId, company: thread.company, ...tc.function.arguments });
    }
  }
  console.log(`classifyEmails: classified ${classifications.length}`);
  console.log("classifications:", JSON.stringify(classifications, null, 2));
  return { classifications };
}

// Node 3 — find applications silent for 7+ days (no update)
async function checkSilentNode(state) {
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const silentApps = state.applications.filter(
    (app) => !["offer", "rejected", "ghosted"].includes(app.status) && new Date(app.updatedAt) < cutoff
  );
  console.log(`checkSilent: ${silentApps.length} silent apps`);
  return { silentApps };
}

// Node 4 — ask the LLM to draft a follow-up for each silent app
async function draftFollowUpsNode(state) {
  const followUpDrafts = [];
  for (const app of state.silentApps) {
    const days = Math.floor((Date.now() - new Date(app.updatedAt)) / 86400000);
    const res = await ollama.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: "Draft a professional follow-up email by calling draft_follow_up." },
        { role: "user",   content: `Company: ${app.company}\nPosition: ${app.position}\nApplied ${days} days ago\nContact: ${app.contactName || "Hiring Manager"}` },
      ],
      tools: [draftTool],
      stream: false,
    }).catch(() => null);

    const tc = res?.message.tool_calls?.[0];
    if (tc?.function.name === "draft_follow_up") {
      followUpDrafts.push({ applicationId: app._id.toString(), ...tc.function.arguments });
    }
  }
  console.log(`draftFollowUps: drafted ${followUpDrafts.length}`);
  return { followUpDrafts };
}

// Node 5 — save all results to MongoDB
async function submitResultsNode(state) {
  const statusMap = { interview_request: "interviewing", offer: "offer", rejection: "rejected" };

  for (const cls of state.classifications) {
    const newStatus = statusMap[cls.classification];
    if (newStatus) {
      const doc = await Application.findById(cls.applicationId);
      if (doc && doc.status !== newStatus) {
        await Application.findByIdAndUpdate(cls.applicationId, { status: newStatus });
        await ActivityLog.create({ applicationId: cls.applicationId, event: "status-change", description: `${cls.company}: ${cls.summary}` });
      }
    }
    await ActivityLog.create({ applicationId: cls.applicationId, event: "email-received", description: `Email from ${cls.company}: ${cls.summary}` });
  }

  for (const draft of state.followUpDrafts) {
    await FollowUp.create({ applicationId: draft.applicationId, subject: draft.subject, body: draft.body, draftedByAI: true });
  }

  await ActivityLog.create({
    event: "ai-scan",
    description: `Scan complete — ${state.emailThreads.length} threads found, ${state.classifications.length} classified, ${state.followUpDrafts.length} follow-ups drafted`,
  });
  return {};
}

// Wire the graph together
const workflow = new StateGraph({ channels: graphState });
workflow.addNode("scanEmails",     scanEmailsNode);
workflow.addNode("classifyEmails", classifyEmailsNode);
workflow.addNode("checkSilent",    checkSilentNode);
workflow.addNode("draftFollowUps", draftFollowUpsNode);
workflow.addNode("submitResults",  submitResultsNode);

workflow.addEdge(START, "scanEmails");
workflow.addEdge("scanEmails",     "classifyEmails");
workflow.addEdge("classifyEmails", "checkSilent");
workflow.addConditionalEdges("checkSilent",
  (state) => state.silentApps.length > 0 ? "draftFollowUps" : "submitResults",
  ["draftFollowUps", "submitResults"]
);
workflow.addEdge("draftFollowUps", "submitResults");
workflow.addEdge("submitResults",  END);

const graph = workflow.compile();

// ─── ROUTES: APPLICATIONS ─────────────────────────────────────────────────────

app.get("/applications", async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    res.json(await Application.find(filter).sort({ appliedDate: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/applications", async (req, res) => {
  try {
    const doc = await Application.create(req.body);
    await ActivityLog.create({ applicationId: doc._id, event: "created", description: `Applied to ${doc.position} at ${doc.company}` });
    if (doc.interviewDate) {
      try {
        const token = await GmailToken.findOne();
        if (token) {
          const auth = makeOAuthClient();
          auth.setCredentials({ access_token: token.access_token, refresh_token: token.refresh_token, expiry_date: token.expiry_date });
          await createCalendarEvent(auth, doc);
        }
      } catch (calErr) { console.error("Calendar event error:", calErr.message); }
    }
    res.status(201).json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put("/applications/:id", async (req, res) => {
  try {
    const prev = await Application.findById(req.params.id);
    if (!prev) return res.status(404).json({ error: "Not found" });
    const doc = await Application.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (prev.status !== doc.status) {
      await ActivityLog.create({ applicationId: doc._id, event: "status-change", description: `${doc.company}: ${prev.status} → ${doc.status}` });
    }
    if (req.body.interviewDate && String(prev.interviewDate) !== String(new Date(req.body.interviewDate))) {
      try {
        const token = await GmailToken.findOne();
        if (token) {
          const auth = makeOAuthClient();
          auth.setCredentials({ access_token: token.access_token, refresh_token: token.refresh_token, expiry_date: token.expiry_date });
          await createCalendarEvent(auth, doc);
        }
      } catch (calErr) { console.error("Calendar event error:", calErr.message); }
    }
    res.json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/applications/:id", async (req, res) => {
  try {
    const doc = await Application.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    await FollowUp.deleteMany({ applicationId: req.params.id });
    await ActivityLog.deleteMany({ applicationId: req.params.id });
    res.json({ message: "Deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTES: FOLLOW-UPS ───────────────────────────────────────────────────────

app.get("/follow-ups", async (_req, res) => {
  try {
    res.json(await FollowUp.find().populate("applicationId", "company position").sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/follow-ups/:id", async (req, res) => {
  try {
    const doc = await FollowUp.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (req.body.sent) {
      await ActivityLog.create({ applicationId: doc.applicationId, event: "follow-up-sent", description: `Follow-up sent: "${doc.subject}"` });
    }
    res.json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/follow-ups/:id", async (req, res) => {
  try {
    const doc = await FollowUp.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/follow-ups/:id/send", async (req, res) => {
  try {
    const fu = await FollowUp.findById(req.params.id).populate("applicationId", "company position contactEmail");
    if (!fu) return res.status(404).json({ error: "Not found" });

    const gmail = await getGmailClient();
    const to = fu.applicationId?.contactEmail || "";
    if (!to) return res.status(400).json({ error: "No contact email on this application" });

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${fu.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fu.body}`
    ).toString("base64url");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

    await FollowUp.findByIdAndUpdate(fu._id, { sent: true });
    await ActivityLog.create({ applicationId: fu.applicationId._id, event: "follow-up-sent", description: `Follow-up sent to ${to}: "${fu.subject}"` });

    res.json({ message: "Sent" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /applications/:id/draft-followup — AI drafts a proactive follow-up, optionally scheduled
app.post("/applications/:id/draft-followup", async (req, res) => {
  try {
    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({ error: "Not found" });

    const days = Math.floor((Date.now() - new Date(app.updatedAt)) / 86400000);
    const result = await ollama.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: "Draft a professional follow-up email by calling draft_follow_up." },
        { role: "user",   content: `Company: ${app.company}\nPosition: ${app.position}\nApplied ${days} days ago\nContact: ${app.contactName || "Hiring Manager"}` },
      ],
      tools: [draftTool],
      stream: false,
    }).catch(() => null);

    const tc = result?.message.tool_calls?.[0];
    if (!tc || tc.function.name !== "draft_follow_up") return res.status(500).json({ error: "AI failed to draft follow-up" });

    const fu = await FollowUp.create({
      applicationId: app._id,
      subject: tc.function.arguments.subject,
      body: tc.function.arguments.body,
      draftedByAI: true,
      scheduledDate: req.body.scheduledDate || null,
    });
    res.status(201).json(fu);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /applications/:id/draft-reply — finds latest Gmail thread and AI drafts a reply
app.post("/applications/:id/draft-reply", async (req, res) => {
  try {
    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({ error: "Not found" });

    const gmail = await getGmailClient();
    const search = await gmail.users.threads
      .list({ userId: "me", q: `"${app.company}" OR subject:"${app.position}"`, maxResults: 1 })
      .catch(() => ({ data: {} }));

    const threads = search.data.threads || [];
    if (!threads.length) return res.status(404).json({ error: `No emails found for ${app.company}` });

    const thread = await gmail.users.threads.get({ userId: "me", id: threads[0].id });
    const messages = thread.data.messages || [];
    const latest = messages[messages.length - 1];
    const subject = latest.payload.headers?.find((h) => h.name === "Subject")?.value || "";
    const from    = latest.payload.headers?.find((h) => h.name === "From")?.value || "";
    const content = `From: ${from}\nSubject: ${subject}\nMessage: ${latest.snippet}`;

    const result = await ollama.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: "Draft a professional reply to this job application email by calling draft_follow_up." },
        { role: "user",   content: `Company: ${app.company}\nPosition: ${app.position}\n\nEmail to reply to:\n${content}` },
      ],
      tools: [draftTool],
      stream: false,
    }).catch(() => null);

    const tc = result?.message.tool_calls?.[0];
    if (!tc || tc.function.name !== "draft_follow_up") return res.status(500).json({ error: "AI failed to draft reply" });

    const fu = await FollowUp.create({
      applicationId: app._id,
      subject: tc.function.arguments.subject,
      body: tc.function.arguments.body,
      draftedByAI: true,
      isReply: true,
    });
    res.status(201).json(fu);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTES: ACTIVITY LOG ─────────────────────────────────────────────────────

app.get("/activity-logs", async (_req, res) => {
  try {
    res.json(await ActivityLog.find().sort({ timestamp: -1 }).limit(50));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ROUTES: GMAIL AUTH ───────────────────────────────────────────────────────

app.get("/auth/gmail", (_req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "Google credentials not set in .env" });
  const url = makeOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });
  res.redirect(url);
});

app.get("/auth/gmail/callback", async (req, res) => {
  try {
    const { tokens } = await makeOAuthClient().getToken(req.query.code);
    await GmailToken.deleteMany({});
    await GmailToken.create({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry_date: tokens.expiry_date });
    res.send("<p>Gmail connected! You can close this tab.</p>");
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/auth/gmail/status", async (_req, res) => {
  const token = await GmailToken.findOne();
  res.json({ connected: !!token });
});

// ─── ROUTE: SCAN INBOX (runs the AI agent) ────────────────────────────────────

app.post("/scan-inbox", async (_req, res) => {
  try {
    const applications = await Application.find({ status: { $in: ["applied", "interviewing"] } });
    if (!applications.length) return res.json({ message: "No active applications to scan" });

    const state = await graph.invoke({ applications });
    res.json({
      message: "Scan complete",
      threadsFound:     state.emailThreads.length,
      classified:       state.classifications.length,
      followUpsDrafted: state.followUpDrafts.length,
    });
  } catch (err) {
    console.error("scan-inbox error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SCHEDULED SEND JOB ──────────────────────────────────────────────────────

setInterval(async () => {
  const due = await FollowUp.find({ sent: false, scheduledDate: { $lte: new Date() } }).populate("applicationId", "company position contactEmail");
  for (const fu of due) {
    try {
      const app = fu.applicationId;
      const to = app?.contactEmail || "";
      if (!to) continue;

      // Check for recent Gmail activity — skip send if email received in last 7 days
      let hasRecentActivity = false;
      try {
        const gmail = await getGmailClient();
        const check = await gmail.users.threads.list({
          userId: "me",
          q: `"${app.company}" newer_than:7d`,
          maxResults: 1,
        });
        hasRecentActivity = (check.data.threads || []).length > 0;
      } catch { /* gmail unavailable, proceed with send */ }

      if (hasRecentActivity) {
        await FollowUp.findByIdAndUpdate(fu._id, { scheduledDate: null });
        await ActivityLog.create({ applicationId: app._id, event: "follow-up-sent", description: `Skipped scheduled follow-up for ${app.company} — recent email activity detected` });
        console.log(`Skipped scheduled follow-up for ${app.company}: recent activity`);
        continue;
      }

      const gmail = await getGmailClient();
      const raw = Buffer.from(
        `To: ${to}\r\nSubject: ${fu.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fu.body}`
      ).toString("base64url");
      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      await FollowUp.findByIdAndUpdate(fu._id, { sent: true, scheduledDate: null });
      await ActivityLog.create({ applicationId: app._id, event: "follow-up-sent", description: `Scheduled follow-up sent to ${to}: "${fu.subject}"` });
      console.log(`Scheduled follow-up sent: ${fu.subject}`);
    } catch (err) {
      console.error(`Failed to send scheduled follow-up ${fu._id}:`, err.message);
    }
  }
}, 60 * 1000); // check every minute

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Pipeline running on http://localhost:${PORT}`));
