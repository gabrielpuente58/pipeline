const mongoose = require("mongoose");

const checklistItemSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: [true, "Category is required"],
      enum: {
        values: ["swim", "bike", "run", "t1", "t2", "nutrition"],
        message: "Category must be swim, bike, run, t1, t2, or nutrition",
      },
    },
    name: {
      type: String,
      required: [true, "Item name is required"],
      trim: true,
    },
    checked: {
      type: Boolean,
      default: false,
    },
    purchased: {
      type: Boolean,
      default: false,
    },
    weeksBeforeNeeded: {
      type: Number,
      default: 1,
      min: [0, "Weeks before needed cannot be negative"],
      max: [52, "Weeks before needed cannot exceed 52"],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChecklistItem", checklistItemSchema);
