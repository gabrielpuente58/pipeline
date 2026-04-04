require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { ChatOllama } = require("@langchain/ollama");
const {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "nourishweek_dev_secret";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "racedayplanner";
const PORT = process.env.PORT || 8080;
const SPOONACULAR_KEY = process.env.SPOONACULAR_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://golem:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";

const llm = new ChatOllama({
  baseUrl: OLLAMA_HOST,
  model: OLLAMA_MODEL,
  numCtx: 131072,
});

mongoose
  .connect(`${MONGODB_URI}/${DB_NAME}`)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB error:", err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: { type: String, required: true },
  height: { type: Number, required: true, min: 1 }, // cm
  weight: { type: Number, required: true, min: 1 }, // kg
  age: { type: Number, required: true, min: 1 },
  sex: { type: String, enum: ["male", "female"], required: true },
  calorieTarget: { type: Number },
  // Store imperial originals for display
  heightFt: { type: Number },
  heightIn: { type: Number },
  weightLbs: { type: Number },
});

userSchema.pre("save", async function () {
  const base = 10 * this.weight + 6.25 * this.height - 5 * this.age;
  this.calorieTarget = this.sex === "male" ? base + 5 : base - 161;
});

const User = mongoose.model("User", userSchema);

function signToken(userId) {
  return jwt.sign({ userId: userId.toString() }, JWT_SECRET, {
    expiresIn: "30d",
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// DailyPlan — one document per generated day plan, linked to a User
const dailyPlanSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  date: { type: Date, default: Date.now },
  totalCalories: Number,
  workouts: {
    swim: { type: Number, default: 0 }, // minutes
    bike: { type: Number, default: 0 },
    run: { type: Number, default: 0 },
    lift: { type: Number, default: 0 },
  },
  meals: [
    {
      mealType: {
        type: String,
        enum: ["breakfast", "lunch", "dinner"],
        required: true,
      },
      recipeId: Number,
      name: String,
      imageUrl: String,
      calories: Number,
      macros: { protein: Number, carbs: Number, fat: Number },
      ingredients: [String],
      instructions: String,
    },
  ],
});

const DailyPlan = mongoose.model("DailyPlan", dailyPlanSchema);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function stripTags(html = "") {
  return html.replace(/<[^>]+>/g, "").trim();
}

function getNutrient(nutrients = [], name) {
  const found = nutrients.find((n) => n.name === name);
  return found ? Math.round(found.amount) : 0;
}

const _ctx = {
  mealTargets: {}, // { breakfast: N, lunch: N, dinner: N }
  recipeDetails: {}, // { breakfast: {...}, lunch: {...}, dinner: {...} }
  usedRecipeIds: new Set(),
  userId: "",
  totalCalories: 0,
  workouts: {},
};

// ─── TOOLS ────────────────────────────────────────────────────────────────────

class SearchRecipesTool extends StructuredTool {
  name = "SearchRecipes";
  description =
    "Search for a recipe for a specific meal. The calorie range is determined automatically.";
  schema = z.object({
    mealType: z.string().describe("breakfast, lunch, or dinner"),
    query: z
      .string()
      .describe("Food query e.g. 'oatmeal banana', 'grilled salmon'"),
  });

  async _call({ mealType, query }) {
    const doSearch = async (q) => {
      const url =
        `https://api.spoonacular.com/recipes/complexSearch` +
        `?apiKey=${SPOONACULAR_KEY}` +
        `&number=5` +
        `&addRecipeInformation=false` +
        `&query=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status === "failure" || data.code === 402)
        console.error("Spoonacular error:", data.message || data);
      console.log(
        `SearchRecipes [${mealType}] query="${q}" hits=${data.results?.length ?? 0}`,
      );
      return data.results || [];
    };

    try {
      // Strip filler adjectives the LLM tends to prepend
      const cleaned = query
        .replace(/\b(high protein|low carb|healthy|nutritious|calorie)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      let results = await doSearch(cleaned);

      // Fallback 1: first 3 words of cleaned query
      if (!results.length) {
        const short = cleaned.split(" ").slice(0, 3).join(" ");
        if (short !== cleaned) results = await doSearch(short);
      }

      // Fallback 2: single-word fallback per meal type
      if (!results.length) {
        const defaults = {
          breakfast: "eggs",
          lunch: "chicken",
          dinner: "salmon",
        };
        results = await doSearch(defaults[mealType] || "chicken");
      }

      const hit =
        results.find((r) => !_ctx.usedRecipeIds.has(r.id)) || results[0];
      if (hit?.id) _ctx.usedRecipeIds.add(hit.id);

      return JSON.stringify({
        mealType,
        recipeId: hit?.id ?? 0,
        title: hit?.title ?? "Balanced Meal",
      });
    } catch (err) {
      console.error("SearchRecipes error:", err.message);
      return JSON.stringify({ mealType, recipeId: 0, title: "Balanced Meal" });
    }
  }
}

class GetRecipeDetailsTool extends StructuredTool {
  name = "GetRecipeDetails";
  description =
    "Get full ingredients, nutrition, and instructions for a recipe.";
  schema = z.object({
    mealType: z.string().describe("breakfast, lunch, or dinner"),
    recipeId: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe("The recipeId returned by SearchRecipes for this meal"),
  });

  async _call({ mealType, recipeId }) {
    let detail;

    if (!recipeId || recipeId === 0) {
      const target = _ctx.mealTargets[mealType] || 600;
      detail = {
        name: "Balanced Meal",
        imageUrl: "",
        ingredients: ["Protein", "Carbs", "Vegetables", "Healthy fats"],
        instructions: "Prepare a balanced meal with your chosen ingredients.",
        calories: target,
        macros: {
          protein: Math.round((target * 0.3) / 4),
          carbs: Math.round((target * 0.45) / 4),
          fat: Math.round((target * 0.25) / 9),
        },
      };
    } else {
      try {
        const res = await fetch(
          `https://api.spoonacular.com/recipes/${recipeId}/information` +
            `?apiKey=${SPOONACULAR_KEY}&includeNutrition=true`,
        );
        const data = await res.json();
        const nutrients = data.nutrition?.nutrients || [];
        detail = {
          name: data.title || "Balanced Meal",
          imageUrl: data.image || "",
          ingredients: (data.extendedIngredients || []).map((i) => i.original),
          instructions: stripTags(data.instructions || ""),
          calories: getNutrient(nutrients, "Calories"),
          macros: {
            protein: getNutrient(nutrients, "Protein"),
            carbs: getNutrient(nutrients, "Carbohydrates"),
            fat: getNutrient(nutrients, "Fat"),
          },
        };
      } catch (err) {
        console.error("GetRecipeDetails error:", err.message);
        const target = _ctx.mealTargets[mealType] || 600;
        detail = {
          name: "Balanced Meal",
          imageUrl: "",
          ingredients: [],
          instructions: "",
          calories: target,
          macros: { protein: 0, carbs: 0, fat: 0 },
        };
      }
    }

    // Store in server-side context so SaveDailyPlan can assemble the plan
    _ctx.recipeDetails[mealType] = { ...detail, recipeId };

    return JSON.stringify({ mealType, ...detail, recipeId });
  }
}

