require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const { ChatOllama } = require("@langchain/ollama");
const { HumanMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");
const { StructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");

const Athlete = require("./models/Athlete");
const ChecklistItem = require("./models/ChecklistItem");
const MealPlan = require("./models/MealPlan");
const Reminder = require("./models/Reminder");
const { seedChecklist } = require("./seed");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "race_day_planner";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://golem:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const PORT = process.env.PORT || 8080;

// Express
const app = express();
app.use(cors());
app.use(express.json());

// MongoDB
mongoose
  .connect(`${MONGODB_URI}/${DB_NAME}`)
  .then(async () => {
    console.log("Connected to MongoDB");
    await seedChecklist(ChecklistItem);
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// LLM
const llm = new ChatOllama({
  baseUrl: OLLAMA_HOST,
  model: OLLAMA_MODEL,
  numCtx: 131072,
});

// ─── LANGGRAPH TOOLS ────────────────────────────────────────────────────────

class GenerateMealPlanTool extends StructuredTool {
  name = "generate_meal_plan";
  description =
    "Generate a 3-day carb-loading meal plan for an Ironman 70.3 athlete based on their weight and gender. Returns an array of 3 days, each with breakfast, lunch, dinner, and snacks.";

  schema = z.object({
    weight: z.number().describe("Athlete weight in pounds"),
    gender: z.enum(["male", "female", "prefer-not-to-say"]).describe("Athlete gender"),
    raceLocation: z.string().describe("Race location for context"),
  });

  async _call({ weight, gender, raceLocation }) {
    return JSON.stringify({
      weight,
      gender,
      raceLocation,
      requested: "3-day carb loading meal plan",
    });
  }
}

class GenerateRemindersTool extends StructuredTool {
  name = "generate_reminders";
  description =
    "Generate a timeline of race preparation reminders for an Ironman 70.3 athlete. Returns an array of reminder objects with title, message, category, daysBeforeRace, and priority.";

  schema = z.object({
    daysUntilRace: z.number().describe("Number of days until the race"),
    raceLocation: z.string().describe("Race location"),
    athleteName: z.string().describe("Athlete name"),
  });

  async _call({ daysUntilRace, raceLocation, athleteName }) {
    return JSON.stringify({
      daysUntilRace,
      raceLocation,
      athleteName,
      requested: "race preparation reminder timeline",
    });
  }
}

// ─── GRAPH STATE ─────────────────────────────────────────────────────────────

const graphStateData = {
  athlete: {
    value: (x, y) => y,
    default: () => null,
  },
  mealPlan: {
    value: (x, y) => y,
    default: () => null,
  },
  reminders: {
    value: (x, y) => y,
    default: () => null,
  },
  messages: {
    value: (x, y) => x.concat(y),
    default: () => [],
  },
  toolCalls: {
    value: (x, y) => x.concat(y),
    default: () => [],
  },
};

const mealPlanTool = new GenerateMealPlanTool();
const remindersTool = new GenerateRemindersTool();

// ─── GRAPH NODES ─────────────────────────────────────────────────────────────

async function analyzeAthleteNode(state) {
  const { athlete, mealPlan, reminders } = state;
  const daysUntilRace = Math.ceil(
    (new Date(athlete.raceDate) - new Date()) / (1000 * 60 * 60 * 24)
  );

  const needsMealPlan = !mealPlan;
  const needsReminders = !reminders;

  if (!needsMealPlan && !needsReminders) {
    return {};
  }

  const systemMsg = new SystemMessage(
    `You are a triathlon race preparation assistant for Ironman 70.3 athletes.
Your job is to call the appropriate tools to generate personalized race preparation content.
Always call the tools — do not generate the content yourself as text.
Call generate_meal_plan if a meal plan is needed.
Call generate_reminders if reminders are needed.`
  );

  const userMsg = new HumanMessage(
    `Athlete: ${athlete.name}, ${athlete.weight} lbs, ${athlete.gender}.
Race: ${athlete.raceLocation} in ${daysUntilRace} days.
${needsMealPlan ? "Generate a 3-day carb-loading meal plan." : ""}
${needsReminders ? "Generate race preparation reminders timeline." : ""}`
  );

  const tools = [];
  if (needsMealPlan) tools.push(mealPlanTool);
  if (needsReminders) tools.push(remindersTool);

  const llmWithTools = llm.bindTools(tools);
  const response = await llmWithTools.invoke([systemMsg, userMsg, ...state.messages]);
  console.log("analyzeAthleteNode LLM response:", response);

  return {
    toolCalls: response.tool_calls || [],
    messages: [response],
  };
}

async function generateMealPlanNode(state) {
  const toolCall = state.toolCalls.find((tc) => tc.name === "generate_meal_plan");
  console.log("generateMealPlanNode tool call:", toolCall);

  const toolResult = await mealPlanTool.invoke(toolCall.args);

  const systemMsg = new SystemMessage(
    `You are a sports nutritionist specializing in triathlon. Generate a detailed 3-day carb-loading meal plan.
Respond ONLY with a valid JSON object in this exact structure:
{
  "days": [
    {
      "label": "3 Days Before Race",
      "meals": [
        { "time": "Breakfast", "name": "...", "description": "...", "carbs": 80, "calories": 450 },
        { "time": "Lunch", "name": "...", "description": "...", "carbs": 90, "calories": 550 },
        { "time": "Dinner", "name": "...", "description": "...", "carbs": 100, "calories": 600 },
        { "time": "Snack", "name": "...", "description": "...", "carbs": 40, "calories": 200 }
      ],
      "totalCarbs": 310,
      "totalCalories": 1800
    }
  ],
  "notes": "..."
}
Do not include any text outside the JSON.`
  );

  const userMsg = new HumanMessage(
    `Generate a 3-day carb-loading meal plan for: ${JSON.stringify(toolCall.args)}`
  );

  const toolMsg = new ToolMessage({
    content: toolResult,
    name: toolCall.name,
    tool_call_id: toolCall.id,
  });

  const response = await llm.invoke([systemMsg, toolMsg, userMsg]);
  console.log("generateMealPlanNode LLM response:", response.content);

  let parsed = null;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response.content);
  } catch (e) {
    console.error("Failed to parse meal plan JSON:", e);
    parsed = { days: [], notes: "Could not generate meal plan." };
  }

  return {
    mealPlan: parsed,
    messages: [toolMsg, response],
  };
}

async function generateRemindersNode(state) {
  const toolCall = state.toolCalls.find((tc) => tc.name === "generate_reminders");
  console.log("generateRemindersNode tool call:", toolCall);

  const toolResult = await remindersTool.invoke(toolCall.args);

  const systemMsg = new SystemMessage(
    `You are a triathlon race director. Generate a timeline of preparation reminders for an Ironman 70.3 athlete.
Respond ONLY with a valid JSON array of reminder objects with this exact structure:
[
  {
    "title": "...",
    "message": "...",
    "category": "purchase|maintenance|training|nutrition|logistics",
    "daysBeforeRace": 90,
    "priority": "high|medium|low"
  }
]
Include 10-15 reminders spanning from 90 days out to race day. Do not include any text outside the JSON array.`
  );

  const userMsg = new HumanMessage(
    `Generate reminders for: ${JSON.stringify(toolCall.args)}`
  );

  const toolMsg = new ToolMessage({
    content: toolResult,
    name: toolCall.name,
    tool_call_id: toolCall.id,
  });

  const response = await llm.invoke([systemMsg, toolMsg, userMsg]);
  console.log("generateRemindersNode LLM response:", response.content);

  let parsed = null;
  try {
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response.content);
  } catch (e) {
    console.error("Failed to parse reminders JSON:", e);
    parsed = [];
  }

  return {
    reminders: parsed,
    messages: [toolMsg, response],
  };
}

async function submitResultsNode(state) {
  console.log("submitResultsNode: persisting results");
  return {};
}

// ─── ROUTING FUNCTION ─────────────────────────────────────────────────────────

function routingFunction(state) {
  if (state.mealPlan && state.reminders) {
    console.log("Routing -> submitResults");
    return "submitResults";
  }

  const pendingToolCalls = state.toolCalls.filter(
    (tc) =>
      (tc.name === "generate_meal_plan" && !state.mealPlan) ||
      (tc.name === "generate_reminders" && !state.reminders)
  );

  if (pendingToolCalls.length > 0) {
    if (pendingToolCalls[0].name === "generate_meal_plan") {
      console.log("Routing -> generateMealPlan");
      return "generateMealPlan";
    }
    if (pendingToolCalls[0].name === "generate_reminders") {
      console.log("Routing -> generateReminders");
      return "generateReminders";
    }
  }

  console.log("Routing -> analyzeAthlete (retry)");
  return "analyzeAthlete";
}

// ─── BUILD GRAPH ─────────────────────────────────────────────────────────────

const workflow = new StateGraph({ channels: graphStateData });

workflow.addNode("analyzeAthlete", analyzeAthleteNode);
workflow.addNode("generateMealPlan", generateMealPlanNode);
workflow.addNode("generateReminders", generateRemindersNode);
workflow.addNode("submitResults", submitResultsNode);

workflow.addEdge(START, "analyzeAthlete");
workflow.addConditionalEdges("analyzeAthlete", routingFunction, [
  "generateMealPlan",
  "generateReminders",
  "submitResults",
]);
workflow.addEdge("generateMealPlan", "analyzeAthlete");
workflow.addEdge("generateReminders", "analyzeAthlete");
workflow.addEdge("submitResults", END);

const graph = workflow.compile();

// ─── REST ROUTES ─────────────────────────────────────────────────────────────

// POST /athlete — create athlete profile
app.post("/athlete", async (req, res) => {
  try {
    const existing = await Athlete.findOne();
    if (existing) {
      return res.status(409).json({ error: "Athlete profile already exists. Use PUT to update." });
    }
    const athlete = await Athlete.create(req.body);
    res.status(201).json(athlete);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /athlete — get athlete profile
app.get("/athlete", async (req, res) => {
  try {
    const athlete = await Athlete.findOne();
    if (!athlete) return res.status(404).json({ error: "No athlete profile found" });
    res.json(athlete);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /athlete/:id — update athlete profile
app.put("/athlete/:id", async (req, res) => {
  try {
    const athlete = await Athlete.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!athlete) return res.status(404).json({ error: "Athlete not found" });
    res.json(athlete);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /checklist — get all checklist items
app.get("/checklist", async (req, res) => {
  try {
    const items = await ChecklistItem.find().sort({ category: 1, name: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /checklist/:id — toggle checked or purchased
app.put("/checklist/:id", async (req, res) => {
  try {
    const item = await ChecklistItem.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!item) return res.status(404).json({ error: "Checklist item not found" });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /checklist/:id — delete a checklist item
app.delete("/checklist/:id", async (req, res) => {
  try {
    const item = await ChecklistItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Checklist item not found" });
    res.json({ message: "Item deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /generate-plan — run AI agent to generate meal plan + reminders
app.post("/generate-plan", async (req, res) => {
  try {
    const athlete = await Athlete.findOne();
    if (!athlete) {
      return res.status(400).json({ error: "No athlete profile found. Create one first." });
    }

    const state = await graph.invoke({ athlete });
    console.log("Final graph state:", state.mealPlan ? "meal plan ok" : "no meal plan", state.reminders ? "reminders ok" : "no reminders");

    // Persist meal plan
    await MealPlan.deleteMany({ athleteId: athlete._id });
    const mealPlan = await MealPlan.create({
      athleteId: athlete._id,
      days: state.mealPlan?.days || [],
      notes: state.mealPlan?.notes || "",
    });

    // Persist reminders
    await Reminder.deleteMany({ athleteId: athlete._id });
    const remindersData = (state.reminders || []).map((r) => ({
      ...r,
      athleteId: athlete._id,
    }));
    const reminders = await Reminder.insertMany(remindersData);

    res.json({ mealPlan, reminders });
  } catch (err) {
    console.error("generate-plan error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /meal-plan — get saved meal plan
app.get("/meal-plan", async (req, res) => {
  try {
    const mealPlan = await MealPlan.findOne().sort({ createdAt: -1 });
    if (!mealPlan) return res.status(404).json({ error: "No meal plan found" });
    res.json(mealPlan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /reminders — get reminders sorted by daysBeforeRace
app.get("/reminders", async (req, res) => {
  try {
    const reminders = await Reminder.find().sort({ daysBeforeRace: -1 });
    res.json(reminders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
