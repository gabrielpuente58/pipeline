# Race Day Planner — Ironman 70.3

A full-stack web application for planning and preparing for an Ironman 70.3 triathlon. Athletes can manage their profile, track gear across all race segments, generate an AI-powered carb-loading meal plan, and follow a personalized race preparation timeline.

**Stack:** Node.js / Express · MongoDB / Mongoose · LangGraph · Ollama · Vue.js (CDN)

---

## Resources

### Athlete
The single athlete profile for the application. Stores personal details and race information.

| Attribute | Type | Description |
|---|---|---|
| name | String | Full name of the athlete |
| gender | String | `male`, `female`, or `prefer-not-to-say` |
| height | Number | Height in inches (36–108) |
| weight | Number | Weight in pounds (50–500) |
| profilePicture | String | URL to profile image |
| raceDate | Date | Date of the race |
| raceLocation | String | City/venue of the race |

### ChecklistItem
Individual gear or task items organized by race segment.

| Attribute | Type | Description |
|---|---|---|
| category | String | `swim`, `bike`, `run`, `t1`, `t2`, or `nutrition` |
| name | String | Name of the item or task |
| checked | Boolean | Whether the item is packed/complete |
| purchased | Boolean | Whether the item has been purchased |
| weeksBeforeNeeded | Number | How many weeks before race day this is needed |
| isDefault | Boolean | Whether this was seeded as a default item |

### MealPlan
AI-generated 3-day carb-loading meal plan linked to an athlete.

| Attribute | Type | Description |
|---|---|---|
| athleteId | ObjectId | Reference to the Athlete |
| days | Array | Array of day objects, each with a label and meals array |
| days[].label | String | e.g. "3 Days Before Race" |
| days[].meals | Array | Meals with time, name, description, carbs, calories |
| days[].totalCarbs | Number | Total carbohydrates for the day (grams) |
| days[].totalCalories | Number | Total calories for the day |
| notes | String | General nutrition notes from the AI |

### Reminder
AI-generated race preparation reminders with timing and priority.

| Attribute | Type | Description |
|---|---|---|
| athleteId | ObjectId | Reference to the Athlete |
| title | String | Short reminder title |
| message | String | Detailed reminder message |
| category | String | `purchase`, `maintenance`, `training`, `nutrition`, or `logistics` |
| daysBeforeRace | Number | How many days before race day this applies |
| priority | String | `high`, `medium`, or `low` |

---

## REST API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/athlete` | Create a new athlete profile |
| GET | `/athlete` | Retrieve the athlete profile |
| PUT | `/athlete/:id` | Update the athlete profile |
| GET | `/checklist` | Get all checklist items sorted by category |
| PUT | `/checklist/:id` | Update a checklist item (toggle checked/purchased) |
| DELETE | `/checklist/:id` | Delete a checklist item |
| POST | `/generate-plan` | Trigger the AI agent to generate a meal plan and reminders |
| GET | `/meal-plan` | Retrieve the most recently generated meal plan |
| GET | `/reminders` | Retrieve all reminders sorted by days before race |

---

## Data Models (Mongoose Schemas)

### Athlete Schema
```js
{
  name:           { type: String, required: true, trim: true },
  gender:         { type: String, required: true, enum: ['male','female','prefer-not-to-say'] },
  height:         { type: Number, required: true, min: 36, max: 108 },
  weight:         { type: Number, required: true, min: 50, max: 500 },
  profilePicture: { type: String, default: '' },
  raceDate:       { type: Date, required: true },
  raceLocation:   { type: String, required: true, trim: true }
}
```

### ChecklistItem Schema
```js
{
  category:          { type: String, required: true, enum: ['swim','bike','run','t1','t2','nutrition'] },
  name:              { type: String, required: true, trim: true },
  checked:           { type: Boolean, default: false },
  purchased:         { type: Boolean, default: false },
  weeksBeforeNeeded: { type: Number, default: 1, min: 0, max: 52 },
  isDefault:         { type: Boolean, default: false }
}
```

### MealPlan Schema
```js
{
  athleteId: { type: ObjectId, ref: 'Athlete', required: true },
  days: [{
    label:          String,
    meals: [{ time, name, description, carbs, calories }],
    totalCarbs:     Number,
    totalCalories:  Number
  }],
  notes: { type: String, default: '' }
}
```

### Reminder Schema
```js
{
  athleteId:      { type: ObjectId, ref: 'Athlete', required: true },
  title:          { type: String, required: true },
  message:        { type: String, required: true },
  category:       { type: String, required: true, enum: ['purchase','maintenance','training','nutrition','logistics'] },
  daysBeforeRace: { type: Number, required: true, min: 0 },
  priority:       { type: String, required: true, enum: ['high','medium','low'] }
}
```

---

## Agentic Workflow

The AI agent is triggered via `POST /generate-plan`. It uses **LangGraph** with **ChatOllama** (llama3.1 on golem) to produce a personalized meal plan and race preparation reminders for the athlete.

### Tools

**`GenerateMealPlanTool`**
- Schema: `{ weight: number, gender: enum, raceLocation: string }`
- Purpose: Provides structured context to the LLM to generate a 3-day carb-loading meal plan

**`GenerateRemindersTool`**
- Schema: `{ daysUntilRace: number, raceLocation: string, athleteName: string }`
- Purpose: Provides structured context to the LLM to generate a timeline of race preparation reminders

### Graph Nodes

| Node | Description |
|---|---|
| `analyzeAthleteNode` | Reads athlete state, determines what is missing, binds the appropriate tools, and calls the LLM |
| `generateMealPlanNode` | Executes `GenerateMealPlanTool`, sends result to LLM, parses and stores the meal plan in state |
| `generateRemindersNode` | Executes `GenerateRemindersTool`, sends result to LLM, parses and stores reminders in state |
| `submitResultsNode` | Terminal node — persists final meal plan and reminders to MongoDB |

### Agent Graph

```
         START
           │
           ▼ (static)
    ┌─────────────────┐
    │  analyzeAthlete  │◄──────────────────────┐
    └─────────────────┘                         │
           │                                    │
    routingFunction (conditional)               │
           │                                    │
     ┌─────┴──────┐                             │
     ▼            ▼                             │
generateMealPlan  generateReminders             │
     │            │                             │
     └─────┬──────┘                             │
           │ (static, loop back) ───────────────┘
           │
    (when both done)
           ▼ (conditional)
    ┌─────────────────┐
    │  submitResults   │
    └─────────────────┘
           │ (static)
           ▼
          END
```

### Routing Function (`routingFunction`)

Inspects graph state after `analyzeAthleteNode`:
- If both `mealPlan` and `reminders` are populated → route to `submitResults`
- If a `generate_meal_plan` tool call is pending → route to `generateMealPlanNode`
- If a `generate_reminders` tool call is pending → route to `generateRemindersNode`
- Otherwise → loop back to `analyzeAthlete` to retry

---

## Running Locally

```bash
# Install server dependencies
cd server
npm install

# Set up environment
cp .env .env.local   # edit as needed
# Requires: MongoDB running locally, Ollama on golem

# Start the server
node server.js

# Open the client
open client/index.html
# or serve it with: npx serve client
```
