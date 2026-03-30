require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const { Ollama } = require("ollama");
const { StateGraph, START, END } = require("@langchain/langgraph");

const Application = require("./models/Application");
const Contact = require("./models/Contact");
const FollowUp = require("./models/FollowUp");
const ActivityLog = require("./models/ActivityLog");
const GmailToken = require("./models/GmailToken");
const { seedApplications } = require("./seed");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "pipeline";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://golem:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";
const PORT = process.env.PORT || 8080;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/gmail/callback`;

// ─── EXPRESS ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── MONGODB ──────────────────────────────────────────────────────────────────

mongoose
  .connect(`${MONGODB_URI}/${DB_NAME}`)
  .then(async () => {
    console.log("Connected to MongoDB");
    await seedApplications(Application);
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// ─── OLLAMA ───────────────────────────────────────────────────────────────────

const ollama = new Ollama({ host: OLLAMA_HOST });

// ─── GMAIL OAUTH ──────────────────────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function getGmailClient() {
  const tokenDoc = await GmailToken.findOne().sort({ createdAt: -1 });
  if (!tokenDoc) throw new Error("Gmail not connected");
  const auth = getOAuth2Client();
  auth.setCredentials({
    access_token: tokenDoc.access_token,
    refresh_token: tokenDoc.refresh_token,
    expiry_date: tokenDoc.expiry_date,
  });
  return google.gmail({ version: "v1", auth });
}

// ─── LANGGRAPH TOOLS ──────────────────────────────────────────────────────────

const classifyEmailToolDef = {
  type: "function",
  function: {
    name: "classify_email_thread",
    description:
      "Classify a job application email thread as interview_request, rejection, offer, or no_response.",
    parameters: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["interview_request", "rejection", "offer", "no_response"],
          description: "The classification of the email thread",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
        summary: {
          type: "string",
          description: "One-sentence summary of what the email says",
        },
      },
      required: ["classification", "confidence", "summary"],
    },
  },
};

const draftFollowUpToolDef = {
  type: "function",
  function: {
    name: "draft_follow_up_email",
    description: "Draft a professional follow-up email for a silent job application.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Full email body" },
      },
      required: ["subject", "body"],
    },
  },
};

// ─── GRAPH STATE ──────────────────────────────────────────────────────────────

const graphStateData = {
  applications: { value: (_x, y) => y, default: () => [] },
  emailThreads: { value: (_x, y) => y, default: () => [] },
  classifications: { value: (_x, y) => _x.concat(y), default: () => [] },
  silentApps: { value: (_x, y) => y, default: () => [] },
  followUpDrafts: { value: (_x, y) => _x.concat(y), default: () => [] },
};

// ─── GRAPH NODES ──────────────────────────────────────────────────────────────

async function scanEmailsNode(state) {
  console.log("scanEmailsNode: scanning Gmail...");
  const threads = [];

  let gmail;
  try {
    gmail = await getGmailClient();
  } catch {
    console.log("Gmail not connected — skipping email scan");
    return { emailThreads: [] };
  }

  for (const app of state.applications) {
    try {
      const q = `"${app.company}" OR subject:"${app.position}"`;
      const res = await gmail.users.threads.list({ userId: "me", q, maxResults: 3 });
      if (!res.data.threads) continue;

      for (const t of res.data.threads) {
        const data = await gmail.users.threads.get({ userId: "me", id: t.id });
        const content = (data.data.messages || [])
          .map((m) => {
            const subject = m.payload.headers?.find((h) => h.name === "Subject")?.value || "";
            const from = m.payload.headers?.find((h) => h.name === "From")?.value || "";
            return `From: ${from}\nSubject: ${subject}\nSnippet: ${m.snippet}`;
          })
          .join("\n---\n");

        threads.push({
          applicationId: app._id.toString(),
          company: app.company,
          position: app.position,
          threadId: t.id,
          content,
        });
      }
    } catch (err) {
      console.error(`Gmail scan error for ${app.company}:`, err.message);
    }
  }

  console.log(`scanEmailsNode: found ${threads.length} threads`);
  return { emailThreads: threads };
}

async function classifyEmailsNode(state) {
  console.log("classifyEmailsNode: classifying...");
  const classifications = [];

  for (const thread of state.emailThreads) {
    try {
      const response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a job search assistant. Classify the email thread for the given job application by calling classify_email_thread.",
          },
          {
            role: "user",
            content: `Company: ${thread.company}\nPosition: ${thread.position}\n\nThread:\n${thread.content}`,
          },
        ],
        tools: [classifyEmailToolDef],
        stream: false,
      });

      const tc = response.message.tool_calls?.[0];
      if (tc?.function.name === "classify_email_thread") {
        classifications.push({
          applicationId: thread.applicationId,
          company: thread.company,
          ...tc.function.arguments,
        });
      }
    } catch (err) {
      console.error(`Classify error for ${thread.company}:`, err.message);
    }
  }

  console.log(`classifyEmailsNode: classified ${classifications.length}`);
  return { classifications };
}

async function checkSilentNode(state) {
  console.log("checkSilentNode: finding silent apps...");
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const silent = state.applications.filter((app) => {
    if (["offer", "rejected", "ghosted"].includes(app.status)) return false;
    return new Date(app.updatedAt) < cutoff;
  });

  console.log(`checkSilentNode: ${silent.length} silent apps`);
  return { silentApps: silent };
}

async function draftFollowUpsNode(state) {
  console.log("draftFollowUpsNode: drafting follow-ups...");
  const drafts = [];

  for (const app of state.silentApps) {
    try {
      const daysSilent = Math.floor(
        (Date.now() - new Date(app.updatedAt)) / (1000 * 60 * 60 * 24)
      );

      const response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a career coach. Draft a concise, professional follow-up email by calling draft_follow_up_email.",
          },
          {
            role: "user",
            content: `Company: ${app.company}\nPosition: ${app.position}\nApplied: ${daysSilent} days ago\nContact: ${app.contactName || "Hiring Manager"}\nStatus: ${app.status}`,
          },
        ],
        tools: [draftFollowUpToolDef],
        stream: false,
      });

      const tc = response.message.tool_calls?.[0];
      if (tc?.function.name === "draft_follow_up_email") {
        drafts.push({
          applicationId: app._id.toString(),
          ...tc.function.arguments,
        });
      }
    } catch (err) {
      console.error(`Draft error for ${app.company}:`, err.message);
    }
  }

  console.log(`draftFollowUpsNode: created ${drafts.length} drafts`);
  return { followUpDrafts: drafts };
}

async function submitResultsNode(state) {
  console.log("submitResultsNode: persisting...");

  const statusMap = {
    interview_request: "interviewing",
    offer: "offer",
    rejection: "rejected",
    no_response: null,
  };

  // Apply classifications → update statuses + log
  for (const cls of state.classifications) {
    const newStatus = statusMap[cls.classification];
    if (newStatus) {
      const app = await Application.findById(cls.applicationId);
      if (app && app.status !== newStatus) {
        const oldStatus = app.status;
        app.status = newStatus;
        await app.save();
        await ActivityLog.create({
          applicationId: app._id,
          event: "status-change",
          description: `Status changed from ${oldStatus} → ${newStatus} (AI: ${cls.summary})`,
        });
      }
    }
    await ActivityLog.create({
      applicationId: cls.applicationId,
      event: "email-received",
      description: `Email from ${cls.company}: ${cls.summary}`,
    });
  }

  // Save AI follow-up drafts
  for (const draft of state.followUpDrafts) {
    await FollowUp.create({
      applicationId: draft.applicationId,
      subject: draft.subject,
      body: draft.body,
      draftedByAI: true,
    });
  }

  // Log the scan itself
  await ActivityLog.create({
    event: "ai-scan",
    description: `Inbox scan complete — ${state.emailThreads.length} threads, ${state.classifications.length} classified, ${state.followUpDrafts.length} follow-ups drafted`,
  });

  return {};
}

// ─── ROUTING ─────────────────────────────────────────────────────────────────

function routingFunction(state) {
  if (state.silentApps.length > 0) {
    console.log("Routing -> draftFollowUps");
    return "draftFollowUps";
  }
  console.log("Routing -> submitResults");
  return "submitResults";
}

// ─── BUILD GRAPH ──────────────────────────────────────────────────────────────

const workflow = new StateGraph({ channels: graphStateData });
workflow.addNode("scanEmails", scanEmailsNode);
workflow.addNode("classifyEmails", classifyEmailsNode);
workflow.addNode("checkSilent", checkSilentNode);
workflow.addNode("draftFollowUps", draftFollowUpsNode);
workflow.addNode("submitResults", submitResultsNode);

workflow.addEdge(START, "scanEmails");
workflow.addEdge("scanEmails", "classifyEmails");
workflow.addEdge("classifyEmails", "checkSilent");
workflow.addConditionalEdges("checkSilent", routingFunction, ["draftFollowUps", "submitResults"]);
workflow.addEdge("draftFollowUps", "submitResults");
workflow.addEdge("submitResults", END);

const graph = workflow.compile();

// ─── REST ROUTES: APPLICATIONS ────────────────────────────────────────────────

app.get("/applications", async (req, res) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const applications = await Application.find(filter).sort({ appliedDate: -1 });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/applications", async (req, res) => {
  try {
    const application = await Application.create(req.body);
    await ActivityLog.create({
      applicationId: application._id,
      event: "created",
      description: `Applied to ${application.position} at ${application.company}`,
    });
    res.status(201).json(application);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/applications/:id", async (req, res) => {
  try {
    const prev = await Application.findById(req.params.id);
    if (!prev) return res.status(404).json({ error: "Application not found" });

    const updated = await Application.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (prev.status !== updated.status) {
      await ActivityLog.create({
        applicationId: updated._id,
        event: "status-change",
        description: `Status changed from ${prev.status} → ${updated.status}`,
      });
    } else {
      await ActivityLog.create({
        applicationId: updated._id,
        event: "updated",
        description: `Updated ${updated.company} — ${updated.position}`,
      });
    }

    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/applications/:id", async (req, res) => {
  try {
    const app_ = await Application.findByIdAndDelete(req.params.id);
    if (!app_) return res.status(404).json({ error: "Application not found" });
    await FollowUp.deleteMany({ applicationId: req.params.id });
    await ActivityLog.deleteMany({ applicationId: req.params.id });
    res.json({ message: "Application deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST ROUTES: CONTACTS ────────────────────────────────────────────────────

app.get("/contacts", async (_req, res) => {
  try {
    const contacts = await Contact.find().sort({ company: 1, name: 1 });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/contacts", async (req, res) => {
  try {
    const contact = await Contact.create(req.body);
    res.status(201).json(contact);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/contacts/:id", async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json(contact);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/contacts/:id", async (req, res) => {
  try {
    const contact = await Contact.findByIdAndDelete(req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    res.json({ message: "Contact deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST ROUTES: FOLLOW-UPS ──────────────────────────────────────────────────

app.get("/follow-ups", async (_req, res) => {
  try {
    const followUps = await FollowUp.find()
      .populate("applicationId", "company position status")
      .sort({ createdAt: -1 });
    res.json(followUps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/follow-ups", async (req, res) => {
  try {
    const followUp = await FollowUp.create(req.body);
    res.status(201).json(followUp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/follow-ups/:id", async (req, res) => {
  try {
    const followUp = await FollowUp.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!followUp) return res.status(404).json({ error: "Follow-up not found" });

    if (req.body.sent === true) {
      await ActivityLog.create({
        applicationId: followUp.applicationId,
        event: "follow-up-sent",
        description: `Follow-up sent: "${followUp.subject}"`,
      });
    }

    res.json(followUp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/follow-ups/:id", async (req, res) => {
  try {
    const followUp = await FollowUp.findByIdAndDelete(req.params.id);
    if (!followUp) return res.status(404).json({ error: "Follow-up not found" });
    res.json({ message: "Follow-up deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST ROUTES: ACTIVITY LOGS ───────────────────────────────────────────────

app.get("/activity-logs", async (req, res) => {
  try {
    const filter = req.query.applicationId ? { applicationId: req.query.applicationId } : {};
    const logs = await ActivityLog.find(filter)
      .sort({ timestamp: -1 })
      .limit(50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/activity-logs/:id", async (req, res) => {
  try {
    const log = await ActivityLog.findByIdAndDelete(req.params.id);
    if (!log) return res.status(404).json({ error: "Log not found" });
    res.json({ message: "Log deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GMAIL AUTH ROUTES ────────────────────────────────────────────────────────

app.get("/auth/gmail", (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: "Google OAuth credentials not configured" });
  }
  const auth = getOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  });
  res.redirect(url);
});

app.get("/auth/gmail/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const auth = getOAuth2Client();
    const { tokens } = await auth.getToken(code);

    await GmailToken.deleteMany({});
    await GmailToken.create({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });

    res.send(`<script>window.close();</script><p>Gmail connected! You can close this window.</p>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/gmail/status", async (_req, res) => {
  try {
    const token = await GmailToken.findOne();
    res.json({ connected: !!token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCAN INBOX ───────────────────────────────────────────────────────────────

app.post("/scan-inbox", async (_req, res) => {
  try {
    const applications = await Application.find({
      status: { $in: ["applied", "interviewing"] },
    });

    if (applications.length === 0) {
      return res.json({ message: "No active applications to scan", results: {} });
    }

    const finalState = await graph.invoke({ applications });

    res.json({
      message: "Inbox scan complete",
      threadsFound: finalState.emailThreads.length,
      classified: finalState.classifications.length,
      followUpsDrafted: finalState.followUpDrafts.length,
    });
  } catch (err) {
    console.error("scan-inbox error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Pipeline server running on http://localhost:${PORT}`);
});
