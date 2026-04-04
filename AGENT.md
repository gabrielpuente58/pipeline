# Race Day Planner — Agent Diagram

## Graph

```mermaid
flowchart TD
    START([START]) --> planMeals

    planMeals["planMeals\nLLM decides next tool call"]

    planMeals -->|toolCalls[0] == SearchRecipes| searchRecipes
    planMeals -->|toolCalls[0] == GetRecipeDetails| getRecipeDetails
    planMeals -->|toolCalls[0] == SaveDailyPlan| savePlan
    planMeals -->|no tool calls| planMeals

    searchRecipes["searchRecipes\nQueries Spoonacular by keyword\nFallbacks: strip adjectives → 3 words → default term"]
    getRecipeDetails["getRecipeDetails\nFetches ingredients, macros,\ninstructions from Spoonacular"]
    savePlan["savePlan\nWrites DailyPlan to MongoDB"]

    searchRecipes -->|routingFunction| planMeals
    getRecipeDetails -->|routingFunction| planMeals
    savePlan --> END([END])

    planMeals -->|state.result set| END
```

---

## Nodes

| Node | Description |
|------|-------------|
| `planMeals` | Calls the LLM with full message history. LLM responds with one tool call. If no tool call returned, nudges LLM to try again. |
| `searchRecipes` | Invokes `SearchRecipesTool` — queries Spoonacular `complexSearch` by meal type and keyword. Has 3 fallback levels if hits = 0. Streams SSE status to client. |
| `getRecipeDetails` | Invokes `GetRecipeDetailsTool` — fetches full recipe info (`/recipes/{id}/information`). Stores result in `_ctx.recipeDetails`. |
| `savePlan` | Invokes `SaveDailyPlanTool` — assembles the 3 meals from `_ctx.recipeDetails` and writes a `DailyPlan` document to MongoDB. Sets `state.result` to signal completion. |

---

## Edges

| From | To | Condition |
|------|----|-----------|
| START | `planMeals` | Always (static) |
| `planMeals` | `searchRecipes` | `toolCalls[0].name === "SearchRecipes"` |
| `planMeals` | `getRecipeDetails` | `toolCalls[0].name === "GetRecipeDetails"` |
| `planMeals` | `savePlan` | `toolCalls[0].name === "SaveDailyPlan"` |
| `planMeals` | `planMeals` | No tool calls returned (LLM nudged) |
| `planMeals` | END | `state.result` is set |
| `searchRecipes` | `planMeals` | Always (via routingFunction, no pending calls) |
| `getRecipeDetails` | `planMeals` | Always (via routingFunction, no pending calls) |
| `savePlan` | END | Always (static) |

---

## Happy Path (7 LLM calls)

```
START
  → planMeals → SearchRecipes(breakfast)
  → planMeals → GetRecipeDetails(breakfast)
  → planMeals → SearchRecipes(lunch)
  → planMeals → GetRecipeDetails(lunch)
  → planMeals → SearchRecipes(dinner)
  → planMeals → GetRecipeDetails(dinner)
  → planMeals → SaveDailyPlan
END
```

---

## Tools

| Tool | Schema | What it does |
|------|--------|-------------|
| `SearchRecipes` | `{ mealType, query }` | Searches Spoonacular for a recipe matching the query. Returns `{ mealType, recipeId, title }`. |
| `GetRecipeDetails` | `{ mealType, recipeId }` | Fetches full recipe info from Spoonacular. Stores in `_ctx.recipeDetails[mealType]`. |
| `SaveDailyPlan` | `{}` | Reads `_ctx.recipeDetails` and writes a `DailyPlan` to MongoDB. |

---

## State

| Key | Reducer | Purpose |
|-----|---------|---------|
| `messages` | append | Full conversation history passed to LLM each turn |
| `toolCalls` | append | Pending tool calls from the LLM's last response |
| `result` | replace | Set by `savePlan` — signals graph to terminate |
| `sendStatus` | replace | SSE callback injected per-request to stream progress to client |
