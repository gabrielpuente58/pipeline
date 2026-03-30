const mongoose = require("mongoose");

const applicationSchema = new mongoose.Schema(
  {
    company: { type: String, required: [true, "Company is required"], trim: true },
    position: { type: String, required: [true, "Position is required"], trim: true },
    status: {
      type: String,
      enum: ["applied", "interviewing", "offer", "rejected", "ghosted"],
      default: "applied",
    },
    appliedDate: { type: Date, required: [true, "Applied date is required"] },
    jobUrl: { type: String, trim: true },
    notes: { type: String },
    contactName: { type: String, trim: true },
    contactEmail: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Application", applicationSchema);
