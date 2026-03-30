const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application" },
  event: {
    type: String,
    enum: ["status-change", "email-received", "follow-up-sent", "ai-scan", "created", "updated"],
    required: [true, "Event type is required"],
  },
  description: { type: String, required: [true, "Description is required"] },
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ActivityLog", activityLogSchema);