class SaveDailyPlanTool extends StructuredTool {
  name = "SaveDailyPlan";
  description =
    "Save the finalized meal plan. Call this after GetRecipeDetails has been called for all 3 meals. No arguments needed.";
  schema = z.object({});

  async _call() {
    const meals = ["breakfast", "lunch", "dinner"].map((mealType) => {
      const detail = _ctx.recipeDetails[mealType] || {};
      return {
        mealType,
        recipeId: detail.recipeId || 0,
        name: detail.name || "Balanced Meal",
        imageUrl: detail.imageUrl || "",
        calories: detail.calories || 0,
        macros: detail.macros || { protein: 0, carbs: 0, fat: 0 },
        ingredients: detail.ingredients || [],
        instructions: detail.instructions || "",
      };
    });

    const plan = await DailyPlan.create({
      userId: _ctx.userId,
      totalCalories: _ctx.totalCalories,
      workouts: _ctx.workouts,
      meals,
    });

    console.log("SaveDailyPlan: created", plan._id.toString());
    return JSON.stringify({ savedPlanId: plan._id.toString() });
  }
}

const searchRecipesTool = new SearchRecipesTool();
const getRecipeDetailsTool = new GetRecipeDetailsTool();
const saveDailyPlanTool = new SaveDailyPlanTool();

// ─── GRAPH STATE ──────────────────────────────────────────────────────────────

const graphStateData = {
  messages: { value: (x, y) => x.concat(y), default: () => [] },
  toolCalls: { value: (x, y) => x.concat(y), default: () => [] },
  result: { value: (_x, y) => y, default: () => null },
  sendStatus: { value: (_x, y) => y, default: () => null },
};

// ─── NODES ────────────────────────────────────────────────────────────────────

