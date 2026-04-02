require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { ChatOllama } = require("@langchain/ollama");
const { HumanMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI    = process.env.MONGODB_URI       || "mongodb://localhost:27017";
const DB_NAME        = process.env.DB_NAME           || "nourishweek";
const PORT           = process.env.PORT              || 8080;
const SPOONACULAR_KEY = process.env.SPOONACULAR_API_KEY;
const OLLAMA_HOST    = process.env.OLLAMA_HOST       || "http://golem:11434";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL      || "gpt-oss:20b";

const llm = new ChatOllama({
  baseUrl: OLLAMA_HOST,
  model:   OLLAMA_MODEL,
  numCtx:  131072,
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────

mongoose
  .connect(`${MONGODB_URI}/${DB_NAME}`)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB error:", err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────

// User — stores biometric profile; calorieTarget is computed server-side
const userSchema = new mongoose.Schema({
  height: { type: Number, required: true, min: 1 }, // cm
  weight: { type: Number, required: true, min: 1 }, // kg
  age:    { type: Number, required: true, min: 1 },
  sex:    { type: String, enum: ["male", "female"], required: true },
  calorieTarget: { type: Number },
});

// Mifflin-St Jeor BMR (sedentary TDEE approximation) — computed before every save
userSchema.pre("save", async function () {
  const base = 10 * this.weight + 6.25 * this.height - 5 * this.age;
  this.calorieTarget = this.sex === "male" ? base + 5 : base - 161;
});

const User = mongoose.model("User", userSchema);

// MealPlan — one document per generated week plan, linked to a User
const mealPlanSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    days: [
      {
        day: {
          type: String,
          enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          required: true,
        },
        workout:    String,
        recipeId:   Number,
        name:       String,
        imageUrl:   String,
        calories:   Number,
        macros: {
          protein: Number,
          carbs:   Number,
          fat:     Number,
        },
        workoutTag:   String, // e.g. "+carbs"
        instructions: String,
        ingredients:  [String],
      },
    ],
  },
  { timestamps: true },
);

const MealPlan = mongoose.model("MealPlan", mealPlanSchema);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Strip HTML tags from Spoonacular instruction strings
function stripTags(html = "") {
  return html.replace(/<[^>]+>/g, "").trim();
}

// Pull a named nutrient amount out of Spoonacular's nutrition.nutrients array
function getNutrient(nutrients = [], name) {
  const found = nutrients.find((n) => n.name === name);
  return found ? Math.round(found.amount) : 0;
}

// ─── LANGGRAPH AGENT ──────────────────────────────────────────────────────────
//
// Triggered by POST /meal-plans.  The LLM drives tool selection via bindTools().
// Nodes: planMeals (LLM) → searchRecipes | getRecipeDetails | calculateNutrition
//        | savePlan → END
// The routing function reads state.toolCalls[0].name to dispatch to the right node,
// looping back to planMeals after each tool result until SaveMealPlan is called.

// ─── REQUEST CONTEXT ─────────────────────────────────────────────────────────
// Holds per-request data that tools need but the LLM shouldn't have to pass.
// Safe for this single-server school project (not concurrent-request safe).

const _ctx = {
  calorieTargets: {},
  workoutTags:    {},
  workouts:       {},
  userId:         "",
  recipeDetails:  {}, // accumulated GetRecipeDetails results keyed by day
};

// ─── TOOLS ────────────────────────────────────────────────────────────────────
// Schemas are kept intentionally minimal — fewer fields = less chance the LLM
// generates malformed JSON. Numbers that require computation live server-side.

class SearchRecipesTool extends StructuredTool {
  name        = "SearchRecipes";
  description = "Search for a recipe for a specific day. The calorie range is determined automatically. Provide a food query inspired by the user's preferences.";
  schema      = z.object({
    day:   z.string().describe("Day of the week: Mon, Tue, Wed, Thu, Fri, Sat, or Sun"),
    query: z.string().describe("Food or cuisine query e.g. 'Mediterranean chicken', 'vegetarian stir fry'"),
  });

  async _call({ day, query }) {
    // calorieTargets are daily totals — divide by 3 for a single-meal calorie range
    const dailyTarget = _ctx.calorieTargets[day] || 2000;
    const mealTarget  = Math.round(dailyTarget / 3);
    const minCal      = Math.max(100, mealTarget - 400);
    const maxCal      = mealTarget + 400;
    try {
      const url =
        `https://api.spoonacular.com/recipes/complexSearch` +
        `?apiKey=${SPOONACULAR_KEY}` +
        `&number=5&addRecipeNutrition=true` +
        `&minCalories=${minCal}&maxCalories=${maxCal}` +
        `&query=${encodeURIComponent(query)}`;
      const res  = await fetch(url);
      const data = await res.json();
      console.log(`SearchRecipes [${day}] query="${query}" cal=${minCal}-${maxCal} hits=${data.results?.length ?? 0}`);
      const hit  = data.results?.[0];
      return JSON.stringify({
        day,
        recipeId: hit?.id    ?? 0,
        title:    hit?.title ?? "Balanced Meal",
        image:    hit?.image ?? "",
      });
    } catch (err) {
      console.error("SearchRecipes error:", err.message);
      return JSON.stringify({ day, recipeId: 0, title: "Balanced Meal", image: "" });
    }
  }
}

class GetRecipeDetailsTool extends StructuredTool {
  name        = "GetRecipeDetails";
  description = "Get full ingredients, instructions, and nutrition for a recipe. Call this after SearchRecipes for each day using the recipeId returned.";
  schema      = z.object({
    day:      z.string().describe("Day of the week: Mon, Tue, Wed, Thu, Fri, Sat, or Sun"),
    recipeId: z.number().int().optional().default(0).describe("The recipeId number returned by SearchRecipes for this day"),
  });

  async _call({ day, recipeId }) {
    let detail;
    if (!recipeId || recipeId === 0) {
      const target = _ctx.calorieTargets[day] || 2000;
      detail = {
        name: "Balanced Meal", imageUrl: "", ingredients: ["Protein", "Carbs", "Vegetables", "Healthy fats"],
        instructions: "Prepare a balanced meal with your chosen ingredients.",
        calories: target, macros: { protein: Math.round(target * 0.3 / 4), carbs: Math.round(target * 0.45 / 4), fat: Math.round(target * 0.25 / 9) },
      };
    } else {
      try {
        const res       = await fetch(`https://api.spoonacular.com/recipes/${recipeId}/information?apiKey=${SPOONACULAR_KEY}&includeNutrition=true`);
        const data      = await res.json();
        const nutrients = data.nutrition?.nutrients || [];
        detail = {
          name:         data.title || "Balanced Meal",
          imageUrl:     data.image || "",
          ingredients:  (data.extendedIngredients || []).map((i) => i.original),
          instructions: stripTags(data.instructions || ""),
          calories:     getNutrient(nutrients, "Calories"),
          macros: {
            protein: getNutrient(nutrients, "Protein"),
            carbs:   getNutrient(nutrients, "Carbohydrates"),
            fat:     getNutrient(nutrients, "Fat"),
          },
        };
      } catch (err) {
        console.error("GetRecipeDetails error:", err.message);
        const target = _ctx.calorieTargets[day] || 2000;
        detail = { name: "Balanced Meal", imageUrl: "", ingredients: [], instructions: "", calories: target, macros: { protein: 0, carbs: 0, fat: 0 } };
      }
    }
    // Store in server-side context so SaveMealPlan can assemble the plan
    _ctx.recipeDetails[day] = { ...detail, recipeId };
    return JSON.stringify({ day, ...detail, recipeId });
  }
}

class CalculateNutritionTool extends StructuredTool {
  name        = "CalculateNutrition";
  description = "Verify the weekly meal plan meets calorie targets. Call this after GetRecipeDetails has been called for all 7 days. No arguments needed.";
  schema      = z.object({});

  async _call() {
    const results = DAYS.map((day) => {
      const detail = _ctx.recipeDetails[day];
      const target = _ctx.calorieTargets[day] || 2000;
      const calories = detail?.calories || 0;
      return { day, calories, target, pass: Math.abs(calories - target) <= 350 };
    });
    return JSON.stringify({ pass: results.every((r) => r.pass), results });
  }
}

class SaveMealPlanTool extends StructuredTool {
  name        = "SaveMealPlan";
  description = "Save the finalized 7-day meal plan to the database. Call this after CalculateNutrition. No arguments needed — the plan is assembled from the recipe details already collected.";
  schema      = z.object({});

  async _call() {
    const days = DAYS.map((day) => {
      const detail = _ctx.recipeDetails[day] || {};
      return {
        day,
        workout:      _ctx.workouts[day]    || "",
        recipeId:     detail.recipeId       || 0,
        name:         detail.name           || "Balanced Meal",
        imageUrl:     detail.imageUrl       || "",
        calories:     detail.calories       || 0,
        macros:       detail.macros         || { protein: 0, carbs: 0, fat: 0 },
        workoutTag:   _ctx.workoutTags[day] || "",
        instructions: detail.instructions   || "",
        ingredients:  detail.ingredients    || [],
      };
    });
    const plan = await MealPlan.create({ userId: _ctx.userId, days });
    console.log("SaveMealPlan: created", plan._id.toString());
    return JSON.stringify({ savedPlanId: plan._id.toString() });
  }
}

// ─── TOOL INSTANCES ───────────────────────────────────────────────────────────

const searchRecipesTool      = new SearchRecipesTool();
const getRecipeDetailsTool   = new GetRecipeDetailsTool();
const calculateNutritionTool = new CalculateNutritionTool();
const saveMealPlanTool       = new SaveMealPlanTool();

// ─── GRAPH STATE ──────────────────────────────────────────────────────────────

const graphStateData = {
  messages:   { value: (x, y) => x.concat(y), default: () => [] },
  toolCalls:  { value: (x, y) => x.concat(y), default: () => [] },
  result:     { value: (_x, y) => y,           default: () => null },
  sendStatus: { value: (_x, y) => y,           default: () => null },
};

// ─── NODES ────────────────────────────────────────────────────────────────────

// planMealsNode — the LLM node; called repeatedly until SaveMealPlan is chosen
const llmWithTools = llm.bindTools([
  searchRecipesTool,
  getRecipeDetailsTool,
  calculateNutritionTool,
  saveMealPlanTool,
]);

async function planMealsNode(state) {
  state.sendStatus?.("Planning your meals…");

  let response, attempts = 0;
  while (true) {
    try {
      response = await llmWithTools.invoke(state.messages);
      break;
    } catch (err) {
      if (++attempts >= 3) throw err;
      console.warn(`LLM attempt ${attempts} failed, retrying:`, err.message);
    }
  }

  const calls = response.tool_calls || [];
  console.log("LLM tool_calls:", calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`));

  if (!calls.length) {
    console.warn("LLM returned no tool calls — re-prompting");
    // Inject a nudge so the LLM sees it needs to keep going
    const nudge = new HumanMessage(
      "You must call a tool. Check the tool results above and call the next required tool now."
    );
    return { messages: [nudge], toolCalls: [] };
  }

  // Add the AI message (with tool_calls) so ToolMessages can be linked by tool_call_id
  return {
    messages:  [response],
    toolCalls: calls,
  };
}

async function searchRecipesNode(state) {
  state.sendStatus?.("Finding recipes that fit your targets…");
  const toolCall = state.toolCalls.shift(); // consume head of queue

  let toolResult;
  try {
    toolResult = await searchRecipesTool.invoke(toolCall.args);
  } catch (err) {
    console.warn("SearchRecipes parse error, using fallback:", err.message);
    const day = toolCall.args?.day || "Mon";
    toolResult = await searchRecipesTool.invoke({ day, query: "healthy balanced meal" });
  }

  const message = new ToolMessage({
    content:      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    name:         toolCall.name,
    tool_call_id: toolCall.id,
  });
  return { messages: [message] };
}

async function getRecipeDetailsNode(state) {
  state.sendStatus?.("Getting recipe details…");
  const toolCall = state.toolCalls.shift();

  let toolResult;
  try {
    toolResult = await getRecipeDetailsTool.invoke(toolCall.args);
  } catch (err) {
    // LLM produced malformed args (e.g. wrong field name) — fall back to day-only call
    console.warn("GetRecipeDetails parse error, using fallback:", err.message);
    const day = toolCall.args?.day || "Mon";
    toolResult = await getRecipeDetailsTool.invoke({ day, recipeId: 0 });
  }

  const message = new ToolMessage({
    content:      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    name:         toolCall.name,
    tool_call_id: toolCall.id,
  });
  return { messages: [message] };
}

async function calculateNutritionNode(state) {
  state.sendStatus?.("Checking nutrition…");
  const toolCall   = state.toolCalls.shift();
  const toolResult = await calculateNutritionTool.invoke(toolCall.args);
  const message    = new ToolMessage({
    content:      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    name:         toolCall.name,
    tool_call_id: toolCall.id,
  });
  return { messages: [message] };
}

async function savePlanNode(state) {
  state.sendStatus?.("Finalizing your plan…");
  const toolCall   = state.toolCalls.shift();
  const toolResult = await saveMealPlanTool.invoke(toolCall.args);
  const parsed     = typeof toolResult === "string" ? JSON.parse(toolResult) : toolResult;
  return { result: parsed };
}

// ─── ROUTING FUNCTION ─────────────────────────────────────────────────────────
// Dispatches to the right node based on the next pending tool call name.
// Loops back to planMeals after each tool result until result is set (SaveMealPlan done).

function routingFunction(state) {
  if (state.result) return END;
  const next = state.toolCalls[0];
  if (!next)                              return "planMeals";        // LLM needs to decide
  if (next.name === "SearchRecipes")      return "searchRecipes";
  if (next.name === "GetRecipeDetails")   return "getRecipeDetails";
  if (next.name === "CalculateNutrition") return "calculateNutrition";
  if (next.name === "SaveMealPlan")       return "savePlan";
  return "planMeals";
}

// ─── WIRE THE GRAPH ───────────────────────────────────────────────────────────

const workflow = new StateGraph({ channels: graphStateData });

workflow.addNode("planMeals",          planMealsNode);
workflow.addNode("searchRecipes",      searchRecipesNode);
workflow.addNode("getRecipeDetails",   getRecipeDetailsNode);
workflow.addNode("calculateNutrition", calculateNutritionNode);
workflow.addNode("savePlan",           savePlanNode);

workflow.addEdge(START, "planMeals");

// After planMeals, route based on which tool the LLM chose
workflow.addConditionalEdges("planMeals", routingFunction,
  ["planMeals", "searchRecipes", "getRecipeDetails", "calculateNutrition", "savePlan", END]);

// After each tool node, route again (either back to planMeals or to another tool)
workflow.addConditionalEdges("searchRecipes", routingFunction,
  ["planMeals", "searchRecipes", "getRecipeDetails", "calculateNutrition", "savePlan"]);
workflow.addConditionalEdges("getRecipeDetails", routingFunction,
  ["planMeals", "searchRecipes", "getRecipeDetails", "calculateNutrition", "savePlan"]);
workflow.addConditionalEdges("calculateNutrition", routingFunction,
  ["planMeals", "searchRecipes", "getRecipeDetails", "calculateNutrition", "savePlan"]);

workflow.addEdge("savePlan", END);

const graph = workflow.compile();

// ─── ROUTES: USERS ────────────────────────────────────────────────────────────

// POST /users — create a new user profile; calorieTarget is computed by pre-save hook
app.post("/users", async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /users/:id — retrieve a user by ID
app.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── ROUTES: MEAL PLANS ───────────────────────────────────────────────────────

// POST /meal-plans — SSE streaming: runs the LangGraph agent and streams progress
app.post("/meal-plans", async (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  function sendStatus(msg) { res.write(`data: ${JSON.stringify({ status: msg })}\n\n`); }
  function sendDone(planId) { res.write(`data: ${JSON.stringify({ done: true, planId })}\n\n`); res.end(); }
  function sendError(msg)   { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); }

  const { userId, workouts = {}, foodPreference = "" } = req.body;
  const user = await User.findById(userId).catch(() => null);
  if (!user) { sendError("User not found"); return; }

  // Pre-compute workout tags and calorie targets (deterministic math, no LLM needed)
  const HIGH_LOAD      = /leg|squat|run|long|heavy|cardio|bike|swim/i;
  const workoutTags    = {};
  const calorieTargets = {};
  for (const day of DAYS) {
    const w             = workouts[day] || "";
    workoutTags[day]    = HIGH_LOAD.test(w) ? "+carbs" : "";
    calorieTargets[day] = Math.round(workoutTags[day] === "+carbs" ? user.calorieTarget + 200 : user.calorieTarget);
  }

  // Build context string for the LLM prompt
  const dayContext = DAYS.map((d) =>
    `  ${d}: workout="${workouts[d] || "Rest"}", calorie_target=${calorieTargets[d]}, tag="${workoutTags[d] || "none"}"`
  ).join("\n");

  const systemMsg = new SystemMessage(
    `You are a meal planner assistant. You create 7-day meal plans by calling tools one at a time.\n` +
    `Each time you are called, look at the tool results already in this conversation to understand your progress, then call EXACTLY ONE tool to take the next step.\n\n` +
    `The required sequence is:\n` +
    `PHASE 1 — For each day Mon,Tue,Wed,Thu,Fri,Sat,Sun (in order): call SearchRecipes to find a recipe.\n` +
    `PHASE 2 — For each day Mon,Tue,Wed,Thu,Fri,Sat,Sun (in order): call GetRecipeDetails using the recipeId from the SearchRecipes result for that day.\n` +
    `PHASE 3 — Call CalculateNutrition once with all 7 meals.\n` +
    `PHASE 4 — Call SaveMealPlan once with all 7 days to finish.\n\n` +
    `Rules:\n` +
    `- Call only ONE tool per response.\n` +
    `- Read previous tool results carefully to know which day you are on and which phase you are in.\n` +
    `- Never repeat a tool call for a day you already have a result for.\n` +
    `- Do not stop until SaveMealPlan has been called.`
  );

  const humanMsg = new HumanMessage(
    `Create a 7-day meal plan.\n` +
    `Food preferences: ${foodPreference || "balanced, healthy meals"}\n\n` +
    `Per-day calorie targets and workout tags:\n${dayContext}\n\n` +
    `Begin now: call SearchRecipes for Mon.`
  );

  // Populate module-level context so tools can access per-request data
  _ctx.calorieTargets = calorieTargets;
  _ctx.workoutTags    = workoutTags;
  _ctx.workouts       = workouts;
  _ctx.userId         = userId;
  _ctx.recipeDetails  = {};

  try {
    sendStatus("Starting meal planning…");
    const finalState = await graph.invoke(
      { messages: [systemMsg, humanMsg], sendStatus },
      { recursionLimit: 60 },
    );
    console.log("FINAL STATE result:", finalState.result);
    if (finalState.result?.savedPlanId) {
      sendDone(finalState.result.savedPlanId);
    } else {
      sendError("Agent did not save a plan");
    }
  } catch (err) {
    console.error("Agent error:", err);
    sendError(err.message);
  }
});

// GET /meal-plans/:id — retrieve a saved meal plan by ID
app.get("/meal-plans/:id", async (req, res) => {
  try {
    const plan = await MealPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Meal plan not found" });
    res.json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /meal-plans/:id/meals/:day — swap a single day's meal
app.put("/meal-plans/:id/meals/:day", async (req, res) => {
  try {
    const plan = await MealPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Meal plan not found" });

    const dayEntry = plan.days.find((d) => d.day === req.params.day);
    if (!dayEntry)
      return res
        .status(404)
        .json({ error: `Day "${req.params.day}" not found in plan` });

    // Apply all provided fields to the matching day sub-document
    const {
      recipeId,
      name,
      imageUrl,
      calories,
      macros,
      workoutTag,
      instructions,
      ingredients,
    } = req.body;
    if (recipeId      !== undefined) dayEntry.recipeId      = recipeId;
    if (name          !== undefined) dayEntry.name          = name;
    if (imageUrl      !== undefined) dayEntry.imageUrl      = imageUrl;
    if (calories      !== undefined) dayEntry.calories      = calories;
    if (macros        !== undefined) dayEntry.macros        = macros;
    if (workoutTag    !== undefined) dayEntry.workoutTag    = workoutTag;
    if (instructions  !== undefined) dayEntry.instructions  = instructions;
    if (ingredients   !== undefined) dayEntry.ingredients   = ingredients;

    await plan.save();
    res.json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /meal-plans/:id — remove a meal plan
app.delete("/meal-plans/:id", async (req, res) => {
  try {
    const plan = await MealPlan.findByIdAndDelete(req.params.id);
    if (!plan) return res.status(404).json({ error: "Meal plan not found" });
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () =>
  console.log(`NourishWeek running on http://localhost:${PORT}`),
);
