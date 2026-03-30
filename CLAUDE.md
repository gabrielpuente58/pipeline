# Pipeline — Job Application Tracker

Full-stack app: Express + MongoDB/Mongoose + LangGraph + Ollama (golem) + Vue.js (CDN, no build step).
Structure: `server/server.js`, `client/index.html`, `client/app.js`, `client/styles.css`.
CommonJS (`require`), dark theme (#0d1117 bg, accent #2f81f7 blue), Material Symbols icons.

---

## Resources (MongoDB Models)

**Application** - company, position, status (applied/interviewing/offer/rejected/ghosted), appliedDate, jobUrl, notes, contactName, contactEmail
**Contact** - name, email, company, role, linkedinUrl, notes
**FollowUp** - applicationId (ref Application), subject, body, scheduledDate, sent (bool), draftedByAI (bool)
**ActivityLog** - applicationId (ref Application, optional), event (status-change/email-received/follow-up-sent/ai-scan/created/updated), description, timestamp
**GmailToken** - access_token, refresh_token, expiry_date

---

## REST API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | /applications | List all applications, optional ?status= filter |
| POST | /applications | Create application |
| PUT | /applications/:id | Update application |
| DELETE | /applications/:id | Delete application |
| GET | /contacts | List all contacts |
| POST | /contacts | Create contact |
| PUT | /contacts/:id | Update contact |
| DELETE | /contacts/:id | Delete contact |
| GET | /follow-ups | List all follow-ups (populated with application) |
| POST | /follow-ups | Create follow-up |
| PUT | /follow-ups/:id | Update follow-up |
| DELETE | /follow-ups/:id | Delete follow-up |
| GET | /activity-logs | List recent activity, optional ?applicationId= |
| DELETE | /activity-logs/:id | Delete log entry |
| GET | /auth/gmail | Initiate Gmail OAuth flow |
| GET | /auth/gmail/callback | Handle OAuth callback, save tokens |
| GET | /auth/gmail/status | Check Gmail connection status |
| POST | /scan-inbox | Trigger AI inbox scan agent |

---

## AI Agent (LangGraph)

**Trigger:** POST /scan-inbox

**Graph Nodes:**
1. `scanEmailsNode` - search Gmail for threads matching each tracked company/position
2. `classifyEmailsNode` - tool call: classify each thread as interview_request/rejection/offer/no_response
3. `checkSilentNode` - pure logic: find applications with no update for 7+ days
4. `draftFollowUpsNode` - tool call: draft a follow-up email for each silent application
5. `submitResultsNode` - persist status updates, save FollowUp drafts, write ActivityLog entries

**Tools (2 required):**
- `ClassifyEmailTool` - schema: { classification (enum), confidence (enum), summary (string) }
- `DraftFollowUpEmailTool` - schema: { subject (string), body (string) }

**Edges:**
- START -> scanEmails (static)
- scanEmails -> classifyEmails (static)
- classifyEmails -> checkSilent (static)
- checkSilent -> draftFollowUps | submitResults (conditional via routingFunction)
- draftFollowUps -> submitResults (static)
- submitResults -> END

**Routing function (`routingFunction`):**
If silentApps.length > 0 -> draftFollowUps. Otherwise -> submitResults.

---

## Gmail Integration

Uses `googleapis` npm package with OAuth2.
Credentials in `.env`: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
Tokens stored in MongoDB via GmailToken model (one doc, replaced on reconnect).

---

## Server-Side Validation

Every Mongoose model uses `required`, `enum`, `min`/`max` validators.
Every POST/PUT route wraps save/create in try/catch and returns `res.status(400).json({ error: err.message })` on failure.

---

## Client (Vue.js CDN)

**Tabs:**
1. Dashboard - stat cards (total/by-status), recent activity feed
2. Applications - list with status filter, add/edit/delete modal, "Scan Inbox" AI button
3. Contacts - list with add/edit/delete modal
4. Follow-ups - AI-drafted emails, mark sent, edit body, delete

**Client-Side Validation:**
- Validate before every POST/PUT: required fields non-empty, dates valid
- Inline `v-if` error messages per field, disable submit while loading/invalid
- Top-level globalMessage / globalMessageType pattern for API feedback

**Style:** Dark theme (#0d1117 bg, accent #2f81f7 blue)

---

## Git Workflow

Commit and push after every logical unit of work. Short imperative messages.
Never commit: `.env`, `node_modules/`, uploads, tokens.

---

## Build Order

1. server: models (Application, Contact, FollowUp, ActivityLog, GmailToken)
2. server: seed.js with sample applications
3. server: REST routes (all 4 resources)
4. server: Gmail OAuth routes
5. server: LangGraph scan-inbox agent
6. client: index.html skeleton + tabs
7. client: Dashboard tab
8. client: Applications tab (CRUD + scan button)
9. client: Contacts tab
10. client: Follow-ups tab
11. client: styles.css
12. README.md