const llmWithTools = llm.bindTools([
  searchRecipesTool,
  getRecipeDetailsTool,
  saveDailyPlanTool,
]);

async function planMealsNode(state) {
  let response,
    attempts = 0;
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
  console.log(
    "LLM tool_calls:",
    calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`),
  );

  if (!calls.length) {
    console.warn("LLM returned no tool calls — re-prompting");
    const nudge = new HumanMessage(
      "You must call a tool. Check the tool results above and call the next required tool now.",
    );
    return { messages: [nudge], toolCalls: [] };
  }

  return {
    messages: [response],
    toolCalls: calls,
  };
}

async function searchRecipesNode(state) {
  const toolCall = state.toolCalls.shift();
  const mealType = toolCall.args?.mealType || "breakfast";

  const statusMap = {
    breakfast: "Searching for breakfast\u2026",
    lunch: "Searching for lunch\u2026",
    dinner: "Searching for dinner\u2026",
  };
  state.sendStatus?.(statusMap[mealType] || "Finding recipes\u2026");

  let toolResult;
  try {
    toolResult = await searchRecipesTool.invoke(toolCall.args);
  } catch (err) {
    console.warn("SearchRecipes parse error, using fallback:", err.message);
    toolResult = await searchRecipesTool.invoke({
      mealType,
      query: "healthy balanced meal",
    });
  }

  const message = new ToolMessage({
    content:
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    name: toolCall.name,
    tool_call_id: toolCall.id,
  });
  return { messages: [message] };
}

async function getRecipeDetailsNode(state) {
  state.sendStatus?.("Getting recipe details\u2026");
  const toolCall = state.toolCalls.shift();

  let toolResult;
  try {
    toolResult = await getRecipeDetailsTool.invoke(toolCall.args);
  } catch (err) {
    console.warn("GetRecipeDetails parse error, using fallback:", err.message);
    const mealType = toolCall.args?.mealType || "breakfast";
    toolResult = await getRecipeDetailsTool.invoke({ mealType, recipeId: 0 });
  }

  const message = new ToolMessage({
    content:
      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
    name: toolCall.name,
    tool_call_id: toolCall.id,
  });
  return { messages: [message] };
}

async function savePlanNode(state) {
  state.sendStatus?.("Saving your meal plan\u2026");
  const toolCall = state.toolCalls.shift();
  const toolResult = await saveDailyPlanTool.invoke(toolCall.args);
  const parsed =
    typeof toolResult === "string" ? JSON.parse(toolResult) : toolResult;
  return { result: parsed };
}

// ─── ROUTING FUNCTION ─────────────────────────────────────────────────────────

function routingFunction(state) {
  if (state.result) return END;
  const next = state.toolCalls[0];
  if (!next) return "planMeals";
  if (next.name === "SearchRecipes") return "searchRecipes";
  if (next.name === "GetRecipeDetails") return "getRecipeDetails";
  if (next.name === "SaveDailyPlan") return "savePlan";
  return "planMeals";
}

// ─── WIRE THE GRAPH ───────────────────────────────────────────────────────────

const workflow = new StateGraph({ channels: graphStateData });

workflow.addNode("planMeals", planMealsNode);
workflow.addNode("searchRecipes", searchRecipesNode);
workflow.addNode("getRecipeDetails", getRecipeDetailsNode);
workflow.addNode("savePlan", savePlanNode);

workflow.addEdge(START, "planMeals");

const conditionalTargets = [
  "planMeals",
  "searchRecipes",
  "getRecipeDetails",
  "savePlan",
  END,
];

workflow.addConditionalEdges("planMeals", routingFunction, conditionalTargets);
workflow.addConditionalEdges(
  "searchRecipes",
  routingFunction,
  conditionalTargets,
);
workflow.addConditionalEdges(
  "getRecipeDetails",
  routingFunction,
  conditionalTargets,
);

workflow.addEdge("savePlan", END);

const graph = workflow.compile();

app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, heightFt, heightIn, weightLbs, age, sex } =
      req.body;
    if (
      !email ||
      !password ||
      heightFt == null ||
      heightIn == null ||
      weightLbs == null ||
      !age ||
      !sex
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(400).json({ error: "Email already in use" });

    const height_cm = Math.round(
      (Number(heightFt) * 12 + Number(heightIn)) * 2.54,
    );
    const weight_kg = Math.round(Number(weightLbs) * 0.453592 * 10) / 10;
    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      passwordHash,
      height: height_cm,
      weight: weight_kg,
      age: Number(age),
      sex,
      heightFt: Number(heightFt),
      heightIn: Number(heightIn),
      weightLbs: Number(weightLbs),
    });
    await user.save();

    res.status(201).json({
      token: signToken(user._id),
      userId: user._id,
      profile: {
        email,
        heightFt: user.heightFt,
        heightIn: user.heightIn,
        weightLbs: user.weightLbs,
        age: user.age,
        sex: user.sex,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ error: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match)
      return res.status(401).json({ error: "Invalid email or password" });

    res.json({
      token: signToken(user._id),
      userId: user._id,
      profile: {
        email: user.email,
        heightFt: user.heightFt,
        heightIn: user.heightIn,
        weightLbs: user.weightLbs,
        age: user.age,
        sex: user.sex,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/users", async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/daily-plans", authenticate, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function sendStatus(msg) {
    res.write(`data: ${JSON.stringify({ status: msg })}\n\n`);
  }
  function sendDone(planId) {
    res.write(`data: ${JSON.stringify({ done: true, planId })}\n\n`);
    res.end();
  }
  function sendError(msg) {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }

  const userId = req.userId;
  const { workouts = {}, foodPreference = "" } = req.body;

  const user = await User.findById(userId).catch(() => null);
  if (!user) {
    sendError("User not found");
    return;
  }

  // Workout calorie burn rates (cal/min)
  const BURN = { swim: 11.67, bike: 10, run: 12.5, lift: 6.67 };

  const swim = Number(workouts.swim || 0);
  const bike = Number(workouts.bike || 0);
  const run = Number(workouts.run || 0);
  const lift = Number(workouts.lift || 0);

  const totalCalories = Math.round(
    user.calorieTarget +
      swim * BURN.swim +
      bike * BURN.bike +
      run * BURN.run +
      lift * BURN.lift,
  );

  const mealTargets = {
    breakfast: totalCalories * 0.28,
    lunch: totalCalories * 0.35,
    dinner: totalCalories * 0.37,
  };

  _ctx.mealTargets = mealTargets;
  _ctx.recipeDetails = {};
  _ctx.usedRecipeIds = new Set();
  _ctx.userId = userId;
  _ctx.totalCalories = totalCalories;
  _ctx.workouts = { swim, bike, run, lift };

  const systemMsg = new SystemMessage(
    `You are a meal planner for a triathlete. Plan 3 meals (breakfast, lunch, dinner) by calling tools one at a time.\n\n` +
      `Sequence:\n` +
      `1. SearchRecipes for breakfast (use a breakfast-appropriate query like "eggs oatmeal", "smoothie bowl", "avocado toast")\n` +
      `2. GetRecipeDetails for breakfast using the recipeId returned\n` +
      `3. SearchRecipes for lunch (use a lunch query like "grilled chicken salad", "tuna wrap")\n` +
      `4. GetRecipeDetails for lunch\n` +
      `5. SearchRecipes for dinner (use a dinner query like "salmon pasta", "beef stir fry")\n` +
      `6. GetRecipeDetails for dinner\n` +
      `7. Call SaveDailyPlan to finish\n\n` +
      `Rules:\n` +
      `- Call exactly ONE tool per response\n` +
      `- Use SHORT queries (2-3 words max, e.g. "chicken salad", "salmon pasta", "oatmeal")\n` +
      `- Do NOT add words like "high protein", "healthy", or "low carb" to queries\n` +
      `- Use DIFFERENT queries for each meal\n` +
      `- Do not stop until SaveDailyPlan is called`,
  );

  const humanMsg = new HumanMessage(
    `Plan meals for today.\n` +
      `Food preferences: ${foodPreference || "balanced, healthy meals"}\n` +
      `Total daily calories: ${totalCalories}\n` +
      `Workouts: swim=${swim}min, bike=${bike}min, run=${run}min, lift=${lift}min\n\n` +
      `Meal calorie targets: breakfast=${Math.round(mealTargets.breakfast)}, lunch=${Math.round(mealTargets.lunch)}, dinner=${Math.round(mealTargets.dinner)}\n\n` +
      `Begin with SearchRecipes for breakfast.`,
  );

  try {
    sendStatus("Planning your meals\u2026");
    const finalState = await graph.invoke(
      { messages: [systemMsg, humanMsg], sendStatus },
      { recursionLimit: 40 },
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

app.get("/daily-plans/:id", async (req, res) => {
  try {
    const plan = await DailyPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Daily plan not found" });
    res.json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`Race Day Planner running on http://localhost:${PORT}`),
);
