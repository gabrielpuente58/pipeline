const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema(
  {
    athleteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Athlete",
      required: [true, "Athlete ID is required"],
    },
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    message: {
      type: String,
      required: [true, "Message is required"],
      trim: true,
    },
    category: {
      type: String,
      required: [true, "Category is required"],
      enum: {
        values: ["purchase", "maintenance", "training", "nutrition", "logistics"],
        message: "Category must be purchase, maintenance, training, nutrition, or logistics",
      },
    },
    daysBeforeRace: {
      type: Number,
      required: [true, "Days before race is required"],
      min: [0, "Days before race cannot be negative"],
    },
    priority: {
      type: String,
      required: [true, "Priority is required"],
      enum: {
        values: ["high", "medium", "low"],
        message: "Priority must be high, medium, or low",
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Reminder", reminderSchema);
