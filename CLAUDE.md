# NourishWeek — Meal Planner App

Full-stack app: Express + MongoDB/Mongoose + LangGraph + Spoonacular API + Vue.js (CDN, no build step).
Structure: `server/server.js`, `client/index.html`, `client/app.js`, `client/styles.css`.
CommonJS (`require`), dark theme (#0d1117 bg, accent #2f81f7 blue), Material Symbols icons.
Spoonacular API key stored in `.env` as `SPOONACULAR_API_KEY`.

---

## Resources (MongoDB Models)

**User** - height (cm), weight (kg), age, sex (male/female), calorieTarget (auto-calculated via Mifflin-St Jeor)
**MealPlan** - userId (ref User), days (array of 7 objects: { day (Mon–Sun), recipeId, name, imageUrl, calories, macros: { protein, carbs, fat }, workoutTag (string, e.g. "+carbs") })

### Mifflin-St Jeor Equation
- Male: `(10 × weight) + (6.25 × height) − (5 × age) + 5`
- Female: `(10 × weight) + (6.25 × height) − (5 × age) − 161`

---

## REST API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | /users | Create user profile |
| GET | /users/:id | Fetch user profile |
| POST | /meal-plans | Trigger agent to generate a plan (streams SSE progress) |
| GET | /meal-plans/:id | Fetch saved plan |
| PUT | /meal-plans/:id/meals/:day | Swap a single day's meal |
| DELETE | /meal-plans/:id | Delete a plan |

---

## AI Agent (LangGraph)

**Trigger:** POST /meal-plans

**Graph Nodes (in order):**
1. `analyze_workouts` — parse workout entries per day, tag high-load days (e.g. leg day → "+carbs")
2. `set_calorie_targets` — compute per-day calorie/macro targets from user's TDEE + workout tags
3. `search_recipes` — tool call: Spoonacular `/recipes/complexSearch` with calorie range per day
4. `get_recipe_details` — tool call: Spoonacular `/recipes/{id}/information` for ingredients, nutrition, image
5. `check_nutrition` — tool call: aggregate macros across the day against TDEE target; pass/fail
6. `save_plan` — tool call: write finalized MealPlan to MongoDB

**Tools (4 required):**
- `search_recipes` — schema: { query (string), minCalories (number), maxCalories (number), number (int) }
- `get_recipe_details` — schema: { recipeId (number) }
- `find_substitutions` — schema: { ingredientId (number) } — called conditionally on ingredient gap
- `calculate_nutrition` — schema: { meals (array), tdee (number) } → returns { pass (bool), gap (object|null) }
- `save_meal_plan` — schema: { userId (string), days (array) }

**Edges:**
- START → analyze_workouts (static)
- analyze_workouts → set_calorie_targets (static)
- set_calorie_targets → search_recipes (static)
- search_recipes → get_recipe_details (static)
- get_recipe_details → check_nutrition (static)
- check_nutrition → search_recipes | save_plan (conditional via routingFunction)
- save_plan → END

**Routing function (`routingFunction`):**
If `check_nutrition` fails targets → loop back to `search_recipes` to swap the offending meal.
If ingredient gap detected → call `find_substitutions` tool before retrying.
Otherwise → `save_plan`.

---

## Server-Sent Events (SSE)

POST /meal-plans keeps the response open and streams agent progress:
- `data: { status: "Analyzing your workouts…" }`
- `data: { status: "Setting calorie targets…" }`
- `data: { status: "Finding recipes that fit your targets…" }`
- `data: { status: "Getting recipe details…" }`
- `data: { status: "Checking nutrition…" }`
- `data: { status: "Finalizing your plan…" }`
- `data: { done: true, planId: "<id>" }` — signals completion

Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

---

## Server-Side Validation

Every Mongoose model uses `required`, `enum`, `min`/`max` validators.
Every POST/PUT route wraps save/create in try/catch and returns `res.status(400).json({ error: err.message })` on failure.

---

## Client (Vue.js CDN)

**Screens (3):**

### 1. Input Screen
Two-column layout:
- Left: Mon–Sun workout entry fields (one text input per day)
- Right: Profile fields (height, weight, age, sex radio)
- Single "Generate my week" button at bottom

### 2. Loading Screen
Full-screen polished loading experience shown while agent runs:
- Animated visual: subtle pulsing or morphing shapes (CSS only, no heavy libs)
- Status messages driven by SSE stream — cycle through actual agent progress messages
- Messages update in real time as each SSE event arrives

### 3. Week Board Screen
7-day grid, one column per day:
- Each day card: Spoonacular recipe image (background or top), meal name, calorie count, workout tag on high-load days
- Clicking a card opens a modal/panel with: full recipe instructions, ingredient list with quantities, macro breakdown (protein/carbs/fat/calories) as visual stat bars, Spoonacular image at top
- Summary bar at top: total meals planned, average daily calories
- "Regenerate" button triggers agent again

**Client-Side Validation:**
- At least one workout field must be filled
- Height, weight, age must be positive numbers
- Sex must be selected
- Inline `v-if` error messages per field, disable submit while loading/invalid

**Style:** Dark theme (#0d1117 bg, accent #2f81f7 blue)

---

## Git Workflow

Commit and push after every logical unit of work. Short imperative messages.
Never commit: `.env`, `node_modules/`, uploads, tokens.

---

## Build Order

1. server: models (User, MealPlan)
2. server: REST routes (/users, /meal-plans CRUD)
3. server: LangGraph agent with SSE streaming on POST /meal-plans
4. client: index.html skeleton + screen routing
5. client: Input screen
6. client: Loading screen (SSE-driven status messages + animation)
7. client: Week Board screen (grid + day card modal)
8. client: styles.css
9. README.md
