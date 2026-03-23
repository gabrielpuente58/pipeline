const mongoose = require("mongoose");

const mealSchema = new mongoose.Schema(
  {
    time: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    carbs: { type: Number, default: 0 },
    calories: { type: Number, default: 0 },
  },
  { _id: false }
);

const daySchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    meals: { type: [mealSchema], default: [] },
    totalCarbs: { type: Number, default: 0 },
    totalCalories: { type: Number, default: 0 },
  },
  { _id: false }
);

const mealPlanSchema = new mongoose.Schema(
  {
    athleteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Athlete",
      required: [true, "Athlete ID is required"],
    },
    days: {
      type: [daySchema],
      default: [],
    },
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MealPlan", mealPlanSchema);
